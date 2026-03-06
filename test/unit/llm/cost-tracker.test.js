// Mock type: LEGACY — TODO: migrate to realistic mocks
/**
 * CostTracker Unit Tests
 *
 * Run: node test/unit/llm/cost-tracker.test.js
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

const CostTracker = require('../../../src/lib/llm/cost-tracker');

console.log('\n=== CostTracker Tests ===\n');

// --- Cost Computation ---

test('Records cloud call with correct cost computation (claude-sonnet-4-20250514)', () => {
  const tracker = new CostTracker();
  tracker.record({
    model: 'claude-sonnet-4-20250514',
    job: 'thinking',
    trigger: 'user_message',
    inputTokens: 1000,
    outputTokens: 500,
  });
  const totals = tracker.getTotals();
  // input: 1000/1M * 3.00 = 0.003
  // output: 500/1M * 15.00 = 0.0075
  // total: 0.0105
  assert.strictEqual(totals.daily.costUsd.toFixed(4), '0.0105');
  assert.strictEqual(totals.daily.cloudCalls, 1);
  assert.strictEqual(totals.daily.localCalls, 0);
});

test('Records local call with zero cost (phi4-mini)', () => {
  const tracker = new CostTracker();
  tracker.record({
    model: 'phi4-mini',
    job: 'quick',
    trigger: 'user_message',
    inputTokens: 2000,
    outputTokens: 1000,
  });
  const totals = tracker.getTotals();
  assert.strictEqual(totals.daily.costUsd, 0);
  assert.strictEqual(totals.daily.cloudCalls, 0);
  assert.strictEqual(totals.daily.localCalls, 1);
});

test('Accumulates daily totals correctly', () => {
  const tracker = new CostTracker();
  tracker.record({
    model: 'claude-sonnet-4-20250514',
    job: 'thinking',
    trigger: 'user_message',
    inputTokens: 1000,
    outputTokens: 500,
  });
  tracker.record({
    model: 'claude-sonnet-4-20250514',
    job: 'writing',
    trigger: 'user_message',
    inputTokens: 2000,
    outputTokens: 1000,
  });
  const totals = tracker.getTotals();
  // Call 1: 0.003 + 0.0075 = 0.0105
  // Call 2: 0.006 + 0.015 = 0.021
  // Total: 0.0315
  assert.strictEqual(totals.daily.costUsd.toFixed(4), '0.0315');
  assert.strictEqual(totals.daily.cloudCalls, 2);
});

test('Accumulates monthly totals correctly (survives daily reset)', () => {
  const tracker = new CostTracker();
  tracker.record({
    model: 'claude-sonnet-4-20250514',
    job: 'thinking',
    trigger: 'user_message',
    inputTokens: 1000,
    outputTokens: 500,
  });
  // Simulate day change
  tracker.currentDay = '2020-01-01'; // force a reset on next check
  tracker.record({
    model: 'claude-sonnet-4-20250514',
    job: 'writing',
    trigger: 'user_message',
    inputTokens: 2000,
    outputTokens: 1000,
  });
  const totals = tracker.getTotals();
  // Daily should only have the second call
  assert.strictEqual(totals.daily.cloudCalls, 1);
  // Monthly should have both calls
  assert.strictEqual(totals.monthly.cloudCalls, 2);
  assert.strictEqual(totals.monthly.costUsd.toFixed(4), '0.0315');
});

test('Resets daily totals on day change', () => {
  const tracker = new CostTracker();
  tracker.record({
    model: 'claude-sonnet-4-20250514',
    job: 'thinking',
    trigger: 'user_message',
    inputTokens: 1000,
    outputTokens: 500,
  });
  assert.strictEqual(tracker.daily.cloudCalls, 1);
  // Force day change
  tracker.currentDay = '2020-01-01';
  tracker._checkReset();
  assert.strictEqual(tracker.daily.cloudCalls, 0);
  assert.strictEqual(tracker.daily.cost, 0);
});

test('Resets monthly totals on month change', () => {
  const tracker = new CostTracker();
  tracker.record({
    model: 'claude-sonnet-4-20250514',
    job: 'thinking',
    trigger: 'user_message',
    inputTokens: 1000,
    outputTokens: 500,
  });
  assert.strictEqual(tracker.monthly.cloudCalls, 1);
  // Force month change
  tracker.currentMonth = '2020-01';
  tracker._checkReset();
  assert.strictEqual(tracker.monthly.cloudCalls, 0);
  assert.strictEqual(tracker.monthly.cost, 0);
});

test('Handles unknown model gracefully (zero cost)', () => {
  const tracker = new CostTracker();
  tracker.record({
    model: 'unknown-model-xyz',
    job: 'test',
    trigger: 'test',
    inputTokens: 1000,
    outputTokens: 500,
  });
  const totals = tracker.getTotals();
  assert.strictEqual(totals.daily.costUsd, 0);
  // Unknown model is still counted (as cloud since not in pricing with 0 cost)
  // Actually: _isLocalModel returns false for unknown (regex doesn't match), so cloudCalls
  assert.strictEqual(totals.daily.cloudCalls, 1);
});

test('topSpending returns top 5 jobs sorted by cost', () => {
  const tracker = new CostTracker();
  // Record different jobs with different costs
  for (let i = 0; i < 7; i++) {
    tracker.record({
      model: 'claude-sonnet-4-20250514',
      job: `job${i}`,
      trigger: 'test',
      inputTokens: (i + 1) * 1000,
      outputTokens: (i + 1) * 500,
    });
  }
  const totals = tracker.getTotals();
  assert.strictEqual(totals.topSpending.length, 5);
  // Should be sorted descending by cost
  assert.strictEqual(totals.topSpending[0].job, 'job6');
  assert.strictEqual(totals.topSpending[4].job, 'job2');
});

test('localRatio computes correctly', () => {
  const tracker = new CostTracker();
  // 3 local + 1 cloud = 75% local
  tracker.record({ model: 'phi4-mini', job: 'quick', inputTokens: 100, outputTokens: 50 });
  tracker.record({ model: 'phi4-mini', job: 'quick', inputTokens: 100, outputTokens: 50 });
  tracker.record({ model: 'phi4-mini', job: 'quick', inputTokens: 100, outputTokens: 50 });
  tracker.record({ model: 'claude-sonnet-4-20250514', job: 'thinking', inputTokens: 100, outputTokens: 50 });
  const totals = tracker.getTotals();
  assert.strictEqual(totals.localRatio, 75);
});

test('Cache tokens computed with correct pricing', () => {
  const tracker = new CostTracker();
  tracker.record({
    model: 'claude-sonnet-4-20250514',
    job: 'thinking',
    trigger: 'user_message',
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 1000000,
    cacheReadTokens: 1000000,
  });
  const totals = tracker.getTotals();
  // cacheCreation: 1M * 3.00/1M * 1.25 = 3.75
  // cacheRead: 1M * 3.00/1M * 0.10 = 0.30
  // Total: 4.05
  assert.strictEqual(totals.daily.costUsd.toFixed(2), '4.05');
});

// --- JSONL Buffer ---

test('Buffer accumulates entries for flush', () => {
  const tracker = new CostTracker();
  tracker.record({ model: 'phi4-mini', job: 'quick', inputTokens: 100, outputTokens: 50 });
  tracker.record({ model: 'phi4-mini', job: 'quick', inputTokens: 200, outputTokens: 100 });
  assert.strictEqual(tracker._buffer.length, 2);
  assert.strictEqual(tracker._buffer[0].model, 'phi4-mini');
  assert.strictEqual(tracker._buffer[1].input_tokens, 200);
});

// --- Async Flush Tests (wrapped in IIFE so they are awaited before summary) ---

(async () => {

await asyncTest('Flush is no-op when no ncFilesClient', async () => {
  const tracker = new CostTracker();
  tracker.record({ model: 'phi4-mini', job: 'quick', inputTokens: 100, outputTokens: 50 });
  await tracker.flush();
  // Buffer should still be full since no client to write to
  // flush returns early without clearing when no files client
  assert.strictEqual(tracker._buffer.length, 1);
});

await asyncTest('Flush writes to ncFilesClient and clears buffer', async () => {
  let writtenPath = null;
  let writtenContent = null;
  const mockFiles = {
    mkdir: async () => {},
    readFile: async () => { throw new Error('not found'); },
    writeFile: async (path, content) => { writtenPath = path; writtenContent = content; },
  };
  const tracker = new CostTracker({ ncFilesClient: mockFiles });
  tracker.record({ model: 'phi4-mini', job: 'quick', inputTokens: 100, outputTokens: 50 });
  tracker.record({ model: 'claude-sonnet-4-20250514', job: 'thinking', inputTokens: 500, outputTokens: 200 });
  await tracker.flush();
  assert.strictEqual(tracker._buffer.length, 0);
  assert.ok(writtenPath.includes('costs-'));
  assert.ok(writtenPath.endsWith('.jsonl'));
  // Should be 2 lines (each ending with \n)
  const lines = writtenContent.trim().split('\n');
  assert.strictEqual(lines.length, 2);
  const parsed = JSON.parse(lines[0]);
  assert.strictEqual(parsed.model, 'phi4-mini');
  assert.strictEqual(parsed.is_local, true);
});

// --- EUR Conversion ---

test('EUR conversion uses configured rate', () => {
  const tracker = new CostTracker({ usdToEur: 0.90 });
  tracker.record({
    model: 'claude-sonnet-4-20250514',
    job: 'thinking',
    trigger: 'user_message',
    inputTokens: 1000000,
    outputTokens: 0,
  });
  const totals = tracker.getTotals();
  // USD: 3.00, EUR at 0.90: 2.70
  assert.strictEqual(totals.daily.costUsd.toFixed(2), '3.00');
  assert.strictEqual(totals.daily.costEur.toFixed(2), '2.70');
});

// --- PRICING export ---

test('PRICING table is exported as static property', () => {
  assert.ok(CostTracker.PRICING);
  assert.ok(CostTracker.PRICING['claude-sonnet-4-20250514']);
  assert.strictEqual(CostTracker.PRICING['qwen3:8b'].input, 0);
});

summary();
exitWithCode();
})();
