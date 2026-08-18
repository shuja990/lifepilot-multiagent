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

export const MODELS = {
  /** Every agent's default. Free tier, good function calling. */
  default: optionalEnv('GEMINI_MODEL_DEFAULT', 'gemini-flash-latest'),
  /** High-volume, low-judgement work: extraction, classification. */
  fast: optionalEnv('GEMINI_MODEL_FAST', 'gemini-flash-lite-latest'),
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
