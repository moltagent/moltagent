'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const IntentRouter = require('../../../src/lib/agent/intent-router');

console.log('\n=== IntentRouter Tests ===\n');

// Helper: create mock provider
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

// -- Test 1: "hi" → greeting via LLM (no regex fast-path) --
asyncTest('classify() sends "hi" to LLM for classification', async () => {
  let llmCalled = false;
  const router = new IntentRouter({
    provider: { chat: async () => { llmCalled = true; return { content: '{"intent":"greeting"}' }; } },
    config: { classifyTimeout: 5000 }
  });
  const result = await router.classify('hi');
  assert.strictEqual(result.intent, 'greeting');
  assert.strictEqual(llmCalled, true, 'LLM SHOULD be called — no regex fast-path');
});

// -- Test 2: "good morning" → greeting via LLM --
asyncTest('classify() sends "good morning" to LLM for classification', async () => {
  const router = createRouter('{"intent":"greeting"}');
  const result = await router.classify('good morning');
  assert.strictEqual(result.intent, 'greeting');
  assert.strictEqual(result.needsHistory, false);
});

// -- Regression: "Hey Molti, what mode are you in?" must NOT be greeting --
asyncTest('classify() sends "Hey Molti, what mode are you in?" to LLM (no regex intercept)', async () => {
  const router = createRouter('{"intent":"complex"}');
  const result = await router.classify('Hey Molti, what mode are you in?');
  assert.strictEqual(result.intent, 'complex');
  assert.notStrictEqual(result.intent, 'greeting', 'Must NOT be classified as greeting');
});

// -- Regression: "Hi Molti, is whisper running?" must NOT be greeting --
asyncTest('classify() sends "Hi Molti, is whisper running?" to LLM (no regex intercept)', async () => {
  const router = createRouter('{"intent":"complex"}');
  const result = await router.classify('Hi Molti, is whisper running?');
  assert.strictEqual(result.intent, 'complex');
  assert.notStrictEqual(result.intent, 'greeting', 'Must NOT be classified as greeting');
});

// -- Regression: "Hey Molti, is whisper running now?" must NOT be greeting --
asyncTest('classify() sends "Hey Molti, is whisper running now?" to LLM (no regex intercept)', async () => {
  const router = createRouter('{"intent":"complex"}');
  const result = await router.classify('Hey Molti, is whisper running now, or still not reachable?');
  assert.strictEqual(result.intent, 'complex');
  assert.notStrictEqual(result.intent, 'greeting', 'Must NOT be classified as greeting');
});

// -- Boundary: bare greeting words still reach LLM --
asyncTest('classify() routes bare "Hey" to LLM, not regex', async () => {
  let llmCalled = false;
  const router = new IntentRouter({
    provider: { chat: async () => { llmCalled = true; return { content: '{"intent":"greeting"}' }; } },
    config: { classifyTimeout: 5000 }
  });
  const result = await router.classify('Hey');
  assert.strictEqual(llmCalled, true, 'LLM should be called even for bare greetings');
  assert.strictEqual(result.intent, 'greeting');
});

// -- Boundary: "Good morning, can you check my calendar?" → LLM decides --
asyncTest('classify() routes "Good morning, can you check my calendar?" to LLM', async () => {
  const router = createRouter('{"intent":"calendar"}');
  const result = await router.classify('Good morning, can you check my calendar?');
  assert.strictEqual(result.intent, 'domain');
  assert.strictEqual(result.domain, 'calendar');
});

// -- Test 3: LLM returns {"intent":"deck"} → domain:deck --
asyncTest('classify() returns domain:deck when LLM classifies as deck', async () => {
  const router = createRouter('{"intent":"deck"}');
  const result = await router.classify('create a card for the feature');
  assert.strictEqual(result.intent, 'domain');
  assert.strictEqual(result.domain, 'deck');
  assert.strictEqual(result.needsHistory, false);
});

// -- Test 4: LLM returns {"intent":"calendar"} → domain:calendar --
asyncTest('classify() returns domain:calendar when LLM classifies as calendar', async () => {
  const router = createRouter('{"intent":"calendar"}');
  const result = await router.classify('schedule a meeting for tomorrow');
  assert.strictEqual(result.intent, 'domain');
  assert.strictEqual(result.domain, 'calendar');
});

