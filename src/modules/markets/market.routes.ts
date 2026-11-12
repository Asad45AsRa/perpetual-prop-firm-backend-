import type { FastifyInstance } from 'fastify';
import { ApiError } from '../../utils/api-error';
import { getMarketOrThrow, listMarkets } from './market.service';
import { priceFeed } from './price-feed';

export async function marketRoutes(app: FastifyInstance) {
  app.get('/', async () => listMarkets());

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
      fresh: priceFeed.isFresh(tick.symbol),
      ts: tick.ts,
    };
  });
}
