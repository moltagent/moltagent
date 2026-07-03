// Mock type: LEGACY — TODO: migrate to realistic mocks
/**
 * CollectivesClient Unit Tests
 *
 * Run: node test/unit/integrations/collectives-client.test.js
 *
 * @module test/unit/integrations/collectives-client
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const { createMockNCRequestManager, createMockCollectivesClient } = require('../../helpers/mock-factories');

// Import module under test
const CollectivesClient = require('../../../src/lib/integrations/collectives-client');

// ============================================================
// Test Fixtures
// ============================================================

const SAMPLE_COLLECTIVES = [
  { id: 10, name: 'Moltagent Knowledge', emoji: '🧠' },
  { id: 20, name: 'Other Collective', emoji: '📚' }
];

const SAMPLE_PAGES = [
  { id: 100, title: 'People', parentId: 0, emoji: '👥', fileName: 'Readme.md', filePath: 'People', collectivePath: '.Collectives/Moltagent Knowledge' },
  { id: 101, title: 'Projects', parentId: 0, emoji: '📁', fileName: 'Readme.md', filePath: 'Projects', collectivePath: '.Collectives/Moltagent Knowledge' },
  { id: 102, title: 'Meta', parentId: 0, emoji: '⚙️', fileName: 'Readme.md', filePath: 'Meta', collectivePath: '.Collectives/Moltagent Knowledge' },
  { id: 200, title: 'John Smith', parentId: 100, emoji: '', fileName: 'Readme.md', filePath: 'People/John Smith', collectivePath: '.Collectives/Moltagent Knowledge' },
  { id: 201, title: 'Q3 Campaign', parentId: 101, emoji: '', fileName: 'Readme.md', filePath: 'Projects/Q3 Campaign', collectivePath: '.Collectives/Moltagent Knowledge' },
  { id: 300, title: 'Learning Log', parentId: 102, emoji: '', fileName: 'Readme.md', filePath: 'Meta/Learning Log', collectivePath: '.Collectives/Moltagent Knowledge' }
];

const SAMPLE_PAGE_CONTENT = `---
type: person
confidence: high
last_verified: 2026-02-08
tags: [team, leadership]
---
# John Smith

VP of Marketing. Reports to CEO.
`;

const SAMPLE_SEARCH_RESULTS = [
  { id: 200, title: 'John Smith', excerpt: 'VP of Marketing' },
  { id: 201, title: 'Q3 Campaign', excerpt: 'Led by John Smith' }
];

// ============================================================
// Mock NC Request Manager for Collectives
// ============================================================

function createCollectivesMockNC(overrides = {}) {
  const defaultResponses = {
    'GET:/ocs/v2.php/apps/collectives/api/v1.0/collectives': {
      status: 200,
      body: { ocs: { data: SAMPLE_COLLECTIVES } },
      headers: {}
    },
    'POST:/ocs/v2.php/apps/collectives/api/v1.0/collectives': {
      status: 200,
      body: { ocs: { data: { id: 30, name: 'New Collective' } } },
      headers: {}
    },
    'GET:/ocs/v2.php/apps/collectives/api/v1.0/collectives/10/pages': {
      status: 200,
      body: { ocs: { data: SAMPLE_PAGES } },
      headers: {}
    },
    'GET:/ocs/v2.php/apps/collectives/api/v1.0/collectives/10/pages/200': {
      status: 200,
      body: { ocs: { data: SAMPLE_PAGES[3] } },
      headers: {}
    },
    'POST:/ocs/v2.php/apps/collectives/api/v1.0/collectives/10/pages/100': {
      status: 200,
      body: { ocs: { data: { id: 500, title: 'New Person', parentId: 100 } } },
      headers: {}
    }
  };

  // Add search response
  defaultResponses['GET:/ocs/v2.php/apps/collectives/api/v1.0/collectives/10/search?search=John'] = {
    status: 200,
    body: { ocs: { data: SAMPLE_SEARCH_RESULTS } },
    headers: {}
  };

  // WebDAV responses
  defaultResponses['GET:/remote.php/dav/files/testuser/.Collectives/Moltagent Knowledge/John Smith/Readme.md'] = {
    status: 200,
    body: SAMPLE_PAGE_CONTENT,
    headers: {}
  };
  defaultResponses['PUT:/remote.php/dav/files/testuser/.Collectives/Moltagent Knowledge/John Smith/Readme.md'] = {
    status: 201,
    body: '',
    headers: {}
  };

  return createMockNCRequestManager({ ...defaultResponses, ...overrides });
}

// ============================================================
// Tests
// ============================================================

console.log('CollectivesClient Unit Tests\n');

// -- Constructor --

test('constructor requires NCRequestManager', () => {
  assert.throws(() => new CollectivesClient(null), /requires an NCRequestManager/);
});

test('constructor accepts NCRequestManager and config', () => {
  const mockNC = createCollectivesMockNC();
  const client = new CollectivesClient(mockNC, { collectiveName: 'Test Wiki' });
  assert.strictEqual(client.collectiveName, 'Test Wiki');
  assert.strictEqual(client.username, 'testuser');
});

// -- Collective Management --

asyncTest('listCollectives returns parsed collective list', async () => {
  const mockNC = createCollectivesMockNC();
  const client = new CollectivesClient(mockNC);
  const collectives = await client.listCollectives();
  assert.ok(Array.isArray(collectives));
  assert.strictEqual(collectives.length, 2);
  assert.strictEqual(collectives[0].name, 'Moltagent Knowledge');
});

asyncTest('getCollective finds existing by name', async () => {
  const mockNC = createCollectivesMockNC();
  const client = new CollectivesClient(mockNC);
  const collective = await client.getCollective('Moltagent Knowledge');
  assert.ok(collective);
  assert.strictEqual(collective.id, 10);
});

asyncTest('getCollective returns null for unknown name', async () => {
  const mockNC = createCollectivesMockNC();
  const client = new CollectivesClient(mockNC);
  const collective = await client.getCollective('Nonexistent');
  assert.strictEqual(collective, null);
});

asyncTest('resolveCollective finds existing by name', async () => {
  const mockNC = createCollectivesMockNC();
  const client = new CollectivesClient(mockNC);
  const id = await client.resolveCollective();
  assert.strictEqual(id, 10);
});

asyncTest('resolveCollective creates when not found', async () => {
  const mockNC = createCollectivesMockNC({
    'GET:/ocs/v2.php/apps/collectives/api/v1.0/collectives': {
      status: 200,
      body: { ocs: { data: [] } },
      headers: {}
    },
    'POST:/ocs/v2.php/apps/collectives/api/v1.0/collectives': {
      status: 200,
      body: { ocs: { data: { id: 30, name: 'Moltagent Knowledge' } } },
      headers: {}
    }
  });
  const client = new CollectivesClient(mockNC);
  const id = await client.resolveCollective();
  assert.strictEqual(id, 30);
});

asyncTest('resolveCollective caches ID on second call', async () => {
  let callCount = 0;
  const mockNC = createMockNCRequestManager({
    'GET:/ocs/v2.php/apps/collectives/api/v1.0/collectives': () => {
      callCount++;
      return { status: 200, body: { ocs: { data: SAMPLE_COLLECTIVES } }, headers: {} };
    }
  });
  const client = new CollectivesClient(mockNC);
  await client.resolveCollective();
  await client.resolveCollective();
  assert.strictEqual(callCount, 1, 'Should only call API once due to caching');
});

// -- Page Tree --

asyncTest('listPages returns page tree', async () => {
  const mockNC = createCollectivesMockNC();
  const client = new CollectivesClient(mockNC);
  const pages = await client.listPages(10);
  assert.ok(Array.isArray(pages));
  assert.strictEqual(pages.length, 6);
});

asyncTest('createPage sends correct OCS request with parentId', async () => {
  let capturedPath, capturedOptions;
  const mockNC = createMockNCRequestManager({
    'POST:/ocs/v2.php/apps/collectives/api/v1.0/collectives/10/pages/100': (path, options) => {
      capturedPath = path;
      capturedOptions = options;
      return { status: 200, body: { ocs: { data: { id: 500, title: 'New Person' } } }, headers: {} };
    }
  });
  const client = new CollectivesClient(mockNC);
  const page = await client.createPage(10, 100, 'New Person');
  assert.strictEqual(page.id, 500);
  assert.ok(capturedPath.includes('/pages/100'));
  assert.ok(capturedOptions.body.includes('New Person'));
});

asyncTest('searchPages uses NC Unified Search endpoint', async () => {
  let capturedPath;
  const mockNC = createMockNCRequestManager({
    'GET:/ocs/v2.php/search/providers/collectives-page-content/search?term=John&limit=10': (path) => {
      capturedPath = path;
      return { status: 200, body: { ocs: { data: { entries: [
        { title: 'John Smith', subline: 'VP of Marketing', resourceUrl: '/wiki/John' },
        { title: 'Q3 Campaign', subline: 'Led by John Smith', resourceUrl: '/wiki/Q3' }
      ] } } }, headers: {} };
    }
  });
  const client = new CollectivesClient(mockNC);
  const results = await client.searchPages(10, 'John');
  assert.ok(capturedPath.includes('term=John'));
  assert.strictEqual(results.length, 2);
  assert.strictEqual(results[0].title, 'John Smith');
});

// -- Page Content (WebDAV) --

asyncTest('readPageContent fetches via WebDAV path', async () => {
  const mockNC = createCollectivesMockNC();
  const client = new CollectivesClient(mockNC);
  const content = await client.readPageContent('John Smith/Readme.md');
  assert.ok(content.includes('# John Smith'));
});

asyncTest('readPageContent returns null on 404', async () => {
  const mockNC = createMockNCRequestManager({
    'GET:/remote.php/dav/files/testuser/.Collectives/Moltagent Knowledge/Missing/Readme.md': () => {
      const err = new Error('Not found');
      err.statusCode = 404;
      throw err;
    }
  });

  // Override _webdavRequest to handle the mock error
  const client = new CollectivesClient(mockNC);
  const originalWebdav = client._webdavRequest.bind(client);
  client._webdavRequest = async (method, filePath, content) => {
    try {
      return await originalWebdav(method, filePath, content);
    } catch (err) {
      throw err;
    }
  };

  const content = await client.readPageContent('Missing/Readme.md');
  assert.strictEqual(content, null);
});

asyncTest('writePageContent PUTs via WebDAV path', async () => {
  let capturedMethod, capturedPath;
  const mockNC = createMockNCRequestManager({
    'PUT:/remote.php/dav/files/testuser/.Collectives/Moltagent Knowledge/Test/Readme.md': (path, options) => {
      capturedMethod = options.method;
      capturedPath = path;
      return { status: 201, body: '', headers: {} };
    }
  });
  const client = new CollectivesClient(mockNC);
  await client.writePageContent('Test/Readme.md', '# Test Page');
  assert.strictEqual(capturedMethod, 'PUT');
  assert.ok(capturedPath.includes('Test/Readme.md'));
});

// -- High-Level Helpers --

asyncTest('findPageByTitle resolves search → exact match', async () => {
  const mockNC = createMockNCRequestManager({
    'GET:/ocs/v2.php/apps/collectives/api/v1.0/collectives': {
      status: 200, body: { ocs: { data: SAMPLE_COLLECTIVES } }, headers: {}
    },
    'GET:/ocs/v2.php/search/providers/collectives-page-content/search?term=John%20Smith&limit=10': {
      status: 200,
      body: { ocs: { data: { entries: [
        { title: 'John Smith', subline: 'VP of Marketing', resourceUrl: '/wiki/People/John Smith' }
      ] } } },
      headers: {}
    },
    // Fallback: listPages for full page metadata needed by _buildPagePath
    'GET:/ocs/v2.php/apps/collectives/api/v1.0/collectives/10/pages': {
      status: 200,
      body: { ocs: { data: SAMPLE_PAGES } },
      headers: {}
    }
  });
  const client = new CollectivesClient(mockNC);
  const result = await client.findPageByTitle('John Smith');
  assert.ok(result);
  assert.strictEqual(result.page.title, 'John Smith');
});

asyncTest('readPageWithFrontmatter returns parsed frontmatter + body', async () => {
  const mockNC = createMockNCRequestManager({
    'GET:/ocs/v2.php/apps/collectives/api/v1.0/collectives': {
      status: 200, body: { ocs: { data: SAMPLE_COLLECTIVES } }, headers: {}
    },
    'GET:/ocs/v2.php/search/providers/collectives-page-content/search?term=John%20Smith&limit=10': {
      status: 200,
      body: { ocs: { data: { entries: [
        { title: 'John Smith', subline: 'VP of Marketing', resourceUrl: '/wiki/People/John Smith' }
      ] } } },
      headers: {}
    },
    // listPages fallback for full metadata (findPageByTitle needs _buildPagePath)
    'GET:/ocs/v2.php/apps/collectives/api/v1.0/collectives/10/pages': {
      status: 200,
      body: { ocs: { data: SAMPLE_PAGES } },
      headers: {}
    },
    'GET:/remote.php/dav/files/testuser/.Collectives/Moltagent Knowledge/People/John Smith/Readme.md': {
      status: 200, body: SAMPLE_PAGE_CONTENT, headers: {}
    }
  });
  const client = new CollectivesClient(mockNC);
  const result = await client.readPageWithFrontmatter('John Smith');
  assert.ok(result);
  assert.strictEqual(result.frontmatter.type, 'person');
  assert.strictEqual(result.frontmatter.confidence, 'high');
  assert.ok(result.body.includes('VP of Marketing'));
});

// -- Error Handling --

asyncTest('OCS 403 returns permission error', async () => {
  const mockNC = createMockNCRequestManager({
    'GET:/ocs/v2.php/apps/collectives/api/v1.0/collectives': {
      status: 403, body: { message: 'Forbidden' }, headers: {}
    }
  });
  const client = new CollectivesClient(mockNC);
  try {
    await client.listCollectives();
    assert.fail('Should have thrown');
  } catch (err) {
    assert.strictEqual(err.statusCode, 403);
    assert.ok(err.message.includes('403'));
  }
});

// -- Mock Factory Test --

test('createMockCollectivesClient provides expected methods', () => {
  const mock = createMockCollectivesClient();
  assert.ok(typeof mock.resolveCollective === 'function');
  assert.ok(typeof mock.listPages === 'function');
  assert.ok(typeof mock.readPageWithFrontmatter === 'function');
  assert.ok(typeof mock.searchPages === 'function');
  assert.ok(typeof mock.writePageContent === 'function');
  assert.ok(typeof mock.findPageByTitle === 'function');
  assert.ok(typeof mock.createPage === 'function');
});

// -- Wikilink Resolution --

const PAGES_WITH_FILEIDS = [
  { id: 1, title: 'Moltagent Knowledge', parentId: 0, fileId: 4000, collectivePath: '.Collectives/Moltagent Knowledge' },
  { id: 100, title: 'People', parentId: 1, fileId: 4001, collectivePath: '.Collectives/Moltagent Knowledge' },
  { id: 101, title: 'Projects', parentId: 1, fileId: 4002, collectivePath: '.Collectives/Moltagent Knowledge' },
  { id: 102, title: 'Meta', parentId: 1, fileId: 4003, collectivePath: '.Collectives/Moltagent Knowledge' },
  { id: 200, title: 'John Smith', parentId: 100, fileId: 4010, collectivePath: '.Collectives/Moltagent Knowledge' },
  { id: 201, title: 'Q3 Campaign', parentId: 101, fileId: 4020, collectivePath: '.Collectives/Moltagent Knowledge' },
  { id: 300, title: 'Learning Log', parentId: 102, fileId: 4030, collectivePath: '.Collectives/Moltagent Knowledge' }
];

function createWikilinkMockNC(overrides = {}) {
  return createMockNCRequestManager({
    'GET:/ocs/v2.php/apps/collectives/api/v1.0/collectives': {
      status: 200, body: { ocs: { data: SAMPLE_COLLECTIVES } }, headers: {}
    },
    'GET:/ocs/v2.php/apps/collectives/api/v1.0/collectives/10/pages': {
      status: 200, body: { ocs: { data: PAGES_WITH_FILEIDS } }, headers: {}
    },
    ...overrides
  });
}

asyncTest('resolveWikilinks replaces [[Page]] with Nextcloud deep link', async () => {
  const mockNC = createWikilinkMockNC();
  const client = new CollectivesClient(mockNC);
  const result = await client.resolveWikilinks('See [[People]] for details.');
  assert.strictEqual(result, 'See [People](https://cloud.example.com/apps/collectives/Moltagent-Knowledge-10/People-100) for details.');
});

asyncTest('resolveWikilinks resolves [[Section/Page]] using leaf title', async () => {
  const mockNC = createWikilinkMockNC();
  const client = new CollectivesClient(mockNC);
  const result = await client.resolveWikilinks('Contact [[People/John Smith]].');
  assert.strictEqual(result, 'Contact [John Smith](https://cloud.example.com/apps/collectives/Moltagent-Knowledge-10/John-Smith-200).');
});

asyncTest('resolveWikilinks preserves [[target]] markup for unfound pages', async () => {
  const mockNC = createWikilinkMockNC();
  const client = new CollectivesClient(mockNC);
  const result = await client.resolveWikilinks('See [[Nonexistent Page]].');
  // Unknown targets keep their markup so a later resolve pass can pick them up
  // once the target page exists (e.g. batch entity creation with forward refs).
  assert.strictEqual(result, 'See [[Nonexistent Page]].');
});

asyncTest('resolveWikilinks handles multiple wikilinks in one string', async () => {
  const mockNC = createWikilinkMockNC();
  const client = new CollectivesClient(mockNC);
  const result = await client.resolveWikilinks('Check [[People]] and [[Projects]] and [[Missing]].');
  assert.ok(result.includes('[People](https://cloud.example.com/apps/collectives/Moltagent-Knowledge-10/People-100)'));
  assert.ok(result.includes('[Projects](https://cloud.example.com/apps/collectives/Moltagent-Knowledge-10/Projects-101)'));
  assert.ok(result.includes('[[Missing]]'), 'unknown targets preserve raw wikilink markup');
});

asyncTest('resolveWikilinks returns content unchanged when no wikilinks', async () => {
  const mockNC = createWikilinkMockNC();
  const client = new CollectivesClient(mockNC);
  const input = 'No wikilinks here, just [normal](https://example.com) links.';
  const result = await client.resolveWikilinks(input);
  assert.strictEqual(result, input);
});

asyncTest('resolveWikilinks caches page map across calls', async () => {
  let listPagesCallCount = 0;
  const mockNC = createMockNCRequestManager({
    'GET:/ocs/v2.php/apps/collectives/api/v1.0/collectives': {
      status: 200, body: { ocs: { data: SAMPLE_COLLECTIVES } }, headers: {}
    },
    'GET:/ocs/v2.php/apps/collectives/api/v1.0/collectives/10/pages': () => {
      listPagesCallCount++;
      return { status: 200, body: { ocs: { data: PAGES_WITH_FILEIDS } }, headers: {} };
    }
  });
  const client = new CollectivesClient(mockNC);
  await client.resolveWikilinks('[[People]]');
  await client.resolveWikilinks('[[Projects]]');
  // 1 call from resolveCollective (path discovery) + 1 from wikilink map build = 2
  assert.strictEqual(listPagesCallCount, 2, 'listPages should be called twice (path discovery + wikilink map)');
});

asyncTest('resolveWikilinks gracefully handles API error', async () => {
  const mockNC = createMockNCRequestManager({
    'GET:/ocs/v2.php/apps/collectives/api/v1.0/collectives': {
      status: 500, body: { message: 'Server error' }, headers: {}
    }
  });
  const client = new CollectivesClient(mockNC);
  const result = await client.resolveWikilinks('See [[People]].');
  // Cache stays empty on error; markup is preserved for a later retry once
  // OCS recovers, rather than destructively rewriting to a sentinel.
  assert.strictEqual(result, 'See [[People]].', 'Should preserve wikilink markup on error');
});

asyncTest('writePageWithFrontmatter resolves wikilinks before writing', async () => {
  let writtenContent = null;
  const mockNC = createMockNCRequestManager({
    'GET:/ocs/v2.php/apps/collectives/api/v1.0/collectives': {
      status: 200, body: { ocs: { data: SAMPLE_COLLECTIVES } }, headers: {}
    },
    'GET:/ocs/v2.php/apps/collectives/api/v1.0/collectives/10/pages': {
      status: 200, body: { ocs: { data: PAGES_WITH_FILEIDS } }, headers: {}
    },
    'GET:/ocs/v2.php/apps/collectives/api/v1.0/collectives/10/search?search=Test%20Page': {
      status: 200, body: { ocs: { data: [] } }, headers: {}
    },
    'PUT:/remote.php/dav/files/testuser/.Collectives/Moltagent Knowledge/Test Page.md': (path, options) => {
      writtenContent = options.body;
      return { status: 201, body: '', headers: {} };
    }
  });
  const client = new CollectivesClient(mockNC);
  await client.writePageWithFrontmatter('Test Page', { type: 'note' }, 'Links to [[People]] and [[John Smith]].');
  assert.ok(writtenContent, 'Should have written content');
  assert.ok(writtenContent.includes('[People](https://cloud.example.com/apps/collectives/Moltagent-Knowledge-10/People-100)'), 'Should resolve People wikilink');
  assert.ok(writtenContent.includes('[John Smith](https://cloud.example.com/apps/collectives/Moltagent-Knowledge-10/John-Smith-200)'), 'Should resolve John Smith wikilink');
  assert.ok(!writtenContent.includes('[['), 'Should not contain raw wikilinks');
});

// -- ensureSection — collision dedup (Fix D) --

const silentLogger = { warn() {}, info() {}, error() {}, debug() {} };

asyncTest('ensureSection returns the existing section without creating', async () => {
  const client = new CollectivesClient(createCollectivesMockNC());
  let createCalls = 0;
  client.createPage = async () => { createCalls++; return { id: 999, title: 'WRONG' }; };
  client.listPages = async () => ([
    { id: 1, title: 'Landing page', parentId: 0 },
    { id: 2, title: 'Documents', parentId: 1 },
  ]);

  const result = await client.ensureSection(10, 'Documents');
  assert.strictEqual(result.id, 2, 'should return the existing Documents section');
  assert.strictEqual(createCalls, 0, 'createPage must not be called when the section exists');
});

asyncTest('ensureSection creates the section when it does not exist', async () => {
  const client = new CollectivesClient(createCollectivesMockNC());
  let createArgs = null;
  client.listPages = async () => ([{ id: 1, title: 'Landing page', parentId: 0 }]);
  client.createPage = async (cid, parentId, title) => {
    createArgs = { cid, parentId, title };
    return { id: 50, title, parentId };
  };

  const result = await client.ensureSection(10, 'Research');
  assert.strictEqual(result.id, 50, 'should return the newly created section');
  assert.deepStrictEqual(createArgs, { cid: 10, parentId: 1, title: 'Research' });
});

asyncTest('ensureSection detects a (N) collision and trashes the artifact', async () => {
  const client = new CollectivesClient(createCollectivesMockNC(), { logger: silentLogger });
  let listCalls = 0;
  // The pre-create check races a stale list (no Documents). After createPage
  // collides, the fresh skipCache re-find sees the real Documents section.
  client.listPages = async () => {
    listCalls++;
    const pages = [{ id: 1, title: 'Landing page', parentId: 0 }];
    if (listCalls >= 2) pages.push({ id: 7, title: 'Documents', parentId: 1 });
    return pages;
  };
  client.createPage = async () => ({ id: 99, title: 'Documents (2)', parentId: 1 });
  let trashedId = null;
  client.trashPage = async (cid, pid) => { trashedId = pid; };

  const result = await client.ensureSection(10, 'Documents', 1);
  assert.strictEqual(trashedId, 99, 'the (2) collision artifact should be trashed');
  assert.strictEqual(result.id, 7, 'should return the real Documents section, not the artifact');
});

asyncTest('ensureSection keeps the suffixed page when no real section can be found', async () => {
  const client = new CollectivesClient(createCollectivesMockNC(), { logger: silentLogger });
  // Both the pre-check and the post-collision re-find see no un-suffixed section.
  client.listPages = async () => ([{ id: 1, title: 'Landing page', parentId: 0 }]);
  client.createPage = async () => ({ id: 88, title: 'Documents (2)', parentId: 1 });
  let trashed = false;
  client.trashPage = async () => { trashed = true; };

  const result = await client.ensureSection(10, 'Documents', 1);
  assert.strictEqual(trashed, false, 'must not trash when there is no section to fall back to');
  assert.strictEqual(result.id, 88, 'should keep the suffixed page rather than lose the section');
});

// ============================================================
// Phase 4: the medium repair at the read chokepoint (G1)
// ============================================================

const fs = require('fs');
const path = require('path');
const D2_FIXTURE = fs.readFileSync(
  path.join(__dirname, '../../fixtures/wikisteward/d2-fixture.md'), 'utf8');

test('_sanitizeContent: D2 fixture round-trips to clean markdown, zero Tiptap remnants', () => {
  const client = new CollectivesClient(createCollectivesMockNC());
  const out = client._sanitizeContent(D2_FIXTURE);

  for (const remnant of ['<paragraph', '<listitem', '<bulletlist', '<orderedlist', '<link href', '<hardbreak']) {
    assert.ok(!out.includes(remnant), `no ${remnant} remnant after sanitize`);
  }
  assert.ok(!out.includes('\\[\\['), 'no escaped wikilinks remain');
  // Structure converted, not destroyed:
  assert.ok(out.includes('- Focus: sovereign farm intelligence'), 'listitem became a bullet');
  assert.ok(out.includes('[Central Europe](https://example.org/region)'), '<link href> became a markdown link');
  assert.ok(out.includes('[[DM]]'), 'escaped wikilink repaired to live markup');
  assert.ok(out.includes('Contradiction flagged by Knowledge Steward'), 'flag blocks pass through untouched');
});

test('_sanitizeContent: attribute-carrying Tiptap tags convert (not strip)', () => {
  const client = new CollectivesClient(createCollectivesMockNC());
  const out = client._sanitizeContent(
    '<heading level="2" dir="ltr">Title</heading>\n' +
    '<paragraph dir="ltr">Text line.</paragraph>\n' +
    '<bulletlist bullet="-" isList="true"><listitem dir="ltr">item one</listitem></bulletlist>\n' +
    '<hardbreak />'
  );
  assert.ok(out.includes('## Title'), 'heading with attributes converts');
  assert.ok(out.includes('Text line.'), 'paragraph content preserved');
  assert.ok(out.includes('- item one'), 'listitem with attributes becomes a bullet');
});

test('_sanitizeContent: <link href> converts to markdown link, title attribute dropped', () => {
  const client = new CollectivesClient(createCollectivesMockNC());
  const out = client._sanitizeContent('See <link href="https://example.org/doc" title="null">the doc</link>.');
  assert.strictEqual(out, 'See [the doc](https://example.org/doc).');
});

test('_sanitizeContent: repairs full escaped wikilinks only; lone escaped brackets untouched', () => {
  const client = new CollectivesClient(createCollectivesMockNC());
  const out = client._sanitizeContent(
    'Links to \\[\\[Conference November 26, 2025\\]\\] here.\nStatus \\[incomplete\\] in prose.'
  );
  assert.ok(out.includes('[[Conference November 26, 2025]]'), 'full escaped wikilink repaired');
  assert.ok(out.includes('Status \\[incomplete\\] in prose.'), 'lone escaped brackets left alone');
});

// Cross-module: a body that arrives escaped on disk dedups correctly in
// _addWikilink once the read chokepoint has repaired it. No belt lands in
// _addWikilink itself — the sanitizer is the component that got stronger.
asyncTest('_addWikilink dedups against an escaped-on-disk link after a sanitized read', async () => {
  const escapedBody = `---
type: person
---
# John Smith

## Related

- \\[\\[Target Page\\]\\] (related)
`;
  const mockNC = createMockNCRequestManager({
    'GET:/ocs/v2.php/apps/collectives/api/v1.0/collectives': {
      status: 200, body: { ocs: { data: SAMPLE_COLLECTIVES } }, headers: {}
    },
    'GET:/ocs/v2.php/search/providers/collectives-page-content/search?term=John%20Smith&limit=10': {
      status: 200,
      body: { ocs: { data: { entries: [
        { title: 'John Smith', subline: '', resourceUrl: '/wiki/People/John Smith' }
      ] } } },
      headers: {}
    },
    'GET:/ocs/v2.php/apps/collectives/api/v1.0/collectives/10/pages': {
      status: 200, body: { ocs: { data: SAMPLE_PAGES } }, headers: {}
    },
    'GET:/remote.php/dav/files/testuser/.Collectives/Moltagent Knowledge/People/John Smith/Readme.md': {
      status: 200, body: escapedBody, headers: {}
    }
  });
  const client = new CollectivesClient(mockNC);

  const { WikiSteward } = require('../../../src/lib/maintenance/wiki-steward');
  const { ObservationLog } = require('../../../src/lib/maintenance/observation-log');
  const silent = { debug() {}, info() {}, warn() {}, error() {} };
  const steward = new WikiSteward({
    collectivesClient: client,
    knowledgeGraph: { getEntity: () => null, relatedTo: () => [] },
    vectorStore: { getMetadata: () => null },
    embeddingClient: { embed: async () => [0] },
    llmRouter: { route: async () => ({ result: '{}' }) },
    observationLog: new ObservationLog({ logger: silent }),
    logger: silent,
  });

  const added = await steward._addWikilink('John Smith', 'Target Page', 'related');
  assert.strictEqual(added, false,
    'escaped link is live markup after the sanitized read — no duplicate append');
});

// ============================================================
// Summary
// ============================================================

setTimeout(() => {
  summary();
  exitWithCode();
}, 500);
