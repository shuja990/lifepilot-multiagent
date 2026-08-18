/**
 * Phase 4: model routing and quota failover.
 *
 * Built ahead of schedule because Phase 3 needed it. `gemini-flash-latest`
 * started returning 503 "experiencing high demand" on consecutive runs, which
 * killed the graph at its first agent — every downstream instruction then
 * failed with "Context variable not found: goal_spec". A free-tier model being
 * briefly unavailable is not an edge case, it is Tuesday, and a demo that dies
 * when it happens is not a demo.
 *
 * Failover is a property of RoutedLlm, not something we hand-roll: ADK re-calls
 * the router with `errorContext.failedKeys` when a model fails before yielding,
 * so the router just has to pick something it has not already tried.
 */
import { Gemini, RoutedLlm } from '@google/adk';

/**
 * IMPORTANT: `modelName` must be a REAL Gemini model id, never a friendly label.
 *
 * RoutedLlm exposes modelName as its `.model`, LlmAgent copies that onto
 * `llmRequest.model`, and the Gemini class sends it verbatim to the API. A
 * descriptive name like "routed(gemini-flash-latest)" therefore comes back as
 *
 *   400 GenerateContentRequest.model: unexpected model name format
 *
 * on EVERY Gemini call, silently pushing all traffic onto the fallback provider
 * until that one rate-limits too. It looks exactly like a Gemini outage.
 *
 * Our OpenAI-compatible adapter is immune because it uses the model id from its
 * own constructor and ignores llmRequest.model — which is why a Gemini id is
 * the safe choice even when a non-Gemini provider is primary.
 */
import type { BaseLlm, LlmRouter } from '@google/adk';
import { OpenAICompatibleLlm } from '../models/openai-compatible.js';
import { MODELS } from './models.js';
import { optionalEnv } from './env.js';

/**
 * Ordered preference. The router walks this list and returns the first key it
 * has not already tried, so adding a tier is a one-line change.
 */
function buildFallbackChain(primary: BaseLlm): Record<string, BaseLlm> {
  const models: Record<string, BaseLlm> = { primary };

  // Same-provider fallback FIRST. Quotas are per-model, so Flash-Lite is often
  // healthy when Flash is throttled, and it shares Gemini's large context
  // window. Reaching for another provider first was actively worse: the late
  // pipeline agents carry the full research findings, and Groq rejected them
  // outright with 413 "Request too large" against its 8,000-token ceiling.
  models['gemini_lite'] = new Gemini({ model: MODELS.fast });

  // Groq is deliberately NOT in this chain. Agents on the default tier carry
  // the full research findings — 10-12k tokens — and Groq's free tier caps a
  // single request at 8,000, so it answered every failover with
  // 413 "Request too large". A fallback that structurally cannot serve the
  // request is worse than no fallback: it converts a clear quota error into a
  // confusing size error and hides which provider actually ran out.
  //
  // Match the fallback to the agent's context size. DeepSeek has the room.
  if (optionalEnv('DEEPSEEK_API_KEY')) {
    models['deepseek'] = new OpenAICompatibleLlm({ model: MODELS.deepseek });
  }

  return models;
}

/**
 * Try primary, then each configured fallback in order, then give up.
 *
 * Returning undefined stops the retry loop and propagates the last error —
 * important, because retrying forever on a bad request looks like a hang.
 */
const failoverRouter: LlmRouter = (models, _request, errorContext) => {
  const order = ['primary', 'gemini_lite', 'deepseek'];

  if (!errorContext) return 'primary';

  for (const key of order) {
    if (models[key] && !errorContext.failedKeys.has(key)) return key;
  }
  return undefined;
};

/**
 * The default model for judgement work: Gemini Flash, with automatic failover.
 *
 * Note this changes which provider answers, not just whether it answers. When
 * the verifier is meant to run on a different provider from the author, check
 * that the failover has not collapsed both onto the same one.
 */
export function createRoutedDefault(): RoutedLlm {
  const primary = new Gemini({ model: MODELS.default });
  return new RoutedLlm({
    models: buildFallbackChain(primary),
    router: failoverRouter,
    modelName: MODELS.default,
  });
}

/**
 * The fan-out tier, used by the four parallel research agents.
 *
 * Gemini Flash-Lite is primary here, NOT Groq, and that is a measured decision
 * rather than a preference. Groq's free tier caps at 8,000 tokens per minute;
 * four research agents firing at once blew straight through it and three of the
 * four came back 429 on their first turn, leaving the planner to work from
 * model priors instead of research. Gemini's free tier is limited per day
 * rather than per minute, which is the shape that survives a burst.
 *
 * Groq stays as the fallback, so a Gemini outage still has somewhere to go.
 */
export function createRoutedFast(): RoutedLlm {
  const models: Record<string, BaseLlm> = {
    primary: new Gemini({ model: MODELS.fast }),
  };
  if (optionalEnv('GROQ_API_KEY')) {
    models['groq'] = new OpenAICompatibleLlm({ model: MODELS.groq });
  }

  return new RoutedLlm({
    models,
    router: orderedRouter(['primary', 'groq']),
    modelName: MODELS.fast,
  });
}

/**
 * The verifier tier: a provider deliberately DIFFERENT from the one that wrote
 * the plan, so the critique cannot be self-confirming.
 *
 * Groq is primary precisely because the planning pipeline runs on Gemini. The
 * verifier is a single sequential agent, not a fan-out, so it does not hit the
 * TPM ceiling that pushed the research swarm off Groq.
 *
 * If GROQ_API_KEY is absent this collapses back to Gemini and the independence
 * property is lost — worth knowing when reading a verdict.
 */
export function createRoutedVerifier(): RoutedLlm {
  const models: Record<string, BaseLlm> = {};

  if (optionalEnv('GROQ_API_KEY')) {
    models['primary'] = new OpenAICompatibleLlm({ model: MODELS.groq });
    models['gemini'] = new Gemini({ model: MODELS.default });
  } else {
    models['primary'] = new Gemini({ model: MODELS.default });
  }

  return new RoutedLlm({
    models,
    router: orderedRouter(['primary', 'gemini']),
    // A Gemini id even though Groq is primary: the adapter ignores this field,
    // and the Gemini fallback needs it to be valid.
    modelName: MODELS.default,
  });
}

/** Walks an ordered list, skipping anything already tried. */
function orderedRouter(order: string[]): LlmRouter {
  return (available, _request, errorContext) => {
    if (!errorContext) return order[0];
    for (const key of order) {
      if (available[key] && !errorContext.failedKeys.has(key)) return key;
    }
    return undefined;
  };
}

export { failoverRouter };
