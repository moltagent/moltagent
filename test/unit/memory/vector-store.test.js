'use strict';

const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const VectorStore = require('../../../src/lib/memory/vector-store');

const silentLogger = { log() {}, info() {}, warn() {}, error() {} };

function createTempDbPath() {
  return path.join(
    os.tmpdir(),
    `vs-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
}

function makeVector(dims, fillValue) {
  const v = new Float64Array(dims);
  v.fill(fillValue);
  return v;
}

/**
 * Create a vector where most values are fillValue but index `spikeAt` has
 * spikeValue. This makes vectors with different spike positions have lower
 * cosine similarity than those sharing the same spike.
 */
function makeSpikedVector(dims, fillValue, spikeAt, spikeValue) {
  const v = new Float64Array(dims);
  v.fill(fillValue);
  v[spikeAt] = spikeValue;
  return v;
}

// Cleanup helper to remove temp DB files
function cleanupDb(store, dbPath) {
  try { store.close(); } catch (_) { /* already closed */ }
  try { fs.unlinkSync(dbPath); } catch (_) { /* may not exist */ }
  try { fs.unlinkSync(dbPath + '-shm'); } catch (_) {}
  try { fs.unlinkSync(dbPath + '-wal'); } catch (_) {}
}

// TC-VS-01: upsert() inserts new vector — count() === 1
test('TC-VS-01: upsert() inserts new vector', () => {
  const dbPath = createTempDbPath();
  const store = new VectorStore({ dbPath, logger: silentLogger });

  try {
    store.upsert('page-1', makeVector(768, 0.1), { title: 'Page 1', source: 'wiki' });
    assert.strictEqual(store.count(), 1, 'count() should be 1 after one upsert');
  } finally {
    cleanupDb(store, dbPath);
  }
});

// TC-VS-02: upsert() updates existing (same id) — count() === 1, verify last vector stored
test('TC-VS-02: upsert() updates existing vector with same id', () => {
  const dbPath = createTempDbPath();
  const store = new VectorStore({ dbPath, logger: silentLogger });

  try {
    store.upsert('page-1', makeVector(768, 0.1), { title: 'Page 1 v1' });
    store.upsert('page-1', makeVector(768, 0.9), { title: 'Page 1 v2' });

    assert.strictEqual(store.count(), 1, 'count() should still be 1 after double upsert');

    const meta = store.getMetadata('page-1');
    assert.ok(meta, 'Metadata should exist');
    assert.strictEqual(meta.title, 'Page 1 v2', 'Title should reflect the updated upsert');
  } finally {
    cleanupDb(store, dbPath);
  }
});

// TC-VS-03: search() returns results sorted by cosine similarity
test('TC-VS-03: search() returns results sorted by cosine similarity', () => {
  const dbPath = createTempDbPath();
  const store = new VectorStore({ dbPath, logger: silentLogger });

  try {
    // page-close: spike at index 0 with large value — most similar to query
    // page-mid: spike at index 1 — partially similar
    // page-far: spike at index 100 — least similar to query which spikes at 0
    store.upsert('page-close', makeSpikedVector(768, 0.0, 0, 10.0), { title: 'Close' });
    store.upsert('page-mid',   makeSpikedVector(768, 0.0, 1,  5.0), { title: 'Mid' });
    store.upsert('page-far',   makeSpikedVector(768, 0.0, 100, 8.0), { title: 'Far' });

    // Query vector spikes at index 0 — should rank page-close highest
    const query = makeSpikedVector(768, 0.0, 0, 10.0);
    const results = store.search(query, 3, 0.0);

    assert.ok(results.length >= 1, 'Should return at least 1 result');
    assert.strictEqual(results[0].id, 'page-close', 'Most similar page should be first');
    // Verify descending order
    for (let i = 1; i < results.length; i++) {
      assert.ok(
        results[i - 1].score >= results[i].score,
        `Results should be sorted descending: ${results[i-1].score} >= ${results[i].score}`
      );
    }
  } finally {
    cleanupDb(store, dbPath);
  }
});

// TC-VS-04: search() respects threshold — high threshold filters low-similarity results
test('TC-VS-04: search() respects threshold filter', () => {
  const dbPath = createTempDbPath();
  const store = new VectorStore({ dbPath, logger: silentLogger });

  try {
    // Orthogonal vectors have cosine similarity = 0
    const vecA = new Float64Array(768);
    vecA[0] = 1.0;
    const vecB = new Float64Array(768);
    vecB[1] = 1.0; // orthogonal to vecA

    store.upsert('page-a', vecA, { title: 'A' });
    store.upsert('page-b', vecB, { title: 'B' });

    // Search with vecA at threshold 0.9 — vecB (similarity ≈ 0) should be excluded
    const results = store.search(vecA, 5, 0.9);

    // page-a should appear (similarity = 1.0), page-b should be excluded (similarity = 0)
    const ids = results.map(r => r.id);
    assert.ok(ids.includes('page-a'), 'page-a (self) should be included');
    assert.ok(!ids.includes('page-b'), 'page-b (orthogonal) should be excluded by threshold 0.9');
  } finally {
    cleanupDb(store, dbPath);
  }
});

// TC-VS-05: search() respects limit — insert 5, search with limit 2, verify 2 returned
test('TC-VS-05: search() respects limit parameter', () => {
  const dbPath = createTempDbPath();
  const store = new VectorStore({ dbPath, logger: silentLogger });

  try {
    for (let i = 0; i < 5; i++) {
      store.upsert(`page-${i}`, makeVector(768, (i + 1) * 0.1), { title: `Page ${i}` });
    }

    const query = makeVector(768, 0.3);
    const results = store.search(query, 2, 0.0);

    assert.strictEqual(results.length, 2, `Expected 2 results with limit=2, got ${results.length}`);
  } finally {
    cleanupDb(store, dbPath);
  }
});

// TC-VS-06: delete() removes vector — insert, delete, count() === 0
test('TC-VS-06: delete() removes vector', () => {
  const dbPath = createTempDbPath();
  const store = new VectorStore({ dbPath, logger: silentLogger });

  try {
    store.upsert('page-1', makeVector(768, 0.5), { title: 'Page 1' });
    assert.strictEqual(store.count(), 1, 'Should have 1 vector before delete');

    const deleted = store.delete('page-1');
    assert.strictEqual(deleted, true, 'delete() should return true when row exists');
    assert.strictEqual(store.count(), 0, 'count() should be 0 after delete');
  } finally {
    cleanupDb(store, dbPath);
  }
});

// TC-VS-07: count() returns correct count
test('TC-VS-07: count() returns correct count', () => {
  const dbPath = createTempDbPath();
  const store = new VectorStore({ dbPath, logger: silentLogger });

  try {
    assert.strictEqual(store.count(), 0, 'Empty store should have count 0');

    store.upsert('page-1', makeVector(768, 0.1), {});
    store.upsert('page-2', makeVector(768, 0.2), {});
    store.upsert('page-3', makeVector(768, 0.3), {});

    assert.strictEqual(store.count(), 3, 'count() should return 3 after 3 upserts');
  } finally {
    cleanupDb(store, dbPath);
  }
});

// TC-VS-08: close() — subsequent operations throw
test('TC-VS-08: close() prevents subsequent operations', () => {
  const dbPath = createTempDbPath();
  const store = new VectorStore({ dbPath, logger: silentLogger });

  try {
    store.upsert('page-1', makeVector(768, 0.1), {});
    store.close();

    assert.throws(
      () => store.count(),
      /VectorStore has been closed/,
      'count() after close() should throw'
    );

    assert.throws(
      () => store.upsert('page-2', makeVector(768, 0.2), {}),
      /VectorStore has been closed/,
      'upsert() after close() should throw'
    );
  } finally {
    // store is already closed; just clean up files
    try { fs.unlinkSync(dbPath); } catch (_) {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch (_) {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch (_) {}
  }
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
