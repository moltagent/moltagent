/*
 * Moltagent - Sovereign AI Security Layer
 * Copyright (C) 2026 Moltagent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 */

/**
 * Heartbeat Intelligence Wiring Tests
 *
 * Tests the wiring between HeartbeatManager's pulse() method and the
 * heartbeat intelligence components: MeetingPreparer and FreshnessChecker.
 *
 * Specifically verifies that:
 *  - Constructor stores both components on the instance
 *  - pulse() gates each component behind the correct initiative level
 *  - Errors in one component do not prevent the other from running
 *  - null components are handled gracefully (no crash)
 *
 * Run: node test/unit/integrations/heartbeat-intelligence-wiring.test.js
 */

'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

// ============================================================================
// Load HeartbeatManager
// ============================================================================

let HeartbeatManager;
try {
  HeartbeatManager = require('../../../src/lib/integrations/heartbeat-manager');
} catch (err) {
  console.error('Failed to load HeartbeatManager:', err.message);
  process.exit(1);
}

// ============================================================================
// Config factory
// ============================================================================

/**
 * Build a minimal config that does not crash the HeartbeatManager constructor.
 * intelligence components are injected via overrides.meetingPreparer /
 * overrides.hbFreshnessChecker.
 */
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
      initiativeLevel: overrides.initiativeLevel ?? 1,
      ...(overrides.heartbeat || {})
    },
    llmRouter: { route: async () => ({ result: 'ok', tokens: 10 }) },
    notifyUser: async () => {},
    auditLog: async () => {},
    credentialBroker: {
      prefetchAll: async () => {},
      get: async () => null,
      getNCPassword: () => 'test'
    },
    // Heartbeat intelligence components
    meetingPreparer: overrides.meetingPreparer || null,
    hbFreshnessChecker: overrides.hbFreshnessChecker || null
  };
}

/**
 * Stub all internal pulse() sub-methods that would otherwise attempt real
 * network/API calls. Call this immediately after constructing HeartbeatManager.
 */
function stubPulseInternals(hb) {
  hb._processDeck = async () => ({ processed: 0 });
  hb._processReviewFeedback = async () => ({ processed: 0 });
  hb._processAssignedCards = async () => ({ processed: 0 });
  hb._checkCalendar = async () => ({ upcoming: [] });
  hb._checkKnowledgeBoard = async () => ({ pending: 0 });
  hb._processFlowEvents = () => ({ processed: 0 });
  hb._isQuietHours = () => false;
}

// ============================================================================
// Mock intelligence component factories
// ============================================================================

/**
 * Create a lightweight mock FreshnessChecker that tracks whether
 * maybeCheck() was invoked.
 */
function createMockFreshnessChecker(result = { checked: 5, flagged: 1 }) {
  let called = false;
  return {
    maybeCheck: async () => { called = true; return result; },
    get wasCalled() { return called; },
    lastCheckDate: null
  };
}

/**
 * Create a lightweight mock MeetingPreparer that tracks whether
 * checkAndPrep() was invoked.
 */
function createMockMeetingPreparer(result = { checked: 2, prepped: 1 }) {
  let called = false;
  return {
    checkAndPrep: async () => { called = true; return result; },
    get wasCalled() { return called; },
    preparedMeetings: new Set(),
    resetDaily: () => {}
  };
}

// ============================================================================
// Tests
// ============================================================================

console.log('\n=== Heartbeat Intelligence Wiring Tests ===\n');

