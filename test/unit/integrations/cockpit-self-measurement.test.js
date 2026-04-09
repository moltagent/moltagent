/**
 * Cockpit Self-Measurement Loop — Issue #19
 *
 * Verifies that internal heartbeat LLM calls do not increment the counters
 * that feed Status cards (Health, Model Usage, Costs). The observer must
 * not change the observed.
 *
 * Run: node test/unit/integrations/cockpit-self-measurement.test.js
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (c) 2026 Moltagent
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

const LLMRouter = require('../../../src/lib/llm/router');
const CostTracker = require('../../../src/lib/llm/cost-tracker');

// ============================================================
// Helpers
// ============================================================

function createMockProvider(overrides = {}) {
  return {
    type: overrides.type || 'remote',
    id: overrides.id || 'mock-provider',
    generate: overrides.generate || (async () => ({
      result: 'Mock response',
      model: 'mock-model',
      tokens: 150,
      inputTokens: 50,
      outputTokens: 100,
      cost: 0.001,
      duration: 500,
      headers: {}
    })),
    estimateTokens: () => 100,
    estimateCost: () => 0.001,
    testConnection: async () => ({ connected: true })
  };
}

function createWiredRouter() {
  const costTracker = new CostTracker();
  const router = new LLMRouter({
    roles: { value: ['mock-provider'] }
  });
  router.providers.set('mock-provider', createMockProvider());
  router.costTracker = costTracker;
  return { router, costTracker };
}

console.log('\n=== Cockpit Self-Measurement Loop Tests ===\n');

// ============================================================
// Router: internal flag excludes from stats
// ============================================================

console.log('\n--- Router internal flag ---\n');

asyncTest('Internal route call does NOT increment totalCalls', async () => {
  const { router } = createWiredRouter();

  await router.route({
    task: 'test',
    content: 'heartbeat housekeeping',
    context: { trigger: 'heartbeat_extract', internal: true }
  });

  assert.strictEqual(router.stats.totalCalls, 0);
  assert.strictEqual(router.stats.successfulCalls, 0);
  assert.deepStrictEqual(router.stats.byProvider, {});
});

asyncTest('Normal route call still increments totalCalls', async () => {
  const { router } = createWiredRouter();

  await router.route({
    task: 'test',
    content: 'user message',
    context: { trigger: 'user_message' }
  });

  assert.strictEqual(router.stats.totalCalls, 1);
  assert.strictEqual(router.stats.successfulCalls, 1);
  assert.strictEqual(router.stats.byProvider['mock-provider'], 1);
});

asyncTest('Mixed internal + normal calls: only normal counted', async () => {
  const { router } = createWiredRouter();

  // 2 internal calls
  await router.route({ task: 'a', content: 'x', context: { internal: true } });
  await router.route({ task: 'b', content: 'y', context: { internal: true } });

  // 1 normal call
  await router.route({ task: 'c', content: 'z' });

  assert.strictEqual(router.stats.totalCalls, 1);
  assert.strictEqual(router.stats.successfulCalls, 1);
  assert.strictEqual(router.stats.byProvider['mock-provider'], 1);
});

// ============================================================
// CostTracker: internal flag excludes call counts, keeps cost
// ============================================================

console.log('\n--- CostTracker internal flag ---\n');

test('Internal cloud call excluded from call count but cost still tracked', () => {
  const tracker = new CostTracker();

  tracker.record({
    model: 'claude-sonnet-4-20250514',
    job: 'heartbeat_extract',
    trigger: 'heartbeat_extract',
    inputTokens: 1000,
    outputTokens: 500,
    internal: true,
  });

  const totals = tracker.getTotals();
  assert.strictEqual(totals.daily.cloudCalls, 0, 'cloud call count should be 0');
  assert.strictEqual(totals.monthly.cloudCalls, 0, 'monthly cloud call count should be 0');
  assert.ok(totals.daily.costUsd > 0, 'cost should still be tracked');
});

test('Internal local call excluded from call count', () => {
  const tracker = new CostTracker();

  tracker.record({
    model: 'qwen2.5:3b',
    job: 'heartbeat_garden',
    trigger: 'heartbeat_garden',
    inputTokens: 500,
    outputTokens: 200,
    isLocal: true,
    internal: true,
  });

  const totals = tracker.getTotals();
  assert.strictEqual(totals.daily.localCalls, 0, 'local call count should be 0');
  assert.strictEqual(totals.monthly.localCalls, 0, 'monthly local call count should be 0');
});

test('Normal call still counted in CostTracker', () => {
  const tracker = new CostTracker();

  tracker.record({
    model: 'claude-sonnet-4-20250514',
    job: 'thinking',
    trigger: 'user_message',
    inputTokens: 1000,
    outputTokens: 500,
  });

  const totals = tracker.getTotals();
  assert.strictEqual(totals.daily.cloudCalls, 1);
  assert.strictEqual(totals.monthly.cloudCalls, 1);
});

test('Mixed internal + normal: only normal counted in CostTracker', () => {
  const tracker = new CostTracker();

  // 3 internal calls (simulating 3 heartbeat pulses)
  for (let i = 0; i < 3; i++) {
    tracker.record({
      model: 'qwen2.5:3b',
      job: 'heartbeat_garden',
      trigger: 'heartbeat_garden',
      inputTokens: 500,
      outputTokens: 200,
      isLocal: true,
      internal: true,
    });
  }

  // 1 normal call
  tracker.record({
    model: 'claude-sonnet-4-20250514',
    job: 'thinking',
    trigger: 'user_message',
    inputTokens: 1000,
    outputTokens: 500,
  });

  const totals = tracker.getTotals();
  assert.strictEqual(totals.daily.localCalls, 0, 'internal local calls not counted');
  assert.strictEqual(totals.daily.cloudCalls, 1, 'only the user call counted');
});

// ============================================================
// End-to-end: internal flag flows from router to CostTracker
// ============================================================

console.log('\n--- End-to-end: router → CostTracker propagation ---\n');

asyncTest('Internal flag propagates from router context to CostTracker', async () => {
  const { router, costTracker } = createWiredRouter();

  // Internal call
  await router.route({
    task: 'extract',
    content: 'heartbeat housekeeping',
    context: { trigger: 'heartbeat_extract', internal: true }
  });

  const totals = costTracker.getTotals();
  assert.strictEqual(totals.daily.cloudCalls, 0, 'internal call not counted in CostTracker');
  assert.strictEqual(router.stats.totalCalls, 0, 'internal call not counted in router');
});

asyncTest('Consecutive idle pulses produce stable counter values', async () => {
  const { router, costTracker } = createWiredRouter();

  // Simulate one real user message first
  await router.route({ task: 'chat', content: 'Hello', context: { trigger: 'user_message' } });

  // Snapshot counters
  const snapshot = {
    totalCalls: router.stats.totalCalls,
    successfulCalls: router.stats.successfulCalls,
    byProvider: { ...router.stats.byProvider },
    cloudCalls: costTracker.getTotals().daily.cloudCalls,
  };

  // Simulate 3 idle heartbeat pulses, each making an internal LLM call
  for (let pulse = 0; pulse < 3; pulse++) {
    await router.route({
      task: 'heartbeat_work',
      content: `pulse ${pulse}`,
      context: { trigger: 'heartbeat_extract', internal: true }
    });
  }

  // Counters must be unchanged
  assert.strictEqual(router.stats.totalCalls, snapshot.totalCalls,
    'totalCalls unchanged after 3 idle pulses');
  assert.strictEqual(router.stats.successfulCalls, snapshot.successfulCalls,
    'successfulCalls unchanged after 3 idle pulses');
  assert.strictEqual(router.stats.byProvider['mock-provider'], snapshot.byProvider['mock-provider'],
    'byProvider unchanged after 3 idle pulses');
  assert.strictEqual(costTracker.getTotals().daily.cloudCalls, snapshot.cloudCalls,
    'CostTracker cloudCalls unchanged after 3 idle pulses');
});

// ============================================================
// recordOutcome: internal flag support
// ============================================================

console.log('\n--- recordOutcome internal flag ---\n');

test('recordOutcome with internal flag skips stats', () => {
  const router = new LLMRouter();
  router.providers.set('mock-provider', createMockProvider());

  router.recordOutcome('mock-provider', { success: true, internal: true });

  assert.strictEqual(router.stats.successfulCalls, 0);
  assert.deepStrictEqual(router.stats.byProvider, {});
});

test('recordOutcome without internal flag tracks stats', () => {
  const router = new LLMRouter();
  router.providers.set('mock-provider', createMockProvider());

  router.recordOutcome('mock-provider', { success: true });

  assert.strictEqual(router.stats.successfulCalls, 1);
  assert.strictEqual(router.stats.byProvider['mock-provider'], 1);
});

// ============================================================
// Audit buffer: internal calls still logged for traceability
// ============================================================

console.log('\n--- Audit buffer ---\n');

test('Internal calls are still buffered in CostTracker audit log', () => {
  const tracker = new CostTracker();

  tracker.record({
    model: 'qwen2.5:3b',
    job: 'heartbeat_garden',
    trigger: 'heartbeat_garden',
    inputTokens: 500,
    outputTokens: 200,
    isLocal: true,
    internal: true,
  });

  assert.strictEqual(tracker._buffer.length, 1, 'audit entry still buffered');
  assert.strictEqual(tracker._buffer[0].job, 'heartbeat_garden');
});

// ============================================================

setTimeout(() => { summary(); exitWithCode(); }, 500);
