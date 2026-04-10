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
  assert.strictEqual(tracker._buffer[0].internal, true, 'internal flag persisted');
});

// ============================================================
// displayCost / displayByJob split
//
// Internal calls still accumulate into `cost` and `byJob` (budget truth)
// but are excluded from `displayCost` and `displayByJob` (card truth).
// Without this split the Costs card flapped on every heartbeat as tiny
// internal synthesis costs pushed the rounded EUR display up by €0.01.
// ============================================================

console.log('\n--- displayCost split ---\n');

test('Internal cloud call: cost tracked, displayCost NOT tracked', () => {
  const tracker = new CostTracker();

  tracker.record({
    model: 'claude-haiku-4-5-20251001',
    job: 'synthesis',
    trigger: 'heartbeat_digest',
    inputTokens: 1000,
    outputTokens: 500,
    internal: true,
  });

  assert.ok(tracker.daily.cost > 0, 'total cost incremented (budget truth)');
  assert.strictEqual(tracker.daily.displayCost, 0, 'displayCost NOT incremented');
  assert.ok(tracker.monthly.cost > 0, 'total monthly cost incremented');
  assert.strictEqual(tracker.monthly.displayCost, 0, 'displayCost monthly NOT incremented');
});

test('Normal cloud call: both cost and displayCost tracked', () => {
  const tracker = new CostTracker();

  tracker.record({
    model: 'claude-haiku-4-5-20251001',
    job: 'tools',
    trigger: 'user_message',
    inputTokens: 1000,
    outputTokens: 500,
  });

  assert.ok(tracker.daily.cost > 0);
  assert.ok(tracker.daily.displayCost > 0);
  assert.strictEqual(tracker.daily.cost, tracker.daily.displayCost,
    'non-internal: cost === displayCost');
});

test('getTotals exposes both cost views', () => {
  const tracker = new CostTracker();

  // 1 external user call
  tracker.record({
    model: 'claude-haiku-4-5-20251001',
    job: 'tools',
    trigger: 'user_message',
    inputTokens: 1000,
    outputTokens: 500,
  });

  // 3 internal heartbeat calls
  for (let i = 0; i < 3; i++) {
    tracker.record({
      model: 'claude-haiku-4-5-20251001',
      job: 'synthesis',
      trigger: 'heartbeat_digest',
      inputTokens: 1000,
      outputTokens: 500,
      internal: true,
    });
  }

  const totals = tracker.getTotals();

  // Budget view includes all 4 calls
  assert.ok(totals.daily.costUsd > 0);
  assert.ok(totals.monthly.costUsd > 0);

  // Display view only includes the 1 external call
  assert.ok(totals.daily.displayCostUsd > 0);
  assert.ok(totals.daily.displayCostEur > 0);
  assert.ok(totals.monthly.displayCostUsd > 0);
  assert.ok(totals.monthly.displayCostEur > 0);

  // Budget total must be exactly 4x the display total (same per-call cost)
  assert.strictEqual(
    totals.daily.costUsd.toFixed(6),
    (totals.daily.displayCostUsd * 4).toFixed(6),
    'total cost = 4x display cost (1 external + 3 internal at same price)'
  );
});

test('topSpending excludes internal jobs', () => {
  const tracker = new CostTracker();

  // 5 expensive internal synthesis calls
  for (let i = 0; i < 5; i++) {
    tracker.record({
      model: 'claude-haiku-4-5-20251001',
      job: 'synthesis',
      trigger: 'heartbeat_digest',
      inputTokens: 10000,
      outputTokens: 5000,
      internal: true,
    });
  }

  // 1 cheap external tools call
  tracker.record({
    model: 'claude-haiku-4-5-20251001',
    job: 'tools',
    trigger: 'user_message',
    inputTokens: 100,
    outputTokens: 50,
  });

  const totals = tracker.getTotals();

  // Internal synthesis was 100x more expensive in total, but topSpending
  // reads from displayByJob so it should rank `tools` (the only external job)
  assert.strictEqual(totals.topSpending.length, 1,
    'only the external job appears in topSpending');
  assert.strictEqual(totals.topSpending[0].job, 'tools');
});

test('Idle pulse stability: displayCost frozen across internal calls', () => {
  const tracker = new CostTracker();

  // Baseline: 1 external call sets display state
  tracker.record({
    model: 'claude-haiku-4-5-20251001',
    job: 'tools',
    trigger: 'user_message',
    inputTokens: 1000,
    outputTokens: 500,
  });

  const baseline = {
    displayCost: tracker.daily.displayCost,
    cloudCalls: tracker.daily.cloudCalls,
    displayByJob: { ...tracker.daily.displayByJob },
  };

  // Simulate 10 idle heartbeat pulses, each making an internal synthesis call
  for (let i = 0; i < 10; i++) {
    tracker.record({
      model: 'claude-haiku-4-5-20251001',
      job: 'synthesis',
      trigger: 'heartbeat_digest',
      inputTokens: 1142,
      outputTokens: 140,
      internal: true,
    });
  }

  // Display state must be byte-for-byte identical to baseline —
  // this is the property that keeps the Cockpit Costs card hash stable.
  assert.strictEqual(tracker.daily.displayCost, baseline.displayCost,
    'displayCost frozen across 10 idle pulses');
  assert.strictEqual(tracker.daily.cloudCalls, baseline.cloudCalls);
  assert.deepStrictEqual(tracker.daily.displayByJob, baseline.displayByJob,
    'displayByJob frozen across 10 idle pulses');

  // But the budget total MUST have moved (otherwise runaway internal usage
  // would never trip the budget limit).
  assert.ok(tracker.daily.cost > baseline.displayCost,
    'total cost advanced past baseline (budget tracking preserved)');
});

test('Audit buffer persists internal flag for restore()', () => {
  const tracker = new CostTracker();

  tracker.record({
    model: 'claude-haiku-4-5-20251001',
    job: 'synthesis',
    trigger: 'heartbeat_digest',
    inputTokens: 1142,
    outputTokens: 140,
    internal: true,
  });

  tracker.record({
    model: 'claude-haiku-4-5-20251001',
    job: 'tools',
    trigger: 'user_message',
    inputTokens: 500,
    outputTokens: 200,
  });

  assert.strictEqual(tracker._buffer.length, 2);
  assert.strictEqual(tracker._buffer[0].internal, true,
    'heartbeat call marked internal in audit buffer');
  assert.strictEqual(tracker._buffer[1].internal, false,
    'user call marked non-internal in audit buffer');
});

// ============================================================

setTimeout(() => { summary(); exitWithCode(); }, 500);
