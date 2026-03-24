/*
 * MoltAgent - Sovereign AI Security Layer
 * Copyright (C) 2026 MoltAgent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 */

/**
 * Unit Tests for HttpToolExecutor Module
 *
 * Tests the declarative REST executor used by all forged skills:
 * - Constructor validation
 * - SSRF / private-IP hard-block (_isPrivateOrMetadata)
 * - Auth header assembly (bearer, header_key, basic, query_param, none)
 * - URL placeholder resolution and encoding
 * - Successful GET / POST execution
 * - Credential-not-found and egress-blocked error paths
 * - HTTP 4xx / 5xx error status handling
 * - Timeout via AbortController
 * - JSON parse with plain-text fallback
 *
 * @module test/unit/skill-forge/http-tool-executor.test.js
 */

'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const { HttpToolExecutor } = require('../../../src/skill-forge/http-tool-executor');

console.log('\n=== HttpToolExecutor Tests ===\n');

// -----------------------------------------------------------------------------
// Test Helpers
// -----------------------------------------------------------------------------

/**
 * Build a mock CredentialBroker that resolves from a plain lookup map.
 *
 * @param {Object} [credentials={}] - Map of credential name → value
 * @returns {{ get: (name: string) => Promise<string|null> }}
 */
function mockCredentialBroker(credentials = {}) {
  return { get: async (name) => credentials[name] || null };
}

/**
 * Build a mock EgressGuard that either allows or blocks every URL.
 *
 * @param {boolean} [allowed=true]
 * @returns {{ evaluate: (url: string) => { allowed: boolean, reason: string|null } }}
 */
function mockEgressGuard(allowed = true) {
  return { evaluate: (url) => ({ allowed, reason: allowed ? null : 'blocked' }) };
}

/** Snapshot of global.fetch before any test tampers with it. */
const originalFetch = global.fetch;

/**
 * Override global.fetch for the duration of a single test.
 *
 * The returned object mimics the Fetch API surface used by HttpToolExecutor:
 *   - response.ok
 *   - response.status
 *   - response.headers.get(name)   ← Map-backed so .get() works correctly
 *   - response.text()
 *
 * @param {{ ok?: boolean, status?: number, headers?: Object, body?: any }} response
 */
function mockFetch(response) {
  global.fetch = async (url, opts) => {
    // Build a real Map so .get() works the same way the executor calls it.
    const headerMap = new Map(Object.entries(response.headers || {}));
    return {
      ok: response.ok !== undefined ? response.ok : true,
      status: response.status || 200,
      headers: { get: (name) => headerMap.get(name) ?? null },
      text: async () => (typeof response.body === 'string' ? response.body : JSON.stringify(response.body)),
      json: async () => response.body,
    };
  };
}

/** Restore the original fetch implementation. */
function restoreFetch() {
  global.fetch = originalFetch;
}

/** A minimal operationConfig that targets a safe public host. */
const BASE_CONFIG = {
  method: 'GET',
  url: 'https://api.github.com/repos/test/repo',
  auth: { type: 'none' },
};

// -----------------------------------------------------------------------------
// Constructor Tests
// -----------------------------------------------------------------------------

test('TC-HTE-001: Constructor throws when credentialBroker is missing', () => {
  assert.throws(
    () => new HttpToolExecutor({}),
    /credentialBroker must have a \.get\(name\) method/,
  );
});

test('TC-HTE-002: Constructor throws when credentialBroker has no .get method', () => {
  assert.throws(
    () => new HttpToolExecutor({ credentialBroker: {} }),
    /credentialBroker must have a \.get\(name\) method/,
  );
});

test('TC-HTE-003: Constructor accepts valid options and stores them', () => {
  const broker = mockCredentialBroker();
  const guard = mockEgressGuard();
  const executor = new HttpToolExecutor({
    credentialBroker: broker,
    egressGuard: guard,
    timeoutMs: 5000,
    maxResponseBytes: 512,
  });
  assert.ok(executor instanceof HttpToolExecutor);
  assert.strictEqual(executor.credentialBroker, broker);
  assert.strictEqual(executor.egressGuard, guard);
  assert.strictEqual(executor.timeoutMs, 5000);
  assert.strictEqual(executor.maxResponseBytes, 512);
});

