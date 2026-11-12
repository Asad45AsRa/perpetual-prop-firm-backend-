import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../middleware/auth';
import { parse } from '../../utils/validate';
import * as service from './auth.service';
import {
  forgotPasswordSchema,
  loginSchema,
  mfaEnableSchema,
  mfaVerifySchema,
  refreshSchema,
  resetPasswordSchema,
  signupSchema,
  verifyEmailSchema,
} from './auth.schemas';

// Strict limit for endpoints attackers like to brute force
const strictLimit = { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } };

export async function authRoutes(app: FastifyInstance) {
  app.post('/signup', strictLimit, async (req, reply) => {
    const body = parse(signupSchema, req.body);
    return reply.status(201).send(await service.signup(body));
  });

  app.post('/verify-email', async (req) => {
    await service.verifyEmail(parse(verifyEmailSchema, req.body).token);
    return { ok: true };
  });

  app.post('/login', strictLimit, async (req) => service.login(parse(loginSchema, req.body), req.ip));

  app.post('/mfa/verify', strictLimit, async (req) =>
    service.verifyMfaLogin(parse(mfaVerifySchema, req.body), req.ip),
  );

  app.post('/refresh', async (req) => service.refresh(parse(refreshSchema, req.body).refreshToken));

  app.post('/logout', async (req) => {
    await service.logout(parse(refreshSchema, req.body).refreshToken);
    return { ok: true };
  });

  app.post('/forgot-password', strictLimit, async (req) => {
    await service.forgotPassword(parse(forgotPasswordSchema, req.body).email);
    return { ok: true };
  });

  app.post('/reset-password', strictLimit, async (req) => {
    const body = parse(resetPasswordSchema, req.body);
    await service.resetPassword(body.token, body.password);
    return { ok: true };
  });

  // ----- Logged in endpoints -----
  app.get('/me', { preHandler: authenticate }, async (req) => service.getMe(req.user!.id));

  app.post('/mfa/setup', { preHandler: authenticate }, async (req) => service.setupMfa(req.user!.id));

  app.post('/mfa/enable', { preHandler: authenticate }, async (req) =>
    service.enableMfa(req.user!.id, parse(mfaEnableSchema, req.body).code),
  );
}
