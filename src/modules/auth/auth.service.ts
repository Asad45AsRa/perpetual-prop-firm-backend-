import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import type { User } from '@prisma/client';
import { env } from '../../config/env';
import { prisma } from '../../config/prisma';
import { ApiError } from '../../utils/api-error';
import { generateReferralCode, generateToken, sha256 } from '../../utils/crypto';
import { decrypt, encrypt } from '../../utils/encryption';
import { hashPassword, verifyPassword } from '../../utils/password';
import {
  signAccessToken,
  signMfaChallengeToken,
  verifyMfaChallengeToken,
} from '../../utils/tokens';
import { STAFF_ROLES } from '../../config/constants';
import { emailTemplates, sendEmail } from '../../services/email.service';
import { audit } from '../audit/audit.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const isStaff = (role: string) => (STAFF_ROLES as readonly string[]).includes(role);

// A real bcrypt hash of a throwaway value. Used to keep login timing the
// same whether or not the email exists.
const DUMMY_HASH = bcrypt.hashSync('timing-attack-protection', 12);

function publicUser(u: User) {
  return {
    id: u.id,
    email: u.email,
    role: u.role,
    emailVerified: u.emailVerified,
    mfaEnabled: u.mfaEnabled,
    referralCode: u.referralCode,
  };
}

// Creates an access token and a rotating refresh token.
async function issueSession(user: User, mfaVerified: boolean) {
  const refresh = generateToken(48);
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: refresh.hash,
      mfaVerified,
      expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * DAY_MS),
    },
  });

  return {
    accessToken: signAccessToken({ sub: user.id, role: user.role, mfa: mfaVerified }),
    refreshToken: refresh.raw,
    user: publicUser(user),
    // Staff without MFA can only reach the MFA setup endpoints
    mfaSetupRequired: isStaff(user.role) && !user.mfaEnabled,
  };
}

export async function signup(input: { email: string; password: string; referralCode?: string }) {
  const email = input.email.toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw ApiError.conflict('An account with this email already exists');

  const referrer = input.referralCode
    ? await prisma.user.findUnique({ where: { referralCode: input.referralCode.toUpperCase() } })
    : null;

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: await hashPassword(input.password),
      referralCode: generateReferralCode(),
      referredById: referrer?.id,
    },
  });

  await sendVerificationEmail(user);
  return { id: user.id, email: user.email };
}

async function sendVerificationEmail(user: User) {
  const token = generateToken();
  await prisma.emailToken.create({
    data: {
      userId: user.id,
      type: 'VERIFY_EMAIL',
      tokenHash: token.hash,
      expiresAt: new Date(Date.now() + DAY_MS),
    },
  });
  await sendEmail({ to: user.email, ...emailTemplates.verifyEmail(token.raw) });
}

export async function verifyEmail(rawToken: string) {
  const record = await prisma.emailToken.findUnique({ where: { tokenHash: sha256(rawToken) } });
  if (!record || record.type !== 'VERIFY_EMAIL' || record.usedAt || record.expiresAt < new Date()) {
    throw ApiError.badRequest('Verification link is invalid or expired');
  }
  await prisma.$transaction([
    prisma.emailToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    prisma.user.update({
      where: { id: record.userId },
      data: { emailVerified: true, emailVerifiedAt: new Date() },
    }),
  ]);
}

export async function login(input: { email: string; password: string }, ip?: string) {
  const user = await prisma.user.findUnique({ where: { email: input.email.toLowerCase() } });
  const valid = await verifyPassword(input.password, user?.passwordHash ?? DUMMY_HASH);

  if (!user || !valid || user.deletedAt || !user.isActive) {
    throw ApiError.unauthorized('Invalid email or password');
  }
  if (!user.emailVerified) throw ApiError.forbidden('Please verify your email first');

  // Staff with MFA enabled must also enter a one-time code
  if (isStaff(user.role) && user.mfaEnabled) {
    return { mfaRequired: true as const, mfaToken: signMfaChallengeToken(user.id) };
  }

  await audit({ actorId: user.id, action: 'auth.login', ip });
  return issueSession(user, false);
}

export async function verifyMfaLogin(input: { mfaToken: string; code: string }, ip?: string) {
  const userId = verifyMfaChallengeToken(input.mfaToken);
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.mfaEnabled || !user.mfaSecret || user.deletedAt || !user.isActive) {
    throw ApiError.unauthorized('MFA is not available for this account');
  }
  if (!authenticator.check(input.code, decrypt(user.mfaSecret))) {
    throw ApiError.unauthorized('Invalid MFA code');
  }
  await audit({ actorId: user.id, action: 'auth.login.mfa', ip });
  return issueSession(user, true);
}

// Refresh token rotation: the old token is revoked, a new one is issued.
export async function refresh(rawToken: string) {
  const record = await prisma.refreshToken.findUnique({
    where: { tokenHash: sha256(rawToken) },
    include: { user: true },
  });
  if (!record || record.revokedAt || record.expiresAt < new Date()) {
    throw ApiError.unauthorized('Invalid refresh token');
  }
  if (record.user.deletedAt || !record.user.isActive) throw ApiError.unauthorized('Account is disabled');

  await prisma.refreshToken.update({ where: { id: record.id }, data: { revokedAt: new Date() } });
  return issueSession(record.user, record.mfaVerified);
}

export async function logout(rawToken: string) {
  await prisma.refreshToken.updateMany({
    where: { tokenHash: sha256(rawToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function forgotPassword(email: string) {
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  // Always succeed so attackers cannot discover which emails exist.
  if (!user || user.deletedAt || !user.isActive) return;

  const token = generateToken();
  await prisma.emailToken.create({
    data: {
      userId: user.id,
      type: 'PASSWORD_RESET',
      tokenHash: token.hash,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  await sendEmail({ to: user.email, ...emailTemplates.passwordReset(token.raw) });
}

export async function resetPassword(rawToken: string, newPassword: string) {
  const record = await prisma.emailToken.findUnique({ where: { tokenHash: sha256(rawToken) } });
  if (!record || record.type !== 'PASSWORD_RESET' || record.usedAt || record.expiresAt < new Date()) {
    throw ApiError.badRequest('Reset link is invalid or expired');
  }
  await prisma.$transaction([
    prisma.emailToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    prisma.user.update({
      where: { id: record.userId },
      data: { passwordHash: await hashPassword(newPassword) },
    }),
    // Log out every device after a password reset
    prisma.refreshToken.updateMany({
      where: { userId: record.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);
}

// ----------------------- MFA (TOTP) for admin accounts -----------------

export async function setupMfa(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (user.mfaEnabled) throw ApiError.conflict('MFA is already enabled');

  const secret = authenticator.generateSecret();
  await prisma.user.update({ where: { id: userId }, data: { mfaSecret: encrypt(secret) } });

  // The frontend renders this URL as a QR code for an authenticator app
  return { secret, otpauthUrl: authenticator.keyuri(user.email, env.MFA_ISSUER, secret) };
}

export async function enableMfa(userId: string, code: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.mfaSecret) throw ApiError.badRequest('Start MFA setup first');
  if (!authenticator.check(code, decrypt(user.mfaSecret))) throw ApiError.badRequest('Invalid MFA code');

  const updated = await prisma.user.update({ where: { id: userId }, data: { mfaEnabled: true } });
  await audit({ actorId: userId, action: 'auth.mfa.enabled' });
  // Return a fresh MFA-verified session so the admin can continue right away
  return issueSession(updated, true);
}

export async function getMe(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: { permissions: true },
  });
  return { ...publicUser(user), permissions: user.permissions.map((p) => p.section) };
}
