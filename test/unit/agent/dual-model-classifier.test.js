/*
 * MoltAgent - Sovereign AI Security Layer
 * Copyright (C) 2026 MoltAgent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * Dual-Model Classifier Tests
 *
 * Validates IntentRouter's dual-model routing: regex pre-router picks model,
 * phi4-mini unknown auto-escalates to qwen3:8b, mutual fallback on timeout,
 * thinking indicator for slow path.
 *
 * Run: node test/unit/agent/dual-model-classifier.test.js
 */

'use strict';

const assert = require('assert');
const { asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const IntentRouter = require('../../../src/lib/agent/intent-router');

console.log('\n=== Dual-Model Classifier Tests ===\n');

/**
 * Create an IntentRouter with a mock provider that tracks calls per model.
 */
function createRouter(modelResponses, opts = {}) {
  const calls = [];
  const provider = {
    chat: async ({ model, system, messages, format, options }) => {
      calls.push({ model, system, messages, format, options });
      const response = modelResponses[model];
      if (typeof response === 'function') return response();
      if (response instanceof Error) throw response;
      return { content: JSON.stringify(response || { intent: 'unknown' }) };
    }
  };
  const router = new IntentRouter({
    provider,
    config: {
      classifyTimeout: 1000,
      fastModel: 'phi4-mini',
      smartModel: 'qwen3:8b',
      ...opts
    }
  });
  return { router, calls };
}

// -- Test 1: Explicit message → phi4-mini called (not qwen3) --
asyncTest('explicit message uses phi4-mini', async () => {
  const { router, calls } = createRouter({
    'phi4-mini': { intent: 'calendar_create' }
  });
  const result = await router.classify('Schedule a meeting tomorrow');
  assert.strictEqual(calls.length, 1, 'Should make exactly 1 call');
  assert.strictEqual(calls[0].model, 'phi4-mini');
  assert.strictEqual(result.intent, 'domain');
  assert.strictEqual(result.domain, 'calendar');
});

// -- Test 2: Ambiguous message → qwen3:8b called (not phi4-mini) --
asyncTest('ambiguous message uses qwen3:8b', async () => {
  const { router, calls } = createRouter({
    'qwen3:8b': { intent: 'wiki_write' }
  });
  const result = await router.classify('Remember that Sarah prefers video calls');
  assert.strictEqual(calls.length, 1, 'Should make exactly 1 call');
  assert.strictEqual(calls[0].model, 'qwen3:8b');
  assert.strictEqual(result.intent, 'domain');
  assert.strictEqual(result.domain, 'wiki');
});

// -- Test 3: phi4-mini returns "unknown" → auto-escalates to qwen3:8b --
asyncTest('phi4-mini unknown auto-escalates to qwen3:8b', async () => {
  const { router, calls } = createRouter({
    'phi4-mini': { intent: 'unknown' },
    'qwen3:8b': { intent: 'deck_move' }
  });
  const result = await router.classify('Mark the onboarding task as complete');
  assert.strictEqual(calls.length, 2, 'Should make 2 calls (phi → qwen)');
  assert.strictEqual(calls[0].model, 'phi4-mini');
  assert.strictEqual(calls[1].model, 'qwen3:8b');
  assert.strictEqual(result.intent, 'domain');
  assert.strictEqual(result.domain, 'deck');
});

// -- Test 4: phi4-mini timeout → falls back to qwen3:8b --
asyncTest('phi4-mini timeout falls back to qwen3:8b', async () => {
  const { router, calls } = createRouter({
    'phi4-mini': new Error('Ollama request timed out after 1000ms'),
    'qwen3:8b': { intent: 'calendar_query' }
  });
  const result = await router.classify("What's on my calendar?");
  assert.strictEqual(calls.length, 2, 'Should make 2 calls');
  assert.strictEqual(calls[0].model, 'phi4-mini');
  assert.strictEqual(calls[1].model, 'qwen3:8b');
  assert.strictEqual(result.domain, 'calendar');
});

// -- Test 5: qwen3:8b timeout → falls back to phi4-mini --
asyncTest('qwen3:8b timeout falls back to phi4-mini', async () => {
  const { router, calls } = createRouter({
    'phi4-mini': { intent: 'wiki_write' },
    'qwen3:8b': new Error('Ollama request timed out after 40000ms')
  });
  const result = await router.classify('Remember that the budget is 50k');
  assert.strictEqual(calls.length, 2, 'Should make 2 calls');
  assert.strictEqual(calls[0].model, 'qwen3:8b', 'First call should be smart model (ambiguous message)');
  assert.strictEqual(calls[1].model, 'phi4-mini', 'Fallback to fast model');
  assert.strictEqual(result.domain, 'wiki');
});

// -- Test 6: Both models fail → returns complex (regex fallback) --
asyncTest('both models fail → regex fallback', async () => {
  const { router, calls } = createRouter({
    'phi4-mini': new Error('Connection refused'),
    'qwen3:8b': new Error('Connection refused')
  });
  const result = await router.classify('check my email');
  assert.strictEqual(calls.length, 2, 'Should try both models');
  // regex fallback catches "email"
  assert.strictEqual(result.intent, 'domain');
  assert.strictEqual(result.domain, 'email');
  assert.strictEqual(result.confidence, 0.5, 'Regex fallback confidence');
});

// -- Test 7: Thinking indicator sent for qwen3 path --
asyncTest('thinking indicator sent for smart model path', async () => {
  let indicatorSent = false;
  const { router } = createRouter({
    'qwen3:8b': { intent: 'wiki_write' }
  });
  await router.classify('Remember the deadline is Friday', [], {
    replyFn: async (text) => { indicatorSent = true; assert.ok(text.includes('think'), `Expected thinking text, got: ${text}`); }
  });
  assert.ok(indicatorSent, 'Thinking indicator should be sent for smart model path');
});

// -- Test 8: Thinking indicator NOT sent for phi4-mini path --
asyncTest('thinking indicator NOT sent for fast model path', async () => {
  let indicatorSent = false;
  const { router } = createRouter({
    'phi4-mini': { intent: 'calendar_create' }
  });
  await router.classify('Schedule a meeting', [], {
    replyFn: async () => { indicatorSent = true; }
  });
  assert.ok(!indicatorSent, 'Thinking indicator should NOT be sent for fast model path');
});

// -- Test 9: Model parameter passed correctly to provider --
asyncTest('model parameter passed correctly to provider', async () => {
  const { router, calls } = createRouter({
    'phi4-mini': { intent: 'chitchat' }
  });
  await router.classify('Good morning!');
  assert.strictEqual(calls[0].model, 'phi4-mini');
  assert.ok(calls[0].format, 'Should pass format/schema');
  assert.ok(calls[0].options, 'Should pass options');
  assert.strictEqual(calls[0].options.temperature, 0.1);
  assert.strictEqual(calls[0].options.num_ctx, 2048);
});

// -- Test 10: Classification prompt is Path C (descriptions only, no rules) --
asyncTest('classification prompt uses Path C (description-only)', async () => {
  const { router, calls } = createRouter({
    'phi4-mini': { intent: 'chitchat' }
  });
  await router.classify('Hello there');
  const systemPrompt = calls[0].system;
  assert.ok(systemPrompt.includes('Available intents:'), 'Should have intent descriptions');
  assert.ok(systemPrompt.includes('calendar_create'), 'Should have fine-grained intents');
  assert.ok(systemPrompt.includes('wiki_write'), 'Should have wiki_write');
  assert.ok(!systemPrompt.includes('Rules:'), 'Should NOT have rules section');
  assert.ok(!systemPrompt.includes('if the user'), 'Should NOT have rule-based hints');
});

// -- Test 11: Fine-grained intents map to correct domains --
asyncTest('fine-grained intents map to correct domains', async () => {
  const cases = [
    ['calendar_create', 'calendar'], ['calendar_query', 'calendar'],
    ['calendar_update', 'calendar'], ['calendar_delete', 'calendar'],
    ['deck_create', 'deck'], ['deck_move', 'deck'], ['deck_query', 'deck'],
    ['wiki_write', 'wiki'], ['wiki_read', 'wiki'],
    ['email_send', 'email'], ['email_read', 'email'],
    ['file_upload', 'file'], ['file_query', 'file']
  ];
  for (const [intentName, expectedDomain] of cases) {
    const { router } = createRouter({ 'phi4-mini': { intent: intentName } });
    const result = await router.classify('test message');
    assert.strictEqual(result.domain, expectedDomain,
      `${intentName} should map to domain ${expectedDomain}, got ${result.domain}`);
  }
});

// -- Test 12: Smart model gets 4x timeout --
asyncTest('smart model gets extended timeout', async () => {
  const timeouts = [];
  const provider = {
    chat: async ({ model, timeout }) => {
      timeouts.push({ model, timeout });
      return { content: '{"intent":"wiki_write"}' };
    }
  };
  const router = new IntentRouter({
    provider,
    config: { classifyTimeout: 5000, fastModel: 'phi4-mini', smartModel: 'qwen3:8b' }
  });
  // Ambiguous message → smart model
  await router.classify('Remember that Sarah prefers video calls');
  assert.strictEqual(timeouts[0].model, 'qwen3:8b');
  assert.strictEqual(timeouts[0].timeout, 20000, 'Smart model should get 4x timeout');
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
