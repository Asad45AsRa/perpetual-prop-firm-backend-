import { Resend } from 'resend';
import { env, isProd } from '../config/env';
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
    // The SDK returns API errors instead of throwing (bad key, unverified domain...).
    const { error } = await resend.emails.send({ from: env.EMAIL_FROM, to: input.to, subject: input.subject, html: input.html });
    // Outside production the subject is logged too, so a blocked sign-in code can still be read while testing.
    if (error) logger.error({ err: error, to: input.to, ...(isProd ? {} : { subject: input.subject }) }, 'Failed to send email');
  } catch (err) {
    // Email problems must never break the main flow.
    logger.error({ err, to: input.to }, 'Failed to send email');
  }
}

export const emailTemplates = {
  // Passwordless sign-in (trader /signup and affiliate /affiliates/join)
  loginCode: (code: string) => ({
    subject: `${code} is your Perpeye sign-in code`,
    // Same look as the sign-up screens: #0F0F0F card, #99804A gold. Inline styles only (email clients).
    html: `<div style="background:#000000;padding:32px 16px;font-family:Arial,Helvetica,sans-serif">
<div style="max-width:440px;margin:0 auto;background:#0F0F0F;border:1px solid #2E2E2E;border-radius:16px;padding:32px;text-align:center">
<div style="color:#99804A;font-size:22px;font-weight:700;letter-spacing:1px">Perpeye</div>
<p style="color:#FFFFFF;font-size:16px;margin:24px 0 8px">Your sign-in code</p>
<div style="color:#99804A;font-size:34px;font-weight:700;letter-spacing:10px;padding:16px 0 16px 10px;border:1px solid #99804A;border-radius:12px;margin:16px 0">${code}</div>
<p style="color:#A0A0A0;font-size:13px;line-height:20px;margin:16px 0 0">This code expires in 10 minutes.<br>If you did not ask for it, you can ignore this email.</p>
</div></div>`,
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
