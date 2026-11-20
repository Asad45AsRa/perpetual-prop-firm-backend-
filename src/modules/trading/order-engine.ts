import type { Market, Order, OrderSide, OrderStatus, OrderType, PositionSide, Prisma, TimeInForce } from '@prisma/client';
import type { Tx } from '../../config/prisma';
import { ApiError } from '../../utils/api-error';
import { Decimal, toD, ZERO } from '../../utils/decimal';
import { postLedgerEntry } from '../ledger/ledger.service';
import { priceFeed } from '../markets/price-feed';
import { getSetting } from '../settings/settings.service';
import { resolveMark } from './account-snapshot';
import { applyFill, initialMargin, scaleMarginOnReduce } from './engine/calculations';
import { checkNewExposure, computeMetrics, symbolSideNotional, type Leg, type WorkingExposure } from './engine/exposure';
import { feeAmount, resolveFeeRate, roundLedger, type LiquidityKind } from './engine/fees';
import { isMarketable, isTriggered, restingLimitCrossed, type Quote, type TriggerOrderType } from './engine/matching';
import {
  bestAsk,
  bestBid,
  consumeBook,
  eligibleSize,
  levelsToJson,
  midPrice,
  slippagePct,
  type BookLevel,
  type BookSnapshot,
} from './engine/orderbook';
import { classifyOrder, closingLegOf, openingSideOf, type Classification } from './engine/positions';
import { checkPrice, checkSize } from './engine/validation';

// =====================================================================
// Transactional order engine (the only code that creates fills and moves positions).
//
// Rules that every path follows:
//  1. The account row is locked first, so orders of one account run one at a time.
//  2. All validation happens BEFORE any write. A rejected order leaves the transaction clean.
//  3. Fills come from ONE consistent order book snapshot (VWAP over the consumed levels).
//  4. Balance changes only through the ledger (realized PnL and fee per fill).
//  5. Cross margin: equity = balance + floating PnL, available = equity - initial margin - reserved margin.
// =====================================================================

export type PlaceableType = 'MARKET' | 'LIMIT' | 'STOP_MARKET' | 'TAKE_PROFIT' | 'STOP_LOSS';
export const ACTIVE_STATUSES = ['NEW', 'PARTIALLY_FILLED'] as const;
const EXIT_TYPES: OrderType[] = ['TAKE_PROFIT', 'STOP_LOSS'];
const isExit = (t: OrderType) => EXIT_TYPES.includes(t);

export interface PriceInput {
  mid: Decimal;
  bid: Decimal | null;
  ask: Decimal | null;
}

export interface OrderParams {
  accountId: string;
  symbol: string;
  side: OrderSide;
  type: PlaceableType;
  // Required except for "close the whole position" exits
  size?: Decimal | null;
  // Exit that always closes the entire current position
  closePosition?: boolean;
  limitPrice?: Decimal | null;
  triggerPrice?: Decimal | null;
  leverage: number;
  reduceOnly: boolean;
  postOnly?: boolean;
  timeInForce?: TimeInForce;
  // Hedge mode: the leg the order targets
  positionSide?: PositionSide | null;
  // Opening market orders only (percent, 3 = 3 percent)
  maxSlippagePct?: Decimal | null;
  clientOrderId?: string;
  // Risk engine closes: skips account / margin / halt checks and accepts a fallback price
  force?: boolean;
  priceOverride?: PriceInput;
  // Modify = place the replacement and cancel this order in the same transaction
  replaceOrderId?: string;
}

export interface OrderResult {
  order: Order;
  fills: Prisma.FillGetPayload<object>[];
  duplicate: boolean;
}

// Locks the account row until the transaction ends. Orders for the same account are processed one
// at a time, which prevents wrong balances and duplicate trades even with concurrent requests.
export async function lockAccount(tx: Tx, accountId: string) {
  await tx.$queryRaw`SELECT id FROM "TradingAccount" WHERE id = ${accountId}::uuid FOR UPDATE`;
}

const reject = (code: string, message: string, details?: unknown): never => {
  throw ApiError.unprocessable(code, message, details);
};

// ------------------------------- state ---------------------------------

interface PosRow {
  id: string;
  marketId: string;
  symbol: string;
  side: PositionSide;
  size: Decimal;
  entryPrice: Decimal;
  margin: Decimal;
  leverage: number;
  markPrice: Decimal;
}

interface EngineState {
  balance: Decimal;
  mode: 'ONE_WAY' | 'HEDGE';
  // Every open leg of the account (all markets)
  rows: PosRow[];
  // Working opening orders that reserve margin (without the ignored ones)
  working: WorkingExposure[];
  settings: Awaited<ReturnType<typeof getSetting<'trading'>>>;
}

async function loadState(tx: Tx, accountId: string, ignore: ReadonlySet<string>): Promise<EngineState> {
  const [account, positions, orders, settings] = await Promise.all([
    tx.tradingAccount.findUniqueOrThrow({ where: { id: accountId }, select: { balance: true, positionMode: true } }),
    tx.position.findMany({ where: { accountId, size: { gt: 0 } }, include: { market: { select: { symbol: true } } } }),
    tx.order.findMany({
      where: { accountId, status: { in: [...ACTIVE_STATUSES] }, reservedMargin: { gt: 0 }, id: { notIn: [...ignore] } },
      include: { market: { select: { symbol: true } } },
    }),
    getSetting('trading'),
  ]);

  return {
    balance: toD(account.balance),
    mode: account.positionMode,
    rows: positions.map((p) => ({
      id: p.id,
      marketId: p.marketId,
      symbol: p.market.symbol,
      side: p.side,
      size: toD(p.size),
      entryPrice: toD(p.entryPrice),
      margin: toD(p.margin),
      leverage: p.leverage,
      markPrice: toD(p.markPrice),
    })),
    working: orders.map((o) => ({
      marketKey: o.market.symbol,
      side: openingSideOf(o.side),
      remaining: toD(o.size).minus(toD(o.filledSize)),
      price: toD(o.limitPrice ?? 0),
      reserved: toD(o.reservedMargin),
    })),
    settings,
  };
}

