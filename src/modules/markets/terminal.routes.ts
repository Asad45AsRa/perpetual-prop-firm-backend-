import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../../utils/api-error';
import { parse } from '../../utils/validate';
import { DEFAULT_CANDLE_LIMIT, isCandleInterval, loadCandles, MAX_CANDLE_LIMIT } from './candle.service';
import { getMarketOrThrow } from './market.service';
import { priceFeed } from './price-feed';
import {
  DEFAULT_BOOK_DEPTH,
  DEFAULT_CHART_INTERVAL,
  DEFAULT_TRADES_LIMIT,
  getTerminalBook,
  getTerminalBootstrap,
  getTerminalMarket,
  getTerminalTrades,
  listTerminalMarkets,
  MAX_BOOK_DEPTH,
  MAX_TRADES_LIMIT,
} from './terminal.service';

const symbolParams = z.object({ symbol: z.string().min(1).max(20) });
const bootstrapQuery = z.object({ symbol: z.string().min(1).max(20).optional() });
const bookQuery = z.object({
  depth: z.coerce.number().int().min(1).max(MAX_BOOK_DEPTH).default(DEFAULT_BOOK_DEPTH),
  // Price step used to merge levels, for example "10". Empty = raw levels.
  group: z
    .string()
    .regex(/^\d+(\.\d+)?$/, 'group must be a positive decimal string')
    .optional(),
});
const tradesQuery = z.object({ limit: z.coerce.number().int().min(1).max(MAX_TRADES_LIMIT).default(DEFAULT_TRADES_LIMIT) });
const candleQuery = z.object({
  interval: z.string().default(DEFAULT_CHART_INTERVAL),
  // Milliseconds since epoch
  startTime: z.coerce.number().int().positive().optional(),
  endTime: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_CANDLE_LIMIT).default(DEFAULT_CANDLE_LIMIT),
});

// Public terminal market data: /api/v1/terminal/...
// Everything comes from OUR backend (which talks to Hyperliquid), browsers never call Hyperliquid.
// Live updates use the WebSocket /ws/market (channels: price, book, trades, candles).
// Account data (positions, orders, fills) stays in the signed-in /api/v1/trading routes.
export async function terminalRoutes(app: FastifyInstance) {
  // First paint of the terminal: markets list, selected market, book, trades, chart settings
  app.get('/bootstrap', async (req) => {
    const { symbol } = parse(bootstrapQuery, req.query);
    return getTerminalBootstrap(symbol);
  });

  // Markets table: live price, 24h change, 24h volume, open interest, funding, leverage and fees
  app.get('/markets', async () => ({ markets: await listTerminalMarkets(), serverTime: Date.now() }));

  // Market bar of one symbol
  app.get('/markets/:symbol', async (req) => {
    const { symbol } = parse(symbolParams, req.params);
    return getTerminalMarket(symbol);
  });

  app.get('/markets/:symbol/book', async (req) => {
    const { symbol } = parse(symbolParams, req.params);
    const query = parse(bookQuery, req.query);
    return getTerminalBook(symbol, { depth: query.depth, group: query.group });
  });

  app.get('/markets/:symbol/trades', async (req) => {
    const { symbol } = parse(symbolParams, req.params);
    const query = parse(tradesQuery, req.query);
    return getTerminalTrades(symbol, query.limit);
  });

  // Historical candles for the chart (oldest first). The forming candle is updated over the WebSocket.
  app.get('/markets/:symbol/candles', async (req) => {
    const { symbol } = parse(symbolParams, req.params);
    const query = parse(candleQuery, req.query);
    if (!isCandleInterval(query.interval)) throw ApiError.badRequest('Unsupported candle interval');
    if (query.startTime && query.endTime && query.startTime >= query.endTime) throw ApiError.badRequest('startTime must be before endTime');

    const market = await getMarketOrThrow(symbol);
    const coin = priceFeed.getCoin(market.symbol) ?? market.hlKey;
    const candles = await loadCandles({
      symbol: market.symbol,
      coin,
      interval: query.interval,
      startTime: query.startTime,
      endTime: query.endTime,
      limit: query.limit,
    });
    return { symbol: market.symbol, interval: query.interval, candles, ts: Date.now() };
  });
}