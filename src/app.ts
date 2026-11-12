import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { corsOrigins } from './config/env';
import { logger } from './config/logger';
import { errorHandler } from './middleware/error-handler';
import { ApiError } from './utils/api-error';
import { adminRoutes } from './modules/admin/admin.routes';
import { affiliateRoutes } from './modules/affiliates/affiliates.routes';
import { authRoutes } from './modules/auth/auth.routes';
import { contentRoutes } from './modules/content/content.routes';
import { healthRoutes } from './modules/health/health.routes';
import { marketRoutes } from './modules/markets/market.routes';
import { marketWebSocket } from './modules/markets/market.ws';
import { paymentRoutes } from './modules/payments/payments.routes';
import { payoutRoutes } from './modules/payouts/payouts.routes';
import { planRoutes } from './modules/plans/plans.routes';
import { tradingRoutes } from './modules/trading/trading.routes';

// Builds the Fastify app without starting it (also useful for tests).
export async function buildApp() {
  const app = Fastify({
    loggerInstance: logger,
    trustProxy: true, // correct client IPs behind Render / Vercel proxies
    bodyLimit: 1_048_576,
  });

  await app.register(helmet);
  await app.register(cors, { origin: corsOrigins, credentials: true });
  await app.register(rateLimit, { global: true, max: 120, timeWindow: '1 minute' });
  await app.register(websocket);

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(() => {
    throw ApiError.notFound('Route not found');
  });

  await app.register(healthRoutes);
  await app.register(marketWebSocket);

  const api = { prefix: '/api/v1' };
  await app.register(async (v1) => {
    await v1.register(authRoutes, { prefix: '/auth' });
    await v1.register(planRoutes, { prefix: '/plans' });
    await v1.register(marketRoutes, { prefix: '/markets' });
    await v1.register(tradingRoutes, { prefix: '/trading' });
    await v1.register(paymentRoutes, { prefix: '/payments' });
    await v1.register(payoutRoutes, { prefix: '/payouts' });
    await v1.register(affiliateRoutes, { prefix: '/affiliates' });
    await v1.register(contentRoutes, { prefix: '/content' });
    await v1.register(adminRoutes, { prefix: '/admin' });
  }, api);

  return app;
}
