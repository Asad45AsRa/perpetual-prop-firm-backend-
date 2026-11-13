import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env';
import { prisma } from '../../config/prisma';
import { requirePortal } from '../../middleware/auth';
import { ApiError } from '../../utils/api-error';
import { parse } from '../../utils/validate';
import { verifyPlisioSignature } from './plisio.client';
import * as service from './payments.service';

export async function paymentRoutes(app: FastifyInstance) {
  app.post('/checkout', { preHandler: requirePortal('TRADER') }, async (req) => {
    const { planId } = parse(z.object({ planId: z.string().uuid() }), req.body);
    return service.createCheckout(req.user!.id, planId);
  });

  app.get('/purchases', { preHandler: requirePortal('TRADER') }, async (req) => service.listMyPurchases(req.user!.id));

  // Plisio webhook (public URL, protected by signature + server-side re-check)
  app.post('/plisio/callback', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;

    if (!verifyPlisioSignature(body, env.PLISIO_API_KEY)) {
      throw ApiError.badRequest('Invalid signature');
    }

    const orderNumber = String(body.order_number ?? '');
    const purchase = await prisma.purchase.findUnique({ where: { id: orderNumber } }).catch(() => null);
    if (purchase) await service.syncPurchaseWithPlisio(purchase.id);

    // Always answer 200 once the signature is valid so Plisio stops retrying
    return { ok: true };
  });
}
