'use strict';

const assert = require('assert');
const { asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const DeferralQueue = require('../../../src/lib/agent/deferral-queue');
const { createMockNCFilesClient } = require('../../helpers/mock-factories');

const silentLogger = { log() {}, warn() {}, error() {} };

// -- Test 1: enqueue() adds task and persists to NC Files --
asyncTest('enqueue() adds task and persists to NC Files', async () => {
  const ncFiles = createMockNCFilesClient();
  const router = { isCloudAvailable: async () => false };

  const queue = new DeferralQueue({ ncFilesClient: ncFiles, llmRouter: router, logger: silentLogger });

  await queue.enqueue({ message: 'Analyze Q4 report', userName: 'Alice', roomToken: 'room1' });

  assert.strictEqual(queue._queue.length, 1);
  assert.strictEqual(queue._queue[0].message, 'Analyze Q4 report');
  assert.strictEqual(queue._queue[0].status, 'queued');
  assert.strictEqual(queue.stats.enqueued, 1);

  // Verify persisted to NC Files
  const stored = ncFiles._store['Moltagent/deferred-tasks.json'];
  assert.ok(stored, 'Queue should be persisted to NC Files');
  const parsed = JSON.parse(stored);
  assert.strictEqual(parsed.length, 1);
  assert.strictEqual(parsed[0].message, 'Analyze Q4 report');
});

// -- Test 2: processNext() processes tasks when cloud available --
asyncTest('processNext() processes tasks when cloud available', async () => {
  const ncFiles = createMockNCFilesClient();
  const router = { isCloudAvailable: async () => true };
  let agentProcessed = false;
  const mockAgentLoop = {
    process: async (msg) => { agentProcessed = true; return 'done'; }
  };

  const queue = new DeferralQueue({ ncFilesClient: ncFiles, llmRouter: router, logger: silentLogger });
  await queue.enqueue({ message: 'Research competitors', userName: 'Bob', roomToken: 'room2' });

  const result = await queue.processNext(mockAgentLoop, 2);

  assert.strictEqual(result.processed, 1);
  assert.ok(agentProcessed, 'AgentLoop.process should have been called');
  assert.strictEqual(queue.stats.processed, 1);
});

// -- Test 3: processNext() skips when cloud unavailable --
asyncTest('processNext() skips when cloud unavailable', async () => {
  const ncFiles = createMockNCFilesClient();
  const router = { isCloudAvailable: async () => false };

  const queue = new DeferralQueue({ ncFilesClient: ncFiles, llmRouter: router, logger: silentLogger });
  await queue.enqueue({ message: 'Complex task', userName: 'Carol', roomToken: 'room3' });

  const result = await queue.processNext(null, 2);

  assert.strictEqual(result.processed, 0);
  assert.strictEqual(result.reason, 'cloud_unavailable');
  // Task should still be queued
  assert.strictEqual(queue._queue[0].status, 'queued');
});

// -- Test 4: load() restores queue from NC Files --
asyncTest('load() restores queue from NC Files', async () => {
  const existingQueue = [
    { id: 'def-1', status: 'queued', message: 'Deferred task 1', enqueuedAt: new Date().toISOString() },
    { id: 'def-2', status: 'queued', message: 'Deferred task 2', enqueuedAt: new Date().toISOString() }
  ];
  const ncFiles = createMockNCFilesClient({
    _store: { 'Moltagent/deferred-tasks.json': JSON.stringify(existingQueue) }
  });
  const router = { isCloudAvailable: async () => false };

  const queue = new DeferralQueue({ ncFilesClient: ncFiles, llmRouter: router, logger: silentLogger });
  await queue.load();

  assert.strictEqual(queue._queue.length, 2);
  assert.strictEqual(queue._queue[0].message, 'Deferred task 1');
  assert.strictEqual(queue._queue[1].message, 'Deferred task 2');
});

setTimeout(() => { summary(); exitWithCode(); }, 100);
