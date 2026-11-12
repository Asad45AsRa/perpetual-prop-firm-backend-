import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import {
  applyFill,
  isLiquidated,
  liquidationPrice,
  marketFillPrice,
  notional,
  requiredMargin,
  tradingFee,
  unrealizedPnl,
} from '../src/modules/trading/engine/calculations';

const d = (v: Decimal.Value) => new Decimal(v);

describe('basic formulas', () => {
  it('computes notional, margin and fee', () => {
    const n = notional(d('0.5'), d('60000'));
    expect(n.toString()).toBe('30000');
    expect(requiredMargin(n, 10).toString()).toBe('3000');
    expect(tradingFee(n, '0.00045').toString()).toBe('13.5');
  });

  it('computes unrealized PnL for long and short', () => {
    expect(unrealizedPnl('LONG', d(2), d(100), d(110)).toString()).toBe('20');
    expect(unrealizedPnl('SHORT', d(2), d(100), d(110)).toString()).toBe('-20');
  });
});

describe('marketFillPrice', () => {
  const base = { mid: d(100), bid: d('99.9'), ask: d('100.1'), spreadBps: 2, slippageBps: 1, pricePrecision: 2 };

  it('buys at ask plus slippage, rounded up', () => {
    // 100.1 * 1.0001 = 100.11001 -> 100.12 (rounded up)
    expect(marketFillPrice({ ...base, side: 'BUY' }).toString()).toBe('100.12');
  });

  it('sells at bid minus slippage, rounded down', () => {
    // 99.9 * 0.9999 = 99.89001 -> 99.89 (rounded down)
    expect(marketFillPrice({ ...base, side: 'SELL' }).toString()).toBe('99.89');
  });

  it('falls back to mid and spread without an order book', () => {
    const price = marketFillPrice({ ...base, bid: null, ask: null, side: 'BUY' });
    // 100 * 1.0001 * 1.0001 = 100.02000... -> 100.03
    expect(price.toString()).toBe('100.03');
  });
});

describe('applyFill (netting)', () => {
  it('opens a position from flat', () => {
    const r = applyFill(null, 'BUY', d(1), d(100));
    expect(r.position).toEqual({ side: 'LONG', size: d(1), entryPrice: d(100) });
    expect(r.realizedPnl.isZero()).toBe(true);
  });

  it('adds to a position with a weighted average entry', () => {
    const r = applyFill({ side: 'LONG', size: d(1), entryPrice: d(100) }, 'BUY', d(3), d(120));
    expect(r.position!.size.toString()).toBe('4');
    expect(r.position!.entryPrice.toString()).toBe('115');
  });

  it('reduces a position and realizes PnL', () => {
    const r = applyFill({ side: 'LONG', size: d(2), entryPrice: d(100) }, 'SELL', d(1), d(110));
    expect(r.position!.size.toString()).toBe('1');
    expect(r.realizedPnl.toString()).toBe('10');
  });

  it('closes a position completely', () => {
    const r = applyFill({ side: 'SHORT', size: d(2), entryPrice: d(100) }, 'BUY', d(2), d(90));
    expect(r.position).toBeNull();
    expect(r.realizedPnl.toString()).toBe('20');
  });

  it('flips direction when the fill is larger than the position', () => {
    const r = applyFill({ side: 'LONG', size: d(1), entryPrice: d(100) }, 'SELL', d(3), d(90));
    expect(r.realizedPnl.toString()).toBe('-10');
    expect(r.position).toEqual({ side: 'SHORT', size: d(2), entryPrice: d(90) });
  });
});

describe('liquidation', () => {
  it('computes liquidation prices', () => {
    expect(liquidationPrice('LONG', d(100), 10, '0.005').toString()).toBe('90.5');
    expect(liquidationPrice('SHORT', d(100), 10, '0.005').toString()).toBe('109.5');
  });

  it('detects liquidation', () => {
    expect(isLiquidated('LONG', d(90), d('90.5'))).toBe(true);
    expect(isLiquidated('LONG', d(95), d('90.5'))).toBe(false);
    expect(isLiquidated('SHORT', d(110), d('109.5'))).toBe(true);
  });
});
