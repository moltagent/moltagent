/**
 * ScheduleHandler Unit Tests
 *
 * Tests schedule parsing, interval conversion, timing gates,
 * CONFIG: card detection, and schedule execution.
 */

'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const {
  ScheduleHandler,
  parseScheduleBlock,
  parseInterval,
  findConfigCard
} = require('../../../src/lib/workflows/schedule-handler');

// ─── parseInterval tests ──────────────────────────────────────────────

test('parseInterval: "Every 24h" → 86400000ms', () => {
  assert.strictEqual(parseInterval('Every 24h'), 86400000);
});

test('parseInterval: "Every 1h" → 3600000ms', () => {
  assert.strictEqual(parseInterval('Every 1h'), 3600000);
});

test('parseInterval: "every 30d" → 2592000000ms', () => {
  assert.strictEqual(parseInterval('every 30d'), 2592000000);
});

test('parseInterval: "Every 7d" → 604800000ms', () => {
  assert.strictEqual(parseInterval('Every 7d'), 604800000);
});

test('parseInterval: "every 12h" → 43200000ms (case insensitive)', () => {
  assert.strictEqual(parseInterval('every 12h'), 43200000);
});

test('parseInterval: invalid strings return null', () => {
  assert.strictEqual(parseInterval(''), null);
  assert.strictEqual(parseInterval(null), null);
  assert.strictEqual(parseInterval('Every 0h'), null);
  assert.strictEqual(parseInterval('Every -5h'), null);
  assert.strictEqual(parseInterval('something else'), null);
  assert.strictEqual(parseInterval('Every 10m'), null); // minutes not supported
});

// ─── parseScheduleBlock tests ─────────────────────────────────────────

test('parseScheduleBlock: parses SCHEDULE block with multiple lines', () => {
  const desc = `
WORKFLOW: pipeline
Some description here.

SCHEDULE:
Every 24h: Scan NC News feeds
Every 7d: Archive stale Tracking cards

STAGES:
Inbox → Review → Done
`;
  const schedules = parseScheduleBlock(desc);
  assert.strictEqual(schedules.length, 2);
  assert.strictEqual(schedules[0].action, 'Scan NC News feeds');
  assert.strictEqual(schedules[0].interval, 86400000);
  assert.strictEqual(schedules[1].action, 'Archive stale Tracking cards');
  assert.strictEqual(schedules[1].interval, 604800000);
  assert.ok(schedules[0].hash, 'has hash');
  assert.ok(schedules[0].hash !== schedules[1].hash, 'different hashes');
});

test('parseScheduleBlock: parses inline SCHEDULE format', () => {
  const desc = 'SCHEDULE: Every 12h: Check for new items';
  const schedules = parseScheduleBlock(desc);
  assert.strictEqual(schedules.length, 1);
  assert.strictEqual(schedules[0].action, 'Check for new items');
  assert.strictEqual(schedules[0].interval, 43200000);
});

test('parseScheduleBlock: returns empty array for no SCHEDULE', () => {
  const desc = 'Just a normal card description with no schedules.';
  assert.strictEqual(parseScheduleBlock(desc).length, 0);
});

test('parseScheduleBlock: returns empty for null/undefined', () => {
  assert.strictEqual(parseScheduleBlock(null).length, 0);
  assert.strictEqual(parseScheduleBlock(undefined).length, 0);
  assert.strictEqual(parseScheduleBlock('').length, 0);
});

test('parseScheduleBlock: hashes are stable across calls', () => {
  const desc = 'SCHEDULE:\nEvery 24h: Scan feeds';
  const s1 = parseScheduleBlock(desc);
  const s2 = parseScheduleBlock(desc);
  assert.strictEqual(s1[0].hash, s2[0].hash);
});

// ─── findConfigCard tests ─────────────────────────────────────────────

test('findConfigCard: finds CONFIG: card in stack', () => {
  const stack = {
    cards: [
      { id: 1, title: 'CONFIG: Ideas settings', description: 'criteria here', archived: false, deletedAt: null },
      { id: 2, title: 'Some task', description: 'task desc', archived: false, deletedAt: null }
    ]
  };
  const config = findConfigCard(stack);
  assert.ok(config);
  assert.strictEqual(config.id, 1);
  assert.strictEqual(config.description, 'criteria here');
});

test('findConfigCard: returns null when no CONFIG: card', () => {
  const stack = {
    cards: [
      { id: 1, title: 'Regular card', description: 'desc', archived: false, deletedAt: null }
    ]
  };
  assert.strictEqual(findConfigCard(stack), null);
});

test('findConfigCard: skips archived CONFIG: cards', () => {
  const stack = {
    cards: [
      { id: 1, title: 'CONFIG: settings', description: 'desc', archived: true, deletedAt: null }
    ]
  };
  assert.strictEqual(findConfigCard(stack), null);
});

test('findConfigCard: handles null/empty stack', () => {
  assert.strictEqual(findConfigCard(null), null);
  assert.strictEqual(findConfigCard({}), null);
  assert.strictEqual(findConfigCard({ cards: [] }), null);
});

// ─── ScheduleHandler timing gate tests ────────────────────────────────

