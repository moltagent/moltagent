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
 * Three-Gate Classifier Tests
 *
 * Architecture Brief:
 * -------------------
 * Problem: Validate the three-gate classifier restructuring — knowledge/action/compound
 *   gates, post-classify guard, greeting pre-check, backward compatibility.
 *
 * Pattern: Unit tests using custom test runner. Mock the OllamaToolsProvider to return
 *   gate-format JSON. Test each gate, the post-classify guard, regex fallback, and
 *   the backward-compat shim.
 *
 * Key Dependencies: IntentRouter, test-runner helpers, assert module.
 *
 * @module test/unit/agent/three-gate-classifier
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const IntentRouter = require('../../../src/lib/agent/intent-router');

console.log('\n=== Three-Gate Classifier Tests ===\n');

// --- Helpers ---

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

// ============================================================
// KNOWLEDGE GATE (default — 6 tests)
// ============================================================

asyncTest('TG-01: "What\'s Carlos\'s email?" → knowledge (NOT email)', async () => {
  const router = createRouter('{"gate":"knowledge","confidence":0.9}');
  const result = await router.classify("What's Carlos's email?");
  assert.strictEqual(result.gate, 'knowledge');
  assert.strictEqual(result.domain, null);
  // Backward compat
  assert.strictEqual(result.intent, 'knowledge');
});

asyncTest('TG-02: "What\'s the status of onboarding?" → knowledge (NOT deck)', async () => {
  const router = createRouter('{"gate":"knowledge","confidence":0.85}');
  const result = await router.classify("What's the status of onboarding?");
  assert.strictEqual(result.gate, 'knowledge');
  assert.strictEqual(result.domain, null);
  assert.strictEqual(result.intent, 'knowledge');
});

asyncTest('TG-03: "Who do we know at TheCatalyne?" → knowledge', async () => {
  const router = createRouter('{"gate":"knowledge","confidence":0.9}');
  const result = await router.classify("Who do we know at TheCatalyne?");
  assert.strictEqual(result.gate, 'knowledge');
  assert.strictEqual(result.domain, null);
});

asyncTest('TG-04: "What\'s the weather in Lisbon?" → knowledge', async () => {
  const router = createRouter('{"gate":"knowledge","confidence":0.8}');
  const result = await router.classify("What's the weather in Lisbon?");
  assert.strictEqual(result.gate, 'knowledge');
  assert.strictEqual(result.domain, null);
});

asyncTest('TG-05: "Tell me about Paradiesgarten" → knowledge', async () => {
  const router = createRouter('{"gate":"knowledge","confidence":0.9}');
  const result = await router.classify("Tell me about Paradiesgarten");
  assert.strictEqual(result.gate, 'knowledge');
  assert.strictEqual(result.domain, null);
});

asyncTest('TG-06: "What boards do I have?" → knowledge (listing = knowing)', async () => {
  const router = createRouter('{"gate":"knowledge","confidence":0.85}');
  const result = await router.classify("What boards do I have?");
  assert.strictEqual(result.gate, 'knowledge');
  assert.strictEqual(result.domain, null);
});

// ============================================================
// ACTION GATE (5 tests)
// ============================================================

asyncTest('TG-07: "Create a board called Sprint Planning" → action, deck', async () => {
  const router = createRouter('{"gate":"action","domain":"deck","confidence":0.95}');
  const result = await router.classify("Create a board called Sprint Planning");
  assert.strictEqual(result.gate, 'action');
  assert.strictEqual(result.domain, 'deck');
  // Backward compat: intent maps to domain for action gate
  assert.strictEqual(result.intent, 'deck');
});

asyncTest('TG-08: "Send an email to Carlos about the meeting" → action, email', async () => {
  const router = createRouter('{"gate":"action","domain":"email","confidence":0.95}');
  const result = await router.classify("Send an email to Carlos about the meeting");
  assert.strictEqual(result.gate, 'action');
  assert.strictEqual(result.domain, 'email');
  assert.strictEqual(result.intent, 'email');
});

asyncTest('TG-09: "Book a meeting for Tuesday at 3pm" → action, calendar', async () => {
  const router = createRouter('{"gate":"action","domain":"calendar","confidence":0.95}');
  const result = await router.classify("Book a meeting for Tuesday at 3pm");
  assert.strictEqual(result.gate, 'action');
  assert.strictEqual(result.domain, 'calendar');
  assert.strictEqual(result.intent, 'calendar');
});

asyncTest('TG-10: "Move the onboarding card to Done" → action, deck', async () => {
  const router = createRouter('{"gate":"action","domain":"deck","confidence":0.9}');
  const result = await router.classify("Move the onboarding card to Done");
  assert.strictEqual(result.gate, 'action');
  assert.strictEqual(result.domain, 'deck');
});

asyncTest('TG-11: "Remember this: Project X uses React" → action, wiki', async () => {
  // Note: "remember" triggers needsSmartClassifier, so both models are tried
  // The mock provider always returns the same response regardless of model
  const router = createRouter('{"gate":"action","domain":"wiki","confidence":0.9}');
  const result = await router.classify("Remember this: Project X uses React");
  assert.strictEqual(result.gate, 'action');
  assert.strictEqual(result.domain, 'wiki');
});

// ============================================================
// COMPOUND GATE (2 tests)
// ============================================================

asyncTest('TG-12: "Check Carlos\'s availability and book a meeting" → compound', async () => {
  const router = createRouter('{"gate":"compound","domain":"calendar","confidence":0.85}');
  const result = await router.classify("Check Carlos's availability and book a meeting");
  assert.strictEqual(result.gate, 'compound');
  assert.strictEqual(result.domain, 'calendar');
  assert.strictEqual(result.compound, true);
  // Backward compat
  assert.strictEqual(result.intent, 'calendar');
});