const rowKey = (marketId: string, side: PositionSide) => `${marketId}:${side}`;

// Legs of the whole account with their marks. The traded market uses the given mark.
function legsFromRows(rows: PosRow[], thisSymbol: string, thisMark: Decimal): Leg[] {
  return rows.map((r) => ({
    marketKey: r.symbol,
    side: r.side,
    size: r.size,
    entryPrice: r.entryPrice,
    mark: r.symbol === thisSymbol ? thisMark : resolveMark(r.symbol, r.markPrice),
    margin: r.margin,
  }));
}

// Margin + fee buffer held for the unfilled opening part of a resting order.
function reservationFor(remaining: Decimal, price: Decimal, leverage: number, takerRate: Decimal): Decimal {
  const notional = remaining.mul(price);
  return notional.div(leverage).plus(notional.mul(takerRate)).toDecimalPlaces(8, Decimal.ROUND_UP);
}

// ------------------------------ execution ------------------------------

interface Execution {
  size: Decimal;
  notional: Decimal;
  // Exact (unrounded) VWAP, or the limit price for maker fills
  price: Decimal;
  liquidity: LiquidityKind;
  levels: BookLevel[];
  bookTime: number | null;
  mark: Decimal;
  // True when part of the fill came from a fallback price (forced closes only)
  synthetic: boolean;
}

interface Residual {
  // Size that keeps resting after this fill
  remaining: Decimal;
  price: Decimal;
}

interface SettleOptions {
  afterStatus: OrderStatus;
  residual: Residual | null;
  triggeredAt?: Date | null;
  cancelReason?: string | null;
  // False for forced closes by the risk engine
  enforce: boolean;
  ignoreOrderIds?: ReadonlySet<string>;
}

// Opening part of a size, given the legs after the current fill.
function openingPortion(state: EngineState, order: Order, marketId: string, rowsAfter: Map<string, PosRow>, size: Decimal): Decimal {
  if (order.reduceOnly || size.lte(0)) return ZERO;
  const long = rowsAfter.get(rowKey(marketId, 'LONG'));
  const short = rowsAfter.get(rowKey(marketId, 'SHORT'));
  const cls = classifyOrder(
    state.mode,
    order.side,
    order.positionSide,
    long ? { side: 'LONG', size: long.size } : null,
    short ? { side: 'SHORT', size: short.size } : null,
    size,
  );
  return cls.openSize;
}

// Pre-trade exposure check shared by fills and by resting-order placement. Throws on rejection.
function enforceExposure(args: {
  state: EngineState;
  market: Market;
  thisMark: Decimal;
  balanceAfter: Decimal;
  rowsAfter: PosRow[];
  workingBefore: WorkingExposure[];
  workingAfter: WorkingExposure[];
  openSide: PositionSide;
}) {
  const { state, market, thisMark } = args;
  const mmr = state.settings.mmrFractionOfImr;
  const legsBefore = legsFromRows(state.rows, market.symbol, thisMark);
  const legsAfter = legsFromRows(args.rowsAfter, market.symbol, thisMark);

  const before = computeMetrics(state.balance, legsBefore, args.workingBefore, mmr);
  const after = computeMetrics(args.balanceAfter, legsAfter, args.workingAfter, mmr);

  const rejection = checkNewExposure({
    before,
    after,
    grossMultiple: state.settings.grossExposureMultiple,
    symbolSideNotionalAfter: symbolSideNotional(legsAfter, args.workingAfter, market.symbol, args.openSide),
    symbolSideCap: market.maxNotionalUsd ? toD(market.maxNotionalUsd) : null,
    increasesExposure: true,
  });
  if (!rejection) return;

  const messages = {
    POSITION_CAP: `Position limit for ${market.symbol} would be exceeded`,
    GROSS_EXPOSURE_CAP: `Total exposure would exceed ${state.settings.grossExposureMultiple}x your equity`,
    INSUFFICIENT_MARGIN: 'Not enough free margin for this order',
  } as const;
  reject(rejection, messages[rejection], {
    availableMargin: after.availableMargin.toFixed(8),
    grossExposure: after.grossWithOrders.toFixed(2),
    equity: after.equity.toFixed(8),
  });
}

