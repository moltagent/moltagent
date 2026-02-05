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
 * WebhookReceiver Unit Tests
 *
 * Tests for the dormant NC webhook receiver module.
 * Covers: dormant mode, server lifecycle, event routing, auth verification,
 * IP filtering, malformed payload handling, event normalization.
 *
 * Run: node test/unit/nc-flow/webhook-receiver.test.js
 *
 * @module test/unit/nc-flow/webhook-receiver
 */

'use strict';

const assert = require('assert');
const http = require('http');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

const { WebhookReceiver, WEBHOOK_EVENT_MAP } = require('../../../src/lib/nc-flow/webhook-receiver');

// ============================================================
// Test Helpers
// ============================================================

/**
 * Silent logger that suppresses output during tests.
 */
const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

/**
 * Send an HTTP POST request to the receiver.
 * @param {number} port - Target port
 * @param {string} path - URL path
 * @param {Object|string} body - Request body (will be JSON.stringify'd if object)
 * @param {Object} [headers={}] - Additional headers
 * @returns {Promise<{status: number, body: string}>}
 */
function sendRequest(port, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const options = {
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Create a default enabled config for testing (port 0 = random port).
 */
function enabledConfig(overrides = {}) {
  return {
    enabled: true,
    port: 0,
    host: '127.0.0.1',
    secret: '',
    trustedIPs: [],
    shutdownTimeoutMs: 1000,
    ...overrides,
  };
}

/**
 * Sample valid webhook payload (file restored event).
 */
const SAMPLE_FILE_RESTORED_PAYLOAD = {
  event: 'OCA\\Files_Trashbin\\Events\\NodeRestoredEvent',
  user: { uid: 'moltagent' },
  node: { id: 42, path: '/moltagent/file.txt', name: 'file.txt' },
  time: 1707350400,
};

/**
 * Sample valid webhook payload (file created event).
 */
const SAMPLE_FILE_CREATED_PAYLOAD = {
  event: 'OCP\\Files\\Events\\NodeCreatedEvent',
  user: { uid: 'alice' },
  node: { id: 100, path: '/alice/Documents/report.pdf', name: 'report.pdf', mimetype: 'application/pdf' },
  time: 1707350500,
};

// ============================================================
// Dormant Mode Tests
// ============================================================

console.log('\n=== WebhookReceiver Tests ===\n');
console.log('--- Dormant Mode ---\n');

asyncTest('WH-DORM-001: Returns false and does not start server when disabled', async () => {
  const receiver = new WebhookReceiver({ enabled: false }, silentLogger);
  const result = await receiver.start();
  assert.strictEqual(result, false);
  assert.strictEqual(receiver.server, null);
});

asyncTest('WH-DORM-002: Constructor defaults to disabled when config.enabled is undefined', async () => {
  const receiver = new WebhookReceiver({}, silentLogger);
  assert.strictEqual(receiver.enabled, false);
});

// ============================================================
// Server Lifecycle Tests
// ============================================================

console.log('\n--- Server Lifecycle ---\n');

asyncTest('WH-LIFE-001: Starts and stops HTTP server when enabled', async () => {
  const receiver = new WebhookReceiver(enabledConfig(), silentLogger);
  try {
    await receiver.start();
    assert.ok(receiver.server !== null);
    assert.strictEqual(receiver.server.listening, true);
    await receiver.stop();
    assert.strictEqual(receiver.server.listening, false);
  } finally {
    await receiver.stop();
  }
});

asyncTest('WH-LIFE-002: start() returns true when server starts successfully', async () => {
  const receiver = new WebhookReceiver(enabledConfig(), silentLogger);
  try {
    const result = await receiver.start();
    assert.strictEqual(result, true);
  } finally {
    await receiver.stop();
  }
});

asyncTest('WH-LIFE-003: stop() is safe to call when server is null', async () => {
  const receiver = new WebhookReceiver({ enabled: false }, silentLogger);
  await receiver.stop();
  // Should not throw
  assert.ok(true);
});

// ============================================================
// Event Routing Tests
// ============================================================

console.log('\n--- Event Routing ---\n');

asyncTest('WH-ROUTE-001: Emits normalized event on valid webhook POST', async () => {
  const receiver = new WebhookReceiver(enabledConfig(), silentLogger);
  try {
    await receiver.start();
    const port = receiver.server.address().port;
    const events = [];
    receiver.on('event', (e) => events.push(e));
    await sendRequest(port, '/webhooks/nc', SAMPLE_FILE_RESTORED_PAYLOAD);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].source, 'webhook');
    assert.strictEqual(events[0].type, 'file_restored');
    assert.strictEqual(events[0].user, 'moltagent');
    assert.strictEqual(events[0].objectType, 'file');
    assert.strictEqual(events[0].objectId, '42');
  } finally {
    await receiver.stop();
  }
});

