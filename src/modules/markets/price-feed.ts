import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { env, staleBookMs, staleMarkMs } from '../../config/env';
import { logger } from '../../config/logger';
import { Decimal } from '../../utils/decimal';
import type { BookLevel, BookSnapshot } from '../trading/engine/orderbook';
import { bestAsk, bestBid, midPrice } from '../trading/engine/orderbook';
import {
  fetchL2Book,
  fetchMetaAndAssetCtxs,
  type CandleInterval,
  type HlAssetCtx,
  type HlCandle,
  type HlL2Book,
  type HlLevel,
  type HlTrade,
} from './hyperliquid.client';

// =====================================================================
// Live market data from Hyperliquid, kept in memory.
//   * l2Book          -> order book (bids / asks with depth), used for execution
//   * activeAssetCtx  -> mark price, oracle price, funding rate, used for PnL and funding
//                        (also 24h volume, open interest and previous day price for the terminal market bar)
//   * trades          -> public trade tape shown in the terminal (last TRADE_BUFFER_SIZE trades per symbol)
//   * candle          -> live candle updates, subscribed ON DEMAND per (symbol, interval) with reference counting
// Both streams are monitored SEPARATELY: a fresh mark with a stale book (or the other way round)
// still blocks trading, because neither a fill price nor the account risk can be trusted.
// A REST snapshot is loaded on startup and after every reconnect. A watchdog reconnects a socket
// that went silent without closing.
//
// Events: "book" (BookSnapshot), "mark" (MarkInfo), "price" (PriceTick, after every update),
//         "trades" (symbol, TradeTick[]), "candle" (CandleTick).
// =====================================================================

export interface MarkInfo {
  symbol: string;
  mark: Decimal;
  oracle: Decimal;
  // Current hourly funding rate estimate published by Hyperliquid
  funding: Decimal | null;
  // Terminal statistics from the same activeAssetCtx message (null when Hyperliquid did not send them)
  prevDayPx: Decimal | null;
  // 24h traded notional in USD
  dayNtlVlm: Decimal | null;
  // Open interest in base asset units (multiply by mark for USD)
  openInterest: Decimal | null;
  premium: Decimal | null;
  receivedAt: number;
}

// One public trade, normalised. side is the side of the AGGRESSOR (taker).
export interface TradeTick {
  symbol: string;
  price: Decimal;
  size: Decimal;
  side: 'BUY' | 'SELL';
  // Exchange timestamp in milliseconds
  time: number;
  tid: string;
}

// One candle, normalised (all numbers kept as Decimal until the JSON boundary).
export interface CandleTick {
  symbol: string;
  interval: CandleInterval;
  // Open time and close time in milliseconds
  openTime: number;
  closeTime: number;
  open: Decimal;
  high: Decimal;
  low: Decimal;
  close: Decimal;
  volume: Decimal;
  trades: number;
}

// Compact "latest price" view used by routes, the WebSocket push and the risk engine.
export interface PriceTick {
  symbol: string;
  // Mid of the best bid and ask
  mid: Decimal;
  bid: Decimal | null;
  ask: Decimal | null;
  mark: Decimal | null;
  oracle: Decimal | null;
  funding: Decimal | null;
  // Unix ms of the last book update (kept as "ts" for older callers)
  ts: number;
}

export interface TrackedMarket {
  symbol: string;
  // Exact Hyperliquid coin key (HIP-3 prefixes are kept)
  coin: string;
}

const PING_INTERVAL_MS = 30_000;
const WATCHDOG_INTERVAL_MS = 5_000;
const CTX_POLL_INTERVAL_MS = 5_000;
// The REST fallback only runs when the websocket mark is this old
const CTX_POLL_WHEN_OLDER_THAN_MS = 4_000;
// Public trades kept in memory per symbol (newest last)
const TRADE_BUFFER_SIZE = 200;

