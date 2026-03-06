'use strict';
// Mock type: LEGACY — TODO: migrate to realistic mocks

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const EmbeddingRefresher = require('../../../src/lib/memory/embedding-refresher');

const silentLogger = { log() {}, info() {}, warn() {}, error() {} };

function createMockEmbedder() {
  let callCount = 0;
  return {
    embed: async (text) => {
      callCount++;
      return new Float64Array(768).fill(0.1);
    },
    getCallCount: () => callCount
  };
}

/**
 * Create a mock VectorStore whose getMetadata() can return controlled timestamps,
 * allowing staleness logic to be tested without a real SQLite DB.
 */
function createMockVectorStore(metaByTitle = {}) {
  const vectors = {};

  return {
    upsert: (id, vector, meta) => {
      vectors[id] = { vector, meta };
      // Update metaByTitle so subsequent getMetadata() reflects the upsert
      metaByTitle[id] = { title: id, updated_at: meta.updated_at || new Date().toISOString() };
    },
    count: () => Object.keys(vectors).length,
    getMetadata: (id) => metaByTitle[id] || null,
    getVectors: () => vectors
  };
}

/**
 * Create a mock CollectivesClient using the real API surface:
 * resolveCollective() → id, listPages(id) → pages, readPageContent(path) → string.
 * Each page object must have { title, filePath, fileName }.
 */
function createMockCollectives(pages, contentByPath = {}) {
  return {
    resolveCollective: async () => 10,
    listPages: async () => pages,
    readPageContent: async (path) => {
      if (contentByPath[path] !== undefined) return contentByPath[path];
      return `Content of ${path}`;
    }
  };
}

/** Helper: build a page object with the fields the rewritten refresher expects. */
function makePage(title, filePath, fileName) {
  filePath = filePath || title;
  fileName = fileName || 'Readme.md';
  return { title, filePath, fileName };
}

// TC-ER-01: tick() embeds stale page — store has old updated_at, tick embeds it
asyncTest('TC-ER-01: tick() embeds stale page when store has old updated_at', async () => {
  const embedder = createMockEmbedder();

  // Return metadata that is 48h old — past the 24h stale threshold
  const oldTimestamp = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const store = createMockVectorStore({ 'PageA': { title: 'PageA', updated_at: oldTimestamp } });

  const collectives = createMockCollectives([makePage('PageA')]);

  const refresher = new EmbeddingRefresher({
    embeddingClient: embedder,
    vectorStore: store,
    collectivesClient: collectives,
    logger: silentLogger
  });

  // Mark as already bootstrapped so tick() goes to incremental path
  refresher._bootstrapped = true;

  const result = await refresher.tick();

  assert.ok(embedder.getCallCount() >= 1, 'Embedder should have been called for stale page');
  assert.ok(result.refreshed >= 1, `Expected at least 1 refreshed, got ${result.refreshed}`);
});

// TC-ER-02: tick() skips recently-refreshed page — updated_at within 24h
asyncTest('TC-ER-02: tick() skips recently-refreshed page', async () => {
  const embedder = createMockEmbedder();

  // Return metadata updated just 1 hour ago — not stale
  const freshTimestamp = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
  const store = createMockVectorStore({ 'PageA': { title: 'PageA', updated_at: freshTimestamp } });

  const collectives = createMockCollectives([makePage('PageA')]);

  const refresher = new EmbeddingRefresher({
    embeddingClient: embedder,
    vectorStore: store,
    collectivesClient: collectives,
    logger: silentLogger
  });

  refresher._bootstrapped = true;

  const result = await refresher.tick();

  assert.strictEqual(embedder.getCallCount(), 0, 'Embedder should NOT be called for fresh page');
  assert.strictEqual(result.refreshed, 0, 'No pages should be refreshed');
});