// Books ONE execution against the account: fill row, position rows, ledger, order status.
// Every check runs before the first write.
async function settle(tx: Tx, order: Order, market: Market, exec: Execution, opts: SettleOptions) {
  const ignore = new Set<string>([order.id, ...(opts.ignoreOrderIds ?? [])]);
  const state = await loadState(tx, order.accountId, ignore);

  const marketRows = await tx.position.findMany({ where: { accountId: order.accountId, marketId: market.id } });
  const rowBySide = new Map(marketRows.map((r) => [r.side, r]));
  const longRow = rowBySide.get('LONG');
  const shortRow = rowBySide.get('SHORT');
  const toLeg = (r?: (typeof marketRows)[number]) => (r && toD(r.size).gt(0) ? { side: r.side, size: toD(r.size) } : null);

  const cls: Classification = classifyOrder(state.mode, order.side, order.positionSide, toLeg(longRow), toLeg(shortRow), exec.size);
  if (cls.exceedsLeg) reject('REDUCE_ONLY_EXCESS', 'Order is larger than the position it would reduce');
  if (order.reduceOnly && cls.openSize.gt(0)) reject('REDUCE_ONLY', 'Reduce-only order would not reduce a position');

  const feeRate = resolveFeeRate({
    marketType: market.marketType,
    liquidity: exec.liquidity,
    schedule: state.settings.fees,
    makerOverride: market.makerFeeRate,
    takerOverride: market.takerFeeRate,
  });
  const fee = feeAmount(exec.notional, feeRate);
  const price = exec.price;
  const leverage = order.leverage;

  // ---- new state of the touched legs (not written yet) ----
  let realized = ZERO;
  const next = new Map<string, { size: Decimal; entry: Decimal; margin: Decimal; leverage: number; existed: boolean; wasOpen: boolean }>();

  if (cls.closeSide) {
    const row = cls.closeSide === 'LONG' ? longRow! : shortRow!;
    const size = toD(row.size);
    const result = applyFill({ side: row.side, size, entryPrice: toD(row.entryPrice) }, order.side, cls.closeSize, price);
    realized = realized.plus(result.realizedPnl);
    const newSize = size.minus(cls.closeSize);
    next.set(cls.closeSide, {
      size: newSize,
      entry: toD(row.entryPrice),
      margin: scaleMarginOnReduce(toD(row.margin), size, newSize),
      leverage: row.leverage,
      existed: true,
      wasOpen: true,
    });
  }
  if (cls.openSide) {
    const row = cls.openSide === 'LONG' ? longRow : shortRow;
    const wasOpen = !!row && toD(row.size).gt(0);
    const result = applyFill(wasOpen ? { side: row!.side, size: toD(row!.size), entryPrice: toD(row!.entryPrice) } : null, order.side, cls.openSize, price);
    next.set(cls.openSide, {
      size: result.position!.size,
      entry: result.position!.entryPrice,
      margin: (wasOpen ? toD(row!.margin) : ZERO).plus(initialMargin(cls.openSize.mul(price), leverage)),
      leverage,
      existed: !!row,
      wasOpen,
    });
  }
  const realizedPnl = roundLedger(realized);

  // ---- checks (only when exposure grows) ----
  if (cls.openSize.gt(0) && opts.enforce && cls.openSide) {
    const legCount = state.rows.length + (next.get(cls.openSide)!.wasOpen ? 0 : 1);
    if (legCount > state.settings.maxPositionLegs) {
      reject('OPEN_POSITION_LIMIT', `At most ${state.settings.maxPositionLegs} open positions are allowed`);
    }

    // Account rows after this fill
    const afterMap = new Map(state.rows.map((r) => [rowKey(r.marketId, r.side), r]));
    for (const [side, n] of next) {
      const key = rowKey(market.id, side as PositionSide);
      if (n.size.lte(0)) afterMap.delete(key);
      else {
        const old = afterMap.get(key);
        afterMap.set(key, {
          id: old?.id ?? 'new',
          marketId: market.id,
          symbol: market.symbol,
          side: side as PositionSide,
          size: n.size,
          entryPrice: n.entry,
          margin: n.margin,
          leverage: n.leverage,
          markPrice: exec.mark,
        });
      }
    }

    const residualOpen = opts.residual ? openingPortion(state, order, market.id, afterMap, opts.residual.remaining) : ZERO;
    const residualExposure: WorkingExposure[] = residualOpen.gt(0)
      ? [
          {
            marketKey: market.symbol,
            side: openingSideOf(order.side),
            remaining: residualOpen,
            price: opts.residual!.price,
            reserved: reservationFor(residualOpen, opts.residual!.price, leverage, resolveFeeRate({ marketType: market.marketType, liquidity: 'TAKER', schedule: state.settings.fees, makerOverride: market.makerFeeRate, takerOverride: market.takerFeeRate })),
          },
        ]
      : [];
    const ownBefore: WorkingExposure[] = toD(order.reservedMargin).gt(0)
      ? [
          {
            marketKey: market.symbol,
            side: openingSideOf(order.side),
            remaining: toD(order.size).minus(toD(order.filledSize)),
            price: toD(order.limitPrice ?? 0),
            reserved: toD(order.reservedMargin),
          },
        ]
      : [];

    enforceExposure({
      state,
      market,
      thisMark: exec.mark,
      balanceAfter: state.balance.plus(realizedPnl).minus(fee),
      rowsAfter: [...afterMap.values()],
      workingBefore: [...state.working, ...ownBefore],
      workingAfter: [...state.working, ...residualExposure],
      openSide: cls.openSide,
    });
  }

  // ---------------------------- writes ----------------------------
  const dbPrice = price.toDecimalPlaces(10, order.side === 'BUY' ? Decimal.ROUND_UP : Decimal.ROUND_DOWN);
  const rulesVersion = `${state.settings.rulesVersion}/${market.riskTierVersion}${exec.synthetic ? '+forced-close' : ''}`;

  const fill = await tx.fill.create({
    data: {
      orderId: order.id,
      accountId: order.accountId,
      marketId: market.id,
      side: order.side,
      price: dbPrice.toFixed(),
      size: exec.size.toFixed(),
      fee: fee.toFixed(),
      realizedPnl: realizedPnl.toFixed(),
      liquidity: exec.liquidity,
      feeRate: feeRate.toFixed(),
      positionSide: order.positionSide ?? cls.openSide ?? cls.closeSide,
      bookLevels: levelsToJson(exec.levels),
      bookTime: exec.bookTime ? new Date(exec.bookTime) : null,
      rulesVersion,
    },
  });

  for (const [side, n] of next) {
    const data = {
      size: n.size.toFixed(),
      entryPrice: n.entry.toDecimalPlaces(10).toFixed(),
      markPrice: exec.mark.toFixed(),
      margin: n.margin.toDecimalPlaces(8, Decimal.ROUND_UP).toFixed(),
      leverage: n.leverage,
      liquidationPrice: null,
      status: n.size.gt(0) ? ('OPEN' as const) : ('CLOSED' as const),
    };
    await tx.position.upsert({
      where: { accountId_marketId_side: { accountId: order.accountId, marketId: market.id, side: side as PositionSide } },
      create: { accountId: order.accountId, marketId: market.id, side: side as PositionSide, ...data },
      update: n.wasOpen ? data : { ...data, openedAt: new Date() },
    });
  }

  // Balance changes ONLY through the ledger
  if (!realizedPnl.isZero()) {
    await postLedgerEntry(tx, {
      accountId: order.accountId,
      type: 'REALIZED_PNL',
      amount: realizedPnl,
      refType: 'fill',
      refId: fill.id,
      idempotencyKey: `fill:${fill.id}:pnl`,
    });
  }
  if (fee.gt(0)) {
    await postLedgerEntry(tx, {
      accountId: order.accountId,
      type: 'FEE',
      amount: fee.negated(),
      refType: 'fill',
      refId: fill.id,
      idempotencyKey: `fill:${fill.id}:fee`,
    });
  }

  // Order: filled quantity, average price, status and the margin still reserved
  const oldFilled = toD(order.filledSize);
  const newFilled = oldFilled.plus(exec.size);
  const avg = toD(order.avgFillPrice ?? 0).mul(oldFilled).plus(price.mul(exec.size)).div(newFilled);

  let reserved = ZERO;
  if (opts.residual && !order.reduceOnly && ACTIVE_STATUSES.includes(opts.afterStatus as 'NEW')) {
    // Legs of this market after the fill: untouched legs stay as they are
    const afterRows = new Map<string, PosRow>(state.rows.filter((r) => r.marketId === market.id).map((r) => [rowKey(r.marketId, r.side), r]));
    for (const [side, n] of next) afterRows.set(rowKey(market.id, side as PositionSide), { id: '', marketId: market.id, symbol: market.symbol, side: side as PositionSide, size: n.size, entryPrice: n.entry, margin: n.margin, leverage: n.leverage, markPrice: exec.mark });
    const portion = openingPortion(state, order, market.id, afterRows, opts.residual.remaining);
    const takerRate = resolveFeeRate({ marketType: market.marketType, liquidity: 'TAKER', schedule: state.settings.fees, makerOverride: market.makerFeeRate, takerOverride: market.takerFeeRate });
    reserved = reservationFor(portion, opts.residual.price, leverage, takerRate);
  }

  const updated = await tx.order.update({
    where: { id: order.id },
    data: {
      filledSize: newFilled.toFixed(),
      avgFillPrice: avg.toDecimalPlaces(10).toFixed(),
      status: opts.afterStatus,
      reservedMargin: reserved.toFixed(),
      ...(opts.triggeredAt !== undefined ? { triggeredAt: opts.triggeredAt } : {}),
      ...(opts.cancelReason !== undefined ? { cancelReason: opts.cancelReason } : {}),
    },
  });

  // A leg that was closed completely takes its exit orders with it
  if (cls.closeSide && next.get(cls.closeSide)!.size.lte(0)) {
    await cancelReduceOnlyOrders(tx, order.accountId, market.id, cls.closeSide, order.id, 'POSITION_CLOSED');
  }

  return { fill, order: updated };
}

