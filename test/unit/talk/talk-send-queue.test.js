/**
 * TalkSendQueue Unit Tests
 *
 * Run: node test/unit/talk/talk-send-queue.test.js
 */

const assert = require('assert');
const { TalkSendQueue } = require('../../../src/lib/talk/talk-send-queue');

let testsPassed = 0;
let testsFailed = 0;

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`\u2713 ${name}`);
    testsPassed++;
  } catch (error) {
    console.log(`\u2717 ${name}`);
    console.log(`  Error: ${error.message}`);
    testsFailed++;
  }
}

// Mock NCRequestManager that records calls
function createMockNC(behavior) {
  const calls = [];
  return {
    calls,
    request: async (url, options) => {
      const body = options.body;
      calls.push({ url, token: url.split('/').pop(), message: body.message, replyTo: body.replyTo });
      if (behavior === 'fail') {
        throw new Error('Network error');
      }
      if (behavior === 'error-status') {
        return { status: 500, body: 'Internal Server Error' };
      }
      // Add a small delay to simulate real HTTP
      await new Promise(r => setTimeout(r, 10));
      return { status: 201, body: { ocs: { data: {} } } };
    }
  };
}

async function runTests() {
  console.log('\n=== TalkSendQueue Tests ===\n');

  // Test 1: FIFO order
  await asyncTest('messages are delivered in FIFO order', async () => {
    const mock = createMockNC('success');
    const queue = new TalkSendQueue(mock);

    const p1 = queue.enqueue('room1', 'first');
    const p2 = queue.enqueue('room1', 'second');
    const p3 = queue.enqueue('room1', 'third');

    await Promise.all([p1, p2, p3]);

    assert.strictEqual(mock.calls.length, 3);
    assert.strictEqual(mock.calls[0].message, 'first');
    assert.strictEqual(mock.calls[1].message, 'second');
    assert.strictEqual(mock.calls[2].message, 'third');
  });

  // Test 2: No parallel sends
  await asyncTest('single consumer — concurrent enqueues do not cause parallel sends', async () => {
    let concurrentSends = 0;
    let maxConcurrent = 0;

    const mock = {
      request: async (url, options) => {
        concurrentSends++;
        if (concurrentSends > maxConcurrent) maxConcurrent = concurrentSends;
        await new Promise(r => setTimeout(r, 20));
        concurrentSends--;
        return { status: 201, body: {} };
      }
    };

    const queue = new TalkSendQueue(mock);

    const promises = [];
    for (let i = 0; i < 5; i++) {
      promises.push(queue.enqueue('room1', `msg-${i}`));
    }

    await Promise.all(promises);

    assert.strictEqual(maxConcurrent, 1, `Expected max 1 concurrent send, got ${maxConcurrent}`);
  });

  // Test 3: Caller gets resolved promise
  await asyncTest('caller gets resolved promise when message is sent', async () => {
    const mock = createMockNC('success');
    const queue = new TalkSendQueue(mock);

    const result = await queue.enqueue('room1', 'hello');
    assert.strictEqual(result, true);
  });

  // Test 4: Send failure rejects the specific caller
  await asyncTest('send failure rejects the specific callers promise', async () => {
    const mock = createMockNC('fail');
    const queue = new TalkSendQueue(mock);

    try {
      await queue.enqueue('room1', 'hello');
      assert.fail('Should have rejected');
    } catch (err) {
      assert.ok(err.message.includes('Network error'));
    }
  });

  // Test 5: HTTP error status returns false (not rejection)
  await asyncTest('HTTP error status resolves with false', async () => {
    const mock = createMockNC('error-status');
    const queue = new TalkSendQueue(mock);

    const result = await queue.enqueue('room1', 'hello');
    assert.strictEqual(result, false);
  });

  // Test 6: Queue drains on shutdown
  await asyncTest('shutdown drains remaining messages', async () => {
    const mock = createMockNC('success');
    const queue = new TalkSendQueue(mock);

    const p1 = queue.enqueue('room1', 'msg1');
    const p2 = queue.enqueue('room1', 'msg2');

    await queue.shutdown();
    await p1;
    await p2;

    assert.strictEqual(mock.calls.length, 2);
  });

  // Test 7: getMetrics returns correct counts
  await asyncTest('getMetrics returns correct counts', async () => {
    const mock = createMockNC('success');
    const queue = new TalkSendQueue(mock);

    await queue.enqueue('room1', 'msg1');
    await queue.enqueue('room1', 'msg2');

    const metrics = queue.getMetrics();
    assert.strictEqual(metrics.sent, 2);
    assert.strictEqual(metrics.failed, 0);
    assert.strictEqual(metrics.pending, 0);
    assert.ok(metrics.maxDepth >= 1);
  });

  // Test 8: Failure increments failed metric
  await asyncTest('failure increments failed metric', async () => {
    const mock = createMockNC('fail');
    const queue = new TalkSendQueue(mock);

    try { await queue.enqueue('room1', 'msg1'); } catch {}

    const metrics = queue.getMetrics();
    assert.strictEqual(metrics.failed, 1);
    assert.strictEqual(metrics.sent, 0);
  });

  // Test 9: replyTo is passed through correctly
  await asyncTest('replyTo is passed through to the API call', async () => {
    const mock = createMockNC('success');
    const queue = new TalkSendQueue(mock);

    await queue.enqueue('room1', 'reply text', 42);

    assert.strictEqual(mock.calls[0].replyTo, 42);
  });

  // Test 10: replyTo defaults to null (omitted from body)
  await asyncTest('replyTo omitted when null', async () => {
    const mock = createMockNC('success');
    const queue = new TalkSendQueue(mock);

    await queue.enqueue('room1', 'no reply');

    assert.strictEqual(mock.calls[0].replyTo, undefined);
  });

  // Test 11: Mixed success and failure doesn't block queue
  await asyncTest('failure on one message does not block subsequent messages', async () => {
    let callCount = 0;
    const mock = {
      request: async (url, options) => {
        callCount++;
        if (callCount === 2) {
          throw new Error('Temporary failure');
        }
        return { status: 201, body: {} };
      }
    };

    const queue = new TalkSendQueue(mock);

    const r1 = queue.enqueue('room1', 'msg1');
    const r2 = queue.enqueue('room1', 'msg2'); // This will fail
    const r3 = queue.enqueue('room1', 'msg3');

    const result1 = await r1;
    assert.strictEqual(result1, true);

    try {
      await r2;
      assert.fail('Should have rejected');
    } catch (err) {
      assert.ok(err.message.includes('Temporary failure'));
    }

    const result3 = await r3;
    assert.strictEqual(result3, true);
  });

  // Summary
  console.log('\n=================================');
  console.log(`Tests passed: ${testsPassed}`);
  console.log(`Tests failed: ${testsFailed}`);
  console.log('=================================\n');
  process.exit(testsFailed > 0 ? 1 : 0);
}

runTests();
