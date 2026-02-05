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
 * ActivityPoller Unit Tests
 *
 * Tests for the NC Activity API poller module.
 * Covers: disabled mode, basic polling, cursor tracking, own-event skipping,
 * type filtering, event classification, error handling, overlap prevention, metrics.
 *
 * Run: node test/unit/nc-flow/activity-poller.test.js
 *
 * @module test/unit/nc-flow/activity-poller
 */

'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

const { ActivityPoller, FILE_TYPE_MAP, SHARE_TYPE_MAP, DECK_TYPE_MAP, OBJECT_TYPE_MAP } = require('../../../src/lib/nc-flow/activity-poller');

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
 * Create a mock NCRequestManager that returns the given activities.
 * @param {Array} [activities=[]] - Activities to return from the mock
 * @returns {Object} Mock NCRequestManager
 */
function createMockNC(activities = []) {
  const calls = [];
  return {
    config: { nextcloud: { user: 'moltagent' } },
    request: async (path, options) => {
      calls.push({ path, options });
      return {
        ocs: {
          data: activities,
        },
      };
    },
    _calls: calls,
  };
}

/**
 * Create a mock NCRequestManager with controllable request function.
 * @param {Function} requestFn - Custom request implementation
 * @returns {Object} Mock NCRequestManager
 */
function createMockNCWithFn(requestFn) {
  return {
    config: { nextcloud: { user: 'moltagent' } },
    request: requestFn,
  };
}

/**
 * Create a sample NC Activity API object.
 * @param {number} id - Activity ID
 * @param {string} type - NC activity type string
 * @param {string} app - Source app name
 * @param {string} [user='alice'] - User who triggered the activity
 * @param {string} [objectName='/test/file.txt'] - Object name/path
 * @returns {Object} Activity object matching NC API shape
 */
function makeActivity(id, type, app, user = 'alice', objectName = '/test/file.txt') {
  return {
    activity_id: id,
    type,
    app,
    user,
    affecteduser: 'moltagent',
    datetime: '2026-02-07T15:30:00+00:00',
    object_type: 'files',
    object_id: id * 100,
    object_name: objectName,
    subject: `${user} did ${type}`,
  };
}

/**
 * Default poller config for testing.
 */
function defaultConfig(overrides = {}) {
  return {
    enabled: true,
    pollIntervalMs: 60000,
    maxEventsPerPoll: 50,
    ignoreOwnEvents: true,
    ignoreUsers: [],
    enabledTypes: [
      'file_created', 'file_changed', 'file_deleted', 'file_shared',
      'calendar_event_created', 'calendar_event_changed',
      'deck_card_created', 'deck_card_updated', 'deck_card_moved',
      'tag_assigned', 'tag_removed',
      'share_created',
    ],
    ...overrides,
  };
}

// ============================================================
// Disabled Mode Tests
// ============================================================

console.log('\n=== ActivityPoller Tests ===\n');
console.log('--- Disabled Mode ---\n');

test('AP-DIS-001: Returns false when disabled', () => {
  const poller = new ActivityPoller({ enabled: false }, createMockNC(), silentLogger);
  assert.strictEqual(poller.start(), false);
});

test('AP-DIS-002: Does not set poll timer when disabled', () => {
  const poller = new ActivityPoller({ enabled: false }, createMockNC(), silentLogger);
  poller.start();
  assert.strictEqual(poller.pollTimer, null);
});

// ============================================================
// Basic Polling Tests
// ============================================================

console.log('\n--- Basic Polling ---\n');

asyncTest('AP-POLL-001: Emits normalized events from Activity API', async () => {
  const nc = createMockNC([
    makeActivity(1, 'file_created', 'files', 'alice', '/Inbox/report.pdf'),
    makeActivity(2, 'file_changed', 'files', 'bob', '/Projects/doc.md'),
  ]);
  const poller = new ActivityPoller(defaultConfig(), nc, silentLogger);
  const events = [];
  poller.on('event', (e) => events.push(e));
  await poller.pollNow();
  assert.strictEqual(events.length, 2);
  assert.strictEqual(events[0].source, 'activity');
  assert.strictEqual(events[0].type, 'file_created');
  assert.strictEqual(events[0].user, 'alice');
  assert.strictEqual(events[0].objectName, '/Inbox/report.pdf');
  assert.strictEqual(events[1].type, 'file_changed');
});

