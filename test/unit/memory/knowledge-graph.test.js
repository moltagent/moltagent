/*
 * MoltAgent - Sovereign AI Security Layer
 * Copyright (C) 2026 MoltAgent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

'use strict';
// Mock type: LEGACY — TODO: migrate to realistic mocks

// NOTE: Collectives WebDAV requires pages to exist in
// OCS database before PUT. Mocks should reject PUT to
// non-existent pages to catch this class of bug.
// See: 2026-03-05 triple production failure diagnostic.

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const KnowledgeGraph = require('../../../src/lib/memory/knowledge-graph');
const EntityExtractor = require('../../../src/lib/memory/entity-extractor');

const silentLogger = { log() {}, info() {}, warn() {}, error() {} };

function createMockFilesClient(initialJson = null) {
  const files = {};
  if (initialJson) files['Memory/_index.json'] = initialJson;
  return {
    readFile: async (path) => {
      if (files[path] !== undefined) return { content: files[path], truncated: false, totalSize: files[path].length };
      throw new Error('404');
    },
    writeFile: async (path, content) => { files[path] = content; return { success: true }; },
    mkdir: async () => {},
    getFiles: () => files
  };
}

// Legacy wiki mock for backward-compat tests
function createMockWikiClient(initialContent = null) {
  const pages = {};
  if (initialContent) pages['Memory/_index'] = initialContent;
  return {
    readPageContent: async (path) => pages[path] || null,
    writePageContent: async (path, content) => { pages[path] = content; },
    getPages: () => pages
  };
}

function createMockRouter(jsonResult) {
  return {
    route: async () => ({ result: JSON.stringify(jsonResult) })
  };
}

// ---------------------------------------------------------------------------
// KnowledgeGraph tests (NCFilesClient path)
// ---------------------------------------------------------------------------

// Test 1: load() on empty store starts with empty graph
asyncTest('load() on empty store starts with empty graph', async () => {
  const fc = createMockFilesClient(null);
  const graph = new KnowledgeGraph({ ncFilesClient: fc, logger: silentLogger });

  await graph.load();

  assert.strictEqual(graph._entities.size, 0, 'Should have 0 entities after loading empty store');
  assert.strictEqual(graph._triples.length, 0, 'Should have 0 triples after loading empty store');
});

// Test 2: addEntity() creates normalized ID (person_sarah_chen)
test('addEntity() creates normalized ID (person_sarah_chen)', () => {
  const fc = createMockFilesClient(null);
  const graph = new KnowledgeGraph({ ncFilesClient: fc, logger: silentLogger });
  graph._loaded = true;

  const id = graph.addEntity('Sarah Chen', 'person');

  assert.strictEqual(id, 'person_sarah_chen', `Expected 'person_sarah_chen', got '${id}'`);
  assert.ok(graph._entities.has('person_sarah_chen'), 'Entity map should contain person_sarah_chen');
  assert.strictEqual(
    graph._entities.get('person_sarah_chen').name,
    'Sarah Chen',
    'Entity name should be preserved as-is'
  );
});

// Test 3: addEntity() deduplicates same name+type
test('addEntity() deduplicates same name+type', () => {
  const fc = createMockFilesClient(null);
  const graph = new KnowledgeGraph({ ncFilesClient: fc, logger: silentLogger });
  graph._loaded = true;

  const id1 = graph.addEntity('Alice Doe', 'person');
  const id2 = graph.addEntity('Alice Doe', 'person');

  assert.strictEqual(graph._entities.size, 1, 'Should have exactly 1 entity after duplicate add');
  assert.strictEqual(id1, id2, 'Both calls should return the same id');
});

// Test 4: addTriple() deduplicates — second call refreshes verified timestamp
asyncTest('addTriple() deduplicates — second call refreshes verified timestamp', async () => {
  const fc = createMockFilesClient(null);
  const graph = new KnowledgeGraph({ ncFilesClient: fc, logger: silentLogger });
  graph._loaded = true;

  const idA = graph.addEntity('Alice Doe', 'person');
  const idB = graph.addEntity('Project Alpha', 'project');

  graph.addTriple(idA, 'works_on', idB);
  const firstVerified = graph._triples[0].verified;

  // Wait a small amount to ensure timestamp can advance
  await new Promise(r => setTimeout(r, 5));

  graph.addTriple(idA, 'works_on', idB);

  assert.strictEqual(graph._triples.length, 1, 'Should have only 1 triple after duplicate addTriple');
  assert.notStrictEqual(
    graph._triples[0].verified,
    firstVerified,
    'Second addTriple should refresh the verified timestamp'
  );
});

// Test 5: relatedTo() traverses 1 hop
test('relatedTo() traverses 1 hop', () => {
  const fc = createMockFilesClient(null);
  const graph = new KnowledgeGraph({ ncFilesClient: fc, logger: silentLogger });
  graph._loaded = true;

  const idA = graph.addEntity('Alice Doe', 'person');
  const idB = graph.addEntity('Project Beta', 'project');
  graph.addTriple(idA, 'works_on', idB);

  const results = graph.relatedTo(idA, 2);

  assert.strictEqual(results.length, 1, `Expected 1 result, got ${results.length}`);
  assert.strictEqual(results[0].entity.name, 'Project Beta', 'Should find Project Beta as neighbour');
  assert.strictEqual(results[0].distance, 1, 'Distance should be 1');
});

// Test 6: relatedTo() traverses 2 hops with cycle protection
test('relatedTo() traverses 2 hops with cycle protection', () => {
  const fc = createMockFilesClient(null);
  const graph = new KnowledgeGraph({ ncFilesClient: fc, logger: silentLogger });
  graph._loaded = true;

  const idA = graph.addEntity('Alice Doe', 'person');
  const idB = graph.addEntity('Bob Smith', 'person');
  const idC = graph.addEntity('Carol Jones', 'person');

  // A → B → C → A (cycle)
  graph.addTriple(idA, 'works_on', idB);
  graph.addTriple(idB, 'works_on', idC);
  graph.addTriple(idC, 'works_on', idA);

  const results = graph.relatedTo(idA, 2);

  const names = results.map(r => r.entity.name);
  assert.ok(names.includes('Bob Smith'), 'B should be in results');
  assert.ok(names.includes('Carol Jones'), 'C should be in results');
  assert.ok(results.length <= 2, `Cycle protection: should have at most 2 results, got ${results.length}`);
});

// Test 7: relatedTo() filters by predicate
test('relatedTo() filters by predicate', () => {
  const fc = createMockFilesClient(null);
  const graph = new KnowledgeGraph({ ncFilesClient: fc, logger: silentLogger });
  graph._loaded = true;

  const idA = graph.addEntity('Alice Doe', 'person');
  const idB = graph.addEntity('Project Beta', 'project');
  const idC = graph.addEntity('Team Gamma', 'team');

  graph.addTriple(idA, 'works_on', idB);
  graph.addTriple(idA, 'leads', idC);

  const results = graph.relatedTo(idA, 2, { predicate: 'leads' });

  const names = results.map(r => r.entity.name);
  assert.ok(names.includes('Team Gamma'), 'Team Gamma should appear with leads filter');
  assert.ok(!names.includes('Project Beta'), 'Project Beta should NOT appear with leads filter');
});

// Test 8: findPath() returns shortest path
test('findPath() returns shortest path', () => {
  const fc = createMockFilesClient(null);
  const graph = new KnowledgeGraph({ ncFilesClient: fc, logger: silentLogger });
  graph._loaded = true;

  const idA = graph.addEntity('Alice Doe', 'person');
  const idB = graph.addEntity('Bob Smith', 'person');
  const idC = graph.addEntity('Carol Jones', 'person');

  graph.addTriple(idA, 'works_on', idB);
  graph.addTriple(idB, 'works_on', idC);

  const path = graph.findPath(idA, idC);

  assert.ok(path !== null, 'Path should not be null when connection exists');
  assert.strictEqual(path.length, 2, `Expected 2 hops in path, got ${path.length}`);
});

// Test 9: findPath() returns null when no connection
test('findPath() returns null when no connection', () => {
  const fc = createMockFilesClient(null);
  const graph = new KnowledgeGraph({ ncFilesClient: fc, logger: silentLogger });
  graph._loaded = true;

  const idA = graph.addEntity('Alice Doe', 'person');
  const idB = graph.addEntity('Bob Smith', 'person');
  // No triples added between A and B

  const result = graph.findPath(idA, idB);

  assert.strictEqual(result, null, 'findPath should return null when there is no path');
});

// Test 10: flush() writes JSON file; second flush without changes is no-op
asyncTest('flush() writes JSON file; second flush without changes is no-op', async () => {
  const fc = createMockFilesClient(null);
  const graph = new KnowledgeGraph({ ncFilesClient: fc, logger: silentLogger });
  graph._loaded = true;

  graph.addEntity('Alice Doe', 'person');

  await graph.flush();

  const files = fc.getFiles();
  assert.ok(files['Memory/_index.json'] != null, 'JSON file should have been written by flush()');
  const parsed = JSON.parse(files['Memory/_index.json']);
  assert.ok(Array.isArray(parsed.entities), 'Written JSON should have entities array');
  assert.strictEqual(graph._dirty, false, '_dirty should be false after flush()');

  // Record content before second flush to verify no-op behaviour
  const contentAfterFirst = files['Memory/_index.json'];

  await graph.flush(); // _dirty is false — should be a no-op

  assert.strictEqual(
    files['Memory/_index.json'],
    contentAfterFirst,
    'Second flush() on a clean graph should not modify the file'
  );
});

// ---------------------------------------------------------------------------
// EntityExtractor tests
// ---------------------------------------------------------------------------

// Test 11: EntityExtractor lightweight extracts wikilinks and page title entity
asyncTest('EntityExtractor lightweight extracts wikilinks and page title entity', async () => {
  const fc = createMockFilesClient(null);
  const graph = new KnowledgeGraph({ ncFilesClient: fc, logger: silentLogger });
  graph._loaded = true;

  // No router — lightweight only
  const extractor = new EntityExtractor({ knowledgeGraph: graph, logger: silentLogger });

  await extractor.extractFromPage('People/Sarah Chen', 'Worked with [[Project Phoenix]]');

  // Title "People/Sarah Chen" → type 'person', id 'person_sarah_chen'
  assert.ok(
    graph._entities.has('person_sarah_chen'),
    'Should have added person_sarah_chen entity from page title'
  );

  // Wikilink [[Project Phoenix]] → entity with name 'Project Phoenix'
  const phoenixEntity = Array.from(graph._entities.values()).find(
    e => e.name === 'Project Phoenix'
  );
  assert.ok(phoenixEntity != null, 'Should have an entity named "Project Phoenix" from wikilink');

  // Should have a 'references' triple linking the two
  const referencesTriple = graph._triples.find(t => t.predicate === 'references');
  assert.ok(referencesTriple != null, 'Should have a "references" triple from wikilink extraction');
});

// Test 12: EntityExtractor deep extraction parses LLM JSON response
asyncTest('EntityExtractor deep extraction parses LLM JSON response', async () => {
  const fc = createMockFilesClient(null);
  const graph = new KnowledgeGraph({ ncFilesClient: fc, logger: silentLogger });
  graph._loaded = true;

  const mockRouter = createMockRouter({
    entities: [{ name: 'Acme Corp', type: 'organization' }],
    relationships: [{ from: 'Sarah Chen', predicate: 'works_on', to: 'Acme Corp' }]
  });

  const extractor = new EntityExtractor({
    knowledgeGraph: graph,
    llmRouter: mockRouter,
    logger: silentLogger
  });

  // Content must be >= 500 chars to trigger deep extraction
  await extractor.extractFromPage('Notes', 'x'.repeat(600));

  // 'Acme Corp' should have been added from the LLM response
  const acmeEntity = Array.from(graph._entities.values()).find(
    e => e.name === 'Acme Corp'
  );
  assert.ok(acmeEntity != null, 'Should have entity "Acme Corp" from deep LLM extraction');

  // A 'works_on' triple should exist in the graph
  const worksOnTriple = graph._triples.find(t => t.predicate === 'works_on');
  assert.ok(worksOnTriple != null, 'Should have a "works_on" triple from deep LLM extraction');
});

// Test 13: flush() with empty graph is no-op (no write)
asyncTest('flush() with empty dirty graph skips write', async () => {
  let writeCount = 0;
  const fc = {
    readFile: async () => { throw new Error('404'); },
    writeFile: async () => { writeCount++; return { success: true }; },
    mkdir: async () => {}
  };
  const graph = new KnowledgeGraph({ ncFilesClient: fc, logger: silentLogger });
  graph._loaded = true;

  // Make dirty but with no entities/triples
  graph._dirty = true;

  await graph.flush();

  assert.strictEqual(writeCount, 0, 'Should not write empty graph');
  assert.strictEqual(graph._dirty, false, '_dirty should be cleared');
});

// Test 14: flush() failure logs LOUD error and propagates
asyncTest('flush() failure logs error and propagates', async () => {
  const errors = [];
  const loudLogger = { log() {}, info() {}, warn() {}, error(msg) { errors.push(msg); } };
  const fc = {
    readFile: async () => { throw new Error('404'); },
    writeFile: async () => { throw new Error('WebDAV 409'); },
    mkdir: async () => {}
  };
  const graph = new KnowledgeGraph({ ncFilesClient: fc, logger: loudLogger });
  graph._loaded = true;
  graph.addEntity('Alice', 'person');

  let threw = false;
  try {
    await graph.flush();
  } catch (err) {
    threw = true;
    assert.ok(err.message.includes('WebDAV 409'), 'Should propagate original error');
  }

  assert.ok(threw, 'flush() should throw on write failure');
  assert.ok(errors.length > 0, 'Should have logged an error');
  assert.ok(errors[0].includes('Flush FAILED'), 'Error should mention Flush FAILED');
  assert.ok(errors[0].includes('1 entities'), 'Error should include entity count');
  assert.ok(graph._dirty, '_dirty should remain true on failure');
});

// Test 15: flush() round-trip — write then load recovers data
asyncTest('flush() round-trip — write then load recovers data', async () => {
  const fc = createMockFilesClient(null);
  const graph1 = new KnowledgeGraph({ ncFilesClient: fc, logger: silentLogger });
  graph1._loaded = true;

  graph1.addEntity('Alice', 'person');
  graph1.addEntity('Project X', 'project');
  graph1.addTriple('person_alice', 'works_on', 'project_project_x');

  await graph1.flush();

  // Load into a fresh graph
  const graph2 = new KnowledgeGraph({ ncFilesClient: fc, logger: silentLogger });
  await graph2.load();

  assert.strictEqual(graph2._entities.size, 2, 'Should load 2 entities');
  assert.strictEqual(graph2._triples.length, 1, 'Should load 1 triple');
  assert.ok(graph2._entities.has('person_alice'), 'Should have person_alice');
  assert.ok(graph2._entities.has('project_project_x'), 'Should have project_project_x');
});

// ---------------------------------------------------------------------------
// EntityExtractor backfillAll tests
// ---------------------------------------------------------------------------

// Test 16: backfillAll processes non-Meta, non-stub pages
asyncTest('backfillAll processes non-Meta, non-stub pages', async () => {
  const fc = createMockFilesClient(null);
  const graph = new KnowledgeGraph({ ncFilesClient: fc, logger: silentLogger });
  graph._loaded = true;

  const extractor = new EntityExtractor({ knowledgeGraph: graph, logger: silentLogger });

  const mockCollectives = {
    resolveCollective: async () => 1,
    listPages: async () => [
      { title: 'Sarah Chen', filePath: 'People', fileName: 'Sarah Chen.md' },
      { title: 'Project Phoenix', filePath: 'Projects', fileName: 'Project Phoenix.md' },
      { title: 'Meta Index', filePath: 'Meta', fileName: 'Index.md' },  // should be skipped
      { title: 'Stub', filePath: 'Notes', fileName: 'Stub.md' }          // content < 50 chars
    ],
    readPageContent: async (path) => {
      if (path.includes('Meta')) return 'meta content';
      if (path.includes('Stub')) return 'short';  // < 50 chars
      if (path.includes('Sarah')) return 'Sarah Chen is a developer at TheCatalyne. She works with [[Project Phoenix]].';
      if (path.includes('Phoenix')) return 'Project Phoenix is the Q1 internal tooling initiative led by Fu.';
      return null;
    }
  };

  const result = await extractor.backfillAll(mockCollectives);

  assert.strictEqual(result.processed, 2, 'Should process 2 pages (skip Meta + stub)');
  assert.strictEqual(result.failed, 0, 'Should have 0 failures');
  assert.ok(graph._entities.size > 0, 'Graph should have entities after backfill');
});

// Test 17: backfillAll handles read failure on one page without aborting
asyncTest('backfillAll handles read failure without aborting', async () => {
  const fc = createMockFilesClient(null);
  const graph = new KnowledgeGraph({ ncFilesClient: fc, logger: silentLogger });
  graph._loaded = true;

  const extractor = new EntityExtractor({ knowledgeGraph: graph, logger: silentLogger });

  const mockCollectives = {
    resolveCollective: async () => 1,
    listPages: async () => [
      { title: 'Good Page', filePath: 'Notes', fileName: 'Good Page.md' },
      { title: 'Bad Page', filePath: 'Notes', fileName: 'Bad Page.md' }
    ],
    readPageContent: async (path) => {
      if (path.includes('Bad')) throw new Error('API timeout');
      return 'This is a good page with some substantial content that is long enough to process.';
    }
  };

  const result = await extractor.backfillAll(mockCollectives);

  assert.strictEqual(result.processed, 1, 'Should process 1 page');
  assert.strictEqual(result.failed, 1, 'Should have 1 failure');
});

// Test 18: backfillAll without collectivesClient returns early
asyncTest('backfillAll without collectivesClient returns early', async () => {
  const fc = createMockFilesClient(null);
  const graph = new KnowledgeGraph({ ncFilesClient: fc, logger: silentLogger });
  graph._loaded = true;

  const extractor = new EntityExtractor({ knowledgeGraph: graph, logger: silentLogger });

  const result = await extractor.backfillAll(null);

  assert.strictEqual(result.processed, 0, 'Should process 0 pages');
  assert.strictEqual(result.failed, 0, 'Should have 0 failures');
});

// Test 19: flush() includes lastFlushed timestamp
asyncTest('flush() includes lastFlushed timestamp', async () => {
  const fc = createMockFilesClient(null);
  const graph = new KnowledgeGraph({ ncFilesClient: fc, logger: silentLogger });
  graph._loaded = true;

  graph.addEntity('Test', 'note');
  await graph.flush();

  const content = fc.getFiles()['Memory/_index.json'];
  assert.ok(content.includes('lastFlushed'), 'Should include lastFlushed timestamp');
});

// Test 20: Legacy wikiClient path still works for backward compat
asyncTest('Legacy wikiClient flush/load round-trip still works', async () => {
  const wiki = createMockWikiClient(null);
  const graph1 = new KnowledgeGraph({ wikiClient: wiki, logger: silentLogger });
  graph1._loaded = true;

  graph1.addEntity('Alice', 'person');
  await graph1.flush();

  const pages = wiki.getPages();
  assert.ok(pages['Memory/_index'] != null, 'Legacy path should write to wiki page');
  assert.ok(pages['Memory/_index'].includes('```json'), 'Legacy path should use code fence');

  const graph2 = new KnowledgeGraph({ wikiClient: wiki, logger: silentLogger });
  await graph2.load();

  assert.strictEqual(graph2._entities.size, 1, 'Should load entity from legacy wiki');
  assert.ok(graph2._entities.has('person_alice'), 'Should have person_alice');
});

// ---------------------------------------------------------------------------
// Entity dedup tests (cross-type)
// ---------------------------------------------------------------------------

// Test 21: Same name, different types → one entity, more specific type wins
test('addEntity() same name different types — specific type wins', () => {
  const fc = createMockFilesClient(null);
  const graph = new KnowledgeGraph({ ncFilesClient: fc, logger: silentLogger });
  graph._loaded = true;

  // Add as person first, then as project (more specific)
  const id1 = graph.addEntity('Project Phoenix', 'person');
  const id2 = graph.addEntity('Project Phoenix', 'project');

  assert.strictEqual(graph._entities.size, 1, 'Should have exactly 1 entity');
  const entity = graph._entities.get(id2);
  assert.ok(entity, 'Entity should exist under project id');
  assert.strictEqual(entity.type, 'project', 'Type should be project (more specific)');
});

// Test 22: Person type does not override project type
test('addEntity() person does not override project for same name', () => {
  const fc = createMockFilesClient(null);
  const graph = new KnowledgeGraph({ ncFilesClient: fc, logger: silentLogger });
  graph._loaded = true;

  const id1 = graph.addEntity('Project Phoenix', 'project');
  const id2 = graph.addEntity('Project Phoenix', 'person');

  assert.strictEqual(graph._entities.size, 1, 'Should have exactly 1 entity');
  assert.strictEqual(id2, id1, 'Should return existing project id');
  assert.strictEqual(graph._entities.get(id1).type, 'project', 'Type should stay project');
});

// Test 23: Re-type updates triple references
test('addEntity() re-type rewrites triple ids', () => {
  const fc = createMockFilesClient(null);
  const graph = new KnowledgeGraph({ ncFilesClient: fc, logger: silentLogger });
  graph._loaded = true;

  const oldId = graph.addEntity('Project Phoenix', 'person');
  const fuId = graph.addEntity('Fu', 'person');
  graph.addTriple(oldId, 'leads', fuId);

  // Re-type: person → project (more specific)
  const newId = graph.addEntity('Project Phoenix', 'project');

  assert.strictEqual(graph._triples[0].subject, newId, 'Triple subject should be updated to new id');
  assert.strictEqual(graph._triples[0].object, fuId, 'Triple object should be unchanged');
});

// Test 24: Expanded predicates accepted by addTriple
test('addTriple() accepts expanded predicates (led_by, works_at, etc)', () => {
  const fc = createMockFilesClient(null);
  const graph = new KnowledgeGraph({ ncFilesClient: fc, logger: silentLogger });
  graph._loaded = true;

  const projId = graph.addEntity('Project Phoenix', 'project');
  const fuId = graph.addEntity('Fu', 'person');
  const coId = graph.addEntity('TheCatalyne', 'organization');

  graph.addTriple(projId, 'led_by', fuId);
  graph.addTriple(fuId, 'works_at', coId);
  graph.addTriple(projId, 'has_goal', coId);

  assert.strictEqual(graph._triples.length, 3, 'Should have 3 triples with new predicates');
  assert.strictEqual(graph._triples[0].predicate, 'led_by');
  assert.strictEqual(graph._triples[1].predicate, 'works_at');
  assert.strictEqual(graph._triples[2].predicate, 'has_goal');
});

// Test 25: load() deduplicates same-name entities with different types
asyncTest('load() collapses cross-type duplicates from persisted data', async () => {
  // Pre-populate with duplicate: Project Phoenix as both project and person
  const dupeData = JSON.stringify({
    entities: [
      { id: 'project_project_phoenix', name: 'Project Phoenix', type: 'project', created: '2026-03-05T00:00:00Z' },
      { id: 'person_project_phoenix', name: 'Project Phoenix', type: 'person', created: '2026-03-05T00:01:00Z' },
      { id: 'person_fu', name: 'Fu', type: 'person', created: '2026-03-05T00:00:00Z' }
    ],
    triples: [
      { subject: 'person_project_phoenix', predicate: 'leads', object: 'person_fu', verified: '2026-03-05T00:00:00Z' }
    ]
  });

  const fc = createMockFilesClient(dupeData);
  const graph = new KnowledgeGraph({ ncFilesClient: fc, logger: silentLogger });
  await graph.load();

  // Should have collapsed to 2 entities (Project Phoenix once + Fu)
  assert.strictEqual(graph._entities.size, 2, 'Should collapse to 2 entities');

  // Project Phoenix should be type: project (more specific)
  const phoenix = Array.from(graph._entities.values()).find(e => e.name === 'Project Phoenix');
  assert.ok(phoenix, 'Project Phoenix should exist');
  assert.strictEqual(phoenix.type, 'project', 'Should keep project type (more specific than person)');

  // Triple should reference the project id, not the person id
  assert.strictEqual(graph._triples.length, 1, 'Should have 1 triple');
  assert.strictEqual(graph._triples[0].subject, 'project_project_phoenix',
    'Triple subject should be remapped to project id');

  // Should be marked dirty so next flush writes clean data
  assert.strictEqual(graph._dirty, true, 'Should be dirty after dedup');
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
