/**
 * CalendarExecutor Validation Gate Tests
 *
 * Validates that bad extractions are caught before hitting APIs.
 * Tests the CalendarExecutor's execute() method with mocked dependencies.
 *
 * Run: node test/unit/agent/executors/calendar-validation.test.js
 */

const assert = require('assert');
const { asyncTest, summary, exitWithCode } = require('../../../helpers/test-runner');

const CalendarExecutor = require('../../../../src/lib/agent/executors/calendar-executor');

console.log('\n=== CalendarExecutor Validation Gate Tests ===\n');

// Shared mock router that returns configurable extraction results
function makeExecutor(extractionResult) {
  const router = {
    route: async () => ({ result: JSON.stringify(extractionResult) })
  };
  const calendarClient = {
    createEvent: async () => ({ uid: 'test-uid-123' })
  };
  return new CalendarExecutor({
    router,
    calendarClient,
    logger: { info: () => {}, warn: () => {}, error: () => {} }
  });
}

const context = { userName: 'testuser', roomToken: 'room1' };

asyncTest('rejects empty summary for create action', async () => {
  const executor = makeExecutor({ action: 'create', summary: '', date: 'tomorrow', time: '14:00' });
  const result = await executor.execute('Schedule something', context);
  assert.ok(result.includes('title'), `expected title prompt, got: ${result}`);
});

asyncTest('rejects null summary for create action', async () => {
  const executor = makeExecutor({ action: 'create', date: 'tomorrow', time: '14:00' });
  const result = await executor.execute('Schedule something', context);
  assert.ok(result.includes('title'), `expected title prompt, got: ${result}`);
});

asyncTest('rejects summary > 80 chars (model dumped whole message)', async () => {
  const longSummary = 'A'.repeat(81);
  const executor = makeExecutor({ action: 'create', summary: longSummary, date: 'tomorrow', time: '10:00' });
  const result = await executor.execute('Some message', context);
  assert.ok(result.includes('event name'), `expected event name prompt, got: ${result}`);
});

asyncTest('rejects missing date AND time for create', async () => {
  const executor = makeExecutor({ action: 'create', summary: 'Standup', date: '', time: '' });
  const result = await executor.execute('Create event Standup', context);
  assert.ok(result.includes('schedule'), `expected schedule prompt, got: ${result}`);
});

asyncTest('passes with date only (no time)', async () => {
  const executor = makeExecutor({ action: 'create', summary: 'Standup', date: 'tomorrow', time: '' });
  const result = await executor.execute('Standup tomorrow', context);
  // Should succeed — resolveDate handles "tomorrow", time defaults to 09:00
  assert.ok(result.includes('Created event'), `expected success, got: ${result}`);
});

asyncTest('passes with time only (no date)', async () => {
  // time present means the gate passes, but resolveDate(null) returns null → DOMAIN_ESCALATE
  // This is correct — the gate catches "no date AND no time", not "no date"
  const executor = makeExecutor({ action: 'create', summary: 'Quick call', date: '', time: '14:00' });
  try {
    await executor.execute('Quick call at 2pm', context);
    assert.fail('should have thrown DOMAIN_ESCALATE for unresolvable date');
  } catch (err) {
    assert.strictEqual(err.code, 'DOMAIN_ESCALATE');
  }
});

asyncTest('requires_clarification=true returns friendly message', async () => {
  const executor = makeExecutor({
    action: 'create', summary: 'Meeting', date: '', time: '',
    requires_clarification: true, missing_fields: ['date', 'time']
  });
  const result = await executor.execute('Schedule a meeting', context);
  assert.ok(result.includes('clarify'), `expected clarification prompt, got: ${result}`);
  assert.ok(result.includes('date'), `expected date in missing fields, got: ${result}`);
  assert.ok(result.includes('time'), `expected time in missing fields, got: ${result}`);
});

asyncTest('requires_clarification=true without missing_fields returns generic message', async () => {
  const executor = makeExecutor({
    action: 'create', summary: '', date: '', time: '',
    requires_clarification: true
  });
  const result = await executor.execute('Something', context);
  assert.ok(result.includes('clarify'), `expected clarification prompt, got: ${result}`);
  assert.ok(result.includes('some details'), `expected generic prompt, got: ${result}`);
});

asyncTest('code-side attendee extraction merges with LLM attendees', async () => {
  let capturedArgs;
  const router = {
    route: async () => ({
      result: JSON.stringify({
        action: 'create', summary: 'Lunch', date: 'tomorrow', time: '12:00',
        attendees: ['Alice']
      })
    })
  };
  const calendarClient = {
    createEvent: async (args) => { capturedArgs = args; return { uid: 'uid-1' }; }
  };
  const executor = new CalendarExecutor({
    router, calendarClient,
    logger: { info: () => {}, warn: () => {}, error: () => {} }
  });

  await executor.execute('Lunch with Bob tomorrow noon', { userName: 'testuser', roomToken: 'room1' });

  // Should have Alice (LLM), Bob (code-side), testuser (requester)
  assert.ok(capturedArgs.attendees.includes('Alice'), `expected Alice, got: ${capturedArgs.attendees}`);
  assert.ok(capturedArgs.attendees.includes('Bob'), `expected Bob from code extraction, got: ${capturedArgs.attendees}`);
  assert.ok(capturedArgs.attendees.includes('testuser'), `expected testuser, got: ${capturedArgs.attendees}`);
});

asyncTest('valid create with all fields succeeds', async () => {
  const executor = makeExecutor({
    action: 'create', summary: 'Team Standup', date: 'tomorrow', time: '09:00',
    duration_minutes: 30, attendees: [], location: 'Room 5'
  });
  const result = await executor.execute('Team Standup tomorrow 9am in Room 5', context);
  assert.ok(result.includes('Created event'), `expected success, got: ${result}`);
  assert.ok(result.includes('Team Standup'), `expected title, got: ${result}`);
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