asyncTest('AP-POLL-002: Calls Activity API with correct URL and headers', async () => {
  const nc = createMockNC();
  const poller = new ActivityPoller(defaultConfig(), nc, silentLogger);
  await poller.pollNow();
  assert.ok(nc._calls[0].path.includes('/ocs/v2.php/apps/activity/api/v2/activity'));
  assert.ok(nc._calls[0].path.includes('sort=asc'));
  assert.ok(nc._calls[0].path.includes('limit='));
});

asyncTest('AP-POLL-003: Handles empty activity response', async () => {
  const nc = createMockNC([]);
  const poller = new ActivityPoller(defaultConfig(), nc, silentLogger);
  const events = [];
  poller.on('event', (e) => events.push(e));
  await poller.pollNow();
  assert.strictEqual(events.length, 0);
  assert.strictEqual(poller.metrics.totalPolls, 1);
});

// ============================================================
// Cursor Tracking Tests
// ============================================================

console.log('\n--- Cursor Tracking ---\n');

asyncTest('AP-CUR-001: Tracks lastActivityId for pagination', async () => {
  const nc = createMockNC([
    makeActivity(10, 'file_created', 'files'),
    makeActivity(15, 'file_changed', 'files'),
  ]);
  const poller = new ActivityPoller(defaultConfig({ ignoreOwnEvents: false }), nc, silentLogger);
  await poller.pollNow();
  assert.strictEqual(poller.lastActivityId, 15);
});

asyncTest('AP-CUR-002: Includes since parameter on subsequent polls', async () => {
  const nc = createMockNC([makeActivity(15, 'file_created', 'files')]);
  const poller = new ActivityPoller(defaultConfig({ ignoreOwnEvents: false }), nc, silentLogger);
  await poller.pollNow();
  await poller.pollNow();
  assert.ok(nc._calls[1].path.includes('since=15'));
});

asyncTest('AP-CUR-003: Updates cursor to highest ID even if activities are out of order', async () => {
  const nc = createMockNC([
    makeActivity(20, 'file_created', 'files'),
    makeActivity(10, 'file_changed', 'files'),
    makeActivity(25, 'file_deleted', 'files'),
  ]);
  const poller = new ActivityPoller(defaultConfig({ ignoreOwnEvents: false }), nc, silentLogger);
  await poller.pollNow();
  assert.strictEqual(poller.lastActivityId, 25);
});

// ============================================================
// Own-Event Skipping Tests
// ============================================================

console.log('\n--- Own-Event Skipping ---\n');

asyncTest('AP-OWN-001: Skips events from moltagent user when ignoreOwnEvents=true', async () => {
  const nc = createMockNC([
    makeActivity(1, 'file_created', 'files', 'moltagent'),
    makeActivity(2, 'file_created', 'files', 'alice'),
  ]);
  const poller = new ActivityPoller(defaultConfig({ ignoreOwnEvents: true }), nc, silentLogger);
  const events = [];
  poller.on('event', (e) => events.push(e));
  await poller.pollNow();
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].user, 'alice');
  assert.strictEqual(poller.metrics.skippedOwn, 1);
});

asyncTest('AP-OWN-002: Does not skip own events when ignoreOwnEvents=false', async () => {
  const nc = createMockNC([makeActivity(1, 'file_created', 'files', 'moltagent')]);
  const poller = new ActivityPoller(defaultConfig({ ignoreOwnEvents: false }), nc, silentLogger);
  const events = [];
  poller.on('event', (e) => events.push(e));
  await poller.pollNow();
  assert.strictEqual(events.length, 1);
  assert.strictEqual(poller.metrics.skippedOwn, 0);
});

asyncTest('AP-OWN-003: Skips events from users in ignoreUsers list', async () => {
  const nc = createMockNC([
    makeActivity(1, 'file_created', 'files', 'bot-admin'),
    makeActivity(2, 'file_created', 'files', 'alice'),
  ]);
  const poller = new ActivityPoller(defaultConfig({ ignoreUsers: ['bot-admin'] }), nc, silentLogger);
  const events = [];
  poller.on('event', (e) => events.push(e));
  await poller.pollNow();
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].user, 'alice');
});

// ============================================================
// Type Filtering Tests
// ============================================================

console.log('\n--- Type Filtering ---\n');

asyncTest('AP-TYPE-001: Only emits enabled event types', async () => {
  const nc = createMockNC([
    makeActivity(1, 'file_created', 'files'),
    makeActivity(2, 'file_deleted', 'files'),
  ]);
  const poller = new ActivityPoller(defaultConfig({ enabledTypes: ['file_created'], ignoreOwnEvents: false }), nc, silentLogger);
  const events = [];
  poller.on('event', (e) => events.push(e));
  await poller.pollNow();
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].type, 'file_created');
});

