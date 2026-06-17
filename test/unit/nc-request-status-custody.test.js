/**
 * Moltagent - NCRequestManager HTTP status custody tests
 *
 * Copyright (C) 2026 Moltagent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 * Architecture Brief:
 * -------------------
 * Verifies the status-custody invariant: every rejection caused by a non-2xx
 * HTTP status carries .statusCode equal to that status.  Without this, the
 * findBoard() 403-self-heal branch (err.statusCode === 403) can never fire in
 * production even though the branch exists in the code (#49/#123/#133 class:
 * signals keep custody).
 *
 * Seam: _httpRequest is overridden on the instance to return a synthetic
 * {status, statusText, headers, body} response, bypassing the real network
 * layer entirely.  maxRetries is set to 0 so 429 exhausts immediately.
 *
 * Run: NC_URL=https://test.example.com node test/unit/nc-request-status-custody.test.js
 *
 * @module test/unit/nc-request-status-custody
 */

'use strict';

const assert = require('assert');
const { asyncTest, summary, exitWithCode } = require('../helpers/test-runner');

// Stub fs.readFileSync so NCRequestManager can load without a real credential
// file, matching the idiom in the sibling nc-request-manager.test.js file.
const originalReadFileSync = require('fs').readFileSync;
require('fs').readFileSync = function(filePath, encoding) {
  if (typeof filePath === 'string' && filePath.includes('nc-password')) {
    return 'test-password';
  }
  return originalReadFileSync.call(this, filePath, encoding);
};

const NCRequestManager = require('../../src/lib/nc-request-manager');

// ============================================================
// Helpers
// ============================================================

/**
 * Build a minimal NCRequestManager instance with:
 *   - maxRetries = 0 so 429 exhausts on the very first attempt (no re-queue)
 *   - defaultRetryAfter = 0 so no sleep between attempts
 *   - _httpRequest stubbed to return the supplied synthetic response
 *   - _getGroupConfig patched so per-request maxRetries is also 0
 *     (the per-group config overrides ncResilience.maxRetries in production)
 *
 * @param {{ status, statusText?, headers?, body? }} syntheticResponse
 */
function makeNcWithStub(syntheticResponse) {
  const nc = new NCRequestManager({
    nextcloud: { url: 'https://test.example.com', username: 'testuser' },
    ncResilience: { maxRetries: 0, defaultRetryAfter: 0 }
  });
  nc.ncPassword = 'test-password';

  // Patch per-group config so maxRetries=0 is honoured at the request level too.
  const origGetGroupConfig = nc._getGroupConfig.bind(nc);
  nc._getGroupConfig = (group) => {
    const cfg = origGetGroupConfig(group);
    return { ...cfg, maxRetries: 0 };
  };

  // Override _httpRequest at the instance level — the only transport seam.
  nc._httpRequest = async () => ({
    status: syntheticResponse.status,
    statusText: syntheticResponse.statusText || String(syntheticResponse.status),
    headers: syntheticResponse.headers || {},
    body: syntheticResponse.body || ''
  });

  return nc;
}

// ============================================================
// Tests
// ============================================================

console.log('\n=== NCRequestManager HTTP status-custody tests ===\n');

// ---------------------------------------------------------------------------
// TC-STATUS-01: 401 rejection carries .statusCode === 401
// ---------------------------------------------------------------------------
asyncTest('TC-STATUS-01: request() rejects with .statusCode=401 on 401 response', async () => {
  const nc = makeNcWithStub({ status: 401 });

  let caughtErr = null;
  try {
    await nc.request('/index.php/apps/deck/api/v1.0/boards', { method: 'GET' });
  } catch (err) {
    caughtErr = err;
  }

  assert.ok(caughtErr !== null, 'request() must reject on 401');
  assert.strictEqual(caughtErr.statusCode, 401,
    `expected .statusCode=401, got ${caughtErr.statusCode}`);
  assert.strictEqual(caughtErr.message, 'Authentication error: 401',
    `message must be "Authentication error: 401", got "${caughtErr.message}"`);
});

