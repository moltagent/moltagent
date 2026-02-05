/**
 * BotEnroller Unit Tests
 *
 * Tests the auto-enrollment of the NC Talk bot in rooms where
 * the MoltAgent user has been added.
 *
 * Run: node test/unit/integrations/bot-enroller.test.js
 *
 * @module test/unit/integrations/bot-enroller
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const { createMockNCRequestManager, createMockAuditLog } = require('../../helpers/mock-factories');

// Import module under test
const BotEnroller = require('../../../src/lib/integrations/bot-enroller');

// ============================================================
// Test Fixtures
// ============================================================

/**
 * Create a mock NCRequestManager with configurable route responses.
 * Routes are matched by "METHOD:/path" keys.
 * @param {Object} [routes={}] - Method:path -> response mappings
 * @returns {Object} Mock NCRequestManager
 */
function createMockNC(routes = {}) {
  const calls = [];

  return {
    _calls: calls,
    ncUrl: 'https://cloud.example.com',
    ncUser: 'moltagent',
    request: async (path, options = {}) => {
      const method = (options.method || 'GET').toUpperCase();
      const key = `${method}:${path}`;
      calls.push({ method, path, options });

      // Check for exact match first
      if (routes[key] !== undefined) {
        if (typeof routes[key] === 'function') return routes[key](path, options);
        if (routes[key] instanceof Error) throw routes[key];
        return routes[key];
      }

      // Check for prefix matches (for dynamic paths like /bot/{token}/{botId})
      for (const [routeKey, routeVal] of Object.entries(routes)) {
        if (key.startsWith(routeKey)) {
          if (typeof routeVal === 'function') return routeVal(path, options);
          if (routeVal instanceof Error) throw routeVal;
          return routeVal;
        }
      }

      return { status: 200, body: {}, headers: {} };
    },
    getMetrics: () => ({ totalRequests: 0 }),
    invalidateCache: () => {},
    shutdown: async () => {}
  };
}

/** Standard OCS response wrapper */
function ocsResponse(data, status = 200) {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: { ocs: { meta: { status: 'ok', statuscode: status }, data } }
  };
}

/** Sample rooms response */
const SAMPLE_ROOMS = [
  { token: 'abc123', type: 2, name: 'Team Chat' },       // group
  { token: 'def456', type: 3, name: 'Public Channel' },   // public
  { token: 'ghi789', type: 1, name: '1-on-1' },           // 1-on-1 (should be filtered)
  { token: 'jkl012', type: 4, name: 'Changelog' }         // changelog (should be filtered)
];

/** Sample admin bots response */
const SAMPLE_ADMIN_BOTS = [
  { id: 42, name: 'MoltAgent', description: 'AI assistant' },
  { id: 99, name: 'OtherBot', description: 'Some other bot' }
];

/** Sample per-room bots response */
const SAMPLE_ROOM_BOTS = [
  { id: 42, name: 'MoltAgent', state: 0 },
  { id: 99, name: 'OtherBot', state: 1 }
];

// ============================================================
// Tests
// ============================================================

console.log('BotEnroller Unit Tests');
console.log('======================\n');

// --- Constructor ---

test('constructor requires ncRequestManager', () => {
  assert.throws(() => new BotEnroller(), /requires an ncRequestManager/);
  assert.throws(() => new BotEnroller({}), /requires an ncRequestManager/);
  assert.throws(() => new BotEnroller({ ncRequestManager: null }), /requires an ncRequestManager/);
});

test('constructor accepts config with ncRequestManager', () => {
  const nc = createMockNC();
  const enroller = new BotEnroller({ ncRequestManager: nc });
  assert.ok(enroller);
  assert.strictEqual(enroller.botName, 'MoltAgent');
  assert.strictEqual(enroller.botId, null);
  assert.strictEqual(enroller.enrolledCount, 0);
});

test('constructor uses custom botName from config', () => {
  const nc = createMockNC();
  const enroller = new BotEnroller({
    ncRequestManager: nc,
    config: { botName: 'CustomBot' }
  });
  assert.strictEqual(enroller.botName, 'CustomBot');
});

test('constructor uses botName shortcut over config', () => {
  const nc = createMockNC();
  const enroller = new BotEnroller({
    ncRequestManager: nc,
    botName: 'ShortcutBot',
    config: { botName: 'ConfigBot' }
  });
  assert.strictEqual(enroller.botName, 'ShortcutBot');
});

// --- enrollAll() resolves bot ID from admin endpoint ---

