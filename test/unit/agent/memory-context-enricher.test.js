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
const MemoryContextEnricher = require('../../../src/lib/agent/memory-context-enricher');

const silentLogger = { log() {}, info() {}, warn() {}, error() {}, debug() {} };

// -- Test 1: _extractSearchTerms finds capitalized names --
test('_extractSearchTerms finds capitalized entity names', () => {
  const enricher = new MemoryContextEnricher({ memorySearcher: {}, logger: silentLogger });

  const terms = enricher._extractSearchTerms('Who is Sarah from ManeraMedia?');
  assert.ok(terms.includes('Sarah'), `Should find "Sarah", got: ${terms}`);
  assert.ok(terms.includes('ManeraMedia'), `Should find "ManeraMedia", got: ${terms}`);
});

// -- Test 2: _extractSearchTerms finds "know about X" patterns --
test('_extractSearchTerms finds knowledge query patterns', () => {
  const enricher = new MemoryContextEnricher({ memorySearcher: {}, logger: silentLogger });

  const terms = enricher._extractSearchTerms('What do you know about reading documents?');
  assert.ok(terms.some(t => t.includes('reading documents')), `Should find "reading documents", got: ${terms}`);
});

// -- Test 3: _extractSearchTerms returns empty for simple messages --
test('_extractSearchTerms returns empty for greetings', () => {
  const enricher = new MemoryContextEnricher({ memorySearcher: {}, logger: silentLogger });

  assert.deepStrictEqual(enricher._extractSearchTerms('hi'), []);
  assert.deepStrictEqual(enricher._extractSearchTerms('thanks'), []);
  assert.deepStrictEqual(enricher._extractSearchTerms('ok'), []);
});

// -- Test 4: enrich returns null for greeting/chitchat intents --
asyncTest('enrich returns null for greeting intent (skipped)', async () => {
  const enricher = new MemoryContextEnricher({
    memorySearcher: { search: async () => [{ title: 'Should not reach' }] },
    logger: silentLogger
  });

  const result = await enricher.enrich('Hello there', 'greeting');
  assert.strictEqual(result, null, 'Should skip greeting intent');
});

// -- Test 5: enrich returns null for confirmation intent --
asyncTest('enrich returns null for confirmation intent', async () => {
  const enricher = new MemoryContextEnricher({
    memorySearcher: { search: async () => [{ title: 'Should not reach' }] },
    logger: silentLogger
  });

  const result = await enricher.enrich('Yes, do it', 'confirmation');
  assert.strictEqual(result, null, 'Should skip confirmation intent');
});

// -- Test 6: enrich returns null for wiki intent (executor handles it) --
asyncTest('enrich returns null for wiki intent (WikiExecutor handles its own lookups)', async () => {
  const enricher = new MemoryContextEnricher({
    memorySearcher: { search: async () => [{ title: 'Should not reach' }] },
    logger: silentLogger
  });

  const result = await enricher.enrich('What does the wiki say about Sarah?', 'wiki');
  assert.strictEqual(result, null, 'Should skip wiki intent');
});

// -- Test 7: enrich returns formatted context when wiki has matches --
asyncTest('enrich returns formatted context when wiki has matches', async () => {
  const enricher = new MemoryContextEnricher({
    memorySearcher: {
      search: async () => [
        { source: 'Wiki', title: 'Sarah', excerpt: 'Sarah is the marketing lead at ManeraMedia' },
        { source: 'Wiki', title: 'ManeraMedia', excerpt: 'ManeraMedia is a podcast production company' }
      ]
    },
    logger: silentLogger
  });

  const result = await enricher.enrich('Tell me about Sarah from ManeraMedia', 'search');
  assert.ok(result !== null, 'Should return enrichment');
  assert.ok(result.includes('Sarah'), 'Should include Sarah page');
  assert.ok(result.includes('ManeraMedia'), 'Should include ManeraMedia page');
  assert.ok(result.includes('<agent_knowledge>'), 'Should wrap in agent_knowledge tags');
  assert.ok(result.includes('source:'), 'Should include source tag');
  assert.ok(result.includes('confidence:'), 'Should include confidence tag');
});

// -- Test 8: enrich returns null when no search results --
asyncTest('enrich returns null when search finds nothing', async () => {
  const enricher = new MemoryContextEnricher({
    memorySearcher: { search: async () => [] },
    logger: silentLogger
  });

  const result = await enricher.enrich('Tell me about Carlos', 'search');
  assert.strictEqual(result, null, 'Should return null when no results');
});

// -- Test 9: enrich returns null on timeout --
asyncTest('enrich returns null on timeout without blocking', async () => {
  const enricher = new MemoryContextEnricher({
    memorySearcher: {
      search: async () => {
        // Simulate slow search
        await new Promise(resolve => setTimeout(resolve, 5000));
        return [{ title: 'Should not reach' }];
      }
    },
    logger: silentLogger,
    timeout: 50 // 50ms timeout for test speed
  });

  const start = Date.now();
  const result = await enricher.enrich('Tell me about Carlos', 'search');
  const elapsed = Date.now() - start;

  assert.strictEqual(result, null, 'Should return null on timeout');
  assert.ok(elapsed < 1000, `Should complete quickly (timeout), took ${elapsed}ms`);
});

