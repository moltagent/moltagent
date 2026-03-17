// Mock type: LEGACY — TODO: migrate to realistic mocks
/**
 * CollectivesClient Bootstrap & Sharing Unit Tests
 *
 * Run: node test/unit/integrations/collectives-bootstrap.test.js
 *
 * @module test/unit/integrations/collectives-bootstrap
 */

const assert = require('assert');
const { asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const { createMockNCRequestManager } = require('../../helpers/mock-factories');

const CollectivesClient = require('../../../src/lib/integrations/collectives-client');

// ============================================================
// Test Fixtures
// ============================================================

const COLLECTIVE = { id: 10, name: 'Moltagent Knowledge', circleId: 'circle-abc-123' };
const LANDING_PAGE = { id: 1, title: 'Landing page', parentId: 0 };

// Build a mock NC that tracks createPage and writePageContent calls
function createBootstrapMock(existingPages = [], opts = {}) {
  const calls = { createPage: [], writeContent: [], circles: [] };
  let pageIdCounter = 500;
  // Always include the landing page — Collectives API always has one
  let currentPages = [LANDING_PAGE, ...existingPages];

  const responses = {
    // listCollectives
    'GET:/ocs/v2.php/apps/collectives/api/v1.0/collectives': {
      status: 200,
      body: { ocs: { data: [COLLECTIVE] } },
      headers: {}
    },
    // listPages — returns current snapshot
    'GET:/ocs/v2.php/apps/collectives/api/v1.0/collectives/10/pages': () => ({
      status: 200,
      body: { ocs: { data: [...currentPages] } },
      headers: {}
    })
  };

  // createPage under landing page (parentId 1) — ensureSection routes here
  responses[`POST:/ocs/v2.php/apps/collectives/api/v1.0/collectives/10/pages/${LANDING_PAGE.id}`] = (path, options) => {
    const body = JSON.parse(options.body);
    if (opts.failOn && opts.failOn.includes(body.title)) {
      return { status: 500, body: { message: 'Server error' }, headers: {} };
    }
    const newPage = { id: pageIdCounter++, title: body.title, parentId: LANDING_PAGE.id, fileName: `${body.title}.md`, filePath: '' };
    calls.createPage.push(body.title);
    currentPages.push(newPage);
    return { status: 200, body: { ocs: { data: newPage } }, headers: {} };
  };

  // createPage under Meta (dynamic parentId)
  // We need a catch-all for any parentId — use the mock's request method directly
  const baseMock = createMockNCRequestManager(responses);

  // Override request to handle dynamic createPage parent IDs and WebDAV writes
  const origRequest = baseMock.request;
  baseMock.request = async (url, options = {}) => {
    const method = options.method || 'GET';

    // Handle createPage for any parentId
    const createMatch = url.match(/\/collectives\/10\/pages\/(\d+)$/);
    if (method === 'POST' && createMatch) {
      const parentId = parseInt(createMatch[1]);
      const body = JSON.parse(options.body);
      if (opts.failOn && opts.failOn.includes(body.title)) {
        return { status: 500, body: { message: 'Server error' }, headers: {} };
      }
      const newPage = { id: pageIdCounter++, title: body.title, parentId, fileName: `${body.title}.md`, filePath: '' };
      calls.createPage.push(body.title);
      currentPages.push(newPage);
      return { status: 200, body: { ocs: { data: newPage } }, headers: {} };
    }

    // Handle WebDAV PUTs
    if (method === 'PUT' && url.includes('/remote.php/dav/')) {
      calls.writeContent.push(url);
      return { status: 201, body: '', headers: {} };
    }

    // Handle Circles API
    if (method === 'POST' && url.includes('/apps/circles/circles/')) {
      calls.circles.push({ url, body: JSON.parse(options.body) });
      if (opts.circleStatus === 400) {
        // NCRequestManager rejects 400s with this error format
        throw new Error('HTTP 400: Bad request');
      }
      if (opts.circleStatus) {
        return { status: opts.circleStatus, body: { ocs: { data: {} } }, headers: {} };
      }
      return { status: 200, body: { ocs: { data: {} } }, headers: {} };
    }

    return origRequest(url, options);
  };

  baseMock._calls = calls;
  return baseMock;
}

// ============================================================
// Tests
// ============================================================

console.log('CollectivesClient Bootstrap & Sharing Tests\n');

// -- bootstrapDefaultPages --

asyncTest('bootstrap: empty collective creates all 5 sections + 3 meta subpages', async () => {
  const mockNC = createBootstrapMock([]);
  const client = new CollectivesClient(mockNC);

  const result = await client.bootstrapDefaultPages();

  assert.strictEqual(result.created.length, 8,
    `Expected 8 created, got ${result.created.length}: ${result.created.join(', ')}`);
  assert.strictEqual(result.skipped.length, 0);
  assert.strictEqual(result.errors.length, 0);

  // Check section pages created
  assert.ok(result.created.includes('People'));
  assert.ok(result.created.includes('Projects'));
  assert.ok(result.created.includes('Procedures'));
  assert.ok(result.created.includes('Research'));
  assert.ok(result.created.includes('Meta'));

  // Check meta subpages created
  assert.ok(result.created.includes('Meta/Learning Log'));
  assert.ok(result.created.includes('Meta/Pending Questions'));
  assert.ok(result.created.includes('Meta/Knowledge Stats'));

  // Verify createPage was called 8 times
  assert.strictEqual(mockNC._calls.createPage.length, 8);

  // Verify WebDAV writes happened for each page
  assert.strictEqual(mockNC._calls.writeContent.length, 8);
});

asyncTest('bootstrap: partially populated skips existing, creates missing', async () => {
  // People and Meta already exist, plus Learning Log under Meta
  const existingPages = [
    { id: 100, title: 'People', parentId: LANDING_PAGE.id },
    { id: 102, title: 'Meta', parentId: LANDING_PAGE.id },
    { id: 300, title: 'Learning Log', parentId: 102 }
  ];
  const mockNC = createBootstrapMock(existingPages);
  const client = new CollectivesClient(mockNC);

  const result = await client.bootstrapDefaultPages();

  // Should skip People, Meta, Meta/Learning Log
  assert.ok(result.skipped.includes('People'));
  assert.ok(result.skipped.includes('Meta'));
  assert.ok(result.skipped.includes('Meta/Learning Log'));

  // Should create Projects, Procedures, Research, Meta/Pending Questions, Meta/Knowledge Stats
  assert.ok(result.created.includes('Projects'));
  assert.ok(result.created.includes('Procedures'));
  assert.ok(result.created.includes('Research'));
  assert.ok(result.created.includes('Meta/Pending Questions'));
  assert.ok(result.created.includes('Meta/Knowledge Stats'));

  assert.strictEqual(result.errors.length, 0);
  assert.strictEqual(result.created.length, 5);
  assert.strictEqual(result.skipped.length, 3);
});

asyncTest('bootstrap: partial failure — one page throws, others still created', async () => {
  const mockNC = createBootstrapMock([], { failOn: ['Procedures'] });
  const client = new CollectivesClient(mockNC);

  const result = await client.bootstrapDefaultPages();

  // Procedures should fail
  assert.strictEqual(result.errors.length, 1);
  assert.strictEqual(result.errors[0].title, 'Procedures');

  // Other sections and meta subpages should succeed
  assert.ok(result.created.includes('People'));
  assert.ok(result.created.includes('Projects'));
  assert.ok(result.created.includes('Research'));
  assert.ok(result.created.includes('Meta'));
  assert.ok(result.created.includes('Meta/Learning Log'));
  assert.ok(result.created.includes('Meta/Pending Questions'));
  assert.ok(result.created.includes('Meta/Knowledge Stats'));

  assert.strictEqual(result.created.length, 7);
});

asyncTest('bootstrap: fully populated — all skipped, createPage never called', async () => {
  const metaId = 104;
  const allPages = [
    { id: 100, title: 'People', parentId: LANDING_PAGE.id },
    { id: 101, title: 'Projects', parentId: LANDING_PAGE.id },
    { id: 102, title: 'Procedures', parentId: LANDING_PAGE.id },
    { id: 103, title: 'Research', parentId: LANDING_PAGE.id },
    { id: metaId, title: 'Meta', parentId: LANDING_PAGE.id },
    { id: 200, title: 'Learning Log', parentId: metaId },
    { id: 201, title: 'Pending Questions', parentId: metaId },
    { id: 202, title: 'Knowledge Stats', parentId: metaId }
  ];
  const mockNC = createBootstrapMock(allPages);
  const client = new CollectivesClient(mockNC);

  const result = await client.bootstrapDefaultPages();

  assert.strictEqual(result.created.length, 0);
  assert.strictEqual(result.skipped.length, 8);
  assert.strictEqual(result.errors.length, 0);
  assert.strictEqual(mockNC._calls.createPage.length, 0, 'createPage should never be called');
});

// -- shareWithAdmin --

asyncTest('shareWithAdmin sends correct Circles API call', async () => {
  const mockNC = createBootstrapMock([]);
  const client = new CollectivesClient(mockNC);

  const result = await client.shareWithAdmin('Funana');

  assert.strictEqual(result.success, true);
  assert.ok(result.message.includes('Funana'));

  // Verify Circles API was called with correct body
  assert.strictEqual(mockNC._calls.circles.length, 1);
  assert.strictEqual(mockNC._calls.circles[0].body.userId, 'Funana');
  assert.strictEqual(mockNC._calls.circles[0].body.type, 1);
  assert.ok(mockNC._calls.circles[0].url.includes('circle-abc-123'));
});

asyncTest('shareWithAdmin with already-member returns success', async () => {
  const mockNC = createBootstrapMock([], { circleStatus: 400 });
  const client = new CollectivesClient(mockNC);

  const result = await client.shareWithAdmin('Funana');

  assert.strictEqual(result.success, true);
  assert.ok(result.message.includes('already a member'));
});

asyncTest('shareWithAdmin with empty username returns failure', async () => {
  const mockNC = createBootstrapMock([]);
  const client = new CollectivesClient(mockNC);

  const result = await client.shareWithAdmin('');

  assert.strictEqual(result.success, false);
  assert.ok(result.message.includes('No admin username'));
});

// ============================================================
// Summary
// ============================================================

setTimeout(() => {
  summary();
  exitWithCode();
}, 500);
