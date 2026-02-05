/**
 * NCFilesClient Unit Tests
 *
 * Run: node test/unit/integrations/nc-files-client.test.js
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

const { NCFilesClient, NCFilesError } = require('../../../src/lib/integrations/nc-files-client');

// ============================================================
// Mock NCRequestManager
// ============================================================

function createMockNCRM(responses = {}) {
  return {
    ncUrl: 'https://nc.example.com',
    ncUser: 'moltagent',
    request: async (path, options = {}) => {
      const method = (options.method || 'GET').toUpperCase();
      const key = `${method}:${path}`;

      // Check for specific mock responses
      for (const [pattern, response] of Object.entries(responses)) {
        if (key.includes(pattern) || path.includes(pattern)) {
          if (typeof response === 'function') return response(path, options);
          return response;
        }
      }

      // Default: 200 OK with empty body
      return { status: 200, headers: {}, body: '' };
    }
  };
}

const SAMPLE_PROPFIND_XML = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:response>
    <d:href>/remote.php/dav/files/moltagent/</d:href>
    <d:propstat>
      <d:prop>
        <d:displayname>moltagent</d:displayname>
        <d:resourcetype><d:collection/></d:resourcetype>
        <oc:permissions>RDNVCK</oc:permissions>
        <oc:size>1024000</oc:size>
      </d:prop>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/files/moltagent/report.md</d:href>
    <d:propstat>
      <d:prop>
        <d:displayname>report.md</d:displayname>
        <d:getcontentlength>256</d:getcontentlength>
        <d:getlastmodified>Mon, 09 Feb 2026 10:00:00 GMT</d:getlastmodified>
        <d:getcontenttype>text/markdown</d:getcontenttype>
        <d:resourcetype/>
        <oc:permissions>RDNVW</oc:permissions>
      </d:prop>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/files/moltagent/Inbox/</d:href>
    <d:propstat>
      <d:prop>
        <d:displayname>Inbox</d:displayname>
        <d:resourcetype><d:collection/></d:resourcetype>
        <oc:permissions>SRDNVCK</oc:permissions>
        <oc:size>512</oc:size>
      </d:prop>
    </d:propstat>
  </d:response>
</d:multistatus>`;

const SAMPLE_PROPFIND_SINGLE = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:response>
    <d:href>/remote.php/dav/files/moltagent/report.md</d:href>
    <d:propstat>
      <d:prop>
        <d:displayname>report.md</d:displayname>
        <d:getcontentlength>256</d:getcontentlength>
        <d:getlastmodified>Mon, 09 Feb 2026 10:00:00 GMT</d:getlastmodified>
        <d:getcontenttype>text/markdown</d:getcontenttype>
        <d:resourcetype/>
        <oc:permissions>RDNVW</oc:permissions>
      </d:prop>
    </d:propstat>
  </d:response>
</d:multistatus>`;

console.log('\n=== NCFilesClient Tests ===\n');

// ============================================================
// Constructor
// ============================================================

test('constructor uses defaults from ncRequestManager', () => {
  const nc = createMockNCRM();
  const client = new NCFilesClient(nc);
  assert.strictEqual(client.username, 'moltagent');
  assert.strictEqual(client.maxContentSize, 51200);
});

test('constructor accepts config overrides', () => {
  const nc = createMockNCRM();
  const client = new NCFilesClient(nc, { username: 'alice', maxContentSize: 1024 });
  assert.strictEqual(client.username, 'alice');
  assert.strictEqual(client.maxContentSize, 1024);
});

// ============================================================
// readFile
// ============================================================

asyncTest('readFile returns file content', async () => {
  const nc = createMockNCRM({
    'report.md': { status: 200, headers: {}, body: '# Hello World\nThis is a test.' }
  });
  const client = new NCFilesClient(nc);
  const result = await client.readFile('report.md');
  assert.ok(result.content.includes('Hello World'));
  assert.strictEqual(result.truncated, false);
});

asyncTest('readFile truncates large content', async () => {
  const bigContent = 'x'.repeat(60000);
  const nc = createMockNCRM({
    'big.txt': { status: 200, headers: {}, body: bigContent }
  });
  const client = new NCFilesClient(nc);
  const result = await client.readFile('big.txt');
  assert.strictEqual(result.truncated, true);
  assert.ok(result.content.includes('truncated'));
  assert.ok(result.content.length < bigContent.length);
});

asyncTest('readFile throws on 404', async () => {
  const nc = createMockNCRM({
    'missing.txt': { status: 404, headers: {}, body: 'Not Found' }
  });
  const client = new NCFilesClient(nc);
  try {
    await client.readFile('missing.txt');
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err instanceof NCFilesError);
    assert.strictEqual(err.statusCode, 404);
  }
});

// ============================================================
// writeFile
// ============================================================

asyncTest('writeFile sends PUT request', async () => {
  let capturedMethod, capturedBody;
  const nc = createMockNCRM();
  nc.request = async (path, options) => {
    capturedMethod = options.method;
    capturedBody = options.body;
    return { status: 201, headers: {}, body: '' };
  };
  const client = new NCFilesClient(nc);
  const result = await client.writeFile('test.md', 'Hello');
  assert.strictEqual(result.success, true);
  assert.strictEqual(capturedMethod, 'PUT');
  assert.strictEqual(capturedBody, 'Hello');
});

asyncTest('writeFile throws on 403', async () => {
  const nc = createMockNCRM();
  nc.request = async () => { throw new Error('Authentication error: 403'); };
  const client = new NCFilesClient(nc);
  try {
    await client.writeFile('readonly/file.md', 'data');
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err instanceof NCFilesError);
    assert.strictEqual(err.statusCode, 403);
  }
});

// ============================================================
// listDirectory
// ============================================================

asyncTest('listDirectory parses PROPFIND XML', async () => {
  const nc = createMockNCRM({
    'PROPFIND': { status: 207, headers: {}, body: SAMPLE_PROPFIND_XML }
  });
  const client = new NCFilesClient(nc);
  const items = await client.listDirectory('/');
  assert.ok(items.length >= 2, `Expected >= 2 items, got ${items.length}`);

  const file = items.find(i => i.name === 'report.md');
  assert.ok(file, 'Should find report.md');
  assert.strictEqual(file.type, 'file');
  assert.strictEqual(file.size, 256);

  const dir = items.find(i => i.name === 'Inbox');
  assert.ok(dir, 'Should find Inbox');
  assert.strictEqual(dir.type, 'directory');
});

asyncTest('listDirectory skips parent entry', async () => {
  const nc = createMockNCRM({
    'PROPFIND': { status: 207, headers: {}, body: SAMPLE_PROPFIND_XML }
  });
  const client = new NCFilesClient(nc);
  const items = await client.listDirectory('/');
  // Parent "moltagent" should be skipped
  const parent = items.find(i => i.name === 'moltagent');
  assert.strictEqual(parent, undefined, 'Parent directory should be skipped');
});

// ============================================================
// getFileInfo
// ============================================================

asyncTest('getFileInfo returns metadata with Depth 0', async () => {
  let capturedHeaders;
  const nc = createMockNCRM();
  nc.request = async (path, options) => {
    capturedHeaders = options.headers;
    return { status: 207, headers: {}, body: SAMPLE_PROPFIND_SINGLE };
  };
  const client = new NCFilesClient(nc);
  const info = await client.getFileInfo('report.md');
  assert.strictEqual(capturedHeaders.Depth, '0');
  assert.strictEqual(info.name, 'report.md');
  assert.strictEqual(info.size, 256);
  assert.strictEqual(info.canWrite, true);
  assert.strictEqual(info.shared, false);
});

asyncTest('getFileInfo detects shared files', async () => {
  // Permissions include S for shared
  const sharedXml = SAMPLE_PROPFIND_SINGLE.replace('RDNVW', 'SRDNVW');
  const nc = createMockNCRM();
  nc.request = async () => ({ status: 207, headers: {}, body: sharedXml });
  const client = new NCFilesClient(nc);
  const info = await client.getFileInfo('shared-doc.md');
  assert.strictEqual(info.shared, true);
  assert.strictEqual(info.canWrite, true);
});

// ============================================================
// moveFile
// ============================================================

asyncTest('moveFile sends MOVE with Destination header', async () => {
  let capturedMethod, capturedHeaders;
  const nc = createMockNCRM();
  nc.request = async (path, options) => {
    capturedMethod = options.method;
    capturedHeaders = options.headers;
    return { status: 201, headers: {}, body: '' };
  };
  const client = new NCFilesClient(nc);
  const result = await client.moveFile('old.md', 'new.md');
  assert.strictEqual(result.success, true);
  assert.strictEqual(capturedMethod, 'MOVE');
  assert.ok(capturedHeaders.Destination.includes('new.md'));
  assert.ok(capturedHeaders.Destination.startsWith('https://'));
});

// ============================================================
// copyFile
// ============================================================

asyncTest('copyFile sends COPY with Destination header', async () => {
  let capturedMethod, capturedHeaders;
  const nc = createMockNCRM();
  nc.request = async (path, options) => {
    capturedMethod = options.method;
    capturedHeaders = options.headers;
    return { status: 201, headers: {}, body: '' };
  };
  const client = new NCFilesClient(nc);
  const result = await client.copyFile('src.md', 'dst.md');
  assert.strictEqual(result.success, true);
  assert.strictEqual(capturedMethod, 'COPY');
  assert.ok(capturedHeaders.Destination.includes('dst.md'));
});

// ============================================================
// deleteFile
// ============================================================

asyncTest('deleteFile sends DELETE', async () => {
  let capturedMethod;
  const nc = createMockNCRM();
  nc.request = async (path, options) => {
    capturedMethod = options.method;
    return { status: 204, headers: {}, body: '' };
  };
  const client = new NCFilesClient(nc);
  const result = await client.deleteFile('trash.md');
  assert.strictEqual(result.success, true);
  assert.strictEqual(capturedMethod, 'DELETE');
});

// ============================================================
// mkdir
// ============================================================

asyncTest('mkdir sends MKCOL', async () => {
  let capturedMethod;
  const nc = createMockNCRM();
  nc.request = async (path, options) => {
    capturedMethod = options.method;
    return { status: 201, headers: {}, body: '' };
  };
  const client = new NCFilesClient(nc);
  const result = await client.mkdir('NewFolder');
  assert.strictEqual(result.success, true);
  assert.strictEqual(capturedMethod, 'MKCOL');
});

asyncTest('mkdir handles 405 (already exists) gracefully', async () => {
  const nc = createMockNCRM();
  nc.request = async () => { throw new Error('HTTP 405: Method Not Allowed'); };
  const client = new NCFilesClient(nc);
  const result = await client.mkdir('ExistingFolder');
  assert.strictEqual(result.success, true);
});

// ============================================================
// shareFile
// ============================================================

asyncTest('shareFile sends OCS POST with correct body', async () => {
  let capturedBody;
  const nc = createMockNCRM();
  nc.request = async (path, options) => {
    capturedBody = options.body;
    return {
      status: 200,
      headers: {},
      body: { ocs: { data: { id: 42 } } }
    };
  };
  const client = new NCFilesClient(nc);
  const result = await client.shareFile('report.md', 'alice', 'edit');
  assert.strictEqual(result.shareId, 42);
  assert.strictEqual(capturedBody.shareType, 0);
  assert.strictEqual(capturedBody.shareWith, 'alice');
  assert.strictEqual(capturedBody.permissions, 15); // edit = 15
  assert.strictEqual(capturedBody.path, '/report.md');
});

asyncTest('shareFile defaults to read permission', async () => {
  let capturedBody;
  const nc = createMockNCRM();
  nc.request = async (path, options) => {
    capturedBody = options.body;
    return { status: 200, headers: {}, body: { ocs: { data: { id: 43 } } } };
  };
  const client = new NCFilesClient(nc);
  await client.shareFile('notes.md', 'bob');
  assert.strictEqual(capturedBody.permissions, 1); // read = 1
});

// ============================================================
// readFileBuffer
// ============================================================

asyncTest('readFileBuffer returns Buffer', async () => {
  const nc = createMockNCRM();
  nc.request = async (path, options) => {
    assert.strictEqual(options.rawBuffer, true);
    return { status: 200, headers: {}, body: Buffer.from('binary data') };
  };
  const client = new NCFilesClient(nc);
  const buf = await client.readFileBuffer('file.pdf');
  assert.ok(Buffer.isBuffer(buf));
  assert.strictEqual(buf.toString(), 'binary data');
});

asyncTest('readFileBuffer converts string fallback to Buffer', async () => {
  const nc = createMockNCRM();
  nc.request = async () => ({ status: 200, headers: {}, body: 'string content' });
  const client = new NCFilesClient(nc);
  const buf = await client.readFileBuffer('file.txt');
  assert.ok(Buffer.isBuffer(buf));
  assert.strictEqual(buf.toString(), 'string content');
});

// ============================================================
// _parsePropfindResponse
// ============================================================

test('_parsePropfindResponse extracts all fields', () => {
  const nc = createMockNCRM();
  const client = new NCFilesClient(nc);
  const entries = client._parsePropfindResponse(SAMPLE_PROPFIND_XML);

  assert.strictEqual(entries.length, 3);

  // First entry (parent dir)
  assert.strictEqual(entries[0].isDirectory, true);
  assert.ok(entries[0].permissions.includes('R'));

  // Second entry (file)
  assert.strictEqual(entries[1].displayname, 'report.md');
  assert.strictEqual(entries[1].size, 256);
  assert.strictEqual(entries[1].isDirectory, false);
  assert.ok(entries[1].permissions.includes('W'));

  // Third entry (shared dir)
  assert.strictEqual(entries[2].isDirectory, true);
  assert.ok(entries[2].permissions.includes('S'));
});

// ============================================================
// Root Cache & Fuzzy Path Resolution
// ============================================================

console.log('\n--- Root Cache & Fuzzy Path Tests ---\n');

asyncTest('getRootListing caches results within TTL', async () => {
  let callCount = 0;
  const nc = createMockNCRM();
  nc.request = async (path, options) => {
    if (options.method === 'PROPFIND') {
      callCount++;
      return { status: 207, headers: {}, body: SAMPLE_PROPFIND_XML };
    }
    return { status: 200, headers: {}, body: '' };
  };
  const client = new NCFilesClient(nc);

  const first = await client.getRootListing();
  const second = await client.getRootListing();

  assert.strictEqual(callCount, 1, 'Should only call PROPFIND once (cached)');
  assert.deepStrictEqual(first, second);
});

asyncTest('getRootListing refreshes after TTL', async () => {
  let callCount = 0;
  const nc = createMockNCRM();
  nc.request = async (path, options) => {
    if (options.method === 'PROPFIND') {
      callCount++;
      return { status: 207, headers: {}, body: SAMPLE_PROPFIND_XML };
    }
    return { status: 200, headers: {}, body: '' };
  };
  const client = new NCFilesClient(nc, { rootCacheTTL: 1 }); // 1ms TTL

  await client.getRootListing();
  // Wait for TTL to expire
  await new Promise(r => setTimeout(r, 5));
  await client.getRootListing();

  assert.strictEqual(callCount, 2, 'Should refresh after TTL');
});

test('invalidateRootCache clears cache', () => {
  const nc = createMockNCRM();
  const client = new NCFilesClient(nc);
  client._rootCache = [{ name: 'test', type: 'directory' }];
  client._rootCacheExpiry = Date.now() + 60000;

  client.invalidateRootCache();

  assert.strictEqual(client._rootCache, null);
  assert.strictEqual(client._rootCacheExpiry, 0);
});

asyncTest('resolvePath returns exact path when it exists', async () => {
  const nc = createMockNCRM();
  nc.request = async (path, options) => {
    if (options.method === 'PROPFIND' && path.includes('Moltagent DEV')) {
      return { status: 207, headers: {}, body: SAMPLE_PROPFIND_SINGLE };
    }
    return { status: 404, headers: {}, body: 'Not Found' };
  };
  const client = new NCFilesClient(nc);
  const result = await client.resolvePath('Moltagent DEV');
  assert.strictEqual(result, 'Moltagent DEV');
});

asyncTest('resolvePath fuzzy-matches case-insensitive first segment', async () => {
  const nc = createMockNCRM();
  nc.request = async (path, options) => {
    // Exact path "moltagent dev" -> 404
    if (options.method === 'PROPFIND' && options.headers?.Depth === '0' && path.includes('moltagent%20dev')) {
      return { status: 404, headers: {}, body: 'Not Found' };
    }
    if (options.method === 'PROPFIND' && options.headers?.Depth === '0' && path.includes('moltagent dev')) {
      return { status: 404, headers: {}, body: 'Not Found' };
    }
    // Root listing returns "Moltagent DEV" (correct casing)
    if (options.method === 'PROPFIND' && options.headers?.Depth === '1') {
      const rootXml = SAMPLE_PROPFIND_XML.replace('Inbox', 'Moltagent DEV');
      return { status: 207, headers: {}, body: rootXml };
    }
    return { status: 200, headers: {}, body: '' };
  };
  const client = new NCFilesClient(nc);
  const result = await client.resolvePath('moltagent dev');
  assert.strictEqual(result, 'Moltagent DEV');
});

asyncTest('resolvePath returns null for genuinely non-existent paths', async () => {
  const nc = createMockNCRM();
  nc.request = async (path, options) => {
    if (options.method === 'PROPFIND' && options.headers?.Depth === '0') {
      return { status: 404, headers: {}, body: 'Not Found' };
    }
    if (options.method === 'PROPFIND' && options.headers?.Depth === '1') {
      return { status: 207, headers: {}, body: SAMPLE_PROPFIND_XML };
    }
    return { status: 200, headers: {}, body: '' };
  };
  const client = new NCFilesClient(nc);
  const result = await client.resolvePath('totally-nonexistent');
  assert.strictEqual(result, null);
});

asyncTest('resolvePath returns "/" for root path', async () => {
  const nc = createMockNCRM();
  const client = new NCFilesClient(nc);
  const result = await client.resolvePath('/');
  assert.strictEqual(result, '/');
});

asyncTest('resolvePath returns input for empty path', async () => {
  const nc = createMockNCRM();
  const client = new NCFilesClient(nc);
  const result = await client.resolvePath('');
  assert.strictEqual(result, '');
});

asyncTest('getRootFolderNames returns name array', async () => {
  const nc = createMockNCRM();
  nc.request = async (path, options) => {
    if (options.method === 'PROPFIND') {
      return { status: 207, headers: {}, body: SAMPLE_PROPFIND_XML };
    }
    return { status: 200, headers: {}, body: '' };
  };
  const client = new NCFilesClient(nc);
  const names = await client.getRootFolderNames();
  assert.ok(Array.isArray(names));
  assert.ok(names.includes('report.md'));
  assert.ok(names.includes('Inbox'));
});

// ============================================================
// Summary
// ============================================================

setTimeout(() => {
  summary();
  exitWithCode();
}, 500);
