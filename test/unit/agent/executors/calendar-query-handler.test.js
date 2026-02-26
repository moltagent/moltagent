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
 * Calendar Query Handler Tests
 *
 * Validates CalendarExecutor.queryEvents() reads the calendar,
 * formats results, and handles errors gracefully.
 *
 * Run: node test/unit/agent/executors/calendar-query-handler.test.js
 */

'use strict';

const assert = require('assert');
const { asyncTest, summary, exitWithCode } = require('../../../helpers/test-runner');
const CalendarExecutor = require('../../../../src/lib/agent/executors/calendar-executor');

console.log('\n=== Calendar Query Handler Tests ===\n');

const silentLogger = { log() {}, info() {}, warn() {}, error() {} };

const context = { userName: 'testuser', roomToken: 'room1' };

function makeQueryExecutor(calendarClientOverrides = {}) {
  const router = {
    route: async () => ({ result: '{}' }) // Not used for queryEvents
  };
  const calendarClient = {
    getEventCalendars: async () => [{ id: 'personal' }],
    getEvents: async () => [],
    getTodayEvents: async () => [],
    getUpcomingEvents: async () => [],
    ...calendarClientOverrides
  };
  return new CalendarExecutor({ router, calendarClient, logger: silentLogger });
}

// -- Test 1: queryEvents with today calls getTodayEvents --
asyncTest('queryEvents with query_type=today calls getTodayEvents', async () => {
  let todayCalled = false;
  const executor = makeQueryExecutor({
    getTodayEvents: async () => { todayCalled = true; return []; }
  });

  await executor.queryEvents({ query_type: 'today' }, context);
  assert.ok(todayCalled, 'Should call getTodayEvents for today queries');
});

// -- Test 2: queryEvents with no events returns "calendar is clear" --
asyncTest('queryEvents returns "calendar is clear" when no events', async () => {
  const executor = makeQueryExecutor({
    getTodayEvents: async () => []
  });

  const result = await executor.queryEvents({ query_type: 'today' }, context);
  assert.ok(result.includes('clear'), `Should say calendar is clear, got: ${result}`);
});

// -- Test 3: queryEvents with events returns formatted list --
asyncTest('queryEvents formats event list correctly', async () => {
  const mockEvents = [
    { summary: 'Team Standup', start: '2026-02-27T09:00:00Z', duration: 30 },
    { summary: 'Lunch with Bob', start: '2026-02-27T12:00:00Z' }
  ];
  const executor = makeQueryExecutor({
    getTodayEvents: async () => mockEvents
  });

  const result = await executor.queryEvents({ query_type: 'today' }, context);
  assert.ok(result.includes('Today:'), `Should have Today label, got: ${result}`);
  assert.ok(result.includes('Team Standup'), `Should include event title, got: ${result}`);
  assert.ok(result.includes('Lunch with Bob'), `Should include second event, got: ${result}`);
  assert.ok(result.includes('30 min'), `Should include duration, got: ${result}`);
});

// -- Test 4: queryEvents with query_type=tomorrow uses tomorrow date range --
asyncTest('queryEvents with query_type=tomorrow returns tomorrow message', async () => {
  const executor = makeQueryExecutor({
    getEventCalendars: async () => [{ id: 'personal' }],
    getEvents: async () => []
  });

  const result = await executor.queryEvents({ query_type: 'tomorrow' }, context);
  assert.ok(result.includes('Nothing') || result.includes('tomorrow'),
    `Should reference tomorrow, got: ${result}`);
});

// -- Test 5: _resolveQueryRange returns correct dates for each query_type --
asyncTest('_resolveQueryRange returns correct start/end for each type', async () => {
  const executor = makeQueryExecutor();

  const todayRange = executor._resolveQueryRange({ query_type: 'today' });
  assert.ok(todayRange.start instanceof Date, 'start should be a Date');
  assert.ok(todayRange.end instanceof Date, 'end should be a Date');
  assert.ok(todayRange.end > todayRange.start, 'end should be after start');
  assert.strictEqual(todayRange.start.getHours(), 0, 'today start should be midnight');

  const tomorrowRange = executor._resolveQueryRange({ query_type: 'tomorrow' });
  const expectedTomorrow = new Date();
  expectedTomorrow.setDate(expectedTomorrow.getDate() + 1);
  assert.strictEqual(tomorrowRange.start.getDate(), expectedTomorrow.getDate(),
    'tomorrow start should be tomorrow');

  const weekRange = executor._resolveQueryRange({ query_type: 'this_week' });
  assert.ok(weekRange.end > weekRange.start, 'week end should be after start');

  const specificRange = executor._resolveQueryRange({ query_type: 'specific_date', date: 'tomorrow' });
  assert.ok(specificRange.start instanceof Date, 'specific date start should be a Date');
});

// -- Test 6: calendarClient error returns friendly message (doesn't throw) --
asyncTest('calendarClient error returns friendly error message', async () => {
  const executor = makeQueryExecutor({
    getTodayEvents: async () => { throw new Error('CalDAV connection refused'); }
  });

  const result = await executor.queryEvents({ query_type: 'today' }, context);
  assert.ok(typeof result === 'string', 'Should return a string');
  assert.ok(result.includes("couldn't read"), `Should be friendly error, got: ${result}`);
});

// -- Test 7: queryEvents with upcoming calls getUpcomingEvents --
asyncTest('queryEvents with query_type=upcoming calls getUpcomingEvents', async () => {
  let upcomingCalled = false;
  const executor = makeQueryExecutor({
    getUpcomingEvents: async (hours) => {
      upcomingCalled = true;
      assert.strictEqual(hours, 168, 'Should request 7 days (168 hours)');
      return [];
    }
  });

  const result = await executor.queryEvents({ query_type: 'upcoming' }, context);
  assert.ok(upcomingCalled, 'Should call getUpcomingEvents for upcoming queries');
  assert.ok(result.includes('No upcoming'), `Should report no upcoming, got: ${result}`);
});

// -- Test 8: _formatEventList handles events without duration --
asyncTest('_formatEventList handles events without duration field', async () => {
  const executor = makeQueryExecutor();
  const events = [
    { summary: 'No Duration Event', start: '2026-02-27T14:00:00Z' }
  ];
  const result = executor._formatEventList(events, 'today');
  assert.ok(result.includes('No Duration Event'), `Should include title, got: ${result}`);
  assert.ok(!result.includes('min'), `Should not show duration, got: ${result}`);
});

// -- Test 9: _formatNoEvents returns distinct messages per query type --
asyncTest('_formatNoEvents returns appropriate messages', async () => {
  const executor = makeQueryExecutor();
  assert.ok(executor._formatNoEvents('today').includes('clear'));
  assert.ok(executor._formatNoEvents('tomorrow').includes('Nothing'));
  assert.ok(executor._formatNoEvents('this_week').includes('week'));
  assert.ok(executor._formatNoEvents('upcoming').includes('upcoming'));
  assert.ok(executor._formatNoEvents('free_slots').includes('free'));
  assert.ok(executor._formatNoEvents('unknown').includes('No events'));
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
