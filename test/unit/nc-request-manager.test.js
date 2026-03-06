// Mock type: LEGACY — TODO: migrate to realistic mocks
/**
 * NCRequestManager Unit Tests
 *
 * Tests for the NC Request Manager module.
 *
 * Run: node test/nc-request-manager.test.js
 */

const assert = require('assert');
const path = require('path');

// Mock the fs module before requiring NCRequestManager
const originalReadFileSync = require('fs').readFileSync;
require('fs').readFileSync = function(path, encoding) {
  if (path.includes('nc-password')) {
    return 'test-password';
  }
  return originalReadFileSync.call(this, path, encoding);
};

const NCRequestManager = require('../../src/lib/nc-request-manager');

// Test helpers
let testsPassed = 0;
let testsFailed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    testsPassed++;
  } catch (error) {
    console.log(`✗ ${name}`);
    console.log(`  Error: ${error.message}`);
    testsFailed++;
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    testsPassed++;
  } catch (error) {
    console.log(`✗ ${name}`);
    console.log(`  Error: ${error.message}`);
    testsFailed++;
  }
}

// ============================================================
// Tests
// ============================================================

console.log('\n=== NCRequestManager Tests ===\n');

// Test 1: Endpoint classification
test('classifies passwords endpoint correctly', () => {
  const nc = new NCRequestManager({
    nextcloud: { url: 'https://example.com', username: 'test' }
  });
  const group = nc._classifyEndpoint('/index.php/apps/passwords/api/1.0/password/list');
  assert.strictEqual(group, 'passwords');
});

test('classifies caldav endpoint correctly', () => {
  const nc = new NCRequestManager({
    nextcloud: { url: 'https://example.com', username: 'test' }
  });
  const group = nc._classifyEndpoint('/remote.php/dav/calendars/user/personal/');
  assert.strictEqual(group, 'caldav');
});

test('classifies deck endpoint correctly', () => {
  const nc = new NCRequestManager({
    nextcloud: { url: 'https://example.com', username: 'test' }
  });
  const group = nc._classifyEndpoint('/index.php/apps/deck/api/v1.0/boards');
  assert.strictEqual(group, 'deck');
});

test('classifies webdav endpoint correctly', () => {
  const nc = new NCRequestManager({
    nextcloud: { url: 'https://example.com', username: 'test' }
  });
  const group = nc._classifyEndpoint('/remote.php/dav/files/user/Documents/');
  assert.strictEqual(group, 'webdav');
});

test('classifies talk endpoint correctly', () => {
  const nc = new NCRequestManager({
    nextcloud: { url: 'https://example.com', username: 'test' }
  });
  const group = nc._classifyEndpoint('/ocs/v2.php/apps/spreed/api/v1/chat/xyz');
  assert.strictEqual(group, 'talk');
});

test('classifies unknown endpoint as other', () => {
  const nc = new NCRequestManager({
    nextcloud: { url: 'https://example.com', username: 'test' }
  });
  const group = nc._classifyEndpoint('/some/unknown/path');
  assert.strictEqual(group, 'other');
});

// Test 2: Cache key generation
test('generates cache key for GET requests', () => {
  const nc = new NCRequestManager({
    nextcloud: { url: 'https://example.com', username: 'test' }
  });
  const key = nc._getCacheKey('https://example.com/api/test', { method: 'GET' });
  assert.strictEqual(key, 'GET:https://example.com/api/test');
});

test('generates cache key for PROPFIND requests', () => {
  const nc = new NCRequestManager({
    nextcloud: { url: 'https://example.com', username: 'test' }
  });
  const key = nc._getCacheKey('https://example.com/dav/calendars/', { method: 'PROPFIND' });
  assert.strictEqual(key, 'PROPFIND:https://example.com/dav/calendars/');
});

test('returns null cache key for POST requests', () => {
  const nc = new NCRequestManager({
    nextcloud: { url: 'https://example.com', username: 'test' }
  });
  const key = nc._getCacheKey('https://example.com/api/test', { method: 'POST' });
  assert.strictEqual(key, null);
});

