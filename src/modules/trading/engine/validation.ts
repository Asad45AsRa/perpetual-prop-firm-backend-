import Decimal from 'decimal.js';

// =====================================================================
// Pure input validation helpers for sizes and prices.
// Hyperliquid price rule: at most 5 significant figures (integers are always
// allowed) and at most (6 - szDecimals) decimals for perpetuals.
// =====================================================================

export interface SizeRules {
  sizeStep: Decimal.Value;
  minSize: Decimal.Value;
}

export type SizeCheck = 'OK' | 'INVALID_LOT' | 'BELOW_MIN_SIZE';

// Size must be a positive multiple of the step and at least the minimum size.
export function checkSize(size: Decimal, rules: SizeRules): SizeCheck {
  const step = new Decimal(rules.sizeStep);
  if (size.lte(0)) return 'INVALID_LOT';
  if (step.gt(0) && !size.mod(step).isZero()) return 'INVALID_LOT';
  if (size.lt(rules.minSize)) return 'BELOW_MIN_SIZE';
  return 'OK';
}

export interface PriceRules {
  pricePrecision: number;
  priceTick: Decimal.Value;
}

// Price must be positive, on the tick grid, within the allowed decimals and (unless it is a
// whole number) within 5 significant figures.
export function checkPrice(price: Decimal, rules: PriceRules): boolean {
  if (price.lte(0)) return false;
  if (price.decimalPlaces() > rules.pricePrecision) return false;
  const tick = new Decimal(rules.priceTick);
  if (tick.gt(0) && !price.mod(tick).isZero()) return false;
  if (!price.isInteger() && price.precision(true) > 5) return false;
  return true;
}
