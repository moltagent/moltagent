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
 * Calendar Update Handler Tests
 *
 * Validates classification of update intents and the updateEvent() handler:
 * event resolution, attendee ops, guardrail checks, error handling.
 *
 * Run: node test/unit/agent/executors/calendar-update-handler.test.js
 */

'use strict';

const assert = require('assert');
const { asyncTest, summary, exitWithCode } = require('../../../helpers/test-runner');
const CalendarExecutor = require('../../../../src/lib/agent/executors/calendar-executor');

console.log('\n=== Calendar Update Handler Tests ===\n');

// Layer 3: executors may return {response, actionRecord} objects
function getResponse(result) {
  return typeof result === 'object' && result !== null && result.response ? result.response : result;
}

const silentLogger = { log() {}, info() {}, warn() {}, error() {} };
const context = { userName: 'testuser', roomToken: 'room1' };

/**
 * Create a CalendarExecutor that returns a specific extraction result.
 */
function makeExecutor(extractionResult, calendarClientOverrides = {}) {
  const router = {
    route: async () => ({ result: JSON.stringify(extractionResult) })
  };
  const calendarClient = {
    createEvent: async () => ({ uid: 'test-uid-123' }),
    getEventCalendars: async () => [{ id: 'personal' }],
    getEvents: async () => [],
    getTodayEvents: async () => [],
    getUpcomingEvents: async () => [],
    updateEvent: async () => ({}),
    deleteEvent: async () => ({}),
    ...calendarClientOverrides
  };
  return new CalendarExecutor({ router, calendarClient, logger: silentLogger });
}

// ---- Classification tests ----

asyncTest('"Assign me to the standup" classifies as update', async () => {
  const executor = makeExecutor({
    action: 'update', update_type: 'add_attendee',
    event_title: 'standup', attendee: 'self'
  }, {
    getEvents: async () => [{ uid: 'ev1', summary: 'Standup', start: new Date().toISOString(), attendees: [] }]
  });
  const result = await executor.execute('Assign me to the standup', context);
  assert.ok(getResponse(result).includes('Added'), `Expected add confirmation, got: ${getResponse(result)}`);
});

asyncTest('"Invite Bob to the planning meeting" classifies as update', async () => {
  const executor = makeExecutor({
    action: 'update', update_type: 'add_attendee',
    event_title: 'planning meeting', attendee: 'Bob'
  }, {
    getEvents: async () => [{ uid: 'ev2', summary: 'Planning Meeting', start: new Date().toISOString(), attendees: [] }]
  });
  const result = await executor.execute('Invite Bob to the planning meeting', context);
  assert.ok(getResponse(result).includes('Added Bob'), `Expected Bob added, got: ${getResponse(result)}`);
});

asyncTest('"Reschedule standup to 3pm" classifies as update', async () => {
  const executor = makeExecutor({
    action: 'update', update_type: 'change_time',
    event_title: 'standup', new_time: '15:00'
  }, {
    getEvents: async () => [{
      uid: 'ev3', summary: 'Standup',
      start: '2026-02-27T09:00:00', end: '2026-02-27T09:30:00'
    }]
  });
  const result = await executor.execute('Reschedule standup to 3pm', context);
  assert.ok(getResponse(result).includes('Rescheduled'), `Expected reschedule confirmation, got: ${getResponse(result)}`);
});

asyncTest('"Schedule a meeting tomorrow" still classifies as create', async () => {
  const executor = makeExecutor({
    action: 'create', summary: 'Team Meeting',
    date: 'tomorrow', time: '14:00'
  });
  const result = await executor.execute('Schedule a meeting tomorrow at 2pm', context);
  assert.ok(getResponse(result).includes('Created event'), `Should create event, got: ${getResponse(result)}`);
});

asyncTest('"What\'s on my calendar?" still classifies as list', async () => {
  const executor = makeExecutor({ action: 'list', query_type: 'today' });
  const result = await executor.execute("What's on my calendar?", context);
  const response = getResponse(result);
  assert.ok(response.includes('clear') || response.includes('Today'),
    `Should list events, got: ${response}`);
});

// ---- Handler tests ----

asyncTest('no event reference → asks which event', async () => {
  const executor = makeExecutor({
    action: 'update', update_type: 'add_attendee',
    event_title: '', event_reference: '', attendee: 'self'
  });
  const result = await executor.execute('Add me to the event', context);
  assert.ok(getResponse(result).includes('Which event'), `Expected clarification, got: ${getResponse(result)}`);
});

