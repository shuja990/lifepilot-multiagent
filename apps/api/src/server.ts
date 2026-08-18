/**
 * The HTTP surface.
 *
 * Everything here is a thin wrapper over logic that already exists and is
 * already tested from the CLI. That ordering was deliberate: the approval flow,
 * the scheduler drain and the agent graph were all proven in a terminal before
 * anything was exposed over HTTP, so a failure here is a transport bug rather
 * than a question about whether the feature works at all.
 *
 *   GET  /health              liveness, and whether persistence is on
 *   POST /chat                run an agent, streaming events as SSE
 *   GET  /approvals           what is waiting for a human
 *   POST /approvals/:id       approve or reject, then resume the run
 *   GET  /plan/:id            the shareable plan page
 *   POST /tick                drain due reminders (cron only)
 */
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { Runner, createResumabilityConfig } from '@google/adk';

import { createBaselineAgent } from './agents/baseline.js';
import { createOrchestrator } from './agents/orchestrator.js';
import { INITIAL_STATE, createPlanningGraph } from './agents/pipeline.js';
import { optionalEnv } from './config/env.js';
import { toTraceEntries } from './lib/trace.js';
import {
  decideApproval,
  getApproval,
  getPlan,
  listPendingApprovals,
} from './memory/approvals.js';
import { getSessionService, isPersistent } from './memory/stores.js';
import { runTick } from './tick.js';

const APP_NAME = 'lifepilot';
const app = new Hono();

// The web app is deployed on a different origin from the API, so CORS is a
// requirement rather than a convenience.
app.use('/*', cors());

app.get('/health', (c) =>
  c.json({ ok: true, persistent: isPersistent(), app: APP_NAME }),
);

/* -------------------------------------------------------------------- chat */

function buildRunner(mode: string) {
  const agent =
    mode === 'baseline'
      ? createBaselineAgent()
      : mode === 'graph'
        ? createPlanningGraph()
        : createOrchestrator();

  return new Runner({
    agent,
    appName: APP_NAME,
    sessionService: getSessionService(),
    // Required so an approval decision resumes the suspended call.
    resumabilityConfig: createResumabilityConfig({ isResumable: true }),
  });
}

/**
 * Runs an agent and streams what it does.
 *
 * The stream is the product, not a debugging aid: showing which agent is
 * working, which tool it called and with what arguments is the thing that makes
 * a multi-agent system legible instead of a slow black box.
 */
app.post('/chat', async (c) => {
  const body = await c.req.json<{
    message?: string;
    userId?: string;
    sessionId?: string;
    mode?: string;
  }>();

  const message = body.message?.trim();
  if (!message) return c.json({ error: 'message is required' }, 400);

  const userId = body.userId?.trim() || 'demo-user';
  const mode = body.mode ?? 'orchestrator';

  const sessionService = getSessionService();
  const session =
    (body.sessionId
      ? await sessionService.getSession({ appName: APP_NAME, userId, sessionId: body.sessionId })
      : undefined) ??
    (await sessionService.createSession({
      appName: APP_NAME,
      userId,
      state: { ...INITIAL_STATE },
    }));

  const runner = buildRunner(mode);

  return streamSSE(c, async (stream) => {
    // Sent first so the client can resume this conversation later, even if the
    // run then fails.
    await stream.writeSSE({ event: 'session', data: JSON.stringify({ sessionId: session.id }) });

    try {
      for await (const event of runner.runAsync({
        userId,
        sessionId: session.id,
        newMessage: {
          role: 'user',
          parts: [{ text: `${message}\n\n(Your user_id for preference tools is "${userId}".)` }],
        },
      })) {
        for (const entry of toTraceEntries(event)) {
          await stream.writeSSE({ event: entry.kind, data: JSON.stringify(entry) });
        }
      }
      await stream.writeSSE({ event: 'done', data: '{}' });
    } catch (error) {
      // Reported on the stream rather than as a status code: headers are long
      // gone by the time most failures happen.
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
      });
    }
  });
});

