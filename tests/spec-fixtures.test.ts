import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { applyFill, initialMargin, unrealizedPnl } from '../src/modules/trading/engine/calculations';
import { checkNewExposure, computeMetrics, type Leg } from '../src/modules/trading/engine/exposure';
import { DEFAULT_FEE_SCHEDULE, feeAmount, resolveFeeRate } from '../src/modules/trading/engine/fees';
import {
  defaultLeverage,
  divergenceLimitPct,
  expiryToDate,
  isDivergenceExceeded,
  maintenanceMargin,
  maxNotionalByLiquidity,
  residualTooSmall,
} from '../src/modules/trading/engine/market-policy';

const d = (v: Decimal.Value) => new Decimal(v);
const taker = resolveFeeRate({ marketType: 'CRYPTO', liquidity: 'TAKER', schedule: DEFAULT_FEE_SCHEDULE });
const maker = resolveFeeRate({ marketType: 'CRYPTO', liquidity: 'MAKER', schedule: DEFAULT_FEE_SCHEDULE });
const btcLeg = (over: Partial<Leg> = {}): Leg => ({ marketKey: 'BTC', side: 'LONG', size: d('0.1111111111'), entryPrice: d(90000), mark: d(90000), margin: d(1000), maxLeverage: 10, ...over });

describe('fees (TC-011 .. TC-016, TC-021, TC-022)', () => {
  it('uses 0.01 % maker and 0.04 % taker for crypto', () => {
    expect(maker.toString()).toBe('0.0001');
    expect(taker.toString()).toBe('0.0004');
  });

  it('TC-011 / TC-012: 10,000 notional taker 4.00, maker 1.00', () => {
    expect(feeAmount(d(10000), taker).toString()).toBe('4');
    expect(feeAmount(d(10000), maker).toString()).toBe('1');
  });

  it('TC-013 .. TC-015: round trips 8 / 5 / 2', () => {
    const fee = (a: Decimal, b: Decimal) => feeAmount(d(10000), a).plus(feeAmount(d(10000), b)).toString();
    expect(fee(taker, taker)).toBe('8');
    expect(fee(maker, taker)).toBe('5');
    expect(fee(maker, maker)).toBe('2');
  });

  it('TC-021: 100 market-to-market round trips cost 800', () => {
    const one = feeAmount(d(10000), taker).mul(2);
    expect(one.mul(100).toString()).toBe('800');
  });

  it('TC-022: entry 100, exit 101, quantity 100: gross 100, fees 4 + 4.04, net 91.96', () => {
    const entryFee = feeAmount(d(100).mul(100), taker);
    const exitFee = feeAmount(d(101).mul(100), taker);
    const fill = applyFill({ side: 'LONG', size: d(100), entryPrice: d(100) }, 'SELL', d(100), d(101));
    expect(entryFee.toString()).toBe('4');
    expect(exitFee.toString()).toBe('4.04');
    expect(fill.realizedPnl.toString()).toBe('100');
    expect(fill.realizedPnl.minus(entryFee).minus(exitFee).toString()).toBe('91.96');
  });
});

describe('margin and capacity (TC-023 .. TC-029, TC-033, TC-114)', () => {
  it('TC-023 .. TC-025: initial margin = notional / leverage', () => {
    expect(initialMargin(d(10000), 10).toString()).toBe('1000');
    expect(initialMargin(d(10000), 5).toString()).toBe('2000');
    expect(initialMargin(d(10000), 2).toString()).toBe('5000');
  });

  it('TC-026: Elite 12,000, 10,000 BTC at 10x taker: balance 11,996, used 1,000, available 10,996', () => {
    const fee = feeAmount(d(10000), taker);
    const balance = d(12000).minus(fee);
    const m = computeMetrics(balance, [btcLeg({ size: d(10000).div(90000), margin: d(1000) })]);
    expect(balance.toString()).toBe('11996');
    expect(m.initialMargin.toString()).toBe('1000');
    expect(m.availableMargin.toString()).toBe('10996');
  });

  it('TC-027 / TC-028: floating loss reduces the capacity, floating profit does not increase it', () => {
    const size = d(10000).div(90000);
    const lossMark = d(90000).minus(d(200).div(size));
    const gainMark = d(90000).plus(d(200).div(size));
    const loss = computeMetrics(d(11996), [btcLeg({ size, margin: d(1000), mark: lossMark })]);
    const gain = computeMetrics(d(11996), [btcLeg({ size, margin: d(1000), mark: gainMark })]);
    expect(loss.equity.toDecimalPlaces(6).toString()).toBe('11796');
    expect(loss.availableMargin.toDecimalPlaces(6).toString()).toBe('10796');
    expect(gain.equity.toDecimalPlaces(6).toString()).toBe('12196');
    expect(gain.availableMargin.toDecimalPlaces(6).toString()).toBe('10996');
  });

  it('TC-029: a pending 10x limit entry of 5,000 reserves 500 initial margin', () => {
    expect(initialMargin(d(5000), 10).toString()).toBe('500');
  });

  it('TC-033 / TC-114: maintenance = 5 % of notional at 10x max leverage, regardless of the selected leverage', () => {
    expect(maintenanceMargin(d(10000), 10).toString()).toBe('500');
    const lowSelected = computeMetrics(d(12000), [btcLeg({ size: d(10000).div(90000), margin: initialMargin(d(10000), 2), maxLeverage: 10 })]);
    const highSelected = computeMetrics(d(12000), [btcLeg({ size: d(10000).div(90000), margin: initialMargin(d(10000), 10), maxLeverage: 10 })]);
    expect(lowSelected.maintenanceMargin.toDecimalPlaces(6).toString()).toBe('500');
    expect(highSelected.maintenanceMargin.toDecimalPlaces(6).toString()).toBe('500');
  });
});

