import pino from 'pino';
import { env } from './env';

// One shared pino logger. Fastify uses the same instance for request logs.
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: ['req.headers.authorization', '*.password', '*.passwordHash', '*.token'],
  transport:
    env.APP_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } }
      : undefined,
});
