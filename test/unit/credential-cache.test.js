/**
 * CredentialCache Unit Tests
 *
 * Tests for the Credential Cache module.
 *
 * Run: node test/credential-cache.test.js
 */

const assert = require('assert');

// Mock NCRequestManager
class MockNCRequestManager {
  constructor() {
    this.requestCalls = [];
    this.mockResponses = {};
  }

  async request(url, options = {}) {
    this.requestCalls.push({ url, options });

    const key = `${options.method || 'GET'}:${url}`;
    if (this.mockResponses[key]) {
      return this.mockResponses[key];
    }

    // Default mock response for password list
    if (url.includes('password/list')) {
      return {
        status: 200,
        body: [
          { label: 'claude-api-key', password: 'sk-test-123', username: '' },
          { label: 'email-imap', password: 'imap-pass', username: 'user@test.com', url: 'imap.test.com', notes: '{"port": 993, "tls": true}' },
          { label: 'deepseek-api-key', password: 'ds-test-456', username: '' },
          { label: 'TEST-CRED', password: 'test-value', username: '' }
        ]
      };
    }

    return { status: 404, body: 'Not found' };
  }

  setMockResponse(method, url, response) {
    this.mockResponses[`${method}:${url}`] = response;
  }
}

const CredentialCache = require('../../src/lib/credential-cache');

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

console.log('\n=== CredentialCache Tests ===\n');

// Test 1: Single credential fetch
asyncTest('fetches single credential', async () => {
  const nc = new MockNCRequestManager();
  const cache = new CredentialCache(nc);

  const value = await cache.get('claude-api-key');

  assert.strictEqual(value, 'sk-test-123');
  assert.strictEqual(nc.requestCalls.length, 1);
});

// Test 2: Cache hit on second fetch
asyncTest('returns cached value on second fetch', async () => {
  const nc = new MockNCRequestManager();
  const cache = new CredentialCache(nc);

  await cache.get('claude-api-key');
  const value = await cache.get('claude-api-key');

  assert.strictEqual(value, 'sk-test-123');
  assert.strictEqual(nc.requestCalls.length, 1); // Only one request
});

// Test 3: Complex credential processing
asyncTest('processes complex credentials correctly', async () => {
  const nc = new MockNCRequestManager();
  const cache = new CredentialCache(nc);

  const value = await cache.get('email-imap');

  assert.strictEqual(typeof value, 'object');
  assert.strictEqual(value.password, 'imap-pass');
  assert.strictEqual(value.username, 'user@test.com');
  assert.strictEqual(value.host, 'imap.test.com');
  assert.strictEqual(value.port, 993);
  assert.strictEqual(value.tls, true);
});

// Test 4: Case-insensitive lookup
asyncTest('finds credentials case-insensitively', async () => {
  const nc = new MockNCRequestManager();
  const cache = new CredentialCache(nc);

  const value = await cache.get('test-cred'); // lowercase
  assert.strictEqual(value, 'test-value');
});

// Test 5: Prefetch multiple credentials
asyncTest('prefetchAll fetches multiple credentials in one call', async () => {
  const nc = new MockNCRequestManager();
  const cache = new CredentialCache(nc);

  const result = await cache.prefetchAll(['claude-api-key', 'deepseek-api-key']);

  assert.strictEqual(result['claude-api-key'], 'sk-test-123');
  assert.strictEqual(result['deepseek-api-key'], 'ds-test-456');
  assert.strictEqual(nc.requestCalls.length, 1); // Only one API call
});

// Test 6: Prefetch skips cached credentials
asyncTest('prefetchAll skips already cached credentials', async () => {
  const nc = new MockNCRequestManager();
  const cache = new CredentialCache(nc);

  // Pre-cache one credential
  await cache.get('claude-api-key');
  nc.requestCalls = []; // Reset call tracking

  const result = await cache.prefetchAll(['claude-api-key', 'deepseek-api-key']);

  assert.strictEqual(result['claude-api-key'], 'sk-test-123');
  assert.strictEqual(result['deepseek-api-key'], 'ds-test-456');
  // Should still make 1 call to refresh for non-cached credentials
  assert.strictEqual(nc.requestCalls.length, 1);
});

