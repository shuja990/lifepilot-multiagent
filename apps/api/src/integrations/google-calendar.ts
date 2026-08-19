/**
 * Optional Google Calendar connection.
 *
 * This is an upgrade, never the critical path. `calendar.events` is a Google
 * *sensitive* scope: an unverified app shows a "Google hasn't verified this app"
 * warning before the consent screen and is capped at 100 users for the lifetime
 * of the project, a cap that cannot be reset. Requiring it would break the rule
 * that a stranger with a link can finish a plan, so the `.ics` file remains the
 * default and this sits behind an explicit "Connect" button.
 *
 * When the OAuth client is not configured the whole feature reports itself as
 * unavailable rather than half-existing.
 *
 * Tokens are per user. Refresh tokens are long-lived credentials, so they live
 * in the database and never leave the server.
 */
import pg from 'pg';
import { optionalEnv } from '../config/env.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

/** Only what is needed to write events — no reading, no other calendars. */
const SCOPE = 'https://www.googleapis.com/auth/calendar.events';

let pool: pg.Pool | undefined;
let ready: Promise<void> | undefined;

function getPool(): pg.Pool {
  const url = optionalEnv('DATABASE_URL');
  if (!url) throw new Error('DATABASE_URL is required to store calendar connections.');
  pool ??= new pg.Pool({ connectionString: url, max: 2 });
  return pool;
}

function init(): Promise<void> {
  ready ??= getPool()
    .query(
      `CREATE TABLE IF NOT EXISTS calendar_connections (
         user_id       TEXT PRIMARY KEY,
         refresh_token TEXT NOT NULL,
         access_token  TEXT,
         expires_at    TIMESTAMPTZ,
         google_email  TEXT,
         connected_at  TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    )
    .then(() => undefined);
  return ready;
}

export function isConfigured(): boolean {
  return Boolean(optionalEnv('GOOGLE_OAUTH_CLIENT_ID') && optionalEnv('GOOGLE_OAUTH_CLIENT_SECRET'));
}

function redirectUri(): string {
  return optionalEnv(
    'GOOGLE_OAUTH_REDIRECT_URI',
    `${optionalEnv('PUBLIC_BASE_URL', 'http://localhost:8080')}/connect/google/callback`,
  );
}

/**
 * Builds the consent URL.
 *
 * `state` carries the signed session token so the callback knows who is
 * connecting — the callback is a plain browser redirect and cannot send an
 * Authorization header.
 *
 * `access_type=offline` with `prompt=consent` is what actually returns a
 * refresh token; without both, Google issues one only on the very first consent
 * and reconnecting later silently yields none.
 */
export function buildConsentUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: optionalEnv('GOOGLE_OAUTH_CLIENT_ID'),
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function exchange(body: Record<string, string>): Promise<TokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: optionalEnv('GOOGLE_OAUTH_CLIENT_ID'),
      client_secret: optionalEnv('GOOGLE_OAUTH_CLIENT_SECRET'),
      ...body,
    }).toString(),
  });

  const json = (await response.json()) as TokenResponse;
  if (!response.ok || json.error) {
    throw new Error(json.error_description ?? json.error ?? `Google returned ${response.status}`);
  }
  return json;
}

/** Completes the OAuth handshake and stores the connection. */
export async function completeConnection(code: string, userId: string): Promise<void> {
  await init();

  const tokens = await exchange({
    code,
    redirect_uri: redirectUri(),
    grant_type: 'authorization_code',
  });

  if (!tokens.refresh_token) {
    throw new Error(
      'Google did not return a refresh token. Revoke the app at ' +
        'myaccount.google.com/permissions and connect again.',
    );
  }

  await getPool().query(
    `INSERT INTO calendar_connections (user_id, refresh_token, access_token, expires_at)
     VALUES ($1, $2, $3, now() + ($4 || ' seconds')::interval)
     ON CONFLICT (user_id) DO UPDATE
       SET refresh_token = EXCLUDED.refresh_token,
           access_token  = EXCLUDED.access_token,
           expires_at    = EXCLUDED.expires_at,
           connected_at  = now()`,
    [userId, tokens.refresh_token, tokens.access_token ?? null, String(tokens.expires_in ?? 3600)],
  );
}

export async function isConnected(userId: string): Promise<boolean> {
  if (!isConfigured()) return false;
  await init();
  const result = await getPool().query('SELECT 1 FROM calendar_connections WHERE user_id = $1', [
    userId,
  ]);
  return result.rowCount === 1;
}

export async function disconnect(userId: string): Promise<void> {
  await init();
  await getPool().query('DELETE FROM calendar_connections WHERE user_id = $1', [userId]);
}

/**
 * Returns a usable access token, refreshing it when needed.
 *
 * Refreshes a minute early rather than exactly on expiry, so a token cannot go
 * stale between the check and the request that uses it.
 */
async function accessTokenFor(userId: string): Promise<string | undefined> {
  await init();

  const result = await getPool().query<{
    refresh_token: string;
    access_token: string | null;
    expires_at: Date | null;
  }>('SELECT refresh_token, access_token, expires_at FROM calendar_connections WHERE user_id = $1', [
    userId,
  ]);

  const row = result.rows[0];
  if (!row) return undefined;

  const stillValid =
    row.access_token && row.expires_at && row.expires_at.getTime() - 60_000 > Date.now();
  if (stillValid) return row.access_token ?? undefined;

  const refreshed = await exchange({
    refresh_token: row.refresh_token,
    grant_type: 'refresh_token',
  });

  await getPool().query(
    `UPDATE calendar_connections
        SET access_token = $2, expires_at = now() + ($3 || ' seconds')::interval
      WHERE user_id = $1`,
    [userId, refreshed.access_token ?? null, String(refreshed.expires_in ?? 3600)],
  );

  return refreshed.access_token;
}

export interface CalendarEvent {
  title: string;
  startsAt: Date;
  description?: string | null;
  /** Stable id so a repeated commit updates rather than duplicates. */
  idempotencyId: string;
}

/**
 * Creates events on the user's primary calendar.
 *
 * Never throws: a calendar failure must not undo a plan that was already saved.
 * The count of what actually landed is returned so the UI can be honest about
 * partial success instead of claiming everything worked.
 */
export async function createEvents(
  userId: string,
  events: CalendarEvent[],
): Promise<{ created: number; error?: string }> {
  if (!isConfigured() || events.length === 0) return { created: 0 };

  try {
    const token = await accessTokenFor(userId);
    if (!token) return { created: 0 };

    let created = 0;
    for (const event of events) {
      const end = new Date(event.startsAt.getTime() + 60 * 60 * 1000);
      const response = await fetch(EVENTS_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          // Google requires lowercase alphanumeric ids of at least 5 chars.
          id: event.idempotencyId.replace(/[^a-v0-9]/g, '').slice(0, 40) || undefined,
          summary: event.title,
          description: event.description ?? undefined,
          start: { dateTime: event.startsAt.toISOString() },
          end: { dateTime: end.toISOString() },
        }),
      });

      // 409 means this exact event already exists, which is success for our
      // purposes: the user asked for it once and it is there.
      if (response.ok || response.status === 409) created += 1;
    }

    return { created };
  } catch (error) {
    return { created: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function closeCalendarStore(): Promise<void> {
  await pool?.end().catch(() => undefined);
  pool = undefined;
  ready = undefined;
}
