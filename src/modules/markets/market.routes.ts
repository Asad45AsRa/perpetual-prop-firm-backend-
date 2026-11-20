import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../../utils/api-error';
import { parse } from '../../utils/validate';
import { getMarketOrThrow, listMarkets, presentMarket } from './market.service';
import { priceFeed } from './price-feed';

const depthQuery = z.object({ depth: z.coerce.number().int().min(1).max(20).default(10) });

// Public market data. Everything here comes from OUR backend (which talks to Hyperliquid),
// browsers never call Hyperliquid directly.
export async function marketRoutes(app: FastifyInstance) {
  // All enabled markets with live price, limits and feed health
  app.get('/', async () => listMarkets());

  // Health of the live feed (connection, age of every book / mark price)
  app.get('/feed/status', async () => {
    const status = priceFeed.status();
    return { connected: status.connected, limits: status.limits, symbols: status.symbols };
  });

  app.get('/:symbol', async (req) => {
    const { symbol } = req.params as { symbol: string };
    return presentMarket(await getMarketOrThrow(symbol));
  });

  app.get('/:symbol/price', async (req) => {
    const { symbol } = req.params as { symbol: string };
    await getMarketOrThrow(symbol);
    const tick = priceFeed.getPrice(symbol.toUpperCase());
    if (!tick) throw ApiError.unprocessable('NO_PRICE', 'No price available yet');
    return {
      symbol: tick.symbol,
      price: tick.mid.toString(),
      bid: tick.bid?.toString() ?? null,
      ask: tick.ask?.toString() ?? null,
      mark: tick.mark?.toString() ?? null,
      oracle: tick.oracle?.toString() ?? null,
      fundingRate: tick.funding?.toString() ?? null,
      fresh: priceFeed.isFresh(tick.symbol),
      bookFresh: priceFeed.isBookFresh(tick.symbol),
      markFresh: priceFeed.isMarkFresh(tick.symbol),
      ts: tick.ts,
    };
  });

  // Order book snapshot (best levels first). Same data the engine fills against.
  app.get('/:symbol/book', async (req) => {
    const { symbol } = req.params as { symbol: string };
    const { depth } = parse(depthQuery, req.query);
    await getMarketOrThrow(symbol);
    const book = priceFeed.getBook(symbol.toUpperCase());
    if (!book) throw ApiError.unprocessable('NO_PRICE', 'No order book available yet');
    const levels = (rows: typeof book.bids) => rows.slice(0, depth).map((l) => [l.price.toString(), l.size.toString()]);
    return {
      symbol: book.symbol,
      bids: levels(book.bids),
      asks: levels(book.asks),
      fresh: priceFeed.isBookFresh(book.symbol),
      seq: book.seq,
      ts: book.receivedAt,
    };
  });
}
