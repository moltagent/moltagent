/**
 * SelfHealClient Unit Tests
 *
 * Run: node test/unit/clients/self-heal-client.test.js
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const { createMockCredentialBroker } = require('../../helpers/mock-factories');

const SelfHealClient = require('../../../src/lib/clients/self-heal-client');

// ============================================================
// Helper: Stub global.fetch
// ============================================================

function stubFetch(handler) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return handler(url, opts);
  };
  return {
    calls,
    restore: () => { global.fetch = original; }
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  };
}

// ============================================================
// Tests (sequential to avoid fetch stub conflicts)
// ============================================================

(async () => {
  console.log('\n=== SelfHealClient Tests ===\n');

  // --- Constructor ---
  console.log('\n--- Constructor Tests ---\n');

  test('TC-CTOR-001: Stores config', () => {
    const client = new SelfHealClient({
      url: 'http://localhost:7867',
      tokenCredential: 'heald-token',
      timeoutMs: 5000,
      credentialBroker: createMockCredentialBroker()
    });
    assert.strictEqual(client.url, 'http://localhost:7867');
    assert.strictEqual(client.tokenCredential, 'heald-token');
    assert.strictEqual(client.timeoutMs, 5000);
  });

  test('TC-CTOR-002: Strips trailing slash from URL', () => {
    const client = new SelfHealClient({
      url: 'http://localhost:7867/',
      tokenCredential: 'heald-token',
      credentialBroker: createMockCredentialBroker()
    });
    assert.strictEqual(client.url, 'http://localhost:7867');
  });

  test('TC-CTOR-003: Defaults timeoutMs to 15000', () => {
    const client = new SelfHealClient({
      url: 'http://localhost:7867',
      tokenCredential: 'heald-token',
      credentialBroker: createMockCredentialBroker()
    });
    assert.strictEqual(client.timeoutMs, 15000);
  });

  // --- health() ---
  console.log('\n--- health() Tests ---\n');

  await asyncTest('TC-HEALTH-001: GET /health returns parsed JSON', async () => {
    const client = new SelfHealClient({
      url: 'http://localhost:7867',
      tokenCredential: 'heald-token',
      credentialBroker: createMockCredentialBroker()
    });

    const stub = stubFetch((url) => {
      assert.ok(url.includes('/health'));
      return jsonResponse(200, { status: 'ok', services: ['ollama', 'whisper-server'] });
    });

    try {
      const result = await client.health();
      assert.strictEqual(result.status, 'ok');
      assert.deepStrictEqual(result.services, ['ollama', 'whisper-server']);
      assert.strictEqual(stub.calls.length, 1);
    } finally {
      stub.restore();
    }
  });

  await asyncTest('TC-HEALTH-002: health() throws on non-200', async () => {
    const client = new SelfHealClient({
      url: 'http://localhost:7867',
      tokenCredential: 'heald-token',
      credentialBroker: createMockCredentialBroker()
    });

    const stub = stubFetch(() => jsonResponse(500, {}));

    try {
      await assert.rejects(() => client.health(), /HTTP 500/);
    } finally {
      stub.restore();
    }
  });

  // --- restart() ---
  console.log('\n--- restart() Tests ---\n');

  await asyncTest('TC-RESTART-001: POST /restart/ollama with Bearer token', async () => {
    const client = new SelfHealClient({
      url: 'http://localhost:7867',
      tokenCredential: 'heald-token',
      credentialBroker: createMockCredentialBroker({ 'heald-token': 'test-secret-token' })
    });

    const stub = stubFetch((url, opts) => {
      assert.ok(url.includes('/restart/ollama'));
      assert.strictEqual(opts.method, 'POST');
      assert.strictEqual(opts.headers['Authorization'], 'Bearer test-secret-token');
      return jsonResponse(200, { ok: true, service: 'ollama', message: 'ollama restarted successfully' });
    });

    try {
      const result = await client.restart('ollama');
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.service, 'ollama');
    } finally {
      stub.restore();
    }
  });

  await asyncTest('TC-RESTART-002: restart() throws on error response', async () => {
    const client = new SelfHealClient({
      url: 'http://localhost:7867',
      tokenCredential: 'heald-token',
      credentialBroker: createMockCredentialBroker({ 'heald-token': 'tok' })
    });

    const stub = stubFetch(() => jsonResponse(404, { error: 'Unknown service: bogus' }));

    try {
      await assert.rejects(() => client.restart('bogus'), /Unknown service/);
    } finally {
      stub.restore();
    }
  });

  await asyncTest('TC-RESTART-003: restart() URL-encodes service name', async () => {
    const client = new SelfHealClient({
      url: 'http://localhost:7867',
      tokenCredential: 'heald-token',
      credentialBroker: createMockCredentialBroker({ 'heald-token': 'tok' })
    });

    const stub = stubFetch((url) => {
      assert.ok(url.includes('/restart/whisper-server'));
      return jsonResponse(200, { ok: true, service: 'whisper-server', message: 'restarted' });
    });

    try {
      await client.restart('whisper-server');
    } finally {
      stub.restore();
    }
  });

  // --- Token caching ---
  console.log('\n--- Token Caching Tests ---\n');

  await asyncTest('TC-TOKEN-001: Token fetched from broker on first call, cached after', async () => {
    let brokerCallCount = 0;
    const broker = {
      get: async () => {
        brokerCallCount++;
        return 'cached-tok';
      }
    };

    const client = new SelfHealClient({
      url: 'http://localhost:7867',
      tokenCredential: 'heald-token',
      credentialBroker: broker
    });

    const stub = stubFetch(() => jsonResponse(200, { ok: true, service: 'ollama', message: 'ok' }));

    try {
      await client.restart('ollama');
      await client.restart('ollama');
      assert.strictEqual(brokerCallCount, 1, 'Token should be fetched only once');
    } finally {
      stub.restore();
    }
  });

  // Summary
  summary();
  exitWithCode();
})();
