/**
 * NCStatusIndicator Unit Tests
 *
 * Tests for the NC Status Indicator module which sets Molti's
 * Nextcloud user status via the OCS User Status API.
 *
 * Run: node test/unit/nc-status-indicator.test.js
 *
 * Test plan (4 tests from briefing):
 *   1. setStatus('ready') calls OCS with statusType 'online' and message 'Ready'
 *   2. setStatus() skips API call when state unchanged (no-op optimization)
 *   3. setStatus('shutdown') calls DELETE on custom message
 *   4. setStatus() doesn't throw on API failure (best-effort)
 */

'use strict';

const assert = require('assert');

// We need to require the module under test. The config module is loaded
// as a side effect, so we set required env vars before requiring.
process.env.NC_URL = 'https://test.example.com';
process.env.NC_USER = 'testbot';

const NCStatusIndicator = require('../../src/lib/integrations/nc-status-indicator');

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

let testsPassed = 0;
let testsFailed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  [PASS] ${name}`);
    testsPassed++;
  } catch (error) {
    console.log(`  [FAIL] ${name}`);
    console.log(`         ${error.message}`);
    testsFailed++;
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`  [PASS] ${name}`);
    testsPassed++;
  } catch (error) {
    console.log(`  [FAIL] ${name}`);
    console.log(`         ${error.message}`);
    testsFailed++;
  }
}

/**
 * Create a mock NCRequestManager that records calls to request().
 * @returns {{ mock: Object, calls: Array }}
 */
function createMockNCRequestManager() {
  const calls = [];
  const mock = {
    request: async (url, options) => {
      calls.push({ url, options });
      return { status: 200, headers: {}, body: { ocs: { data: {} } } };
    }
  };
  return { mock, calls };
}

/**
 * Create a mock NCRequestManager that throws on request().
 * @param {string} errorMessage
 * @returns {Object}
 */
function createFailingMockNCRequestManager(errorMessage) {
  return {
    request: async () => {
      throw new Error(errorMessage);
    }
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log('\n=== NCStatusIndicator Tests ===\n');

// Test 1: setStatus('ready') calls OCS with statusType 'online' and message 'Ready'
asyncTest('setStatus("ready") sends correct OCS calls for online + Ready', async () => {
  // Setup
  const { mock, calls } = createMockNCRequestManager();
  const indicator = new NCStatusIndicator({ ncRequestManager: mock, config: {} });

  // Act
  await indicator.setStatus('ready');

  // Assert
  assert.strictEqual(calls.length, 2, 'Should make 2 API calls');

  // First call: set presence status
  assert.ok(calls[0].url.includes('/user_status/status'), 'First call should be to /user_status/status');
  assert.strictEqual(calls[0].options.method, 'PUT', 'First call should be PUT');
  const firstBody = JSON.parse(calls[0].options.body);
  assert.strictEqual(firstBody.statusType, 'online', 'Should set statusType to online');

  // Second call: set custom message
  assert.ok(calls[1].url.includes('/user_status/message/custom'), 'Second call should be to /user_status/message/custom');
  assert.strictEqual(calls[1].options.method, 'PUT', 'Second call should be PUT');
  const secondBody = JSON.parse(calls[1].options.body);
  assert.strictEqual(secondBody.message, 'Ready', 'Should set message to Ready');
  assert.strictEqual(secondBody.statusIcon, '🟢', 'Should set icon to green circle');

  // Current status should be updated
  assert.strictEqual(indicator.getCurrentStatus(), 'ready', 'Current status should be ready');
});

// Test 2: setStatus() skips API call when state unchanged (no-op optimization)
asyncTest('setStatus() skips API call when state unchanged', async () => {
  // Setup
  const { mock, calls } = createMockNCRequestManager();
  const indicator = new NCStatusIndicator({ ncRequestManager: mock, config: {} });

  // Act
  await indicator.setStatus('ready');  // First call: should make API requests
  const callsAfterFirst = calls.length;
  await indicator.setStatus('ready');  // Second call: should be a no-op

  // Assert
  assert.strictEqual(calls.length, callsAfterFirst, 'Should not make new API calls for unchanged state');
  assert.strictEqual(indicator.getCurrentStatus(), 'ready', 'Current status should still be ready');
});

// Test 3: setStatus('shutdown') calls DELETE on custom message
asyncTest('setStatus("shutdown") sets offline and DELETEs custom message', async () => {
  // Setup
  const { mock, calls } = createMockNCRequestManager();
  const indicator = new NCStatusIndicator({ ncRequestManager: mock, config: {} });

  // Act
  await indicator.setStatus('shutdown');

  // Assert
  assert.strictEqual(calls.length, 2, 'Should make 2 API calls');

  // First call: set presence status to offline
  assert.ok(calls[0].url.includes('/user_status/status'), 'First call should be to /user_status/status');
  assert.strictEqual(calls[0].options.method, 'PUT', 'First call should be PUT');
  const firstBody = JSON.parse(calls[0].options.body);
  assert.strictEqual(firstBody.statusType, 'offline', 'Should set statusType to offline');

  // Second call: delete custom message
  assert.ok(calls[1].url.includes('/user_status/message'), 'Second call should be to /user_status/message');
  assert.ok(!calls[1].url.includes('/custom'), 'Second call should NOT include /custom');
  assert.strictEqual(calls[1].options.method, 'DELETE', 'Second call should be DELETE');

  // Current status should be updated
  assert.strictEqual(indicator.getCurrentStatus(), 'shutdown', 'Current status should be shutdown');
});

// Test 4: setStatus() doesn't throw on API failure (best-effort)
asyncTest('setStatus() does not throw when API fails', async () => {
  // Setup
  const failingMock = createFailingMockNCRequestManager('Network timeout');
  const indicator = new NCStatusIndicator({ ncRequestManager: failingMock, config: {} });

  // Act + Assert: should NOT throw
  let didThrow = false;
  try {
    await indicator.setStatus('ready');
  } catch (err) {
    didThrow = true;
  }

  assert.strictEqual(didThrow, false, 'setStatus should not throw on API failure');
  assert.strictEqual(indicator.getCurrentStatus(), null, 'Current status should remain null after failure');
});

// Test 5 (bonus): disabled indicator skips all API calls
asyncTest('setStatus() skips API calls when disabled', async () => {
  // Setup
  const { mock, calls } = createMockNCRequestManager();
  const indicator = new NCStatusIndicator({
    ncRequestManager: mock,
    config: { statusIndicator: { enabled: false } }
  });

  // Act
  await indicator.setStatus('ready');

  // Assert
  assert.strictEqual(calls.length, 0, 'Should not make any API calls when disabled');
  assert.strictEqual(indicator.getCurrentStatus(), null, 'Current status should remain null when disabled');
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

// Note: Since tests are async, summary must wait. For the skeleton, this
// is sufficient — the implementer will use a proper test runner or add
// a top-level async wrapper.
setTimeout(() => {
  console.log(`\n=== Results: ${testsPassed} passed, ${testsFailed} failed ===\n`);
  if (testsFailed > 0) process.exit(1);
}, 500);
