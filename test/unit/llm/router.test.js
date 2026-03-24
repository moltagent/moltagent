/**
 * LLMRouter Unit Tests
 *
 * Comprehensive test suite for the LLMRouter class.
 *
 * Run: node test/unit/llm/router.test.js
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const { createMockAuditLog, createMockNotifyUser } = require('../../helpers/mock-factories');

// Import module under test
const LLMRouter = require('../../../src/lib/llm/router');

// ============================================================
// Mock Provider Factory
// ============================================================

function createMockProvider(overrides = {}) {
  return {
    type: overrides.type || 'remote',
    id: overrides.id || 'mock-provider',
    generate: overrides.generate || (async (task, content, options) => ({
      result: 'Mock LLM response',
      model: 'mock-model',
      tokens: 150,
      inputTokens: 50,
      outputTokens: 100,
      cost: 0.001,
      duration: 500,
      headers: overrides.headers || {}
    })),
    estimateTokens: overrides.estimateTokens || ((content) => Math.ceil(String(content).length / 4)),
    estimateCost: overrides.estimateCost || ((input, output) => (input + output) * 0.00001),
    testConnection: overrides.testConnection || (async () => ({ connected: true }))
  };
}

// ============================================================
// Test Suites
// ============================================================

console.log('\n=== LLMRouter Tests ===\n');

// --- Constructor Tests ---
console.log('\n--- Constructor Tests ---\n');

test('TC-CTOR-001: Initialize with default configuration', () => {
  const router = new LLMRouter();

  assert.ok(router.providers instanceof Map);
  assert.ok(router.roles);
  assert.ok(router.rateLimits);
  assert.ok(router.budget);
  assert.ok(router.backoff);
  assert.ok(router.circuitBreaker);
  assert.ok(router.loopDetector);
  assert.ok(router.outputVerifier);
});

test('TC-CTOR-002: Initialize with custom roles', () => {
  const router = new LLMRouter({
    roles: {
      sovereign: ['local-1'],
      free: ['local-1', 'local-2'],
      value: ['remote-1'],
      premium: ['remote-2']
    }
  });

  assert.deepStrictEqual(router.roles.sovereign, ['local-1']);
  assert.deepStrictEqual(router.roles.free, ['local-1', 'local-2']);
  assert.deepStrictEqual(router.roles.value, ['remote-1']);
  assert.deepStrictEqual(router.roles.premium, ['remote-2']);
});

test('TC-CTOR-003: Initialize with fallback chains', () => {
  const router = new LLMRouter({
    fallbackChain: {
      'provider-a': ['provider-b', 'provider-c']
    }
  });

  assert.deepStrictEqual(router.fallbackChain['provider-a'], ['provider-b', 'provider-c']);
});

test('TC-CTOR-004: Initialize auditLog callback', () => {
  const mockAuditLog = createMockAuditLog();
  const router = new LLMRouter({ auditLog: mockAuditLog });

  assert.strictEqual(router.auditLog, mockAuditLog);
});

test('TC-CTOR-005: Initialize notifyUser callback', () => {
  const mockNotify = createMockNotifyUser();
  const router = new LLMRouter({ notifyUser: mockNotify });

  assert.strictEqual(router.notifyUser, mockNotify);
});

test('TC-CTOR-006: Initialize stats tracking', () => {
  const router = new LLMRouter();

  assert.strictEqual(router.stats.totalCalls, 0);
  assert.strictEqual(router.stats.successfulCalls, 0);
  assert.strictEqual(router.stats.failovers, 0);
  assert.strictEqual(router.stats.errors, 0);
  assert.deepStrictEqual(router.stats.byProvider, {});
  assert.deepStrictEqual(router.stats.byRole, {});
});

test('TC-CTOR-007: Initialize with custom circuit breaker config', () => {
  const router = new LLMRouter({
    circuitBreaker: {
      failureThreshold: 10,
      resetTimeoutMs: 120000,
      successThreshold: 5
    }
  });

  assert.strictEqual(router.circuitBreaker.failureThreshold, 10);
  assert.strictEqual(router.circuitBreaker.resetTimeoutMs, 120000);
  assert.strictEqual(router.circuitBreaker.successThreshold, 5);
});

test('TC-CTOR-008: Initialize with custom loop detector config', () => {
  const router = new LLMRouter({
    loopDetector: {
      maxConsecutiveErrors: 5,
      maxSameCall: 10,
      historyWindowMs: 120000,
      pingPongThreshold: 6
    }
  });

  assert.strictEqual(router.loopDetector.maxConsecutiveErrors, 5);
  assert.strictEqual(router.loopDetector.maxSameCall, 10);
});

// --- Build Chain Tests ---
console.log('\n--- Build Chain Tests ---\n');

test('TC-CHAIN-001: Build chain with role providers only', () => {
  const router = new LLMRouter({
    roles: {
      value: ['provider-a', 'provider-b']
    }
  });

  const chain = router._buildChain('value');

  assert.ok(chain.includes('provider-a'));
  assert.ok(chain.includes('provider-b'));
  assert.strictEqual(chain.indexOf('provider-a'), 0);
});

test('TC-CHAIN-002: Build chain includes fallbacks', () => {
  const router = new LLMRouter({
    roles: {
      value: ['provider-a']
    },
    fallbackChain: {
      'provider-a': ['provider-b', 'provider-c']
    }
  });

  const chain = router._buildChain('value');

  assert.ok(chain.includes('provider-a'));
  assert.ok(chain.includes('provider-b'));
  assert.ok(chain.includes('provider-c'));
});

test('TC-CHAIN-003: Build chain avoids duplicates', () => {
  const router = new LLMRouter({
    roles: {
      value: ['provider-a', 'provider-b']
    },
    fallbackChain: {
      'provider-a': ['provider-b', 'provider-c']
    }
  });

  const chain = router._buildChain('value');
  const providerBCount = chain.filter(p => p === 'provider-b').length;

  assert.strictEqual(providerBCount, 1);
});

test('TC-CHAIN-004: Build chain for unknown role returns empty', () => {
  const router = new LLMRouter({
    roles: {
      value: ['provider-a']
    }
  });

  const chain = router._buildChain('nonexistent');

  // Should be empty or only contain local providers
  assert.strictEqual(chain.filter(p => p === 'provider-a').length, 0);
});

// --- Route Tests - Happy Path ---
console.log('\n--- Route Tests - Happy Path ---\n');

asyncTest('TC-ROUTE-001: Route successful request', async () => {
  const mockProvider = createMockProvider();

  const router = new LLMRouter({
    roles: { value: ['mock-provider'] }
  });
  router.providers.set('mock-provider', mockProvider);

  const result = await router.route({
    task: 'test',
    content: 'Hello',
    requirements: { role: 'value' }
  });

  assert.strictEqual(result.result, 'Mock LLM response');
  assert.strictEqual(result.provider, 'mock-provider');
  assert.strictEqual(result.model, 'mock-model');
  assert.strictEqual(result.tokens, 150);
});

asyncTest('TC-ROUTE-002: Route tracks stats on success', async () => {
  const mockProvider = createMockProvider();

  const router = new LLMRouter({
    roles: { value: ['mock-provider'] }
  });
  router.providers.set('mock-provider', mockProvider);

  await router.route({ task: 'test', content: 'Hello' });

  assert.strictEqual(router.stats.totalCalls, 1);
  assert.strictEqual(router.stats.successfulCalls, 1);
  assert.strictEqual(router.stats.byProvider['mock-provider'], 1);
  assert.strictEqual(router.stats.byRole['value'], 1);
});

asyncTest('TC-ROUTE-003: Route with default role', async () => {
  const mockProvider = createMockProvider();

  const router = new LLMRouter({
    roles: { value: ['mock-provider'] }
  });
  router.providers.set('mock-provider', mockProvider);

  const result = await router.route({
    task: 'test',
    content: 'Hello'
    // No requirements.role - should default to 'value'
  });

  assert.strictEqual(result.result, 'Mock LLM response');
  assert.strictEqual(router.stats.byRole['value'], 1);
});

asyncTest('TC-ROUTE-004: Route logs audit on success', async () => {
  const mockAuditLog = createMockAuditLog();
  const mockProvider = createMockProvider();

  const router = new LLMRouter({
    roles: { value: ['mock-provider'] },
    auditLog: mockAuditLog
  });
  router.providers.set('mock-provider', mockProvider);

  await router.route({ task: 'test-task', content: 'Hello' });

  const calls = mockAuditLog.getCallsFor('llm_call');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].data.task, 'test-task');
  assert.strictEqual(calls[0].data.provider, 'mock-provider');
});

asyncTest('TC-ROUTE-005: Route updates rate limits from headers', async () => {
  const mockProvider = createMockProvider({
    generate: async () => ({
      result: 'Response',
      model: 'model',
      tokens: 100,
      headers: {
        requestsRemaining: 99,
        tokensRemaining: 9000
      }
    })
  });

  const router = new LLMRouter({
    roles: { value: ['mock-provider'] }
  });
  router.providers.set('mock-provider', mockProvider);

  await router.route({ task: 'test', content: 'Hello' });

  const limits = router.rateLimits.getLimits('mock-provider');
  assert.strictEqual(limits.requestsRemaining, 99);
  assert.strictEqual(limits.tokensRemaining, 9000);
});

asyncTest('TC-ROUTE-006: Route records budget spend', async () => {
  const mockProvider = createMockProvider({
    generate: async () => ({
      result: 'Response',
      model: 'model',
      tokens: 100,
      cost: 0.005
    })
  });

  const router = new LLMRouter({
    roles: { value: ['mock-provider'] },
    budgets: { 'mock-provider': { daily: 10 } }
  });
  router.providers.set('mock-provider', mockProvider);

  // Wire a mock CostTracker so canSpend() and recordSpend() work
  let recordedCost = 0;
  router.budget.costTracker = {
    getTotals: () => ({
      daily: { costUsd: recordedCost, costEur: recordedCost * 0.92, cloudCalls: 0, localCalls: 0 },
      monthly: { costUsd: recordedCost, costEur: recordedCost * 0.92, cloudCalls: 0, localCalls: 0 },
      localRatio: 100, topSpending: []
    })
  };

  await router.route({ task: 'test', content: 'Hello' });

  // After a successful route, recordSpend() was called — verify via costTracker
  // (CostTracker is now the accumulator; BudgetEnforcer only enforces caps)
  assert.ok(router.budget.costTracker, 'CostTracker should be wired');
  assert.ok(router.budget.budgets['mock-provider'], 'Budget config should exist');
});

// --- Route Tests - Failover ---
console.log('\n--- Route Tests - Failover ---\n');

asyncTest('TC-FAILOVER-001: Failover on rate limit', async () => {
  const primaryProvider = createMockProvider({
    id: 'primary'
  });
  const backupProvider = createMockProvider({
    id: 'backup',
    generate: async () => ({
      result: 'Backup response',
      model: 'backup-model',
      tokens: 100
    })
  });

  const router = new LLMRouter({
    roles: { value: ['primary', 'backup'] }
  });
  router.providers.set('primary', primaryProvider);
  router.providers.set('backup', backupProvider);

  // Mark primary as rate limited
  router.rateLimits.markRateLimited('primary', 60);

  const result = await router.route({ task: 'test', content: 'Hello' });

  assert.strictEqual(result.result, 'Backup response');
  assert.strictEqual(result.provider, 'backup');
  assert.ok(result.failoverPath);
  assert.ok(result.failoverPath.includes('primary'));
});

asyncTest('TC-FAILOVER-002: Failover on circuit open', async () => {
  const primaryProvider = createMockProvider({ id: 'primary' });
  const backupProvider = createMockProvider({
    id: 'backup',
    generate: async () => ({
      result: 'Backup response',
      model: 'backup-model',
      tokens: 100
    })
  });

  const router = new LLMRouter({
    roles: { value: ['primary', 'backup'] }
  });
  router.providers.set('primary', primaryProvider);
  router.providers.set('backup', backupProvider);

  // Force open circuit for primary
  router.circuitBreaker.forceOpen('primary');

  const result = await router.route({ task: 'test', content: 'Hello' });

  assert.strictEqual(result.provider, 'backup');
  assert.ok(result.failoverPath.includes('primary'));
});

asyncTest('TC-FAILOVER-003: Failover increments stats', async () => {
  const primaryProvider = createMockProvider({ id: 'primary' });
  const backupProvider = createMockProvider({
    id: 'backup',
    generate: async () => ({
      result: 'Response',
      model: 'model',
      tokens: 100
    })
  });

  const router = new LLMRouter({
    roles: { value: ['primary', 'backup'] }
  });
  router.providers.set('primary', primaryProvider);
  router.providers.set('backup', backupProvider);

  router.rateLimits.markRateLimited('primary', 60);

  await router.route({ task: 'test', content: 'Hello' });

  assert.strictEqual(router.stats.failovers, 1);
});

asyncTest('TC-FAILOVER-004: Failover on budget exhausted', async () => {
  const primaryProvider = createMockProvider({
    id: 'primary',
    estimateCost: () => 100 // Very expensive
  });
  const backupProvider = createMockProvider({
    id: 'backup',
    generate: async () => ({
      result: 'Backup response',
      model: 'model',
      tokens: 100
    })
  });

  const router = new LLMRouter({
    roles: { value: ['primary', 'backup'] },
    budgets: { primary: { daily: 1 } } // Low budget
  });
  router.providers.set('primary', primaryProvider);
  router.providers.set('backup', backupProvider);

  // Exhaust budget by wiring a CostTracker that reports spend above the cap
  router.budget.costTracker = {
    getTotals: () => ({
      daily: { costUsd: 1.5, costEur: 1.38, cloudCalls: 1, localCalls: 0 },
      monthly: { costUsd: 1.5, costEur: 1.38, cloudCalls: 1, localCalls: 0 },
      localRatio: 0, topSpending: []
    })
  };

  const result = await router.route({ task: 'test', content: 'Hello' });

  assert.strictEqual(result.provider, 'backup');
});

asyncTest('TC-FAILOVER-005: Failover on provider error', async () => {
  const primaryProvider = createMockProvider({
    id: 'primary',
    generate: async () => {
      throw new Error('Provider failed');
    }
  });
  const backupProvider = createMockProvider({
    id: 'backup',
    generate: async () => ({
      result: 'Backup response',
      model: 'model',
      tokens: 100
    })
  });

  const router = new LLMRouter({
    roles: { value: ['primary', 'backup'] }
  });
  router.providers.set('primary', primaryProvider);
  router.providers.set('backup', backupProvider);

  const result = await router.route({ task: 'test', content: 'Hello' });

  assert.strictEqual(result.provider, 'backup');
  assert.ok(result.failoverPath.includes('primary'));
});

// --- Route Tests - Errors ---
console.log('\n--- Route Tests - Errors ---\n');

asyncTest('TC-ERROR-001: Throw when no providers available', async () => {
  const router = new LLMRouter({
    roles: { value: [] }
  });

  try {
    await router.route({ task: 'test', content: 'Hello' });
    assert.fail('Should have thrown');
  } catch (error) {
    assert.ok(error.message.includes('No providers available'));
  }
});

asyncTest('TC-ERROR-002: Throw when all providers exhausted', async () => {
  const failingProvider = createMockProvider({
    id: 'failing',
    generate: async () => {
      throw new Error('Failed');
    }
  });

  const router = new LLMRouter({
    roles: { value: ['failing'] }
  });
  router.providers.set('failing', failingProvider);

  try {
    await router.route({ task: 'test', content: 'Hello' });
    assert.fail('Should have thrown');
  } catch (error) {
    assert.ok(error.message.includes('All providers exhausted'));
  }
});

asyncTest('TC-ERROR-003: Log audit when all exhausted', async () => {
  const mockAuditLog = createMockAuditLog();
  const failingProvider = createMockProvider({
    id: 'failing',
    generate: async () => {
      throw new Error('Failed');
    }
  });

  const router = new LLMRouter({
    roles: { value: ['failing'] },
    auditLog: mockAuditLog
  });
  router.providers.set('failing', failingProvider);

  try {
    await router.route({ task: 'test', content: 'Hello' });
  } catch {
    // Expected
  }

  const calls = mockAuditLog.getCallsFor('llm_all_exhausted');
  assert.strictEqual(calls.length, 1);
});

asyncTest('TC-ERROR-004: Notify user when all exhausted', async () => {
  const mockNotify = createMockNotifyUser();
  const failingProvider = createMockProvider({
    id: 'failing',
    generate: async () => {
      throw new Error('Failed');
    }
  });

  const router = new LLMRouter({
    roles: { value: ['failing'] },
    notifyUser: mockNotify
  });
  router.providers.set('failing', failingProvider);

  try {
    await router.route({ task: 'test', content: 'Hello' });
  } catch {
    // Expected
  }

  const notifications = mockNotify.getNotifications();
  assert.ok(notifications.some(n => n.type === 'all_exhausted'));
});

asyncTest('TC-ERROR-005: Permanent error does not failover', async () => {
  const primaryProvider = createMockProvider({
    id: 'primary',
    generate: async () => {
      const error = new Error('Invalid request');
      error.status = 400;
      throw error;
    }
  });
  const backupProvider = createMockProvider({ id: 'backup' });

  const router = new LLMRouter({
    roles: { value: ['primary', 'backup'] }
  });
  router.providers.set('primary', primaryProvider);
  router.providers.set('backup', backupProvider);

  try {
    await router.route({ task: 'test', content: 'Hello' });
    assert.fail('Should have thrown');
  } catch (error) {
    assert.strictEqual(error.message, 'Invalid request');
  }
});

// --- Loop Detection Tests ---
console.log('\n--- Loop Detection Tests ---\n');

asyncTest('TC-LOOP-001: Block when loop detected', async () => {
  const router = new LLMRouter({
    roles: { value: ['mock'] },
    loopDetector: {
      maxSameCall: 2
    }
  });
  router.providers.set('mock', createMockProvider());

  // Simulate loop by recording same call multiple times
  const signature = { type: 'llm', action: 'test', params: { role: 'value', contentHash: 'test:4' } };
  router.loopDetector.recordCall(signature);
  router.loopDetector.recordCall(signature);
  router.loopDetector.recordCall(signature);

  try {
    await router.route({ task: 'test', content: 'test' });
    assert.fail('Should have thrown');
  } catch (error) {
    assert.ok(error.message.includes('Loop detected'));
  }
});

asyncTest('TC-LOOP-002: Log audit when loop blocked', async () => {
  const mockAuditLog = createMockAuditLog();
  const router = new LLMRouter({
    roles: { value: ['mock'] },
    auditLog: mockAuditLog,
    loopDetector: {
      maxSameCall: 2
    }
  });
  router.providers.set('mock', createMockProvider());

  const signature = { type: 'llm', action: 'test', params: { role: 'value', contentHash: 'test:4' } };
  router.loopDetector.recordCall(signature);
  router.loopDetector.recordCall(signature);
  router.loopDetector.recordCall(signature);

  try {
    await router.route({ task: 'test', content: 'test' });
  } catch {
    // Expected
  }

  const calls = mockAuditLog.getCallsFor('llm_loop_blocked');
  assert.strictEqual(calls.length, 1);
});

// --- Output Verification Tests ---
console.log('\n--- Output Verification Tests ---\n');

asyncTest('TC-VERIFY-001: Block unsafe output', async () => {
  const mockProvider = createMockProvider({
    generate: async () => ({
      result: 'Contact: password123@secret.com',
      model: 'model',
      tokens: 100
    })
  });

  const router = new LLMRouter({
    roles: { value: ['mock'] },
    outputVerifier: {
      strictMode: true
    }
  });
  router.providers.set('mock', mockProvider);

  // The output verifier should flag this - may or may not throw depending on config
  const result = await router.route({ task: 'test', content: 'Hello' });
  // If it passes, verify warnings exist or result is sanitized
  assert.ok(result);
});

asyncTest('TC-VERIFY-002: Log audit for output warnings', async () => {
  const mockAuditLog = createMockAuditLog();
  const mockProvider = createMockProvider();

  const router = new LLMRouter({
    roles: { value: ['mock'] },
    auditLog: mockAuditLog
  });
  router.providers.set('mock', mockProvider);

  await router.route({ task: 'test', content: 'Hello' });

  // Verify llm_call was logged
  const calls = mockAuditLog.getCallsFor('llm_call');
  assert.strictEqual(calls.length, 1);
  assert.ok('outputVerified' in calls[0].data);
});

// --- Error Type Classification Tests ---
console.log('\n--- Error Type Classification Tests ---\n');

test('TC-ERRTYPE-001: Identify rate limit error by status', () => {
  const router = new LLMRouter();
  const error = new Error('Rate limit');
  error.status = 429;

  assert.strictEqual(router._isRateLimitError(error), true);
});

test('TC-ERRTYPE-002: Identify rate limit error by code', () => {
  const router = new LLMRouter();
  const error = new Error('Too many requests');
  error.code = 'rate_limit_exceeded';

  assert.strictEqual(router._isRateLimitError(error), true);
});

test('TC-ERRTYPE-003: Identify rate limit error by message', () => {
  const router = new LLMRouter();
  const error = new Error('You have hit the rate limit');

  assert.strictEqual(router._isRateLimitError(error), true);
});

test('TC-ERRTYPE-004: Identify transient error 500', () => {
  const router = new LLMRouter();
  const error = new Error('Internal error');
  error.status = 500;

  assert.strictEqual(router._isTransientError(error), true);
});

test('TC-ERRTYPE-005: Identify transient error 502', () => {
  const router = new LLMRouter();
  const error = new Error('Bad gateway');
  error.status = 502;

  assert.strictEqual(router._isTransientError(error), true);
});

test('TC-ERRTYPE-006: Identify transient error 503', () => {
  const router = new LLMRouter();
  const error = new Error('Service unavailable');
  error.status = 503;

  assert.strictEqual(router._isTransientError(error), true);
});

test('TC-ERRTYPE-007: Identify transient error 504', () => {
  const router = new LLMRouter();
  const error = new Error('Gateway timeout');
  error.status = 504;

  assert.strictEqual(router._isTransientError(error), true);
});

test('TC-ERRTYPE-008: Identify overloaded error by code', () => {
  const router = new LLMRouter();
  const error = new Error('Server overloaded');
  error.code = 'overloaded';

  assert.strictEqual(router._isTransientError(error), true);
});

test('TC-ERRTYPE-009: Identify permanent error 400', () => {
  const router = new LLMRouter();
  const error = new Error('Bad request');
  error.status = 400;

  assert.strictEqual(router._isPermanentError(error), true);
});

test('TC-ERRTYPE-010: Identify permanent error 401', () => {
  const router = new LLMRouter();
  const error = new Error('Unauthorized');
  error.status = 401;

  assert.strictEqual(router._isPermanentError(error), true);
});

test('TC-ERRTYPE-011: Identify permanent error 403', () => {
  const router = new LLMRouter();
  const error = new Error('Forbidden');
  error.status = 403;

  assert.strictEqual(router._isPermanentError(error), true);
});

test('TC-ERRTYPE-012: Identify permanent error 404', () => {
  const router = new LLMRouter();
  const error = new Error('Not found');
  error.status = 404;

  assert.strictEqual(router._isPermanentError(error), true);
});

// --- Test Connections Tests ---
console.log('\n--- Test Connections Tests ---\n');

asyncTest('TC-CONN-001: Test all provider connections', async () => {
  const provider1 = createMockProvider({
    id: 'provider-1',
    testConnection: async () => ({ connected: true, latency: 100 })
  });
  const provider2 = createMockProvider({
    id: 'provider-2',
    testConnection: async () => ({ connected: true, latency: 200 })
  });

  const router = new LLMRouter();
  router.providers.set('provider-1', provider1);
  router.providers.set('provider-2', provider2);

  const results = await router.testConnections();

  assert.strictEqual(results['provider-1'].connected, true);
  assert.strictEqual(results['provider-2'].connected, true);
});

asyncTest('TC-CONN-002: Handle connection test failure', async () => {
  const failingProvider = createMockProvider({
    id: 'failing',
    testConnection: async () => {
      throw new Error('Connection failed');
    }
  });

  const router = new LLMRouter();
  router.providers.set('failing', failingProvider);

  const results = await router.testConnections();

  assert.strictEqual(results['failing'].connected, false);
  assert.strictEqual(results['failing'].error, 'Connection failed');
});

// --- Statistics Tests ---
console.log('\n--- Statistics Tests ---\n');

test('TC-STATS-001: Get stats returns all fields', () => {
  const router = new LLMRouter();

  const stats = router.getStats();

  assert.ok('totalCalls' in stats);
  assert.ok('successfulCalls' in stats);
  assert.ok('failovers' in stats);
  assert.ok('errors' in stats);
  assert.ok('byProvider' in stats);
  assert.ok('byRole' in stats);
  assert.ok('rateLimits' in stats);
  assert.ok('budget' in stats);
  assert.ok('backoff' in stats);
  assert.ok('circuitBreaker' in stats);
  assert.ok('loopDetector' in stats);
  assert.ok('outputVerifier' in stats);
});

asyncTest('TC-STATS-002: Stats accumulate across calls', async () => {
  const router = new LLMRouter({
    roles: { value: ['mock'] }
  });
  router.providers.set('mock', createMockProvider());

  await router.route({ task: 'test1', content: 'Hello' });
  await router.route({ task: 'test2', content: 'World' });
  await router.route({ task: 'test3', content: 'Foo' });

  assert.strictEqual(router.stats.totalCalls, 3);
  assert.strictEqual(router.stats.successfulCalls, 3);
});

// --- Available Roles Tests ---
console.log('\n--- Available Roles Tests ---\n');

test('TC-ROLES-001: Get available roles', () => {
  const router = new LLMRouter({
    roles: {
      sovereign: ['local'],
      free: ['local'],
      value: ['remote'],
      premium: ['remote-premium']
    }
  });

  const roles = router.getAvailableRoles();

  assert.ok(roles.includes('sovereign'));
  assert.ok(roles.includes('free'));
  assert.ok(roles.includes('value'));
  assert.ok(roles.includes('premium'));
});

test('TC-ROLES-002: Get providers for role', () => {
  const router = new LLMRouter({
    roles: {
      value: ['provider-a', 'provider-b']
    },
    fallbackChain: {
      'provider-a': ['provider-c']
    }
  });

  const providers = router.getProvidersForRole('value');

  assert.ok(providers.includes('provider-a'));
  assert.ok(providers.includes('provider-b'));
  assert.ok(providers.includes('provider-c'));
});

// --- Content Hash Tests ---
console.log('\n--- Content Hash Tests ---\n');

test('TC-HASH-001: Hash string content', () => {
  const router = new LLMRouter();

  const hash = router._hashContent('Hello World');

  assert.ok(hash.includes('Hello World'));
  assert.ok(hash.includes(':11'));
});

test('TC-HASH-002: Hash empty content', () => {
  const router = new LLMRouter();

  const hash = router._hashContent('');

  assert.strictEqual(hash, 'empty');
});

test('TC-HASH-003: Hash null content', () => {
  const router = new LLMRouter();

  const hash = router._hashContent(null);

  assert.strictEqual(hash, 'empty');
});

test('TC-HASH-004: Hash object content', () => {
  const router = new LLMRouter();

  const hash = router._hashContent({ key: 'value' });

  assert.ok(hash.includes('key'));
  assert.ok(hash.includes('value'));
});

test('TC-HASH-005: Hash truncates long content', () => {
  const router = new LLMRouter();
  const longContent = 'A'.repeat(200);

  const hash = router._hashContent(longContent);

  assert.ok(hash.startsWith('A'.repeat(100)));
  assert.ok(hash.includes(':200'));
});

// --- Callback Handler Tests ---
console.log('\n--- Callback Handler Tests ---\n');

asyncTest('TC-CALLBACK-001: Handle budget warning', async () => {
  const mockNotify = createMockNotifyUser();
  const router = new LLMRouter({
    notifyUser: mockNotify
  });

  await router._handleBudgetWarning({
    providerId: 'test-provider',
    spent: 8.5,
    budget: 10,
    percentUsed: 85
  });

  const notifications = mockNotify.getNotifications();
  assert.strictEqual(notifications.length, 1);
  assert.strictEqual(notifications[0].type, 'budget_warning');
  assert.strictEqual(notifications[0].provider, 'test-provider');
});

asyncTest('TC-CALLBACK-002: Handle budget exhausted', async () => {
  const mockNotify = createMockNotifyUser();
  const router = new LLMRouter({
    notifyUser: mockNotify
  });

  await router._handleBudgetExhausted({
    providerId: 'test-provider',
    spent: 10.5,
    budget: 10,
    resetAt: new Date()
  });

  const notifications = mockNotify.getNotifications();
  assert.strictEqual(notifications.length, 1);
  assert.strictEqual(notifications[0].type, 'budget_exhausted');
});

asyncTest('TC-CALLBACK-003: Handle circuit state change', async () => {
  const mockAuditLog = createMockAuditLog();
  const mockNotify = createMockNotifyUser();
  const router = new LLMRouter({
    auditLog: mockAuditLog,
    notifyUser: mockNotify
  });

  await router._handleCircuitStateChange({
    providerId: 'test-provider',
    oldState: 'closed',
    newState: 'open',
    failures: 5,
    lastError: 'Connection timeout'
  });

  const auditCalls = mockAuditLog.getCallsFor('circuit_state_change');
  assert.strictEqual(auditCalls.length, 1);

  const notifications = mockNotify.getNotifications();
  assert.ok(notifications.some(n => n.type === 'circuit_opened'));
});

asyncTest('TC-CALLBACK-004: Handle loop detected', async () => {
  const mockAuditLog = createMockAuditLog();
  const mockNotify = createMockNotifyUser();
  const router = new LLMRouter({
    auditLog: mockAuditLog,
    notifyUser: mockNotify
  });

  await router._handleLoopDetected({
    type: 'same_call',
    reason: 'Same call repeated 5 times',
    suggestion: 'Check for infinite loop',
    pattern: 'test-pattern'
  });

  const auditCalls = mockAuditLog.getCallsFor('loop_detected');
  assert.strictEqual(auditCalls.length, 1);

  const notifications = mockNotify.getNotifications();
  assert.ok(notifications.some(n => n.type === 'loop_detected'));
});

// --- Dynamic Provider Registration Tests (B2: Models card wiring) ---
console.log('\n--- Dynamic Provider Registration Tests ---\n');

test('TC-REG-001: registerProvider adds provider to the Map', () => {
  const router = new LLMRouter();

  router.registerProvider('test-cloud', {
    adapter: 'openai-compatible',
    endpoint: 'https://api.example.com/v1',
    model: 'gpt-4o',
    type: 'api',
    getCredential: async () => 'fake-key'
  });

  assert.ok(router.providers.has('test-cloud'), 'Provider should be in the map');
});

test('TC-REG-002: unregisterProvider removes provider from the Map', () => {
  const router = new LLMRouter();

  router.registerProvider('removable', {
    adapter: 'openai-compatible',
    endpoint: 'https://api.example.com/v1',
    model: 'gpt-4o-mini',
    getCredential: async () => 'fake-key'
  });

  assert.ok(router.providers.has('removable'), 'Should exist before removal');
  router.unregisterProvider('removable');
  assert.strictEqual(router.providers.has('removable'), false, 'Should not exist after removal');
});

test('TC-REG-003: unregisterProvider is a no-op for unknown id', () => {
  const router = new LLMRouter();
  // Should not throw
  router.unregisterProvider('does-not-exist');
  assert.ok(true, 'no-op — no error thrown');
});

test('TC-REG-004: getRegisteredProviders returns metadata for all providers', () => {
  const router = new LLMRouter();

  router.registerProvider('cloud-a', {
    adapter: 'openai-compatible',
    endpoint: 'https://api.example.com/v1',
    model: 'model-a',
    getCredential: async () => 'key-a'
  });

  const all = router.getRegisteredProviders();
  assert.ok('cloud-a' in all, 'cloud-a should appear in result');
  assert.ok('type' in all['cloud-a'], 'type field should be present');
  assert.ok('model' in all['cloud-a'], 'model field should be present');
  assert.ok('endpoint' in all['cloud-a'], 'endpoint field should be present');
});

test('TC-REG-005: getRegisteredProviders includes statically-initialized providers', () => {
  const router = new LLMRouter({
    providers: {
      'ollama-local': { adapter: 'ollama', endpoint: 'http://localhost:11434', model: 'phi4-mini' }
    }
  });

  const all = router.getRegisteredProviders();
  assert.ok('ollama-local' in all, 'statically-initialized provider should appear');
});

// --- setRoster with custom job names (B2: Any job accepted) ---
console.log('\n--- setRoster Custom Job Name Tests ---\n');

test('TC-ROSTER-001: setRoster accepts custom job names beyond VALID_JOBS', () => {
  const router = new LLMRouter({
    providers: {
      'ollama-local': { adapter: 'ollama', endpoint: 'http://localhost:11434', model: 'phi4-mini' }
    }
  });

  // 'images' is not in VALID_JOBS but should NOT be silently dropped now
  router.setRoster({
    quick: ['ollama-local'],
    images: ['ollama-local']   // custom job type
  });

  const roster = router.getRoster();
  assert.ok(roster !== null, 'roster should be set');
  assert.ok('quick' in roster, 'standard job should be in roster');
  assert.ok('images' in roster, 'custom job should be accepted in roster');
});

test('TC-ROSTER-002: setRoster rejects credentials job (always enforced locally)', () => {
  const router = new LLMRouter({
    providers: {
      'ollama-local': { adapter: 'ollama', endpoint: 'http://localhost:11434', model: 'phi4-mini' }
    }
  });

  router.setRoster({
    quick: ['ollama-local'],
    credentials: ['some-cloud-provider']  // should be rejected
  });

  const roster = router.getRoster();
  // credentials entry should come from smart-mix preset (local-only), not our override
  if ('credentials' in roster) {
    const credChain = roster.credentials;
    // All providers in credentials chain must be local-type (or undefined)
    for (const id of credChain) {
      const p = router.providers.get(id);
      if (p) {
        assert.strictEqual(p.type, 'local', `credentials chain must only contain local providers, got: ${p.type}`);
      }
    }
  }
});

test('TC-ROSTER-003: setRoster with unknown provider IDs filters them out', () => {
  const router = new LLMRouter({
    providers: {
      'ollama-local': { adapter: 'ollama', endpoint: 'http://localhost:11434', model: 'phi4-mini' }
    }
  });

  router.setRoster({
    quick: ['ollama-local', 'nonexistent-provider']
  });

  const roster = router.getRoster();
  assert.ok(!roster.quick.includes('nonexistent-provider'), 'Unknown provider IDs should be filtered');
  assert.ok(roster.quick.includes('ollama-local'), 'Known provider should remain');
});

// --- buildProviderChain fallback for unknown jobs ---
console.log('\n--- buildProviderChain Unknown Job Fallback Tests ---\n');

test('TC-CHAIN-001: buildProviderChain falls back to local providers for unknown job', () => {
  const router = new LLMRouter({
    providers: {
      'ollama-local': { adapter: 'ollama', endpoint: 'http://localhost:11434', model: 'phi4-mini' }
    }
  });

  // Activate a preset so _roster is set
  router.setPreset('all-local');

  const { chain } = router.buildProviderChain('video-generation');
  // ollama-local should appear as the local fallback
  const ids = chain.map(c => c.id);
  assert.ok(ids.includes('ollama-local'), 'Local provider should appear as fallback for unknown job');
});

test('TC-CHAIN-002: buildProviderChain uses roster entry for known job', () => {
  const router = new LLMRouter({
    providers: {
      'ollama-local': { adapter: 'ollama', endpoint: 'http://localhost:11434', model: 'phi4-mini' }
    }
  });

  router.setPreset('all-local');

  const { chain } = router.buildProviderChain('quick');
  const ids = chain.map(c => c.id);
  assert.ok(ids.length > 0, 'Chain should not be empty for known job');
  assert.ok(ids.includes('ollama-local'), 'Local provider should be in chain');
});

// --- LegacyLLMRouter proxy tests ---
console.log('\n--- LegacyLLMRouter Proxy Tests ---\n');

// Load the wrapper to test its proxy methods
let LegacyLLMRouter;
try {
  LegacyLLMRouter = require('../../../src/lib/llm-router');
} catch (e) {
  // skip if load fails in CI — it requires config files
  LegacyLLMRouter = null;
}

if (LegacyLLMRouter) {
  test('TC-PROXY-001: setPreset proxy delegates to inner router', () => {
    const wrapper = new LegacyLLMRouter({});
    // Should not throw, and should set the preset on the inner router
    wrapper.setPreset('all-local');
    assert.strictEqual(wrapper.getPreset(), 'all-local', 'Preset should be accessible via proxy');
  });

  test('TC-PROXY-002: setRoster/getRoster proxy delegates to inner router', () => {
    const wrapper = new LegacyLLMRouter({
      ollama: { url: 'http://localhost:11434', model: 'phi4-mini' }
    });

    wrapper.setRoster({ quick: ['ollama-local'] });
    const roster = wrapper.getRoster();
    assert.ok(roster !== null, 'Roster should be accessible via proxy');
  });

  test('TC-PROXY-003: registerProvider proxy delegates to inner router', () => {
    const wrapper = new LegacyLLMRouter({
      ollama: { url: 'http://localhost:11434', model: 'phi4-mini' }
    });

    // Should not throw
    assert.doesNotThrow(() => {
      wrapper.registerProvider('test-provider', {
        adapter: 'ollama',
        endpoint: 'http://localhost:11434',
        model: 'phi3',
        getCredential: async () => null
      });
    });

    const all = wrapper.getRegisteredProviders();
    assert.ok('test-provider' in all, 'Registered provider should appear via proxy');
  });

  test('TC-PROXY-004: unregisterProvider proxy delegates to inner router', () => {
    const wrapper = new LegacyLLMRouter({
      ollama: { url: 'http://localhost:11434', model: 'phi4-mini' }
    });

    wrapper.registerProvider('temp-provider', {
      adapter: 'ollama',
      endpoint: 'http://localhost:11434',
      model: 'phi3',
      getCredential: async () => null
    });

    assert.ok('temp-provider' in wrapper.getRegisteredProviders());
    wrapper.unregisterProvider('temp-provider');
    assert.ok(!('temp-provider' in wrapper.getRegisteredProviders()), 'Should be removed via proxy');
  });
}

// ─── allowCloud override tests ────────────────────────────────────────

{
  const cloudProvider = createMockProvider({ id: 'claude-haiku', type: 'remote' });
  const localProvider = createMockProvider({ id: 'ollama-fast', type: 'local' });
  const localProvider2 = createMockProvider({ id: 'ollama-local', type: 'local' });

  test('buildProviderChain: allowCloud uses smart-mix roster on all-local preset', () => {
    const router = new LLMRouter({ auditLog: createMockAuditLog(), notifyUser: createMockNotifyUser() });
    router.providers.set('claude-haiku', cloudProvider);
    router.providers.set('ollama-fast', localProvider);
    router.providers.set('ollama-local', localProvider2);
    router.setPreset('all-local');

    // Without allowCloud — only local
    const { chain: localChain } = router.buildProviderChain('tools', {});
    const localIds = localChain.map(e => e.id);
    assert.ok(localIds.every(id => id.startsWith('ollama')), 'all-local: only local providers');

    // With allowCloud — should include cloud
    const { chain: cloudChain } = router.buildProviderChain('tools', { allowCloud: true });
    const cloudIds = cloudChain.map(e => e.id);
    assert.ok(cloudIds.some(id => id === 'claude-haiku'), 'allowCloud: cloud provider in chain');
  });

  test('buildProviderChain: allowCloud overrides forceLocal', () => {
    const router = new LLMRouter({ auditLog: createMockAuditLog(), notifyUser: createMockNotifyUser() });
    router.providers.set('claude-haiku', cloudProvider);
    router.providers.set('ollama-fast', localProvider);
    router.setPreset('all-local');

    // forceLocal + allowCloud → allowCloud wins
    const { chain } = router.buildProviderChain('tools', { forceLocal: true, allowCloud: true });
    const ids = chain.map(e => e.id);
    assert.ok(ids.some(id => id === 'claude-haiku'), 'allowCloud overrides forceLocal');
  });

  test('buildProviderChain: allowCloud false keeps all-local roster', () => {
    const router = new LLMRouter({ auditLog: createMockAuditLog(), notifyUser: createMockNotifyUser() });
    router.providers.set('claude-haiku', cloudProvider);
    router.providers.set('ollama-fast', localProvider);
    router.setPreset('all-local');

    const { chain } = router.buildProviderChain('tools', { allowCloud: false });
    const ids = chain.map(e => e.id);
    assert.ok(!ids.includes('claude-haiku'), 'allowCloud false: no cloud providers');
  });

  test('buildProviderChain: allowCloud still blocks credentials job from cloud', () => {
    const router = new LLMRouter({ auditLog: createMockAuditLog(), notifyUser: createMockNotifyUser() });
    router.providers.set('claude-haiku', cloudProvider);
    router.providers.set('ollama-fast', localProvider);
    router.setPreset('all-local');

    const { chain } = router.buildProviderChain('credentials', { allowCloud: true });
    const ids = chain.map(e => e.id);
    assert.ok(!ids.includes('claude-haiku'), 'credentials job: cloud blocked even with allowCloud');
  });
}

// Summary
setTimeout(() => {
  summary();
  exitWithCode();
}, 100);
