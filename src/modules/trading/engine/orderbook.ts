import Decimal from 'decimal.js';

// =====================================================================
// Pure order book math. No database, no network, no clock.
// A book snapshot is immutable: one order is always simulated against ONE
// consistent snapshot, never against a book that changes mid-calculation.
// =====================================================================

export type BookSide = 'BUY' | 'SELL';

export interface BookLevel {
  price: Decimal;
  size: Decimal;
}

export interface BookSnapshot {
  symbol: string;
  // Bids sorted from the highest price down, asks from the lowest price up
  bids: BookLevel[];
  asks: BookLevel[];
  // Local receive time (ms). Freshness is always judged with this clock.
  receivedAt: number;
  // Exchange timestamp (ms) when the feed provides one
  exchangeTime: number | null;
  // Increases with every accepted update. Proof of ordering for audits.
  seq: number;
}

export interface ConsumeResult {
  // Levels (or parts of levels) that were taken
  taken: BookLevel[];
  filledSize: Decimal;
  // Exact sum of price x size over the taken levels
  notional: Decimal;
  // notional / filledSize, null when nothing was filled
  vwap: Decimal | null;
  // True when the book ran out (or hit the price limit) before the requested size was filled
  exhausted: boolean;
}

export const bestBid = (book: BookSnapshot): Decimal | null => book.bids[0]?.price ?? null;
export const bestAsk = (book: BookSnapshot): Decimal | null => book.asks[0]?.price ?? null;

export function midPrice(book: BookSnapshot): Decimal | null {
  const bid = bestBid(book);
  const ask = bestAsk(book);
  return bid && ask ? bid.plus(ask).div(2) : null;
}

// Takes liquidity for a BUY from the asks (cheapest first) or for a SELL from the bids
// (highest first). With a limit price, levels worse than the limit are never touched.
export function consumeBook(book: BookSnapshot, side: BookSide, size: Decimal, limitPrice?: Decimal | null): ConsumeResult {
  const levels = side === 'BUY' ? book.asks : book.bids;
  const taken: BookLevel[] = [];
  let remaining = size;
  let notional = new Decimal(0);

  for (const level of levels) {
    if (remaining.lte(0)) break;
    if (limitPrice) {
      const withinLimit = side === 'BUY' ? level.price.lte(limitPrice) : level.price.gte(limitPrice);
      if (!withinLimit) break;
    }
    const take = Decimal.min(remaining, level.size);
    if (take.lte(0)) continue;
    taken.push({ price: level.price, size: take });
    notional = notional.plus(level.price.mul(take));
    remaining = remaining.minus(take);
  }

  const filledSize = size.minus(remaining);
  return {
    taken,
    filledSize,
    notional,
    vwap: filledSize.gt(0) ? notional.div(filledSize) : null,
    exhausted: remaining.gt(0),
  };
}

// Total visible size that a resting order could trade against at its limit price or better.
export function eligibleSize(book: BookSnapshot, side: BookSide, limitPrice: Decimal): Decimal {
  const levels = side === 'BUY' ? book.asks : book.bids;
  let total = new Decimal(0);
  for (const level of levels) {
    const ok = side === 'BUY' ? level.price.lte(limitPrice) : level.price.gte(limitPrice);
    if (!ok) break;
    total = total.plus(level.size);
  }
  return total;
}

// Slippage in percent versus the best price at the start of the order.
//   BUY : (vwap / bestAsk - 1) x 100      SELL: (bestBid - vwap) / bestBid x 100
// A negative value (better than the best quote) is reported as 0.
export function slippagePct(side: BookSide, vwap: Decimal, bestQuote: Decimal): Decimal {
  const raw = side === 'BUY' ? vwap.div(bestQuote).minus(1) : bestQuote.minus(vwap).div(bestQuote);
  return Decimal.max(0, raw.mul(100));
}

// Compact form stored with every fill as proof: [["90000","0.1"],["90010","0.2"]]
export const levelsToJson = (levels: BookLevel[]): [string, string][] =>
  levels.map((l) => [l.price.toFixed(), l.size.toFixed()]);
