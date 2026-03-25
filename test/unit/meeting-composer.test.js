/**
 * Tests for MeetingComposer
 *
 * Run: node test/unit/meeting-composer.test.js
 *
 * @module test/unit/meeting-composer
 */

'use strict';

// AGPL-3.0 — moltagent project

const { test, asyncTest, summary, exitWithCode } = require('../helpers/test-runner');
const assert = require('assert');
const MeetingComposer = require('../../src/lib/calendar/meeting-composer');
const boardRegistry = require('../../src/lib/integrations/deck-board-registry');

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMocks(overrides = {}) {
  return {
    contactsClient: {
      resolve: overrides.resolve || (async (name) => {
        if (name.includes('@')) {
          return { resolved: true, contact: { name: name.split('@')[0], email: name, type: 'external' } };
        }
        if (name === 'João') {
          return { resolved: true, contact: { name: 'João Silva', email: 'joao@company.pt', type: 'internal' } };
        }
        if (name === 'Dr. Müller') {
          return {
            resolved: false,
            options: [
              { name: 'Klaus Müller', email: 'klaus@uni.de', org: 'Uni Bonn' },
              { name: 'Stefan Müller', email: 'stefan@diem.de', org: 'DIEM' }
            ]
          };
        }
        return { resolved: false, error: 'no_match', name };
      }),
      search: overrides.search || (async () => [])
    },
    caldavClient: {
      checkAvailability: overrides.checkAvailability || (async () => ({ isFree: true, conflicts: [] })),
      scheduleMeeting:   overrides.scheduleMeeting   || (async (m) => ({
        uid:         'test-uid-123',
        calendarId:  'personal',
        summary:     m.summary,
        icalString:  'BEGIN:VCALENDAR...'
      }))
    },
    deckClient: {
      listBoards:       overrides.listBoards       || (async () => []),
      getBoard:         overrides.getBoard         || (async () => ({ stacks: [] })),
      createCardOnBoard: overrides.createCardOnBoard || (async () => ({ id: 42 }))
    },
    emailHandler: {
      sendWithIcal: overrides.sendWithIcal || (async () => ({ success: true }))
    },
    rsvpTracker: {
      trackEvent: overrides.trackEvent || (() => {})
    },
    llmRouter: {
      route: overrides.route || (async () => ({
        result: JSON.stringify({
          title:        'Q1 Review',
          participants: ['João'],
          start:        '2026-03-25T14:00:00.000Z',
          duration:     60,
          location:     null,
          description:  null
        })
      }))
    },
    auditLog: overrides.auditLog || (async () => {})
  };
}

function createComposer(overrides = {}) {
  const mocks = createMocks(overrides);
  return new MeetingComposer(mocks);
}

// ---------------------------------------------------------------------------
// Helper: drive a fresh process() call for user 'testuser'
// ---------------------------------------------------------------------------

const USER  = 'testuser';
const TOKEN = 'room-abc';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log('MeetingComposer Unit Tests');
console.log('==========================\n');

// --- 1. Constructor ---

test('constructor creates instance with valid deps', () => {
  const composer = createComposer();
  assert.ok(composer instanceof MeetingComposer);
  assert.ok(composer.sessions instanceof Map);
});

test('constructor throws when contactsClient is missing', () => {
  const mocks = createMocks();
  delete mocks.contactsClient;
  assert.throws(() => new MeetingComposer(mocks), /contactsClient is required/);
});

test('constructor throws when caldavClient is missing', () => {
  const mocks = createMocks();
  delete mocks.caldavClient;
  assert.throws(() => new MeetingComposer(mocks), /caldavClient is required/);
});

test('constructor throws when llmRouter is missing', () => {
  const mocks = createMocks();
  delete mocks.llmRouter;
  assert.throws(() => new MeetingComposer(mocks), /llmRouter is required/);
});

test('constructor makes emailHandler, rsvpTracker, deckClient optional', () => {
  const mocks = createMocks();
  delete mocks.emailHandler;
  delete mocks.rsvpTracker;
  delete mocks.deckClient;
  const composer = new MeetingComposer(mocks);
  assert.strictEqual(composer.email, null);
  assert.strictEqual(composer.rsvpTracker, null);
  assert.strictEqual(composer.deck, null);
});

