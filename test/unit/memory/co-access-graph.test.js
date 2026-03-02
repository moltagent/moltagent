'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const CoAccessGraph = require('../../../src/lib/memory/co-access-graph');

const silentLogger = { log() {}, info() {}, warn() {}, error() {} };

function createMockFilesClient(initialData = null) {
  let stored = initialData;
  let writeCount = 0;
  return {
    readFile: async (path) => {
      if (!stored) throw new Error('404 Not Found');
      return { content: stored, truncated: false, totalSize: stored.length };
    },
    writeFile: async (path, content) => {
      stored = content;
      writeCount++;
      return { success: true };
    },
    getStored: () => stored,
    getWriteCount: () => writeCount
  };
}

// TC-CG-01: record() strengthens edge between two pages
asyncTest('TC-CG-01: record() strengthens edge between two pages', async () => {
  const client = createMockFilesClient();
  const graph = new CoAccessGraph({ ncFilesClient: client, logger: silentLogger });
  graph._loaded = true;

  await graph.record(['A', 'B']);

  assert.ok('A::B' in graph._graph.edges, 'Edge A::B should exist');
  assert.strictEqual(graph._graph.edges['A::B'], 1, 'Edge weight should be 1');
});

// TC-CG-02: record() creates symmetric key (sorted alphabetically)
asyncTest('TC-CG-02: record() creates symmetric key sorted alphabetically', async () => {
  const client = createMockFilesClient();
  const graph = new CoAccessGraph({ ncFilesClient: client, logger: silentLogger });
  graph._loaded = true;

  await graph.record(['Z', 'A']);

  assert.ok('A::Z' in graph._graph.edges, 'Edge should be stored as A::Z');
  assert.ok(!('Z::A' in graph._graph.edges), 'Z::A should not exist');
});

// TC-CG-03: record() with 3 pages creates 3 edges
asyncTest('TC-CG-03: record() with 3 pages creates 3 edges', async () => {
  const client = createMockFilesClient();
  const graph = new CoAccessGraph({ ncFilesClient: client, logger: silentLogger });
  graph._loaded = true;

  await graph.record(['A', 'B', 'C']);

  const edgeCount = Object.keys(graph._graph.edges).length;
  assert.strictEqual(edgeCount, 3, `Expected 3 edges, got ${edgeCount}`);
  assert.ok('A::B' in graph._graph.edges, 'A::B should exist');
  assert.ok('A::C' in graph._graph.edges, 'A::C should exist');
  assert.ok('B::C' in graph._graph.edges, 'B::C should exist');
});

// TC-CG-04: getRelated() returns top co-accessed pages by weight
asyncTest('TC-CG-04: getRelated() returns top co-accessed pages by weight', async () => {
  const client = createMockFilesClient();
  const graph = new CoAccessGraph({ ncFilesClient: client, logger: silentLogger });
  graph._loaded = true;

  // Record A+B twice and A+C once — B should rank higher
  await graph.record(['A', 'B']);
  await graph.record(['A', 'B']);
  await graph.record(['A', 'C']);

  const related = await graph.getRelated('A', 3);

  assert.ok(Array.isArray(related), 'Should return array');
  assert.ok(related.length >= 2, 'Should have at least 2 results');
  assert.strictEqual(related[0].title, 'B', 'B should be first (weight 2)');
  assert.strictEqual(related[0].weight, 2, 'B weight should be 2');
  assert.strictEqual(related[1].title, 'C', 'C should be second (weight 1)');
});

// TC-CG-05: getRelated() respects limit parameter
asyncTest('TC-CG-05: getRelated() respects limit parameter', async () => {
  const client = createMockFilesClient();
  const graph = new CoAccessGraph({ ncFilesClient: client, logger: silentLogger });
  graph._loaded = true;

  // Create 5 edges from A to B, C, D, E, F
  await graph.record(['A', 'B']);
  await graph.record(['A', 'C']);
  await graph.record(['A', 'D']);
  await graph.record(['A', 'E']);
  await graph.record(['A', 'F']);

  const related = await graph.getRelated('A', 2);

  assert.strictEqual(related.length, 2, `Expected max 2 results, got ${related.length}`);
});

// TC-CG-06: getRelated() returns empty for unknown page
asyncTest('TC-CG-06: getRelated() returns empty for unknown page', async () => {
  const client = createMockFilesClient();
  const graph = new CoAccessGraph({ ncFilesClient: client, logger: silentLogger });
  graph._loaded = true;

  const related = await graph.getRelated('unknown');

  assert.deepStrictEqual(related, [], 'Should return empty array for unknown page');
});

