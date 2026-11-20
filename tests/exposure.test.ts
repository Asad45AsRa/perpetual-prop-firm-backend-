import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { fundingCashflow, initialMargin, maintenanceMarginRef, scaleMarginOnReduce } from '../src/modules/trading/engine/calculations';
import { checkNewExposure, computeMetrics, isOverCap, symbolSideNotional, type Leg } from '../src/modules/trading/engine/exposure';

const d = (v: Decimal.Value) => new Decimal(v);
const leg = (over: Partial<Leg> = {}): Leg => ({
  marketKey: 'BTC',
  side: 'LONG',
  size: d(1),
  entryPrice: d(90000),
  mark: d(90000),
  margin: d(2000),
  ...over,
});

describe('margin formulas', () => {
  it('initial margin is notional / leverage and MMR is half of it (reference only)', () => {
    expect(initialMargin(d(20000), 10).toString()).toBe('2000');
    expect(initialMargin(d(20000), 5).toString()).toBe('4000');
    expect(maintenanceMarginRef(d(2000)).toString()).toBe('1000');
  });

  it('margin shrinks in proportion when a position is reduced', () => {
    expect(scaleMarginOnReduce(d(2000), d(2), d('0.5')).toString()).toBe('500');
    expect(scaleMarginOnReduce(d(2000), d(2), d(0)).toString()).toBe('0');
  });
});

describe('account metrics (cross margin)', () => {
  it('available margin = equity - initial margin - reserved (spec fixture)', () => {
    // equity 10,000 = balance 10,000 with no floating PnL, IM 2,000, reserved 1,000
    const m = computeMetrics(
      d(10000),
      [leg({ margin: d(2000) })],
      [{ marketKey: 'ETH', side: 'LONG', remaining: d(1), price: d(3000), reserved: d(1000) }],
    );
    expect(m.equity.toString()).toBe('10000');
    expect(m.availableMargin.toString()).toBe('7000');
    expect(m.maintenanceMarginRef.toString()).toBe('1000');
  });

  it('floating PnL moves equity but not the balance', () => {
    const m = computeMetrics(d(10000), [leg({ mark: d(91000) })]);
    expect(m.unrealizedPnl.toString()).toBe('1000');
    expect(m.equity.toString()).toBe('11000');
    expect(m.balance.toString()).toBe('10000');
  });

  it('counts both legs of a hedge in the gross exposure', () => {
    const m = computeMetrics(d(10000), [leg(), leg({ side: 'SHORT' })]);
    expect(m.grossExposure.toString()).toBe('180000');
    expect(m.unrealizedPnl.toString()).toBe('0');
  });

  it('adds the worst case of working orders to the gross exposure', () => {
    const m = computeMetrics(d(10000), [leg()], [{ marketKey: 'BTC', side: 'LONG', remaining: d('0.5'), price: d(90000), reserved: d(500) }]);
    expect(m.grossWithOrders.toString()).toBe('135000');
  });

  it('sums notional per market and side', () => {
    const legs = [leg(), leg({ side: 'SHORT', size: d(2) })];
    const working = [{ marketKey: 'BTC', side: 'LONG' as const, remaining: d('0.1'), price: d(90000), reserved: d(0) }];
    expect(symbolSideNotional(legs, working, 'BTC', 'LONG').toString()).toBe('99000');
    expect(symbolSideNotional(legs, working, 'BTC', 'SHORT').toString()).toBe('180000');
  });
});

describe('pre-trade exposure checks', () => {
  const base = computeMetrics(d(10000), []);
  const after = (balance: number, size: number, mark = 90000) =>
    computeMetrics(d(balance), [leg({ size: d(size), mark: d(mark), entryPrice: d(mark), margin: d(size * mark).div(10) })]);

  it('allows a position inside every limit', () => {
    const a = after(10000, 1, 10000); // 10,000 notional at 10x leverage
    expect(checkNewExposure({ before: base, after: a, grossMultiple: 10, symbolSideNotionalAfter: d(10000), symbolSideCap: 1_000_000, increasesExposure: true })).toBeNull();
  });

  it('rejects above the symbol cap', () => {
    const a = after(100000, 1);
    expect(checkNewExposure({ before: base, after: a, grossMultiple: 10, symbolSideNotionalAfter: d(310000), symbolSideCap: 300000, increasesExposure: true })).toBe('POSITION_CAP');
  });

  it('rejects when gross exposure goes above 10x equity (FX 20x leverage example)', () => {
    // equity 10k, 120k notional = 12x
    const a = computeMetrics(d(10000), [leg({ size: d(120000), mark: d(1), entryPrice: d(1), margin: d(6000) })]);
    expect(checkNewExposure({ before: base, after: a, grossMultiple: 10, symbolSideNotionalAfter: d(120000), symbolSideCap: null, increasesExposure: true })).toBe('GROSS_EXPOSURE_CAP');
    // 90k notional = 9x is fine
    const ok = computeMetrics(d(10000), [leg({ size: d(90000), mark: d(1), entryPrice: d(1), margin: d(4500) })]);
    expect(checkNewExposure({ before: base, after: ok, grossMultiple: 10, symbolSideNotionalAfter: d(90000), symbolSideCap: null, increasesExposure: true })).toBeNull();
  });

  it('rejects when the margin is not enough', () => {
    const a = computeMetrics(d(1000), [leg({ margin: d(2000) })]);
    expect(checkNewExposure({ before: base, after: a, grossMultiple: 100, symbolSideNotionalAfter: d(90000), symbolSideCap: null, increasesExposure: true })).toBe('INSUFFICIENT_MARGIN');
  });

  it('never blocks a pure reduction, even when the account is above the cap', () => {
    const over = computeMetrics(d(1000), [leg({ margin: d(5000) })]);
    expect(checkNewExposure({ before: over, after: over, grossMultiple: 10, symbolSideNotionalAfter: d(90000), symbolSideCap: 1, increasesExposure: false })).toBeNull();
    expect(isOverCap(over, 10)).toBe(true);
  });

  it('allows exposure that does not increase the gross while the account is above the cap', () => {
    const over = computeMetrics(d(1000), [leg({ margin: d(100) })]);
    expect(checkNewExposure({ before: over, after: over, grossMultiple: 10, symbolSideNotionalAfter: d(0), symbolSideCap: null, increasesExposure: true })).toBeNull();
  });
});

describe('funding', () => {
  it('long pays and short receives on a positive rate (spec fixture)', () => {
    expect(fundingCashflow('LONG', d(1), d(90000), '0.0001').toString()).toBe('-9');
    expect(fundingCashflow('SHORT', d(1), d(90000), '0.0001').toString()).toBe('9');
  });

  it('reverses on a negative rate', () => {
    expect(fundingCashflow('LONG', d(1), d(90000), '-0.0001').toString()).toBe('9');
    expect(fundingCashflow('SHORT', d(1), d(90000), '-0.0001').toString()).toBe('-9');
  });

  it('scales with size and oracle price', () => {
    expect(fundingCashflow('LONG', d('0.5'), d(100000), '0.0002').toString()).toBe('-10');
  });
});
