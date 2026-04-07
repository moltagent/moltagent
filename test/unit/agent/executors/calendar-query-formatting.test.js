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
 * Calendar Query Formatting Tests
 *
 * Validates _formatEventList(): single-day vs multi-day grouping,
 * event cap with truncation notice, time sorting.
 *
 * Run: node test/unit/agent/executors/calendar-query-formatting.test.js
 */

'use strict';

const assert = require('assert');
const { test, summary, exitWithCode } = require('../../../helpers/test-runner');
const CalendarExecutor = require('../../../../src/lib/agent/executors/calendar-executor');

console.log('\n=== Calendar Query Formatting Tests ===\n');

const silentLogger = { log() {}, info() {}, warn() {}, error() {} };

function makeExecutor() {
  const router = { route: async () => ({ result: '{}' }) };
  const calendarClient = {
    getEventCalendars: async () => [{ id: 'personal' }],
    getEvents: async () => [],
    getTodayEvents: async () => [],
    getUpcomingEvents: async () => []
  };
  return new CalendarExecutor({ router, calendarClient, logger: silentLogger });
}

test('single-day query (today) has no date headers', () => {
  const executor = makeExecutor();
  const events = [
    { summary: 'Standup', start: '2026-02-27T09:00:00Z', duration: 30 },
    { summary: 'Lunch', start: '2026-02-27T12:00:00Z' }
  ];
  const result = executor._formatEventList(events, 'today');
  assert.ok(result.startsWith('Today:'), `Should start with Today:, got: ${result}`);
  assert.ok(result.includes('Standup'), `Should include Standup, got: ${result}`);
  assert.ok(result.includes('Lunch'), `Should include Lunch, got: ${result}`);
  // Single-day: lines should start with "•" not date headers
  const lines = result.split('\n').slice(1); // Skip "Today:" header
  for (const line of lines) {
    assert.ok(line.trim().startsWith('•'), `Each line should start with •, got: "${line}"`);
  }
});

test('multi-day query (this_week) groups by date with headers', () => {
  const executor = makeExecutor();
  const events = [
    { summary: 'Monday Standup', start: '2026-03-02T09:00:00Z' },
    { summary: 'Monday Lunch', start: '2026-03-02T12:00:00Z' },
    { summary: 'Tuesday Review', start: '2026-03-03T14:00:00Z' }
  ];
  const result = executor._formatEventList(events, 'this_week');
  assert.ok(result.startsWith('This week:'), `Should start with This week:, got: ${result}`);
  // Should have date grouping headers (e.g., "Mon, Mar 2:")
  const lines = result.split('\n');
  const headerLines = lines.filter(l => l.match(/^[A-Z][a-z]{2},/) || l.match(/^Unknown/));
  assert.ok(headerLines.length >= 2, `Expected at least 2 date headers, got ${headerLines.length}: ${result}`);
  assert.ok(result.includes('Monday Standup'), `Should include Monday Standup`);
  assert.ok(result.includes('Tuesday Review'), `Should include Tuesday Review`);
});

test('>15 events shows truncation message', () => {
  const executor = makeExecutor();
  const events = [];
  for (let i = 0; i < 20; i++) {
    events.push({
      summary: `Event ${i + 1}`,
      start: `2026-02-27T${String(8 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 === 0 ? '00' : '30'}:00Z`
    });
  }
  const result = executor._formatEventList(events, 'today');
  assert.ok(result.includes('Showing 15 of 20'), `Expected truncation notice, got: ${result}`);
  assert.ok(result.includes('Event 1'), 'Should include first event');
  assert.ok(result.includes('Event 15'), 'Should include 15th event');
  assert.ok(!result.includes('Event 16'), 'Should not include 16th event');
});

test('events sorted by time within each day (pre-sorted input preserved)', () => {
  const executor = makeExecutor();
  const events = [
    { summary: 'Early', start: '2026-02-27T08:00:00Z' },
    { summary: 'Mid', start: '2026-02-27T12:00:00Z' },
    { summary: 'Late', start: '2026-02-27T17:00:00Z' }
  ];
  const result = executor._formatEventList(events, 'today');
  const earlyIdx = result.indexOf('Early');
  const midIdx = result.indexOf('Mid');
  const lateIdx = result.indexOf('Late');
  assert.ok(earlyIdx < midIdx && midIdx < lateIdx,
    `Events should be in time order, got: ${result}`);
});

test('empty event list returns appropriate message via _formatNoEvents', () => {
  const executor = makeExecutor();
  const result = executor._formatNoEvents('today');
  assert.ok(result.includes('clear'), `Expected clear message, got: ${result}`);
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
