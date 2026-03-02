'use strict';

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

function createMockCollectives(pages) {
  return {
    getPageList: async () => pages,
    readPageContent: async (title) => `Content of ${title}`
  };
}

// TC-ER-01: tick() embeds stale page — store has old updated_at, tick embeds it
asyncTest('TC-ER-01: tick() embeds stale page when store has old updated_at', async () => {
  const embedder = createMockEmbedder();

  // Return metadata that is 48h old — past the 24h stale threshold
  const oldTimestamp = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const store = createMockVectorStore({ 'PageA': { title: 'PageA', updated_at: oldTimestamp } });

  const collectives = createMockCollectives([{ title: 'PageA' }]);

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

  const collectives = createMockCollectives([{ title: 'PageA' }]);

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
    { title: 'Page1' },
    { title: 'Page2' },
    { title: 'Page3' }
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
    { title: 'Page1' },
    { title: 'Page2' },
    { title: 'Page3' }
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
  const collectives = createMockCollectives([{ title: 'PageA' }]);

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
    { title: 'P1' }, { title: 'P2' }, { title: 'P3' },
    { title: 'P4' }, { title: 'P5' }
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

setTimeout(() => { summary(); exitWithCode(); }, 500);