test('ScheduleHandler: _isDue returns true when never run', () => {
  const handler = new ScheduleHandler({ agentLoop: {} });
  const due = handler._isDue(1, { hash: 'abc', interval: 86400000 });
  assert.strictEqual(due, true);
});

test('ScheduleHandler: _isDue returns false immediately after run', () => {
  const handler = new ScheduleHandler({ agentLoop: {} });
  handler._markRun(1, { hash: 'abc' });
  const due = handler._isDue(1, { hash: 'abc', interval: 86400000 });
  assert.strictEqual(due, false);
});

test('ScheduleHandler: _isDue returns true after interval elapsed', () => {
  const handler = new ScheduleHandler({ agentLoop: {} });
  // Manually set lastRun to past
  handler._lastRun.set(1, new Map([['abc', Date.now() - 90000000]])); // 25h ago
  const due = handler._isDue(1, { hash: 'abc', interval: 86400000 });
  assert.strictEqual(due, true);
});

test('ScheduleHandler: different boards have independent timing', () => {
  const handler = new ScheduleHandler({ agentLoop: {} });
  handler._markRun(1, { hash: 'abc' });
  // Board 2 never ran — should be due
  assert.strictEqual(handler._isDue(2, { hash: 'abc', interval: 86400000 }), true);
  // Board 1 just ran — should not be due
  assert.strictEqual(handler._isDue(1, { hash: 'abc', interval: 86400000 }), false);
});

test('ScheduleHandler: resetState clears all timing', () => {
  const handler = new ScheduleHandler({ agentLoop: {} });
  handler._markRun(1, { hash: 'abc' });
  handler._markRun(2, { hash: 'def' });
  handler.resetState();
  assert.strictEqual(handler._isDue(1, { hash: 'abc', interval: 1000 }), true);
  assert.strictEqual(handler._isDue(2, { hash: 'def', interval: 1000 }), true);
});

// ─── ScheduleHandler.processSchedules integration ─────────────────────

asyncTest('processSchedules: executes due schedules via agentLoop', async () => {
  let taskExecuted = null;
  const mockAgent = {
    processWorkflowTask: async (opts) => { taskExecuted = opts; return 'done'; }
  };
  const handler = new ScheduleHandler({ agentLoop: mockAgent });

  const wb = {
    board: { id: 1, title: 'Content Pipeline' },
    description: 'WORKFLOW: pipeline\n\nSCHEDULE:\nEvery 1h: Scan NC News feeds\n\nSTAGES:\nInbox → Done',
    stacks: [
      { id: 10, title: 'Ideas', cards: [
        { id: 100, title: 'CONFIG: Evaluation', description: 'Only tech articles', archived: false, deletedAt: null }
      ] }
    ],
    workflowType: 'pipeline'
  };

  const result = await handler.processSchedules(wb);
  assert.strictEqual(result.executed, 1);
  assert.ok(taskExecuted, 'agentLoop was called');
  assert.ok(taskExecuted.systemAddition.includes('Scan NC News feeds'), 'action in system prompt');
  assert.ok(taskExecuted.systemAddition.includes('Only tech articles'), 'config context included');
  assert.strictEqual(taskExecuted.boardId, 1);
});

asyncTest('processSchedules: skips schedules not yet due', async () => {
  let callCount = 0;
  const mockAgent = { processWorkflowTask: async () => { callCount++; } };
  const handler = new ScheduleHandler({ agentLoop: mockAgent });

  const wb = {
    board: { id: 1, title: 'Test' },
    description: 'SCHEDULE:\nEvery 24h: Do something',
    stacks: [],
    workflowType: 'pipeline'
  };

  // First run — should execute
  await handler.processSchedules(wb);
  assert.strictEqual(callCount, 1);

  // Second run immediately — should skip
  const result = await handler.processSchedules(wb);
  assert.strictEqual(result.skipped, 1);
  assert.strictEqual(callCount, 1, 'no second execution');
});

asyncTest('processSchedules: returns empty for no SCHEDULE block', async () => {
  const handler = new ScheduleHandler({ agentLoop: {} });
  const wb = {
    board: { id: 1, title: 'Test' },
    description: 'Just a normal workflow board.',
    stacks: [],
    workflowType: 'pipeline'
  };
  const result = await handler.processSchedules(wb);
  assert.strictEqual(result.executed, 0);
  assert.strictEqual(result.skipped, 0);
});

asyncTest('processSchedules: marks run even on error (prevents retry storm)', async () => {
  const mockAgent = { processWorkflowTask: async () => { throw new Error('LLM failed'); } };
  const handler = new ScheduleHandler({ agentLoop: mockAgent });

  const wb = {
    board: { id: 1, title: 'Test' },
    description: 'SCHEDULE:\nEvery 1h: Failing action',
    stacks: [],
    workflowType: 'pipeline'
  };

  const result = await handler.processSchedules(wb);
  assert.strictEqual(result.errors, 1);

  // Second run should skip (marked as run despite error)
  const result2 = await handler.processSchedules(wb);
  assert.strictEqual(result2.skipped, 1);
});

setTimeout(() => {
  summary();
  exitWithCode();
}, 500);
