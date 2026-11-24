import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { env } from '../../config/env';
import { Decimal } from '../../utils/decimal';
import type { BookSnapshot } from '../trading/engine/orderbook';
import { presentBook, resolveGroup } from './book-grouping';
import { isCandleInterval } from './candle.service';
import { CANDLE_INTERVALS, type CandleInterval } from './hyperliquid.client';
import { priceFeed, type CandleTick, type PriceTick, type TradeTick } from './price-feed';
import { marketStats, presentTrade } from './terminal.service';

// =====================================================================
// Pushes live market data from our backend to the frontend, so browsers never
// talk to Hyperliquid directly. Connect to: ws://host/ws/market
//
// Server -> client messages
//   {type:"hello", symbols, intervalMs, channels, candleIntervals}
//   {type:"price", symbol, price, bid, ask, mark, oracle, fundingRate, bookFresh, markFresh, fresh, ts,
//                  prevDayPx, change24h, change24hPct, volume24hUsd, openInterest, openInterestUsd,
//                  premium, nextFundingAt}
//   {type:"book", symbol, bids:[[px,sz]..], asks:[[px,sz]..], seq, ts, depth, group}   (only if subscribed)
//   {type:"trades", symbol, snapshot, trades:[{price,size,side,time,tid}..]}            (only if subscribed, newest first)
//   {type:"candle", symbol, interval, t, T, o, h, l, c, v, n}                           (only if subscribed)
//   {type:"feed", symbol, fresh, bookFresh, markFresh, feedStatus}                     (when the feed status CHANGES: LIVE / DELAYED / PAUSED)
//   {type:"error", code}
//   {type:"pong"}
// Client -> server messages
//   {op:"subscribe",   symbols?:["BTC"], channels?:["price","book","trades","candles"], interval?:"1m", depth?:15, group?:"10"}
//   {op:"unsubscribe", symbols?:["BTC"], channels?:["book","candles"], interval?:"1m"}
//   {op:"ping"}
// Defaults: every symbol, price channel only. "candles" needs explicit symbols and an interval.
// The symbol list of a subscribe applies to the channels named in the same message (to all of
// price / book / trades when no channel is named). So a terminal can keep "price" for every market
// (markets table) and ask "book" + "trades" for the selected market only. Unsubscribing a channel
// switches it off and resets its symbol list.
// "depth" (1-20) and "group" (price step, "" = raw levels) apply to the book channel of this client.
// Updates are coalesced per symbol (WS_PUSH_INTERVAL_MS), so a fast book never floods the browser.
// =====================================================================

type SymbolChannel = 'price' | 'book' | 'trades';
const SYMBOL_CHANNELS: SymbolChannel[] = ['price', 'book', 'trades'];

interface ClientState {
  // Symbol filter per channel, null = every symbol
  filter: Record<SymbolChannel, Set<string> | null>;
  price: boolean;
  book: boolean;
  trades: boolean;
  // "SYMBOL|interval" keys of the live candle streams this client holds
  candles: Set<string>;
  bookDepth: number;
  bookGroup: Decimal | null;
  // Trade ids that were just sent in a snapshot: a live batch queued at the same moment must not repeat them
  snapshotTids: Set<string>;
  alive: boolean;
}

const HEARTBEAT_MS = 30_000;
const FRESHNESS_CHECK_MS = 1_000;
const MAX_BUFFERED_BYTES = 1_000_000;
const DEFAULT_BOOK_DEPTH = 10;
const MAX_BOOK_DEPTH = 20;
const TRADES_SNAPSHOT_SIZE = 50;
// One browser tab never needs more live chart streams than this
const MAX_CANDLE_STREAMS_PER_CLIENT = 6;
const CHANNELS = ['price', 'book', 'trades', 'candles'];