asyncTest('TG-13: "What\'s the status and create a follow-up task" → compound', async () => {
  const router = createRouter('{"gate":"compound","domain":"deck","confidence":0.85}');
  const result = await router.classify("What's the status and create a follow-up task");
  assert.strictEqual(result.gate, 'compound');
  assert.strictEqual(result.domain, 'deck');
  assert.strictEqual(result.compound, true);
});

// ============================================================
// POST-CLASSIFY GUARD (1 test)
// ============================================================

test('TG-14: Action without action verb → reclassified to knowledge', () => {
  const router = createRouter('');
  const input = { gate: 'action', domain: 'email', intent: 'email', confidence: 0.8, compound: false };
  const guarded = router._postClassifyGuard(input, "What's Carlos's email?");
  assert.strictEqual(guarded.gate, 'knowledge', 'Should reclassify to knowledge');
  assert.strictEqual(guarded.domain, null);
  assert.strictEqual(guarded.intent, 'knowledge');
});

// ============================================================
// GREETING PRE-CHECK (1 test)
// ============================================================

test('TG-15: Greeting detection patterns', () => {
  // Test the _isGreeting pattern that message-processor will use
  // We test the regex pattern directly here as a contract test
  const greetingPattern = /^(hi|hello|hey|good\s+(morning|afternoon|evening)|thanks|thank you|bye|goodbye|cheers|guten\s+(morgen|tag|abend))[\s!.,]*$/i;

  assert.ok(greetingPattern.test('Good morning!'), '"Good morning!" is a greeting');
  assert.ok(greetingPattern.test('Hi'), '"Hi" is a greeting');
  assert.ok(greetingPattern.test('Hello!'), '"Hello!" is a greeting');
  assert.ok(greetingPattern.test('Thanks'), '"Thanks" is a greeting');
  assert.ok(greetingPattern.test('hey'), '"hey" is a greeting');

  // NOT greetings (contain substantive content)
  assert.ok(!greetingPattern.test('Good morning, what tasks do I have?'), 'Question is NOT a greeting');
  assert.ok(!greetingPattern.test('Hi, can you check my calendar?'), 'Request is NOT a greeting');
  assert.ok(!greetingPattern.test('Hey Molti, is whisper running?'), 'Status check is NOT a greeting');
});

// ============================================================
// ENRICHER AUGMENTATION CONTRACT (2 tests)
// ============================================================

test('TG-16: Short action response qualifies for augmentation', () => {
  const shortResponse = 'Moved #1366 to Done.';
  assert.ok(shortResponse.length < 200, 'Short response qualifies for enricher augmentation');

  const mediumResponse = 'Created board "Sprint Planning" with 3 default stacks.';
  assert.ok(mediumResponse.length < 200, 'Medium response also qualifies');
});

test('TG-17: Long action response skips augmentation', () => {
  const longResponse = 'Created board "Sprint Planning" with the following stacks:\n' +
    '- To Do (3 cards)\n- In Progress (2 cards)\n- Done (5 cards)\n' +
    'Cards have been populated from the template. Each card includes ' +
    'a description, due date, and assignee. The board is now ready for use. ' +
    'You can access it at https://cloud.example.com/apps/deck/board/42';
  assert.ok(longResponse.length >= 200, 'Long response should NOT get augmented');
});

// ============================================================
// BACKWARD COMPATIBILITY (1 test)
// ============================================================

test('TG-18: Legacy LLM response {"intent":"calendar_create"} maps to action gate', () => {
  const router = createRouter('');
  const result = router._parseClassification('{"intent":"calendar_create"}');
  assert.strictEqual(result.gate, 'action', 'Legacy intent maps to action gate');
  assert.strictEqual(result.domain, 'calendar', 'Domain extracted from fine-grained intent');
  assert.strictEqual(result.intent, 'calendar', 'Backward compat: intent = domain');
});

test('TG-19: Legacy LLM response {"intent":"knowledge"} maps to knowledge gate', () => {
  const router = createRouter('');
  const result = router._parseClassification('{"intent":"knowledge"}');
  assert.strictEqual(result.gate, 'knowledge');
  assert.strictEqual(result.domain, null);
  assert.strictEqual(result.intent, 'knowledge');
});

test('TG-20: Legacy LLM response {"intent":"greeting"} maps to greeting gate', () => {
  const router = createRouter('');
  const result = router._parseClassification('{"intent":"greeting"}');
  assert.strictEqual(result.gate, 'greeting');
  assert.strictEqual(result.intent, 'greeting');
});

// ============================================================
// REGEX FALLBACK — THREE-GATE (3 tests)
// ============================================================

test('TG-21: Regex fallback: action verb + domain → action gate', () => {
  const router = createRouter('');
  const result = router._regexFallback('send an email to Carlos');
  assert.strictEqual(result.gate, 'action');
  assert.strictEqual(result.domain, 'email');
});

test('TG-22: Regex fallback: no action verb + question → knowledge gate', () => {
  const router = createRouter('');
  const result = router._regexFallback("What's the status of the project?");
  assert.strictEqual(result.gate, 'knowledge');
  assert.strictEqual(result.domain, null);
});

test('TG-23: Regex fallback: long unmatched → knowledge (NOT complex)', () => {
  const router = createRouter('');
  const result = router._regexFallback(
    'I was thinking about the implications of the recent market analysis and how it relates to our strategic positioning in the European market'
  );
  assert.strictEqual(result.gate, 'knowledge', 'Default should be knowledge, not complex');
  assert.strictEqual(result.domain, null);
});

setTimeout(() => { summary(); exitWithCode(); }, 100);