// TC-CG-07: decay() multiplies weights by 0.9
asyncTest('TC-CG-07: decay() multiplies weights by 0.9', async () => {
  const client = createMockFilesClient();
  const graph = new CoAccessGraph({ ncFilesClient: client, logger: silentLogger });
  graph._loaded = true;
  graph._lastSave = 0;

  // Set up an edge with weight 10 so it survives decay (10 * 0.9 = 9 >= 1.0)
  graph._graph.edges['A::B'] = 10;
  graph._dirty = true;

  await graph.decay();

  assert.ok('A::B' in graph._graph.edges, 'Edge should still exist after decay');
  assert.ok(
    Math.abs(graph._graph.edges['A::B'] - 9.0) < 0.0001,
    `Weight should be ~9.0, got ${graph._graph.edges['A::B']}`
  );
});

// TC-CG-08: decay() prunes edges below 1.0
asyncTest('TC-CG-08: decay() prunes edges below 1.0', async () => {
  const client = createMockFilesClient();
  const graph = new CoAccessGraph({ ncFilesClient: client, logger: silentLogger });
  graph._loaded = true;
  graph._lastSave = 0;

  // Weight 1.0 * 0.9 = 0.9, which is < 1.0 — should be pruned
  graph._graph.edges['A::B'] = 1.0;
  graph._dirty = true;

  await graph.decay();

  assert.ok(!('A::B' in graph._graph.edges), 'Edge with weight 1.0 should be pruned after decay');
});

// TC-CG-09: decay() updates lastDecay timestamp
asyncTest('TC-CG-09: decay() updates lastDecay timestamp', async () => {
  const client = createMockFilesClient();
  const graph = new CoAccessGraph({ ncFilesClient: client, logger: silentLogger });
  graph._loaded = true;
  graph._lastSave = 0;

  const before = new Date(graph._graph.lastDecay).getTime();

  // Small wait to ensure timestamp advances
  await new Promise(r => setTimeout(r, 5));
  graph._dirty = true;
  await graph.decay();

  const after = new Date(graph._graph.lastDecay).getTime();
  assert.ok(after >= before, 'lastDecay timestamp should be updated');
});

// TC-CG-10: _load()/_save() round-trips through mock ncFilesClient
asyncTest('TC-CG-10: _load()/_save() round-trips through mock ncFilesClient', async () => {
  const client = createMockFilesClient();
  const graph = new CoAccessGraph({ ncFilesClient: client, logger: silentLogger });
  graph._loaded = true;
  graph._lastSave = 0;

  // Set edges and force save
  graph._graph.edges['X::Y'] = 5;
  graph._dirty = true;
  await graph._save();

  assert.ok(client.getStored() !== null, 'Should have written to client');

  // Now create a new graph instance and load from the saved data
  const graph2 = new CoAccessGraph({ ncFilesClient: client, logger: silentLogger });
  await graph2._load();

  assert.ok('X::Y' in graph2._graph.edges, 'Loaded graph should have X::Y edge');
  assert.strictEqual(graph2._graph.edges['X::Y'], 5, 'Loaded edge weight should be 5');
});

// TC-CG-11: auto-decay triggers when >30 days since lastDecay
asyncTest('TC-CG-11: auto-decay triggers when >30 days since lastDecay', async () => {
  // Prepare stored data with a lastDecay 31 days in the past
  const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
  const initialData = JSON.stringify({
    edges: { 'A::B': 10 },
    lastDecay: oldDate
  });

  const client = createMockFilesClient(initialData);
  const graph = new CoAccessGraph({ ncFilesClient: client, logger: silentLogger });

  // This triggers _load() which should auto-decay
  await graph._load();

  // lastDecay should have been updated to a recent time
  const lastDecayMs = new Date(graph._graph.lastDecay).getTime();
  const thirtyDaysAgoMs = Date.now() - 31 * 24 * 60 * 60 * 1000;
  assert.ok(
    lastDecayMs > thirtyDaysAgoMs,
    `lastDecay should be recent, got ${graph._graph.lastDecay}`
  );
});

// TC-CG-12: _save() debounce — record twice rapidly, verify only 1 save occurred
asyncTest('TC-CG-12: _save() debounce — rapid records result in only 1 save', async () => {
  const client = createMockFilesClient();
  const graph = new CoAccessGraph({ ncFilesClient: client, logger: silentLogger });
  graph._loaded = true;

  // Reset _lastSave to 0 so the first call writes, subsequent debounced
  graph._lastSave = 0;

  // First record: should write (lastSave = 0, debounce not triggered)
  await graph.record(['A', 'B']);
  const writeAfterFirst = client.getWriteCount();
  assert.strictEqual(writeAfterFirst, 1, 'First record should write once');

  // Second record immediately after: _lastSave is now recent, debounce kicks in
  await graph.record(['A', 'C']);
  const writeAfterSecond = client.getWriteCount();
  assert.strictEqual(writeAfterSecond, 1, 'Second record within debounce window should not write again');
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
