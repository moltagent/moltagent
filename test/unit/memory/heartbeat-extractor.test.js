'use strict';

const assert = require('assert');
const { asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const { HeartbeatExtractor } = require('../../../src/lib/memory/heartbeat-extractor');

const silentLogger = { log() {}, info() {}, warn() {}, error() {} };

function createMockActivityLogger(entries) {
  const _entries = entries || [];
  let processedCount = 0;
  return {
    flush: async () => {},
    getUnprocessedEntries: () => _entries.filter(e => !e.processed),
    markProcessed: (count) => { processedCount = count; },
    getProcessedCount: () => processedCount
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
    getPages: () => pages
  };
}

function createMockRouter(result) {
  return {
    route: async () => ({ result: result || '{"nothing": true}' })
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
      processed: false
    });
  }
  return entries;
}

// -- Test 1: tick() skips when fewer than 3 unprocessed entries --
asyncTest('tick() skips when fewer than 3 unprocessed entries', async () => {
  const wiki = createMockWikiClient();
  const extractor = new HeartbeatExtractor({
    activityLogger: createMockActivityLogger(makeEntries(2)),
    wikiClient: wiki,
    llmRouter: createMockRouter(),
    logger: silentLogger
  });
  extractor._lastExtraction = 0; // No cooldown

  await extractor.tick();

  assert.deepStrictEqual(wiki.getPages(), {}, 'Should not write anything with < 3 entries');
});

// -- Test 2: tick() skips during cooldown period --
asyncTest('tick() skips during cooldown period', async () => {
  const wiki = createMockWikiClient();
  const extractor = new HeartbeatExtractor({
    activityLogger: createMockActivityLogger(makeEntries(5)),
    wikiClient: wiki,
    llmRouter: createMockRouter(),
    logger: silentLogger
  });
  extractor._lastExtraction = Date.now(); // Just extracted

  await extractor.tick();

  assert.deepStrictEqual(wiki.getPages(), {}, 'Should not write during cooldown');
});

// -- Test 3: tick() calls flush() before reading entries --
asyncTest('tick() calls flush() before reading entries', async () => {
  let flushed = false;
  const extractor = new HeartbeatExtractor({
    activityLogger: {
      flush: async () => { flushed = true; },
      getUnprocessedEntries: () => [], // Empty after flush
      markProcessed: () => {}
    },
    wikiClient: createMockWikiClient(),
    llmRouter: createMockRouter(),
    logger: silentLogger
  });
  extractor._lastExtraction = 0;

  await extractor.tick();

  assert.strictEqual(flushed, true, 'Should flush activity log before reading');
});

// -- Test 4: tick() sends extraction prompt via synthesis job (trust boundary) --
asyncTest('tick() uses synthesis job for trust-boundary-aware extraction', async () => {
  let capturedReq = null;
  const extractor = new HeartbeatExtractor({
    activityLogger: createMockActivityLogger(makeEntries(5)),
    wikiClient: createMockWikiClient(),
    llmRouter: {
      route: async (req) => {
        capturedReq = req;
        return { result: '{"nothing": true}' };
      }
    },
    logger: silentLogger
  });
  extractor._lastExtraction = 0;

  await extractor.tick();

  assert.ok(capturedReq, 'Should have called router');
  assert.strictEqual(capturedReq.requirements.role, undefined, 'Should not hardcode sovereign role');
  assert.strictEqual(capturedReq.job, 'synthesis', 'Should use synthesis job');
});

// -- Test 5: tick() writes people facts to People/ wiki pages --
asyncTest('tick() writes people facts to People/ pages', async () => {
  const wiki = createMockWikiClient();
  const extractor = new HeartbeatExtractor({
    activityLogger: createMockActivityLogger(makeEntries(5)),
    wikiClient: wiki,
    llmRouter: createMockRouter(JSON.stringify({
      people: [{ name: 'Alice', fact: 'Prefers morning meetings' }]
    })),
    logger: silentLogger
  });
  extractor._lastExtraction = 0;

  await extractor.tick();

  assert.ok(wiki.getPages()['People/Alice'], 'Should create People/Alice page');
  assert.ok(wiki.getPages()['People/Alice'].includes('Prefers morning meetings'));
});

// -- Test 6: tick() writes preferences to People/ or General/Preferences --
asyncTest('tick() writes preferences with who to People/ page', async () => {
  const wiki = createMockWikiClient();
  const extractor = new HeartbeatExtractor({
    activityLogger: createMockActivityLogger(makeEntries(5)),
    wikiClient: wiki,
    llmRouter: createMockRouter(JSON.stringify({
      preferences: [{ who: 'Bob', preference: 'Uses dark mode' }]
    })),
    logger: silentLogger
  });
  extractor._lastExtraction = 0;

  await extractor.tick();

  assert.ok(wiki.getPages()['People/Bob'], 'Should write to People/Bob');
  assert.ok(wiki.getPages()['People/Bob'].includes('dark mode'));
});

