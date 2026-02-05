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
 * NC Flow Heartbeat Integration Tests
 *
 * Tests covering the wiring between NC Flow modules (ActivityPoller,
 * WebhookReceiver) and HeartbeatManager. Verifies event queue, processing,
 * pulse integration, and status reporting.
 *
 * Run: node test/unit/nc-flow/heartbeat-integration.test.js
 *
 * @module test/unit/nc-flow/heartbeat-integration
 */

'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

const HeartbeatManager = require('../../../src/lib/integrations/heartbeat-manager');

// ============================================================
// Test Helpers
// ============================================================

/**
 * Create a minimal HeartbeatManager config sufficient for testing
 * the NC Flow integration (no real NC/Deck/CalDAV connections).
 */
function createTestHeartbeat(overrides = {}) {
  // Set quiet hours to a window that never matches (same start/end = disabled)
  const currentHour = new Date().getHours();
  const safeQuietStart = (currentHour + 12) % 24;
  const safeQuietEnd = (safeQuietStart + 1) % 24;

  return new HeartbeatManager({
    nextcloud: { url: 'https://test.example.com', username: 'moltagent' },
    deck: { boardId: 1 },
    heartbeat: {
      intervalMs: 60000,
      deckEnabled: false,
      caldavEnabled: false,
      quietHoursStart: safeQuietStart,
      quietHoursEnd: safeQuietEnd,
      initiativeLevel: 2
    },
    llmRouter: { generate: async () => ({}) },
    notifyUser: async () => {},
    auditLog: async () => {},
    ncFlow: overrides.ncFlow || null,
    ...overrides
  });
}

/**
 * Create a sample NCFlowEvent.
 */
function makeFlowEvent(type, id) {
  return {
    id: `test:${id || Math.random().toString(36).slice(2, 8)}`,
    source: 'activity',
    type: type || 'file_created',
    user: 'alice',
    timestamp: Date.now(),
    objectType: 'file',
    objectId: String(id || 1),
    objectName: '/test/file.txt',
    data: { subject: 'test event' }
  };
}

/**
 * Create a mock ActivityPoller (EventEmitter with getMetrics).
 */
function createMockPoller() {
  const poller = new EventEmitter();
  poller.getMetrics = () => ({
    totalPolls: 5,
    totalEvents: 20,
    emittedEvents: 15,
    skippedOwn: 3,
    errors: 0,
    lastActivityId: 100,
    enabled: true,
    polling: false
  });
  poller.start = () => true;
  poller.stop = () => {};
  return poller;
}

/**
 * Create a mock WebhookReceiver (EventEmitter with enabled flag).
 */
function createMockReceiver() {
  const receiver = new EventEmitter();
  receiver.enabled = false;
  receiver.start = async () => false;
  receiver.stop = async () => {};
  return receiver;
}

// ============================================================
// enqueueExternalEvent Tests
// ============================================================

console.log('\n=== NC Flow Heartbeat Integration Tests ===\n');
console.log('--- enqueueExternalEvent ---\n');

test('HB-FLOW-001: enqueueExternalEvent adds event to queue', () => {
  const hb = createTestHeartbeat();
  const event = makeFlowEvent('file_created', 1);
  hb.enqueueExternalEvent(event);
  assert.strictEqual(hb.externalEventQueue.length, 1);
  assert.strictEqual(hb.externalEventQueue[0].type, 'file_created');
});

test('HB-FLOW-002: enqueueExternalEvent accepts multiple events', () => {
  const hb = createTestHeartbeat();
  hb.enqueueExternalEvent(makeFlowEvent('file_created', 1));
  hb.enqueueExternalEvent(makeFlowEvent('file_changed', 2));
  hb.enqueueExternalEvent(makeFlowEvent('deck_card_created', 3));
  assert.strictEqual(hb.externalEventQueue.length, 3);
});

test('HB-FLOW-003: Queue caps at 500 events (drops oldest)', () => {
  const hb = createTestHeartbeat();
  for (let i = 0; i < 510; i++) {
    hb.enqueueExternalEvent(makeFlowEvent('file_changed', i));
  }
  assert.strictEqual(hb.externalEventQueue.length, 500);
  // Oldest events should be dropped — queue[0] should be event #10
  assert.strictEqual(hb.externalEventQueue[0].objectId, '10');
});

