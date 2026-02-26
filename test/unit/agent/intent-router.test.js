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

// -- Test 11: LLM timeout → retries once, then regex fallback --
asyncTest('classify() retries on timeout then falls back to regex', async () => {
  let callCount = 0;
  const router = new IntentRouter({
    provider: { chat: async () => { callCount++; throw new Error('Request timed out'); } },
    config: { classifyTimeout: 100 }
  });
  const result = await router.classify('what is on my schedule today');
  assert.strictEqual(callCount, 2, 'Should have tried twice (initial + retry)');
  // Regex fallback should pick up "schedule" → calendar
  assert.strictEqual(result.intent, 'domain');
  assert.strictEqual(result.domain, 'calendar');
  assert.strictEqual(result.confidence, 0.5);
});

// -- Test 11b: LLM timeout → retry succeeds --
asyncTest('classify() succeeds on retry after first timeout', async () => {
  let callCount = 0;
  const router = new IntentRouter({
    provider: {
      chat: async () => {
        callCount++;
        if (callCount === 1) throw new Error('Request timed out');
        return { content: '{"intent":"greeting"}' };
      }
    },
    config: { classifyTimeout: 100 }
  });
  const result = await router.classify('hey there');
  assert.strictEqual(callCount, 2, 'Should have tried twice');
  assert.strictEqual(result.intent, 'greeting');
  assert.strictEqual(result.confidence, 0.9);
});

// -- Test 11c: Non-timeout error → regex fallback (no retry) --
asyncTest('classify() uses regex fallback on non-timeout error (no retry)', async () => {
  let callCount = 0;
  const router = new IntentRouter({
    provider: { chat: async () => { callCount++; throw new Error('Connection refused'); } },
    config: { classifyTimeout: 100 }
  });
  const result = await router.classify('check my email');
  assert.strictEqual(callCount, 1, 'Should NOT retry on non-timeout error');
  assert.strictEqual(result.intent, 'domain');
  assert.strictEqual(result.domain, 'email');
});

// -- Test 11d: Retry uses 2× timeout --
asyncTest('classify() retries with doubled timeout', async () => {
  const timeouts = [];
  const router = new IntentRouter({
    provider: {
      chat: async ({ timeout }) => {
        timeouts.push(timeout);
        if (timeouts.length === 1) throw new Error('timeout');
        return { content: '{"intent":"deck"}' };
      }
    },
    config: { classifyTimeout: 5000 }
  });
  await router.classify('create a card');
  assert.strictEqual(timeouts.length, 2);
  assert.strictEqual(timeouts[0], 5000, 'First attempt uses base timeout');
  assert.strictEqual(timeouts[1], 10000, 'Retry uses 2× timeout');
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

// -- _regexFallback tests --

test('_regexFallback maps calendar keywords correctly', () => {
  const router = createRouter('');
  const cases = [
    ["What's on my schedule today", 'calendar'],
    ['Do I have any meetings this week', 'calendar'],
    ['Check my calendar', 'calendar'],
    ['Any events tomorrow', 'calendar'],
    ["What's on my agenda", 'calendar']
  ];
  for (const [msg, expectedDomain] of cases) {
    const result = router._regexFallback(msg);
    assert.strictEqual(result.intent, 'domain', `"${msg}" → intent should be domain`);
    assert.strictEqual(result.domain, expectedDomain, `"${msg}" → domain should be ${expectedDomain}`);
  }
});

test('_regexFallback maps email keywords correctly', () => {
  const router = createRouter('');
  const result = router._regexFallback('check my email');
  assert.strictEqual(result.domain, 'email');
});

test('_regexFallback maps deck keywords correctly', () => {
  const router = createRouter('');
  const result = router._regexFallback('show my tasks');
  assert.strictEqual(result.domain, 'deck');
});

test('_regexFallback maps wiki keywords correctly', () => {
  const router = createRouter('');
  const result = router._regexFallback('open the wiki page');
  assert.strictEqual(result.domain, 'wiki');
});

test('_regexFallback maps file keywords correctly', () => {
  const router = createRouter('');
  const result = router._regexFallback('upload this document');
  assert.strictEqual(result.domain, 'file');
});

test('_regexFallback maps search keywords correctly', () => {
  const router = createRouter('');
  const result = router._regexFallback('search for project docs');
  assert.strictEqual(result.domain, 'search');
});

test('_regexFallback returns chitchat for short ambiguous messages', () => {
  const router = createRouter('');
  const result = router._regexFallback('hey how are you doing');
  assert.strictEqual(result.intent, 'chitchat');
  assert.strictEqual(result.confidence, 0.4);
});

test('_regexFallback returns complex for long ambiguous messages', () => {
  const router = createRouter('');
  const result = router._regexFallback(
    'I need you to analyze the current market trends and compare them with our previous quarterly results and then generate a comprehensive report'
  );
  assert.strictEqual(result.intent, 'complex');
  assert.strictEqual(result.confidence, 0.3);
});

// -- _isTimeoutError tests --

test('_isTimeoutError detects timeout variants', () => {
  const router = createRouter('');
  assert.strictEqual(router._isTimeoutError(new Error('Request timed out')), true);
  assert.strictEqual(router._isTimeoutError(new Error('timeout')), true);
  assert.strictEqual(router._isTimeoutError(new Error('The operation was aborted')), true);
  assert.strictEqual(router._isTimeoutError(new Error('Connection refused')), false);
  assert.strictEqual(router._isTimeoutError(new Error('ECONNRESET')), false);
  assert.strictEqual(router._isTimeoutError(new Error('')), false);
});

// -- Prompt improvement: calendar schedule keywords --

asyncTest('_buildPrompt includes schedule/agenda hints for calendar', async () => {
  let capturedPrompt = '';
  const router = new IntentRouter({
    provider: {
      chat: async ({ messages }) => {
        capturedPrompt = messages[0].content;
        return { content: '{"intent":"calendar"}' };
      }
    },
    config: { classifyTimeout: 5000 }
  });
  await router.classify("What's on my schedule for today?");
  assert.ok(capturedPrompt.includes('schedule'), 'Prompt should mention schedule in calendar hints');
  assert.ok(capturedPrompt.includes('agenda'), 'Prompt should mention agenda in calendar hints');
  assert.ok(
    capturedPrompt.includes('schedule, agenda, or what'),
    'Prompt should have rule about schedule → calendar'
  );
});

setTimeout(() => { summary(); exitWithCode(); }, 100);