// -----------------------------------------------------------------------------
// SSRF Protection — _isPrivateOrMetadata (exercised via execute())
// -----------------------------------------------------------------------------

asyncTest('TC-HTE-010: SSRF blocks localhost', async () => {
  const executor = new HttpToolExecutor({ credentialBroker: mockCredentialBroker() });
  const result = await executor.execute({ method: 'GET', url: 'http://localhost/admin' });
  assert.strictEqual(result.success, false);
  assert.ok(result.error.includes('SSRF'));
  assert.ok(result.error.includes('localhost'));
});

asyncTest('TC-HTE-011: SSRF blocks 127.0.0.1', async () => {
  const executor = new HttpToolExecutor({ credentialBroker: mockCredentialBroker() });
  const result = await executor.execute({ method: 'GET', url: 'http://127.0.0.1:8080/' });
  assert.strictEqual(result.success, false);
  assert.ok(result.error.includes('SSRF'));
});

asyncTest('TC-HTE-012: SSRF blocks 10.x.x.x private range', async () => {
  const executor = new HttpToolExecutor({ credentialBroker: mockCredentialBroker() });
  const result = await executor.execute({ method: 'GET', url: 'http://10.0.0.5/internal' });
  assert.strictEqual(result.success, false);
  assert.ok(result.error.includes('SSRF'));
});

asyncTest('TC-HTE-013: SSRF blocks 172.16.x.x private range', async () => {
  const executor = new HttpToolExecutor({ credentialBroker: mockCredentialBroker() });
  const result = await executor.execute({ method: 'GET', url: 'http://172.16.0.1/data' });
  assert.strictEqual(result.success, false);
  assert.ok(result.error.includes('SSRF'));
});

asyncTest('TC-HTE-014: SSRF blocks 192.168.x.x private range', async () => {
  const executor = new HttpToolExecutor({ credentialBroker: mockCredentialBroker() });
  const result = await executor.execute({ method: 'GET', url: 'http://192.168.1.100/' });
  assert.strictEqual(result.success, false);
  assert.ok(result.error.includes('SSRF'));
});

asyncTest('TC-HTE-015: SSRF blocks AWS metadata endpoint 169.254.169.254', async () => {
  const executor = new HttpToolExecutor({ credentialBroker: mockCredentialBroker() });
  const result = await executor.execute({ method: 'GET', url: 'http://169.254.169.254/latest/meta-data/' });
  assert.strictEqual(result.success, false);
  assert.ok(result.error.includes('SSRF'));
  assert.ok(result.error.includes('169.254.169.254'));
});

asyncTest('TC-HTE-016: SSRF blocks metadata.google.internal', async () => {
  const executor = new HttpToolExecutor({ credentialBroker: mockCredentialBroker() });
  const result = await executor.execute({ method: 'GET', url: 'http://metadata.google.internal/' });
  assert.strictEqual(result.success, false);
  assert.ok(result.error.includes('SSRF'));
});

asyncTest('TC-HTE-017: SSRF blocks metadata.hetzner.cloud', async () => {
  const executor = new HttpToolExecutor({ credentialBroker: mockCredentialBroker() });
  const result = await executor.execute({ method: 'GET', url: 'http://metadata.hetzner.cloud/' });
  assert.strictEqual(result.success, false);
  assert.ok(result.error.includes('SSRF'));
});

asyncTest('TC-HTE-018: SSRF allows api.trello.com (public host)', async () => {
  const executor = new HttpToolExecutor({ credentialBroker: mockCredentialBroker() });
  // Verify that the SSRF check itself passes (subsequent fetch may fail, that is fine)
  // We check the error is NOT an SSRF error
  mockFetch({ status: 200, body: { ok: true } });
  try {
    const result = await executor.execute({ method: 'GET', url: 'https://api.trello.com/1/boards' });
    // If fetch succeeded, result should not be SSRF
    assert.ok(!result.error || !result.error.includes('SSRF'));
  } finally {
    restoreFetch();
  }
});

