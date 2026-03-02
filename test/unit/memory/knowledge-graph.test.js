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

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const KnowledgeGraph = require('../../../src/lib/memory/knowledge-graph');
const EntityExtractor = require('../../../src/lib/memory/entity-extractor');

const silentLogger = { log() {}, info() {}, warn() {}, error() {} };

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
// KnowledgeGraph tests
// ---------------------------------------------------------------------------

// Test 1: load() on empty wiki starts with empty graph
asyncTest('load() on empty wiki starts with empty graph', async () => {
  const wiki = createMockWikiClient(null);
  const graph = new KnowledgeGraph({ wikiClient: wiki, logger: silentLogger });

  await graph.load();

  assert.strictEqual(graph._entities.size, 0, 'Should have 0 entities after loading empty wiki');
  assert.strictEqual(graph._triples.length, 0, 'Should have 0 triples after loading empty wiki');
});

// Test 2: addEntity() creates normalized ID (person_sarah_chen)
test('addEntity() creates normalized ID (person_sarah_chen)', () => {
  const wiki = createMockWikiClient(null);
  const graph = new KnowledgeGraph({ wikiClient: wiki, logger: silentLogger });
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
  const wiki = createMockWikiClient(null);
  const graph = new KnowledgeGraph({ wikiClient: wiki, logger: silentLogger });
  graph._loaded = true;

  const id1 = graph.addEntity('Alice Doe', 'person');
  const id2 = graph.addEntity('Alice Doe', 'person');

  assert.strictEqual(graph._entities.size, 1, 'Should have exactly 1 entity after duplicate add');
  assert.strictEqual(id1, id2, 'Both calls should return the same id');
});

// Test 4: addTriple() deduplicates — second call refreshes verified timestamp
asyncTest('addTriple() deduplicates — second call refreshes verified timestamp', async () => {
  const wiki = createMockWikiClient(null);
  const graph = new KnowledgeGraph({ wikiClient: wiki, logger: silentLogger });
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
  const wiki = createMockWikiClient(null);
  const graph = new KnowledgeGraph({ wikiClient: wiki, logger: silentLogger });
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
  const wiki = createMockWikiClient(null);
  const graph = new KnowledgeGraph({ wikiClient: wiki, logger: silentLogger });
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
  const wiki = createMockWikiClient(null);
  const graph = new KnowledgeGraph({ wikiClient: wiki, logger: silentLogger });
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
  const wiki = createMockWikiClient(null);
  const graph = new KnowledgeGraph({ wikiClient: wiki, logger: silentLogger });
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
  const wiki = createMockWikiClient(null);
  const graph = new KnowledgeGraph({ wikiClient: wiki, logger: silentLogger });
  graph._loaded = true;

  const idA = graph.addEntity('Alice Doe', 'person');
  const idB = graph.addEntity('Bob Smith', 'person');
  // No triples added between A and B

  const result = graph.findPath(idA, idB);

  assert.strictEqual(result, null, 'findPath should return null when there is no path');
});

// Test 10: flush() writes JSON to wiki; second flush without changes is no-op
asyncTest('flush() writes JSON to wiki; second flush without changes is no-op', async () => {
  const wiki = createMockWikiClient(null);
  const graph = new KnowledgeGraph({ wikiClient: wiki, logger: silentLogger });
  graph._loaded = true;

  graph.addEntity('Alice Doe', 'person');

  await graph.flush();

  const pages = wiki.getPages();
  assert.ok(pages['Memory/_index'] != null, 'Wiki page should have been written by flush()');
  assert.ok(
    pages['Memory/_index'].includes('```json'),
    'Written content should include a JSON code fence'
  );
  assert.strictEqual(graph._dirty, false, '_dirty should be false after flush()');

  // Record content before second flush to verify no-op behaviour
  const contentAfterFirst = pages['Memory/_index'];

  await graph.flush(); // _dirty is false — should be a no-op

  assert.strictEqual(
    pages['Memory/_index'],
    contentAfterFirst,
    'Second flush() on a clean graph should not modify the wiki page'
  );
});

// ---------------------------------------------------------------------------
// EntityExtractor tests
// ---------------------------------------------------------------------------

// Test 11: EntityExtractor lightweight extracts wikilinks and page title entity
asyncTest('EntityExtractor lightweight extracts wikilinks and page title entity', async () => {
  const wiki = createMockWikiClient(null);
  const graph = new KnowledgeGraph({ wikiClient: wiki, logger: silentLogger });
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
  const wiki = createMockWikiClient(null);
  const graph = new KnowledgeGraph({ wikiClient: wiki, logger: silentLogger });
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

setTimeout(() => { summary(); exitWithCode(); }, 500);
