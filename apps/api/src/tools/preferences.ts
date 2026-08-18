/**
 * User preferences — long-term memory that survives sessions.
 *
 * Preferences are written EXPLICITLY, never silently inferred: an agent has to
 * call savePreference, which means every stored fact is attributable, visible
 * in the timeline, and deletable by the user.
 *
 * Storage sits behind PreferenceStore. Phase 0 uses a JSON file so the tool
 * layer can be developed and tested with no database at all; Phase 5 swaps in
 * a Postgres implementation without touching the tool surface.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runTool } from '../lib/http.js';
import { dataDir, optionalEnv } from '../config/env.js';
import { PostgresPreferenceStore, registerClosablePreferenceStore } from '../memory/stores.js';
import {
  GetPreferencesInputSchema,
  PreferencesOutputSchema,
  SavePreferenceInputSchema,
  type GetPreferencesInput,
  type Preference,
  type PreferencesOutput,
  type SavePreferenceInput,
  type ToolResult,
} from '@lifepilot/shared';

export interface PreferenceStore {
  get(userId: string): Promise<Preference[]>;
  put(userId: string, preference: Preference): Promise<void>;
}

/**
 * Development store. Replaced by Postgres in Phase 5.
 *
 * Two properties this needs even as a dev store, because the research fan-out
 * is a ParallelAgent and concurrent writes are the normal case, not the edge:
 *
 *  1. Writes are serialised through an in-process promise chain. A plain
 *     read-modify-write loses every update but one when calls interleave.
 *  2. Writes are atomic (temp file + rename). Truncate-then-write leaves a
 *     structurally invalid JSON file if the process dies mid-write, and a
 *     blanket parse-catch would then report that corruption as "no
 *     preferences" — silent total data loss dressed up as a successful read.
 */
export class JsonFilePreferenceStore implements PreferenceStore {
  private readonly file: string;
  /** Serialises writes within this process. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(file = path.join(dataDir, 'preferences.json')) {
    this.file = file;
  }

  private async readAll(): Promise<Record<string, Preference[]>> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (error) {
      // A store that does not exist yet is genuinely empty. Anything else
      // (permissions, I/O) must surface rather than masquerade as empty.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }

    try {
      return JSON.parse(raw) as Record<string, Preference[]>;
    } catch {
      // Refuse to proceed: returning {} here would let the next write persist
      // an empty store and make the loss permanent.
      throw new Error(
        `Preference store at ${this.file} is not valid JSON. Refusing to overwrite it — ` +
          'inspect or delete the file to continue.',
      );
    }
  }

  async get(userId: string): Promise<Preference[]> {
    const all = await this.readAll();
    return all[userId] ?? [];
  }

  async put(userId: string, preference: Preference): Promise<void> {
    // Chain onto the queue so concurrent puts apply one at a time. Errors are
    // isolated so one failed write does not poison every later write.
    const run = this.queue.then(
      () => this.putUnsafe(userId, preference),
      () => this.putUnsafe(userId, preference),
    );
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async putUnsafe(userId: string, preference: Preference): Promise<void> {
    const all = await this.readAll();
    const existing = all[userId] ?? [];
    // One value per key: a preference is current state, not an event log.
    all[userId] = [...existing.filter((p) => p.key !== preference.key), preference];

    await mkdir(path.dirname(this.file), { recursive: true });
    // Write-then-rename: rename is atomic on the same filesystem, so a reader
    // sees either the old file or the new one, never a half-written one.
    const temp = `${this.file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(all, null, 2), 'utf8');
    await rename(temp, this.file);
  }
}

let store: PreferenceStore | undefined;

/**
 * Postgres when DATABASE_URL is set, a JSON file otherwise.
 *
 * Resolved lazily rather than at import so that tests, and anyone without
 * credentials, never open a pool they do not use.
 */
function getStore(): PreferenceStore {
  if (store) return store;

  const url = optionalEnv('DATABASE_URL');
  if (url) {
    const postgres = new PostgresPreferenceStore(url);
    registerClosablePreferenceStore(postgres);
    store = postgres;
  } else {
    store = new JsonFilePreferenceStore();
  }
  return store;
}

/** Swap the backing store — used by tests. */
export function setPreferenceStore(next: PreferenceStore): void {
  store = next;
}

export async function savePreference(
  rawInput: SavePreferenceInput,
): Promise<ToolResult<Preference>> {
  return runTool(async () => {
    const input = SavePreferenceInputSchema.parse(rawInput);
    const preference: Preference = {
      key: input.key,
      value: input.value,
      updatedAt: new Date().toISOString(),
    };
    await getStore().put(input.userId, preference);
    return preference;
  });
}

export async function getPreferences(
  rawInput: GetPreferencesInput,
): Promise<ToolResult<PreferencesOutput>> {
  return runTool(async () => {
    const input = GetPreferencesInputSchema.parse(rawInput);
    const preferences = await getStore().get(input.userId);
    return PreferencesOutputSchema.parse({ userId: input.userId, preferences });
  });
}