test('returns null cache key for PUT requests', () => {
  const nc = new NCRequestManager({
    nextcloud: { url: 'https://example.com', username: 'test' }
  });
  const key = nc._getCacheKey('https://example.com/api/test', { method: 'PUT' });
  assert.strictEqual(key, null);
});

// Test 3: Read operation detection
test('GET is a read operation', () => {
  const nc = new NCRequestManager({
    nextcloud: { url: 'https://example.com', username: 'test' }
  });
  assert.strictEqual(nc._isReadOperation('GET'), true);
});

test('PROPFIND is a read operation', () => {
  const nc = new NCRequestManager({
    nextcloud: { url: 'https://example.com', username: 'test' }
  });
  assert.strictEqual(nc._isReadOperation('PROPFIND'), true);
});

test('POST is not a read operation', () => {
  const nc = new NCRequestManager({
    nextcloud: { url: 'https://example.com', username: 'test' }
  });
  assert.strictEqual(nc._isReadOperation('POST'), false);
});

test('PUT is not a read operation', () => {
  const nc = new NCRequestManager({
    nextcloud: { url: 'https://example.com', username: 'test' }
  });
  assert.strictEqual(nc._isReadOperation('PUT'), false);
});

test('DELETE is not a read operation', () => {
  const nc = new NCRequestManager({
    nextcloud: { url: 'https://example.com', username: 'test' }
  });
  assert.strictEqual(nc._isReadOperation('DELETE'), false);
});

// Test 4: Retry-After parsing
test('parses numeric Retry-After header', () => {
  const nc = new NCRequestManager({
    nextcloud: { url: 'https://example.com', username: 'test' }
  });
  const ms = nc._parseRetryAfter('60');
  assert.strictEqual(ms, 60000);
});

test('uses default when Retry-After is missing', () => {
  const nc = new NCRequestManager({
    nextcloud: { url: 'https://example.com', username: 'test' }
  });
  const ms = nc._parseRetryAfter(null);
  assert.strictEqual(ms, 30000); // default
});

// Test 5: Backoff management
test('tracks backoff state', () => {
  const nc = new NCRequestManager({
    nextcloud: { url: 'https://example.com', username: 'test' }
  });

  assert.strictEqual(nc._isInBackoff('passwords'), false);

  nc._setBackoff('passwords', 5000);
  assert.strictEqual(nc._isInBackoff('passwords'), true);

  nc._clearBackoff('passwords');
  assert.strictEqual(nc._isInBackoff('passwords'), false);
});

// Test 6: Queue management
test('sorts queue by priority', () => {
  const nc = new NCRequestManager({
    nextcloud: { url: 'https://example.com', username: 'test' }
  });

  nc.queue = [
    { priority: 2, enqueuedAt: 1, group: 'webdav' },  // low
    { priority: 0, enqueuedAt: 2, group: 'passwords' }, // high
    { priority: 1, enqueuedAt: 3, group: 'caldav' }   // normal
  ];

  nc._sortQueue();

  assert.strictEqual(nc.queue[0].priority, 0); // high first
  assert.strictEqual(nc.queue[1].priority, 1); // normal second
  assert.strictEqual(nc.queue[2].priority, 2); // low last
});

test('sorts by enqueue time within same priority', () => {
  const nc = new NCRequestManager({
    nextcloud: { url: 'https://example.com', username: 'test' }
  });

  nc.queue = [
    { priority: 1, enqueuedAt: 3, group: 'caldav' },
    { priority: 1, enqueuedAt: 1, group: 'deck' },
    { priority: 1, enqueuedAt: 2, group: 'talk' }
  ];

  nc._sortQueue();

  assert.strictEqual(nc.queue[0].enqueuedAt, 1); // oldest first
  assert.strictEqual(nc.queue[1].enqueuedAt, 2);
  assert.strictEqual(nc.queue[2].enqueuedAt, 3);
});