test('HB-FLOW-004: Queue preserves event order within cap', () => {
  const hb = createTestHeartbeat();
  hb.enqueueExternalEvent(makeFlowEvent('file_created', 1));
  hb.enqueueExternalEvent(makeFlowEvent('file_changed', 2));
  hb.enqueueExternalEvent(makeFlowEvent('file_deleted', 3));
  assert.strictEqual(hb.externalEventQueue[0].type, 'file_created');
  assert.strictEqual(hb.externalEventQueue[1].type, 'file_changed');
  assert.strictEqual(hb.externalEventQueue[2].type, 'file_deleted');
});

test('HB-FLOW-005: enqueueExternalEvent ignores null events', () => {
  const hb = createTestHeartbeat();
  hb.enqueueExternalEvent(null);
  hb.enqueueExternalEvent(undefined);
  assert.strictEqual(hb.externalEventQueue.length, 0);
});

test('HB-FLOW-006: enqueueExternalEvent ignores events without type', () => {
  const hb = createTestHeartbeat();
  hb.enqueueExternalEvent({ id: 'no-type', source: 'test' });
  assert.strictEqual(hb.externalEventQueue.length, 0);
});

// ============================================================
// _processFlowEvents Tests
// ============================================================

console.log('\n--- _processFlowEvents ---\n');

test('HB-PROC-001: Returns { processed: 0 } on empty queue', () => {
  const hb = createTestHeartbeat();
  const result = hb._processFlowEvents();
  assert.strictEqual(result.processed, 0);
  assert.strictEqual(result.byType, undefined);
});

test('HB-PROC-002: Drains queue completely', () => {
  const hb = createTestHeartbeat();
  hb.enqueueExternalEvent(makeFlowEvent('file_created', 1));
  hb.enqueueExternalEvent(makeFlowEvent('file_changed', 2));
  const result = hb._processFlowEvents();
  assert.strictEqual(result.processed, 2);
  assert.strictEqual(hb.externalEventQueue.length, 0);
});

test('HB-PROC-003: Returns correct byType summary', () => {
  const hb = createTestHeartbeat();
  hb.enqueueExternalEvent(makeFlowEvent('file_created', 1));
  hb.enqueueExternalEvent(makeFlowEvent('file_created', 2));
  hb.enqueueExternalEvent(makeFlowEvent('file_changed', 3));
  hb.enqueueExternalEvent(makeFlowEvent('deck_card_created', 4));
  const result = hb._processFlowEvents();
  assert.strictEqual(result.byType.file_created, 2);
  assert.strictEqual(result.byType.file_changed, 1);
  assert.strictEqual(result.byType.deck_card_created, 1);
});

test('HB-PROC-004: Updates flowEventsProcessedToday counter', () => {
  const hb = createTestHeartbeat();
  hb.enqueueExternalEvent(makeFlowEvent('file_created', 1));
  hb.enqueueExternalEvent(makeFlowEvent('file_changed', 2));
  hb._processFlowEvents();
  assert.strictEqual(hb.state.flowEventsProcessedToday, 2);

  // Process more events — counter accumulates
  hb.enqueueExternalEvent(makeFlowEvent('file_deleted', 3));
  hb._processFlowEvents();
  assert.strictEqual(hb.state.flowEventsProcessedToday, 3);
});

test('HB-PROC-005: Updates lastFlowProcess timestamp', () => {
  const hb = createTestHeartbeat();
  assert.strictEqual(hb.state.lastFlowProcess, null);
  hb.enqueueExternalEvent(makeFlowEvent('file_created', 1));
  hb._processFlowEvents();
  assert.ok(hb.state.lastFlowProcess instanceof Date);
});

test('HB-PROC-006: Does not update lastFlowProcess on empty queue', () => {
  const hb = createTestHeartbeat();
  hb._processFlowEvents();
  assert.strictEqual(hb.state.lastFlowProcess, null);
});

// ============================================================
// Pulse Integration Tests
// ============================================================

console.log('\n--- Pulse Integration ---\n');

asyncTest('HB-PULSE-001: pulse() includes flow event processing', async () => {
  const auditEvents = [];
  const hb = createTestHeartbeat({
    auditLog: async (event, data) => auditEvents.push({ event, data })
  });
  hb.enqueueExternalEvent(makeFlowEvent('file_created', 1));
  hb.enqueueExternalEvent(makeFlowEvent('file_changed', 2));

  const results = await hb.pulse();
  assert.strictEqual(results.flow.processed, 2);
  assert.strictEqual(hb.externalEventQueue.length, 0);
});

