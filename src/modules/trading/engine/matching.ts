import Decimal from 'decimal.js';
import type { BookSide } from './orderbook';

// =====================================================================
// Pure trigger, marketability and fill price rules (spec sections 4 and 6).
//
//  * The server mark price is the only authoritative price. The order book is used to decide
//    marketability and liquidity, never to price a fill.
//  * Market order            : fills at the fresh mark, zero slippage, taker.
//  * Marketable limit        : fills at the fresh mark, never worse than the limit, taker.
//  * Resting limit           : fills at the exact saved limit price, maker, when a LATER fresh mark crosses it.
//  * Stop / TP / SL          : triggered by the mark only. Continuous crossing fills at the saved trigger price,
//                              the first fresh mark after an outage (gap) fills at that mark.
// =====================================================================

export type TriggerOrderType = 'STOP_MARKET' | 'TAKE_PROFIT' | 'STOP_LOSS';

export interface Quote {
  bid: Decimal | null;
  ask: Decimal | null;
  mark: Decimal | null;
}

// Which way must the price move to fire the order?
//   STOP_MARKET (entry): BUY fires on a rise, SELL fires on a fall
//   TAKE_PROFIT        : SELL (closes a long) on a rise, BUY (closes a short) on a fall
//   STOP_LOSS          : SELL (closes a long) on a fall, BUY (closes a short) on a rise
export function triggerDirection(type: TriggerOrderType, side: BookSide): 'UP' | 'DOWN' {
  if (type === 'STOP_MARKET') return side === 'BUY' ? 'UP' : 'DOWN';
  if (type === 'TAKE_PROFIT') return side === 'SELL' ? 'UP' : 'DOWN';
  return side === 'SELL' ? 'DOWN' : 'UP';
}

// A trigger fires when the MARK price touches or crosses the level (the book is not used).
export function isTriggered(type: TriggerOrderType, side: BookSide, trigger: Decimal, quote: Pick<Quote, 'mark'>): boolean {
  if (!quote.mark) return false;
  return triggerDirection(type, side) === 'UP' ? quote.mark.gte(trigger) : quote.mark.lte(trigger);
}

// A limit order is marketable at acceptance when it immediately crosses the opposite best price OR the mark.
// A marketable order is a taker. A post-only order that is marketable is rejected.
export function isMarketable(side: BookSide, limit: Decimal, quote: Quote): boolean {
  const crossesBook = side === 'BUY' ? !!quote.ask && quote.ask.lte(limit) : !!quote.bid && quote.bid.gte(limit);
  const crossesMark = !!quote.mark && (side === 'BUY' ? quote.mark.lte(limit) : quote.mark.gte(limit));
  return crossesBook || crossesMark;
}

// Fill price of a marketable limit order: the fresh mark, but never worse than the limit.
export function marketableLimitFillPrice(side: BookSide, limit: Decimal, mark: Decimal): Decimal {
  return side === 'BUY' ? Decimal.min(mark, limit) : Decimal.max(mark, limit);
}

// A resting limit order fills when a fresh mark crosses its saved limit (the fill price is the limit itself).
export function restingLimitCrossed(side: BookSide, limit: Decimal, mark: Decimal | null): boolean {
  if (!mark) return false;
  return side === 'BUY' ? mark.lte(limit) : mark.gte(limit);
}

// Execution price of a triggered stop / TP / SL.
//   ordinary continuous crossing  -> the saved trigger price
//   first fresh mark after an outage (afterGap) -> that mark, no invented intermediate price
export function triggerFillPrice(trigger: Decimal, mark: Decimal, afterGap: boolean): Decimal {
  return afterGap ? mark : trigger;
}