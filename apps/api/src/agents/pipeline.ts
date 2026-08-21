/**
 * Phase 3: the agent graph.
 *
 *   Intake            reads memory, turns a vague goal into a spec
 *     |
 *   ResearchSwarm     ParallelAgent — four specialists, concurrently
 *     |
 *   PlanPipeline      SequentialAgent — recommend -> budget -> schedule
 *     |
 *   VerifyLoop        LoopAgent — critique and revise, up to 2 passes
 *     |
 *   Presenter         renders the final answer
 *
 * Models are assigned by task shape, not uniformly (docs/ARCHITECTURE.md):
 * research is high-volume and low-judgement so it runs on Groq; the planning
 * pipeline needs judgement so it runs on Gemini; and the verifier deliberately
 * runs on a DIFFERENT provider from the agents that wrote the plan, so the
 * critique is not self-confirming. That last choice is the real argument for
 * multi-provider support — not "we support many models".
 */
import { BaseAgent, LlmAgent, LoopAgent, ParallelAgent, SequentialAgent, createEvent, createEventActions } from '@google/adk';
import type { Event, InvocationContext } from '@google/adk';

import { createRoutedDefault, createRoutedFast, createRoutedVerifier } from '../config/routing.js';
import {
  currencyTool,
  geocodeTool,
  getPreferencesTool,
  placesTool,
  productsTool,
  savePreferenceTool,
  searchTool,
  weatherTool,
} from '../tools/index.js';

/** Shared across every agent, so honesty rules cannot drift between them. */
const HONESTY_RULES = `
Non-negotiable rules:
- find_places has NO ratings, reviews or popularity data. Never rank places by
  quality from it or call one "the best"; use web_search for opinion.
- find_products never returns prices. Never infer a price from a listing title.
- null means unknown, never zero. A null temperature is a gap in the forecast.
- Mark anything you could not verify as an estimate. Never present a model prior
  as an observed figure.
`.trim();

/* ------------------------------------------------------------------ intake */

const intakeAgent = new LlmAgent({
  name: 'intake',
  model: createRoutedDefault(),
  description: 'Turns a vague goal into a concrete, checkable spec.',
  instruction: `
You turn a user's goal into a specification the rest of the system can work from.

First call get_preferences to see what is already known about this user. Apply
anything relevant — home city, currency, dietary needs, travel class — without
asking again.

If the user states a NEW durable preference (not a one-off detail of this
request), call save_preference to record it.

Then output a compact spec with these headings and nothing else:
GOAL: one sentence.
GOAL_TYPE: exactly one of trip | purchase | event | budget | other. Downstream
agents skip themselves based on this, so it must be accurate.
CONSTRAINTS: budget with currency, dates, party size, hard limits. Mark anything
you had to assume as ASSUMED.
LOCATION: the place this concerns, as specifically as you can state it.
OPEN QUESTIONS: what you genuinely could not infer. Keep this short; do not
invent questions to look thorough.
`.trim(),
  tools: [getPreferencesTool, savePreferenceTool],
  outputKey: 'goal_spec',
});

/* ----------------------------------------------------------- research swarm */

const webResearchAgent = new LlmAgent({
  name: 'web_research',
  model: createRoutedFast(),
  description: 'Finds current, subjective, or ranking information on the web.',
  instruction: `
Spec:
{goal_spec}

Search the web for what this goal needs and structured data cannot answer:
opinions, rankings, current advice, typical costs, seasonal timing, caveats.

Use ONE well-formed search. Each call costs quota. Report findings as terse
bullets, each with the claim and its source URL. If sources disagree, say so
rather than picking one silently.

${HONESTY_RULES}
`.trim(),
  tools: [searchTool],
  outputKey: 'web_findings',
});

const placeResearchAgent = new LlmAgent({
  name: 'place_research',
  model: createRoutedFast(),
  description: 'Finds real, named places with addresses and distances.',
  instruction: `
Spec:
{goal_spec}

If GOAL_TYPE is "purchase" or "budget", this goal probably needs no venues.
Reply exactly "No places in scope." and stop, without calling a tool.

Otherwise find REAL places relevant to this goal using find_places — the venues,
food, lodging or landmarks it needs. Geocode the location first if ambiguous.

Report each as: name, address, distance. These come from OpenStreetMap, so you
must NOT rank them by quality or popularity — you have no such data. Present
them as verified-to-exist options, nothing more.

If the goal needs no physical places, say so in one line and stop.

${HONESTY_RULES}
`.trim(),
  tools: [placesTool, geocodeTool],
  outputKey: 'place_findings',
});

