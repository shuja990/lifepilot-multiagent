/**
 * The ONLY place model names live.
 *
 * A project rule from docs/PLAN.md: any agent hardcoding a model string is a
 * bug. Routing policy lands here too (Phase 4), so the answer to "which model
 * ran this?" is always one file.
 */
import { LLMRegistry } from '@google/adk';
import { OpenAICompatibleLlm } from '../models/openai-compatible.js';
import { envFlag, optionalEnv } from './env.js';

/**
 * Register the OpenAI-compatible adapter once, at import.
 *
 * After this, any agent can take `model: 'groq/openai/gpt-oss-120b'` as a
 * plain string and ADK resolves it through our BaseLlm implementation — the
 * same ergonomics Gemini gets natively.
 */
LLMRegistry.register(OpenAICompatibleLlm);

/**
 * Model ids are PINNED, never `-latest`.
 *
 * `gemini-flash-latest` resolved to `gemini-3.7-flash`, whose free tier allows
 * 20 requests per DAY — not the ~1,500 the plan was costed against. The alias
 * had quietly drifted onto the newest premium model, and the only symptom was
 * the whole system 429ing after a handful of runs and blaming "quota".
 *
 * Same lesson as pinning the ADK version: a moving alias is not a dependency
 * you control. Re-check deliberately, do not inherit silently.
 */
export const MODELS = {
  /** Every agent's default. Free tier, good function calling. */
  default: optionalEnv('GEMINI_MODEL_DEFAULT', 'gemini-3.6-flash'),
  /** High-volume, low-judgement work: extraction, classification. */
  fast: optionalEnv('GEMINI_MODEL_FAST', 'gemini-3.5-flash-lite'),
  /**
   * Non-Gemini tiers. Empty keys make these inert rather than broken: the
   * adapter reports a missing key as a response, so a run degrades instead of
   * crashing and Phase 4 routing can fail over.
   */
  groq: optionalEnv('GROQ_MODEL', 'groq/openai/gpt-oss-120b'),
  deepseek: optionalEnv('DEEPSEEK_MODEL', 'deepseek/deepseek-chat'),
} as const;

/**
 * Guard rail. When false the router must never select a paid premium model,
 * whatever the routing policy says. Stays false for the public demo.
 */
export const PREMIUM_ENABLED = envFlag('PREMIUM_ENABLED', false);

/**
 * Gemini's free tier is Flash-class only — Pro moved to paid-only around April
 * 2026. If an agent only behaves on Pro, that is a prompt problem, not a model
 * problem, and it should be fixed rather than escalated.
 */
export const FREE_TIER_NOTE =
  'Gemini free tier is Flash/Flash-Lite only; ~1,500 requests/day.';
