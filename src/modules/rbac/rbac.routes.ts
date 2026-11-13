import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../config/prisma';
import { getAccess, requireAccess, requireStaff } from '../../middleware/auth';
import { ApiError } from '../../utils/api-error';
import { parse } from '../../utils/validate';
import { audit } from '../audit/audit.service';
import { PORTALS } from './rbac.catalog';
import { getCatalog } from './rbac.service';

// /api/v1/rbac: what the signed-in person can do (any role).
export async function rbacRoutes(app: FastifyInstance) {
  // Frontend calls this after login to build menus and hide buttons.
  app.get('/me', async (req, reply) => getAccess(req, reply));
}

// /api/v1/admin/rbac: catalog for the Staff & Permissions page + end-user portal management.
export async function adminRbacRoutes(app: FastifyInstance) {
  app.get('/catalog', { preHandler: requireStaff }, async () => getCatalog());

  // Grant or revoke the trader / affiliate dashboards for a customer.
  app.put(
    '/users/:id/portals',
    { preHandler: requireAccess('affiliates', 'manage') },
    async (req) => {
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
      const { portals } = parse(z.object({ portals: z.array(z.enum(PORTALS)) }), req.body);

      const user = await prisma.user.findUnique({ where: { id } });
      if (!user || user.deletedAt) throw ApiError.notFound('User not found');
      if (user.role !== 'USER') throw ApiError.badRequest('Portals apply to customers only, not staff');

      const unique = [...new Set(portals)];
      await prisma.user.update({ where: { id }, data: { portals: unique, portalsManagedByAdmin: true } });
      await audit({ actorId: req.user!.id, action: 'user.portals_updated', entity: 'User', entityId: id, metadata: { portals: unique } });
      return { id, portals: unique };
    },
  );
}