asyncTest('TC-HTE-019: SSRF allows api.github.com (public host)', async () => {
  const executor = new HttpToolExecutor({ credentialBroker: mockCredentialBroker() });
  mockFetch({ status: 200, body: { id: 42 } });
  try {
    const result = await executor.execute(BASE_CONFIG);
    assert.ok(!result.error || !result.error.includes('SSRF'));
  } finally {
    restoreFetch();
  }
});

// -----------------------------------------------------------------------------
// Auth Header Assembly Tests
// -----------------------------------------------------------------------------

asyncTest('TC-HTE-020: bearer auth sets Authorization: Bearer <token> header', async () => {
  // Use a Promise to synchronise the captured value with the await boundary.
  let resolveCapture;
  const capturePromise = new Promise((res) => { resolveCapture = res; });
  global.fetch = async (url, opts) => {
    resolveCapture(opts.headers);
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => '{}' };
  };
  try {
    const executor = new HttpToolExecutor({
      credentialBroker: mockCredentialBroker({ 'my-token': 'secret-abc' }),
    });
    await executor.execute({
      method: 'GET',
      url: 'https://api.github.com/repos/test/repo',
      auth: { type: 'bearer', credentialName: 'my-token' },
    });
    const capturedHeaders = await capturePromise;
    assert.strictEqual(capturedHeaders['Authorization'], 'Bearer secret-abc');
  } finally {
    restoreFetch();
  }
});

asyncTest('TC-HTE-021: header_key auth sets custom header with credential value', async () => {
  let resolveCapture;
  const capturePromise = new Promise((res) => { resolveCapture = res; });
  global.fetch = async (url, opts) => {
    resolveCapture(opts.headers);
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => '{}' };
  };
  try {
    const executor = new HttpToolExecutor({
      credentialBroker: mockCredentialBroker({ 'api-key': 'key-xyz' }),
    });
    await executor.execute({
      method: 'GET',
      url: 'https://api.github.com/repos/test/repo',
      auth: { type: 'header_key', headerName: 'X-API-Key', credentialName: 'api-key' },
    });
    const capturedHeaders = await capturePromise;
    assert.strictEqual(capturedHeaders['X-API-Key'], 'key-xyz');
  } finally {
    restoreFetch();
  }
});

asyncTest('TC-HTE-022: basic auth sets base64-encoded Authorization header', async () => {
  let resolveCapture;
  const capturePromise = new Promise((res) => { resolveCapture = res; });
  global.fetch = async (url, opts) => {
    resolveCapture(opts.headers);
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => '{}' };
  };
  try {
    const executor = new HttpToolExecutor({
      credentialBroker: mockCredentialBroker({ 'basic-cred': 'user:pass' }),
    });
    await executor.execute({
      method: 'GET',
      url: 'https://api.github.com/repos/test/repo',
      auth: { type: 'basic', credentialName: 'basic-cred' },
    });
    const capturedHeaders = await capturePromise;
    const expected = 'Basic ' + Buffer.from('user:pass', 'utf8').toString('base64');
    assert.strictEqual(capturedHeaders['Authorization'], expected);
  } finally {
    restoreFetch();
  }
});

asyncTest('TC-HTE-023: query_param auth appends key and token to URL', async () => {
  let resolveCapture;
  const capturePromise = new Promise((res) => { resolveCapture = res; });
  global.fetch = async (url, opts) => {
    resolveCapture(url);
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => '{}' };
  };
  try {
    // credential format: "mykey:mytoken"
    const executor = new HttpToolExecutor({
      credentialBroker: mockCredentialBroker({ 'trello-cred': 'mykey:mytoken' }),
    });
    await executor.execute({
      method: 'GET',
      url: 'https://api.trello.com/1/boards',
      auth: { type: 'query_param', credentialName: 'trello-cred', keyParam: 'key', tokenParam: 'token' },
    });
    const capturedUrl = await capturePromise;
    assert.ok(capturedUrl.includes('key=mykey'));
    assert.ok(capturedUrl.includes('token=mytoken'));
  } finally {
    restoreFetch();
  }
});

