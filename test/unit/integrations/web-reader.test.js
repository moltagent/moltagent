/**
 * WebReader Unit Tests
 *
 * Run: node test/unit/integrations/web-reader.test.js
 *
 * @module test/unit/integrations/web-reader
 */

const assert = require('assert');
const dns = require('dns');
const { asyncTest, summary, exitWithCode, reset } = require('../../helpers/test-runner');

// Import module under test
const { WebReader, WebReaderError } = require('../../../src/lib/integrations/web-reader');

// ============================================================
// Helper: Mock fetch and DNS
// ============================================================

const _originalFetch = global.fetch;
const _originalDnsLookup = dns.promises.lookup;

function mockFetch(handler) {
  global.fetch = handler;
}

function restoreFetch() {
  global.fetch = _originalFetch;
}

function mockDns(handler) {
  dns.promises.lookup = handler;
}

function restoreDns() {
  dns.promises.lookup = _originalDnsLookup;
}

function restoreAll() {
  restoreFetch();
  restoreDns();
}

/**
 * Create a mock Response-like object with streaming body
 */
function createMockResponse(body, options = {}) {
  const bodyBuffer = Buffer.from(body, 'utf-8');
  const contentType = options.contentType || 'text/html';
  const status = options.status || 200;
  const ok = status >= 200 && status < 300;

  return {
    ok,
    status,
    statusText: options.statusText || 'OK',
    headers: {
      get: (name) => {
        if (name.toLowerCase() === 'content-type') return contentType;
        if (name.toLowerCase() === 'content-length') return options.contentLength || String(bodyBuffer.length);
        return null;
      }
    },
    body: {
      getReader: () => {
        let read = false;
        return {
          read: async () => {
            if (read) return { done: true, value: undefined };
            read = true;
            return { done: false, value: bodyBuffer };
          },
          cancel: async () => {}
        };
      }
    }
  };
}

// ============================================================
// Run all tests sequentially to avoid mock conflicts
// ============================================================

console.log('\n=== WebReader Tests ===\n');

