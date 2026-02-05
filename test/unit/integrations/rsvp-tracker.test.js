/**
 * RSVPTracker Unit Tests
 *
 * Run: node test/unit/integrations/rsvp-tracker.test.js
 *
 * @module test/unit/integrations/rsvp-tracker
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const { createMockCalDAVClient, createMockNotifyUser, createMockAuditLog } = require('../../helpers/mock-factories');

// Import module under test
const RSVPTracker = require('../../../src/lib/integrations/rsvp-tracker');

// ============================================================
// Test Fixtures
// ============================================================

const SAMPLE_ATTENDEES = [
  { email: 'alice@company.com', name: 'Alice' },
  { email: 'bob@company.com', name: 'Bob' }
];

const SAMPLE_EVENT_END = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // tomorrow

const PAST_EVENT_END = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2 hours ago

// ============================================================
// Tests
// ============================================================

console.log('RSVPTracker Unit Tests');
console.log('======================\n');

// --- Constructor ---

test('constructor requires caldavClient', () => {
  assert.throws(() => new RSVPTracker(), /requires a CalDAVClient/);
  assert.throws(() => new RSVPTracker({}), /requires a CalDAVClient/);
});

test('constructor accepts config with caldavClient', () => {
  const caldav = createMockCalDAVClient();
  const tracker = new RSVPTracker({ caldavClient: caldav });
  assert.ok(tracker);
  assert.strictEqual(tracker.caldavClient, caldav);
  assert.strictEqual(tracker.checkIntervalMs, 300000);
  assert.strictEqual(tracker.expiryBufferMs, 3600000);
  assert.strictEqual(tracker.trackedCount, 0);
});

test('constructor accepts custom intervals', () => {
  const caldav = createMockCalDAVClient();
  const tracker = new RSVPTracker({
    caldavClient: caldav,
    checkIntervalMs: 60000,
    expiryBufferMs: 1800000
  });
  assert.strictEqual(tracker.checkIntervalMs, 60000);
  assert.strictEqual(tracker.expiryBufferMs, 1800000);
});

// --- trackEvent ---

test('trackEvent adds event to pendingEvents', () => {
  const caldav = createMockCalDAVClient();
  const tracker = new RSVPTracker({ caldavClient: caldav });

  tracker.trackEvent('uid-1', 'personal', SAMPLE_ATTENDEES, 'Team Meeting', SAMPLE_EVENT_END);
  assert.strictEqual(tracker.trackedCount, 1);

  const tracked = tracker.pendingEvents.get('uid-1');
  assert.ok(tracked);
  assert.strictEqual(tracked.uid, 'uid-1');
  assert.strictEqual(tracked.calendarId, 'personal');
  assert.strictEqual(tracked.summary, 'Team Meeting');
  assert.strictEqual(tracked.attendees.length, 2);
  assert.strictEqual(tracked.attendees[0].email, 'alice@company.com');
  assert.strictEqual(tracked.attendees[0].lastStatus, 'NEEDS-ACTION');
  assert.strictEqual(tracked.attendees[0].respondedAt, null);
});

// --- untrackEvent ---

test('untrackEvent removes event', () => {
  const caldav = createMockCalDAVClient();
  const tracker = new RSVPTracker({ caldavClient: caldav });

  tracker.trackEvent('uid-1', 'personal', SAMPLE_ATTENDEES, 'Meeting', SAMPLE_EVENT_END);
  assert.strictEqual(tracker.trackedCount, 1);

  const removed = tracker.untrackEvent('uid-1');
  assert.strictEqual(removed, true);
  assert.strictEqual(tracker.trackedCount, 0);
});

test('untrackEvent returns false for unknown uid', () => {
  const caldav = createMockCalDAVClient();
  const tracker = new RSVPTracker({ caldavClient: caldav });
  assert.strictEqual(tracker.untrackEvent('nonexistent'), false);
});

// --- getStatus ---

test('getStatus returns found:false for unknown uid', () => {
  const caldav = createMockCalDAVClient();
  const tracker = new RSVPTracker({ caldavClient: caldav });
  const status = tracker.getStatus('nonexistent');
  assert.strictEqual(status.found, false);
});

test('getStatus returns attendee info for tracked event', () => {
  const caldav = createMockCalDAVClient();
  const tracker = new RSVPTracker({ caldavClient: caldav });
  tracker.trackEvent('uid-1', 'personal', SAMPLE_ATTENDEES, 'Meeting', SAMPLE_EVENT_END);

  const status = tracker.getStatus('uid-1');
  assert.strictEqual(status.found, true);
  assert.strictEqual(status.summary, 'Meeting');
  assert.strictEqual(status.attendees.length, 2);
  assert.strictEqual(status.allResponded, false);
});

// --- getPendingSummary ---

test('getPendingSummary returns counts per event', () => {
  const caldav = createMockCalDAVClient();
  const tracker = new RSVPTracker({ caldavClient: caldav });
  tracker.trackEvent('uid-1', 'personal', SAMPLE_ATTENDEES, 'Meeting', SAMPLE_EVENT_END);

  const pendingSummary = tracker.getPendingSummary();
  assert.strictEqual(pendingSummary.length, 1);
  assert.strictEqual(pendingSummary[0].uid, 'uid-1');
  assert.strictEqual(pendingSummary[0].pending, 2);
  assert.strictEqual(pendingSummary[0].accepted, 0);
  assert.strictEqual(pendingSummary[0].declined, 0);
});

// --- _extractPartstat ---

test('_extractPartstat finds attendee PARTSTAT', () => {
  const caldav = createMockCalDAVClient();
  const tracker = new RSVPTracker({ caldavClient: caldav });

  const event = {
    attendees: [
      { email: 'alice@company.com', status: 'ACCEPTED' },
      { email: 'bob@company.com', status: 'DECLINED' }
    ]
  };

  assert.strictEqual(tracker._extractPartstat(event, 'alice@company.com'), 'ACCEPTED');
  assert.strictEqual(tracker._extractPartstat(event, 'bob@company.com'), 'DECLINED');
});

test('_extractPartstat returns UNKNOWN for missing attendee', () => {
  const caldav = createMockCalDAVClient();
  const tracker = new RSVPTracker({ caldavClient: caldav });

  const event = {
    attendees: [{ email: 'alice@company.com', status: 'ACCEPTED' }]
  };

  assert.strictEqual(tracker._extractPartstat(event, 'unknown@company.com'), 'UNKNOWN');
});

test('_extractPartstat normalizes mailto: prefix and case', () => {
  const caldav = createMockCalDAVClient();
  const tracker = new RSVPTracker({ caldavClient: caldav });

  const event = {
    attendees: [{ email: 'mailto:Alice@Company.com', status: 'TENTATIVE' }]
  };

  assert.strictEqual(tracker._extractPartstat(event, 'alice@company.com'), 'TENTATIVE');
  assert.strictEqual(tracker._extractPartstat(event, 'MAILTO:ALICE@COMPANY.COM'), 'TENTATIVE');
});

test('_extractPartstat returns UNKNOWN for null/missing attendees', () => {
  const caldav = createMockCalDAVClient();
  const tracker = new RSVPTracker({ caldavClient: caldav });

  assert.strictEqual(tracker._extractPartstat(null, 'test@co.com'), 'UNKNOWN');
  assert.strictEqual(tracker._extractPartstat({}, 'test@co.com'), 'UNKNOWN');
  assert.strictEqual(tracker._extractPartstat({ attendees: 'not-array' }, 'test@co.com'), 'UNKNOWN');
});

// --- _cleanupExpired ---

test('_cleanupExpired removes events past end + buffer', () => {
  const caldav = createMockCalDAVClient();
  const tracker = new RSVPTracker({ caldavClient: caldav, expiryBufferMs: 3600000 });

  // Past event (2 hours ago, buffer is 1 hour => should be removed)
  tracker.trackEvent('uid-old', 'personal', SAMPLE_ATTENDEES, 'Old Meeting', PAST_EVENT_END);
  // Future event
  tracker.trackEvent('uid-new', 'personal', SAMPLE_ATTENDEES, 'New Meeting', SAMPLE_EVENT_END);

  assert.strictEqual(tracker.trackedCount, 2);
  const removed = tracker._cleanupExpired();
  assert.strictEqual(removed, 1);
  assert.strictEqual(tracker.trackedCount, 1);
  assert.ok(tracker.pendingEvents.has('uid-new'));
  assert.ok(!tracker.pendingEvents.has('uid-old'));
});

test('_cleanupExpired keeps events within buffer window', () => {
  const caldav = createMockCalDAVClient();
  // 3-hour buffer, event ended 2 hours ago => still within buffer
  const tracker = new RSVPTracker({ caldavClient: caldav, expiryBufferMs: 3 * 60 * 60 * 1000 });
  tracker.trackEvent('uid-1', 'personal', SAMPLE_ATTENDEES, 'Recent Meeting', PAST_EVENT_END);

  const removed = tracker._cleanupExpired();
  assert.strictEqual(removed, 0);
  assert.strictEqual(tracker.trackedCount, 1);
});

// --- checkUpdates ---

asyncTest('checkUpdates detects ACCEPTED status change', async () => {
  const notifyUser = createMockNotifyUser();
  const auditLog = createMockAuditLog();
  const caldav = createMockCalDAVClient({
    getEvent: async () => ({
      attendees: [
        { email: 'alice@company.com', status: 'ACCEPTED' },
        { email: 'bob@company.com', status: 'NEEDS-ACTION' }
      ]
    })
  });

  const tracker = new RSVPTracker({
    caldavClient: caldav,
    notifyUser,
    auditLog,
    checkIntervalMs: 0  // No throttle for tests
  });

  tracker.trackEvent('uid-1', 'personal', SAMPLE_ATTENDEES, 'Meeting', SAMPLE_EVENT_END);
  const result = await tracker.checkUpdates();

  assert.strictEqual(result.checked, 1);
  assert.strictEqual(result.changes, 1);

  // Verify notification was sent
  const notifications = notifyUser.getNotifications();
  assert.strictEqual(notifications.length, 1);
  assert.ok(notifications[0].message.includes('Alice'));
  assert.ok(notifications[0].message.includes('accepted'));
  assert.strictEqual(notifications[0].type, 'rsvp_update');

  // Verify audit log
  const auditCalls = auditLog.getCallsFor('rsvp_status_change');
  assert.strictEqual(auditCalls.length, 1);
  assert.strictEqual(auditCalls[0].data.newStatus, 'ACCEPTED');
});

asyncTest('checkUpdates detects DECLINED and sends high urgency', async () => {
  const notifyUser = createMockNotifyUser();
  const caldav = createMockCalDAVClient({
    getEvent: async () => ({
      attendees: [
        { email: 'alice@company.com', status: 'DECLINED' },
        { email: 'bob@company.com', status: 'NEEDS-ACTION' }
      ]
    })
  });

  const tracker = new RSVPTracker({
    caldavClient: caldav,
    notifyUser,
    checkIntervalMs: 0
  });

  tracker.trackEvent('uid-1', 'personal', SAMPLE_ATTENDEES, 'Meeting', SAMPLE_EVENT_END);
  await tracker.checkUpdates();

  const notifications = notifyUser.getNotifications();
  assert.strictEqual(notifications[0].urgency, 'high');
  assert.ok(notifications[0].message.includes('declined'));
  assert.ok(notifications[0].message.includes('find a new time'));
});

asyncTest('checkUpdates untracks event when all responded', async () => {
  const caldav = createMockCalDAVClient({
    getEvent: async () => ({
      attendees: [
        { email: 'alice@company.com', status: 'ACCEPTED' },
        { email: 'bob@company.com', status: 'ACCEPTED' }
      ]
    })
  });

  const tracker = new RSVPTracker({
    caldavClient: caldav,
    checkIntervalMs: 0
  });

  tracker.trackEvent('uid-1', 'personal', SAMPLE_ATTENDEES, 'Meeting', SAMPLE_EVENT_END);
  const result = await tracker.checkUpdates();

  assert.strictEqual(result.changes, 2);
  assert.strictEqual(tracker.trackedCount, 0); // Auto-untracked
});

asyncTest('checkUpdates handles deleted event', async () => {
  const caldav = createMockCalDAVClient({ getEvent: null });

  const tracker = new RSVPTracker({
    caldavClient: caldav,
    checkIntervalMs: 0
  });

  tracker.trackEvent('uid-1', 'personal', SAMPLE_ATTENDEES, 'Meeting', SAMPLE_EVENT_END);
  await tracker.checkUpdates();

  assert.strictEqual(tracker.trackedCount, 0); // Removed
});

asyncTest('checkUpdates respects checkIntervalMs throttle', async () => {
  let getEventCalls = 0;
  const caldav = createMockCalDAVClient({
    getEvent: async () => {
      getEventCalls++;
      return { attendees: [{ email: 'alice@company.com', status: 'NEEDS-ACTION' }] };
    }
  });

  const tracker = new RSVPTracker({
    caldavClient: caldav,
    checkIntervalMs: 60000  // 1 minute throttle
  });

  tracker.trackEvent('uid-1', 'personal', [{ email: 'alice@company.com', name: 'Alice' }], 'Meeting', SAMPLE_EVENT_END);

  await tracker.checkUpdates();
  assert.strictEqual(getEventCalls, 1);

  // Second check should be throttled
  await tracker.checkUpdates();
  assert.strictEqual(getEventCalls, 1); // Not called again
});

asyncTest('checkUpdates catches errors per-event and continues', async () => {
  const caldav = createMockCalDAVClient({
    getEvent: async () => { throw new Error('CalDAV timeout'); }
  });

  const tracker = new RSVPTracker({
    caldavClient: caldav,
    checkIntervalMs: 0
  });

  tracker.trackEvent('uid-1', 'personal', SAMPLE_ATTENDEES, 'Meeting', SAMPLE_EVENT_END);
  const result = await tracker.checkUpdates();

  assert.strictEqual(result.errors.length, 1);
  assert.ok(result.errors[0].includes('CalDAV timeout'));
  assert.strictEqual(tracker.trackedCount, 1); // Event still tracked
});

// --- trackedCount ---

test('trackedCount returns 0 initially', () => {
  const caldav = createMockCalDAVClient();
  const tracker = new RSVPTracker({ caldavClient: caldav });
  assert.strictEqual(tracker.trackedCount, 0);
});

// --- Module export ---

test('module exports RSVPTracker constructor', () => {
  const mod = require('../../../src/lib/integrations/rsvp-tracker');
  assert.strictEqual(typeof mod, 'function');
  assert.strictEqual(mod.name, 'RSVPTracker');
});

// ============================================================
// Summary
// ============================================================

setTimeout(() => {
  summary();
  exitWithCode();
}, 100);
