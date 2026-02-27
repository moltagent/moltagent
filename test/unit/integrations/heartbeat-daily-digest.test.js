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
 * Heartbeat Daily Digest Tests
 *
 * Tests the DailyBriefing class and the HeartbeatManager daily digest
 * wiring in pulse().
 *
 * TC-DD-01 through TC-DD-10: DailyBriefing unit tests
 * TC-DD-11 through TC-DD-13: HeartbeatManager wiring tests
 *
 * Run: node test/unit/integrations/heartbeat-daily-digest.test.js
 */

'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

// ============================================================================
// Load modules under test
// ============================================================================

let DailyBriefing;
try {
  ({ DailyBriefing } = require('../../../src/lib/agent/daily-briefing'));
} catch (err) {
  console.error('Failed to load DailyBriefing:', err.message);
  process.exit(1);
}

let HeartbeatManager;
try {
  HeartbeatManager = require('../../../src/lib/integrations/heartbeat-manager');
} catch (err) {
  console.error('Failed to load HeartbeatManager:', err.message);
  process.exit(1);
}

// ============================================================================
// Mock factories for DailyBriefing
// ============================================================================

/**
 * Build a mock caldavClient whose getUpcomingEvents() returns the provided array.
 */
function makeCaldav(events) {
  return { getUpcomingEvents: async () => events };
}

/**
 * Build a mock caldavClient that throws on getUpcomingEvents().
 */
function makeThrowingCaldav() {
  return { getUpcomingEvents: async () => { throw new Error('caldav boom'); } };
}

/**
 * Build a mock deckClient whose getCardsInStack() returns a fixed array per stack name.
 * stackMap: { inbox: [...], working: [...], review: [...] }
 */
function makeDeck(stackMap = {}) {
  return {
    getCardsInStack: async (name) => stackMap[name] || []
  };
}

/**
 * Build a mock deckClient that throws on getCardsInStack().
 */
function makeThrowingDeck() {
  return { getCardsInStack: async () => { throw new Error('deck boom'); } };
}

/**
 * Build a mock budgetEnforcer whose getFullReport() returns the provided report.
 */
function makeBudget(report) {
  return { getFullReport: () => report };
}

// ============================================================================
// HeartbeatManager config factory (matches existing wiring test pattern)
// ============================================================================

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
      timezone: 'UTC',
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
    // Daily digest components
    dailyBriefing: overrides.dailyBriefing || null,
    talkSendQueue: overrides.talkSendQueue || null,
    primaryRoomToken: overrides.primaryRoomToken || null,
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
// Tests
// ============================================================================

console.log('\n=== Heartbeat Daily Digest Tests ===\n');

