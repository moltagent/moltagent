/**
 * Unit Tests for PendingActionStore
 *
 * Tests storage, retrieval, TTL expiration, and cleanup.
 *
 * @module test/unit/pending-action-store.test.js
 */

'use strict';

const assert = require('assert');
const { PendingActionStore } = require('../../src/lib/pending-action-store');

/**
 * Helper to run test with proper error handling
 * @param {string} name - Test name
 * @param {Function} fn - Test function (can be async)
 */
async function test(name, fn) {
  try {
    await fn();
    console.log(`[PASS] ${name}`);
  } catch (error) {
    console.error(`[FAIL] ${name}`);
    console.error(`       ${error.message}`);
    process.exitCode = 1;
  }
}

/**
 * Create a fresh store for testing
 * @param {Object} options - Store options
 * @returns {PendingActionStore}
 */
function createStore(options = {}) {
  return new PendingActionStore({
    defaultTTLMs: 60000, // 1 minute default for tests
    cleanupIntervalMs: 300000, // 5 minutes (won't run during tests)
    ...options
  });
}

// -----------------------------------------------------------------------------
// Test Suite
// -----------------------------------------------------------------------------

console.log('\n=== PendingActionStore Tests ===\n');

// --- Basic Operations ---

test('TC-PAS-001: set() returns unique ID', async () => {
  const store = createStore();
  const id1 = store.set('email_reply', { draft: 'Hello' });
  const id2 = store.set('email_reply', { draft: 'World' });

  assert.strictEqual(typeof id1, 'string');
  assert.ok(id1.includes('email_reply'));
  assert.notStrictEqual(id1, id2);
});

test('TC-PAS-002: get() retrieves stored item', async () => {
  const store = createStore();
  const data = { draft: 'Test draft', email: { from: 'test@example.com' } };
  const id = store.set('email_reply', data);

  const retrieved = store.get(id);
  assert.strictEqual(retrieved.draft, 'Test draft');
  assert.strictEqual(retrieved.email.from, 'test@example.com');
});

test('TC-PAS-003: get() returns null for non-existent ID', async () => {
  const store = createStore();
  const retrieved = store.get('non_existent_id');
  assert.strictEqual(retrieved, null);
});

test('TC-PAS-004: delete() removes item', async () => {
  const store = createStore();
  const id = store.set('email_reply', { draft: 'To delete' });

  assert.strictEqual(store.delete(id), true);
  assert.strictEqual(store.get(id), null);
  assert.strictEqual(store.delete(id), false); // Already deleted
});

test('TC-PAS-005: clear() removes all items', async () => {
  const store = createStore();
  store.set('email_reply', { draft: 'One' });
  store.set('email_reply', { draft: 'Two' });
  store.set('confirmation', { handler: 'calendar' });

  assert.strictEqual(store.size(), 3);
  const cleared = store.clear();
  assert.strictEqual(cleared, 3);
  assert.strictEqual(store.size(), 0);
});

// --- Type Filtering ---

test('TC-PAS-010: size() with type filter', async () => {
  const store = createStore();
  store.set('email_reply', { draft: 'One' });
  store.set('email_reply', { draft: 'Two' });
  store.set('confirmation', { handler: 'calendar' });

  assert.strictEqual(store.size(), 3);
  assert.strictEqual(store.size('email_reply'), 2);
  assert.strictEqual(store.size('confirmation'), 1);
  assert.strictEqual(store.size('nonexistent'), 0);
});

test('TC-PAS-011: has() checks existence by type', async () => {
  const store = createStore();
  store.set('email_reply', { draft: 'Test' });

  assert.strictEqual(store.has(), true);
  assert.strictEqual(store.has('email_reply'), true);
  assert.strictEqual(store.has('confirmation'), false);
});

test('TC-PAS-012: clearType() removes only matching type', async () => {
  const store = createStore();
  store.set('email_reply', { draft: 'One' });
  store.set('email_reply', { draft: 'Two' });
  store.set('confirmation', { handler: 'calendar' });

  const cleared = store.clearType('email_reply');
  assert.strictEqual(cleared, 2);
  assert.strictEqual(store.size('email_reply'), 0);
  assert.strictEqual(store.size('confirmation'), 1);
});

test('TC-PAS-013: getAll() returns all items of type', async () => {
  const store = createStore();
  store.set('email_reply', { draft: 'One' });
  store.set('email_reply', { draft: 'Two' });
  store.set('confirmation', { handler: 'calendar' });

  const replies = store.getAll('email_reply');
  assert.strictEqual(replies.length, 2);
  assert.ok(replies.every(r => r.data.draft));
});

// --- getRecent() ---

test('TC-PAS-020: getRecent() returns most recent of type', async () => {
  const store = createStore();
  store.set('email_reply', { draft: 'First', order: 1 });

  // Small delay to ensure different timestamps
  await new Promise(r => setTimeout(r, 10));
  store.set('email_reply', { draft: 'Second', order: 2 });

  const recent = store.getRecent('email_reply');
  assert.ok(recent);
  assert.strictEqual(recent.data.order, 2);
});

test('TC-PAS-021: getRecent() returns null when no items of type', async () => {
  const store = createStore();
  store.set('confirmation', { handler: 'calendar' });

  const recent = store.getRecent('email_reply');
  assert.strictEqual(recent, null);
});

// --- TTL and Expiration ---

