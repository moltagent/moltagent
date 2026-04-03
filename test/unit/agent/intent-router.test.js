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

// -- Boundary: "Good morning, can you check my calendar?" → LLM decides, trust its output --
asyncTest('classify() routes "Good morning, can you check my calendar?" to LLM', async () => {
  // Language-agnostic: no English-only regex guards. LLM output is trusted directly.
  // If the LLM returns "calendar" (action gate), we honour it.
  const router = createRouter('{"intent":"calendar"}');
  const result = await router.classify('Good morning, can you check my calendar?');
  // LLM said calendar → action gate (no post-classify override)
  assert.strictEqual(result.gate, 'action');
  assert.strictEqual(result.domain, 'calendar');
});

// -- Test 3: LLM returns {"intent":"deck"} → gate:action, domain:deck --
asyncTest('classify() returns gate:action domain:deck when LLM classifies as deck', async () => {
  const router = createRouter('{"intent":"deck"}');
  const result = await router.classify('create a card for the feature');
  assert.strictEqual(result.gate, 'action');
  assert.strictEqual(result.domain, 'deck');
  assert.strictEqual(result.needsHistory, false);
});

// -- Test 4: LLM returns {"intent":"calendar"} → gate:action, domain:calendar --
asyncTest('classify() returns gate:action domain:calendar when LLM classifies as calendar', async () => {
  const router = createRouter('{"intent":"calendar"}');
  const result = await router.classify('schedule a meeting for tomorrow');
  assert.strictEqual(result.gate, 'action');
  assert.strictEqual(result.domain, 'calendar');
});

// -- Test 5: LLM returns {"intent":"email"} → gate:action, domain:email --
asyncTest('classify() returns gate:action domain:email when LLM classifies as email', async () => {
  const router = createRouter('{"intent":"email"}');
  const result = await router.classify('send an email to Bob');
  assert.strictEqual(result.gate, 'action');
  assert.strictEqual(result.domain, 'email');
});

// -- Test 6: LLM returns {"intent":"search"} → search maps to knowledge gate (no action domain) --
asyncTest('classify() maps search intent to knowledge gate (search is a knowledge intent)', async () => {
  const router = createRouter('{"gate":"knowledge"}');
  const result = await router.classify('what do you know about Portugal');
  // LLM returns knowledge gate directly — no English-only post-classify guard
  assert.strictEqual(result.gate, 'knowledge');
  assert.strictEqual(result.domain, null);
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

// -- Test 10: LLM returns garbage → knowledge fallback (COMPLEX_FALLBACK is now gate:knowledge) --
asyncTest('classify() returns knowledge fallback on garbage LLM response', async () => {
  const router = createRouter('I think this is about tasks maybe?');
  const result = await router.classify('something ambiguous');
  assert.strictEqual(result.gate, 'knowledge');
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
  // "what is on my schedule today" has no action verb → regex falls back to knowledge gate
  assert.strictEqual(result.gate, 'knowledge');
  assert.strictEqual(result.domain, null);
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
  assert.strictEqual(result.confidence, 0.8);
});

// -- Test 11c: Non-timeout error → tries other model, then regex fallback --
asyncTest('classify() tries other model on error, then regex fallback', async () => {
  let callCount = 0;
  const router = new IntentRouter({
    provider: { chat: async () => { callCount++; throw new Error('Connection refused'); } },
    config: { classifyTimeout: 100 }
  });
  const result = await router.classify('check my email');
  assert.strictEqual(callCount, 2, 'Should try both models before regex fallback');
  // "check my email" has no action verb → 3 words short message → chitchat
  assert.strictEqual(result.gate, 'chitchat');
  assert.strictEqual(result.domain, null);
});

// -- Test 11d: Fallback model uses different timeout tier --
asyncTest('classify() fallback model uses appropriate timeout', async () => {
  const calls = [];
  const router = new IntentRouter({
    provider: {
      chat: async ({ model, timeout }) => {
        calls.push({ model, timeout });
        if (calls.length === 1) throw new Error('timeout');
        return { content: '{"intent":"deck"}' };
      }
    },
    config: { classifyTimeout: 5000 }
  });
  await router.classify('create a card');
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].model, 'qwen3:8b', 'First call is smart model');
  assert.strictEqual(calls[0].timeout, 20000, 'Smart model gets 4x timeout');
  assert.strictEqual(calls[1].model, 'qwen2.5:3b', 'Fallback is fast model');
  assert.strictEqual(calls[1].timeout, 5000, 'Fast model uses base timeout');
});

// -- Test 12: LLM returns {"intent":"deck"} wrapped in think tags → parsed correctly --
asyncTest('classify() parses intent from response wrapped in think tags', async () => {
  const router = createRouter('<think>The user wants to manage cards...</think>{"intent":"deck"}');
  const result = await router.classify('move the card to done');
  assert.strictEqual(result.gate, 'action');
  assert.strictEqual(result.domain, 'deck');
});

