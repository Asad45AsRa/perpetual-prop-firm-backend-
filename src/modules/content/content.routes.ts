import type { FastifyInstance } from 'fastify';
import { prisma } from '../../config/prisma';
import { ApiError } from '../../utils/api-error';

// Public content (FAQ, rules, ...) edited from the admin panel.
export async function contentRoutes(app: FastifyInstance) {
  app.get('/:key', async (req) => {
    const { key } = req.params as { key: string };
    const block = await prisma.contentBlock.findUnique({ where: { key } });
    if (!block) throw ApiError.notFound('Content not found');
    return { key: block.key, title: block.title, data: block.data, updatedAt: block.updatedAt };
  });
}
