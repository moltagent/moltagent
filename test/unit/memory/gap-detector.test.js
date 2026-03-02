'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const GapDetector = require('../../../src/lib/memory/gap-detector');

const silentLogger = { log() {}, info() {}, warn() {}, error() {} };

function createMockVectorStore(searchResults = []) {
  return {
    search: (queryVector, limit, threshold) => searchResults
  };
}

function createMockEmbedder() {
  return {
    embed: async (text) => new Float64Array(768).fill(0.1)
  };
}

function createMockTalkClient() {
  const messages = [];
  return {
    enqueue: async (token, msg) => { messages.push({ token, msg }); },
    getMessages: () => messages
  };
}

function createMockFilesClient(initialData = null) {
  let stored = initialData;
  return {
    readFile: async (path) => {
      if (!stored) throw new Error('404');
      return { content: stored };
    },
    writeFile: async (path, content) => { stored = content; }
  };
}

// TC-GD-01: recordMention() increments topic count
test('TC-GD-01: recordMention() increments topic count', () => {
  const detector = new GapDetector({
    vectorStore: createMockVectorStore(),
    embeddingClient: createMockEmbedder(),
    ncFilesClient: createMockFilesClient(),
    talkClient: createMockTalkClient(),
    config: { talk: { primaryRoom: 'room-abc' } },
    logger: silentLogger
  });

  detector.recordMention('onboarding');
  detector.recordMention('onboarding');
  detector.recordMention('onboarding');

  const entry = detector._mentions.get('onboarding');
  assert.ok(entry, 'Mention entry should exist');
  assert.strictEqual(entry.count, 3, 'Count should be 3 after 3 mentions');
});

// TC-GD-02: detectGaps() finds topic with no wiki match (score 0 < 0.35)
asyncTest('TC-GD-02: detectGaps() finds topic with no wiki match', async () => {
  // Empty search results → bestScore = 0 < SIMILARITY_THRESHOLD (0.35)
  const vectorStore = createMockVectorStore([]);
  const talk = createMockTalkClient();

  const detector = new GapDetector({
    vectorStore,
    embeddingClient: createMockEmbedder(),
    ncFilesClient: createMockFilesClient(),
    talkClient: talk,
    config: { talk: { primaryRoom: 'room-abc' } },
    logger: silentLogger
  });

  // Mark cooldowns as loaded to skip disk read
  detector._cooldownsLoaded = true;

  // Need count >= 3 to qualify
  detector.recordMention('kubernetes');
  detector.recordMention('kubernetes');
  detector.recordMention('kubernetes');

  const result = await detector.detectGaps();

  assert.ok(result.gaps >= 1, `Expected at least 1 gap detected, got ${result.gaps}`);
  assert.ok(result.checked >= 1, 'At least 1 topic should have been checked');
  assert.ok(talk.getMessages().length >= 1, 'Talk should have received a gap alert');
});

// TC-GD-03: detectGaps() skips topic with good wiki match (score 0.8 >= 0.35)
asyncTest('TC-GD-03: detectGaps() skips topic with good wiki match', async () => {
  // Search returns a result with a high similarity score
  const vectorStore = createMockVectorStore([{ id: 'wiki/onboarding', score: 0.8, title: 'Onboarding' }]);
  const talk = createMockTalkClient();

  const detector = new GapDetector({
    vectorStore,
    embeddingClient: createMockEmbedder(),
    ncFilesClient: createMockFilesClient(),
    talkClient: talk,
    config: { talk: { primaryRoom: 'room-abc' } },
    logger: silentLogger
  });

  detector._cooldownsLoaded = true;

  detector.recordMention('onboarding');
  detector.recordMention('onboarding');
  detector.recordMention('onboarding');

  const result = await detector.detectGaps();

  assert.strictEqual(result.gaps, 0, 'No gaps should be detected when wiki match is good');
  assert.strictEqual(talk.getMessages().length, 0, 'Talk should not receive alert for covered topic');
});

// TC-GD-04: detectGaps() requires count >= 3 — only 2 mentions returns 0 gaps
asyncTest('TC-GD-04: detectGaps() requires count >= 3', async () => {
  const vectorStore = createMockVectorStore([]);
  const talk = createMockTalkClient();

  const detector = new GapDetector({
    vectorStore,
    embeddingClient: createMockEmbedder(),
    ncFilesClient: createMockFilesClient(),
    talkClient: talk,
    config: { talk: { primaryRoom: 'room-abc' } },
    logger: silentLogger
  });

  detector._cooldownsLoaded = true;

  // Only 2 mentions — should not reach the detection threshold
  detector.recordMention('newfeature');
  detector.recordMention('newfeature');

  const result = await detector.detectGaps();

  assert.strictEqual(result.gaps, 0, 'Should detect 0 gaps when count < 3');
  assert.strictEqual(result.checked, 0, 'No topics should be checked when count < 3');
  assert.strictEqual(talk.getMessages().length, 0, 'No talk messages for under-threshold topic');
});

