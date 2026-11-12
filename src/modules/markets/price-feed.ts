import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { Decimal } from '../../utils/decimal';
import { fetchAllMids } from './hyperliquid.client';

export interface PriceTick {
  symbol: string;
  mid: Decimal;
  bid: Decimal | null;
  ask: Decimal | null;
  // Unix ms when we last heard about this symbol
  ts: number;
}

// Keeps the latest price of every tracked symbol in memory.
// Source: Hyperliquid WebSocket (allMids + l2Book), with a REST snapshot
// on startup and after every reconnect. Emits "price" for each update.
class PriceFeed extends EventEmitter {
  private ws: WebSocket | null = null;
  private prices = new Map<string, PriceTick>();
  private tracked = new Set<string>();
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private attempts = 0;
  private stopped = false;
  private lastMessageAt = 0;

  start(symbols: string[]) {
    symbols.forEach((s) => this.tracked.add(s));
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  // Start tracking a symbol that an admin just enabled.
  track(symbol: string) {
    if (this.tracked.has(symbol)) return;
    this.tracked.add(symbol);
    this.subscribeBook(symbol);
  }

  untrack(symbol: string) {
    this.tracked.delete(symbol);
  }

  getPrice(symbol: string): PriceTick | undefined {
    return this.prices.get(symbol);
  }

  // A price older than STALE_PRICE_MS must never be used for trading.
  isFresh(symbol: string): boolean {
    const tick = this.prices.get(symbol);
    return !!tick && Date.now() - tick.ts <= env.STALE_PRICE_MS;
  }

  allPrices(): PriceTick[] {
    return [...this.prices.values()];
  }

  status() {
    return {
      connected: this.ws?.readyState === WebSocket.OPEN,
      tracked: [...this.tracked],
      lastMessageAgeMs: this.lastMessageAt ? Date.now() - this.lastMessageAt : null,
    };
  }

  // --------------------------- internals ------------------------------

  private connect() {
    if (this.stopped) return;
    const ws = new WebSocket(env.HYPERLIQUID_WS_URL);
    this.ws = ws;

    ws.on('open', async () => {
      logger.info('Hyperliquid WebSocket connected');
      this.attempts = 0;
      this.send({ method: 'subscribe', subscription: { type: 'allMids' } });
      this.tracked.forEach((s) => this.subscribeBook(s));
      // Recovery: fill the cache from REST so we do not wait for the first tick
      await this.loadSnapshot();
      this.pingTimer = setInterval(() => this.send({ method: 'ping' }), 30_000);
    });

    ws.on('message', (raw) => {
      this.lastMessageAt = Date.now();
      try {
        this.handleMessage(JSON.parse(raw.toString()));
      } catch (err) {
        logger.warn({ err }, 'Could not parse Hyperliquid message');
      }
    });

    ws.on('close', () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      if (this.stopped) return;
      // Exponential backoff, capped at 30 seconds
      const delay = Math.min(30_000, 1000 * 2 ** this.attempts++);
      logger.warn({ delay }, 'Hyperliquid WebSocket closed, reconnecting');
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    });

    ws.on('error', (err) => logger.error({ err }, 'Hyperliquid WebSocket error'));
  }

  private send(payload: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }

  private subscribeBook(symbol: string) {
    this.send({ method: 'subscribe', subscription: { type: 'l2Book', coin: symbol } });
  }

  private async loadSnapshot() {
    try {
      const mids = await fetchAllMids();
      this.applyMids(mids);
    } catch (err) {
      logger.warn({ err }, 'Could not load Hyperliquid price snapshot');
    }
  }

  private handleMessage(msg: { channel?: string; data?: any }) {
    if (msg.channel === 'allMids') {
      this.applyMids(msg.data?.mids ?? {});
    } else if (msg.channel === 'l2Book') {
      const { coin, levels } = msg.data ?? {};
      const bid = levels?.[0]?.[0]?.px;
      const ask = levels?.[1]?.[0]?.px;
      const current = this.prices.get(coin);
      if (this.tracked.has(coin) && bid && ask) {
        this.update({
          symbol: coin,
          mid: current?.mid ?? new Decimal(bid).plus(ask).div(2),
          bid: new Decimal(bid),
          ask: new Decimal(ask),
          ts: Date.now(),
        });
      }
    }
  }

  private applyMids(mids: Record<string, string>) {
    for (const symbol of this.tracked) {
      const px = mids[symbol];
      if (!px) continue;
      const current = this.prices.get(symbol);
      this.update({
        symbol,
        mid: new Decimal(px),
        bid: current?.bid ?? null,
        ask: current?.ask ?? null,
        ts: Date.now(),
      });
    }
  }

  private update(tick: PriceTick) {
    this.prices.set(tick.symbol, tick);
    this.emit('price', tick);
  }
}

export const priceFeed = new PriceFeed();
