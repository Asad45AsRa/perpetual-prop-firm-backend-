import type { FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../config/prisma';
import { ApiError } from '../utils/api-error';
import { verifyAccessToken } from '../utils/tokens';
import { loadAccess } from '../modules/rbac/rbac.service';
import { canSection, hasPortal, hasRight, type EffectiveAccess } from '../modules/rbac/rbac.resolve';
import type { AdminSection, PortalName, SpecialRight } from '../modules/rbac/rbac.catalog';
import { appOf, readAccessCookie, refreshFromCookie } from '../modules/auth/session';

// =====================================================================
// Guards. Use them as Fastify preHandlers, e.g.
//   { preHandler: requireAccess('payouts', 'manage', 'payout.approve') }
//   { preHandler: requirePortal('TRADER') }
// Sessions come from httpOnly cookies (see modules/auth/session.ts). Every guard
// authenticates first if needed, so the order never matters.
// =====================================================================

type Guard = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

async function loadUser(req: FastifyRequest, userId: string, mfa: boolean, issuedAtSec?: number) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, role: true, portals: true, isActive: true, deletedAt: true, tokensValidAfter: true },
  });
  if (!user || !user.isActive || user.deletedAt) return false;
  // Token issued before a force sign-out / suspension / role change.
  // iat has 1s precision: a token from the same second as the cut-off is rejected (the refresh cookie, ms-precise, re-issues it).
  if (issuedAtSec !== undefined && user.tokensValidAfter && issuedAtSec * 1000 <= user.tokensValidAfter.getTime()) return false;
  req.user = { id: user.id, email: user.email, role: user.role, portals: user.portals, mfaVerified: mfa };
  return true;
}

// Loads the signed-in user into req.user (access cookie, or a silent refresh).
export const authenticate: Guard = async (req, reply) => {
  if (req.user) return;
  const app = appOf(req);

  const access = readAccessCookie(req, app);
  if (access) {
    try {
      const payload = verifyAccessToken(access);
      if (await loadUser(req, payload.sub, payload.mfa, payload.iat)) return;
    } catch {
      // expired or invalid: fall through to the refresh cookie
    }
  }

  const refreshed = await refreshFromCookie(req, reply, app);
  if (refreshed && (await loadUser(req, refreshed.userId, refreshed.mfaVerified))) return;

  throw ApiError.unauthorized('Please sign in');
};

/** Effective access for this request, loaded once and cached on the request. */
export async function getAccess(req: FastifyRequest, reply: FastifyReply): Promise<EffectiveAccess> {
  await authenticate(req, reply);
  if (!req.access) req.access = await loadAccess(req.user!.id);
  return req.access;
}

// --------------------------- Staff (admin panel) ---------------------------

// Any staff member. Staff sessions must have passed 2FA.
export const requireStaff: Guard = async (req, reply) => {
  const access = await getAccess(req, reply);
  if (access.kind !== 'staff') throw ApiError.forbidden('Staff access only');
  if (!req.user!.mfaVerified) throw ApiError.forbidden('Two-factor authentication is required for admin access');
};

export const requireSuperAdmin: Guard = async (req, reply) => {
  await requireStaff(req, reply);
  if (!req.access!.isSuperAdmin) throw ApiError.forbidden('Super admin only');
};

/**
 * Section level, plus optional special rights (all required).
 *   requireAccess('payouts')                              -> can open the page
 *   requireAccess('payouts', 'manage')                    -> can run normal actions
 *   requireAccess('payouts', 'manage', 'payout.approve')  -> sensitive action
 */
export function requireAccess(section: AdminSection, level: 'view' | 'manage' = 'view', ...rights: SpecialRight[]): Guard {
  return async (req, reply) => {
    await requireStaff(req, reply);
    const access = req.access!;
    if (!canSection(access, section, level)) {
      throw ApiError.forbidden(`Requires "${level}" access to the "${section}" section`);
    }
    const missing = rights.filter((r) => !hasRight(access, r));
    if (missing.length) throw ApiError.forbidden(`Requires the special right: ${missing.join(', ')}`);
  };
}

/** A special right on its own (no section), e.g. audit export. */
export function requireRight(...rights: SpecialRight[]): Guard {
  return async (req, reply) => {
    await requireStaff(req, reply);
    const missing = rights.filter((r) => !hasRight(req.access!, r));
    if (missing.length) throw ApiError.forbidden(`Requires the special right: ${missing.join(', ')}`);
  };
}

// --------------------------- Customers (portals) ---------------------------

/** Signed-in customer (trader and/or affiliate). Staff accounts never pass. */
export const requireCustomer: Guard = async (req, reply) => {
  const access = await getAccess(req, reply);
  if (access.kind !== 'user') throw ApiError.forbidden('Staff accounts cannot use the customer dashboards');
};

/** Trader or affiliate dashboard. */
export function requirePortal(portal: PortalName): Guard {
  return async (req, reply) => {
    await requireCustomer(req, reply);
    if (!hasPortal(req.access!, portal)) {
      throw ApiError.forbidden(
        portal === 'AFFILIATE' ? 'Join the affiliate program to use the affiliate dashboard' : 'Trader access is not enabled for this account',
      );
    }
  };
}
