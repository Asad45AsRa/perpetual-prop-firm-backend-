import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../config/prisma';
import { requireSuperAdmin } from '../../middleware/auth';
import { ApiError } from '../../utils/api-error';
import { generateReferralCode } from '../../utils/crypto';
import { hashPassword } from '../../utils/password';
import { parse } from '../../utils/validate';
import { audit } from '../audit/audit.service';
import { revokeAllSessions } from '../auth/session';
import { GRANTABLE_SECTIONS, ROLE_PRESETS, SPECIAL_RIGHTS } from '../rbac/rbac.catalog';
import { fromFrontRole, replaceStaffAccess, staffInclude, toStaffRow, type GrantInput } from '../rbac/rbac.service';

// =====================================================================
// Staff & Permissions page (frontend src/components/admin/pages/StaffPermissions.tsx).
// Only the SUPER_ADMIN can use these endpoints. Roles use the frontend casing:
// "admin" | "moderator" (there is only one "super_admin").
// =====================================================================

// grants: { "<page key>": "view" | "manage" } ("none" or missing = no access). The staff page is never grantable.
const grantsSchema = z.record(z.enum(GRANTABLE_SECTIONS), z.enum(['none', 'view', 'manage']));
const rightsSchema = z.array(z.enum(SPECIAL_RIGHTS));
const role = z.enum(['admin', 'moderator'], { message: 'There can only be one super admin.' });
const tempPassword = z.string().min(8, 'The temporary password needs at least 8 characters.').max(128);

const createSchema = z.object({
  name: z.string().trim().min(2, "Enter the person's name.").max(80),
  email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
  password: tempPassword,
  role,
  // Omit both to start from the role preset (GET /admin/rbac/catalog -> rolePresets).
  grants: grantsSchema.optional(),
  rights: rightsSchema.optional(),
});
const patchSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  role: role.optional(),
  grants: grantsSchema.optional(),
  rights: rightsSchema.optional(),
  // Optimistic lock: send the row's `version`; 409 if someone else changed it first.
  ifVersion: z.number().int().optional(),
});
const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(100).optional(),
  // Comma list of fields to return distinct values for (filter dropdowns): role,status
  facet: z.string().optional(),
});
const idParams = z.object({ id: z.string().uuid() });
const reasonBody = z.object({ reason: z.string().trim().max(500).optional() }).default({});

async function findStaff(id: string) {
  const target = await prisma.user.findFirst({ where: { id, role: { not: 'USER' }, deletedAt: null }, include: staffInclude });
  if (!target) throw ApiError.notFound('Staff member not found.');
  return target;
}

// The super admin can never be changed, suspended or deleted (also blocked if someone tries by id).
async function guardProtected(actorId: string, target: { id: string; email: string; isProtected: boolean; role: string }, message: string) {
  if (target.isProtected || target.role === 'SUPER_ADMIN') {
    await audit({ actorId, action: 'staff.change_blocked', entity: 'User', entityId: target.id, metadata: { email: target.email, reason: message } });
    throw new ApiError(403, 'PROTECTED', message);
  }
}

