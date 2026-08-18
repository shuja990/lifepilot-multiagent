/**
 * Run an agent from the terminal and watch what it does.
 *
 *   npm run agent -- "plan a weekend in Islamabad under 20000 PKR"
 *   npm run agent -- --user shuja "help me buy noise cancelling headphones"
 *
 * Prints the live event stream (tool calls, arguments, results) followed by the
 * final answer, plus wall-clock time and a tool-call count. Those last two are
 * the numbers Phase 3 needs to compare the agent graph against this baseline.
 */
import { Runner } from '@google/adk';
import { createBaselineAgent } from './agents/baseline.js';
import { INITIAL_STATE, createPlanningGraph } from './agents/pipeline.js';
import { createOrchestrator } from './agents/orchestrator.js';
import { formatTraceEntry, toTraceEntries } from './lib/trace.js';
import { requireEnv } from './config/env.js';
import { MODELS } from './config/models.js';
import { closeStores, getSessionService, isPersistent } from './memory/stores.js';

const APP_NAME = 'lifepilot';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  let userId = 'demo-user';
  const userFlag = argv.indexOf('--user');
  if (userFlag !== -1) {
    userId = argv[userFlag + 1] ?? userId;
    argv.splice(userFlag, 2);
  }

  // --model runs the identical agent on another provider: the Phase 2 gate.
  let model: string | undefined;
  const modelFlag = argv.indexOf('--model');
  if (modelFlag !== -1) {
    model = argv[modelFlag + 1];
    argv.splice(modelFlag, 2);
  }

  // Default is the orchestrator — the whole system, routing included.
  // --graph forces the deterministic pipeline, which is what the Phase 3
  // comparison against the baseline measures.
  // --baseline is the Phase 1 control.
  const useGraph = argv.includes('--graph');
  if (useGraph) argv.splice(argv.indexOf('--graph'), 1);
  const useBaseline = argv.includes('--baseline');
  if (useBaseline) argv.splice(argv.indexOf('--baseline'), 1);

  // --session resumes an existing conversation instead of starting one.
  let sessionId: string | undefined;
  const sessionFlag = argv.indexOf('--session');
  if (sessionFlag !== -1) {
    sessionId = argv[sessionFlag + 1];
    argv.splice(sessionFlag, 2);
  }

  const prompt = argv.join(' ').trim();
  if (!prompt) {
    console.error('Usage: npm run agent -- [--user <id>] [--model <m>] [--graph|--baseline] "<goal>"');
    process.exit(1);
  }

  // Only Gemini needs this; other providers carry their own key check.
  if (!model) requireEnv('GOOGLE_API_KEY');

  const agent = useBaseline
    ? createBaselineAgent(model)
    : useGraph
      ? createPlanningGraph()
      : createOrchestrator();
  console.log(
    useBaseline
      ? `agent: baseline (${model ?? MODELS.default})`
      : useGraph
        ? 'agent: deterministic pipeline'
        : 'agent: orchestrator',
  );
  const sessionService = getSessionService();
  const runner = new Runner({ agent, appName: APP_NAME, sessionService });
  console.log(`sessions: ${isPersistent() ? 'postgres' : 'in-memory'}`);

  const session =
    (sessionId
      ? await sessionService.getSession({ appName: APP_NAME, userId, sessionId })
      : undefined) ??
    (await sessionService.createSession({
      appName: APP_NAME,
      userId,
      // Seeded so one failed branch degrades the plan instead of breaking every
      // downstream instruction template.
      ...(useBaseline ? {} : { state: { ...INITIAL_STATE } }),
    }));

  if (sessionId && session.id !== sessionId) {
    console.log(`(session ${sessionId} not found — started a new one)`);
  }
  console.log(`session: ${session.id}`);

  console.log(`\n> ${prompt}\n`);

  const started = Date.now();
  let toolCalls = 0;
  let finalText = '';
  let failed = false;

  for await (const event of runner.runAsync({
    userId,
    sessionId: session.id,
    newMessage: {
      role: 'user',
      // The agent needs the user id to read and write preferences, and the model
      // cannot know it otherwise.
      parts: [{ text: `${prompt}\n\n(Your user_id for preference tools is "${userId}".)` }],
    },
  })) {
    for (const entry of toTraceEntries(event)) {
      if (entry.kind === 'tool-call') toolCalls += 1;
      if (entry.kind === 'error') failed = true;
      if (entry.kind === 'text') {
        finalText = entry.text ?? finalText;
        continue; // hold the prose back so the trace stays readable
      }
      console.log(formatTraceEntry(entry));
    }
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  console.log(`\n${'-'.repeat(70)}\n`);
  console.log(finalText.trim() || '(no final answer)');
  console.log(`\n${'-'.repeat(70)}`);
  console.log(`${elapsed}s, ${toolCalls} tool calls`);
  // Release DB handles, or the process lingers with the event loop held open.
  await closeStores();

  // Exit explicitly. Pooled database connections can still hold the event loop
  // even after close(), and a CLI that prints its answer and then hangs is a
  // worse bug than a slightly blunt exit.
  process.exit(failed ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
