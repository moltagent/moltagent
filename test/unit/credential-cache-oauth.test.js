/**
 * CredentialCache OAuth Tests
 *
 * Tests that 'oauth-*' named credentials return complex objects
 * with parsed notes JSON.
 */

'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../helpers/test-runner');
const CredentialCache = require('../../src/lib/credential-cache');

// ─── Mock NCRequestManager ───────────────────────────────────────────

function createMockNC(entries) {
  return {
    request: async () => ({
      status: 200,
      body: entries,
    }),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────

// Test 1: oauth-* name returns complex object
asyncTest('oauth-* credential returns complex object (not just password)', async () => {
  const cache = new CredentialCache(createMockNC([
    {
      label: 'oauth-google-calendar',
      password: 'client-secret-value',
      username: 'client-id-value',
      url: 'https://oauth2.googleapis.com/token',
      notes: JSON.stringify({
        grant_type: 'authorization_code',
        access_token: 'ya29.test-token',
        refresh_token: '1//test-refresh',
        expires_at: 1711234567890,
      }),
    },
  ]), { cacheTTL: 5000 });

  const cred = await cache.get('oauth-google-calendar');

  // Should be an object, not a string
  assert.strictEqual(typeof cred, 'object', 'should return object');
  assert.strictEqual(cred.password, 'client-secret-value');
  assert.strictEqual(cred.username, 'client-id-value');
  assert.strictEqual(cred.url, 'https://oauth2.googleapis.com/token');
  assert.strictEqual(cred.host, 'oauth2.googleapis.com');
});

// Test 2: Notes JSON is parsed into top-level fields
asyncTest('oauth credential notes JSON parsed via _parseExtras', async () => {
  const cache = new CredentialCache(createMockNC([
    {
      label: 'oauth-service-api',
      password: 'secret',
      username: 'client-id',
      url: 'https://auth.example.com/token',
      notes: JSON.stringify({
        grant_type: 'client_credentials',
        access_token: 'eyJ.test',
        expires_at: 9999999999999,
        scope: 'read:data',
      }),
    },
  ]), { cacheTTL: 5000 });

  const cred = await cache.get('oauth-service-api');

  // _parseExtras should have merged notes JSON into the credential object
  assert.strictEqual(cred.grant_type, 'client_credentials');
  assert.strictEqual(cred.access_token, 'eyJ.test');
  assert.strictEqual(cred.expires_at, 9999999999999);
  assert.strictEqual(cred.scope, 'read:data');
});

// Cleanup and report
setTimeout(() => {
  summary();
  exitWithCode();
}, 500);
