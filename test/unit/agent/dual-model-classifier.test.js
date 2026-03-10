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
 * fast model unknown auto-escalates to qwen3:8b, mutual fallback on timeout,
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
      fastModel: 'qwen2.5:3b',
      smartModel: 'qwen3:8b',
      ...opts
    }
  });
  return { router, calls };
}

// -- Test 1: Explicit message → qwen2.5:3b called (not qwen3) --
asyncTest('explicit message uses qwen2.5:3b', async () => {
  const { router, calls } = createRouter({
    'qwen2.5:3b': { intent: 'calendar_create' }
  });
  const result = await router.classify('Schedule a meeting tomorrow');
  assert.strictEqual(calls.length, 1, 'Should make exactly 1 call');
  assert.strictEqual(calls[0].model, 'qwen2.5:3b');
  assert.strictEqual(result.gate, 'action');
  assert.strictEqual(result.domain, 'calendar');
});

// -- Test 2: All messages start with fast model (no needsSmartClassifier pre-routing) --
asyncTest('ambiguous message uses fast model first (language-agnostic routing)', async () => {
  const { router, calls } = createRouter({
    'qwen2.5:3b': { intent: 'wiki_write' }
  });
  const result = await router.classify('Remember that Sarah prefers video calls');
  assert.strictEqual(calls.length, 1, 'Should make exactly 1 call — fast model handles all messages');
  assert.strictEqual(calls[0].model, 'qwen2.5:3b', 'Fast model should be used — LLM handles context natively');
  assert.strictEqual(result.gate, 'action');
  assert.strictEqual(result.domain, 'wiki');
});

// -- Test 3: fast model returns unknown confidence → auto-escalates to qwen3:8b --
asyncTest('fast model unknown auto-escalates to qwen3:8b', async () => {
  const { router, calls } = createRouter({
    'qwen2.5:3b': { gate: 'knowledge', confidence: 0 },
    'qwen3:8b': { intent: 'deck_move' }
  });
  const result = await router.classify('Move the onboarding task to done');
  assert.strictEqual(calls.length, 2, 'Should make 2 calls (fast → smart)');
  assert.strictEqual(calls[0].model, 'qwen2.5:3b');
  assert.strictEqual(calls[1].model, 'qwen3:8b');
  assert.strictEqual(result.gate, 'action');
  assert.strictEqual(result.domain, 'deck');
});

// -- Test 4: fast model timeout → falls back to qwen3:8b --
asyncTest('fast model timeout falls back to qwen3:8b', async () => {
  const { router, calls } = createRouter({
    'qwen2.5:3b': new Error('Ollama request timed out after 1000ms'),
    'qwen3:8b': { intent: 'calendar_query' }
  });
  const result = await router.classify('Book a meeting on my calendar for Friday');
  assert.strictEqual(calls.length, 2, 'Should make 2 calls');
  assert.strictEqual(calls[0].model, 'qwen2.5:3b');
  assert.strictEqual(calls[1].model, 'qwen3:8b');
  assert.strictEqual(result.domain, 'calendar');
});

// -- Test 5: fast model fails → escalates to qwen3:8b --
asyncTest('fast model failure escalates to qwen3:8b', async () => {
  const { router, calls } = createRouter({
    'qwen2.5:3b': new Error('Ollama request timed out after 10000ms'),
    'qwen3:8b': { intent: 'wiki_write' }
  });
  const result = await router.classify('Remember that the budget is 50k');
  assert.strictEqual(calls.length, 2, 'Should make 2 calls');
  assert.strictEqual(calls[0].model, 'qwen2.5:3b', 'First call should be fast model');
  assert.strictEqual(calls[1].model, 'qwen3:8b', 'Fallback to smart model on failure');
  assert.strictEqual(result.domain, 'wiki');
});

// -- Test 6: Both models fail → returns gate-based result (regex fallback) --
asyncTest('both models fail → regex fallback', async () => {
  const { router, calls } = createRouter({
    'qwen2.5:3b': new Error('Connection refused'),
    'qwen3:8b': new Error('Connection refused')
  });
  const result = await router.classify('send an email to the team about the project update');
  assert.strictEqual(calls.length, 2, 'Should try both models');
  // regex fallback catches "send" (action verb) + "email" (domain)
  assert.strictEqual(result.gate, 'action');
  assert.strictEqual(result.domain, 'email');
  assert.strictEqual(result.confidence, 0.5, 'Regex fallback confidence');
});