asyncTest('AP-TYPE-002: Emits all types when enabledTypes is null/undefined', async () => {
  const nc = createMockNC([
    makeActivity(1, 'file_created', 'files'),
    makeActivity(2, 'file_deleted', 'files'),
    makeActivity(3, 'deck_card_create', 'deck'),
  ]);
  const poller = new ActivityPoller(defaultConfig({ enabledTypes: undefined, ignoreOwnEvents: false }), nc, silentLogger);
  const events = [];
  poller.on('event', (e) => events.push(e));
  await poller.pollNow();
  assert.strictEqual(events.length, 3);
});

// ============================================================
// Event Classification Tests
// ============================================================

console.log('\n--- Event Classification ---\n');

test('AP-CLASS-001: Classifies all known file activity types', () => {
  const poller = new ActivityPoller(defaultConfig(), createMockNC(), silentLogger);
  for (const [activityType, expected] of Object.entries(FILE_TYPE_MAP)) {
    assert.strictEqual(poller._classifyActivityType(activityType, 'files'), expected);
  }
});

test('AP-CLASS-002: Classifies sharing activity types', () => {
  const poller = new ActivityPoller(defaultConfig(), createMockNC(), silentLogger);
  assert.strictEqual(poller._classifyActivityType('shared_with_by', 'files_sharing'), 'share_created');
  assert.strictEqual(poller._classifyActivityType('public_links', 'files_sharing'), 'file_shared');
  assert.strictEqual(poller._classifyActivityType('shared_user_self', 'files_sharing'), 'share_created');
});

test('AP-CLASS-003: Classifies deck activity types', () => {
  const poller = new ActivityPoller(defaultConfig(), createMockNC(), silentLogger);
  assert.strictEqual(poller._classifyActivityType('deck_card_create', 'deck'), 'deck_card_created');
  assert.strictEqual(poller._classifyActivityType('deck_card_move', 'deck'), 'deck_card_moved');
  assert.strictEqual(poller._classifyActivityType('deck_card_update', 'deck'), 'deck_card_updated');
  assert.strictEqual(poller._classifyActivityType('deck_comment_create', 'deck'), 'deck_comment_added');
});

test('AP-CLASS-004: Classifies calendar activity types', () => {
  const poller = new ActivityPoller(defaultConfig(), createMockNC(), silentLogger);
  assert.strictEqual(poller._classifyActivityType('calendar_event', 'dav'), 'calendar_event_changed');
  assert.strictEqual(poller._classifyActivityType('calendar_todo', 'calendar'), 'calendar_todo_changed');
});

test('AP-CLASS-005: Classifies tag activity types', () => {
  const poller = new ActivityPoller(defaultConfig(), createMockNC(), silentLogger);
  assert.strictEqual(poller._classifyActivityType('systemtag_assign', 'systemtags'), 'tag_assigned');
  assert.strictEqual(poller._classifyActivityType('systemtag_unassign', 'systemtags'), 'tag_removed');
});

test('AP-CLASS-006: Falls back to app-based classification', () => {
  const poller = new ActivityPoller(defaultConfig(), createMockNC(), silentLogger);
  assert.strictEqual(poller._classifyActivityType('unknown_type', 'files'), 'file_changed');
  assert.strictEqual(poller._classifyActivityType('unknown_type', 'deck'), 'deck_card_updated');
  assert.strictEqual(poller._classifyActivityType('unknown_type', 'dav'), 'calendar_event_changed');
});

test('AP-CLASS-007: Returns "unknown" for unrecognized types', () => {
  const poller = new ActivityPoller(defaultConfig(), createMockNC(), silentLogger);
  assert.strictEqual(poller._classifyActivityType('unknown_type', 'unknown_app'), 'unknown');
});

// ============================================================
// Object Type Mapping Tests
// ============================================================

console.log('\n--- Object Type Mapping ---\n');

test('AP-OBJ-001: Maps NC object types correctly', () => {
  const poller = new ActivityPoller(defaultConfig(), createMockNC(), silentLogger);
  for (const [ncType, expected] of Object.entries(OBJECT_TYPE_MAP)) {
    assert.strictEqual(poller._mapObjectType(ncType), expected);
  }
});

test('AP-OBJ-002: Falls back to raw object type for unknown values', () => {
  const poller = new ActivityPoller(defaultConfig(), createMockNC(), silentLogger);
  assert.strictEqual(poller._mapObjectType('some_custom_type'), 'some_custom_type');
});

