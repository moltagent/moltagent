/**
 * CommandHandler Unit Tests
 *
 * Test suite for slash command handling.
 *
 * Run: node test/unit/server/command-handler.test.js
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const { createMockAuditLog } = require('../../helpers/mock-factories');

// Import module under test
const CommandHandler = require('../../../src/lib/server/command-handler');

// ============================================================
// Helper: Create mock signature verifier
// ============================================================

function createMockSignatureVerifier(stats = {}) {
  return {
    getStats: () => ({
      totalVerifications: stats.totalVerifications || 100,
      successful: stats.successful || 95,
      failed: stats.failed || 5,
      successRate: stats.successRate || '95%',
      failureReasons: stats.failureReasons || { invalid_signature: 3, missing_header: 2 }
    })
  };
}

function createMockMessageRouter(stats = {}) {
  return {
    getStats: () => ({
      pendingConfirmations: stats.pendingConfirmations || 0,
      handlersConfigured: {
        calendar: stats.calendar !== false,
        email: stats.email !== false,
        llm: stats.llm !== false
      }
    })
  };
}

// ============================================================
// Test Suites
// ============================================================

console.log('\n=== CommandHandler Tests ===\n');

// --- Constructor Tests ---
console.log('\n--- Constructor Tests ---\n');

test('TC-CTOR-001: Initialize with dependencies', () => {
  const handler = new CommandHandler({
    signatureVerifier: createMockSignatureVerifier(),
    allowedBackends: ['https://cloud.example.com']
  });
  assert.ok(handler.signatureVerifier);
  assert.strictEqual(handler.allowedBackends.length, 1);
});

// --- Command Parsing Tests ---
console.log('\n--- Command Parsing Tests ---\n');

test('TC-PARSE-001: Parse command and args', () => {
  const handler = new CommandHandler({
    signatureVerifier: createMockSignatureVerifier(),
    allowedBackends: []
  });
  const { command, args } = handler._parseCommand('/help me please');
  assert.strictEqual(command, '/help');
  assert.strictEqual(args, 'me please');
});

test('TC-PARSE-002: Handle command without args', () => {
  const handler = new CommandHandler({
    signatureVerifier: createMockSignatureVerifier(),
    allowedBackends: []
  });
  const { command, args } = handler._parseCommand('/status');
  assert.strictEqual(command, '/status');
  assert.strictEqual(args, '');
});

test('TC-PARSE-003: Normalize command to lowercase', () => {
  const handler = new CommandHandler({
    signatureVerifier: createMockSignatureVerifier(),
    allowedBackends: []
  });
  const { command } = handler._parseCommand('/HELP');
  assert.strictEqual(command, '/help');
});

// --- /help Command Tests ---
console.log('\n--- /help Command Tests ---\n');

asyncTest('TC-HELP-001: Return help text', async () => {
  const handler = new CommandHandler({
    signatureVerifier: createMockSignatureVerifier(),
    allowedBackends: []
  });
  const context = { user: 'testuser', token: 'test-token', messageId: 'msg-123' };
  const result = await handler.handle('/help', context);
  assert.ok(result.response.includes('Commands'));
  assert.ok(result.response.includes('/status'));
  assert.ok(result.response.includes('/stats'));
});

asyncTest('TC-HELP-002: Include natural language examples', async () => {
  const handler = new CommandHandler({
    signatureVerifier: createMockSignatureVerifier(),
    allowedBackends: []
  });
  const context = { user: 'testuser', token: 'test-token', messageId: 'msg-123' };
  const result = await handler.handle('/help', context);
  assert.ok(result.response.includes('calendar'));
  assert.ok(result.response.includes('email'));
});

// --- /status Command Tests ---
console.log('\n--- /status Command Tests ---\n');

asyncTest('TC-STATUS-001: Return server status', async () => {
  const handler = new CommandHandler({
    signatureVerifier: createMockSignatureVerifier(),
    messageRouter: createMockMessageRouter(),
    allowedBackends: ['https://cloud.example.com']
  });
  const context = { user: 'testuser', token: 'test-token', messageId: 'msg-123' };
  const result = await handler.handle('/status', context);
  assert.ok(result.response.includes('Running'));
});

asyncTest('TC-STATUS-002: Include verification count', async () => {
  const handler = new CommandHandler({
    signatureVerifier: createMockSignatureVerifier({ totalVerifications: 123 }),
    messageRouter: createMockMessageRouter(),
    allowedBackends: []
  });
  const context = { user: 'testuser', token: 'test-token', messageId: 'msg-123' };
  const result = await handler.handle('/status', context);
  assert.ok(result.response.includes('123'));
});

asyncTest('TC-STATUS-003: Show handler availability', async () => {
  const handler = new CommandHandler({
    signatureVerifier: createMockSignatureVerifier(),
    messageRouter: createMockMessageRouter(),
    llmRouter: { test: true },
    allowedBackends: []
  });
  const context = { user: 'testuser', token: 'test-token', messageId: 'msg-123' };
  const result = await handler.handle('/status', context);
  assert.ok(result.response.includes('Calendar'));
  assert.ok(result.response.includes('Email'));
  assert.ok(result.response.includes('LLM'));
});

asyncTest('TC-STATUS-004: Show allowed backends count', async () => {
  const handler = new CommandHandler({
    signatureVerifier: createMockSignatureVerifier(),
    messageRouter: createMockMessageRouter(),
    allowedBackends: ['https://cloud1.example.com', 'https://cloud2.example.com']
  });
  const context = { user: 'testuser', token: 'test-token', messageId: 'msg-123' };
  const result = await handler.handle('/status', context);
  assert.ok(result.response.includes('2'));
});

// --- /stats Command Tests ---
console.log('\n--- /stats Command Tests ---\n');

asyncTest('TC-STATS-001: Return verification statistics', async () => {
  const handler = new CommandHandler({
    signatureVerifier: createMockSignatureVerifier(),
    allowedBackends: []
  });
  const context = { user: 'testuser', token: 'test-token', messageId: 'msg-123' };
  const result = await handler.handle('/stats', context);
  assert.ok(result.response.includes('Total'));
  assert.ok(result.response.includes('Successful'));
  assert.ok(result.response.includes('Failed'));
});

asyncTest('TC-STATS-002: Include success rate', async () => {
  const handler = new CommandHandler({
    signatureVerifier: createMockSignatureVerifier({ successRate: '95%' }),
    allowedBackends: []
  });
  const context = { user: 'testuser', token: 'test-token', messageId: 'msg-123' };
  const result = await handler.handle('/stats', context);
  assert.ok(result.response.includes('95%'));
});

asyncTest('TC-STATS-003: Include failure reasons', async () => {
  const handler = new CommandHandler({
    signatureVerifier: createMockSignatureVerifier({
      failureReasons: { invalid_signature: 3 }
    }),
    allowedBackends: []
  });
  const context = { user: 'testuser', token: 'test-token', messageId: 'msg-123' };
  const result = await handler.handle('/stats', context);
  assert.ok(result.response.includes('invalid_signature'));
});

// --- Unknown Command Tests ---
console.log('\n--- Unknown Command Tests ---\n');

asyncTest('TC-UNKNOWN-001: Return unknown command message', async () => {
  const handler = new CommandHandler({
    signatureVerifier: createMockSignatureVerifier(),
    allowedBackends: []
  });
  const context = { user: 'testuser', token: 'test-token', messageId: 'msg-123' };
  const result = await handler.handle('/foobar', context);
  assert.ok(result.unknown);
  assert.ok(result.response.includes('Unknown command'));
});

asyncTest('TC-UNKNOWN-002: Suggest /help', async () => {
  const handler = new CommandHandler({
    signatureVerifier: createMockSignatureVerifier(),
    allowedBackends: []
  });
  const context = { user: 'testuser', token: 'test-token', messageId: 'msg-123' };
  const result = await handler.handle('/unknown', context);
  assert.ok(result.response.includes('/help'));
});

// --- Audit Logging Tests ---
console.log('\n--- Audit Logging Tests ---\n');

asyncTest('TC-AUDIT-001: Log command execution', async () => {
  const mockAuditLog = createMockAuditLog();
  const handler = new CommandHandler({
    signatureVerifier: createMockSignatureVerifier(),
    allowedBackends: [],
    auditLog: mockAuditLog
  });
  const context = { user: 'testuser', token: 'test-token', messageId: 'msg-123' };
  await handler.handle('/status', context);
  const calls = mockAuditLog.getCallsFor('command');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].data.command, '/status');
});

// Summary
setTimeout(() => {
  summary();
  exitWithCode();
}, 100);