// TC-GD-05: surfaceGap() posts message to Talk
asyncTest('TC-GD-05: surfaceGap() posts message to Talk', async () => {
  const talk = createMockTalkClient();

  const detector = new GapDetector({
    vectorStore: createMockVectorStore(),
    embeddingClient: createMockEmbedder(),
    ncFilesClient: createMockFilesClient(),
    talkClient: talk,
    config: { talk: { primaryRoom: 'room-xyz' } },
    logger: silentLogger
  });

  await detector.surfaceGap('infrastructure', 0.1);

  const messages = talk.getMessages();
  assert.strictEqual(messages.length, 1, 'One message should be posted to Talk');
  assert.strictEqual(messages[0].token, 'room-xyz', 'Message should go to the configured room');
  assert.ok(
    messages[0].msg.includes('infrastructure'),
    'Message should mention the gap topic'
  );
});

// TC-GD-06: 7-day cooldown prevents duplicate gap alerts
asyncTest('TC-GD-06: 7-day cooldown prevents duplicate gap alerts', async () => {
  const vectorStore = createMockVectorStore([]);
  const talk = createMockTalkClient();

  const detector = new GapDetector({
    vectorStore,
    embeddingClient: createMockEmbedder(),
    ncFilesClient: createMockFilesClient(),
    talkClient: talk,
    config: { talk: { primaryRoom: 'room-abc' } },
    logger: silentLogger
  });

  detector._cooldownsLoaded = true;

  detector.recordMention('deployment');
  detector.recordMention('deployment');
  detector.recordMention('deployment');

  // First detection run — should surface gap
  await detector.detectGaps();
  const firstCount = talk.getMessages().length;
  assert.strictEqual(firstCount, 1, 'First detection should surface the gap');

  // Simulate that a cooldown was just set (which surfaceGap() does)
  // The cooldown is set inside surfaceGap() to Date.now()
  // Second detection run — should be blocked by cooldown
  await detector.detectGaps();
  const secondCount = talk.getMessages().length;
  assert.strictEqual(secondCount, 1, 'Second detection within cooldown should not add another message');
});

// TC-GD-07: tick() only runs detectGaps every 12 pulses
asyncTest('TC-GD-07: tick() only runs detectGaps every 12 pulses', async () => {
  const detector = new GapDetector({
    vectorStore: createMockVectorStore([]),
    embeddingClient: createMockEmbedder(),
    ncFilesClient: createMockFilesClient(),
    talkClient: createMockTalkClient(),
    config: { talk: { primaryRoom: 'room-abc' } },
    logger: silentLogger
  });

  // Ticks 1 through 11 should return null (gate not reached)
  for (let i = 0; i < 11; i++) {
    const result = await detector.tick();
    assert.strictEqual(result, null, `tick() call ${i + 1} should return null (gate not reached)`);
  }

  // 12th tick should run detectGaps and return a result object
  const result = await detector.tick();
  assert.ok(result !== null, '12th tick() should return a result object');
  assert.ok(typeof result.gaps === 'number', 'Result should have a gaps count');
  assert.ok(typeof result.checked === 'number', 'Result should have a checked count');
});

// TC-GD-08: graceful fallback when vectorStore is null
asyncTest('TC-GD-08: graceful fallback when vectorStore unavailable', async () => {
  const detector = new GapDetector({
    vectorStore: null,
    embeddingClient: createMockEmbedder(),
    ncFilesClient: createMockFilesClient(),
    talkClient: createMockTalkClient(),
    config: { talk: { primaryRoom: 'room-abc' } },
    logger: silentLogger
  });

  // Record 3 mentions to exceed threshold
  detector.recordMention('topic');
  detector.recordMention('topic');
  detector.recordMention('topic');
  detector._cooldownsLoaded = true;

  let threw = false;
  let result;
  try {
    result = await detector.detectGaps();
  } catch (err) {
    threw = true;
  }

  assert.strictEqual(threw, false, 'detectGaps() should not throw when vectorStore is null');
  assert.ok(result, 'Should return a result object even without vectorStore');
  assert.strictEqual(result.gaps, 0, 'Should report 0 gaps when vectorStore unavailable');
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
