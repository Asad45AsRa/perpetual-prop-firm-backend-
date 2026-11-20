import Decimal from 'decimal.js';
import type { BookSide } from './orderbook';

// =====================================================================
// Pure trigger and fill-eligibility rules.
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

// A trigger fires when EITHER the mark price OR the executable side of the book touches the level.
// The executable side is the one the order would trade against: asks for a BUY, bids for a SELL.
export function isTriggered(type: TriggerOrderType, side: BookSide, trigger: Decimal, quote: Quote): boolean {
  const direction = triggerDirection(type, side);
  const executable = side === 'BUY' ? quote.ask : quote.bid;
  const test = (px: Decimal | null) => (px ? (direction === 'UP' ? px.gte(trigger) : px.lte(trigger)) : false);
  return test(quote.mark) || test(executable);
}

// A limit order is marketable when it crosses the opposite best price at placement.
export function isMarketable(side: BookSide, limit: Decimal, quote: Pick<Quote, 'bid' | 'ask'>): boolean {
  return side === 'BUY' ? !!quote.ask && quote.ask.lte(limit) : !!quote.bid && quote.bid.gte(limit);
}

// A resting limit order fills when the opposite best price touches its limit.
// Markets flagged "requireMarkConfirm" also need the mark price on the right side of the limit.
export function restingLimitCrossed(side: BookSide, limit: Decimal, quote: Quote, requireMarkConfirm: boolean): boolean {
  if (!isMarketable(side, limit, quote)) return false;
  if (!requireMarkConfirm) return true;
  if (!quote.mark) return false;
  return side === 'BUY' ? quote.mark.lte(limit) : quote.mark.gte(limit);
}