// -- Test 5: LLM returns {"intent":"email"} → domain:email --
asyncTest('classify() returns domain:email when LLM classifies as email', async () => {
  const router = createRouter('{"intent":"email"}');
  const result = await router.classify('send an email to Bob');
  assert.strictEqual(result.intent, 'domain');
  assert.strictEqual(result.domain, 'email');
});

// -- Test 6: LLM returns {"intent":"search"} → domain:search --
asyncTest('classify() returns domain:search when LLM classifies as search', async () => {
  const router = createRouter('{"intent":"search"}');
  const result = await router.classify('what do you know about Portugal');
  assert.strictEqual(result.intent, 'domain');
  assert.strictEqual(result.domain, 'search');
});

// -- Test 7: LLM returns {"intent":"confirmation"} → confirmation, needsHistory --
asyncTest('classify() returns confirmation with needsHistory when LLM classifies as confirmation', async () => {
  const router = createRouter('{"intent":"confirmation"}');
  const result = await router.classify('yes', [
    { role: 'assistant', content: 'Shall I create that card?' }
  ]);
  assert.strictEqual(result.intent, 'confirmation');
  assert.strictEqual(result.needsHistory, true);
});

// -- Test 8: LLM returns {"intent":"selection"} → selection, needsHistory --
asyncTest('classify() returns selection with needsHistory when LLM classifies as selection', async () => {
  const router = createRouter('{"intent":"selection"}');
  const result = await router.classify('2.', [
    { role: 'assistant', content: '1. Option A\n2. Option B' }
  ]);
  assert.strictEqual(result.intent, 'selection');
  assert.strictEqual(result.needsHistory, true);
});

// -- Test 9: LLM returns {"intent":"complex"} → complex, needsHistory --
asyncTest('classify() returns complex with needsHistory when LLM classifies as complex', async () => {
  const router = createRouter('{"intent":"complex"}');
  const result = await router.classify('analyze market trends and send report');
  assert.strictEqual(result.intent, 'complex');
  assert.strictEqual(result.needsHistory, true);
});

// -- Test 10: LLM returns garbage → complex fallback --
asyncTest('classify() returns complex fallback on garbage LLM response', async () => {
  const router = createRouter('I think this is about tasks maybe?');
  const result = await router.classify('something ambiguous');
  assert.strictEqual(result.intent, 'complex');
  assert.strictEqual(result.confidence, 0);
});

// -- Test 11: LLM throws (timeout) → complex fallback --
asyncTest('classify() returns complex fallback on LLM timeout/error', async () => {
  const router = new IntentRouter({
    provider: { chat: async () => { throw new Error('timeout'); } },
    config: { classifyTimeout: 5000 }
  });
  const result = await router.classify('something that times out');
  assert.strictEqual(result.intent, 'complex');
  assert.strictEqual(result.needsHistory, true);
  assert.strictEqual(result.confidence, 0);
});

// -- Test 12: LLM returns {"intent":"deck"} wrapped in think tags → parsed correctly --
asyncTest('classify() parses intent from response wrapped in think tags', async () => {
  const router = createRouter('<think>The user wants to manage cards...</think>{"intent":"deck"}');
  const result = await router.classify('move the card to done');
  assert.strictEqual(result.intent, 'domain');
  assert.strictEqual(result.domain, 'deck');
});

// -- Test 13: _parseClassification handles markdown fences --
test('_parseClassification handles markdown-fenced JSON', () => {
  const router = createRouter('');
  const result = router._parseClassification('```json\n{"intent":"wiki"}\n```');
  assert.strictEqual(result.intent, 'domain');
  assert.strictEqual(result.domain, 'wiki');
});

// -- Test 14: classify() passes recentContext to prompt --
asyncTest('classify() includes recentContext in LLM prompt', async () => {
  let capturedPrompt = '';
  const router = new IntentRouter({
    provider: {
      chat: async ({ messages }) => {
        capturedPrompt = messages[0].content;
        return { content: '{"intent":"confirmation"}' };
      }
    },
    config: { classifyTimeout: 5000 }
  });

  await router.classify('yes', [
    { role: 'user', content: 'Can you create a card?' },
    { role: 'assistant', content: 'Sure, shall I create it?' }
  ]);

  assert.ok(capturedPrompt.includes('Can you create a card?'), 'Prompt should include user context');
  assert.ok(capturedPrompt.includes('Sure, shall I create it?'), 'Prompt should include assistant context');
});

setTimeout(() => { summary(); exitWithCode(); }, 100);
