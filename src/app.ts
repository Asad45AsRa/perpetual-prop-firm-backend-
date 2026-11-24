import { randomUUID } from 'node:crypto';
import path from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { corsOrigins, isProd } from './config/env';
import { logger } from './config/logger';
import { errorHandler } from './middleware/error-handler';
import { ApiError } from './utils/api-error';
import { adminAuthRoutes } from './modules/admin/admin.auth.routes';
import { adminRoutes } from './modules/admin/admin.routes';
import { affiliateRoutes } from './modules/affiliates/affiliates.routes';
import { authRoutes } from './modules/auth/auth.routes';
import { hasSessionCookie } from './modules/auth/session';
import { contentRoutes } from './modules/content/content.routes';
import { healthRoutes } from './modules/health/health.routes';
import { marketRoutes } from './modules/markets/market.routes';
import { marketWebSocket } from './modules/markets/market.ws';
import { terminalRoutes } from './modules/markets/terminal.routes';
import { accountWebSocket } from './modules/trading/account.ws';
import { paymentRoutes } from './modules/payments/payments.routes';
import { payoutRoutes } from './modules/payouts/payouts.routes';
import { planRoutes } from './modules/plans/plans.routes';
import { rbacRoutes } from './modules/rbac/rbac.routes';
import { tradingRoutes } from './modules/trading/trading.routes';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Builds the Fastify app without starting it (also useful for tests).
export async function buildApp() {
  const app = Fastify({
    loggerInstance: logger,
    trustProxy: true, // correct client IPs behind Render / Vercel proxies
    bodyLimit: 1_048_576,
    // Every response carries this id (body "requestId" on errors + "x-request-id" header).
    genReqId: (req) => (typeof req.headers['x-request-id'] === 'string' && req.headers['x-request-id'].length <= 64 ? req.headers['x-request-id'] : randomUUID()),
  });

  // The frontend client always sends "Content-Type: application/json", also on POSTs without a body
  // (join affiliate, staff actions, logout). Treat an empty JSON body as {} instead of a 400.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString();
    if (text.trim() === '') return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch {
      const err = new ApiError(400, 'INVALID_JSON', 'Request body is not valid JSON');
      done(err, undefined);
    }
  });

  await app.register(helmet);
  await app.register(cookie);
  await app.register(cors, {
    origin: corsOrigins,
    credentials: true, // session cookies
    allowedHeaders: ['Content-Type', 'Idempotency-Key', 'X-Request-Id'],
    exposedHeaders: ['x-request-id'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  await app.register(rateLimit, { global: true, max: 120, timeWindow: '1 minute' });
  await app.register(websocket);

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);

    // CSRF protection for cookie sessions: a write that carries our cookies must come from an allowed
    // origin and be JSON (a cross-site HTML form cannot send application/json without CORS approval).
    if (!SAFE_METHODS.has(req.method) && hasSessionCookie(req)) {
      const origin = req.headers.origin;
      if (origin && !corsOrigins.includes(origin)) throw ApiError.forbidden('Request origin is not allowed');
      const type = req.headers['content-type'] ?? '';
      if (!type.startsWith('application/json')) throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send requests as application/json');
    }
  });

  // API docs (Auth & RBAC) at /docs, from docs/openapi-rbac.yaml. Not exposed in production.
  if (!isProd) {
    await app.register(swagger, {
      mode: 'static',
      specification: { path: path.join(process.cwd(), 'docs', 'openapi-rbac.yaml'), baseDir: path.join(process.cwd(), 'docs') },
    });
    await app.register(swaggerUi, { routePrefix: '/docs' });
  }

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(() => {
    throw ApiError.notFound('Route not found');
  });

  await app.register(healthRoutes);
  await app.register(marketWebSocket);
  // Real-time account stream for the terminal (balance, equity, margin, positions, orders, fills)
  await app.register(accountWebSocket);

  const api = { prefix: '/api/v1' };
  await app.register(async (v1) => {
    await v1.register(authRoutes, { prefix: '/auth' });
    await v1.register(rbacRoutes, { prefix: '/rbac' });
    await v1.register(planRoutes, { prefix: '/plans' });
    await v1.register(marketRoutes, { prefix: '/markets' });
    // Trading terminal market data: bootstrap, markets table, book, trades, candles
    await v1.register(terminalRoutes, { prefix: '/terminal' });
    await v1.register(tradingRoutes, { prefix: '/trading' });
    await v1.register(paymentRoutes, { prefix: '/payments' });
    await v1.register(payoutRoutes, { prefix: '/payouts' });
    await v1.register(affiliateRoutes, { prefix: '/affiliates' });
    await v1.register(contentRoutes, { prefix: '/content' });
    // Admin sign-in is outside the signed-in admin routes.
    await v1.register(adminAuthRoutes, { prefix: '/admin/auth' });
    await v1.register(adminRoutes, { prefix: '/admin' });
  }, api);

  return app;
}
///