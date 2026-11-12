import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { env } from '../config/env';

// AES-256-GCM encryption for secrets stored in the database (MFA secrets).
const key = Buffer.from(env.MFA_ENCRYPTION_KEY, 'hex');

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((b) => b.toString('hex')).join(':');
}

export function decrypt(payload: string): string {
  const [ivHex, tagHex, dataHex] = payload.split(':');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}
