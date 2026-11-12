import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../config/prisma';
import { authenticate, requirePermission } from '../../middleware/auth';
import { ApiError } from '../../utils/api-error';
import { parse } from '../../utils/validate';
import { audit } from '../audit/audit.service';
import { getHealth } from '../health/health.service';
import { priceFeed } from '../markets/price-feed';
import { syncMarkets } from '../markets/market.service';
import * as payouts from '../payouts/payouts.service';
import { lockAccount } from '../risk/risk.service';
import { SETTING_DEFAULTS, getSetting, saveSetting, type SettingKey } from '../settings/settings.service';
import { adminStaffRoutes } from './admin.staff.routes';

const page = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
const idParams = z.object({ id: z.string().uuid() });

const planSchema = z.object({
  name: z.string().min(1),
  accountSize: z.string().regex(/^\d+(\.\d+)?$/),
  price: z.string().regex(/^\d+(\.\d+)?$/),
  profitTargetPct: z.string().regex(/^\d+(\.\d+)?$/),
  dailyLossPct: z.string().regex(/^\d+(\.\d+)?$/),
  maxDrawdownPct: z.string().regex(/^\d+(\.\d+)?$/),
  maxLeverage: z.number().int().min(1).max(200).default(20),
  minTradingDays: z.number().int().min(0).default(0),
  dailyLossMethod: z.enum(['BALANCE_BASED', 'EQUITY_BASED']).default('BALANCE_BASED'),
  drawdownType: z.enum(['STATIC', 'TRAILING']).default('STATIC'),
  isActive: z.boolean().default(true),
});

