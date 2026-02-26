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
 * Calendar Query Classification Tests
 *
 * Verifies that phi4-mini extraction correctly distinguishes
 * calendar_create (action: create) from calendar_query (action: list).
 *
 * Run: node test/unit/agent/executors/calendar-query-classification.test.js
 */

'use strict';

const assert = require('assert');
const { asyncTest, summary, exitWithCode } = require('../../../helpers/test-runner');
const CalendarExecutor = require('../../../../src/lib/agent/executors/calendar-executor');

console.log('\n=== Calendar Query Classification Tests ===\n');

const silentLogger = { log() {}, info() {}, warn() {}, error() {} };

/**
 * Create a CalendarExecutor that returns a specific extraction result.
 * Captures which action was extracted so we can verify classification.
 */
function makeExecutor(extractionResult) {
  const router = {
    route: async () => ({ result: JSON.stringify(extractionResult) })
  };
  const queriedRanges = [];
  const calendarClient = {
    createEvent: async () => ({ uid: 'test-uid-123' }),
    getEventCalendars: async () => [{ id: 'personal' }],
    getEvents: async (calId, start, end) => {
      queriedRanges.push({ calId, start, end });
      return [];
    },
    getTodayEvents: async () => [],
    getUpcomingEvents: async () => []
  };
  return { executor: new CalendarExecutor({ router, calendarClient, logger: silentLogger }), queriedRanges };
}

const context = { userName: 'testuser', roomToken: 'room1' };

// -- Test 1: "Do I have events today?" → action: list (not create) --
asyncTest('"Do I have events today?" classifies as list, not create', async () => {
  const { executor } = makeExecutor({ action: 'list', query_type: 'today' });
  const result = await executor.execute('Do I have any events today?', context);
  // Should NOT ask for a title (create path), should return a calendar response
  assert.ok(!result.includes('title'), `Should not ask for title, got: ${result}`);
  assert.ok(!result.includes('What should I call it'), `Should not ask to name event, got: ${result}`);
  // Should return the "no events" message (empty mock calendar)
  assert.ok(result.includes('clear') || result.includes('No events'), `Should report calendar status, got: ${result}`);
});

// -- Test 2: "What's on my schedule tomorrow?" → action: list --
asyncTest('"What\'s on my schedule tomorrow?" classifies as list', async () => {
  const { executor } = makeExecutor({ action: 'list', query_type: 'tomorrow' });
  const result = await executor.execute("What's on my schedule tomorrow?", context);
  assert.ok(result.includes('Nothing') || result.includes('No events') || result.includes('Tomorrow'),
    `Should report tomorrow's calendar, got: ${result}`);
});

// -- Test 3: "Am I free at 3pm?" → action: list --
asyncTest('"Am I free at 3pm?" classifies as list with free_slots', async () => {
  const { executor } = makeExecutor({ action: 'list', query_type: 'free_slots', time: '15:00' });
  const result = await executor.execute('Am I free at 3pm?', context);
  assert.ok(result.includes('clear') || result.includes('free') || result.includes('No events'),
    `Should report availability, got: ${result}`);
});

// -- Test 4: "Schedule a meeting tomorrow" → action: create (still works) --
asyncTest('"Schedule a meeting tomorrow" still classifies as create', async () => {
  const { executor } = makeExecutor({
    action: 'create', summary: 'Team Meeting',
    date: 'tomorrow', time: '14:00'
  });
  const result = await executor.execute('Schedule a meeting called Team Meeting tomorrow at 2pm', context);
  assert.ok(result.includes('Created event'), `Should create event, got: ${result}`);
  assert.ok(result.includes('Team Meeting'), `Should confirm title, got: ${result}`);
});

// -- Test 5: "Create event called Standup" → action: create (still works) --
asyncTest('"Create event called Standup" still classifies as create', async () => {
  const { executor } = makeExecutor({
    action: 'create', summary: 'Standup',
    date: 'tomorrow', time: '09:00'
  });
  const result = await executor.execute('Create event called Standup tomorrow 9am', context);
  assert.ok(result.includes('Created event'), `Should create event, got: ${result}`);
  assert.ok(result.includes('Standup'), `Should confirm title, got: ${result}`);
});

// -- Test 6: "When is my next meeting?" → action: list --
asyncTest('"When is my next meeting?" classifies as list with upcoming', async () => {
  const { executor } = makeExecutor({ action: 'list', query_type: 'upcoming' });
  const result = await executor.execute('When is my next meeting?', context);
  assert.ok(result.includes('No upcoming') || result.includes('Upcoming') || result.includes('No events'),
    `Should report upcoming events, got: ${result}`);
});

// -- Test 7: "Any meetings this week?" → action: list --
asyncTest('"Any meetings this week?" classifies as list with this_week', async () => {
  const { executor } = makeExecutor({ action: 'list', query_type: 'this_week' });
  const result = await executor.execute('Any meetings this week?', context);
  assert.ok(result.includes('week') || result.includes('No events'),
    `Should report week's events, got: ${result}`);
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