// ---------------------------------------------------------------------------
// TC-STATUS-02: 403 rejection carries .statusCode === 403
// ---------------------------------------------------------------------------
asyncTest('TC-STATUS-02: request() rejects with .statusCode=403 on 403 response', async () => {
  const nc = makeNcWithStub({ status: 403 });

  let caughtErr = null;
  try {
    await nc.request('/index.php/apps/deck/api/v1.0/boards/99', { method: 'GET' });
  } catch (err) {
    caughtErr = err;
  }

  assert.ok(caughtErr !== null, 'request() must reject on 403');
  assert.strictEqual(caughtErr.statusCode, 403,
    `expected .statusCode=403, got ${caughtErr.statusCode}`);
  assert.strictEqual(caughtErr.message, 'Authentication error: 403',
    `message must be "Authentication error: 403", got "${caughtErr.message}"`);
});

// ---------------------------------------------------------------------------
// TC-STATUS-03: 429 rejection carries .statusCode === 429 (maxRetries exhausted)
// ---------------------------------------------------------------------------
asyncTest('TC-STATUS-03: request() rejects with .statusCode=429 after maxRetries exhausted', async () => {
  const nc = makeNcWithStub({ status: 429, headers: {} });

  let caughtErr = null;
  try {
    await nc.request('/ocs/v2.php/apps/spreed/api/v1/chat/room', { method: 'GET' });
  } catch (err) {
    caughtErr = err;
  }

  assert.ok(caughtErr !== null, 'request() must reject when 429 maxRetries exhausted');
  assert.strictEqual(caughtErr.statusCode, 429,
    `expected .statusCode=429, got ${caughtErr.statusCode}`);
  // Message must start with "Rate limited after" — the unchanged text that
  // existing consumers may parse.
  assert.ok(
    caughtErr.message.startsWith('Rate limited after'),
    `message must start with "Rate limited after", got "${caughtErr.message}"`
  );
});

// ---------------------------------------------------------------------------
// TC-STATUS-04: message strings are UNCHANGED (protects regex consumers)
// ---------------------------------------------------------------------------
asyncTest('TC-STATUS-04: 401 message string is exactly "Authentication error: 401"', async () => {
  const nc = makeNcWithStub({ status: 401 });
  let msg = null;
  try {
    await nc.request('/ocs/v2.php/test', { method: 'GET' });
  } catch (err) {
    msg = err.message;
  }
  assert.strictEqual(msg, 'Authentication error: 401');
});

asyncTest('TC-STATUS-05: 403 message string is exactly "Authentication error: 403"', async () => {
  const nc = makeNcWithStub({ status: 403 });
  let msg = null;
  try {
    await nc.request('/ocs/v2.php/test', { method: 'GET' });
  } catch (err) {
    msg = err.message;
  }
  assert.strictEqual(msg, 'Authentication error: 403');
});

// ---------------------------------------------------------------------------
// TC-STATUS-06: 404 resolves (not rejects) — regression guard
// ---------------------------------------------------------------------------
asyncTest('TC-STATUS-06: 404 resolves normally (not rejected) so callers can inspect status', async () => {
  const nc = makeNcWithStub({ status: 404, body: 'Not Found' });

  const response = await nc.request('/index.php/apps/deck/api/v1.0/boards/999', { method: 'GET' });
  assert.strictEqual(response.status, 404, 'resolved response.status must be 404');
  assert.strictEqual(response.fromCache, false);
});

// ---------------------------------------------------------------------------
// TC-STATUS-07: pre-existing ~line 584 pattern still works (5xx)
// ---------------------------------------------------------------------------
asyncTest('TC-STATUS-07: 500 rejection carries .statusCode=500 (pre-existing pattern regression guard)', async () => {
  // maxRetries=0 so 500 doesn't retry
  const nc = makeNcWithStub({ status: 500, statusText: 'Internal Server Error', body: 'boom' });

  let caughtErr = null;
  try {
    await nc.request('/index.php/apps/deck/api/v1.0/boards', { method: 'GET' });
  } catch (err) {
    caughtErr = err;
  }

  assert.ok(caughtErr !== null, 'request() must reject on 500');
  assert.strictEqual(caughtErr.statusCode, 500,
    `expected .statusCode=500, got ${caughtErr.statusCode}`);
});

// ============================================================
// Summary
// ============================================================

setTimeout(() => {
  summary();
  exitWithCode();
}, 500);
