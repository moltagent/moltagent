/*
 * Moltagent - Sovereign AI Security Layer
 * Copyright (C) 2026 Moltagent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * SystemTagsClient Unit Tests
 *
 * Tests for the NC SystemTags WebDAV client module.
 * Covers: tag ID lookups, assign/remove operations, 409/404 handling,
 * tag transitions, file ID resolution, convenience methods,
 * refreshTagIds, getFileTags, hasTag, XML parsing.
 *
 * Run: node test/unit/nc-flow/system-tags.test.js
 *
 * @module test/unit/nc-flow/system-tags
 */

'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

const { SystemTagsClient } = require('../../../src/lib/nc-flow/system-tags');

// ============================================================
// Test Helpers
// ============================================================

/**
 * Silent logger that suppresses output during tests.
 */
const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

/**
 * Standard tag config matching the deployment IDs from the brief.
 */
const TAG_CONFIG = {
  enabled: true,
  tagIds: {
    'pending': 2,
    'processed': 5,
    'needs-review': 8,
    'ai-flagged': 11,
  },
};

/**
 * Create a mock NCRequestManager with a controllable request function.
 * @param {Function} [requestFn] - Custom request implementation
 * @returns {Object} Mock NCRequestManager
 */
function createMockNC(requestFn) {
  const calls = [];
  const defaultRequestFn = async (path, options) => {
    calls.push({ path, options });
    return {};
  };
  return {
    config: { nextcloud: { user: 'moltagent' } },
    request: requestFn || defaultRequestFn,
    _calls: calls,
  };
}

/**
 * Create a mock NC that resolves all requests successfully.
 * @returns {Object} Mock NCRequestManager
 */
function createSuccessMockNC() {
  const calls = [];
  return {
    config: { nextcloud: { user: 'moltagent' } },
    request: async (path, options) => {
      calls.push({ path, options });
      return {};
    },
    _calls: calls,
  };
}

/**
 * Sample PROPFIND response for tags on a file.
 */
const SAMPLE_FILE_TAGS_XML = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:response><d:propstat><d:prop>
    <oc:display-name>pending</oc:display-name>
    <oc:id>2</oc:id>
  </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
  <d:response><d:propstat><d:prop>
    <oc:display-name>ai-flagged</oc:display-name>
    <oc:id>11</oc:id>
  </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>`;

/**
 * Sample PROPFIND response for file ID resolution.
 */
const SAMPLE_FILE_ID_XML = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:response>
    <d:propstat>
      <d:prop><oc:fileid>67890</oc:fileid></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

/**
 * Sample PROPFIND response for refreshTagIds.
 */
const SAMPLE_ALL_TAGS_XML = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:response><d:propstat><d:prop>
    <oc:display-name>custom-tag</oc:display-name>
    <oc:id>99</oc:id>
    <oc:user-visible>true</oc:user-visible>
    <oc:user-assignable>true</oc:user-assignable>
  </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
  <d:response><d:propstat><d:prop>
    <oc:display-name>another-tag</oc:display-name>
    <oc:id>100</oc:id>
    <oc:user-visible>true</oc:user-visible>
    <oc:user-assignable>false</oc:user-assignable>
  </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>`;

// ============================================================
// Tag ID Lookup Tests
// ============================================================

console.log('\n=== SystemTagsClient Tests ===\n');
console.log('--- Tag ID Lookups ---\n');

test('ST-ID-001: Resolves tag IDs from config', () => {
  const client = new SystemTagsClient(TAG_CONFIG, createMockNC(), silentLogger);
  assert.strictEqual(client.getTagId('pending'), 2);
  assert.strictEqual(client.getTagId('processed'), 5);
  assert.strictEqual(client.getTagId('needs-review'), 8);
  assert.strictEqual(client.getTagId('ai-flagged'), 11);
});

test('ST-ID-002: Returns null for unknown tag name', () => {
  const client = new SystemTagsClient(TAG_CONFIG, createMockNC(), silentLogger);
  assert.strictEqual(client.getTagId('nonexistent'), null);
});

test('ST-ID-003: Resolves tag names from ID (reverse lookup)', () => {
  const client = new SystemTagsClient(TAG_CONFIG, createMockNC(), silentLogger);
  assert.strictEqual(client.getTagName(2), 'pending');
  assert.strictEqual(client.getTagName(8), 'needs-review');
});

