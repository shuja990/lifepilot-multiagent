/**
 * Conversation index.
 *
 * ADK's listSessions deliberately returns sessions WITHOUT their state or
 * events, which is the right call for a storage API but leaves nothing to label
 * a sidebar with. Fetching every session just to read its first message would
 * be an N+1 against the database on every page load.
 *
 * So we keep a small index of our own: one row per conversation, carrying the
 * title and when it was last touched. It is derived data, cheap to rebuild, and
 * it exists purely so the history list can be rendered in one query.
 */
import pg from 'pg';
import { optionalEnv } from '../config/env.js';

export interface Conversation {
  sessionId: string;
  userId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

let pool: pg.Pool | undefined;
let ready: Promise<void> | undefined;

/** In-memory fallback so the app still runs with no database configured. */
const memory = new Map<string, Conversation>();

function getPool(): pg.Pool | undefined {
  const url = optionalEnv('DATABASE_URL');
  if (!url) return undefined;
  pool ??= new pg.Pool({ connectionString: url, max: 4 });
  return pool;
}

function init(client: pg.Pool): Promise<void> {
  ready ??= client
    .query(
      `CREATE TABLE IF NOT EXISTS conversations (
         session_id TEXT PRIMARY KEY,
         user_id    TEXT NOT NULL,
         title      TEXT NOT NULL,
         created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    )
    .then(() =>
      client
        .query(
          `CREATE INDEX IF NOT EXISTS conversations_user_updated
             ON conversations (user_id, updated_at DESC)`,
        )
        .then(() => undefined),
    );
  return ready;
}

/** Derives a readable label from the opening message. */
export function titleFrom(message: string): string {
  const cleaned = message.trim().replace(/\s+/g, ' ');
  return cleaned.length > 70 ? `${cleaned.slice(0, 67)}…` : cleaned || 'New conversation';
}

/**
 * Records a conversation, keeping the FIRST title.
 *
 * Later turns bump `updated_at` so ordering stays useful, but the title is left
 * alone — a sidebar that renames itself as the conversation goes on is
 * impossible to navigate.
 */
export async function touchConversation(
  sessionId: string,
  userId: string,
  title: string,
): Promise<void> {
  const client = getPool();

  if (!client) {
    const existing = memory.get(sessionId);
    memory.set(sessionId, {
      sessionId,
      userId,
      title: existing?.title ?? title,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return;
  }

  await init(client);
  await client.query(
    `INSERT INTO conversations (session_id, user_id, title)
     VALUES ($1,$2,$3)
     ON CONFLICT (session_id)
     DO UPDATE SET updated_at = now()`,
    [sessionId, userId, title],
  );
}

export async function listConversations(userId: string, limit = 50): Promise<Conversation[]> {
  const client = getPool();

  if (!client) {
    return [...memory.values()]
      .filter((c) => c.userId === userId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  await init(client);
  const result = await client.query<{
    session_id: string;
    user_id: string;
    title: string;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT session_id, user_id, title, created_at, updated_at
       FROM conversations WHERE user_id = $1
      ORDER BY updated_at DESC LIMIT $2`,
    [userId, limit],
  );

  return result.rows.map((row) => ({
    sessionId: row.session_id,
    userId: row.user_id,
    title: row.title,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }));
}

export async function deleteConversation(sessionId: string, userId: string): Promise<void> {
  const client = getPool();
  if (!client) {
    memory.delete(sessionId);
    return;
  }
  await init(client);
  await client.query('DELETE FROM conversations WHERE session_id = $1 AND user_id = $2', [
    sessionId,
    userId,
  ]);
}

export async function closeConversationStore(): Promise<void> {
  await pool?.end().catch(() => undefined);
  pool = undefined;
  ready = undefined;
}
