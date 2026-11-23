import { Decimal } from '../../utils/decimal';
import type { BookLevel, BookSnapshot } from '../trading/engine/orderbook';

// =====================================================================
// Order book price grouping for the terminal (pure functions, no network, no clock).
// A group step of 10 merges every bid into the multiple of 10 BELOW it and every ask into the
// multiple of 10 ABOVE it. Rounding this way keeps the spread honest: after grouping the best bid
// can never be higher than, and the best ask never lower than, the real best quotes.
// The levels come from the 20 raw levels Hyperliquid streams, so very large steps return few rows.
// =====================================================================

export type GroupedRow = [price: string, size: string];

// Multipliers offered next to the smallest "nice" step of a market.
const STEP_MULTIPLIERS = [1, 2, 5, 10];

// Group steps offered to the terminal for a market, smallest first, never below the price tick.
// The base step follows the price magnitude (5 significant figures, like Hyperliquid itself),
// e.g. BTC at 90000 -> 1, 2, 5, 10 and ETH at 3000 -> 0.1, 0.2, 0.5, 1.
export function groupOptions(mid: Decimal, priceTick: Decimal): string[] {
  const tick = priceTick.gt(0) ? priceTick : new Decimal('0.01');
  const magnitude = mid.gt(0) ? mid.log(10).floor().toNumber() : 0;
  let base = new Decimal(10).pow(magnitude - 4);
  if (base.lt(tick)) base = tick;
  const seen = new Set<string>();
  const options: string[] = [];
  for (const m of STEP_MULTIPLIERS) {
    const step = base.mul(m).toFixed();
    if (!seen.has(step)) {
      seen.add(step);
      options.push(step);
    }
  }
  return options;
}

// Validates a requested group step. Returns null when no grouping was requested.
// A step below the price tick is raised to the tick (finer than the exchange grid has no meaning).
export function resolveGroup(raw: string | null | undefined, priceTick: Decimal): Decimal | null {
  if (raw == null || raw === '') return null;
  let step: Decimal;
  try {
    step = new Decimal(raw);
  } catch {
    return null;
  }
  if (!step.isFinite() || step.lte(0)) return null;
  return priceTick.gt(0) && step.lt(priceTick) ? priceTick : step;
}

// Sums the sizes of all levels that fall into the same price bucket. Input must be sorted best first.
export function groupLevels(levels: BookLevel[], side: 'BID' | 'ASK', step: Decimal, depth: number): GroupedRow[] {
  const buckets = new Map<string, { price: Decimal; size: Decimal }>();
  for (const level of levels) {
    const units = level.price.div(step);
    const price = (side === 'BID' ? units.floor() : units.ceil()).mul(step);
    const key = price.toFixed();
    const bucket = buckets.get(key);
    if (bucket) bucket.size = bucket.size.plus(level.size);
    else {
      // Stop collecting once we already have enough rows and this level starts a new one
      if (buckets.size >= depth) break;
      buckets.set(key, { price, size: level.size });
    }
  }
  return [...buckets.values()].map((b) => [b.price.toFixed(), b.size.toFixed()]);
}

// Plain (ungrouped) rows, best first.
export function rawLevels(levels: BookLevel[], depth: number): GroupedRow[] {
  return levels.slice(0, depth).map((l) => [l.price.toFixed(), l.size.toFixed()]);
}

// Both sides of a book in the terminal format. step = null returns the raw levels.
export function presentBook(book: BookSnapshot, step: Decimal | null, depth: number): { bids: GroupedRow[]; asks: GroupedRow[] } {
  if (!step) return { bids: rawLevels(book.bids, depth), asks: rawLevels(book.asks, depth) };
  return { bids: groupLevels(book.bids, 'BID', step, depth), asks: groupLevels(book.asks, 'ASK', step, depth) };
}