export async function adminStaffRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireSuperAdmin);

  // Paged list (frontend ListResponse: { items, total, page, pageSize, facets })
  app.get('/', async (req) => {
    const { page, pageSize, q, facet } = parse(listQuery, req.query);
    const where: Prisma.UserWhereInput = {
      role: { in: ['ADMIN', 'MODERATOR', 'SUPER_ADMIN'] },
      deletedAt: null,
      ...(q ? { OR: [{ email: { contains: q, mode: 'insensitive' } }, { displayName: { contains: q, mode: 'insensitive' } }] } : {}),
    };
    const [total, rows] = await prisma.$transaction([
      prisma.user.count({ where }),
      prisma.user.findMany({ where, include: staffInclude, orderBy: { createdAt: 'asc' }, skip: (page - 1) * pageSize, take: pageSize }),
    ]);
    const facets: Record<string, string[]> = {};
    const wanted = (facet ?? '').split(',').filter(Boolean);
    if (wanted.includes('role')) facets.role = ['super_admin', 'admin', 'moderator'];
    if (wanted.includes('status')) facets.status = ['active', 'suspended'];
    return { items: rows.map(toStaffRow), total, page, pageSize, facets };
  });

  app.get('/:id', async (req) => toStaffRow(await findStaff(parse(idParams, req.params).id)));

  // Create an admin or moderator. Without grants/rights the role preset is applied.
  app.post('/', async (req, reply) => {
    const body = parse(createSchema, req.body);
    if (await prisma.user.findUnique({ where: { email: body.email } })) {
      throw new ApiError(409, 'CONFLICT', 'A staff member with this email already exists.');
    }
    const dbRole = fromFrontRole(body.role);
    const preset = ROLE_PRESETS[dbRole as 'ADMIN' | 'MODERATOR'];
    const grants: GrantInput = body.grants ?? preset.grants;
    const rights = body.rights ?? preset.rights;

    const user = await prisma.user.create({
      data: {
        email: body.email,
        displayName: body.name,
        passwordHash: await hashPassword(body.password),
        role: dbRole,
        portals: [],
        emailVerified: true,
        emailVerifiedAt: new Date(),
        referralCode: generateReferralCode(),
        createdByEmail: req.user!.email,
      },
    });
    await replaceStaffAccess(user.id, grants, rights);
    await audit({ actorId: req.user!.id, action: 'staff.created', entity: 'User', entityId: user.id, metadata: { email: body.email, role: body.role, grants, rights } });
    return reply.status(201).send(toStaffRow(await findStaff(user.id)));
  });

  // Edit name, role, page levels and rights in one call (the frontend's save button).
  app.patch('/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(patchSchema, req.body);
    const target = await findStaff(id);
    await guardProtected(req.user!.id, target, 'The super admin cannot be changed.');
    if (body.ifVersion !== undefined && body.ifVersion !== target.version) {
      throw new ApiError(409, 'VERSION_CONFLICT', 'This record was changed by someone else. Reload and try again.');
    }

    const roleChanged = body.role !== undefined && fromFrontRole(body.role) !== target.role;
    await prisma.user.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { displayName: body.name } : {}),
        ...(body.role !== undefined ? { role: fromFrontRole(body.role) } : {}),
        version: { increment: 1 },
      },
    });
    if (body.grants !== undefined || body.rights !== undefined) {
      const current = toStaffRow(target);
      await replaceStaffAccess(id, (body.grants ?? current.grants) as GrantInput, (body.rights ?? current.rights) as typeof SPECIAL_RIGHTS[number][]);
    }
    // A new role must be in every token: sign the person out everywhere.
    if (roleChanged) await revokeAllSessions(id);

    const after = await findStaff(id);
    await audit({
      actorId: req.user!.id,
      action: 'staff.access_updated',
      entity: 'User',
      entityId: id,
      metadata: { before: { role: target.role, grants: toStaffRow(target).grants, rights: toStaffRow(target).rights }, after: { role: after.role, grants: toStaffRow(after).grants, rights: toStaffRow(after).rights } },
    });
    return toStaffRow(after);
  });

  // Row actions: suspend, restore, force-logout, reset-2fa, reset-password
  app.post('/:id/:action', async (req) => {
    const { id, action } = parse(z.object({ id: z.string().uuid(), action: z.enum(['suspend', 'restore', 'force-logout', 'reset-2fa', 'reset-password']) }), req.params);
    const target = await findStaff(id);
    await guardProtected(req.user!.id, target, 'The super admin cannot be changed.');
    if (target.id === req.user!.id) throw new ApiError(409, 'SELF_ACTION', 'You cannot do this to your own account.');

    const { reason } = parse(reasonBody, req.body ?? {});
    switch (action) {
      case 'suspend':
        await prisma.user.update({ where: { id }, data: { isActive: false, version: { increment: 1 } } });
        await revokeAllSessions(id);
        break;
      case 'restore':
        await prisma.user.update({ where: { id }, data: { isActive: true, version: { increment: 1 } } });
        break;
      case 'force-logout':
        await revokeAllSessions(id);
        await prisma.user.update({ where: { id }, data: { version: { increment: 1 } } });
        break;
      case 'reset-2fa':
        await prisma.user.update({ where: { id }, data: { mfaEnabled: false, mfaSecret: null, version: { increment: 1 } } });
        await revokeAllSessions(id);
        break;
      case 'reset-password': {
        const { password } = parse(z.object({ password: tempPassword }), req.body);
        await prisma.user.update({ where: { id }, data: { passwordHash: await hashPassword(password), version: { increment: 1 } } });
        await revokeAllSessions(id);
        break;
      }
    }
    await audit({ actorId: req.user!.id, action: `staff.${action}`, entity: 'User', entityId: id, metadata: { reason } });
    return toStaffRow(await findStaff(id));
  });

  // Delete a staff member: they can no longer sign in and every session ends.
  app.delete('/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const target = await findStaff(id);
    await guardProtected(req.user!.id, target, 'The super admin cannot be deleted.');
    if (target.id === req.user!.id) throw new ApiError(409, 'SELF_DELETE', 'You cannot delete your own account.');

    await prisma.$transaction([
      prisma.user.update({ where: { id }, data: { deletedAt: new Date(), isActive: false, tokensValidAfter: new Date() } }),
      prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } }),
      prisma.staffPermission.deleteMany({ where: { userId: id } }),
      prisma.staffRight.deleteMany({ where: { userId: id } }),
    ]);
    await audit({ actorId: req.user!.id, action: 'staff.deleted', entity: 'User', entityId: id, metadata: { email: target.email, role: target.role } });
    return {};
  });
}
