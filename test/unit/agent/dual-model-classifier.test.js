/*
 * Moltagent - Sovereign AI Security Layer
 * Copyright (C) 2026 Moltagent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * Dual-Model Classifier Tests
 *
 * Validates IntentRouter's dual-model routing: smart model (qwen3:8b) first,
 * fast model (qwen2.5:3b) fallback on failure, regex last resort.
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

// -- Test 1: Explicit message → qwen3:8b called first --
asyncTest('explicit message uses qwen3:8b', async () => {
  const { router, calls } = createRouter({
    'qwen3:8b': { intent: 'calendar_create' }
  });
  const result = await router.classify('Schedule a meeting tomorrow');
  assert.strictEqual(calls.length, 1, 'Should make exactly 1 call');
  assert.strictEqual(calls[0].model, 'qwen3:8b');
  assert.strictEqual(result.gate, 'action');
  assert.strictEqual(result.domain, 'calendar');
});

// -- Test 2: All messages start with smart model --
asyncTest('ambiguous message uses smart model first', async () => {
  const { router, calls } = createRouter({
    'qwen3:8b': { intent: 'wiki_write' }
  });
  const result = await router.classify('Remember that Sarah prefers video calls');
  assert.strictEqual(calls.length, 1, 'Should make exactly 1 call');
  assert.strictEqual(calls[0].model, 'qwen3:8b', 'Smart model should be used first');
  assert.strictEqual(result.gate, 'action');
  assert.strictEqual(result.domain, 'wiki');
});

// -- Test 3: smart model fails → falls back to qwen2.5:3b --
asyncTest('smart model failure falls back to qwen2.5:3b', async () => {
  const { router, calls } = createRouter({
    'qwen3:8b': new Error('Ollama request timed out after 1000ms'),
    'qwen2.5:3b': { intent: 'deck_move' }
  });
  const result = await router.classify('Move the onboarding task to done');
  assert.strictEqual(calls.length, 2, 'Should make 2 calls (smart → fast)');
  assert.strictEqual(calls[0].model, 'qwen3:8b');
  assert.strictEqual(calls[1].model, 'qwen2.5:3b');
  assert.strictEqual(result.gate, 'action');
  assert.strictEqual(result.domain, 'deck');
});

// -- Test 4: smart model timeout → falls back to qwen2.5:3b --
asyncTest('smart model timeout falls back to qwen2.5:3b', async () => {
  const { router, calls } = createRouter({
    'qwen3:8b': new Error('Ollama request timed out after 1000ms'),
    'qwen2.5:3b': { intent: 'calendar_query' }
  });
  const result = await router.classify('Book a meeting on my calendar for Friday');
  assert.strictEqual(calls.length, 2, 'Should make 2 calls');
  assert.strictEqual(calls[0].model, 'qwen3:8b');
  assert.strictEqual(calls[1].model, 'qwen2.5:3b');
  assert.strictEqual(result.domain, 'calendar');
});

// -- Test 5: smart model fails → escalates to qwen2.5:3b --
asyncTest('smart model failure escalates to qwen2.5:3b', async () => {
  const { router, calls } = createRouter({
    'qwen3:8b': new Error('Ollama request timed out after 10000ms'),
    'qwen2.5:3b': { intent: 'wiki_write' }
  });
  const result = await router.classify('Remember that the budget is 50k');
  assert.strictEqual(calls.length, 2, 'Should make 2 calls');
  assert.strictEqual(calls[0].model, 'qwen3:8b', 'First call should be smart model');
  assert.strictEqual(calls[1].model, 'qwen2.5:3b', 'Fallback to fast model on failure');
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
  let indicatorSent = false;
  const { router } = createRouter({
    'qwen3:8b': { intent: 'wiki_write' }
  });
  await router.classify('Remember the deadline is Friday', [], {
    replyFn: async () => { indicatorSent = true; }
  });
  assert.ok(!indicatorSent, 'Thinking indicator should NOT be sent');
});

// -- Test 8: Thinking indicator NOT sent for smart model path --
asyncTest('thinking indicator NOT sent for smart model path', async () => {
  let indicatorSent = false;
  const { router } = createRouter({
    'qwen3:8b': { intent: 'calendar_create' }
  });
  await router.classify('Schedule a meeting', [], {
    replyFn: async () => { indicatorSent = true; }
  });
  assert.ok(!indicatorSent, 'Thinking indicator should NOT be sent for smart model path');
});

// -- Test 9: Model parameter passed correctly to provider --
asyncTest('model parameter passed correctly to provider', async () => {
  const { router, calls } = createRouter({
    'qwen3:8b': { intent: 'chitchat' }
  });
  await router.classify('Good morning!');
  assert.strictEqual(calls[0].model, 'qwen3:8b');
  assert.ok(calls[0].format, 'Should pass format/schema');
  assert.ok(calls[0].options, 'Should pass options');
  assert.strictEqual(calls[0].options.temperature, 0.1);
  assert.strictEqual(calls[0].options.num_ctx, 2048);
});

// -- Test 10: Classification prompt has three-gate sections and context-aware rules --
asyncTest('classification prompt uses three-gate format', async () => {
  const { router, calls } = createRouter({
    'qwen3:8b': { intent: 'chitchat' }
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
    const { router } = createRouter({ 'qwen3:8b': { intent: intentName } });
    // Use a message with a generic action verb so the post-classify guard does not override
    const result = await router.classify('create and send it');
    assert.strictEqual(result.gate, 'action',
      `${intentName} should produce gate 'action', got ${result.gate}`);
    assert.strictEqual(result.domain, expectedDomain,
      `${intentName} should map to domain ${expectedDomain}, got ${result.domain}`);
  }
});

// -- Test 12: Smart model gets 4x timeout; fast model (fallback) gets base timeout --
asyncTest('fast model gets base timeout when used as fallback', async () => {
  const timeouts = [];
  let callCount = 0;
  const provider = {
    chat: async ({ model, timeout }) => {
      timeouts.push({ model, timeout });
      callCount++;
      if (callCount === 1) throw new Error('timeout'); // force smart model to fail
      return { content: '{"intent":"wiki_write"}' };
    }
  };
  const router = new IntentRouter({
    provider,
    config: { classifyTimeout: 5000, fastModel: 'qwen2.5:3b', smartModel: 'qwen3:8b' }
  });
  await router.classify('Remember that Sarah prefers video calls');
  assert.strictEqual(timeouts[0].model, 'qwen3:8b', 'First call is smart model');
  assert.strictEqual(timeouts[0].timeout, 20000, 'Smart model gets 4x timeout');
  assert.strictEqual(timeouts[1].model, 'qwen2.5:3b', 'Fallback is fast model');
  assert.strictEqual(timeouts[1].timeout, 5000, 'Fast model uses base timeout');
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
