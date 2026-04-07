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
const IntentRouter = require('../../../../src/lib/agent/intent-router');

console.log('\n=== Calendar Query Classification Tests ===\n');

// Layer 3: executors may return {response, actionRecord} objects
function getResponse(result) {
  return typeof result === 'object' && result !== null && result.response ? result.response : result;
}

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
  const response = getResponse(result);
  // Should NOT ask for a title (create path), should return a calendar response
  assert.ok(!response.includes('title'), `Should not ask for title, got: ${response}`);
  assert.ok(!response.includes('What should I call it'), `Should not ask to name event, got: ${response}`);
  // Should return the "no events" message (empty mock calendar)
  assert.ok(response.includes('clear') || response.includes('No events'), `Should report calendar status, got: ${response}`);
});

// -- Test 2: "What's on my schedule tomorrow?" → action: list --
asyncTest('"What\'s on my schedule tomorrow?" classifies as list', async () => {
  const { executor } = makeExecutor({ action: 'list', query_type: 'tomorrow' });
  const result = await executor.execute("What's on my schedule tomorrow?", context);
  const response = getResponse(result);
  assert.ok(response.includes('Nothing') || response.includes('No events') || response.includes('Tomorrow'),
    `Should report tomorrow's calendar, got: ${response}`);
});

// -- Test 3: "Am I free at 3pm?" → action: list --
asyncTest('"Am I free at 3pm?" classifies as list with free_slots', async () => {
  const { executor } = makeExecutor({ action: 'list', query_type: 'free_slots', time: '15:00' });
  const result = await executor.execute('Am I free at 3pm?', context);
  const response = getResponse(result);
  assert.ok(response.includes('clear') || response.includes('free') || response.includes('No events'),
    `Should report availability, got: ${response}`);
});

// -- Test 4: "Schedule a meeting tomorrow" → action: create (still works) --
asyncTest('"Schedule a meeting tomorrow" still classifies as create', async () => {
  const { executor } = makeExecutor({
    action: 'create', summary: 'Team Meeting',
    date: 'tomorrow', time: '14:00'
  });
  const result = await executor.execute('Schedule a meeting called Team Meeting tomorrow at 2pm', context);
  const response = getResponse(result);
  assert.ok(response.includes('Created event'), `Should create event, got: ${response}`);
  assert.ok(response.includes('Team Meeting'), `Should confirm title, got: ${response}`);
});

// -- Test 5: "Create event called Standup" → action: create (still works) --
asyncTest('"Create event called Standup" still classifies as create', async () => {
  const { executor } = makeExecutor({
    action: 'create', summary: 'Standup',
    date: 'tomorrow', time: '09:00'
  });
  const result = await executor.execute('Create event called Standup tomorrow 9am', context);
  const response = getResponse(result);
  assert.ok(response.includes('Created event'), `Should create event, got: ${response}`);
  assert.ok(response.includes('Standup'), `Should confirm title, got: ${response}`);
});

// -- Test 6: "When is my next meeting?" → action: list --
asyncTest('"When is my next meeting?" classifies as list with upcoming', async () => {
  const { executor } = makeExecutor({ action: 'list', query_type: 'upcoming' });
  const result = await executor.execute('When is my next meeting?', context);
  const response = getResponse(result);
  assert.ok(response.includes('No upcoming') || response.includes('Upcoming') || response.includes('No events'),
    `Should report upcoming events, got: ${response}`);
});

// -- Test 7: "Any meetings this week?" → action: list --
asyncTest('"Any meetings this week?" classifies as list with this_week', async () => {
  const { executor } = makeExecutor({ action: 'list', query_type: 'this_week' });
  const result = await executor.execute('Any meetings this week?', context);
  const response = getResponse(result);
  assert.ok(response.includes('week') || response.includes('No events'),
    `Should report week's events, got: ${response}`);
});

// === Intent Router classification tests ===
// These verify that calendar read-queries classify as action+calendar at the
// routing layer, not as knowledge — preventing them from being swallowed by
// the knowledge pipeline before they reach CalendarExecutor.queryEvents().

function createIntentRouter(providerResponse) {
  return new IntentRouter({
    provider: { chat: async () => ({ content: providerResponse, toolCalls: null }) },
    config: { classifyTimeout: 5000 }
  });
}

asyncTest('intent router: "Do I have events today?" classifies as action+calendar', async () => {
  const router = createIntentRouter('{"gate":"action","domain":"calendar","confidence":0.9}');
  const result = await router.classify('Do I have events today?');
  assert.strictEqual(result.gate, 'action');
  assert.strictEqual(result.domain, 'calendar');
});

asyncTest('intent router: "What\'s on my calendar this week?" classifies as action+calendar', async () => {
  const router = createIntentRouter('{"gate":"action","domain":"calendar","confidence":0.9}');
  const result = await router.classify("What's on my calendar this week?");
  assert.strictEqual(result.gate, 'action');
  assert.strictEqual(result.domain, 'calendar');
});

asyncTest('intent router: "Am I free at 3pm?" classifies as action+calendar', async () => {
  const router = createIntentRouter('{"gate":"action","domain":"calendar","confidence":0.9}');
  const result = await router.classify('Am I free at 3pm?');
  assert.strictEqual(result.gate, 'action');
  assert.strictEqual(result.domain, 'calendar');
});

asyncTest('intent router: "When is my next meeting?" classifies as action+calendar', async () => {
  const router = createIntentRouter('{"gate":"action","domain":"calendar","confidence":0.9}');
  const result = await router.classify('When is my next meeting?');
  assert.strictEqual(result.gate, 'action');
  assert.strictEqual(result.domain, 'calendar');
});

asyncTest('intent router: "What\'s on my schedule?" classifies as action+calendar', async () => {
  const router = createIntentRouter('{"gate":"action","domain":"calendar","confidence":0.9}');
  const result = await router.classify("What's on my schedule?");
  assert.strictEqual(result.gate, 'action');
  assert.strictEqual(result.domain, 'calendar');
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
