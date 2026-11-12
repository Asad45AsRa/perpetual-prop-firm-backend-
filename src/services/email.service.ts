import { Resend } from 'resend';
import { env } from '../config/env';
import { logger } from '../config/logger';

const resend = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;

export interface EmailInput {
  to: string;
  subject: string;
  html: string;
}

// Sends email through Resend. Without an API key (local development) the
// email is printed to the log instead, so you can copy verification links.
export async function sendEmail(input: EmailInput): Promise<void> {
  if (!resend) {
    logger.info({ to: input.to, subject: input.subject, html: input.html }, 'EMAIL (not sent, no RESEND_API_KEY)');
    return;
  }
  try {
    await resend.emails.send({ from: env.EMAIL_FROM, to: input.to, subject: input.subject, html: input.html });
  } catch (err) {
    // Email problems must never break the main flow.
    logger.error({ err, to: input.to }, 'Failed to send email');
  }
}

export const emailTemplates = {
  verifyEmail: (token: string) => ({
    subject: 'Verify your email',
    html: `<p>Welcome! Confirm your email address:</p><p><a href="${env.FRONTEND_URL}/verify-email?token=${token}">Verify email</a></p>`,
  }),
  passwordReset: (token: string) => ({
    subject: 'Reset your password',
    html: `<p>Use this link to reset your password (valid for 1 hour):</p><p><a href="${env.FRONTEND_URL}/reset-password?token=${token}">Reset password</a></p>`,
  }),
  challengeActivated: (planName: string) => ({
    subject: 'Your challenge account is active',
    html: `<p>Your <b>${planName}</b> challenge account is now active. Good luck trading!</p>`,
  }),
  payoutUpdate: (status: string, amount: string) => ({
    subject: `Payout ${status.toLowerCase()}`,
    html: `<p>Your payout request of <b>${amount}</b> is now <b>${status}</b>.</p>`,
  }),
};
