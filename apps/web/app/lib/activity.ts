/**
 * Turns the agent event stream into human sentences.
 *
 * The stream is engineering output: `transfer_to_agent`, argument objects,
 * internal agent names. Showing that raw was a category error — it is the
 * inside of the machine, not a report to the person using it.
 *
 * So each event becomes a plain sentence about what is happening ("Checking the
 * weather in Islamabad"), the raw payload stays available behind a toggle for
 * anyone who wants it, and pure plumbing is dropped entirely.
 *
 * The transparency requirement is still met — arguably better. "Searching the
 * web for bus fares" tells a non-technical user more about what the system is
 * doing than `web_search({"query":"..."})` ever did.
 */

export interface RawEntry {
  author: string;
  kind: 'text' | 'tool-call' | 'tool-result' | 'error' | 'other' | 'user';
  tool?: string;
  args?: Record<string, unknown>;
  text?: string;
  ok?: boolean;
  summary?: string;
}

export interface Activity {
  id: string;
  type: 'user' | 'answer' | 'step' | 'error' | 'handoff';
  /** The sentence shown to the user. */
  label: string;
  /** Secondary detail, e.g. what came back. */
  detail?: string;
  /** Full markdown, for answers. */
  text?: string;
  /** Raw payload, revealed only by the details toggle. */
  raw?: unknown;
  ok?: boolean;
  agent?: string;
}

/** Internal agent names are not product language. */
const AGENT_LABELS: Record<string, string> = {
  lifepilot: 'LifePilot',
  quick_answer: 'Quick answer',
  commit_agent: 'Saving',
  lifepilot_graph: 'Full planning',
  intake: 'Understanding your goal',
  research_swarm: 'Research',
  web_research: 'Searching the web',
  place_research: 'Finding places',
  context_research: 'Weather and currency',
  price_research: 'Product research',
  plan_pipeline: 'Planning',
  recommender: 'Choosing options',
  budget: 'Working out costs',
  planner: 'Building the plan',
  verify_loop: 'Checking',
  verifier: 'Checking the work',
  presenter: 'Writing it up',
  lifepilot_baseline: 'LifePilot',
  user: 'You',
  system: 'System',
};

