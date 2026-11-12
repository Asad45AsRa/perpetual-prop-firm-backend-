import { createHash, randomBytes } from 'crypto';

// Random token, returned raw (sent to the user) and hashed (stored in DB).
export function generateToken(bytes = 32) {
  const raw = randomBytes(bytes).toString('hex');
  return { raw, hash: sha256(raw) };
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function generateReferralCode(): string {
  return randomBytes(4).toString('hex').toUpperCase();
}