asyncTest('WH-ROUTE-002: Emits event with correct data fields', async () => {
  const receiver = new WebhookReceiver(enabledConfig(), silentLogger);
  try {
    await receiver.start();
    const port = receiver.server.address().port;
    const events = [];
    receiver.on('event', (e) => events.push(e));
    await sendRequest(port, '/webhooks/nc', SAMPLE_FILE_CREATED_PAYLOAD);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].data.eventClass, 'OCP\\Files\\Events\\NodeCreatedEvent');
    assert.strictEqual(events[0].data.path, '/alice/Documents/report.pdf');
    assert.strictEqual(events[0].data.mimeType, 'application/pdf');
    assert.ok(events[0].data.raw);
  } finally {
    await receiver.stop();
  }
});

asyncTest('WH-ROUTE-003: Does not emit event when payload has no event field', async () => {
  const receiver = new WebhookReceiver(enabledConfig(), silentLogger);
  try {
    await receiver.start();
    const port = receiver.server.address().port;
    const events = [];
    receiver.on('event', (e) => events.push(e));
    await sendRequest(port, '/webhooks/nc', { user: { uid: 'test' }, time: 1707350400 });
    assert.strictEqual(events.length, 0);
  } finally {
    await receiver.stop();
  }
});

asyncTest('WH-ROUTE-004: Responds 200 even for unknown event types', async () => {
  const receiver = new WebhookReceiver(enabledConfig(), silentLogger);
  try {
    await receiver.start();
    const port = receiver.server.address().port;
    const res = await sendRequest(port, '/webhooks/nc', {
      event: 'Unknown\\Event\\Class',
      user: { uid: 'test' },
      time: 1707350400
    });
    assert.strictEqual(res.status, 200);
  } finally {
    await receiver.stop();
  }
});

// ============================================================
// Path and Method Filtering Tests
// ============================================================

console.log('\n--- Path and Method Filtering ---\n');

asyncTest('WH-PATH-001: Returns 404 for non-webhook paths', async () => {
  const receiver = new WebhookReceiver(enabledConfig(), silentLogger);
  try {
    await receiver.start();
    const port = receiver.server.address().port;
    const res = await sendRequest(port, '/other/path', {});
    assert.strictEqual(res.status, 404);
  } finally {
    await receiver.stop();
  }
});

asyncTest('WH-PATH-002: Returns 404 for GET requests to /webhooks/nc', async () => {
  const receiver = new WebhookReceiver(enabledConfig(), silentLogger);
  try {
    await receiver.start();
    const port = receiver.server.address().port;
    const res = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/webhooks/nc',
        method: 'GET'
      }, (r) => {
        let data = '';
        r.on('data', (c) => data += c);
        r.on('end', () => resolve({ status: r.statusCode, body: data }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.strictEqual(res.status, 404);
  } finally {
    await receiver.stop();
  }
});

// ============================================================
// Secret Verification Tests
// ============================================================

console.log('\n--- Secret Verification ---\n');

asyncTest('WH-SEC-001: Rejects request with wrong secret', async () => {
  const receiver = new WebhookReceiver(enabledConfig({ secret: 'my-secret-token' }), silentLogger);
  try {
    await receiver.start();
    const port = receiver.server.address().port;
    const res = await sendRequest(port, '/webhooks/nc', { event: 'test' }, {
      'x-webhook-secret': 'wrong-secret'
    });
    assert.strictEqual(res.status, 401);
  } finally {
    await receiver.stop();
  }
});

asyncTest('WH-SEC-002: Accepts request with correct secret', async () => {
  const receiver = new WebhookReceiver(enabledConfig({ secret: 'my-secret-token' }), silentLogger);
  try {
    await receiver.start();
    const port = receiver.server.address().port;
    const res = await sendRequest(port, '/webhooks/nc', SAMPLE_FILE_RESTORED_PAYLOAD, {
      'x-webhook-secret': 'my-secret-token'
    });
    assert.strictEqual(res.status, 200);
  } finally {
    await receiver.stop();
  }
});

asyncTest('WH-SEC-003: Accepts request when no secret is configured', async () => {
  const receiver = new WebhookReceiver(enabledConfig({ secret: '' }), silentLogger);
  try {
    await receiver.start();
    const port = receiver.server.address().port;
    const res = await sendRequest(port, '/webhooks/nc', SAMPLE_FILE_RESTORED_PAYLOAD);
    assert.strictEqual(res.status, 200);
  } finally {
    await receiver.stop();
  }
});

asyncTest('WH-SEC-004: Rejects request with missing secret header when secret is configured', async () => {
  const receiver = new WebhookReceiver(enabledConfig({ secret: 'required-token' }), silentLogger);
  try {
    await receiver.start();
    const port = receiver.server.address().port;
    const res = await sendRequest(port, '/webhooks/nc', SAMPLE_FILE_RESTORED_PAYLOAD);
    assert.strictEqual(res.status, 401);
  } finally {
    await receiver.stop();
  }
});

// ============================================================
// Malformed Payload Tests
// ============================================================

console.log('\n--- Malformed Payload ---\n');

asyncTest('WH-MAL-001: Returns 400 for invalid JSON', async () => {
  const receiver = new WebhookReceiver(enabledConfig(), silentLogger);
  try {
    await receiver.start();
    const port = receiver.server.address().port;
    const res = await sendRequest(port, '/webhooks/nc', 'not json at all');
    assert.strictEqual(res.status, 400);
  } finally {
    await receiver.stop();
  }
});

asyncTest('WH-MAL-002: Returns 400 for empty body', async () => {
  const receiver = new WebhookReceiver(enabledConfig(), silentLogger);
  try {
    await receiver.start();
    const port = receiver.server.address().port;
    const res = await sendRequest(port, '/webhooks/nc', '');
    assert.strictEqual(res.status, 400);
  } finally {
    await receiver.stop();
  }
});

// ============================================================
// Event Normalization Tests
// ============================================================

console.log('\n--- Event Normalization ---\n');

asyncTest('WH-NORM-001: Normalizes unknown events as type "unknown"', async () => {
  const receiver = new WebhookReceiver(enabledConfig(), silentLogger);
  try {
    await receiver.start();
    const port = receiver.server.address().port;
    const events = [];
    receiver.on('event', (e) => events.push(e));
    await sendRequest(port, '/webhooks/nc', {
      event: 'Some\\Future\\EventClass',
      user: { uid: 'test' },
      time: 1707350400
    });
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].type, 'unknown');
    assert.strictEqual(events[0].data.eventClass, 'Some\\Future\\EventClass');
  } finally {
    await receiver.stop();
  }
});

