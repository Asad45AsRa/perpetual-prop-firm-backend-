import type { OrderSide, PositionSide } from '@prisma/client';
import { prisma, type Tx } from '../../config/prisma';
import { ApiError } from '../../utils/api-error';
import { Decimal, toD, ZERO } from '../../utils/decimal';
import { getSetting } from '../settings/settings.service';
import { postLedgerEntry } from '../ledger/ledger.service';
import { priceFeed } from '../markets/price-feed';
import { computeAccountSnapshot } from './account-snapshot';
import {
  applyFill,
  liquidationPrice,
  marketFillPrice,
  notional,
  requiredMargin,
  tradingFee,
  type PositionState,
} from './engine/calculations';
import { evaluateAccount } from '../risk/risk.service';

export interface PriceInput {
  mid: Decimal;
  bid: Decimal | null;
  ask: Decimal | null;
}

export interface MarketOrderParams {
  accountId: string;
  symbol: string;
  side: OrderSide;
  size: Decimal;
  leverage: number;
  reduceOnly: boolean;
  clientOrderId?: string;
  // Used by the risk engine to close positions: skips margin / leverage
  // checks and accepts a fallback price when the feed is stale.
  force?: boolean;
  priceOverride?: PriceInput;
}

// Locks the account row until the transaction ends. Orders for the same
// account are processed one at a time, which prevents wrong balances and
// duplicate trades even with concurrent requests.
async function lockAccount(tx: Tx, accountId: string) {
  await tx.$queryRaw`SELECT id FROM "TradingAccount" WHERE id = ${accountId}::uuid FOR UPDATE`;
}

