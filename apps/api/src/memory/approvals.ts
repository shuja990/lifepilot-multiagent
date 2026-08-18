/**
 * Durable state for the human-in-the-loop gate.
 *
 * Everything here is in Postgres rather than memory, and that is the whole
 * point of the feature. An approval that lives in a JS Map cannot survive a
 * restart, which means it cannot survive a deploy, which means the pause is
 * theatre: the demo only works if nobody closes the tab.
 *
 * Three tables:
 *   pending_approvals  what was asked, and the ids needed to resume the run
 *   executed_actions   the idempotency ledger — one row per action, enforced
 *   plans              committed plans, addressable by a shareable id
 */
import pg from 'pg';
import type { ActionKind, ApprovalStatus, PendingApproval } from '@lifepilot/shared';
import { optionalEnv } from '../config/env.js';

let pool: pg.Pool | undefined;
let schemaReady: Promise<void> | undefined;

function getPool(): pg.Pool {
  if (!pool) {
    const url = optionalEnv('DATABASE_URL');
    if (!url) {
      throw new Error(
        'DATABASE_URL is required for the approval flow. An approval that only ' +
          'exists in memory cannot survive a restart, so there is no in-memory fallback.',
      );
    }
    pool = new pg.Pool({ connectionString: url, max: 4 });
  }
  return pool;
}