// ----------------------------- cancellation ----------------------------

export async function cancelOrderRow(tx: Tx, orderId: string, reason: string) {
  return tx.order.update({
    where: { id: orderId },
    data: { status: 'CANCELED', reservedMargin: '0', cancelReason: reason },
  });
}

// Cancels working orders of an account. Without a filter it cancels everything (breach, pass, admin lock).
export async function cancelActiveOrders(
  tx: Tx,
  accountId: string,
  reason: string,
  filter: { marketId?: string; side?: OrderSide } = {},
) {
  const result = await tx.order.updateMany({
    where: { accountId, status: { in: [...ACTIVE_STATUSES] }, ...filter },
    data: { status: 'CANCELED', reservedMargin: '0', cancelReason: reason },
  });
  return result.count;
}

// Reduce-only orders (TP, SL, reduce-only limits) that belong to one leg of one market.
async function cancelReduceOnlyOrders(tx: Tx, accountId: string, marketId: string, leg: PositionSide, exceptId: string, reason: string) {
  await tx.order.updateMany({
    where: {
      accountId,
      marketId,
      id: { not: exceptId },
      reduceOnly: true,
      side: leg === 'LONG' ? 'SELL' : 'BUY',
      status: { in: [...ACTIVE_STATUSES] },
    },
    data: { status: 'CANCELED', reservedMargin: '0', cancelReason: reason },
  });
}

// ------------------------------ live quotes ----------------------------

interface LiveQuote {
  book: BookSnapshot;
  mark: Decimal;
  synthetic: boolean;
}

const HUGE = new Decimal('1e18');

// The data a fill is allowed to use. Stale data blocks trading; only forced closes (risk engine)
// may fall back to the last known price.
function liveQuote(symbol: string, force: boolean, override?: PriceInput, storedMark?: Decimal): LiveQuote {
  const book = priceFeed.getBook(symbol);
  const mark = priceFeed.getMark(symbol);

  if (priceFeed.isFresh(symbol) && book && mark) return { book, mark: mark.mark, synthetic: false };

  if (!force) {
    reject('MARKET_FEED_STALE', 'Price is outdated, trading is temporarily blocked', {
      bookFresh: priceFeed.isBookFresh(symbol),
      markFresh: priceFeed.isMarkFresh(symbol),
    });
  }

  const markValue = (priceFeed.isMarkFresh(symbol) ? mark?.mark : undefined) ?? override?.mid ?? storedMark ?? mark?.mark;
  if (priceFeed.isBookFresh(symbol) && book && markValue) return { book, mark: markValue, synthetic: false };
  if (!override && !markValue) reject('MARKET_FEED_STALE', 'No price is available for this market');

  const mid = override?.mid ?? markValue!;
  const bid = override?.bid ?? mid;
  const ask = override?.ask ?? mid;
  return {
    book: {
      symbol,
      bids: [{ price: bid, size: HUGE }],
      asks: [{ price: ask, size: HUGE }],
      receivedAt: Date.now(),
      exchangeTime: null,
      seq: 0,
    },
    mark: markValue ?? mid,
    synthetic: true,
  };
}