// Core of the engine: executes ONE market order inside a transaction.
// Used by users (placeOrder) and by the risk engine (force close).
export async function executeMarketOrder(tx: Tx, params: MarketOrderParams) {
  await lockAccount(tx, params.accountId);

  const account = await tx.tradingAccount.findUniqueOrThrow({
    where: { id: params.accountId },
    include: { plan: true },
  });
  if (account.status !== 'ACTIVE' && !params.force) {
    throw ApiError.unprocessable('ACCOUNT_NOT_ACTIVE', 'This account cannot trade');
  }

  // Duplicate protection: same clientOrderId returns the original order
  if (params.clientOrderId) {
    const existing = await tx.order.findUnique({
      where: { accountId_clientOrderId: { accountId: params.accountId, clientOrderId: params.clientOrderId } },
    });
    if (existing) return { order: existing, duplicate: true as const };
  }

  const market = await tx.market.findUnique({ where: { symbol: params.symbol.toUpperCase() } });
  if (!market || !market.isEnabled) throw ApiError.unprocessable('MARKET_UNAVAILABLE', 'Market is not available');
  if (market.isHalted && !params.force) throw ApiError.unprocessable('MARKET_HALTED', 'Market is halted');

  // ----- Price (blocked when stale) -----
  let price: PriceInput;
  if (params.priceOverride) {
    price = params.priceOverride;
  } else {
    const tick = priceFeed.getPrice(market.symbol);
    if (!tick || !priceFeed.isFresh(market.symbol)) {
      throw ApiError.unprocessable('STALE_PRICE', 'Price is outdated, trading is temporarily blocked');
    }
    price = { mid: tick.mid, bid: tick.bid, ask: tick.ask };
  }

  // ----- Size and leverage checks -----
  const size = params.size;
  if (size.lte(0) || size.lt(toD(market.minSize))) {
    throw ApiError.unprocessable('SIZE_TOO_SMALL', `Minimum size is ${market.minSize.toString()}`);
  }
  if (size.decimalPlaces() > market.szDecimals) {
    throw ApiError.unprocessable('SIZE_PRECISION', `Size allows ${market.szDecimals} decimals`);
  }
  const maxLeverage = Math.min(market.maxLeverage, account.plan.maxLeverage);
  if (!params.force && (params.leverage < 1 || params.leverage > maxLeverage)) {
    throw ApiError.unprocessable('LEVERAGE_LIMIT', `Leverage must be between 1 and ${maxLeverage}`);
  }

  // ----- Current position -----
  const existing = await tx.position.findUnique({
    where: { accountId_marketId: { accountId: params.accountId, marketId: market.id } },
  });
  const current: PositionState | null =
    existing && toD(existing.size).gt(0)
      ? { side: existing.side, size: toD(existing.size), entryPrice: toD(existing.entryPrice) }
      : null;

  let fillSize = size;
  if (params.reduceOnly) {
    const isReducing = current && ((params.side === 'SELL' && current.side === 'LONG') || (params.side === 'BUY' && current.side === 'SHORT'));
    if (!isReducing) throw ApiError.unprocessable('REDUCE_ONLY', 'Reduce-only order would not reduce a position');
    fillSize = Decimal.min(size, current!.size);
  }

  // ----- Virtual fill price and fee -----
  const config = await getSetting('trading');
  const fillPrice = marketFillPrice({
    side: params.side,
    mid: price.mid,
    bid: price.bid,
    ask: price.ask,
    spreadBps: config.spreadBps,
    slippageBps: config.slippageBps,
    pricePrecision: market.pricePrecision,
  });
  const fee = tradingFee(notional(fillSize, fillPrice), config.takerFeeRate);
  const result = applyFill(current, params.side, fillSize, fillPrice);

  // ----- Margin check (only when exposure grows) -----
  const leverage = existing && current && result.position?.side === current.side ? existing.leverage : params.leverage;
  const newMargin = result.position ? requiredMargin(notional(result.position.size, fillPrice), leverage) : ZERO;
  const increasesExposure =
    !!result.position && (!current || result.position.side !== current.side || result.position.size.gt(current.size));

  if (increasesExposure && !params.force) {
    const snapshot = await computeAccountSnapshot(tx, params.accountId);
    const others = snapshot.positions.filter((p) => p.marketId !== market.id);
    const otherMargin = others.reduce((s, p) => s.plus(p.margin), ZERO);
    const otherPnl = others.reduce((s, p) => s.plus(p.unrealizedPnl), ZERO);
    const equityAfter = snapshot.balance.plus(result.realizedPnl).minus(fee).plus(otherPnl);
    if (equityAfter.lt(otherMargin.plus(newMargin))) {
      throw ApiError.unprocessable('INSUFFICIENT_MARGIN', 'Not enough free margin for this order');
    }
  }

  // ----- Persist order, fill, position and ledger -----
  const order = await tx.order.create({
    data: {
      accountId: params.accountId,
      marketId: market.id,
      clientOrderId: params.clientOrderId,
      side: params.side,
      type: 'MARKET',
      status: 'FILLED',
      size: fillSize.toFixed(),
      filledSize: fillSize.toFixed(),
      avgFillPrice: fillPrice.toFixed(),
      leverage,
      reduceOnly: params.reduceOnly,
    },
  });

  const fill = await tx.fill.create({
    data: {
      orderId: order.id,
      accountId: params.accountId,
      marketId: market.id,
      side: params.side,
      price: fillPrice.toFixed(),
      size: fillSize.toFixed(),
      fee: fee.toFixed(),
      realizedPnl: result.realizedPnl.toFixed(),
    },
  });

  const closedSide: PositionSide = existing?.side ?? (params.side === 'BUY' ? 'LONG' : 'SHORT');
  const positionData = result.position
    ? {
        side: result.position.side,
        size: result.position.size.toFixed(),
        entryPrice: result.position.entryPrice.toFixed(),
        markPrice: fillPrice.toFixed(),
        leverage,
        margin: newMargin.toFixed(),
        liquidationPrice: liquidationPrice(
          result.position.side,
          result.position.entryPrice,
          leverage,
          config.maintenanceMarginRate,
        ).toFixed(),
        status: 'OPEN' as const,
      }
    : {
        side: closedSide,
        size: '0',
        margin: '0',
        liquidationPrice: null,
        markPrice: fillPrice.toFixed(),
        status: 'CLOSED' as const,
      };

  await tx.position.upsert({
    where: { accountId_marketId: { accountId: params.accountId, marketId: market.id } },
    create: { accountId: params.accountId, marketId: market.id, ...positionData },
    update: positionData,
  });

  // Balance changes ONLY through the ledger
  if (!result.realizedPnl.isZero()) {
    await postLedgerEntry(tx, {
      accountId: params.accountId,
      type: 'REALIZED_PNL',
      amount: result.realizedPnl,
      refType: 'fill',
      refId: fill.id,
      idempotencyKey: `fill:${fill.id}:pnl`,
    });
  }
  await postLedgerEntry(tx, {
    accountId: params.accountId,
    type: 'FEE',
    amount: fee.negated(),
    refType: 'fill',
    refId: fill.id,
    idempotencyKey: `fill:${fill.id}:fee`,
  });

  return { order, fill, duplicate: false as const };
}

