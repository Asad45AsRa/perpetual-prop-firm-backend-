import { createHmac, randomInt, timingSafeEqual } from 'crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Portal, Prisma, User } from '@prisma/client';
import { env } from '../../config/env';
import { prisma } from '../../config/prisma';
import { ApiError } from '../../utils/api-error';
import { generateReferralCode } from '../../utils/crypto';
import { emailTemplates, sendEmail } from '../../services/email.service';
import { audit } from '../audit/audit.service';
import { loadAccess } from '../rbac/rbac.service';
import { currentSessionHash, deviceLabel, endSession, revokeAllSessions, startSession } from './session';

// =====================================================================
// Customer authentication (trader + affiliate). Passwordless:
//   1. POST /auth/email/start   -> 6-digit code by email
//   2. POST /auth/email/verify  -> signs in (creates the account on first use)
//   3. PATCH /auth/profile      -> username + avatar (onboarding steps 3 and 4)
// or POST /auth/google. Staff use /admin/auth (password + 2FA).
// =====================================================================

const CODE_TTL_MS = 10 * 60 * 1000;
export const RESEND_COOLDOWN_S = 60;
const MAX_ATTEMPTS = 5;

type SignupMeta = { portal: Portal; referralCode?: string; platform?: string; handle?: string };

const hashCode = (email: string, code: string) => createHmac('sha256', env.JWT_REFRESH_SECRET).update(`${email}:${code}`).digest('hex');

export function publicUser(u: User) {
  return {
    id: u.id,
    email: u.email,
    username: u.username,
    avatar: u.avatar,
    leaderboardPublic: u.leaderboardPublic,
    portals: u.portals,
    referralCode: u.referralCode,
    signupPlatform: u.signupPlatform,
    signupHandle: u.signupHandle,
    createdAt: u.createdAt,
  };
}

const needsProfile = (u: User) => !u.username || !u.avatar;

// ------------------------------ Email code ------------------------------

async function issueCode(emailAddr: string, meta: SignupMeta) {
  const last = await prisma.loginCode.findFirst({ where: { email: emailAddr }, orderBy: { createdAt: 'desc' } });
  if (last && Date.now() - last.createdAt.getTime() < RESEND_COOLDOWN_S * 1000) {
    const wait = Math.ceil(RESEND_COOLDOWN_S - (Date.now() - last.createdAt.getTime()) / 1000);
    throw new ApiError(429, 'RESEND_COOLDOWN', `Please wait ${wait}s before requesting a new code`, { retryInSeconds: wait });
  }

  const existing = await prisma.user.findUnique({ where: { email: emailAddr } });
  // Staff, suspended and deleted accounts never get a customer code. Same response, so emails are not revealed.
  const allowed = !existing || (existing.role === 'USER' && existing.isActive && !existing.deletedAt);

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await prisma.loginCode.create({
    data: { email: emailAddr, codeHash: hashCode(emailAddr, code), meta: meta as unknown as Prisma.InputJsonValue, expiresAt: new Date(Date.now() + CODE_TTL_MS) },
  });
  if (allowed) await sendEmail({ to: emailAddr, ...emailTemplates.loginCode(code) });
  return { ok: true, resendInSeconds: RESEND_COOLDOWN_S, expiresInSeconds: CODE_TTL_MS / 1000 };
}

export const startEmailSignIn = (input: { email: string } & SignupMeta) =>
  issueCode(input.email, { portal: input.portal, referralCode: input.referralCode, platform: input.platform, handle: input.handle });

export async function resendEmailCode(emailAddr: string) {
  // Keeps what the first form sent (portal, referral, platform, handle).
  const last = await prisma.loginCode.findFirst({ where: { email: emailAddr }, orderBy: { createdAt: 'desc' } });
  if (!last) throw ApiError.badRequest('Start again with your email');
  return issueCode(emailAddr, (last.meta as unknown as SignupMeta) ?? { portal: 'TRADER' });
}

