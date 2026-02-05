/**
 * NCSearchClient Unit Tests
 *
 * Run: node test/unit/integrations/nc-search-client.test.js
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

const { NCSearchClient } = require('../../../src/lib/integrations/nc-search-client');

// ============================================================
// Mock NCRequestManager
// ============================================================

function createMockNCRM() {
  return {
    ncUrl: 'https://nc.example.com',
    ncUser: 'moltagent',
    request: async (path, options = {}) => {
      // Search results per provider (check this FIRST — more specific path)
      if (path.includes('/search?term=')) {
        const providerId = path.match(/providers\/([^/]+)\//)?.[1] || 'unknown';
        if (providerId === 'failing') {
          throw new Error('Provider unavailable');
        }
        return {
          status: 200,
          headers: {},
          body: {
            ocs: {
              data: {
                entries: [
                  { title: `Result from ${providerId}`, subline: 'test match', resourceUrl: `/apps/${providerId}/1` }
                ]
              }
            }
          }
        };
      }

      // Providers list (less specific — match after search)
      if (path.includes('/search/providers')) {
        return {
          status: 200,
          headers: {},
          body: {
            ocs: {
              data: [
                { id: 'files', name: 'Files' },
                { id: 'deck', name: 'Deck' },
                { id: 'calendar', name: 'Calendar' }
              ]
            }
          }
        };
      }

      return { status: 200, headers: {}, body: {} };
    }
  };
}

console.log('\n=== NCSearchClient Tests ===\n');

// ============================================================
// getProviders
// ============================================================

asyncTest('getProviders fetches OCS providers', async () => {
  const nc = createMockNCRM();
  const client = new NCSearchClient(nc);
  const providers = await client.getProviders();
  assert.ok(Array.isArray(providers));
  assert.strictEqual(providers.length, 3);
  assert.strictEqual(providers[0].id, 'files');
  assert.strictEqual(providers[1].id, 'deck');
});

asyncTest('getProviders caches result', async () => {
  let callCount = 0;
  const nc = createMockNCRM();
  const origRequest = nc.request;
  nc.request = async (...args) => {
    callCount++;
    return origRequest(...args);
  };

  const client = new NCSearchClient(nc);
  await client.getProviders();
  const before = callCount;
  await client.getProviders();
  assert.strictEqual(callCount, before, 'Should not make additional request (cached)');
});

// ============================================================
// searchProvider
// ============================================================

asyncTest('searchProvider URL encodes term', async () => {
  let capturedPath;
  const nc = createMockNCRM();
  const origRequest = nc.request;
  nc.request = async (path, options) => {
    capturedPath = path;
    return origRequest(path, options);
  };

  const client = new NCSearchClient(nc);
  await client.searchProvider('files', 'hello world', 5);
  assert.ok(capturedPath.includes('hello%20world'), `Path should contain encoded term: ${capturedPath}`);
});

// ============================================================
// search
// ============================================================

asyncTest('search merges results from all providers', async () => {
  const nc = createMockNCRM();
  const client = new NCSearchClient(nc);
  const results = await client.search('test');
  assert.ok(results.length >= 3, `Expected >= 3 results, got ${results.length}`);
  assert.ok(results.some(r => r.provider === 'Files'));
  assert.ok(results.some(r => r.provider === 'Deck'));
  assert.ok(results.some(r => r.provider === 'Calendar'));
});

asyncTest('search filters to specified providers', async () => {
  const nc = createMockNCRM();
  const client = new NCSearchClient(nc);
  const results = await client.search('test', ['files'], 5);
  assert.ok(results.length >= 1);
  // Only 'files' provider results (provider name defaults to id when using explicit list)
  assert.ok(results.every(r => r.provider === 'files'));
});

asyncTest('search handles failures gracefully', async () => {
  const nc = createMockNCRM();
  const client = new NCSearchClient(nc);
  // Search with a mix of valid and failing providers
  const results = await client.search('test', ['files', 'failing'], 5);
  // Should still return results from the working provider
  assert.ok(results.length >= 1);
  assert.ok(results.some(r => r.provider === 'files'));
});

asyncTest('search returns empty array for no results', async () => {
  const nc = {
    ncUrl: 'https://nc.example.com',
    ncUser: 'moltagent',
    request: async (path) => {
      if (path.includes('/search/providers') && !path.includes('/search?')) {
        return { status: 200, headers: {}, body: { ocs: { data: [] } } };
      }
      return { status: 200, headers: {}, body: {} };
    }
  };
  const client = new NCSearchClient(nc);
  const results = await client.search('nothing');
  assert.ok(Array.isArray(results));
  assert.strictEqual(results.length, 0);
});

// ============================================================
// Summary
// ============================================================

setTimeout(() => {
  summary();
  exitWithCode();
}, 500);
