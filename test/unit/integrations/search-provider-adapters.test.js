/**
 * Search Provider Adapters Unit Tests
 *
 * Run: node test/unit/integrations/search-provider-adapters.test.js
 *
 * @module test/unit/integrations/search-provider-adapters
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

const {
  BraveSearchAdapter,
  PerplexityAdapter,
  ExaAdapter,
  normalizeUrl
} = require('../../../src/lib/integrations/search-provider-adapters');

// ============================================================
// Test Fixtures
// ============================================================

const BRAVE_RESPONSE = {
  web: {
    results: [
      { title: 'Node.js', url: 'https://nodejs.org', description: 'JS runtime' },
      { title: 'Express', url: 'https://expressjs.com', description: 'Web framework' }
    ]
  }
};

const PERPLEXITY_RESPONSE = {
  choices: [{ message: { content: 'Node.js is a JavaScript runtime built on V8.' } }],
  citations: ['https://nodejs.org', 'https://v8.dev']
};

const EXA_RESPONSE = {
  results: [
    { title: 'Node.js Docs', url: 'https://nodejs.org/docs', text: 'Official docs', score: 0.95 },
    { title: 'Deno Land', url: 'https://deno.land', text: 'Deno runtime', score: 0.82 }
  ]
};

// ============================================================
// Helpers
// ============================================================

const _originalFetch = global.fetch;

function mockFetch(handler) {
  global.fetch = handler;
}

function restoreFetch() {
  global.fetch = _originalFetch;
}

function mockCredentialBroker(password = 'test-api-key-123') {
  return {
    borrow: async () => ({ password }),
    release: () => {}
  };
}

// ============================================================
// Tests
// ============================================================

console.log('\n=== Search Provider Adapters Tests ===\n');

// --- Sync tests first (no mock conflicts) ---

test('normalizeUrl() strips protocol, www, trailing slash', () => {
  assert.strictEqual(normalizeUrl('https://www.example.com/'), 'example.com');
  assert.strictEqual(normalizeUrl('http://example.com'), 'example.com');
  assert.strictEqual(normalizeUrl('https://www.example.com///'), 'example.com');
  assert.strictEqual(normalizeUrl('https://nodejs.org/docs/'), 'nodejs.org/docs');
});

test('normalizeUrl() handles edge cases (no protocol, query params)', () => {
  assert.strictEqual(normalizeUrl('example.com'), 'example.com');
  assert.strictEqual(normalizeUrl('https://example.com?foo=bar'), 'example.com');
  assert.strictEqual(normalizeUrl('https://example.com/path#section'), 'example.com/path');
  assert.strictEqual(normalizeUrl(''), '');
  assert.strictEqual(normalizeUrl(null), '');
  assert.strictEqual(normalizeUrl(undefined), '');
});

// --- Async adapter tests (chained to avoid mock conflicts) ---

(async () => {
  await asyncTest('BraveSearchAdapter.search() returns formatted results', async () => {
    const adapter = new BraveSearchAdapter(
      { apiKeyLabel: 'brave-api-key' },
      mockCredentialBroker()
    );

    mockFetch(async (url, opts) => {
      assert.ok(url.includes('api.search.brave.com'));
      assert.strictEqual(opts.headers['X-Subscription-Token'], 'test-api-key-123');
      return { ok: true, json: async () => BRAVE_RESPONSE };
    });

    try {
      const results = await adapter.search('node.js');
      assert.strictEqual(results.length, 2);
      assert.strictEqual(results[0].title, 'Node.js');
      assert.strictEqual(results[0].url, 'https://nodejs.org');
      assert.strictEqual(results[0].snippet, 'JS runtime');
      assert.strictEqual(results[0].source, 'brave');
      assert.ok(results[0].score > 0);
    } finally {
      restoreFetch();
    }
  });

  await asyncTest('BraveSearchAdapter.search() returns empty on API error', async () => {
    const adapter = new BraveSearchAdapter(
      { apiKeyLabel: 'brave-api-key' },
      mockCredentialBroker()
    );

    mockFetch(async () => ({ ok: false, status: 429 }));

    try {
      const results = await adapter.search('test');
      assert.strictEqual(results.length, 0);
    } finally {
      restoreFetch();
    }
  });

  await asyncTest('PerplexityAdapter.search() returns formatted results', async () => {
    const adapter = new PerplexityAdapter(
      { apiKeyLabel: 'pplx-key', model: 'sonar' },
      mockCredentialBroker()
    );

    mockFetch(async (url, opts) => {
      assert.ok(url.includes('api.perplexity.ai'));
      assert.ok(opts.headers['Authorization'].includes('test-api-key-123'));
      return { ok: true, json: async () => PERPLEXITY_RESPONSE };
    });

    try {
      const results = await adapter.search('what is node.js');
      assert.strictEqual(results.length, 2);
      assert.strictEqual(results[0].url, 'https://nodejs.org');
      assert.strictEqual(results[0].source, 'perplexity');
      assert.ok(results[0].snippet.length > 0);
    } finally {
      restoreFetch();
    }
  });

  await asyncTest('ExaAdapter.search() returns formatted results', async () => {
    const adapter = new ExaAdapter(
      { apiKeyLabel: 'exa-key', searchType: 'neural' },
      mockCredentialBroker()
    );

    mockFetch(async (url, opts) => {
      assert.ok(url.includes('api.exa.ai'));
      assert.strictEqual(opts.headers['x-api-key'], 'test-api-key-123');
      return { ok: true, json: async () => EXA_RESPONSE };
    });

    try {
      const results = await adapter.search('node.js runtime');
      assert.strictEqual(results.length, 2);
      assert.strictEqual(results[0].title, 'Node.js Docs');
      assert.strictEqual(results[0].url, 'https://nodejs.org/docs');
      assert.strictEqual(results[0].snippet, 'Official docs');
      assert.strictEqual(results[0].source, 'exa');
      assert.strictEqual(results[0].score, 0.95);
    } finally {
      restoreFetch();
    }
  });

  summary();
  exitWithCode();
})();
