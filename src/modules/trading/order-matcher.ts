import { env, staleMarkMs } from '../../config/env';
import { logger } from '../../config/logger';
import { prisma } from '../../config/prisma';
import { toD } from '../../utils/decimal';
import { priceFeed } from '../markets/price-feed';
import { evaluateAccount } from '../risk/risk.service';
import { isTriggered, restingLimitCrossed, type Quote, type TriggerOrderType } from './engine/matching';
import { bestAsk, bestBid } from './engine/orderbook';
import { ACTIVE_STATUSES, processWorkingOrder } from './order-engine';
import { tradingEvents } from './trading-events';

// =====================================================================
// Order matcher: the background worker that fills resting limit orders, fires stop / take-profit /
// stop-loss orders and expires limit orders, always against the LIVE mark price of the Hyperliquid feed.
//
//  * Runs every ORDER_MATCHER_INTERVAL_MS, plus immediately for symbols whose book or mark changed.
//  * Looks only at markets whose book AND mark price are fresh. Stale data = no fills, no triggers.
//  * Cheap in-memory pre-filter first, the database transaction (account lock) only for orders that
//    can actually fill or trigger.
//  * A resting limit order needs a mark that arrived AFTER the order was accepted (it must survive one later fresh update).
//  * The first fresh mark after a data outage (or after a restart) is flagged "afterGap": stops fill at that mark instead of
//    at their trigger price (spec: no invented intermediate price).
//  * Safe to run next to user requests and on several instances: every order is re-read after the
//    account row lock, and fills / ledger entries are idempotent.
// =====================================================================

const ENTRY_TYPES = ['LIMIT', 'STOP_MARKET', 'TAKE_PROFIT', 'STOP_LOSS'] as const;
const CLEANUP_EVERY_MS = 5_000;
const EXPIRY_EVERY_MS = 1_000;
const FULL_SWEEP_EVERY_MS = 2_000;

const dirty = new Set<string>();
// Receive time of the last mark this matcher processed per symbol (outage detection)
const lastMarkAt = new Map<string, number>();
let timer: NodeJS.Timeout | null = null;
let running = false;
let lastCleanup = 0;
let lastExpiry = 0;
let lastFullSweep = 0;

const onBook = (book: { symbol: string }) => void dirty.add(book.symbol);
const onMark = (mark: { symbol: string }) => void dirty.add(mark.symbol);

// Working orders must never outlive the state that allows them.
async function cleanup() {
  const reason = { status: 'CANCELED' as const, reservedMargin: '0' };
  const inactive = await prisma.order.updateMany({
    where: { status: { in: [...ACTIVE_STATUSES] }, account: { status: { not: 'ACTIVE' } } },
    data: { ...reason, cancelReason: 'ACCOUNT_INACTIVE' },
  });
  const disabled = await prisma.order.updateMany({
    where: { status: { in: [...ACTIVE_STATUSES] }, market: { isEnabled: false } },
    data: { ...reason, cancelReason: 'MARKET_DISABLED' },
  });
  const closeOnly = await prisma.order.updateMany({
    where: { status: { in: [...ACTIVE_STATUSES] }, reduceOnly: false, market: { isCloseOnly: true } },
    data: { ...reason, cancelReason: 'MARKET_CLOSE_ONLY' },
  });
  const total = inactive.count + disabled.count + closeOnly.count;
  if (total > 0) logger.info({ inactive: inactive.count, disabled: disabled.count, closeOnly: closeOnly.count }, 'Orders cancelled by cleanup');
}

// Cancels resting limit orders whose expiry has passed (5m / 1h / 24h / 30d) and releases their margin reservation once.
// Does not depend on prices, so it also works while the feed is down.
export async function expireOrders(now = new Date()): Promise<number> {
  const due = await prisma.order.findMany({
    where: { status: { in: [...ACTIVE_STATUSES] }, expiresAt: { lte: now } },
    select: { id: true, accountId: true },
  });
  if (due.length === 0) return 0;

  const result = await prisma.order.updateMany({
    where: { id: { in: due.map((o) => o.id) }, status: { in: [...ACTIVE_STATUSES] } },
    data: { status: 'CANCELED', reservedMargin: '0', cancelReason: 'EXPIRED' },
  });
  for (const accountId of new Set(due.map((o) => o.accountId))) tradingEvents.accountChanged(accountId, 'cancel');
  return result.count;
}

