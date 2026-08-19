/**
 * Outbound email.
 *
 * Pluggable on purpose. Resend is used when RESEND_API_KEY is configured;
 * otherwise the message is written to the server log so the flow is still
 * testable locally without signing up for anything.
 *
 * What this deliberately does NOT do is return the reset link to the caller.
 * That would be convenient and it would also mean anyone who knows an email
 * address could reset that account — the link has to travel over a channel only
 * the account owner controls, or the whole mechanism is theatre.
 */
import { optionalEnv } from '../config/env.js';

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export function emailConfigured(): boolean {
  return Boolean(optionalEnv('RESEND_API_KEY'));
}

export async function sendMail(mail: Mail): Promise<{ delivered: boolean; via: string }> {
  const apiKey = optionalEnv('RESEND_API_KEY');

  if (!apiKey) {
    // Loud and complete, so a developer can copy the link out of the terminal.
    console.log(
      [
        '',
        '─── email (no provider configured, logged instead) ───',
        `to:      ${mail.to}`,
        `subject: ${mail.subject}`,
        '',
        mail.text,
        '──────────────────────────────────────────────────────',
        '',
      ].join('\n'),
    );
    return { delivered: false, via: 'log' };
  }

  const from = optionalEnv('EMAIL_FROM', 'LifePilot <onboarding@resend.dev>');

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from, to: [mail.to], subject: mail.subject, text: mail.text }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    // Thrown so the caller can decide; a silent failure here means a user waits
    // forever for a message that was never sent.
    throw new Error(`Email provider returned ${response.status}: ${detail.slice(0, 200)}`);
  }

  return { delivered: true, via: 'resend' };
}
