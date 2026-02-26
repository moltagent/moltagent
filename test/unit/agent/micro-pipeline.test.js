'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const MicroPipeline = require('../../../src/lib/agent/micro-pipeline');

const silentLogger = { log() {}, info() {}, warn() {}, error() {} };

function createMockRouter(routeResponse) {
  return {
    route: async () => routeResponse || { result: 'Mock response', provider: 'mock', tokens: 10 },
    hasCloudPlayers: () => false,
    isCloudAvailable: async () => false
  };
}

function createMockMemorySearcher(results) {
  return {
    search: async () => results || []
  };
}

function createMockDeckClient() {
  const cards = [];
  return {
    createCard: async (stack, card) => { cards.push({ stack, ...card }); },
    getCreatedCards: () => cards
  };
}

function createMockDeferralQueue() {
  const tasks = [];
  return {
    enqueue: async (task) => { tasks.push(task); },
    getEnqueued: () => tasks
  };
}

// -- Test 1: _classifyFallback() routes "Hello!" to chitchat (single word → short msg heuristic) --
asyncTest('_classifyFallback() routes single-word "Hello!" to chitchat', async () => {
  const pipeline = new MicroPipeline({ llmRouter: createMockRouter(), logger: silentLogger });
  const result = await pipeline._classifyFallback('Hello!');
  assert.strictEqual(result.intent, 'chitchat', 'Single word should be chitchat (no greeting fast-path)');
});

// -- Test 2: _classifyFallback() routes "Hey Molti, what mode are you in?" to LLM (regression) --
asyncTest('_classifyFallback() sends "Hey Molti, what mode..." to LLM, not greeting regex', async () => {
  let llmCalled = false;
  const router = {
    route: async () => { llmCalled = true; return { result: 'chitchat', provider: 'mock', tokens: 5 }; },
    hasCloudPlayers: () => false,
    isCloudAvailable: async () => false
  };
  const pipeline = new MicroPipeline({ llmRouter: router, logger: silentLogger });
  const result = await pipeline._classifyFallback('Hey Molti, what mode are you in?');
  assert.strictEqual(llmCalled, true, 'LLM should be called for messages starting with greeting words');
  assert.notStrictEqual(result.intent, 'greeting', 'Must NOT be classified as greeting');
});

// -- Test 3: _handleQuestion() searches memory then synthesizes --
asyncTest('_handleQuestion() searches memory then synthesizes', async () => {
  const router = createMockRouter({ result: 'Synthesized answer from memory', provider: 'mock', tokens: 50 });
  const searcher = createMockMemorySearcher([
    { title: 'Meeting notes', subline: 'Discussed project timeline', resourceUrl: '/page/1' }
  ]);

  const pipeline = new MicroPipeline({ llmRouter: router, memorySearcher: searcher, logger: silentLogger });
  const result = await pipeline._handleQuestion('What was discussed in the meeting?', {}, {});
  assert.strictEqual(result, 'Synthesized answer from memory');
});

// -- Test 4: _handleQuestion() falls back to simple chat when search empty --
asyncTest('_handleQuestion() falls back to simple chat when no search results', async () => {
  const router = createMockRouter({ result: 'Direct chat response', provider: 'mock', tokens: 20 });
  const searcher = createMockMemorySearcher([]);

  const pipeline = new MicroPipeline({ llmRouter: router, memorySearcher: searcher, logger: silentLogger });
  const result = await pipeline._handleQuestion('What is the meaning of life?', {}, {});
  assert.strictEqual(result, 'Direct chat response');
});

// -- Test 5: _handleTask() extracts parameters and routes to Deck --
asyncTest('_handleTask() creates a Deck card for task requests', async () => {
  const deckClient = createMockDeckClient();
  const pipeline = new MicroPipeline({ llmRouter: createMockRouter(), deckClient, logger: silentLogger });

  const result = await pipeline._handleTask('Create a report on Q4 sales', {}, { userName: 'Bob' });
  assert.ok(result.includes('task board'));
  assert.strictEqual(deckClient.getCreatedCards().length, 1);
  assert.strictEqual(deckClient.getCreatedCards()[0].stack, 'inbox');
});