(async () => {

  // --------------------------------------------------------------------------
  // 1. Constructor stores hbFreshnessChecker on the instance
  // --------------------------------------------------------------------------
  test('HeartbeatManager receives hbFreshnessChecker in constructor', () => {
    const freshnessChecker = createMockFreshnessChecker();
    const config = createMockConfig({ hbFreshnessChecker: freshnessChecker });
    const hb = new HeartbeatManager(config);

    assert.strictEqual(hb.hbFreshnessChecker, freshnessChecker,
      'hbFreshnessChecker should be stored on the instance');
  });

  // --------------------------------------------------------------------------
  // 2. Constructor stores meetingPreparer on the instance
  // --------------------------------------------------------------------------
  test('HeartbeatManager receives meetingPreparer in constructor', () => {
    const meetingPreparer = createMockMeetingPreparer();
    const config = createMockConfig({ meetingPreparer });
    const hb = new HeartbeatManager(config);

    assert.strictEqual(hb.meetingPreparer, meetingPreparer,
      'meetingPreparer should be stored on the instance');
  });

  // --------------------------------------------------------------------------
  // 3. pulse() at level 2 calls hbFreshnessChecker.maybeCheck()
  // --------------------------------------------------------------------------
  await asyncTest('pulse() at level 2 calls hbFreshnessChecker.maybeCheck()', async () => {
    const freshnessChecker = createMockFreshnessChecker();
    const config = createMockConfig({
      initiativeLevel: 2,
      hbFreshnessChecker: freshnessChecker
    });
    const hb = new HeartbeatManager(config);
    stubPulseInternals(hb);

    await hb.pulse();

    assert.strictEqual(freshnessChecker.wasCalled, true,
      'hbFreshnessChecker.maybeCheck() should be called at level 2');
  });

  // --------------------------------------------------------------------------
  // 4. pulse() at level 2 does NOT call meetingPreparer.checkAndPrep()
  // --------------------------------------------------------------------------
  await asyncTest('pulse() at level 2 does NOT call meetingPreparer.checkAndPrep()', async () => {
    const meetingPreparer = createMockMeetingPreparer();
    const config = createMockConfig({
      initiativeLevel: 2,
      meetingPreparer
    });
    const hb = new HeartbeatManager(config);
    stubPulseInternals(hb);

    await hb.pulse();

    assert.strictEqual(meetingPreparer.wasCalled, false,
      'meetingPreparer.checkAndPrep() should NOT be called at level 2');
  });

  // --------------------------------------------------------------------------
  // 5. pulse() at level 3 calls meetingPreparer.checkAndPrep()
  // --------------------------------------------------------------------------
  await asyncTest('pulse() at level 3 calls meetingPreparer.checkAndPrep()', async () => {
    const meetingPreparer = createMockMeetingPreparer();
    const config = createMockConfig({
      initiativeLevel: 3,
      meetingPreparer
    });
    const hb = new HeartbeatManager(config);
    stubPulseInternals(hb);

    await hb.pulse();

    assert.strictEqual(meetingPreparer.wasCalled, true,
      'meetingPreparer.checkAndPrep() should be called at level 3');
  });

  // --------------------------------------------------------------------------
  // 6. pulse() at level 3 also calls hbFreshnessChecker.maybeCheck()
  // --------------------------------------------------------------------------
  await asyncTest('pulse() at level 3 calls hbFreshnessChecker.maybeCheck()', async () => {
    const freshnessChecker = createMockFreshnessChecker();
    const config = createMockConfig({
      initiativeLevel: 3,
      hbFreshnessChecker: freshnessChecker
    });
    const hb = new HeartbeatManager(config);
    stubPulseInternals(hb);

    await hb.pulse();

    assert.strictEqual(freshnessChecker.wasCalled, true,
      'hbFreshnessChecker.maybeCheck() should also be called at level 3');
  });

  // --------------------------------------------------------------------------
  // 7. pulse() at level 1 does NOT call either intelligence component
  // --------------------------------------------------------------------------
  await asyncTest('pulse() at level 1 does NOT call either component', async () => {
    const freshnessChecker = createMockFreshnessChecker();
    const meetingPreparer = createMockMeetingPreparer();
    const config = createMockConfig({
      initiativeLevel: 1,
      hbFreshnessChecker: freshnessChecker,
      meetingPreparer
    });
    const hb = new HeartbeatManager(config);
    stubPulseInternals(hb);

    await hb.pulse();

    assert.strictEqual(freshnessChecker.wasCalled, false,
      'hbFreshnessChecker should NOT be called at level 1');
    assert.strictEqual(meetingPreparer.wasCalled, false,
      'meetingPreparer should NOT be called at level 1');
  });

  // --------------------------------------------------------------------------
  // 8. pulse() handles null components gracefully (no crash if both null)
  // --------------------------------------------------------------------------
  await asyncTest('pulse() handles null components gracefully (no crash if both null)', async () => {
    const config = createMockConfig({
      initiativeLevel: 3,
      hbFreshnessChecker: null,
      meetingPreparer: null
    });
    const hb = new HeartbeatManager(config);
    stubPulseInternals(hb);

    // Should not throw even though both components are null
    let caughtError = null;
    try {
      await hb.pulse();
    } catch (err) {
      caughtError = err;
    }

    assert.strictEqual(caughtError, null,
      'pulse() should not throw when both intelligence components are null');
  });

  // --------------------------------------------------------------------------
  // 9. pulse() catches hbFreshnessChecker error without crashing
  // --------------------------------------------------------------------------
  await asyncTest('pulse() catches hbFreshnessChecker error without crashing', async () => {
    const throwingFreshnessChecker = {
      maybeCheck: async () => { throw new Error('freshness boom'); },
      get wasCalled() { return true; },
      lastCheckDate: null
    };

    const config = createMockConfig({
      initiativeLevel: 2,
      hbFreshnessChecker: throwingFreshnessChecker
    });
    const hb = new HeartbeatManager(config);
    stubPulseInternals(hb);

    let caughtError = null;
    let pulseResult;
    try {
      pulseResult = await hb.pulse();
    } catch (err) {
      caughtError = err;
    }

    assert.strictEqual(caughtError, null,
      'pulse() should not propagate hbFreshnessChecker errors');

    // The error should be recorded in results.errors
    assert.ok(
      Array.isArray(pulseResult.errors) &&
      pulseResult.errors.some(e => e.component === 'freshness'),
      'freshness error should be recorded in results.errors'
    );
  });

  // --------------------------------------------------------------------------
  // 10. FreshnessChecker error does not block MeetingPreparer from running
  // --------------------------------------------------------------------------
  await asyncTest('FreshnessChecker error does not block MeetingPreparer from running', async () => {
    const throwingFreshnessChecker = {
      maybeCheck: async () => { throw new Error('freshness boom'); },
      lastCheckDate: null
    };
    const meetingPreparer = createMockMeetingPreparer();

    const config = createMockConfig({
      initiativeLevel: 3,
      hbFreshnessChecker: throwingFreshnessChecker,
      meetingPreparer
    });
    const hb = new HeartbeatManager(config);
    stubPulseInternals(hb);

    await hb.pulse();

    assert.strictEqual(meetingPreparer.wasCalled, true,
      'meetingPreparer.checkAndPrep() should still run even when FreshnessChecker throws');
  });

  // ============================================================================
  // Summary
  // ============================================================================

  summary();
  exitWithCode();
})();