asyncTest('TC-HTE-024: none auth adds no extra headers beyond User-Agent', async () => {
  let resolveCapture;
  const capturePromise = new Promise((res) => { resolveCapture = res; });
  global.fetch = async (url, opts) => {
    resolveCapture(opts.headers);
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => '{}' };
  };
  try {
    const executor = new HttpToolExecutor({ credentialBroker: mockCredentialBroker() });
    await executor.execute({
      method: 'GET',
      url: 'https://api.github.com/repos/test/repo',
      auth: { type: 'none' },
    });
    const capturedHeaders = await capturePromise;
    assert.ok(!capturedHeaders['Authorization']);
    assert.ok(!capturedHeaders['X-API-Key']);
    assert.strictEqual(capturedHeaders['User-Agent'], 'MoltAgent/1.0');
  } finally {
    restoreFetch();
  }
});

// -----------------------------------------------------------------------------
// URL Resolution Tests
// -----------------------------------------------------------------------------

asyncTest('TC-HTE-030: resolves {{param}} placeholders in URL', async () => {
  let resolveCapture;
  const capturePromise = new Promise((res) => { resolveCapture = res; });
  global.fetch = async (url, opts) => {
    resolveCapture(url);
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => '{}' };
  };
  try {
    const executor = new HttpToolExecutor({ credentialBroker: mockCredentialBroker() });
    await executor.execute(
      { method: 'GET', url: 'https://api.github.com/repos/{{owner}}/{{repo}}' },
      { owner: 'acme', repo: 'widget' },
    );
    const capturedUrl = await capturePromise;
    assert.ok(capturedUrl.includes('/repos/acme/widget'));
  } finally {
    restoreFetch();
  }
});

asyncTest('TC-HTE-031: encodeURIComponent applied to placeholder values', async () => {
  let resolveCapture;
  const capturePromise = new Promise((res) => { resolveCapture = res; });
  global.fetch = async (url, opts) => {
    resolveCapture(url);
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => '{}' };
  };
  try {
    const executor = new HttpToolExecutor({ credentialBroker: mockCredentialBroker() });
    await executor.execute(
      { method: 'GET', url: 'https://api.github.com/search?q={{query}}' },
      { query: 'hello world & more' },
    );
    // encodeURIComponent('hello world & more') = 'hello%20world%20%26%20more'
    const capturedUrl = await capturePromise;
    assert.ok(capturedUrl.includes('hello%20world'));
    assert.ok(!capturedUrl.includes('hello world'));
  } finally {
    restoreFetch();
  }
});

asyncTest('TC-HTE-032: leaves URL unchanged when no placeholders present', async () => {
  let resolveCapture;
  const capturePromise = new Promise((res) => { resolveCapture = res; });
  global.fetch = async (url, opts) => {
    resolveCapture(url);
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => '{}' };
  };
  try {
    const executor = new HttpToolExecutor({ credentialBroker: mockCredentialBroker() });
    const plainUrl = 'https://api.github.com/repos/test/repo';
    await executor.execute({ method: 'GET', url: plainUrl });
    const capturedUrl = await capturePromise;
    assert.ok(capturedUrl.startsWith(plainUrl));
  } finally {
    restoreFetch();
  }
});

// -----------------------------------------------------------------------------
// Execute — Success Cases
// -----------------------------------------------------------------------------

asyncTest('TC-HTE-040: GET request returns success with parsed JSON body', async () => {
  const executor = new HttpToolExecutor({ credentialBroker: mockCredentialBroker() });
  mockFetch({ status: 200, body: { id: 1, name: 'test-repo' } });
  try {
    const result = await executor.execute(BASE_CONFIG);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.data.id, 1);
    assert.strictEqual(result.data.name, 'test-repo');
    assert.strictEqual(result.error, undefined);
  } finally {
    restoreFetch();
  }
});

