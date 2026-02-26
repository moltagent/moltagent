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
  hb._processFlowEvents = async () => ({ processed: 0, mentionsHandled: 0 });
  hb._isQuietHours = () => false;
  hb._isWithinWorkingHours = () => true;
}

// ============================================================
// Tests
// ============================================================

console.log('\n=== Heartbeat-Cockpit Integration Tests ===\n');

(async () => {
  await asyncTest('pulse() reads cockpit config when cockpitManager is present', async () => {
    let readConfigCalled = false;
    let updateStatusArg = null;

    const mockCockpit = createMockCockpitManager();
    mockCockpit.readConfig = async () => {
      readConfigCalled = true;
      return {
        style: { name: 'Test', description: 'test' },
        persona: { name: 'Molti', humor: 'light', emoji: 'none', language: 'EN', verbosity: 'concise', formality: 'balanced' },
        guardrails: [],
        mode: { name: 'Full Auto', description: 'Max initiative.' },
        system: { dailyDigest: '08:00', initiativeLevel: 2, workingHours: '08:00-18:00' }
      };
    };
    mockCockpit.updateStatus = async (arg) => { updateStatusArg = arg; };

    const config = createMockConfig({ cockpitManager: mockCockpit });
    const hb = new HeartbeatManager(config);
    stubHeartbeatMethods(hb);

    const results = await hb.pulse();

    assert.strictEqual(readConfigCalled, true, 'readConfig should be called');
    assert.ok(updateStatusArg, 'updateStatus should be called');
    assert.ok(updateStatusArg.health, 'updateStatus should receive health');
    assert.ok('costs' in updateStatusArg, 'updateStatus should receive costs key');
    assert.ok('routerStats' in updateStatusArg, 'updateStatus should receive routerStats key');
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
      system: { dailyDigest: '08:00', initiativeLevel: 2, workingHours: '08:00-18:00' }
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
      system: { dailyDigest: '09:30', initiativeLevel: 2, workingHours: '08:00-18:00' }
    });
    mockCockpit.updateStatus = async () => {};

    const config = createMockConfig({ cockpitManager: mockCockpit });
    const hb = new HeartbeatManager(config);
    stubHeartbeatMethods(hb);

    await hb.pulse();

    assert.strictEqual(hb._cockpitDailyDigest, '09:30', 'Daily digest should be propagated');
  });

  await asyncTest('pulse() propagates models preset to router when setPreset exists', async () => {
    let setPresetCalled = null;
    const mockCockpit = createMockCockpitManager();
    mockCockpit.readConfig = async () => ({
      style: null,
      persona: { name: 'Molti', humor: 'light', emoji: 'none', language: 'EN', verbosity: 'concise', formality: 'balanced' },
      guardrails: [],
      mode: null,
      system: { modelsConfig: { preset: 'all-local' }, dailyDigest: 'off', initiativeLevel: 2, workingHours: '08:00-18:00' }
    });
    mockCockpit.updateStatus = async () => {};

    const config = createMockConfig({ cockpitManager: mockCockpit });
    const hb = new HeartbeatManager(config);
    stubHeartbeatMethods(hb);

    // Mock llmRouter with setPreset
    hb.llmRouter = {
      route: async () => ({ result: 'ok', tokens: 10 }),
      setPreset: (preset) => { setPresetCalled = preset; }
    };

    await hb.pulse();

    assert.strictEqual(setPresetCalled, 'all-local', 'setPreset should be called with cockpit value');
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

  // ============================================================
  // Cockpit Mode Gating Tests
  // ============================================================

  console.log('\n--- Cockpit Mode Gating Tests ---\n');

  await asyncTest('TC-HB-MODE-001: pulse() reads mode from cockpitConfig and sets _activeMode', async () => {
    const mockCockpit = createMockCockpitManager();
    mockCockpit.readConfig = async () => ({
      style: null,
      persona: { name: 'Molti', humor: 'light', emoji: 'none', language: 'EN', verbosity: 'concise', formality: 'balanced' },
      guardrails: [],
      mode: { name: 'Focus Mode', description: 'Minimal interruptions.' },
      system: { initiativeLevel: 2, workingHours: '08:00-18:00' }
    });
    mockCockpit.updateStatus = async () => {};

    const config = createMockConfig({ cockpitManager: mockCockpit });
    const hb = new HeartbeatManager(config);
    stubHeartbeatMethods(hb);

    await hb.pulse();

    assert.strictEqual(hb._activeMode, 'focus-mode', 'Active mode should be set to focus-mode');
  });

  await asyncTest('TC-HB-MODE-002: Focus Mode skips Deck, email, workflow processing', async () => {
    const config = createMockConfig({});
    const hb = new HeartbeatManager(config);
    hb._activeMode = 'focus-mode';

    assert.strictEqual(hb._isModeGated('deck'), true, 'Deck should be gated in Focus Mode');
    assert.strictEqual(hb._isModeGated('email'), true, 'Email should be gated in Focus Mode');
    assert.strictEqual(hb._isModeGated('workflow'), true, 'Workflow should be gated in Focus Mode');
    assert.strictEqual(hb._isModeGated('calendar'), true, 'Calendar should be gated in Focus Mode');
    assert.strictEqual(hb._isModeGated('cockpit'), false, 'Cockpit should NOT be gated in Focus Mode');
    assert.strictEqual(hb._isModeGated('infra'), false, 'Infra should NOT be gated in Focus Mode');
  });

  await asyncTest('TC-HB-MODE-003: Meeting Day runs calendar + meeting prep, skips Deck', async () => {
    const config = createMockConfig({});
    const hb = new HeartbeatManager(config);
    hb._activeMode = 'meeting-day';

    assert.strictEqual(hb._isModeGated('deck'), true, 'Deck should be gated in Meeting Day');
    assert.strictEqual(hb._isModeGated('email'), true, 'Email should be gated in Meeting Day');
    assert.strictEqual(hb._isModeGated('calendar'), false, 'Calendar should NOT be gated in Meeting Day');
    assert.strictEqual(hb._isModeGated('meetingPrep'), false, 'Meeting prep should NOT be gated in Meeting Day');
    assert.strictEqual(hb._isModeGated('rsvp'), false, 'RSVP should NOT be gated in Meeting Day');
    assert.strictEqual(hb._isModeGated('flow'), false, 'Flow should NOT be gated in Meeting Day');
    assert.strictEqual(hb._isModeGated('cockpit'), false, 'Cockpit should NOT be gated in Meeting Day');
    assert.strictEqual(hb._isModeGated('infra'), false, 'Infra should NOT be gated in Meeting Day');
  });

  await asyncTest('TC-HB-MODE-004: Out of Office skips everything except cockpit + infra', async () => {
    const config = createMockConfig({});
    const hb = new HeartbeatManager(config);
    hb._activeMode = 'out-of-office';

    assert.strictEqual(hb._isModeGated('deck'), true, 'Deck should be gated in OOO');
    assert.strictEqual(hb._isModeGated('email'), true, 'Email should be gated in OOO');
    assert.strictEqual(hb._isModeGated('calendar'), true, 'Calendar should be gated in OOO');
    assert.strictEqual(hb._isModeGated('workflow'), true, 'Workflow should be gated in OOO');
    assert.strictEqual(hb._isModeGated('flow'), true, 'Flow should be gated in OOO');
    assert.strictEqual(hb._isModeGated('deferral'), true, 'Deferral should be gated in OOO');
    assert.strictEqual(hb._isModeGated('cockpit'), false, 'Cockpit should NOT be gated in OOO');
    assert.strictEqual(hb._isModeGated('infra'), false, 'Infra should NOT be gated in OOO');
  });

  await asyncTest('TC-HB-MODE-005: Full Auto runs all subsystems (no gating)', async () => {
    const config = createMockConfig({});
    const hb = new HeartbeatManager(config);
    hb._activeMode = 'full-auto';

    const subsystems = ['deck', 'calendar', 'email', 'rsvp', 'workflow', 'knowledge', 'meetingPrep', 'flow', 'deferral', 'infra', 'cockpit'];
    for (const sub of subsystems) {
      assert.strictEqual(hb._isModeGated(sub), false, `${sub} should NOT be gated in Full Auto`);
    }
  });

  await asyncTest('TC-HB-MODE-006: Mode change propagates to messageProcessor.setMode()', async () => {
    let setModeArg = null;
    const mockCockpit = createMockCockpitManager();
    mockCockpit.readConfig = async () => ({
      style: null,
      persona: { name: 'Molti', humor: 'light', emoji: 'none', language: 'EN', verbosity: 'concise', formality: 'balanced' },
      guardrails: [],
      mode: { name: 'Out of Office', description: 'Away.' },
      system: { initiativeLevel: 2, workingHours: '08:00-18:00' }
    });
    mockCockpit.updateStatus = async () => {};

    const config = createMockConfig({ cockpitManager: mockCockpit });
    const hb = new HeartbeatManager(config);
    stubHeartbeatMethods(hb);

    // Attach mock messageProcessor
    hb.messageProcessor = {
      setMode: (mode) => { setModeArg = mode; }
    };

    await hb.pulse();

    assert.strictEqual(setModeArg, 'out-of-office', 'setMode should be called with out-of-office');
    assert.strictEqual(hb._activeMode, 'out-of-office', '_activeMode should be set');
  });

  // ============================================================
  // B2: Models card / _handleModelsUpdate tests
  // ============================================================

  console.log('\n--- B2: Models card / _handleModelsUpdate Tests ---\n');

  await asyncTest('TC-MODELS-001: _handleModelsUpdate registers players and calls setRoster', async () => {
    let registerProviderCalls = [];
    let setRosterArg = null;

    const config = createMockConfig({});
    const hb = new HeartbeatManager(config);

    // Mock llmRouter with tracking
    hb.llmRouter = {
      route: async () => ({ result: 'ok', tokens: 10 }),
      registerProvider: (id, cfg) => { registerProviderCalls.push({ id, cfg }); },
      setRoster: (r) => { setRosterArg = r; }
    };

    await hb._handleModelsUpdate({
      players: {
        'my-ollama': { type: 'ollama', model: 'llama3', local: true }
      },
      roster: { quick: ['my-ollama'] }
    });

    assert.ok(registerProviderCalls.some(c => c.id === 'my-ollama'), 'Should register my-ollama');
    assert.deepStrictEqual(setRosterArg, { quick: ['my-ollama'] }, 'Should call setRoster with provided roster');
  });

  await asyncTest('TC-MODELS-002: _handleModelsUpdate skips players with missing API keys', async () => {
    let registerProviderCalls = [];

    const config = createMockConfig({});
    const hb = new HeartbeatManager(config);

    // credentialBroker returns null for all keys
    hb.credentialBroker = { get: async () => null };
    hb.llmRouter = {
      registerProvider: (id) => { registerProviderCalls.push(id); },
      setRoster: () => {}
    };

    await hb._handleModelsUpdate({
      players: {
        'perplexity-sonar': {
          type: 'perplexity',
          model: 'sonar-pro',
          credentialLabel: 'perplexity-api-key'  // key doesn't exist
        }
      }
    });

    assert.strictEqual(registerProviderCalls.length, 0, 'Should not register player with missing API key');
  });

  await asyncTest('TC-MODELS-003: _handleModelsUpdate does not require credentialLabel for local providers', async () => {
    let registerProviderCalls = [];

    const config = createMockConfig({});
    const hb = new HeartbeatManager(config);

    hb.llmRouter = {
      registerProvider: (id) => { registerProviderCalls.push(id); },
      setRoster: () => {}
    };

    await hb._handleModelsUpdate({
      players: {
        'local-ollama': {
          type: 'ollama',
          model: 'phi4-mini',
          local: true
          // No credentialLabel needed
        }
      }
    });

    assert.ok(registerProviderCalls.includes('local-ollama'), 'Local player without key should register');
  });

  await asyncTest('TC-MODELS-004: _handleModelsUpdate registers chat provider with routerChatBridge', async () => {
    let registeredChatProviders = [];

    const config = createMockConfig({});
    const hb = new HeartbeatManager(config);

    hb.llmRouter = {
      registerProvider: () => {},
      setRoster: () => {}
    };

    hb.routerChatBridge = {
      registerChatProvider: (id, provider) => { registeredChatProviders.push({ id, provider }); }
    };

    await hb._handleModelsUpdate({
      players: {
        'local-llama': {
          type: 'ollama',
          model: 'llama3',
          local: true
        }
      }
    });

    assert.ok(registeredChatProviders.some(e => e.id === 'local-llama'),
      'Should register chat provider for local-llama');
  });

  await asyncTest('TC-MODELS-005: _handleModelsUpdate skips setRoster when no roster provided', async () => {
    let setRosterCalled = false;

    const config = createMockConfig({});
    const hb = new HeartbeatManager(config);

    hb.llmRouter = {
      registerProvider: () => {},
      setRoster: () => { setRosterCalled = true; }
    };

    await hb._handleModelsUpdate({
      players: {
        'local-llama': { type: 'ollama', model: 'llama3', local: true }
      }
      // no roster key
    });

    assert.strictEqual(setRosterCalled, false, 'setRoster should not be called when no roster provided');
  });

  await asyncTest('TC-MODELS-006: _handleModelsUpdate is a no-op when llmRouter is null', async () => {
    const config = createMockConfig({});
    const hb = new HeartbeatManager(config);
    hb.llmRouter = null;

    // Should not throw
    await hb._handleModelsUpdate({
      players: { 'local-llama': { type: 'ollama', model: 'llama3', local: true } }
    });
    assert.ok(true, 'Should complete without error');
  });

  await asyncTest('TC-MODELS-007: pulse() calls _handleModelsUpdate when modelsConfig.players is present', async () => {
    let handleModelsUpdateArg = null;
    const mockCockpit = createMockCockpitManager();
    mockCockpit.readConfig = async () => ({
      style: null,
      persona: { name: 'Molti', humor: 'light', emoji: 'none', language: 'EN', verbosity: 'concise', formality: 'balanced' },
      guardrails: [],
      mode: null,
      system: {
        modelsConfig: {
          players: { 'my-player': { type: 'ollama', model: 'llama3', local: true } },
          roster: { quick: ['my-player'] }
        },
        dailyDigest: 'off',
        initiativeLevel: 2,
        workingHours: '08:00-18:00'
      }
    });
    mockCockpit.updateStatus = async () => {};

    const config = createMockConfig({ cockpitManager: mockCockpit });
    config.llmRouter = {
      route: async () => ({ result: 'ok', tokens: 10 }),
      getStats: () => ({ totalCalls: 0 }),
      registerProvider: () => {},
      setRoster: () => {}
    };
    const hb = new HeartbeatManager(config);
    stubHeartbeatMethods(hb);

    // Spy on _handleModelsUpdate
    const original = hb._handleModelsUpdate.bind(hb);
    hb._handleModelsUpdate = async (mc) => { handleModelsUpdateArg = mc; return original(mc); };

    await hb.pulse();

    assert.ok(handleModelsUpdateArg !== null, '_handleModelsUpdate should have been called');
    assert.ok(handleModelsUpdateArg.players, 'players should be passed to _handleModelsUpdate');
  });

  await asyncTest('TC-MODELS-008: routerChatBridge set from config', async () => {
    const fakeBridge = { registerChatProvider: () => {}, unregisterChatProvider: () => {} };
    const config = createMockConfig({});
    config.routerChatBridge = fakeBridge;

    const hb = new HeartbeatManager(config);
    assert.strictEqual(hb.routerChatBridge, fakeBridge, 'routerChatBridge should be stored from config');
  });

  test('TC-MODELS-009: routerChatBridge defaults to null', () => {
    const config = createMockConfig({});
    const hb = new HeartbeatManager(config);
    assert.strictEqual(hb.routerChatBridge, null);
  });

  await asyncTest('TC-MODELS-010: pulse() skips propagation when modelsConfig.changed is false', async () => {
    let setPresetCalled = false;
    const mockCockpit = createMockCockpitManager();
    mockCockpit.readConfig = async () => ({
      style: null,
      persona: { name: 'Molti', humor: 'light', emoji: 'none', language: 'EN', verbosity: 'concise', formality: 'balanced' },
      guardrails: [],
      mode: null,
      system: { modelsConfig: { preset: 'smart-mix', changed: false }, dailyDigest: 'off', initiativeLevel: 2, workingHours: '08:00-18:00' }
    });
    mockCockpit.updateStatus = async () => {};

    const config = createMockConfig({ cockpitManager: mockCockpit });
    const hb = new HeartbeatManager(config);
    stubHeartbeatMethods(hb);

    hb.llmRouter = {
      route: async () => ({ result: 'ok', tokens: 10 }),
      setPreset: () => { setPresetCalled = true; }
    };

    await hb.pulse();
    assert.strictEqual(setPresetCalled, false, 'setPreset should NOT be called when changed=false');
  });

  await asyncTest('TC-MODELS-011: pulse() propagates when modelsConfig.changed is true', async () => {
    let setPresetCalled = null;
    const mockCockpit = createMockCockpitManager();
    mockCockpit.readConfig = async () => ({
      style: null,
      persona: { name: 'Molti', humor: 'light', emoji: 'none', language: 'EN', verbosity: 'concise', formality: 'balanced' },
      guardrails: [],
      mode: null,
      system: { modelsConfig: { preset: 'cloud-first', changed: true }, dailyDigest: 'off', initiativeLevel: 2, workingHours: '08:00-18:00' }
    });
    mockCockpit.updateStatus = async () => {};

    const config = createMockConfig({ cockpitManager: mockCockpit });
    const hb = new HeartbeatManager(config);
    stubHeartbeatMethods(hb);

    hb.llmRouter = {
      route: async () => ({ result: 'ok', tokens: 10 }),
      setPreset: (p) => { setPresetCalled = p; }
    };

    await hb.pulse();
    assert.strictEqual(setPresetCalled, 'cloud-first', 'setPreset should be called when changed=true');
  });

  summary();
  exitWithCode();
})();
