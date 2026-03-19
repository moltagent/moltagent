/**
 * BudgetEnforcer Unit Tests
 *
 * Run: node test/unit/llm/budget-enforcer.test.js
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

const BudgetEnforcer = require('../../../src/lib/llm/budget-enforcer');

console.log('\n=== BudgetEnforcer Tests ===\n');

// Helper: build a mock CostTracker that returns given daily/monthly spend
function mockTracker(dailyUsd, monthlyUsd) {
  return {
    getTotals: () => ({
      daily: { costUsd: dailyUsd, costEur: dailyUsd * 0.92, cloudCalls: 0, localCalls: 0 },
      monthly: { costUsd: monthlyUsd, costEur: monthlyUsd * 0.92, cloudCalls: 0, localCalls: 0 },
      localRatio: 100,
      topSpending: [],
    })
  };
}

// --- Budget Enforcement Tests ---
console.log('\n--- Budget Enforcement Tests ---\n');

test('canSpend() allows when under budget', () => {
  const enforcer = new BudgetEnforcer({
    budgets: { claude: { daily: 1.00 } }
  });
  enforcer.costTracker = mockTracker(0.10, 0.10);
  const result = enforcer.canSpend('claude', 0.10);
  assert.strictEqual(result.allowed, true);
});

test('canSpend() blocks when over daily budget', () => {
  const enforcer = new BudgetEnforcer({
    budgets: { claude: { daily: 1.00 } }
  });
  enforcer.costTracker = mockTracker(0.95, 0.95);
  const result = enforcer.canSpend('claude', 0.10);
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.reason, 'daily_budget_exceeded');
});

test('canSpend() blocks when over monthly budget', () => {
  const enforcer = new BudgetEnforcer({
    budgets: { claude: { monthly: 5.00 } }
  });
  enforcer.costTracker = mockTracker(0, 4.95);
  const result = enforcer.canSpend('claude', 0.10);
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.reason, 'monthly_budget_exceeded');
});

test('canSpend() allows unlimited when no budget configured', () => {
  const enforcer = new BudgetEnforcer({ budgets: {} });
  const result = enforcer.canSpend('unknown', 100);
  assert.strictEqual(result.allowed, true);
});

test('canSpend() allows when costTracker is null (fail-open)', () => {
  const enforcer = new BudgetEnforcer({
    budgets: { claude: { daily: 1.00 } }
  });
  // No costTracker wired — defaults to zero spend (fail-open)
  const result = enforcer.canSpend('claude', 0.50);
  assert.strictEqual(result.allowed, true);
});

test('canSpend() returns dailyRemaining and monthlyRemaining', () => {
  const enforcer = new BudgetEnforcer({
    budgets: { claude: { daily: 1.00, monthly: 10.00 } }
  });
  enforcer.costTracker = mockTracker(0.30, 3.00);
  const result = enforcer.canSpend('claude', 0.10);
  assert.strictEqual(result.allowed, true);
  assert.ok(Math.abs(result.dailyRemaining - 0.70) < 0.0001);
  assert.ok(Math.abs(result.monthlyRemaining - 7.00) < 0.0001);
});

test('recordSpend() fires onExhausted when daily cap crossed', () => {
  let exhaustedInfo = null;
  const enforcer = new BudgetEnforcer({
    budgets: { claude: { daily: 1.00 } },
    onExhausted: (info) => { exhaustedInfo = info; }
  });
  enforcer.costTracker = mockTracker(1.05, 1.05);
  enforcer.recordSpend('claude');
  assert.ok(exhaustedInfo, 'onExhausted should have been called');
  assert.strictEqual(exhaustedInfo.providerId, 'claude');
  assert.strictEqual(exhaustedInfo.budget, 1.00);
});

test('recordSpend() does nothing when no budget configured', () => {
  let called = false;
  const enforcer = new BudgetEnforcer({
    budgets: {},
    onExhausted: () => { called = true; }
  });
  enforcer.costTracker = mockTracker(5.00, 5.00);
  enforcer.recordSpend('unknown');
  assert.strictEqual(called, false);
});

// --- Proactive Budget Tests ---
console.log('\n--- Proactive Budget Tests ---\n');

test('classifyOperation() returns proactive for heartbeat triggers', () => {
  const enforcer = new BudgetEnforcer({});
  assert.strictEqual(enforcer.classifyOperation({ trigger: 'heartbeat_deck' }), 'proactive');
  assert.strictEqual(enforcer.classifyOperation({ trigger: 'heartbeat_calendar' }), 'proactive');
  assert.strictEqual(enforcer.classifyOperation({ trigger: 'heartbeat_activity' }), 'proactive');
  assert.strictEqual(enforcer.classifyOperation({ trigger: 'heartbeat_digest' }), 'proactive');
  assert.strictEqual(enforcer.classifyOperation({ trigger: 'heartbeat_knowledge' }), 'proactive');
  assert.strictEqual(enforcer.classifyOperation({ trigger: 'heartbeat_email' }), 'proactive');
  assert.strictEqual(enforcer.classifyOperation({ trigger: 'deck_card_pickup' }), 'proactive');
});

test('classifyOperation() returns reactive for talk triggers', () => {
  const enforcer = new BudgetEnforcer({});
  assert.strictEqual(enforcer.classifyOperation({ trigger: 'talk_message' }), 'reactive');
  assert.strictEqual(enforcer.classifyOperation({ trigger: 'user_command' }), 'reactive');
});

test('classifyOperation() returns reactive for missing context', () => {
  const enforcer = new BudgetEnforcer({});
  assert.strictEqual(enforcer.classifyOperation(null), 'reactive');
  assert.strictEqual(enforcer.classifyOperation(undefined), 'reactive');
  assert.strictEqual(enforcer.classifyOperation({}), 'reactive');
  assert.strictEqual(enforcer.classifyOperation({ other: 'field' }), 'reactive');
});

test('canSpendProactive() allows when under budget', () => {
  const enforcer = new BudgetEnforcer({ proactiveDailyBudget: 0.50 });
  const result = enforcer.canSpendProactive(0.10);
  assert.strictEqual(result.allowed, true);
  assert.ok(result.remaining !== undefined);
});

test('canSpendProactive() blocks when exhausted', () => {
  const enforcer = new BudgetEnforcer({ proactiveDailyBudget: 0.50 });
  enforcer.recordProactiveSpend(0.45, 500);
  const result = enforcer.canSpendProactive(0.10);
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.reason, 'proactive_budget_exceeded');
  assert.strictEqual(result.spent, 0.45);
  assert.strictEqual(result.budget, 0.50);
});

test('canSpendProactive() allows when budget disabled (0)', () => {
  const enforcer = new BudgetEnforcer({ proactiveDailyBudget: 0 });
  const result = enforcer.canSpendProactive(100);
  assert.strictEqual(result.allowed, true);
});

test('isProactiveBudgetExhausted() returns true when budget hit', () => {
  const enforcer = new BudgetEnforcer({ proactiveDailyBudget: 0.50 });
  assert.strictEqual(enforcer.isProactiveBudgetExhausted(), false);
  enforcer.recordProactiveSpend(0.50, 500);
  assert.strictEqual(enforcer.isProactiveBudgetExhausted(), true);
});

test('isProactiveBudgetExhausted() returns false when disabled', () => {
  const enforcer = new BudgetEnforcer({ proactiveDailyBudget: 0 });
  assert.strictEqual(enforcer.isProactiveBudgetExhausted(), false);
});

test('recordProactiveSpend() tracks costs and calls onExhausted', () => {
  let exhaustedInfo = null;
  const enforcer = new BudgetEnforcer({
    proactiveDailyBudget: 0.50,
    onExhausted: (info) => { exhaustedInfo = info; }
  });

  enforcer.recordProactiveSpend(0.30, 300);
  assert.strictEqual(exhaustedInfo, null);
  assert.strictEqual(enforcer.proactiveUsage.dailyCost, 0.30);
  assert.strictEqual(enforcer.proactiveUsage.dailyCalls, 1);
  assert.strictEqual(enforcer.proactiveUsage.dailyTokens, 300);

  enforcer.recordProactiveSpend(0.25, 250);
  assert.ok(exhaustedInfo, 'onExhausted should have been called');
  assert.strictEqual(exhaustedInfo.providerId, '_proactive');
  assert.strictEqual(exhaustedInfo.spent, 0.55);
  assert.strictEqual(exhaustedInfo.budget, 0.50);
});

test('recordProactiveSpend() only calls onExhausted once', () => {
  let callCount = 0;
  const enforcer = new BudgetEnforcer({
    proactiveDailyBudget: 0.50,
    onExhausted: () => { callCount++; }
  });

  enforcer.recordProactiveSpend(0.50, 500);
  enforcer.recordProactiveSpend(0.10, 100);
  enforcer.recordProactiveSpend(0.10, 100);
  assert.strictEqual(callCount, 1);
});

test('Daily reset clears proactive usage', () => {
  const enforcer = new BudgetEnforcer({ proactiveDailyBudget: 0.50 });
  enforcer.recordProactiveSpend(0.50, 500);
  assert.strictEqual(enforcer.isProactiveBudgetExhausted(), true);

  // Simulate day change by backdating the internal day key
  enforcer._proactiveDay = '2020-01-01';
  enforcer._checkProactiveReset();

  assert.strictEqual(enforcer.proactiveUsage.dailyCost, 0);
  assert.strictEqual(enforcer.proactiveUsage.dailyCalls, 0);
  assert.strictEqual(enforcer.proactiveUsage.dailyTokens, 0);
  assert.strictEqual(enforcer.isProactiveBudgetExhausted(), false);
  assert.strictEqual(enforcer.proactiveBudgetExhaustedNotified, false);
});

// --- Budget Override Tests ---
console.log('\n--- Budget Override Tests ---\n');

test('activateOverride() bypasses budget limits', () => {
  const enforcer = new BudgetEnforcer({
    budgets: { claude: { daily: 1.00 } }
  });
  enforcer.costTracker = mockTracker(0.95, 0.95);
  // Without override, should be blocked
  assert.strictEqual(enforcer.canSpend('claude', 0.10).allowed, false);
  // Activate override
  enforcer.activateOverride(3600000); // 1 hour
  // Now should be allowed
  assert.strictEqual(enforcer.canSpend('claude', 0.10).allowed, true);
});

test('isOverrideActive() returns true during active override', () => {
  const enforcer = new BudgetEnforcer({});
  assert.strictEqual(enforcer.isOverrideActive(), false);
  enforcer.activateOverride(3600000);
  assert.strictEqual(enforcer.isOverrideActive(), true);
});

test('Override expires after duration', () => {
  const enforcer = new BudgetEnforcer({
    budgets: { claude: { daily: 1.00 } }
  });
  enforcer.costTracker = mockTracker(0.95, 0.95);
  // Activate with already-expired timestamp
  enforcer._overrideActive = true;
  enforcer._overrideExpiry = Date.now() - 1;
  // Should not bypass
  assert.strictEqual(enforcer.canSpend('claude', 0.10).allowed, false);
  assert.strictEqual(enforcer.isOverrideActive(), false);
});

test('updateBudgets() merges new limits', () => {
  const enforcer = new BudgetEnforcer({ budgets: { claude: { daily: 1.00 } } });
  enforcer.updateBudgets({ openai: { daily: 0.50 } });
  assert.ok(enforcer.budgets.claude);
  assert.ok(enforcer.budgets.openai);
  assert.strictEqual(enforcer.budgets.openai.daily, 0.50);
});

test('onWarning() fires when warning threshold crossed', () => {
  let warnInfo = null;
  const enforcer = new BudgetEnforcer({
    budgets: { claude: { daily: 1.00 } },
    warningThreshold: 0.8,
    onWarning: (info) => { warnInfo = info; }
  });
  enforcer.costTracker = mockTracker(0.75, 0.75);
  // 0.75 existing + 0.10 estimated = 0.85 = 85% > 80% threshold
  enforcer.canSpend('claude', 0.10);
  assert.ok(warnInfo, 'onWarning should have been called');
  assert.strictEqual(warnInfo.providerId, 'claude');
});

(async () => {
  summary();
  exitWithCode();
})();