test('AP-OBJ-003: Returns "unknown" for null/undefined object type', () => {
  const poller = new ActivityPoller(defaultConfig(), createMockNC(), silentLogger);
  assert.strictEqual(poller._mapObjectType(null), 'unknown');
  assert.strictEqual(poller._mapObjectType(undefined), 'unknown');
});

// ============================================================
// Error Handling Tests
// ============================================================

console.log('\n--- Error Handling ---\n');

asyncTest('AP-ERR-001: Continues polling after API error', async () => {
  let callCount = 0;
  const nc = createMockNCWithFn(async () => {
    callCount++;
    if (callCount === 1) throw new Error('Network timeout');
    return { ocs: { data: [makeActivity(1, 'file_created', 'files', 'alice')] } };
  });
  const poller = new ActivityPoller(defaultConfig({ ignoreOwnEvents: false }), nc, silentLogger);
  const events = [];
  poller.on('event', (e) => events.push(e));
  await poller.pollNow();
  assert.strictEqual(poller.metrics.errors, 1);
  assert.strictEqual(events.length, 0);
  await poller.pollNow();
  assert.strictEqual(events.length, 1);
});

asyncTest('AP-ERR-002: Does not throw on API error', async () => {
  const nc = createMockNCWithFn(async () => {
    throw new Error('Network error');
  });
  const poller = new ActivityPoller(defaultConfig(), nc, silentLogger);
  await poller.pollNow();
  assert.strictEqual(poller.metrics.errors, 1);
});

asyncTest('AP-ERR-003: Increments error count on each failure', async () => {
  const nc = createMockNCWithFn(async () => {
    throw new Error('Network error');
  });
  const poller = new ActivityPoller(defaultConfig(), nc, silentLogger);
  await poller.pollNow();
  await poller.pollNow();
  await poller.pollNow();
  assert.strictEqual(poller.metrics.errors, 3);
});

// ============================================================
// Overlap Prevention Tests
// ============================================================

console.log('\n--- Overlap Prevention ---\n');

asyncTest('AP-OVER-001: Skips poll if previous poll still running', async () => {
  let resolveFirst;
  let callCount = 0;
  const nc = createMockNCWithFn(async () => {
    callCount++;
    if (callCount === 1) return new Promise(resolve => { resolveFirst = () => resolve({ ocs: { data: [] } }); });
    return { ocs: { data: [] } };
  });
  const poller = new ActivityPoller(defaultConfig(), nc, silentLogger);
  const poll1 = poller.pollNow();
  await poller.pollNow();
  assert.strictEqual(callCount, 1);
  resolveFirst();
  await poll1;
});

// ============================================================
// Metrics Tests
// ============================================================

console.log('\n--- Metrics ---\n');

asyncTest('AP-MET-001: Tracks accurate metrics', async () => {
  const nc = createMockNC([
    makeActivity(1, 'file_created', 'files', 'moltagent'),
    makeActivity(2, 'file_created', 'files', 'alice'),
    makeActivity(3, 'file_deleted', 'files', 'bob'),
  ]);
  const poller = new ActivityPoller(defaultConfig({ enabledTypes: ['file_created'] }), nc, silentLogger);
  poller.on('event', () => {});
  await poller.pollNow();
  const metrics = poller.getMetrics();
  assert.strictEqual(metrics.totalPolls, 1);
  assert.strictEqual(metrics.totalEvents, 3);
  assert.strictEqual(metrics.skippedOwn, 1);
  assert.strictEqual(metrics.emittedEvents, 1);
});

test('AP-MET-002: getMetrics includes all expected fields', () => {
  const poller = new ActivityPoller(defaultConfig(), createMockNC(), silentLogger);
  const metrics = poller.getMetrics();
  assert.ok('totalPolls' in metrics);
  assert.ok('totalEvents' in metrics);
  assert.ok('emittedEvents' in metrics);
  assert.ok('skippedOwn' in metrics);
  assert.ok('errors' in metrics);
  assert.ok('lastActivityId' in metrics);
  assert.ok('enabled' in metrics);
  assert.ok('polling' in metrics);
});

test('AP-MET-003: Initial metrics are all zero', () => {
  const poller = new ActivityPoller(defaultConfig(), createMockNC(), silentLogger);
  const metrics = poller.getMetrics();
  assert.strictEqual(metrics.totalPolls, 0);
  assert.strictEqual(metrics.totalEvents, 0);
  assert.strictEqual(metrics.emittedEvents, 0);
  assert.strictEqual(metrics.skippedOwn, 0);
  assert.strictEqual(metrics.errors, 0);
  assert.strictEqual(metrics.lastActivityId, null);
  assert.strictEqual(metrics.polling, false);
});

