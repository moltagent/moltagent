'use strict';

/**
 * cloud-model-descriptor Unit Tests
 *
 * Architecture Brief:
 * -------------------
 * Problem: Verify the cloud datasheet reports declared capabilities from the
 * adapter profile and per-model overrides, in the shared vocabulary, and flags
 * unrecognized models as unknown rather than guessing from the name.
 *
 * Pattern: Direct unit testing of the lookup function against known and
 * unknown adapters/models.
 *
 * Run: node test/unit/providers/cloud-model-descriptor.test.js
 *
 * @module test/unit/providers/cloud-model-descriptor
 */

const assert = require('assert');
const { test, summary, exitWithCode } = require('../../helpers/test-runner');
const { cloudCapabilities } = require('../../../src/lib/providers/cloud-model-descriptor');
const { isToolCapable } = require('../../../src/lib/providers/capability-classes');

console.log('\n=== cloud-model-descriptor Tests ===\n');

// --- adapter profile: tool-capable chat provider ---
test('anthropic adapter is tool-capable with a context window', () => {
  const caps = cloudCapabilities({ adapter: 'anthropic', model: 'claude-opus-4-6' });
  assert.strictEqual(caps.source, 'adapter');
  assert.ok(caps.capabilities.includes('tools'));
  assert.ok(caps.capabilities.includes('vision'));
  assert.strictEqual(isToolCapable(caps.capabilities), true);
  assert.strictEqual(typeof caps.contextWindow, 'number');
});

test('adapter profile answers even for an unlisted model of a known adapter', () => {
  // A newer Claude version not individually enumerated still resolves via the
  // adapter contract — the datasheet survives model-version bumps.
  const caps = cloudCapabilities({ adapter: 'anthropic', model: 'claude-opus-9-future' });
  assert.strictEqual(caps.source, 'adapter');
  assert.strictEqual(isToolCapable(caps.capabilities), true);
});

// --- per-model override: a real non-tool cloud model ---
test('embedding model override is not tool-capable (excluded from tools job)', () => {
  const caps = cloudCapabilities({ adapter: 'openai', model: 'text-embedding-3-small' });
  assert.strictEqual(caps.source, 'model-override');
  assert.deepStrictEqual(caps.capabilities, ['embedding']);
  assert.strictEqual(isToolCapable(caps.capabilities), false);
});

test('override wins over the adapter profile', () => {
  // openai adapter alone is tool-capable; the embedding model override overrides it.
  const adapterOnly = cloudCapabilities({ adapter: 'openai', model: 'gpt-4o' });
  assert.strictEqual(isToolCapable(adapterOnly.capabilities), true);
  const overridden = cloudCapabilities({ adapter: 'openai', model: 'text-embedding-3-large' });
  assert.strictEqual(isToolCapable(overridden.capabilities), false);
});

// --- unknown: not guessed from the name ---
test('unrecognized adapter is reported unknown, not guessed', () => {
  const caps = cloudCapabilities({ adapter: 'some-new-provider', model: 'mystery-model-claude-ish' });
  assert.strictEqual(caps.source, 'unknown');
  assert.strictEqual(caps.capabilities, null, 'capability is null, not inferred from the name');
});

test('missing adapter and model yields unknown', () => {
  const caps = cloudCapabilities({});
  assert.strictEqual(caps.source, 'unknown');
  assert.strictEqual(caps.capabilities, null);
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
