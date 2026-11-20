// The real Hyperliquid cannot be called from a test, so this file runs a small FAKE Hyperliquid
// (REST /info + WebSocket) on localhost and checks the real client and price feed against it.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let httpServer: http.Server;
let wss: WebSocketServer;
const sockets = new Set<WsSocket>();
const subscriptions: any[] = [];
const requests: any[] = [];
let failInfo = 0;

const book = (px: number) => ({
  coin: 'BTC',
  time: Date.now(),
  levels: [[{ px: String(px - 5), sz: '2', n: 1 }], [{ px: String(px + 5), sz: '2', n: 1 }]],
});
const ctx = (px: number) => ({ funding: '0.0000125', openInterest: '1', prevDayPx: '1', dayNtlVlm: '1', premium: '0', oraclePx: String(px - 1), markPx: String(px), midPx: String(px), impactPxs: null });

beforeAll(async () => {
  httpServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const msg = JSON.parse(body || '{}');
      requests.push(msg);
      if (failInfo > 0) {
        failInfo--;
        res.writeHead(503).end('busy');
        return;
      }
      res.setHeader('content-type', 'application/json');
      if (msg.type === 'meta') res.end(JSON.stringify({ universe: [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 }] }));
      else if (msg.type === 'metaAndAssetCtxs') res.end(JSON.stringify([{ universe: [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 }] }, [ctx(90000)]]));
      else if (msg.type === 'l2Book') res.end(JSON.stringify(book(90000)));
      else if (msg.type === 'fundingHistory') res.end(JSON.stringify([{ coin: 'BTC', fundingRate: '0.0001', premium: '0', time: msg.startTime + 600_000 }]));
      else res.writeHead(422).end('bad request');
    });
  });
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
  wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  wss.on('connection', (ws) => {
    sockets.add(ws);
    ws.on('message', (raw) => subscriptions.push(JSON.parse(raw.toString())));
    ws.on('close', () => sockets.delete(ws));
  });
  const port = (httpServer.address() as AddressInfo).port;
  process.env.HYPERLIQUID_REST_URL = `http://127.0.0.1:${port}`;
  process.env.HYPERLIQUID_WS_URL = `ws://127.0.0.1:${port}/ws`;
});

afterAll(async () => {
  wss.close();
  await new Promise((r) => httpServer.close(r));
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await wait(25);
  }
  return fn();
};

describe('Hyperliquid REST client', () => {
  it('loads metadata, contexts, books and funding history', async () => {
    const c = await import('../../src/modules/markets/hyperliquid.client');
    expect((await c.fetchPerpMeta())[0].name).toBe('BTC');
    const { ctxs } = await c.fetchMetaAndAssetCtxs();
    expect(ctxs.get('BTC')!.markPx).toBe('90000');
    expect((await c.fetchL2Book('BTC')).levels[1][0].px).toBe('90005');
    expect((await c.fetchFundingHistory('BTC', 1000))[0].fundingRate).toBe('0.0001');
  });

  it('retries a busy server (5xx) but not a client error', async () => {
    const c = await import('../../src/modules/markets/hyperliquid.client');
    failInfo = 2;
    expect((await c.fetchPerpMeta())[0].name).toBe('BTC'); // 2 failures, 3rd attempt works
    requests.length = 0;
    await expect(c.fetchAllMids()).rejects.toThrow(/422/);
    expect(requests).toHaveLength(1); // no retry for a 4xx
  });
});

describe('price feed against a fake Hyperliquid', () => {
  it('subscribes, loads the REST snapshot, streams books and marks, and reconnects after a drop', async () => {
    const { priceFeed } = await import('../../src/modules/markets/price-feed');
    priceFeed.start([{ symbol: 'BTC', coin: 'BTC' }]);

    // Snapshot + subscriptions
    expect(await until(() => priceFeed.isFresh('BTC'))).toBe(true);
    expect(await until(() => subscriptions.length >= 2)).toBe(true);
    expect(subscriptions.map((s) => s.subscription?.type).sort()).toEqual(['activeAssetCtx', 'l2Book']);
    expect(priceFeed.getPrice('BTC')!.mid.toString()).toBe('90000');
    expect(priceFeed.status().connected).toBe(true);

    // Live updates over the socket
    const ws = [...sockets][0];
    ws.send(JSON.stringify({ channel: 'l2Book', data: { ...book(91000), time: Date.now() + 10_000 } }));
    ws.send(JSON.stringify({ channel: 'activeAssetCtx', data: { coin: 'BTC', ctx: ctx(91000) } }));
    expect(await until(() => priceFeed.getPrice('BTC')?.mid.toString() === '91000')).toBe(true);
    expect(priceFeed.getMark('BTC')!.mark.toString()).toBe('91000');
    expect(priceFeed.getMark('BTC')!.oracle.toString()).toBe('90999');

    // Unknown coins and garbage are ignored
    ws.send(JSON.stringify({ channel: 'l2Book', data: { ...book(1), coin: 'DOGE' } }));
    ws.send('not json');
    await wait(100);
    expect(priceFeed.getBook('DOGE')).toBeUndefined();

    // Connection drop: the feed reconnects and subscribes again
    const before = subscriptions.length;
    sockets.forEach((s) => s.terminate());
    expect(await until(() => sockets.size === 1 && subscriptions.length >= before + 2, 8000)).toBe(true);
    expect(priceFeed.status().reconnects).toBeGreaterThanOrEqual(1);

    priceFeed.untrack('BTC');
    expect(priceFeed.getBook('BTC')).toBeUndefined();
    priceFeed.stop();
  }, 20_000);
});