// Test 7: Metrics
test('initializes metrics correctly', () => {
  const nc = new NCRequestManager({
    nextcloud: { url: 'https://example.com', username: 'test' }
  });

  assert.strictEqual(nc.metrics.totalRequests, 0);
  assert.strictEqual(nc.metrics.cacheHits, 0);
  assert.strictEqual(nc.metrics.rateLimited, 0);
  assert.ok(nc.metrics.byGroup.passwords);
  assert.ok(nc.metrics.byGroup.caldav);
  assert.ok(nc.metrics.byGroup.deck);
});

test('getMetrics returns formatted stats', () => {
  const nc = new NCRequestManager({
    nextcloud: { url: 'https://example.com', username: 'test' }
  });

  const metrics = nc.getMetrics();

  assert.ok('hitRate' in metrics);
  assert.ok('cacheSize' in metrics);
  assert.ok('queueLength' in metrics);
  assert.ok('activeRequests' in metrics);
  assert.ok('backoffGroups' in metrics);
});

// Test 8: Configuration
test('uses default configuration', () => {
  const nc = new NCRequestManager({
    nextcloud: { url: 'https://example.com', username: 'test' }
  });

  assert.strictEqual(nc.maxConcurrent, 4);
  assert.strictEqual(nc.defaultRetryAfter, 30000);
  assert.strictEqual(nc.maxQueueSize, 1000);
});

test('accepts custom configuration', () => {
  const nc = new NCRequestManager({
    nextcloud: { url: 'https://example.com', username: 'test' },
    ncResilience: {
      maxConcurrent: 8,
      defaultRetryAfter: 60000,
      maxQueueSize: 500
    }
  });

  assert.strictEqual(nc.maxConcurrent, 8);
  assert.strictEqual(nc.defaultRetryAfter, 60000);
  assert.strictEqual(nc.maxQueueSize, 500);
});

// Test 9: URL handling
test('handles relative URLs', () => {
  const nc = new NCRequestManager({
    nextcloud: { url: 'https://example.com', username: 'test' }
  });

  // The URL prefix would be added in request()
  const group = nc._classifyEndpoint('/apps/passwords/api/1.0/password/list');
  assert.strictEqual(group, 'passwords');
});

test('handles full URLs', () => {
  const nc = new NCRequestManager({
    nextcloud: { url: 'https://example.com', username: 'test' }
  });

  const group = nc._classifyEndpoint('https://other.com/apps/passwords/api/1.0/password/list');
  assert.strictEqual(group, 'passwords');
});

// Test 10: Cache invalidation
test('invalidates specific cache entries', () => {
  const nc = new NCRequestManager({
    nextcloud: { url: 'https://example.com', username: 'test' }
  });

  // Manually add cache entries
  nc.cache.set('GET:https://example.com/api/test', { response: {}, expiry: Date.now() + 60000 });
  nc.cache.set('GET:https://example.com/api/other', { response: {}, expiry: Date.now() + 60000 });

  assert.strictEqual(nc.cache.size, 2);

  nc.invalidateCache('/api/test');

  assert.strictEqual(nc.cache.size, 1);
  assert.ok(!nc.cache.has('GET:https://example.com/api/test'));
  assert.ok(nc.cache.has('GET:https://example.com/api/other'));
});

test('clears all cache entries', () => {
  const nc = new NCRequestManager({
    nextcloud: { url: 'https://example.com', username: 'test' }
  });

  nc.cache.set('key1', { response: {}, expiry: Date.now() + 60000 });
  nc.cache.set('key2', { response: {}, expiry: Date.now() + 60000 });

  nc.invalidateCache();

  assert.strictEqual(nc.cache.size, 0);
});

// Test 11: Group configuration
test('gets correct group config for passwords', () => {
  const nc = new NCRequestManager({
    nextcloud: { url: 'https://example.com', username: 'test' }
  });

  const config = nc._getGroupConfig('passwords');

  assert.strictEqual(config.cacheTTL, 5 * 60 * 1000); // 5 minutes
  assert.strictEqual(config.priority, 'high');
});

