/*
 * Moltagent - Sovereign AI Security Layer
 * Copyright (C) 2026 Moltagent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * meeting_check_rsvp Handler Tests
 *
 * The handler was dead code until #226/#227 made the meeting family
 * registrable, and its first live dispatch crashed: it called
 * rsvpTracker.getStatus() bare and expected an array, but the real API is
 * getPendingSummary() -> Array and getStatus(uid) -> single-event object.
 * These tests exercise the handler through ToolRegistry.execute() against
 * a stub that mirrors the REAL RsvpTracker return shapes, so any future
 * drift between handler and tracker API fails here instead of in Talk.
 *
 * Run: node test/unit/agent/meeting-check-rsvp-handler.test.js
 */

'use strict';

const assert = require('assert');
const { asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const { ToolRegistry } = require('../../../src/lib/agent/tool-registry');

console.log('\n=== meeting_check_rsvp Handler Tests ===\n');

/** Truthy mock client: any property access yields a callable no-op. */
function mockClient() {
  return new Proxy({}, { get: () => () => {} });
}

const quietLogger = { info: () => {}, warn: () => {}, error: () => {}, log: () => {} };

/** Stub mirroring RsvpTracker's actual public API shapes. */
function stubTracker(events) {
  return {
    getPendingSummary: () => events.map(e => ({
      uid: e.uid,
      summary: e.summary,
      pending: 0, accepted: 0, declined: 0, tentative: 0,
    })),
    getStatus: (uid) => {
      const e = events.find(ev => ev.uid === uid);
      if (!e) return { found: false };
      return {
        found: true,
        summary: e.summary,
        attendees: e.attendees,
        allResponded: e.attendees.every(a => a.lastStatus !== 'NEEDS-ACTION'),
      };
    },
  };
}

function buildRegistry(rsvpTracker) {
  return new ToolRegistry({
    meetingComposer: mockClient(),
    rsvpTracker,
    logger: quietLogger,
  });
}

const TEAM_SYNC = {
  uid: 'uid-team-sync',
  summary: 'Team Sync Q3',
  attendees: [
    { name: 'Alice', email: 'alice@example.org', lastStatus: 'ACCEPTED' },
    { name: 'Bob', email: 'bob@example.org', lastStatus: 'NEEDS-ACTION' },
  ],
};

asyncTest('TC-RSVP-001: no tracked meetings → informative empty answer', async () => {
  const registry = buildRegistry(stubTracker([]));
  const out = await registry.execute('meeting_check_rsvp', { meeting_title: 'Team Sync' });
  assert.strictEqual(out.success, true);
  assert.ok(/No meetings are currently being tracked/.test(out.result), out.result);
});

asyncTest('TC-RSVP-002: case-insensitive title substring resolves to attendee detail', async () => {
  const registry = buildRegistry(stubTracker([TEAM_SYNC]));
  const out = await registry.execute('meeting_check_rsvp', { meeting_title: 'team sync' });
  assert.strictEqual(out.success, true);
  assert.ok(out.result.includes('Team Sync Q3'), out.result);
  assert.ok(out.result.includes('Alice') && out.result.includes('ACCEPTED'), out.result);
  assert.ok(out.result.includes('Bob') && out.result.includes('NEEDS-ACTION'), out.result);
});

asyncTest('TC-RSVP-003: unmatched title → not-found answer, no throw', async () => {
  const registry = buildRegistry(stubTracker([TEAM_SYNC]));
  const out = await registry.execute('meeting_check_rsvp', { meeting_title: 'Budget Review' });
  assert.strictEqual(out.success, true);
  assert.ok(/No tracked meeting found matching "Budget Review"/.test(out.result), out.result);
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
