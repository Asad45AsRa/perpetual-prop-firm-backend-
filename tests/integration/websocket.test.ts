import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { marketWebSocket } from '../../src/modules/markets/market.ws';
import { priceFeed } from '../../src/modules/markets/price-feed';
import { lv } from './helpers';

// Live price push to browsers: /ws/market
let app: ReturnType<typeof Fastify>;
let url: string;

const open = (): Promise<{ ws: WebSocket; messages: any[] }> =>
  new Promise((resolve) => {
    const ws = new WebSocket(url);
    const messages: any[] = [];
    ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
    ws.on('open', () => resolve({ ws, messages }));
  });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let clock = 1_000;
const feed = (symbol: string, price: number, ageMs = 0) => {
  const now = Date.now() - ageMs;
  // Increasing exchange time: the feed drops anything older than the stored book
  priceFeed.ingestBook(symbol, [lv(price - 5, 1)], [lv(price + 5, 1)], ++clock, now);
  priceFeed.ingestMark(symbol, { markPx: String(price), oraclePx: String(price), funding: '0.00001' }, now);
};

beforeAll(async () => {
  // No Hyperliquid socket here: the test feeds data directly
  (priceFeed as any).addTracked({ symbol: 'WSBTC', coin: 'WSBTC' });
  (priceFeed as any).addTracked({ symbol: 'WSETH', coin: 'WSETH' });
  feed('WSBTC', 90000);
  feed('WSETH', 3000);
  app = Fastify();
  await app.register(websocket);
  await app.register(marketWebSocket);
  await app.listen({ port: 0, host: '127.0.0.1' });
  url = `ws://127.0.0.1:${(app.server.address() as { port: number }).port}/ws/market`;
});

afterAll(async () => {
  await app.close();
});

describe('/ws/market', () => {
  it('sends hello and the current prices to a new client', async () => {
    const { ws, messages } = await open();
    await wait(150);
    expect(messages[0].type).toBe('hello');
    const prices = messages.filter((m) => m.type === 'price');
    expect(prices.map((p) => p.symbol).sort()).toEqual(['WSBTC', 'WSETH']);
    const btc = prices.find((p) => p.symbol === 'WSBTC');
    expect(btc.price).toBe('90000');
    expect(btc.fresh).toBe(true);
    expect(btc.mark).toBe('90000');
    expect(btc.fundingRate).toBe('0.00001');
    ws.close();
  });

  it('pushes live updates, coalesced and only for subscribed symbols', async () => {
    const { ws, messages } = await open();
    ws.send(JSON.stringify({ op: 'subscribe', symbols: ['wsbtc'] }));
    await wait(100);
    messages.length = 0;

    for (let i = 1; i <= 20; i++) feed('WSBTC', 90000 + i);
    feed('WSETH', 3001);
    await wait(500);

    const prices = messages.filter((m) => m.type === 'price');
    expect(prices.every((p) => p.symbol === 'WSBTC')).toBe(true);
    expect(prices.length).toBeGreaterThanOrEqual(1);
    expect(prices.length).toBeLessThan(20); // 20 updates were merged
    expect(prices[prices.length - 1].price).toBe('90020');
    ws.close();
  });

  it('sends book updates only to clients that ask for them', async () => {
    feed('WSBTC', 90000);
    const { ws, messages } = await open();
    ws.send(JSON.stringify({ op: 'subscribe', symbols: ['WSBTC'], channels: ['book'] }));
    await wait(100);
    expect(messages.some((m) => m.type === 'book' && m.symbol === 'WSBTC')).toBe(true);
    const book = messages.find((m) => m.type === 'book');
    expect(book.bids[0]).toEqual(['89995', '1']);
    expect(book.asks[0]).toEqual(['90005', '1']);
    ws.close();
  });

  it('answers ping and survives invalid input', async () => {
    const { ws, messages } = await open();
    ws.send('not json');
    ws.send(JSON.stringify({ op: 'ping' }));
    await wait(100);
    expect(messages.some((m) => m.type === 'error' && m.code === 'INVALID_JSON')).toBe(true);
    expect(messages.some((m) => m.type === 'pong')).toBe(true);
    ws.close();
  });

  it('tells clients when a symbol becomes stale', async () => {
    const { ws, messages } = await open();
    await wait(1300); // first freshness check
    feed('WSETH', 3000, 3500); // 3.5 s old: still fresh, goes stale in about 1.5 s
    await wait(2800);
    const events = messages.filter((m) => m.type === 'feed' && m.symbol === 'WSETH');
    expect(events.some((e) => e.fresh === false && e.bookFresh === false)).toBe(true);
    ws.close();
  });
});
