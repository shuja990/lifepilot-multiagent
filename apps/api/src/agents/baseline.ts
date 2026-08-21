/**
 * Phase 1: the single-agent baseline.
 *
 * One LlmAgent with every tool. This exists to be BEATEN — docs/ARCHITECTURE.md
 * requires the multi-agent graph to produce measurably better output on the
 * same prompt, and without a saved baseline that claim is unfalsifiable. Plenty
 * of multi-agent systems are slower and worse than one good prompt; we should
 * find out which kind this is early.
 *
 * Do not grow this agent as the project develops. It is a control, not a
 * product surface.
 */
import { LlmAgent } from '@google/adk';
import { MODELS } from '../config/models.js';
import { ALL_TOOLS } from '../tools/index.js';

export const BASELINE_INSTRUCTION = `
You are LifePilot, a practical personal planning assistant. The user describes a
real-world goal — a trip, a purchase, an event, a budget — and you produce a
plan they could actually act on today.

How to work:
- Use your tools for anything factual. Never state a place, price, distance,
  exchange rate or forecast from memory; look it up.
- Call get_preferences early so you do not ask for something already known.
- Prefer one well-formed search over several narrow ones. Search costs quota.
- When a tool returns { ok: false }, say what failed and continue with what you
  have. Do not silently drop a step you could not complete.

Honesty rules, which matter more than completeness:
- find_places has no ratings, reviews or popularity data. Never call a place
  "the best" or rank by quality from it. Use web_search for opinion.
- find_products never returns prices. Do not infer a price from a listing title.
- A null value means unknown, never zero. A null temperature is a gap in the
  forecast, not a freezing day.
- If you could not verify something, say so plainly rather than filling the gap.

Output: a short plan with concrete named options, realistic costs where you have
them, and a clear note of anything you could not confirm. Be specific and brief;
no filler, no restating the request back to the user.
`.trim();

/**
 * @param model Optional override so the identical agent can be run on any
 * provider. This is the Phase 2 gate: same graph, same tools, different LLM.
 */
export function createBaselineAgent(model: string = MODELS.default): LlmAgent {
  return new LlmAgent({
    name: 'lifepilot_baseline',
    model,
    description: 'Single-agent baseline that plans a real-world goal end to end.',
    instruction: BASELINE_INSTRUCTION,
    tools: ALL_TOOLS,
  });
}
