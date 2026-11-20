import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { consumeBook, eligibleSize, levelsToJson, slippagePct, type BookSnapshot } from '../src/modules/trading/engine/orderbook';

const d = (v: Decimal.Value) => new Decimal(v);
const lv = (price: string, size: string) => ({ price: d(price), size: d(size) });

const book: BookSnapshot = {
  symbol: 'BTC',
  bids: [lv('89990', '0.2'), lv('89980', '0.5')],
  asks: [lv('90000', '0.1'), lv('90010', '0.2'), lv('90020', '0.2')],
  receivedAt: 0,
  exchangeTime: null,
  seq: 1,
};

describe('consumeBook', () => {
  it('computes the VWAP over several ask levels (spec fixture)', () => {
    const r = consumeBook(book, 'BUY', d('0.3'));
    expect(r.vwap!.toFixed(6)).toBe('90006.666667');
    expect(r.notional.toString()).toBe('27002');
    expect(r.filledSize.toString()).toBe('0.3');
    expect(r.exhausted).toBe(false);
    expect(levelsToJson(r.taken)).toEqual([
      ['90000', '0.1'],
      ['90010', '0.2'],
    ]);
  });

  it('walks the bids from the highest price down for a SELL', () => {
    const r = consumeBook(book, 'SELL', d('0.3'));
    // 0.2 @ 89990 + 0.1 @ 89980
    expect(r.notional.toString()).toBe('26996');
    expect(r.vwap!.toFixed(4)).toBe('89986.6667');
  });

  it('reports a thin book instead of inventing size', () => {
    const r = consumeBook(book, 'BUY', d('2'));
    expect(r.filledSize.toString()).toBe('0.5');
    expect(r.exhausted).toBe(true);
  });

  it('never trades through a limit price', () => {
    const r = consumeBook(book, 'BUY', d('0.5'), d('90010'));
    expect(r.filledSize.toString()).toBe('0.3');
    expect(r.exhausted).toBe(true);
    const none = consumeBook(book, 'BUY', d('0.5'), d('89999'));
    expect(none.filledSize.toString()).toBe('0');
    expect(none.vwap).toBeNull();
  });

  it('sums the eligible size at the limit or better', () => {
    expect(eligibleSize(book, 'BUY', d('90010')).toString()).toBe('0.3');
    expect(eligibleSize(book, 'SELL', d('89985')).toString()).toBe('0.2');
  });
});

describe('slippagePct', () => {
  it('is vwap / best ask - 1 for a BUY', () => {
    expect(slippagePct('BUY', d('90006.666667'), d('90000')).toFixed(6)).toBe('0.007407');
  });
  it('is (best bid - vwap) / best bid for a SELL', () => {
    expect(slippagePct('SELL', d('99'), d('100')).toString()).toBe('1');
  });
  it('treats a better-than-best price as zero slippage', () => {
    expect(slippagePct('BUY', d('99'), d('100')).toString()).toBe('0');
  });
});
