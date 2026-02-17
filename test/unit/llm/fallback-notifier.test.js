/**
 * FallbackNotifier Unit Tests (V3)
 *
 * Tests for LLM fallback notification with debounce and recovery.
 *
 * Run: node test/unit/llm/fallback-notifier.test.js
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

const FallbackNotifier = require('../../../src/lib/llm/fallback-notifier');

// ============================================================
// Helpers
// ============================================================

function createMockLogger() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function createMockTalkQueue() {
  const queue = {
    messages: [],
    enqueue: async (token, message) => {
      queue.messages.push({ token, message });
      return true;
    }
  };
  return queue;
}

function createNotifier(overrides = {}) {
  const talkQueue = overrides.talkSendQueue || createMockTalkQueue();
  return {
    notifier: new FallbackNotifier({
      talkSendQueue: talkQueue,
      primaryRoomToken: overrides.primaryRoomToken || 'room_primary',
      debounceMinutes: overrides.debounceMinutes !== undefined ? overrides.debounceMinutes : 0.001, // ~60ms for tests
      logger: overrides.logger || createMockLogger()
    }),
    talkQueue
  };
}

function makeFallbackResult(overrides = {}) {
  return {
    content: 'test response',
    toolCalls: null,
    _routing: {
      isFallback: overrides.isFallback !== undefined ? overrides.isFallback : true,
      primaryIsLocal: overrides.primaryIsLocal || false,
      fallbackIsLocal: overrides.fallbackIsLocal !== undefined ? overrides.fallbackIsLocal : true,
      player: overrides.player || 'fallback'
    }
  };
}

function makePrimaryResult(overrides = {}) {
  return {
    content: 'test response',
    toolCalls: null,
    _routing: {
      isFallback: false,
      primaryIsLocal: overrides.primaryIsLocal || false,
      fallbackIsLocal: overrides.fallbackIsLocal || false,
      player: 'primary'
    }
  };
}

// ============================================================
// Test Suites
// ============================================================

console.log('\n=== FallbackNotifier Tests (V3) ===\n');

// --- onRouteComplete() Tests ---
console.log('\n--- onRouteComplete() Tests ---\n');

(async () => {

await asyncTest('TC-FN-001: Sends notification on cloud→local fallback', async () => {
  const { notifier, talkQueue } = createNotifier();
  notifier.onRouteComplete(makeFallbackResult());
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(talkQueue.messages.length, 1);
  assert.ok(talkQueue.messages[0].message.includes('local AI'));
  assert.strictEqual(talkQueue.messages[0].token, 'room_primary');
});

await asyncTest('TC-FN-002: No notification on non-fallback routes', async () => {
  const { notifier, talkQueue } = createNotifier();
  notifier.onRouteComplete(makePrimaryResult());
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(talkQueue.messages.length, 0);
});

await asyncTest('TC-FN-003: No notification on local→local (primaryIsLocal + fallbackIsLocal)', async () => {
  const { notifier, talkQueue } = createNotifier();
  notifier.onRouteComplete(makeFallbackResult({
    primaryIsLocal: true,
    fallbackIsLocal: true
  }));
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(talkQueue.messages.length, 0);
});

await asyncTest('TC-FN-004: Sends recovery when cloud comes back after fallback', async () => {
  const { notifier, talkQueue } = createNotifier();
  // First: fallback event
  notifier.onRouteComplete(makeFallbackResult());
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(talkQueue.messages.length, 1);

  // Then: primary success (recovery)
  notifier.onRouteComplete(makePrimaryResult());
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(talkQueue.messages.length, 2);
  assert.ok(talkQueue.messages[1].message.includes('back online'));
});

await asyncTest('TC-FN-005: No recovery if no prior fallback', async () => {
  const { notifier, talkQueue } = createNotifier();
  // Primary success without prior fallback
  notifier.onRouteComplete(makePrimaryResult());
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(talkQueue.messages.length, 0);
});

// --- Debounce Tests ---
console.log('\n--- Debounce Tests ---\n');

await asyncTest('TC-FN-006: Second fallback within debounce window → no duplicate', async () => {
  const { notifier, talkQueue } = createNotifier({ debounceMinutes: 10 }); // 10 min
  notifier.onRouteComplete(makeFallbackResult());
  await new Promise(r => setTimeout(r, 20));
  notifier.onRouteComplete(makeFallbackResult());
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(talkQueue.messages.length, 1, 'Should only send one notification within debounce window');
});

await asyncTest('TC-FN-007: Fallback after debounce window expires → new notification', async () => {
  const { notifier, talkQueue } = createNotifier({ debounceMinutes: 0.00001 }); // ~0.6ms
  notifier.onRouteComplete(makeFallbackResult());
  await new Promise(r => setTimeout(r, 20));
  assert.strictEqual(talkQueue.messages.length, 1);

  // Wait for debounce to expire
  await new Promise(r => setTimeout(r, 50));
  notifier.onRouteComplete(makeFallbackResult());
  await new Promise(r => setTimeout(r, 20));
  assert.strictEqual(talkQueue.messages.length, 2, 'Should send new notification after debounce expires');
});

await asyncTest('TC-FN-008: Different notifier instances have independent debounce', async () => {
  const queue1 = createMockTalkQueue();
  const queue2 = createMockTalkQueue();
  const notifier1 = new FallbackNotifier({
    talkSendQueue: queue1, primaryRoomToken: 'room1', debounceMinutes: 10,
    logger: createMockLogger()
  });
  const notifier2 = new FallbackNotifier({
    talkSendQueue: queue2, primaryRoomToken: 'room2', debounceMinutes: 10,
    logger: createMockLogger()
  });
  notifier1.onRouteComplete(makeFallbackResult());
  notifier2.onRouteComplete(makeFallbackResult());
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(queue1.messages.length, 1, 'First notifier should send notification');
  assert.strictEqual(queue2.messages.length, 1, 'Second notifier should send independently');
});

await asyncTest('TC-FN-009: Recovery resets debounce state', async () => {
  const { notifier, talkQueue } = createNotifier({ debounceMinutes: 10 }); // Long debounce
  // 1. Fallback
  notifier.onRouteComplete(makeFallbackResult());
  await new Promise(r => setTimeout(r, 20));
  assert.strictEqual(talkQueue.messages.length, 1);

  // 2. Recovery
  notifier.onRouteComplete(makePrimaryResult());
  await new Promise(r => setTimeout(r, 20));
  assert.strictEqual(talkQueue.messages.length, 2);

  // 3. New fallback — should NOT be debounced because recovery reset the state
  notifier.onRouteComplete(makeFallbackResult());
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(talkQueue.messages.length, 3, 'Recovery should reset debounce, allowing new fallback notification');
});

// --- Edge Cases ---
console.log('\n--- Edge Cases ---\n');

await asyncTest('TC-FN-010: Missing _routing → silently returns', async () => {
  const { notifier, talkQueue } = createNotifier();
  notifier.onRouteComplete({ content: 'no routing' });
  notifier.onRouteComplete(null);
  notifier.onRouteComplete(undefined);
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(talkQueue.messages.length, 0);
});

await asyncTest('TC-FN-011: Missing talkSendQueue → silently returns', async () => {
  const notifier = new FallbackNotifier({
    talkSendQueue: null,
    primaryRoomToken: 'room123',
    logger: createMockLogger()
  });
  // Should not throw
  notifier.onRouteComplete(makeFallbackResult());
});

await asyncTest('TC-FN-012: Notification send failure → logged, does not throw', async () => {
  let warnLogged = false;
  const failingQueue = {
    enqueue: async () => { throw new Error('Send failed'); }
  };
  const notifier = new FallbackNotifier({
    talkSendQueue: failingQueue,
    primaryRoomToken: 'room123',
    logger: { info: () => {}, warn: () => { warnLogged = true; }, error: () => {} }
  });
  // Should not throw
  notifier.onRouteComplete(makeFallbackResult());
  await new Promise(r => setTimeout(r, 50));
  assert.ok(warnLogged, 'Should have logged a warning about the send failure');
});

summary();
exitWithCode();

})();