asyncTest('finds event by partial title match', async () => {
  let updateCalledWith = null;
  const executor = makeExecutor({
    action: 'update', update_type: 'add_attendee',
    event_title: 'standup', attendee: 'Bob'
  }, {
    getEvents: async () => [
      { uid: 'ev1', summary: 'Daily Standup', start: new Date().toISOString(), attendees: ['Alice'] }
    ],
    updateEvent: async (calId, uid, updates) => {
      updateCalledWith = { calId, uid, updates };
      return {};
    }
  });
  const result = await executor.execute('Add Bob to the standup', context);
  assert.ok(getResponse(result).includes('Added Bob'), `Expected add confirmation, got: ${getResponse(result)}`);
  assert.ok(updateCalledWith, 'updateEvent should have been called');
  assert.strictEqual(updateCalledWith.uid, 'ev1');
  assert.ok(updateCalledWith.updates.attendees.includes('Bob'));
  assert.ok(updateCalledWith.updates.attendees.includes('Alice'), 'Existing attendees preserved');
});

asyncTest('add_attendee with "self" resolves to userName', async () => {
  let updateCalledWith = null;
  const executor = makeExecutor({
    action: 'update', update_type: 'add_attendee',
    event_title: 'standup', attendee: 'self'
  }, {
    getEvents: async () => [
      { uid: 'ev1', summary: 'Standup', start: new Date().toISOString(), attendees: [] }
    ],
    updateEvent: async (calId, uid, updates) => {
      updateCalledWith = { calId, uid, updates };
      return {};
    }
  });
  const result = await executor.execute('Add me to the standup', context);
  assert.ok(getResponse(result).includes('Added testuser'), `Expected testuser, got: ${getResponse(result)}`);
  assert.ok(updateCalledWith.updates.attendees.includes('testuser'));
});

asyncTest('change_time without new_time → asks what time', async () => {
  const executor = makeExecutor({
    action: 'update', update_type: 'change_time',
    event_title: 'standup', new_time: '', date: ''
  });
  const result = await executor.execute('Reschedule the standup', context);
  assert.ok(getResponse(result).includes('time'), `Expected time prompt, got: ${getResponse(result)}`);
});

asyncTest('change_title without new_title → asks what name', async () => {
  const executor = makeExecutor({
    action: 'update', update_type: 'change_title',
    event_title: 'standup', new_title: ''
  });
  const result = await executor.execute('Rename the standup', context);
  assert.ok(getResponse(result).includes('rename'), `Expected rename prompt, got: ${getResponse(result)}`);
});

asyncTest('requires_clarification returns friendly message', async () => {
  const executor = makeExecutor({
    action: 'update', update_type: 'add_attendee',
    requires_clarification: true, missing_fields: ['event_title']
  });
  const result = await executor.execute('Update the event somehow', context);
  assert.ok(getResponse(result).includes('clarify'), `Expected clarification, got: ${getResponse(result)}`);
});

asyncTest('event not found → friendly error', async () => {
  const executor = makeExecutor({
    action: 'update', update_type: 'add_attendee',
    event_title: 'nonexistent', attendee: 'Bob'
  }, {
    getEvents: async () => []
  });
  const result = await executor.execute('Add Bob to the nonexistent meeting', context);
  assert.ok(getResponse(result).includes("couldn't find"), `Expected not-found message, got: ${getResponse(result)}`);
});

asyncTest('lastCreatedEvent reference works for update', async () => {
  let updateCalledWith = null;
  const executor = makeExecutor({
    action: 'update', update_type: 'add_attendee',
    event_reference: 'last_created', attendee: 'self'
  }, {
    updateEvent: async (calId, uid, updates) => {
      updateCalledWith = { calId, uid, updates };
      return {};
    }
  });
  // Simulate a prior create
  executor._lastCreatedEvent = {
    uid: 'last-uid', calendarId: 'personal',
    summary: 'Team Sync', start: new Date(), attendees: []
  };
  const result = await executor.execute('Add me to the event you just created', context);
  assert.ok(getResponse(result).includes('Added testuser'), `Expected add confirmation, got: ${getResponse(result)}`);
  assert.strictEqual(updateCalledWith.uid, 'last-uid');
});

asyncTest('last_created with no tracked event → helpful message', async () => {
  const executor = makeExecutor({
    action: 'update', update_type: 'add_attendee',
    event_reference: 'last_created', attendee: 'self'
  }, {
    getEvents: async () => []
  });
  // Do NOT set _lastCreatedEvent — simulates cloud-created event
  const result = await executor.execute('Add me to the event you just created', context);
  assert.ok(getResponse(result).includes("don't remember"), `Expected helpful message, got: ${getResponse(result)}`);
  assert.ok(!getResponse(result).includes('last_created'), 'Should NOT show literal "last_created" to user');
});

asyncTest('calendarClient error in update → friendly error', async () => {
  const executor = makeExecutor({
    action: 'update', update_type: 'add_attendee',
    event_title: 'standup', attendee: 'Bob'
  }, {
    getEvents: async () => [
      { uid: 'ev1', summary: 'Standup', start: new Date().toISOString(), attendees: [] }
    ],
    updateEvent: async () => { throw new Error('CalDAV timeout'); }
  });
  const result = await executor.execute('Add Bob to the standup', context);
  assert.ok(getResponse(result).includes("couldn't update"), `Expected error message, got: ${getResponse(result)}`);
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
