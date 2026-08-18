/**
 * Environment access.
 *
 * Keys are read lazily, never at import time. A missing GEOAPIFY_API_KEY must
 * not stop the weather tool from running — that would make local development
 * an all-or-nothing affair and would break the ParallelAgent research fan-out,
 * where one unconfigured branch should degrade rather than take down the run.
 */
import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
/** repo root: apps/api/src/config -> ../../../.. */
export const repoRoot = path.resolve(here, '../../../..');

loadDotenv({ path: path.join(repoRoot, '.env') });

/**
 * Gemini key aliasing.
 *
 * The TypeScript SDK reads GOOGLE_GENAI_API_KEY or GEMINI_API_KEY, while the
 * Python ADK and most Google docs say GOOGLE_API_KEY. That mismatch fails at
 * the first model call with an error that names neither variable the user set,
 * so accept all three spellings and normalise here, once.
 */
for (const alias of ['GOOGLE_GENAI_API_KEY', 'GEMINI_API_KEY'] as const) {
  if (!process.env[alias]?.trim() && process.env['GOOGLE_API_KEY']?.trim()) {
    process.env[alias] = process.env['GOOGLE_API_KEY'];
  }
}

/** Thrown when a tool is invoked without the key it needs. */
export class MissingEnvError extends Error {
  constructor(public readonly variable: string) {
    super(`Missing required environment variable: ${variable}`);
    this.name = 'MissingEnvError';
  }
}

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new MissingEnvError(name);
  return value;
}

export function optionalEnv(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback;
}

export function envFlag(name: string, fallback = false): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes';
}

/** Directory for the file-backed dev stores. Replaced by Postgres in Phase 5. */
export const dataDir = path.join(repoRoot, '.data');
