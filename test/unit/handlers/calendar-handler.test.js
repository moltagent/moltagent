/*
 * MoltAgent - Sovereign AI Security Layer
 * Copyright (C) 2026 MoltAgent Contributors
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
 * CalendarHandler Unit Tests
 *
 * Architecture Brief:
 * -------------------
 * Problem: CalendarHandler needs comprehensive unit tests verifying intent routing,
 * CalDAV delegation, SecurityInterceptor integration, and error handling.
 *
 * Pattern: Mock-based unit testing with isolated component verification.
 * - Mock CalDAV client to simulate calendar responses
 * - Mock LLM router for intent parsing
 * - Mock SecurityInterceptor for before/after execute hooks
 * - Verify each handler method and security integration path
 *
 * Key Dependencies:
 * - CalDAVClient (mocked via createMockCalDAVClient)
 * - LLMRouter (mocked via createMockLLMRouter)
 * - SecurityInterceptor (mocked via createMockSecurityInterceptor)
 *
 * Data Flow:
 * Test -> CalendarHandler -> MockCalDAVClient -> Simulated Response
 * Test -> CalendarHandler -> MockSecurityInterceptor -> Allow/Block/Approval
 *
 * Run: node test/unit/handlers/calendar-handler.test.js
 *
 * @module test/unit/handlers/calendar-handler
 */

'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const {
  createMockAuditLog,
  createMockLLMRouter,
  createMockCalDAVClient,
  createMockSecurityInterceptor
} = require('../../helpers/mock-factories');

// Import module under test
const CalendarHandler = require('../../../src/lib/handlers/calendar-handler');

// ============================================================
// Test Helpers
// ============================================================

/**
 * Create a CalendarHandler with mock dependencies
 * @param {Object} [options] - Override options
 * @param {Object} [options.caldavResponses] - Mock CalDAV responses
 * @param {Object} [options.llmResponses] - Mock LLM responses
 * @param {Object} [options.securityOverrides] - Mock security interceptor overrides
 * @param {boolean} [options.withSecurity] - Whether to include security interceptor
 * @returns {{ handler: CalendarHandler, auditLog: Function, security: Object|null }}
 */
function createTestHandler(options = {}) {
  const caldav = createMockCalDAVClient(options.caldavResponses || {});
  const llm = createMockLLMRouter(options.llmResponses || {});
  const auditLog = createMockAuditLog();
  let security = null;

  if (options.withSecurity !== false && options.securityOverrides !== undefined) {
    security = createMockSecurityInterceptor(options.securityOverrides || {});
  } else if (options.withSecurity) {
    security = createMockSecurityInterceptor();
  }

  const handler = new CalendarHandler(caldav, llm, auditLog, security);
  return { handler, caldav, llm, auditLog, security };
}

/**
 * Create a mock LLM that returns a specific intent
 */
function llmForIntent(intent) {
  return {
    calendar_parse: JSON.stringify(intent)
  };
}

// ============================================================
// Test Suites
// ============================================================

console.log('\n=== CalendarHandler Tests ===\n');

// --- Constructor Tests ---
console.log('\n--- Constructor Tests ---\n');

test('TC-CH-001: Constructor stores caldavClient, llmRouter, auditLog', () => {
  const caldav = createMockCalDAVClient();
  const llm = createMockLLMRouter();
  const auditLog = createMockAuditLog();

  const handler = new CalendarHandler(caldav, llm, auditLog);

  assert.strictEqual(handler.caldav, caldav);
  assert.strictEqual(handler.llm, llm);
  assert.strictEqual(handler.auditLog, auditLog);
});

test('TC-CH-002: Constructor stores securityInterceptor as 4th arg', () => {
  const caldav = createMockCalDAVClient();
  const llm = createMockLLMRouter();
  const auditLog = createMockAuditLog();
  const security = createMockSecurityInterceptor();

  const handler = new CalendarHandler(caldav, llm, auditLog, security);

  assert.strictEqual(handler.security, security);
});

test('TC-CH-003: Constructor defaults auditLog to no-op when null', () => {
  const handler = new CalendarHandler(createMockCalDAVClient(), createMockLLMRouter(), null);

  assert.ok(typeof handler.auditLog === 'function');
  assert.strictEqual(handler.security, null);
});

