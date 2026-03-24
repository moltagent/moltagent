/**
 * OAuthBroker Unit Tests
 *
 * Tests the OAuth 2.0 broker: PKCE generation, consent flow with NC Passwords
 * persistence, token refresh, client credentials, mutex, secure eviction.
 */

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { test, asyncTest, summary, exitWithCode } = require('../helpers/test-runner');
const { OAuthBroker } = require('../../src/skill-forge/oauth-broker');

const originalFetch = global.fetch;

// ─── Mock helpers ─────────────────────────────────────────────────────

function createMockNCRM(store = {}) {
  let nextId = 100;
  return {
    request: async (path, opts) => {
      if (path.includes('/password/list')) return { status: 200, body: Object.values(store) };
      if (path.includes('/password/create')) {
        const { label, password, username, url, notes } = opts.body;
        store[label] = { id: String(nextId++), label, password, username, url, notes };
        return { status: 200, body: { id: store[label].id } };
      }
      if (path.includes('/password/update')) {
        const { id, notes } = opts.body;
        const e = Object.values(store).find(e => e.id === id);
        if (e) e.notes = notes;
        return { status: 200, body: {} };
      }
      if (path.includes('/password/delete')) {
        const { id } = opts.body;
        const k = Object.keys(store).find(k => store[k].id === id);
        if (k) delete store[k];
        return { status: 200, body: {} };
      }
      return { status: 404, body: {} };
    },
  };
}

function mockBroker(ncStore) {
  return {
    get: async (name) => {
      const e = ncStore[name];
      if (!e) throw new Error(`Credential "${name}" not found`);
      const extras = {};
      if (e.notes) { try { Object.assign(extras, JSON.parse(e.notes)); } catch {} }
      return { password: e.password, username: e.username, user: e.username, url: e.url, notes: e.notes, ...extras };
    },
    listAvailable: async () => Object.keys(ncStore),
    clearCache: () => {},
  };
}

function mkBroker(ncStore, nc) {
  return new OAuthBroker({
    credentialBroker: mockBroker(ncStore),
    ncRequestManager: nc || createMockNCRM(ncStore),
    redirectUri: 'https://agent.example.com/oauth/callback',
  });
}

// ─── Sync Tests ───────────────────────────────────────────────────────

test('PKCE: generates valid code_verifier (base64url, 43+ chars)', () => {
  const b = mkBroker({});
  const v = b._generateCodeVerifier();
  assert.ok(v.length >= 43);
  assert.ok(/^[A-Za-z0-9_-]+$/.test(v));
});

test('PKCE: code_challenge is SHA-256 base64url of verifier', () => {
  const b = mkBroker({});
  const v = b._generateCodeVerifier();
  const c = b._generateCodeChallenge(v);
  assert.strictEqual(c, crypto.createHash('sha256').update(v).digest('base64url'));
});

// ─── All async tests run sequentially in one block ────────────────────

