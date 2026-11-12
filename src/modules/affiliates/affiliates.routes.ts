import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../middleware/auth';
import { getAffiliateSummary } from './affiliates.service';

export async function affiliateRoutes(app: FastifyInstance) {
  app.get('/me', { preHandler: authenticate }, async (req) => getAffiliateSummary(req.user!.id));
}
