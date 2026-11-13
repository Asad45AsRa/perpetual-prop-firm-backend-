import type { FastifyInstance } from 'fastify';
import { requireCustomer } from '../../middleware/auth';
import { parse } from '../../utils/validate';
import * as service from './auth.service';
import { endSession } from './session';
import {
  emailResendSchema,
  emailStartSchema,
  emailVerifySchema,
  googleSchema,
  profileSchema,
  sessionParams,
  usernameQuerySchema,
} from './auth.schemas';

// Strict limit for endpoints attackers like to brute force
const strictLimit = { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } };
const verifyLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

// /api/v1/auth: customer (trader + affiliate) sign-in. Session = httpOnly cookies.
export async function authRoutes(app: FastifyInstance) {
  // ----- Passwordless sign-in / sign-up -----
  app.post('/email/start', strictLimit, async (req) => service.startEmailSignIn(parse(emailStartSchema, req.body)));
  app.post('/email/resend', strictLimit, async (req) => service.resendEmailCode(parse(emailResendSchema, req.body).email));
  app.post('/email/verify', verifyLimit, async (req, reply) => {
    const body = parse(emailVerifySchema, req.body);
    return service.verifyEmailCode(req, reply, body.email, body.code);
  });
  app.post('/google', strictLimit, async (req, reply) => service.signInWithGoogle(req, reply, parse(googleSchema, req.body)));

  app.get('/username-available', async (req) => service.isUsernameAvailable(parse(usernameQuerySchema, req.query).username));

  // ----- Signed in -----
  app.get('/me', { preHandler: requireCustomer }, async (req) => service.getMe(req.user!.id));
  app.patch('/profile', { preHandler: requireCustomer }, async (req) => service.updateProfile(req.user!.id, parse(profileSchema, req.body)));

  app.post('/logout', async (req, reply) => {
    await endSession(req, reply, 'customer');
    return { ok: true };
  });
  app.post('/logout-all', { preHandler: requireCustomer }, async (req, reply) => service.logoutEverywhere(req, reply, req.user!.id));

  // Active devices (Settings / My Profile)
  app.get('/sessions', { preHandler: requireCustomer }, async (req) => service.listSessions(req, req.user!.id));
  app.delete('/sessions/:id', { preHandler: requireCustomer }, async (req, reply) =>
    service.revokeSession(req, reply, req.user!.id, parse(sessionParams, req.params).id),
  );
}