test('WH-NORM-002: Maps all known file event classes correctly', () => {
  const receiver = new WebhookReceiver({ enabled: false }, silentLogger);
  const fileEvents = [
    'OCP\\Files\\Events\\NodeCreatedEvent',
    'OCA\\Files\\Events\\NodeCreatedEvent',
    'OCP\\Files\\Events\\NodeWrittenEvent',
    'OCP\\Files\\Events\\NodeDeletedEvent',
    'OCA\\Files_Trashbin\\Events\\NodeRestoredEvent'
  ];
  for (const eventClass of fileEvents) {
    const event = receiver._normalizeWebhookPayload({
      event: eventClass,
      user: { uid: 'test' },
      node: { id: 1 },
      time: 1707350400
    });
    assert.ok(WEBHOOK_EVENT_MAP[eventClass]);
    assert.strictEqual(event.objectType, 'file');
  }
});

test('WH-NORM-003: Maps calendar event classes correctly', () => {
  const receiver = new WebhookReceiver({ enabled: false }, silentLogger);
  const testCases = [
    ['OCA\\DAV\\Events\\CalendarObjectCreatedEvent', 'calendar_event_created'],
    ['OCA\\DAV\\Events\\CalendarObjectUpdatedEvent', 'calendar_event_changed'],
    ['OCA\\DAV\\Events\\CalendarObjectDeletedEvent', 'calendar_event_deleted']
  ];
  for (const [eventClass, expectedType] of testCases) {
    const event = receiver._normalizeWebhookPayload({
      event: eventClass,
      user: { uid: 'test' },
      time: 1707350400
    });
    assert.strictEqual(event.type, expectedType);
    assert.strictEqual(event.objectType, 'calendar');
  }
});

test('WH-NORM-004: Maps deck event classes correctly', () => {
  const receiver = new WebhookReceiver({ enabled: false }, silentLogger);
  const testCases = [
    ['OCA\\Deck\\Event\\CardCreatedEvent', 'deck_card_created'],
    ['OCA\\Deck\\Event\\CardUpdatedEvent', 'deck_card_updated']
  ];
  for (const [eventClass, expectedType] of testCases) {
    const event = receiver._normalizeWebhookPayload({
      event: eventClass,
      user: { uid: 'test' },
      time: 1707350400
    });
    assert.strictEqual(event.type, expectedType);
    assert.strictEqual(event.objectType, 'deck_card');
  }
});

test('WH-NORM-005: Maps sharing event classes correctly', () => {
  const receiver = new WebhookReceiver({ enabled: false }, silentLogger);
  const event = receiver._normalizeWebhookPayload({
    event: 'OCP\\Share\\Events\\ShareCreatedEvent',
    user: { uid: 'test' },
    time: 1707350400
  });
  assert.strictEqual(event.type, 'share_created');
  assert.strictEqual(event.objectType, 'share');
});

