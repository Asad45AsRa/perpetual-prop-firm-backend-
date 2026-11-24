import Decimal from 'decimal.js';

// =====================================================================
// Pure trading math. No database, no network, no clock.
// Everything here is deterministic. Fills are priced by the server mark (see matching.ts), never by a spread or slippage model.
// Netting model: one position per account and market.
// =====================================================================

export type Side = 'BUY' | 'SELL';
export type PositionSide = 'LONG' | 'SHORT';

export interface PositionState {
  side: PositionSide;
  size: Decimal;
  entryPrice: Decimal;
}

export const sideToPositionSide = (side: Side): PositionSide => (side === 'BUY' ? 'LONG' : 'SHORT');

// Order value in account currency.
export const notional = (size: Decimal, price: Decimal): Decimal => size.mul(price);

// Margin locked by a position: notional / leverage.
export const requiredMargin = (notionalValue: Decimal, leverage: number): Decimal =>
  notionalValue.div(leverage);

// Trading fee charged on the notional value of a fill.
export const tradingFee = (notionalValue: Decimal, feeRate: Decimal.Value): Decimal =>
  notionalValue.mul(feeRate);

// Floating profit or loss of an open position at a mark price.
export function unrealizedPnl(side: PositionSide, size: Decimal, entry: Decimal, mark: Decimal): Decimal {
  const priceDiff = side === 'LONG' ? mark.minus(entry) : entry.minus(mark);
  return priceDiff.mul(size);
}

export interface FillResult {
  // Position after the fill, or null when it is fully closed
  position: PositionState | null;
  // Profit or loss realized by the part of the fill that closed exposure
  realizedPnl: Decimal;
  // Size that reduced or closed the old position
  closedSize: Decimal;
}

// Applies one fill to the current position (or null if flat).
//  * Same direction  -> adds size, entry price becomes the weighted average
//  * Opposite        -> reduces / closes, realizes PnL on the closed part
//  * Larger opposite -> closes everything and opens the remainder the other way
export function applyFill(
  current: PositionState | null,
  fillSide: Side,
  size: Decimal,
  price: Decimal,
): FillResult {
  const fillDirection = sideToPositionSide(fillSide);

  if (!current || current.size.isZero()) {
    return {
      position: { side: fillDirection, size, entryPrice: price },
      realizedPnl: new Decimal(0),
      closedSize: new Decimal(0),
    };
  }

  if (current.side === fillDirection) {
    const newSize = current.size.plus(size);
    const entry = current.entryPrice.mul(current.size).plus(price.mul(size)).div(newSize);
    return {
      position: { side: current.side, size: newSize, entryPrice: entry },
      realizedPnl: new Decimal(0),
      closedSize: new Decimal(0),
    };
  }

  const closedSize = Decimal.min(size, current.size);
  const realizedPnl = unrealizedPnl(current.side, closedSize, current.entryPrice, price);
  const remainingOld = current.size.minus(closedSize);
  const remainingFill = size.minus(closedSize);

  if (remainingOld.gt(0)) {
    return { position: { ...current, size: remainingOld }, realizedPnl, closedSize };
  }
  if (remainingFill.gt(0)) {
    return {
      position: { side: fillDirection, size: remainingFill, entryPrice: price },
      realizedPnl,
      closedSize,
    };
  }
  return { position: null, realizedPnl, closedSize };
}

// Simplified isolated-margin liquidation price.
//   LONG : entry * (1 - 1/leverage + maintenanceRate)
//   SHORT: entry * (1 + 1/leverage - maintenanceRate)
export function liquidationPrice(
  side: PositionSide,
  entry: Decimal,
  leverage: number,
  maintenanceRate: Decimal.Value,
): Decimal {
  const inv = new Decimal(1).div(leverage);
  const mmr = new Decimal(maintenanceRate);
  return side === 'LONG'
    ? entry.mul(new Decimal(1).minus(inv).plus(mmr))
    : entry.mul(new Decimal(1).plus(inv).minus(mmr));
}

export function isLiquidated(side: PositionSide, mark: Decimal, liqPrice: Decimal): boolean {
  return side === 'LONG' ? mark.lte(liqPrice) : mark.gte(liqPrice);
}

// =====================================================================
// Cross margin accounting helpers (added with the order book engine).
// =====================================================================

// Initial margin of one fill: notional / leverage. A position keeps the SUM of the margins of its
// opening fills, so adding with another leverage never re-margins the old part.
export const initialMargin = (notionalValue: Decimal, leverage: number): Decimal => notionalValue.div(leverage);

// Maintenance margin (spec section 8) lives in market-policy.ts: |qty| x mark x (0.5 / symbol max leverage).

// When a position shrinks, its margin shrinks in the same proportion.
export function scaleMarginOnReduce(oldMargin: Decimal, oldSize: Decimal, newSize: Decimal): Decimal {
  if (oldSize.lte(0) || newSize.lte(0)) return new Decimal(0);
  return oldMargin.mul(newSize).div(oldSize);
}

// Funding cash flow for one position and one hourly funding event.
//   amount = -(signed size) x oracle price x hourly rate
// Positive rate: longs pay and shorts receive. Negative rate: the opposite.
export function fundingCashflow(side: PositionSide, size: Decimal, oraclePrice: Decimal, hourlyRate: Decimal.Value): Decimal {
  const signedSize = side === 'LONG' ? size : size.negated();
  return signedSize.mul(oraclePrice).mul(hourlyRate).negated();
}