const contextAgent = new LlmAgent({
  name: 'context_research',
  model: createRoutedFast(),
  description: 'Gathers weather and currency context.',
  instruction: `
Spec:
{goal_spec}

Gather the physical and financial context:
- If the goal involves being somewhere on given dates, call get_weather and
  report what actually matters for planning (rain, heat, cold), not a full dump.
- If the budget currency differs from local prices, call convert_currency and
  give the rate you used.

Be brief. If neither applies, say so in one line.

${HONESTY_RULES}
`.trim(),
  tools: [weatherTool, currencyTool],
  outputKey: 'context_findings',
});

const priceResearchAgent = new LlmAgent({
  name: 'price_research',
  model: createRoutedFast(),
  description: 'Finds real retail listings when the goal involves buying.',
  instruction: `
Spec:
{goal_spec}

If GOAL_TYPE in the spec is not "purchase", reply exactly "No purchase in scope."
and stop. Do not call any tool. Deciding this costs a call, so decide fast.

Otherwise call find_products and list the real listings with retailer and link.

find_products NEVER returns prices. Do not state or infer one. Say the listing
must be opened to confirm price and availability.

If the goal involves no purchase, reply exactly "No purchase in scope." and stop.

${HONESTY_RULES}
`.trim(),
  tools: [productsTool],
  outputKey: 'price_findings',
});

const researchSwarm = new ParallelAgent({
  name: 'research_swarm',
  description: 'Runs four research specialists concurrently.',
  subAgents: [webResearchAgent, placeResearchAgent, contextAgent, priceResearchAgent],
});

/* ------------------------------------------------------------ plan pipeline */

const FINDINGS_BLOCK = `
Spec:
{goal_spec}

Web findings:
{web_findings}

Place findings:
{place_findings}

Context (weather, currency):
{context_findings}

Product findings:
{price_findings}
`.trim();

const recommenderAgent = new LlmAgent({
  name: 'recommender',
  model: createRoutedDefault(),
  description: 'Chooses the options worth acting on and says why.',
  instruction: `
${FINDINGS_BLOCK}

Choose the specific options worth acting on. For each, give the name, one line
on why it fits THIS goal and its constraints, and where the supporting evidence
came from (place data, web source, or your own judgement — label it).

Prefer options backed by the research above. If you recommend something the
research did not surface, mark it clearly as your own suggestion.

${HONESTY_RULES}
`.trim(),
  outputKey: 'recommendations',
});

const budgetAgent = new LlmAgent({
  name: 'budget',
  model: createRoutedDefault(),
  description: 'Builds the costing and checks it against the constraint.',
  // Arithmetic must never be creative.
  generateContentConfig: { temperature: 0 },
  instruction: `
${FINDINGS_BLOCK}

Recommendations:
{recommendations}

Build a line-item budget. For every line, mark the source as one of:
  [observed]  a real figure from the research above
  [estimate]  your own prior — the common case, and that is fine if labelled

Use convert_currency if the budget and the costs are in different currencies;
state the rate.

End with:
TOTAL: <range>
VERDICT: within budget / over budget by <amount> / cannot tell, and why.

Do not adjust numbers to make the total fit. If it does not fit, say so.

${HONESTY_RULES}
`.trim(),
  outputKey: 'budget',
});

const plannerAgent = new LlmAgent({
  name: 'planner',
  model: createRoutedDefault(),
  description: 'Turns choices and costs into a time-ordered plan.',
  instruction: `
${FINDINGS_BLOCK}

Recommendations:
{recommendations}

Budget:
{budget}

Produce a concrete, time-ordered plan the user could follow. Sequence it
sensibly, respect the weather in the context findings, and attach real addresses
where the place findings supply them.

Be specific and brief. No filler, no restating the request.

${HONESTY_RULES}
`.trim(),
  outputKey: 'plan_draft',
});

const planPipeline = new SequentialAgent({
  name: 'plan_pipeline',
  description: 'Recommend, then cost, then schedule.',
  subAgents: [recommenderAgent, budgetAgent, plannerAgent],
});

/* ------------------------------------------------------------- verify loop */