// -- Test 6: _handleComplex() defers when cloud players exist --
asyncTest('_handleComplex() defers to cloud when hasCloudPlayers', async () => {
  const router = {
    route: async () => ({ result: 'response', provider: 'mock', tokens: 10 }),
    hasCloudPlayers: () => true,
    isCloudAvailable: async () => false
  };
  const dq = createMockDeferralQueue();

  const pipeline = new MicroPipeline({ llmRouter: router, deferralQueue: dq, logger: silentLogger });
  const result = await pipeline._handleComplex('Analyze the market trends and compare competitors', {}, { userName: 'Carol' });

  assert.ok(result.includes('queued'));
  assert.strictEqual(dq.getEnqueued().length, 1);
});

// -- Test 7: _handleComplex() decomposes when no cloud players --
asyncTest('_handleComplex() decomposes when no cloud players configured', async () => {
  let callCount = 0;
  const router = {
    route: async ({ content }) => {
      callCount++;
      if (callCount === 1) {
        // Decomposition call
        return { result: '- What are current trends?\n- Who are top competitors?', provider: 'mock', tokens: 30 };
      }
      // Sub-question answers
      return { result: `Answer ${callCount}`, provider: 'mock', tokens: 20 };
    },
    hasCloudPlayers: () => false,
    isCloudAvailable: async () => false
  };

  const pipeline = new MicroPipeline({ llmRouter: router, logger: silentLogger });
  const result = await pipeline._handleComplex('Analyze market trends and compare competitors', {}, {});

  assert.ok(callCount >= 2, `Expected at least 2 router calls for decomposition, got ${callCount}`);
  assert.ok(result.length > 0);
});

// -- Test 8: _decomposeAndProcess() breaks task into sub-questions --
asyncTest('_decomposeAndProcess() breaks task into sub-questions and stitches', async () => {
  let callCount = 0;
  const router = {
    route: async () => {
      callCount++;
      if (callCount === 1) {
        return { result: '- Sub-question one about data\n- Sub-question two about analysis', provider: 'mock', tokens: 20 };
      }
      return { result: `Detailed answer ${callCount}`, provider: 'mock', tokens: 30 };
    },
    hasCloudPlayers: () => false,
    isCloudAvailable: async () => false
  };

  const pipeline = new MicroPipeline({ llmRouter: router, logger: silentLogger });
  const result = await pipeline._decomposeAndProcess('Complex analysis request', {});

  assert.ok(result.includes('Detailed answer'), `Expected stitched answer, got: ${result.substring(0, 100)}`);
});

// -- Test 9: _fallbackStitch produces readable output when synthesis fails --
test('_stitchAnswers() produces readable output', () => {
  const pipeline = new MicroPipeline({ llmRouter: createMockRouter(), logger: silentLogger });
  const result = pipeline._stitchAnswers('original', [
    { question: 'Part 1', answer: 'Answer to part 1' },
    { question: 'Part 2', answer: 'Answer to part 2' }
  ]);

  assert.ok(result.includes('Part 1'));
  assert.ok(result.includes('Answer to part 1'));
  assert.ok(result.includes('Part 2'));
});

// -- Test 10: process() routes "Hello there!" to chat handler (no greeting template) --
asyncTest('process() routes "Hello there!" to chat handler, not greeting template', async () => {
  const router = createMockRouter({ result: 'Hi Dave, how can I help?', provider: 'mock', tokens: 20 });
  const pipeline = new MicroPipeline({ llmRouter: router, logger: silentLogger });
  const result = await pipeline.process('Hello there!', { userName: 'Dave' });

  assert.ok(typeof result === 'string');
  assert.strictEqual(pipeline.getStats().byIntent.greeting, undefined, 'Should NOT have greeting intent');
});

// -- Test 11: process() routes question intent to search+synthesize --
asyncTest('process() routes question intent to search+synthesize handler', async () => {
  const router = createMockRouter({ result: 'question', provider: 'mock', tokens: 5 });
  // Override route to return 'question' for classify, then answer for synthesis
  let callNum = 0;
  router.route = async () => {
    callNum++;
    if (callNum === 1) return { result: 'question', provider: 'mock', tokens: 5 };
    return { result: 'Answer from LLM', provider: 'mock', tokens: 50 };
  };
  const searcher = createMockMemorySearcher([
    { title: 'Relevant page', subline: 'Some relevant content' }
  ]);

  const pipeline = new MicroPipeline({ llmRouter: router, memorySearcher: searcher, logger: silentLogger });
  // Use a question that doesn't match any domain pattern
  const result = await pipeline.process('How does the deployment process work?', {});

  assert.strictEqual(result, 'Answer from LLM');
});

