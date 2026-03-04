'use strict';

const assert = require('assert');
const { asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const CalendarExecutor = require('../../../src/lib/agent/executors/calendar-executor');

const silentLogger = { log() {}, info() {}, warn() {}, error() {} };

// Layer 3: executors may return {response, actionRecord} objects
function getResponse(result) {
  return typeof result === 'object' && result !== null && result.response ? result.response : result;
}

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
  const resp = getResponse(result);
  assert.ok(resp.includes('Team Standup'), 'Should confirm event title');
  assert.ok(resp.includes('evt-12345'), 'Should include event UID');
  assert.ok(resp.includes('90 min'), 'Should confirm duration');
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
  assert.ok(getResponse(result).includes('60 min'), 'Should default to 60 minutes');
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
  assert.ok(getResponse(result).includes('09:00'), 'Should default to 09:00');
});

// -- Test 6: Validates required fields (summary) — returns clarification object --
asyncTest('Validates summary is required for create', async () => {
  const executor = new CalendarExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'create', date: 'tomorrow', time: '10:00' })
    }),
    calendarClient: createMockCalendarClient(),
    logger: silentLogger
  });

  const result = await executor.execute('Create event tomorrow', { userName: 'alice' });
  // The executor now returns {response, pendingClarification} instead of a plain string
  assert.ok(result !== null && typeof result === 'object', 'Should return clarification object');
  assert.ok(typeof result.response === 'string', 'result.response should be a string');
  assert.ok(result.response.includes('title') || result.response.includes('call'), 'Should ask for event title');
  assert.ok(result.pendingClarification !== undefined, 'Should include pendingClarification');
  assert.ok(result.pendingClarification.missingFields.includes('summary'), 'Should flag summary as missing');
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
  assert.ok(getResponse(result).includes('Fenced Event'), 'Should parse fenced JSON');
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
  assert.ok(getResponse(result).includes('real-uid-abc123'), 'Should include real event UID');
});

// -- Test 11: execute() returns {response, pendingClarification} when title missing --
asyncTest('execute() returns {response, pendingClarification} when title missing', async () => {
  const executor = new CalendarExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'create', date: 'tomorrow', time: '10:00' })
    }),
    calendarClient: createMockCalendarClient(),
    logger: silentLogger
  });

  const result = await executor.execute('Create event tomorrow at 10am', { userName: 'alice' });

  assert.ok(result !== null && typeof result === 'object', 'Result should be an object, not a plain string');
  assert.ok(typeof result.response === 'string', 'result.response should be a string');
  assert.ok(result.response.length > 0, 'result.response should not be empty');
  assert.ok(result.pendingClarification !== undefined, 'Should have pendingClarification');
  assert.strictEqual(result.pendingClarification.executor, 'calendar', 'executor should be "calendar"');
  assert.ok(Array.isArray(result.pendingClarification.missingFields), 'missingFields should be an array');
  assert.ok(result.pendingClarification.missingFields.includes('summary'), 'missingFields should include "summary"');
});

// -- Test 12: execute() returns {response, pendingClarification} when date/time missing --
asyncTest('execute() returns {response, pendingClarification} when date/time missing', async () => {
  const executor = new CalendarExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'create', summary: 'Test' })
    }),
    calendarClient: createMockCalendarClient(),
    logger: silentLogger
  });

  const result = await executor.execute('Create event called Test', { userName: 'alice' });

  assert.ok(result !== null && typeof result === 'object', 'Result should be an object, not a plain string');
  assert.ok(typeof result.response === 'string', 'result.response should be a string');
  assert.ok(result.pendingClarification !== undefined, 'Should have pendingClarification');
  assert.strictEqual(result.pendingClarification.executor, 'calendar', 'executor should be "calendar"');
  assert.ok(Array.isArray(result.pendingClarification.missingFields), 'missingFields should be an array');
  assert.ok(result.pendingClarification.missingFields.includes('date'), 'missingFields should include "date"');
  assert.strictEqual(result.pendingClarification.collectedFields.summary, 'Test', 'collectedFields should carry forward summary');
});

// -- Test 13: resumeWithClarification() completes event creation with filled fields --
asyncTest('resumeWithClarification() completes event creation with filled fields', async () => {
  const calClient = createMockCalendarClient();
  const executor = new CalendarExecutor({
    router: createMockRouter(),
    calendarClient: calClient,
    logger: silentLogger
  });

  // Scenario: summary was missing, user answered with 'Budget Review'
  // All other required fields (date) were already collected
  const clarification = {
    executor: 'calendar',
    action: 'create',
    missingFields: ['summary'],
    collectedFields: { date: 'tomorrow', time: '14:00', duration_minutes: 60, attendees: [], location: '' },
    originalMessage: 'Create event tomorrow at 2pm',
    userResponse: 'Budget Review'
  };

  const result = await executor.resumeWithClarification(clarification, { userName: 'alice' });

  assert.ok(result !== null && typeof result === 'object', 'Result should be an object');
  assert.ok(typeof result.response === 'string', 'result.response should be a string');
  assert.ok(result.pendingClarification === undefined, 'Should not have pendingClarification — creation is complete');
  assert.strictEqual(calClient.getCreatedEvents().length, 1, 'createEvent should have been called once');
  assert.strictEqual(calClient.getCreatedEvents()[0].summary, 'Budget Review', 'Created event should have the provided summary');
  assert.ok(result.response.includes('Budget Review'), 'Confirmation should mention the event title');
});

