/*
 * Moltagent - Sovereign AI Security Layer
 * Copyright (C) 2026 Moltagent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 */

/**
 * Unit Tests for MemorySearcher — Three-Channel Fusion
 *
 * Tests the keyword + vector + graph channel fusion flow:
 * _searchKeyword, _searchVector, _searchGraph, and _fuseResults.
 * Also covers co-access expansion.
 *
 * Run: node test/unit/integrations/memory-searcher-fusion.test.js
 *
 * @module test/unit/integrations/memory-searcher-fusion
 */

'use strict';
// Mock type: LEGACY — TODO: migrate to realistic mocks

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const MemorySearcher = require('../../../src/lib/integrations/memory-searcher');

const silentLogger = { log() {}, info() {}, warn() {}, error() {} };

// ============================================================================
// Mock helpers
// ============================================================================

/**
 * Create a minimal NCSearchClient mock.
 * Each call to searchProvider returns the provided results array mapped to the
 * NC Unified Search entry shape { title, subline, resourceUrl }.
 */
function createMockNCSearchClient(results = []) {
  return {
    getProviders: async () => [{ id: 'collectives-page-content', name: 'Wiki' }],
    searchProvider: async (pid, query, limit) => results.map(r => ({
      title: r.title || r,
      subline: r.excerpt || '',
      resourceUrl: r.link || ''
    }))
  };
}

/**
 * Create a VectorStore mock.
 * search() returns results mapped to { title, id, score }.
 */
function createMockVectorStore(results = []) {
  return {
    search: (vector, limit) => results.map(r => ({
      title: r.title || r,
      id: r.title || r,
      score: r.score || 0.8
    }))
  };
}

/**
 * Create an EmbeddingClient mock that always returns a fixed 3-element vector.
 */
function createMockEmbeddingClient() {
  return {
    embed: async (text) => [0.1, 0.2, 0.3]
  };
}

/**
 * Create a KnowledgeGraph mock.
 *
 * @param {Array<{id:string, name:string}>} entities
 * @param {Array<{subject:string, predicate:string, object:string}>} triples
 */
function createMockKnowledgeGraph(entities = [], triples = []) {
  const entityMap = new Map();
  for (const e of entities) {
    entityMap.set(e.id, e);
  }
  return {
    _entities: entityMap,
    getEntity: (id) => entityMap.get(id) || null,
    relatedTo: (entityId, maxHops) => {
      // Return related entities based on triples (distance 1 only)
      const results = [];
      for (const t of triples) {
        if (t.subject === entityId && entityMap.has(t.object)) {
          results.push({ entity: entityMap.get(t.object), predicate: t.predicate, distance: 1 });
        }
        if (t.object === entityId && entityMap.has(t.subject)) {
          results.push({ entity: entityMap.get(t.subject), predicate: t.predicate, distance: 1 });
        }
      }
      return results;
    }
  };
}

/**
 * Create a KnowledgeGraph mock that supports 2-hop traversal.
 * relatedTo returns both distance-1 and distance-2 relationships.
 */
function createMockKnowledgeGraphMultiHop(entities = [], triples = []) {
  const entityMap = new Map();
  for (const e of entities) {
    entityMap.set(e.id, e);
  }
  return {
    _entities: entityMap,
    getEntity: (id) => entityMap.get(id) || null,
    relatedTo: (entityId, maxHops) => {
      const results = [];
      const hop1Ids = new Set();

      // Distance-1 relationships
      for (const t of triples) {
        if (t.subject === entityId && entityMap.has(t.object)) {
          results.push({ entity: entityMap.get(t.object), predicate: t.predicate, distance: 1 });
          hop1Ids.add(t.object);
        }
        if (t.object === entityId && entityMap.has(t.subject)) {
          results.push({ entity: entityMap.get(t.subject), predicate: t.predicate, distance: 1 });
          hop1Ids.add(t.subject);
        }
      }

      // Distance-2 relationships (hop through hop-1 neighbours)
      if (maxHops >= 2) {
        for (const hop1Id of hop1Ids) {
          for (const t of triples) {
            if (t.subject === hop1Id && entityMap.has(t.object) && t.object !== entityId) {
              results.push({ entity: entityMap.get(t.object), predicate: t.predicate, distance: 2 });
            }
            if (t.object === hop1Id && entityMap.has(t.subject) && t.subject !== entityId) {
              results.push({ entity: entityMap.get(t.subject), predicate: t.predicate, distance: 2 });
            }
          }
        }
      }

      return results;
    }
  };
}

