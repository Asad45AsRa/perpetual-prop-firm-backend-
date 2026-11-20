import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { prisma } from '../../config/prisma';
import { Decimal, toD } from '../../utils/decimal';
import { priceFeed } from '../markets/price-feed';
import { evaluateAccount } from '../risk/risk.service';
import { isTriggered, restingLimitCrossed, type Quote, type TriggerOrderType } from './engine/matching';
import { bestAsk, bestBid, eligibleSize } from './engine/orderbook';
import { ACTIVE_STATUSES, processWorkingOrder } from './order-engine';

// =====================================================================
// Order matcher: the background worker that fills resting limit orders and fires
// stop / take-profit / stop-loss orders against the LIVE order book.
//
//  * Runs every ORDER_MATCHER_INTERVAL_MS, plus immediately for symbols whose book changed.
//  * Looks only at orders of markets whose book AND mark price are fresh. Stale data = no fills.
//  * Cheap in-memory pre-filter first, the database transaction (account lock) only for orders that
//    can actually fill or trigger.
//  * Orders of one market are processed oldest first. Resting limits share the visible liquidity,
//    so two orders can never use the same size twice within one sweep.
//  * Safe to run next to user requests and on several instances: every order is re-read after the
//    account row lock, and fills / ledger entries are idempotent.
// =====================================================================

const ENTRY_TYPES = ['LIMIT', 'STOP_MARKET', 'TAKE_PROFIT', 'STOP_LOSS'] as const;
const CLEANUP_EVERY_MS = 5_000;
const FULL_SWEEP_EVERY_MS = 2_000;
const BIG = new Decimal('1e18');

const dirty = new Set<string>();
let timer: NodeJS.Timeout | null = null;
let running = false;
let lastCleanup = 0;
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

// One sweep over the working orders of one market. Returns the number of orders that were processed.
// Exported so tests (and admin tools) can run it directly.
export async function sweepSymbol(symbol: string): Promise<number> {
  if (!priceFeed.isFresh(symbol)) return 0;
  const book = priceFeed.getBook(symbol);
  const mark = priceFeed.getMark(symbol);
  if (!book || !mark) return 0;

  const market = await prisma.market.findUnique({ where: { symbol } });
  if (!market || !market.isEnabled || market.isHalted) return 0;

  const q: Quote = { bid: bestBid(book), ask: bestAsk(book), mark: mark.mark };
  const orders = await prisma.order.findMany({
    where: { marketId: market.id, status: { in: [...ACTIVE_STATUSES] }, type: { in: [...ENTRY_TYPES] } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, accountId: true, type: true, side: true, limitPrice: true, triggerPrice: true, triggeredAt: true },
  });

  // Visible liquidity already used by earlier orders of this sweep
  const used = { BUY: new Decimal(0), SELL: new Decimal(0) };
  const touched = new Set<string>();
  let processed = 0;

  for (const o of orders) {
    let ready: boolean;
    if (o.type === 'LIMIT') ready = restingLimitCrossed(o.side, toD(o.limitPrice!), q, market.requireMarkConfirm);
    else ready = !!o.triggeredAt || isTriggered(o.type as TriggerOrderType, o.side, toD(o.triggerPrice!), q);
    if (!ready) continue;

    const budget = o.type === 'LIMIT' ? Decimal.max(0, eligibleSize(book, o.side, toD(o.limitPrice!)).minus(used[o.side])) : BIG;
    if (budget.lte(0)) continue;

    try {
      const outcome = await prisma.$transaction((tx) => processWorkingOrder(tx, o.id, budget), { timeout: 10_000, maxWait: 5_000 });
      processed++;
      if (outcome.filled.gt(0)) {
        if (o.type === 'LIMIT') used[o.side] = used[o.side].plus(outcome.filled);
        touched.add(o.accountId);
      }
    } catch (err) {
      logger.error({ err, orderId: o.id, symbol }, 'Order matcher failed for one order');
    }
  }

  // New equity after fills: check the account rules once per account
  for (const accountId of touched) await evaluateAccount(accountId).catch((err) => logger.error({ err, accountId }, 'Risk check after fill failed'));
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