/* --------------------------------------------------------------- approvals */

app.get('/approvals', async (c) => {
  const userId = c.req.query('userId');
  return c.json({ approvals: await listPendingApprovals(userId) });
});

/**
 * Records a decision and resumes the suspended run.
 *
 * The decision is written before the agent restarts, so a crash mid-resume
 * leaves a decided approval rather than an ambiguous one.
 */
app.post('/approvals/:id', async (c) => {
  const approvalId = c.req.param('id');
  const body = await c.req.json<{ status?: string; reason?: string }>();

  const status = body.status === 'rejected' ? 'rejected' : 'approved';
  const approval = await getApproval(approvalId);
  if (!approval) return c.json({ error: 'not found' }, 404);

  const changed = await decideApproval(approvalId, status, body.reason);
  if (!changed) {
    // Not an error the user needs to fear — usually a double-click.
    return c.json({ ok: false, reason: `already ${approval.status}` }, 409);
  }

  const runner = buildRunner('orchestrator');
  const texts: string[] = [];

  for await (const event of runner.runAsync({
    userId: approval.userId,
    sessionId: approval.sessionId,
    newMessage: {
      role: 'user',
      parts: [
        {
          functionResponse: {
            // Same id as the suspended call, or ADK starts a new turn instead
            // of resuming this one.
            id: approval.functionCallId,
            name: 'request_approval',
            response: { status, approvalId, ...(body.reason ? { reason: body.reason } : {}) },
          },
        },
      ],
    },
  })) {
    for (const entry of toTraceEntries(event)) {
      if (entry.kind === 'text' && entry.text) texts.push(entry.text);
    }
  }

  return c.json({ ok: true, status, answer: texts.join('\n').trim() });
});

/* -------------------------------------------------------------------- plan */

/** The shareable page. Deliberately plain HTML — no login, no build step. */
app.get('/plan/:id', async (c) => {
  const plan = await getPlan(c.req.param('id'));
  if (!plan) return c.text('Plan not found', 404);

  return c.html(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(plan.title)} — LifePilot</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.6 system-ui, sans-serif; max-width: 42rem; margin: 3rem auto; padding: 0 1.25rem; }
  h1 { font-size: 1.6rem; margin-bottom: .25rem; }
  .meta { opacity: .65; font-size: .875rem; margin-bottom: 2rem; }
  pre { white-space: pre-wrap; word-wrap: break-word; font: inherit; }
  footer { margin-top: 3rem; opacity: .6; font-size: .8rem; }
</style></head>
<body>
  <h1>${escapeHtml(plan.title)}</h1>
  <div class="meta">Saved ${new Date(plan.createdAt).toUTCString()}</div>
  <pre>${escapeHtml(plan.body)}</pre>
  <footer>Made with LifePilot. Booking and payment are simulated in this demo.</footer>
</body></html>`);
});

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* -------------------------------------------------------------------- tick */

/**
 * Drains due reminders. Called by cron, not by users.
 *
 * Guarded by a shared secret: this endpoint has a side effect on the world, so
 * it must not be triggerable by anyone who finds the URL. When TICK_SECRET is
 * unset the endpoint refuses rather than running unprotected — failing closed
 * is the right default for something that sends messages.
 */
app.post('/tick', async (c) => {
  const secret = optionalEnv('TICK_SECRET');
  if (!secret) return c.json({ error: 'TICK_SECRET is not configured' }, 503);
  if (c.req.header('authorization') !== `Bearer ${secret}`) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  const delivered = await runTick();
  return c.json({ delivered: delivered.length, notifications: delivered });
});

/* ------------------------------------------------------------------- boot */

const port = Number(optionalEnv('PORT', '8080'));
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`LifePilot API on http://localhost:${info.port}`);
  console.log(`sessions: ${isPersistent() ? 'postgres' : 'in-memory'}`);
});

export { app };
