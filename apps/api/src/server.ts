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
import {
  AuthError,
  completePasswordReset,
  createGuest,
  getUser,
  login,
  register,
  requestPasswordReset,
  verifyToken,
} from './memory/auth.js';
import { emailConfigured, sendMail } from './lib/email.js';
import * as calendar from './integrations/google-calendar.js';
import { listConversations, titleFrom, touchConversation, deleteConversation } from './memory/conversations.js';
import { getPreferences, savePreference } from './tools/preferences.js';
import { runTick } from './tick.js';

const APP_NAME = 'lifepilot';
const app = new Hono();

/**
 * CORS, restricted to the origins we actually serve.
 *
 * The web app is on a different origin from the API, so CORS is a requirement
 * rather than a convenience — but a wildcard is now the wrong default. With
 * bearer-token auth, any page a signed-in user visits could otherwise call this
 * API from their browser. Localhost stays allowed so development still works.
 *
 * ALLOWED_ORIGINS overrides the list for preview deployments.
 */
const allowedOrigins = [
  optionalEnv('WEB_BASE_URL', 'http://localhost:3100'),
  ...optionalEnv('ALLOWED_ORIGINS')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  'http://localhost:3000',
  'http://localhost:3100',
];

app.use(
  '/*',
  cors({
    origin: (origin) => {
      // Non-browser callers (curl, the cron) send no Origin at all.
      if (!origin) return origin;
      if (allowedOrigins.includes(origin)) return origin;
      // Vercel preview deployments get a new hostname per push.
      if (/^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin)) return origin;
      return null;
    },
    credentials: true,
  }),
);

app.get('/health', (c) =>
  c.json({ ok: true, persistent: isPersistent(), app: APP_NAME }),
);

/* -------------------------------------------------------------------- auth */

/**
 * Resolves the caller from the Authorization header.
 *
 * Every user-scoped route goes through this. It replaces reading `userId` from
 * a query string, which meant `?userId=someone-else` was enough to read another
 * person's conversations — identity was a label, not a boundary.
 */
function requireUserId(c: { req: { header(name: string): string | undefined } }): string {
  const header = c.req.header('authorization') ?? '';
  const userId = verifyToken(header.replace(/^Bearer\s+/i, '').trim() || undefined);
  if (!userId) throw new AuthError('Sign in to continue.', 401);
  return userId;
}

app.onError((error, c) => {
  if (error instanceof AuthError) return c.json({ error: error.message }, error.status as 401);
  console.error(error);
  return c.json({ error: error.message || 'Something went wrong.' }, 500);
});

app.post('/auth/register', async (c) => {
  const body = await c.req.json<{ email?: string; password?: string; displayName?: string }>();
  if (!body.email || !body.password) return c.json({ error: 'Email and password are required.' }, 400);
  return c.json(await register(body.email, body.password, body.displayName));
});

app.post('/auth/login', async (c) => {
  const body = await c.req.json<{ email?: string; password?: string }>();
  if (!body.email || !body.password) return c.json({ error: 'Email and password are required.' }, 400);
  return c.json(await login(body.email, body.password));
});

/** A real row, so a guest's data is scoped exactly like anyone else's. */
app.post('/auth/guest', async (c) => c.json(await createGuest()));

/**
 * Starts a password reset.
 *
 * Always answers the same way, whether or not the address is registered — a
 * different response for unknown addresses turns this into a way to discover
 * which emails have accounts.
 */
app.post('/auth/forgot', async (c) => {
  const body = await c.req.json<{ email?: string }>();
  if (!body.email) return c.json({ error: 'Email is required.' }, 400);

  const reset = await requestPasswordReset(body.email);

  if (reset.token && reset.email) {
    const base = optionalEnv('WEB_BASE_URL', 'http://localhost:3100');
    const link = `${base}/reset?token=${reset.token}`;

    try {
      await sendMail({
        to: reset.email,
        subject: 'Reset your LifePilot password',
        text: [
          `Hi ${reset.displayName ?? 'there'},`,
          '',
          'Use this link to choose a new password. It expires in an hour and',
          'can only be used once.',
          '',
          link,
          '',
          'If you did not ask for this, you can ignore this email — nothing has',
          'changed on your account.',
        ].join('\n'),
      });
    } catch (error) {
      // Logged, not surfaced: telling the caller that delivery failed would
      // also tell them the address exists.
      console.error('Password reset email failed:', error);
    }
  }

  return c.json({
    ok: true,
    message: 'If that email has an account, a reset link is on its way.',
    // Not a secret, and it tells a self-hoster why no mail arrived.
    emailConfigured: emailConfigured(),
  });
});

app.post('/auth/reset', async (c) => {
  const body = await c.req.json<{ token?: string; password?: string }>();
  if (!body.token || !body.password) {
    return c.json({ error: 'Token and new password are required.' }, 400);
  }

  await completePasswordReset(body.token, body.password);
  return c.json({ ok: true, message: 'Password updated. You can sign in now.' });
});

app.get('/auth/me', async (c) => {
  const user = await getUser(requireUserId(c));
  return user ? c.json({ user }) : c.json({ error: 'Account not found.' }, 404);
});

/* -------------------------------------------------------------------- chat */

