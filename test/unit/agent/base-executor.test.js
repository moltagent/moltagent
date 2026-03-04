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

// ===== resumeWithClarification — Bug A fix: no double-wrapping =====

asyncTest('resumeWithClarification does not double-wrap { response, actionRecord } result', async () => {
  const expectedActionRecord = { type: 'file_write', refs: { path: 'Outbox/notes.txt' } };
  const executor = new BaseExecutor({
    router: createMockRouter(),
    logger: silentLogger
  });
  // Override execute() to return the standard { response, actionRecord } shape
  executor.execute = async () => ({
    response: 'File written successfully.',
    actionRecord: expectedActionRecord
  });

  const clarification = {
    executor: 'file',
    action: 'write',
    missingFields: [],           // already satisfied — triggers immediate re-execute
    collectedFields: { content: 'hello' },
    userResponse: 'notes.txt',
    originalMessage: 'Write a file'
  };

  const result = await executor.resumeWithClarification(clarification, { userName: 'alice' });

  // Top-level result must NOT be { response: { response: '...', actionRecord: ... } }
  assert.strictEqual(typeof result.response, 'string',
    `result.response must be a string, got: ${typeof result.response}`);
  assert.strictEqual(result.response, 'File written successfully.');
  assert.deepStrictEqual(result.actionRecord, expectedActionRecord,
    'actionRecord should be preserved at top level');
});

asyncTest('resumeWithClarification returns plain { response } when execute returns string', async () => {
  const executor = new BaseExecutor({
    router: createMockRouter(),
    logger: silentLogger
  });
  executor.execute = async () => 'Operation done.';

  const clarification = {
    executor: 'test',
    action: 'test',
    missingFields: [],
    collectedFields: {},
    userResponse: 'something',
    originalMessage: 'do thing'
  };

  const result = await executor.resumeWithClarification(clarification, {});
  assert.strictEqual(result.response, 'Operation done.');
});

asyncTest('resumeWithClarification after last field does not double-wrap', async () => {
  const executor = new BaseExecutor({
    router: createMockRouter(),
    logger: silentLogger
  });
  executor.execute = async () => ({ response: 'Done writing.', actionRecord: { type: 'x' } });

  // One field remaining — after storing the user answer, all fields satisfied
  const clarification = {
    executor: 'file',
    action: 'write',
    missingFields: ['filename'],
    collectedFields: { content: 'data' },
    userResponse: 'report.txt',
    originalMessage: 'write a file with data'
  };

  const result = await executor.resumeWithClarification(clarification, { userName: 'bob' });

  assert.strictEqual(typeof result.response, 'string',
    `result.response must be a string after final field, got: ${typeof result.response}`);
  assert.strictEqual(result.response, 'Done writing.');
  assert.ok(result.actionRecord, 'actionRecord should be at top level');
});

// ===== _isMetaInstruction =====

test('_isMetaInstruction detects "propose a name"', () => {
  const executor = new BaseExecutor({ router: createMockRouter(), logger: silentLogger });
  assert.strictEqual(executor._isMetaInstruction('propose a name'), true);
  assert.strictEqual(executor._isMetaInstruction('you pick'), true);
  assert.strictEqual(executor._isMetaInstruction('whatever makes sense'), true);
  assert.strictEqual(executor._isMetaInstruction('you decide'), true);
  assert.strictEqual(executor._isMetaInstruction('suggest something'), true);
  assert.strictEqual(executor._isMetaInstruction('up to you'), true);
  assert.strictEqual(executor._isMetaInstruction('your choice'), true);
  assert.strictEqual(executor._isMetaInstruction('your call'), true);
  assert.strictEqual(executor._isMetaInstruction("you're the AI"), true);
  assert.strictEqual(executor._isMetaInstruction("you're the bot"), true);
});

test('_isMetaInstruction does not fire on normal replies', () => {
  const executor = new BaseExecutor({ router: createMockRouter(), logger: silentLogger });
  assert.strictEqual(executor._isMetaInstruction('myfile.md'), false);
  assert.strictEqual(executor._isMetaInstruction('OCR-Briefing-Summary.md'), false);
  assert.strictEqual(executor._isMetaInstruction('Documents/report.txt'), false);
  assert.strictEqual(executor._isMetaInstruction(''), false);
  assert.strictEqual(executor._isMetaInstruction(null), false);
  assert.strictEqual(executor._isMetaInstruction(undefined), false);
});

// ===== _generateDefaultValue — base returns null =====

test('_generateDefaultValue base implementation returns null for any field', () => {
  const executor = new BaseExecutor({ router: createMockRouter(), logger: silentLogger });
  assert.strictEqual(executor._generateDefaultValue('filename', {}, 'save a file'), null);
  assert.strictEqual(executor._generateDefaultValue('title', {}, 'create something'), null);
  assert.strictEqual(executor._generateDefaultValue('content', {}, 'make content'), null);
});

// ===== resumeWithClarification + meta-instruction integration =====

asyncTest('meta-instruction "propose a name" triggers _generateDefaultValue', async () => {
  const executor = new BaseExecutor({
    router: createMockRouter(),
    logger: silentLogger
  });

  let capturedField = null;
  let capturedOriginal = null;
  // Override _generateDefaultValue to spy and return a generated name
  executor._generateDefaultValue = (fieldName, _collectedFields, originalMessage) => {
    capturedField = fieldName;
    capturedOriginal = originalMessage;
    return 'Auto-Generated-Name.md';
  };

  let receivedFields = null;
  executor.execute = async (_msg, _ctx) => {
    // Normally execute would re-parse the original message;
    // here we just capture what collectedFields would have been set to.
    // We don't have direct access, but we verify via the stored value on the spy.
    return { response: 'Done.' };
  };

  const clarification = {
    executor: 'file',
    action: 'write',
    missingFields: ['filename'],
    collectedFields: { content: 'hello' },
    userResponse: 'propose a name',
    originalMessage: 'save my notes to a file'
  };

  const result = await executor.resumeWithClarification(clarification, { userName: 'alice' });

  assert.strictEqual(capturedField, 'filename', 'should have called _generateDefaultValue with field=filename');
  assert.strictEqual(capturedOriginal, 'save my notes to a file');
  assert.strictEqual(result.response, 'Done.');
});

asyncTest('direct value "myfile.md" is stored as-is (not treated as meta-instruction)', async () => {
  const executor = new BaseExecutor({
    router: createMockRouter(),
    logger: silentLogger
  });

  let defaultValueCalled = false;
  executor._generateDefaultValue = () => { defaultValueCalled = true; return 'should-not-appear.md'; };

  let executeCalled = false;
  executor.execute = async () => { executeCalled = true; return { response: 'Wrote file.' }; };

  const clarification = {
    executor: 'file',
    action: 'write',
    missingFields: ['filename'],
    collectedFields: { content: 'data' },
    userResponse: 'myfile.md',
    originalMessage: 'save data to a file'
  };

  const result = await executor.resumeWithClarification(clarification, { userName: 'carol' });

  assert.strictEqual(defaultValueCalled, false, '_generateDefaultValue must NOT be called for a direct value');
  assert.strictEqual(executeCalled, true, 'execute must be called');
  assert.strictEqual(result.response, 'Wrote file.');
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
