/*
 * MoltAgent - Sovereign AI Security Layer
 * Copyright (C) 2026 MoltAgent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * Calendar Delete Handler Tests
 *
 * Validates the deleteEvent() handler: event resolution,
 * guardrail checks (always required), and error handling.
 *
 * Run: node test/unit/agent/executors/calendar-delete-handler.test.js
 */

'use strict';

const assert = require('assert');
const { asyncTest, summary, exitWithCode } = require('../../../helpers/test-runner');
const CalendarExecutor = require('../../../../src/lib/agent/executors/calendar-executor');

console.log('\n=== Calendar Delete Handler Tests ===\n');

const silentLogger = { log() {}, info() {}, warn() {}, error() {} };
const context = { userName: 'testuser', roomToken: 'room1' };

function makeExecutor(extractionResult, calendarClientOverrides = {}, guardrailOverrides = null) {
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
  const config = { router, calendarClient, logger: silentLogger };
  if (guardrailOverrides) {
    config.guardrailEnforcer = guardrailOverrides;
  }
  return new CalendarExecutor(config);
}

asyncTest('no event identification → asks which event', async () => {
  const executor = makeExecutor({
    action: 'delete', event_title: '', summary: ''
  });
  const result = await executor.execute('Delete an event', context);
  assert.ok(result.includes('Which event'), `Expected clarification, got: ${result}`);
});

asyncTest('finds event by title → confirms deletion', async () => {
  let deletedUid = null;
  const executor = makeExecutor({
    action: 'delete', event_title: 'standup'
  }, {
    getEvents: async () => [
      { uid: 'ev-del-1', summary: 'Daily Standup', start: new Date().toISOString() }
    ],
    deleteEvent: async (calId, uid) => { deletedUid = uid; }
  });
  const result = await executor.execute('Delete the standup', context);
  assert.ok(result.includes('Deleted'), `Expected deletion confirmation, got: ${result}`);
  assert.ok(result.includes('Daily Standup'), `Expected event name, got: ${result}`);
  assert.strictEqual(deletedUid, 'ev-del-1');
});

asyncTest('lastCreatedEvent reference works for delete', async () => {
  let deletedUid = null;
  const executor = makeExecutor({
    action: 'delete', event_reference: 'last_created'
  }, {
    deleteEvent: async (calId, uid) => { deletedUid = uid; }
  });
  executor._lastCreatedEvent = {
    uid: 'last-uid', calendarId: 'personal',
    summary: 'Quick Sync', start: new Date()
  };
  const result = await executor.execute('Delete the event you just made', context);
  assert.ok(result.includes('Deleted'), `Expected deletion, got: ${result}`);
  assert.strictEqual(deletedUid, 'last-uid');
  // lastCreatedEvent should be cleared
  assert.strictEqual(executor._lastCreatedEvent, null, 'lastCreatedEvent should be cleared');
});

asyncTest('guardrail denied → event preserved', async () => {
  let deleteWasCalled = false;
  const executor = makeExecutor({
    action: 'delete', event_title: 'standup'
  }, {
    getEvents: async () => [
      { uid: 'ev-prot', summary: 'Standup', start: new Date().toISOString() }
    ],
    deleteEvent: async () => { deleteWasCalled = true; }
  }, {
    check: async () => ({ allowed: false, reason: 'Deletion requires manager approval' }),
    checkApproval: async () => ({ allowed: false, reason: 'Denied' })
  });
  const result = await executor.execute('Delete the standup', context);
  assert.ok(result.includes('blocked'), `Expected blocked message, got: ${result}`);
  assert.ok(!deleteWasCalled, 'deleteEvent should not have been called');
});

asyncTest('calendarClient error → friendly error', async () => {
  const executor = makeExecutor({
    action: 'delete', event_title: 'standup'
  }, {
    getEvents: async () => [
      { uid: 'ev-err', summary: 'Standup', start: new Date().toISOString() }
    ],
    deleteEvent: async () => { throw new Error('CalDAV server error'); }
  });
  const result = await executor.execute('Delete the standup', context);
  assert.ok(result.includes("couldn't delete"), `Expected friendly error, got: ${result}`);
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
