'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

const {
  KNOWN_PROVIDERS,
  getProviderDefaults,
  getKnownProviderTypes,
} = require('../../../src/lib/providers/known-providers');

const { ADAPTERS } = require('../../../src/lib/llm/providers/index');

// Required fields that every KNOWN_PROVIDERS entry must carry.
// Note: endpoint may be null for local providers, so it is excluded from
// the mandatory-non-null check — only its *presence* is verified.
const REQUIRED_FIELDS = ['protocol', 'auth', 'local', 'adapter', 'description'];

// -- Test 1: Every entry has required fields --
test('every KNOWN_PROVIDERS entry has required fields', () => {
  const types = Object.keys(KNOWN_PROVIDERS);
  assert.ok(types.length > 0, 'KNOWN_PROVIDERS must not be empty');

  for (const typeName of types) {
    const entry = KNOWN_PROVIDERS[typeName];

    // endpoint key must exist (value may be null for local providers)
    assert.ok(
      Object.prototype.hasOwnProperty.call(entry, 'endpoint'),
      `${typeName}: missing 'endpoint' key`
    );

    for (const field of REQUIRED_FIELDS) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(entry, field),
        `${typeName}: missing required field '${field}'`
      );
      // None of the non-endpoint required fields should be null/undefined
      assert.ok(
        entry[field] !== null && entry[field] !== undefined,
        `${typeName}: required field '${field}' must not be null or undefined`
      );
    }

    // Local providers must have endpoint === null; cloud providers must have a non-null string
    if (entry.local) {
      assert.strictEqual(
        entry.endpoint,
        null,
        `${typeName}: local provider must have endpoint === null`
      );
    } else {
      assert.ok(
        typeof entry.endpoint === 'string' && entry.endpoint.length > 0,
        `${typeName}: cloud provider must have a non-empty string endpoint`
      );
    }
  }
});

// -- Test 2: getProviderDefaults('perplexity') returns correct config --
test("getProviderDefaults('perplexity') returns correct config", () => {
  const result = getProviderDefaults('perplexity');

  assert.ok(result !== null, 'should return a non-null object for perplexity');
  assert.strictEqual(result.endpoint, 'https://api.perplexity.ai');
  assert.strictEqual(result.protocol, 'openai');
  assert.strictEqual(result.auth, true);
  assert.strictEqual(result.local, false);
  assert.strictEqual(result.adapter, 'openai-compatible');
  assert.strictEqual(result.description, 'Perplexity search-augmented models');
});

// -- Test 3: getProviderDefaults is case-insensitive --
test("getProviderDefaults('PERPLEXITY') returns correct config (case-insensitive)", () => {
  const lower = getProviderDefaults('perplexity');
  const upper = getProviderDefaults('PERPLEXITY');
  const mixed = getProviderDefaults('Perplexity');

  assert.ok(upper !== null, 'PERPLEXITY should resolve');
  assert.ok(mixed !== null, 'Perplexity should resolve');
  assert.deepStrictEqual(upper, lower, 'PERPLEXITY should equal perplexity');
  assert.deepStrictEqual(mixed, lower, 'Perplexity should equal perplexity');
});

// -- Test 4: getProviderDefaults returns null for unknown types --
test("getProviderDefaults('unknown-thing') returns null", () => {
  assert.strictEqual(getProviderDefaults('unknown-thing'), null);
  assert.strictEqual(getProviderDefaults(''), null);
  assert.strictEqual(getProviderDefaults('NOTREAL'), null);
});

// -- Test 5: getKnownProviderTypes returns array of all known types --
test('getKnownProviderTypes() returns array of all known types', () => {
  const types = getKnownProviderTypes();

  assert.ok(Array.isArray(types), 'should return an array');
  assert.ok(types.length > 0, 'array should not be empty');

  // Spot-check a few expected entries
  const expected = [
    'ollama', 'anthropic', 'openai', 'perplexity', 'mistral',
    'deepseek', 'groq', 'together', 'fireworks', 'openrouter',
    'xai', 'google', 'llama-cpp', 'vllm',
  ];
  for (const name of expected) {
    assert.ok(
      types.includes(name),
      `getKnownProviderTypes() should include '${name}'`
    );
  }

  // The returned keys should match KNOWN_PROVIDERS exactly
  assert.deepStrictEqual(
    types.slice().sort(),
    Object.keys(KNOWN_PROVIDERS).sort(),
    'getKnownProviderTypes() must return all KNOWN_PROVIDERS keys'
  );
});

// -- Test 6: All adapter values in KNOWN_PROVIDERS map to valid ADAPTERS keys --
test('all adapter values in KNOWN_PROVIDERS map to valid ADAPTERS keys', () => {
  const availableAdapters = Object.keys(ADAPTERS);

  for (const [typeName, entry] of Object.entries(KNOWN_PROVIDERS)) {
    assert.ok(
      availableAdapters.includes(entry.adapter),
      `${typeName}: adapter '${entry.adapter}' is not registered in ADAPTERS. ` +
      `Available: ${availableAdapters.join(', ')}`
    );
  }
});

// Use setTimeout to allow all asyncTest promises to resolve before exiting.
setTimeout(() => {
  summary();
  exitWithCode();
}, 100);
