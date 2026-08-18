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
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runTool } from '../lib/http.js';
import { dataDir } from '../config/env.js';
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

/** Development store. Not concurrency-safe — replaced by Postgres in Phase 5. */
export class JsonFilePreferenceStore implements PreferenceStore {
  private readonly file: string;

  constructor(file = path.join(dataDir, 'preferences.json')) {
    this.file = file;
  }

  private async readAll(): Promise<Record<string, Preference[]>> {
    try {
      return JSON.parse(await readFile(this.file, 'utf8')) as Record<string, Preference[]>;
    } catch {
      return {};
    }
  }

  async get(userId: string): Promise<Preference[]> {
    const all = await this.readAll();
    return all[userId] ?? [];
  }

  async put(userId: string, preference: Preference): Promise<void> {
    const all = await this.readAll();
    const existing = all[userId] ?? [];
    // One value per key: a preference is current state, not an event log.
    all[userId] = [...existing.filter((p) => p.key !== preference.key), preference];
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(all, null, 2), 'utf8');
  }
}

let store: PreferenceStore = new JsonFilePreferenceStore();

/** Swap the backing store — used by Phase 5 and by tests. */
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
    await store.put(input.userId, preference);
    return preference;
  });
}

export async function getPreferences(
  rawInput: GetPreferencesInput,
): Promise<ToolResult<PreferencesOutput>> {
  return runTool(async () => {
    const input = GetPreferencesInputSchema.parse(rawInput);
    const preferences = await store.get(input.userId);
    return PreferencesOutputSchema.parse({ userId: input.userId, preferences });
  });
}