// One sweep over the working orders of one market. Returns the number of orders that were processed.
export async function sweepSymbol(symbol: string): Promise<number> {
  if (!priceFeed.isFresh(symbol)) return 0;
  const book = priceFeed.getBook(symbol);
  const mark = priceFeed.getMark(symbol);
  if (!book || !mark) return 0;

  // First fresh mark after an outage, a long silence or a restart
  const previous = lastMarkAt.get(symbol);
  const afterGap = previous == null || mark.receivedAt - previous >= staleMarkMs;

  const market = await prisma.market.findUnique({ where: { symbol } });
  if (!market || !market.isEnabled || market.isHalted) return 0;

  const q: Quote = { bid: bestBid(book), ask: bestAsk(book), mark: mark.mark };
  const orders = await prisma.order.findMany({
    where: { marketId: market.id, status: { in: [...ACTIVE_STATUSES] }, type: { in: [...ENTRY_TYPES] } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, accountId: true, type: true, side: true, limitPrice: true, triggerPrice: true, triggeredAt: true, createdAt: true },
  });

  const touched = new Set<string>();
  let processed = 0;

  for (const o of orders) {
    let ready: boolean;
    if (o.type === 'LIMIT') {
      // The mark must be newer than the order and must cross the saved limit
      ready = mark.receivedAt > o.createdAt.getTime() && restingLimitCrossed(o.side, toD(o.limitPrice!), mark.mark);
    } else {
      ready = !!o.triggeredAt || isTriggered(o.type as TriggerOrderType, o.side, toD(o.triggerPrice!), q);
    }
    if (!ready) continue;

    try {
      const outcome = await prisma.$transaction((tx) => processWorkingOrder(tx, o.id, { afterGap }), { timeout: 10_000, maxWait: 5_000 });
      processed++;
      if (outcome.filled.gt(0)) touched.add(o.accountId);
    } catch (err) {
      logger.error({ err, orderId: o.id, symbol }, 'Order matcher failed for one order');
    }
  }

  lastMarkAt.set(symbol, mark.receivedAt);

  // New equity after fills: announce the change to the terminals and check the account rules once per account
  for (const accountId of touched) {
    tradingEvents.accountChanged(accountId, 'fill');
    await evaluateAccount(accountId).catch((err) => logger.error({ err, accountId }, 'Risk check after fill failed'));
  }
  return processed;
}

async function tick() {
  if (running) return; // never overlap with the previous run
  running = true;
  try {
    const now = Date.now();
    const full = now - lastFullSweep >= FULL_SWEEP_EVERY_MS;
    if (full) lastFullSweep = now;
    const symbols = full ? priceFeed.trackedSymbols() : [...dirty].filter((s) => priceFeed.trackedSymbols().includes(s));
    dirty.clear();

    for (const symbol of symbols) await sweepSymbol(symbol);

    if (now - lastExpiry >= EXPIRY_EVERY_MS) {
      lastExpiry = now;
      await expireOrders();
    }
    if (now - lastCleanup >= CLEANUP_EVERY_MS) {
      lastCleanup = now;
      await cleanup();
    }
  } catch (err) {
    logger.error({ err }, 'Order matcher tick failed');
  } finally {
    running = false;
  }
}

export function startOrderMatcher() {
  if (timer) return;
  priceFeed.on('book', onBook);
  priceFeed.on('mark', onMark);
  timer = setInterval(() => void tick(), env.ORDER_MATCHER_INTERVAL_MS);
  logger.info({ intervalMs: env.ORDER_MATCHER_INTERVAL_MS }, 'Order matcher started');
}

export function stopOrderMatcher() {
  if (timer) clearInterval(timer);
  timer = null;
  priceFeed.off('book', onBook);
  priceFeed.off('mark', onMark);
}