asyncTest('OAuth broker: all async tests', async () => {
  // --- 3: unique state ---
  {
    const s = { 'oauth-p': { id: '1', label: 'oauth-p', username: 'cid', password: 's', url: 'https://p.com/t', notes: '{"grant_type":"authorization_code"}' } };
    const b = mkBroker(s);
    const ta = { scope: 'r', authorize_endpoint: 'https://p.com/auth' };
    const u1 = await b.beginAuthorization(ta, 'oauth-p');
    const u2 = await b.beginAuthorization(ta, 'oauth-p');
    assert.ok(new URL(u1).searchParams.get('state') !== new URL(u2).searchParams.get('state'), 'unique state per call');
  }

  // --- 4: pending persisted ---
  {
    const s = { 'oauth-p2': { id: '2', label: 'oauth-p2', username: 'cid', password: 's', url: 'https://p.com/t', notes: '{"grant_type":"authorization_code"}' } };
    const nc = createMockNCRM(s);
    const b = new OAuthBroker({ credentialBroker: mockBroker(s), ncRequestManager: nc, redirectUri: 'https://a.com/oauth/callback' });
    const url = await b.beginAuthorization({ scope: 'r', authorize_endpoint: 'https://p.com/auth' }, 'oauth-p2');
    const state = new URL(url).searchParams.get('state');
    const pending = s[`oauth-pending-${state}`];
    assert.ok(pending, 'pending entry persisted');
    assert.strictEqual(JSON.parse(pending.notes).type, 'oauth_pending');
    assert.ok(pending.password.length >= 43, 'verifier in password');
  }

  // --- 5: reject unknown state ---
  {
    const b = mkBroker({});
    try { await b.handleCallback('code', 'bad'); assert.fail(); } catch (e) { assert.ok(e.message.includes('Invalid or expired')); }
  }

  // --- 6: reject expired ---
  {
    const s = {
      'oauth-pending-exp1': { id: '50', label: 'oauth-pending-exp1', username: '', password: 'v', url: '',
        notes: JSON.stringify({ type: 'oauth_pending', credential_name: 'x', expires_at: Date.now() - 1000 }) },
    };
    const nc = createMockNCRM(s);
    const b = new OAuthBroker({ credentialBroker: mockBroker(s), ncRequestManager: nc, redirectUri: 'https://a.com/oauth/callback' });
    try { await b.handleCallback('code', 'exp1'); assert.fail(); } catch (e) { assert.ok(e.message.includes('expired')); }
    assert.ok(!s['oauth-pending-exp1'], 'expired entry deleted');
  }

  // --- 7: exchange code for tokens ---
  {
    const s = {
      'oauth-pending-v1': { id: '50', label: 'oauth-pending-v1', username: '', password: 'my-verifier',
        url: '', notes: JSON.stringify({ type: 'oauth_pending', credential_name: 'oauth-g', skill_id: 'g', expires_at: Date.now() + 300000 }) },
      'oauth-g': { id: '10', label: 'oauth-g', username: 'cid', password: 'cs',
        url: 'https://oauth2.googleapis.com/token', notes: '{"grant_type":"authorization_code"}' },
    };
    const nc = createMockNCRM(s);
    const b = new OAuthBroker({ credentialBroker: mockBroker(s), ncRequestManager: nc, redirectUri: 'https://a.com/oauth/callback' });
    let body = null;
    global.fetch = async (u, o) => { body = o.body; return { ok: true, status: 200, json: async () => ({ access_token: 'ya29', refresh_token: '1//r', expires_in: 3600, scope: 'cal' }) }; };
    try {
      const r = await b.handleCallback('code', 'v1');
      assert.strictEqual(r.success, true);
      assert.ok(!s['oauth-pending-v1'], 'pending deleted');
      const n = JSON.parse(s['oauth-g'].notes);
      assert.strictEqual(n.access_token, 'ya29');
      assert.strictEqual(n.refresh_token, '1//r');
      assert.ok(body.includes('my-verifier'), 'verifier in body');
    } finally { global.fetch = originalFetch; }
  }

  // --- 8: cached token ---
  {
    const s = { 'oauth-c': { id: '20', label: 'oauth-c', username: 'c', password: 's', url: 'https://p.com/t',
      notes: JSON.stringify({ grant_type: 'authorization_code', access_token: 'valid', refresh_token: 'r', expires_at: Date.now() + 300000 }) } };
    assert.strictEqual(await mkBroker(s).getAccessToken('oauth-c'), 'valid');
  }

  // --- 9: refresh expired ---
  {
    const s = { 'oauth-e': { id: '30', label: 'oauth-e', username: 'c', password: 's', url: 'https://p.com/t',
      notes: JSON.stringify({ grant_type: 'authorization_code', access_token: 'old', refresh_token: 'r', expires_at: Date.now() - 1000 }) } };
    const nc = createMockNCRM(s);
    const b = new OAuthBroker({ credentialBroker: mockBroker(s), ncRequestManager: nc, redirectUri: 'https://a.com/oauth/callback' });
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ access_token: 'fresh', expires_in: 3600 }) });
    try {
      assert.strictEqual(await b.getAccessToken('oauth-e'), 'fresh');
      assert.strictEqual(JSON.parse(s['oauth-e'].notes).access_token, 'fresh');
    } finally { global.fetch = originalFetch; }
  }

  // --- 10: token rotation ---
  {
    const s = { 'oauth-r': { id: '31', label: 'oauth-r', username: 'c', password: 's', url: 'https://p.com/t',
      notes: JSON.stringify({ grant_type: 'authorization_code', access_token: 'old', refresh_token: 'old-r', expires_at: Date.now() - 1000 }) } };
    const nc = createMockNCRM(s);
    const b = new OAuthBroker({ credentialBroker: mockBroker(s), ncRequestManager: nc, redirectUri: 'https://a.com/oauth/callback' });
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ access_token: 'new', refresh_token: 'rotated', expires_in: 3600 }) });
    try {
      await b.getAccessToken('oauth-r');
      assert.strictEqual(JSON.parse(s['oauth-r'].notes).refresh_token, 'rotated');
    } finally { global.fetch = originalFetch; }
  }

  // --- 11: missing refresh_token ---
  {
    const s = { 'oauth-nr': { id: '32', label: 'oauth-nr', username: 'c', password: 's', url: 'https://p.com/t',
      notes: JSON.stringify({ grant_type: 'authorization_code', access_token: 'old', expires_at: Date.now() - 1000 }) } };
    try { await mkBroker(s).getAccessToken('oauth-nr'); assert.fail(); } catch (e) { assert.ok(e.message.includes('Reauthorization required')); }
  }

  // --- 12: forceRefresh ---
  {
    const s = { 'oauth-fr': { id: '33', label: 'oauth-fr', username: 'c', password: 's', url: 'https://p.com/t',
      notes: JSON.stringify({ grant_type: 'authorization_code', access_token: 'valid', refresh_token: 'r', expires_at: Date.now() + 300000 }) } };
    const nc = createMockNCRM(s);
    const b = new OAuthBroker({ credentialBroker: mockBroker(s), ncRequestManager: nc, redirectUri: 'https://a.com/oauth/callback' });
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ access_token: 'forced', expires_in: 3600 }) });
    try {
      assert.strictEqual(await b.getAccessToken('oauth-fr', { forceRefresh: true }), 'forced');
    } finally { global.fetch = originalFetch; }
  }

  // --- 13: client_credentials acquire ---
  {
    const s = { 'oauth-cc': { id: '40', label: 'oauth-cc', username: 'svc', password: 'scs', url: 'https://p.com/t',
      notes: JSON.stringify({ grant_type: 'client_credentials', scope: 'read' }) } };
    const nc = createMockNCRM(s);
    const b = new OAuthBroker({ credentialBroker: mockBroker(s), ncRequestManager: nc, redirectUri: 'https://a.com/oauth/callback' });
    let body = null;
    global.fetch = async (u, o) => { body = o.body; return { ok: true, status: 200, json: async () => ({ access_token: 'cc-tok', expires_in: 7200 }) }; };
    try {
      assert.strictEqual(await b.getAccessToken('oauth-cc'), 'cc-tok');
      assert.ok(body.includes('grant_type=client_credentials'));
    } finally { global.fetch = originalFetch; }
  }

  // --- 14: client_credentials cached ---
  {
    const s = { 'oauth-cc2': { id: '41', label: 'oauth-cc2', username: 'c', password: 's', url: 'https://p.com/t',
      notes: JSON.stringify({ grant_type: 'client_credentials', access_token: 'cached-cc', expires_at: Date.now() + 300000 }) } };
    assert.strictEqual(await mkBroker(s).getAccessToken('oauth-cc2'), 'cached-cc');
  }

  // --- 15: mutex ---
  {
    let cnt = 0;
    const s = { 'oauth-m': { id: '50', label: 'oauth-m', username: 'c', password: 's', url: 'https://p.com/t',
      notes: JSON.stringify({ grant_type: 'authorization_code', access_token: 'old', refresh_token: 'r', expires_at: Date.now() - 1000 }) } };
    const nc = createMockNCRM(s);
    const b = new OAuthBroker({ credentialBroker: mockBroker(s), ncRequestManager: nc, redirectUri: 'https://a.com/oauth/callback' });
    global.fetch = async () => { cnt++; return { ok: true, status: 200, json: async () => ({ access_token: `mtx-${cnt}`, expires_in: 3600 }) }; };
    try {
      const [t1, t2] = await Promise.all([b.getAccessToken('oauth-m'), b.getAccessToken('oauth-m')]);
      assert.ok(t1, 'first token');
      assert.ok(t2, 'second token');
    } finally { global.fetch = originalFetch; }
  }

  // --- 16: cleanExpiredPending ---
  {
    const s = {
      'oauth-pending-f': { id: '60', label: 'oauth-pending-f', username: '', password: 'v', url: '',
        notes: JSON.stringify({ type: 'oauth_pending', expires_at: Date.now() + 300000 }) },
      'oauth-pending-s': { id: '61', label: 'oauth-pending-s', username: '', password: 'v', url: '',
        notes: JSON.stringify({ type: 'oauth_pending', expires_at: Date.now() - 60000 }) },
      'oauth-real': { id: '62', label: 'oauth-real', username: 'c', password: 's', url: 'https://e.com/t',
        notes: JSON.stringify({ grant_type: 'authorization_code', access_token: 't' }) },
    };
    const nc = createMockNCRM(s);
    const b = new OAuthBroker({ credentialBroker: mockBroker(s), ncRequestManager: nc, redirectUri: 'https://a.com/oauth/callback' });
    const r = await b.cleanExpiredPending();
    assert.strictEqual(r.deleted, 1);
    assert.ok(!s['oauth-pending-s']);
    assert.ok(s['oauth-pending-f']);
    assert.ok(s['oauth-real']);
  }

  // --- 17: secure eviction ---
  {
    let cap = null;
    const b = new OAuthBroker({
      credentialBroker: {
        get: async () => { cap = { password: 'sec', username: 'c', url: 'https://p.com/t', access_token: 'tok', refresh_token: 'ref', grant_type: 'authorization_code', expires_at: Date.now() + 300000 }; return cap; },
        listAvailable: async () => [], clearCache: () => {},
      },
      ncRequestManager: createMockNCRM({}),
      redirectUri: 'https://a.com/oauth/callback',
    });
    assert.strictEqual(await b.getAccessToken('oauth-x'), 'tok');
    assert.ok(cap.access_token.includes('*'), 'access_token overwritten');
    assert.ok(cap.refresh_token.includes('*'), 'refresh_token overwritten');
    assert.ok(cap.password.includes('*'), 'password overwritten');
  }
});

setTimeout(() => {
  global.fetch = originalFetch;
  summary();
  exitWithCode();
}, 500);
