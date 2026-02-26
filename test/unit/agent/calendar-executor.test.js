'use strict';

const assert = require('assert');
const { asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const CalendarExecutor = require('../../../src/lib/agent/executors/calendar-executor');

const silentLogger = { log() {}, info() {}, warn() {}, error() {} };

function createMockRouter(extractResult) {
  return {
    route: async () => extractResult || { result: '{}', provider: 'mock', tokens: 10 }
  };
}

function createMockCalendarClient(eventResult) {
  const events = [];
  return {
    createEvent: async (params) => {
      events.push(params);
      return eventResult || { uid: 'evt-12345' };
    },
    getCreatedEvents: () => events
  };
}

// -- Test 1: Creates event with extracted params --
asyncTest('Creates event with extracted params', async () => {
  const calClient = createMockCalendarClient();
  const executor = new CalendarExecutor({
    router: createMockRouter({
      result: JSON.stringify({
        action: 'create', summary: 'Team Standup',
        date: 'tomorrow', time: '14:00', duration_minutes: 90,
        attendees: ['bob@example.com'], location: 'Room 5'
      })
    }),
    calendarClient: calClient,
    logger: silentLogger
  });

  const result = await executor.execute('Create meeting tomorrow 2pm 90 min Team Standup', { userName: 'alice' });
  assert.ok(result.includes('Team Standup'), 'Should confirm event title');
  assert.ok(result.includes('evt-12345'), 'Should include event UID');
  assert.ok(result.includes('90 min'), 'Should confirm duration');
});

// -- Test 2: Resolves "tomorrow" date correctly --
asyncTest('Resolves "tomorrow" date correctly', async () => {
  const calClient = createMockCalendarClient();
  const executor = new CalendarExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'create', summary: 'Test', date: 'tomorrow', time: '10:00' })
    }),
    calendarClient: calClient,
    logger: silentLogger
  });

  await executor.execute('Create event tomorrow', { userName: 'alice' });
  const created = calClient.getCreatedEvents()[0];
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const expectedDate = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;
  const startStr = created.start.toISOString().substring(0, 10);
  assert.strictEqual(startStr, expectedDate);
});

// -- Test 3: Adds requesting user as attendee --
asyncTest('Adds requesting user as attendee', async () => {
  const calClient = createMockCalendarClient();
  const executor = new CalendarExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'create', summary: 'Test', date: 'tomorrow', time: '09:00', attendees: ['bob@test.com'] })
    }),
    calendarClient: calClient,
    logger: silentLogger
  });

  await executor.execute('Create event', { userName: 'alice' });
  const created = calClient.getCreatedEvents()[0];
  assert.ok(created.attendees.includes('alice'), 'Should include requesting user');
  assert.ok(created.attendees.includes('bob@test.com'), 'Should keep existing attendees');
});

// -- Test 4: Defaults duration to 60 minutes --
asyncTest('Defaults duration to 60 minutes', async () => {
  const calClient = createMockCalendarClient();
  const executor = new CalendarExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'create', summary: 'Quick Chat', date: 'tomorrow', time: '15:00' })
    }),
    calendarClient: calClient,
    logger: silentLogger
  });

  const result = await executor.execute('Create event Quick Chat tomorrow 3pm', { userName: 'alice' });
  assert.ok(result.includes('60 min'), 'Should default to 60 minutes');
  const created = calClient.getCreatedEvents()[0];
  const diffMs = created.end.getTime() - created.start.getTime();
  assert.strictEqual(diffMs, 60 * 60000, 'Duration should be 60 minutes');
});

// -- Test 5: Defaults time to 09:00 --
asyncTest('Defaults time to 09:00 when not specified', async () => {
  const calClient = createMockCalendarClient();
  const executor = new CalendarExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'create', summary: 'Morning Task', date: 'tomorrow' })
    }),
    calendarClient: calClient,
    logger: silentLogger
  });

  const result = await executor.execute('Create event Morning Task tomorrow', { userName: 'alice' });
  assert.ok(result.includes('09:00'), 'Should default to 09:00');
});

// -- Test 6: Validates required fields (summary) — returns friendly prompt --
asyncTest('Validates summary is required for create', async () => {
  const executor = new CalendarExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'create', date: 'tomorrow', time: '10:00' })
    }),
    calendarClient: createMockCalendarClient(),
    logger: silentLogger
  });

  const result = await executor.execute('Create event tomorrow', { userName: 'alice' });
  assert.ok(typeof result === 'string', 'Should return clarification string');
  assert.ok(result.includes('title'), 'Should ask for event title');
});

// -- Test 7: Guardrail blocks when denied --
asyncTest('Guardrail blocks calendar creation when denied', async () => {
  const executor = new CalendarExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'create', summary: 'Secret Meeting', date: 'tomorrow', time: '10:00' })
    }),
    calendarClient: createMockCalendarClient(),
    guardrailEnforcer: {
      check: async () => ({ allowed: false, reason: 'Calendar write blocked' }),
      checkApproval: async () => ({ allowed: true })
    },
    logger: silentLogger
  });

  const result = await executor.execute('Create secret meeting', { userName: 'alice' });
  assert.ok(result.includes('blocked'), 'Should indicate blocking');
  assert.ok(result.includes('Calendar write blocked'));
});

// -- Test 8: Throws DOMAIN_ESCALATE on extraction failure --
asyncTest('Throws DOMAIN_ESCALATE on extraction failure', async () => {
  const executor = new CalendarExecutor({
    router: createMockRouter({ result: 'I cannot parse that request' }),
    calendarClient: createMockCalendarClient(),
    logger: silentLogger
  });

  try {
    await executor.execute('Something unparseable', { userName: 'alice' });
    assert.fail('Should have thrown');
  } catch (err) {
    assert.strictEqual(err.code, 'DOMAIN_ESCALATE');
  }
});

// -- Test 9: Handles JSON with markdown fences --
asyncTest('Handles JSON response wrapped in markdown fences', async () => {
  const calClient = createMockCalendarClient();
  const executor = new CalendarExecutor({
    router: createMockRouter({
      result: '```json\n{"action":"create","summary":"Fenced Event","date":"tomorrow","time":"11:00"}\n```'
    }),
    calendarClient: calClient,
    logger: silentLogger
  });

  const result = await executor.execute('Create fenced event tomorrow', { userName: 'alice' });
  assert.ok(result.includes('Fenced Event'), 'Should parse fenced JSON');
});

// -- Test 10: Returns real event UID in confirmation --
asyncTest('Returns real event UID in confirmation', async () => {
  const executor = new CalendarExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'create', summary: 'UID Test', date: 'tomorrow', time: '10:00' })
    }),
    calendarClient: createMockCalendarClient({ uid: 'real-uid-abc123' }),
    logger: silentLogger
  });

  const result = await executor.execute('Create event UID Test', { userName: 'alice' });
  assert.ok(result.includes('real-uid-abc123'), 'Should include real event UID');
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