const verifierAgent = new LlmAgent({
  // Deliberately a different provider from the agents that wrote the plan, so
  // the critique cannot be self-confirming.
  name: 'verifier',
  model: createRoutedVerifier(),
  description: 'Critiques the draft plan and revises it when it fails.',
  instruction: `
Spec:
{goal_spec}

Budget:
{budget}

Draft plan:
{plan_draft}

You are the check on work someone else did. Look specifically for:
1. Constraint violations — does the total actually respect the stated budget?
2. Invented specifics — a ranking claimed from place data, a price claimed from
   a product listing, a figure presented as observed when it is an estimate.
3. Internal contradictions — outdoor plans against a thunderstorm forecast, an
   itinerary that cannot fit the time available.
4. Anything material that is missing.

If the plan is sound, reply with exactly:
PASS

Otherwise reply with:
FAIL
<one line per problem>
REVISED PLAN:
<the corrected plan in full>
`.trim(),
  outputKey: 'verdict',
});

/**
 * Stops the loop once the verifier is satisfied.
 *
 * LoopAgent has no built-in notion of "done", so the exit condition is an
 * explicit escalate signal from a tiny custom agent. Keeping it separate from
 * the verifier means the stopping rule is a plain string check, not something
 * an LLM has to be trusted to get right.
 */
class VerdictGate extends BaseAgent {
  protected async *runAsyncImpl(ctx: InvocationContext): AsyncGenerator<Event> {
    const verdict = String(ctx.session.state['verdict'] ?? '');
    const passed = verdict.trim().toUpperCase().startsWith('PASS');

    // When the verifier revised the plan, promote its revision so the next
    // iteration verifies the NEW draft rather than re-reading the old one.
    const revisionMarker = /REVISED PLAN:\s*/i;
    if (!passed && revisionMarker.test(verdict)) {
      const revised = verdict.split(revisionMarker)[1]?.trim();
      if (revised) ctx.session.state['plan_draft'] = revised;
    }

    yield createEvent({
      author: this.name,
      actions: createEventActions({ escalate: passed }),
    });
  }

  protected async *runLiveImpl(): AsyncGenerator<Event> {
    throw new Error('VerdictGate does not support live mode.');
  }
}

const verifyLoop = new LoopAgent({
  name: 'verify_loop',
  description: 'Critique and revise until the plan passes or the budget runs out.',
  // Two passes. Each iteration costs a full model call per child, and free-tier
  // quota is the binding constraint, not plan quality.
  maxIterations: 2,
  subAgents: [verifierAgent, new VerdictGate({ name: 'verdict_gate' })],
});

/* --------------------------------------------------------------- presenter */

const presenterAgent = new LlmAgent({
  name: 'presenter',
  model: createRoutedDefault(),
  description: 'Renders the final answer for the user.',
  instruction: `
Final plan:
{plan_draft}

Budget:
{budget}

Verifier verdict:
{verdict}

Present this to the user as the finished answer. Include the plan, the costs,
and a short "Not verified" section listing what remains an estimate or was left
unconfirmed.

If the verdict was not PASS, say plainly at the top what the verifier still
objects to. Do not hide it.

Write for someone acting on this today. No preamble, no restating the request.
`.trim(),
});

/* -------------------------------------------------------------------- root */

/**
 * Seed state for every session.
 *
 * ADK resolves `{placeholders}` in instructions against session state and
 * throws "Context variable not found" if a key is absent. Without these seeds a
 * single failed research branch takes down every downstream agent — one Groq
 * 429 in the swarm ended the whole run, even though three siblings had
 * succeeded. Seeding turns that into a degraded plan, which is the behaviour a
 * ParallelAgent fan-out is supposed to have.
 */
export const INITIAL_STATE: Record<string, string> = {
  goal_spec: '(not produced)',
  web_findings: '(no web research available)',
  place_findings: '(no place research available)',
  context_findings: '(no weather or currency context available)',
  price_findings: '(no product research available)',
  recommendations: '(none)',
  budget: '(no budget produced)',
  plan_draft: '(no plan produced)',
  verdict: '(not verified)',
};

export function createPlanningGraph(): SequentialAgent {
  return new SequentialAgent({
    name: 'lifepilot_graph',
    description: 'Multi-agent planner: intake, parallel research, plan, verify, present.',
    subAgents: [intakeAgent, researchSwarm, planPipeline, verifyLoop, presenterAgent],
  });
}