test('TC-CH-004: Constructor defaults security to null when omitted', () => {
  const handler = new CalendarHandler(
    createMockCalDAVClient(),
    createMockLLMRouter(),
    createMockAuditLog()
  );

  assert.strictEqual(handler.security, null);
});

// --- Intent Parsing Tests ---
console.log('\n--- Intent Parsing Tests ---\n');

asyncTest('TC-CH-010: parseIntent returns intent from LLM response', async () => {
  const { handler } = createTestHandler({
    llmResponses: llmForIntent({ action: 'query_today' })
  });

  const intent = await handler.parseIntent("what's on my calendar today?");
  assert.strictEqual(intent.action, 'query_today');
});

test('TC-CH-011: fallbackIntentParse returns query_today for "today"', () => {
  const { handler } = createTestHandler();
  const intent = handler.fallbackIntentParse("what's on today");
  assert.strictEqual(intent.action, 'query_today');
});

test('TC-CH-012: fallbackIntentParse returns query_tomorrow for "tomorrow"', () => {
  const { handler } = createTestHandler();
  const intent = handler.fallbackIntentParse("what do I have tomorrow");
  assert.strictEqual(intent.action, 'query_tomorrow');
});

test('TC-CH-013: fallbackIntentParse returns create_event for "schedule"', () => {
  const { handler } = createTestHandler();
  const intent = handler.fallbackIntentParse("schedule a meeting");
  assert.strictEqual(intent.action, 'create_event');
});

test('TC-CH-014: fallbackIntentParse returns find_free_time for "free"', () => {
  const { handler } = createTestHandler();
  const intent = handler.fallbackIntentParse("when am I free");
  assert.strictEqual(intent.action, 'find_free_time');
});

test('TC-CH-015: fallbackIntentParse returns query_upcoming for "this week"', () => {
  const { handler } = createTestHandler();
  const intent = handler.fallbackIntentParse("what's this week look like");
  assert.strictEqual(intent.action, 'query_upcoming');
  assert.strictEqual(intent.days, 7);
});

// --- Query Handler Tests ---
console.log('\n--- Query Handler Tests ---\n');

asyncTest('TC-CH-020: handleQueryToday returns events from CalDAV', async () => {
  const { handler } = createTestHandler({
    caldavResponses: {
      todaySummary: {
        text: 'Today: 2 events\n- Meeting at 10am\n- Lunch at noon',
        events: [
          { summary: 'Meeting', start: new Date().toISOString(), uid: 'ev1' },
          { summary: 'Lunch', start: new Date().toISOString(), uid: 'ev2' }
        ]
      }
    }
  });

  const result = await handler.handleQueryToday({ action: 'query_today' }, 'testuser');

  assert.strictEqual(result.success, true);
  assert.ok(result.message.includes('2 events'));
  assert.strictEqual(result.events.length, 2);
});

asyncTest('TC-CH-021: handleQueryToday returns message when no events', async () => {
  const { handler } = createTestHandler({
    caldavResponses: {
      todaySummary: {
        text: 'No events today.',
        events: []
      }
    }
  });

  const result = await handler.handleQueryToday({ action: 'query_today' }, 'testuser');

  assert.strictEqual(result.success, true);
  assert.ok(result.message.includes('No events'));
  assert.strictEqual(result.events.length, 0);
});

asyncTest('TC-CH-022: handleQueryTomorrow returns tomorrow events', async () => {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(10, 0, 0, 0);

  const { handler } = createTestHandler({
    caldavResponses: {
      events: [
        { summary: 'Standup', start: tomorrow.toISOString(), end: tomorrow.toISOString(), uid: 'ev-tm1' }
      ]
    }
  });

  const result = await handler.handleQueryTomorrow({ action: 'query_tomorrow' }, 'testuser');

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.events.length, 1);
  assert.ok(result.message.includes('Tomorrow'));
});

