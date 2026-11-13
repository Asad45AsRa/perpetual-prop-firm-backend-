import type { Role, User } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { ApiError } from '../../utils/api-error';
import {
  ACCESS_LEVELS,
  ADMIN_SECTION_LIST,
  GRANTABLE_SECTIONS,
  PORTAL_PERMISSIONS,
  ROLE_PRESETS,
  SPECIAL_RIGHT_LIST,
  type AdminSection,
  type SpecialRight,
} from './rbac.catalog';
import { resolveAccess, type EffectiveAccess } from './rbac.resolve';

// The admin frontend uses lowercase roles ("super_admin" | "admin" | "moderator").
export type FrontRole = 'super_admin' | 'admin' | 'moderator';
export const toFrontRole = (r: Role) => r.toLowerCase() as FrontRole;
export const fromFrontRole = (r: 'admin' | 'moderator'): Role => (r === 'admin' ? 'ADMIN' : 'MODERATOR');

/** Loads a user's grants and rights and resolves their effective access. */
export async function loadAccess(userId: string): Promise<EffectiveAccess> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      role: true,
      portals: true,
      permissions: { select: { section: true, level: true } },
      rights: { select: { right: true } },
    },
  });
  if (!user) throw ApiError.unauthorized();
  return resolveAccess({
    role: user.role,
    portals: user.portals,
    grants: user.permissions,
    rights: user.rights.map((r) => r.right),
  });
}

/** Everything the Staff & Permissions page needs to render its checkboxes. */
export function getCatalog() {
  return {
    levels: ACCESS_LEVELS,
    sections: ADMIN_SECTION_LIST,
    rights: SPECIAL_RIGHT_LIST,
    portals: PORTAL_PERMISSIONS,
    rolePresets: { admin: ROLE_PRESETS.ADMIN, moderator: ROLE_PRESETS.MODERATOR },
  };
}

export type GrantInput = Partial<Record<AdminSection, 'none' | 'view' | 'manage'>>;

/** Replaces a staff member's section grants and rights in one transaction. */
export async function replaceStaffAccess(userId: string, grants: GrantInput, rights: SpecialRight[]) {
  const rows = Object.entries(grants)
    .filter(([section, level]) => level && level !== 'none' && (GRANTABLE_SECTIONS as string[]).includes(section))
    .map(([section, level]) => ({ userId, section, level: level === 'manage' ? ('MANAGE' as const) : ('VIEW' as const) }));

  await prisma.$transaction([
    prisma.staffPermission.deleteMany({ where: { userId } }),
    prisma.staffPermission.createMany({ data: rows }),
    prisma.staffRight.deleteMany({ where: { userId } }),
    prisma.staffRight.createMany({ data: [...new Set(rights)].map((right) => ({ userId, right })) }),
  ]);
}

export const staffInclude = {
  permissions: { select: { section: true, level: true } },
  rights: { select: { right: true } },
} as const;

type StaffRow = User & { permissions: { section: string; level: 'VIEW' | 'MANAGE' }[]; rights: { right: string }[] };

function grantsAndRights(u: StaffRow) {
  const access = resolveAccess({ role: u.role, portals: [], grants: u.permissions, rights: u.rights.map((r) => r.right) });
  // Super admin: the frontend checks role, so only real grants are listed (like its mock).
  const grants = u.role === 'SUPER_ADMIN' ? {} : Object.fromEntries(Object.entries(access.sections).filter(([, l]) => l !== 'none'));
  return { grants, rights: u.role === 'SUPER_ADMIN' ? [] : access.rights };
}

/** The admin frontend's `AdminUser` (session user). */
export async function toAdminUser(userId: string) {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, include: staffInclude });
  return {
    id: u.id,
    name: u.displayName ?? u.email,
    email: u.email,
    role: toFrontRole(u.role),
    ...grantsAndRights(u),
    protected: u.isProtected,
  };
}

/** One row of the Staff & Permissions table (frontend `Staff` type). */
export function toStaffRow(u: StaffRow) {
  return {
    id: u.id,
    name: u.displayName ?? u.email,
    email: u.email,
    role: toFrontRole(u.role),
    status: u.isActive ? 'active' : 'suspended',
    ...grantsAndRights(u),
    protected: u.isProtected,
    twoFactor: u.mfaEnabled ? 'enabled' : 'setup required',
    lastLoginAt: u.lastLoginAt?.toISOString() ?? '',
    createdBy: u.createdByEmail ?? '',
    createdAt: u.createdAt.toISOString(),
    version: u.version,
  };
}