asyncTest('TC-HTE-041: POST request sends JSON body with bodyFields', async () => {
  let resolveCapture;
  const capturePromise = new Promise((res) => { resolveCapture = res; });
  global.fetch = async (url, opts) => {
    resolveCapture({ body: opts.body, headers: opts.headers });
    return { ok: true, status: 201, headers: { get: () => null }, text: async () => JSON.stringify({ created: true }) };
  };
  try {
    const executor = new HttpToolExecutor({ credentialBroker: mockCredentialBroker() });
    const result = await executor.execute(
      {
        method: 'POST',
        url: 'https://api.github.com/repos/test/repo/issues',
        bodyType: 'json',
        bodyFields: ['title', 'body'],
      },
      { title: 'Bug report', body: 'Details here', ignoredField: 'x' },
    );
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.status, 201);
    const { body: capturedBody, headers: capturedHeaders } = await capturePromise;
    const parsed = JSON.parse(capturedBody);
    assert.strictEqual(parsed.title, 'Bug report');
    assert.strictEqual(parsed.body, 'Details here');
    // ignoredField must NOT appear in the body
    assert.strictEqual(parsed.ignoredField, undefined);
    assert.strictEqual(capturedHeaders['Content-Type'], 'application/json');
  } finally {
    restoreFetch();
  }
});

asyncTest('TC-HTE-042: query params appended to URL from queryParams list', async () => {
  let resolveCapture;
  const capturePromise = new Promise((res) => { resolveCapture = res; });
  global.fetch = async (url, opts) => {
    resolveCapture(url);
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => '[]' };
  };
  try {
    const executor = new HttpToolExecutor({ credentialBroker: mockCredentialBroker() });
    await executor.execute(
      {
        method: 'GET',
        url: 'https://api.github.com/search/repositories',
        queryParams: ['q', 'sort'],
      },
      { q: 'moltagent', sort: 'stars', unrelated: 'skip' },
    );
    const capturedUrl = await capturePromise;
    assert.ok(capturedUrl.includes('q=moltagent'));
    assert.ok(capturedUrl.includes('sort=stars'));
    assert.ok(!capturedUrl.includes('unrelated'));
  } finally {
    restoreFetch();
  }
});

// -----------------------------------------------------------------------------
// Execute — Error Cases
// -----------------------------------------------------------------------------

asyncTest('TC-HTE-050: returns error when named credential not found in broker', async () => {
  const executor = new HttpToolExecutor({
    credentialBroker: mockCredentialBroker({}), // empty — no credentials registered
  });
  const result = await executor.execute({
    method: 'GET',
    url: 'https://api.github.com/repos/test/repo',
    auth: { type: 'bearer', credentialName: 'missing-token' },
  });
  assert.strictEqual(result.success, false);
  assert.ok(result.error.includes('missing-token'));
  assert.ok(result.error.toLowerCase().includes('not found'));
});

asyncTest('TC-HTE-051: returns error when EgressGuard blocks the domain', async () => {
  const executor = new HttpToolExecutor({
    credentialBroker: mockCredentialBroker(),
    egressGuard: mockEgressGuard(false), // blocks everything
  });
  const result = await executor.execute(BASE_CONFIG);
  assert.strictEqual(result.success, false);
  assert.ok(result.error.toLowerCase().includes('blocked') || result.error.toLowerCase().includes('egress'));
});

asyncTest('TC-HTE-052: returns SSRF error when URL resolves to private IP', async () => {
  const executor = new HttpToolExecutor({ credentialBroker: mockCredentialBroker() });
  const result = await executor.execute({
    method: 'GET',
    url: 'http://192.168.0.1/api',
  });
  assert.strictEqual(result.success, false);
  assert.ok(result.error.includes('SSRF'));
});

asyncTest('TC-HTE-053: returns error on HTTP 404 status', async () => {
  mockFetch({ status: 404, body: { message: 'Not Found' } });
  try {
    const executor = new HttpToolExecutor({ credentialBroker: mockCredentialBroker() });
    const result = await executor.execute(BASE_CONFIG);
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.status, 404);
    assert.ok(result.error.includes('404'));
  } finally {
    restoreFetch();
  }
});

