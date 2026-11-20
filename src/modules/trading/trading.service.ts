import type { OrderSide, PositionMode, PositionSide } from '@prisma/client';
import { prisma, type Tx } from '../../config/prisma';
import { ApiError } from '../../utils/api-error';
import { Decimal, toD } from '../../utils/decimal';
import { evaluateAccount } from '../risk/risk.service';
import { computeAccountSnapshot } from './account-snapshot';
import { ACTIVE_STATUSES, cancelOrderRow, lockAccount, submitOrder, type OrderParams, type PriceInput } from './order-engine';

// =====================================================================
// Public trading API used by the routes (and by the risk engine).
// The matching logic itself lives in order-engine.ts.
// =====================================================================

export type { OrderParams, PriceInput } from './order-engine';

// Older name used by the risk engine: one market order inside an existing transaction.
export interface MarketOrderParams {
  accountId: string;
  symbol: string;
  side: OrderSide;
  size: Decimal;
  leverage: number;
  reduceOnly: boolean;
  clientOrderId?: string;
  // Used by the risk engine to close positions: skips margin / leverage checks and accepts a
  // fallback price when the feed is stale.
  force?: boolean;
  priceOverride?: PriceInput;
}

export function executeMarketOrder(tx: Tx, params: MarketOrderParams) {
  return submitOrder(tx, { ...params, type: 'MARKET' });
}

async function assertOwner(userId: string, accountId: string) {
  const account = await prisma.tradingAccount.findUnique({ where: { id: accountId } });
  if (!account || account.userId !== userId) throw ApiError.notFound('Account not found');
  return account;
}

// Runs one order in a transaction, then re-checks the risk rules.
async function runOrder(userId: string, params: OrderParams) {
  await assertOwner(userId, params.accountId);
  const result = await prisma.$transaction((tx) => submitOrder(tx, params), { timeout: 10_000, maxWait: 5_000 });
  // Re-check risk rules right after a trade
  if (!result.duplicate && result.fills.length > 0) await evaluateAccount(params.accountId).catch(() => undefined);
  return { ...result, fill: result.fills[0] ?? null };
}

// Public entry point used by the trading routes.
export function placeOrder(userId: string, input: Omit<OrderParams, 'force' | 'priceOverride' | 'replaceOrderId'>) {
  return runOrder(userId, input);
}

// Modify = place the replacement (fully validated) and cancel the old order in one transaction.
// "size" is the quantity that should still be worked after the change.
export async function modifyOrder(
  userId: string,
  accountId: string,
  orderId: string,
  changes: { size?: Decimal; limitPrice?: Decimal; triggerPrice?: Decimal },
) {
  await assertOwner(userId, accountId);
  const old = await prisma.order.findFirst({ where: { id: orderId, accountId }, include: { market: { select: { symbol: true } } } });
  if (!old) throw ApiError.notFound('Order not found');
  if (old.type === 'MARKET') throw ApiError.unprocessable('INVALID_ORDER', 'A market order cannot be modified');
  if (old.status === 'FILLED') throw ApiError.unprocessable('ORDER_ALREADY_FILLED', 'Order is already filled');
  if (!ACTIVE_STATUSES.includes(old.status as 'NEW')) throw ApiError.unprocessable('ORDER_NOT_ACTIVE', 'Order is no longer active');

  const remaining = toD(old.size).minus(toD(old.filledSize));
  return runOrder(userId, {
    accountId,
    symbol: old.market.symbol,
    side: old.side,
    type: old.type,
    size: old.closePosition ? null : (changes.size ?? remaining),
    closePosition: old.closePosition,
    limitPrice: changes.limitPrice ?? (old.limitPrice ? toD(old.limitPrice) : null),
    triggerPrice: changes.triggerPrice ?? (old.triggerPrice ? toD(old.triggerPrice) : null),
    leverage: old.leverage,
    reduceOnly: old.reduceOnly,
    postOnly: old.postOnly,
    timeInForce: old.timeInForce,
    positionSide: old.positionSide,
    replaceOrderId: old.id,
  });
}

// Cancel is idempotent: cancelling a cancelled order returns it, a filled order is reported.
export async function cancelOrder(userId: string, accountId: string, orderId: string) {
  await assertOwner(userId, accountId);
  return prisma.$transaction(async (tx) => {
    await lockAccount(tx, accountId);
    const order = await tx.order.findFirst({ where: { id: orderId, accountId } });
    if (!order) throw ApiError.notFound('Order not found');
    if (order.status === 'FILLED') throw ApiError.unprocessable('ORDER_ALREADY_FILLED', 'Order is already filled');
    if (order.status === 'CANCELED' || order.status === 'REJECTED') return order;
    return cancelOrderRow(tx, order.id, 'USER');
  });
}

// Cancels every working order (entries AND exits), optionally for one symbol / side.
// Position closing and advanced jobs are separate actions.
export async function cancelAllOrders(userId: string, accountId: string, filter: { symbol?: string; side?: OrderSide } = {}) {
  await assertOwner(userId, accountId);
  return prisma.$transaction(async (tx) => {
    await lockAccount(tx, accountId);
    const market = filter.symbol ? await tx.market.findUnique({ where: { symbol: filter.symbol.toUpperCase() } }) : null;
    if (filter.symbol && !market) throw ApiError.notFound('Market not found');
    const result = await tx.order.updateMany({
      where: {
        accountId,
        status: { in: [...ACTIVE_STATUSES] },
        ...(market ? { marketId: market.id } : {}),
        ...(filter.side ? { side: filter.side } : {}),
      },
      data: { status: 'CANCELED', reservedMargin: '0', cancelReason: 'USER_CANCEL_ALL' },
    });
    return { canceled: result.count };
  });
}