// TC-ER-03: refreshAll() embeds all pages
asyncTest('TC-ER-03: refreshAll() embeds all pages', async () => {
  const embedder = createMockEmbedder();
  const store = createMockVectorStore();
  const collectives = createMockCollectives([
    makePage('Page1'),
    makePage('Page2'),
    makePage('Page3')
  ]);

  const refresher = new EmbeddingRefresher({
    embeddingClient: embedder,
    vectorStore: store,
    collectivesClient: collectives,
    logger: silentLogger
  });

  const result = await refresher.refreshAll();

  assert.strictEqual(result.processed, 3, `Expected 3 processed, got ${result.processed}`);
  assert.strictEqual(result.errors, 0, `Expected 0 errors, got ${result.errors}`);
  assert.strictEqual(embedder.getCallCount(), 3, 'Embedder should be called once per page');

  const storedVectors = store.getVectors();
  assert.ok('Page1' in storedVectors, 'Page1 should be upserted');
  assert.ok('Page2' in storedVectors, 'Page2 should be upserted');
  assert.ok('Page3' in storedVectors, 'Page3 should be upserted');
});

// TC-ER-04: refreshStale() only re-embeds modified pages
asyncTest('TC-ER-04: refreshStale() only re-embeds stale pages', async () => {
  const embedder = createMockEmbedder();

  const freshTimestamp = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
  const oldTimestamp  = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  // Page1 is fresh; Page2 is fresh; Page3 is stale
  const store = createMockVectorStore({
    'Page1': { title: 'Page1', updated_at: freshTimestamp },
    'Page2': { title: 'Page2', updated_at: freshTimestamp },
    'Page3': { title: 'Page3', updated_at: oldTimestamp }
  });

  const collectives = createMockCollectives([
    makePage('Page1'),
    makePage('Page2'),
    makePage('Page3')
  ]);

  const refresher = new EmbeddingRefresher({
    embeddingClient: embedder,
    vectorStore: store,
    collectivesClient: collectives,
    logger: silentLogger
  });

  const result = await refresher.refreshStale();

  assert.strictEqual(result.processed, 1, `Expected only 1 stale page processed, got ${result.processed}`);
  assert.strictEqual(embedder.getCallCount(), 1, 'Embedder should be called only for stale page');

  const storedVectors = store.getVectors();
  assert.ok('Page3' in storedVectors, 'Page3 (stale) should be upserted');
  assert.ok(!('Page1' in storedVectors), 'Page1 (fresh) should NOT be re-upserted');
});

// TC-ER-05: tick() handles Ollama connection failure gracefully
asyncTest('TC-ER-05: tick() handles Ollama connection failure gracefully', async () => {
  const failingEmbedder = {
    embed: async () => { throw new Error('ECONNREFUSED: connection refused'); }
  };

  const oldTimestamp = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const store = createMockVectorStore({ 'PageA': { title: 'PageA', updated_at: oldTimestamp } });
  const collectives = createMockCollectives([makePage('PageA')]);

  const refresher = new EmbeddingRefresher({
    embeddingClient: failingEmbedder,
    vectorStore: store,
    collectivesClient: collectives,
    logger: silentLogger
  });

  refresher._bootstrapped = true;

  // Should not throw
  let result;
  let threw = false;
  try {
    result = await refresher.tick();
  } catch (err) {
    threw = true;
  }

  assert.strictEqual(threw, false, 'tick() should not throw on Ollama connection failure');
  assert.ok(result, 'tick() should return a result object');
  assert.ok(result.errors >= 1, `Expected errors >= 1, got ${result.errors}`);
});

// TC-ER-06: tick() limits to 2 pages per pulse
asyncTest('TC-ER-06: tick() limits to 2 pages per pulse (MAX_PER_TICK)', async () => {
  const embedder = createMockEmbedder();

  // All 5 pages are stale (no metadata)
  const store = createMockVectorStore();
  const collectives = createMockCollectives([
    makePage('P1'), makePage('P2'), makePage('P3'),
    makePage('P4'), makePage('P5')
  ]);

  const refresher = new EmbeddingRefresher({
    embeddingClient: embedder,
    vectorStore: store,
    collectivesClient: collectives,
    logger: silentLogger
  });

  // Mark bootstrapped and ensure the store looks non-empty so tick goes incremental
  refresher._bootstrapped = true;

  const result = await refresher.tick();

  assert.ok(
    embedder.getCallCount() <= 2,
    `tick() should process at most 2 pages, got ${embedder.getCallCount()}`
  );
  assert.ok(
    result.refreshed <= 2,
    `result.refreshed should be at most 2, got ${result.refreshed}`
  );
});

