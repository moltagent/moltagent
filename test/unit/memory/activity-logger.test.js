'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const { ActivityLogger } = require('../../../src/lib/memory/activity-logger');

const silentLogger = { log() {}, info() {}, warn() {}, error() {} };

function createMockWikiClient() {
  const pages = {};
  return {
    readPageContent: async (pageName) => {
      if (pages[pageName]) return pages[pageName];
      throw new Error('404 Not Found');
    },
    writePageContent: async (pageName, content) => {
      pages[pageName] = content;
    },
    getPages: () => pages
  };
}

// -- Test 1: append() adds entry to buffer --
test('append() adds entry to buffer', () => {
  const logger = new ActivityLogger({
    wikiClient: createMockWikiClient(),
    logger: silentLogger
  });
  logger.append({ action: 'calendar_create', summary: 'Created event Test' });
  assert.strictEqual(logger.getBufferSize(), 1);
  assert.strictEqual(logger.getUnprocessedEntries().length, 1);
  assert.strictEqual(logger.getUnprocessedEntries()[0].action, 'calendar_create');
});

// -- Test 2: append() auto-flushes at 10 entries --
asyncTest('append() auto-flushes at 10 entries', async () => {
  const wiki = createMockWikiClient();
  const logger = new ActivityLogger({ wikiClient: wiki, logger: silentLogger });
  // Set lastFlush far in the future so only count triggers flush
  logger._lastFlush = Date.now() + 999999;

  for (let i = 0; i < 10; i++) {
    logger.append({ action: `action_${i}`, summary: `Summary ${i}` });
  }

  // Give async flush a moment
  await new Promise(r => setTimeout(r, 50));

  const today = new Date().toISOString().slice(0, 10);
  const pageName = `Meta/Activity Log ${today}`;
  assert.ok(wiki.getPages()[pageName], 'Should have flushed to wiki page');
  assert.ok(wiki.getPages()[pageName].includes('action_0'), 'Should contain first entry');
});

// -- Test 3: append() auto-flushes after 60 seconds --
asyncTest('append() auto-flushes when time interval exceeded', async () => {
  const wiki = createMockWikiClient();
  const logger = new ActivityLogger({ wikiClient: wiki, logger: silentLogger });
  // Set lastFlush to long ago
  logger._lastFlush = Date.now() - 120000;

  logger.append({ action: 'test', summary: 'Time-triggered flush' });

  await new Promise(r => setTimeout(r, 50));

  const today = new Date().toISOString().slice(0, 10);
  const pageName = `Meta/Activity Log ${today}`;
  assert.ok(wiki.getPages()[pageName], 'Should have flushed due to time interval');
});

// -- Test 4: flush() writes to wiki with correct page name --
asyncTest('flush() writes to wiki with correct page name', async () => {
  const wiki = createMockWikiClient();
  const logger = new ActivityLogger({ wikiClient: wiki, logger: silentLogger });
  logger._buffer.push({
    time: '14:30', action: 'test_action', summary: 'Test summary',
    user: 'alice', room: 'r1', processed: false
  });

  await logger.flush();

  const today = new Date().toISOString().slice(0, 10);
  const pageName = `Meta/Activity Log ${today}`;
  assert.ok(wiki.getPages()[pageName]);
  assert.ok(wiki.getPages()[pageName].includes('test_action'));
  assert.ok(wiki.getPages()[pageName].includes('Test summary'));
  assert.strictEqual(logger.getTodayPageName(), pageName);
});

// -- Test 5: flush() creates page with header if it doesn't exist --
asyncTest('flush() creates page with header if new', async () => {
  const wiki = createMockWikiClient();
  const logger = new ActivityLogger({ wikiClient: wiki, logger: silentLogger });
  logger._buffer.push({
    time: '10:00', action: 'create', summary: 'First entry',
    user: 'bob', room: 'r2', processed: false
  });

  await logger.flush();

  const today = new Date().toISOString().slice(0, 10);
  const content = wiki.getPages()[`Meta/Activity Log ${today}`];
  assert.ok(content.includes('# Activity Log'), 'Should have header');
  assert.ok(content.includes('| Time | Action | Summary | User |'), 'Should have table header');
});

// -- Test 6: flush() appends to existing page --
asyncTest('flush() appends to existing page (does not overwrite)', async () => {
  const wiki = createMockWikiClient();
  const today = new Date().toISOString().slice(0, 10);
  const pageName = `Meta/Activity Log ${today}`;
  // Pre-populate existing page
  wiki.getPages()[pageName] = '# Existing Content\n| 09:00 | old | Old entry | user |\n';

  const logger = new ActivityLogger({ wikiClient: wiki, logger: silentLogger });
  logger._buffer.push({
    time: '15:00', action: 'new_action', summary: 'New entry',
    user: 'alice', room: 'r1', processed: false
  });

  await logger.flush();

  const content = wiki.getPages()[pageName];
  assert.ok(content.includes('Existing Content'), 'Should keep existing content');
  assert.ok(content.includes('old'), 'Should keep old entries');
  assert.ok(content.includes('new_action'), 'Should append new entry');
});

// -- Test 7: getUnprocessedEntries() returns only unprocessed --
test('getUnprocessedEntries() returns only unprocessed', () => {
  const logger = new ActivityLogger({
    wikiClient: createMockWikiClient(),
    logger: silentLogger
  });
  logger._buffer = [
    { action: 'a', processed: false },
    { action: 'b', processed: true },
    { action: 'c', processed: false }
  ];
  const unprocessed = logger.getUnprocessedEntries();
  assert.strictEqual(unprocessed.length, 2);
  assert.strictEqual(unprocessed[0].action, 'a');
  assert.strictEqual(unprocessed[1].action, 'c');
});

// -- Test 8: markProcessed() marks correct count and prunes --
test('markProcessed() marks correct count and prunes old entries', () => {
  const logger = new ActivityLogger({
    wikiClient: createMockWikiClient(),
    logger: silentLogger
  });
  // Fill buffer with 130 entries (above prune threshold)
  for (let i = 0; i < 130; i++) {
    logger._buffer.push({ action: `a${i}`, processed: false });
  }

  logger.markProcessed(100);

  const processedCount = logger._buffer.filter(e => e.processed).length;
  assert.ok(processedCount > 0, 'Some entries should be marked processed');
  // After pruning: unprocessed (30) + last 20 processed = 50
  assert.ok(logger._buffer.length <= 120, `Buffer should be pruned, got ${logger._buffer.length}`);
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
