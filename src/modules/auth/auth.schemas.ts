import { z } from 'zod';

// Same rules as the frontend forms (src/components/auth/schemas.ts, affiliate-join/schemas.ts).
export const PLATFORMS = ['Instagram', 'Meta', 'TikTok'] as const;

const email = z.string().trim().toLowerCase().email('Enter a valid email').max(254);
const code = z.string().regex(/^\d{6}$/, 'Enter the 6-digit code');
const portal = z.enum(['TRADER', 'AFFILIATE']).default('TRADER');
// Optional; "" from the form means "no code".
const referralCode = z
  .string()
  .trim()
  .max(32, 'Code is too long')
  .regex(/^[A-Za-z0-9_-]*$/, 'Only letters, numbers, - and _')
  .optional()
  .transform((v) => (v ? v : undefined));
const platform = z.enum(PLATFORMS).optional();
const handle = z
  .string()
  .trim()
  .max(30, 'Username is too long')
  .regex(/^@?[A-Za-z0-9._]+$/, 'Only letters, numbers, dots and underscores')
  .optional();

export const username = z
  .string()
  .trim()
  .min(3, 'At least 3 characters')
  .max(20, 'At most 20 characters')
  .regex(/^[A-Za-z0-9_]+$/, 'Only letters, numbers and underscores');

// Step 1 of /signup (portal TRADER) or /affiliates/join (portal AFFILIATE, with platform + handle).
export const emailStartSchema = z
  .object({ email, portal, referralCode, platform, handle })
  .superRefine((v, ctx) => {
    if (v.portal === 'AFFILIATE' && (!v.platform || !v.handle)) {
      ctx.addIssue({ code: 'custom', path: ['platform'], message: 'Select your platform and enter your username' });
    }
  });

export const emailResendSchema = z.object({ email });
export const emailVerifySchema = z.object({ email, code });

// Google Identity Services: the "credential" (ID token) from the Google button.
export const googleSchema = z.object({ credential: z.string().min(20), portal, referralCode, platform, handle });

// Onboarding steps 3-4 and the Settings / My Profile page.
export const profileSchema = z
  .object({
    username: username.optional(),
    // Path of one of the built-in avatars, e.g. /images/affiliate-join/avatars/avatar-07.png
    avatar: z.string().regex(/^\/images\/[A-Za-z0-9/_.-]+\.(png|webp|jpg)$/, 'Pick an avatar').optional(),
    leaderboardPublic: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export const usernameQuerySchema = z.object({ username });
export const sessionParams = z.object({ id: z.string().uuid() });
