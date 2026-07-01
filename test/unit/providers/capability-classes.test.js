'use strict';

/**
 * capability-classes Unit Tests
 *
 * Architecture Brief:
 * -------------------
 * Problem: Verify the shared capability vocabulary classifies a declared
 * capabilities array consistently for local (Ollama probe) and cloud
 * (descriptor) models — one predicate set, one answer for any player.
 *
 * Pattern: Direct unit testing of pure predicates. No mocks — leaf module.
 *
 * Run: node test/unit/providers/capability-classes.test.js
 *
 * @module test/unit/providers/capability-classes
 */

const assert = require('assert');
const { test, summary, exitWithCode } = require('../../helpers/test-runner');
const {
  CLASS,
  normalizeCapabilities,
  isEmbedding,
  hasVision,
  isTextGeneration,
  isDedicatedTextGenerator,
  isToolCapable,
  classesOf,
} = require('../../../src/lib/providers/capability-classes');

console.log('\n=== capability-classes Tests ===\n');

// --- normalizeCapabilities: default + lowercase ---
test('normalizeCapabilities defaults empty/undefined to completion', () => {
  assert.deepStrictEqual(normalizeCapabilities(undefined), ['completion']);
  assert.deepStrictEqual(normalizeCapabilities([]), ['completion']);
  assert.deepStrictEqual(normalizeCapabilities(null), ['completion']);
});

test('normalizeCapabilities lowercases declared tokens', () => {
  assert.deepStrictEqual(normalizeCapabilities(['Completion', 'TOOLS']), ['completion', 'tools']);
});

// --- text-generation membership (honest, additive vision) ---
test('isTextGeneration: completion-bearing model is text-gen, embedding is not', () => {
  assert.strictEqual(isTextGeneration(['completion', 'tools']), true);
  assert.strictEqual(isTextGeneration(['completion', 'vision']), true, 'vision is additive');
  assert.strictEqual(isTextGeneration(['embedding']), false);
});

// --- dedicated (local roster policy) excludes vision/embedding specialists ---
test('isDedicatedTextGenerator excludes vision and embedding specialists', () => {
  assert.strictEqual(isDedicatedTextGenerator(['completion', 'tools']), true);
  assert.strictEqual(isDedicatedTextGenerator(['completion', 'vision']), false, 'llava excluded from local text jobs');
  assert.strictEqual(isDedicatedTextGenerator(['embedding']), false);
});

// --- tool-capable: text-gen + tools, vision-additive generalist still qualifies ---
test('isToolCapable: multimodal generalist qualifies, embedding does not', () => {
  assert.strictEqual(isToolCapable(['completion', 'tools', 'vision']), true, 'Claude-shape qualifies');
  assert.strictEqual(isToolCapable(['completion', 'tools']), true);
  assert.strictEqual(isToolCapable(['completion']), false, 'no tools declared');
  assert.strictEqual(isToolCapable(['embedding']), false);
});

test('hasVision / isEmbedding read declared tokens', () => {
  assert.strictEqual(hasVision(['completion', 'vision']), true);
  assert.strictEqual(hasVision(['completion']), false);
  assert.strictEqual(isEmbedding(['embedding']), true);
  assert.strictEqual(isEmbedding(['completion']), false);
});

// --- classesOf: consistent classes for a LOCAL and a CLOUD model ---
test('classesOf returns consistent classes for a local and a cloud tool-caller', () => {
  // qwen3:8b (local, /api/show) and claude (cloud, descriptor) both declare
  // completion+tools → both are text-generation AND tool-capable.
  const localCaps = ['completion', 'tools', 'thinking'];
  const cloudCaps = ['completion', 'tools', 'vision'];
  const localClasses = classesOf(localCaps);
  const cloudClasses = classesOf(cloudCaps);

  assert.ok(localClasses.includes(CLASS.TEXT_GENERATION));
  assert.ok(localClasses.includes(CLASS.TOOL_CAPABLE));
  assert.ok(cloudClasses.includes(CLASS.TEXT_GENERATION));
  assert.ok(cloudClasses.includes(CLASS.TOOL_CAPABLE));
  // Cloud model additionally sees images; both agree on the shared classes.
  assert.ok(cloudClasses.includes(CLASS.VISION));
  assert.ok(!localClasses.includes(CLASS.VISION));
});

test('classesOf: embedding model is embedding-only, not text-generation', () => {
  const classes = classesOf(['embedding']);
  assert.deepStrictEqual(classes, [CLASS.EMBEDDING]);
});

test('classesOf: vision specialist is text-generation + vision (membership, not policy)', () => {
  // Membership is honest even though the local roster POLICY excludes it.
  const classes = classesOf(['completion', 'vision']);
  assert.ok(classes.includes(CLASS.TEXT_GENERATION));
  assert.ok(classes.includes(CLASS.VISION));
  assert.ok(!classes.includes(CLASS.TOOL_CAPABLE));
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
