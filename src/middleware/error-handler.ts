import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { ApiError } from '../utils/api-error';

// One error shape for every endpoint, the one the frontend client reads (src/lib/api.ts):
// { code, message, requestId, details? }  + an "x-request-id" header.
// Quote the requestId to find the matching server log line.
function send(reply: FastifyReply, req: FastifyRequest, status: number, code: string, message: string, details?: unknown) {
  return reply.status(status).send({ code, message, requestId: req.id, ...(details !== undefined ? { details } : {}) });
}

export function errorHandler(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof ApiError) return send(reply, req, err.statusCode, err.code, err.message, err.details);

  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    return send(reply, req, 409, 'CONFLICT', 'Record already exists');
  }

  const statusCode = (err as FastifyError).statusCode;
  if (statusCode && statusCode < 500) {
    // Fastify built-in errors (rate limit, invalid JSON, payload too large)
    const code = statusCode === 429 ? 'RATE_LIMITED' : ((err as FastifyError).code ?? 'REQUEST_ERROR');
    return send(reply, req, statusCode, code, err.message);
  }

  req.log.error({ err }, 'Unhandled error');
  return send(reply, req, 500, 'INTERNAL', 'Internal server error');
}
