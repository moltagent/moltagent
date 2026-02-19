/**
 * CommandHandler /restart Command Unit Tests
 *
 * Run: node test/unit/server/command-handler-restart.test.js
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const { createMockAuditLog } = require('../../helpers/mock-factories');

const CommandHandler = require('../../../src/lib/server/command-handler');

// ============================================================
// Helpers
// ============================================================

function createMockSignatureVerifier() {
  return {
    getStats: () => ({
      totalVerifications: 100,
      successful: 95,
      failed: 5,
      successRate: '95%',
      failureReasons: {}
    })
  };
}

function createMockSelfHealClient(responses = {}) {
  const calls = [];
  return {
    restart: async (service) => {
      calls.push(service);
      if (responses.error) throw new Error(responses.error);
      return responses.restart || { ok: true, service, message: `${service} restarted successfully` };
    },
    health: async () => responses.health || { status: 'ok', services: ['ollama', 'whisper-server'] },
    getCalls: () => calls
  };
}

function createHandler(opts = {}) {
  return new CommandHandler({
    signatureVerifier: createMockSignatureVerifier(),
    allowedBackends: [],
    selfHealClient: opts.selfHealClient || null,
    adminUser: opts.adminUser !== undefined ? opts.adminUser : 'admin',
    auditLog: opts.auditLog || createMockAuditLog()
  });
}

const adminContext = { user: 'admin', token: 'room-1', messageId: 'msg-1' };
const userContext = { user: 'regular-user', token: 'room-1', messageId: 'msg-2' };

// ============================================================
// Tests
// ============================================================

console.log('\n=== CommandHandler /restart Tests ===\n');

// --- Admin Gate ---
console.log('\n--- Admin Gate ---\n');

asyncTest('TC-ADMIN-001: /restart by admin calls selfHealClient.restart()', async () => {
  const mockClient = createMockSelfHealClient();
  const handler = createHandler({ selfHealClient: mockClient });

  const result = await handler.handle('/restart voice', adminContext);
  assert.ok(result.response.includes('whisper-server'));
  assert.deepStrictEqual(mockClient.getCalls(), ['whisper-server']);
});

asyncTest('TC-ADMIN-002: /restart by non-admin returns admin access message', async () => {
  const mockClient = createMockSelfHealClient();
  const handler = createHandler({ selfHealClient: mockClient });

  const result = await handler.handle('/restart voice', userContext);
  assert.ok(result.response.includes('admin access'));
  assert.strictEqual(mockClient.getCalls().length, 0);
});

asyncTest('TC-ADMIN-003: /restart with no adminUser configured blocks everyone', async () => {
  const mockClient = createMockSelfHealClient();
  const handler = createHandler({ selfHealClient: mockClient, adminUser: '' });

  const result = await handler.handle('/restart voice', adminContext);
  assert.ok(result.response.includes('admin access'));
});

// --- Service Mapping ---
console.log('\n--- Service Mapping ---\n');

asyncTest('TC-MAP-001: /restart voice maps to whisper-server', async () => {
  const mockClient = createMockSelfHealClient();
  const handler = createHandler({ selfHealClient: mockClient });

  await handler.handle('/restart voice', adminContext);
  assert.deepStrictEqual(mockClient.getCalls(), ['whisper-server']);
});

asyncTest('TC-MAP-002: /restart whisper maps to whisper-server', async () => {
  const mockClient = createMockSelfHealClient();
  const handler = createHandler({ selfHealClient: mockClient });

  await handler.handle('/restart whisper', adminContext);
  assert.deepStrictEqual(mockClient.getCalls(), ['whisper-server']);
});

asyncTest('TC-MAP-003: /restart ai maps to ollama', async () => {
  const mockClient = createMockSelfHealClient();
  const handler = createHandler({ selfHealClient: mockClient });

  await handler.handle('/restart ai', adminContext);
  assert.deepStrictEqual(mockClient.getCalls(), ['ollama']);
});

asyncTest('TC-MAP-004: /restart ollama maps to ollama', async () => {
  const mockClient = createMockSelfHealClient();
  const handler = createHandler({ selfHealClient: mockClient });

  await handler.handle('/restart ollama', adminContext);
  assert.deepStrictEqual(mockClient.getCalls(), ['ollama']);
});

asyncTest('TC-MAP-005: /restart unknown returns error', async () => {
  const mockClient = createMockSelfHealClient();
  const handler = createHandler({ selfHealClient: mockClient });

  const result = await handler.handle('/restart bogus', adminContext);
  assert.ok(result.response.includes('Unknown service'));
  assert.ok(result.response.includes('voice'));
  assert.ok(result.response.includes('ai'));
  assert.strictEqual(mockClient.getCalls().length, 0);
});

// --- No Client Configured ---
console.log('\n--- No Client Configured ---\n');

asyncTest('TC-NOCLIENT-001: /restart without selfHealClient returns not configured', async () => {
  const handler = createHandler({ selfHealClient: null });

  const result = await handler.handle('/restart voice', adminContext);
  assert.ok(result.response.includes('not configured'));
});

// --- Error Handling ---
console.log('\n--- Error Handling ---\n');

asyncTest('TC-ERR-001: /restart reports client error', async () => {
  const mockClient = createMockSelfHealClient({ error: 'Connection refused' });
  const handler = createHandler({ selfHealClient: mockClient });

  const result = await handler.handle('/restart ai', adminContext);
  assert.ok(result.response.includes('Failed to restart'));
  assert.ok(result.response.includes('Connection refused'));
});

// --- Help Text ---
console.log('\n--- Help Text ---\n');

asyncTest('TC-HELP-001: /help includes restart command', async () => {
  const handler = createHandler();
  const result = await handler.handle('/help', adminContext);
  assert.ok(result.response.includes('/restart'));
  assert.ok(result.response.includes('admin'));
});

// --- Case Insensitivity ---
console.log('\n--- Case Insensitivity ---\n');

asyncTest('TC-CASE-001: /restart VOICE is case-insensitive', async () => {
  const mockClient = createMockSelfHealClient();
  const handler = createHandler({ selfHealClient: mockClient });

  await handler.handle('/restart VOICE', adminContext);
  assert.deepStrictEqual(mockClient.getCalls(), ['whisper-server']);
});

// Summary
setTimeout(() => {
  summary();
  exitWithCode();
}, 100);
