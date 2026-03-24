/**
 * HttpToolExecutor OAuth Integration Tests
 *
 * Tests that HttpToolExecutor correctly delegates to OAuthBroker for
 * oauth2 auth type, including the 401 retry path.
 */

'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../helpers/test-runner');
const { HttpToolExecutor } = require('../../src/skill-forge/http-tool-executor');

const originalFetch = global.fetch;

// ─── Mock helpers ─────────────────────────────────────────────────────

function mockResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  };
}

function mkOAuth(token, forceToken) {
  return {
    getAccessToken: async (name, opts = {}) => {
      if (opts.forceRefresh && forceToken !== undefined) {
        if (forceToken instanceof Error) throw forceToken;
        return forceToken;
      }
      if (token instanceof Error) throw token;
      return token;
    },
  };
}

const opConfig = {
  method: 'GET',
  url: 'https://api.example.com/data',
  auth: { type: 'oauth2', credentialName: 'oauth-test-cred' },
};

// ─── All tests in one sequential block ────────────────────────────────

asyncTest('HttpToolExecutor OAuth: all tests', async () => {
  // --- 1: oauth2 uses OAuthBroker ---
  {
    const exec = new HttpToolExecutor({
      credentialBroker: { get: async () => 'x', clearCache: () => {} },
      oauthBroker: mkOAuth('oauth-tok-123'),
    });
    let captured = null;
    global.fetch = async (url, opts) => { captured = opts; return mockResponse(200, { ok: true }); };
    try {
      const r = await exec.execute(opConfig);
      assert.strictEqual(r.success, true, 'request succeeds');
      assert.strictEqual(captured.headers.Authorization, 'Bearer oauth-tok-123', 'bearer header set');
    } finally { global.fetch = originalFetch; }
  }

  // --- 2: no oauthBroker returns error ---
  {
    const exec = new HttpToolExecutor({
      credentialBroker: { get: async () => 'x', clearCache: () => {} },
    });
    const r = await exec.execute(opConfig);
    assert.strictEqual(r.success, false);
    assert.ok(r.error.includes('OAuthBroker'), r.error);
  }

  // --- 3: token error returns structured error ---
  {
    const exec = new HttpToolExecutor({
      credentialBroker: { get: async () => 'x', clearCache: () => {} },
      oauthBroker: mkOAuth(new Error('Reauthorization required')),
    });
    const r = await exec.execute(opConfig);
    assert.strictEqual(r.success, false);
    assert.ok(r.error.includes('Reauthorization required'), r.error);
  }

  // --- 4: 401 triggers refresh + retry ---
  {
    let clearCalled = false;
    const exec = new HttpToolExecutor({
      credentialBroker: { get: async () => 'x', clearCache: () => { clearCalled = true; } },
      oauthBroker: mkOAuth('stale', 'fresh-after-refresh'),
    });
    let callCount = 0;
    global.fetch = async (url, opts) => {
      callCount++;
      if (callCount === 1) return mockResponse(401, { error: 'unauthorized' });
      return mockResponse(200, { data: 'ok' });
    };
    try {
      const r = await exec.execute(opConfig);
      assert.strictEqual(r.success, true, '401 retry succeeds');
      assert.ok(clearCalled, 'clearCache called');
    } finally { global.fetch = originalFetch; }
  }

  // --- 5: second 401 returns reauthorization error ---
  {
    const exec = new HttpToolExecutor({
      credentialBroker: { get: async () => 'x', clearCache: () => {} },
      oauthBroker: mkOAuth('stale', 'also-stale'),
    });
    global.fetch = async () => mockResponse(401, { error: 'nope' });
    try {
      const r = await exec.execute(opConfig);
      assert.strictEqual(r.success, false);
      assert.strictEqual(r.status, 401);
      assert.ok(r.error.includes('Reauthorization likely required'), r.error);
    } finally { global.fetch = originalFetch; }
  }

  // --- 6: 401 retry with refresh failure ---
  {
    const exec = new HttpToolExecutor({
      credentialBroker: { get: async () => 'x', clearCache: () => {} },
      oauthBroker: mkOAuth('stale', new Error('Refresh token revoked')),
    });
    global.fetch = async () => mockResponse(401, { error: 'unauthorized' });
    try {
      const r = await exec.execute(opConfig);
      assert.strictEqual(r.success, false);
      assert.ok(r.error.includes('Refresh token revoked'), r.error);
    } finally { global.fetch = originalFetch; }
  }
});

setTimeout(() => {
  global.fetch = originalFetch;
  summary();
  exitWithCode();
}, 500);