asyncTest('TC-CH-023: handleQueryUpcoming returns grouped events by day', async () => {
  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);

  const { handler } = createTestHandler({
    caldavResponses: {
      upcomingEvents: [
        { summary: 'Today Meeting', start: today.toISOString(), uid: 'ev-u1' },
        { summary: 'Tomorrow Call', start: tomorrow.toISOString(), uid: 'ev-u2' }
      ]
    }
  });

  const result = await handler.handleQueryUpcoming({ action: 'query_upcoming', days: 7 }, 'testuser');

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.events.length, 2);
  assert.ok(result.message.includes('Next 7 days'));
});

asyncTest('TC-CH-024: handleQueryDate returns events for a specific date', async () => {
  const targetDate = new Date();
  targetDate.setDate(targetDate.getDate() + 5);
  targetDate.setHours(14, 0, 0, 0);

  const { handler } = createTestHandler({
    caldavResponses: {
      events: [
        { summary: 'Future Event', start: targetDate.toISOString(), end: targetDate.toISOString(), uid: 'ev-d1' }
      ]
    }
  });

  const result = await handler.handleQueryDate(
    { action: 'query_date', date: targetDate.toISOString().split('T')[0] },
    'testuser'
  );

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.events.length, 1);
});

// --- Create Event Tests ---
console.log('\n--- Create Event Tests ---\n');

asyncTest('TC-CH-030: handleCreateEvent returns requiresConfirmation=true', async () => {
  const start = new Date();
  start.setDate(start.getDate() + 1);
  start.setHours(14, 0, 0, 0);

  const { handler } = createTestHandler();

  const result = await handler.handleCreateEvent(
    { action: 'create_event', title: 'Team Sync', start: start.toISOString(), duration: 30 },
    'testuser',
    {}
  );

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.requiresConfirmation, true);
  assert.strictEqual(result.confirmationType, 'create_event');
  assert.ok(result.pendingAction);
  assert.strictEqual(result.pendingAction.data.summary, 'Team Sync');
});

asyncTest('TC-CH-031: handleCreateEvent requires start time', async () => {
  const { handler } = createTestHandler();

  const result = await handler.handleCreateEvent(
    { action: 'create_event', title: 'No Time Meeting' },
    'testuser',
    {}
  );

  assert.strictEqual(result.success, false);
  assert.ok(result.message.includes('specify a date and time'));
});

asyncTest('TC-CH-032: handleCreateEvent shows conflict warning', async () => {
  const start = new Date();
  start.setDate(start.getDate() + 1);
  start.setHours(14, 0, 0, 0);

  const { handler } = createTestHandler({
    caldavResponses: {
      availability: {
        isFree: false,
        conflicts: [
          { summary: 'Existing Meeting', start: start.toISOString(), end: start.toISOString() }
        ]
      }
    }
  });

  const result = await handler.handleCreateEvent(
    { action: 'create_event', title: 'Conflict Test', start: start.toISOString() },
    'testuser',
    {}
  );

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.requiresConfirmation, true);
  assert.ok(result.message.includes('Conflicts detected'));
});

asyncTest('TC-CH-033: confirmCreateEvent calls caldav.createEvent', async () => {
  let createCalled = false;
  const { handler } = createTestHandler({
    caldavResponses: {
      createEvent: (() => {
        // Override with a tracking wrapper
        return { uid: 'new-uid-123', summary: 'Test Event' };
      })()
    }
  });

  // Replace createEvent with tracking mock
  const originalCreate = handler.caldav.createEvent;
  handler.caldav.createEvent = async (data) => {
    createCalled = true;
    return originalCreate(data);
  };

  const start = new Date();
  start.setHours(14, 0, 0, 0);
  const end = new Date(start.getTime() + 60 * 60 * 1000);

  await handler.confirmCreateEvent(
    { summary: 'Test Event', start, end },
    'testuser'
  );

  assert.strictEqual(createCalled, true);
});

asyncTest('TC-CH-034: confirmCreateEvent returns created event', async () => {
  const { handler } = createTestHandler({
    caldavResponses: {
      createEvent: { uid: 'created-uid-456', summary: 'New Event' }
    }
  });

  const start = new Date();
  start.setHours(14, 0, 0, 0);
  const end = new Date(start.getTime() + 60 * 60 * 1000);

  const result = await handler.confirmCreateEvent(
    { summary: 'New Event', start, end },
    'testuser'
  );

  assert.strictEqual(result.success, true);
  assert.ok(result.message.includes('Event created'));
  assert.ok(result.event);
  assert.strictEqual(result.event.uid, 'created-uid-456');
});

