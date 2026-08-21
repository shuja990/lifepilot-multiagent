/**
 * The orchestrator — the agent that decides which agents run.
 *
 * Until now the root was a SequentialAgent: a fixed pipeline whose control flow
 * lived in TypeScript, so every request paid for every stage. "What is 5,000
 * USD in yen?" ran intake, four parallel research agents, a three-stage
 * planning pipeline and a verification loop to produce one number.
 *
 * The tell that this was wrong was in the prompts: price_research and
 * place_research both carried "if this does not apply, say so and stop"
 * escape hatches. That is a routing decision being made one level too low, by
 * an LLM call we already paid for.
 *
 * This is a real LlmAgent with sub-agents, so ADK's delegation applies: the
 * model reads the request and transfers to the specialist that fits. Routing
 * is now a decision, not a straight line.
 *
 * The deterministic pipeline did not go away — it is one of the destinations.
 * Predictability is worth keeping where the work genuinely needs every stage.
 */
import { LlmAgent } from '@google/adk';
import { createRoutedFast } from '../config/routing.js';
import { ALL_TOOLS } from '../tools/index.js';
import { commitPlanTool, requestApprovalTool } from '../tools/approval.js';
import { createPlanningGraph } from './pipeline.js';

/**
 * The fast path: one agent, all tools, no pipeline.
 *
 * For questions that need a lookup and an answer rather than a plan. This is
 * deliberately the same shape as the Phase 1 baseline, because for this class
 * of request the baseline was already the right architecture.
 */
export function createQuickAnswerAgent(): LlmAgent {
  return new LlmAgent({
    name: 'quick_answer',
    // Flash-Lite: a lookup and a short answer needs speed, not deliberation.
    model: createRoutedFast(),
    description:
      'Answers a single factual or lookup question directly using tools: a ' +
      'conversion, a forecast, one place lookup, one search, or reading and ' +
      'saving user preferences. Use when the user wants an ANSWER, not a plan.',
    instruction: `
Answer the question directly using your tools. Look things up rather than
recalling them.

Keep it short — a sentence or a few bullets. Do not produce an itinerary, a
budget breakdown, or a multi-step plan; if the request actually needs one, say
so in one line instead of half-building it.

Rules that do not bend:
- find_places has no ratings or reviews. Never rank places by quality from it.
- find_products never returns prices. Never infer one from a title.
- null means unknown, never zero.
- Say plainly when you could not verify something.
`.trim(),
    tools: ALL_TOOLS,
  });
}

/**
 * The only agent allowed to change anything outside this process.
 *
 * Separated from the planners on purpose: everything upstream reads and
 * reasons, and exactly one agent acts. That boundary is what makes the blast
 * radius reviewable — the answer to "what can this system do to the world?"
 * is this agent's tool list.
 */
export function createCommitAgent(): LlmAgent {
  return new LlmAgent({
    name: 'commit_agent',
    model: createRoutedFast(),
    description:
      'Saves, commits or schedules a plan the user already has, and asks for ' +
      'approval before doing anything consequential. Use when the user says ' +
      'save this, commit it, schedule it, or remind me.',
    instruction: `
You perform actions that affect the real world. You do not plan; the plan
already exists in the conversation.

Always call request_approval FIRST. Never act before a human has approved.

Write summary and details for a non-technical reader deciding whether to let
this happen: what will be saved, what reminders will fire and when, and what it
costs. No jargon, no internal identifiers.

Calling request_approval ends your turn. Do not guess the decision, do not
proceed hopefully, and do not call commit_plan in the same turn.

Once you are told the decision:
- approved: call commit_plan with the approvalId, then report the shareable link
  and the reminders that were scheduled.
- rejected: say so plainly, repeat the reason given, and change nothing.

Milestone times must be real ISO-8601 instants in the future. If you do not know
a real date, do not invent one — say which one you need.
`.trim(),
    tools: [requestApprovalTool, commitPlanTool],
  });
}

export const ORCHESTRATOR_INSTRUCTION = `
You are LifePilot's orchestrator. You do not answer the user yourself. Your only
job is to hand the request to the right specialist.

Choose one:

**quick_answer** — the user wants a fact or a single lookup. A currency
conversion, a weather check, "find me a pharmacy near X", one web search,
recording or recalling a preference. The answer is a sentence, not a plan.

**commit_agent** — the user wants something SAVED, committed, scheduled, sent
or booked. Anything with a real-world effect. This path always asks for human
approval before acting.

**lifepilot_graph** — the user wants something planned, compared, costed or
scheduled. A trip, an event, a purchase decision, a budget. It needs research
from several angles, a costing, an ordered plan, and checking. This path is
thorough and slow, so send work here because it needs the depth, not because
you are unsure.

Rules:
- Transfer immediately. Do not ask a clarifying question first and do not
  research before deciding — deciding is your entire job.
- When genuinely torn, prefer quick_answer. It can say "this needs a full plan",
  which costs one cheap call; the reverse mistake runs a dozen agents to answer
  a one-line question.
- Never answer the user directly, even when the answer seems obvious to you.
`.trim();

/**
 * The root agent.
 *
 * Note the cost asymmetry driving the tie-break rule above: delegating to
 * quick_answer when the graph was needed wastes one small call, while
 * delegating to the graph when quick_answer would do runs roughly a dozen
 * agents and, on a free tier, is what actually exhausts the daily quota.
 */
export function createOrchestrator(): LlmAgent {
  return new LlmAgent({
    name: 'lifepilot',
    /**
     * Flash-Lite, deliberately.
     *
     * Routing is classification — pick one of two labels — which is the task
     * Lite is built for. It is also the most frequent call in the system, since
     * every single request pays for it, so putting the heavyweight model here
     * would tax everything to decide something a small model gets right.
     */
    model: createRoutedFast(),
    description: 'Routes a user goal to the specialist best suited to it.',
    instruction: ORCHESTRATOR_INSTRUCTION,
    subAgents: [createQuickAnswerAgent(), createCommitAgent(), createPlanningGraph()],
  });
}