test('WH-NORM-006: Maps tag event classes correctly', () => {
  const receiver = new WebhookReceiver({ enabled: false }, silentLogger);
  const testCases = [
    ['OCP\\SystemTag\\Events\\SystemTagMappedEvent', 'tag_assigned'],
    ['OCP\\SystemTag\\Events\\SystemTagUnmappedEvent', 'tag_removed']
  ];
  for (const [eventClass, expectedType] of testCases) {
    const event = receiver._normalizeWebhookPayload({
      event: eventClass,
      user: { uid: 'test' },
      time: 1707350400
    });
    assert.strictEqual(event.type, expectedType);
    assert.strictEqual(event.objectType, 'tag');
  }
});

test('WH-NORM-007: _inferObjectType returns correct types', () => {
  const receiver = new WebhookReceiver({ enabled: false }, silentLogger);
  assert.strictEqual(receiver._inferObjectType('OCP\\Files\\Events\\NodeCreatedEvent'), 'file');
  assert.strictEqual(receiver._inferObjectType('OCA\\Files_Trashbin\\Events\\NodeRestoredEvent'), 'file');
  assert.strictEqual(receiver._inferObjectType('OCA\\DAV\\Events\\CalendarObjectCreatedEvent'), 'calendar');
  assert.strictEqual(receiver._inferObjectType('OCP\\Share\\Events\\ShareCreatedEvent'), 'share');
  assert.strictEqual(receiver._inferObjectType('OCA\\Deck\\Event\\CardCreatedEvent'), 'deck_card');
  assert.strictEqual(receiver._inferObjectType('OCP\\SystemTag\\Events\\SystemTagMappedEvent'), 'tag');
  assert.strictEqual(receiver._inferObjectType('Some\\Other\\Event'), 'unknown');
});

test('WH-NORM-008: Returns null for payload with no event field', () => {
  const receiver = new WebhookReceiver({ enabled: false }, silentLogger);
  assert.strictEqual(receiver._normalizeWebhookPayload({}), null);
  assert.strictEqual(receiver._normalizeWebhookPayload(null), null);
});

test('WH-NORM-009: Extracts user from payload.user.uid', () => {
  const receiver = new WebhookReceiver({ enabled: false }, silentLogger);
  const event = receiver._normalizeWebhookPayload({
    event: 'OCP\\Files\\Events\\NodeCreatedEvent',
    user: { uid: 'testuser' },
    time: 1707350400
  });
  assert.strictEqual(event.user, 'testuser');
});

test('WH-NORM-010: Falls back to user.id when uid is missing', () => {
  const receiver = new WebhookReceiver({ enabled: false }, silentLogger);
  const event = receiver._normalizeWebhookPayload({
    event: 'OCP\\Files\\Events\\NodeCreatedEvent',
    user: { id: 'alt-user' },
    time: 1707350400
  });
  assert.strictEqual(event.user, 'alt-user');
});

test('WH-NORM-011: Falls back to "unknown" when user is missing', () => {
  const receiver = new WebhookReceiver({ enabled: false }, silentLogger);
  const event = receiver._normalizeWebhookPayload({
    event: 'OCP\\Files\\Events\\NodeCreatedEvent',
    time: 1707350400
  });
  assert.strictEqual(event.user, 'unknown');
});

test('WH-NORM-012: Computes timestamp correctly from payload.time (seconds)', () => {
  const receiver = new WebhookReceiver({ enabled: false }, silentLogger);
  const event = receiver._normalizeWebhookPayload({
    event: 'OCP\\Files\\Events\\NodeCreatedEvent',
    user: { uid: 'test' },
    time: 1707350400
  });
  assert.strictEqual(event.timestamp, 1707350400000);
});

test('WH-NORM-013: Falls back to Date.now() when payload.time is missing', () => {
  const receiver = new WebhookReceiver({ enabled: false }, silentLogger);
  const now = Date.now();
  const event = receiver._normalizeWebhookPayload({
    event: 'OCP\\Files\\Events\\NodeCreatedEvent',
    user: { uid: 'test' }
  });
  assert.ok(Math.abs(event.timestamp - now) < 5000);
});

// ============================================================
// WEBHOOK_EVENT_MAP Completeness Check
// ============================================================

console.log('\n--- Event Map ---\n');

test('WH-MAP-001: WEBHOOK_EVENT_MAP covers all expected event classes', () => {
  assert.ok(Object.keys(WEBHOOK_EVENT_MAP).length >= 17);
});

// ============================================================
// Summary
// ============================================================

setTimeout(() => {
  summary();
  exitWithCode();
}, 200);