asyncTest('HB-PULSE-002: pulse() audit log includes flowEventsProcessed', async () => {
  const auditEvents = [];
  const hb = createTestHeartbeat({
    auditLog: async (event, data) => auditEvents.push({ event, data })
  });
  hb.enqueueExternalEvent(makeFlowEvent('file_created', 1));
  await hb.pulse();

  const pulseLog = auditEvents.find(e => e.event === 'heartbeat_pulse');
  assert.ok(pulseLog, 'heartbeat_pulse audit event should exist');
  assert.strictEqual(pulseLog.data.flowEventsProcessed, 1);
});

asyncTest('HB-PULSE-003: pulse() handles empty flow queue gracefully', async () => {
  const hb = createTestHeartbeat();
  const results = await hb.pulse();
  assert.strictEqual(results.flow.processed, 0);
});

// ============================================================
// getStatus Tests
// ============================================================

console.log('\n--- getStatus ---\n');

test('HB-STATUS-001: getStatus includes lastFlowProcess', () => {
  const hb = createTestHeartbeat();
  const status = hb.getStatus();
  assert.ok('lastFlowProcess' in status);
  assert.strictEqual(status.lastFlowProcess, null);
});

test('HB-STATUS-002: getStatus includes flowEventsProcessedToday', () => {
  const hb = createTestHeartbeat();
  const status = hb.getStatus();
  assert.ok('flowEventsProcessedToday' in status);
  assert.strictEqual(status.flowEventsProcessedToday, 0);
});

test('HB-STATUS-003: getStatus includes flowQueueLength', () => {
  const hb = createTestHeartbeat();
  hb.enqueueExternalEvent(makeFlowEvent('file_created', 1));
  const status = hb.getStatus();
  assert.ok('flowQueueLength' in status);
  assert.strictEqual(status.flowQueueLength, 1);
});

test('HB-STATUS-004: getStatus reflects accurate counters after processing', () => {
  const hb = createTestHeartbeat();
  hb.enqueueExternalEvent(makeFlowEvent('file_created', 1));
  hb.enqueueExternalEvent(makeFlowEvent('file_changed', 2));
  hb._processFlowEvents();

  const status = hb.getStatus();
  assert.strictEqual(status.flowEventsProcessedToday, 2);
  assert.strictEqual(status.flowQueueLength, 0);
  assert.ok(status.lastFlowProcess instanceof Date);
});

// ============================================================
// getHeartbeatContext Tests
// ============================================================

console.log('\n--- getHeartbeatContext ---\n');

asyncTest('HB-CTX-001: getHeartbeatContext includes ncFlow when configured', async () => {
  const poller = createMockPoller();
  const receiver = createMockReceiver();

  const hb = createTestHeartbeat({
    ncFlow: { activityPoller: poller, webhookReceiver: receiver, systemTags: {} }
  });
  hb.enqueueExternalEvent(makeFlowEvent('file_created', 1));

  const context = await hb.getHeartbeatContext();
  assert.ok(context.ncFlow, 'ncFlow section should exist in context');
  assert.strictEqual(context.ncFlow.queueLength, 1);
  assert.strictEqual(context.ncFlow.flowEventsProcessedToday, 0);
  assert.ok(context.ncFlow.activityPoller, 'activityPoller metrics should exist');
  assert.strictEqual(context.ncFlow.activityPoller.totalPolls, 5);
  assert.strictEqual(context.ncFlow.webhookEnabled, false);
});

asyncTest('HB-CTX-002: getHeartbeatContext omits ncFlow when not configured', async () => {
  const hb = createTestHeartbeat({ ncFlow: null });
  const context = await hb.getHeartbeatContext();
  assert.strictEqual(context.ncFlow, undefined);
});

// ============================================================
// Event Wiring Tests
// ============================================================

console.log('\n--- Event Wiring ---\n');

test('HB-WIRE-001: ActivityPoller events wire to enqueueExternalEvent', () => {
  const poller = createMockPoller();
  const hb = createTestHeartbeat({
    ncFlow: { activityPoller: poller, webhookReceiver: createMockReceiver() }
  });

  // Simulate wiring (as done in bot.js)
  poller.on('event', (event) => hb.enqueueExternalEvent(event));

  poller.emit('event', makeFlowEvent('file_created', 1));
  poller.emit('event', makeFlowEvent('file_changed', 2));

  assert.strictEqual(hb.externalEventQueue.length, 2);
});

