import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { env } from '../../config/env';
import type { BookSnapshot } from '../trading/engine/orderbook';
import { priceFeed, type PriceTick } from './price-feed';

// =====================================================================
// Pushes live prices from our backend to the frontend, so browsers never
// talk to Hyperliquid directly. Connect to: ws://host/ws/market
//
// Server -> client messages
//   {type:"hello", symbols, intervalMs}
//   {type:"price", symbol, price, bid, ask, mark, oracle, fundingRate, bookFresh, markFresh, fresh, ts}
//   {type:"book", symbol, bids:[[px,sz]..], asks:[[px,sz]..], seq, ts}      (only if subscribed)
//   {type:"feed", symbol, fresh, bookFresh, markFresh}                       (when freshness CHANGES)
//   {type:"pong"}
// Client -> server messages
//   {op:"subscribe",   symbols?:["BTC"], channels?:["price","book"]}   default: all symbols, price only
//   {op:"unsubscribe", symbols?:["BTC"], channels?:["book"]}
//   {op:"ping"}
// Updates are coalesced per symbol (WS_PUSH_INTERVAL_MS), so a fast book never floods the browser.
// =====================================================================

interface ClientState {
  // null = every symbol
  symbols: Set<string> | null;
  price: boolean;
  book: boolean;
  alive: boolean;
}

const HEARTBEAT_MS = 30_000;
const FRESHNESS_CHECK_MS = 1_000;
const MAX_BUFFERED_BYTES = 1_000_000;
const BOOK_DEPTH = 10;

export async function marketWebSocket(app: FastifyInstance) {
  const clients = new Map<WebSocket, ClientState>();
  const dirtyPrices = new Map<string, PriceTick>();
  const dirtyBooks = new Map<string, BookSnapshot>();
  const lastFresh = new Map<string, boolean>();

  const wants = (state: ClientState, symbol: string) => !state.symbols || state.symbols.has(symbol);

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
      fundingRate: tick.funding?.toString() ?? null,
      bookFresh,
      markFresh,
      fresh: bookFresh && markFresh,
      ts: tick.ts,
    };
  };

  const bookMessage = (book: BookSnapshot) => ({
    type: 'book',
    symbol: book.symbol,
    bids: book.bids.slice(0, BOOK_DEPTH).map((l) => [l.price.toString(), l.size.toString()]),
    asks: book.asks.slice(0, BOOK_DEPTH).map((l) => [l.price.toString(), l.size.toString()]),
    seq: book.seq,
    ts: book.receivedAt,
  });

  const onPrice = (tick: PriceTick) => void dirtyPrices.set(tick.symbol, tick);
  const onBook = (book: BookSnapshot) => void dirtyBooks.set(book.symbol, book);
  priceFeed.on('price', onPrice);
  priceFeed.on('book', onBook);

  // Flush the coalesced updates
  const flushTimer = setInterval(() => {
    if (dirtyPrices.size === 0 && dirtyBooks.size === 0) return;
    const prices = [...dirtyPrices.values()];
    const books = [...dirtyBooks.values()];
    dirtyPrices.clear();
    dirtyBooks.clear();
    for (const [client, state] of clients) {
      if (state.price) prices.filter((t) => wants(state, t.symbol)).forEach((t) => send(client, priceMessage(t)));
      if (state.book) books.filter((b) => wants(state, b.symbol)).forEach((b) => send(client, bookMessage(b)));
    }
  }, env.WS_PUSH_INTERVAL_MS);

  // Tell every client the moment a symbol becomes stale (or healthy again), even when no ticks arrive.
  const freshnessTimer = setInterval(() => {
    for (const symbol of priceFeed.trackedSymbols()) {
      const bookFresh = priceFeed.isBookFresh(symbol);
      const markFresh = priceFeed.isMarkFresh(symbol);
      const fresh = bookFresh && markFresh;
      if (lastFresh.get(symbol) === fresh) continue;
      lastFresh.set(symbol, fresh);
      for (const [client, state] of clients) {
        if (wants(state, symbol)) send(client, { type: 'feed', symbol, fresh, bookFresh, markFresh });
      }
    }
  }, FRESHNESS_CHECK_MS);

  // Heartbeat: terminate connections that stopped answering pings
  const heartbeatTimer = setInterval(() => {
    for (const [client, state] of clients) {
      if (!state.alive) {
        client.terminate();
        clients.delete(client);
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
    for (const client of clients.keys()) client.terminate();
    clients.clear();
  });

  const normalize = (value: unknown): string[] | null =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').map((v) => v.toUpperCase()).slice(0, 100) : null;

  app.get('/ws/market', { websocket: true }, (socket) => {
    const state: ClientState = { symbols: null, price: true, book: false, alive: true };
    clients.set(socket, state);

    send(socket, { type: 'hello', symbols: priceFeed.trackedSymbols(), intervalMs: env.WS_PUSH_INTERVAL_MS });
    // Current snapshot for this new client only
    priceFeed.allPrices().forEach((tick) => send(socket, priceMessage(tick)));

    socket.on('pong', () => {
      state.alive = true;
    });

    socket.on('message', (raw) => {
      state.alive = true;
      let msg: { op?: string; symbols?: unknown; channels?: unknown };
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

        if (symbols) {
          if (on) state.symbols = new Set([...(state.symbols ?? []), ...symbols]);
          else if (state.symbols) symbols.forEach((s) => state.symbols!.delete(s));
        } else if (on) {
          state.symbols = null;
        }
        if (channels) {
          if (channels.includes('price')) state.price = on;
          if (channels.includes('book')) state.book = on;
        }

        // Send the current state of what was just subscribed
        if (on) {
          priceFeed.allPrices().filter((t) => wants(state, t.symbol)).forEach((t) => state.price && send(socket, priceMessage(t)));
          if (state.book) {
            priceFeed.trackedSymbols().filter((s) => wants(state, s)).forEach((s) => {
              const book = priceFeed.getBook(s);
              if (book) send(socket, bookMessage(book));
            });
          }
        }
      }
    });

    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => clients.delete(socket));
  });
}
