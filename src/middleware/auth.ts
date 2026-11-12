import type { FastifyRequest } from 'fastify';
import type { Role } from '@prisma/client';
import { prisma } from '../config/prisma';
import { ApiError } from '../utils/api-error';
import { verifyAccessToken } from '../utils/tokens';
import { STAFF_ROLES, type AdminSection } from '../config/constants';

// Reads the Bearer token and loads the current user into req.user.
export async function authenticate(req: FastifyRequest): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw ApiError.unauthorized('Missing access token');

  const payload = verifyAccessToken(header.slice(7));
  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    select: { id: true, email: true, role: true, isActive: true, deletedAt: true },
  });

  // Deleted or disabled staff cannot use an old token.
  if (!user || !user.isActive || user.deletedAt) throw ApiError.unauthorized('Account is disabled');

  req.user = { id: user.id, email: user.email, role: user.role, mfaVerified: payload.mfa };
}

// Allow only the listed roles.
export function requireRole(...roles: Role[]) {
  return async (req: FastifyRequest): Promise<void> => {
    if (!req.user) throw ApiError.unauthorized();
    if (!roles.includes(req.user.role)) throw ApiError.forbidden('Insufficient role');
  };
}

// Any staff member. Staff sessions must have passed MFA.
export async function requireStaff(req: FastifyRequest): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  if (!(STAFF_ROLES as readonly string[]).includes(req.user.role)) {
    throw ApiError.forbidden('Staff access only');
  }
  if (!req.user.mfaVerified) {
    throw ApiError.forbidden('Multi-factor authentication is required for admin access');
  }
}

// Staff member that has been granted a specific admin section.
// SUPER_ADMIN always passes.
export function requirePermission(section: AdminSection) {
  return async (req: FastifyRequest): Promise<void> => {
    await requireStaff(req);
    if (req.user!.role === 'SUPER_ADMIN') return;

    const granted = await prisma.staffPermission.findUnique({
      where: { userId_section: { userId: req.user!.id, section } },
    });
    if (!granted) throw ApiError.forbidden(`No access to the "${section}" section`);
  };
}
