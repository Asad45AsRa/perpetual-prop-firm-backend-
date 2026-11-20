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

  // Session cookies. Frontend and API on different sites (e.g. vercel.app + onrender.com) need
  // COOKIE_SAMESITE=none and COOKIE_SECURE=true. Same site (or localhost) works with lax.
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),
  COOKIE_DOMAIN: z.string().optional(),

  // Google sign-in (Google Identity Services client id). Empty = Google sign-in disabled.
  GOOGLE_CLIENT_ID: z.string().optional().default(''),

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
  // Trading is blocked when the order book (or the mark price) is older than this.
  // STALE_PRICE_MS is the base value. STALE_BOOK_MS / STALE_MARK_MS override it per data type.
  STALE_PRICE_MS: z.coerce.number().int().min(500).default(5000),
  STALE_BOOK_MS: z.coerce.number().int().min(500).optional(),
  STALE_MARK_MS: z.coerce.number().int().min(500).optional(),
  // Timeout for every Hyperliquid REST call
  HYPERLIQUID_TIMEOUT_MS: z.coerce.number().int().min(1000).default(8000),
  // Watchdog: reconnect when the Hyperliquid socket is silent for this long
  HYPERLIQUID_WS_SILENCE_MS: z.coerce.number().int().min(5000).default(20000),
  // Live prices pushed to browsers are coalesced per symbol to this interval
  WS_PUSH_INTERVAL_MS: z.coerce.number().int().min(50).default(250),
  // How often resting limit / stop / TP / SL orders are checked against the live book
  ORDER_MATCHER_INTERVAL_MS: z.coerce.number().int().min(100).default(500),

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

// Freshness limits (milliseconds). The mark price moves more slowly than the book on quiet
// markets, so by default it is allowed to be a little older than the book.
export const staleBookMs = env.STALE_BOOK_MS ?? env.STALE_PRICE_MS;
export const staleMarkMs = env.STALE_MARK_MS ?? Math.max(env.STALE_PRICE_MS, 10_000);


///Test