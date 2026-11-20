import Decimal from 'decimal.js';

// =====================================================================
// Fee schedule and fee math (pure).
// Maker = a resting limit order that gets filled.
// Taker = market, stop, take-profit, stop-loss, IOC and any limit order that
//         crosses the book on placement.
// Fees are charged on the notional of every fill, on entries AND exits,
// also on losing trades.
// =====================================================================

export type FeeMarketType = 'CRYPTO' | 'EQUITY' | 'COMMODITY' | 'INDEX' | 'FX';
export type LiquidityKind = 'MAKER' | 'TAKER';

export interface FeeRates {
  maker: Decimal.Value;
  taker: Decimal.Value;
}
export type FeeSchedule = Record<FeeMarketType, FeeRates>;

// Default schedule, matches the public Hypernova rates used by the product spec.
// Admins can override it in the "trading" platform setting (key "fees").
export const DEFAULT_FEE_SCHEDULE: FeeSchedule = {
  CRYPTO: { maker: '0.0001', taker: '0.0004' }, // 0.01 percent / 0.04 percent
  EQUITY: { maker: '0', taker: '0.0003' }, // 0 / 0.03 percent
  COMMODITY: { maker: '0', taker: '0.00005' }, // 0 / 0.005 percent
  INDEX: { maker: '0', taker: '0.00005' },
  FX: { maker: '0', taker: '0.00005' },
};

export interface FeeRateInput {
  marketType: FeeMarketType;
  liquidity: LiquidityKind;
  schedule?: Partial<Record<FeeMarketType, FeeRates>>;
  // Per-market override from the market registry (null = use the schedule)
  makerOverride?: Decimal.Value | null;
  takerOverride?: Decimal.Value | null;
}

export function resolveFeeRate(input: FeeRateInput): Decimal {
  if (input.liquidity === 'MAKER' && input.makerOverride != null) return new Decimal(input.makerOverride);
  if (input.liquidity === 'TAKER' && input.takerOverride != null) return new Decimal(input.takerOverride);
  const rates = input.schedule?.[input.marketType] ?? DEFAULT_FEE_SCHEDULE[input.marketType];
  return new Decimal(input.liquidity === 'MAKER' ? rates.maker : rates.taker);
}

// Money in the ledger has 8 decimals. Fees are rounded UP so rounding never favours the trader.
export const LEDGER_DECIMALS = 8;

export function feeAmount(notional: Decimal, rate: Decimal.Value): Decimal {
  return notional.mul(rate).toDecimalPlaces(LEDGER_DECIMALS, Decimal.ROUND_UP);
}

// Signed ledger amounts (PnL, funding) are rounded toward minus infinity:
// a credit is cut down, a debit grows. Rounding never favours the trader.
export function roundLedger(amount: Decimal): Decimal {
  return amount.toDecimalPlaces(LEDGER_DECIMALS, Decimal.ROUND_FLOOR);
}
