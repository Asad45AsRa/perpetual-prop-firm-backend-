import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { authenticator } from 'otplib';
import { z } from 'zod';
import { env } from '../../config/env';
import { prisma } from '../../config/prisma';
import { requireStaff } from '../../middleware/auth';
import { ApiError } from '../../utils/api-error';
import { decrypt, encrypt } from '../../utils/encryption';
import { verifyPassword } from '../../utils/password';
import { signMfaChallengeToken, verifyMfaChallengeToken } from '../../utils/tokens';
import { parse } from '../../utils/validate';
import { audit } from '../audit/audit.service';
import { endSession, startSession } from '../auth/session';
import { toAdminUser } from '../rbac/rbac.service';
import { getSetting } from '../settings/settings.service';

// Accept the previous/next 30s code too: phone clock drift and codes typed at the boundary (RFC 6238).
authenticator.options = { window: 1 };

// =====================================================================
// /api/v1/admin/auth: admin console sign-in (frontend src/components/admin/Adminauth.tsx).
//   POST /login       { email, password }   -> { challengeId, twoFactorSetupRequired, otpauthUrl? }
//   POST /verify-2fa  { challengeId, code } -> { user: AdminUser }  + httpOnly session cookies
//   GET  /me          -> { user: AdminUser, killSwitches }  (polled by the console)
//   POST /logout
// 2FA is always required. The first sign-in (or after "Reset 2FA") returns an otpauth URL to scan.
// =====================================================================

const strictLimit = { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } };
// One message for every failure, so nobody can learn which emails exist (same as the frontend mock).
const BAD_LOGIN = 'Sign-in failed. Check your details or contact the super admin.';
const DUMMY_HASH = bcrypt.hashSync('timing-attack-protection', 12);

export async function adminAuthRoutes(app: FastifyInstance) {
  app.post('/login', strictLimit, async (req) => {
    const { email, password } = parse(z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1) }), req.body);
    const user = await prisma.user.findUnique({ where: { email } });
    const valid = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !valid || user.role === 'USER' || !user.isActive || user.deletedAt) {
      await audit({ actorId: user?.role !== 'USER' ? user?.id : undefined, action: 'admin.login.failed', ip: req.ip, metadata: { email } });
      throw new ApiError(401, 'BAD_CREDENTIALS', BAD_LOGIN);
    }

    // First sign-in or after a 2FA reset: create a secret to scan; it is confirmed by /verify-2fa.
    let otpauthUrl: string | undefined;
    if (!user.mfaEnabled) {
      const secret = user.mfaSecret ? decrypt(user.mfaSecret) : authenticator.generateSecret();
      if (!user.mfaSecret) await prisma.user.update({ where: { id: user.id }, data: { mfaSecret: encrypt(secret) } });
      otpauthUrl = authenticator.keyuri(user.email, env.MFA_ISSUER, secret);
    }
    return { challengeId: signMfaChallengeToken(user.id), twoFactorSetupRequired: !user.mfaEnabled, ...(otpauthUrl ? { otpauthUrl } : {}) };
  });

  app.post('/verify-2fa', strictLimit, async (req, reply) => {
    const { challengeId, code } = parse(z.object({ challengeId: z.string().min(10), code: z.string().regex(/^\d{6}$/) }), req.body);
    const userId = verifyMfaChallengeToken(challengeId);
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.role === 'USER' || !user.isActive || user.deletedAt || !user.mfaSecret) {
      throw new ApiError(401, 'BAD_CODE', 'That code is not correct.');
    }
    if (!authenticator.check(code, decrypt(user.mfaSecret))) {
      await audit({ actorId: user.id, action: 'admin.2fa.failed', ip: req.ip });
      throw new ApiError(401, 'BAD_CODE', 'That code is not correct.');
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date(), ...(user.mfaEnabled ? {} : { mfaEnabled: true }) },
    });
    await startSession(req, reply, updated, 'admin', true);
    await audit({ actorId: user.id, action: user.mfaEnabled ? 'admin.login' : 'admin.login.2fa_enabled', ip: req.ip });
    return { user: await toAdminUser(updated.id) };
  });

  // Polled by the console: refreshes the person's access and shows active kill switches.
  app.get('/me', { preHandler: requireStaff }, async (req) => ({
    user: await toAdminUser(req.user!.id),
    killSwitches: await getSetting('killSwitches'),
  }));

  app.post('/logout', async (req, reply) => {
    if (req.user) await audit({ actorId: req.user.id, action: 'admin.logout', ip: req.ip });
    await endSession(req, reply, 'admin');
    return {};
  });
}
