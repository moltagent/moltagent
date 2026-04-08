/*
 * Moltagent - Sovereign AI Security Layer
 * Copyright (C) 2026 Moltagent Contributors
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
const DECK = require('../../../src/config/deck-names');

const silentLogger = { log() {}, info() {}, warn() {}, error() {}, debug() {} };

// -- Test 1: _extractSearchTerms finds capitalized names --
test('_extractSearchTerms finds capitalized entity names', () => {
  const enricher = new MemoryContextEnricher({ memorySearcher: {}, logger: silentLogger });

  const terms = enricher._extractSearchTerms('Who is Sarah from AcmeCorp?');
  assert.ok(terms.includes('Sarah'), `Should find "Sarah", got: ${terms}`);
  assert.ok(terms.includes('AcmeCorp'), `Should find "AcmeCorp", got: ${terms}`);
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

// -- Test 6: enrich runs for wiki intent (pre-enriches warmMemory for WikiExecutor fallback) --
asyncTest('enrich runs for wiki intent to pre-populate warmMemory', async () => {
  const enricher = new MemoryContextEnricher({
    memorySearcher: { search: async () => [{ source: 'Wiki', title: 'Sarah', excerpt: 'Sarah is the marketing lead' }] },
    logger: silentLogger
  });

  const result = await enricher.enrich('What does the wiki say about Sarah?', 'wiki');
  assert.ok(result !== null, 'Should enrich wiki intent (no longer skipped)');
  assert.ok(result.includes('Sarah'), 'Should include search results');
  assert.ok(result.includes('<agent_knowledge>'), 'Should wrap in agent_knowledge tags');
});

// -- Test 7: enrich returns formatted context when wiki has matches --
asyncTest('enrich returns formatted context when wiki has matches', async () => {
  const enricher = new MemoryContextEnricher({
    memorySearcher: {
      search: async () => [
        { source: 'Wiki', title: 'Sarah', excerpt: 'Sarah is the marketing lead at AcmeCorp' },
        { source: 'Wiki', title: 'AcmeCorp', excerpt: 'AcmeCorp is a podcast production company' }
      ]
    },
    logger: silentLogger
  });

  const result = await enricher.enrich('Tell me about Sarah from AcmeCorp', 'search');
  assert.ok(result !== null, 'Should return enrichment');
  assert.ok(result.includes('Sarah'), 'Should include Sarah page');
  assert.ok(result.includes('AcmeCorp'), 'Should include AcmeCorp page');
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

  const result = await enricher.enrich('Tell me about Alex', 'search');
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
  const result = await enricher.enrich('Tell me about Alex', 'search');
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

  const result = await enricher.enrich('Tell me about Alex', 'search');
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
        { source: 'Wiki', title: 'Alex', excerpt: 'Contact at AcmeCorp', channelScores: { keyword: 1.0, vector: 0, graph: 0 } }
      ]
    },
    logger: silentLogger
  });

  const result = await enricher.enrich('Tell me about Alex', 'search');
  assert.ok(result.includes('<agent_knowledge>'), 'Should open agent_knowledge tag');
  assert.ok(result.includes('</agent_knowledge>'), 'Should close agent_knowledge tag');
  assert.ok(result.includes('source: wiki'), 'Should include source tag');
  assert.ok(result.includes('confidence: high'), 'Should compute high confidence for keyword 1.0');
  assert.ok(result.includes('Alex'), 'Should include title');
});

// ============================================================
// Deck Enrichment Tests (Ring 2)
// ============================================================

function createMockDeckClient(cardsByStack = {}, boards = null) {
  // Default: single board with all stacks
  const defaultBoards = [{ id: 1, title: DECK.boards.tasks, archived: false }];
  const boardList = boards || defaultBoards;

  // Convert cardsByStack to stacks array for getStacks()
  const stacks = Object.entries(cardsByStack).map(([name, cards], idx) => ({
    id: idx + 1, title: name, cards: cards || []
  }));

  return {
    listBoards: async () => boardList,
    getStacks: async () => stacks,
    getAllCards: async () => cardsByStack,
    _callCount: 0,
    get callCount() { return this._callCount; }
  };
}

function enricherWithDeck(deckCards, wikiResults = [], boards = null) {
  const deckClient = createMockDeckClient(deckCards, boards);
  // Track listBoards call count
  const origFn = deckClient.listBoards;
  deckClient.listBoards = async function() {
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

// -- Test 17: _searchDeck returns empty for no matches — board map still present --
asyncTest('_searchDeck returns empty for no matches — board map still present', async () => {
  const { enricher } = enricherWithDeck({
    inbox: [{ id: 1, title: 'Unrelated card', description: 'Nothing relevant' }]
  });

  const result = await enricher.enrich('Tell me about Alex', 'question');
  // No card matches, but board map is always injected when boards exist
  assert.ok(result !== null, 'Should return board map even without card matches');
  assert.ok(result.includes('<deck_boards>'), 'Should include board map');
  assert.ok(!result.includes('source: deck'), 'Should NOT include card-level deck results');
});

// -- Test 18: Results include stack name and card ID --
asyncTest('Deck results include stack name and card ID', async () => {
  const { enricher } = enricherWithDeck({
    review: [{ id: 77, title: 'Deploy Moltagent v2', description: 'Production deploy', duedate: '2026-03-10' }]
  });

  const result = await enricher.enrich('What about Moltagent deploy?', 'question');
  assert.ok(result.includes('Stack: review'), 'Should include stack name');
  assert.ok(result.includes('Card #77'), 'Should include card ID');
  assert.ok(result.includes('Due: 2026-03-10'), 'Should include due date');
});

// -- Test 19: Deck results appear in <agent_knowledge> alongside wiki results --
asyncTest('Deck results appear alongside wiki results in agent_knowledge', async () => {
  const wikiResults = [
    { source: 'Wiki', title: 'Moltagent Docs', excerpt: 'Documentation for Moltagent' }
  ];
  const { enricher } = enricherWithDeck(
    { working: [{ id: 55, title: 'Moltagent Phase 2', description: 'Phase 2 work' }] },
    wikiResults
  );

  const result = await enricher.enrich('What about Moltagent?', 'question');
  assert.ok(result.includes('source: wiki'), 'Should include wiki source');
  assert.ok(result.includes('source: deck'), 'Should include deck source');
  assert.ok(result.includes('Moltagent Docs'), 'Should include wiki title');
  assert.ok(result.includes('Moltagent Phase 2'), 'Should include deck card title');
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
    listBoards: async () => { throw new Error('Deck API 503'); },
    getAllCards: async () => { throw new Error('Deck API 503'); }
  };

  const enricher = new MemoryContextEnricher({
    memorySearcher: {
      search: async () => [
        { source: 'Wiki', title: 'Alex', excerpt: 'Contact person' }
      ]
    },
    deckClient: failingDeckClient,
    logger: silentLogger
  });

  const result = await enricher.enrich('Tell me about Alex', 'question');
  assert.ok(result !== null, 'Should still return wiki results');
  assert.ok(result.includes('Alex'), 'Wiki result should be present despite deck failure');
  assert.ok(!result.includes('source: deck'), 'No deck results should be present');
});

// ============================================================
// Multi-Board Deck Tests
// ============================================================

// -- Test 23: Multi-board fetch returns cards from all boards --
asyncTest('Multi-board: finds card on secondary board', async () => {
  const boards = [
    { id: 1, title: DECK.boards.tasks, archived: false },
    { id: 2, title: 'Client Project', archived: false }
  ];
  const deckClient = {
    listBoards: async () => boards,
    getStacks: async (boardId) => {
      if (boardId === 1) return [{ id: 1, title: 'Working', cards: [] }];
      if (boardId === 2) return [{ id: 10, title: 'To Do', cards: [
        { id: 500, title: 'Redesign landing page', description: 'New branding' }
      ] }];
      return [];
    },
    getAllCards: async () => ({})
  };

  const enricher = new MemoryContextEnricher({
    memorySearcher: { search: async () => [] },
    deckClient,
    logger: silentLogger
  });

  const result = await enricher.enrich('What about the "landing page redesign"?', 'question');
  assert.ok(result !== null, 'Should find card on secondary board');
  assert.ok(result.includes('Redesign landing page'), 'Should include card title');
  assert.ok(result.includes('Client Project'), 'Should include board name');
});

// -- Test 24: Archived boards are excluded --
asyncTest('Multi-board: archived boards are excluded', async () => {
  const boards = [
    { id: 1, title: 'Active Board', archived: false },
    { id: 2, title: 'Old Board', archived: true }
  ];
  let fetchedBoardIds = [];
  const deckClient = {
    listBoards: async () => boards,
    getStacks: async (boardId) => {
      fetchedBoardIds.push(boardId);
      return [{ id: 1, title: 'Stack', cards: [
        { id: 1, title: 'Test Card', description: '' }
      ] }];
    },
    getAllCards: async () => ({})
  };

  const enricher = new MemoryContextEnricher({
    memorySearcher: { search: async () => [] },
    deckClient,
    logger: silentLogger
  });

  await enricher.enrich('Test Card status', 'question');
  assert.ok(fetchedBoardIds.includes(1), 'Should fetch active board');
  assert.ok(!fetchedBoardIds.includes(2), 'Should NOT fetch archived board');
});

// -- Test 25: Results include board name in snippet --
asyncTest('Multi-board: search results include board name in snippet', async () => {
  const { enricher } = enricherWithDeck(
    { working: [{ id: 42, title: 'Fix API endpoint', description: 'Bug in auth' }] },
    [],
    [{ id: 1, title: 'Sprint 5', archived: false }]
  );

  const result = await enricher.enrich('What about the API endpoint fix?', 'question');
  assert.ok(result !== null);
  assert.ok(result.includes('Sprint 5'), 'Should include board name in enrichment');
});

// -- Test 26: listBoards failure falls back to getAllCards --
asyncTest('Multi-board: listBoards failure falls back to single board', async () => {
  const deckClient = {
    listBoards: async () => { throw new Error('503'); },
    getAllCards: async () => ({
      inbox: [{ id: 1, title: 'Fallback card', description: '' }]
    })
  };

  const enricher = new MemoryContextEnricher({
    memorySearcher: { search: async () => [] },
    deckClient,
    logger: silentLogger
  });

  const result = await enricher.enrich('What about the "fallback card"?', 'question');
  assert.ok(result !== null, 'Should find card via getAllCards fallback');
  assert.ok(result.includes('Fallback card'), 'Should include fallback card title');
});

// -- Board Map Tests --

asyncTest('Enricher output includes <deck_boards> when boards exist', async () => {
  const { enricher } = enricherWithDeck({
    inbox: [{ id: 1, title: 'Some card', description: 'test' }]
  });

  const result = await enricher.enrich('Show me my tasks', 'deck');
  assert.ok(result !== null, 'Should return enrichment');
  assert.ok(result.includes('<deck_boards>'), 'Should include board map section');
  assert.ok(result.includes('</deck_boards>'), 'Should close board map section');
  assert.ok(result.includes(DECK.boards.tasks), 'Should include default board name');
  assert.ok(result.includes('stacks: inbox'), 'Should include stack names');
});

asyncTest('Enricher output omits <deck_boards> when no boards', async () => {
  const enricher = new MemoryContextEnricher({
    memorySearcher: { search: async () => [] },
    deckClient: {
      listBoards: async () => [],
      getStacks: async () => [],
      getAllCards: async () => ({})
    },
    logger: silentLogger
  });

  const result = await enricher.enrich('Show me cards', 'deck');
  assert.strictEqual(result, null, 'Should return null when no boards and no matches');
});

asyncTest('Board map includes multiple boards with their stacks', async () => {
  const multiBoards = [
    { id: 12, title: 'Moltagent Tasks', archived: false },
    { id: 144, title: 'Content Pipeline - Molti', archived: false }
  ];
  const { enricher } = enricherWithDeck({}, [], multiBoards);
  // Override getStacks to return different stacks per board
  enricher.deckClient.getStacks = async (boardId) => {
    if (boardId === 12) return [{ id: 1, title: 'Inbox', cards: [] }, { id: 2, title: 'Done', cards: [] }];
    if (boardId === 144) return [{ id: 3, title: 'Ideas', cards: [] }, { id: 4, title: 'Drafting', cards: [] }];
    return [];
  };

  const result = await enricher.enrich('What boards do I have?', 'deck');
  assert.ok(result.includes('Content Pipeline - Molti'), 'Should include Content Pipeline board');
  assert.ok(result.includes('id: 144'), 'Should include board ID 144');
  assert.ok(result.includes('Ideas'), 'Should include Ideas stack');
  assert.ok(result.includes('Moltagent Tasks'), 'Should include Tasks board');
});

asyncTest('getBoardMap() pulls from cache, no fresh API calls', async () => {
  const { enricher, deckClient } = enricherWithDeck({
    inbox: [{ id: 1, title: 'Card', description: 'test' }]
  });

  // First call populates cache
  await enricher.enrich('Show me tasks', 'deck');
  const firstCount = deckClient._callCount;

  // getBoardMap should use cached state — no new listBoards call
  const map = await enricher.getBoardMap();
  assert.ok(Array.isArray(map), 'Should return array');
  assert.ok(map.length > 0, 'Should have boards');
  assert.strictEqual(deckClient._callCount, firstCount, 'getBoardMap must not trigger new API call');
});

setTimeout(() => { summary(); exitWithCode(); }, 1000);