asyncTest('TC-HTE-054: returns error on HTTP 500 status', async () => {
  mockFetch({ status: 500, body: 'Internal Server Error' });
  try {
    const executor = new HttpToolExecutor({ credentialBroker: mockCredentialBroker() });
    const result = await executor.execute(BASE_CONFIG);
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.status, 500);
    assert.ok(result.error.includes('500'));
  } finally {
    restoreFetch();
  }
});

asyncTest('TC-HTE-055: returns timeout error when fetch is aborted', async () => {
  // Replace fetch with one that simulates an AbortError
  global.fetch = async (url, opts) => {
    // Wait for the signal to fire, then throw an AbortError
    await new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  };
  try {
    const executor = new HttpToolExecutor({
      credentialBroker: mockCredentialBroker(),
      timeoutMs: 50, // very short so the abort fires quickly
    });
    const result = await executor.execute(BASE_CONFIG);
    assert.strictEqual(result.success, false);
    assert.ok(result.error.toLowerCase().includes('timed out'));
  } finally {
    restoreFetch();
  }
});

// -----------------------------------------------------------------------------
// Response Handling Tests
// -----------------------------------------------------------------------------

asyncTest('TC-HTE-060: parses JSON response body into structured data', async () => {
  const payload = { repos: [{ id: 1 }, { id: 2 }], total: 2 };
  mockFetch({ status: 200, body: payload });
  try {
    const executor = new HttpToolExecutor({ credentialBroker: mockCredentialBroker() });
    const result = await executor.execute(BASE_CONFIG);
    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(result.data, payload);
  } finally {
    restoreFetch();
  }
});

asyncTest('TC-HTE-061: falls back to plain text when response is not valid JSON', async () => {
  const plainText = 'OK — operation completed successfully';
  global.fetch = async (url, opts) => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => plainText,
  });
  try {
    const executor = new HttpToolExecutor({ credentialBroker: mockCredentialBroker() });
    const result = await executor.execute(BASE_CONFIG);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.data, plainText);
  } finally {
    restoreFetch();
  }
});

// -----------------------------------------------------------------------------
// Cleanup: ensure global.fetch is restored after all async tests complete
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Session Auth Tests (sequential — share global.fetch, must not race)
// Delayed start to let previous fire-and-forget async tests settle.
// -----------------------------------------------------------------------------
setTimeout(async () => {

/**
 * Mock fetch that returns different responses for different URLs.
 * @param {Object} urlResponses - Map of URL substring → mock response
 */
function mockFetchByUrl(urlResponses) {
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    for (const [pattern, resp] of Object.entries(urlResponses)) {
      if (url.includes(pattern)) {
        const headerMap = new Map(Object.entries(resp.headers || {}));
        return {
          ok: resp.ok !== undefined ? resp.ok : true,
          status: resp.status || 200,
          headers: { get: (name) => headerMap.get(name) ?? null },
          text: async () => (typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body)),
        };
      }
    }
    return { ok: false, status: 404, headers: { get: () => null }, text: async () => 'Not found' };
  };
  return calls;
}

const SESSION_AUTH = {
  type: 'session',
  credential_name: 'bluesky',
  session_endpoint: 'https://bsky.social/xrpc/com.atproto.server.createSession',
  session_method: 'POST',
  session_body: {
    identifier: '{{credential.handle}}',
    password: '{{credential.appPassword}}',
  },
  token_path: 'accessJwt',
  extra_from_session: { did: 'did' },
  token_ttl: 7200,
};

