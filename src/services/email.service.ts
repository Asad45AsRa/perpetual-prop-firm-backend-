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
  // Passwordless sign-in (trader /signup and affiliate /affiliates/join)
  loginCode: (code: string) => ({
    subject: `${code} is your Perpeye sign-in code`,
    html: `<p>Your sign-in code is:</p><p style="font-size:28px;letter-spacing:6px;font-weight:600">${code}</p><p>It expires in 10 minutes. If you did not ask for it, you can ignore this email.</p>`,
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
