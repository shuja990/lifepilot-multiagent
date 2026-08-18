/**
 * Phase 5: persistence.
 *
 * Two things become durable here, and they are durable for different reasons:
 *
 *   Sessions      so a conversation survives a restart, which the approval gate
 *                 in Phase 6 depends on absolutely — an approval that only
 *                 exists in memory is a prop, not a feature.
 *   Preferences   so what the user told us once still applies next week.
 *
 * Both fall back to their in-process versions when DATABASE_URL is unset, so
 * the project still runs with no database at all. That is not politeness; it
 * keeps the tool layer and the agents developable when Neon is asleep or a
 * contributor has no credentials.
 */
import pg from 'pg';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { DatabaseSessionService, InMemorySessionService } from '@google/adk';
import type { BaseSessionService } from '@google/adk';
import type { Preference, PreferenceKey } from '@lifepilot/shared';
import { optionalEnv } from '../config/env.js';
import type { PreferenceStore } from '../tools/preferences.js';

/* ------------------------------------------------------------------ sessions */

let sessionService: BaseSessionService | undefined;

/**
 * The session service, created once per process.
 *
 * DatabaseSessionService carries its own schema (sessions, events, app state,
 * user state) through MikroORM, so there is no migration of ours to run.
 */
export function getSessionService(): BaseSessionService {
  if (sessionService) return sessionService;

  const url = optionalEnv('DATABASE_URL');
  if (!url) {
    sessionService = new InMemorySessionService();
    return sessionService;
  }

  /**
   * SSL has to be passed as a driver option, not left to the URL.
   *
   * Neon rejects unencrypted connections, and although our DATABASE_URL already
   * carries `sslmode=require`, that is a libpq parameter. MikroORM's driver does
   * not interpret it, so it dialled out in plaintext and Neon replied
   * "connection is insecure (try using `sslmode=require`)" — an error that reads
   * like the URL is wrong when the URL is fine.
   *
   * `ssl: true` uses the system CA store and verifies Neon's certificate. It is
   * deliberately not `rejectUnauthorized: false`, which would silence the error
   * by turning verification off.
   */
  sessionService = new DatabaseSessionService({
    // The driver is inferred from a connection string but must be explicit once
    // options are passed as an object.
    driver: PostgreSqlDriver,
    clientUrl: url,
    driverOptions: { connection: { ssl: true } },
  });
  return sessionService;
}

export function isPersistent(): boolean {
  return Boolean(optionalEnv('DATABASE_URL'));
}

/**
 * Closes every open database handle.
 *
 * Without this a CLI run finishes its work, prints its answer, and then hangs:
 * both the MikroORM connection and our own pg Pool keep the event loop alive.
 * Long-lived servers do not care, but every script and every test does.
 */
export async function closeStores(): Promise<void> {
  // DatabaseSessionService exposes no close(), and its MikroORM instance is
  // private, so reach for it defensively: if the shape changes this quietly
  // does nothing rather than throwing, and the CLI's explicit exit covers us.
  const internals = sessionService as unknown as
    | { close?: () => Promise<void>; orm?: { close?: () => Promise<void> } }
    | undefined;
  await internals?.close?.().catch(() => undefined);
  await internals?.orm?.close?.().catch(() => undefined);
  sessionService = undefined;

  await preferenceStoreToClose?.close().catch(() => undefined);
  preferenceStoreToClose = undefined;
}

/** Registered by the preferences tool so cleanup can reach the pool it opened. */
let preferenceStoreToClose: PostgresPreferenceStore | undefined;
export function registerClosablePreferenceStore(store: PostgresPreferenceStore): void {
  preferenceStoreToClose = store;
}

/* --------------------------------------------------------------- preferences */

/**
 * Preferences in Postgres.
 *
 * The primary key is (user_id, key) and writes are a single INSERT ... ON
 * CONFLICT DO UPDATE. That is the real fix for the concurrency bug the Phase 0
 * review found in the JSON store: correctness is enforced by the database in
 * one statement, rather than by a read-modify-write we have to remember to
 * serialise. The ParallelAgent fan-out can write freely.
 */
export class PostgresPreferenceStore implements PreferenceStore {
  private pool: pg.Pool;
  private ready?: Promise<void>;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 4 });
  }

  /** Creates the table on first use. Idempotent, so it is safe on every boot. */
  private init(): Promise<void> {
    return (this.ready ??= this.pool
      .query(
        `CREATE TABLE IF NOT EXISTS user_preferences (
           user_id    TEXT        NOT NULL,
           key        TEXT        NOT NULL,
           value      TEXT        NOT NULL,
           updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
           PRIMARY KEY (user_id, key)
         )`,
      )
      .then(() => undefined));
  }

  async get(userId: string): Promise<Preference[]> {
    await this.init();
    const result = await this.pool.query<{ key: string; value: string; updated_at: Date }>(
      'SELECT key, value, updated_at FROM user_preferences WHERE user_id = $1 ORDER BY key',
      [userId],
    );
    return result.rows.map((row: { key: string; value: string; updated_at: Date }) => ({
      key: row.key as PreferenceKey,
      value: row.value,
      updatedAt: row.updated_at.toISOString(),
    }));
  }

  async put(userId: string, preference: Preference): Promise<void> {
    await this.init();
    // One value per key, applied atomically. No read-modify-write, so
    // concurrent writers cannot lose each other's updates.
    await this.pool.query(
      `INSERT INTO user_preferences (user_id, key, value, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [userId, preference.key, preference.value, preference.updatedAt],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
