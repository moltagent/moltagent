'use strict';

/**
 * Unit Tests for HeartbeatExtractor — Biological Frontmatter Initialization
 *
 * Tests that new wiki pages created by HeartbeatExtractor include proper
 * frontmatter with biological memory fields.
 *
 * Run: node test/unit/memory/heartbeat-extractor-init.test.js
 */

const assert = require('assert');
const { asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const { HeartbeatExtractor } = require('../../../src/lib/memory/heartbeat-extractor');
const { parseFrontmatter } = require('../../../src/lib/knowledge/frontmatter');

const silentLogger = { log() {}, info() {}, warn() {}, error() {} };

function createMockActivityLogger(entries) {
  return {
    flush: async () => {},
    getUnprocessedEntries: () => entries,
    markProcessed: () => {},
  };
}

function createMockWikiClient() {
  const pages = {};
  return {
    readPageContent: async (pageName) => {
      if (pages[pageName]) return pages[pageName];
      throw new Error('404');
    },
    writePageContent: async (pageName, content) => {
      pages[pageName] = content;
    },
    getPages: () => pages,
  };
}

function createMockRouter(result) {
  return {
    route: async () => ({ result: result || '{"nothing": true}' }),
  };
}

function makeEntries(count) {
  const entries = [];
  for (let i = 0; i < count; i++) {
    entries.push({
      time: `10:${String(i).padStart(2, '0')}`,
      action: `action_${i}`,
      summary: `Summary ${i}`,
      user: 'alice',
      processed: false,
    });
  }
  return entries;
}

// -----------------------------------------------------------------------
// New pages include biological frontmatter
// -----------------------------------------------------------------------

asyncTest('New people page includes access_count: 0 and confidence: medium', async () => {
  const wiki = createMockWikiClient();
  const extractor = new HeartbeatExtractor({
    activityLogger: createMockActivityLogger(makeEntries(5)),
    wikiClient: wiki,
    llmRouter: createMockRouter(JSON.stringify({
      people: [{ name: 'Alice', fact: 'Works at Acme Corp' }],
    })),
    logger: silentLogger,
  });
  extractor._lastExtraction = 0;

  await extractor.tick();

  const content = wiki.getPages()['People/Alice'];
  assert.ok(content, 'Should create People/Alice page');

  const { frontmatter } = parseFrontmatter(content);
  assert.strictEqual(frontmatter.access_count, 0, 'Should have access_count: 0');
  assert.strictEqual(frontmatter.confidence, 'medium', 'Should have confidence: medium');
  assert.strictEqual(frontmatter.type, 'person', 'Should have type: person');
  assert.ok(frontmatter.created, 'Should have created date');
  assert.ok(frontmatter.last_updated, 'Should have last_updated date');
});

asyncTest('New people page gets decay_days: 90 (person default)', async () => {
  const wiki = createMockWikiClient();
  const extractor = new HeartbeatExtractor({
    activityLogger: createMockActivityLogger(makeEntries(5)),
    wikiClient: wiki,
    llmRouter: createMockRouter(JSON.stringify({
      people: [{ name: 'Bob', fact: 'Is the CEO' }],
    })),
    logger: silentLogger,
  });
  extractor._lastExtraction = 0;

  await extractor.tick();

  const { frontmatter } = parseFrontmatter(wiki.getPages()['People/Bob']);
  assert.strictEqual(frontmatter.decay_days, 90, 'Person pages should decay at 90 days');
});

asyncTest('New decision page gets decay_days: 180', async () => {
  const wiki = createMockWikiClient();
  const extractor = new HeartbeatExtractor({
    activityLogger: createMockActivityLogger(makeEntries(5)),
    wikiClient: wiki,
    llmRouter: createMockRouter(JSON.stringify({
      decisions: [{ topic: 'Migration Plan', decision: 'Use PostgreSQL' }],
    })),
    logger: silentLogger,
  });
  extractor._lastExtraction = 0;

  await extractor.tick();

  const { frontmatter } = parseFrontmatter(wiki.getPages()['Decisions Index']);
  assert.strictEqual(frontmatter.decay_days, 180, 'Decision pages should decay at 180 days');
  assert.strictEqual(frontmatter.type, 'decision');
});

asyncTest('New gap page gets decay_days: 30', async () => {
  const wiki = createMockWikiClient();
  const extractor = new HeartbeatExtractor({
    activityLogger: createMockActivityLogger(makeEntries(5)),
    wikiClient: wiki,
    llmRouter: createMockRouter(JSON.stringify({
      gaps: [{ topic: 'Project Aurora', context: 'User asked, nothing found' }],
    })),
    logger: silentLogger,
  });
  extractor._lastExtraction = 0;

  await extractor.tick();

  const { frontmatter } = parseFrontmatter(wiki.getPages()['Meta/Pending Questions']);
  assert.strictEqual(frontmatter.decay_days, 30, 'Gap pages should decay at 30 days');
  assert.strictEqual(frontmatter.type, 'gap');
});

asyncTest('New preference page gets decay_days: 365', async () => {
  const wiki = createMockWikiClient();
  const extractor = new HeartbeatExtractor({
    activityLogger: createMockActivityLogger(makeEntries(5)),
    wikiClient: wiki,
    llmRouter: createMockRouter(JSON.stringify({
      preferences: [{ who: '', preference: 'Dark mode everywhere' }],
    })),
    logger: silentLogger,
  });
  extractor._lastExtraction = 0;

  await extractor.tick();

  const { frontmatter } = parseFrontmatter(wiki.getPages()['General/Preferences']);
  assert.strictEqual(frontmatter.decay_days, 365, 'Preference pages should decay at 365 days');
  assert.strictEqual(frontmatter.type, 'preference');
});

asyncTest('Appending to existing page does NOT overwrite frontmatter', async () => {
  const wiki = createMockWikiClient();
  // Pre-create a page with existing content (no frontmatter, like legacy pages)
  wiki.getPages()['People/Carlos'] = '# Carlos\n\n- Existing fact\n';

  const extractor = new HeartbeatExtractor({
    activityLogger: createMockActivityLogger(makeEntries(5)),
    wikiClient: {
      readPageContent: async (name) => wiki.getPages()[name] || (() => { throw new Error('404'); })(),
      writePageContent: async (name, content) => { wiki.getPages()[name] = content; },
    },
    llmRouter: createMockRouter(JSON.stringify({
      people: [{ name: 'Carlos', fact: 'VP of Marketing' }],
    })),
    logger: silentLogger,
  });
  extractor._lastExtraction = 0;

  await extractor.tick();

  const content = wiki.getPages()['People/Carlos'];
  assert.ok(content.includes('Existing fact'), 'Should preserve existing content');
  assert.ok(content.includes('VP of Marketing'), 'Should append new fact');
  // Should NOT have frontmatter since page already existed
  assert.ok(!content.startsWith('---'), 'Should not add frontmatter to existing page');
});

// -----------------------------------------------------------------------
// _defaultDecayForType
// -----------------------------------------------------------------------

asyncTest('_defaultDecayForType returns correct defaults', async () => {
  const extractor = new HeartbeatExtractor({
    activityLogger: createMockActivityLogger([]),
    wikiClient: createMockWikiClient(),
    llmRouter: createMockRouter(),
    logger: silentLogger,
  });

  assert.strictEqual(extractor._defaultDecayForType('person'), 90);
  assert.strictEqual(extractor._defaultDecayForType('decision'), 180);
  assert.strictEqual(extractor._defaultDecayForType('preference'), 365);
  assert.strictEqual(extractor._defaultDecayForType('project'), 60);
  assert.strictEqual(extractor._defaultDecayForType('procedure'), 180);
  assert.strictEqual(extractor._defaultDecayForType('gap'), 30);
  assert.strictEqual(extractor._defaultDecayForType('unknown_type'), 90, 'Unknown types default to 90');
  assert.strictEqual(extractor._defaultDecayForType(undefined), 90, 'Undefined defaults to 90');
});

setTimeout(() => { summary(); exitWithCode(); }, 600);