/**
 * Runners are built once per mode and reused for every request.
 *
 * This is not an optimisation. ADK stamps a parent onto each sub-agent when a
 * workflow agent is composed, so constructing the graph a second time throws
 *
 *   Agent "intake" already has a parent agent, current parent: "lifepilot_graph"
 *
 * The CLI never hit it because it builds the tree once and exits; the server
 * built one per request, so the FIRST /chat succeeded and every one after it
 * returned 500. Agents are stateless — all per-conversation state lives in the
 * session — so a single tree is the intended shape.
 */
const runners = new Map<string, Runner>();

function buildRunner(mode: string): Runner {
  const cached = runners.get(mode);
  if (cached) return cached;

  const agent =
    mode === 'baseline'
      ? createBaselineAgent()
      : mode === 'graph'
        ? createPlanningGraph()
        : createOrchestrator();

  const runner = new Runner({
    agent,
    appName: APP_NAME,
    sessionService: getSessionService(),
    // Required so an approval decision resumes the suspended call.
    resumabilityConfig: createResumabilityConfig({ isResumable: true }),
  });

  runners.set(mode, runner);
  return runner;
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

  const userId = requireUserId(c);
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
  // Index it for the history sidebar. The first message becomes the title.
  await touchConversation(session.id, userId, titleFrom(message));

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

/* ------------------------------------------------------- connections */

app.get('/connections', async (c) => {
  const userId = requireUserId(c);
  return c.json({
    googleCalendar: {
      // Distinguishes "the operator has not set this up" from "you have not
      // connected yet", so the UI can explain rather than just disable a button.
      available: calendar.isConfigured(),
      connected: await calendar.isConnected(userId),
    },
  });
});

/**
 * Starts the Google consent flow.
 *
 * The session token travels in `state` because the callback is a top-level
 * browser redirect and cannot carry an Authorization header. Google returns
 * `state` untouched, and it is verified on the way back.
 */
app.get('/connect/google', (c) => {
  if (!calendar.isConfigured()) {
    return c.json({ error: 'Google Calendar is not configured on this server.' }, 503);
  }

  const token = c.req.query('token') ?? '';
  if (!verifyToken(token)) return c.json({ error: 'Sign in first.' }, 401);

  return c.redirect(calendar.buildConsentUrl(token));
});

app.get('/connect/google/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const userId = verifyToken(state ?? undefined);
  const web = optionalEnv('WEB_BASE_URL', 'http://localhost:3100');

  if (c.req.query('error')) return c.redirect(`${web}/?calendar=denied`);
  if (!code || !userId) return c.redirect(`${web}/?calendar=failed`);

  try {
    await calendar.completeConnection(code, userId);
    return c.redirect(`${web}/?calendar=connected`);
  } catch (error) {
    console.error('Google Calendar connection failed:', error);
    return c.redirect(`${web}/?calendar=failed`);
  }
});

app.delete('/connections/google', async (c) => {
  await calendar.disconnect(requireUserId(c));
  return c.json({ ok: true });
});

/* ---------------------------------------------------------------- history */

app.get('/sessions', async (c) =>
  c.json({ sessions: await listConversations(requireUserId(c)) }),
);

/**
 * Replays one conversation.
 *
 * The transcript is rebuilt from the session's stored events through the same
 * formatter the live stream uses, so history and live output cannot drift
 * apart — a reopened conversation looks exactly like it did when it ran.
 */
app.get('/sessions/:id', async (c) => {
  const userId = requireUserId(c);

  const session = await getSessionService().getSession({
    appName: APP_NAME,
    userId,
    sessionId: c.req.param('id'),
  });
  if (!session) return c.json({ error: 'not found' }, 404);

  const entries = (session.events ?? []).flatMap((event) => toTraceEntries(event));
  return c.json({ sessionId: session.id, entries });
});

app.delete('/sessions/:id', async (c) => {
  await deleteConversation(c.req.param('id'), requireUserId(c));
  // The ADK session is left in place: deleting the index entry removes it from
  // the sidebar, while the transcript stays recoverable by id.
  return c.json({ ok: true });
});

/* ------------------------------------------------------------ preferences */

app.get('/preferences', async (c) => {
  const result = await getPreferences({ userId: requireUserId(c) });
  return result.ok ? c.json(result.data) : c.json({ error: result.error }, 500);
});

app.post('/preferences', async (c) => {
  const userId = requireUserId(c);
  const body = await c.req.json<{ key?: string; value?: string }>();
  if (!body.key || !body.value) return c.json({ error: 'key and value are required' }, 400);

  const result = await savePreference({
    userId,
    key: body.key as never,
    value: body.value,
  });
  return result.ok ? c.json(result.data) : c.json({ error: result.error }, 400);
});

/* --------------------------------------------------------------- approvals */

app.get('/approvals', async (c) =>
  c.json({ approvals: await listPendingApprovals(requireUserId(c)) }),
);

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

  // An approval authorises a real-world action, so it may only be decided by
  // the person it was raised for. Without this check, knowing an id would be
  // enough to approve someone else's spending.
  if (approval.userId !== requireUserId(c)) return c.json({ error: 'not found' }, 404);

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