test('TC-PAS-030: Items expire after TTL', async () => {
  const store = createStore({ defaultTTLMs: 50 }); // 50ms TTL
  const id = store.set('email_reply', { draft: 'Expiring' });

  // Should exist immediately
  assert.ok(store.get(id));

  // Wait for expiration
  await new Promise(r => setTimeout(r, 100));

  // Should be expired now
  assert.strictEqual(store.get(id), null);
});

test('TC-PAS-031: Custom TTL overrides default', async () => {
  const store = createStore({ defaultTTLMs: 50 });
  const id = store.set('email_reply', { draft: 'Long lived' }, { ttlMs: 5000 });

  // Wait past default TTL
  await new Promise(r => setTimeout(r, 100));

  // Should still exist due to custom TTL
  assert.ok(store.get(id));
});

test('TC-PAS-032: cleanup() removes expired items', async () => {
  const store = createStore({ defaultTTLMs: 50 });
  store.set('email_reply', { draft: 'Expiring1' });
  store.set('email_reply', { draft: 'Expiring2' });
  store.set('email_reply', { draft: 'Long lived' }, { ttlMs: 60000 });

  assert.strictEqual(store.size(), 3);

  // Wait for short-TTL items to expire
  await new Promise(r => setTimeout(r, 100));

  const removed = store.cleanup();
  assert.strictEqual(removed, 2);
  assert.strictEqual(store.size(), 1);
});

test('TC-PAS-033: has() ignores expired items', async () => {
  const store = createStore({ defaultTTLMs: 50 });
  store.set('email_reply', { draft: 'Expiring' });

  assert.strictEqual(store.has('email_reply'), true);

  // Wait for expiration
  await new Promise(r => setTimeout(r, 100));

  assert.strictEqual(store.has('email_reply'), false);
});

test('TC-PAS-034: getAll() excludes expired items', async () => {
  const store = createStore({ defaultTTLMs: 50 });
  store.set('email_reply', { draft: 'Expiring' });
  store.set('email_reply', { draft: 'Long lived' }, { ttlMs: 60000 });

  // Wait for short-TTL item to expire
  await new Promise(r => setTimeout(r, 100));

  const all = store.getAll('email_reply');
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].data.draft, 'Long lived');
});

// --- Statistics ---

test('TC-PAS-040: getStats() returns accurate statistics', async () => {
  const store = createStore({ defaultTTLMs: 50 });
  store.set('email_reply', { draft: 'One' });
  store.set('email_reply', { draft: 'Two' });
  store.set('confirmation', { handler: 'calendar' }, { ttlMs: 60000 });

  // Wait for some to expire
  await new Promise(r => setTimeout(r, 100));

  const stats = store.getStats();
  assert.strictEqual(stats.total, 3);
  assert.strictEqual(stats.byType.email_reply, 2);
  assert.strictEqual(stats.byType.confirmation, 1);
  assert.strictEqual(stats.expired, 2);
});

// --- Metadata ---

test('TC-PAS-050: Items have timestamp and expiresAt', async () => {
  const store = createStore();
  const before = Date.now();
  const id = store.set('email_reply', { draft: 'Test' });
  const after = Date.now();

  const item = store.get(id);
  assert.ok(item.timestamp >= before);
  assert.ok(item.timestamp <= after);
  assert.ok(item.expiresAt > item.timestamp);
});

test('TC-PAS-051: Items preserve original data', async () => {
  const store = createStore();
  const originalData = {
    email: { messageId: '123', from: 'sender@example.com' },
    draft: 'Test response',
    is_meeting_request: true,
    meeting_details: { proposed_datetime: '2026-02-05T14:00:00Z' }
  };

  const id = store.set('email_reply', originalData);
  const retrieved = store.get(id);

  assert.strictEqual(retrieved.email.messageId, '123');
  assert.strictEqual(retrieved.draft, 'Test response');
  assert.strictEqual(retrieved.is_meeting_request, true);
  assert.strictEqual(retrieved.meeting_details.proposed_datetime, '2026-02-05T14:00:00Z');
});

// --- Shutdown ---

test('TC-PAS-060: stop() clears cleanup timer', async () => {
  const store = createStore();
  store.set('email_reply', { draft: 'Test' });

  // Should not throw
  store.stop();
  store.stop(); // Calling twice should be safe
});

// --- Email Reply Compatibility ---

test('TC-PAS-070: Compatible with email reply workflow', async () => {
  const store = createStore();

  // EmailMonitor stores pending reply
  const pendingId = store.set('email_reply', {
    email: {
      messageId: 'msg-123',
      from: 'John Doe',
      fromAddress: 'john@example.com',
      subject: 'Meeting Request',
      inReplyTo: 'msg-123',
      references: 'msg-123'
    },
    draft: 'Thank you for your email.',
    is_meeting_request: true,
    meeting_details: { proposed_datetime: '2026-02-06T10:00:00Z' },
    calendar_context: { is_available: true }
  });

  // MessageRouter checks for pending
  assert.strictEqual(store.has('email_reply'), true);

  // MessageRouter gets recent
  const recent = store.getRecent('email_reply');
  assert.ok(recent);
  assert.strictEqual(recent.data.email.fromAddress, 'john@example.com');
  assert.strictEqual(recent.data.is_meeting_request, true);

  // MessageRouter clears after handling
  store.clearType('email_reply');
  assert.strictEqual(store.has('email_reply'), false);
});

console.log('\n=== PendingActionStore Tests Complete ===\n');
