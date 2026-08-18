/**
 * The human-in-the-loop gate.
 *
 * `request_approval` is a LongRunningFunctionTool, which is the ADK-native way
 * to suspend a run: the tool returns `{ status: 'pending' }`, the event carries
 * the call id in `longRunningToolIds`, and nothing further executes until the
 * application feeds a FunctionResponse back with that same id.
 *
 * That matters more than it looks. The alternative — asking the model "shall I
 * proceed?" and reading its reply — leaves the decision inside the model's
 * context, where a persuasive turn can talk it into yes. Here the run is
 * genuinely stopped, and only a real decision written to Postgres restarts it.
 */
import { randomUUID } from 'node:crypto';
import { FunctionTool, LongRunningFunctionTool } from '@google/adk';
import type { Context } from '@google/adk';
import { ApprovalRequestSchema, CommitPlanInputSchema } from '@lifepilot/shared';
import type { ApprovalRequest, CommitPlanInput } from '@lifepilot/shared';
import { commitPlan } from '../actions/commit-plan.js';
import { createApproval, getApproval } from '../memory/approvals.js';
import { runTool } from '../lib/http.js';

/**
 * Pulls the ids needed to resume out of the tool context.
 *
 * ADK exposes these under slightly different shapes across versions, so read
 * defensively: if the session id cannot be found the approval is unresumable,
 * and it is far better to fail loudly here than to write a row that can never
 * be acted on.
 */
function readContextIds(context?: Context): {
  sessionId: string;
  invocationId: string | null;
  functionCallId: string;
} {
  const anyContext = context as unknown as
    | {
        sessionId?: string;
        invocationId?: string;
        functionCallId?: string;
        invocationContext?: { session?: { id?: string }; invocationId?: string };
      }
    | undefined;

  const sessionId =
    anyContext?.sessionId ?? anyContext?.invocationContext?.session?.id ?? '';
  const invocationId =
    anyContext?.invocationId ?? anyContext?.invocationContext?.invocationId ?? null;
  const functionCallId = anyContext?.functionCallId ?? '';

  if (!sessionId) {
    throw new Error(
      'Cannot record an approval without a session id — the run could never be resumed.',
    );
  }

  return { sessionId, invocationId, functionCallId };
}

export const requestApprovalTool = new LongRunningFunctionTool({
  name: 'request_approval',
  description:
    'Pause and ask the human to approve a consequential action BEFORE doing ' +
    'it. Required before committing a plan, sending anything, booking, or ' +
    'spending money. Write summary and details in plain language for a ' +
    'non-technical reader — they are what the person sees when deciding. ' +
    'Calling this stops your turn; you will be given their decision.',
  parameters: ApprovalRequestSchema,
  execute: async (input: ApprovalRequest, context?: Context) => {
    const parsed = ApprovalRequestSchema.parse(input);
    const { sessionId, invocationId, functionCallId } = readContextIds(context);
    const approvalId = randomUUID();

    await createApproval({
      approvalId,
      userId: parsed.userId,
      sessionId,
      // Fall back to the approval id so a row is never written without a
      // resumable handle of some kind.
      functionCallId: functionCallId || approvalId,
      invocationId,
      action: parsed.action,
      summary: parsed.summary,
      details: parsed.details,
      estimatedCost: parsed.estimatedCost,
    });

    return {
      status: 'pending',
      approvalId,
      message:
        'Waiting for human approval. Do not proceed, and do not assume the ' +
        'answer — you will be told the decision.',
    };
  },
});

/**
 * Performs the approved action.
 *
 * Deliberately separate from the approval tool: agents decide, actions execute,
 * and keeping them apart is what makes "what can this system do to the world?"
 * answerable by reading one directory.
 *
 * The gate is enforced here too, not only in the prompt. An LLM that forgets to
 * ask, or is talked out of asking, still cannot execute — the approval must
 * exist and be approved.
 */
export const commitPlanTool = new FunctionTool({
  name: 'commit_plan',
  description:
    'Commit an APPROVED plan: save it to a shareable page, generate a calendar ' +
    'file, and schedule reminders at its milestones. Requires the approvalId ' +
    'from an approved request_approval call. Never call this before approval.',
  parameters: CommitPlanInputSchema.extend({
    approvalId: ApprovalRequestSchema.shape.userId.describe(
      'The approvalId returned by request_approval, after it was approved.',
    ),
  }),
  execute: async (input: CommitPlanInput & { approvalId: string }) => {
    return runTool(async () => {
      const approval = await getApproval(input.approvalId);

      if (!approval) {
        throw new Error(`No approval found with id ${input.approvalId}.`);
      }
      if (approval.status !== 'approved') {
        throw new Error(
          `Approval ${input.approvalId} is "${approval.status}", not "approved". ` +
            'The action was not performed.',
        );
      }

      // Keyed on the approval, so one authorisation can only ever produce one
      // execution no matter how many times the model retries the call.
      return commitPlan(input, `commit_plan:${approval.approvalId}`);
    });
  },
});