// Takes liquidity from the book. Forced closes continue at the worst visible price when the book is too thin.
function takerExecution(quote: LiveQuote, side: OrderSide, size: Decimal, limit: Decimal | null, force: boolean): Execution {
  const result = consumeBook(quote.book, side, size, limit);
  let taken = result.taken;
  let notional = result.notional;
  let filled = result.filledSize;
  let synthetic = quote.synthetic;

  if (force && result.exhausted && !limit) {
    const rest = size.minus(filled);
    const worst = taken.length ? taken[taken.length - 1].price : (side === 'BUY' ? bestAsk(quote.book) : bestBid(quote.book)) ?? quote.mark;
    taken = [...taken, { price: worst, size: rest }];
    notional = notional.plus(worst.mul(rest));
    filled = size;
    synthetic = true;
  }

  return {
    size: filled,
    notional,
    price: filled.gt(0) ? notional.div(filled) : ZERO,
    liquidity: 'TAKER',
    levels: taken,
    bookTime: quote.book.exchangeTime ?? quote.book.receivedAt,
    mark: quote.mark,
    synthetic,
  };
}

// ----------------------------- submit order ----------------------------

export async function submitOrder(tx: Tx, params: OrderParams): Promise<OrderResult> {
  await lockAccount(tx, params.accountId);

  const force = !!params.force;
  const account = await tx.tradingAccount.findUniqueOrThrow({ where: { id: params.accountId }, include: { plan: true } });
  if (account.status !== 'ACTIVE' && !force) reject('ACCOUNT_NOT_ACTIVE', 'This account cannot trade');

  // Duplicate protection: same clientOrderId returns the original order and its fills
  if (params.clientOrderId) {
    const existing = await tx.order.findUnique({
      where: { accountId_clientOrderId: { accountId: params.accountId, clientOrderId: params.clientOrderId } },
    });
    if (existing) {
      const fills = await tx.fill.findMany({ where: { orderId: existing.id }, orderBy: { createdAt: 'asc' } });
      return { order: existing, fills, duplicate: true };
    }
  }

  const market = await tx.market.findUnique({ where: { symbol: params.symbol.toUpperCase() } });
  if (!market || !market.isEnabled) reject('MARKET_DISABLED', 'Market is not available');
  const mkt = market!;
  if (mkt.isHalted && !force) reject('MARKET_DISABLED', 'Market is halted');

  const settings = await getSetting('trading');
  const kill = await getSetting('killSwitches');

  // ---- modify: the order that will be replaced ----
  const ignore = new Set<string>();
  let replaced: Order | null = null;
  if (params.replaceOrderId) {
    replaced = await tx.order.findFirst({ where: { id: params.replaceOrderId, accountId: params.accountId } });
    if (!replaced) throw ApiError.notFound('Order not found');
    if (replaced.status === 'FILLED') reject('ORDER_ALREADY_FILLED', 'Order is already filled');
    if (!ACTIVE_STATUSES.includes(replaced.status as 'NEW')) reject('ORDER_NOT_ACTIVE', 'Order is no longer active');
    ignore.add(replaced.id);
  }

  const type = params.type;
  const exit = type === 'TAKE_PROFIT' || type === 'STOP_LOSS';
  const reduceOnly = exit ? true : params.reduceOnly;
  const mode = account.positionMode;

  // ---- order shape ----
  if (type === 'MARKET' && (params.limitPrice || params.triggerPrice)) reject('INVALID_ORDER', 'A market order has no price');
  if (type === 'LIMIT' && !params.limitPrice) reject('INVALID_ORDER', 'A limit order needs a limit price');
  if (type !== 'LIMIT' && (params.postOnly || params.timeInForce === 'IOC')) {
    if (params.postOnly) reject('INVALID_ORDER', 'Post-only is only available for limit orders');
    if (type !== 'MARKET') reject('INVALID_ORDER', 'IOC is only available for limit orders');
  }
  if (params.postOnly && params.timeInForce === 'IOC') reject('INVALID_ORDER', 'Post-only and IOC cannot be combined');
  if (type === 'STOP_MARKET' && reduceOnly) reject('INVALID_ORDER', 'Use a stop-loss order to close a position');
  if ((type === 'STOP_MARKET' || exit) && !params.triggerPrice) reject('INVALID_ORDER', 'A trigger price is required');
  if (params.closePosition && !exit && !reduceOnly) reject('INVALID_ORDER', 'closePosition requires a reduce-only order');

  // ---- feed, quote and position legs ----
  const marketRows = await tx.position.findMany({ where: { accountId: params.accountId, marketId: mkt.id } });
  const legRow = (leg: PositionSide) => marketRows.find((r) => r.side === leg && toD(r.size).gt(0));
  const legState = (leg: PositionSide) => {
    const r = legRow(leg);
    return r ? { side: leg, size: toD(r.size) } : null;
  };

  // The leg a reduce-only / exit order works on
  let positionSide: PositionSide | null = params.positionSide ?? null;
  if (mode === 'HEDGE' && !positionSide) {
    if (reduceOnly) positionSide = closingLegOf(params.side);
    else reject('POSITION_SIDE_REQUIRED', 'Hedge mode: choose LONG or SHORT for this order');
  }
  if (reduceOnly || exit) {
    const leg = closingLegOf(params.side);
    if (positionSide && positionSide !== leg) reject('INVALID_POSITION_SIDE', 'This order side does not reduce that position');
    positionSide = leg;
  }
  if (mode === 'ONE_WAY' && !reduceOnly && !exit) positionSide = null;

  const quote = liveQuote(mkt.symbol, force, params.priceOverride, marketRows[0] ? toD(marketRows[0].markPrice) : undefined);
  const q: Quote = { bid: bestBid(quote.book), ask: bestAsk(quote.book), mark: quote.mark };

  // ---- size ----
  let size: Decimal;
  const heldLeg = positionSide ? legRow(positionSide) : undefined;
  if (params.closePosition) {
    if (!heldLeg) reject('NO_POSITION', 'There is no open position to close');
    size = toD(heldLeg!.size);
  } else {
    if (!params.size) reject('INVALID_LOT', 'Order size is required');
    size = params.size!;
    if (!force && checkSize(size, { sizeStep: mkt.sizeStep, minSize: mkt.minSize }) !== 'OK') {
      reject('INVALID_LOT', `Size must be a multiple of ${mkt.sizeStep.toString()} (minimum ${mkt.minSize.toString()})`);
    }
  }

  if ((reduceOnly || exit) && !force) {
    if (!heldLeg) reject('NO_POSITION', 'There is no open position to reduce');
    if (!params.closePosition && size.gt(toD(heldLeg!.size))) reject('REDUCE_ONLY_EXCESS', 'Order is larger than the position it would reduce');
  }

  const cls = classifyOrder(mode, params.side, positionSide, legState('LONG'), legState('SHORT'), size);
  if (cls.exceedsLeg) reject('REDUCE_ONLY_EXCESS', 'Order is larger than the position it would reduce');
  if (reduceOnly && cls.openSize.gt(0)) reject('REDUCE_ONLY', 'Reduce-only order would not reduce a position');
  const opens = cls.openSize.gt(0) || type === 'STOP_MARKET' || (type === 'LIMIT' && !reduceOnly && mode === 'HEDGE' && cls.openSize.gt(0));

  // ---- leverage, caps, switches ----
  const leverageCap = Math.min(mkt.maxLeverage, account.plan.maxLeverage);
  if (opens && !force) {
    if (!Number.isInteger(params.leverage) || params.leverage < 1 || params.leverage > leverageCap) {
      reject('LEVERAGE_CAP', `Leverage must be between 1 and ${leverageCap} for ${mkt.symbol}`, { max: leverageCap });
    }
    if (kill.pauseTrading) reject('TRADING_PAUSED', 'Trading is paused by the platform');
    if (mkt.isCloseOnly) reject('MARKET_CLOSE_ONLY', `${mkt.symbol} only accepts orders that reduce a position`);
  }
  const leverage = opens ? params.leverage : (heldLeg?.leverage ?? params.leverage);

  // ---- prices ----
  const pricePrecisionRules = { pricePrecision: mkt.pricePrecision, priceTick: mkt.priceTick };
  if (params.limitPrice && !checkPrice(params.limitPrice, pricePrecisionRules)) {
    reject('INVALID_TICK', `Price must be a multiple of ${mkt.priceTick.toString()} (max 5 significant figures)`);
  }
  if (params.triggerPrice && !checkPrice(params.triggerPrice, pricePrecisionRules)) {
    reject('INVALID_TICK', `Trigger price must be a multiple of ${mkt.priceTick.toString()} (max 5 significant figures)`);
  }

  const refPrice = params.limitPrice ?? midPrice(quote.book) ?? quote.mark;
  if (opens && !force && size.mul(refPrice).lt(toD(mkt.minNotionalUsd))) {
    reject('BELOW_MIN_NOTIONAL', `Minimum order value for ${mkt.symbol} is ${mkt.minNotionalUsd.toString()} USD`, { minimum: mkt.minNotionalUsd.toString() });
  }

  // ---- trigger orders: correct side, not already triggered ----
  if (params.triggerPrice && !force) {
    if (isTriggered(type as TriggerOrderType, params.side, params.triggerPrice, q)) {
      reject('TRIGGER_WOULD_FIRE', 'The trigger price is already reached. Choose a price on the other side of the market.');
    }
  }

  // ---- order count limits ----
  if (!force && (type === 'LIMIT' || type === 'STOP_MARKET') && !reduceOnly) {
    const openOrders = await tx.order.count({
      where: { accountId: params.accountId, status: { in: [...ACTIVE_STATUSES] }, reduceOnly: false, type: { in: ['LIMIT', 'STOP_MARKET'] }, id: { notIn: [...ignore] } },
    });
    if (openOrders >= settings.maxOpenOrders) reject('OPEN_ORDER_LIMIT', `At most ${settings.maxOpenOrders} open orders are allowed`);
  }
  if (exit && !force) {
    const legOrders = await tx.order.findMany({
      where: { accountId: params.accountId, marketId: mkt.id, positionSide, type: { in: EXIT_TYPES }, status: { in: [...ACTIVE_STATUSES] }, id: { notIn: [...ignore] } },
    });
    if (legOrders.length >= settings.maxExitLegsPerPosition) {
      reject('EXIT_LEG_LIMIT', `At most ${settings.maxExitLegsPerPosition} take-profit / stop-loss orders per position`);
    }
    const sameKind = legOrders.filter((o) => o.type === type);
    if (params.closePosition || sameKind.some((o) => o.closePosition)) {
      if (sameKind.length > 0) reject('EXIT_SIZE_EXCEEDS_POSITION', 'A full-position exit cannot be combined with other exits of the same kind');
    }
    const committed = sameKind.reduce((s, o) => s.plus(toD(o.size).minus(toD(o.filledSize))), ZERO);
    if (committed.plus(size).gt(toD(heldLeg!.size))) {
      reject('EXIT_SIZE_EXCEEDS_POSITION', 'Take-profit / stop-loss sizes together exceed the position size');
    }
  }
  if (opens && !force && cls.openSide && !(legRow(cls.openSide))) {
    const legs = await tx.position.count({ where: { accountId: params.accountId, size: { gt: 0 } } });
    if (legs >= settings.maxPositionLegs) reject('OPEN_POSITION_LIMIT', `At most ${settings.maxPositionLegs} open positions are allowed`);
  }

  // ---- slippage setting (opening market orders) ----
  let slippageLimit: Decimal | null = null;
  if (type === 'MARKET' && cls.openSize.gt(0)) {
    slippageLimit = params.maxSlippagePct ?? toD(settings.defaultOpenSlippagePct);
    if (slippageLimit.lte(0) || slippageLimit.gt(settings.maxOpenSlippagePct)) {
      reject('INVALID_SLIPPAGE', `Slippage must be between 0 and ${settings.maxOpenSlippagePct} percent`);
    }
  }

  // ---- limit orders: post-only ----
  const marketable = type === 'LIMIT' ? isMarketable(params.side, params.limitPrice!, q) : false;
  if (type === 'LIMIT' && params.postOnly && marketable) {
    reject('POST_ONLY_WOULD_TAKE', 'A post-only order would execute immediately. Choose a price that rests in the book.');
  }

  // ---- market execution plan (validated before writing anything) ----
  let marketExec: Execution | null = null;
  if (type === 'MARKET') {
    marketExec = takerExecution(quote, params.side, size, null, force);
    const best = params.side === 'BUY' ? bestAsk(quote.book) : bestBid(quote.book);
    if (marketExec.size.lte(0)) reject('VISIBLE_BOOK_TOO_THIN', 'No liquidity is available in the order book');
    if (cls.openSize.gt(0)) {
      // Opening / adding / reversing: the WHOLE size must be available within the slippage limit
      if (marketExec.size.lt(size)) reject('VISIBLE_BOOK_TOO_THIN', 'The order book is too thin for this size', { visible: marketExec.size.toFixed() });
      if (!force && best && slippageLimit) {
        const slip = slippagePct(params.side, marketExec.price, best);
        if (slip.gt(slippageLimit)) {
          reject('OPEN_SLIPPAGE_EXCEEDED', `Slippage ${slip.toFixed(4)}% is above your limit of ${slippageLimit.toFixed()}%`, { slippagePct: slip.toFixed(4) });
        }
      }
    }
  }

  // ----------------------------- create the order -----------------------------
  const order = await tx.order.create({
    data: {
      accountId: params.accountId,
      marketId: mkt.id,
      clientOrderId: params.clientOrderId,
      side: params.side,
      type,
      status: 'NEW',
      size: size.toFixed(),
      limitPrice: params.limitPrice?.toFixed(),
      triggerPrice: params.triggerPrice?.toFixed(),
      closePosition: !!params.closePosition,
      leverage,
      reduceOnly,
      positionSide,
      timeInForce: params.timeInForce ?? 'GTC',
      postOnly: !!params.postOnly,
      maxSlippagePct: slippageLimit?.toFixed(),
    },
  });

  const fills: OrderResult['fills'] = [];
  let current = order;
  const settleOpts = { enforce: !force, ignoreOrderIds: ignore };

  if (type === 'MARKET') {
    const exec = marketExec!;
    const done = exec.size.gte(size);
    const result = await settle(tx, order, mkt, exec, {
      ...settleOpts,
      afterStatus: done ? 'FILLED' : 'CANCELED',
      residual: null,
      cancelReason: done ? undefined : 'PARTIAL_DEPTH',
    });
    fills.push(result.fill);
    current = result.order;
  } else if (type === 'LIMIT') {
    const limit = params.limitPrice!;
    let remaining = size;

    if (marketable) {
      const exec = takerExecution(quote, params.side, size, limit, false);
      if (exec.size.gt(0)) {
        remaining = size.minus(exec.size);
        const rests = remaining.gt(0) && (params.timeInForce ?? 'GTC') === 'GTC';
        const result = await settle(tx, order, mkt, exec, {
          ...settleOpts,
          afterStatus: remaining.lte(0) ? 'FILLED' : rests ? 'PARTIALLY_FILLED' : 'CANCELED',
          residual: rests ? { remaining, price: limit } : null,
          cancelReason: remaining.gt(0) && !rests ? 'IOC_REMAINDER' : undefined,
        });
        fills.push(result.fill);
        current = result.order;
      }
    }

    // Nothing filled: IOC is cancelled, GTC rests (and reserves margin when it opens)
    if (fills.length === 0) {
      if ((params.timeInForce ?? 'GTC') === 'IOC') {
        current = await tx.order.update({ where: { id: order.id }, data: { status: 'CANCELED', cancelReason: 'NO_LIQUIDITY' } });
      } else {
        current = await restOrder(tx, order, mkt, ignore, force, quote.mark);
      }
    }
  }
  // STOP_MARKET, TAKE_PROFIT and STOP_LOSS stay armed (NEW) until the matcher triggers them.

  // Modify: the replacement is accepted, the old order goes away in the same transaction
  if (replaced) {
    await tx.order.update({
      where: { id: replaced.id },
      data: { status: 'CANCELED', reservedMargin: '0', cancelReason: `REPLACED_BY:${order.id}` },
    });
  }

  return { order: current, fills, duplicate: false };
}

