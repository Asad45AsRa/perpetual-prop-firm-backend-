import type { FastifyInstance } from 'fastify';
import { getHealth } from './health.service';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async (_req, reply) => {
    const result = await getHealth(false);
    return reply.status(result.status === 'ok' ? 200 : 503).send(result);
  });
}
