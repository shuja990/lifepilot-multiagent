/**
 * The single place any tool talks to the outside world.
 *
 * Centralised so that timeouts, retry classification, and latency measurement
 * are identical across every provider. Phase 0 of the plan asks for real
 * per-call latency numbers for the README; `lastTimingMs` on the result is how
 * we get them without instrumenting each tool separately.
 */
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