// -- Test 7: tick() writes gaps to Meta/Pending Questions --
asyncTest('tick() writes knowledge gaps to Meta/Pending Questions', async () => {
  const wiki = createMockWikiClient();
  const extractor = new HeartbeatExtractor({
    activityLogger: createMockActivityLogger(makeEntries(5)),
    wikiClient: wiki,
    llmRouter: createMockRouter(JSON.stringify({
      gaps: [{ topic: 'Project Aurora', context: 'User asked, found nothing' }]
    })),
    logger: silentLogger
  });
  extractor._lastExtraction = 0;

  await extractor.tick();

  assert.ok(wiki.getPages()['Meta/Pending Questions'], 'Should create Pending Questions');
  assert.ok(wiki.getPages()['Meta/Pending Questions'].includes('Project Aurora'));
});

// -- Test 8: tick() handles {"nothing": true} gracefully --
asyncTest('tick() handles {"nothing": true} gracefully (no writes)', async () => {
  const wiki = createMockWikiClient();
  const actLog = createMockActivityLogger(makeEntries(5));
  const extractor = new HeartbeatExtractor({
    activityLogger: actLog,
    wikiClient: wiki,
    llmRouter: createMockRouter('{"nothing": true}'),
    logger: silentLogger
  });
  extractor._lastExtraction = 0;

  await extractor.tick();

  assert.deepStrictEqual(wiki.getPages(), {}, 'Should not write anything');
  assert.strictEqual(actLog.getProcessedCount(), 5, 'Should still mark entries as processed');
});

// -- Test 9: tick() works without invalidateCache (NC indexes automatically) --
asyncTest('tick() does not require invalidateCache on memorySearcher', async () => {
  const memSearcher = {}; // No invalidateCache method — NC handles indexing
  const extractor = new HeartbeatExtractor({
    activityLogger: createMockActivityLogger(makeEntries(5)),
    wikiClient: createMockWikiClient(),
    llmRouter: createMockRouter(JSON.stringify({
      people: [{ name: 'Test', fact: 'A fact' }]
    })),
    memorySearcher: memSearcher,
    logger: silentLogger
  });
  extractor._lastExtraction = 0;

  await extractor.tick();

  // Should complete without error — no invalidateCache needed
  assert.ok(true, 'tick() completes without invalidateCache');
});

// -- Test 10: tick() handles wiki write failures gracefully --
asyncTest('tick() handles wiki write failures gracefully (continues to next)', async () => {
  let writeCount = 0;
  const failingWiki = {
    readPageContent: async () => { throw new Error('404'); },
    writePageContent: async () => {
      writeCount++;
      if (writeCount === 1) throw new Error('First write fails');
      // Second write succeeds
    }
  };
  const extractor = new HeartbeatExtractor({
    activityLogger: createMockActivityLogger(makeEntries(5)),
    wikiClient: failingWiki,
    llmRouter: createMockRouter(JSON.stringify({
      people: [
        { name: 'FailPerson', fact: 'Will fail' },
        { name: 'SuccessPerson', fact: 'Will succeed' }
      ]
    })),
    logger: silentLogger
  });
  extractor._lastExtraction = 0;

  // Should not throw despite first write failing
  await extractor.tick();

  assert.strictEqual(writeCount, 2, 'Should attempt both writes');
});

// -- Test 11: Entity extraction reads actual page content (not empty string) --
asyncTest('Entity extraction passes actual page content to extractFromPage', async () => {
  const extractCalls = [];
  const wiki = createMockWikiClient();
  const extractor = new HeartbeatExtractor({
    activityLogger: createMockActivityLogger(makeEntries(5)),
    wikiClient: wiki,
    llmRouter: createMockRouter(JSON.stringify({
      people: [{ name: 'Alice', fact: 'Likes coffee' }]
    })),
    logger: silentLogger
  });
  extractor._lastExtraction = 0;
  extractor.entityExtractor = {
    extractFromPage: async (path, content) => { extractCalls.push({ path, content }); }
  };

  await extractor.tick();

  assert.strictEqual(extractCalls.length, 1, 'Should call extractFromPage once');
  assert.strictEqual(extractCalls[0].path, 'People/Alice', 'Path should match written page');
  assert.ok(extractCalls[0].content.includes('Likes coffee'), `Content should be actual page content, got: ${extractCalls[0].content}`);
  assert.ok(extractCalls[0].content.length > 0, 'Content should not be empty string');
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