// --- Free Time Tests ---
console.log('\n--- Free Time Tests ---\n');

asyncTest('TC-CH-040: handleFindFreeTime returns free slots', async () => {
  const slotStart = new Date();
  slotStart.setHours(10, 0, 0, 0);
  const slotEnd = new Date(slotStart.getTime() + 2 * 60 * 60 * 1000);

  const { handler } = createTestHandler({
    caldavResponses: {
      freeSlots: [
        { start: slotStart, end: slotEnd, durationMinutes: 120 }
      ]
    }
  });

  const result = await handler.handleFindFreeTime({ action: 'find_free_time', duration: 60, days: 7 }, 'testuser');

  assert.strictEqual(result.success, true);
  assert.ok(result.message.includes('Found'));
  assert.strictEqual(result.slots.length, 1);
});

asyncTest('TC-CH-041: handleFindFreeTime returns "no slots" when packed', async () => {
  const { handler } = createTestHandler({
    caldavResponses: { freeSlots: [] }
  });

  const result = await handler.handleFindFreeTime({ action: 'find_free_time', duration: 60, days: 7 }, 'testuser');

  assert.strictEqual(result.success, true);
  assert.ok(result.message.includes('packed') || result.message.includes("Couldn't find"));
  assert.strictEqual(result.slots.length, 0);
});

asyncTest('TC-CH-042: handleCheckAvailability returns free when no conflicts', async () => {
  const checkTime = new Date();
  checkTime.setDate(checkTime.getDate() + 3);
  checkTime.setHours(15, 0, 0, 0);

  const { handler } = createTestHandler();

  const result = await handler.handleCheckAvailability(
    { action: 'check_availability', start: checkTime.toISOString() },
    'testuser'
  );

  assert.strictEqual(result.success, true);
  assert.ok(result.message.includes('free'));
});

asyncTest('TC-CH-043: handleCheckAvailability returns conflicts when busy', async () => {
  const checkTime = new Date();
  checkTime.setDate(checkTime.getDate() + 3);
  checkTime.setHours(15, 0, 0, 0);

  const { handler } = createTestHandler({
    caldavResponses: {
      availability: {
        isFree: false,
        conflicts: [
          { summary: 'Blocking Meeting', start: checkTime.toISOString(), end: checkTime.toISOString() }
        ]
      }
    }
  });

  const result = await handler.handleCheckAvailability(
    { action: 'check_availability', start: checkTime.toISOString() },
    'testuser'
  );

  assert.strictEqual(result.success, true);
  assert.ok(result.message.includes('conflicts') || result.message.includes('Blocking Meeting'));
  assert.ok(result.conflicts);
  assert.strictEqual(result.conflicts.length, 1);
});

// --- Security Integration Tests ---
console.log('\n--- Security Integration Tests ---\n');

asyncTest('TC-CH-050: handle() calls security.beforeExecute before CalDAV operation', async () => {
  let beforeCalled = false;
  let capturedOperation = null;

  const { handler } = createTestHandler({
    llmResponses: llmForIntent({ action: 'query_today' }),
    securityOverrides: {
      beforeExecute: (operation, params, context) => {
        beforeCalled = true;
        capturedOperation = operation;
        return {
          proceed: true,
          decision: 'ALLOW',
          reason: null,
          modifiedParams: { ...params },
          approvalRequired: false,
          approvalPrompt: null,
          routeToLocal: false,
          session: {},
          guardResults: { tools: null, prompt: null, secrets: null, paths: null, egress: null }
        };
      }
    }
  });

  await handler.handle("what's on today", 'testuser', { roomToken: 'room1' });

  assert.strictEqual(beforeCalled, true);
  assert.strictEqual(capturedOperation, 'calendar_query_today');
});

