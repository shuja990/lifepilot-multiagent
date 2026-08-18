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
import { InMemoryRunner } from '@google/adk';
import { createBaselineAgent } from './agents/baseline.js';
import { formatTraceEntry, toTraceEntries } from './lib/trace.js';
import { requireEnv } from './config/env.js';

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

  const prompt = argv.join(' ').trim();
  if (!prompt) {
    console.error('Usage: npm run agent -- [--user <id>] [--model <provider/model>] "<your goal>"');
    process.exit(1);
  }

  // Only Gemini needs this; other providers carry their own key check.
  if (!model) requireEnv('GOOGLE_API_KEY');

  const agent = createBaselineAgent(model);
  console.log(`model: ${agent.model as string}`);
  const runner = new InMemoryRunner({ agent, appName: APP_NAME });
  const session = await runner.sessionService.createSession({ appName: APP_NAME, userId });

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
  if (failed) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
