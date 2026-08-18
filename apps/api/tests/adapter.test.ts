/**
 * Tests for the OpenAI-compatible BaseLlm adapter.
 *
 * The schema translation is the part that actually broke in practice, so it
 * gets the most coverage. Every case here was observed against a live provider,
 * not imagined.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { geminiSchemaToJsonSchema, PROVIDERS } from '../src/models/openai-compatible.js';
import { ALL_TOOLS } from '../src/tools/index.js';

test('upper-case Gemini types become JSON Schema types', () => {
  const converted = geminiSchemaToJsonSchema({
    type: 'OBJECT',
    properties: { location: { type: 'STRING' }, days: { type: 'INTEGER' } },
  });

  assert.equal(converted?.['type'], 'object');
  const props = converted?.['properties'] as Record<string, { type: string }>;
  assert.equal(props['location']?.type, 'string');
  assert.equal(props['days']?.type, 'integer');
});

test('string-valued numeric constraints become numbers', () => {
  // Observed verbatim: ADK emits `"minLength": "2"`, and strict validators
  // reject it because JSON Schema requires a number here.
  const converted = geminiSchemaToJsonSchema({
    type: 'OBJECT',
    properties: { location: { type: 'STRING', minLength: '2' } },
  });

  const location = (converted?.['properties'] as Record<string, Record<string, unknown>>)['location'];
  assert.equal(location?.['minLength'], 2);
  assert.equal(typeof location?.['minLength'], 'number');
});

test('nested objects and arrays are converted recursively', () => {
  const converted = geminiSchemaToJsonSchema({
    type: 'OBJECT',
    properties: {
      items: { type: 'ARRAY', items: { type: 'OBJECT', properties: { id: { type: 'STRING' } } } },
    },
  });

  const items = (converted?.['properties'] as Record<string, Record<string, unknown>>)['items'];
  assert.equal(items?.['type'], 'array');
  const inner = items?.['items'] as Record<string, unknown>;
  assert.equal(inner['type'], 'object');
});

test('nullable folds into a type union instead of a non-standard keyword', () => {
  const converted = geminiSchemaToJsonSchema({ type: 'STRING', nullable: true });
  assert.deepEqual(converted?.['type'], ['string', 'null']);
  assert.ok(!('nullable' in (converted ?? {})), 'nullable is not valid JSON Schema');
});

test('enums survive conversion', () => {
  const converted = geminiSchemaToJsonSchema({ type: 'STRING', enum: ['cafe', 'hotel'] });
  assert.deepEqual(converted?.['enum'], ['cafe', 'hotel']);
});

test('no real tool schema still contains an upper-case type after conversion', () => {
  // The end-to-end guarantee: whatever ADK emits for our actual tools must be
  // valid JSON Schema by the time a third-party provider sees it.
  for (const tool of ALL_TOOLS) {
    const declaration = (tool as unknown as { _getDeclaration(): { name: string; parameters?: unknown } })
      ._getDeclaration();
    const converted = JSON.stringify(geminiSchemaToJsonSchema(declaration.parameters) ?? {});

    for (const bad of ['"OBJECT"', '"STRING"', '"INTEGER"', '"NUMBER"', '"BOOLEAN"', '"ARRAY"']) {
      assert.ok(!converted.includes(bad), `${declaration.name} still emits ${bad}`);
    }
    assert.ok(
      !/"(minLength|maxLength|minimum|maximum|minItems|maxItems)":"/.test(converted),
      `${declaration.name} still has a string-valued numeric constraint`,
    );
  }
});

test('every provider has a base URL and a key variable', () => {
  for (const [name, config] of Object.entries(PROVIDERS)) {
    assert.ok(config.baseUrl.startsWith('https://'), `${name} needs an https base URL`);
    assert.ok(config.apiKeyEnv.endsWith('_API_KEY'), `${name} key var should end in _API_KEY`);
  }
});
