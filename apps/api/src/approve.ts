/**
 * The other half of the approval gate: deciding, and resuming.
 *
 *   npm run approve -- list
 *   npm run approve -- approve <approvalId>
 *   npm run approve -- reject  <approvalId> "too expensive"
 *
 * This is deliberately a SEPARATE process from the one that requested the
 * approval. If a decision can only be made by the process that asked, the
 * feature does not survive a restart, a deploy, or the user closing the tab —
 * and then the pause was never real. Everything needed to resume comes out of
 * Postgres.
 *
 * Phase 7 puts an HTTP endpoint in front of exactly this logic.
 */
import { Runner, createResumabilityConfig } from '@google/adk';
import { createOrchestrator } from './agents/orchestrator.js';
import { INITIAL_STATE } from './agents/pipeline.js';
import { formatTraceEntry, toTraceEntries } from './lib/trace.js';
import {
  closeApprovalStore,
  decideApproval,
  getApproval,
  listPendingApprovals,
} from './memory/approvals.js';
import { closeStores, getSessionService } from './memory/stores.js';

const APP_NAME = 'lifepilot';

async function list(userId?: string): Promise<void> {
  const pending = await listPendingApprovals(userId);

  if (pending.length === 0) {
    console.log('No approvals waiting.');
    return;
  }

  for (const approval of pending) {
    console.log(`\n${approval.approvalId}`);
    console.log(`  action  : ${approval.action}`);
    console.log(`  user    : ${approval.userId}`);
    console.log(`  summary : ${approval.summary}`);
    console.log(`  cost    : ${approval.estimatedCost ?? '(none stated)'}`);
    console.log(`  asked   : ${approval.createdAt}`);
    console.log(`  details :\n${indent(approval.details)}`);
  }
  console.log(`\n${pending.length} waiting.`);
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

async function decide(
  approvalId: string,
  status: 'approved' | 'rejected',
  reason?: string,
): Promise<void> {
  const approval = await getApproval(approvalId);
  if (!approval) {
    console.error(`No approval with id ${approvalId}.`);
    process.exitCode = 1;
    return;
  }

  // Compare-and-set. A second decision changes nothing and says so, rather than
  // silently overwriting the first — which is what a double-click looks like.
  const changed = await decideApproval(approvalId, status, reason);
  if (!changed) {
    console.error(
      `Approval ${approvalId} was already "${approval.status}". Nothing changed.`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(`Recorded: ${status}${reason ? ` (${reason})` : ''}`);
  console.log('Resuming the agent run...\n');

  const sessionService = getSessionService();
  const runner = new Runner({
    agent: createOrchestrator(),
    appName: APP_NAME,
    sessionService,
    // Without this, ADK will not route a function response back into the
    // suspended call and the run restarts instead of resuming.
    resumabilityConfig: createResumabilityConfig({ isResumable: true }),
  });

  const session =
    (await sessionService.getSession({
      appName: APP_NAME,
      userId: approval.userId,
      sessionId: approval.sessionId,
    })) ??
    (await sessionService.createSession({
      appName: APP_NAME,
      userId: approval.userId,
      state: { ...INITIAL_STATE },
    }));

  let finalText = '';

  for await (const event of runner.runAsync({
    userId: approval.userId,
    sessionId: session.id,
    newMessage: {
      role: 'user',
      parts: [
        {
          functionResponse: {
            // The SAME id the tool call carried. This is what tells ADK which
            // suspended call is being answered; a fresh id starts a new turn.
            id: approval.functionCallId,
            name: 'request_approval',
            response: {
              status,
              approvalId,
              ...(reason ? { reason } : {}),
            },
          },
        },
      ],
    },
  })) {
    for (const entry of toTraceEntries(event)) {
      if (entry.kind === 'text') {
        finalText = entry.text ?? finalText;
        continue;
      }
      console.log(formatTraceEntry(entry));
    }
  }

  console.log(`\n${'-'.repeat(70)}\n`);
  console.log(finalText.trim() || '(no final answer)');
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case 'list':
      await list(args[0]);
      break;
    case 'approve':
      if (!args[0]) throw new Error('Usage: approve <approvalId>');
      await decide(args[0], 'approved', args.slice(1).join(' ') || undefined);
      break;
    case 'reject':
      if (!args[0]) throw new Error('Usage: reject <approvalId> <reason>');
      await decide(args[0], 'rejected', args.slice(1).join(' ') || 'no reason given');
      break;
    default:
      console.log('Usage: npm run approve -- <list|approve|reject> [args]');
      console.log('  list [userId]');
      console.log('  approve <approvalId>');
      console.log('  reject  <approvalId> <reason>');
  }
}

main()
  .then(async () => {
    await closeApprovalStore();
    await closeStores();
    process.exit(process.exitCode ?? 0);
  })
  .catch(async (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    await closeApprovalStore();
    await closeStores();
    process.exit(1);
  });