test('STATES are exported as class property', () => {
  assert.ok(MeetingComposer.STATES);
  assert.strictEqual(MeetingComposer.STATES.DONE, 'DONE');
  assert.strictEqual(MeetingComposer.STATES.CANCELLED, 'CANCELLED');
});

// --- 2. New meeting request ---

asyncTest('process() creates new session and returns confirmation prompt', async () => {
  const composer = createComposer();
  const result = await composer.process('Schedule Q1 Review with João tomorrow at 2pm', USER, TOKEN);

  assert.ok(result.reply);
  assert.strictEqual(result.done, false);
  // Should have moved through RESOLVING → CHECKING → REVIEWING and shown summary + "Confirm?"
  assert.ok(result.reply.includes('Confirm?'), `Expected "Confirm?" in: ${result.reply}`);
});

asyncTest('process() stores session after first message', async () => {
  const composer = createComposer();
  await composer.process('Meet with João tomorrow at 2pm', USER, TOKEN);
  assert.ok(composer.hasActiveSession(USER));
});

// --- 3. Direct email participant ---

asyncTest('participant with @ skips contact resolution and goes to confirmation', async () => {
  const resolveSpy = { called: false };
  const composer = createComposer({
    resolve: async (name) => {
      resolveSpy.called = true;
      return { resolved: true, contact: { name, email: name, type: 'external' } };
    },
    route: async () => ({
      result: JSON.stringify({
        title: 'Call',
        participants: ['bob@external.com'],
        start: '2026-03-25T09:00:00.000Z',
        duration: 30,
        location: null,
        description: null
      })
    })
  });

  const result = await composer.process('Call with bob@external.com', USER, TOKEN);

  // resolve() should NOT have been called because the name contained @
  assert.strictEqual(resolveSpy.called, false);
  // Should have reached REVIEWING — prompt includes Confirm?
  assert.ok(result.reply.includes('Confirm?'), `Reply was: ${result.reply}`);
});

// --- 4. Single contact resolution ---

asyncTest('single resolved contact advances to conflict check and review', async () => {
  const composer = createComposer();
  const result = await composer.process('Meeting with João next week', USER, TOKEN);

  assert.strictEqual(result.done, false);
  // João should appear in the summary
  assert.ok(result.reply.includes('João'), `Expected João in: ${result.reply}`);
  assert.ok(result.reply.includes('Confirm?'));
});

// --- 5. Ambiguous contact ---

asyncTest('ambiguous contact triggers disambiguation prompt', async () => {
  const composer = createComposer({
    route: async () => ({
      result: JSON.stringify({
        title: 'Discussion',
        participants: ['Dr. Müller'],
        start: '2026-03-26T10:00:00.000Z',
        duration: 60,
        location: null,
        description: null
      })
    })
  });

  const result = await composer.process('Meet with Dr. Müller', USER, TOKEN);

  assert.strictEqual(result.done, false);
  assert.ok(result.reply.includes('Multiple contacts match'), `Reply was: ${result.reply}`);
  assert.ok(result.reply.includes('Klaus Müller'));
  assert.ok(result.reply.includes('Stefan Müller'));
});

// --- 6. No match contact ---

asyncTest('no-match contact continues with warning and reaches review', async () => {
  const composer = createComposer({
    route: async () => ({
      result: JSON.stringify({
        title: 'Catch-up',
        participants: ['UnknownPerson'],
        start: '2026-03-26T11:00:00.000Z',
        duration: 30,
        location: null,
        description: null
      })
    })
  });

  const result = await composer.process('Meet with UnknownPerson', USER, TOKEN);

  assert.strictEqual(result.done, false);
  // Unresolved participant → note in reply
  assert.ok(result.reply.includes('UnknownPerson'), `Reply was: ${result.reply}`);
});

// --- 7. Disambiguation by number ---

asyncTest('disambiguation by number selects correct option and advances', async () => {
  const composer = createComposer({
    route: async () => ({
      result: JSON.stringify({
        title: 'Discussion',
        participants: ['Dr. Müller'],
        start: '2026-03-26T10:00:00.000Z',
        duration: 60,
        location: null,
        description: null
      })
    })
  });

  // First turn — triggers disambiguation
  const first = await composer.process('Meet with Dr. Müller', USER, TOKEN);
  assert.ok(first.reply.includes('Multiple contacts match'));

  // Second turn — user picks #1
  const second = await composer.process('1', USER, TOKEN);
  assert.strictEqual(second.done, false);
  // Should now be at REVIEWING with Klaus Müller resolved
  assert.ok(second.reply.includes('Klaus Müller'), `Reply was: ${second.reply}`);
  assert.ok(second.reply.includes('Confirm?'));
});

