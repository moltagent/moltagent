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
 * MeetingPreparer heartbeat intelligence component.
 *
 * Specifically verifies that:
 *  - Constructor stores meetingPreparer on the instance
 *  - pulse() gates MeetingPreparer behind the correct initiative level
 *  - null meetingPreparer is handled gracefully (no crash)
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
 * MeetingPreparer is injected via overrides.meetingPreparer.
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
    meetingPreparer: overrides.meetingPreparer || null
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
  // 1. Constructor stores meetingPreparer on the instance
  // --------------------------------------------------------------------------
  test('HeartbeatManager receives meetingPreparer in constructor', () => {
    const meetingPreparer = createMockMeetingPreparer();
    const config = createMockConfig({ meetingPreparer });
    const hb = new HeartbeatManager(config);

    assert.strictEqual(hb.meetingPreparer, meetingPreparer,
      'meetingPreparer should be stored on the instance');
  });

  // --------------------------------------------------------------------------
  // 2. pulse() at level 2 does NOT call meetingPreparer.checkAndPrep()
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
  // 3. pulse() at level 3 calls meetingPreparer.checkAndPrep()
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
  // 4. pulse() at level 1 does NOT call meetingPreparer
  // --------------------------------------------------------------------------
  await asyncTest('pulse() at level 1 does NOT call meetingPreparer', async () => {
    const meetingPreparer = createMockMeetingPreparer();
    const config = createMockConfig({
      initiativeLevel: 1,
      meetingPreparer
    });
    const hb = new HeartbeatManager(config);
    stubPulseInternals(hb);

    await hb.pulse();

    assert.strictEqual(meetingPreparer.wasCalled, false,
      'meetingPreparer should NOT be called at level 1');
  });

  // --------------------------------------------------------------------------
  // 5. pulse() handles null meetingPreparer gracefully (no crash)
  // --------------------------------------------------------------------------
  await asyncTest('pulse() handles null meetingPreparer gracefully (no crash)', async () => {
    const config = createMockConfig({
      initiativeLevel: 3,
      meetingPreparer: null
    });
    const hb = new HeartbeatManager(config);
    stubPulseInternals(hb);

    let caughtError = null;
    try {
      await hb.pulse();
    } catch (err) {
      caughtError = err;
    }

    assert.strictEqual(caughtError, null,
      'pulse() should not throw when meetingPreparer is null');
  });

  // ============================================================================
  // Summary
  // ============================================================================

  summary();
  exitWithCode();
})();
