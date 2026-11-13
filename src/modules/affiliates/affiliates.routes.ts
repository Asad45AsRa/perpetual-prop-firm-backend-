import type { FastifyInstance } from 'fastify';
import { prisma } from '../../config/prisma';
import { getAccess, requireCustomer, requirePortal } from '../../middleware/auth';
import { ApiError } from '../../utils/api-error';
import { audit } from '../audit/audit.service';
import { getAffiliateSummary } from './affiliates.service';

export async function affiliateRoutes(app: FastifyInstance) {
  // Affiliate join flow (/affiliates/join on the frontend): adds the AFFILIATE portal.
  // Already signed-in customer joins (new people use /auth/email/start with portal AFFILIATE).
  app.post('/join', { preHandler: requireCustomer }, async (req, reply) => {
    const access = await getAccess(req, reply);
    if (access.portals.includes('AFFILIATE')) return { portals: access.portals, alreadyJoined: true };
    const me = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id }, select: { portalsManagedByAdmin: true } });
    if (me.portalsManagedByAdmin) throw ApiError.forbidden('Affiliate access for this account is managed by support');

    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data: { portals: { push: 'AFFILIATE' } },
      select: { portals: true },
    });
    await audit({ actorId: req.user!.id, action: 'affiliate.joined', entity: 'User', entityId: req.user!.id });
    return { portals: user.portals, alreadyJoined: false };
  });

  app.get('/me', { preHandler: requirePortal('AFFILIATE') }, async (req) => getAffiliateSummary(req.user!.id));
}