// Test 7: Prefetch returns empty object for empty input
asyncTest('prefetchAll returns empty object for empty list', async () => {
  const nc = new MockNCRequestManager();
  const cache = new CredentialCache(nc);

  const result = await cache.prefetchAll([]);

  assert.deepStrictEqual(result, {});
  assert.strictEqual(nc.requestCalls.length, 0);
});

// Test 8: Secure invalidation
asyncTest('invalidate securely overwrites value', async () => {
  const nc = new MockNCRequestManager();
  const cache = new CredentialCache(nc);

  await cache.get('claude-api-key');

  // Get the cached entry before invalidation
  const cachedBefore = cache._cache.get('claude-api-key');
  assert.strictEqual(cachedBefore.value, 'sk-test-123');

  cache.invalidate('claude-api-key');

  // Cache should be empty
  assert.strictEqual(cache._cache.has('claude-api-key'), false);
});

// Test 9: Invalidate all
asyncTest('invalidateAll clears all cached credentials', async () => {
  const nc = new MockNCRequestManager();
  const cache = new CredentialCache(nc);

  await cache.prefetchAll(['claude-api-key', 'deepseek-api-key']);
  assert.strictEqual(cache._cache.size, 2);

  cache.invalidateAll();

  assert.strictEqual(cache._cache.size, 0);
  assert.strictEqual(cache._allCredentials, null);
});

// Test 10: Credential not found
asyncTest('throws error for unknown credential', async () => {
  const nc = new MockNCRequestManager();
  const cache = new CredentialCache(nc);

  try {
    await cache.get('non-existent-credential');
    assert.fail('Should have thrown');
  } catch (error) {
    assert.ok(error.message.includes('not found'));
  }
});

// Test 11: getStats
asyncTest('getStats returns cache statistics', async () => {
  const nc = new MockNCRequestManager();
  const cache = new CredentialCache(nc);

  await cache.prefetchAll(['claude-api-key', 'deepseek-api-key']);

  const stats = cache.getStats();

  assert.strictEqual(stats.cacheSize, 2);
  assert.strictEqual(stats.allCredentialsCached, true);
});

// Test 12: Custom cache TTL
asyncTest('respects custom cache TTL', async () => {
  const nc = new MockNCRequestManager();
  const cache = new CredentialCache(nc, { cacheTTL: 100 }); // 100ms

  await cache.get('claude-api-key');

  // Wait for cache to expire
  await new Promise(r => setTimeout(r, 150));

  // Should fetch again
  await cache.get('claude-api-key');

  assert.strictEqual(nc.requestCalls.length, 2);
});

// Test 13: Shutdown
asyncTest('shutdown clears all caches', async () => {
  const nc = new MockNCRequestManager();
  const cache = new CredentialCache(nc);

  await cache.prefetchAll(['claude-api-key', 'deepseek-api-key']);

  cache.shutdown();

  assert.strictEqual(cache._cache.size, 0);
  assert.strictEqual(cache._allCredentials, null);
});

// Test 14: Host extraction
test('extracts hostname from URL', () => {
  const nc = new MockNCRequestManager();
  const cache = new CredentialCache(nc);

  assert.strictEqual(cache._extractHost('https://mail.example.com:993'), 'mail.example.com');
  assert.strictEqual(cache._extractHost('imap.test.com'), 'imap.test.com');
  assert.strictEqual(cache._extractHost(null), null);
});

// Test 15: Parse extras from notes
test('parses JSON from notes field', () => {
  const nc = new MockNCRequestManager();
  const cache = new CredentialCache(nc);

  const extras = cache._parseExtras({
    notes: '{"port": 993, "tls": true}'
  });

  assert.strictEqual(extras.port, 993);
  assert.strictEqual(extras.tls, true);
});

test('handles non-JSON notes gracefully', () => {
  const nc = new MockNCRequestManager();
  const cache = new CredentialCache(nc);

  const extras = cache._parseExtras({
    notes: 'This is just a plain note'
  });

  assert.deepStrictEqual(extras, {});
});

// Summary
setTimeout(() => {
  console.log('\n=================================');
  console.log(`Tests passed: ${testsPassed}`);
  console.log(`Tests failed: ${testsFailed}`);
  console.log('=================================\n');
  process.exit(testsFailed > 0 ? 1 : 0);
}, 200);
