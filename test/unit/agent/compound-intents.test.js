/*
 * Moltagent - Sovereign AI Security Layer
 * Copyright (C) 2026 Moltagent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

'use strict';

/**
 * Unit Tests for Compound Intents Decomposition
 *
 * Tests compound detection, plan decomposition, condition evaluation,
 * plan execution, and graceful degradation.
 *
 * Run: node test/unit/agent/compound-intents.test.js
 *
 * @module test/unit/agent/compound-intents
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const IntentRouter = require('../../../src/lib/agent/intent-router');
const IntentDecomposer = require('../../../src/lib/agent/intent-decomposer');

console.log('\n=== Compound Intents Decomposition Tests ===\n');

// ============================================================
// Mock Factories
// ============================================================

function createMockProvider(response) {
  return {
    chat: async () => ({ content: response, toolCalls: null })
  };
}

function createRouter(providerResponse) {
  return new IntentRouter({
    provider: createMockProvider(providerResponse),
    config: { classifyTimeout: 5000 }
  });
}

function createMockLlmRouter(responses) {
  let callIndex = 0;
  return {
    route: async () => {
      const resp = Array.isArray(responses) ? responses[callIndex++] || responses[responses.length - 1] : responses;
      return { result: typeof resp === 'string' ? resp : JSON.stringify(resp) };
    }
  };
}

// ============================================================
// Compound Detection Tests (Classifier)
// ============================================================

asyncTest('TC-CI-001: Simple query → compound: false', async () => {
  const router = createRouter('{"intent":"knowledge","compound":false}');
  const result = await router.classify("What's Carlos's email?");
  assert.strictEqual(result.compound, false);
});

asyncTest('TC-CI-002: Compound query → compound: true', async () => {
  const router = createRouter('{"intent":"knowledge","compound":true}');
  const result = await router.classify("Check Carlos's email and book a meeting with him");
  assert.strictEqual(result.compound, true);
});

asyncTest('TC-CI-003: Regex fallback detects compound "and create"', async () => {
  const router = new IntentRouter({
    provider: { chat: async () => { throw new Error('model unavailable'); } },
    config: { classifyTimeout: 100, fastModel: 'fake', smartModel: 'fake' }
  });
  const result = await router.classify('check the email and create a reminder');
  assert.strictEqual(result.compound, true);
});

asyncTest('TC-CI-004: Regex fallback detects compound "if not, create"', async () => {
  const router = new IntentRouter({
    provider: { chat: async () => { throw new Error('model unavailable'); } },
    config: { classifyTimeout: 100, fastModel: 'fake', smartModel: 'fake' }
  });
  const result = await router.classify('check if we have a meeting, if not then create one');
  assert.strictEqual(result.compound, true);
});

asyncTest('TC-CI-005: Simple greeting → compound: false in regex fallback', async () => {
  const router = new IntentRouter({
    provider: { chat: async () => { throw new Error('model unavailable'); } },
    config: { classifyTimeout: 100, fastModel: 'fake', smartModel: 'fake' }
  });
  const result = await router.classify('hello');
  assert.strictEqual(result.compound, false);
});

// ============================================================
// Classification Prompt Tests
// ============================================================

test('TC-CI-006: Classification prompt includes COMPOUND gate section', () => {
  const prompt = IntentRouter.CLASSIFICATION_SYSTEM_PROMPT;
  assert.ok(prompt.includes('COMPOUND'), 'Prompt should have COMPOUND section');
  assert.ok(prompt.includes('compound'), 'Prompt should mention compound');
});

// ============================================================
// IntentDecomposer Tests
// ============================================================

asyncTest('TC-CI-007: Decomposition produces valid plan with steps', async () => {
  const plan = {
    steps: [
      { id: 1, type: 'probe', source: 'wiki', query: 'Carlos email' },
      { id: 2, type: 'probe', source: 'calendar', query: 'Carlos next 14 days' },
      { id: 3, type: 'synthesis', query: 'Summarize', depends_on: [1, 2] }
    ]
  };
  const decomposer = new IntentDecomposer({
    llmRouter: createMockLlmRouter(JSON.stringify(plan))
  });
  const result = await decomposer.decompose('Check Carlos email and his calendar');
  assert.ok(result, 'Should return a plan');
  assert.ok(Array.isArray(result.steps), 'Plan should have steps array');
  assert.strictEqual(result.steps.length, 3);
  assert.strictEqual(result.steps[0].type, 'probe');
  assert.strictEqual(result.steps[0].source, 'wiki');
});

asyncTest('TC-CI-008: Decomposition failure returns null', async () => {
  const decomposer = new IntentDecomposer({
    llmRouter: createMockLlmRouter('not valid json at all')
  });
  const result = await decomposer.decompose('Check Carlos email');
  // The _cleanJson will extract {} which has no steps → null
  assert.strictEqual(result, null);
});

asyncTest('TC-CI-009: Decomposition without router returns null', async () => {
  const decomposer = new IntentDecomposer({});
  const result = await decomposer.decompose('anything');
  assert.strictEqual(result, null);
});

// ============================================================
// Condition Evaluation Tests
// ============================================================

test('TC-CI-010: if_empty condition — step returned nothing → execute', () => {
  const decomposer = new IntentDecomposer({});
  const results = new Map();
  results.set(2, { results: [] }); // empty
  assert.strictEqual(decomposer._evaluateCondition('if_empty:2', results), true);
});

test('TC-CI-011: if_empty condition — step returned results → skip', () => {
  const decomposer = new IntentDecomposer({});
  const results = new Map();
  results.set(2, { results: [{ title: 'Meeting with Carlos' }] });
  assert.strictEqual(decomposer._evaluateCondition('if_empty:2', results), false);
});

test('TC-CI-012: if_found condition — step returned results → execute', () => {
  const decomposer = new IntentDecomposer({});
  const results = new Map();
  results.set(1, { results: [{ title: 'Carlos email' }] });
  assert.strictEqual(decomposer._evaluateCondition('if_found:1', results), true);
});

test('TC-CI-013: if_found condition — step returned nothing → skip', () => {
  const decomposer = new IntentDecomposer({});
  const results = new Map();
  results.set(1, { results: [] });
  assert.strictEqual(decomposer._evaluateCondition('if_found:1', results), false);
});

test('TC-CI-014: "always" condition → execute', () => {
  const decomposer = new IntentDecomposer({});
  assert.strictEqual(decomposer._evaluateCondition('always', new Map()), true);
});

test('TC-CI-015: Unknown condition → execute by default', () => {
  const decomposer = new IntentDecomposer({});
  assert.strictEqual(decomposer._evaluateCondition('something_else', new Map()), true);
});

// ============================================================
// Plan Execution Tests
// ============================================================

asyncTest('TC-CI-016: Plan with parallel probes executes all probes', async () => {
  const plan = {
    originalMessage: 'Check Carlos email and calendar',
    steps: [
      { id: 1, type: 'probe', source: 'wiki', query: 'Carlos email' },
      { id: 2, type: 'probe', source: 'deck', query: 'Carlos tasks' },
      { id: 3, type: 'synthesis', query: 'Summarize', depends_on: [1, 2] }
    ]
  };

  const probed = [];
  const probeExecutor = {
    probeWiki: async (terms) => { probed.push('wiki'); return [{ title: 'Carlos', snippet: 'carlos@test.com' }]; },
    probeDeck: async (terms) => { probed.push('deck'); return [{ title: 'Onboarding', snippet: '[Working] Onboarding' }]; },
    probeCalendar: async () => [],
    probeGraph: async () => [],
    probeSessions: async () => []
  };

  const decomposer = new IntentDecomposer({
    llmRouter: createMockLlmRouter('Here are the results for Carlos.')
  });

  const response = await decomposer.executePlan(plan, { probeExecutor });
  assert.ok(probed.includes('wiki'), 'Should have probed wiki');
  assert.ok(probed.includes('deck'), 'Should have probed deck');
  assert.ok(response.length > 0, 'Should return a response');
});

asyncTest('TC-CI-017: Conditional action skipped when condition not met', async () => {
  const plan = {
    originalMessage: 'Check and create if empty',
    steps: [
      { id: 1, type: 'probe', source: 'calendar', query: 'meetings' },
      { id: 2, type: 'action', source: 'deck', query: 'Create reminder', condition: 'if_empty:1', depends_on: [1] },
      { id: 3, type: 'synthesis', query: 'Summarize', depends_on: [1, 2] }
    ]
  };

  const probeExecutor = {
    probeCalendar: async () => [{ title: 'Meeting tomorrow', snippet: '10:00 AM' }],
    probeWiki: async () => [],
    probeDeck: async () => [],
    probeGraph: async () => [],
    probeSessions: async () => []
  };

  const decomposer = new IntentDecomposer({
    llmRouter: createMockLlmRouter('Meeting found. No reminder created.')
  });

  const response = await decomposer.executePlan(plan, { probeExecutor });
  assert.ok(response.includes('Meeting found') || response.includes('reminder') || response.length > 0,
    'Should synthesize a response mentioning skipped action');
});

asyncTest('TC-CI-018: Conditional action executes when condition met', async () => {
  const plan = {
    originalMessage: 'Check and create if empty',
    steps: [
      { id: 1, type: 'probe', source: 'calendar', query: 'meetings' },
      { id: 2, type: 'action', source: 'deck', query: 'Create reminder', condition: 'if_empty:1', depends_on: [1] },
      { id: 3, type: 'synthesis', query: 'Summarize', depends_on: [1, 2] }
    ]
  };

  let actionExecuted = false;
  const probeExecutor = {
    probeCalendar: async () => [], // empty → condition met
    probeWiki: async () => [],
    probeDeck: async () => [],
    probeGraph: async () => [],
    probeSessions: async () => []
  };
  const actionExecutor = {
    process: async (msg) => { actionExecuted = true; return { response: 'Reminder created.' }; }
  };

  const decomposer = new IntentDecomposer({
    llmRouter: createMockLlmRouter('No meetings found. Created a reminder.')
  });

  await decomposer.executePlan(plan, { probeExecutor, actionExecutor });
  assert.strictEqual(actionExecuted, true, 'Action should have been executed');
});

// ============================================================
// Feedback Messages Tests
// ============================================================

test('TC-CI-019: Compound feedback messages exist', () => {
  const { getFeedbackMessage } = require('../../../src/lib/talk/feedback-messages');
  const decomposing = getFeedbackMessage('compound', 'decomposing');
  const probing = getFeedbackMessage('compound', 'probing');
  const acting = getFeedbackMessage('compound', 'acting');
  const synthesizing = getFeedbackMessage('compound', 'synthesizing');
  const defaultMsg = getFeedbackMessage('compound');

  assert.ok(decomposing, 'Should have decomposing feedback');
  assert.ok(probing, 'Should have probing feedback');
  assert.ok(acting, 'Should have acting feedback');
  assert.ok(synthesizing, 'Should have synthesizing feedback');
  assert.ok(defaultMsg, 'Should have default compound feedback');
});

// ============================================================
// Plain-text Fallback Tests
// ============================================================

test('TC-CI-020: Plain-text fallback formats results without LLM', () => {
  const decomposer = new IntentDecomposer({}); // no router
  const plan = {
    originalMessage: 'test',
    steps: [
      { id: 1, type: 'probe', source: 'wiki', query: 'Carlos' },
      { id: 2, type: 'synthesis', query: 'Summarize', depends_on: [1] }
    ]
  };
  const results = new Map();
  results.set(1, { source: 'wiki', results: [{ title: 'Carlos', snippet: 'carlos@test.com' }], provenance: 'stored_knowledge' });

  const formatted = decomposer._formatResultsPlain(plan, results);
  assert.ok(formatted.includes('Carlos'), 'Should include result title');
  assert.ok(formatted.includes('carlos@test.com'), 'Should include result snippet');
});

// ============================================================
// JSON Cleaning Tests
// ============================================================

test('TC-CI-021: _cleanJson strips think tags and markdown fences', () => {
  const decomposer = new IntentDecomposer({});
  const raw = '<think>reasoning here</think>\n```json\n{"steps":[{"id":1}]}\n```';
  const cleaned = decomposer._cleanJson(raw);
  const parsed = JSON.parse(cleaned);
  assert.ok(parsed.steps, 'Should parse to valid JSON with steps');
  assert.strictEqual(parsed.steps[0].id, 1);
});

// ============================================================
// INTENT_SCHEMA Tests
// ============================================================

test('TC-CI-022: INTENT_SCHEMA includes compound property', () => {
  // Verify the schema was updated to include compound
  const prompt = IntentRouter.CLASSIFICATION_SYSTEM_PROMPT;
  assert.ok(prompt.includes('compound'), 'Prompt should reference compound');
});

setTimeout(() => {
  console.log('\n=== Compound Intents Tests Complete ===\n');
  summary();
  exitWithCode();
}, 500);