test('ST-ID-004: Returns null for unknown tag ID', () => {
  const client = new SystemTagsClient(TAG_CONFIG, createMockNC(), silentLogger);
  assert.strictEqual(client.getTagName(999), null);
});

test('ST-ID-005: Handles empty tagIds config gracefully', () => {
  const client = new SystemTagsClient({ enabled: true, tagIds: {} }, createMockNC(), silentLogger);
  assert.strictEqual(client.getTagId('pending'), null);
});

// ============================================================
// Assign Tag Tests
// ============================================================

console.log('\n--- Assign Tag ---\n');

asyncTest('ST-ASSIGN-001: Assigns tag to file via WebDAV PUT', async () => {
  const nc = createSuccessMockNC();
  const client = new SystemTagsClient(TAG_CONFIG, nc, silentLogger);
  const result = await client.assignTag(12345, 'processed');
  assert.strictEqual(result, true);
  assert.ok(nc._calls[0].path.includes('/12345/5'));
  assert.strictEqual(nc._calls[0].options.method, 'PUT');
});

asyncTest('ST-ASSIGN-002: Returns false for unknown tag name', async () => {
  const nc = createSuccessMockNC();
  const client = new SystemTagsClient(TAG_CONFIG, nc, silentLogger);
  const result = await client.assignTag(12345, 'nonexistent');
  assert.strictEqual(result, false);
  assert.strictEqual(nc._calls.length, 0);
});

asyncTest('ST-ASSIGN-003: Handles 409 Conflict (already tagged) gracefully', async () => {
  const nc = createMockNC(async () => {
    throw Object.assign(new Error('Conflict'), { status: 409 });
  });
  const client = new SystemTagsClient(TAG_CONFIG, nc, silentLogger);
  const result = await client.assignTag(12345, 'pending');
  assert.strictEqual(result, true);
});

asyncTest('ST-ASSIGN-004: Returns false on unexpected error', async () => {
  const nc = createMockNC(async () => {
    throw Object.assign(new Error('Server error'), { status: 500 });
  });
  const client = new SystemTagsClient(TAG_CONFIG, nc, silentLogger);
  const result = await client.assignTag(12345, 'pending');
  assert.strictEqual(result, false);
});

// ============================================================
// Remove Tag Tests
// ============================================================

console.log('\n--- Remove Tag ---\n');

asyncTest('ST-REM-001: Removes tag from file via WebDAV DELETE', async () => {
  const nc = createSuccessMockNC();
  const client = new SystemTagsClient(TAG_CONFIG, nc, silentLogger);
  const result = await client.removeTag(12345, 'pending');
  assert.strictEqual(result, true);
  assert.ok(nc._calls[0].path.includes('/12345/2'));
  assert.strictEqual(nc._calls[0].options.method, 'DELETE');
});

asyncTest('ST-REM-002: Returns false for unknown tag name', async () => {
  const nc = createSuccessMockNC();
  const client = new SystemTagsClient(TAG_CONFIG, nc, silentLogger);
  const result = await client.removeTag(12345, 'nonexistent');
  assert.strictEqual(result, false);
});

asyncTest('ST-REM-003: Handles 404 (tag not assigned) gracefully', async () => {
  const nc = createMockNC(async () => {
    throw Object.assign(new Error('Not found'), { status: 404 });
  });
  const client = new SystemTagsClient(TAG_CONFIG, nc, silentLogger);
  const result = await client.removeTag(12345, 'pending');
  assert.strictEqual(result, true);
});

asyncTest('ST-REM-004: Returns false on unexpected error', async () => {
  const nc = createMockNC(async () => {
    throw Object.assign(new Error('Server error'), { status: 500 });
  });
  const client = new SystemTagsClient(TAG_CONFIG, nc, silentLogger);
  const result = await client.removeTag(12345, 'pending');
  assert.strictEqual(result, false);
});

// ============================================================
// Tag Transition Tests
// ============================================================

console.log('\n--- Tag Transitions ---\n');

