'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const BaseExecutor = require('../../../src/lib/agent/executors/base-executor');

const silentLogger = { log() {}, info() {}, warn() {}, error() {} };

function createMockRouter(routeResult) {
  return {
    route: async () => routeResult || { result: '{"action":"test"}', provider: 'mock', tokens: 10 }
  };
}

// -- Test 1: _extractJSON() strips markdown fences --
asyncTest('_extractJSON() strips markdown fences and parses JSON', async () => {
  const executor = new BaseExecutor({
    router: createMockRouter({ result: '```json\n{"action":"create","title":"Test"}\n```' }),
    logger: silentLogger
  });
  const result = await executor._extractJSON('test message', 'Extract stuff');
  assert.deepStrictEqual(result, { action: 'create', title: 'Test' });
});

// -- Test 2: _extractJSON() returns null on invalid JSON --
asyncTest('_extractJSON() returns null on invalid JSON', async () => {
  const executor = new BaseExecutor({
    router: createMockRouter({ result: 'This is not JSON at all' }),
    logger: silentLogger
  });
  const result = await executor._extractJSON('test', 'Extract');
  assert.strictEqual(result, null);
});

// -- Test 3: _resolveDate('tomorrow') → correct ISO date --
test('_resolveDate("tomorrow") returns correct ISO date', () => {
  const executor = new BaseExecutor({ router: createMockRouter(), logger: silentLogger });
  const result = executor._resolveDate('tomorrow');
  const expected = new Date();
  expected.setDate(expected.getDate() + 1);
  const y = expected.getFullYear();
  const m = String(expected.getMonth() + 1).padStart(2, '0');
  const d = String(expected.getDate()).padStart(2, '0');
  assert.strictEqual(result, `${y}-${m}-${d}`);
});

// -- Test 4: _resolveDate('Monday') → next Monday --
test('_resolveDate("Monday") returns next Monday', () => {
  const executor = new BaseExecutor({ router: createMockRouter(), logger: silentLogger });
  const result = executor._resolveDate('Monday');
  assert.ok(result, 'Should return a date string');
  // Verify it's a Monday
  const parsed = new Date(result + 'T00:00:00');
  assert.strictEqual(parsed.getDay(), 1, 'Should be Monday (day 1)');
  // Verify it's in the future
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  assert.ok(parsed >= today, 'Should be in the future');
});

// -- Test 5: _resolveDate('2026-03-15') → passthrough --
test('_resolveDate("2026-03-15") passes through ISO dates', () => {
  const executor = new BaseExecutor({ router: createMockRouter(), logger: silentLogger });
  assert.strictEqual(executor._resolveDate('2026-03-15'), '2026-03-15');
});

// -- Test 6: _resolveDate('garbage') → null --
test('_resolveDate("garbage") returns null', () => {
  const executor = new BaseExecutor({ router: createMockRouter(), logger: silentLogger });
  assert.strictEqual(executor._resolveDate('garbage'), null);
});

// -- Test 7: _checkGuardrails() runs both guard layers --
asyncTest('_checkGuardrails() runs ToolGuard then GuardrailEnforcer', async () => {
  let toolGuardCalled = false;
  let enforcerCalled = false;
  const executor = new BaseExecutor({
    router: createMockRouter(),
    toolGuard: {
      evaluate: () => { toolGuardCalled = true; return { allowed: true }; }
    },
    guardrailEnforcer: {
      check: async () => { enforcerCalled = true; return { allowed: true }; },
      checkApproval: async () => ({ allowed: true })
    },
    logger: silentLogger
  });
  const result = await executor._checkGuardrails('deck_list', {}, null);
  assert.strictEqual(result.allowed, true);
  assert.strictEqual(toolGuardCalled, true, 'ToolGuard should be called');
  assert.strictEqual(enforcerCalled, true, 'GuardrailEnforcer should be called');
});

// -- Test 8: Constructor throws without router --
test('Constructor throws without router', () => {
  assert.throws(
    () => new BaseExecutor({ logger: silentLogger }),
    /requires a router/
  );
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