export async function marketWebSocket(app: FastifyInstance) {
  const clients = new Map<WebSocket, ClientState>();
  const dirtyPrices = new Map<string, PriceTick>();
  const dirtyBooks = new Map<string, BookSnapshot>();
  const dirtyTrades = new Map<string, TradeTick[]>();
  const dirtyCandles = new Map<string, CandleTick>();
  const lastStatus = new Map<string, string>();

  const wants = (state: ClientState, channel: SymbolChannel, symbol: string) => !state.filter[channel] || state.filter[channel]!.has(symbol);

  const send = (client: WebSocket, payload: unknown) => {
    // Slow clients are skipped instead of growing the server memory
    if (client.readyState !== client.OPEN || client.bufferedAmount > MAX_BUFFERED_BYTES) return;
    client.send(JSON.stringify(payload));
  };

  const priceMessage = (tick: PriceTick) => {
    const bookFresh = priceFeed.isBookFresh(tick.symbol);
    const markFresh = priceFeed.isMarkFresh(tick.symbol);
    return {
      type: 'price',
      symbol: tick.symbol,
      price: tick.mid.toString(),
      bid: tick.bid?.toString() ?? null,
      ask: tick.ask?.toString() ?? null,
      mark: tick.mark?.toString() ?? null,
      oracle: tick.oracle?.toString() ?? null,
      bookFresh,
      markFresh,
      fresh: bookFresh && markFresh,
      // LIVE, DELAYED (mark older than 2 s, warning only) or PAUSED (older than 5 s, trading blocked)
      feedStatus: priceFeed.feedStatus(tick.symbol),
      divergencePct: priceFeed.divergencePct(tick.symbol)?.toFixed(4) ?? null,
      ts: tick.ts,
      // fundingRate + 24h statistics for the terminal market bar and markets table
      ...marketStats(tick.symbol),
    };
  };

  // The book is shaped per client: every client can ask for its own depth and price grouping.
  const bookMessage = (book: BookSnapshot, state: ClientState) => {
    const { bids, asks } = presentBook(book, state.bookGroup, state.bookDepth);
    return {
      type: 'book',
      symbol: book.symbol,
      bids,
      asks,
      seq: book.seq,
      ts: book.receivedAt,
      depth: state.bookDepth,
      group: state.bookGroup?.toFixed() ?? null,
    };
  };

  const tradesMessage = (symbol: string, trades: TradeTick[], snapshot: boolean) => ({
    type: 'trades',
    symbol,
    snapshot,
    trades: trades.map(presentTrade),
  });

  const candleMessage = (c: CandleTick) => ({
    type: 'candle',
    symbol: c.symbol,
    interval: c.interval,
    t: c.openTime,
    T: c.closeTime,
    o: c.open.toFixed(),
    h: c.high.toFixed(),
    l: c.low.toFixed(),
    c: c.close.toFixed(),
    v: c.volume.toFixed(),
    n: c.trades,
  });

  const onPrice = (tick: PriceTick) => void dirtyPrices.set(tick.symbol, tick);
  const onBook = (book: BookSnapshot) => void dirtyBooks.set(book.symbol, book);
  // New trades are queued oldest first
  const onTrades = (symbol: string, added: TradeTick[]) => void dirtyTrades.set(symbol, [...(dirtyTrades.get(symbol) ?? []), ...added]);
  const onCandle = (candle: CandleTick) => void dirtyCandles.set(`${candle.symbol}|${candle.interval}`, candle);
  priceFeed.on('price', onPrice);
  priceFeed.on('book', onBook);
  priceFeed.on('trades', onTrades);
  priceFeed.on('candle', onCandle);

  // Gives back every live candle stream a client holds. Safe to call more than once.
  const releaseCandles = (state: ClientState) => {
    for (const key of state.candles) {
      const [symbol, interval] = key.split('|');
      priceFeed.unsubscribeCandle(symbol, interval as CandleInterval);
    }
    state.candles.clear();
  };

  const dropClient = (socket: WebSocket) => {
    const state = clients.get(socket);
    if (!state) return;
    releaseCandles(state);
    clients.delete(socket);
  };

  // Flush the coalesced updates
  const flushTimer = setInterval(() => {
    if (dirtyPrices.size === 0 && dirtyBooks.size === 0 && dirtyTrades.size === 0 && dirtyCandles.size === 0) return;
    const prices = [...dirtyPrices.values()];
    const books = [...dirtyBooks.values()];
    const trades = [...dirtyTrades.entries()];
    const candles = [...dirtyCandles.entries()];
    dirtyPrices.clear();
    dirtyBooks.clear();
    dirtyTrades.clear();
    dirtyCandles.clear();
    for (const [client, state] of clients) {
      if (state.price) prices.filter((t) => wants(state, 'price', t.symbol)).forEach((t) => send(client, priceMessage(t)));
      if (state.book) books.filter((b) => wants(state, 'book', b.symbol)).forEach((b) => send(client, bookMessage(b, state)));
      if (state.trades) {
        // Newest first, the same order as the REST endpoint
        for (const [symbol, list] of trades) {
          if (!wants(state, 'trades', symbol)) continue;
          const fresh = list.filter((t) => !state.snapshotTids.has(t.tid));
          if (fresh.length > 0) send(client, tradesMessage(symbol, fresh.reverse(), false));
        }
        state.snapshotTids.clear();
      }
      if (state.candles.size > 0) candles.filter(([key]) => state.candles.has(key)).forEach(([, c]) => send(client, candleMessage(c)));
    }
  }, env.WS_PUSH_INTERVAL_MS);

  // Tell every client the moment a symbol becomes stale (or healthy again), even when no ticks arrive.
  const freshnessTimer = setInterval(() => {
    for (const symbol of priceFeed.trackedSymbols()) {
      const bookFresh = priceFeed.isBookFresh(symbol);
      const markFresh = priceFeed.isMarkFresh(symbol);
      const fresh = bookFresh && markFresh;
      // LIVE / DELAYED / PAUSED: announced the moment it changes, even when no ticks arrive
      const feedStatus = priceFeed.feedStatus(symbol);
      if (lastStatus.get(symbol) === feedStatus) continue;
      lastStatus.set(symbol, feedStatus);
      for (const [client, state] of clients) {
        if (wants(state, 'price', symbol) || (state.book && wants(state, 'book', symbol))) {
          send(client, { type: 'feed', symbol, fresh, bookFresh, markFresh, feedStatus });
        }
      }
    }
  }, FRESHNESS_CHECK_MS);

  // Heartbeat: terminate connections that stopped answering pings
  const heartbeatTimer = setInterval(() => {
    for (const [client, state] of clients) {
      if (!state.alive) {
        client.terminate();
        dropClient(client);
        continue;
      }
      state.alive = false;
      client.ping();
    }
  }, HEARTBEAT_MS);

  app.addHook('onClose', async () => {
    clearInterval(flushTimer);
    clearInterval(freshnessTimer);
    clearInterval(heartbeatTimer);
    priceFeed.off('price', onPrice);
    priceFeed.off('book', onBook);
    priceFeed.off('trades', onTrades);
    priceFeed.off('candle', onCandle);
    for (const client of [...clients.keys()]) {
      client.terminate();
      dropClient(client);
    }
  });

  const normalize = (value: unknown): string[] | null =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').map((v) => v.toUpperCase()).slice(0, 100) : null;

  app.get('/ws/market', { websocket: true }, (socket) => {
    const state: ClientState = {
      filter: { price: null, book: null, trades: null },
      price: true,
      book: false,
      trades: false,
      candles: new Set(),
      bookDepth: DEFAULT_BOOK_DEPTH,
      bookGroup: null,
      snapshotTids: new Set(),
      alive: true,
    };
    clients.set(socket, state);

    send(socket, { type: 'hello', symbols: priceFeed.trackedSymbols(), intervalMs: env.WS_PUSH_INTERVAL_MS, channels: CHANNELS, candleIntervals: CANDLE_INTERVALS });
    // Current snapshot for this new client only
    priceFeed.allPrices().forEach((tick) => send(socket, priceMessage(tick)));

    socket.on('pong', () => {
      state.alive = true;
    });

    socket.on('message', (raw) => {
      state.alive = true;
      let msg: { op?: string; symbols?: unknown; channels?: unknown; interval?: unknown; depth?: unknown; group?: unknown };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return send(socket, { type: 'error', code: 'INVALID_JSON' });
      }

      if (msg.op === 'ping') return send(socket, { type: 'pong' });

      if (msg.op === 'subscribe' || msg.op === 'unsubscribe') {
        const on = msg.op === 'subscribe';
        const symbols = normalize(msg.symbols);
        const channels = normalize(msg.channels)?.map((c) => c.toLowerCase());

        // Book shape of this client (applies to the book channel)
        if (on && typeof msg.depth === 'number' && Number.isFinite(msg.depth)) {
          state.bookDepth = Math.min(Math.max(Math.trunc(msg.depth), 1), MAX_BOOK_DEPTH);
        }
        if (on && 'group' in msg) {
          state.bookGroup = resolveGroup(typeof msg.group === 'string' ? msg.group : null, new Decimal(0));
        }

        // Candle streams are handled per symbol and interval, so they do not touch the symbol filter
        const candleRequested = !!channels?.includes('candles');
        if (candleRequested) {
          if (!symbols || symbols.length === 0) {
            send(socket, { type: 'error', code: 'SYMBOL_REQUIRED' });
          } else if (on) {
            if (typeof msg.interval !== 'string' || !isCandleInterval(msg.interval)) {
              send(socket, { type: 'error', code: 'INVALID_INTERVAL' });
            } else {
              for (const symbol of symbols) {
                const key = `${symbol}|${msg.interval}`;
                if (state.candles.has(key)) continue;
                if (state.candles.size >= MAX_CANDLE_STREAMS_PER_CLIENT) {
                  send(socket, { type: 'error', code: 'TOO_MANY_CANDLE_STREAMS' });
                  break;
                }
                if (!priceFeed.subscribeCandle(symbol, msg.interval)) {
                  send(socket, { type: 'error', code: 'UNKNOWN_SYMBOL', symbol });
                  continue;
                }
                state.candles.add(key);
                const latest = priceFeed.getLatestCandle(symbol, msg.interval);
                if (latest) send(socket, candleMessage(latest));
              }
            }
          } else {
            // No interval = every interval of the given symbols
            for (const key of [...state.candles]) {
              const [symbol, interval] = key.split('|');
              if (!symbols.includes(symbol) || (typeof msg.interval === 'string' && msg.interval !== interval)) continue;
              priceFeed.unsubscribeCandle(symbol, interval as CandleInterval);
              state.candles.delete(key);
            }
          }
        }

        // Symbol lists and on / off switches of price / book / trades (candle-only requests change nothing here)
        const targets = (channels ? channels.filter((c): c is SymbolChannel => (SYMBOL_CHANNELS as string[]).includes(c)) : SYMBOL_CHANNELS);
        if (on) {
          for (const c of targets) {
            if (symbols) state.filter[c] = new Set([...(state.filter[c] ?? []), ...symbols]);
            else state.filter[c] = null;
          }
          if (channels) targets.forEach((c) => (state[c] = true));
        } else if (channels) {
          // Switching a channel off also forgets its symbol list, so the next subscribe starts clean
          targets.forEach((c) => {
            state[c] = false;
            state.filter[c] = null;
          });
        } else if (symbols) {
          // Legacy form: unsubscribe symbols from every channel
          for (const c of targets) symbols.forEach((sym) => state.filter[c]?.delete(sym));
        }

        // Send the current state of what was just subscribed
        if (on) {
          if (state.price && (!channels || channels.includes('price'))) {
            priceFeed.allPrices().filter((t) => wants(state, 'price', t.symbol)).forEach((t) => send(socket, priceMessage(t)));
          }
          if (state.book && (!channels || channels.includes('book'))) {
            priceFeed.trackedSymbols().filter((s) => wants(state, 'book', s)).forEach((s) => {
              const book = priceFeed.getBook(s);
              if (book) send(socket, bookMessage(book, state));
            });
          }
          if (state.trades && channels?.includes('trades')) {
            priceFeed.trackedSymbols().filter((s) => wants(state, 'trades', s)).forEach((s) => {
              const recent = priceFeed.getTrades(s, TRADES_SNAPSHOT_SIZE);
              if (recent.length === 0) return;
              recent.forEach((t) => state.snapshotTids.add(t.tid));
              send(socket, tradesMessage(s, recent, true));
            });
          }
        }
      }
    });

    socket.on('close', () => dropClient(socket));
    socket.on('error', () => dropClient(socket));
  });
}