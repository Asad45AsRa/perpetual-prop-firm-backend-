import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePortal } from '../../middleware/auth';
import { Decimal } from '../../utils/decimal';
import { parse } from '../../utils/validate';
import * as service from './trading.service';

const orderSchema = z.object({
  symbol: z.string().min(1).max(20),
  side: z.enum(['BUY', 'SELL']),
  // Sent as a string so no precision is lost in JSON
  size: z.string().regex(/^\d+(\.\d+)?$/, 'size must be a positive decimal string'),
  leverage: z.number().int().min(1).max(200),
  reduceOnly: z.boolean().default(false),
  clientOrderId: z.string().max(64).optional(),
  // LIMIT orders are not implemented yet (see README, next steps)
  type: z.literal('MARKET').default('MARKET'),
});

const accountParams = z.object({ accountId: z.string().uuid() });

export async function tradingRoutes(app: FastifyInstance) {
  // Trader dashboard + terminal only (ownership of each account is checked in the service).
  app.addHook('preHandler', requirePortal('TRADER'));

  app.get('/accounts', async (req) => service.listMyAccounts(req.user!.id));

  app.get('/accounts/:accountId', async (req) => {
    const { accountId } = parse(accountParams, req.params);
    return service.getAccountOverview(req.user!.id, accountId);
  });

  app.post('/accounts/:accountId/orders', async (req, reply) => {
    const { accountId } = parse(accountParams, req.params);
    const body = parse(orderSchema, req.body);
    const result = await service.placeOrder(req.user!.id, {
      accountId,
      symbol: body.symbol,
      side: body.side,
      size: new Decimal(body.size),
      leverage: body.leverage,
      reduceOnly: body.reduceOnly,
      clientOrderId: body.clientOrderId,
    });
    return reply.status(result.duplicate ? 200 : 201).send(result);
  });

  app.post('/accounts/:accountId/positions/:symbol/close', async (req) => {
    const { accountId } = parse(accountParams, req.params);
    const { symbol } = req.params as { symbol: string };
    return service.closePosition(req.user!.id, accountId, symbol);
  });

  app.get('/accounts/:accountId/orders', async (req) => {
    const { accountId } = parse(accountParams, req.params);
    return service.listOrders(req.user!.id, accountId);
  });

  app.get('/accounts/:accountId/fills', async (req) => {
    const { accountId } = parse(accountParams, req.params);
    return service.listFills(req.user!.id, accountId);
  });

  app.get('/accounts/:accountId/ledger', async (req) => {
    const { accountId } = parse(accountParams, req.params);
    return service.listLedger(req.user!.id, accountId);
  });
}