test('HB-WIRE-002: WebhookReceiver events wire to enqueueExternalEvent', () => {
  const receiver = createMockReceiver();
  const hb = createTestHeartbeat({
    ncFlow: { activityPoller: createMockPoller(), webhookReceiver: receiver }
  });

  // Simulate wiring
  receiver.on('event', (event) => hb.enqueueExternalEvent(event));

  receiver.emit('event', makeFlowEvent('calendar_event_created', 10));

  assert.strictEqual(hb.externalEventQueue.length, 1);
  assert.strictEqual(hb.externalEventQueue[0].type, 'calendar_event_created');
});

test('HB-WIRE-003: Events from both sources accumulate in same queue', () => {
  const poller = createMockPoller();
  const receiver = createMockReceiver();
  const hb = createTestHeartbeat({
    ncFlow: { activityPoller: poller, webhookReceiver: receiver }
  });

  poller.on('event', (event) => hb.enqueueExternalEvent(event));
  receiver.on('event', (event) => hb.enqueueExternalEvent(event));

  poller.emit('event', makeFlowEvent('file_created', 1));
  receiver.emit('event', makeFlowEvent('calendar_event_created', 2));
  poller.emit('event', makeFlowEvent('tag_assigned', 3));

  assert.strictEqual(hb.externalEventQueue.length, 3);
});

// ============================================================
// Rapid Enqueue Stress Test
// ============================================================

console.log('\n--- Stress Tests ---\n');

test('HB-STRESS-001: Multiple rapid enqueues do not corrupt state', () => {
  const hb = createTestHeartbeat();
  for (let i = 0; i < 200; i++) {
    hb.enqueueExternalEvent(makeFlowEvent('file_changed', i));
  }
  assert.strictEqual(hb.externalEventQueue.length, 200);

  const result = hb._processFlowEvents();
  assert.strictEqual(result.processed, 200);
  assert.strictEqual(result.byType.file_changed, 200);
  assert.strictEqual(hb.externalEventQueue.length, 0);
  assert.strictEqual(hb.state.flowEventsProcessedToday, 200);
});

test('HB-STRESS-002: Enqueue after process works correctly', () => {
  const hb = createTestHeartbeat();
  hb.enqueueExternalEvent(makeFlowEvent('file_created', 1));
  hb._processFlowEvents();
  assert.strictEqual(hb.externalEventQueue.length, 0);

  hb.enqueueExternalEvent(makeFlowEvent('file_changed', 2));
  assert.strictEqual(hb.externalEventQueue.length, 1);

  const result = hb._processFlowEvents();
  assert.strictEqual(result.processed, 1);
  assert.strictEqual(hb.state.flowEventsProcessedToday, 2);
});

// ============================================================
// resetDailyCounters Tests
// ============================================================

console.log('\n--- resetDailyCounters ---\n');

test('HB-RESET-001: resetDailyCounters resets flowEventsProcessedToday', () => {
  const hb = createTestHeartbeat();
  hb.enqueueExternalEvent(makeFlowEvent('file_created', 1));
  hb._processFlowEvents();
  assert.strictEqual(hb.state.flowEventsProcessedToday, 1);

  hb.resetDailyCounters();
  assert.strictEqual(hb.state.flowEventsProcessedToday, 0);
});

// ============================================================
// Constructor Tests
// ============================================================

console.log('\n--- Constructor ---\n');

test('HB-CTOR-001: externalEventQueue initialized as empty array', () => {
  const hb = createTestHeartbeat();
  assert.ok(Array.isArray(hb.externalEventQueue));
  assert.strictEqual(hb.externalEventQueue.length, 0);
});

test('HB-CTOR-002: ncFlow stored from config', () => {
  const ncFlow = { activityPoller: {}, webhookReceiver: {}, systemTags: {} };
  const hb = createTestHeartbeat({ ncFlow });
  assert.strictEqual(hb.ncFlow, ncFlow);
});

test('HB-CTOR-003: ncFlow defaults to null when not provided', () => {
  const hb = new HeartbeatManager({
    nextcloud: { url: 'https://test.example.com', username: 'moltagent' },
    deck: { boardId: 1 },
    heartbeat: { intervalMs: 60000, deckEnabled: false, caldavEnabled: false }
  });
  assert.strictEqual(hb.ncFlow, null);
});

test('HB-CTOR-004: state includes lastFlowProcess and flowEventsProcessedToday', () => {
  const hb = createTestHeartbeat();
  assert.strictEqual(hb.state.lastFlowProcess, null);
  assert.strictEqual(hb.state.flowEventsProcessedToday, 0);
});

// ============================================================
// Summary
// ============================================================

setTimeout(() => {
  summary();
  exitWithCode();
}, 200);
