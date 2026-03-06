// Mock type: LEGACY — TODO: migrate to realistic mocks
/**
 * FreshnessChecker Unit Tests
 *
 * Run: node test/unit/knowledge/freshness-checker.test.js
 *
 * @module test/unit/knowledge/freshness-checker
 */

const assert = require('assert');
const { test, summary, exitWithCode } = require('../../helpers/test-runner');
const { FreshnessChecker } = require('../../../src/lib/knowledge/freshness-checker');

// ============================================================
// Helpers
// ============================================================

function createMockCollectivesClient(pages = [], pageData = {}) {
  return {
    resolveCollective: async () => 10,
    listPages: async () => pages,
    readPageWithFrontmatter: async (title) => pageData[title] || null
  };
}

function createMockKnowledgeBoard(existingStaleCards = []) {
  const createdCards = [];
  return {
    deck: {
      getCardsInStack: async (stack) => {
        if (stack === 'stale') return existingStaleCards;
        return [];
      },
      createCard: async (stack, data) => {
        const card = { id: 100 + createdCards.length, ...data, stack };
        createdCards.push(card);
        return card;
      }
    },
    _createdCards: createdCards
  };
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

// ============================================================
// Tests
// ============================================================

console.log('FreshnessChecker Unit Tests\n');

// -- checkAll tests --

test('checkAll() scans pages and identifies stale ones', async () => {
  const pages = [
    { id: 1, title: 'People', parentId: 0 },
    { id: 2, title: 'John Smith', parentId: 1 },
    { id: 3, title: 'Jane Doe', parentId: 1 }
  ];
  const pageData = {
    'John Smith': { frontmatter: { last_verified: daysAgo(100), decay_days: 90 }, body: '# John' },
    'Jane Doe': { frontmatter: { last_verified: daysAgo(10), decay_days: 90 }, body: '# Jane' }
  };

  const checker = new FreshnessChecker({
    collectivesClient: createMockCollectivesClient(pages, pageData),
    knowledgeBoard: createMockKnowledgeBoard(),
    config: { defaultDecayDays: 90 }
  });

  const result = await checker.checkAll();
  assert.strictEqual(result.scanned, 2); // Only non-root pages
  assert.strictEqual(result.stale, 1);   // Only John is stale
  assert.strictEqual(result.cards.length, 1);
});

test('checkAll() skips root section pages (parentId = 0)', async () => {
  const pages = [
    { id: 1, title: 'People', parentId: 0 },
    { id: 2, title: 'Projects', parentId: 0 }
  ];

  const checker = new FreshnessChecker({
    collectivesClient: createMockCollectivesClient(pages, {}),
    knowledgeBoard: createMockKnowledgeBoard()
  });

  const result = await checker.checkAll();
  assert.strictEqual(result.scanned, 0);
  assert.strictEqual(result.stale, 0);
});

test('checkAll() respects maxPagesPerScan cap', async () => {
  const pages = [];
  const pageData = {};
  for (let i = 0; i < 30; i++) {
    pages.push({ id: i + 10, title: `Page ${i}`, parentId: 1 });
    pageData[`Page ${i}`] = { frontmatter: { last_verified: daysAgo(10), decay_days: 90 }, body: '' };
  }

  const checker = new FreshnessChecker({
    collectivesClient: createMockCollectivesClient(pages, pageData),
    knowledgeBoard: createMockKnowledgeBoard(),
    config: { maxPagesPerScan: 5 }
  });

  const result = await checker.checkAll();
  assert.strictEqual(result.scanned, 5);
});

test('checkAll() handles empty wiki (no pages)', async () => {
  const checker = new FreshnessChecker({
    collectivesClient: createMockCollectivesClient([], {}),
    knowledgeBoard: createMockKnowledgeBoard()
  });

  const result = await checker.checkAll();
  assert.strictEqual(result.scanned, 0);
  assert.strictEqual(result.stale, 0);
  assert.deepStrictEqual(result.cards, []);
});

test('checkAll() handles missing collectivesClient', async () => {
  const checker = new FreshnessChecker({
    collectivesClient: null,
    knowledgeBoard: createMockKnowledgeBoard()
  });

  const result = await checker.checkAll();
  assert.strictEqual(result.scanned, 0);
  assert.strictEqual(result.stale, 0);
});

test('checkAll() handles CollectivesClient errors gracefully', async () => {
  const badClient = {
    resolveCollective: async () => { throw new Error('Network error'); },
    listPages: async () => [],
    readPageWithFrontmatter: async () => null
  };

  const checker = new FreshnessChecker({
    collectivesClient: badClient,
    knowledgeBoard: createMockKnowledgeBoard()
  });

  await assert.rejects(() => checker.checkAll(), /Network error/);
});

// -- _isStale tests --

test('_isStale() returns true when last_verified + decay_days < now', () => {
  const checker = new FreshnessChecker({
    collectivesClient: null,
    knowledgeBoard: null,
    config: { defaultDecayDays: 90 }
  });

  const result = checker._isStale({ last_verified: daysAgo(100), decay_days: 90 });
  assert.strictEqual(result.stale, true);
  assert.ok(result.daysSinceVerified >= 100);
  assert.strictEqual(result.decayDays, 90);
});

test('_isStale() returns false for recently verified pages', () => {
  const checker = new FreshnessChecker({
    collectivesClient: null,
    knowledgeBoard: null,
    config: { defaultDecayDays: 90 }
  });

  const result = checker._isStale({ last_verified: daysAgo(10), decay_days: 90 });
  assert.strictEqual(result.stale, false);
  assert.ok(result.daysSinceVerified >= 10);
});

test('_isStale() returns true when last_verified is missing', () => {
  const checker = new FreshnessChecker({
    collectivesClient: null,
    knowledgeBoard: null,
    config: { defaultDecayDays: 90 }
  });

  const result = checker._isStale({});
  assert.strictEqual(result.stale, true);
  assert.strictEqual(result.daysSinceVerified, Infinity);
});

test('_isStale() uses defaultDecayDays when frontmatter omits decay_days', () => {
  const checker = new FreshnessChecker({
    collectivesClient: null,
    knowledgeBoard: null,
    config: { defaultDecayDays: 30 }
  });

  const result = checker._isStale({ last_verified: daysAgo(40) });
  assert.strictEqual(result.stale, true);
  assert.strictEqual(result.decayDays, 30);
});

// -- Card creation tests --

test('creates KnowledgeBoard card for stale pages', async () => {
  const pages = [
    { id: 2, title: 'Old Page', parentId: 1 }
  ];
  const pageData = {
    'Old Page': { frontmatter: { last_verified: daysAgo(100), decay_days: 30, type: 'research' }, body: '' }
  };
  const board = createMockKnowledgeBoard();

  const checker = new FreshnessChecker({
    collectivesClient: createMockCollectivesClient(pages, pageData),
    knowledgeBoard: board
  });

  const result = await checker.checkAll();
  assert.strictEqual(result.cards.length, 1);
  assert.ok(board._createdCards[0].title.startsWith('Stale: '));
});

test('does not create duplicate cards', async () => {
  const pages = [
    { id: 2, title: 'Old Page', parentId: 1 }
  ];
  const pageData = {
    'Old Page': { frontmatter: { last_verified: daysAgo(100), decay_days: 30 }, body: '' }
  };
  const existingCards = [{ id: 50, title: 'Stale: Old Page' }];
  const board = createMockKnowledgeBoard(existingCards);

  const checker = new FreshnessChecker({
    collectivesClient: createMockCollectivesClient(pages, pageData),
    knowledgeBoard: board
  });

  const result = await checker.checkAll();
  assert.strictEqual(result.stale, 1);
  assert.strictEqual(result.cards.length, 0); // Card not created (duplicate)
  assert.strictEqual(board._createdCards.length, 0);
});

test('returns correct scan summary', async () => {
  const pages = [
    { id: 1, title: 'Section', parentId: 0 },
    { id: 2, title: 'Fresh', parentId: 1 },
    { id: 3, title: 'Stale1', parentId: 1 },
    { id: 4, title: 'Stale2', parentId: 1 }
  ];
  const pageData = {
    'Fresh': { frontmatter: { last_verified: daysAgo(5), decay_days: 90 }, body: '' },
    'Stale1': { frontmatter: { last_verified: daysAgo(100), decay_days: 90 }, body: '' },
    'Stale2': { frontmatter: {}, body: '' }
  };

  const checker = new FreshnessChecker({
    collectivesClient: createMockCollectivesClient(pages, pageData),
    knowledgeBoard: createMockKnowledgeBoard()
  });

  const result = await checker.checkAll();
  assert.strictEqual(result.scanned, 3);
  assert.strictEqual(result.stale, 2);
  assert.strictEqual(result.cards.length, 2);
});

// -- Phase 2 Tests: Access-refreshes-freshness feedback loop --

test('_isStale() respects last_accessed — recently accessed page is NOT stale', () => {
  const checker = new FreshnessChecker({
    collectivesClient: createMockCollectivesClient(),
    knowledgeBoard: createMockKnowledgeBoard()
  });

  // last_verified is 120 days ago (past 90-day default) but last_accessed is yesterday
  const result = checker._isStale({
    last_verified: new Date(Date.now() - 120 * 86400000).toISOString().split('T')[0],
    last_accessed: new Date(Date.now() - 1 * 86400000).toISOString(),
    decay_days: 90
  });

  assert.strictEqual(result.stale, false, 'Page recently accessed should NOT be stale');
  assert.ok(result.daysSinceVerified < 90, 'daysSinceVerified should reflect most recent touch');
});

test('_isStale() identifies pages past decay_days with no recent access', () => {
  const checker = new FreshnessChecker({
    collectivesClient: createMockCollectivesClient(),
    knowledgeBoard: createMockKnowledgeBoard()
  });

  const result = checker._isStale({
    last_verified: new Date(Date.now() - 100 * 86400000).toISOString().split('T')[0],
    decay_days: 90
  });

  assert.strictEqual(result.stale, true, 'Page verified 100 days ago with no access should be stale');
  assert.ok(result.daysSinceVerified >= 90, `Expected >= 90, got ${result.daysSinceVerified}`);
});

test('Recently accessed pages are protected from decay even if never verified', () => {
  const checker = new FreshnessChecker({
    collectivesClient: createMockCollectivesClient(),
    knowledgeBoard: createMockKnowledgeBoard()
  });

  // No last_verified at all, but last_accessed is today
  const result = checker._isStale({
    last_accessed: new Date().toISOString(),
    decay_days: 90
  });

  assert.strictEqual(result.stale, false, 'Page accessed today should not be stale even without last_verified');
});

test('Old access does not protect from decay', () => {
  const checker = new FreshnessChecker({
    collectivesClient: createMockCollectivesClient(),
    knowledgeBoard: createMockKnowledgeBoard()
  });

  // Both last_verified and last_accessed are past decay threshold
  const result = checker._isStale({
    last_verified: new Date(Date.now() - 100 * 86400000).toISOString().split('T')[0],
    last_accessed: new Date(Date.now() - 95 * 86400000).toISOString(),
    decay_days: 90
  });

  assert.strictEqual(result.stale, true, 'Page with old access should still be stale');
});

// -- Summary --
summary();
exitWithCode();