asyncTest('ST-TRANS-001: Transitions tags: removes old, assigns new', async () => {
  const nc = createSuccessMockNC();
  const client = new SystemTagsClient(TAG_CONFIG, nc, silentLogger);
  const result = await client.transitionTags(12345, 'pending', 'processed');
  assert.strictEqual(result, true);
  assert.strictEqual(nc._calls.length, 2);
  assert.ok(nc._calls[0].path.includes('/2'));
  assert.strictEqual(nc._calls[0].options.method, 'DELETE');
  assert.ok(nc._calls[1].path.includes('/5'));
  assert.strictEqual(nc._calls[1].options.method, 'PUT');
});

asyncTest('ST-TRANS-002: Transitions multiple tags at once', async () => {
  const nc = createSuccessMockNC();
  const client = new SystemTagsClient(TAG_CONFIG, nc, silentLogger);
  const result = await client.transitionTags(12345, 'pending', ['processed', 'ai-flagged']);
  assert.strictEqual(result, true);
  assert.strictEqual(nc._calls.length, 3);
});

asyncTest('ST-TRANS-003: Handles array of fromTags', async () => {
  const nc = createSuccessMockNC();
  const client = new SystemTagsClient(TAG_CONFIG, nc, silentLogger);
  const result = await client.transitionTags(12345, ['pending', 'ai-flagged'], 'processed');
  assert.strictEqual(result, true);
  assert.strictEqual(nc._calls.length, 3);
});

asyncTest('ST-TRANS-004: Returns false if assignTag fails', async () => {
  let callCount = 0;
  const nc = createMockNC(async () => {
    callCount++;
    if (callCount > 1) throw Object.assign(new Error('Server error'), { status: 500 });
    return {};
  });
  const client = new SystemTagsClient(TAG_CONFIG, nc, silentLogger);
  const result = await client.transitionTags(12345, 'pending', 'processed');
  assert.strictEqual(result, false);
});

// ============================================================
// Get File Tags Tests
// ============================================================

console.log('\n--- Get File Tags ---\n');

asyncTest('ST-FTAGS-001: Lists tags assigned to a file', async () => {
  const nc = createMockNC(async () => ({
    text: () => Promise.resolve(SAMPLE_FILE_TAGS_XML)
  }));
  const client = new SystemTagsClient(TAG_CONFIG, nc, silentLogger);
  const tags = await client.getFileTags(12345);
  assert.strictEqual(tags.length, 2);
  assert.deepStrictEqual(tags[0], { name: 'pending', id: 2 });
  assert.deepStrictEqual(tags[1], { name: 'ai-flagged', id: 11 });
});

asyncTest('ST-FTAGS-002: Returns empty array when file has no tags', async () => {
  const nc = createMockNC(async () => ({
    text: () => Promise.resolve('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"></d:multistatus>')
  }));
  const client = new SystemTagsClient(TAG_CONFIG, nc, silentLogger);
  const tags = await client.getFileTags(12345);
  assert.strictEqual(tags.length, 0);
});

// ============================================================
// Has Tag Tests
// ============================================================

console.log('\n--- Has Tag ---\n');

asyncTest('ST-HAS-001: Returns true when file has the tag', async () => {
  const nc = createMockNC(async () => ({
    text: () => Promise.resolve(SAMPLE_FILE_TAGS_XML)
  }));
  const client = new SystemTagsClient(TAG_CONFIG, nc, silentLogger);
  const result = await client.hasTag(12345, 'pending');
  assert.strictEqual(result, true);
});

asyncTest('ST-HAS-002: Returns false when file does not have the tag', async () => {
  const nc = createMockNC(async () => ({
    text: () => Promise.resolve(SAMPLE_FILE_TAGS_XML)
  }));
  const client = new SystemTagsClient(TAG_CONFIG, nc, silentLogger);
  const result = await client.hasTag(12345, 'processed');
  assert.strictEqual(result, false);
});

// ============================================================
// Get File ID Tests
// ============================================================

console.log('\n--- Get File ID ---\n');

asyncTest('ST-FID-001: Resolves file ID from path via PROPFIND', async () => {
  const calls = [];
  const nc = {
    config: { nextcloud: { user: 'moltagent' } },
    request: async (path, options) => {
      calls.push({ path, options });
      return { text: () => Promise.resolve(SAMPLE_FILE_ID_XML) };
    }
  };
  const client = new SystemTagsClient(TAG_CONFIG, nc, silentLogger);
  const fileId = await client.getFileId('/Inbox/report.pdf');
  assert.strictEqual(fileId, 67890);
  assert.ok(calls[0].path.includes('/remote.php/dav/files/moltagent/Inbox/report.pdf'));
  assert.strictEqual(calls[0].options.method, 'PROPFIND');
});

