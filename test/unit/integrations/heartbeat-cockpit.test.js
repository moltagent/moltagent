/**
 * Heartbeat-Cockpit Integration Tests
 *
 * Tests that CockpitManager is correctly integrated into HeartbeatManager's
 * pulse cycle: config read, initiative level propagation, status writes,
 * and graceful error handling.
 *
 * Run: node test/unit/integrations/heartbeat-cockpit.test.js
 *
 * @module test/unit/integrations/heartbeat-cockpit
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const { createMockCockpitManager } = require('../../helpers/mock-factories');

// ============================================================
// HeartbeatManager Setup
// ============================================================

let HeartbeatManager;
try {
  HeartbeatManager = require('../../../src/lib/integrations/heartbeat-manager');
} catch (err) {
  console.error('Failed to load HeartbeatManager:', err.message);
  process.exit(1);
}

/**
 * Create a minimal mock config for HeartbeatManager construction.
 * @param {Object} [overrides]
 * @returns {Object} Config suitable for HeartbeatManager constructor
 */
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
    cockpitManager: overrides.cockpitManager || null
  };
}

/**
 * Stub all internal heartbeat methods to prevent real processing.
 * @param {HeartbeatManager} hb
 */
function stubHeartbeatMethods(hb) {
  hb._processDeck = async () => ({ processed: 0 });
  hb._processReviewFeedback = async () => ({ processed: 0 });
  hb._processAssignedCards = async () => ({ processed: 0 });
  hb._checkCalendar = async () => ({ upcoming: [] });
  hb._checkKnowledgeBoard = async () => ({ pending: 0 });
  hb._processFlowEvents = () => ({ processed: 0 });
  hb._isQuietHours = () => false;
}

// ============================================================
// Tests
// ============================================================

console.log('\n=== Heartbeat-Cockpit Integration Tests ===\n');