await asyncTest('Session auth: creates session and uses token for API call', async () => {
  const calls = mockFetchByUrl({
    'createSession': {
      body: { accessJwt: 'test-jwt-token', did: 'did:plc:test123' },
    },
    'createRecord': {
      body: { uri: 'at://did:plc:test123/app.bsky.feed.post/abc', cid: 'baf123' },
    },
  });

  try {
    const executor = new HttpToolExecutor({
      credentialBroker: mockCredentialBroker({
        bluesky: { handle: 'test.bsky.social', appPassword: 'secret-app-pw' },
      }),
    });

    const result = await executor.execute({
      method: 'POST',
      url: 'https://bsky.social/xrpc/com.atproto.repo.createRecord',
      auth: SESSION_AUTH,
      bodyType: 'json',
      bodyTemplate: {
        repo: '{{session.did}}',
        collection: 'app.bsky.feed.post',
        record: {
          text: '{{params.text}}',
          '$type': 'app.bsky.feed.post',
          createdAt: '{{now_iso}}',
        },
      },
    }, { text: 'Hello Bluesky!' });

    assert.strictEqual(result.success, true, `request should succeed, error: ${result.error}`);
    assert.strictEqual(calls.length, 2, 'should make 2 fetch calls (session + API)');

    // Verify session call
    const sessionCall = calls[0];
    assert.ok(sessionCall.url.includes('createSession'), 'first call is session');
    const sessionBody = JSON.parse(sessionCall.opts.body);
    assert.strictEqual(sessionBody.identifier, 'test.bsky.social');
    assert.strictEqual(sessionBody.password, 'secret-app-pw');

    // Verify API call uses Bearer token
    const apiCall = calls[1];
    assert.strictEqual(apiCall.opts.headers['Authorization'], 'Bearer test-jwt-token');

    // Verify body template resolution
    const apiBody = JSON.parse(apiCall.opts.body);
    assert.strictEqual(apiBody.repo, 'did:plc:test123', 'session.did resolved');
    assert.strictEqual(apiBody.record.text, 'Hello Bluesky!', 'params.text resolved');
    assert.ok(apiBody.record.createdAt.includes('T'), 'now_iso resolved to ISO timestamp');
    assert.strictEqual(apiBody.collection, 'app.bsky.feed.post', 'literal value preserved');
  } finally {
    restoreFetch();
  }
});

await asyncTest('Session auth: caches token across calls', async () => {
  let sessionCallCount = 0;
  mockFetchByUrl({
    'createSession': {
      body: { accessJwt: 'cached-jwt', did: 'did:plc:cached' },
    },
    'createRecord': { body: { uri: 'at://x', cid: 'c' } },
    'getPosts': { body: { posts: [] } },
  });
  // Override to count session calls
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (url.includes('createSession')) sessionCallCount++;
    return origFetch(url, opts);
  };

  try {
    const executor = new HttpToolExecutor({
      credentialBroker: mockCredentialBroker({
        bluesky: { handle: 'test.bsky.social', appPassword: 'pw' },
      }),
    });

    // First call: creates session
    await executor.execute({
      method: 'POST', url: 'https://bsky.social/xrpc/com.atproto.repo.createRecord',
      auth: SESSION_AUTH, bodyType: 'json', bodyTemplate: { repo: '{{session.did}}' },
    }, {});

    // Second call: should reuse cached token
    await executor.execute({
      method: 'GET', url: 'https://bsky.social/xrpc/app.bsky.feed.getPosts?uris=at://x',
      auth: SESSION_AUTH,
    }, {});

    assert.strictEqual(sessionCallCount, 1, 'session endpoint called only once (cached)');
  } finally {
    restoreFetch();
  }
});

await asyncTest('Session auth: re-authenticates on 401', async () => {
  let callCount = 0;
  global.fetch = async (url, opts) => {
    callCount++;
    const headerMap = new Map();
    if (url.includes('createSession')) {
      return {
        ok: true, status: 200, headers: { get: () => null },
        text: async () => JSON.stringify({ accessJwt: `jwt-${callCount}`, did: 'did:plc:x' }),
      };
    }
    // First API call returns 401, retry succeeds
    if (callCount <= 3) {
      return { ok: false, status: 401, headers: { get: () => null }, text: async () => '{"error":"ExpiredToken"}' };
    }
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => '{"success":true}' };
  };

  try {
    const executor = new HttpToolExecutor({
      credentialBroker: mockCredentialBroker({
        bluesky: { handle: 'h', appPassword: 'p' },
      }),
    });

    const result = await executor.execute({
      method: 'POST', url: 'https://bsky.social/xrpc/com.atproto.repo.createRecord',
      auth: SESSION_AUTH, bodyType: 'json', bodyTemplate: { repo: '{{session.did}}' },
    }, {});

    assert.strictEqual(result.success, true, 'should succeed after re-auth');
    assert.ok(callCount >= 4, 'should have made session + api + re-session + retry calls');
  } finally {
    restoreFetch();
  }
});

