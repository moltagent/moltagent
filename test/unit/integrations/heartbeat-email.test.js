/**
 * HeartbeatManager Email Integration Tests
 *
 * Tests that HeartbeatManager correctly integrates with EmailMonitor:
 * - Email check gated by initiative level >= 2
 * - Error handling for email check failures
 * - Status reporting includes email fields
 *
 * Run: node test/unit/integrations/heartbeat-email.test.js
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

let HeartbeatManager;
try {
  HeartbeatManager = require('../../../src/lib/integrations/heartbeat-manager');
} catch (err) {
  console.error('Failed to load HeartbeatManager:', err.message);
  process.exit(1);
}

console.log('\n=== HeartbeatManager Email Integration Tests ===\n');

// Minimal mock config
function createMockConfig(overrides = {}) {
  return {
    nextcloud: { url: 'https://example.com', username: 'test' },
    deck: { boardId: 1, stacks: {} },
    heartbeat: {
      intervalMs: 60000,
      deckEnabled: true,
      caldavEnabled: true,
      quietHoursStart: 22,
      quietHoursEnd: 7,
      maxTasksPerCycle: 3,
      calendarLookaheadMinutes: 30,
      initiativeLevel: overrides.initiativeLevel ?? 2,
      ...(overrides.heartbeat || {})
    },
    llmRouter: { route: async () => ({ result: 'ok', tokens: 10 }) },
    notifyUser: async () => {},
    auditLog: overrides.auditLog || (async () => {}),
    credentialBroker: {
      prefetchAll: async () => {},
      get: async () => null,
      getNCPassword: () => 'test'
    },
    emailMonitor: overrides.emailMonitor || null
  };
}

// Mock emailMonitor
function createMockEmailMonitor(overrides = {}) {
  return {
    checkInbox: overrides.checkInbox || (async () => ({ checked: true })),
    isAvailable: overrides.isAvailable || (() => true),
    stop: () => {}
  };
}

(async () => {
  await asyncTest('Level 1: pulse() does NOT call emailMonitor.checkInbox()', async () => {
    let emailCalled = false;
    const emailMonitor = createMockEmailMonitor({
      checkInbox: async () => { emailCalled = true; return {}; }
    });
    const config = createMockConfig({ initiativeLevel: 1, emailMonitor });
    const hb = new HeartbeatManager(config);

    // Stub other methods to avoid side effects
    hb._processDeck = async () => ({ processed: 0 });
    hb._processReviewFeedback = async () => ({ processed: 0 });
    hb._processAssignedCards = async () => ({ processed: 0 });
    hb._checkCalendar = async () => ({ upcoming: [] });
    hb._processFlowEvents = () => ({ processed: 0 });
    hb._isQuietHours = () => false;

    await hb.pulse();

    assert.strictEqual(emailCalled, false, 'Email should NOT be checked at level 1');
  });

  await asyncTest('Level 2: pulse() calls emailMonitor.checkInbox()', async () => {
    let emailCalled = false;
    const emailMonitor = createMockEmailMonitor({
      checkInbox: async () => { emailCalled = true; return { checked: true }; }
    });
    const config = createMockConfig({ initiativeLevel: 2, emailMonitor });
    const hb = new HeartbeatManager(config);

    hb._processDeck = async () => ({ processed: 0 });
    hb._processReviewFeedback = async () => ({ processed: 0 });
    hb._processAssignedCards = async () => ({ processed: 0 });
    hb._checkCalendar = async () => ({ upcoming: [] });
    hb._processFlowEvents = () => ({ processed: 0 });
    hb._isQuietHours = () => false;

    const results = await hb.pulse();

    assert.strictEqual(emailCalled, true, 'Email should be checked at level 2');
    assert.ok(results.email, 'Results should include email');
    assert.strictEqual(results.email.checked, true);
    assert.ok(hb.state.lastEmailCheck, 'lastEmailCheck should be set');
  });

  await asyncTest('Level 3: pulse() calls emailMonitor.checkInbox()', async () => {
    let emailCalled = false;
    const emailMonitor = createMockEmailMonitor({
      checkInbox: async () => { emailCalled = true; return { checked: true }; }
    });
    const config = createMockConfig({ initiativeLevel: 3, emailMonitor });
    const hb = new HeartbeatManager(config);

    hb._processDeck = async () => ({ processed: 0 });
    hb._processReviewFeedback = async () => ({ processed: 0 });
    hb._processAssignedCards = async () => ({ processed: 0 });
    hb._checkCalendar = async () => ({ upcoming: [] });
    hb._checkKnowledgeBoard = async () => ({ pending: 0 });
    hb._processFlowEvents = () => ({ processed: 0 });
    hb._isQuietHours = () => false;
    hb.knowledgeBoard = { getStatus: async () => ({ stacks: {} }) };

    await hb.pulse();

    assert.strictEqual(emailCalled, true, 'Email should be checked at level 3');
  });

  await asyncTest('No emailMonitor: pulse() skips email silently', async () => {
    const config = createMockConfig({ initiativeLevel: 2, emailMonitor: null });
    const hb = new HeartbeatManager(config);

    hb._processDeck = async () => ({ processed: 0 });
    hb._processReviewFeedback = async () => ({ processed: 0 });
    hb._processAssignedCards = async () => ({ processed: 0 });
    hb._checkCalendar = async () => ({ upcoming: [] });
    hb._processFlowEvents = () => ({ processed: 0 });
    hb._isQuietHours = () => false;

    const results = await hb.pulse();

    assert.strictEqual(results.email, null, 'Email result should remain null when no monitor');
    assert.strictEqual(results.errors.length, 0, 'Should not have errors');
  });

  await asyncTest('Email error: pulse() catches and continues, adds to errors', async () => {
    const emailMonitor = createMockEmailMonitor({
      checkInbox: async () => { throw new Error('IMAP connection refused'); }
    });
    const config = createMockConfig({ initiativeLevel: 2, emailMonitor });
    const hb = new HeartbeatManager(config);

    hb._processDeck = async () => ({ processed: 0 });
    hb._processReviewFeedback = async () => ({ processed: 0 });
    hb._processAssignedCards = async () => ({ processed: 0 });
    hb._checkCalendar = async () => ({ upcoming: [] });
    hb._processFlowEvents = () => ({ processed: 0 });
    hb._isQuietHours = () => false;

    const results = await hb.pulse();

    assert.strictEqual(results.email, null, 'Email result should be null on error');
    const emailError = results.errors.find(e => e.component === 'email');
    assert.ok(emailError, 'Should have email error in errors array');
    assert.ok(emailError.error.includes('IMAP connection refused'), 'Error message should be preserved');
  });

  test('getStatus() includes lastEmailCheck and emailsProcessedToday', () => {
    const config = createMockConfig({ initiativeLevel: 2 });
    const hb = new HeartbeatManager(config);

    const status = hb.getStatus();
    assert.ok('lastEmailCheck' in status, 'Status should include lastEmailCheck');
    assert.ok('emailsProcessedToday' in status, 'Status should include emailsProcessedToday');
    assert.strictEqual(status.lastEmailCheck, null, 'Initial lastEmailCheck should be null');
    assert.strictEqual(status.emailsProcessedToday, 0, 'Initial emailsProcessedToday should be 0');
  });

  summary();
  exitWithCode();
})();