describe('exposure (TC-035 .. TC-040)', () => {
  const grossCheck = (balance: number, multiple: number, grossBefore: number, add: number, leverage: number) => {
    const price = d(100);
    const before = computeMetrics(d(balance), grossBefore > 0 ? [btcLeg({ size: d(grossBefore).div(price), entryPrice: price, mark: price, margin: d(grossBefore).div(leverage) })] : []);
    const fee = feeAmount(d(add), taker);
    const afterLegs = [btcLeg({ size: d(grossBefore + add).div(price), entryPrice: price, mark: price, margin: d(grossBefore + add).div(leverage) })];
    const after = computeMetrics(d(balance).minus(fee), afterLegs);
    return checkNewExposure({ before, after, grossMultiple: multiple, symbolSideNotionalAfter: d(grossBefore + add), symbolSideCap: null, increasesExposure: true });
  };

  it('TC-037: Elite 12,000 cannot open 120,000 at 10x: margin 12,000 + fee 48 exceeds the balance', () => {
    expect(grossCheck(12000, 10, 0, 120000, 10)).toBe('INSUFFICIENT_MARGIN');
  });

  it('TC-038: 80,000 open, adding 50,000 breaks the 120,000 account cap', () => {
    expect(grossCheck(12000, 10, 80000, 50000, 10)).toBe('GROSS_EXPOSURE_CAP');
  });

  it('TC-036: Instant (3x) with 4,000 equity may not exceed 12,000 gross', () => {
    expect(grossCheck(4000, 3, 0, 13000, 10)).toBe('GROSS_EXPOSURE_CAP');
    expect(grossCheck(4000, 3, 0, 10000, 10)).toBeNull();
  });
});

describe('PnL (TC-063 .. TC-067)', () => {
  it('TC-063 / TC-064: long and short floating PnL', () => {
    expect(unrealizedPnl('LONG', d(1), d(90000), d(91000)).toString()).toBe('1000');
    expect(unrealizedPnl('SHORT', d(1), d(90000), d(91000)).toString()).toBe('-1000');
  });

  it('TC-065: closing 1 of 2 BTC at 91,000 realizes +1,000 and keeps the entry price', () => {
    const r = applyFill({ side: 'LONG', size: d(2), entryPrice: d(90000) }, 'SELL', d(1), d(91000));
    expect(r.realizedPnl.toString()).toBe('1000');
    expect(r.position!.size.toString()).toBe('1');
    expect(r.position!.entryPrice.toString()).toBe('90000');
  });

  it('TC-066: adding 1 BTC at 92,000 to 1 BTC at 90,000 gives an average entry of 91,000', () => {
    const r = applyFill({ side: 'LONG', size: d(1), entryPrice: d(90000) }, 'BUY', d(1), d(92000));
    expect(r.position!.size.toString()).toBe('2');
    expect(r.position!.entryPrice.toString()).toBe('91000');
  });
});

describe('market policy numbers (TC-044, TC-051, TC-106, TC-107, TC-058, leverage default)', () => {
  it('TC-044: 200,000 visible depth allows an order of 20,000 (10 %)', () => {
    expect(maxNotionalByLiquidity(d(200000)).toString()).toBe('20000');
  });

  it('TC-051: a partial close that leaves less than 10 USD of position is rejected', () => {
    expect(residualTooSmall(d('0.0001'), d(50000), 10)).toBe(true); // 5 USD left
    expect(residualTooSmall(d('0.0001998'), d(50000), 10)).toBe(true); // 9.99 USD left
    expect(residualTooSmall(d('0.0002'), d(50000), 10)).toBe(false); // exactly 10 USD left
    expect(residualTooSmall(d('0.001'), d(50000), 10)).toBe(false); // 50 USD left
    expect(residualTooSmall(d(0), d(50000), 10)).toBe(false); // closing everything is always fine
  });

  it('TC-106 / TC-107: divergence limits are 0.75 % for BTC / ETH / SOL and 1.5 % for the others', () => {
    expect(divergenceLimitPct('BTC').toString()).toBe('0.75');
    expect(divergenceLimitPct('HYPE').toString()).toBe('1.5');
    expect(isDivergenceExceeded('BTC', d('1.0'))).toBe(true);
    expect(isDivergenceExceeded('HYPE', d('1.0'))).toBe(false);
    expect(isDivergenceExceeded('BTC', d('0.75'))).toBe(false);
    expect(isDivergenceExceeded('BTC', null)).toBe(false);
  });

  it('TC-058: limit expiry choices', () => {
    const now = Date.UTC(2026, 10, 23, 12, 0, 0);
    expect(expiryToDate('GTC', now)).toBeNull();
    expect(expiryToDate('5m', now)!.getTime() - now).toBe(300_000);
    expect(expiryToDate('1h', now)!.getTime() - now).toBe(3_600_000);
    expect(expiryToDate('24h', now)!.getTime() - now).toBe(86_400_000);
    expect(expiryToDate('30d', now)!.getTime() - now).toBe(30 * 86_400_000);
  });

  it('selected leverage defaults to min(3x, maximum available)', () => {
    expect(defaultLeverage(10)).toBe(3);
    expect(defaultLeverage(2)).toBe(2);
  });
});