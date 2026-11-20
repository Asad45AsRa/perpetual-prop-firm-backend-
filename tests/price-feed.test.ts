import { describe, expect, it } from 'vitest';
import { priceFeed } from '../src/modules/markets/price-feed';

const lv = (px: string, sz: string) => ({ px, sz, n: 1 });
const bids = [lv('89990', '0.2'), lv('89980', '0.5')];
const asks = [lv('90000', '0.1'), lv('90010', '0.2')];
const ctx = { markPx: '89995', oraclePx: '89990', funding: '0.0000125' };

describe('price feed freshness', () => {
  it('needs BOTH a fresh book and a fresh mark price to allow trading', () => {
    const t0 = 1_000_000;
    expect(priceFeed.ingestBook('T1', bids, asks, 100, t0)).toBe(true);
    // book only: not tradable
    expect(priceFeed.isBookFresh('T1', t0 + 1000)).toBe(true);
    expect(priceFeed.isFresh('T1', t0 + 1000)).toBe(false);

    expect(priceFeed.ingestMark('T1', ctx, t0)).toBe(true);
    expect(priceFeed.isFresh('T1', t0 + 1000)).toBe(true);

    // book older than 5 s -> stale even though the mark is still fresh
    expect(priceFeed.isBookFresh('T1', t0 + 5001)).toBe(false);
    expect(priceFeed.isMarkFresh('T1', t0 + 5001)).toBe(true);
    expect(priceFeed.isFresh('T1', t0 + 5001)).toBe(false);

    // book refreshed but the mark is older than 10 s -> still blocked
    priceFeed.ingestBook('T1', bids, asks, 200, t0 + 10_500);
    expect(priceFeed.isBookFresh('T1', t0 + 10_600)).toBe(true);
    expect(priceFeed.isMarkFresh('T1', t0 + 10_600)).toBe(false);
    expect(priceFeed.isFresh('T1', t0 + 10_600)).toBe(false);
  });

  it('exposes mid, bid, ask, mark, oracle and funding', () => {
    const now = Date.now();
    priceFeed.ingestBook('T2', bids, asks, 1, now);
    priceFeed.ingestMark('T2', ctx, now);
    const tick = priceFeed.getPrice('T2')!;
    expect(tick.mid.toString()).toBe('89995');
    expect(tick.bid!.toString()).toBe('89990');
    expect(tick.ask!.toString()).toBe('90000');
    expect(tick.mark!.toString()).toBe('89995');
    expect(tick.oracle!.toString()).toBe('89990');
    expect(tick.funding!.toString()).toBe('0.0000125');
  });
});

describe('price feed input protection', () => {
  it('drops a book that is older than the stored one (reconnect replay)', () => {
    expect(priceFeed.ingestBook('T3', bids, asks, 500, 1000)).toBe(true);
    expect(priceFeed.ingestBook('T3', [lv('1', '1')], [lv('2', '1')], 400, 2000)).toBe(false);
    expect(priceFeed.getBook('T3')!.bids[0].price.toString()).toBe('89990');
    // same or newer exchange time is accepted
    expect(priceFeed.ingestBook('T3', bids, asks, 500, 3000)).toBe(true);
  });

  it('rejects a crossed or empty book', () => {
    expect(priceFeed.ingestBook('T4', [lv('100', '1')], [lv('99', '1')], 1)).toBe(false);
    expect(priceFeed.ingestBook('T4', [], asks, 1)).toBe(false);
    expect(priceFeed.getBook('T4')).toBeUndefined();
  });

  it('skips malformed and empty levels, and sorts best first', () => {
    priceFeed.ingestBook('T5', [lv('89980', '0.5'), lv('abc', '1'), lv('89990', '0'), lv('89990', '0.2')], [lv('90010', '1'), lv('90000', '1')], 1);
    const book = priceFeed.getBook('T5')!;
    expect(book.bids.map((l) => l.price.toString())).toEqual(['89990', '89980']);
    expect(book.asks.map((l) => l.price.toString())).toEqual(['90000', '90010']);
  });

  it('rejects an invalid mark price', () => {
    expect(priceFeed.ingestMark('T6', { markPx: '0', oraclePx: '1', funding: '0' })).toBe(false);
    expect(priceFeed.ingestMark('T6', { markPx: 'x', oraclePx: '1', funding: '0' })).toBe(false);
  });

  it('emits events for every accepted update', () => {
    const seen: string[] = [];
    const onBook = (b: { symbol: string }) => seen.push(`book:${b.symbol}`);
    priceFeed.on('book', onBook);
    priceFeed.ingestBook('T7', bids, asks, 1);
    priceFeed.off('book', onBook);
    expect(seen).toEqual(['book:T7']);
  });
});