// -- Test 13: _parseClassification handles markdown fences --
test('_parseClassification handles markdown-fenced JSON', () => {
  const router = createRouter('');
  const result = router._parseClassification('```json\n{"intent":"wiki"}\n```');
  assert.strictEqual(result.gate, 'action');
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

test('_regexFallback routes calendar questions to knowledge (no action verb)', () => {
  const router = createRouter('');
  const cases = [
    "What's on my schedule today",
    'Do I have any meetings this week',
    'Any events tomorrow',
    "What's on my agenda"
  ];
  for (const msg of cases) {
    const result = router._regexFallback(msg);
    assert.strictEqual(result.gate, 'knowledge', `"${msg}" → should be knowledge (no action verb)`);
  }
});

test('_regexFallback routes "check my email" to chitchat (no action verb, short message)', () => {
  const router = createRouter('');
  const result = router._regexFallback('check my email');
  assert.strictEqual(result.gate, 'chitchat');
});

test('_regexFallback routes "show my tasks" to chitchat (no action verb, short message)', () => {
  const router = createRouter('');
  const result = router._regexFallback('show my tasks');
  assert.strictEqual(result.gate, 'chitchat');
});

test('_regexFallback routes "open the wiki page" to chitchat (no action verb, short message)', () => {
  const router = createRouter('');
  const result = router._regexFallback('open the wiki page');
  assert.strictEqual(result.gate, 'chitchat');
});

test('_regexFallback maps file keywords correctly (upload is action verb)', () => {
  const router = createRouter('');
  const result = router._regexFallback('upload this document');
  assert.strictEqual(result.gate, 'action');
  assert.strictEqual(result.domain, 'file');
});

test('_regexFallback routes "search for project docs" to chitchat (no action verb, short message)', () => {
  const router = createRouter('');
  const result = router._regexFallback('search for project docs');
  assert.strictEqual(result.gate, 'chitchat');
});

test('_regexFallback returns chitchat for short ambiguous messages', () => {
  const router = createRouter('');
  const result = router._regexFallback('hey how are you doing');
  assert.strictEqual(result.gate, 'chitchat');
  assert.strictEqual(result.confidence, 0.4);
});

test('_regexFallback returns knowledge for long ambiguous messages', () => {
  const router = createRouter('');
  const result = router._regexFallback(
    'I need you to analyze the current market trends and compare them with our previous quarterly results and then generate a comprehensive report'
  );
  assert.strictEqual(result.gate, 'knowledge');
  assert.strictEqual(result.confidence, 0.3);
});

// -- Prompt tests --

asyncTest('System prompt has three-gate sections and context-aware rules', async () => {
  let capturedSystem = '';
  const router = new IntentRouter({
    provider: {
      chat: async ({ system }) => {
        capturedSystem = system;
        return { content: '{"intent":"calendar_query"}' };
      }
    },
    config: { classifyTimeout: 5000 }
  });
  await router.classify("What's on my schedule for today?");
  assert.ok(capturedSystem.includes('ACTION'), 'System prompt should have ACTION section');
  assert.ok(capturedSystem.includes('KNOWLEDGE'), 'System prompt should have KNOWLEDGE section');
  assert.ok(capturedSystem.includes('COMPOUND'), 'System prompt should have COMPOUND section');
  assert.ok(capturedSystem.includes('CONTEXT-AWARE RULES'), 'System prompt should have context-aware rules');
});

// === Layer 2: Context-Aware Classification ===

asyncTest('classify() includes <conversation> tags when context provided', async () => {
  let capturedPrompt = '';
  const router = new IntentRouter({
    provider: {
      chat: async ({ messages }) => {
        capturedPrompt = messages[0].content;
        return { content: '{"intent":"calendar_delete"}' };
      }
    },
    config: { classifyTimeout: 5000 }
  });

  await router.classify('Delete the dentist', [
    { role: 'user', content: 'What events do I have tomorrow?' },
    { role: 'assistant', content: 'You have 3 events: Team Standup at 9am, Client Call at 2pm, Dentist at 5pm' }
  ]);

  assert.ok(capturedPrompt.includes('<conversation>'), 'Prompt should include <conversation> tag');
  assert.ok(capturedPrompt.includes('</conversation>'), 'Prompt should include </conversation> tag');
  assert.ok(capturedPrompt.includes('What events do I have tomorrow'), 'Prompt should include user context');
  assert.ok(capturedPrompt.includes('Dentist at 5pm'), 'Prompt should include assistant context');
});

asyncTest('classify() context block absent when recentContext is empty', async () => {
  let capturedPrompt = '';
  const router = new IntentRouter({
    provider: {
      chat: async ({ messages }) => {
        capturedPrompt = messages[0].content;
        return { content: '{"intent":"chitchat"}' };
      }
    },
    config: { classifyTimeout: 5000 }
  });

  await router.classify('Good morning', []);
  assert.ok(!capturedPrompt.includes('<conversation>'), 'No context block when empty');
});

asyncTest('classify() truncates context entries to 200 chars', async () => {
  let capturedPrompt = '';
  const longContent = 'A'.repeat(300);
  const router = new IntentRouter({
    provider: {
      chat: async ({ messages }) => {
        capturedPrompt = messages[0].content;
        return { content: '{"intent":"deck_query"}' };
      }
    },
    config: { classifyTimeout: 5000 }
  });

  await router.classify('Show me the first one', [
    { role: 'assistant', content: longContent }
  ]);

  // Content should be truncated to 200 chars, not the full 300
  assert.ok(!capturedPrompt.includes('A'.repeat(201)), 'Context entries should be truncated to 200 chars');
  assert.ok(capturedPrompt.includes('A'.repeat(200)), 'Context should include up to 200 chars');
});

asyncTest('classify() includes up to 6 context entries (3 exchanges)', async () => {
  let capturedPrompt = '';
  const router = new IntentRouter({
    provider: {
      chat: async ({ messages }) => {
        capturedPrompt = messages[0].content;
        return { content: '{"intent":"deck_move"}' };
      }
    },
    config: { classifyTimeout: 5000 }
  });

  const context = [
    { role: 'user', content: 'exchange-1-user' },
    { role: 'assistant', content: 'exchange-1-assistant' },
    { role: 'user', content: 'exchange-2-user' },
    { role: 'assistant', content: 'exchange-2-assistant' },
    { role: 'user', content: 'exchange-3-user' },
    { role: 'assistant', content: 'exchange-3-assistant' },
    { role: 'user', content: 'exchange-4-user' },
    { role: 'assistant', content: 'exchange-4-assistant' },
  ];

  await router.classify('Move it to done', context);

  // Should include last 6 (3 exchanges), NOT the first 2
  assert.ok(!capturedPrompt.includes('exchange-1-user'), 'Should not include oldest exchange');
  assert.ok(capturedPrompt.includes('exchange-3-user'), 'Should include 3rd exchange');
  assert.ok(capturedPrompt.includes('exchange-4-assistant'), 'Should include most recent exchange');
});

asyncTest('system prompt contains context-aware rules', async () => {
  let capturedSystem = '';
  const router = new IntentRouter({
    provider: {
      chat: async ({ system }) => {
        capturedSystem = system;
        return { content: '{"intent":"chitchat"}' };
      }
    },
    config: { classifyTimeout: 5000 }
  });

  await router.classify('hello');
  assert.ok(capturedSystem.includes('Read the <conversation> block FIRST'), 'System prompt should instruct reading context first');
  assert.ok(capturedSystem.includes('move it to done'), 'System prompt should include concrete continuation example');
  assert.ok(capturedSystem.includes('prefer the domain'), 'System prompt should include domain continuation bias');
});

// === buildClassificationPrompt static API ===

test('buildClassificationPrompt is exported as static method', () => {
  assert.strictEqual(typeof IntentRouter.buildClassificationPrompt, 'function',
    'buildClassificationPrompt should be a static function on IntentRouter');
});

test('buildClassificationPrompt defaults to EN when no language given', () => {
  const prompt = IntentRouter.buildClassificationPrompt();
  assert.ok(prompt.includes('just listed files'), 'EN prompt should include file context rule');
  assert.ok(prompt.includes('Upload the report'), 'EN prompt should include file action example');
});

test('buildClassificationPrompt returns DE examples for DE language', () => {
  const prompt = IntentRouter.buildClassificationPrompt('DE');
  assert.ok(prompt.includes('Lade den Bericht hoch'), 'DE prompt should include German file upload example');
  assert.ok(prompt.includes('Erstelle ein Board'), 'DE prompt should include German deck example');
});

test('buildClassificationPrompt returns PT examples for PT language', () => {
  const prompt = IntentRouter.buildClassificationPrompt('PT');
  assert.ok(prompt.includes('Carrega o relatório'), 'PT prompt should include Portuguese file upload example');
});

test('buildClassificationPrompt falls back to EN for unknown language', () => {
  const prompt = IntentRouter.buildClassificationPrompt('ZZ');
  const enPrompt = IntentRouter.buildClassificationPrompt('EN');
  assert.strictEqual(prompt, enPrompt, 'Unknown language should fall back to EN');
});

test('system prompt includes file context rule (via buildClassificationPrompt)', () => {
  const prompt = IntentRouter.buildClassificationPrompt('EN');
  assert.ok(prompt.includes('just listed files'), 'Prompt should include file context rule');
  assert.ok(prompt.includes('Upload the report'), 'Prompt should include file action example');
});

asyncTest('classify() uses smart model first', async () => {
  // Smart model (qwen3:8b) is tried first, fast model (qwen2.5:3b) is fallback.
  const models = [];
  const router = new IntentRouter({
    provider: {
      chat: async ({ model }) => {
        models.push(model);
        return { content: '{"intent":"file_query"}' };
      }
    },
    config: { classifyTimeout: 5000 }
  });

  await router.classify('read the most recent one and tell me what you learned', [
    { role: 'user', content: 'list my files' },
    { role: 'assistant', content: 'report.pdf — 2KB — 2026-03-02\nnotes.txt — 512B — 2026-03-03' }
  ]);

  assert.strictEqual(models[0], 'qwen3:8b', 'Smart model should be used first');
});

setTimeout(() => { summary(); exitWithCode(); }, 100);