// -- Test 10: _extractSearchTerms filters common starters --
test('_extractSearchTerms filters common sentence starters', () => {
  const enricher = new MemoryContextEnricher({ memorySearcher: {}, logger: silentLogger });

  const terms = enricher._extractSearchTerms('The project FileOps is ready');
  assert.ok(!terms.includes('The'), 'Should filter "The"');
  assert.ok(terms.includes('FileOps'), `Should keep "FileOps", got: ${terms}`);
});

// -- Test 11: _extractSearchTerms finds quoted terms --
test('_extractSearchTerms finds quoted terms', () => {
  const enricher = new MemoryContextEnricher({ memorySearcher: {}, logger: silentLogger });

  const terms = enricher._extractSearchTerms('Search for "onboarding process" in the wiki');
  assert.ok(terms.some(t => t.includes('onboarding process')), `Should find quoted term, got: ${terms}`);
});

// -- Test 12: enrich handles search error gracefully --
asyncTest('enrich handles search error gracefully', async () => {
  const enricher = new MemoryContextEnricher({
    memorySearcher: {
      search: async () => { throw new Error('Connection refused'); }
    },
    logger: silentLogger
  });

  const result = await enricher.enrich('Tell me about Carlos', 'search');
  assert.strictEqual(result, null, 'Should return null on search error');
});

// -- Test 13: _computeConfidence returns high for strong keyword match --
test('_computeConfidence returns high for strong keyword match', () => {
  const enricher = new MemoryContextEnricher({ memorySearcher: {}, logger: silentLogger });

  assert.strictEqual(enricher._computeConfidence({ channelScores: { keyword: 1.0, vector: 0, graph: 0 } }), 'high');
  assert.strictEqual(enricher._computeConfidence({ channelScores: { keyword: 0.8, vector: 0, graph: 0 } }), 'high');
  assert.strictEqual(enricher._computeConfidence({ channelScores: { keyword: 0.5, vector: 0, graph: 0 } }), 'medium');
  assert.strictEqual(enricher._computeConfidence({ channelScores: { keyword: 0.1, vector: 0.2, graph: 0 } }), 'low');
  assert.strictEqual(enricher._computeConfidence({}), 'medium', 'No channelScores defaults to medium');
});

// -- Test 14: enricher output wraps in agent_knowledge tags with source metadata --
asyncTest('enricher output includes source and confidence per result', async () => {
  const enricher = new MemoryContextEnricher({
    memorySearcher: {
      search: async () => [
        { source: 'Wiki', title: 'Carlos', excerpt: 'Contact at TheCatalyne', channelScores: { keyword: 1.0, vector: 0, graph: 0 } }
      ]
    },
    logger: silentLogger
  });

  const result = await enricher.enrich('Tell me about Carlos', 'search');
  assert.ok(result.includes('<agent_knowledge>'), 'Should open agent_knowledge tag');
  assert.ok(result.includes('</agent_knowledge>'), 'Should close agent_knowledge tag');
  assert.ok(result.includes('source: wiki'), 'Should include source tag');
  assert.ok(result.includes('confidence: high'), 'Should compute high confidence for keyword 1.0');
  assert.ok(result.includes('Carlos'), 'Should include title');
});

// ============================================================
// Deck Enrichment Tests (Ring 2)
// ============================================================

function createMockDeckClient(cardsByStack = {}) {
  return {
    getAllCards: async () => cardsByStack,
    _callCount: 0,
    get callCount() { return this._callCount; },
    _origGetAllCards: null
  };
}

function enricherWithDeck(deckCards, wikiResults = []) {
  const deckClient = createMockDeckClient(deckCards);
  // Track getAllCards call count
  const origFn = deckClient.getAllCards;
  deckClient.getAllCards = async function() {
    deckClient._callCount++;
    return origFn.call(this);
  };
  return {
    enricher: new MemoryContextEnricher({
      memorySearcher: { search: async () => wikiResults },
      deckClient,
      logger: silentLogger
    }),
    deckClient
  };
}

// -- Test 15: _searchDeck finds card by title keyword --
asyncTest('_searchDeck finds card by title keyword', async () => {
  const { enricher } = enricherWithDeck({
    working: [{ id: 42, title: 'Compare Hetzner CPX31 vs GEX44', description: 'Research specs' }]
  });

  const result = await enricher.enrich('What about the Hetzner upgrade?', 'question');
  assert.ok(result !== null, 'Should find Hetzner card');
  assert.ok(result.includes('Hetzner'), 'Should include card title');
  assert.ok(result.includes('source: deck'), 'Should tag as deck source');
  assert.ok(result.includes('Card #42'), 'Should include card ID');
});

