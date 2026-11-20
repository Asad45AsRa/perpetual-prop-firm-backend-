import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { DEFAULT_FEE_SCHEDULE, feeAmount, resolveFeeRate, roundLedger } from '../src/modules/trading/engine/fees';
import { checkPrice, checkSize } from '../src/modules/trading/engine/validation';

const d = (v: Decimal.Value) => new Decimal(v);

describe('fee schedule', () => {
  it('uses the crypto maker / taker rates', () => {
    expect(feeAmount(d(20000), resolveFeeRate({ marketType: 'CRYPTO', liquidity: 'TAKER' })).toString()).toBe('8');
    expect(feeAmount(d(20000), resolveFeeRate({ marketType: 'CRYPTO', liquidity: 'MAKER' })).toString()).toBe('2');
  });

  it('charges equities 0 maker and 0.03 percent taker', () => {
    expect(feeAmount(d(50000), resolveFeeRate({ marketType: 'EQUITY', liquidity: 'TAKER' })).toString()).toBe('15');
    expect(resolveFeeRate({ marketType: 'EQUITY', liquidity: 'MAKER' }).isZero()).toBe(true);
  });

  it('charges commodities, indices and FX 0.005 percent taker and 0 maker', () => {
    for (const t of ['COMMODITY', 'INDEX', 'FX'] as const) {
      expect(feeAmount(d(50000), resolveFeeRate({ marketType: t, liquidity: 'TAKER' })).toString()).toBe('2.5');
      expect(feeAmount(d(50000), resolveFeeRate({ marketType: t, liquidity: 'MAKER' })).toString()).toBe('0');
    }
  });

  it('matches the spec fee fixtures', () => {
    // exit fee uses the FILL price, not the trigger price
    expect(feeAmount(d(21000), DEFAULT_FEE_SCHEDULE.CRYPTO.taker).toString()).toBe('8.4');
    expect(feeAmount(d('27002'), DEFAULT_FEE_SCHEDULE.CRYPTO.taker).toString()).toBe('10.8008');
    expect(feeAmount(d('1.4').mul(91000), DEFAULT_FEE_SCHEDULE.CRYPTO.taker).toString()).toBe('50.96');
  });

  it('rounds fees UP at 8 decimals and signed amounts toward minus infinity', () => {
    expect(feeAmount(d('0.000000011'), '1').toFixed()).toBe('0.00000002');
    expect(roundLedger(d('1.123456789')).toString()).toBe('1.12345678');
    expect(roundLedger(d('-1.123456781')).toString()).toBe('-1.12345679');
  });

  it('lets a market override the group rate', () => {
    const rate = resolveFeeRate({ marketType: 'CRYPTO', liquidity: 'TAKER', takerOverride: '0.0002' });
    expect(rate.toString()).toBe('0.0002');
    const custom = resolveFeeRate({ marketType: 'CRYPTO', liquidity: 'MAKER', schedule: { CRYPTO: { maker: '0.00005', taker: '0.0003' } } });
    expect(custom.toString()).toBe('0.00005');
  });
});

describe('size and price validation', () => {
  const sizeRules = { sizeStep: '0.00001', minSize: '0.00001' };
  it('accepts multiples of the step and rejects the rest', () => {
    expect(checkSize(d('0.0001'), sizeRules)).toBe('OK');
    expect(checkSize(d('0.000015'), sizeRules)).toBe('INVALID_LOT');
    expect(checkSize(d(0), sizeRules)).toBe('INVALID_LOT');
    expect(checkSize(d(-1), sizeRules)).toBe('INVALID_LOT');
  });

  const priceRules = { pricePrecision: 1, priceTick: '0.1' };
  it('allows whole numbers and up to 5 significant figures', () => {
    expect(checkPrice(d('90000'), priceRules)).toBe(true);
    expect(checkPrice(d('90000.1'), priceRules)).toBe(false); // 6 significant figures
    expect(checkPrice(d('1234.5'), priceRules)).toBe(true);
    expect(checkPrice(d('1234.55'), priceRules)).toBe(false); // too many decimals
    expect(checkPrice(d(0), priceRules)).toBe(false);
  });

  it('respects the tick grid', () => {
    expect(checkPrice(d('0.25'), { pricePrecision: 2, priceTick: '0.05' })).toBe(true);
    expect(checkPrice(d('0.26'), { pricePrecision: 2, priceTick: '0.05' })).toBe(false);
  });
});
