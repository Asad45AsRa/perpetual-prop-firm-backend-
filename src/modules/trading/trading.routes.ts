import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePortal } from '../../middleware/auth';
import { ApiError } from '../../utils/api-error';
import { Decimal } from '../../utils/decimal';
import { parse } from '../../utils/validate';
import { EXPIRY_CHOICES, expiryToDate } from './engine/market-policy';
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
  // Resting limit orders: good till cancelled, or cancelled by the server after 5 minutes / 1 hour / 24 hours / 30 days
  expiry: z.enum(EXPIRY_CHOICES).default('GTC'),
  // Hedge mode: which leg the order works on
  positionSide: z.enum(['LONG', 'SHORT']).optional(),
  clientOrderId: z.string().min(1).max(64).optional(),
});

// Order ticket preview: send ONE of size (coins), notionalUsd (value) or marginUsd (margin x leverage)
const previewSchema = z
  .object({
    symbol: z.string().min(1).max(20),
    side: z.enum(['BUY', 'SELL']),
    type: z.enum(['MARKET', 'LIMIT', 'STOP_MARKET']).default('MARKET'),
    size: positive.optional(),
    notionalUsd: positive.optional(),
    marginUsd: positive.optional(),
    leverage: z.number().int().min(1).max(200).default(1),
    limitPrice: positive.optional(),
    triggerPrice: positive.optional(),
    reduceOnly: z.boolean().default(false),
    postOnly: z.boolean().default(false),
  })
  .refine((v) => [v.size, v.notionalUsd, v.marginUsd].filter(Boolean).length === 1, 'Send exactly one of size, notionalUsd, marginUsd')
  .refine((v) => v.type !== 'LIMIT' || !!v.limitPrice, 'A limit order needs a limit price')
  .refine((v) => v.type !== 'STOP_MARKET' || !!v.triggerPrice, 'A stop order needs a trigger price');

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

  // Risk and breach history of the account, newest first (cursor = nextBefore of the previous page)
  app.get('/accounts/:accountId/risk-events', async (req) => {
    const { accountId } = parse(accountParams, req.params);
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(100).default(25), before: z.string().datetime().optional() }), req.query);
    return service.getAccountRiskEvents(req.user!.id, accountId, { limit: q.limit, before: q.before ? new Date(q.before) : undefined });
  });

  // Technical breach review (72 hours after a breach)
  app.post('/accounts/:accountId/breach-review', async (req, reply) => {
    const { accountId } = parse(accountParams, req.params);
    const body = parse(z.object({ reason: z.string().trim().min(10).max(2000) }), req.body);
    return reply.status(201).send(await service.requestAccountBreachReview(req.user!.id, accountId, body.reason));
  });

  app.get('/accounts/:accountId/breach-review', async (req) => {
    const { accountId } = parse(accountParams, req.params);
    return service.getAccountBreachReview(req.user!.id, accountId);
  });

  // Live risk view: equity, daily / static floors and room, profit target progress, exposure, margin and trading results
  app.get('/accounts/:accountId/risk', async (req) => {
    const { accountId } = parse(accountParams, req.params);
    return service.getAccountRisk(req.user!.id, accountId);
  });

  app.get('/accounts/:accountId', async (req) => {
    const { accountId } = parse(accountParams, req.params);
    return service.getAccountOverview(req.user!.id, accountId);
  });

  // ----------------------------- orders -----------------------------

  app.post('/accounts/:accountId/orders', writeLimit, async (req, reply) => {
    const { accountId } = parse(accountParams, req.params);
    const body = parse(orderSchema, req.body);
    // The standard Idempotency-Key header works like clientOrderId. A key is REQUIRED (spec: every mutating order call carries a
    // client idempotency key), so a double click or a network retry can never execute twice.
    const header = req.headers['idempotency-key'];
    const clientOrderId = body.clientOrderId ?? (typeof header === 'string' && header.length > 0 && header.length <= 64 ? header : undefined);
    if (!clientOrderId) {
      throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header (1 to 64 characters) or clientOrderId with every order');
    }

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
      // The server clock sets the expiry time (GTC = never)
      expiresAt: body.type === 'LIMIT' ? expiryToDate(body.expiry) : null,
      positionSide: body.positionSide ?? null,
      clientOrderId,
    });
    return reply.status(result.duplicate ? 200 : 201).send(result);
  });

  // Preview of the order ticket (size, notional, margin, fee, maker / taker, maximum valid size and the binding rule).
  // Read only: nothing is reserved, nothing is written.
  app.post('/accounts/:accountId/orders/preview', async (req) => {
    const { accountId } = parse(accountParams, req.params);
    const body = parse(previewSchema, req.body);
    return service.previewTrade(req.user!.id, {
      accountId,
      symbol: body.symbol,
      side: body.side,
      type: body.type,
      size: body.size ? new Decimal(body.size) : null,
      notionalUsd: body.notionalUsd ? new Decimal(body.notionalUsd) : null,
      marginUsd: body.marginUsd ? new Decimal(body.marginUsd) : null,
      leverage: body.leverage,
      limitPrice: body.limitPrice ? new Decimal(body.limitPrice) : null,
      triggerPrice: body.triggerPrice ? new Decimal(body.triggerPrice) : null,
      reduceOnly: body.reduceOnly,
      postOnly: body.postOnly,
    });
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
    // Optional Idempotency-Key: a retried partial close is answered with the first result instead of closing twice
    const header = req.headers['idempotency-key'];
    return service.closePosition(req.user!.id, accountId, symbol, {
      size: body.size ? new Decimal(body.size) : undefined,
      positionSide: body.positionSide,
      clientOrderId: typeof header === 'string' && header.length > 0 && header.length <= 64 ? header : undefined,
    });
  });

  // Close all positions, or only longs / only shorts
  app.post('/accounts/:accountId/positions/close-all', writeLimit, async (req) => {
    const { accountId } = parse(accountParams, req.params);
    const body = parse(z.object({ side: z.enum(['LONG', 'SHORT']).optional() }), req.body ?? {});
    return service.closeAllPositions(req.user!.id, accountId, body.side);
  });

  // Spec v1: one net position per symbol. ONE_WAY is accepted, HEDGE is refused (HEDGE_NOT_AVAILABLE).
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