// TC-ER-07: backfillAll() processes all pages with content > 50 chars (alias for refreshAll)
asyncTest('TC-ER-07: backfillAll() processes all pages with content', async () => {
  const embedder = createMockEmbedder();
  const store = createMockVectorStore();
  const pages = [makePage('FullPage'), makePage('StubPage'), makePage('AnotherPage')];
  const contentByPath = {
    'StubPage/Readme.md': '',  // empty content — should be skipped
  };
  const collectives = createMockCollectives(pages, contentByPath);

  const refresher = new EmbeddingRefresher({
    embeddingClient: embedder,
    vectorStore: store,
    collectivesClient: collectives,
    logger: silentLogger
  });

  const result = await refresher.backfillAll();

  assert.strictEqual(result.processed, 2, `Expected 2 processed (skipping stub), got ${result.processed}`);
  assert.strictEqual(result.errors, 0, `Expected 0 errors, got ${result.errors}`);
});

// TC-ER-08: backfillAll() skips stubs gracefully (empty/null content)
asyncTest('TC-ER-08: backfillAll() skips stubs gracefully', async () => {
  const embedder = createMockEmbedder();
  const store = createMockVectorStore();
  const pages = [makePage('Stub1'), makePage('Stub2')];
  const collectives = createMockCollectives(pages, {
    'Stub1/Readme.md': null,
    'Stub2/Readme.md': null
  });

  const refresher = new EmbeddingRefresher({
    embeddingClient: embedder,
    vectorStore: store,
    collectivesClient: collectives,
    logger: silentLogger
  });

  const result = await refresher.backfillAll();

  assert.strictEqual(result.processed, 0, 'No pages should be processed when all are stubs');
  assert.strictEqual(embedder.getCallCount(), 0, 'Embedder should not be called for stubs');
});

// TC-ER-09: One embedding failure doesn't abort the batch
asyncTest('TC-ER-09: One embedding failure does not abort the batch', async () => {
  let callCount = 0;
  const partialEmbedder = {
    embed: async (text) => {
      callCount++;
      if (text.includes('BadPage')) throw new Error('Embedding failed for BadPage');
      return new Float64Array(768).fill(0.2);
    }
  };

  const store = createMockVectorStore();
  const pages = [makePage('GoodPage1'), makePage('BadPage'), makePage('GoodPage2')];
  const collectives = createMockCollectives(pages);

  const refresher = new EmbeddingRefresher({
    embeddingClient: partialEmbedder,
    vectorStore: store,
    collectivesClient: collectives,
    logger: silentLogger
  });

  const result = await refresher.backfillAll();

  assert.strictEqual(result.processed, 2, `Expected 2 processed, got ${result.processed}`);
  assert.strictEqual(result.errors, 1, `Expected 1 error, got ${result.errors}`);
  assert.strictEqual(callCount, 3, 'Embedder should be called for all 3 pages');
});

// TC-ER-10: Bootstrap retries on next tick if first attempt fails
asyncTest('TC-ER-10: Bootstrap retries on next tick if first attempt produced 0', async () => {
  let attempt = 0;
  const eventualEmbedder = {
    embed: async () => {
      attempt++;
      if (attempt <= 1) throw new Error('Ollama cold start');
      return new Float64Array(768).fill(0.3);
    }
  };

  const store = createMockVectorStore();
  const collectives = createMockCollectives([makePage('PageX')]);

  const refresher = new EmbeddingRefresher({
    embeddingClient: eventualEmbedder,
    vectorStore: store,
    collectivesClient: collectives,
    logger: silentLogger
  });

  // First tick — bootstrap fails, _bootstrapped should stay false
  const result1 = await refresher.tick();
  assert.strictEqual(result1.refreshed, 0, 'First tick should fail');
  assert.strictEqual(refresher._bootstrapped, false, '_bootstrapped should be false after failed bootstrap');

  // Second tick — bootstrap retries and succeeds
  const result2 = await refresher.tick();
  assert.strictEqual(result2.refreshed, 1, 'Second tick should succeed');
  assert.strictEqual(refresher._bootstrapped, true, '_bootstrapped should be true after successful bootstrap');
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
