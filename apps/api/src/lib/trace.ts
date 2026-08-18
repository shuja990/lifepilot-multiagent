/**
 * Turns the ADK event stream into something a human can follow.
 *
 * "Show users what the agents are doing" is a product requirement, not a debug
 * aid, so this lives in the API rather than in the CLI: the same formatter
 * feeds the terminal now and the SSE timeline in Phase 7. Anything added here
 * shows up in both.
 */
import type { Event } from '@google/adk';

export interface TraceEntry {
  /** Which agent emitted this — the label on the timeline card. */
  author: string;
  kind: 'text' | 'tool-call' | 'tool-result' | 'error' | 'other';
  /** Tool name, for tool-call and tool-result entries. */
  tool?: string;
  /** Arguments the model chose. This is the interesting part of a tool call. */
  args?: Record<string, unknown>;
  text?: string;
  /** Whether the tool reported success, read off our ToolResult envelope. */
  ok?: boolean;
  /** One-line digest of the result, so a timeline stays readable. */
  summary?: string;
}

/**
 * Flattens one event into zero or more trace entries.
 *
 * A single event can carry several parts (a model can request two tools at
 * once), so this returns an array rather than one entry.
 */
export function toTraceEntries(event: Event): TraceEntry[] {
  const entries: TraceEntry[] = [];
  const author = event.author ?? 'unknown';

  // Model and transport failures arrive as an error field on an otherwise empty
  // event. Dropping them produced a run that ended in 0.7s with no answer and
  // no explanation, which is the worst possible failure mode to debug.
  if (event.errorMessage) {
    entries.push({
      author,
      kind: 'error',
      ok: false,
      summary: event.errorCode ? `${event.errorCode}: ${event.errorMessage}` : event.errorMessage,
    });
  }

  const parts = event.content?.parts ?? [];

  for (const part of parts) {
    if (part.functionCall) {
      entries.push({
        author,
        kind: 'tool-call',
        tool: part.functionCall.name ?? 'unknown',
        args: (part.functionCall.args ?? {}) as Record<string, unknown>,
      });
      continue;
    }

    if (part.functionResponse) {
      const response = part.functionResponse.response as
        | { ok?: boolean; error?: string; data?: unknown }
        | undefined;
      entries.push({
        author,
        kind: 'tool-result',
        tool: part.functionResponse.name ?? 'unknown',
        ok: response?.ok !== false,
        summary: summarise(response),
      });
      continue;
    }

    if (part.text && part.text.trim()) {
      entries.push({ author, kind: 'text', text: part.text });
    }
  }

  return entries;
}

/**
 * A one-line digest of a tool result.
 *
 * Deliberately shallow: the timeline needs to show that something came back and
 * roughly how much, not to re-render the payload.
 */
function summarise(response: { ok?: boolean; error?: string; data?: unknown } | undefined): string {
  if (!response) return '(no response)';
  if (response.ok === false) return `error: ${response.error ?? 'unknown'}`;

  const data = response.data;
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    const arrayField = Object.entries(record).find(([, v]) => Array.isArray(v));
    if (arrayField) {
      return `${(arrayField[1] as unknown[]).length} ${arrayField[0]}`;
    }
    return Object.keys(record).slice(0, 4).join(', ');
  }
  return String(data ?? '').slice(0, 80);
}

/** ANSI-free rendering of one entry, for the terminal and for logs. */
export function formatTraceEntry(entry: TraceEntry): string {
  switch (entry.kind) {
    case 'tool-call': {
      const args = entry.args ? JSON.stringify(entry.args) : '{}';
      return `  -> ${entry.tool}(${truncate(args, 120)})`;
    }
    case 'tool-result':
      return `  <- ${entry.tool}: ${entry.ok ? '' : 'FAILED '}${entry.summary ?? ''}`;
    case 'error':
      return `  !! ${entry.author}: ${entry.summary ?? 'unknown error'}`;
    case 'text':
      return `[${entry.author}] ${entry.text?.trim()}`;
    default:
      return `[${entry.author}] (${entry.kind})`;
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}