await asyncTest('Session auth: SSRF blocks private session_endpoint', async () => {
  const executor = new HttpToolExecutor({
    credentialBroker: mockCredentialBroker({ bluesky: { handle: 'h', appPassword: 'p' } }),
  });

  const result = await executor.execute({
    method: 'GET', url: 'https://bsky.social/xrpc/test',
    auth: { ...SESSION_AUTH, session_endpoint: 'http://192.168.1.1/session' },
  }, {});

  assert.strictEqual(result.success, false);
  assert.ok(result.error.includes('SSRF'), 'should mention SSRF');
});

await asyncTest('Session auth: errors on missing credential', async () => {
  mockFetch({ body: {} });
  try {
    const executor = new HttpToolExecutor({
      credentialBroker: mockCredentialBroker({}), // no bluesky credential
    });

    const result = await executor.execute({
      method: 'GET', url: 'https://bsky.social/xrpc/test',
      auth: SESSION_AUTH,
    }, {});

    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('not found'), 'error mentions credential not found');
  } finally {
    restoreFetch();
  }
});

// Sync tests follow (no fetch dependency)
}, 200); // end session auth delayed block

// ─── _resolveTemplate tests ──────────────────────────────────────────

test('_resolveTemplate: resolves {{params.x}}, {{session.x}}, {{now_iso}}', () => {
  const executor = new HttpToolExecutor({ credentialBroker: mockCredentialBroker() });
  const result = executor._resolveTemplate(
    { text: '{{params.text}}', did: '{{session.did}}', ts: '{{now_iso}}', literal: 'unchanged' },
    { params: { text: 'hello' }, session: { did: 'did:plc:123' }, credential: {} }
  );
  assert.strictEqual(result.text, 'hello');
  assert.strictEqual(result.did, 'did:plc:123');
  assert.ok(result.ts.includes('T'), 'now_iso is ISO timestamp');
  assert.strictEqual(result.literal, 'unchanged');
});

test('_resolveTemplate: handles nested objects and arrays', () => {
  const executor = new HttpToolExecutor({ credentialBroker: mockCredentialBroker() });
  const result = executor._resolveTemplate(
    { record: { text: '{{params.text}}', tags: ['{{params.tag}}', 'fixed'] } },
    { params: { text: 'hi', tag: 'test' }, session: {}, credential: {} }
  );
  assert.strictEqual(result.record.text, 'hi');
  assert.strictEqual(result.record.tags[0], 'test');
  assert.strictEqual(result.record.tags[1], 'fixed');
});

test('_resolveTemplate: unknown placeholders left as-is', () => {
  const executor = new HttpToolExecutor({ credentialBroker: mockCredentialBroker() });
  const result = executor._resolveTemplate('{{unknown.key}}', { params: {}, session: {}, credential: {} });
  assert.strictEqual(result, '{{unknown.key}}');
});

test('_getNestedValue: extracts dot-notation paths', () => {
  const executor = new HttpToolExecutor({ credentialBroker: mockCredentialBroker() });
  assert.strictEqual(executor._getNestedValue({ a: { b: { c: 42 } } }, 'a.b.c'), 42);
  assert.strictEqual(executor._getNestedValue({ accessJwt: 'tok' }, 'accessJwt'), 'tok');
  assert.strictEqual(executor._getNestedValue({}, 'missing'), undefined);
  assert.strictEqual(executor._getNestedValue(null, 'x'), undefined);
});

setTimeout(() => {
  // Final safety restore — guards against any test that failed inside try/finally
  global.fetch = originalFetch;
  console.log('\n=== HttpToolExecutor Tests Complete ===\n');
  summary();
  exitWithCode();
}, 3000);
