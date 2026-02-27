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

// -- Test 9: _extractJSON() defaults to job='tools' --
asyncTest('_extractJSON() defaults to job=tools for roster routing', async () => {
  let capturedJob = null;
  const executor = new BaseExecutor({
    router: {
      route: async (req) => { capturedJob = req.job; return { result: '{"ok":true}', provider: 'mock', tokens: 5 }; }
    },
    logger: silentLogger
  });
  await executor._extractJSON('test', 'Extract');
  assert.strictEqual(capturedJob, 'tools', 'Should route extraction to tools job');
});

// -- Test 10: _extractJSON() accepts custom job override --
asyncTest('_extractJSON() accepts custom job override', async () => {
  let capturedJob = null;
  const executor = new BaseExecutor({
    router: {
      route: async (req) => { capturedJob = req.job; return { result: '{"ok":true}', provider: 'mock', tokens: 5 }; }
    },
    logger: silentLogger
  });
  await executor._extractJSON('test', 'Extract', null, 'quick');
  assert.strictEqual(capturedJob, 'quick', 'Should use the overridden job');
});

// -- Test 11: _parseTime() handles common time formats --
test('_parseTime() normalizes 12-hour formats to HH:MM', () => {
  const executor = new BaseExecutor({ router: createMockRouter(), logger: silentLogger });
  assert.strictEqual(executor._parseTime('3pm'), '15:00');
  assert.strictEqual(executor._parseTime('3:30pm'), '15:30');
  assert.strictEqual(executor._parseTime('3 PM'), '15:00');
  assert.strictEqual(executor._parseTime('12pm'), '12:00');
  assert.strictEqual(executor._parseTime('12am'), '00:00');
  assert.strictEqual(executor._parseTime('11:00am'), '11:00');
  assert.strictEqual(executor._parseTime('11:00 AM'), '11:00');
});

test('_parseTime() handles 24-hour and named times', () => {
  const executor = new BaseExecutor({ router: createMockRouter(), logger: silentLogger });
  assert.strictEqual(executor._parseTime('15:00'), '15:00');
  assert.strictEqual(executor._parseTime('9:00'), '09:00');
  assert.strictEqual(executor._parseTime('0:00'), '00:00');
  assert.strictEqual(executor._parseTime('noon'), '12:00');
  assert.strictEqual(executor._parseTime('midnight'), '00:00');
});

test('_parseTime() returns null for unparseable input', () => {
  const executor = new BaseExecutor({ router: createMockRouter(), logger: silentLogger });
  assert.strictEqual(executor._parseTime(null), null);
  assert.strictEqual(executor._parseTime(''), null);
  assert.strictEqual(executor._parseTime('sometime'), null);
  assert.strictEqual(executor._parseTime('25:00'), null);
  assert.strictEqual(executor._parseTime('13pm'), null);
});

test('_parseTime() handles edge cases with dots and whitespace', () => {
  const executor = new BaseExecutor({ router: createMockRouter(), logger: silentLogger });
  assert.strictEqual(executor._parseTime('3:00 p.m.'), '15:00');
  assert.strictEqual(executor._parseTime('  3pm  '), '15:00');
  assert.strictEqual(executor._parseTime('7:45am'), '07:45');
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