asyncTest('TC-CH-051: handle() returns block message when security blocks', async () => {
  const { handler } = createTestHandler({
    llmResponses: llmForIntent({ action: 'query_today' }),
    securityOverrides: {
      beforeExecute: {
        proceed: false,
        decision: 'BLOCK',
        reason: 'Suspicious calendar query detected',
        modifiedParams: {},
        approvalRequired: false,
        approvalPrompt: null,
        routeToLocal: false,
        session: {},
        guardResults: { tools: null, prompt: null, secrets: null, paths: null, egress: null }
      }
    }
  });

  const result = await handler.handle("what's on today", 'testuser', { roomToken: 'room1' });

  assert.strictEqual(result.success, false);
  assert.ok(result.message.includes('blocked'));
  assert.ok(result.message.includes('Suspicious calendar query'));
});

asyncTest('TC-CH-052: handle() returns approval request when security requires approval', async () => {
  const { handler } = createTestHandler({
    llmResponses: llmForIntent({ action: 'create_event', title: 'Secret Meeting', start: new Date().toISOString() }),
    securityOverrides: {
      beforeExecute: {
        proceed: false,
        decision: 'APPROVAL_REQUIRED',
        reason: null,
        modifiedParams: {},
        approvalRequired: true,
        approvalPrompt: 'Approve calendar event creation?',
        routeToLocal: false,
        session: {},
        guardResults: { tools: null, prompt: null, secrets: null, paths: null, egress: null }
      }
    }
  });

  const result = await handler.handle('schedule a secret meeting', 'testuser', { roomToken: 'room1' });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.requiresConfirmation, true);
  assert.strictEqual(result.confirmationType, 'security_approval');
  assert.ok(result.message.includes('Approve'));
});

asyncTest('TC-CH-053: handle() calls security.afterExecute on response', async () => {
  let afterCalled = false;
  let capturedResponse = null;

  const { handler } = createTestHandler({
    llmResponses: llmForIntent({ action: 'query_today' }),
    caldavResponses: {
      todaySummary: { text: 'Today: 1 event', events: [{ summary: 'Test' }] }
    },
    securityOverrides: {
      afterExecute: (operation, response, context) => {
        afterCalled = true;
        capturedResponse = response;
        return {
          response,
          sanitized: false,
          warnings: [],
          blocked: false,
          reason: null
        };
      }
    }
  });

  await handler.handle("what's on today", 'testuser', { roomToken: 'room1' });

  assert.strictEqual(afterCalled, true);
  assert.ok(capturedResponse.includes('Today'));
});

asyncTest('TC-CH-054: handle() returns blocked response when afterExecute blocks', async () => {
  const { handler } = createTestHandler({
    llmResponses: llmForIntent({ action: 'query_today' }),
    caldavResponses: {
      todaySummary: { text: 'Secret meeting with secret-password-123', events: [] }
    },
    securityOverrides: {
      afterExecute: {
        response: 'Response blocked for security review.',
        sanitized: true,
        warnings: [{ type: 'secret_detected', severity: 'critical', action: 'blocked' }],
        blocked: true,
        reason: 'Response contained critical secrets'
      }
    }
  });

  const result = await handler.handle("what's on today", 'testuser', { roomToken: 'room1' });

  assert.strictEqual(result.success, false);
  assert.ok(result.message.includes('blocked') || result.message.includes('security'));
});

asyncTest('TC-CH-055: handle() works without security (null interceptor)', async () => {
  const { handler } = createTestHandler({
    llmResponses: llmForIntent({ action: 'query_today' }),
    caldavResponses: {
      todaySummary: { text: 'No events today.', events: [] }
    }
    // No securityOverrides, no withSecurity -- security is null
  });

  assert.strictEqual(handler.security, null);

  const result = await handler.handle("what's on today", 'testuser', {});

  assert.strictEqual(result.success, true);
  assert.ok(result.message.includes('No events'));
});

asyncTest('TC-CH-056: confirmCreateEvent() calls security.beforeExecute', async () => {
  let beforeCalled = false;
  let capturedOperation = null;

  const { handler } = createTestHandler({
    securityOverrides: {
      beforeExecute: (operation, params, context) => {
        beforeCalled = true;
        capturedOperation = operation;
        return {
          proceed: true,
          decision: 'ALLOW',
          reason: null,
          modifiedParams: { ...params },
          approvalRequired: false,
          approvalPrompt: null,
          routeToLocal: false,
          session: {},
          guardResults: { tools: null, prompt: null, secrets: null, paths: null, egress: null }
        };
      }
    }
  });

  const start = new Date();
  const end = new Date(start.getTime() + 60 * 60 * 1000);

  await handler.confirmCreateEvent(
    { summary: 'Test', start, end },
    'testuser',
    { roomToken: 'room1' }
  );

  assert.strictEqual(beforeCalled, true);
  assert.strictEqual(capturedOperation, 'calendar_create_event_confirmed');
});

