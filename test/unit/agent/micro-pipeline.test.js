'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const MicroPipeline = require('../../../src/lib/agent/micro-pipeline');

const silentLogger = { log() {}, warn() {}, error() {} };

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

// -- Test 1: _classify() returns greeting for hello --
asyncTest('_classify() returns greeting intent for hello messages', async () => {
  const pipeline = new MicroPipeline({ llmRouter: createMockRouter(), logger: silentLogger });
  const result = await pipeline._classify('Hello!');
  assert.strictEqual(result.intent, 'greeting');
});

// -- Test 2: _handleGreeting() returns template without LLM call --
test('_handleGreeting() returns template without LLM call', () => {
  const pipeline = new MicroPipeline({ llmRouter: createMockRouter(), logger: silentLogger });
  const result = pipeline._handleGreeting({ userName: 'Alice' });
  assert.ok(typeof result === 'string');
  assert.ok(result.length > 0);
  assert.ok(result.includes('Alice'), `Expected greeting to contain userName, got: ${result}`);
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

// -- Test 10: process() routes greeting intent to template handler --
asyncTest('process() routes greeting intent to template handler', async () => {
  const pipeline = new MicroPipeline({ llmRouter: createMockRouter(), logger: silentLogger });
  const result = await pipeline.process('Hello there!', { userName: 'Dave' });

  assert.ok(typeof result === 'string');
  assert.ok(result.includes('Dave'));
  assert.strictEqual(pipeline.getStats().byIntent.greeting, 1);
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
  const result = await pipeline.process('What time is the meeting tomorrow?', {});

  assert.strictEqual(result, 'Answer from LLM');
});

setTimeout(() => { summary(); exitWithCode(); }, 100);
