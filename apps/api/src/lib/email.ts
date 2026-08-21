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

    // Resend's shared sender only delivers to the account owner's own address
    // until a domain is verified. That is easy to hit and the raw 403 does not
    // say what to do about it, so spell it out for whoever runs the server.
    if (response.status === 403 && detail.includes('your own email address')) {
      console.warn(
        [
          '',
          'Resend refused this message.',
          `  from: ${from}`,
          `  to:   ${mail.to}`,
          '',
          'The shared onboarding@resend.dev sender can only deliver to the address',
          'that owns the Resend account. To email anyone else, verify a domain at',
          'https://resend.com/domains and set EMAIL_FROM to an address on it.',
          '',
          'Until then, the reset link is below so you can still test the flow:',
          '',
          mail.text,
          '',
        ].join('\n'),
      );
      return { delivered: false, via: 'resend-restricted' };
    }

    // Thrown so the caller can decide; a silent failure here means a user waits
    // forever for a message that was never sent.
    throw new Error(`Email provider returned ${response.status}: ${detail.slice(0, 200)}`);
  }

  return { delivered: true, via: 'resend' };
}
