/**
 * NewsClient Unit Tests
 *
 * Tests the NC News API client: getFeeds, getItems, markItemRead.
 * Uses the same mock NCRequestManager pattern as deck-client tests.
 */

'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const { NewsClient, NewsApiError } = require('../../../src/lib/integrations/news-client');

// ─── Mock NCRequestManager ───────────────────────────────────────────

function createMockNC(responses = {}) {
  const calls = [];
  return {
    calls,
    request: async (path, opts) => {
      calls.push({ path, opts });
      const key = `${opts.method || 'GET'} ${path.split('?')[0]}`;
      const resp = responses[key];
      if (resp) return resp;
      return { status: 200, body: {} };
    }
  };
}

// ─── Tests ────────────────────────────────────────────────────────────

// Test 1: Constructor requires NCRequestManager
test('constructor throws without NCRequestManager', () => {
  try {
    new NewsClient(null);
    assert.fail('should throw');
  } catch (err) {
    assert.ok(err.message.includes('NCRequestManager'));
  }
});

test('constructor accepts valid NCRequestManager', () => {
  const nc = createMockNC();
  const client = new NewsClient(nc);
  assert.ok(client);
});

// Test 2: getFeeds returns feed array
asyncTest('getFeeds returns feeds array', async () => {
  const nc = createMockNC({
    'GET /apps/news/api/v1-3/feeds': {
      status: 200,
      body: {
        feeds: [
          { id: 1, title: 'Hacker News', url: 'https://hn.algolia.com/api/v1', unreadCount: 5 },
          { id: 2, title: 'TechCrunch', url: 'https://techcrunch.com/feed/', unreadCount: 12 }
        ]
      }
    }
  });
  const client = new NewsClient(nc);
  const feeds = await client.getFeeds();
  assert.strictEqual(feeds.length, 2);
  assert.strictEqual(feeds[0].title, 'Hacker News');
  assert.strictEqual(feeds[1].unreadCount, 12);
});

// Test 3: getFeeds returns empty array when no feeds
asyncTest('getFeeds returns empty array when no feeds', async () => {
  const nc = createMockNC({
    'GET /apps/news/api/v1-3/feeds': { status: 200, body: { feeds: [] } }
  });
  const client = new NewsClient(nc);
  const feeds = await client.getFeeds();
  assert.strictEqual(feeds.length, 0);
});

// Test 4: getItems returns items with default params
asyncTest('getItems returns items with default params', async () => {
  const nc = createMockNC({
    'GET /apps/news/api/v1-3/items': {
      status: 200,
      body: {
        items: [
          { id: 100, title: 'Test Article', url: 'https://example.com/article', feedTitle: 'Test Feed', unread: true },
          { id: 101, title: 'Another Article', url: 'https://example.com/another', feedTitle: 'Test Feed', unread: true }
        ]
      }
    }
  });
  const client = new NewsClient(nc);
  const items = await client.getItems();
  assert.strictEqual(items.length, 2);
  assert.strictEqual(items[0].title, 'Test Article');
  // Verify default params in URL
  const call = nc.calls[0];
  assert.ok(call.path.includes('batchSize=20'));
  assert.ok(call.path.includes('getRead=false'));
  assert.ok(call.path.includes('type=3'));
});

// Test 5: getItems passes custom batchSize
asyncTest('getItems passes custom batchSize', async () => {
  const nc = createMockNC({
    'GET /apps/news/api/v1-3/items': { status: 200, body: { items: [] } }
  });
  const client = new NewsClient(nc);
  await client.getItems({ batchSize: 50 });
  assert.ok(nc.calls[0].path.includes('batchSize=50'));
});

// Test 6: markItemRead sends POST request (managed NC proxy blocks PUT)
asyncTest('markItemRead sends POST to correct path', async () => {
  const nc = createMockNC({
    'POST /apps/news/api/v1-3/items/42/read': { status: 200, body: {} }
  });
  const client = new NewsClient(nc);
  await client.markItemRead(42);
  assert.strictEqual(nc.calls[0].opts.method, 'POST');
  assert.ok(nc.calls[0].path.includes('/items/42/read'));
});

// Test 6b: markAllRead sends POST with newestItemId body
asyncTest('markAllRead sends POST with newestItemId body', async () => {
  const nc = createMockNC({
    'POST /apps/news/api/v1-3/items/read': { status: 200, body: {} }
  });
  const client = new NewsClient(nc);
  await client.markAllRead(500);
  assert.strictEqual(nc.calls[0].opts.method, 'POST');
  assert.ok(nc.calls[0].path.includes('/items/read'));
  assert.deepStrictEqual(nc.calls[0].opts.body, { newestItemId: 500 });
});

// Test 7: markItemRead throws on null itemId
asyncTest('markItemRead throws on null itemId', async () => {
  const nc = createMockNC();
  const client = new NewsClient(nc);
  try {
    await client.markItemRead(null);
    assert.fail('should throw');
  } catch (err) {
    assert.ok(err.message.includes('itemId is required'));
  }
});

// Test 8: _request throws NewsApiError on HTTP error
asyncTest('_request throws NewsApiError on HTTP error', async () => {
  const nc = createMockNC({
    'GET /apps/news/api/v1-3/feeds': { status: 404, body: { message: 'Not Found' } }
  });
  const client = new NewsClient(nc);
  try {
    await client.getFeeds();
    assert.fail('should throw');
  } catch (err) {
    assert.ok(err instanceof NewsApiError);
    assert.strictEqual(err.statusCode, 404);
    assert.ok(err.message.includes('Not Found'));
  }
});

// Test 9: _request includes OCS-APIRequest header
asyncTest('_request includes OCS-APIRequest header', async () => {
  const nc = createMockNC({
    'GET /apps/news/api/v1-3/feeds': { status: 200, body: { feeds: [] } }
  });
  const client = new NewsClient(nc);
  await client.getFeeds();
  assert.strictEqual(nc.calls[0].opts.headers['OCS-APIRequest'], 'true');
});

setTimeout(() => {
  summary();
  exitWithCode();
}, 500);
