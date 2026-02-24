/**
 * BudgetEnforcer Unit Tests
 *
 * Run: node test/unit/llm/budget-enforcer.test.js
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

const BudgetEnforcer = require('../../../src/lib/llm/budget-enforcer');

console.log('\n=== BudgetEnforcer Tests ===\n');

// --- Existing Functionality ---
console.log('\n--- Existing Budget Tests ---\n');

test('canSpend() allows when under budget', () => {
  const enforcer = new BudgetEnforcer({
    budgets: { claude: { daily: 1.00 } }
  });
  const result = enforcer.canSpend('claude', 0.10);
  assert.strictEqual(result.allowed, true);
});

test('canSpend() blocks when over daily budget', () => {
  const enforcer = new BudgetEnforcer({
    budgets: { claude: { daily: 1.00 } }
  });
  enforcer.recordSpend('claude', 0.95, 1000);
  const result = enforcer.canSpend('claude', 0.10);
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.reason, 'daily_budget_exceeded');
});

test('canSpend() blocks when over monthly budget', () => {
  const enforcer = new BudgetEnforcer({
    budgets: { claude: { monthly: 5.00 } }
  });
  enforcer.recordSpend('claude', 4.95, 10000);
  const result = enforcer.canSpend('claude', 0.10);
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.reason, 'monthly_budget_exceeded');
});

test('canSpend() allows unlimited when no budget configured', () => {
  const enforcer = new BudgetEnforcer({ budgets: {} });
  const result = enforcer.canSpend('unknown', 100);
  assert.strictEqual(result.allowed, true);
});

test('recordSpend() tracks daily and monthly costs', () => {
  const enforcer = new BudgetEnforcer({
    budgets: { claude: { daily: 10.00, monthly: 100.00 } }
  });
  enforcer.recordSpend('claude', 0.50, 500);
  enforcer.recordSpend('claude', 0.30, 300);
  const summary = enforcer.getUsageSummary('claude');
  assert.strictEqual(summary.daily.cost, 0.80);
  assert.strictEqual(summary.daily.tokens, 800);
  assert.strictEqual(summary.daily.calls, 2);
  assert.strictEqual(summary.monthly.cost, 0.80);
});

test('getFullReport() returns complete report', () => {
  const enforcer = new BudgetEnforcer({
    budgets: { claude: { daily: 5.00 } }
  });
  enforcer.recordSpend('claude', 0.10, 100);
  const report = enforcer.getFullReport();
  assert.ok(report.date);
  assert.ok(report.month);
  assert.ok(report.providers.claude);
  assert.ok(report.proactive);
  assert.strictEqual(report.proactive.dailyCost, 0);
  assert.strictEqual(report.proactive.exhausted, false);
});

test('exportUsage() / importUsage() round-trip', () => {
  const enforcer1 = new BudgetEnforcer({
    budgets: { claude: { daily: 5.00 } },
    proactiveDailyBudget: 0.50
  });
  enforcer1.recordSpend('claude', 0.25, 250);
  enforcer1.recordProactiveSpend(0.10, 100);

  const exported = enforcer1.exportUsage();

  const enforcer2 = new BudgetEnforcer({
    budgets: { claude: { daily: 5.00 } },
    proactiveDailyBudget: 0.50
  });
  enforcer2.importUsage(exported);

  const summary = enforcer2.getUsageSummary('claude');
  assert.strictEqual(summary.daily.cost, 0.25);
  assert.strictEqual(enforcer2.proactiveUsage.dailyCost, 0.10);
  assert.strictEqual(enforcer2.proactiveUsage.dailyCalls, 1);
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

  // Simulate day change
  enforcer.lastDailyReset = '2020-01-01';
  enforcer.checkReset();

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
  enforcer.recordSpend('claude', 0.95, 1000);
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
  enforcer.recordSpend('claude', 0.95, 1000);
  // Activate with very short duration (already expired)
  enforcer._overrideActive = true;
  enforcer._overrideExpiry = Date.now() - 1; // already expired
  // Should not bypass
  assert.strictEqual(enforcer.canSpend('claude', 0.10).allowed, false);
  assert.strictEqual(enforcer.isOverrideActive(), false);
});

// --- Persistence Tests (async) ---

(async () => {
console.log('\n--- Persistence Tests ---\n');

await asyncTest('persist() writes JSON via ncRequestManager when dirty', async () => {
  const requestCalls = [];
  const mockNC = {
    request: async (path, options) => {
      requestCalls.push({ path, options });
      return { status: 200 };
    }
  };

  const enforcer = new BudgetEnforcer({
    budgets: { claude: { daily: 5.00 } },
    ncRequestManager: mockNC
  });

  // Not dirty yet — should not write
  await enforcer.persist();
  assert.strictEqual(requestCalls.length, 0, 'Should not write when not dirty');

  // Record spend makes it dirty
  enforcer.recordSpend('claude', 0.25, 250);
  assert.strictEqual(enforcer._dirty, true, 'Should be dirty after recordSpend');

  await enforcer.persist();
  assert.strictEqual(requestCalls.length, 1, 'Should write once when dirty');
  assert.strictEqual(requestCalls[0].options.method, 'PUT');
  assert.ok(requestCalls[0].path.includes('spending.json'));

  const written = JSON.parse(requestCalls[0].options.body);
  assert.ok(written.providers.claude, 'Should include claude provider');
  assert.strictEqual(enforcer._dirty, false, 'Should clear dirty flag after persist');
});

await asyncTest('persist() is no-op without ncRequestManager', async () => {
  const enforcer = new BudgetEnforcer({ budgets: {} });
  enforcer.recordSpend('test', 0.10, 100);
  // Should not throw
  await enforcer.persist();
  assert.strictEqual(enforcer._dirty, true, 'Dirty flag stays set without ncRequestManager');
});

await asyncTest('restore() reads JSON and imports usage', async () => {
  const savedData = {
    lastDailyReset: new Date().toISOString().split('T')[0],
    lastMonthlyReset: `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`,
    providers: {
      claude: { dailyCost: 1.50, dailyTokens: 1500, dailyCalls: 3, monthlyCost: 10.00, monthlyTokens: 10000, monthlyCalls: 20, lastCall: Date.now() }
    },
    proactiveUsage: { dailyCost: 0.25, dailyCalls: 2, dailyTokens: 200 }
  };

  const mockNC = {
    request: async (path, options) => {
      if (options.method === 'GET') {
        return { status: 200, body: savedData };
      }
      return { status: 200 };
    }
  };

  const enforcer = new BudgetEnforcer({
    budgets: { claude: { daily: 5.00 } },
    ncRequestManager: mockNC
  });

  await enforcer.restore();

  const summary = enforcer.getUsageSummary('claude');
  assert.strictEqual(summary.daily.cost, 1.50, 'Should restore daily cost');
  assert.strictEqual(summary.monthly.cost, 10.00, 'Should restore monthly cost');
  assert.strictEqual(enforcer.proactiveUsage.dailyCost, 0.25, 'Should restore proactive usage');
});

await asyncTest('restore() handles 404 gracefully', async () => {
  const mockNC = {
    request: async () => {
      const err = new Error('Not Found 404');
      err.statusCode = 404;
      throw err;
    }
  };

  const enforcer = new BudgetEnforcer({
    budgets: {},
    ncRequestManager: mockNC
  });

  // Should not throw
  await enforcer.restore();
  // Usage should remain at defaults
  assert.strictEqual(enforcer.usage.size, 0, 'Should have no usage data after 404');
});

await asyncTest('restore() is no-op without ncRequestManager', async () => {
  const enforcer = new BudgetEnforcer({ budgets: {} });
  // Should not throw
  await enforcer.restore();
});

test('_dirty flag is set by recordSpend and recordProactiveSpend', () => {
  const enforcer = new BudgetEnforcer({ budgets: {} });
  assert.strictEqual(enforcer._dirty, false, 'Should start clean');

  enforcer.recordSpend('claude', 0.10, 100);
  assert.strictEqual(enforcer._dirty, true, 'recordSpend should set dirty');

  enforcer._dirty = false;
  enforcer.recordProactiveSpend(0.05, 50);
  assert.strictEqual(enforcer._dirty, true, 'recordProactiveSpend should set dirty');
});

summary();
exitWithCode();
})();
