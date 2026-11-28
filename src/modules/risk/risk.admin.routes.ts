import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAccess } from '../../middleware/auth';
import { parse } from '../../utils/validate';
import { listAbuseFlags, resolveAbuseFlag, runAbuseScan } from './abuse.service';
import { listBreachReviews, resolveBreachReview } from './breach-review.service';

const idParams = z.object({ id: z.string().uuid() });
const paging = { page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) };

// Registered by the admin routes under /admin/risk (the admin authentication hook is inherited).
export async function adminRiskRoutes(app: FastifyInstance) {
  // ---- Abuse flags: hedging between accounts, copy trading, latency abuse ----
  app.get('/abuse-flags', { preHandler: requireAccess('risk') }, async (req) => {
    const q = parse(
      z.object({
        status: z.enum(['OPEN', 'CONFIRMED', 'DISMISSED']).optional(),
        type: z.enum(['CROSS_ACCOUNT_HEDGE', 'COPY_TRADING', 'LATENCY_ABUSE']).optional(),
        accountId: z.string().uuid().optional(),
        ...paging,
      }),
      req.query,
    );
    return listAbuseFlags(q);
  });

  app.post('/abuse-flags/:id/resolve', { preHandler: requireAccess('risk', 'manage', 'risk.review') }, async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(z.object({ decision: z.enum(['CONFIRMED', 'DISMISSED']), note: z.string().trim().min(3).max(2000) }), req.body);
    return resolveAbuseFlag(id, req.user!.id, body.decision, body.note);
  });

  // Runs all detectors now (they also run every 5 minutes)
  app.post('/abuse-scan', { preHandler: requireAccess('risk', 'manage', 'risk.review') }, async () => runAbuseScan());

  // ---- Technical breach reviews (72 hour window) ----
  app.get('/breach-reviews', { preHandler: requireAccess('risk') }, async (req) => {
    const q = parse(z.object({ status: z.enum(['OPEN', 'APPROVED', 'REJECTED']).optional(), ...paging }), req.query);
    return listBreachReviews(q);
  });

  app.post('/breach-reviews/:id/resolve', { preHandler: requireAccess('risk', 'manage', 'risk.review') }, async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(z.object({ decision: z.enum(['APPROVED', 'REJECTED']), note: z.string().trim().min(3).max(2000) }), req.body);
    return resolveBreachReview(id, req.user!.id, body.decision, body.note);
  });
}