asyncTest('TC-CH-057: confirmCreateEvent() returns block when security blocks', async () => {
  const { handler } = createTestHandler({
    securityOverrides: {
      beforeExecute: {
        proceed: false,
        decision: 'BLOCK',
        reason: 'Event creation not allowed',
        modifiedParams: {},
        approvalRequired: false,
        approvalPrompt: null,
        routeToLocal: false,
        session: {},
        guardResults: { tools: null, prompt: null, secrets: null, paths: null, egress: null }
      }
    }
  });

  const start = new Date();
  const end = new Date(start.getTime() + 60 * 60 * 1000);

  const result = await handler.confirmCreateEvent(
    { summary: 'Blocked Event', start, end },
    'testuser',
    { roomToken: 'room1' }
  );

  assert.strictEqual(result.success, false);
  assert.ok(result.message.includes('blocked') || result.message.includes('Event creation'));
});

// --- Formatting Helper Tests ---
console.log('\n--- Formatting Helper Tests ---\n');

test('TC-CH-060: formatTime returns 12-hour format', () => {
  const { handler } = createTestHandler();
  const date = new Date('2026-02-06T14:30:00');
  const formatted = handler.formatTime(date);
  assert.ok(formatted.includes('2:30') || formatted.includes('02:30'));
  assert.ok(formatted.includes('PM'));
});

test('TC-CH-061: formatDate returns short date format', () => {
  const { handler } = createTestHandler();
  const date = new Date('2026-02-06T14:30:00');
  const formatted = handler.formatDate(date);
  assert.ok(formatted.includes('Feb'));
  assert.ok(formatted.includes('6'));
});

test('TC-CH-062: isToday returns true for today', () => {
  const { handler } = createTestHandler();
  assert.strictEqual(handler.isToday(new Date()), true);

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  assert.strictEqual(handler.isToday(yesterday), false);
});

test('TC-CH-063: isTomorrow returns true for tomorrow', () => {
  const { handler } = createTestHandler();
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  assert.strictEqual(handler.isTomorrow(tomorrow), true);

  assert.strictEqual(handler.isTomorrow(new Date()), false);
});

test('TC-CH-064: getTomorrow returns ISO date string', () => {
  const { handler } = createTestHandler();
  const result = handler.getTomorrow();
  // Should match YYYY-MM-DD format
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(result));

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  assert.strictEqual(result, tomorrow.toISOString().split('T')[0]);
});

// --- Error Handling Tests ---
console.log('\n--- Error Handling Tests ---\n');

asyncTest('TC-CH-070: handle() returns error message on CalDAV failure', async () => {
  const { handler } = createTestHandler({
    llmResponses: llmForIntent({ action: 'query_today' })
  });

  // Override CalDAV to throw
  handler.caldav.getTodaySummary = async () => {
    throw new Error('CalDAV connection refused');
  };

  const result = await handler.handle("what's on today", 'testuser', {});

  assert.strictEqual(result.success, false);
  assert.ok(result.message.includes('CalDAV connection refused'));
});

asyncTest('TC-CH-071: handle() logs error to auditLog on failure', async () => {
  const { handler, auditLog } = createTestHandler({
    llmResponses: llmForIntent({ action: 'query_today' })
  });

  // Override CalDAV to throw
  handler.caldav.getTodaySummary = async () => {
    throw new Error('Network timeout');
  };

  await handler.handle("what's on today", 'testuser', {});

  const errorCalls = auditLog.getCallsFor('calendar_error');
  assert.strictEqual(errorCalls.length, 1);
  assert.strictEqual(errorCalls[0].data.action, 'query_today');
  assert.ok(errorCalls[0].data.error.includes('Network timeout'));
});

// --- Summary ---
setTimeout(() => {
  summary();
  exitWithCode();
}, 100);