asyncTest('enrollAll() resolves bot ID from admin endpoint', async () => {
  const nc = createMockNC({
    'GET:/ocs/v2.php/apps/spreed/api/v1/bot/admin': ocsResponse(SAMPLE_ADMIN_BOTS),
    'GET:/ocs/v2.php/apps/spreed/api/v4/room': ocsResponse(SAMPLE_ROOMS),
    'POST:/ocs/v2.php/apps/spreed/api/v1/bot/': { status: 201, body: {}, headers: {} }
  });

  const enroller = new BotEnroller({ ncRequestManager: nc });
  const result = await enroller.enrollAll();

  assert.strictEqual(enroller.botId, 42);
  assert.strictEqual(result.checked, 2); // Only group + public rooms
  assert.strictEqual(result.enrolled, 2);
  assert.strictEqual(result.errors.length, 0);
});

// --- enrollAll() enables bot in rooms where user is member ---

asyncTest('enrollAll() enables bot in group and public rooms', async () => {
  const nc = createMockNC({
    'GET:/ocs/v2.php/apps/spreed/api/v1/bot/admin': ocsResponse(SAMPLE_ADMIN_BOTS),
    'GET:/ocs/v2.php/apps/spreed/api/v4/room': ocsResponse(SAMPLE_ROOMS),
    'POST:/ocs/v2.php/apps/spreed/api/v1/bot/': { status: 201, body: {}, headers: {} }
  });

  const enroller = new BotEnroller({ ncRequestManager: nc });
  const result = await enroller.enrollAll();

  // Should only process type 2 and type 3 rooms
  assert.strictEqual(result.checked, 2);
  assert.strictEqual(result.enrolled, 2);

  // Verify POST calls were made for the right rooms
  const postCalls = nc._calls.filter(c => c.method === 'POST');
  assert.strictEqual(postCalls.length, 2);
  assert.ok(postCalls[0].path.includes('abc123'));
  assert.ok(postCalls[1].path.includes('def456'));
});

// --- enrollAll() skips already-enrolled rooms ---

asyncTest('enrollAll() skips already-enrolled rooms on second call', async () => {
  const nc = createMockNC({
    'GET:/ocs/v2.php/apps/spreed/api/v1/bot/admin': ocsResponse(SAMPLE_ADMIN_BOTS),
    'GET:/ocs/v2.php/apps/spreed/api/v4/room': ocsResponse(SAMPLE_ROOMS),
    'POST:/ocs/v2.php/apps/spreed/api/v1/bot/': { status: 201, body: {}, headers: {} }
  });

  const enroller = new BotEnroller({ ncRequestManager: nc });

  // First call enrolls
  const result1 = await enroller.enrollAll();
  assert.strictEqual(result1.enrolled, 2);

  // Second call skips
  const result2 = await enroller.enrollAll();
  assert.strictEqual(result2.enrolled, 0);
  assert.strictEqual(result2.skipped, 2);
});

// --- enrollAll() handles 403 (not moderator) gracefully ---

asyncTest('enrollAll() handles 403 not-moderator gracefully', async () => {
  const nc = createMockNC({
    'GET:/ocs/v2.php/apps/spreed/api/v1/bot/admin': ocsResponse(SAMPLE_ADMIN_BOTS),
    'GET:/ocs/v2.php/apps/spreed/api/v4/room': ocsResponse([
      { token: 'room1', type: 2, name: 'Room 1' },
      { token: 'room2', type: 2, name: 'Room 2' }
    ]),
    'POST:/ocs/v2.php/apps/spreed/api/v1/bot/': (path) => {
      if (path.includes('room1')) {
        throw new Error('Authentication error: 403');
      }
      return { status: 201, body: {}, headers: {} };
    }
  });

  const enroller = new BotEnroller({ ncRequestManager: nc });
  const result = await enroller.enrollAll();

  assert.strictEqual(result.checked, 2);
  assert.strictEqual(result.enrolled, 1);
  assert.strictEqual(result.skipped, 1);
  assert.strictEqual(result.errors.length, 0);

  // room1 should be marked as enrolled (no retry)
  assert.strictEqual(enroller.enrolledCount, 2);
});

// --- enrollAll() handles 400 (already enabled) gracefully ---

asyncTest('enrollAll() handles 400 already-enabled gracefully', async () => {
  const nc = createMockNC({
    'GET:/ocs/v2.php/apps/spreed/api/v1/bot/admin': ocsResponse(SAMPLE_ADMIN_BOTS),
    'GET:/ocs/v2.php/apps/spreed/api/v4/room': ocsResponse([
      { token: 'room1', type: 2, name: 'Room 1' }
    ]),
    'POST:/ocs/v2.php/apps/spreed/api/v1/bot/': new Error('HTTP 400: Bad Request')
  });

  const enroller = new BotEnroller({ ncRequestManager: nc });
  const result = await enroller.enrollAll();

  assert.strictEqual(result.checked, 1);
  assert.strictEqual(result.enrolled, 0);
  assert.strictEqual(result.skipped, 1);
  assert.strictEqual(result.errors.length, 0);
});