// --- 8. Disambiguation by name ---

asyncTest('disambiguation by name match selects option and advances', async () => {
  const composer = createComposer({
    route: async () => ({
      result: JSON.stringify({
        title: 'Workshop',
        participants: ['Dr. Müller'],
        start: '2026-03-26T14:00:00.000Z',
        duration: 90,
        location: null,
        description: null
      })
    })
  });

  await composer.process('Workshop with Dr. Müller', USER, TOKEN);

  // User replies with part of the name
  const result = await composer.process('Stefan', USER, TOKEN);
  assert.strictEqual(result.done, false);
  assert.ok(result.reply.includes('Stefan Müller'), `Reply was: ${result.reply}`);
  assert.ok(result.reply.includes('Confirm?'));
});

// --- 9. Confirmation yes ---

asyncTest('confirming with "yes" creates the event and returns done:true', async () => {
  let scheduleCalled = false;
  const composer = createComposer({
    scheduleMeeting: async (m) => {
      scheduleCalled = true;
      return { uid: 'uid-yes', calendarId: 'personal', summary: m.summary, icalString: 'BEGIN:VCALENDAR' };
    }
  });

  await composer.process('Meeting with João tomorrow at 2pm', USER, TOKEN);
  const result = await composer.process('yes', USER, TOKEN);

  assert.strictEqual(result.done, true);
  assert.ok(scheduleCalled, 'scheduleMeeting should have been called');
  assert.ok(result.reply.includes('created'), `Reply was: ${result.reply}`);
});

// --- 10. Confirmation no ---

asyncTest('cancelling with "no" returns CANCELLED state and done:true', async () => {
  const composer = createComposer();

  await composer.process('Meeting with João tomorrow at 2pm', USER, TOKEN);
  const result = await composer.process('no', USER, TOKEN);

  assert.strictEqual(result.done, true);
  assert.ok(result.reply.toLowerCase().includes('cancel'), `Reply was: ${result.reply}`);
  assert.strictEqual(composer.hasActiveSession(USER), false);
});

// --- 11. Multilingual confirmation ---

asyncTest('"ja" confirms the meeting (German)', async () => {
  const composer = createComposer();
  await composer.process('Meeting with João tomorrow at 2pm', USER, TOKEN);
  const result = await composer.process('ja', USER, TOKEN);
  assert.strictEqual(result.done, true);
  assert.ok(result.reply.includes('created'));
});

asyncTest('"sim" confirms the meeting (Portuguese)', async () => {
  const composer = createComposer();
  await composer.process('Meeting with João tomorrow at 2pm', USER, TOKEN);
  const result = await composer.process('sim', USER, TOKEN);
  assert.strictEqual(result.done, true);
  assert.ok(result.reply.includes('created'));
});

asyncTest('"nein" cancels the meeting (German)', async () => {
  const composer = createComposer();
  await composer.process('Meeting with João tomorrow at 2pm', USER, TOKEN);
  const result = await composer.process('nein', USER, TOKEN);
  assert.strictEqual(result.done, true);
  assert.ok(result.reply.toLowerCase().includes('cancel'));
});

asyncTest('"não" cancels the meeting (Portuguese)', async () => {
  const composer = createComposer();
  await composer.process('Meeting with João tomorrow at 2pm', USER, TOKEN);
  const result = await composer.process('não', USER, TOKEN);
  assert.strictEqual(result.done, true);
  assert.ok(result.reply.toLowerCase().includes('cancel'));
});

// --- 12. Calendar conflict ---

asyncTest('calendar conflict shows warning in review prompt', async () => {
  const composer = createComposer({
    checkAvailability: async () => ({
      isFree: false,
      conflicts: [
        { summary: 'Existing Event', start: '2026-03-25T14:00:00.000Z', end: '2026-03-25T15:00:00.000Z' }
      ]
    })
  });

  const result = await composer.process('Meeting with João tomorrow at 2pm', USER, TOKEN);

  assert.strictEqual(result.done, false);
  assert.ok(result.reply.includes('Conflict warning'), `Reply was: ${result.reply}`);
  assert.ok(result.reply.includes('Existing Event'));
  assert.ok(result.reply.includes('Confirm?'));
});

