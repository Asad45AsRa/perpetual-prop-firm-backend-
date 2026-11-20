import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import { priceFeed } from '../../src/modules/markets/price-feed';
import { createMarket, setMarket, wipeDatabase } from './helpers';

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  await wipeDatabase();
  await createMarket();
  (priceFeed as any).addTracked({ symbol: 'BTC', coin: 'BTC' }); // no Hyperliquid socket in this test
  setMarket('BTC', { bids: [[89990, 2], [89980, 3]], asks: [[90000, 1], [90010, 4]], mark: 90000 });
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
});

describe('market data routes', () => {
  it('lists the supported markets with live price, limits and feed health', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/markets' });
    expect(res.statusCode).toBe(200);
    const [btc] = res.json();
    expect(btc).toMatchObject({ symbol: 'BTC', maxLeverage: 10, bid: '89990', ask: '90000', mark: '90000', priceFresh: true, tradable: true, sizeStep: '0.00001' });
  });

  it('returns one market, its price and its order book', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/markets/BTC' })).json().symbol).toBe('BTC');
    const price = (await app.inject({ method: 'GET', url: '/api/v1/markets/btc/price' })).json();
    expect(price).toMatchObject({ price: '89995', fresh: true, bookFresh: true, markFresh: true });
    const book = (await app.inject({ method: 'GET', url: '/api/v1/markets/BTC/book?depth=1' })).json();
    expect(book.bids).toEqual([['89990', '2']]);
    expect(book.asks).toEqual([['90000', '1']]);
  });

  it('shows feed status and 404 for an unknown market', async () => {
    const status = (await app.inject({ method: 'GET', url: '/api/v1/markets/feed/status' })).json();
    expect(status.symbols.some((s: { symbol: string; bookFresh: boolean }) => s.symbol === 'BTC' && s.bookFresh)).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/api/v1/markets/NOPE' })).statusCode).toBe(404);
  });

  it('marks a market as not tradable when its price is stale', async () => {
    setMarket('BTC', { mark: 90000, bookAgeMs: 6000 });
    const [btc] = (await app.inject({ method: 'GET', url: '/api/v1/markets' })).json();
    expect(btc).toMatchObject({ bookFresh: false, priceFresh: false, tradable: false });
    setMarket('BTC', { mark: 90000 });
  });
});

describe('trading routes need a signed-in trader', () => {
  it('rejects anonymous requests', async () => {
    for (const [method, url] of [
      ['GET', '/api/v1/trading/accounts'],
      ['POST', '/api/v1/trading/accounts/6f1e0e4e-8c53-4a4e-9a56-4f0d6a1b2c3d/orders'],
      ['DELETE', '/api/v1/trading/accounts/6f1e0e4e-8c53-4a4e-9a56-4f0d6a1b2c3d/orders'],
    ] as const) {
      expect((await app.inject({ method, url, payload: {} })).statusCode).toBe(401);
    }
  });
});
