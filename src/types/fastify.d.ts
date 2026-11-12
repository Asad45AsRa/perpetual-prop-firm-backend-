import 'fastify';
import type { AuthUser } from './auth';

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}
