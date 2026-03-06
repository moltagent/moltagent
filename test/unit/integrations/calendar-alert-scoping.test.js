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
 * Calendar Alert Scoping Tests
 *
 * Tests for owner-event filtering: isOwnerEvent, filterOwnerEvents,
 * resolveOwnerIdentities, and integration with HeartbeatManager,
 * DailyBriefing, and MeetingPreparer.
 *
 * TC-CS-01 through TC-CS-11
 *
 * Run: node test/unit/integrations/calendar-alert-scoping.test.js
 */

'use strict';
// Mock type: LEGACY — TODO: migrate to realistic mocks

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

// ============================================================================
// Load modules under test
// ============================================================================

let resolveOwnerIdentities, isOwnerEvent, filterOwnerEvents;
try {
  ({ resolveOwnerIdentities, isOwnerEvent, filterOwnerEvents } =
    require('../../../src/lib/integrations/calendar-scoping'));
} catch (err) {
  console.error('Failed to load calendar-scoping:', err.message);
  process.exit(1);
}

let HeartbeatManager;
try {
  HeartbeatManager = require('../../../src/lib/integrations/heartbeat-manager');
} catch (err) {
  console.error('Failed to load heartbeat-manager:', err.message);
  process.exit(1);
}

let DailyBriefing;
try {
  ({ DailyBriefing } = require('../../../src/lib/agent/daily-briefing'));
} catch (err) {
  console.error('Failed to load daily-briefing:', err.message);
  process.exit(1);
}

let MeetingPreparer;
try {
  ({ MeetingPreparer } = require('../../../src/lib/integrations/heartbeat-intelligence'));
} catch (err) {
  console.error('Failed to load heartbeat-intelligence:', err.message);
  process.exit(1);
}

// ============================================================================
// Helpers
// ============================================================================

const OWNER_IDS = { username: 'alice', emails: ['alice@example.com'] };

function makeEvent(overrides = {}) {
  return {
    uid: overrides.uid || 'ev-1',
    summary: overrides.summary || 'Test Event',
    start: overrides.start || new Date(Date.now() + 10 * 60000).toISOString(),
    end: overrides.end || new Date(Date.now() + 70 * 60000).toISOString(),
    status: overrides.status || 'CONFIRMED',
    calendarId: overrides.calendarId || 'personal',
    attendees: overrides.attendees || [],
    organizer: overrides.organizer || undefined,
    location: overrides.location || null,
    ...overrides
  };
}

function makeCaldav(events) {
  return { getUpcomingEvents: async () => events };
}

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
      initiativeLevel: 1,
      timezone: 'UTC'
    },
    llmRouter: { route: async () => ({ result: 'ok', tokens: 10 }) },
    notifyUser: async () => {},
    auditLog: async () => {},
    credentialBroker: {
      prefetchAll: async () => {},
      get: async () => null,
      getNCPassword: () => 'test'
    },
    ownerIds: overrides.ownerIds || null,
    ...overrides
  };
}

function stubPulseInternals(hb) {
  hb._processDeck = async () => ({ processed: 0 });
  hb._processReviewFeedback = async () => ({ processed: 0 });
  hb._processAssignedCards = async () => ({ processed: 0 });
  hb._checkKnowledgeBoard = async () => ({ pending: 0 });
  hb._processFlowEvents = () => ({ processed: 0 });
  hb._isQuietHours = () => false;
}

// ============================================================================
// Tests
// ============================================================================

console.log('\n=== Calendar Alert Scoping Tests ===\n');

