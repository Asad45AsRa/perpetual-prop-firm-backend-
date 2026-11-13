import type { FastifyReply, FastifyRequest } from 'fastify';
import type { User } from '@prisma/client';
import { env, isProd } from '../../config/env';
import { prisma } from '../../config/prisma';
import { generateToken, sha256 } from '../../utils/crypto';
import { signAccessToken } from '../../utils/tokens';

// =====================================================================
// Cookie sessions. The frontend never sees a token: the backend sets two
// httpOnly cookies per app and refreshes them silently.
//   customer app (trader + affiliate):  pp_at / pp_rt
//   admin panel:                        pp_admin_at / pp_admin_rt
// Separate names so one browser can be signed in to both without clashes.
// =====================================================================

export type App = 'customer' | 'admin';

const NAMES: Record<App, { access: string; refresh: string }> = {
  customer: { access: 'pp_at', refresh: 'pp_rt' },
  admin: { access: 'pp_admin_at', refresh: 'pp_admin_rt' },
};

const DAY_MS = 24 * 60 * 60 * 1000;
const secure = env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProd || env.COOKIE_SAMESITE === 'none';

function baseCookie() {
  return {
    httpOnly: true,
    secure,
    sameSite: env.COOKIE_SAMESITE,
    domain: env.COOKIE_DOMAIN || undefined,
    path: '/',
  } as const;
}

/** Which app a request belongs to (admin API paths use the admin cookies). */
export const appOf = (req: FastifyRequest): App => (req.url.startsWith('/api/v1/admin') ? 'admin' : 'customer');

export const readAccessCookie = (req: FastifyRequest, app: App) => req.cookies?.[NAMES[app].access];
export const readRefreshCookie = (req: FastifyRequest, app: App) => req.cookies?.[NAMES[app].refresh];
export const hasSessionCookie = (req: FastifyRequest) =>
  Object.values(NAMES).some((n) => req.cookies?.[n.access] || req.cookies?.[n.refresh]);

/** Creates a session (refresh token row + both cookies). */
export async function startSession(req: FastifyRequest, reply: FastifyReply, user: User, app: App, mfaVerified: boolean) {
  const refresh = generateToken(48);
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * DAY_MS);
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: refresh.hash,
      mfaVerified,
      expiresAt,
      userAgent: (req.headers['user-agent'] ?? '').slice(0, 300) || null,
      ip: req.ip,
    },
  });
  setCookies(reply, app, signAccessToken({ sub: user.id, role: user.role, mfa: mfaVerified }), refresh.raw, expiresAt);
}

function setCookies(reply: FastifyReply, app: App, access: string, refresh: string, refreshExpires: Date) {
  reply.setCookie(NAMES[app].access, access, { ...baseCookie(), maxAge: 60 * 60 * 24 }); // JWT expiry is the real limit
  reply.setCookie(NAMES[app].refresh, refresh, { ...baseCookie(), expires: refreshExpires });
}

export function clearCookies(reply: FastifyReply, app: App) {
  reply.clearCookie(NAMES[app].access, baseCookie());
  reply.clearCookie(NAMES[app].refresh, baseCookie());
}

/**
 * Silent refresh: when the access cookie is missing/expired but the refresh cookie is valid,
 * rotate the refresh token and set new cookies. Returns the user id, or null.
 */
export async function refreshFromCookie(req: FastifyRequest, reply: FastifyReply, app: App) {
  const raw = readRefreshCookie(req, app);
  if (!raw) return null;
  const record = await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(raw) }, include: { user: true } });
  const now = new Date();
  if (!record || record.revokedAt || record.expiresAt < now || !record.user.isActive || record.user.deletedAt) {
    clearCookies(reply, app);
    return null;
  }
  // A staff refresh cookie must never sign into the customer app and vice versa.
  if ((app === 'admin') !== (record.user.role !== 'USER')) {
    clearCookies(reply, app);
    return null;
  }
  if (record.user.tokensValidAfter && record.createdAt < record.user.tokensValidAfter) {
    clearCookies(reply, app);
    return null;
  }

  const next = generateToken(48);
  await prisma.$transaction([
    prisma.refreshToken.update({ where: { id: record.id }, data: { revokedAt: now } }),
    prisma.refreshToken.create({
      data: {
        userId: record.userId,
        tokenHash: next.hash,
        mfaVerified: record.mfaVerified,
        expiresAt: record.expiresAt, // rotation keeps the original session lifetime
        userAgent: record.userAgent,
        ip: req.ip,
        lastUsedAt: now,
      },
    }),
  ]);
  setCookies(
    reply,
    app,
    signAccessToken({ sub: record.user.id, role: record.user.role, mfa: record.mfaVerified }),
    next.raw,
    record.expiresAt,
  );
  return { userId: record.userId, mfaVerified: record.mfaVerified, sessionHash: next.hash };
}

/** Revokes the current session (logout). */
export async function endSession(req: FastifyRequest, reply: FastifyReply, app: App) {
  const raw = readRefreshCookie(req, app);
  if (raw) {
    await prisma.refreshToken.updateMany({ where: { tokenHash: sha256(raw), revokedAt: null }, data: { revokedAt: new Date() } });
  }
  clearCookies(reply, app);
}

/** Hash of this request's refresh cookie, to mark "current device" in the sessions list. */
export const currentSessionHash = (req: FastifyRequest, app: App) => {
  const raw = readRefreshCookie(req, app);
  return raw ? sha256(raw) : null;
};

/** Short device label from a user agent, e.g. "Windows · Chrome". */
export function deviceLabel(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const os = /Windows/.test(ua) ? 'Windows' : /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Other';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${os} · ${browser}`;
}

/** Signs a user out everywhere and invalidates every access token already issued. */
export async function revokeAllSessions(userId: string) {
  const now = new Date();
  await prisma.$transaction([
    prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } }),
    prisma.user.update({ where: { id: userId }, data: { tokensValidAfter: now } }),
  ]);
}