// -- Test 7: No thinking indicator sent (needsSmartClassifier removed) --
asyncTest('thinking indicator not sent for any path (language-agnostic routing)', async () => {
  // v4.0.0: needsSmartClassifier removed — no thinking indicator is proactively sent.
  // The replyFn is no longer called for thinking indicators in the classify path.
  let indicatorSent = false;
  const { router } = createRouter({
    'qwen2.5:3b': { intent: 'wiki_write' }
  });
  await router.classify('Remember the deadline is Friday', [], {
    replyFn: async () => { indicatorSent = true; }
  });
  assert.ok(!indicatorSent, 'Thinking indicator should NOT be sent — no pre-routing to smart model');
});

// -- Test 8: Thinking indicator NOT sent for fast model path --
asyncTest('thinking indicator NOT sent for fast model path', async () => {
  let indicatorSent = false;
  const { router } = createRouter({
    'qwen2.5:3b': { intent: 'calendar_create' }
  });
  await router.classify('Schedule a meeting', [], {
    replyFn: async () => { indicatorSent = true; }
  });
  assert.ok(!indicatorSent, 'Thinking indicator should NOT be sent for fast model path');
});

// -- Test 9: Model parameter passed correctly to provider --
asyncTest('model parameter passed correctly to provider', async () => {
  const { router, calls } = createRouter({
    'qwen2.5:3b': { intent: 'chitchat' }
  });
  await router.classify('Good morning!');
  assert.strictEqual(calls[0].model, 'qwen2.5:3b');
  assert.ok(calls[0].format, 'Should pass format/schema');
  assert.ok(calls[0].options, 'Should pass options');
  assert.strictEqual(calls[0].options.temperature, 0.1);
  assert.strictEqual(calls[0].options.num_ctx, 2048);
});

// -- Test 10: Classification prompt has three-gate sections and context-aware rules --
asyncTest('classification prompt uses three-gate format', async () => {
  const { router, calls } = createRouter({
    'qwen2.5:3b': { intent: 'chitchat' }
  });
  await router.classify('Hello there');
  const systemPrompt = calls[0].system;
  assert.ok(systemPrompt.includes('ACTION'), 'Should have ACTION gate section');
  assert.ok(systemPrompt.includes('COMPOUND'), 'Should have COMPOUND gate section');
  assert.ok(systemPrompt.includes('KNOWLEDGE'), 'Should have KNOWLEDGE gate section');
  assert.ok(systemPrompt.includes('CONTEXT-AWARE RULES'), 'Should have context-aware rules section');
});

// -- Test 11: Fine-grained legacy intents map to correct gate and domains --
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
    const { router } = createRouter({ 'qwen2.5:3b': { intent: intentName } });
    // Use a message with a generic action verb so the post-classify guard does not override
    const result = await router.classify('create and send it');
    assert.strictEqual(result.gate, 'action',
      `${intentName} should produce gate 'action', got ${result.gate}`);
    assert.strictEqual(result.domain, expectedDomain,
      `${intentName} should map to domain ${expectedDomain}, got ${result.domain}`);
  }
});

// -- Test 12: Fast model uses base timeout; smart model (fallback) gets 4x timeout --
asyncTest('smart model gets extended timeout when used as fallback', async () => {
  const timeouts = [];
  let callCount = 0;
  const provider = {
    chat: async ({ model, timeout }) => {
      timeouts.push({ model, timeout });
      callCount++;
      if (callCount === 1) throw new Error('timeout'); // force fast model to fail
      return { content: '{"intent":"wiki_write"}' };
    }
  };
  const router = new IntentRouter({
    provider,
    config: { classifyTimeout: 5000, fastModel: 'qwen2.5:3b', smartModel: 'qwen3:8b' }
  });
  // Fast model fails → falls back to smart model (with 4x timeout)
  await router.classify('Remember that Sarah prefers video calls');
  assert.strictEqual(timeouts[0].model, 'qwen2.5:3b', 'First call is always fast model');
  assert.strictEqual(timeouts[0].timeout, 5000, 'Fast model uses base timeout');
  assert.strictEqual(timeouts[1].model, 'qwen3:8b', 'Fallback is smart model');
  assert.strictEqual(timeouts[1].timeout, 20000, 'Smart model fallback should get 4x timeout');
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