// ============================================================================
// Tests
// ============================================================================

console.log('\n=== MemorySearcher Three-Channel Fusion Tests ===\n');

(async () => {

  // --------------------------------------------------------------------------
  // Test 1: search() returns keyword results when vector and graph unavailable
  // --------------------------------------------------------------------------
  await asyncTest('search() returns keyword results when vector and graph unavailable', async () => {
    const ncClient = createMockNCSearchClient([
      { title: 'Page One', excerpt: 'First result', link: '/wiki/one' },
      { title: 'Page Two', excerpt: 'Second result', link: '/wiki/two' }
    ]);
    const searcher = new MemorySearcher({
      ncSearchClient: ncClient,
      logger: silentLogger
      // No vectorStore, no knowledgeGraph
    });

    const results = await searcher.search('test query');

    assert.strictEqual(results.length, 2, 'Should return exactly 2 keyword results');

    for (const r of results) {
      assert.ok(r.channelScores, `Result "${r.title}" should have a channelScores property`);
    }

    // At least one result should have a non-zero keyword score
    const keywordScored = results.filter(r => r.channelScores.keyword > 0);
    assert.ok(keywordScored.length > 0, 'At least one result should have channelScores.keyword > 0');
    assert.ok(results[0].channelScores.keyword > 0, 'First result should have channelScores.keyword > 0');
  });

  // --------------------------------------------------------------------------
  // Test 2: search() fuses keyword + vector scores with channel weights
  // --------------------------------------------------------------------------
  await asyncTest('search() fuses keyword + vector scores with channel weights', async () => {
    const ncClient = createMockNCSearchClient([
      { title: 'Alpha', excerpt: 'from keyword', link: '/wiki/alpha' }
    ]);
    const vectorStore = createMockVectorStore([
      { title: 'Beta', score: 0.9 }
    ]);
    const embeddingClient = createMockEmbeddingClient();

    const searcher = new MemorySearcher({
      ncSearchClient: ncClient,
      vectorStore,
      embeddingClient,
      logger: silentLogger
    });

    const results = await searcher.search('test');

    const titles = results.map(r => r.title);
    assert.ok(titles.includes('Alpha'), 'Results should contain keyword result "Alpha"');
    assert.ok(titles.includes('Beta'), 'Results should contain vector result "Beta"');

    for (const r of results) {
      assert.ok(r.channelScores, `Result "${r.title}" should have channelScores`);
      assert.ok('keyword' in r.channelScores, `channelScores should have keyword key`);
      assert.ok('vector' in r.channelScores, `channelScores should have vector key`);
      assert.ok('graph' in r.channelScores, `channelScores should have graph key`);
    }

    const alpha = results.find(r => r.title === 'Alpha');
    const beta = results.find(r => r.title === 'Beta');
    assert.ok(alpha.channelScores.keyword > 0, 'Alpha should have keyword score > 0');
    assert.ok(beta.channelScores.vector > 0, 'Beta should have vector score > 0');
  });

  // --------------------------------------------------------------------------
  // Test 3: search() includes graph results with distance-based scoring
  // --------------------------------------------------------------------------
  await asyncTest('search() includes graph results with distance-based scoring', async () => {
    // Query contains "Phoenix" — the graph entity named "Phoenix" should be matched
    const ncClient = createMockNCSearchClient([]); // No keyword results

    const knowledgeGraph = createMockKnowledgeGraph(
      [
        { id: 'project_phoenix', name: 'Phoenix' },
        { id: 'team_alpha',      name: 'Alpha Team' }
      ],
      [
        { subject: 'project_phoenix', predicate: 'assigned_to', object: 'team_alpha' }
      ]
    );

    const searcher = new MemorySearcher({
      ncSearchClient: ncClient,
      knowledgeGraph,
      logger: silentLogger
    });

    const results = await searcher.search('tell me about Phoenix');

    // Graph traversal should yield at least the related entity (Alpha Team)
    // and potentially the direct match (Phoenix itself)
    assert.ok(results.length > 0, 'Should return at least one graph result');

    const graphResults = results.filter(r => r.graph === true || (r.channelScores && r.channelScores.graph > 0));
    assert.ok(graphResults.length > 0, 'At least one result should come from the graph channel');
  });

  // --------------------------------------------------------------------------
  // Test 4: search() deduplicates across channels
  // --------------------------------------------------------------------------
  await asyncTest('search() deduplicates across channels', async () => {
    // Both keyword and vector return the same title
    const ncClient = createMockNCSearchClient([
      { title: 'Same Page', excerpt: 'from keyword', link: '/wiki/same' }
    ]);
    const vectorStore = createMockVectorStore([
      { title: 'Same Page', score: 0.85 }
    ]);
    const embeddingClient = createMockEmbeddingClient();

    const searcher = new MemorySearcher({
      ncSearchClient: ncClient,
      vectorStore,
      embeddingClient,
      logger: silentLogger
    });

    const results = await searcher.search('test');

    const samePage = results.filter(r => r.title === 'Same Page');
    assert.strictEqual(samePage.length, 1, '"Same Page" should appear exactly once (deduplicated)');

    // The single merged result should carry scores from both channels
    assert.ok(samePage[0].channelScores.keyword > 0, 'Merged result should carry keyword score');
    assert.ok(samePage[0].channelScores.vector > 0, 'Merged result should carry vector score');
  });

  // --------------------------------------------------------------------------
  // Test 5: search() channelScores included in all results
  // --------------------------------------------------------------------------
  await asyncTest('search() channelScores included in results', async () => {
    const ncClient = createMockNCSearchClient([
      { title: 'Result A', excerpt: 'excerpt a', link: '/wiki/a' },
      { title: 'Result B', excerpt: 'excerpt b', link: '/wiki/b' }
    ]);
    const searcher = new MemorySearcher({
      ncSearchClient: ncClient,
      logger: silentLogger
    });

    const results = await searcher.search('query');

    assert.ok(results.length > 0, 'Should return results');

    for (const r of results) {
      assert.ok(
        r.channelScores && typeof r.channelScores === 'object',
        `Every result should have a channelScores object (missing on "${r.title}")`
      );
      assert.ok('keyword' in r.channelScores, `channelScores.keyword must exist on "${r.title}"`);
      assert.ok('vector'  in r.channelScores, `channelScores.vector must exist on "${r.title}"`);
      assert.ok('graph'   in r.channelScores, `channelScores.graph must exist on "${r.title}"`);
    }
  });

  // --------------------------------------------------------------------------
  // Test 6: search() applies co-access expansion when results sparse
  // --------------------------------------------------------------------------
  await asyncTest('search() applies co-access expansion when results sparse', async () => {
    // Only 1 wiki result — sparse, so co-access expansion should fire
    const ncClient = createMockNCSearchClient([
      { title: 'Sparse Page', excerpt: 'one result', link: '/wiki/sparse' }
    ]);

    const coAccessGraph = {
      record: async () => {},
      getRelated: async (title) => [{ title: 'Related Page', weight: 3 }]
    };

    const searcher = new MemorySearcher({
      ncSearchClient: ncClient,
      coAccessGraph,
      logger: silentLogger
    });

    const results = await searcher.search('sparse topic', { maxResults: 5 });

    const relatedPage = results.find(r => r.title === 'Related Page');
    assert.ok(relatedPage, 'Results should include "Related Page" from co-access expansion');
    assert.strictEqual(relatedPage.coAccess, true, 'Expanded result should have coAccess: true');
  });

  // --------------------------------------------------------------------------
  // Test 7: _searchGraph() finds entity mentioned in query
  // --------------------------------------------------------------------------
  await asyncTest('_searchGraph() finds entity mentioned in query', async () => {
    const ncClient = createMockNCSearchClient([]);

    const knowledgeGraph = createMockKnowledgeGraph(
      [
        { id: 'person_sarah_chen', name: 'Sarah Chen' },
        { id: 'project_atlas',     name: 'Atlas Project' }
      ],
      [
        { subject: 'person_sarah_chen', predicate: 'leads', object: 'project_atlas' }
      ]
    );

    const searcher = new MemorySearcher({
      ncSearchClient: ncClient,
      knowledgeGraph,
      logger: silentLogger
    });

    // Call the private method directly
    const results = await searcher._searchGraph('What does Sarah Chen work on?', 5);

    assert.ok(results.length > 0, 'Graph search should return at least one result');

    // Atlas Project should appear as a distance-1 result from Sarah Chen
    const atlasResult = results.find(r => r.title === 'Atlas Project');
    assert.ok(atlasResult, 'Should find related entity "Atlas Project"');
    assert.strictEqual(atlasResult.graph, true, 'Result should be flagged as graph: true');
    assert.ok(atlasResult._graphScore > 0, 'Atlas Project should have a positive _graphScore');
  });

  // --------------------------------------------------------------------------
  // Test 8: _searchGraph() traverses relationships to resolve connected wiki pages
  // --------------------------------------------------------------------------
  await asyncTest('_searchGraph() traverses relationships to resolve connected wiki pages', async () => {
    const ncClient = createMockNCSearchClient([]);

    // A → B (distance 1), B → C (distance 2 from A)
    const knowledgeGraph = createMockKnowledgeGraphMultiHop(
      [
        { id: 'entity_a', name: 'Concept A' },
        { id: 'entity_b', name: 'Concept B' },
        { id: 'entity_c', name: 'Concept C' }
      ],
      [
        { subject: 'entity_a', predicate: 'related_to', object: 'entity_b' },
        { subject: 'entity_b', predicate: 'related_to', object: 'entity_c' }
      ]
    );

    const searcher = new MemorySearcher({
      ncSearchClient: ncClient,
      knowledgeGraph,
      logger: silentLogger
    });

    const results = await searcher._searchGraph('query about Concept A', 10);

    assert.ok(results.length >= 2, 'Should return results at distance 1 and 2');

    const conceptB = results.find(r => r.title === 'Concept B');
    const conceptC = results.find(r => r.title === 'Concept C');

    assert.ok(conceptB, 'Should include distance-1 entity "Concept B"');
    assert.ok(conceptC, 'Should include distance-2 entity "Concept C"');

    // Distance-1 score = 0.6, distance-2 score = 0.3
    assert.strictEqual(conceptB._graphScore, 0.6, 'Concept B (distance 1) should have score 0.6');
    assert.strictEqual(conceptC._graphScore, 0.3, 'Concept C (distance 2) should have score 0.3');
  });

  // --------------------------------------------------------------------------
  // Test 9: page score multiplier — typed sections get 2x boost
  // --------------------------------------------------------------------------
  await asyncTest('fusion scoring applies 2x multiplier for typed section pages', async () => {
    // Two results: one from /People/ path, one from generic path
    // Both have the same keyword score, so the typed page should rank higher
    const ncClient = createMockNCSearchClient([
      { title: 'Alex', excerpt: 'Contact at @user-123', link: '/apps/collectives/Moltagent Knowledge/People/Alex' },
      { title: 'Meeting Notes', excerpt: 'Discussed @user-123', link: '/apps/collectives/Moltagent Knowledge/Meeting Notes' }
    ]);
    const searcher = new MemorySearcher({
      ncSearchClient: ncClient,
      logger: silentLogger
    });

    const results = await searcher.search('@user-123');

    assert.ok(results.length >= 2, 'Should return both results');
    // Alex (People path, 2x) should rank above Meeting Notes (no multiplier)
    const carlosIdx = results.findIndex(r => r.title === 'Alex');
    const meetingIdx = results.findIndex(r => r.title === 'Meeting Notes');
    assert.ok(carlosIdx < meetingIdx, `Alex (People/ 2x) should rank above Meeting Notes, got idx ${carlosIdx} vs ${meetingIdx}`);
  });

  // --------------------------------------------------------------------------
  // Test 10: page score multiplier — Meta/ pages get 0.3x demotion
  // --------------------------------------------------------------------------
  await asyncTest('fusion scoring applies 0.3x demotion for Meta/ pages', async () => {
    const ncClient = createMockNCSearchClient([
      { title: 'Meta Config', excerpt: 'internal config page', link: '/apps/collectives/Moltagent Knowledge/Meta/Config' },
      { title: 'Onboarding Guide', excerpt: 'how to onboard', link: '/apps/collectives/Moltagent Knowledge/Onboarding Guide' }
    ]);
    const searcher = new MemorySearcher({
      ncSearchClient: ncClient,
      logger: silentLogger
    });

    const results = await searcher.search('config onboarding');

    assert.ok(results.length >= 2, 'Should return both results');
    // Onboarding Guide (1x) should rank above Meta Config (0.3x)
    const metaIdx = results.findIndex(r => r.title === 'Meta Config');
    const guideIdx = results.findIndex(r => r.title === 'Onboarding Guide');
    assert.ok(guideIdx < metaIdx, `Onboarding Guide (1x) should rank above Meta Config (0.3x), got idx ${guideIdx} vs ${metaIdx}`);
  });

  // --------------------------------------------------------------------------
  // Test 11: page score multiplier — Projects/Procedures/Decisions also get 2x
  // --------------------------------------------------------------------------
  await asyncTest('fusion scoring applies 2x multiplier for projects, procedures, decisions paths', async () => {
    const ncClient = createMockNCSearchClient([
      { title: 'Project Atlas', excerpt: 'main project', link: '/apps/collectives/Moltagent Knowledge/Projects/Atlas' },
      { title: 'Hiring Procedure', excerpt: 'hiring steps', link: '/apps/collectives/Moltagent Knowledge/Procedures/Hiring' },
      { title: 'Budget Decision', excerpt: 'Q1 budget', link: '/apps/collectives/Moltagent Knowledge/Decisions/Budget Q1' },
      { title: 'Random Note', excerpt: 'untyped page', link: '/apps/collectives/Moltagent Knowledge/Random Note' }
    ]);
    const searcher = new MemorySearcher({
      ncSearchClient: ncClient,
      logger: silentLogger
    });

    const results = await searcher.search('project hiring budget');

    // All three typed pages should rank above the untyped Random Note
    const randomIdx = results.findIndex(r => r.title === 'Random Note');
    for (const typed of ['Project Atlas', 'Hiring Procedure', 'Budget Decision']) {
      const typedIdx = results.findIndex(r => r.title === typed);
      assert.ok(typedIdx >= 0, `Should contain "${typed}"`);
      assert.ok(typedIdx < randomIdx, `"${typed}" (2x) should rank above "Random Note" (1x), got idx ${typedIdx} vs ${randomIdx}`);
    }
  });

  // --------------------------------------------------------------------------
  // Summary & exit
  // --------------------------------------------------------------------------
  setTimeout(() => { summary(); exitWithCode(); }, 500);

})();