// --- _listRooms() filters to group/public conversations only ---

asyncTest('_listRooms() filters to group and public conversations only', async () => {
  const nc = createMockNC({
    'GET:/ocs/v2.php/apps/spreed/api/v4/room': ocsResponse(SAMPLE_ROOMS)
  });

  const enroller = new BotEnroller({ ncRequestManager: nc });
  const rooms = await enroller._listRooms();

  assert.strictEqual(rooms.length, 2);
  assert.strictEqual(rooms[0].token, 'abc123');
  assert.strictEqual(rooms[0].type, 2);
  assert.strictEqual(rooms[1].token, 'def456');
  assert.strictEqual(rooms[1].type, 3);
});

// --- _discoverBotIdFromRoom() fallback when admin endpoint fails ---

asyncTest('_discoverBotIdFromRoom() discovers bot ID from room bot list', async () => {
  const nc = createMockNC({
    'GET:/ocs/v2.php/apps/spreed/api/v1/bot/admin':
      new Error('Authentication error: 403'),
    'GET:/ocs/v2.php/apps/spreed/api/v4/room': ocsResponse([
      { token: 'room1', type: 2, name: 'Room 1' }
    ]),
    'GET:/ocs/v2.php/apps/spreed/api/v1/bot/room1': ocsResponse(SAMPLE_ROOM_BOTS),
    'POST:/ocs/v2.php/apps/spreed/api/v1/bot/': { status: 201, body: {}, headers: {} }
  });

  const enroller = new BotEnroller({ ncRequestManager: nc });
  const result = await enroller.enrollAll();

  assert.strictEqual(enroller.botId, 42);
  assert.strictEqual(result.enrolled, 1);
});

// --- resetCache() clears enrolled set ---

asyncTest('resetCache() clears enrolled set so rooms are re-checked', async () => {
  const nc = createMockNC({
    'GET:/ocs/v2.php/apps/spreed/api/v1/bot/admin': ocsResponse(SAMPLE_ADMIN_BOTS),
    'GET:/ocs/v2.php/apps/spreed/api/v4/room': ocsResponse([
      { token: 'room1', type: 2, name: 'Room 1' }
    ]),
    'POST:/ocs/v2.php/apps/spreed/api/v1/bot/': { status: 201, body: {}, headers: {} }
  });

  const enroller = new BotEnroller({ ncRequestManager: nc });

  await enroller.enrollAll();
  assert.strictEqual(enroller.enrolledCount, 1);

  enroller.resetCache();
  assert.strictEqual(enroller.enrolledCount, 0);

  // Re-enrollment should work
  const result = await enroller.enrollAll();
  assert.strictEqual(result.enrolled, 1);
});

// --- enrollAll() with no bot found returns gracefully ---

asyncTest('enrollAll() returns gracefully when bot cannot be found', async () => {
  const nc = createMockNC({
    'GET:/ocs/v2.php/apps/spreed/api/v1/bot/admin': ocsResponse([
      { id: 99, name: 'OtherBot', description: 'Not ours' }
    ]),
    'GET:/ocs/v2.php/apps/spreed/api/v4/room': ocsResponse([
      { token: 'room1', type: 2, name: 'Room 1' }
    ]),
    'GET:/ocs/v2.php/apps/spreed/api/v1/bot/room1': ocsResponse([
      { id: 99, name: 'OtherBot', state: 1 }
    ])
  });

  const enroller = new BotEnroller({ ncRequestManager: nc });
  const result = await enroller.enrollAll();

  assert.strictEqual(result.checked, 0);
  assert.strictEqual(result.enrolled, 0);
  assert.strictEqual(result.errors.length, 0);
  assert.strictEqual(enroller.botId, null);
});

// --- enrollAll() audits enrollment ---

