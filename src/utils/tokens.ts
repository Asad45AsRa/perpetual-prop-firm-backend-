import jwt from 'jsonwebtoken';
import type { Role } from '@prisma/client';
import { env } from '../config/env';
import { ApiError } from './api-error';

export interface AccessPayload {
  sub: string;
  role: Role;
  // true when the session passed MFA (required for staff)
  mfa: boolean;
}

export function signAccessToken(payload: AccessPayload): string {
  return jwt.sign({ ...payload, typ: 'access' }, env.JWT_ACCESS_SECRET, {
    expiresIn: env.ACCESS_TOKEN_TTL as jwt.SignOptions['expiresIn'],
  });
}

export function verifyAccessToken(token: string): AccessPayload {
  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET) as jwt.JwtPayload;
    if (decoded.typ !== 'access') throw new Error('wrong token type');
    return { sub: decoded.sub as string, role: decoded.role, mfa: Boolean(decoded.mfa) };
  } catch {
    throw ApiError.unauthorized('Invalid or expired token');
  }
}

// Short lived token handed out after a correct password for staff accounts.
// It can only be exchanged for a session together with a valid MFA code.
export function signMfaChallengeToken(userId: string): string {
  return jwt.sign({ typ: 'mfa-challenge' }, env.JWT_ACCESS_SECRET, {
    subject: userId,
    expiresIn: '5m',
  });
}

export function verifyMfaChallengeToken(token: string): string {
  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET) as jwt.JwtPayload;
    if (decoded.typ !== 'mfa-challenge') throw new Error('wrong token type');
    return decoded.sub as string;
  } catch {
    throw ApiError.unauthorized('MFA challenge expired, please log in again');
  }
}