test('gets correct group config for talk', () => {
  const nc = new NCRequestManager({
    nextcloud: { url: 'https://example.com', username: 'test' }
  });

  const config = nc._getGroupConfig('talk');

  assert.strictEqual(config.cacheTTL, 5 * 1000); // 5 seconds
  assert.strictEqual(config.priority, 'normal');
});

test('returns default config for unknown groups', () => {
  const nc = new NCRequestManager({
    nextcloud: { url: 'https://example.com', username: 'test' }
  });

  const config = nc._getGroupConfig('unknown');

  assert.ok(config.cacheTTL > 0);
  assert.strictEqual(config.priority, 'normal');
});

// Test 12: resolveCanonicalUsername
asyncTest('resolveCanonicalUsername updates ncUser when server returns different case', async () => {
  const http = require('http');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ocs: {
        data: { id: 'Moltagent', displayname: 'Moltagent', email: '' }
      }
    }));
  });
  await new Promise(resolve => server.listen(19880, resolve));

  const nc = new NCRequestManager({
    nextcloud: { url: 'http://localhost:19880', username: 'moltagent' }
  });
  nc.ncPassword = 'test';

  try {
    assert.strictEqual(nc.ncUser, 'moltagent');
    await nc.resolveCanonicalUsername();
    assert.strictEqual(nc.ncUser, 'Moltagent');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

asyncTest('resolveCanonicalUsername keeps original if server returns same case', async () => {
  const http = require('http');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ocs: { data: { id: 'testuser' } }
    }));
  });
  await new Promise(resolve => server.listen(19881, resolve));

  const nc = new NCRequestManager({
    nextcloud: { url: 'http://localhost:19881', username: 'testuser' }
  });
  nc.ncPassword = 'test';

  try {
    await nc.resolveCanonicalUsername();
    assert.strictEqual(nc.ncUser, 'testuser');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

asyncTest('resolveCanonicalUsername continues on error (non-fatal)', async () => {
  const nc = new NCRequestManager({
    nextcloud: { url: 'http://localhost:19999', username: 'moltagent' }
  });
  nc.ncPassword = 'test';

  // No server listening on 19999 — should warn but not throw
  await nc.resolveCanonicalUsername();
  assert.strictEqual(nc.ncUser, 'moltagent'); // Unchanged
});

// Test 13: Shutdown
asyncTest('shutdown clears state', async () => {
  const nc = new NCRequestManager({
    nextcloud: { url: 'https://example.com', username: 'test' }
  });

  nc.cache.set('key1', { response: {}, expiry: Date.now() + 60000 });
  nc._setBackoff('passwords', 5000);
  nc.ncPassword = 'secret';

  await nc.shutdown();

  assert.strictEqual(nc.cache.size, 0);
  assert.strictEqual(nc.backoff.size, 0);
  assert.strictEqual(nc.ncPassword, null);
  assert.strictEqual(nc._shuttingDown, true);
});

// Test 13: 404 responses are resolved, not rejected
asyncTest('404 responses resolve normally for caller handling', async () => {
  const nc = new NCRequestManager({
    nextcloud: { url: 'http://localhost:19876', username: 'test' }
  });
  nc.ncPassword = 'test';

  // Start a minimal HTTP server that returns 404
  const http = require('http');
  const server = http.createServer((req, res) => {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });
  await new Promise(resolve => server.listen(19876, resolve));

  try {
    const response = await nc.request('/remote.php/dav/files/test/missing', { method: 'GET' });
    assert.strictEqual(response.status, 404);
    assert.strictEqual(response.fromCache, false);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

// ============================================================
// 429 Retry Tests (NC API path)
// ============================================================

console.log('\n--- 429 Retry Tests ---\n');

asyncTest('retries on 429 and succeeds on next attempt', async () => {
  let requestCount = 0;
  const http = require('http');
  const server = http.createServer((req, res) => {
    requestCount++;
    if (requestCount === 1) {
      res.writeHead(429, { 'Retry-After': '1', 'Content-Type': 'text/plain' });
      res.end('Rate limited');
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    }
  });
  await new Promise(resolve => server.listen(19877, resolve));

  const nc = new NCRequestManager({
    nextcloud: { url: 'http://localhost:19877', username: 'test' }
  });
  nc.ncPassword = 'test';

  try {
    const response = await nc.request('/ocs/v2.php/test', { method: 'GET' });
    assert.strictEqual(response.status, 200);
    assert.ok(requestCount >= 2, `Expected at least 2 requests, got ${requestCount}`);
    assert.ok(nc.metrics.rateLimited >= 1, 'Should track rate limit in metrics');
    assert.ok(nc.metrics.retries >= 1, 'Should track retry in metrics');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

asyncTest('gives up after maxRetries on persistent 429', async () => {
  const http = require('http');
  const server = http.createServer((req, res) => {
    res.writeHead(429, { 'Content-Type': 'text/plain' });
    res.end('Rate limited');
  });
  await new Promise(resolve => server.listen(19878, resolve));

  const nc = new NCRequestManager({
    nextcloud: { url: 'http://localhost:19878', username: 'test' },
    ncResilience: { defaultRetryAfter: 100 }  // Short backoff for test
  });
  nc.ncPassword = 'test';

  try {
    await nc.request('/ocs/v2.php/test', { method: 'GET' });
    assert.fail('Should have rejected');
  } catch (err) {
    assert.ok(err.message.includes('Rate limited'), `Got: ${err.message}`);
    assert.ok(nc.metrics.failures >= 1, 'Should track failure in metrics');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

asyncTest('serves stale cache on 429 for read operations', async () => {
  let requestCount = 0;
  const http = require('http');
  const server = http.createServer((req, res) => {
    requestCount++;
    if (requestCount === 1) {
      // First request: return fresh data
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: 'fresh' }));
    } else {
      // Subsequent requests: 429
      res.writeHead(429, { 'Retry-After': '1', 'Content-Type': 'text/plain' });
      res.end('Rate limited');
    }
  });
  await new Promise(resolve => server.listen(19879, resolve));

  const nc = new NCRequestManager({
    nextcloud: { url: 'http://localhost:19879', username: 'test' }
  });
  nc.ncPassword = 'test';

  try {
    // First request — caches the result
    const first = await nc.request('/ocs/v2.php/test', { method: 'GET' });
    assert.strictEqual(first.status, 200);

    // Expire the cache but keep stale window
    const cacheKey = 'GET:http://localhost:19879/ocs/v2.php/test';
    const cached = nc.cache.get(cacheKey);
    if (cached) {
      cached.expiry = Date.now() - 1; // Expired but staleUntil still valid
    }

    // Second request — should get stale cache back after 429
    const second = await nc.request('/ocs/v2.php/test', { method: 'GET', skipCache: false });
    // It should either be from stale cache or a retry success
    assert.ok(second.status === 200, 'Should resolve with 200 (stale or retry)');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('parseRetryAfter handles seconds format', () => {
  const nc = new NCRequestManager({
    nextcloud: { url: 'https://example.com', username: 'test' }
  });
  assert.strictEqual(nc._parseRetryAfter('60'), 60000);
});

test('parseRetryAfter handles HTTP-date format', () => {
  const nc = new NCRequestManager({
    nextcloud: { url: 'https://example.com', username: 'test' }
  });

  const futureDate = new Date(Date.now() + 10000).toUTCString();
  const ms = nc._parseRetryAfter(futureDate);
  assert.ok(ms >= 8000 && ms <= 11000, `Expected ~10000ms, got ${ms}ms`);
});

test('parseRetryAfter returns default for unparseable value', () => {
  const nc = new NCRequestManager({
    nextcloud: { url: 'https://example.com', username: 'test' }
  });
  const ms = nc._parseRetryAfter('garbage');
  assert.strictEqual(ms, 30000);
});

// Summary
setTimeout(() => {
  console.log('\n=================================');
  console.log(`Tests passed: ${testsPassed}`);
  console.log(`Tests failed: ${testsFailed}`);
  console.log('=================================\n');
  process.exit(testsFailed > 0 ? 1 : 0);
}, 100);
