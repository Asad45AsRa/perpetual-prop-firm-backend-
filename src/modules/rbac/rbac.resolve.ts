// Pure RBAC logic (no database), so it is fully unit-tested in tests/rbac.test.ts.
import {
  ADMIN_SECTIONS,
  PORTAL_PERMISSIONS,
  SPECIAL_RIGHTS,
  SUPER_ONLY_SECTIONS,
  type AccessLevelName,
  type AdminSection,
  type PortalName,
  type PortalPermission,
  type SpecialRight,
} from './rbac.catalog';

export type RoleName = 'USER' | 'MODERATOR' | 'ADMIN' | 'SUPER_ADMIN';

export interface RbacInput {
  role: RoleName;
  portals: PortalName[];
  grants: { section: string; level: 'VIEW' | 'MANAGE' }[];
  rights: string[];
}

// What the frontend needs to build menus and what the guards check.
export interface EffectiveAccess {
  role: RoleName;
  kind: 'user' | 'staff';
  isSuperAdmin: boolean;
  portals: PortalName[];
  /** End-user features (empty for staff). */
  permissions: PortalPermission[];
  /** Admin section level for every section (all "none" for end users). */
  sections: Record<AdminSection, AccessLevelName>;
  /** Special rights (empty for end users). */
  rights: SpecialRight[];
}

const RANK: Record<AccessLevelName, number> = { none: 0, view: 1, manage: 2 };

/** Does `have` satisfy `need`? manage implies view. */
export const levelAllows = (have: AccessLevelName, need: Exclude<AccessLevelName, 'none'>) => RANK[have] >= RANK[need];

export const isStaffRole = (role: RoleName) => role !== 'USER';

export function resolveAccess(input: RbacInput): EffectiveAccess {
  const isSuperAdmin = input.role === 'SUPER_ADMIN';
  const staff = isStaffRole(input.role);

  const sections = Object.fromEntries(ADMIN_SECTIONS.map((s) => [s, 'none'])) as Record<AdminSection, AccessLevelName>;
  if (isSuperAdmin) {
    for (const s of ADMIN_SECTIONS) sections[s] = 'manage';
  } else if (staff) {
    for (const g of input.grants) {
      // Unknown or super-only keys in the DB are ignored, never trusted.
      if (!(ADMIN_SECTIONS as string[]).includes(g.section)) continue;
      if (SUPER_ONLY_SECTIONS.includes(g.section as AdminSection)) continue;
      sections[g.section as AdminSection] = g.level === 'MANAGE' ? 'manage' : 'view';
    }
  }

  const rights: SpecialRight[] = isSuperAdmin
    ? [...SPECIAL_RIGHTS]
    : staff
      ? SPECIAL_RIGHTS.filter((r) => input.rights.includes(r))
      : [];

  // Staff are not traders or affiliates; their portals are ignored.
  const portals = staff ? [] : [...new Set(input.portals)];
  const permissions = portals.flatMap((p) => [...PORTAL_PERMISSIONS[p]]) as PortalPermission[];

  return { role: input.role, kind: staff ? 'staff' : 'user', isSuperAdmin, portals, permissions, sections, rights };
}

export const canSection = (a: EffectiveAccess, section: AdminSection, need: Exclude<AccessLevelName, 'none'> = 'view') =>
  levelAllows(a.sections[section], need);

export const hasRight = (a: EffectiveAccess, right: SpecialRight) => a.isSuperAdmin || a.rights.includes(right);

export const hasPortal = (a: EffectiveAccess, portal: PortalName) => a.portals.includes(portal);