async function runTests() {
  // ---- SSRF Validation Tests ----

  await asyncTest('_validateUrl() accepts valid HTTPS URL', async () => {
    const reader = new WebReader();
    mockDns(async () => ({ address: '93.184.216.34' }));
    try {
      await reader._validateUrl('https://example.com/page');
    } finally {
      restoreDns();
    }
  });

  await asyncTest('_validateUrl() accepts valid HTTP URL', async () => {
    const reader = new WebReader();
    mockDns(async () => ({ address: '93.184.216.34' }));
    try {
      await reader._validateUrl('http://example.com');
    } finally {
      restoreDns();
    }
  });

  await asyncTest('_validateUrl() rejects non-HTTP protocols', async () => {
    const reader = new WebReader();
    const protocols = ['ftp://example.com', 'file:///etc/passwd'];
    for (const url of protocols) {
      try {
        await reader._validateUrl(url);
        assert.fail(`Should have rejected ${url}`);
      } catch (err) {
        assert.ok(err instanceof WebReaderError, `Expected WebReaderError for ${url}, got ${err.constructor.name}`);
        assert.strictEqual(err.code, 'BLOCKED_PROTOCOL');
      }
    }
  });

  await asyncTest('_validateUrl() rejects private IP 10.x', async () => {
    const reader = new WebReader();
    try {
      await reader._validateUrl('http://10.0.0.1/admin');
      assert.fail('Should have rejected');
    } catch (err) {
      assert.ok(err instanceof WebReaderError);
      assert.strictEqual(err.code, 'BLOCKED_IP');
    }
  });

  await asyncTest('_validateUrl() rejects private IP 172.16.x', async () => {
    const reader = new WebReader();
    try {
      await reader._validateUrl('http://172.16.0.1');
      assert.fail('Should have rejected');
    } catch (err) {
      assert.ok(err instanceof WebReaderError);
      assert.strictEqual(err.code, 'BLOCKED_IP');
    }
  });

  await asyncTest('_validateUrl() rejects private IP 192.168.x', async () => {
    const reader = new WebReader();
    try {
      await reader._validateUrl('http://192.168.1.1');
      assert.fail('Should have rejected');
    } catch (err) {
      assert.ok(err instanceof WebReaderError);
      assert.strictEqual(err.code, 'BLOCKED_IP');
    }
  });

  await asyncTest('_validateUrl() rejects 127.x loopback', async () => {
    const reader = new WebReader();
    try {
      await reader._validateUrl('http://127.0.0.1');
      assert.fail('Should have rejected');
    } catch (err) {
      assert.ok(err instanceof WebReaderError);
      assert.strictEqual(err.code, 'BLOCKED_IP');
    }
  });

  await asyncTest('_validateUrl() rejects localhost', async () => {
    const reader = new WebReader();
    try {
      await reader._validateUrl('http://localhost:3000');
      assert.fail('Should have rejected');
    } catch (err) {
      assert.ok(err instanceof WebReaderError);
      assert.strictEqual(err.code, 'BLOCKED_HOST');
    }
  });

  await asyncTest('_validateUrl() rejects metadata endpoint', async () => {
    const reader = new WebReader();
    try {
      await reader._validateUrl('http://169.254.169.254/latest/meta-data');
      assert.fail('Should have rejected');
    } catch (err) {
      assert.ok(err instanceof WebReaderError);
      assert.strictEqual(err.code, 'BLOCKED_IP');
    }
  });

  await asyncTest('_validateUrl() rejects empty/null input', async () => {
    const reader = new WebReader();
    try {
      await reader._validateUrl('');
      assert.fail('Should have rejected');
    } catch (err) {
      assert.ok(err instanceof WebReaderError);
      assert.strictEqual(err.code, 'INVALID_URL');
    }

    try {
      await reader._validateUrl(null);
      assert.fail('Should have rejected');
    } catch (err) {
      assert.ok(err instanceof WebReaderError);
    }
  });

  await asyncTest('_validateUrl() rejects DNS-resolved private IP', async () => {
    const reader = new WebReader();
    mockDns(async () => ({ address: '10.0.0.5' }));
    try {
      await reader._validateUrl('https://evil.example.com');
      assert.fail('Should have rejected');
    } catch (err) {
      assert.ok(err instanceof WebReaderError);
      assert.strictEqual(err.code, 'BLOCKED_IP');
    } finally {
      restoreDns();
    }
  });

  await asyncTest('_validateUrl() rejects IPv6-mapped private IP', async () => {
    const reader = new WebReader();
    mockDns(async () => ({ address: '::ffff:10.0.0.1' }));
    try {
      await reader._validateUrl('https://sneaky.example.com');
      assert.fail('Should have rejected');
    } catch (err) {
      assert.ok(err instanceof WebReaderError);
      assert.strictEqual(err.code, 'BLOCKED_IP');
    } finally {
      restoreDns();
    }
  });

  await asyncTest('read() rejects redirect to private IP (SSRF)', async () => {
    const reader = new WebReader();
    let callCount = 0;

    mockDns(async (hostname) => {
      if (hostname === 'evil.example.com') return { address: '93.184.216.34' };
      // redirect target resolves to private IP
      return { address: '169.254.169.254' };
    });
    mockFetch(async () => {
      callCount++;
      // First call returns redirect
      return {
        ok: false,
        status: 302,
        statusText: 'Found',
        headers: {
          get: (name) => {
            if (name.toLowerCase() === 'location') return 'http://169.254.169.254/latest/meta-data';
            return null;
          }
        }
      };
    });

    try {
      await reader.read('https://evil.example.com/redir');
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err instanceof WebReaderError);
      assert.strictEqual(err.code, 'BLOCKED_IP');
    } finally {
      restoreAll();
    }
  });

  // ---- Content Extraction Tests ----

  await asyncTest('read() fetches and returns article content', async () => {
    const reader = new WebReader({ config: { maxOutputChars: 50000 } });
    const html = '<html><head><title>Test Article</title></head><body><article><p>Hello world article content.</p></article></body></html>';

    mockDns(async () => ({ address: '93.184.216.34' }));
    mockFetch(async () => createMockResponse(html, { contentType: 'text/html' }));

    try {
      const result = await reader.read('https://example.com/article');
      assert.ok(result.title);
      assert.ok(result.content.length > 0);
      assert.strictEqual(result.url, 'https://example.com/article');
      assert.ok(result.extractedAt);
      assert.ok(result.bytesFetched > 0);
      assert.strictEqual(typeof result.truncated, 'boolean');
    } finally {
      restoreAll();
    }
  });

  await asyncTest('read() truncates long content at maxOutputChars', async () => {
    const reader = new WebReader({ config: { maxOutputChars: 50 } });
    const longContent = 'A'.repeat(200);
    const html = `<html><head><title>Long</title></head><body><article><p>${longContent}</p></article></body></html>`;

    mockDns(async () => ({ address: '93.184.216.34' }));
    mockFetch(async () => createMockResponse(html, { contentType: 'text/html' }));

    try {
      const result = await reader.read('https://example.com/long');
      assert.strictEqual(result.truncated, true);
      assert.ok(result.content.includes('[Content truncated]'));
    } finally {
      restoreAll();
    }
  });

  await asyncTest('read() handles plain text responses', async () => {
    const reader = new WebReader();
    const text = 'This is plain text content.';

    mockDns(async () => ({ address: '93.184.216.34' }));
    mockFetch(async () => createMockResponse(text, { contentType: 'text/plain' }));

    try {
      const result = await reader.read('https://example.com/text');
      assert.strictEqual(result.content, text);
      assert.strictEqual(result.title, 'Plain Text');
    } finally {
      restoreAll();
    }
  });

  await asyncTest('read() handles JSON responses', async () => {
    const reader = new WebReader();
    const json = '{"name":"test","value":42}';

    mockDns(async () => ({ address: '93.184.216.34' }));
    mockFetch(async () => createMockResponse(json, { contentType: 'application/json' }));

    try {
      const result = await reader.read('https://api.example.com/data');
      assert.strictEqual(result.title, 'JSON Response');
      assert.ok(result.content.includes('"name"'));
      assert.ok(result.content.includes('"test"'));
    } finally {
      restoreAll();
    }
  });

  await asyncTest('read() rejects non-text content types', async () => {
    const reader = new WebReader();

    mockDns(async () => ({ address: '93.184.216.34' }));
    mockFetch(async () => createMockResponse('binary', { contentType: 'image/png' }));

    try {
      await reader.read('https://example.com/image.png');
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err instanceof WebReaderError);
      assert.strictEqual(err.code, 'UNSUPPORTED_TYPE');
    } finally {
      restoreAll();
    }
  });

  await asyncTest('read() respects maxResponseBytes limit', async () => {
    const reader = new WebReader({ config: { maxResponseBytes: 100 } });
    const largeBody = 'X'.repeat(200);

    mockDns(async () => ({ address: '93.184.216.34' }));
    mockFetch(async () => createMockResponse(largeBody, { contentType: 'text/html', contentLength: '200' }));

    try {
      await reader.read('https://example.com/large');
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err instanceof WebReaderError);
      assert.strictEqual(err.code, 'BODY_TOO_LARGE');
    } finally {
      restoreAll();
    }
  });

  await asyncTest('read() handles fetch timeout', async () => {
    const reader = new WebReader({ config: { timeoutMs: 100 } });

    mockDns(async () => ({ address: '93.184.216.34' }));
    mockFetch(async () => {
      const err = new Error('timeout');
      err.name = 'TimeoutError';
      throw err;
    });

    try {
      await reader.read('https://example.com/slow');
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err instanceof WebReaderError);
      assert.strictEqual(err.code, 'TIMEOUT');
    } finally {
      restoreAll();
    }
  });

  await asyncTest('read() handles network errors', async () => {
    const reader = new WebReader();

    mockDns(async () => ({ address: '93.184.216.34' }));
    mockFetch(async () => {
      throw new Error('ECONNREFUSED');
    });

    try {
      await reader.read('https://example.com/down');
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err instanceof WebReaderError);
      assert.strictEqual(err.code, 'NETWORK_ERROR');
    } finally {
      restoreAll();
    }
  });

  // ---- Cache Tests ----

  await asyncTest('read() returns cached result on second call', async () => {
    const reader = new WebReader({ config: { cacheTtlMs: 60000 } });
    const html = '<html><head><title>Cached</title></head><body><p>Cached content.</p></body></html>';
    let fetchCount = 0;

    mockDns(async () => ({ address: '93.184.216.34' }));
    mockFetch(async () => {
      fetchCount++;
      return createMockResponse(html, { contentType: 'text/html' });
    });

    try {
      await reader.read('https://example.com/cached');
      await reader.read('https://example.com/cached');
      assert.strictEqual(fetchCount, 1, 'Should only fetch once due to caching');
    } finally {
      restoreAll();
    }
  });

  await asyncTest('read() cache expires after TTL', async () => {
    const reader = new WebReader({ config: { cacheTtlMs: 1 } }); // 1ms TTL
    const html = '<html><head><title>Expire</title></head><body><p>Content.</p></body></html>';
    let fetchCount = 0;

    mockDns(async () => ({ address: '93.184.216.34' }));
    mockFetch(async () => {
      fetchCount++;
      return createMockResponse(html, { contentType: 'text/html' });
    });

    try {
      await reader.read('https://example.com/expire');
      await new Promise(resolve => setTimeout(resolve, 10));
      await reader.read('https://example.com/expire');
      assert.strictEqual(fetchCount, 2, 'Should fetch twice after cache expiry');
    } finally {
      restoreAll();
    }
  });

  await asyncTest('clearCache() empties the cache', async () => {
    const reader = new WebReader({ config: { cacheTtlMs: 60000 } });
    const html = '<html><head><title>Clear</title></head><body><p>Content.</p></body></html>';
    let fetchCount = 0;

    mockDns(async () => ({ address: '93.184.216.34' }));
    mockFetch(async () => {
      fetchCount++;
      return createMockResponse(html, { contentType: 'text/html' });
    });

    try {
      await reader.read('https://example.com/clear');
      reader.clearCache();
      await reader.read('https://example.com/clear');
      assert.strictEqual(fetchCount, 2, 'Should fetch twice after cache clear');
    } finally {
      restoreAll();
    }
  });

  // ---- Summary ----
  summary();
  exitWithCode();
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