// Places a limit order into the book: checks the margin / exposure it would need and reserves it.
async function restOrder(tx: Tx, order: Order, market: Market, ignore: ReadonlySet<string>, force: boolean, mark: Decimal): Promise<Order> {
  if (order.reduceOnly) return order; // exits reserve nothing
  const state = await loadState(tx, order.accountId, new Set([order.id, ...ignore]));
  const rows = new Map(state.rows.map((r) => [rowKey(r.marketId, r.side), r]));
  const remaining = toD(order.size).minus(toD(order.filledSize));
  const portion = openingPortion(state, order, market.id, rows, remaining);
  if (portion.lte(0)) return order;

  const price = toD(order.limitPrice!);
  const takerRate = resolveFeeRate({ marketType: market.marketType, liquidity: 'TAKER', schedule: state.settings.fees, makerOverride: market.makerFeeRate, takerOverride: market.takerFeeRate });
  const reserved = reservationFor(portion, price, order.leverage, takerRate);
  const exposure: WorkingExposure = { marketKey: market.symbol, side: openingSideOf(order.side), remaining: portion, price, reserved };

  if (!force) {
    enforceExposure({
      state,
      market,
      thisMark: mark,
      balanceAfter: state.balance,
      rowsAfter: state.rows,
      workingBefore: state.working,
      workingAfter: [...state.working, exposure],
      openSide: openingSideOf(order.side),
    });
  }
  return tx.order.update({ where: { id: order.id }, data: { reservedMargin: reserved.toFixed() } });
}