// --- 13. Session expiry ---

asyncTest('expired session is treated as a new request', async () => {
  const composer = createComposer();

  // Create a session and then backdate lastActivity beyond timeout
  await composer.process('Meeting with João tomorrow at 2pm', USER, TOKEN);

  const key = `${USER}:meeting`;
  const session = composer.sessions.get(key);
  assert.ok(session);
  // Backdate 31 minutes
  session.lastActivity = Date.now() - 31 * 60 * 1000;

  // A new message should start fresh — LLM is called again and new session created
  const result = await composer.process('Book a new meeting with João', USER, TOKEN);
  assert.strictEqual(result.done, false);
  // Session should have been replaced with a new one (different id or reset state)
  const newSession = composer.sessions.get(key);
  assert.ok(newSession);
  assert.notStrictEqual(newSession.id, session.id);
});

// --- 14. LLM parse error ---

asyncTest('graceful fallback when LLM returns unparseable JSON', async () => {
  const composer = createComposer({
    route: async () => ({ result: 'This is not JSON at all' })
  });

  const result = await composer.process('Schedule something', USER, TOKEN);

  assert.strictEqual(result.done, false);
  assert.ok(
    result.reply.toLowerCase().includes('could not understand') ||
    result.reply.toLowerCase().includes('rephrase'),
    `Reply was: ${result.reply}`
  );
});

asyncTest('LLM JSON wrapped in markdown fences is parsed successfully', async () => {
  const composer = createComposer({
    route: async () => ({
      result: '```json\n' + JSON.stringify({
        title: 'Fence Test',
        participants: ['João'],
        start: '2026-03-25T09:00:00.000Z',
        duration: 60,
        location: null,
        description: null
      }) + '\n```'
    })
  });

  const result = await composer.process('Schedule meeting with João', USER, TOKEN);
  assert.strictEqual(result.done, false);
  // Should have made it to REVIEWING
  assert.ok(result.reply.includes('Confirm?'), `Reply was: ${result.reply}`);
});

// --- 15. Calendar event creation with correct args ---

asyncTest('scheduleMeeting is called with correct title, start, end, and attendees', async () => {
  let capturedArgs = null;
  const composer = createComposer({
    scheduleMeeting: async (m) => {
      capturedArgs = m;
      return { uid: 'uid-args', calendarId: 'personal', summary: m.summary, icalString: '' };
    }
  });

  await composer.process('Meeting with João tomorrow', USER, TOKEN);
  await composer.process('yes', USER, TOKEN);

  assert.ok(capturedArgs, 'scheduleMeeting should have been called');
  assert.strictEqual(capturedArgs.summary, 'Q1 Review');
  assert.ok(capturedArgs.start instanceof Date, 'start should be a Date');
  assert.ok(capturedArgs.end instanceof Date, 'end should be a Date');
  assert.ok(Array.isArray(capturedArgs.attendees));
  assert.ok(capturedArgs.attendees.includes('joao@company.pt'));
  // end should be start + 60 minutes
  const diffMs = capturedArgs.end.getTime() - capturedArgs.start.getTime();
  assert.strictEqual(diffMs, 60 * 60 * 1000, 'end − start should equal duration');
});

// --- 16. RSVP tracking ---

asyncTest('rsvpTracker.trackEvent is called after meeting creation', async () => {
  const trackCalls = [];
  const composer = createComposer({
    trackEvent: (...args) => { trackCalls.push(args); }
  });

  await composer.process('Meeting with João tomorrow', USER, TOKEN);
  await composer.process('yes', USER, TOKEN);

  assert.strictEqual(trackCalls.length, 1, 'trackEvent should be called once');
  const [uid, calendarId, attendees, title, endTime] = trackCalls[0];
  assert.strictEqual(uid, 'test-uid-123');
  assert.ok(calendarId);
  assert.ok(Array.isArray(attendees));
  assert.ok(attendees.some(a => a.email === 'joao@company.pt'));
  assert.strictEqual(title, 'Q1 Review');
  assert.ok(endTime);
});