asyncTest('ST-FID-002: Returns null when file not found', async () => {
  const nc = createMockNC(async () => {
    throw Object.assign(new Error('Not found'), { status: 404 });
  });
  const client = new SystemTagsClient(TAG_CONFIG, nc, silentLogger);
  const fileId = await client.getFileId('/nonexistent.txt');
  assert.strictEqual(fileId, null);
});

asyncTest('ST-FID-003: Returns null when PROPFIND response has no fileid', async () => {
  const nc = createMockNC(async () => ({
    text: () => Promise.resolve('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"></d:multistatus>')
  }));
  const client = new SystemTagsClient(TAG_CONFIG, nc, silentLogger);
  const fileId = await client.getFileId('/some/path');
  assert.strictEqual(fileId, null);
});

asyncTest('ST-FID-004: Uses custom user parameter when provided', async () => {
  const calls = [];
  const nc = {
    config: { nextcloud: { user: 'moltagent' } },
    request: async (path, options) => {
      calls.push({ path, options });
      return { text: () => Promise.resolve(SAMPLE_FILE_ID_XML) };
    }
  };
  const client = new SystemTagsClient(TAG_CONFIG, nc, silentLogger);
  await client.getFileId('/test.txt', 'alice');
  assert.ok(calls[0].path.includes('/remote.php/dav/files/alice/test.txt'));
});

// ============================================================
// Convenience Method Tests
// ============================================================

console.log('\n--- Convenience Methods ---\n');

asyncTest('ST-CONV-001: tagFileByPath resolves ID and assigns tag', async () => {
  let callCount = 0;
  const calls = [];
  const nc = {
    config: { nextcloud: { user: 'moltagent' } },
    request: async (path, options) => {
      callCount++;
      calls.push({ path, options });
      if (callCount === 1) return { text: () => Promise.resolve(SAMPLE_FILE_ID_XML) };
      return {};
    }
  };
  const client = new SystemTagsClient(TAG_CONFIG, nc, silentLogger);
  const result = await client.tagFileByPath('/Inbox/doc.pdf', 'ai-flagged');
  assert.strictEqual(result, true);
  assert.strictEqual(calls.length, 2);
});

asyncTest('ST-CONV-002: tagFileByPath returns false when file ID not found', async () => {
  const nc = createMockNC(async () => {
    throw Object.assign(new Error('Not found'), { status: 404 });
  });
  const client = new SystemTagsClient(TAG_CONFIG, nc, silentLogger);
  const result = await client.tagFileByPath('/nonexistent.pdf', 'pending');
  assert.strictEqual(result, false);
});

asyncTest('ST-CONV-003: transitionTagsByPath resolves ID and transitions', async () => {
  let callCount = 0;
  const calls = [];
  const nc = {
    config: { nextcloud: { user: 'moltagent' } },
    request: async (path, options) => {
      callCount++;
      calls.push({ path, options });
      if (callCount === 1) return { text: () => Promise.resolve(SAMPLE_FILE_ID_XML) };
      return {};
    }
  };
  const client = new SystemTagsClient(TAG_CONFIG, nc, silentLogger);
  const result = await client.transitionTagsByPath('/test.pdf', 'pending', 'processed');
  assert.strictEqual(result, true);
  assert.strictEqual(calls.length, 3);
});

asyncTest('ST-CONV-004: transitionTagsByPath returns false when file ID not found', async () => {
  const nc = createMockNC(async () => {
    throw Object.assign(new Error('Not found'), { status: 404 });
  });
  const client = new SystemTagsClient(TAG_CONFIG, nc, silentLogger);
  const result = await client.transitionTagsByPath('/nonexistent.pdf', 'pending', 'processed');
  assert.strictEqual(result, false);
});

// ============================================================
// Refresh Tag IDs Tests
// ============================================================

console.log('\n--- Refresh Tag IDs ---\n');