(async () => {

  // --------------------------------------------------------------------------
  // TC-DD-01: checkAndBuild() returns non-empty string on first call
  // --------------------------------------------------------------------------
  await asyncTest('TC-DD-01: checkAndBuild() returns non-empty string on first call', async () => {
    const caldav = makeCaldav([
      { start: new Date().toISOString(), summary: 'Standup' },
      { start: new Date().toISOString(), summary: 'Review' }
    ]);
    const deck = makeDeck({ inbox: [1], working: [], review: [] });
    const briefing = new DailyBriefing({ caldavClient: caldav, deckClient: deck });

    const result = await briefing.checkAndBuild();

    assert.ok(typeof result === 'string' && result.length > 0,
      'checkAndBuild() should return a non-empty string on first call');
    assert.ok(result.includes('<daily_briefing>'),
      'result should contain <daily_briefing> tag');
  });

  // --------------------------------------------------------------------------
  // TC-DD-02: checkAndBuild() returns '' on second call (already sent today)
  // --------------------------------------------------------------------------
  await asyncTest('TC-DD-02: checkAndBuild() returns empty string on second call', async () => {
    const caldav = makeCaldav([{ start: new Date().toISOString(), summary: 'Standup' }]);
    const briefing = new DailyBriefing({ caldavClient: caldav });

    const first = await briefing.checkAndBuild();
    const second = await briefing.checkAndBuild();

    assert.ok(first.length > 0, 'first call should return non-empty string');
    assert.strictEqual(second, '', 'second call should return empty string');
  });

  // --------------------------------------------------------------------------
  // TC-DD-03: checkAndBuild() includes calendar events in output
  // --------------------------------------------------------------------------
  await asyncTest('TC-DD-03: checkAndBuild() includes calendar event summaries in output', async () => {
    const caldav = makeCaldav([{ start: '2026-02-27T09:00:00Z', summary: 'Team Standup' }]);
    const briefing = new DailyBriefing({ caldavClient: caldav });

    const result = await briefing.checkAndBuild();

    assert.ok(result.includes('Team Standup'),
      'result should contain the calendar event summary "Team Standup"');
  });

  // --------------------------------------------------------------------------
  // TC-DD-04: checkAndBuild() includes task counts in output
  // --------------------------------------------------------------------------
  await asyncTest('TC-DD-04: checkAndBuild() includes task counts in output', async () => {
    const deck = makeDeck({
      inbox:   [1, 2, 3],
      working: [4, 5],
      review:  [6]
    });
    const briefing = new DailyBriefing({ deckClient: deck });

    const result = await briefing.checkAndBuild();

    assert.ok(result.includes('3 in inbox'),
      'result should contain "3 in inbox"');
    assert.ok(result.includes('2 in progress'),
      'result should contain "2 in progress"');
    assert.ok(result.includes('1 awaiting review'),
      'result should contain "1 awaiting review"');
  });

  // --------------------------------------------------------------------------
  // TC-DD-05: checkAndBuild() includes cost data in output
  // --------------------------------------------------------------------------
  await asyncTest('TC-DD-05: checkAndBuild() includes cost data in output', async () => {
    const budget = makeBudget({
      providers: { local: { monthly: { cost: 4.20 } } },
      proactive: { dailyCost: 0.30 }
    });
    const briefing = new DailyBriefing({ budgetEnforcer: budget });

    const result = await briefing.checkAndBuild();

    assert.ok(result.includes('$4.20'),
      'result should contain "$4.20" monthly cost');
  });

  // --------------------------------------------------------------------------
  // TC-DD-06: checkAndBuild() handles calendar failure gracefully
  // --------------------------------------------------------------------------
  await asyncTest('TC-DD-06: checkAndBuild() handles calendar failure gracefully', async () => {
    const caldav = makeThrowingCaldav();
    const deck = makeDeck({ inbox: [1, 2], working: [], review: [] });
    const briefing = new DailyBriefing({ caldavClient: caldav, deckClient: deck });

    let caughtError = null;
    let result;
    try {
      result = await briefing.checkAndBuild();
    } catch (err) {
      caughtError = err;
    }

    assert.strictEqual(caughtError, null, 'checkAndBuild() should not throw on calendar failure');
    assert.ok(result.includes('Could not check'),
      'result should contain "Could not check" for failed calendar');
    assert.ok(result.includes('2 in inbox'),
      'result should still contain task data despite calendar failure');
  });

  // --------------------------------------------------------------------------
  // TC-DD-07: checkAndBuild() handles all sources failing
  // --------------------------------------------------------------------------
  await asyncTest('TC-DD-07: checkAndBuild() handles all data sources failing', async () => {
    const caldav = makeThrowingCaldav();
    const deck = makeThrowingDeck();
    const budget = { getFullReport: () => { throw new Error('budget boom'); } };
    const briefing = new DailyBriefing({ caldavClient: caldav, deckClient: deck, budgetEnforcer: budget });

    let caughtError = null;
    let result;
    try {
      result = await briefing.checkAndBuild();
    } catch (err) {
      caughtError = err;
    }

    assert.strictEqual(caughtError, null, 'checkAndBuild() should not throw when all sources fail');
    // Each source appends a failure marker; result may be a string (with failures) or ''
    assert.ok(typeof result === 'string', 'checkAndBuild() should return a string');
    if (result.length > 0) {
      assert.ok(result.includes('Could not check'),
        'result should contain "Could not check" when sources fail');
    }
  });

  // --------------------------------------------------------------------------
  // TC-DD-08: checkAndBuild() handles 'no events today'
  // --------------------------------------------------------------------------
  await asyncTest('TC-DD-08: checkAndBuild() reports "No events today" when calendar is empty', async () => {
    const caldav = makeCaldav([]);
    const briefing = new DailyBriefing({ caldavClient: caldav });

    const result = await briefing.checkAndBuild();

    assert.ok(result.includes('No events today'),
      'result should contain "No events today" when calendar returns empty array');
  });

  // --------------------------------------------------------------------------
  // TC-DD-09: checkAndBuild() handles 'all clear' tasks
  // --------------------------------------------------------------------------
  await asyncTest('TC-DD-09: checkAndBuild() reports "all clear" when all task stacks are empty', async () => {
    const deck = makeDeck({ inbox: [], working: [], review: [] });
    const briefing = new DailyBriefing({ deckClient: deck });

    const result = await briefing.checkAndBuild();

    assert.ok(result.includes('all clear'),
      'result should contain "all clear" when all task stacks are empty');
  });

  // --------------------------------------------------------------------------
  // TC-DD-10: checkAndBuild() works with null/missing deps
  // --------------------------------------------------------------------------
  await asyncTest('TC-DD-10: checkAndBuild() works with no constructor args', async () => {
    const briefing = new DailyBriefing();

    let caughtError = null;
    let result;
    try {
      result = await briefing.checkAndBuild();
    } catch (err) {
      caughtError = err;
    }

    assert.strictEqual(caughtError, null, 'checkAndBuild() should not throw with no deps');
    // All sources are null so parts is empty, returns ''
    assert.strictEqual(result, '', 'checkAndBuild() should return empty string when all deps are null');
  });

  // --------------------------------------------------------------------------
  // TC-DD-11: pulse() calls dailyBriefing.checkAndBuild() when all conditions met
  // --------------------------------------------------------------------------
  await asyncTest('TC-DD-11: pulse() calls dailyBriefing.checkAndBuild() when all conditions met', async () => {
    let buildCalled = false;
    let enqueueCalled = false;

    const mockDailyBriefing = {
      lastBriefingDate: null,
      checkAndBuild: async () => {
        buildCalled = true;
        return '<daily_briefing>- Test\n</daily_briefing>';
      }
    };

    const mockTalkSendQueue = {
      enqueue: async (token, msg) => {
        enqueueCalled = true;
      }
    };

    const config = createMockConfig({
      dailyBriefing: mockDailyBriefing,
      talkSendQueue: mockTalkSendQueue,
      primaryRoomToken: 'room123'
    });

    const hb = new HeartbeatManager(config);
    stubPulseInternals(hb);

    // Set _cockpitDailyDigest to the current hour so the time gate passes
    const h = new Date().getHours();
    hb._cockpitDailyDigest = String(h).padStart(2, '0') + ':00';

    await hb.pulse();

    assert.strictEqual(buildCalled, true,
      'dailyBriefing.checkAndBuild() should be called when all conditions are met');
    assert.strictEqual(enqueueCalled, true,
      'talkSendQueue.enqueue() should be called when briefing returns content');
  });

  // --------------------------------------------------------------------------
  // TC-DD-12: pulse() skips digest when _cockpitDailyDigest is null
  // --------------------------------------------------------------------------
  await asyncTest('TC-DD-12: pulse() skips digest when _cockpitDailyDigest is null', async () => {
    let buildCalled = false;

    const mockDailyBriefing = {
      lastBriefingDate: null,
      checkAndBuild: async () => {
        buildCalled = true;
        return '<daily_briefing>- Test\n</daily_briefing>';
      }
    };

    const mockTalkSendQueue = {
      enqueue: async () => {}
    };

    const config = createMockConfig({
      dailyBriefing: mockDailyBriefing,
      talkSendQueue: mockTalkSendQueue,
      primaryRoomToken: 'room123'
    });

    const hb = new HeartbeatManager(config);
    stubPulseInternals(hb);

    // Do NOT set _cockpitDailyDigest — it stays null from constructor
    await hb.pulse();

    assert.strictEqual(buildCalled, false,
      'dailyBriefing.checkAndBuild() should NOT be called when _cockpitDailyDigest is null');
  });

  // --------------------------------------------------------------------------
  // TC-DD-13: pulse() catches dailyBriefing errors without killing other components
  // --------------------------------------------------------------------------
  await asyncTest('TC-DD-13: pulse() catches dailyBriefing errors without killing other components', async () => {
    const throwingDailyBriefing = {
      lastBriefingDate: null,
      checkAndBuild: async () => { throw new Error('briefing boom'); }
    };

    const mockTalkSendQueue = {
      enqueue: async () => {}
    };

    let freshnessCheckerCalled = false;
    const mockFreshnessChecker = {
      maybeCheck: async () => {
        freshnessCheckerCalled = true;
        return { checked: 1, flagged: 0 };
      },
      lastCheckDate: null
    };

    const config = createMockConfig({
      initiativeLevel: 2,
      dailyBriefing: throwingDailyBriefing,
      talkSendQueue: mockTalkSendQueue,
      primaryRoomToken: 'room123',
      hbFreshnessChecker: mockFreshnessChecker
    });

    const hb = new HeartbeatManager(config);
    stubPulseInternals(hb);

    // Set _cockpitDailyDigest to the current hour so the digest gate is entered
    const h = new Date().getHours();
    hb._cockpitDailyDigest = String(h).padStart(2, '0') + ':00';

    let caughtError = null;
    try {
      await hb.pulse();
    } catch (err) {
      caughtError = err;
    }

    assert.strictEqual(caughtError, null,
      'pulse() should not propagate dailyBriefing errors');
    assert.strictEqual(freshnessCheckerCalled, true,
      'hbFreshnessChecker.maybeCheck() should still be called after dailyBriefing throws');
  });

  // ============================================================================
  // Summary
  // ============================================================================

  summary();
  exitWithCode();
})();