// ------------------------- working orders (matcher) --------------------

export interface WorkingOutcome {
  // Size that was filled in this call
  filled: Decimal;
}

// Evaluates ONE working order against the live market: resting limits fill as maker when the book
// touches the limit, stops / TP / SL fire as taker. Called by the order matcher inside a transaction.
//   eligibleBudget = visible liquidity this limit order may still use in the current sweep
export async function processWorkingOrder(tx: Tx, orderId: string, eligibleBudget: Decimal): Promise<WorkingOutcome> {
  const none: WorkingOutcome = { filled: ZERO };
  const peek = await tx.order.findUnique({ where: { id: orderId }, select: { accountId: true } });
  if (!peek) return none;
  await lockAccount(tx, peek.accountId);

  // Re-read after the lock: another transaction may have changed the order
  const order = await tx.order.findUnique({ where: { id: orderId } });
  if (!order || !ACTIVE_STATUSES.includes(order.status as 'NEW')) return none;

  const account = await tx.tradingAccount.findUniqueOrThrow({ where: { id: order.accountId }, select: { status: true } });
  if (account.status !== 'ACTIVE') {
    await cancelOrderRow(tx, order.id, 'ACCOUNT_INACTIVE');
    return none;
  }

  const market = await tx.market.findUniqueOrThrow({ where: { id: order.marketId } });
  const opening = !order.reduceOnly;
  if (!market.isEnabled) {
    await cancelOrderRow(tx, order.id, 'MARKET_DISABLED');
    return none;
  }
  if (market.isHalted) return none; // armed orders wait, no fills while halted
  if (opening && market.isCloseOnly) {
    await cancelOrderRow(tx, order.id, 'MARKET_CLOSE_ONLY');
    return none;
  }
  if (opening && (await getSetting('killSwitches')).pauseTrading) return none;

  // No fills and no triggers on stale data
  const book = priceFeed.getBook(market.symbol);
  const mark = priceFeed.getMark(market.symbol);
  if (!book || !mark || !priceFeed.isFresh(market.symbol)) return none;
  const quote: LiveQuote = { book, mark: mark.mark, synthetic: false };
  const q: Quote = { bid: bestBid(book), ask: bestAsk(book), mark: mark.mark };

  const remaining = toD(order.size).minus(toD(order.filledSize));
  if (remaining.lte(0)) {
    await tx.order.update({ where: { id: order.id }, data: { status: 'FILLED', reservedMargin: '0' } });
    return none;
  }

  const rejectOrder = async (err: unknown, final: 'REJECTED' | 'CANCELED') => {
    if (!(err instanceof ApiError)) throw err;
    await tx.order.update({
      where: { id: order.id },
      data: { status: final, reservedMargin: '0', ...(final === 'REJECTED' ? { rejectReason: err.code } : { cancelReason: err.code }) },
    });
    return none;
  };

  // The leg that a reduce-only order works on
  const legSide = order.reduceOnly ? closingLegOf(order.side) : null;
  const leg = legSide
    ? await tx.position.findUnique({ where: { accountId_marketId_side: { accountId: order.accountId, marketId: market.id, side: legSide } } })
    : null;
  const legSize = leg ? toD(leg.size) : ZERO;

  if (order.reduceOnly && legSize.lte(0)) {
    await cancelOrderRow(tx, order.id, 'POSITION_CLOSED');
    return none;
  }

  // ---------------------------- resting limit ----------------------------
  if (order.type === 'LIMIT') {
    const limit = toD(order.limitPrice!);
    if (!restingLimitCrossed(order.side, limit, q, market.requireMarkConfirm)) return none;

    let want = order.reduceOnly ? Decimal.min(remaining, legSize) : remaining;
    want = Decimal.min(want, eligibleSize(book, order.side, limit), eligibleBudget);
    // Keep the size on the market's step grid
    const step = toD(market.sizeStep);
    if (step.gt(0)) want = want.div(step).floor().mul(step);
    if (want.lte(0)) return none;

    // Resting orders trade at their limit price as maker
    const exec: Execution = {
      size: want,
      notional: limit.mul(want),
      price: limit,
      liquidity: 'MAKER',
      levels: [{ price: limit, size: want }],
      bookTime: book.exchangeTime ?? book.receivedAt,
      mark: mark.mark,
      synthetic: false,
    };
    const left = remaining.minus(want);
    try {
      const result = await settle(tx, order, market, exec, {
        enforce: true,
        afterStatus: left.lte(0) ? 'FILLED' : 'PARTIALLY_FILLED',
        residual: left.gt(0) ? { remaining: left, price: limit } : null,
      });
      return { filled: toD(result.fill.size) };
    } catch (err) {
      return rejectOrder(err, 'CANCELED');
    }
  }

  // ------------------------ stop entry / TP / SL --------------------------
  let triggeredAt = order.triggeredAt;
  if (!triggeredAt) {
    if (!isTriggered(order.type as TriggerOrderType, order.side, toD(order.triggerPrice!), q)) return none;
    triggeredAt = new Date();
    await tx.order.update({ where: { id: order.id }, data: { triggeredAt } });
  }

  const want = order.reduceOnly ? (order.closePosition ? legSize : Decimal.min(remaining, legSize)) : remaining;
  const exec = takerExecution(quote, order.side, want, null, false);
  if (exec.size.lte(0)) return none; // waiting for liquidity, stays armed

  // An entry stop needs the whole size. Exits take what the book offers.
  if (!order.reduceOnly && exec.size.lt(want)) return none;

  const left = order.closePosition ? legSize.minus(exec.size) : remaining.minus(exec.size);
  try {
    const result = await settle(tx, order, market, exec, {
      enforce: true,
      afterStatus: left.lte(0) ? 'FILLED' : 'PARTIALLY_FILLED',
      residual: null,
      triggeredAt,
    });
    return { filled: toD(result.fill.size) };
  } catch (err) {
    return rejectOrder(err, 'REJECTED');
  }
}
