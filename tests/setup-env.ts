// Minimal environment so modules that read src/config/env.ts can be imported in unit tests.
// Real values are only needed by the running server.
process.env.APP_ENV = process.env.APP_ENV ?? 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/test';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? 'test-access-secret-test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ?? 'test-refresh-secret-test-refresh-secret';
process.env.MFA_ENCRYPTION_KEY = process.env.MFA_ENCRYPTION_KEY ?? '0'.repeat(64);
process.env.FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:3000';
process.env.PUBLIC_API_URL = process.env.PUBLIC_API_URL ?? 'http://localhost:4000';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'fatal';
process.env.STALE_PRICE_MS = process.env.STALE_PRICE_MS ?? '5000';
process.env.STALE_MARK_MS = process.env.STALE_MARK_MS ?? '10000';