(async () => {

  // --------------------------------------------------------------------------
  // TC-CS-01: isOwnerEvent returns true when owner is ATTENDEE
  // --------------------------------------------------------------------------
  test('TC-CS-01: isOwnerEvent returns true when owner is ATTENDEE', () => {
    const event = makeEvent({
      attendees: [
        { email: 'alice@example.com', name: 'Alice', status: 'ACCEPTED' },
        { email: 'bob@example.com', name: 'Bob', status: 'NEEDS-ACTION' }
      ],
      organizer: { email: 'bob@example.com', name: 'Bob' }
    });

    assert.strictEqual(isOwnerEvent(event, OWNER_IDS), true,
      'Should return true when owner email is in attendees');
  });

  // --------------------------------------------------------------------------
  // TC-CS-02: isOwnerEvent returns true when owner is ORGANIZER
  // --------------------------------------------------------------------------
  test('TC-CS-02: isOwnerEvent returns true when owner is ORGANIZER', () => {
    const event = makeEvent({
      attendees: [
        { email: 'bob@example.com', name: 'Bob', status: 'NEEDS-ACTION' }
      ],
      organizer: { email: 'alice@example.com', name: 'Alice' }
    });

    assert.strictEqual(isOwnerEvent(event, OWNER_IDS), true,
      'Should return true when owner email matches organizer');
  });

  // --------------------------------------------------------------------------
  // TC-CS-03: isOwnerEvent returns true for personal event (no attendees)
  // --------------------------------------------------------------------------
  test('TC-CS-03: isOwnerEvent returns true for personal event (no attendees, no organizer)', () => {
    const event = makeEvent({
      attendees: [],
      organizer: undefined
    });

    assert.strictEqual(isOwnerEvent(event, OWNER_IDS), true,
      'Should return true for event with no attendees and no organizer');
  });

  // --------------------------------------------------------------------------
  // TC-CS-04: isOwnerEvent returns false for shared calendar event where owner isn't attending
  // --------------------------------------------------------------------------
  test('TC-CS-04: isOwnerEvent returns false for shared calendar event (owner not attending)', () => {
    const event = makeEvent({
      calendarId: 'shared-team-calendar',
      attendees: [
        { email: 'bob@example.com', name: 'Bob', status: 'ACCEPTED' },
        { email: 'carol@example.com', name: 'Carol', status: 'ACCEPTED' }
      ],
      organizer: { email: 'bob@example.com', name: 'Bob' }
    });

    assert.strictEqual(isOwnerEvent(event, OWNER_IDS), false,
      'Should return false when owner is not in attendees or organizer');
  });

  // --------------------------------------------------------------------------
  // TC-CS-05: isOwnerEvent returns false for Moltagent calendar event where owner isn't invited
  // --------------------------------------------------------------------------
  test('TC-CS-05: isOwnerEvent returns false for Moltagent event (owner not invited)', () => {
    const event = makeEvent({
      calendarId: 'personal',
      attendees: [
        { email: 'moltagent@example.com', name: 'Moltagent', status: 'ACCEPTED' },
        { email: 'bob@example.com', name: 'Bob', status: 'NEEDS-ACTION' }
      ],
      organizer: { email: 'moltagent@example.com', name: 'Moltagent' }
    });

    assert.strictEqual(isOwnerEvent(event, OWNER_IDS), false,
      'Should return false when Molti created event but owner is not an attendee');
  });

  // --------------------------------------------------------------------------
  // TC-CS-06: filterOwnerEvents filters a mixed list correctly
  // --------------------------------------------------------------------------
  test('TC-CS-06: filterOwnerEvents filters a mixed list correctly', () => {
    const events = [
      makeEvent({ uid: 'personal', summary: 'Lunch', attendees: [] }),
      makeEvent({
        uid: 'attending',
        summary: 'Standup',
        attendees: [
          { email: 'alice@example.com', name: 'Alice' },
          { email: 'bob@example.com', name: 'Bob' }
        ],
        organizer: { email: 'bob@example.com', name: 'Bob' }
      }),
      makeEvent({
        uid: 'not-mine',
        summary: 'Other Team Sync',
        attendees: [
          { email: 'bob@example.com', name: 'Bob' },
          { email: 'carol@example.com', name: 'Carol' }
        ],
        organizer: { email: 'bob@example.com', name: 'Bob' }
      })
    ];

    const filtered = filterOwnerEvents(events, OWNER_IDS);

    assert.strictEqual(filtered.length, 2,
      'Should keep 2 of 3 events (personal + attending)');
    assert.ok(filtered.some(e => e.uid === 'personal'), 'personal event should pass');
    assert.ok(filtered.some(e => e.uid === 'attending'), 'attending event should pass');
    assert.ok(!filtered.some(e => e.uid === 'not-mine'), 'non-attending event should be removed');
  });

  // --------------------------------------------------------------------------
  // TC-CS-07: resolveOwnerIdentities resolves username + email
  // --------------------------------------------------------------------------
  await asyncTest('TC-CS-07: resolveOwnerIdentities resolves username + email', async () => {
    const mockNCRM = {
      getUserEmail: async (userId) => {
        if (userId === 'alice') return 'alice@example.com';
        return null;
      }
    };

    const ids = await resolveOwnerIdentities('alice', mockNCRM);

    assert.strictEqual(ids.username, 'alice');
    assert.deepStrictEqual(ids.emails, ['alice@example.com']);
  });

  // --------------------------------------------------------------------------
  // TC-CS-08: HeartbeatManager._checkCalendar applies owner filter
  // --------------------------------------------------------------------------
  await asyncTest('TC-CS-08: _checkCalendar applies owner filter', async () => {
    const ownerEvent = makeEvent({
      uid: 'mine',
      summary: 'My meeting',
      attendees: [{ email: 'alice@example.com', name: 'Alice' }],
      organizer: { email: 'bob@example.com', name: 'Bob' }
    });
    const otherEvent = makeEvent({
      uid: 'theirs',
      summary: 'Their meeting',
      attendees: [{ email: 'bob@example.com', name: 'Bob' }],
      organizer: { email: 'carol@example.com', name: 'Carol' }
    });

    const hb = new HeartbeatManager(createMockConfig({
      ownerIds: OWNER_IDS
    }));
    stubPulseInternals(hb);

    // Override the caldav client with our mock
    hb.caldavClient = { getUpcomingEvents: async () => [ownerEvent, otherEvent] };

    // Re-enable _checkCalendar (stubPulseInternals overrides it)
    hb._checkCalendar = HeartbeatManager.prototype._checkCalendar.bind(hb);

    const result = await hb._checkCalendar();

    assert.strictEqual(result.upcoming.length, 1,
      'Should return only 1 event after owner filtering');
    assert.strictEqual(result.upcoming[0].uid, 'mine',
      'Should keep the owner\'s event');
  });

  // --------------------------------------------------------------------------
  // TC-CS-09: DailyBriefing applies owner filter
  // --------------------------------------------------------------------------
  await asyncTest('TC-CS-09: DailyBriefing applies owner filter', async () => {
    const ownerEvent = makeEvent({
      summary: 'My standup',
      attendees: [{ email: 'alice@example.com', name: 'Alice' }],
      organizer: { email: 'alice@example.com', name: 'Alice' }
    });
    const otherEvent = makeEvent({
      summary: 'Not my meeting',
      attendees: [{ email: 'bob@example.com', name: 'Bob' }],
      organizer: { email: 'bob@example.com', name: 'Bob' }
    });

    const briefing = new DailyBriefing({
      caldavClient: makeCaldav([ownerEvent, otherEvent]),
      ownerIds: OWNER_IDS
    });

    const result = await briefing.checkAndBuild();

    assert.ok(result.includes('My standup'),
      'Briefing should include owner event "My standup"');
    assert.ok(!result.includes('Not my meeting'),
      'Briefing should exclude non-owner event "Not my meeting"');
  });

  // --------------------------------------------------------------------------
  // TC-CS-10: MeetingPreparer applies owner filter
  // --------------------------------------------------------------------------
  await asyncTest('TC-CS-10: MeetingPreparer applies owner filter', async () => {
    const ownerEvent = makeEvent({
      uid: 'mine',
      summary: 'My strategy session',
      attendees: [
        { email: 'alice@example.com', name: 'Alice' },
        { email: 'bob@example.com', name: 'Bob' }
      ],
      organizer: { email: 'alice@example.com', name: 'Alice' }
    });
    const otherEvent = makeEvent({
      uid: 'theirs',
      summary: 'Their planning',
      attendees: [
        { email: 'bob@example.com', name: 'Bob' },
        { email: 'carol@example.com', name: 'Carol' }
      ],
      organizer: { email: 'bob@example.com', name: 'Bob' }
    });

    const prepped = [];
    const mp = new MeetingPreparer({
      caldavClient: makeCaldav([ownerEvent, otherEvent]),
      collectivesClient: null,
      contactsClient: null,
      deckClient: null,
      router: { route: async () => ({ result: 'Prep notes for meeting', tokens: 50 }) },
      notifyUser: async (msg) => { prepped.push(msg); },
      config: {},
      ownerIds: OWNER_IDS
    });

    const result = await mp.checkAndPrep();

    assert.strictEqual(result.checked, 1,
      'Should only count owner-relevant events as checked');
    assert.ok(result.prepped <= 1,
      'Should only prep owner-relevant events');
  });

  // --------------------------------------------------------------------------
  // TC-CS-11: Missing ADMIN_USER gracefully falls back to no filtering
  // --------------------------------------------------------------------------
  await asyncTest('TC-CS-11: Missing ADMIN_USER falls back to no filtering', async () => {
    // resolveOwnerIdentities with empty adminUser
    const ids = await resolveOwnerIdentities('', null);
    assert.strictEqual(ids.username, '');
    assert.deepStrictEqual(ids.emails, []);

    // isOwnerEvent with empty ownerIds passes everything through
    const event = makeEvent({
      attendees: [{ email: 'bob@example.com', name: 'Bob' }],
      organizer: { email: 'bob@example.com', name: 'Bob' }
    });
    assert.strictEqual(isOwnerEvent(event, ids), true,
      'Should pass through when no owner identity is configured');

    // filterOwnerEvents with null passes everything
    const events = [event, makeEvent({ uid: 'ev2' })];
    const filtered = filterOwnerEvents(events, null);
    assert.strictEqual(filtered.length, 2,
      'Should pass all events when ownerIds is null');
  });

  // --------------------------------------------------------------------------
  // Summary & exit
  // --------------------------------------------------------------------------
  setTimeout(() => { summary(); exitWithCode(); }, 500);

})();
