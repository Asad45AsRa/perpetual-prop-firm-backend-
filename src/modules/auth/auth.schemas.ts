import { z } from 'zod';

const password = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(128)
  .regex(/[a-z]/, 'Password needs a lowercase letter')
  .regex(/[A-Z]/, 'Password needs an uppercase letter')
  .regex(/[0-9]/, 'Password needs a number');

export const signupSchema = z.object({
  email: z.string().email().max(254),
  password,
  referralCode: z.string().max(32).optional(),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const verifyEmailSchema = z.object({ token: z.string().min(10) });
export const forgotPasswordSchema = z.object({ email: z.string().email() });
export const resetPasswordSchema = z.object({ token: z.string().min(10), password });
export const refreshSchema = z.object({ refreshToken: z.string().min(10) });
export const mfaVerifySchema = z.object({ mfaToken: z.string().min(10), code: z.string().length(6) });
export const mfaEnableSchema = z.object({ code: z.string().length(6) });
