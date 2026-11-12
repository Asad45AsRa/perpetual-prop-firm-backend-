import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { ApiError } from '../utils/api-error';

// One consistent error shape for every endpoint:
// { error: { code, message, details? } }
export function errorHandler(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof ApiError) {
    return reply.status(err.statusCode).send({
      error: { code: err.code, message: err.message, details: err.details },
    });
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    return reply.status(409).send({ error: { code: 'CONFLICT', message: 'Record already exists' } });
  }

  const statusCode = (err as FastifyError).statusCode;
  if (statusCode && statusCode < 500) {
    // Fastify built-in errors (rate limit, invalid JSON, payload too large)
    return reply.status(statusCode).send({
      error: { code: (err as FastifyError).code ?? 'REQUEST_ERROR', message: err.message },
    });
  }

  req.log.error({ err }, 'Unhandled error');
  return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Internal server error' } });
}
