'use strict';
// Mock type: LEGACY — TODO: migrate to realistic mocks

/**
 * Unit Tests for FreshnessChecker — Biological Triage
 *
 * Tests three-outcome decay: strengthen, compost, verify.
 * Tests _mostRecent effective-age calculation and core memory protection.
 *
 * Run: node test/unit/integrations/freshness-biological.test.js
 */

const assert = require('assert');
const { asyncTest, test, summary, exitWithCode } = require('../../helpers/test-runner');
const { FreshnessChecker } = require('../../../src/lib/integrations/heartbeat-intelligence');
const { serializeFrontmatter } = require('../../../src/lib/knowledge/frontmatter');

const silentNotify = async () => {};

function daysAgoISO(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

function makePage(id, title, frontmatter, body) {
  const content = serializeFrontmatter(frontmatter, body || `# ${title}\n\nSome content here.`);
  return { id, title, content, frontmatter };
}

function createMockCollectivesClient(pageList) {
  const writes = [];
  return {
    resolveCollective: async () => 10,
    listPages: async () => pageList.map(p => ({
      id: p.id,
      title: p.title,
      fileName: `${p.title}.md`,
    })),
    readPageContent: async (pagePath) => {
      const title = pagePath.replace('.md', '');
      const page = pageList.find(p => p.title === title);
      return page ? page.content : null;
    },
    readPageWithFrontmatter: async (title) => {
      const page = pageList.find(p => p.title === title);
      if (!page) return null;
      return { frontmatter: { ...page.frontmatter }, body: page.content.replace(/^---[\s\S]*?---\n/, '') };
    },
    writePageWithFrontmatter: async (title, fm, body) => {
      writes.push({ title, frontmatter: fm, body });
      // Update in-place for subsequent reads
      const page = pageList.find(p => p.title === title);
      if (page) {
        page.frontmatter = fm;
        page.content = serializeFrontmatter(fm, body);
      }
    },
    getWrites: () => writes,
  };
}

function createMockDeckClient(existingCards = []) {
  const created = [];
  return {
    getCardsInStack: async () => existingCards,
    createCard: async (stack, data) => { created.push({ stack, ...data }); },
    getCreated: () => created,
  };
}

// -----------------------------------------------------------------------
// _mostRecent
// -----------------------------------------------------------------------

test('_mostRecent returns the most recent of multiple dates', () => {
  const checker = new FreshnessChecker({
    collectivesClient: { resolveCollective: async () => 10, listPages: async () => [] },
    deckClient: createMockDeckClient(),
    notifyUser: silentNotify,
  });

  const result = checker._mostRecent(
    daysAgoISO(100),
    daysAgoISO(2),
    daysAgoISO(50)
  );
  // 2 days ago is most recent
  const daysDiff = Math.floor((Date.now() - result.getTime()) / 86400000);
  assert.ok(daysDiff <= 2, `Expected ~2 days ago, got ${daysDiff}`);
});

test('_mostRecent returns null when all inputs are null/undefined', () => {
  const checker = new FreshnessChecker({
    collectivesClient: { resolveCollective: async () => 10, listPages: async () => [] },
    deckClient: createMockDeckClient(),
    notifyUser: silentNotify,
  });

  const result = checker._mostRecent(null, undefined, '');
  assert.strictEqual(result, null);
});

test('_mostRecent skips invalid date strings', () => {
  const checker = new FreshnessChecker({
    collectivesClient: { resolveCollective: async () => 10, listPages: async () => [] },
    deckClient: createMockDeckClient(),
    notifyUser: silentNotify,
  });

  const validDate = daysAgoISO(5);
  const result = checker._mostRecent('not-a-date', validDate, 'also invalid');
  assert.ok(result instanceof Date, 'Should return the valid date');
});

// -----------------------------------------------------------------------
// Core memory protection (decay_days: -1)
// -----------------------------------------------------------------------

asyncTest('Core memory (decay_days: -1) is never checked', async () => {
  const pages = [
    makePage(1, 'Owner Name', {
      type: 'person', decay_days: -1, last_updated: daysAgoISO(500), confidence: 'high',
    }),
  ];
  const wiki = createMockCollectivesClient(pages);
  const deck = createMockDeckClient();

  const checker = new FreshnessChecker({
    collectivesClient: wiki,
    deckClient: deck,
    notifyUser: silentNotify,
  });

  const result = await checker.checkAll();
  assert.strictEqual(result.flagged, 0, 'Should not flag core memory');
  assert.strictEqual(result.composted, 0, 'Should not compost core memory');
  assert.strictEqual(result.strengthened, 0, 'Should not strengthen core memory');
});

// -----------------------------------------------------------------------
// Already-archived pages skipped
// -----------------------------------------------------------------------

asyncTest('Already-archived pages (type: archive) are skipped', async () => {
  const pages = [
    makePage(1, 'Old Fact', {
      type: 'archive', decay_days: 90, last_updated: daysAgoISO(200), confidence: 'low',
    }),
  ];
  const wiki = createMockCollectivesClient(pages);
  const checker = new FreshnessChecker({
    collectivesClient: wiki,
    deckClient: createMockDeckClient(),
    notifyUser: silentNotify,
  });

  const result = await checker.checkAll();
  assert.strictEqual(result.flagged, 0);
  assert.strictEqual(result.composted, 0);
  assert.strictEqual(result.strengthened, 0);
});

// -----------------------------------------------------------------------
// Outcome 1: COMPOST
// -----------------------------------------------------------------------

asyncTest('Composts page: never accessed + past decay + low confidence', async () => {
  const pages = [
    makePage(1, 'Dead Fact', {
      type: 'research', decay_days: 30, last_updated: daysAgoISO(60),
      confidence: 'low', access_count: 0,
    }, '# Dead Fact\n\nThis fact is no longer useful. Extra content here.'),
  ];
  const wiki = createMockCollectivesClient(pages);
  const checker = new FreshnessChecker({
    collectivesClient: wiki,
    deckClient: createMockDeckClient(),
    notifyUser: silentNotify,
  });

  const result = await checker.checkAll();
  assert.strictEqual(result.composted, 1, 'Should compost one page');
  assert.strictEqual(result.flagged, 0, 'Should not flag (composted instead)');

  const write = wiki.getWrites()[0];
  assert.ok(write, 'Should have written archive content');
  assert.strictEqual(write.frontmatter.type, 'archive', 'Should set type to archive');
  assert.strictEqual(write.frontmatter.original_type, 'research');
  assert.strictEqual(write.frontmatter.reason, 'unused_past_decay');
  assert.ok(write.body.includes('Archived'), 'Archive body should mention Archived');
});

// -----------------------------------------------------------------------
// Outcome 2: STRENGTHEN
// -----------------------------------------------------------------------

asyncTest('Strengthens page: accessed within 30 days but content past decay', async () => {
  // decay_days: 90, last_updated: 100 days ago → content age 100 > 90 (past decay)
  // but last_accessed: 5 days ago → _daysSince(last_accessed) = 5 < 30 → strengthen
  // Key: effective age is based on content dates (last_verified/last_updated), not access
  const pages = [
    makePage(1, 'Active Fact', {
      type: 'decision', decay_days: 90, last_updated: daysAgoISO(100),
      last_accessed: daysAgoISO(5), access_count: 8, confidence: 'medium',
    }),
  ];
  const wiki = createMockCollectivesClient(pages);
  const checker = new FreshnessChecker({
    collectivesClient: wiki,
    deckClient: createMockDeckClient(),
    notifyUser: silentNotify,
  });

  const result = await checker.checkAll();
  assert.strictEqual(result.strengthened, 1, 'Should strengthen one page');
  assert.strictEqual(result.flagged, 0, 'Should not flag (strengthened instead)');

  const write = wiki.getWrites()[0];
  assert.ok(write.frontmatter.last_verified, 'Should set last_verified');
  assert.strictEqual(write.frontmatter.verified_by, 'system:usage_pattern');
  assert.strictEqual(write.frontmatter.confidence, 'high', 'Should boost confidence (8 >= 5 accesses)');
});

asyncTest('Strengthen does NOT boost confidence below 5 accesses', async () => {
  const pages = [
    makePage(1, 'Low Use', {
      type: 'decision', decay_days: 90, last_updated: daysAgoISO(100),
      last_accessed: daysAgoISO(10), access_count: 3, confidence: 'medium',
    }),
  ];
  const wiki = createMockCollectivesClient(pages);
  const checker = new FreshnessChecker({
    collectivesClient: wiki,
    deckClient: createMockDeckClient(),
    notifyUser: silentNotify,
  });

  const result = await checker.checkAll();
  assert.strictEqual(result.strengthened, 1);

  const write = wiki.getWrites()[0];
  assert.strictEqual(write.frontmatter.confidence, 'medium', 'Should not boost with < 5 accesses');
});

// -----------------------------------------------------------------------
// Outcome 3: VERIFY
// -----------------------------------------------------------------------

asyncTest('Flags page for verification: past decay, accessed but not recently', async () => {
  const pages = [
    makePage(1, 'Stale Fact', {
      type: 'person', decay_days: 30, last_updated: daysAgoISO(60),
      last_accessed: daysAgoISO(45), access_count: 5, confidence: 'medium',
    }),
  ];
  const wiki = createMockCollectivesClient(pages);
  const deck = createMockDeckClient();
  const checker = new FreshnessChecker({
    collectivesClient: wiki,
    deckClient: deck,
    notifyUser: silentNotify,
  });

  const result = await checker.checkAll();
  assert.strictEqual(result.flagged, 1, 'Should flag one page');
  assert.strictEqual(result.composted, 0);
  assert.strictEqual(result.strengthened, 0);

  // Should create Deck card
  assert.strictEqual(deck.getCreated().length, 1);
  assert.ok(deck.getCreated()[0].title.includes('Verify:'));

  // Should set needs_verification in frontmatter
  const fmWrite = wiki.getWrites().find(w => w.title === 'Stale Fact');
  assert.ok(fmWrite, 'Should write updated frontmatter');
  assert.strictEqual(fmWrite.frontmatter.needs_verification, true);
  // Confidence should be downgraded
  assert.strictEqual(fmWrite.frontmatter.confidence, 'low', 'Should downgrade confidence from medium to low');
});

asyncTest('Verify skips duplicate Deck cards', async () => {
  const pages = [
    makePage(1, 'Already Flagged', {
      type: 'person', decay_days: 30, last_updated: daysAgoISO(60),
      last_accessed: daysAgoISO(45), access_count: 2, confidence: 'medium',
    }),
  ];
  const wiki = createMockCollectivesClient(pages);
  const deck = createMockDeckClient([{ title: 'Verify: Already Flagged' }]);
  const checker = new FreshnessChecker({
    collectivesClient: wiki,
    deckClient: deck,
    notifyUser: silentNotify,
  });

  const result = await checker.checkAll();
  assert.strictEqual(deck.getCreated().length, 0, 'Should not create duplicate card');
});

// -----------------------------------------------------------------------
// Effective age uses MAX(last_verified, last_accessed, last_updated)
// -----------------------------------------------------------------------

asyncTest('Recently accessed page with old content is strengthened (not flagged)', async () => {
  // Content age based on last_verified (100 days) > decay_days 30 → past decay
  // But last_accessed: 1 day ago → within 30 days → STRENGTHEN (not verify)
  const pages = [
    makePage(1, 'Recently Used', {
      type: 'person', decay_days: 30,
      last_updated: daysAgoISO(200),
      last_verified: daysAgoISO(100),
      last_accessed: daysAgoISO(1),
      access_count: 10, confidence: 'high',
    }),
  ];
  const wiki = createMockCollectivesClient(pages);
  const checker = new FreshnessChecker({
    collectivesClient: wiki,
    deckClient: createMockDeckClient(),
    notifyUser: silentNotify,
  });

  const result = await checker.checkAll();
  assert.strictEqual(result.strengthened, 1, 'Should strengthen recently-accessed page');
  assert.strictEqual(result.flagged, 0, 'Should not flag');
  assert.strictEqual(result.composted, 0, 'Should not compost');
});

// -----------------------------------------------------------------------
// Summary notification
// -----------------------------------------------------------------------

asyncTest('checkAll sends summary notification with all outcomes', async () => {
  const pages = [
    makePage(1, 'Compost Me', {
      type: 'research', decay_days: 30, last_updated: daysAgoISO(60),
      confidence: 'low', access_count: 0,
    }),
    makePage(2, 'Strengthen Me', {
      type: 'decision', decay_days: 90, last_updated: daysAgoISO(100),
      last_accessed: daysAgoISO(10), access_count: 6, confidence: 'medium',
    }),
    makePage(3, 'Verify Me', {
      type: 'person', decay_days: 30, last_updated: daysAgoISO(60),
      last_accessed: daysAgoISO(45), access_count: 2, confidence: 'medium',
    }),
  ];

  let notificationMsg = '';
  const checker = new FreshnessChecker({
    collectivesClient: createMockCollectivesClient(pages),
    deckClient: createMockDeckClient(),
    notifyUser: async (msg) => { notificationMsg = msg.message; },
  });

  const result = await checker.checkAll();
  assert.strictEqual(result.composted, 1);
  assert.strictEqual(result.strengthened, 1);
  assert.strictEqual(result.flagged, 1);
  assert.ok(notificationMsg.includes('reinforced'), 'Should mention reinforced');
  assert.ok(notificationMsg.includes('verification'), 'Should mention verification');
  assert.ok(notificationMsg.includes('archived'), 'Should mention archived');
});

setTimeout(() => { summary(); exitWithCode(); }, 600);
