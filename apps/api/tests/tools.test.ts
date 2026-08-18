/**
 * Regression tests for the Phase 0 review findings.
 *
 * Every test here exists because a real defect was found, so a failure means a
 * specific bug came back rather than "something changed". Nothing in this file
 * touches the network: these cover the logic that was actually wrong, and the
 * live-API behaviour is covered by running the CLI.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ZodError } from 'zod';

import { ToolFailure, toToolError } from '../src/lib/http.js';
import { JsonFilePreferenceStore } from '../src/tools/preferences.js';
import { findSchemaViolations } from '../src/tools/schema-guard.js';
import { WeatherDaySchema, CurrencyOutputSchema, ProductsInputSchema } from '@lifepilot/shared';

async function tempStoreFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'lifepilot-prefs-'));
  return path.join(dir, 'preferences.json');
}

/* --------------------------------------------------- preference store (#2) */

test('concurrent preference writes do not lose updates', async () => {
  const store = new JsonFilePreferenceStore(await tempStoreFile());
  const keys = ['home_city', 'currency', 'dietary', 'travel_class', 'interests'] as const;

  // The read-modify-write version kept 1 of these and corrupted the file.
  await Promise.all(
    keys.map((key) =>
      store.put('u1', { key, value: `value-${key}`, updatedAt: new Date().toISOString() }),
    ),
  );

  const stored = await store.get('u1');
  assert.equal(stored.length, keys.length, 'every concurrent write should survive');
  for (const key of keys) {
    assert.ok(
      stored.find((p) => p.key === key),
      `expected preference ${key} to be present`,
    );
  }
});

test('preference file stays valid JSON under concurrent writes', async () => {
  const file = await tempStoreFile();
  const store = new JsonFilePreferenceStore(file);

  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      store.put('u1', {
        key: 'interests',
        value: `write-${i}`,
        updatedAt: new Date().toISOString(),
      }),
    ),
  );

  // Must parse — the non-atomic writer left trailing fragments behind.
  const parsed = JSON.parse(await readFile(file, 'utf8'));
  assert.ok(Array.isArray(parsed.u1));
  assert.equal(parsed.u1.length, 1, 'one value per key');
});

test('a corrupt preference store fails loudly instead of reporting empty', async () => {
  const file = await tempStoreFile();
  await writeFile(file, '{ "u1": [ truncated', 'utf8');
  const store = new JsonFilePreferenceStore(file);

  // Returning [] here would let the next write persist {} and make the loss permanent.
  await assert.rejects(() => store.get('u1'), /not valid JSON/);
});

test('a missing preference store is treated as empty, not as an error', async () => {
  const store = new JsonFilePreferenceStore(await tempStoreFile());
  assert.deepEqual(await store.get('nobody'), []);
});

/* ------------------------------------------------ error propagation (#3) */

test('ToolFailure preserves missingEnv and retryable through a throw', () => {
  const inner = {
    ok: false as const,
    error: 'TAVILY_API_KEY is not set.',
    missingEnv: 'TAVILY_API_KEY',
    retryable: false,
  };

  const normalised = toToolError(new ToolFailure(inner));

  // Flattening to `new Error(result.error)` dropped both of these.
  assert.equal(normalised.missingEnv, 'TAVILY_API_KEY');
  assert.equal(normalised.error, inner.error);
});

test('ToolFailure preserves retryable so transient failures stay retryable', () => {
  const inner = { ok: false as const, error: 'HTTP 429 from api.geoapify.com', retryable: true };
  assert.equal(toToolError(new ToolFailure(inner)).retryable, true);
});

test('Zod errors are flattened to one readable line', () => {
  let error: unknown;
  try {
    WeatherDaySchema.parse({ date: 'not-a-date', summary: 'x' });
  } catch (e) {
    error = e;
  }

  assert.ok(error instanceof ZodError);
  const normalised = toToolError(error);
  assert.match(normalised.error, /^Invalid arguments - /);
  assert.ok(!normalised.error.includes('\n'), 'must be single-line at an LLM boundary');
});

/* ------------------------------------------- no fabricated values (#1, #4, #7) */

test('weather accepts a null temperature rather than requiring a number', () => {
  const parsed = WeatherDaySchema.parse({
    date: '2026-09-02',
    tempMinC: null,
    tempMaxC: null,
    precipitationChancePct: 16,
    summary: 'Unknown',
  });
  assert.equal(parsed.tempMinC, null, 'a missing reading must stay missing, never become 0');
});

test('currency accepts a null rate date rather than backfilling today', () => {
  const parsed = CurrencyOutputSchema.parse({
    amount: 1,
    from: 'USD',
    to: 'PKR',
    rate: 277.9,
    converted: 277.9,
    rateDate: null,
  });
  assert.equal(parsed.rateDate, null);
});

test('product search does not advertise a currency parameter it cannot honour', () => {
  const parsed = ProductsInputSchema.parse({ query: 'headphones', currency: 'PKR' });
  assert.ok(
    !('currency' in parsed),
    'an accepted currency arg would let an agent report USD listings as PKR',
  );
});

/* -------------------------------------------- Gemini schema compatibility */

test('every tool schema stays inside the Gemini function-declaration subset', async () => {
  const { ALL_TOOLS } = await import('../src/tools/index.js');
  const { assertGeminiCompatible } = await import('../src/tools/schema-guard.js');

  // z.number().positive() emitted exclusiveMinimum and Gemini rejected the whole
  // request with a 400 naming only an array index. Fail here instead.
  assertGeminiCompatible(ALL_TOOLS as unknown as Array<{ _getDeclaration(): unknown }>);
});

test('the schema guard actually catches an unsupported keyword', () => {
  const violations = findSchemaViolations('demo', {
    name: 'demo',
    parameters: { properties: { amount: { type: 'number', exclusiveMinimum: 0 } } },
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.keyword, 'exclusiveMinimum');
});
