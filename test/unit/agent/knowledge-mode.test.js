/*
 * MoltAgent - Sovereign AI Security Layer
 * Copyright (C) 2026 MoltAgent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

'use strict';

/**
 * Unit Tests for Knowledge Mode Routing
 *
 * Tests that knowledge queries route to the knowledge handler,
 * tool actions still route to domain executors, and the enricher
 * fallback works when domain executors return "not found".
 *
 * Run: node test/unit/agent/knowledge-mode.test.js
 *
 * @module test/unit/agent/knowledge-mode
 */

const assert = require('assert');
const { asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const IntentRouter = require('../../../src/lib/agent/intent-router');

console.log('\n=== Knowledge Mode Routing Tests ===\n');

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

// ============================================================
// Classification Tests
// ============================================================

asyncTest('TC-KM-001: "Who is Carlos?" → classified as knowledge, not email', async () => {
  const router = createRouter('{"intent":"knowledge"}');
  const result = await router.classify('Who is Carlos?');
  assert.strictEqual(result.domain, 'knowledge');
});

asyncTest('TC-KM-002: "What\'s Carlos\'s email?" → classified as knowledge, not email', async () => {
  const router = createRouter('{"intent":"knowledge"}');
  const result = await router.classify("What's Carlos's email?");
  assert.strictEqual(result.domain, 'knowledge');
});

asyncTest('TC-KM-003: "What\'s the status of onboarding?" → classified as knowledge, not calendar', async () => {
  const router = createRouter('{"intent":"knowledge"}');
  const result = await router.classify("What's the status of onboarding?");
  assert.strictEqual(result.domain, 'knowledge');
});

asyncTest('TC-KM-004: "Tell me about Paradiesgarten" → classified as knowledge', async () => {
  const router = createRouter('{"intent":"knowledge"}');
  const result = await router.classify('Tell me about Paradiesgarten');
  assert.strictEqual(result.domain, 'knowledge');
});

asyncTest('TC-KM-005: "Send an email to Carlos" → classified as email (tool action, unchanged)', async () => {
  const router = createRouter('{"intent":"email_send"}');
  const result = await router.classify('Send an email to Carlos');
  assert.strictEqual(result.domain, 'email');
});

asyncTest('TC-KM-006: "Create a board" → classified as deck (tool action, unchanged)', async () => {
  const router = createRouter('{"intent":"deck_create"}');
  const result = await router.classify('Create a board');
  assert.strictEqual(result.domain, 'deck');
});

asyncTest('TC-KM-007: knowledge intent is valid and maps to domain routing', async () => {
  const router = createRouter('{"intent":"knowledge"}');
  const result = await router.classify('What do you know about Project Phoenix?');
  assert.strictEqual(result.intent, 'domain');
  assert.strictEqual(result.domain, 'knowledge');
  assert.strictEqual(result.needsHistory, false);
});

// ============================================================
// Regex Fallback Tests
// ============================================================

asyncTest('TC-KM-008: Regex fallback routes "who is" to knowledge', async () => {
  // Both models fail → regex fallback
  const router = new IntentRouter({
    provider: { chat: async () => { throw new Error('model unavailable'); } },
    config: { classifyTimeout: 100, fastModel: 'fake', smartModel: 'fake' }
  });
  const result = await router.classify('who is Carlos and what does he do?');
  assert.strictEqual(result.domain, 'knowledge');
});

asyncTest('TC-KM-009: Regex fallback routes "tell me about" to knowledge', async () => {
  const router = new IntentRouter({
    provider: { chat: async () => { throw new Error('model unavailable'); } },
    config: { classifyTimeout: 100, fastModel: 'fake', smartModel: 'fake' }
  });
  const result = await router.classify('tell me about the Paradiesgarten client');
  assert.strictEqual(result.domain, 'knowledge');
});

asyncTest('TC-KM-010: Regex fallback still routes "send email" to email domain', async () => {
  const router = new IntentRouter({
    provider: { chat: async () => { throw new Error('model unavailable'); } },
    config: { classifyTimeout: 100, fastModel: 'fake', smartModel: 'fake' }
  });
  const result = await router.classify('send an email to Carlos about the project update');
  assert.strictEqual(result.domain, 'email');
});

// ============================================================
// Feedback Messages Tests
// ============================================================

asyncTest('TC-KM-011: Feedback message exists for knowledge intent', async () => {
  const { getFeedbackMessage } = require('../../../src/lib/talk/feedback-messages');
  const msg = getFeedbackMessage('knowledge');
  assert.ok(msg, 'Should return a feedback message');
  assert.ok(msg.includes('knowledge base'), 'Should mention knowledge base');
});

// ============================================================
// MicroPipeline Enricher Fallback Tests
// ============================================================

asyncTest('TC-KM-012: _isNotFoundResponse detects "not found" responses', async () => {
  // Import MicroPipeline to test _isNotFoundResponse
  const MicroPipeline = require('../../../src/lib/agent/micro-pipeline');
  const pipeline = new MicroPipeline({ logger: console });

  assert.strictEqual(pipeline._isNotFoundResponse("I don't have anything about that."), true);
  assert.strictEqual(pipeline._isNotFoundResponse("No results found for that query."), true);
  assert.strictEqual(pipeline._isNotFoundResponse("I couldn't find that information."), true);
  assert.strictEqual(pipeline._isNotFoundResponse("Here is the information you asked for."), false);
  assert.strictEqual(pipeline._isNotFoundResponse("Carlos is the project manager."), false);
  assert.strictEqual(pipeline._isNotFoundResponse(42), false);
});

asyncTest('TC-KM-013: Knowledge intent is in INTENTS constant', async () => {
  const MicroPipeline = require('../../../src/lib/agent/micro-pipeline');
  assert.strictEqual(MicroPipeline.INTENTS.KNOWLEDGE, 'knowledge');
});

// ============================================================
// Classifier Prompt Tests
// ============================================================

asyncTest('TC-KM-014: Classification prompt includes knowledge intent', async () => {
  const prompt = IntentRouter.CLASSIFICATION_SYSTEM_PROMPT;
  assert.ok(prompt.includes('knowledge'), 'Prompt should include knowledge intent');
  assert.ok(prompt.includes('KNOWLEDGE INTENT'), 'Prompt should have KNOWLEDGE INTENT section');
  assert.ok(prompt.includes('action vs question'), 'Prompt should distinguish action from question');
});

asyncTest('TC-KM-015: Classification prompt includes "when in doubt → knowledge"', async () => {
  const prompt = IntentRouter.CLASSIFICATION_SYSTEM_PROMPT;
  assert.ok(prompt.includes('When in doubt'), 'Prompt should have "when in doubt" guidance');
  assert.ok(prompt.includes('knowledge'), 'Default should be knowledge');
});

setTimeout(() => {
  console.log('\n=== Knowledge Mode Tests Complete ===\n');
  summary();
  exitWithCode();
}, 500);
