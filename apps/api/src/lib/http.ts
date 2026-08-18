/**
 * The single place any tool talks to the outside world.
 *
 * Centralised so that timeouts and retry classification are identical across
 * every provider, and so that every failure shape is normalised in exactly one
 * place before it reaches an agent.
 */
import { ZodError } from 'zod';
import { MissingEnvError } from '../config/env.js';
import type { ToolError, ToolResult } from '@lifepilot/shared';

export interface FetchJsonOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Status codes where trying again later is reasonable. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * Carries an already-formed ToolError across a throw.
 *
 * Tools that compose other tools (places -> geocode, products -> search) must
 * not flatten an inner failure into `new Error(result.error)`: that discards
 * `missingEnv` and `retryable`, so a missing API key stops telling you which
 * key, and a transient 429 starts looking permanent to a retry supervisor.
 */
export class ToolFailure extends Error {
  constructor(public readonly toolError: ToolError) {
    super(toolError.error);
    this.name = 'ToolFailure';
  }
}

export async function fetchJson<T>(url: string, options: FetchJsonOptions = {}): Promise<T> {
  const { method = 'GET', headers = {}, body, timeoutMs = 10_000 } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method,
      headers: {
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });

    if (!response.ok) {
      // Providers put the useful part of the message in the body, not the status.
      const detail = await response.text().catch(() => '');
      throw new HttpError(
        `HTTP ${response.status} from ${new URL(url).host}${detail ? `: ${detail.slice(0, 300)}` : ''}`,
        response.status,
        isRetryableStatus(response.status),
      );
    }

    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new HttpError(`Request to ${new URL(url).host} timed out after ${timeoutMs}ms`, 408, true);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wraps a tool body so it always resolves to the ToolResult envelope.
 *
 * Tools must not throw across the agent boundary — an LLM recovers from
 * `{ ok: false, error }` far better than a ParallelAgent branch recovers from
 * an exception.
 */
export async function runTool<T>(fn: () => Promise<T>): Promise<ToolResult<T>> {
  try {
    const data = await fn();
    return { ok: true, data };
  } catch (error) {
    return toToolError(error);
  }
}

export function toToolError(error: unknown): ToolError {
  // Already normalised by an inner tool - pass it through with its fields intact.
  if (error instanceof ToolFailure) return error.toolError;

  if (error instanceof ZodError) {
    // Zod's default message is a multi-line JSON dump. At an LLM boundary that
    // is expensive and hard to act on, so collapse it to one line per issue.
    const issues = error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return { ok: false, error: `Invalid arguments - ${issues}`, retryable: false };
  }

  if (error instanceof MissingEnvError) {
    return {
      ok: false,
      error: `${error.variable} is not set. Add it to .env — see .env.example for where to get a free key.`,
      missingEnv: error.variable,
      retryable: false,
    };
  }
  if (error instanceof HttpError) {
    return { ok: false, error: error.message, retryable: error.retryable };
  }
  if (error instanceof Error) {
    return { ok: false, error: error.message, retryable: false };
  }
  return { ok: false, error: String(error), retryable: false };
}
