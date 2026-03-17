/**
 * Tests for ResilientWikiWriter
 *
 * Validates dual-path (OCS + WebDAV) write logic, health tracking,
 * cooldown behavior, and fallback paths.
 *
 * @license AGPL-3.0
 */

'use strict';

const assert = require('assert');
const { asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const ResilientWikiWriter = require('../../../src/lib/integrations/resilient-wiki-writer');

// ── Mock factories ──

function makeCollectivesClient(overrides = {}) {
  return {
    resolveCollective: overrides.resolveCollective || (async () => 42),
    listPages: overrides.listPages || (async () => [
      { id: 1, parentId: 0, title: 'Moltagent Knowledge' },
      { id: 10, parentId: 1, title: 'Sessions' }
    ]),
    // ensureSection: idempotent section lookup — returns existing page if found,
    // otherwise creates via createPage. Tests provide a default that returns a
    // predictable section page so OCS path succeeds without real API calls.
    ensureSection: overrides.ensureSection || (async (collectiveId, sectionName) => {
      return { id: 10, parentId: 1, title: sectionName };
    }),
    createPage: overrides.createPage || (async (cId, parentId, title) => ({ id: 99, title })),
    writePageContent: overrides.writePageContent || (async () => {}),
  };
}

function makeNCFilesClient(overrides = {}) {
  return {
    mkdir: overrides.mkdir || (async () => ({ success: true })),
    writeFile: overrides.writeFile || (async () => ({ success: true })),
    readFile: overrides.readFile || (async () => ({ content: '# Hello', truncated: false })),
    listDirectory: overrides.listDirectory || (async () => [
      { name: 'page1.md', type: 'file', size: 100, modified: '2026-03-06' }
    ]),
  };
}

function makeSilentLogger() {
  return { warn: () => {}, error: () => {}, info: () => {} };
}

function makeWriter(ocsOverrides = {}, webdavOverrides = {}, opts = {}) {
  return new ResilientWikiWriter({
    collectivesClient: makeCollectivesClient(ocsOverrides),
    ncFilesClient: makeNCFilesClient(webdavOverrides),
    logger: makeSilentLogger(),
    ocsTimeoutMs: opts.ocsTimeoutMs || 500,
    ...opts,
  });
}

// ── Tests ──

(async () => {
  // 1. OCS succeeds → page created via OCS
  await asyncTest('createPage: OCS succeeds → returns method ocs', async () => {
    const writer = makeWriter();
    const result = await writer.createPage('Sessions', 'Test Page', '# Content');
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.method, 'ocs');
  });

  // 2. OCS fails (500) → fallback to WebDAV
  await asyncTest('createPage: OCS fails → fallback to WebDAV', async () => {
    const writer = makeWriter({
      resolveCollective: async () => { throw new Error('HTTP 500'); }
    });
    const result = await writer.createPage('Sessions', 'Test Page', '# Content');
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.method, 'webdav');
  });

  // 3. OCS timeout → fallback to WebDAV
  await asyncTest('createPage: OCS timeout → fallback to WebDAV', async () => {
    const writer = makeWriter({
      resolveCollective: () => new Promise((resolve) => setTimeout(resolve, 5000))
    }, {}, { ocsTimeoutMs: 50 });
    const result = await writer.createPage('Sessions', 'Test Page', '# Content');
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.method, 'webdav');
  });

  // 4. Both OCS and WebDAV fail → returns null
  await asyncTest('createPage: both fail → success false, method null', async () => {
    const writer = makeWriter(
      { resolveCollective: async () => { throw new Error('OCS down'); } },
      { mkdir: async () => { throw new Error('WebDAV down'); } }
    );
    const result = await writer.createPage('Sessions', 'Test Page', '# Content');
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.method, null);
    assert.ok(result.error);
  });

  // 5. After OCS failure → cooldown skips OCS, goes straight to WebDAV
  // Note: the ensureSection chokepoint in createPage() calls resolveCollective once
  // before the OCS/WebDAV decision, so each createPage() adds 1 chokepoint call.
  await asyncTest('createPage: cooldown skips OCS after failure', async () => {
    let ocsCallCount = 0;
    const writer = makeWriter({
      resolveCollective: async () => { ocsCallCount++; throw new Error('OCS down'); }
    });

    // First call: chokepoint(1) + _createViaOCS(2) both call resolveCollective, both fail
    await writer.createPage('Sessions', 'Page1', '# One');
    assert.strictEqual(ocsCallCount, 2); // chokepoint + OCS path

    // Second call: chokepoint(3) calls resolveCollective, OCS skipped due to cooldown
    const result = await writer.createPage('Sessions', 'Page2', '# Two');
    assert.strictEqual(ocsCallCount, 3); // only chokepoint call added
    assert.strictEqual(result.method, 'webdav');
  });

  // 6. After cooldown expires → retries OCS
  await asyncTest('createPage: cooldown expires → retries OCS', async () => {
    let ocsCallCount = 0;
    const writer = makeWriter({
      resolveCollective: async () => {
        ocsCallCount++;
        if (ocsCallCount <= 2) throw new Error('OCS down'); // first call (chokepoint+OCS) fails
        return 42;
      }
    });

    // First call: chokepoint(1) + OCS path(2) both fail
    await writer.createPage('Sessions', 'Page1', '# One');
    assert.strictEqual(ocsCallCount, 2);

    // Simulate cooldown expiry by backdating the failure
    writer._ocsLastFailure = Date.now() - (6 * 60 * 1000);

    // Should retry OCS now: chokepoint(3) succeeds + OCS path(4) succeeds
    const result = await writer.createPage('Sessions', 'Page2', '# Two');
    assert.strictEqual(ocsCallCount, 4);
    assert.strictEqual(result.method, 'ocs');
  });

  // 7. updatePage → WebDAV primary
  await asyncTest('updatePage: WebDAV primary → returns method webdav', async () => {
    let webdavCalled = false;
    const writer = makeWriter({}, {
      writeFile: async () => { webdavCalled = true; return { success: true }; }
    });
    const result = await writer.updatePage('Sessions/test.md', '# Updated');
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.method, 'webdav');
    assert.strictEqual(webdavCalled, true);
  });

  // 8. updatePage WebDAV fails → OCS fallback
  await asyncTest('updatePage: WebDAV fails → OCS fallback', async () => {
    let ocsCalled = false;
    const writer = makeWriter({
      writePageContent: async () => { ocsCalled = true; }
    }, {
      writeFile: async () => { throw new Error('WebDAV write failed'); }
    });
    const result = await writer.updatePage('Sessions/test.md', '# Updated');
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.method, 'ocs');
    assert.strictEqual(ocsCalled, true);
  });

  // 9. listPages OCS works → returns OCS result
  await asyncTest('listPages: OCS works → returns OCS result', async () => {
    const writer = makeWriter({
      listPages: async () => [
        { id: 10, parentId: 1, title: 'Sessions', filePath: 'Sessions/' },
        { id: 20, parentId: 10, title: 'Day1', filePath: 'Sessions/Day1.md' }
      ]
    });
    const result = await writer.listPages('Sessions');
    assert.strictEqual(result.method, 'ocs');
    assert.ok(result.pages.length > 0);
  });

  // 10. listPages OCS fails → WebDAV PROPFIND fallback
  await asyncTest('listPages: OCS fails → WebDAV fallback', async () => {
    const writer = makeWriter({
      resolveCollective: async () => { throw new Error('OCS down'); }
    }, {
      listDirectory: async () => [
        { name: 'page1.md', type: 'file', size: 50, modified: '2026-03-06' }
      ]
    });
    const result = await writer.listPages('Sessions');
    assert.strictEqual(result.method, 'webdav');
    assert.strictEqual(result.pages.length, 1);
    assert.strictEqual(result.pages[0].title, 'page1');
  });

  // 11. 404 error does NOT mark OCS unhealthy
  await asyncTest('_markOCSDown: 404 does not flip health flag', async () => {
    const writer = makeWriter();
    assert.strictEqual(writer.isOCSHealthy, true);

    const err404 = new Error('HTTP 404 Not Found');
    err404.statusCode = 404;
    writer._markOCSDown(err404);

    assert.strictEqual(writer.isOCSHealthy, true, 'OCS should stay healthy after 404');
  });

  // 12. 500 error DOES mark OCS unhealthy
  await asyncTest('_markOCSDown: 500 flips health flag', async () => {
    const writer = makeWriter();
    const err500 = new Error('HTTP 500 Internal Server Error');
    err500.statusCode = 500;
    writer._markOCSDown(err500);

    assert.strictEqual(writer.isOCSHealthy, false, 'OCS should be unhealthy after 500');
  });

  // 13. Error message containing "404" (no statusCode) also skips marking unhealthy
  await asyncTest('_markOCSDown: message-only 404 does not flip health flag', async () => {
    const writer = makeWriter();
    writer._markOCSDown(new Error('WebDAV 404 path not found'));
    assert.strictEqual(writer.isOCSHealthy, true);
  });

  setTimeout(() => { summary(); exitWithCode(); }, 200);
})();
