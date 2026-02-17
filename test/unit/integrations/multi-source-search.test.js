/**
 * Multi-Source Search Unit Tests
 *
 * Run: node test/unit/integrations/multi-source-search.test.js
 *
 * @module test/unit/integrations/multi-source-search
 */

const assert = require('assert');
const { asyncTest, test, summary, exitWithCode } = require('../../helpers/test-runner');

const { multiSourceSearch, normalizeUrl } = require('../../../src/lib/integrations/search-provider-adapters');

// ============================================================
// Test Fixtures
// ============================================================

function mockProvider(source, results) {
  return {
    source,
    search: async () => results
  };
}

function failingProvider(source) {
  return {
    source,
    search: async () => { throw new Error(`${source} failed`); }
  };
}

// ============================================================
// Tests
// ============================================================

console.log('\n=== Multi-Source Search Tests ===\n');

(async () => {
  await asyncTest('multiSourceSearch deduplicates by normalized URL', async () => {
    const providerA = mockProvider('searxng', [
      { title: 'Node.js', url: 'https://nodejs.org/', snippet: 'Short', source: 'searxng', score: 0.8 },
      { title: 'Express', url: 'https://expressjs.com', snippet: 'Framework', source: 'searxng', score: 0.7 }
    ]);
    const providerB = mockProvider('brave', [
      { title: 'Node.js Official', url: 'https://www.nodejs.org', snippet: 'Longer description of Node.js runtime', source: 'brave', score: 0.9 },
      { title: 'Deno', url: 'https://deno.land', snippet: 'Deno runtime', source: 'brave', score: 0.6 }
    ]);

    const results = await multiSourceSearch([providerA, providerB], 'node.js', 10);

    // nodejs.org and www.nodejs.org should be deduplicated
    const nodeResults = results.filter(r => normalizeUrl(r.url).includes('nodejs.org'));
    assert.strictEqual(nodeResults.length, 1, 'Should have 1 deduplicated Node.js result');
    assert.strictEqual(results.length, 3, 'Should have 3 unique results');
  });

  await asyncTest('Multi-source results get score boost', async () => {
    const providerA = mockProvider('searxng', [
      { title: 'Node.js', url: 'https://nodejs.org', snippet: 'Runtime', source: 'searxng', score: 0.8 }
    ]);
    const providerB = mockProvider('brave', [
      { title: 'Node.js Official', url: 'https://nodejs.org/', snippet: 'JS Runtime', source: 'brave', score: 0.7 }
    ]);

    const results = await multiSourceSearch([providerA, providerB], 'node.js');

    assert.strictEqual(results.length, 1, 'Should deduplicate to 1 result');
    // Original score 0.8 + 0.2 boost = 1.0
    assert.ok(results[0].score >= 1.0, `Score should be boosted (got ${results[0].score})`);
    assert.deepStrictEqual(results[0].sources, ['searxng', 'brave']);
  });

  await asyncTest('SearXNG results survive when other providers fail', async () => {
    const searxng = mockProvider('searxng', [
      { title: 'Result 1', url: 'https://example.com', snippet: 'Test', source: 'searxng', score: 0.9 }
    ]);
    const broken = failingProvider('brave');

    const results = await multiSourceSearch([searxng, broken], 'test');

    assert.strictEqual(results.length, 1, 'SearXNG result should survive');
    assert.strictEqual(results[0].source, 'searxng');
  });

  await asyncTest('Empty provider list returns empty results', async () => {
    const results = await multiSourceSearch([], 'test');
    assert.strictEqual(results.length, 0);

    const nullResults = await multiSourceSearch(null, 'test');
    assert.strictEqual(nullResults.length, 0);
  });

  summary();
  exitWithCode();
})();
