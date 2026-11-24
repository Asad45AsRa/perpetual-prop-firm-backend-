import Decimal from 'decimal.js';

// =====================================================================
// Numeric rules of the trading terminal spec (v1.0) that do not depend on the database.
// Pure functions and constants only: no network, no clock, no market data.
// =====================================================================

// ---- Mark / book disagreement (section 6): new entries pause when the book mid and the mark differ too much ----
const MAJOR_SYMBOLS = new Set(['BTC', 'ETH', 'SOL']);
export const DIVERGENCE_LIMIT_MAJOR_PCT = new Decimal('0.75');
export const DIVERGENCE_LIMIT_OTHER_PCT = new Decimal('1.5');

export const divergenceLimitPct = (symbol: string): Decimal => (MAJOR_SYMBOLS.has(symbol.toUpperCase()) ? DIVERGENCE_LIMIT_MAJOR_PCT : DIVERGENCE_LIMIT_OTHER_PCT);

// True when the divergence EXCEEDS the limit (equal is still allowed). Unknown divergence is not a pause reason on its own.
export const isDivergenceExceeded = (symbol: string, divergencePct: Decimal | null): boolean => !!divergencePct && divergencePct.gt(divergenceLimitPct(symbol));

// ---- Single opening entry liquidity guard (section 5) ----
// Notional must be <= 10 percent of the 30 second robust median visible relevant-side depth within 1 percent of the mark.
export const LIQUIDITY_SHARE = new Decimal('0.10');
export const maxNotionalByLiquidity = (robustDepthUsd: Decimal): Decimal => robustDepthUsd.mul(LIQUIDITY_SHARE);

// ---- Order rate limits (section 5): exposure-increasing requests per account ----
export const ORDER_RATE_PER_SECOND = 5;
export const ORDER_RATE_PER_MINUTE = 120;

// ---- Limit order expiry choices (section 4) ----
export const EXPIRY_CHOICES = ['GTC', '5m', '1h', '24h', '30d'] as const;
export type ExpiryChoice = (typeof EXPIRY_CHOICES)[number];
const EXPIRY_MS: Record<Exclude<ExpiryChoice, 'GTC'>, number> = {
  '5m': 5 * 60_000,
  '1h': 3_600_000,
  '24h': 86_400_000,
  '30d': 30 * 86_400_000,
};
// GTC never expires (null).
export const expiryToDate = (choice: ExpiryChoice, now = Date.now()): Date | null => (choice === 'GTC' ? null : new Date(now + EXPIRY_MS[choice]));

// ---- Leverage (section 5) ----
// Selected leverage defaults to min(3x, maximum available).
export const defaultLeverage = (maxAvailable: number): number => Math.min(3, maxAvailable);

// ---- Maintenance margin (section 8) ----
// Per position: |qty| x mark x (0.5 / the symbol's MAX permitted leverage). It does NOT depend on the leverage the trader selected.
export const MAINTENANCE_FACTOR = new Decimal('0.5');
export function maintenanceMargin(notionalAtMark: Decimal, symbolMaxLeverage: number): Decimal {
  return symbolMaxLeverage > 0 ? notionalAtMark.mul(MAINTENANCE_FACTOR).div(symbolMaxLeverage) : new Decimal(0);
}

// ---- Minimum residual after a partial close (section 4 / TC-051) ----
// A partial close that would leave less than the minimum notional is rejected (the trader must close the whole position).
export const residualTooSmall = (residualSize: Decimal, mark: Decimal, minNotionalUsd: Decimal.Value): boolean =>
  residualSize.gt(0) && residualSize.mul(mark).lt(minNotionalUsd);