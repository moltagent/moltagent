/**
 * Think Tag Stripping Tests
 *
 * Verifies that <think>...</think> reasoning blocks from local LLMs
 * are stripped before messages reach Talk.
 *
 * Run: node test/unit/talk/think-tag-stripping.test.js
 */

'use strict';

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

function createMockNC() {
  const calls = [];
  return {
    calls,
    request: async (url, options) => {
      calls.push({ url, message: options.body.message });
      return { status: 201, body: { ocs: { data: {} } } };
    }
  };
}

async function runTests() {
  console.log('\n=== Think Tag Stripping Tests ===\n');

  // Test 1: Complete think block is stripped, actual response preserved
  await asyncTest('strips complete <think>...</think> block and returns actual response', async () => {
    const mock = createMockNC();
    const queue = new TalkSendQueue(mock);

    await queue.enqueue('room1', '<think>Let me reason about this carefully...</think>Actual response');

    assert.strictEqual(mock.calls.length, 1, 'Should send one message');
    assert.strictEqual(mock.calls[0].message, 'Actual response');
  });

  // Test 2: Incomplete think block (model timed out mid-reasoning) returns empty → not enqueued
  await asyncTest('incomplete <think> block (no closing tag) results in no message sent', async () => {
    const mock = createMockNC();
    const queue = new TalkSendQueue(mock);

    const result = await queue.enqueue('room1', '<think>The user is asking about their calendar and I need to think about');

    assert.strictEqual(mock.calls.length, 0, 'Should not send any message');
    assert.strictEqual(result, true, 'Should resolve with true (silently dropped)');
  });

  // Test 3: Response with no think tags passes through unchanged
  await asyncTest('message without think tags passes through unchanged', async () => {
    const mock = createMockNC();
    const queue = new TalkSendQueue(mock);

    await queue.enqueue('room1', 'Here is your calendar for today.');

    assert.strictEqual(mock.calls.length, 1, 'Should send one message');
    assert.strictEqual(mock.calls[0].message, 'Here is your calendar for today.');
  });

  // Summary
  console.log('\n=================================');
  console.log(`Tests passed: ${testsPassed}`);
  console.log(`Tests failed: ${testsFailed}`);
  console.log('=================================\n');
  process.exit(testsFailed > 0 ? 1 : 0);
}

runTests();