// -- Test 16: _searchDeck finds card by description keyword --
asyncTest('_searchDeck finds card by description keyword', async () => {
  const { enricher } = enricherWithDeck({
    inbox: [{ id: 99, title: 'Server Migration', description: 'Migrate from Hetzner to OVH cloud' }]
  });

  const result = await enricher.enrich('What do you know about OVH?', 'question');
  assert.ok(result !== null, 'Should find card by description match');
  assert.ok(result.includes('Server Migration'), 'Should include card title');
  assert.ok(result.includes('match: content'), 'Should tag as content match');
});

// -- Test 17: _searchDeck returns empty for no matches --
asyncTest('_searchDeck returns empty for no matches — not an error', async () => {
  const { enricher } = enricherWithDeck({
    inbox: [{ id: 1, title: 'Unrelated card', description: 'Nothing relevant' }]
  });

  const result = await enricher.enrich('Tell me about Carlos', 'question');
  // Only wiki results matter here, and wiki mock returns []
  assert.strictEqual(result, null, 'Should return null when no deck or wiki matches');
});

// -- Test 18: Results include stack name and card ID --
asyncTest('Deck results include stack name and card ID', async () => {
  const { enricher } = enricherWithDeck({
    review: [{ id: 77, title: 'Deploy MoltAgent v2', description: 'Production deploy', duedate: '2026-03-10' }]
  });

  const result = await enricher.enrich('What about MoltAgent deploy?', 'question');
  assert.ok(result.includes('Stack: review'), 'Should include stack name');
  assert.ok(result.includes('Card #77'), 'Should include card ID');
  assert.ok(result.includes('Due: 2026-03-10'), 'Should include due date');
});

// -- Test 19: Deck results appear in <agent_knowledge> alongside wiki results --
asyncTest('Deck results appear alongside wiki results in agent_knowledge', async () => {
  const wikiResults = [
    { source: 'Wiki', title: 'MoltAgent Docs', excerpt: 'Documentation for MoltAgent' }
  ];
  const { enricher } = enricherWithDeck(
    { working: [{ id: 55, title: 'MoltAgent Phase 2', description: 'Phase 2 work' }] },
    wikiResults
  );

  const result = await enricher.enrich('What about MoltAgent?', 'question');
  assert.ok(result.includes('source: wiki'), 'Should include wiki source');
  assert.ok(result.includes('source: deck'), 'Should include deck source');
  assert.ok(result.includes('MoltAgent Docs'), 'Should include wiki title');
  assert.ok(result.includes('MoltAgent Phase 2'), 'Should include deck card title');
});

// -- Test 20: Cache returns stale data within TTL (fast path) --
asyncTest('Deck cache returns stale data within TTL', async () => {
  const { enricher, deckClient } = enricherWithDeck({
    inbox: [{ id: 10, title: 'Hetzner card', description: 'test' }]
  });

  // First call — populates cache
  await enricher.enrich('Hetzner status?', 'question');
  const firstCallCount = deckClient._callCount;
  assert.strictEqual(firstCallCount, 1, 'Should call getAllCards once');

  // Second call — hits cache
  await enricher.enrich('Hetzner progress?', 'question');
  assert.strictEqual(deckClient._callCount, 1, 'Should NOT call getAllCards again (cache hit)');
});

// -- Test 21: invalidateDeckCache() forces fresh fetch --
asyncTest('invalidateDeckCache forces fresh fetch on next enrich', async () => {
  const { enricher, deckClient } = enricherWithDeck({
    inbox: [{ id: 10, title: 'Hetzner card', description: 'test' }]
  });

  // Populate cache
  await enricher.enrich('Hetzner status?', 'question');
  assert.strictEqual(deckClient._callCount, 1);

  // Invalidate
  enricher.invalidateDeckCache();

  // Next call should fetch again
  await enricher.enrich('Hetzner progress?', 'question');
  assert.strictEqual(deckClient._callCount, 2, 'Should call getAllCards again after invalidation');
});

// -- Test 22: Deck API failure doesn't block wiki enrichment --
asyncTest('Deck API failure does not block wiki enrichment', async () => {
  const failingDeckClient = {
    getAllCards: async () => { throw new Error('Deck API 503'); }
  };

  const enricher = new MemoryContextEnricher({
    memorySearcher: {
      search: async () => [
        { source: 'Wiki', title: 'Carlos', excerpt: 'Contact person' }
      ]
    },
    deckClient: failingDeckClient,
    logger: silentLogger
  });

  const result = await enricher.enrich('Tell me about Carlos', 'question');
  assert.ok(result !== null, 'Should still return wiki results');
  assert.ok(result.includes('Carlos'), 'Wiki result should be present despite deck failure');
  assert.ok(!result.includes('source: deck'), 'No deck results should be present');
});

setTimeout(() => { summary(); exitWithCode(); }, 1000);