export async function verifyEmailCode(req: FastifyRequest, reply: FastifyReply, emailAddr: string, code: string) {
  const record = await prisma.loginCode.findFirst({
    where: { email: emailAddr, usedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  if (!record) throw ApiError.badRequest('This code has expired. Request a new one.');
  if (record.attempts >= MAX_ATTEMPTS) throw new ApiError(429, 'TOO_MANY_ATTEMPTS', 'Too many wrong codes. Request a new one.');

  const expected = Buffer.from(record.codeHash, 'hex');
  const given = Buffer.from(hashCode(emailAddr, code), 'hex');
  if (!timingSafeEqual(expected, given)) {
    await prisma.loginCode.update({ where: { id: record.id }, data: { attempts: { increment: 1 } } });
    throw new ApiError(400, 'BAD_CODE', 'That code is not correct.');
  }
  await prisma.loginCode.updateMany({ where: { email: emailAddr, usedAt: null }, data: { usedAt: new Date() } });

  const { user, isNewUser } = await signInOrCreate(emailAddr, record.meta as unknown as SignupMeta, {});
  await startSession(req, reply, user, 'customer', false);
  await audit({ actorId: user.id, action: isNewUser ? 'auth.signup.email' : 'auth.login.email', ip: req.ip });
  return { user: publicUser(user), isNewUser, needsProfile: needsProfile(user) };
}

// ------------------------------ Google ------------------------------

export async function signInWithGoogle(req: FastifyRequest, reply: FastifyReply, input: { credential: string } & SignupMeta) {
  if (!env.GOOGLE_CLIENT_ID) throw new ApiError(503, 'GOOGLE_DISABLED', 'Google sign-in is not configured yet');

  // Google verifies the signature and expiry; we check it was issued for our app and the email is verified.
  const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(input.credential)}`);
  const info = (await res.json().catch(() => ({}))) as { aud?: string; sub?: string; email?: string; email_verified?: string | boolean };
  if (!res.ok || info.aud !== env.GOOGLE_CLIENT_ID || !info.sub || !info.email || String(info.email_verified) !== 'true') {
    throw ApiError.unauthorized('Google sign-in failed. Try again.');
  }

  const emailAddr = info.email.toLowerCase();
  const { user, isNewUser } = await signInOrCreate(emailAddr, input, { googleSub: info.sub });
  await startSession(req, reply, user, 'customer', false);
  await audit({ actorId: user.id, action: isNewUser ? 'auth.signup.google' : 'auth.login.google', ip: req.ip });
  return { user: publicUser(user), isNewUser, needsProfile: needsProfile(user) };
}

// ------------------------------ Shared ------------------------------

async function signInOrCreate(emailAddr: string, meta: SignupMeta, extra: { googleSub?: string }) {
  const existing = await prisma.user.findUnique({ where: { email: emailAddr } });
  if (existing) {
    if (existing.role !== 'USER') throw ApiError.forbidden('Staff accounts sign in on the admin console');
    if (!existing.isActive || existing.deletedAt) throw ApiError.forbidden('This account is suspended. Contact support.');
    if (extra.googleSub && existing.googleSub && existing.googleSub !== extra.googleSub) {
      throw ApiError.forbidden('This email is linked to a different Google account');
    }

    // Signing in through a flow joins that dashboard (e.g. a trader using /affiliates/join),
    // unless an admin has set this customer's portals by hand.
    const addPortal = !existing.portalsManagedByAdmin && !existing.portals.includes(meta.portal);
    const user = await prisma.user.update({
      where: { id: existing.id },
      data: {
        lastLoginAt: new Date(),
        emailVerified: true,
        emailVerifiedAt: existing.emailVerifiedAt ?? new Date(),
        ...(extra.googleSub && !existing.googleSub ? { googleSub: extra.googleSub } : {}),
        ...(addPortal ? { portals: { push: meta.portal } } : {}),
        ...(meta.portal === 'AFFILIATE' && meta.platform && !existing.signupPlatform ? { signupPlatform: meta.platform, signupHandle: meta.handle?.replace(/^@/, '') } : {}),
      },
    });
    return { user, isNewUser: false };
  }

  const referrer = meta.referralCode
    ? await prisma.user.findUnique({ where: { referralCode: meta.referralCode.toUpperCase() } })
    : null;
  const user = await prisma.user.create({
    data: {
      email: emailAddr,
      role: 'USER',
      portals: [meta.portal],
      emailVerified: true,
      emailVerifiedAt: new Date(),
      referralCode: generateReferralCode(),
      referredById: referrer?.role === 'USER' ? referrer.id : undefined,
      signupPlatform: meta.portal === 'AFFILIATE' ? meta.platform : undefined,
      signupHandle: meta.portal === 'AFFILIATE' ? meta.handle?.replace(/^@/, '') : undefined,
      googleSub: extra.googleSub,
      lastLoginAt: new Date(),
    },
  });
  return { user, isNewUser: true };
}

export async function getMe(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  return { user: publicUser(user), needsProfile: needsProfile(user), access: await loadAccess(userId) };
}

export async function updateProfile(userId: string, input: { username?: string; avatar?: string; leaderboardPublic?: boolean }) {
  if (input.username) {
    const taken = await prisma.user.findFirst({ where: { username: { equals: input.username, mode: 'insensitive' }, id: { not: userId } } });
    if (taken) throw ApiError.conflict('That username is taken');
  }
  const user = await prisma.user.update({ where: { id: userId }, data: input });
  await audit({ actorId: userId, action: 'profile.updated', metadata: input });
  return { user: publicUser(user), needsProfile: needsProfile(user) };
}

export async function isUsernameAvailable(username: string) {
  const taken = await prisma.user.findFirst({ where: { username: { equals: username, mode: 'insensitive' } } });
  return { username, available: !taken };
}

// ------------------------------ Sessions (Active devices) ------------------------------

export async function listSessions(req: FastifyRequest, userId: string) {
  const current = currentSessionHash(req, 'customer');
  const rows = await prisma.refreshToken.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastUsedAt: 'desc' },
  });
  return rows.map((r) => ({
    id: r.id,
    device: deviceLabel(r.userAgent),
    ip: r.ip,
    lastActiveAt: r.lastUsedAt,
    createdAt: r.createdAt,
    current: r.tokenHash === current,
  }));
}

export async function revokeSession(req: FastifyRequest, reply: FastifyReply, userId: string, sessionId: string) {
  const row = await prisma.refreshToken.findFirst({ where: { id: sessionId, userId } });
  if (!row) throw ApiError.notFound('Session not found');
  await prisma.refreshToken.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
  if (row.tokenHash === currentSessionHash(req, 'customer')) await endSession(req, reply, 'customer');
  return { ok: true };
}

export async function logoutEverywhere(req: FastifyRequest, reply: FastifyReply, userId: string) {
  await revokeAllSessions(userId);
  await endSession(req, reply, 'customer');
  await audit({ actorId: userId, action: 'auth.logout_all', ip: req.ip });
  return { ok: true };
}