asyncTest('meeting proceeds normally when rsvpTracker is absent', async () => {
  const mocks = createMocks();
  delete mocks.rsvpTracker;
  const composer = new MeetingComposer(mocks);

  await composer.process('Meeting with João tomorrow', USER, TOKEN);
  const result = await composer.process('yes', USER, TOKEN);

  assert.strictEqual(result.done, true);
  assert.ok(result.reply.includes('created'));
});

// --- 17. Deck tracking card ---

asyncTest('deck card created on Pending Meetings board after meeting creation', async () => {
  boardRegistry._reset();
  const createCardCalls = [];
  const composer = createComposer({
    listBoards: async () => [{ id: 7, title: 'Pending Meetings' }],
    getBoard: async () => ({
      stacks: [{ id: 20, title: 'Invited' }]
    }),
    createCardOnBoard: async (boardId, stackId, title, opts) => {
      createCardCalls.push({ boardId, stackId, title, opts });
      return { id: 99 };
    }
  });

  await composer.process('Meeting with João tomorrow', USER, TOKEN);
  await composer.process('yes', USER, TOKEN);

  assert.strictEqual(createCardCalls.length, 1, 'createCardOnBoard should be called once');
  const call = createCardCalls[0];
  assert.strictEqual(call.boardId, 7);
  assert.strictEqual(call.stackId, 20);
  assert.strictEqual(call.title, 'Q1 Review');
  assert.ok(call.opts.description.includes('joao@company.pt'));
  assert.ok(call.opts.description.includes('test-uid-123'));
});

asyncTest('meeting creation succeeds even when deck board is not found', async () => {
  boardRegistry._reset();
  const composer = createComposer({
    listBoards: async () => [],  // No Pending Meetings board
    scheduleMeeting: async (m) => ({
      uid: 'uid-nodeck', calendarId: 'personal', summary: m.summary, icalString: ''
    })
  });

  await composer.process('Meeting with João tomorrow', USER, TOKEN);
  const result = await composer.process('yes', USER, TOKEN);

  assert.strictEqual(result.done, true);
  assert.ok(result.reply.includes('created'));
});

asyncTest('deck card falls back to first stack when no Invited stack exists', async () => {
  boardRegistry._reset();
  const createCardCalls = [];
  const composer = createComposer({
    listBoards: async () => [{ id: 8, title: 'Pending Meetings' }],
    getBoard: async () => ({
      stacks: [{ id: 30, title: 'Backlog' }, { id: 31, title: 'In Progress' }]
    }),
    createCardOnBoard: async (boardId, stackId, title, opts) => {
      createCardCalls.push({ boardId, stackId, title, opts });
      return { id: 100 };
    }
  });

  await composer.process('Meeting with João tomorrow', USER, TOKEN);
  await composer.process('yes', USER, TOKEN);

  assert.strictEqual(createCardCalls.length, 1);
  // Falls back to stacks[0] = id 30
  assert.strictEqual(createCardCalls[0].stackId, 30);
});

// --- hasActiveSession ---

asyncTest('hasActiveSession returns false before any process() call', async () => {
  const composer = createComposer();
  assert.strictEqual(composer.hasActiveSession('nobody'), false);
});

asyncTest('hasActiveSession returns false after session reaches DONE', async () => {
  const composer = createComposer();
  await composer.process('Meeting with João tomorrow', USER, TOKEN);
  await composer.process('yes', USER, TOKEN);
  // DONE state -> not active
  assert.strictEqual(composer.hasActiveSession(USER), false);
});

asyncTest('hasActiveSession returns false after CANCELLED', async () => {
  const composer = createComposer();
  await composer.process('Meeting with João tomorrow', USER, TOKEN);
  await composer.process('no', USER, TOKEN);
  assert.strictEqual(composer.hasActiveSession(USER), false);
});

// --- Unknown confirmation word ---

asyncTest('unknown confirmation word returns prompt without advancing state', async () => {
  const composer = createComposer();
  await composer.process('Meeting with João tomorrow', USER, TOKEN);

  const result = await composer.process('maybe later', USER, TOKEN);
  assert.strictEqual(result.done, false);
  assert.ok(
    result.reply.toLowerCase().includes('yes') || result.reply.toLowerCase().includes('confirm'),
    `Reply was: ${result.reply}`
  );
  // Session still active
  assert.ok(composer.hasActiveSession(USER));
});

// ============================================================
// Summary
// ============================================================

setTimeout(() => {
  summary();
  exitWithCode();
}, 500);
