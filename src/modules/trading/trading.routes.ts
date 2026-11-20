import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePortal } from '../../middleware/auth';
import { Decimal } from '../../utils/decimal';
import { parse } from '../../utils/validate';
import * as service from './trading.service';

// Decimals travel as strings so no precision is lost in JSON
const decimalString = z.string().regex(/^\d+(\.\d+)?$/, 'must be a positive decimal string');
const positive = decimalString.refine((v) => new Decimal(v).gt(0), 'must be greater than 0');

const orderSchema = z.object({
  symbol: z.string().min(1).max(20),
  side: z.enum(['BUY', 'SELL']),
  type: z.enum(['MARKET', 'LIMIT', 'STOP_MARKET', 'TAKE_PROFIT', 'STOP_LOSS']).default('MARKET'),
  size: positive.optional(),
  // TP / SL that always closes the whole position (the size follows the position)
  closePosition: z.boolean().default(false),
  limitPrice: positive.optional(),
  triggerPrice: positive.optional(),
  leverage: z.number().int().min(1).max(200).default(1),
  reduceOnly: z.boolean().default(false),
  postOnly: z.boolean().default(false),
  timeInForce: z.enum(['GTC', 'IOC']).default('GTC'),
  // Hedge mode: which leg the order works on
  positionSide: z.enum(['LONG', 'SHORT']).optional(),
  // Opening market orders: reject when slippage is above this percent (default 3)
  maxSlippagePct: positive.optional(),
  clientOrderId: z.string().min(1).max(64).optional(),
});

const modifySchema = z
  .object({ size: positive.optional(), limitPrice: positive.optional(), triggerPrice: positive.optional() })
  .refine((v) => v.size || v.limitPrice || v.triggerPrice, 'Send at least one of size, limitPrice, triggerPrice');

const accountParams = z.object({ accountId: z.string().uuid() });
const orderParams = z.object({ accountId: z.string().uuid(), orderId: z.string().uuid() });
const closeSchema = z.object({ size: positive.optional(), positionSide: z.enum(['LONG', 'SHORT']).optional() });
const cancelAllQuery = z.object({ symbol: z.string().min(1).max(20).optional(), side: z.enum(['BUY', 'SELL']).optional() });
const listQuery = z.object({
  active: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export async function tradingRoutes(app: FastifyInstance) {
  // Trader dashboard + terminal only (ownership of each account is checked in the service).
  app.addHook('preHandler', requirePortal('TRADER'));

  // Order writes are limited per user (a stuck client must never flood the engine)
  const writeLimit = {
    config: { rateLimit: { max: 30, timeWindow: '1 second', keyGenerator: (req: { user?: { id: string }; ip: string }) => req.user?.id ?? req.ip } },
  };

  app.get('/accounts', async (req) => service.listMyAccounts(req.user!.id));

  app.get('/accounts/:accountId', async (req) => {
    const { accountId } = parse(accountParams, req.params);
    return service.getAccountOverview(req.user!.id, accountId);
  });

  // ----------------------------- orders -----------------------------

  app.post('/accounts/:accountId/orders', writeLimit, async (req, reply) => {
    const { accountId } = parse(accountParams, req.params);
    const body = parse(orderSchema, req.body);
    // The standard Idempotency-Key header works like clientOrderId
    const header = req.headers['idempotency-key'];
    const clientOrderId = body.clientOrderId ?? (typeof header === 'string' && header.length <= 64 ? header : undefined);

    const result = await service.placeOrder(req.user!.id, {
      accountId,
      symbol: body.symbol,
      side: body.side,
      type: body.type,
      size: body.size ? new Decimal(body.size) : null,
      closePosition: body.closePosition,
      limitPrice: body.limitPrice ? new Decimal(body.limitPrice) : null,
      triggerPrice: body.triggerPrice ? new Decimal(body.triggerPrice) : null,
      leverage: body.leverage,
      reduceOnly: body.reduceOnly,
      postOnly: body.postOnly,
      timeInForce: body.timeInForce,
      positionSide: body.positionSide ?? null,
      maxSlippagePct: body.maxSlippagePct ? new Decimal(body.maxSlippagePct) : null,
      clientOrderId,
    });
    return reply.status(result.duplicate ? 200 : 201).send(result);
  });

  app.get('/accounts/:accountId/orders', async (req) => {
    const { accountId } = parse(accountParams, req.params);
    const query = parse(listQuery, req.query);
    return service.listOrders(req.user!.id, accountId, { limit: query.limit, active: query.active === 'true' });
  });

  app.get('/accounts/:accountId/orders/:orderId', async (req) => {
    const { accountId, orderId } = parse(orderParams, req.params);
    return service.getOrder(req.user!.id, accountId, orderId);
  });

  // Modify price / trigger / size. The replacement is validated first, then the old order is cancelled.
  app.patch('/accounts/:accountId/orders/:orderId', writeLimit, async (req) => {
    const { accountId, orderId } = parse(orderParams, req.params);
    const body = parse(modifySchema, req.body);
    return service.modifyOrder(req.user!.id, accountId, orderId, {
      size: body.size ? new Decimal(body.size) : undefined,
      limitPrice: body.limitPrice ? new Decimal(body.limitPrice) : undefined,
      triggerPrice: body.triggerPrice ? new Decimal(body.triggerPrice) : undefined,
    });
  });

  app.delete('/accounts/:accountId/orders/:orderId', writeLimit, async (req) => {
    const { accountId, orderId } = parse(orderParams, req.params);
    return service.cancelOrder(req.user!.id, accountId, orderId);
  });

  // Cancel all working orders (entries and exits), optionally for one symbol / side
  app.delete('/accounts/:accountId/orders', writeLimit, async (req) => {
    const { accountId } = parse(accountParams, req.params);
    const query = parse(cancelAllQuery, req.query);
    return service.cancelAllOrders(req.user!.id, accountId, query);
  });

  // ---------------------------- positions ----------------------------

  // Close the position of one market (whole position, or "size" for a partial close)
  app.post('/accounts/:accountId/positions/:symbol/close', writeLimit, async (req) => {
    const { accountId } = parse(accountParams, req.params);
    const { symbol } = req.params as { symbol: string };
    const body = parse(closeSchema, req.body ?? {});
    return service.closePosition(req.user!.id, accountId, symbol, {
      size: body.size ? new Decimal(body.size) : undefined,
      positionSide: body.positionSide,
    });
  });

  // Close all positions, or only longs / only shorts
  app.post('/accounts/:accountId/positions/close-all', writeLimit, async (req) => {
    const { accountId } = parse(accountParams, req.params);
    const body = parse(z.object({ side: z.enum(['LONG', 'SHORT']).optional() }), req.body ?? {});
    return service.closeAllPositions(req.user!.id, accountId, body.side);
  });

  // One-way / hedge. Only while the account has no positions and no working orders.
  app.put('/accounts/:accountId/position-mode', async (req) => {
    const { accountId } = parse(accountParams, req.params);
    const body = parse(z.object({ mode: z.enum(['ONE_WAY', 'HEDGE']) }), req.body);
    return service.setPositionMode(req.user!.id, accountId, body.mode);
  });

  // ---------------------------- history ----------------------------

  app.get('/accounts/:accountId/fills', async (req) => {
    const { accountId } = parse(accountParams, req.params);
    return service.listFills(req.user!.id, accountId);
  });

  app.get('/accounts/:accountId/ledger', async (req) => {
    const { accountId } = parse(accountParams, req.params);
    return service.listLedger(req.user!.id, accountId);
  });
}