// ============================================================
// Activity Normalization Tests
// ============================================================

console.log('\n--- Activity Normalization ---\n');

test('AP-ANORM-001: _normalizeActivity returns correct NCFlowEvent shape', () => {
  const poller = new ActivityPoller(defaultConfig(), createMockNC(), silentLogger);
  const activity = makeActivity(42, 'file_created', 'files', 'alice');
  const event = poller._normalizeActivity(activity);
  assert.ok('id' in event);
  assert.ok('source' in event);
  assert.ok('type' in event);
  assert.ok('user' in event);
  assert.ok('timestamp' in event);
  assert.ok('objectType' in event);
  assert.ok('objectId' in event);
  assert.ok('objectName' in event);
  assert.ok('data' in event);
  assert.ok('activityId' in event.data);
  assert.ok('app' in event.data);
  assert.ok('subject' in event.data);
  assert.ok('rawType' in event.data);
  assert.ok('affectedUser' in event.data);
});

test('AP-ANORM-002: Event ID format is activity:{activity_id}', () => {
  const poller = new ActivityPoller(defaultConfig(), createMockNC(), silentLogger);
  const activity = makeActivity(42, 'file_created', 'files');
  const event = poller._normalizeActivity(activity);
  assert.strictEqual(event.id, 'activity:42');
});

test('AP-ANORM-003: Source is always "activity"', () => {
  const poller = new ActivityPoller(defaultConfig(), createMockNC(), silentLogger);
  const activity = makeActivity(1, 'file_created', 'files');
  const event = poller._normalizeActivity(activity);
  assert.strictEqual(event.source, 'activity');
});

test('AP-ANORM-004: Timestamp is parsed from ISO 8601 datetime', () => {
  const poller = new ActivityPoller(defaultConfig(), createMockNC(), silentLogger);
  const activity = makeActivity(1, 'file_created', 'files');
  const event = poller._normalizeActivity(activity);
  assert.strictEqual(event.timestamp, new Date('2026-02-07T15:30:00+00:00').getTime());
});

test('AP-ANORM-005: Falls back to affecteduser when user is missing', () => {
  const poller = new ActivityPoller(defaultConfig(), createMockNC(), silentLogger);
  const activity = {
    activity_id: 1,
    type: 'file_created',
    app: 'files',
    user: null,
    affecteduser: 'bob',
    datetime: '2026-02-07T15:30:00+00:00',
    object_type: 'files',
    object_id: 100,
    object_name: '/test/file.txt',
    subject: 'test'
  };
  const event = poller._normalizeActivity(activity);
  assert.strictEqual(event.user, 'bob');
});

// ============================================================
// Exported Maps Completeness
// ============================================================

console.log('\n--- Type Map Completeness ---\n');

test('AP-MAPS-001: FILE_TYPE_MAP covers expected file activity types', () => {
  assert.ok(FILE_TYPE_MAP['file_created'] === 'file_created');
  assert.ok(FILE_TYPE_MAP['file_changed'] === 'file_changed');
  assert.ok(FILE_TYPE_MAP['file_deleted'] === 'file_deleted');
  assert.ok(FILE_TYPE_MAP['file_restored'] === 'file_restored');
  assert.ok(FILE_TYPE_MAP['file_moved'] === 'file_changed');
});

test('AP-MAPS-002: SHARE_TYPE_MAP covers expected sharing types', () => {
  assert.ok(SHARE_TYPE_MAP['shared_with_by'] === 'share_created');
  assert.ok(SHARE_TYPE_MAP['public_links'] === 'file_shared');
});

test('AP-MAPS-003: DECK_TYPE_MAP covers expected deck types', () => {
  assert.ok(DECK_TYPE_MAP['deck_card_create'] === 'deck_card_created');
  assert.ok(DECK_TYPE_MAP['deck_card_move'] === 'deck_card_moved');
});

test('AP-MAPS-004: OBJECT_TYPE_MAP covers expected object types', () => {
  assert.ok(OBJECT_TYPE_MAP['files'] === 'file');
  assert.ok(OBJECT_TYPE_MAP['calendar'] === 'calendar');
  assert.ok(OBJECT_TYPE_MAP['deck_card'] === 'deck_card');
  assert.ok(OBJECT_TYPE_MAP['share'] === 'share');
  assert.ok(OBJECT_TYPE_MAP['systemtag'] === 'tag');
});

// ============================================================
// Summary
// ============================================================

setTimeout(() => {
  summary();
  exitWithCode();
}, 200);
