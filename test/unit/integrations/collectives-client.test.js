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
  { id: 100, title: 'People', parentId: 0, emoji: '👥' },
  { id: 101, title: 'Projects', parentId: 0, emoji: '📁' },
  { id: 102, title: 'Meta', parentId: 0, emoji: '⚙️' },
  { id: 200, title: 'John Smith', parentId: 100, emoji: '' },
  { id: 201, title: 'Q3 Campaign', parentId: 101, emoji: '' },
  { id: 300, title: 'Learning Log', parentId: 102, emoji: '' }
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
  defaultResponses['GET:/remote.php/dav/files/testuser/Collectives/Moltagent Knowledge/John Smith/Readme.md'] = {
    status: 200,
    body: SAMPLE_PAGE_CONTENT,
    headers: {}
  };
  defaultResponses['PUT:/remote.php/dav/files/testuser/Collectives/Moltagent Knowledge/John Smith/Readme.md'] = {
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

asyncTest('searchPages sends search query parameter', async () => {
  let capturedPath;
  const mockNC = createMockNCRequestManager({
    'GET:/ocs/v2.php/apps/collectives/api/v1.0/collectives/10/search?search=John': (path) => {
      capturedPath = path;
      return { status: 200, body: { ocs: { data: SAMPLE_SEARCH_RESULTS } }, headers: {} };
    }
  });
  const client = new CollectivesClient(mockNC);
  const results = await client.searchPages(10, 'John');
  assert.ok(capturedPath.includes('search=John'));
  assert.strictEqual(results.length, 2);
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
    'GET:/remote.php/dav/files/testuser/Collectives/Moltagent Knowledge/Missing/Readme.md': () => {
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
    'PUT:/remote.php/dav/files/testuser/Collectives/Moltagent Knowledge/Test/Readme.md': (path, options) => {
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
    'GET:/ocs/v2.php/apps/collectives/api/v1.0/collectives/10/search?search=John%20Smith': {
      status: 200,
      body: { ocs: { data: [{ id: 200, title: 'John Smith', fileName: 'Readme.md', filePath: 'People/John Smith' }] } },
      headers: {}
    }
  });
  const client = new CollectivesClient(mockNC);
  const result = await client.findPageByTitle('John Smith');
  assert.ok(result);
  assert.strictEqual(result.page.title, 'John Smith');
  assert.strictEqual(result.path, 'People/John Smith/Readme.md');
});

asyncTest('readPageWithFrontmatter returns parsed frontmatter + body', async () => {
  const mockNC = createMockNCRequestManager({
    'GET:/ocs/v2.php/apps/collectives/api/v1.0/collectives': {
      status: 200, body: { ocs: { data: SAMPLE_COLLECTIVES } }, headers: {}
    },
    'GET:/ocs/v2.php/apps/collectives/api/v1.0/collectives/10/search?search=John%20Smith': {
      status: 200,
      body: { ocs: { data: [{ id: 200, title: 'John Smith', fileName: 'Readme.md', filePath: 'People/John Smith' }] } },
      headers: {}
    },
    'GET:/remote.php/dav/files/testuser/Collectives/Moltagent Knowledge/People/John Smith/Readme.md': {
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
  { id: 100, title: 'People', parentId: 0, fileId: 4001 },
  { id: 101, title: 'Projects', parentId: 0, fileId: 4002 },
  { id: 200, title: 'John Smith', parentId: 100, fileId: 4010 },
  { id: 201, title: 'Q3 Campaign', parentId: 101, fileId: 4020 },
  { id: 300, title: 'Learning Log', parentId: 102, fileId: 4030 }
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

asyncTest('resolveWikilinks replaces [[Page]] with Nextcloud file link', async () => {
  const mockNC = createWikilinkMockNC();
  const client = new CollectivesClient(mockNC);
  const result = await client.resolveWikilinks('See [[People]] for details.');
  assert.strictEqual(result, 'See [People](https://cloud.example.com/f/4001) for details.');
});

asyncTest('resolveWikilinks resolves [[Section/Page]] using leaf title', async () => {
  const mockNC = createWikilinkMockNC();
  const client = new CollectivesClient(mockNC);
  const result = await client.resolveWikilinks('Contact [[People/John Smith]].');
  assert.strictEqual(result, 'Contact [John Smith](https://cloud.example.com/f/4010).');
});

asyncTest('resolveWikilinks replaces unfound pages with plain text', async () => {
  const mockNC = createWikilinkMockNC();
  const client = new CollectivesClient(mockNC);
  const result = await client.resolveWikilinks('See [[Nonexistent Page]].');
  assert.strictEqual(result, 'See Nonexistent Page (page not found).');
});

asyncTest('resolveWikilinks handles multiple wikilinks in one string', async () => {
  const mockNC = createWikilinkMockNC();
  const client = new CollectivesClient(mockNC);
  const result = await client.resolveWikilinks('Check [[People]] and [[Projects]] and [[Missing]].');
  assert.ok(result.includes('[People](https://cloud.example.com/f/4001)'));
  assert.ok(result.includes('[Projects](https://cloud.example.com/f/4002)'));
  assert.ok(result.includes('Missing (page not found)'));
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
  assert.strictEqual(listPagesCallCount, 1, 'listPages should only be called once');
});

asyncTest('resolveWikilinks gracefully handles API error', async () => {
  const mockNC = createMockNCRequestManager({
    'GET:/ocs/v2.php/apps/collectives/api/v1.0/collectives': {
      status: 500, body: { message: 'Server error' }, headers: {}
    }
  });
  const client = new CollectivesClient(mockNC);
  const result = await client.resolveWikilinks('See [[People]].');
  assert.strictEqual(result, 'See People (page not found).', 'Should fall back to plain text on error');
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
    'PUT:/remote.php/dav/files/testuser/Collectives/Moltagent Knowledge/Test Page.md': (path, options) => {
      writtenContent = options.body;
      return { status: 201, body: '', headers: {} };
    }
  });
  const client = new CollectivesClient(mockNC);
  await client.writePageWithFrontmatter('Test Page', { type: 'note' }, 'Links to [[People]] and [[John Smith]].');
  assert.ok(writtenContent, 'Should have written content');
  assert.ok(writtenContent.includes('[People](https://cloud.example.com/f/4001)'), 'Should resolve People wikilink');
  assert.ok(writtenContent.includes('[John Smith](https://cloud.example.com/f/4010)'), 'Should resolve John Smith wikilink');
  assert.ok(!writtenContent.includes('[['), 'Should not contain raw wikilinks');
});

// ============================================================
// Summary
// ============================================================

setTimeout(() => {
  summary();
  exitWithCode();
}, 500);