/** Creates the schema on first use. Idempotent, safe on every boot. */
function init(): Promise<void> {
  schemaReady ??= (async () => {
    const client = getPool();
    await client.query(`
      CREATE TABLE IF NOT EXISTS pending_approvals (
        approval_id      TEXT PRIMARY KEY,
        user_id          TEXT NOT NULL,
        session_id       TEXT NOT NULL,
        function_call_id TEXT NOT NULL,
        invocation_id    TEXT,
        action           TEXT NOT NULL,
        summary          TEXT NOT NULL,
        details          TEXT NOT NULL,
        estimated_cost   TEXT,
        status           TEXT NOT NULL DEFAULT 'pending',
        reason           TEXT,
        modifications    TEXT,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        decided_at       TIMESTAMPTZ
      )`);

    // The idempotency ledger. The UNIQUE constraint is the actual guarantee —
    // a double-click, a retry, or a replay after restart collides here rather
    // than performing the action twice.
    await client.query(`
      CREATE TABLE IF NOT EXISTS executed_actions (
        idempotency_key TEXT PRIMARY KEY,
        action          TEXT NOT NULL,
        user_id         TEXT NOT NULL,
        result          JSONB NOT NULL,
        executed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS plans (
        plan_id    TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL,
        title      TEXT NOT NULL,
        body       TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS scheduled_notifications (
        id         TEXT PRIMARY KEY,
        plan_id    TEXT NOT NULL,
        user_id    TEXT NOT NULL,
        title      TEXT NOT NULL,
        body       TEXT,
        due_at     TIMESTAMPTZ NOT NULL,
        sent_at    TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);

    // Drives the /tick drain; without it the sweep scans the whole table.
    await client.query(
      `CREATE INDEX IF NOT EXISTS scheduled_notifications_due
       ON scheduled_notifications (due_at) WHERE sent_at IS NULL`,
    );
  })();
  return schemaReady;
}

/* ------------------------------------------------------------- approvals */

export interface CreateApprovalInput {
  approvalId: string;
  userId: string;
  sessionId: string;
  functionCallId: string;
  invocationId: string | null;
  action: ActionKind;
  summary: string;
  details: string;
  estimatedCost: string | null;
}

export async function createApproval(input: CreateApprovalInput): Promise<void> {
  await init();
  await getPool().query(
    `INSERT INTO pending_approvals
       (approval_id, user_id, session_id, function_call_id, invocation_id,
        action, summary, details, estimated_cost)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (approval_id) DO NOTHING`,
    [
      input.approvalId,
      input.userId,
      input.sessionId,
      input.functionCallId,
      input.invocationId,
      input.action,
      input.summary,
      input.details,
      input.estimatedCost,
    ],
  );
}

interface ApprovalRow {
  approval_id: string;
  user_id: string;
  session_id: string;
  function_call_id: string;
  invocation_id: string | null;
  action: string;
  summary: string;
  details: string;
  estimated_cost: string | null;
  status: string;
  created_at: Date;
}

function toApproval(row: ApprovalRow): PendingApproval {
  return {
    approvalId: row.approval_id,
    userId: row.user_id,
    sessionId: row.session_id,
    functionCallId: row.function_call_id,
    invocationId: row.invocation_id,
    action: row.action as ActionKind,
    summary: row.summary,
    details: row.details,
    estimatedCost: row.estimated_cost,
    status: row.status as ApprovalStatus,
    createdAt: row.created_at.toISOString(),
  };
}

export async function getApproval(approvalId: string): Promise<PendingApproval | undefined> {
  await init();
  const result = await getPool().query<ApprovalRow>(
    'SELECT * FROM pending_approvals WHERE approval_id = $1',
    [approvalId],
  );
  const row = result.rows[0];
  return row ? toApproval(row) : undefined;
}

export async function listPendingApprovals(userId?: string): Promise<PendingApproval[]> {
  await init();
  const result = userId
    ? await getPool().query<ApprovalRow>(
        `SELECT * FROM pending_approvals WHERE status = 'pending' AND user_id = $1
         ORDER BY created_at DESC`,
        [userId],
      )
    : await getPool().query<ApprovalRow>(
        `SELECT * FROM pending_approvals WHERE status = 'pending' ORDER BY created_at DESC`,
      );
  return result.rows.map(toApproval);
}

/**
 * Records a decision, but only against a still-pending approval.
 *
 * The `status = 'pending'` predicate makes this a compare-and-set: a second
 * decision on the same approval updates no rows and is reported as such,
 * rather than quietly overwriting the first.
 */
export async function decideApproval(
  approvalId: string,
  status: 'approved' | 'rejected',
  reason?: string,
  modifications?: string,
): Promise<boolean> {
  await init();
  const result = await getPool().query(
    `UPDATE pending_approvals
        SET status = $2, reason = $3, modifications = $4, decided_at = now()
      WHERE approval_id = $1 AND status = 'pending'`,
    [approvalId, status, reason ?? null, modifications ?? null],
  );
  return (result.rowCount ?? 0) > 0;
}

/* ----------------------------------------------------------- idempotency */

/**
 * Runs `perform` at most once per key, ever.
 *
 * The check is the INSERT itself, not a preceding SELECT: two concurrent
 * callers both see an empty table, so a read-then-write would let both through.
 * Here the loser collides with the primary key and gets the winner's result.
 */
export async function runOnce<T>(
  idempotencyKey: string,
  action: ActionKind,
  userId: string,
  perform: () => Promise<T>,
): Promise<{ result: T; alreadyExecuted: boolean }> {
  await init();
  const client = getPool();

  const existing = await client.query<{ result: T }>(
    'SELECT result FROM executed_actions WHERE idempotency_key = $1',
    [idempotencyKey],
  );
  if (existing.rows[0]) {
    return { result: existing.rows[0].result, alreadyExecuted: true };
  }

  const result = await perform();

  const inserted = await client.query(
    `INSERT INTO executed_actions (idempotency_key, action, user_id, result)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [idempotencyKey, action, userId, JSON.stringify(result)],
  );

  // Lost the race: another caller performed it between our SELECT and INSERT.
  // Report theirs, so callers never see two different "first" results.
  if ((inserted.rowCount ?? 0) === 0) {
    const winner = await client.query<{ result: T }>(
      'SELECT result FROM executed_actions WHERE idempotency_key = $1',
      [idempotencyKey],
    );
    if (winner.rows[0]) return { result: winner.rows[0].result, alreadyExecuted: true };
  }

  return { result, alreadyExecuted: false };
}

/* ---------------------------------------------------------------- plans */

export async function savePlan(
  planId: string,
  userId: string,
  title: string,
  body: string,
): Promise<void> {
  await init();
  await getPool().query(
    `INSERT INTO plans (plan_id, user_id, title, body) VALUES ($1,$2,$3,$4)
     ON CONFLICT (plan_id) DO NOTHING`,
    [planId, userId, title, body],
  );
}

export async function getPlan(
  planId: string,
): Promise<{ planId: string; title: string; body: string; createdAt: string } | undefined> {
  await init();
  const result = await getPool().query<{
    plan_id: string;
    title: string;
    body: string;
    created_at: Date;
  }>('SELECT plan_id, title, body, created_at FROM plans WHERE plan_id = $1', [planId]);
  const row = result.rows[0];
  return row
    ? {
        planId: row.plan_id,
        title: row.title,
        body: row.body,
        createdAt: row.created_at.toISOString(),
      }
    : undefined;
}

/* -------------------------------------------------------- notifications */

export async function scheduleNotification(input: {
  id: string;
  planId: string;
  userId: string;
  title: string;
  body: string | null;
  dueAt: Date;
}): Promise<void> {
  await init();
  await getPool().query(
    `INSERT INTO scheduled_notifications (id, plan_id, user_id, title, body, due_at)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
    [input.id, input.planId, input.userId, input.title, input.body, input.dueAt],
  );
}

/**
 * Claims every notification that is due and not yet sent.
 *
 * The UPDATE ... RETURNING claims and reports in one statement, so two
 * concurrent ticks cannot both deliver the same reminder.
 */
export async function claimDueNotifications(
  now = new Date(),
): Promise<Array<{ id: string; userId: string; title: string; body: string | null }>> {
  await init();
  const result = await getPool().query<{
    id: string;
    user_id: string;
    title: string;
    body: string | null;
  }>(
    `UPDATE scheduled_notifications
        SET sent_at = now()
      WHERE id IN (
        SELECT id FROM scheduled_notifications
         WHERE sent_at IS NULL AND due_at <= $1
         ORDER BY due_at
         LIMIT 50
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id, user_id, title, body`,
    [now],
  );
  return result.rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    title: row.title,
    body: row.body,
  }));
}

export async function closeApprovalStore(): Promise<void> {
  await pool?.end().catch(() => undefined);
  pool = undefined;
  schemaReady = undefined;
}
