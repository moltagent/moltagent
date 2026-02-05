/**
 * SearXNG Client Unit Tests
 *
 * Run: node test/unit/integrations/searxng-client.test.js
 *
 * @module test/unit/integrations/searxng-client
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

// Import module under test
const { SearXNGClient, SearXNGError } = require('../../../src/lib/integrations/searxng-client');

// ============================================================
// Test Fixtures
// ============================================================

const SAMPLE_RESULTS = {
  results: [
    { title: 'Node.js Docs', url: 'https://nodejs.org/docs', content: 'Official documentation', engine: 'google', score: 1.0 },
    { title: 'MDN Web Docs', url: 'https://developer.mozilla.org', content: 'Web reference', engine: 'duckduckgo', score: 0.9 },
    { title: 'Stack Overflow', url: 'https://stackoverflow.com', content: 'Q&A site', engine: 'google', score: 0.8 },
    { title: 'GitHub', url: 'https://github.com', content: 'Code hosting', engine: 'google', score: 0.7 },
    { title: 'npm', url: 'https://npmjs.com', content: 'Package registry', engine: 'google', score: 0.6 },
    { title: 'Extra Result', url: 'https://extra.com', content: 'Beyond limit', engine: 'google', score: 0.5 }
  ]
};

// ============================================================
// Helper: Mock fetch
// ============================================================

const _originalFetch = global.fetch;

function mockFetch(handler) {
  global.fetch = handler;
}

function restoreFetch() {
  global.fetch = _originalFetch;
}

// ============================================================
// Tests
// ============================================================

console.log('\n=== SearXNG Client Tests ===\n');

test('constructor requires baseUrl', () => {
  assert.throws(() => new SearXNGClient({ baseUrl: '' }), /baseUrl is required/);
  assert.throws(() => new SearXNGClient({}), /baseUrl is required/);
});

test('constructor sets defaults', () => {
  const client = new SearXNGClient({ baseUrl: 'http://searxng:8080' });
  assert.strictEqual(client.baseUrl, 'http://searxng:8080');
  assert.strictEqual(client.defaultLimit, 5);
  assert.strictEqual(client.timeoutMs, 10000);
  assert.strictEqual(client.defaultLanguage, 'en');
});

test('constructor strips trailing slashes from baseUrl', () => {
  const client = new SearXNGClient({ baseUrl: 'http://searxng:8080///' });
  assert.strictEqual(client.baseUrl, 'http://searxng:8080');
});

asyncTest('search() builds correct URL with query params', async () => {
  const client = new SearXNGClient({ baseUrl: 'http://searxng:8080' });
  let capturedUrl = '';

  mockFetch(async (url) => {
    capturedUrl = url;
    return { ok: true, json: async () => ({ results: [] }) };
  });

  try {
    await client.search('test query');
    assert.ok(capturedUrl.includes('/search?'));
    assert.ok(capturedUrl.includes('q=test+query'));
    assert.ok(capturedUrl.includes('format=json'));
    assert.ok(capturedUrl.includes('language=en'));
  } finally {
    restoreFetch();
  }
});

asyncTest('search() respects limit option', async () => {
  const client = new SearXNGClient({ baseUrl: 'http://searxng:8080' });

  mockFetch(async () => ({
    ok: true,
    json: async () => SAMPLE_RESULTS
  }));

  try {
    const result = await client.search('node.js', { limit: 3 });
    assert.strictEqual(result.results.length, 3);
    assert.strictEqual(result.total, 6);
  } finally {
    restoreFetch();
  }
});

asyncTest('search() returns formatted results array', async () => {
  const client = new SearXNGClient({ baseUrl: 'http://searxng:8080' });

  mockFetch(async () => ({
    ok: true,
    json: async () => SAMPLE_RESULTS
  }));

  try {
    const result = await client.search('node.js');
    assert.strictEqual(result.results.length, 5); // default limit
    assert.strictEqual(result.query, 'node.js');
    assert.strictEqual(result.results[0].title, 'Node.js Docs');
    assert.strictEqual(result.results[0].url, 'https://nodejs.org/docs');
    assert.strictEqual(result.results[0].content, 'Official documentation');
    assert.strictEqual(result.results[0].engine, 'google');
  } finally {
    restoreFetch();
  }
});

asyncTest('search() handles empty results', async () => {
  const client = new SearXNGClient({ baseUrl: 'http://searxng:8080' });

  mockFetch(async () => ({
    ok: true,
    json: async () => ({ results: [] })
  }));

  try {
    const result = await client.search('nonexistent');
    assert.strictEqual(result.results.length, 0);
    assert.strictEqual(result.total, 0);
    assert.strictEqual(result.query, 'nonexistent');
  } finally {
    restoreFetch();
  }
});

asyncTest('search() handles fetch timeout', async () => {
  const client = new SearXNGClient({ baseUrl: 'http://searxng:8080', config: { timeoutMs: 100 } });

  mockFetch(async () => {
    const err = new Error('timeout');
    err.name = 'TimeoutError';
    throw err;
  });

  try {
    await client.search('test');
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err instanceof SearXNGError);
    assert.ok(err.message.includes('timed out'));
  } finally {
    restoreFetch();
  }
});

asyncTest('search() handles network errors', async () => {
  const client = new SearXNGClient({ baseUrl: 'http://searxng:8080' });

  mockFetch(async () => {
    throw new Error('ECONNREFUSED');
  });

  try {
    await client.search('test');
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err instanceof SearXNGError);
    assert.ok(err.message.includes('ECONNREFUSED'));
  } finally {
    restoreFetch();
  }
});

asyncTest('search() handles non-JSON response', async () => {
  const client = new SearXNGClient({ baseUrl: 'http://searxng:8080' });

  mockFetch(async () => ({
    ok: true,
    json: async () => { throw new Error('invalid json'); }
  }));

  try {
    await client.search('test');
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err instanceof SearXNGError);
    assert.ok(err.message.includes('parse'));
  } finally {
    restoreFetch();
  }
});

asyncTest('search() handles SearXNG error response', async () => {
  const client = new SearXNGClient({ baseUrl: 'http://searxng:8080' });

  mockFetch(async () => ({
    ok: false,
    status: 500
  }));

  try {
    await client.search('test');
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err instanceof SearXNGError);
    assert.strictEqual(err.statusCode, 500);
  } finally {
    restoreFetch();
  }
});

asyncTest('search() encodes special characters in query', async () => {
  const client = new SearXNGClient({ baseUrl: 'http://searxng:8080' });
  let capturedUrl = '';

  mockFetch(async (url) => {
    capturedUrl = url;
    return { ok: true, json: async () => ({ results: [] }) };
  });

  try {
    await client.search('hello world & foo=bar');
    assert.ok(capturedUrl.includes('q=hello+world+%26+foo%3Dbar'));
  } finally {
    restoreFetch();
  }
});

asyncTest('search() passes engines and categories params', async () => {
  const client = new SearXNGClient({ baseUrl: 'http://searxng:8080' });
  let capturedUrl = '';

  mockFetch(async (url) => {
    capturedUrl = url;
    return { ok: true, json: async () => ({ results: [] }) };
  });

  try {
    await client.search('test', { engines: 'google,duckduckgo', categories: 'science' });
    assert.ok(capturedUrl.includes('engines=google%2Cduckduckgo'));
    assert.ok(capturedUrl.includes('categories=science'));
  } finally {
    restoreFetch();
  }
});

asyncTest('search() passes time_range param', async () => {
  const client = new SearXNGClient({ baseUrl: 'http://searxng:8080' });
  let capturedUrl = '';

  mockFetch(async (url) => {
    capturedUrl = url;
    return { ok: true, json: async () => ({ results: [] }) };
  });

  try {
    await client.search('test', { time_range: 'week' });
    assert.ok(capturedUrl.includes('time_range=week'));
  } finally {
    restoreFetch();
  }
});

asyncTest('healthCheck() returns ok status', async () => {
  const client = new SearXNGClient({ baseUrl: 'http://searxng:8080' });

  mockFetch(async () => ({
    ok: true
  }));

  try {
    const result = await client.healthCheck();
    assert.strictEqual(result.ok, true);
    assert.ok(typeof result.latencyMs === 'number');
  } finally {
    restoreFetch();
  }
});

// ============================================================
// Summary
// ============================================================

setTimeout(() => {
  summary();
  exitWithCode();
}, 500);