export async function adminRoutes(app: FastifyInstance) {
  // Every admin endpoint needs a logged in user; permissions are per section.
  app.addHook('preHandler', authenticate);

  // Staff management (super admin only)
  await app.register(adminStaffRoutes, { prefix: '/staff' });

  // ------------------------------ Dashboard ----------------------------
  app.get('/dashboard', { preHandler: requirePermission('system-health') }, async () => {
    const [users, activeAccounts, breached, pendingPayouts, revenue] = await Promise.all([
      prisma.user.count({ where: { role: 'USER' } }),
      prisma.tradingAccount.count({ where: { status: 'ACTIVE' } }),
      prisma.tradingAccount.count({ where: { status: 'BREACHED' } }),
      prisma.payout.count({ where: { status: 'REQUESTED' } }),
      prisma.purchase.aggregate({ where: { status: 'PAID' }, _sum: { amount: true } }),
    ]);
    return { users, activeAccounts, breached, pendingPayouts, revenue: revenue._sum.amount?.toString() ?? '0' };
  });

  // -------------------------------- Users ------------------------------
  app.get('/users', { preHandler: requirePermission('users') }, async (req) => {
    const { page: p, pageSize } = parse(page, req.query);
    const search = (req.query as { search?: string }).search;
    const where = search ? { email: { contains: search, mode: 'insensitive' as const } } : {};
    const [items, total] = await Promise.all([
      prisma.user.findMany({
        where: { ...where, role: 'USER' },
        select: { id: true, email: true, isActive: true, emailVerified: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        skip: (p - 1) * pageSize,
        take: pageSize,
      }),
      prisma.user.count({ where: { ...where, role: 'USER' } }),
    ]);
    return { items, total, page: p, pageSize };
  });

  app.patch('/users/:id/status', { preHandler: requirePermission('users') }, async (req) => {
    const { id } = parse(idParams, req.params);
    const { isActive } = parse(z.object({ isActive: z.boolean() }), req.body);
    const target = await prisma.user.findUnique({ where: { id } });
    if (!target || target.role !== 'USER') throw ApiError.notFound('User not found');

    await prisma.user.update({ where: { id }, data: { isActive } });
    if (!isActive) {
      await prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    await audit({ actorId: req.user!.id, action: isActive ? 'user.enabled' : 'user.disabled', entity: 'User', entityId: id });
    return { ok: true };
  });

  // -------------------------------- Plans ------------------------------
  app.get('/plans', { preHandler: requirePermission('plans') }, async () =>
    prisma.plan.findMany({ orderBy: { accountSize: 'asc' } }),
  );

  app.post('/plans', { preHandler: requirePermission('plans') }, async (req, reply) => {
    const plan = await prisma.plan.create({ data: parse(planSchema, req.body) });
    await audit({ actorId: req.user!.id, action: 'plan.created', entity: 'Plan', entityId: plan.id });
    return reply.status(201).send(plan);
  });

  app.patch('/plans/:id', { preHandler: requirePermission('plans') }, async (req) => {
    const { id } = parse(idParams, req.params);
    const plan = await prisma.plan.update({ where: { id }, data: parse(planSchema.partial(), req.body) });
    await audit({ actorId: req.user!.id, action: 'plan.updated', entity: 'Plan', entityId: id });
    return plan;
  });

  // ------------------------------- Markets -----------------------------
  app.get('/markets', { preHandler: requirePermission('markets') }, async () =>
    prisma.market.findMany({ orderBy: { symbol: 'asc' } }),
  );

  app.post('/markets/sync', { preHandler: requirePermission('markets') }, async (req) => {
    const synced = await syncMarkets();
    await audit({ actorId: req.user!.id, action: 'market.synced', metadata: { synced } });
    return { synced };
  });

  app.patch('/markets/:id', { preHandler: requirePermission('markets') }, async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(
      z.object({
        isEnabled: z.boolean().optional(),
        isHalted: z.boolean().optional(),
        maxLeverage: z.number().int().min(1).max(200).optional(),
      }),
      req.body,
    );
    const market = await prisma.market.update({ where: { id }, data: body });
    if (market.isEnabled) priceFeed.track(market.symbol);
    else priceFeed.untrack(market.symbol);
    await audit({ actorId: req.user!.id, action: 'market.updated', entity: 'Market', entityId: id, metadata: body });
    return market;
  });

  // ------------------------------ Accounts -----------------------------
  app.get('/accounts', { preHandler: requirePermission('accounts') }, async (req) => {
    const { page: p, pageSize } = parse(page, req.query);
    const status = (req.query as { status?: string }).status;
    const where = status ? { status: status as 'ACTIVE' } : {};
    const [items, total] = await Promise.all([
      prisma.tradingAccount.findMany({
        where,
        include: { user: { select: { email: true } }, plan: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (p - 1) * pageSize,
        take: pageSize,
      }),
      prisma.tradingAccount.count({ where }),
    ]);
    return { items, total, page: p, pageSize };
  });

  // Manual lock: closes positions and disables the account
  app.post('/accounts/:id/lock', { preHandler: requirePermission('accounts') }, async (req) => {
    const { id } = parse(idParams, req.params);
    const { reason } = parse(z.object({ reason: z.string().min(3) }), req.body);
    await lockAccount(id, 'DISABLED', 'MANUAL_LOCK', reason, { reason }, req.user!.id);
    return { ok: true };
  });

  // Full ledger of an account (transparency for admins)
  app.get('/accounts/:id/ledger', { preHandler: requirePermission('accounts') }, async (req) => {
    const { id } = parse(idParams, req.params);
    return prisma.ledgerEntry.findMany({ where: { accountId: id }, orderBy: { createdAt: 'desc' }, take: 200 });
  });

  // ----------------------------- Risk events ---------------------------
  app.get('/risk-events', { preHandler: requirePermission('risk') }, async (req) => {
    const { page: p, pageSize } = parse(page, req.query);
    const [items, total] = await Promise.all([
      prisma.riskEvent.findMany({
        include: { account: { select: { id: true, user: { select: { email: true } } } } },
        orderBy: { createdAt: 'desc' },
        skip: (p - 1) * pageSize,
        take: pageSize,
      }),
      prisma.riskEvent.count(),
    ]);
    return { items, total, page: p, pageSize };
  });

  // ------------------------------- Payouts -----------------------------
  app.get('/payouts', { preHandler: requirePermission('payouts') }, async (req) => {
    const status = (req.query as { status?: 'REQUESTED' }).status;
    return payouts.listPayoutsForAdmin(status);
  });
  app.post('/payouts/:id/approve', { preHandler: requirePermission('payouts') }, async (req) => {
    await payouts.approvePayout(parse(idParams, req.params).id, req.user!.id);
    return { ok: true };
  });
  app.post('/payouts/:id/reject', { preHandler: requirePermission('payouts') }, async (req) => {
    const { reason } = parse(z.object({ reason: z.string().min(3) }), req.body);
    await payouts.rejectPayout(parse(idParams, req.params).id, req.user!.id, reason);
    return { ok: true };
  });
  app.post('/payouts/:id/sent', { preHandler: requirePermission('payouts') }, async (req) => {
    const { txHash } = parse(z.object({ txHash: z.string().min(10).max(128) }), req.body);
    await payouts.markPayoutSent(parse(idParams, req.params).id, req.user!.id, txHash);
    return { ok: true };
  });
  app.post('/payouts/:id/confirm', { preHandler: requirePermission('payouts') }, async (req) => {
    await payouts.confirmPayout(parse(idParams, req.params).id, req.user!.id);
    return { ok: true };
  });

  // ------------------------------ Affiliates ---------------------------
  app.get('/commissions', { preHandler: requirePermission('affiliates') }, async () =>
    prisma.commission.findMany({
      include: { affiliate: { select: { email: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
  );
  app.patch('/commissions/:id', { preHandler: requirePermission('affiliates') }, async (req) => {
    const { id } = parse(idParams, req.params);
    const { status } = parse(z.object({ status: z.enum(['APPROVED', 'PAID', 'REJECTED']) }), req.body);
    await prisma.commission.update({ where: { id }, data: { status } });
    await audit({ actorId: req.user!.id, action: 'commission.updated', entity: 'Commission', entityId: id, metadata: { status } });
    return { ok: true };
  });

  // ---------------------- Website content (FAQ, rules) -----------------
  app.get('/content', { preHandler: requirePermission('content') }, async () =>
    prisma.contentBlock.findMany({ orderBy: { key: 'asc' } }),
  );
  app.put('/content/:key', { preHandler: requirePermission('content') }, async (req) => {
    const { key } = req.params as { key: string };
    const body = parse(z.object({ title: z.string().optional(), data: z.any() }), req.body);
    const block = await prisma.contentBlock.upsert({
      where: { key },
      create: { key, title: body.title, data: body.data ?? {}, updatedById: req.user!.id },
      update: { title: body.title, data: body.data ?? {}, updatedById: req.user!.id },
    });
    await audit({ actorId: req.user!.id, action: 'content.updated', entity: 'ContentBlock', entityId: block.id, metadata: { key } });
    return block;
  });

  // ---------------------------- Platform settings ----------------------
  app.get('/settings', { preHandler: requirePermission('settings') }, async () => ({
    trading: await getSetting('trading'),
    payout: await getSetting('payout'),
    affiliate: await getSetting('affiliate'),
  }));
  app.put('/settings/:key', { preHandler: requirePermission('settings') }, async (req) => {
    const { key } = req.params as { key: string };
    if (!(key in SETTING_DEFAULTS)) throw ApiError.notFound('Unknown setting');
    const value = parse(z.record(z.any()), req.body);
    await saveSetting(key as SettingKey, value);
    await audit({ actorId: req.user!.id, action: 'settings.updated', entity: 'PlatformSetting', entityId: key, metadata: value });
    return { ok: true };
  });

  // ------------------------------ Audit logs ---------------------------
  app.get('/audit-logs', { preHandler: requirePermission('audit') }, async (req) => {
    const { page: p, pageSize } = parse(page, req.query);
    const [items, total] = await Promise.all([
      prisma.auditLog.findMany({
        include: { actor: { select: { email: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (p - 1) * pageSize,
        take: pageSize,
      }),
      prisma.auditLog.count(),
    ]);
    return { items, total, page: p, pageSize };
  });

  // ---------------------------- System health --------------------------
  app.get('/system-health', { preHandler: requirePermission('system-health') }, async () => getHealth(true));
}