asyncTest('ST-REF-001: Refreshes tag mapping from NC', async () => {
  const nc = createMockNC(async () => ({
    text: () => Promise.resolve(SAMPLE_ALL_TAGS_XML)
  }));
  const client = new SystemTagsClient({ enabled: true, tagIds: {} }, nc, silentLogger);
  await client.refreshTagIds();
  assert.strictEqual(client.getTagId('custom-tag'), 99);
  assert.strictEqual(client.getTagName(99), 'custom-tag');
  assert.strictEqual(client.getTagId('another-tag'), 100);
});

asyncTest('ST-REF-002: Refresh replaces previous mappings', async () => {
  const nc = createMockNC(async () => ({
    text: () => Promise.resolve(SAMPLE_ALL_TAGS_XML)
  }));
  const client = new SystemTagsClient(TAG_CONFIG, nc, silentLogger);
  await client.refreshTagIds();
  assert.strictEqual(client.getTagId('pending'), null);
  assert.strictEqual(client.getTagId('custom-tag'), 99);
});

asyncTest('ST-REF-003: Returns updated Map', async () => {
  const nc = createMockNC(async () => ({
    text: () => Promise.resolve(SAMPLE_ALL_TAGS_XML)
  }));
  const client = new SystemTagsClient({ enabled: true, tagIds: {} }, nc, silentLogger);
  const result = await client.refreshTagIds();
  assert.ok(result instanceof Map);
  assert.strictEqual(result.get('custom-tag'), 99);
});

// ============================================================
// XML Parsing Tests
// ============================================================

console.log('\n--- XML Parsing ---\n');

test('ST-XML-001: Parses standard multistatus response', () => {
  const client = new SystemTagsClient(TAG_CONFIG, createMockNC(), silentLogger);
  const tags = client._parseTagsPropfind(SAMPLE_FILE_TAGS_XML);
  assert.strictEqual(tags.length, 2);
  assert.deepStrictEqual(tags[0], { name: 'pending', id: 2 });
  assert.deepStrictEqual(tags[1], { name: 'ai-flagged', id: 11 });
});

test('ST-XML-002: Returns empty array for response with no tag data', () => {
  const client = new SystemTagsClient(TAG_CONFIG, createMockNC(), silentLogger);
  const tags = client._parseTagsPropfind('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"></d:multistatus>');
  assert.strictEqual(tags.length, 0);
});

test('ST-XML-003: Handles XML with extra whitespace', () => {
  const client = new SystemTagsClient(TAG_CONFIG, createMockNC(), silentLogger);
  const xml = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:response>
    <d:propstat>
      <d:prop>
        <oc:display-name>pending</oc:display-name>
        <oc:id>2</oc:id>
      </d:prop>
    </d:propstat>
  </d:response>
</d:multistatus>`;
  const tags = client._parseTagsPropfind(xml);
  assert.strictEqual(tags.length, 1);
  assert.strictEqual(tags[0].name, 'pending');
  assert.strictEqual(tags[0].id, 2);
});

test('ST-XML-004: Handles empty string input', () => {
  const client = new SystemTagsClient(TAG_CONFIG, createMockNC(), silentLogger);
  const tags = client._parseTagsPropfind('');
  assert.strictEqual(tags.length, 0);
});

// ============================================================
// Constructor Tests
// ============================================================

console.log('\n--- Constructor ---\n');

test('ST-CTOR-001: Defaults to enabled when config.enabled is undefined', () => {
  const client = new SystemTagsClient({ tagIds: {} }, createMockNC(), silentLogger);
  assert.strictEqual(client.enabled, true);
});

test('ST-CTOR-002: Respects enabled: false', () => {
  const client = new SystemTagsClient({ enabled: false, tagIds: {} }, createMockNC(), silentLogger);
  assert.strictEqual(client.enabled, false);
});

test('ST-CTOR-003: Builds reverse mapping on construction', () => {
  const client = new SystemTagsClient(TAG_CONFIG, createMockNC(), silentLogger);
  assert.strictEqual(client.tagNames.get(2), 'pending');
  assert.strictEqual(client.tagNames.get(5), 'processed');
  assert.strictEqual(client.tagNames.get(8), 'needs-review');
  assert.strictEqual(client.tagNames.get(11), 'ai-flagged');
});

// ============================================================
// Summary
// ============================================================

setTimeout(() => {
  summary();
  exitWithCode();
}, 200);