// -- Test 12: _classifyFallback() detects domain-specific intents via regex --
asyncTest('_classifyFallback() detects deck intent from task keywords', async () => {
  const pipeline = new MicroPipeline({ llmRouter: createMockRouter(), logger: silentLogger });
  const result = await pipeline._classifyFallback('Create a card for the new feature');
  assert.strictEqual(result.intent, 'deck');
});

asyncTest('_classifyFallback() detects calendar intent from meeting keywords', async () => {
  const pipeline = new MicroPipeline({ llmRouter: createMockRouter(), logger: silentLogger });
  const result = await pipeline._classifyFallback('What time is the meeting tomorrow?');
  assert.strictEqual(result.intent, 'calendar');
});

asyncTest('_classifyFallback() detects multi-domain as complex', async () => {
  const pipeline = new MicroPipeline({ llmRouter: createMockRouter(), logger: silentLogger });
  const result = await pipeline._classifyFallback('Create a task for the meeting notes and send an email about it');
  assert.strictEqual(result.intent, 'complex');
});

// -- Test 13: _handleDomainTask() falls back to chat without toolRegistry --
asyncTest('_handleDomainTask() falls back to chat when no toolRegistry', async () => {
  const router = createMockRouter({ result: 'Fallback response', provider: 'mock', tokens: 20 });
  const pipeline = new MicroPipeline({ llmRouter: router, logger: silentLogger });
  const result = await pipeline._handleDomainTask('Create a card', 'deck', {});
  assert.strictEqual(result, 'Fallback response');
});

// -- Test 14: _detectDomains() returns correct domain hits --
asyncTest('_detectDomains() returns correct domain hits', async () => {
  const pipeline = new MicroPipeline({ llmRouter: createMockRouter(), logger: silentLogger });
  assert.deepStrictEqual(pipeline._detectDomains('create a card'), ['deck']);
  assert.deepStrictEqual(pipeline._detectDomains('schedule a meeting'), ['calendar']);
  assert.deepStrictEqual(pipeline._detectDomains('send an email'), ['email']);
  assert.deepStrictEqual(pipeline._detectDomains('search the wiki'), ['wiki']); // search dedup: wiki wins
  assert.deepStrictEqual(pipeline._detectDomains('find the file'), ['file']); // search dedup: file wins
  assert.deepStrictEqual(pipeline._detectDomains('hello there'), []);
});

// -- Test 15: _classifyFallback() routes short confirmations to chitchat (IntentRouter handles context) --
asyncTest('_classifyFallback() routes short confirmations to chitchat (IntentRouter handles these)', async () => {
  const pipeline = new MicroPipeline({ llmRouter: createMockRouter(), logger: silentLogger });
  // Short single-word messages fall through to word-count heuristic → chitchat
  // Confirmation/selection routing is now handled by IntentRouter with conversation context
  const result = await pipeline._classifyFallback('yes');
  assert.strictEqual(result.intent, 'chitchat', 'Short words should be chitchat in fallback (IntentRouter handles confirmations)');
});

asyncTest('_classifyFallback() does not treat confirmations inside longer messages as confirmation intent', async () => {
  const pipeline = new MicroPipeline({ llmRouter: createMockRouter(), logger: silentLogger });
  // "yes" inside a longer message should NOT trigger confirmation fast-path
  const result = await pipeline._classifyFallback('Yes I would like to create a card for the new feature');
  assert.notStrictEqual(result.intent, 'complex', `Long message starting with "Yes" should not be classified as complex confirmation`);
});

// -- Test 16: _classifyFallback() routes short numeric selections to chitchat (IntentRouter handles context) --
asyncTest('_classifyFallback() routes short numeric selections to chitchat (IntentRouter handles these)', async () => {
  const pipeline = new MicroPipeline({ llmRouter: createMockRouter(), logger: silentLogger });
  // Short numeric messages fall through to word-count heuristic → chitchat
  // Selection routing is now handled by IntentRouter with conversation context
  const result = await pipeline._classifyFallback('2.');
  assert.strictEqual(result.intent, 'chitchat', 'Short numeric should be chitchat in fallback (IntentRouter handles selections)');
});

// -- Test 17: process() uses pre-classified intent from context (skips _classifyFallback) --
asyncTest('process() uses context.intent and skips _classifyFallback', async () => {
  let classifyCalled = false;
  const router = createMockRouter({ result: 'LLM chat response', provider: 'mock', tokens: 20 });
  const pipeline = new MicroPipeline({ llmRouter: router, logger: silentLogger });
  const origClassify = pipeline._classifyFallback.bind(pipeline);
  pipeline._classifyFallback = async (msg) => { classifyCalled = true; return origClassify(msg); };

  // Pre-classified as chitchat (greeting intent no longer exists in MicroPipeline)
  const result = await pipeline.process('Hello there!', { userName: 'Eve', intent: 'chitchat' });
  assert.ok(typeof result === 'string');
  assert.strictEqual(classifyCalled, false, '_classifyFallback should NOT be called when context.intent is provided');
});