// Closes a position (or part of it) with a reduce-only market order at the live book.
// The book may be too thin: the result then shows a partial fill and the rest stays open.
export async function closePosition(
  userId: string,
  accountId: string,
  symbol: string,
  options: { size?: Decimal; positionSide?: PositionSide } = {},
) {
  const rows = await prisma.position.findMany({
    where: { accountId, market: { symbol: symbol.toUpperCase() }, size: { gt: 0 }, ...(options.positionSide ? { side: options.positionSide } : {}) },
  });
  if (rows.length === 0) throw ApiError.notFound('No open position in this market');
  if (rows.length > 1) throw ApiError.unprocessable('POSITION_SIDE_REQUIRED', 'Hedge mode: choose LONG or SHORT to close');
  const position = rows[0];

  const total = toD(position.size);
  const size = options.size ?? total;
  return placeOrder(userId, {
    accountId,
    symbol,
    side: position.side === 'LONG' ? 'SELL' : 'BUY',
    type: 'MARKET',
    size: size.gte(total) && !options.size ? total : size,
    leverage: position.leverage,
    reduceOnly: true,
    positionSide: position.side,
  });
}

// Closes every open position (or only longs / only shorts). Each market is its own transaction:
// a thin book on one market never blocks the others, and nothing is reported as closed unless it was.
export async function closeAllPositions(userId: string, accountId: string, only?: PositionSide) {
  await assertOwner(userId, accountId);
  const rows = await prisma.position.findMany({
    where: { accountId, size: { gt: 0 }, ...(only ? { side: only } : {}) },
    include: { market: { select: { symbol: true } } },
  });

  const results: Array<{ symbol: string; side: PositionSide; closed: string; remaining: string; error?: { code: string; message: string } }> = [];
  for (const row of rows) {
    try {
      const r = await closePosition(userId, accountId, row.market.symbol, { positionSide: row.side });
      const filled = r.fills.reduce((s, f) => s.plus(toD(f.size)), new Decimal(0));
      results.push({ symbol: row.market.symbol, side: row.side, closed: filled.toFixed(), remaining: toD(row.size).minus(filled).toFixed() });
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      results.push({ symbol: row.market.symbol, side: row.side, closed: '0', remaining: toD(row.size).toFixed(), error: { code: err.code, message: err.message } });
    }
  }
  return { results };
}

// One-way <-> hedge. Only allowed while the account is completely flat.
export async function setPositionMode(userId: string, accountId: string, mode: PositionMode) {
  await assertOwner(userId, accountId);
  return prisma.$transaction(async (tx) => {
    await lockAccount(tx, accountId);
    const [positions, orders] = await Promise.all([
      tx.position.count({ where: { accountId, size: { gt: 0 } } }),
      tx.order.count({ where: { accountId, status: { in: [...ACTIVE_STATUSES] } } }),
    ]);
    if (positions > 0 || orders > 0) {
      throw ApiError.unprocessable('POSITION_MODE_LOCKED', 'Close all positions and cancel all orders before changing the position mode');
    }
    const account = await tx.tradingAccount.update({ where: { id: accountId }, data: { positionMode: mode }, select: { positionMode: true } });
    return { positionMode: account.positionMode };
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

export async function getAccountOverview(userId: string, accountId: string) {
  const account = await assertOwner(userId, accountId);
  const snapshot = await prisma.$transaction((tx) => computeAccountSnapshot(tx, accountId));
  return {
    id: account.id,
    stage: account.stage,
    status: account.status,
    positionMode: snapshot.positionMode,
    startingBalance: account.startingBalance.toString(),
    balance: snapshot.balance.toString(),
    unrealizedPnl: snapshot.unrealizedPnl.toString(),
    equity: snapshot.equity.toString(),
    marginUsed: snapshot.marginUsed.toString(),
    reservedMargin: snapshot.reservedMargin.toString(),
    freeMargin: snapshot.freeMargin.toString(),
    availableMargin: snapshot.availableMargin.toString(),
    maintenanceMarginRef: snapshot.maintenanceMarginRef.toString(),
    grossExposure: snapshot.grossExposure.toString(),
    grossExposureLimit: snapshot.grossExposureLimit.toString(),
    overCap: snapshot.overCap,
    positions: snapshot.positions.map((p) => ({
      id: p.positionId,
      symbol: p.symbol,
      side: p.side,
      size: p.size.toString(),
      entryPrice: p.entryPrice.toString(),
      markPrice: p.markPrice.toString(),
      notional: p.notional.toString(),
      leverage: p.leverage,
      margin: p.margin.toString(),
      maintenanceMarginRef: p.maintenanceMarginRef.toString(),
      unrealizedPnl: p.unrealizedPnl.toString(),
      liquidationPrice: null,
    })),
  };
}

export async function listOrders(userId: string, accountId: string, opts: { limit?: number; active?: boolean } = {}) {
  await assertOwner(userId, accountId);
  return prisma.order.findMany({
    where: { accountId, ...(opts.active ? { status: { in: [...ACTIVE_STATUSES] } } : {}) },
    include: { market: { select: { symbol: true } } },
    orderBy: { createdAt: 'desc' },
    take: opts.limit ?? 50,
  });
}

export async function getOrder(userId: string, accountId: string, orderId: string) {
  await assertOwner(userId, accountId);
  const order = await prisma.order.findFirst({
    where: { id: orderId, accountId },
    include: { market: { select: { symbol: true } }, fills: { orderBy: { createdAt: 'asc' } } },
  });
  if (!order) throw ApiError.notFound('Order not found');
  return order;
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