asyncTest('enrollAll() calls auditLog when rooms are enrolled', async () => {
  const auditLog = createMockAuditLog();
  const nc = createMockNC({
    'GET:/ocs/v2.php/apps/spreed/api/v1/bot/admin': ocsResponse(SAMPLE_ADMIN_BOTS),
    'GET:/ocs/v2.php/apps/spreed/api/v4/room': ocsResponse([
      { token: 'room1', type: 2, name: 'Room 1' },
      { token: 'room2', type: 3, name: 'Room 2' }
    ]),
    'POST:/ocs/v2.php/apps/spreed/api/v1/bot/': { status: 201, body: {}, headers: {} }
  });

  const enroller = new BotEnroller({ ncRequestManager: nc, auditLog });
  await enroller.enrollAll();

  const auditCalls = auditLog.getCallsFor('bot_enrolled');
  assert.strictEqual(auditCalls.length, 1);
  assert.strictEqual(auditCalls[0].data.enrolled, 2);
  assert.strictEqual(auditCalls[0].data.total, 2);
});

// --- enrollAll() does NOT audit when no rooms are enrolled ---

asyncTest('enrollAll() does not audit when no new rooms are enrolled', async () => {
  const auditLog = createMockAuditLog();
  const nc = createMockNC({
    'GET:/ocs/v2.php/apps/spreed/api/v1/bot/admin': ocsResponse(SAMPLE_ADMIN_BOTS),
    'GET:/ocs/v2.php/apps/spreed/api/v4/room': ocsResponse([])
  });

  const enroller = new BotEnroller({ ncRequestManager: nc, auditLog });
  await enroller.enrollAll();

  const auditCalls = auditLog.getCallsFor('bot_enrolled');
  assert.strictEqual(auditCalls.length, 0);
});

// --- enrollAll() handles room list failure gracefully ---

asyncTest('enrollAll() handles room list failure gracefully', async () => {
  const nc = createMockNC({
    'GET:/ocs/v2.php/apps/spreed/api/v1/bot/admin': ocsResponse(SAMPLE_ADMIN_BOTS),
    'GET:/ocs/v2.php/apps/spreed/api/v4/room': new Error('Network error: timeout')
  });

  const enroller = new BotEnroller({ ncRequestManager: nc });
  const result = await enroller.enrollAll();

  assert.strictEqual(result.checked, 0);
  assert.strictEqual(result.enrolled, 0);
  assert.strictEqual(result.errors.length, 1);
  assert.ok(result.errors[0].error.includes('timeout'));
});

// --- enrollAll() handles 200 (already enabled) from POST ---

asyncTest('enrollAll() treats POST 200 as already-enabled (skip not enroll)', async () => {
  const nc = createMockNC({
    'GET:/ocs/v2.php/apps/spreed/api/v1/bot/admin': ocsResponse(SAMPLE_ADMIN_BOTS),
    'GET:/ocs/v2.php/apps/spreed/api/v4/room': ocsResponse([
      { token: 'room1', type: 2, name: 'Room 1' }
    ]),
    'POST:/ocs/v2.php/apps/spreed/api/v1/bot/': { status: 200, body: {}, headers: {} }
  });

  const enroller = new BotEnroller({ ncRequestManager: nc });
  const result = await enroller.enrollAll();

  assert.strictEqual(result.checked, 1);
  assert.strictEqual(result.enrolled, 0);
  assert.strictEqual(result.skipped, 1);
  assert.strictEqual(enroller.enrolledCount, 1);
});

// --- _extractStatusCode ---

test('_extractStatusCode parses Authentication error format', () => {
  const nc = createMockNC();
  const enroller = new BotEnroller({ ncRequestManager: nc });

  assert.strictEqual(enroller._extractStatusCode(new Error('Authentication error: 403')), 403);
  assert.strictEqual(enroller._extractStatusCode(new Error('Authentication error: 401')), 401);
});

test('_extractStatusCode parses HTTP status format', () => {
  const nc = createMockNC();
  const enroller = new BotEnroller({ ncRequestManager: nc });

  assert.strictEqual(enroller._extractStatusCode(new Error('HTTP 400: Bad Request')), 400);
  assert.strictEqual(enroller._extractStatusCode(new Error('HTTP 500: Internal Server Error')), 500);
});

test('_extractStatusCode returns null for non-HTTP errors', () => {
  const nc = createMockNC();
  const enroller = new BotEnroller({ ncRequestManager: nc });

  assert.strictEqual(enroller._extractStatusCode(new Error('Network error: timeout')), null);
  assert.strictEqual(enroller._extractStatusCode(null), null);
  assert.strictEqual(enroller._extractStatusCode(new Error('')), null);
});

// --- Module export ---

test('module exports BotEnroller constructor', () => {
  const mod = require('../../../src/lib/integrations/bot-enroller');
  assert.strictEqual(typeof mod, 'function');
  assert.strictEqual(mod.name, 'BotEnroller');
});

// ============================================================
// Summary
// ============================================================

setTimeout(() => {
  summary();
  exitWithCode();
}, 100);