asyncTest('process() routes pre-classified deck intent to domain handler', async () => {
  const router = createMockRouter({ result: 'Fallback chat', provider: 'mock', tokens: 20 });
  const pipeline = new MicroPipeline({ llmRouter: router, logger: silentLogger });
  // No toolRegistry → falls back to chat, but intent should be 'deck'
  const result = await pipeline.process('do the thing', { intent: 'deck' });
  assert.ok(typeof result === 'string');
  assert.strictEqual(pipeline.getStats().byIntent.deck, 1);
});

// -- Test 18: _handleDomainTask() system prompt includes date/identity context --
asyncTest('_handleDomainTask() system prompt includes Moltagent identity and current year', async () => {
  let capturedSystem = '';
  const mockToolsProvider = {
    model: 'phi4-mini',
    chat: async ({ system }) => {
      capturedSystem = system;
      return { content: 'Done.', toolCalls: [], _inputTokens: 10, _outputTokens: 5 };
    }
  };
  const mockToolRegistry = {
    getToolSubset: () => [{ function: { name: 'cal_list', parameters: {} } }],
    execute: async () => ({ success: true, result: 'OK' }),
    setRequestContext: () => {}
  };
  const pipeline = new MicroPipeline({
    llmRouter: createMockRouter(),
    ollamaToolsProvider: mockToolsProvider,
    toolRegistry: mockToolRegistry,
    timezone: 'UTC',
    logger: silentLogger
  });
  await pipeline._handleDomainTask('Create event tomorrow', 'calendar', { userName: 'Test' });
  assert.ok(capturedSystem.includes('Moltagent'), `System prompt should include Moltagent identity, got: ${capturedSystem.substring(0, 80)}`);
  const year = new Date().getFullYear().toString();
  assert.ok(capturedSystem.includes(year), `System prompt should include current year ${year}`);
  assert.ok(capturedSystem.includes('Calendar assistant'), 'System prompt should still include domain instruction');
});

// -- Test 19: _handleChat() prompt includes Moltagent identity --
asyncTest('_handleChat() prompt includes Moltagent identity', async () => {
  let capturedContent = '';
  const router = {
    route: async ({ content }) => { capturedContent = content; return { result: 'Hi!', provider: 'mock', tokens: 10 }; },
    hasCloudPlayers: () => false,
    isCloudAvailable: async () => false
  };
  const pipeline = new MicroPipeline({ llmRouter: router, timezone: 'Europe/Berlin', logger: silentLogger });
  await pipeline._handleChat('What year is it?', {});
  assert.ok(capturedContent.includes('Moltagent'), `Chat prompt should include Moltagent identity`);
  assert.ok(capturedContent.includes('Europe/Berlin'), `Chat prompt should include timezone`);
});

// -- Test 20: _handleQuestion() synthesize prompt includes identity --
asyncTest('_handleQuestion() synthesize prompt includes Moltagent identity', async () => {
  let capturedContent = '';
  const router = {
    route: async ({ content }) => { capturedContent = content; return { result: 'Answer', provider: 'mock', tokens: 10 }; },
    hasCloudPlayers: () => false,
    isCloudAvailable: async () => false
  };
  const searcher = createMockMemorySearcher([
    { title: 'Note', subline: 'Some info' }
  ]);
  const pipeline = new MicroPipeline({ llmRouter: router, memorySearcher: searcher, timezone: 'UTC', logger: silentLogger });
  await pipeline._handleQuestion('What year is it?', {}, {});
  assert.ok(capturedContent.includes('Moltagent'), `Synthesize prompt should include Moltagent identity`);
});

// -- Test 21: constructor stores timezone --
test('constructor stores timezone from config', () => {
  const pipeline = new MicroPipeline({ llmRouter: createMockRouter(), timezone: 'America/New_York', logger: silentLogger });
  assert.strictEqual(pipeline.timezone, 'America/New_York');
});

test('constructor defaults timezone to UTC', () => {
  const pipeline = new MicroPipeline({ llmRouter: createMockRouter(), logger: silentLogger });
  assert.strictEqual(pipeline.timezone, 'UTC');
});

