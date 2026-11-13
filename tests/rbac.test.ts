import { describe, expect, it } from 'vitest';
import {
  ADMIN_SECTIONS,
  GRANTABLE_SECTIONS,
  PORTAL_PERMISSIONS,
  ROLE_PRESETS,
  SPECIAL_RIGHTS,
  SUPER_ONLY_SECTIONS,
} from '../src/modules/rbac/rbac.catalog';
import { canSection, hasPortal, hasRight, levelAllows, resolveAccess } from '../src/modules/rbac/rbac.resolve';

const base = { portals: [] as ('TRADER' | 'AFFILIATE')[], grants: [], rights: [] };

describe('levelAllows', () => {
  it('manage implies view, none allows nothing', () => {
    expect(levelAllows('manage', 'view')).toBe(true);
    expect(levelAllows('manage', 'manage')).toBe(true);
    expect(levelAllows('view', 'view')).toBe(true);
    expect(levelAllows('view', 'manage')).toBe(false);
    expect(levelAllows('none', 'view')).toBe(false);
  });
});

describe('super admin', () => {
  const a = resolveAccess({ ...base, role: 'SUPER_ADMIN' });
  it('has manage on every section, including super-only ones', () => {
    for (const s of ADMIN_SECTIONS) expect(a.sections[s]).toBe('manage');
  });
  it('has every special right and no customer portals', () => {
    expect(a.rights).toEqual([...SPECIAL_RIGHTS]);
    expect(a.portals).toEqual([]);
    expect(a.permissions).toEqual([]);
  });
});

describe('admin / moderator', () => {
  it('only gets the sections and rights it was granted', () => {
    const a = resolveAccess({
      ...base,
      role: 'ADMIN',
      grants: [
        { section: 'payouts', level: 'MANAGE' },
        { section: 'traders', level: 'VIEW' },
      ],
      rights: ['payout.approve'],
    });
    expect(canSection(a, 'payouts', 'manage')).toBe(true);
    expect(canSection(a, 'traders', 'view')).toBe(true);
    expect(canSection(a, 'traders', 'manage')).toBe(false);
    expect(canSection(a, 'settings', 'view')).toBe(false);
    expect(hasRight(a, 'payout.approve')).toBe(true);
    expect(hasRight(a, 'settings.kill_switch')).toBe(false);
  });

  it('never trusts super-only, unknown sections or unknown rights from the database', () => {
    const a = resolveAccess({
      ...base,
      role: 'MODERATOR',
      grants: [
        { section: 'staff', level: 'MANAGE' },
        { section: 'not-a-page', level: 'MANAGE' },
      ],
      rights: ['root.everything'],
    });
    expect(a.sections.staff).toBe('none');
    expect(a.rights).toEqual([]);
  });

  it('manage on a page does not grant money rights', () => {
    const a = resolveAccess({ ...base, role: 'ADMIN', grants: [{ section: 'payouts', level: 'MANAGE' }] });
    expect(hasRight(a, 'payout.approve')).toBe(false);
  });

  it('ignores portals for staff', () => {
    const a = resolveAccess({ ...base, role: 'ADMIN', portals: ['TRADER', 'AFFILIATE'] });
    expect(a.kind).toBe('staff');
    expect(a.portals).toEqual([]);
  });
});

describe('customers (trader / affiliate)', () => {
  it('a trader gets trader permissions only and no admin access', () => {
    const a = resolveAccess({ ...base, role: 'USER', portals: ['TRADER'] });
    expect(a.kind).toBe('user');
    expect(hasPortal(a, 'TRADER')).toBe(true);
    expect(hasPortal(a, 'AFFILIATE')).toBe(false);
    expect(a.permissions).toEqual([...PORTAL_PERMISSIONS.TRADER]);
    for (const s of ADMIN_SECTIONS) expect(a.sections[s]).toBe('none');
    expect(a.rights).toEqual([]);
  });

  it('a trader who joins the affiliate program gets both sets', () => {
    const a = resolveAccess({ ...base, role: 'USER', portals: ['TRADER', 'AFFILIATE', 'AFFILIATE'] });
    expect(a.portals).toEqual(['TRADER', 'AFFILIATE']);
    expect(a.permissions).toEqual([...PORTAL_PERMISSIONS.TRADER, ...PORTAL_PERMISSIONS.AFFILIATE]);
  });

  it('a user cannot gain staff rights from stray rows', () => {
    const a = resolveAccess({ ...base, role: 'USER', grants: [{ section: 'payouts', level: 'MANAGE' }], rights: ['payout.approve'] });
    expect(a.sections.payouts).toBe('none');
    expect(hasRight(a, 'payout.approve')).toBe(false);
  });
});

describe('catalog consistency', () => {
  it('section keys are unique and staff is super-only', () => {
    expect(new Set(ADMIN_SECTIONS).size).toBe(ADMIN_SECTIONS.length);
    expect(SUPER_ONLY_SECTIONS).toEqual(['staff']);
    expect(GRANTABLE_SECTIONS).not.toContain('staff');
  });

  it('role presets only use grantable sections and known rights', () => {
    for (const preset of Object.values(ROLE_PRESETS)) {
      for (const key of Object.keys(preset.grants)) expect(GRANTABLE_SECTIONS).toContain(key);
      for (const r of preset.rights) expect(SPECIAL_RIGHTS).toContain(r);
    }
  });
});