// -- Test 14: resumeWithClarification() chains when multiple fields still missing --
asyncTest('resumeWithClarification() chains when multiple fields still missing', async () => {
  const calClient = createMockCalendarClient();
  const executor = new CalendarExecutor({
    router: createMockRouter(),
    calendarClient: calClient,
    logger: silentLogger
  });

  // Scenario: both summary and date were missing; user fills summary first
  const clarification = {
    executor: 'calendar',
    action: 'create',
    missingFields: ['summary', 'date'],
    collectedFields: { time: '10:00', duration_minutes: 60, attendees: [], location: '' },
    originalMessage: 'Create an event',
    userResponse: 'Quarterly Review'
  };

  const result = await executor.resumeWithClarification(clarification, { userName: 'alice' });

  assert.ok(result !== null && typeof result === 'object', 'Result should be an object');
  assert.ok(typeof result.response === 'string', 'result.response should ask the next question');
  assert.ok(result.pendingClarification !== undefined, 'Should still have pendingClarification — date is still missing');
  assert.strictEqual(result.pendingClarification.executor, 'calendar', 'executor should be "calendar"');
  assert.ok(Array.isArray(result.pendingClarification.missingFields), 'missingFields should be an array');
  assert.ok(result.pendingClarification.missingFields.includes('date'), 'Remaining missingFields should include "date"');
  assert.ok(!result.pendingClarification.missingFields.includes('summary'), 'summary should no longer be in missingFields');
  assert.strictEqual(result.pendingClarification.collectedFields.summary, 'Quarterly Review', 'summary should be stored in collectedFields');
  assert.strictEqual(calClient.getCreatedEvents().length, 0, 'createEvent should NOT have been called yet');
});

// -- Test 15: Create returns actionRecord with event refs --
asyncTest('Create returns actionRecord with event refs', async () => {
  const calClient = createMockCalendarClient({ uid: 'evt-action-1' });
  const executor = new CalendarExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'create', summary: 'Action Test', date: 'tomorrow', time: '10:00' })
    }),
    calendarClient: calClient,
    logger: silentLogger
  });

  const result = await executor.execute('Create event Action Test tomorrow 10am', { userName: 'alice' });

  assert.ok(typeof result === 'object' && result !== null, 'Should return structured object');
  assert.ok(result.actionRecord !== undefined, 'Should have actionRecord');
  assert.strictEqual(result.actionRecord.type, 'calendar_create');
  assert.strictEqual(result.actionRecord.refs.uid, 'evt-action-1');
  assert.strictEqual(result.actionRecord.refs.title, 'Action Test');
});

// -- Test 16: resumeWithClarification propagates actionRecord --
asyncTest('resumeWithClarification() propagates actionRecord', async () => {
  const calClient = createMockCalendarClient({ uid: 'evt-resume-1' });
  const executor = new CalendarExecutor({
    router: createMockRouter(),
    calendarClient: calClient,
    logger: silentLogger
  });

  const clarification = {
    executor: 'calendar',
    action: 'create',
    missingFields: ['summary'],
    collectedFields: { date: 'tomorrow', time: '14:00', duration_minutes: 60, attendees: [], location: '' },
    originalMessage: 'Create event tomorrow at 2pm',
    userResponse: 'Team Sync'
  };

  const result = await executor.resumeWithClarification(clarification, { userName: 'alice' });

  assert.ok(result.actionRecord !== undefined, 'Should have actionRecord');
  assert.strictEqual(result.actionRecord.type, 'calendar_create');
  assert.strictEqual(result.actionRecord.refs.uid, 'evt-resume-1');
  assert.strictEqual(result.actionRecord.refs.title, 'Team Sync');
});

// -- Test 17: Create event includes calendar day link when ncUrl available --
asyncTest('Create event includes calendar day link when ncUrl available', async () => {
  const calClient = createMockCalendarClient({ uid: 'evt-link-1' });
  calClient.ncUrl = 'https://cloud.example.com';
  const executor = new CalendarExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'create', summary: 'Link Test', date: 'tomorrow', time: '11:00' })
    }),
    calendarClient: calClient,
    logger: silentLogger
  });

  const result = await executor.execute('Create event Link Test tomorrow 11am', { userName: 'alice' });

  assert.ok(result.response.includes('[View day]'), 'Should include [View day] link');
  assert.ok(result.response.includes('https://cloud.example.com/apps/calendar/dayGridMonth/'), 'Should include calendar URL');
});

// -- Test 18: Create event omits calendar link when ncUrl missing --
asyncTest('Create event omits calendar link when ncUrl missing', async () => {
  const calClient = createMockCalendarClient({ uid: 'evt-nolink-1' });
  const executor = new CalendarExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'create', summary: 'No Link', date: 'tomorrow', time: '11:00' })
    }),
    calendarClient: calClient,
    logger: silentLogger
  });

  const result = await executor.execute('Create event No Link tomorrow 11am', { userName: 'alice' });

  assert.ok(!result.response.includes('[View day]'), 'Should not include [View day] link when ncUrl missing');
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
