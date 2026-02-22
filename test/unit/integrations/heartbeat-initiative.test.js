/**
 * Heartbeat Initiative Level Tests
 *
 * Tests that initiative levels correctly gate which pulse() blocks run.
 *
 * Run: node test/unit/integrations/heartbeat-initiative.test.js
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

// We test HeartbeatManager by mocking its dependencies at the instance level
// after construction, since the constructor creates DeckClient/DeckTaskProcessor.

// Minimal mock config that won't crash the constructor
function createMockConfig(overrides = {}) {
  return {
    nextcloud: { url: 'https://example.com', username: 'test' },
    deck: { boardId: 1, stacks: {} },
    heartbeat: {
      intervalMs: 60000,
      deckEnabled: overrides.deckEnabled ?? true,
      caldavEnabled: overrides.caldavEnabled ?? true,
      quietHoursStart: 22,
      quietHoursEnd: 7,
      maxTasksPerCycle: 3,
      calendarLookaheadMinutes: 30,
      initiativeLevel: overrides.initiativeLevel ?? 1,
      ...(overrides.heartbeat || {})
    },
    llmRouter: { route: async () => ({ result: 'ok', tokens: 10 }) },
    notifyUser: async () => {},
    auditLog: overrides.auditLog || (async () => {}),
    credentialBroker: {
      prefetchAll: async () => {},
      get: async () => null,
      getNCPassword: () => 'test'
    }
  };
}

// We need to stub the modules HeartbeatManager imports.
// The easiest approach: require HeartbeatManager and override instance methods.

let HeartbeatManager;
try {
  HeartbeatManager = require('../../../src/lib/integrations/heartbeat-manager');
} catch (err) {
  console.error('Failed to load HeartbeatManager:', err.message);
  process.exit(1);
}

console.log('\n=== Heartbeat Initiative Level Tests ===\n');

(async () => {
  await asyncTest('Level 1: pulse() skips all proactive checks', async () => {
    const config = createMockConfig({ initiativeLevel: 1 });
    const hb = new HeartbeatManager(config);

    // Track which methods get called
    let deckCalled = false, reviewCalled = false, assignmentsCalled = false;
    let calendarCalled = false, knowledgeCalled = false, flowCalled = false;

    hb._processDeck = async () => { deckCalled = true; return { processed: 0 }; };
    hb._processReviewFeedback = async () => { reviewCalled = true; return { processed: 0 }; };
    hb._processAssignedCards = async () => { assignmentsCalled = true; return { processed: 0 }; };
    hb._checkCalendar = async () => { calendarCalled = true; return { upcoming: [] }; };
    hb._checkKnowledgeBoard = async () => { knowledgeCalled = true; return { pending: 0 }; };
    hb._processFlowEvents = () => { flowCalled = true; return { processed: 0 }; };
    hb._isQuietHours = () => false;

    await hb.pulse();

    assert.strictEqual(deckCalled, false, 'Deck should not run at level 1');
    assert.strictEqual(reviewCalled, false, 'Review should not run at level 1');
    assert.strictEqual(assignmentsCalled, false, 'Assignments should not run at level 1');
    assert.strictEqual(calendarCalled, false, 'Calendar should not run at level 1');
    assert.strictEqual(knowledgeCalled, false, 'Knowledge should not run at level 1');
    assert.strictEqual(flowCalled, true, 'Flow runs at all levels (before initiative gate)');
  });

  await asyncTest('Level 2: pulse() runs Deck + Calendar + Flow, skips Knowledge', async () => {
    const config = createMockConfig({ initiativeLevel: 2 });
    const hb = new HeartbeatManager(config);

    let deckCalled = false, calendarCalled = false, knowledgeCalled = false, flowCalled = false;

    hb._processDeck = async () => { deckCalled = true; return { processed: 0 }; };
    hb._processReviewFeedback = async () => ({ processed: 0 });
    hb._processAssignedCards = async () => ({ processed: 0 });
    hb._checkCalendar = async () => { calendarCalled = true; return { upcoming: [] }; };
    hb._checkKnowledgeBoard = async () => { knowledgeCalled = true; return { pending: 0 }; };
    hb._processFlowEvents = () => { flowCalled = true; return { processed: 0 }; };
    hb._isQuietHours = () => false;
    hb.knowledgeBoard = { getStatus: async () => ({ stacks: {} }) }; // present but should be skipped

    await hb.pulse();

    assert.strictEqual(deckCalled, true, 'Deck should run at level 2');
    assert.strictEqual(calendarCalled, true, 'Calendar should run at level 2');
    assert.strictEqual(flowCalled, true, 'Flow should run at level 2');
    assert.strictEqual(knowledgeCalled, false, 'Knowledge should NOT run at level 2');
  });

  await asyncTest('Level 3: pulse() runs Deck + Calendar + Flow + Knowledge', async () => {
    const config = createMockConfig({ initiativeLevel: 3 });
    const hb = new HeartbeatManager(config);

    let deckCalled = false, calendarCalled = false, knowledgeCalled = false, flowCalled = false;

    hb._processDeck = async () => { deckCalled = true; return { processed: 0 }; };
    hb._processReviewFeedback = async () => ({ processed: 0 });
    hb._processAssignedCards = async () => ({ processed: 0 });
    hb._checkCalendar = async () => { calendarCalled = true; return { upcoming: [] }; };
    hb._checkKnowledgeBoard = async () => { knowledgeCalled = true; return { pending: 0 }; };
    hb._processFlowEvents = () => { flowCalled = true; return { processed: 0 }; };
    hb._isQuietHours = () => false;
    hb.knowledgeBoard = { getStatus: async () => ({ stacks: {} }) };

    await hb.pulse();

    assert.strictEqual(deckCalled, true, 'Deck should run at level 3');
    assert.strictEqual(calendarCalled, true, 'Calendar should run at level 3');
    assert.strictEqual(flowCalled, true, 'Flow should run at level 3');
    assert.strictEqual(knowledgeCalled, true, 'Knowledge should run at level 3');
  });

  await asyncTest('Level 1 with deckEnabled=true: still skips deck (level takes precedence)', async () => {
    const config = createMockConfig({ initiativeLevel: 1, deckEnabled: true });
    const hb = new HeartbeatManager(config);

    let deckCalled = false;
    hb._processDeck = async () => { deckCalled = true; return { processed: 0 }; };
    hb._processReviewFeedback = async () => ({ processed: 0 });
    hb._processAssignedCards = async () => ({ processed: 0 });
    hb._checkCalendar = async () => ({ upcoming: [] });
    hb._processFlowEvents = () => ({ processed: 0 });
    hb._isQuietHours = () => false;

    await hb.pulse();

    assert.strictEqual(deckCalled, false, 'Level should take precedence over deckEnabled');
  });

  test('Initiative level appears in getStatus()', () => {
    const config = createMockConfig({ initiativeLevel: 3 });
    const hb = new HeartbeatManager(config);
    const status = hb.getStatus();
    assert.strictEqual(status.initiativeLevel, 3);
    assert.strictEqual(status.settings.initiativeLevel, 3);
  });

  await asyncTest('Initiative level logged in heartbeat_started audit event', async () => {
    const auditCalls = [];
    const config = createMockConfig({
      initiativeLevel: 2,
      auditLog: async (event, data) => { auditCalls.push({ event, data }); }
    });
    const hb = new HeartbeatManager(config);

    // Override pulse to prevent actual processing
    hb._processDeck = async () => ({ processed: 0 });
    hb._processReviewFeedback = async () => ({ processed: 0 });
    hb._processAssignedCards = async () => ({ processed: 0 });
    hb._checkCalendar = async () => ({ upcoming: [] });
    hb._processFlowEvents = () => ({ processed: 0 });
    hb._isQuietHours = () => false;

    await hb.start();
    // Stop immediately
    await hb.stop();

    const startEvent = auditCalls.find(c => c.event === 'heartbeat_started');
    assert.ok(startEvent, 'heartbeat_started event should exist');
    assert.strictEqual(startEvent.data.initiativeLevel, 2);
  });

  await asyncTest('Quiet hours still respected at all levels', async () => {
    const config = createMockConfig({ initiativeLevel: 3 });
    const hb = new HeartbeatManager(config);

    let deckCalled = false;
    hb._processDeck = async () => { deckCalled = true; return { processed: 0 }; };
    hb._processReviewFeedback = async () => ({ processed: 0 });
    hb._processAssignedCards = async () => ({ processed: 0 });
    hb._checkCalendar = async () => ({ upcoming: [] });
    hb._checkKnowledgeBoard = async () => ({ pending: 0 });
    hb._processFlowEvents = () => ({ processed: 0 });
    hb._isQuietHours = () => true; // Force quiet hours
    hb.knowledgeBoard = { getStatus: async () => ({ stacks: {} }) };

    const results = await hb.pulse();

    assert.strictEqual(deckCalled, false, 'Nothing should run during quiet hours');
  });

  test('Default initiative level is 1', () => {
    const config = createMockConfig({});
    // Remove explicit initiativeLevel to test default
    delete config.heartbeat.initiativeLevel;
    const hb = new HeartbeatManager(config);
    assert.strictEqual(hb.settings.initiativeLevel, 1);
  });

  summary();
  exitWithCode();
})();
