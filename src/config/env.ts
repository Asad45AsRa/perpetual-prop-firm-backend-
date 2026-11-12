import dotenv from 'dotenv';
import { z } from 'zod';

// Load ".env.<APP_ENV>" first (staging / production), then the plain ".env".
// dotenv never overrides values that are already set, so the first file wins.
const appEnv = process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development';
dotenv.config({ path: `.env.${appEnv}` });
dotenv.config();

const boolFromString = z
  .enum(['true', 'false'])
  .default('true')
  .transform((v) => v === 'true');

const schema = z.object({
  APP_ENV: z.enum(['development', 'staging', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().min(1),

  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().default(30),
  MFA_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex characters'),
  MFA_ISSUER: z.string().default('PerpetualPropFirm'),

  FRONTEND_URL: z.string().url(),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),

  RESEND_API_KEY: z.string().optional().default(''),
  EMAIL_FROM: z.string().default('Perpetual Prop <no-reply@example.com>'),

  PLISIO_API_KEY: z.string().optional().default(''),
  PLISIO_BASE_URL: z.string().url().default('https://plisio.net/api/v1'),
  PUBLIC_API_URL: z.string().url(),

  HYPERLIQUID_REST_URL: z.string().url().default('https://api.hyperliquid.xyz'),
  HYPERLIQUID_WS_URL: z.string().default('wss://api.hyperliquid.xyz/ws'),
  LAUNCH_SYMBOLS: z.string().default('BTC,ETH'),
  STALE_PRICE_MS: z.coerce.number().int().default(5000),

  ENABLE_JOBS: boolFromString,
  DAILY_RESET_UTC_HOUR: z.coerce.number().int().min(0).max(23).default(0),

  SUPER_ADMIN_EMAIL: z.string().email().optional(),
  SUPER_ADMIN_PASSWORD: z.string().min(12).optional(),
});

const parsed = schema.safeParse({ ...process.env, APP_ENV: appEnv });

if (!parsed.success) {
  // Fail fast: a misconfigured server must not start.
  console.error('Invalid environment configuration:');
  console.error(JSON.stringify(parsed.error.flatten().fieldErrors, null, 2));
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.APP_ENV === 'production';
export const launchSymbols = env.LAUNCH_SYMBOLS.split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
export const corsOrigins = env.CORS_ORIGINS.split(',').map((s) => s.trim());