// ---------------------------------------------------------------------------
// Part C: Cloud Escalation Patterns
// ---------------------------------------------------------------------------

// -- Test 22: _shouldEscalateToCloud() detects "analyze and compare" --
test('_shouldEscalateToCloud() detects "analyze and compare" pattern', () => {
  const pipeline = new MicroPipeline({ llmRouter: createMockRouter(), logger: silentLogger });
  assert.strictEqual(pipeline._shouldEscalateToCloud('Please analyze and compare these two proposals'), true);
});

// -- Test 23: _shouldEscalateToCloud() detects "write a detailed report" --
test('_shouldEscalateToCloud() detects "write a detailed report" pattern', () => {
  const pipeline = new MicroPipeline({ llmRouter: createMockRouter(), logger: silentLogger });
  assert.strictEqual(pipeline._shouldEscalateToCloud('Write a detailed report about our quarterly results'), true);
});

// -- Test 24: _shouldEscalateToCloud() does NOT escalate simple domain actions --
test('_shouldEscalateToCloud() does NOT escalate "create a card"', () => {
  const pipeline = new MicroPipeline({ llmRouter: createMockRouter(), logger: silentLogger });
  assert.strictEqual(pipeline._shouldEscalateToCloud('Create a card for the new feature'), false);
});

// -- Test 25: _shouldEscalateToCloud() does NOT escalate short messages --
test('_shouldEscalateToCloud() does NOT escalate short messages (<= 20 chars)', () => {
  const pipeline = new MicroPipeline({ llmRouter: createMockRouter(), logger: silentLogger });
  assert.strictEqual(pipeline._shouldEscalateToCloud('analyze vs compare'), false);
});

// -- Test 25b: _shouldEscalateToCloud() detects "how do I" questions --
test('_shouldEscalateToCloud() detects "How do I set up a Workflow" pattern', () => {
  const pipeline = new MicroPipeline({ llmRouter: createMockRouter(), logger: silentLogger });
  assert.strictEqual(pipeline._shouldEscalateToCloud('How do I set up a Workflow in Deck?'), true);
  assert.strictEqual(pipeline._shouldEscalateToCloud('How can I configure email forwarding?'), true);
  // Simple domain actions should NOT escalate
  assert.strictEqual(pipeline._shouldEscalateToCloud('Set up a meeting for Monday'), false);
});

// -- Test 26: _handleDomainTask() throws DOMAIN_ESCALATE for matching message --
asyncTest('_handleDomainTask() throws DOMAIN_ESCALATE for cloud-worthy message', async () => {
  const pipeline = new MicroPipeline({
    llmRouter: createMockRouter(),
    toolRegistry: {
      getToolSubset: () => [{ function: { name: 'search_web', parameters: {} } }],
      execute: async () => ({ success: true, result: 'OK' }),
      setRequestContext: () => {}
    },
    ollamaToolsProvider: { model: 'test', chat: async () => ({ content: 'Done.', toolCalls: [] }) },
    logger: silentLogger
  });

  try {
    await pipeline._handleDomainTask('Research and investigate the market trends for our product category', 'search', {});
    assert.fail('Should have thrown DOMAIN_ESCALATE');
  } catch (err) {
    assert.strictEqual(err.code, 'DOMAIN_ESCALATE');
  }
});

// -- _handleChat throws DOMAIN_ESCALATE on LLM failure --
asyncTest('_handleChat() throws DOMAIN_ESCALATE when LLM fails', async () => {
  const failRouter = {
    route: async () => { throw new Error('connection refused'); },
    hasCloudPlayers: () => false,
    isCloudAvailable: async () => false
  };
  const pipeline = new MicroPipeline({ llmRouter: failRouter, logger: silentLogger });

  try {
    await pipeline._handleChat('Hello!', {});
    assert.fail('Should have thrown DOMAIN_ESCALATE');
  } catch (err) {
    assert.strictEqual(err.code, 'DOMAIN_ESCALATE');
    assert.ok(err.message.includes('Chat provider unavailable'));
  }
});

asyncTest('_handleChat() returns response on success (no escalation)', async () => {
  const router = createMockRouter({ result: 'Hello back!', provider: 'mock', tokens: 10 });
  const pipeline = new MicroPipeline({ llmRouter: router, logger: silentLogger });
  const result = await pipeline._handleChat('Hello!', {});
  assert.strictEqual(result, 'Hello back!');
});

setTimeout(() => { summary(); exitWithCode(); }, 100);
