import 'fastify';
import type { AuthUser } from './auth';
import type { EffectiveAccess } from '../modules/rbac/rbac.resolve';

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
    /** Resolved RBAC access, cached for the request by getAccess(). */
    access?: EffectiveAccess;
  }
}
