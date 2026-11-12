import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { priceFeed, type PriceTick } from './price-feed';

// Pushes live prices from our backend to the frontend, so browsers never
// talk to Hyperliquid directly. Connect to: ws://host/ws/market
export async function marketWebSocket(app: FastifyInstance) {
  const clients = new Set<WebSocket>();

  const serialize = (tick: PriceTick) =>
    JSON.stringify({
      type: 'price',
      symbol: tick.symbol,
      price: tick.mid.toString(),
      bid: tick.bid?.toString() ?? null,
      ask: tick.ask?.toString() ?? null,
      ts: tick.ts,
    });

  const broadcast = (tick: PriceTick) => {
    const message = serialize(tick);
    for (const client of clients) {
      if (client.readyState === client.OPEN) client.send(message);
    }
  };

  priceFeed.on('price', broadcast);
  app.addHook('onClose', async () => {
    priceFeed.off('price', broadcast);
  });

  app.get('/ws/market', { websocket: true }, (socket) => {
    clients.add(socket);
    // Send the current snapshot to this new client only
    priceFeed.allPrices().forEach((tick) => socket.send(serialize(tick)));
    socket.on('close', () => clients.delete(socket));
  });
}
