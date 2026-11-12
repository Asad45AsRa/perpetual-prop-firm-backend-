import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ADMIN_SECTIONS } from '../../config/constants';
import { prisma } from '../../config/prisma';
import { requireRole, requireStaff } from '../../middleware/auth';
import { ApiError } from '../../utils/api-error';
import { generateReferralCode } from '../../utils/crypto';
import { hashPassword } from '../../utils/password';
import { parse } from '../../utils/validate';
import { audit } from '../audit/audit.service';

const sectionEnum = z.enum(ADMIN_SECTIONS);

const createStaffSchema = z.object({
  email: z.string().email(),
  password: z.string().min(12),
  role: z.enum(['ADMIN', 'MODERATOR']),
  permissions: z.array(sectionEnum).default([]),
});

const idParams = z.object({ id: z.string().uuid() });

// Staff management. Only the SUPER_ADMIN can use these endpoints.
export async function adminStaffRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (req) => {
    await requireStaff(req);
    await requireRole('SUPER_ADMIN')(req);
  });

  app.get('/', async () => {
    const staff = await prisma.user.findMany({
      where: { role: { in: ['ADMIN', 'MODERATOR', 'SUPER_ADMIN'] }, deletedAt: null },
      include: { permissions: true },
      orderBy: { createdAt: 'asc' },
    });
    return staff.map((u) => ({
      id: u.id,
      email: u.email,
      role: u.role,
      isProtected: u.isProtected,
      mfaEnabled: u.mfaEnabled,
      permissions: u.permissions.map((p) => p.section),
    }));
  });

  // Create a sub-admin or moderator and grant sections one by one
  app.post('/', async (req, reply) => {
    const body = parse(createStaffSchema, req.body);
    const email = body.email.toLowerCase();
    if (await prisma.user.findUnique({ where: { email } })) throw ApiError.conflict('Email already in use');

    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: await hashPassword(body.password),
        role: body.role,
        emailVerified: true,
        emailVerifiedAt: new Date(),
        referralCode: generateReferralCode(),
        permissions: { create: body.permissions.map((section) => ({ section })) },
      },
    });
    await audit({ actorId: req.user!.id, action: 'staff.created', entity: 'User', entityId: user.id, metadata: { role: body.role, permissions: body.permissions } });
    return reply.status(201).send({ id: user.id, email: user.email, role: user.role });
  });

  // Replace the granted sections of a staff member
  app.put('/:id/permissions', async (req) => {
    const { id } = parse(idParams, req.params);
    const { permissions } = parse(z.object({ permissions: z.array(sectionEnum) }), req.body);

    const target = await prisma.user.findUnique({ where: { id } });
    if (!target || target.role === 'USER') throw ApiError.notFound('Staff member not found');
    if (target.isProtected) throw ApiError.forbidden('The super admin always has full access');

    await prisma.$transaction([
      prisma.staffPermission.deleteMany({ where: { userId: id } }),
      prisma.staffPermission.createMany({ data: permissions.map((section) => ({ userId: id, section })) }),
    ]);
    await audit({ actorId: req.user!.id, action: 'staff.permissions_updated', entity: 'User', entityId: id, metadata: { permissions } });
    return { ok: true };
  });

  // Delete a staff member: they can no longer log in and all sessions die.
  app.delete('/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const target = await prisma.user.findUnique({ where: { id } });
    if (!target || target.role === 'USER') throw ApiError.notFound('Staff member not found');
    if (target.isProtected || target.role === 'SUPER_ADMIN') {
      throw ApiError.forbidden('The super admin cannot be deleted');
    }

    await prisma.$transaction([
      prisma.user.update({ where: { id }, data: { deletedAt: new Date(), isActive: false } }),
      prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    await audit({ actorId: req.user!.id, action: 'staff.deleted', entity: 'User', entityId: id });
    return { ok: true };
  });
}