// Optional numeric field of a Hyperliquid context: missing, empty or invalid values become null.
function optionalDecimal(value: string | null | undefined): Decimal | null {
  if (value == null || value === '') return null;
  try {
    const d = new Decimal(value);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

// Converts raw Hyperliquid levels into sorted, validated levels. Bad rows are skipped.
function parseLevels(raw: HlLevel[] | undefined, side: 'BID' | 'ASK'): BookLevel[] {
  const levels: BookLevel[] = [];
  for (const row of raw ?? []) {
    try {
      const price = new Decimal(row.px);
      const size = new Decimal(row.sz);
      if (price.gt(0) && size.gt(0)) levels.push({ price, size });
    } catch {
      // ignore a malformed level
    }
  }
  // Hyperliquid already sends best-first, sorting again makes the result independent of that
  levels.sort((a, b) => (side === 'BID' ? b.price.comparedTo(a.price) : a.price.comparedTo(b.price)));
  return levels;
}

class PriceFeed extends EventEmitter {
  private ws: WebSocket | null = null;
  private books = new Map<string, BookSnapshot>();
  private marks = new Map<string, MarkInfo>();
  // symbol -> Hyperliquid coin key
  private tracked = new Map<string, string>();
  private coinToSymbol = new Map<string, string>();
  // symbol -> last trades (oldest first)
  private trades = new Map<string, TradeTick[]>();
  // "SYMBOL|interval" -> live candle subscription with the number of interested consumers
  private candleSubs = new Map<string, { symbol: string; coin: string; interval: CandleInterval; refs: number }>();
  // "SYMBOL|interval" -> newest candle received from the stream
  private latestCandles = new Map<string, CandleTick>();

  private pingTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private ctxPollTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private attempts = 0;
  private reconnects = 0;
  private stopped = true;
  private lastMessageAt = 0;
  private seq = 0;
  private droppedOutOfOrder = 0;

  // ------------------------------ lifecycle ------------------------------

  start(markets: Array<string | TrackedMarket>) {
    markets.forEach((m) => this.addTracked(m));
    this.stopped = false;
    this.connect();
    this.watchdogTimer = setInterval(() => this.watchdog(), WATCHDOG_INTERVAL_MS);
    this.ctxPollTimer = setInterval(() => void this.pollContexts(), CTX_POLL_INTERVAL_MS);
  }

  stop() {
    this.stopped = true;
    [this.pingTimer, this.watchdogTimer, this.ctxPollTimer].forEach((t) => t && clearInterval(t));
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pingTimer = this.watchdogTimer = this.ctxPollTimer = this.reconnectTimer = null;
    this.ws?.removeAllListeners();
    this.ws?.terminate();
    this.ws = null;
  }

  // Start tracking a market that an admin just enabled.
  track(symbol: string, coin: string = symbol) {
    if (this.tracked.has(symbol)) return;
    this.addTracked({ symbol, coin });
    this.subscribe(coin);
    void this.loadSnapshot([{ symbol, coin }]);
  }

  untrack(symbol: string) {
    const coin = this.tracked.get(symbol);
    if (!coin) return;
    this.send({ method: 'unsubscribe', subscription: { type: 'l2Book', coin } });
    this.send({ method: 'unsubscribe', subscription: { type: 'activeAssetCtx', coin } });
    this.send({ method: 'unsubscribe', subscription: { type: 'trades', coin } });
    for (const [key, sub] of [...this.candleSubs]) {
      if (sub.symbol !== symbol) continue;
      this.send({ method: 'unsubscribe', subscription: { type: 'candle', coin, interval: sub.interval } });
      this.candleSubs.delete(key);
      this.latestCandles.delete(key);
    }
    this.tracked.delete(symbol);
    this.coinToSymbol.delete(coin);
    // A market that is no longer tracked must not keep a price that can look fresh
    this.books.delete(symbol);
    this.marks.delete(symbol);
    this.trades.delete(symbol);
  }

  // Live candles on demand. Every call must be paired with one unsubscribeCandle call.
  // The Hyperliquid subscription exists while at least one consumer needs it.
  subscribeCandle(symbol: string, interval: CandleInterval): boolean {
    const coin = this.tracked.get(symbol);
    if (!coin) return false;
    const key = `${symbol}|${interval}`;
    const existing = this.candleSubs.get(key);
    if (existing) {
      existing.refs++;
      return true;
    }
    this.candleSubs.set(key, { symbol, coin, interval, refs: 1 });
    this.send({ method: 'subscribe', subscription: { type: 'candle', coin, interval } });
    return true;
  }

  unsubscribeCandle(symbol: string, interval: CandleInterval) {
    const key = `${symbol}|${interval}`;
    const sub = this.candleSubs.get(key);
    if (!sub) return;
    sub.refs--;
    if (sub.refs > 0) return;
    this.send({ method: 'unsubscribe', subscription: { type: 'candle', coin: sub.coin, interval } });
    this.candleSubs.delete(key);
    this.latestCandles.delete(key);
  }

  // ------------------------------- readers -------------------------------

  getBook(symbol: string): BookSnapshot | undefined {
    return this.books.get(symbol);
  }

  getMark(symbol: string): MarkInfo | undefined {
    return this.marks.get(symbol);
  }

  // Newest trades first, at most "limit" rows.
  getTrades(symbol: string, limit = 50): TradeTick[] {
    const list = this.trades.get(symbol) ?? [];
    return list.slice(-limit).reverse();
  }

  getLatestCandle(symbol: string, interval: CandleInterval): CandleTick | undefined {
    return this.latestCandles.get(`${symbol}|${interval}`);
  }

  // Symbol and exact Hyperliquid coin key for a tracked symbol (used by the REST candle loader).
  getCoin(symbol: string): string | undefined {
    return this.tracked.get(symbol);
  }

  isBookFresh(symbol: string, now = Date.now()): boolean {
    const book = this.books.get(symbol);
    return !!book && now - book.receivedAt <= staleBookMs && !!bestBid(book) && !!bestAsk(book);
  }

  isMarkFresh(symbol: string, now = Date.now()): boolean {
    const mark = this.marks.get(symbol);
    return !!mark && now - mark.receivedAt <= staleMarkMs;
  }

  // Trading is allowed only when BOTH the book and the mark price are fresh.
  isFresh(symbol: string, now = Date.now()): boolean {
    return this.isBookFresh(symbol, now) && this.isMarkFresh(symbol, now);
  }

  getPrice(symbol: string): PriceTick | undefined {
    const book = this.books.get(symbol);
    if (!book) return undefined;
    const mid = midPrice(book);
    if (!mid) return undefined;
    const mark = this.marks.get(symbol);
    return {
      symbol,
      mid,
      bid: bestBid(book),
      ask: bestAsk(book),
      mark: mark?.mark ?? null,
      oracle: mark?.oracle ?? null,
      funding: mark?.funding ?? null,
      ts: book.receivedAt,
    };
  }

  allPrices(): PriceTick[] {
    return [...this.books.keys()].map((s) => this.getPrice(s)).filter((t): t is PriceTick => !!t);
  }

  trackedSymbols(): string[] {
    return [...this.tracked.keys()];
  }

  status(now = Date.now()) {
    return {
      connected: this.ws?.readyState === WebSocket.OPEN,
      tracked: [...this.tracked.keys()],
      lastMessageAgeMs: this.lastMessageAt ? now - this.lastMessageAt : null,
      reconnects: this.reconnects,
      droppedOutOfOrder: this.droppedOutOfOrder,
      candleSubscriptions: [...this.candleSubs.values()].map((c) => ({ symbol: c.symbol, interval: c.interval, consumers: c.refs })),
      limits: { staleBookMs, staleMarkMs },
      symbols: [...this.tracked.keys()].map((symbol) => {
        const book = this.books.get(symbol);
        const mark = this.marks.get(symbol);
        return {
          symbol,
          bookAgeMs: book ? now - book.receivedAt : null,
          markAgeMs: mark ? now - mark.receivedAt : null,
          bookFresh: this.isBookFresh(symbol, now),
          markFresh: this.isMarkFresh(symbol, now),
          bufferedTrades: this.trades.get(symbol)?.length ?? 0,
        };
      }),
    };
  }

  // ------------------------------- ingestion -------------------------------
  // Public so tests (and recovery code) can feed data without a socket.

  // Returns false when the update was rejected (invalid, crossed, or older than the stored book).
  ingestBook(symbol: string, rawBids: HlLevel[], rawAsks: HlLevel[], exchangeTime: number | null, now = Date.now()): boolean {
    const bids = parseLevels(rawBids, 'BID');
    const asks = parseLevels(rawAsks, 'ASK');
    if (bids.length === 0 || asks.length === 0) return false;
    // A crossed book can not be traded against
    if (bids[0].price.gte(asks[0].price)) {
      logger.warn({ symbol }, 'Ignored crossed order book update');
      return false;
    }

    const previous = this.books.get(symbol);
    // Out-of-order protection (reconnect replays): never go back in time
    if (previous && exchangeTime != null && previous.exchangeTime != null && exchangeTime < previous.exchangeTime) {
      this.droppedOutOfOrder++;
      return false;
    }

    const book: BookSnapshot = { symbol, bids, asks, receivedAt: now, exchangeTime, seq: ++this.seq };
    this.books.set(symbol, book);
    this.emit('book', book);
    this.emitPrice(symbol);
    return true;
  }

  ingestMark(
    symbol: string,
    ctx: Pick<HlAssetCtx, 'markPx' | 'oraclePx' | 'funding'> & Partial<Pick<HlAssetCtx, 'prevDayPx' | 'dayNtlVlm' | 'openInterest' | 'premium'>>,
    now = Date.now(),
  ): boolean {
    try {
      const mark = new Decimal(ctx.markPx);
      const oracle = new Decimal(ctx.oraclePx);
      if (mark.lte(0) || oracle.lte(0)) return false;
      const info: MarkInfo = {
        symbol,
        mark,
        oracle,
        funding: ctx.funding != null && ctx.funding !== '' ? new Decimal(ctx.funding) : null,
        prevDayPx: optionalDecimal(ctx.prevDayPx),
        dayNtlVlm: optionalDecimal(ctx.dayNtlVlm),
        openInterest: optionalDecimal(ctx.openInterest),
        premium: optionalDecimal(ctx.premium),
        receivedAt: now,
      };
      this.marks.set(symbol, info);
      this.emit('mark', info);
      this.emitPrice(symbol);
      return true;
    } catch {
      return false;
    }
  }

  // Public trades. Duplicates (same trade id, e.g. the snapshot after a reconnect) are ignored.
  // Returns the trades that were actually added, oldest first.
  ingestTrades(symbol: string, raw: HlTrade[]): TradeTick[] {
    if (!Array.isArray(raw) || raw.length === 0) return [];
    const list = this.trades.get(symbol) ?? [];
    const known = new Set(list.map((t) => t.tid));
    const added: TradeTick[] = [];

    for (const row of raw) {
      try {
        const tid = String(row.tid ?? row.hash ?? '');
        const price = new Decimal(row.px);
        const size = new Decimal(row.sz);
        if (!tid || known.has(tid) || price.lte(0) || size.lte(0) || typeof row.time !== 'number') continue;
        known.add(tid);
        added.push({ symbol, price, size, side: row.side === 'B' ? 'BUY' : 'SELL', time: row.time, tid });
      } catch {
        // ignore a malformed trade
      }
    }
    if (added.length === 0) return [];

    added.sort((a, b) => a.time - b.time);
    const merged = [...list, ...added].sort((a, b) => a.time - b.time).slice(-TRADE_BUFFER_SIZE);
    this.trades.set(symbol, merged);
    this.emit('trades', symbol, added);
    return added;
  }

  // One live candle update. Returns false for malformed rows or an interval nobody asked for.
  ingestCandle(symbol: string, raw: HlCandle): boolean {
    try {
      const interval = raw.i as CandleInterval;
      const key = `${symbol}|${interval}`;
      if (!this.candleSubs.has(key)) return false;
      const candle: CandleTick = {
        symbol,
        interval,
        openTime: Number(raw.t),
        closeTime: Number(raw.T),
        open: new Decimal(raw.o),
        high: new Decimal(raw.h),
        low: new Decimal(raw.l),
        close: new Decimal(raw.c),
        volume: new Decimal(raw.v),
        trades: Number(raw.n) || 0,
      };
      if (!Number.isFinite(candle.openTime) || !Number.isFinite(candle.closeTime) || candle.open.lte(0) || candle.close.lte(0)) return false;
      // A candle older than the newest one we hold is a replay: ignore it
      const latest = this.latestCandles.get(key);
      if (latest && candle.openTime < latest.openTime) return false;
      this.latestCandles.set(key, candle);
      this.emit('candle', candle);
      return true;
    } catch {
      return false;
    }
  }

  // --------------------------------- internals ---------------------------------

  private addTracked(m: string | TrackedMarket) {
    const { symbol, coin } = typeof m === 'string' ? { symbol: m, coin: m } : m;
    this.tracked.set(symbol, coin);
    this.coinToSymbol.set(coin, symbol);
  }

  private emitPrice(symbol: string) {
    const tick = this.getPrice(symbol);
    if (tick) this.emit('price', tick);
  }

  private connect() {
    if (this.stopped) return;
    const ws = new WebSocket(env.HYPERLIQUID_WS_URL);
    this.ws = ws;

    ws.on('open', () => {
      logger.info('Hyperliquid WebSocket connected');
      this.attempts = 0;
      this.lastMessageAt = Date.now();
      for (const coin of this.tracked.values()) this.subscribe(coin);
      // Live candle streams that consumers still need are restored after a reconnect
      for (const sub of this.candleSubs.values()) {
        this.send({ method: 'subscribe', subscription: { type: 'candle', coin: sub.coin, interval: sub.interval } });
      }
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.send({ method: 'ping' }), PING_INTERVAL_MS);
      // Recovery: fill the cache from REST so we do not wait for the first tick
      void this.loadSnapshot([...this.tracked].map(([symbol, coin]) => ({ symbol, coin })));
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
      this.pingTimer = null;
      if (this.stopped || this.ws !== ws) return;
      // Exponential backoff, capped at 30 seconds
      const delay = Math.min(30_000, 1000 * 2 ** this.attempts++);
      this.reconnects++;
      logger.warn({ delay }, 'Hyperliquid WebSocket closed, reconnecting');
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    });

    ws.on('error', (err) => logger.error({ err }, 'Hyperliquid WebSocket error'));
  }

  // A socket that is "open" but silent is dead (half-open TCP). Close it so it reconnects.
  private watchdog() {
    if (this.stopped || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - this.lastMessageAt > env.HYPERLIQUID_WS_SILENCE_MS) {
      logger.warn('Hyperliquid WebSocket is silent, forcing a reconnect');
      this.ws.terminate();
    }
  }

  private send(payload: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }

  private subscribe(coin: string) {
    this.send({ method: 'subscribe', subscription: { type: 'l2Book', coin } });
    this.send({ method: 'subscribe', subscription: { type: 'activeAssetCtx', coin } });
    this.send({ method: 'subscribe', subscription: { type: 'trades', coin } });
  }

  // REST snapshot of books and contexts (startup, reconnect, newly enabled market).
  private async loadSnapshot(markets: TrackedMarket[]) {
    try {
      const { ctxs } = await fetchMetaAndAssetCtxs();
      for (const { symbol, coin } of markets) {
        const ctx = ctxs.get(coin);
        if (ctx) this.ingestMark(symbol, ctx);
      }
    } catch (err) {
      logger.warn({ err }, 'Could not load Hyperliquid mark snapshot');
    }
    await Promise.all(
      markets.map(async ({ symbol, coin }) => {
        try {
          const book: HlL2Book = await fetchL2Book(coin);
          this.ingestBook(symbol, book.levels[0], book.levels[1], book.time);
        } catch (err) {
          logger.warn({ err, symbol }, 'Could not load Hyperliquid order book snapshot');
        }
      }),
    );
  }

  // Backup for the mark stream: one REST call refreshes every tracked market.
  private async pollContexts() {
    if (this.stopped || this.tracked.size === 0) return;
    const now = Date.now();
    const needsRefresh = [...this.tracked.keys()].some((s) => {
      const mark = this.marks.get(s);
      return !mark || now - mark.receivedAt > CTX_POLL_WHEN_OLDER_THAN_MS;
    });
    if (!needsRefresh) return;
    try {
      const { ctxs } = await fetchMetaAndAssetCtxs();
      for (const [symbol, coin] of this.tracked) {
        const ctx = ctxs.get(coin);
        if (ctx) this.ingestMark(symbol, ctx);
      }
    } catch (err) {
      logger.warn({ err }, 'Mark price REST fallback failed');
    }
  }

  private handleMessage(msg: { channel?: string; data?: any }) {
    switch (msg.channel) {
      case 'l2Book': {
        const symbol = this.coinToSymbol.get(msg.data?.coin);
        if (!symbol) return;
        const levels = msg.data?.levels;
        this.ingestBook(symbol, levels?.[0], levels?.[1], typeof msg.data?.time === 'number' ? msg.data.time : null);
        return;
      }
      case 'activeAssetCtx': {
        const symbol = this.coinToSymbol.get(msg.data?.coin);
        if (symbol && msg.data?.ctx) this.ingestMark(symbol, msg.data.ctx);
        return;
      }
      case 'trades': {
        const rows: HlTrade[] = Array.isArray(msg.data) ? msg.data : [];
        const symbol = this.coinToSymbol.get(rows[0]?.coin);
        if (symbol) this.ingestTrades(symbol, rows);
        return;
      }
      case 'candle': {
        // Hyperliquid sends one candle or a list of candles, accept both
        const rows: HlCandle[] = Array.isArray(msg.data) ? msg.data : msg.data ? [msg.data] : [];
        for (const row of rows) {
          const symbol = this.coinToSymbol.get(row?.s);
          if (symbol) this.ingestCandle(symbol, row);
        }
        return;
      }
      case 'error':
        logger.warn({ data: msg.data }, 'Hyperliquid WebSocket reported an error');
        return;
      default:
        // subscriptionResponse, pong and other channels need no handling
        return;
    }
  }
}

export const priceFeed = new PriceFeed();