// Public entry point used by the trading routes.
export async function placeOrder(userId: string, input: Omit<MarketOrderParams, 'force' | 'priceOverride'>) {
  const account = await prisma.tradingAccount.findUnique({ where: { id: input.accountId } });
  if (!account || account.userId !== userId) throw ApiError.notFound('Account not found');

  const result = await prisma.$transaction((tx) => executeMarketOrder(tx, input), { timeout: 10_000 });

  // Re-check risk rules right after the trade
  if (!result.duplicate) await evaluateAccount(input.accountId).catch(() => undefined);
  return result;
}

// Closes the whole position of one market with a reduce-only market order.
export async function closePosition(userId: string, accountId: string, symbol: string) {
  const position = await prisma.position.findFirst({
    where: { accountId, market: { symbol: symbol.toUpperCase() }, size: { gt: 0 } },
  });
  if (!position) throw ApiError.notFound('No open position in this market');

  return placeOrder(userId, {
    accountId,
    symbol,
    side: position.side === 'LONG' ? 'SELL' : 'BUY',
    size: toD(position.size),
    leverage: position.leverage,
    reduceOnly: true,
  });
}

// ----------------------------- Queries --------------------------------

export async function listMyAccounts(userId: string) {
  return prisma.tradingAccount.findMany({
    where: { userId },
    include: { plan: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
  });
}

async function assertOwner(userId: string, accountId: string) {
  const account = await prisma.tradingAccount.findUnique({ where: { id: accountId } });
  if (!account || account.userId !== userId) throw ApiError.notFound('Account not found');
  return account;
}

export async function getAccountOverview(userId: string, accountId: string) {
  const account = await assertOwner(userId, accountId);
  const snapshot = await prisma.$transaction((tx) => computeAccountSnapshot(tx, accountId));
  return {
    id: account.id,
    stage: account.stage,
    status: account.status,
    startingBalance: account.startingBalance.toString(),
    balance: snapshot.balance.toString(),
    unrealizedPnl: snapshot.unrealizedPnl.toString(),
    equity: snapshot.equity.toString(),
    marginUsed: snapshot.marginUsed.toString(),
    freeMargin: snapshot.freeMargin.toString(),
    positions: snapshot.positions.map((p) => ({
      symbol: p.symbol,
      side: p.side,
      size: p.size.toString(),
      entryPrice: p.entryPrice.toString(),
      markPrice: p.markPrice.toString(),
      leverage: p.leverage,
      margin: p.margin.toString(),
      unrealizedPnl: p.unrealizedPnl.toString(),
      liquidationPrice: p.liquidationPrice?.toString() ?? null,
    })),
  };
}

export async function listOrders(userId: string, accountId: string, limit = 50) {
  await assertOwner(userId, accountId);
  return prisma.order.findMany({
    where: { accountId },
    include: { market: { select: { symbol: true } } },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

export async function listFills(userId: string, accountId: string, limit = 50) {
  await assertOwner(userId, accountId);
  return prisma.fill.findMany({
    where: { accountId },
    include: { market: { select: { symbol: true } } },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

export async function listLedger(userId: string, accountId: string, limit = 100) {
  await assertOwner(userId, accountId);
  return prisma.ledgerEntry.findMany({ where: { accountId }, orderBy: { createdAt: 'desc' }, take: limit });
}
