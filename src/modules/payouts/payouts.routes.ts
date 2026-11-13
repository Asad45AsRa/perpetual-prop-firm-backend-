import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePortal } from '../../middleware/auth';
import { Decimal } from '../../utils/decimal';
import { parse } from '../../utils/validate';
import * as service from './payouts.service';

const requestSchema = z.object({
  accountId: z.string().uuid(),
  amount: z.string().regex(/^\d+(\.\d+)?$/),
  asset: z.string().min(2).max(10).default('USDT'),
  network: z.string().min(2).max(10),
  walletAddress: z.string().min(10).max(128),
});

export async function payoutRoutes(app: FastifyInstance) {
  // Public feed shown on the website
  app.get('/public', async () => service.listPublicPayouts());

  app.post('/', { preHandler: requirePortal('TRADER') }, async (req, reply) => {
    const body = parse(requestSchema, req.body);
    const payout = await service.requestPayout(req.user!.id, { ...body, amount: new Decimal(body.amount) });
    return reply.status(201).send(payout);
  });

  app.get('/', { preHandler: requirePortal('TRADER') }, async (req) => service.listMyPayouts(req.user!.id));

  app.get('/eligibility/:accountId', { preHandler: requirePortal('TRADER') }, async (req) => {
    const { accountId } = req.params as { accountId: string };
    const info = await service.getPayoutEligibility(req.user!.id, accountId);
    return {
      eligible: info.eligible,
      available: info.available.toString(),
      minPayout: info.minPayout.toString(),
      networks: info.networks,
    };
  });
}