(async () => {
  await asyncTest('pulse() reads cockpit config when cockpitManager is present', async () => {
    let readConfigCalled = false;
    let updateStatusCalled = false;

    const mockCockpit = createMockCockpitManager();
    mockCockpit.readConfig = async () => {
      readConfigCalled = true;
      return {
        style: { name: 'Test', description: 'test' },
        persona: { name: 'Molti', humor: 'light', emoji: 'none', language: 'EN', verbosity: 'concise', formality: 'balanced' },
        guardrails: [],
        mode: { name: 'Full Auto', description: 'Max initiative.' },
        system: { searchProvider: 'searxng', llmTier: 'balanced', dailyDigest: '08:00', autoTagFiles: true, initiativeLevel: 2, workingHours: '08:00-18:00' }
      };
    };
    mockCockpit.updateStatus = async () => { updateStatusCalled = true; };

    const config = createMockConfig({ cockpitManager: mockCockpit });
    const hb = new HeartbeatManager(config);
    stubHeartbeatMethods(hb);

    const results = await hb.pulse();

    assert.strictEqual(readConfigCalled, true, 'readConfig should be called');
    assert.strictEqual(updateStatusCalled, true, 'updateStatus should be called');
    assert.ok(results.cockpit, 'results should include cockpit entry');
    assert.strictEqual(results.cockpit.read, true);
    assert.strictEqual(results.cockpit.updated, true);
  });

  await asyncTest('pulse() propagates initiative level changes from cockpit', async () => {
    const mockCockpit = createMockCockpitManager();
    mockCockpit.readConfig = async () => ({
      style: null,
      persona: { name: 'Molti', humor: 'light', emoji: 'none', language: 'EN', verbosity: 'concise', formality: 'balanced' },
      guardrails: [],
      mode: null,
      system: { searchProvider: 'searxng', llmTier: 'balanced', dailyDigest: '08:00', autoTagFiles: true, initiativeLevel: 3, workingHours: '08:00-18:00' }
    });
    mockCockpit.updateStatus = async () => {};

    const config = createMockConfig({ initiativeLevel: 2, cockpitManager: mockCockpit });
    const hb = new HeartbeatManager(config);
    stubHeartbeatMethods(hb);

    assert.strictEqual(hb.settings.initiativeLevel, 2, 'Should start at level 2');

    await hb.pulse();

    assert.strictEqual(hb.settings.initiativeLevel, 3, 'Should be updated to level 3 from cockpit');
  });

  await asyncTest('pulse() handles cockpit errors gracefully', async () => {
    const mockCockpit = createMockCockpitManager();
    mockCockpit.readConfig = async () => { throw new Error('Deck API timeout'); };

    const config = createMockConfig({ cockpitManager: mockCockpit });
    const hb = new HeartbeatManager(config);
    stubHeartbeatMethods(hb);

    const results = await hb.pulse();

    // Should not throw, and should record error
    const cockpitError = results.errors.find(e => e.component === 'cockpit');
    assert.ok(cockpitError, 'Should record cockpit error');
    assert.ok(cockpitError.error.includes('Deck API timeout'));
  });

  await asyncTest('pulse() skips cockpit when cockpitManager is null', async () => {
    const config = createMockConfig({ cockpitManager: null });
    const hb = new HeartbeatManager(config);
    stubHeartbeatMethods(hb);

    const results = await hb.pulse();

    assert.strictEqual(results.cockpit, undefined, 'No cockpit entry when manager is null');
    assert.strictEqual(results.errors.filter(e => e.component === 'cockpit').length, 0);
  });

  await asyncTest('pulse() does not propagate initiative if system config is null', async () => {
    const mockCockpit = createMockCockpitManager();
    mockCockpit.readConfig = async () => ({
      style: null,
      persona: { name: 'Molti', humor: 'light', emoji: 'none', language: 'EN', verbosity: 'concise', formality: 'balanced' },
      guardrails: [],
      mode: null,
      system: null
    });
    mockCockpit.updateStatus = async () => {};

    const config = createMockConfig({ initiativeLevel: 2, cockpitManager: mockCockpit });
    const hb = new HeartbeatManager(config);
    stubHeartbeatMethods(hb);

    await hb.pulse();

    assert.strictEqual(hb.settings.initiativeLevel, 2, 'Should remain at level 2 when system is null');
  });

  test('cockpitManager property is set on constructor', () => {
    const mockCockpit = createMockCockpitManager();
    const config = createMockConfig({ cockpitManager: mockCockpit });
    const hb = new HeartbeatManager(config);
    assert.strictEqual(hb.cockpitManager, mockCockpit);
  });

  test('cockpitManager defaults to null', () => {
    const config = createMockConfig({});
    const hb = new HeartbeatManager(config);
    assert.strictEqual(hb.cockpitManager, null);
  });

  await asyncTest('start() initializes cockpitManager', async () => {
    let initCalled = false;
    const mockCockpit = createMockCockpitManager();
    mockCockpit.initialize = async () => { initCalled = true; };
    mockCockpit.readConfig = async () => ({
      style: null, persona: { name: 'Molti', humor: 'light', emoji: 'none', language: 'EN', verbosity: 'concise', formality: 'balanced' },
      guardrails: [], mode: null,
      system: { searchProvider: 'searxng', llmTier: 'balanced', dailyDigest: '08:00', autoTagFiles: true, initiativeLevel: 2, workingHours: '08:00-18:00' }
    });
    mockCockpit.updateStatus = async () => {};

    const config = createMockConfig({ cockpitManager: mockCockpit });
    const hb = new HeartbeatManager(config);
    stubHeartbeatMethods(hb);

    await hb.start();
    await hb.stop();

    assert.strictEqual(initCalled, true, 'initialize() should be called during start()');
  });

  // ============================================================
  // Session A3: Working Hours, LLM Tier, Daily Digest Tests
  // ============================================================

  console.log('\n--- Session A3: Working Hours + Config Propagation Tests ---\n');

  await asyncTest('pulse() propagates working hours from cockpit', async () => {
    const mockCockpit = createMockCockpitManager();
    mockCockpit.readConfig = async () => ({
      style: null,
      persona: { name: 'Molti', humor: 'light', emoji: 'none', language: 'EN', verbosity: 'concise', formality: 'balanced' },
      guardrails: [],
      mode: null,
      system: { searchProvider: 'searxng', llmTier: 'balanced', dailyDigest: '08:00', autoTagFiles: true, initiativeLevel: 2, workingHours: '09:00-17:00' }
    });
    mockCockpit.updateStatus = async () => {};

    const config = createMockConfig({ cockpitManager: mockCockpit });
    const hb = new HeartbeatManager(config);
    stubHeartbeatMethods(hb);

    await hb.pulse();

    assert.strictEqual(hb._cockpitWorkingHours, '09:00-17:00', 'Working hours should be propagated');
  });

  await asyncTest('pulse() propagates daily digest from cockpit', async () => {
    const mockCockpit = createMockCockpitManager();
    mockCockpit.readConfig = async () => ({
      style: null,
      persona: { name: 'Molti', humor: 'light', emoji: 'none', language: 'EN', verbosity: 'concise', formality: 'balanced' },
      guardrails: [],
      mode: null,
      system: { searchProvider: 'searxng', llmTier: 'balanced', dailyDigest: '09:30', autoTagFiles: true, initiativeLevel: 2, workingHours: '08:00-18:00' }
    });
    mockCockpit.updateStatus = async () => {};

    const config = createMockConfig({ cockpitManager: mockCockpit });
    const hb = new HeartbeatManager(config);
    stubHeartbeatMethods(hb);

    await hb.pulse();

    assert.strictEqual(hb._cockpitDailyDigest, '09:30', 'Daily digest should be propagated');
  });

  await asyncTest('pulse() propagates LLM tier to router when setTier exists', async () => {
    let setTierCalled = null;
    const mockCockpit = createMockCockpitManager();
    mockCockpit.readConfig = async () => ({
      style: null,
      persona: { name: 'Molti', humor: 'light', emoji: 'none', language: 'EN', verbosity: 'concise', formality: 'balanced' },
      guardrails: [],
      mode: null,
      system: { searchProvider: 'searxng', llmTier: 'local-only', dailyDigest: 'off', autoTagFiles: false, initiativeLevel: 2, workingHours: '08:00-18:00' }
    });
    mockCockpit.updateStatus = async () => {};

    const config = createMockConfig({ cockpitManager: mockCockpit });
    const hb = new HeartbeatManager(config);
    stubHeartbeatMethods(hb);

    // Mock llmRouter with setTier
    hb.llmRouter = {
      route: async () => ({ result: 'ok', tokens: 10 }),
      setTier: (tier) => { setTierCalled = tier; }
    };

    await hb.pulse();

    assert.strictEqual(setTierCalled, 'local-only', 'setTier should be called with cockpit value');
  });

  test('_parseWorkingHours() parses valid HH:MM-HH:MM', () => {
    const config = createMockConfig({});
    const hb = new HeartbeatManager(config);

    const result = hb._parseWorkingHours('08:00-18:00');
    assert.deepStrictEqual(result, { start: 8, end: 18 });
  });

  test('_parseWorkingHours() parses midnight-crossing hours', () => {
    const config = createMockConfig({});
    const hb = new HeartbeatManager(config);

    const result = hb._parseWorkingHours('22:00-06:00');
    assert.deepStrictEqual(result, { start: 22, end: 6 });
  });

  test('_parseWorkingHours() returns null for invalid input', () => {
    const config = createMockConfig({});
    const hb = new HeartbeatManager(config);

    assert.strictEqual(hb._parseWorkingHours(null), null);
    assert.strictEqual(hb._parseWorkingHours(''), null);
    assert.strictEqual(hb._parseWorkingHours('invalid'), null);
    assert.strictEqual(hb._parseWorkingHours('25:00-18:00'), null);
  });

  test('_isWithinWorkingHours() returns true when no hours configured', () => {
    const config = createMockConfig({});
    const hb = new HeartbeatManager(config);

    assert.strictEqual(hb._isWithinWorkingHours(), true, 'Should fail-open when no hours set');
  });

  test('getStatus() includes cockpit working hours and daily digest', () => {
    const config = createMockConfig({});
    const hb = new HeartbeatManager(config);
    hb._cockpitWorkingHours = '09:00-17:00';
    hb._cockpitDailyDigest = '08:00';

    const status = hb.getStatus();
    assert.strictEqual(status.cockpitWorkingHours, '09:00-17:00');
    assert.strictEqual(status.cockpitDailyDigest, '08:00');
  });

  summary();
  exitWithCode();
})();
