import { z } from 'zod';
import { ApiError } from './api-error';

// Parse and validate untrusted input (body, query, params) with a zod schema.
export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw ApiError.badRequest('Validation failed', result.error.flatten());
  }
  return result.data;
}