export function agentLabel(name: string): string {
  return AGENT_LABELS[name] ?? name.replace(/_/g, ' ');
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function num(value: unknown): string | undefined {
  return typeof value === 'number' ? value.toLocaleString() : undefined;
}

/**
 * A sentence for a tool call, built from the arguments the model chose.
 *
 * The arguments are the interesting part — "Finding cafes near Islamabad" is
 * only useful because it names the category and the place.
 */
function describeCall(tool: string, args: Record<string, unknown> = {}): string {
  switch (tool) {
    case 'get_weather': {
      const place = str(args['location']) ?? 'the destination';
      const days = args['days'];
      return typeof days === 'number'
        ? `Checking the ${days}-day forecast for ${place}`
        : `Checking the weather in ${place}`;
    }
    case 'convert_currency': {
      const amount = num(args['amount']);
      const from = str(args['from']);
      const to = str(args['to']);
      return from && to
        ? `Converting ${amount ? `${amount} ` : ''}${from} to ${to}`
        : 'Converting currency';
    }
    case 'find_places': {
      const category = str(args['category'])?.replace(/_/g, ' ');
      const near = str(args['near']);
      return category && near
        ? `Finding ${category}s near ${near}`
        : `Finding places${near ? ` near ${near}` : ''}`;
    }
    case 'geocode':
      return `Locating ${str(args['query']) ?? 'the place'}`;
    case 'web_search': {
      const query = str(args['query']);
      return query ? `Searching the web for “${query}”` : 'Searching the web';
    }
    case 'find_products': {
      const query = str(args['query']);
      return query ? `Looking up listings for “${query}”` : 'Looking up product listings';
    }
    case 'get_preferences':
      return 'Recalling what you have told me before';
    case 'save_preference': {
      const key = str(args['key'])?.replace(/_/g, ' ');
      const value = str(args['value']);
      return key && value ? `Remembering that your ${key} is ${value}` : 'Saving a preference';
    }
    case 'request_approval':
      return 'Asking for your approval';
    case 'commit_plan':
      return `Saving “${str(args['title']) ?? 'your plan'}”`;
    default:
      return tool.replace(/_/g, ' ');
  }
}

/** A short sentence for what came back, from the tool's own summary. */
function describeResult(tool: string, summary: string | undefined, ok: boolean): string {
  if (!ok) return summary ? `Could not complete — ${summary}` : 'Could not complete';

  const count = /^(\d+)\s+(\w+)/.exec(summary ?? '');
  if (count) {
    const [, n, noun] = count;
    const number = Number(n);
    const label = noun === 'days' ? 'day forecast' : (noun ?? 'results');
    return number === 1 ? `Found 1 ${label.replace(/s$/, '')}` : `Found ${number} ${label}`;
  }

  switch (tool) {
    case 'convert_currency':
      return 'Got the exchange rate';
    case 'geocode':
      return 'Located it';
    case 'get_preferences':
      return 'Loaded your preferences';
    case 'save_preference':
      return 'Saved';
    case 'commit_plan':
      return 'Saved and scheduled';
    default:
      return 'Done';
  }
}

let counter = 0;
function nextId(): string {
  counter += 1;
  return `a${counter}`;
}

/**
 * Folds raw entries into the activity list.
 *
 * Tool results are merged into the call they answer rather than becoming their
 * own row, which halves the length of the feed and keeps cause next to effect.
 */
export function toActivities(entries: RawEntry[]): Activity[] {
  const activities: Activity[] = [];

  for (const entry of entries) {
    if (entry.kind === 'user') {
      activities.push({ id: nextId(), type: 'user', label: entry.text ?? '', text: entry.text });
      continue;
    }

    if (entry.kind === 'error') {
      activities.push({
        id: nextId(),
        type: 'error',
        label: 'Something went wrong',
        detail: entry.summary,
        agent: agentLabel(entry.author),
        raw: entry,
      });
      continue;
    }

    if (entry.kind === 'text') {
      const text = entry.text?.trim();
      if (!text) continue;
      activities.push({
        id: nextId(),
        type: 'answer',
        label: agentLabel(entry.author),
        text,
        agent: agentLabel(entry.author),
      });
      continue;
    }

    if (entry.kind === 'tool-call') {
      // Delegation is real, but "transfer_to_agent({agentName})" is plumbing.
      // Shown as a handoff instead, which is the part a user cares about.
      if (entry.tool === 'transfer_to_agent') {
        const target = str(entry.args?.['agentName']);
        activities.push({
          id: nextId(),
          type: 'handoff',
          label: target ? `Handing over to ${agentLabel(target)}` : 'Choosing an approach',
          raw: entry,
        });
        continue;
      }

      activities.push({
        id: nextId(),
        type: 'step',
        label: describeCall(entry.tool ?? '', entry.args),
        agent: agentLabel(entry.author),
        raw: entry,
      });
      continue;
    }

    if (entry.kind === 'tool-result') {
      // The matching handoff row already says what happened.
      if (entry.tool === 'transfer_to_agent') continue;

      // Attach to the most recent step still awaiting its result.
      const pending = [...activities].reverse().find((a) => a.type === 'step' && !a.detail);
      const detail = describeResult(entry.tool ?? '', entry.summary, entry.ok !== false);

      if (pending) {
        pending.detail = detail;
        pending.ok = entry.ok !== false;
      } else {
        activities.push({
          id: nextId(),
          type: 'step',
          label: (entry.tool ?? 'step').replace(/_/g, ' '),
          detail,
          ok: entry.ok !== false,
          raw: entry,
        });
      }
    }
  }

  return activities;
}
