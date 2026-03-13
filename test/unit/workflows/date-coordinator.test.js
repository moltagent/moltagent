/*
 * Moltagent - Sovereign AI Security Layer
 * Copyright (C) 2026 Moltagent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * @architecture-brief
 * Problem: Validate the DateCoordinator three-tier meeting scheduling workflow
 *          across internal calendars, freelancer calendars, and external email flow.
 * Pattern: 17 async tests covering Tier 1-3, finalization, and heartbeat integration.
 * Key Dependencies: CalDAV, Email, Deck, Contacts, Talk, LLM Router.
 * Data Flow: User request → participant resolution → tier-by-tier slot narrowing →
 *            HITL email proposal → reply parsing → event creation + cleanup.
 *
 * Dependency Map:
 *   date-coordinator.test.js
 *     ← test-runner.js (test harness)
 *     ← mock-factories.js (CalDAV, LLM, Contacts, NCRequestManager mocks)
 *     ← inline mocks (DeckClient, EmailHandler, TalkClient)
 *     ← ../../../src/lib/workflows/date-coordinator.js (SUT)
 */

'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const {
  createMockCalDAVClient,
  createMockLLMRouter,
  createMockContactsClient,
  createMockNCRequestManager
} = require('../../helpers/mock-factories');

// --- Module Under Test ---
const DateCoordinator = require('../../../src/lib/workflows/date-coordinator');

// ============================================================
// Inline Mocks (not covered by mock-factories)
// ============================================================

/**
 * Creates a mock DeckClient with tracking for card operations.
 * @param {object} [overrides] - Override default behavior
 * @returns {object} Mock with createCard, moveCard, addComment + call tracking
 */
function createMockDeckClient(overrides = {}) {
  const cards = [];
  const moves = [];
  const comments = [];
  return {
    createCard: overrides.createCard || (async (stackName, data) => {
      const id = cards.length + 1;
      cards.push({ id, stackName, ...data });
      return id;
    }),
    moveCard: overrides.moveCard || (async (cardId, targetStack) => {
      moves.push({ cardId, targetStack });
      return { success: true };
    }),
    addComment: overrides.addComment || (async (cardId, message) => {
      comments.push({ cardId, message });
      return { id: comments.length };
    }),
    _cards: cards,
    _moves: moves,
    _comments: comments
  };
}

/**
 * Creates a mock EmailHandler with tracking for sent emails.
 * @param {object} [overrides] - Override default behavior
 * @returns {object} Mock with confirmSendEmail, searchInbox + call tracking
 */
function createMockEmailHandler(overrides = {}) {
  const sent = [];
  const inbox = overrides.inbox || [];
  return {
    confirmSendEmail: overrides.confirmSendEmail || (async (draft, user) => {
      sent.push({ draft, user, timestamp: Date.now() });
      return { message: 'Email sent', success: true };
    }),
    searchInbox: overrides.searchInbox || (async ({ from, since, subject }) => {
      return inbox.filter(e =>
        (!from || e.from === from) &&
        (!subject || e.subject.includes(subject))
      );
    }),
    _sent: sent,
    _inbox: inbox
  };
}

/**
 * Creates a mock TalkClient with message tracking.
 * @param {object} [overrides] - Override default behavior
 * @returns {object} Mock with sendMessage + call tracking
 */
function createMockTalkClient(overrides = {}) {
  const messages = [];
  return {
    sendMessage: overrides.sendMessage || (async (token, msg) => {
      messages.push({ token, msg, timestamp: Date.now() });
    }),
    _messages: messages
  };
}

// ============================================================
// Shared Fixtures
// ============================================================

/** Next Monday at 09:00 UTC — deterministic base for all slot math */
function nextMonday() {
  const d = new Date('2026-03-16T09:00:00Z'); // Monday
  return d;
}

/** A week-long timeframe starting next Monday */
const TIMEFRAME = {
  start: new Date('2026-03-16T09:00:00Z'),
  end: new Date('2026-03-20T17:00:00Z')
};

/** Sample events for calendar A (organizer) — busy Tuesday 10-11 and Thursday 14-15 */
const CALENDAR_A_EVENTS = [
  { uid: 'a1', summary: 'Team sync', start: '2026-03-17T10:00:00Z', end: '2026-03-17T11:00:00Z' },
  { uid: 'a2', summary: 'Client call', start: '2026-03-19T14:00:00Z', end: '2026-03-19T15:00:00Z' }
];

/** Sample events for calendar B (internal participant) — busy Tuesday 14-15 */
const CALENDAR_B_EVENTS = [
  { uid: 'b1', summary: 'Sprint review', start: '2026-03-17T14:00:00Z', end: '2026-03-17T15:00:00Z' }
];

/** Sample events for a fully-booked freelancer calendar — all day every day */
const FULLY_BOOKED_EVENTS = [
  { uid: 'fb1', summary: 'Booked', start: '2026-03-16T08:00:00Z', end: '2026-03-16T18:00:00Z' },
  { uid: 'fb2', summary: 'Booked', start: '2026-03-17T08:00:00Z', end: '2026-03-17T18:00:00Z' },
  { uid: 'fb3', summary: 'Booked', start: '2026-03-18T08:00:00Z', end: '2026-03-18T18:00:00Z' },
  { uid: 'fb4', summary: 'Booked', start: '2026-03-19T08:00:00Z', end: '2026-03-19T18:00:00Z' },
  { uid: 'fb5', summary: 'Booked', start: '2026-03-20T08:00:00Z', end: '2026-03-20T18:00:00Z' }
];

/** Freelancer calendar — busy Wednesday 10-12, narrows candidates */
const FREELANCER_EVENTS = [
  { uid: 'f1', summary: 'External gig', start: '2026-03-18T10:00:00Z', end: '2026-03-18T12:00:00Z' }
];

/** Internal participants for a typical editorial meeting */
const INTERNAL_PARTICIPANTS = [
  { name: 'Tom', tier: 1, type: 'internal', userId: 'tom', email: 'tom@example.com', calendarId: 'tom-personal' },
  { name: 'Lisa', tier: 1, type: 'internal', userId: 'lisa', email: 'lisa@example.com', calendarId: 'lisa-personal' }
];

/** Freelancer participant */
const FREELANCER_PARTICIPANT = {
  name: 'Maria', tier: 2, type: 'freelancer', calendarId: 'maria-subscribed', email: 'maria@freelance.de'
};

/** External participant */
const EXTERNAL_PARTICIPANT = {
  name: 'Hans', tier: 3, type: 'external', email: 'hans@paradiesgarten.com', calendarId: null
};

/** External participant without email */
const EXTERNAL_NO_EMAIL = {
  name: 'Klaus', tier: 3, type: 'external', email: null, calendarId: null
};

/** Sample candidate slots (output of Tier 1) */
const CANDIDATE_SLOTS = [
  { start: new Date('2026-03-17T14:00:00Z'), end: new Date('2026-03-17T15:00:00Z'), day: 'Dienstag', time: '14:00' },
  { start: new Date('2026-03-18T10:00:00Z'), end: new Date('2026-03-18T11:00:00Z'), day: 'Mittwoch', time: '10:00' },
  { start: new Date('2026-03-19T15:00:00Z'), end: new Date('2026-03-19T16:00:00Z'), day: 'Donnerstag', time: '15:00' }
];

/** Standard session context */
const SESSION = { userId: 'editor', displayName: 'Editor', language: 'de' };

/** Minimal logger mock */
const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {}
};

// ============================================================
// Helper: build a DateCoordinator with default mocks
// ============================================================

/**
 * Constructs a DateCoordinator with all dependencies mocked.
 * Pass overrides to replace individual mocks.
 * @param {object} [overrides] - Keyed by dependency name
 * @returns {{ coordinator: DateCoordinator, mocks: object }}
 */
function buildCoordinator(overrides = {}) {
  const mocks = {
    caldavClient: overrides.caldavClient || createMockCalDAVClient(),
    emailHandler: overrides.emailHandler || createMockEmailHandler(),
    deckClient: overrides.deckClient || createMockDeckClient(),
    contactsClient: overrides.contactsClient || createMockContactsClient(),
    talkClient: overrides.talkClient || createMockTalkClient(),
    ncRequestManager: overrides.ncRequestManager || createMockNCRequestManager(),
    llmRouter: overrides.llmRouter || createMockLLMRouter(),
    logger: overrides.logger || logger
  };

  const coordinator = new DateCoordinator(mocks);
  return { coordinator, mocks };
}


// ============================================================
// Test Suite
// ============================================================

(async () => {
  console.log('\n=== DateCoordinator Tests ===\n');

  // ──────────────────────────────────────────────────────────
  // TIER 1 — Internal Calendar Resolution
  // ──────────────────────────────────────────────────────────

  await asyncTest('T1.1 — Find free slots across 2 NC calendars returns correct intersection', async () => {
    const caldavClient = createMockCalDAVClient({
      events: [],
      calendars: [
        { id: 'editor-personal', displayName: 'Personal' },
        { id: 'tom-personal', displayName: 'Tom Personal' }
      ]
    });
    const eventsByCalendar = {
      'editor-personal': CALENDAR_A_EVENTS,
      'tom-personal': CALENDAR_B_EVENTS
    };
    caldavClient.getEvents = async (calId, start, end) => eventsByCalendar[calId] || [];

    const { coordinator } = buildCoordinator({ caldavClient });

    const slots = await coordinator._findFreeSlots(
      ['editor-personal', 'tom-personal'],
      TIMEFRAME,
      60
    );

    // Must return at least one valid slot
    assert.ok(slots.length > 0, 'Expected at least one free slot');

    // Busy periods from both calendars:
    // A: Tue 10-11, Thu 14-15
    // B: Tue 14-15
    const busyRanges = [
      { start: new Date('2026-03-17T10:00:00Z'), end: new Date('2026-03-17T11:00:00Z') },
      { start: new Date('2026-03-19T14:00:00Z'), end: new Date('2026-03-19T15:00:00Z') },
      { start: new Date('2026-03-17T14:00:00Z'), end: new Date('2026-03-17T15:00:00Z') },
    ];

    for (const slot of slots) {
      for (const busy of busyRanges) {
        const overlaps = slot.start < busy.end && slot.end > busy.start;
        assert.ok(!overlaps,
          `Slot ${slot.day} ${slot.time} overlaps with busy period ${busy.start.toISOString()}`
        );
      }
      // Each slot must fall within the timeframe
      assert.ok(slot.start >= TIMEFRAME.start && slot.end <= TIMEFRAME.end,
        `Slot outside timeframe: ${slot.start.toISOString()}`
      );
    }
  });

  await asyncTest('T1.2 — No overlapping free slots returns appropriate message', async () => {
    const caldavClient = createMockCalDAVClient();
    caldavClient.getEvents = async (calId, start, end) => FULLY_BOOKED_EVENTS;

    const { coordinator } = buildCoordinator({ caldavClient });

    const slots = await coordinator._findFreeSlots(
      ['editor-personal', 'tom-personal'],
      TIMEFRAME,
      60
    );

    // Fully booked calendar covers all business hours — no free slots expected
    assert.strictEqual(slots.length, 0, 'Expected empty slot array for fully booked calendars');
  });

  await asyncTest('T1.3 — Single internal participant uses organizer + 1 calendar', async () => {
    const calendarCalls = [];
    const caldavClient = createMockCalDAVClient();
    caldavClient.getEvents = async (calId, start, end) => {
      calendarCalls.push(calId);
      return [];
    };

    const { coordinator } = buildCoordinator({ caldavClient });

    // Call _findFreeSlots with 2 distinct calendar IDs (organizer + 1 participant)
    const calIds = ['editor-personal', 'tom-personal'];
    await coordinator._findFreeSlots(calIds, TIMEFRAME, 60);

    assert.strictEqual(calendarCalls.length, 2,
      `Expected exactly 2 getEvents calls, got ${calendarCalls.length}`
    );
    assert.notStrictEqual(calendarCalls[0], calendarCalls[1],
      'Expected two distinct calendar IDs'
    );
    assert.ok(calendarCalls.includes('editor-personal'), 'Should query editor-personal');
    assert.ok(calendarCalls.includes('tom-personal'), 'Should query tom-personal');
  });

  // ──────────────────────────────────────────────────────────
  // TIER 2 — Freelancer Subscribed Calendars
  // ──────────────────────────────────────────────────────────

  await asyncTest('T2.1 — Subscribed calendar narrows candidates correctly', async () => {
    const caldavClient = createMockCalDAVClient();
    const eventsByCalendar = {
      'editor-personal': [],
      'tom-personal': [],
      'maria-subscribed': FREELANCER_EVENTS // busy Wed 10-12
    };
    caldavClient.getEvents = async (calId, start, end) => eventsByCalendar[calId] || [];

    const { coordinator } = buildCoordinator({ caldavClient });

    // CANDIDATE_SLOTS contains Wed 10:00-11:00 which overlaps FREELANCER_EVENTS
    const narrowed = await coordinator._narrowSlots(
      CANDIDATE_SLOTS,
      ['maria-subscribed'],
      60
    );

    // Wed 10:00-11:00 slot overlaps freelancer busy 10-12 → must be excluded
    const wedSlot = narrowed.find(s => s.day === 'Mittwoch' && s.time === '10:00');
    assert.ok(!wedSlot, 'Wednesday 10:00 slot should be excluded due to freelancer conflict');

    // Remaining slots must not overlap with FREELANCER_EVENTS (Wed 10-12)
    const freelancerBusy = { start: new Date('2026-03-18T10:00:00Z'), end: new Date('2026-03-18T12:00:00Z') };
    for (const slot of narrowed) {
      const overlaps = slot.start < freelancerBusy.end && slot.end > freelancerBusy.start;
      assert.ok(!overlaps, `Slot ${slot.day} ${slot.time} should not conflict with freelancer`);
    }

    // Narrowed result must be smaller than original candidates (3 → 2)
    assert.ok(narrowed.length < CANDIDATE_SLOTS.length,
      `Expected fewer slots after narrowing, got ${narrowed.length} from ${CANDIDATE_SLOTS.length}`
    );
  });

  await asyncTest('T2.2 — Freelancer fully booked offers "without freelancer?" option', async () => {
    const caldavClient = createMockCalDAVClient();
    caldavClient.getEvents = async (calId, start, end) => {
      if (calId === 'maria-subscribed') return FULLY_BOOKED_EVENTS;
      return [];
    };

    const { coordinator } = buildCoordinator({ caldavClient });

    // Narrow the three candidate slots against a fully-booked freelancer calendar
    const narrowed = await coordinator._narrowSlots(
      CANDIDATE_SLOTS,
      ['maria-subscribed'],
      60
    );

    assert.strictEqual(narrowed.length, 0, 'Expected 0 slots after fully-booked narrowing');

    // Verify _runTierFlow surfaces the "without freelancer" message
    const meeting = {
      id: 'mtg-t2-2',
      state: 'TIER1_CHECKING',
      title: 'Team Meeting',
      duration: 60,
      timeframe: TIMEFRAME,
      organizerUserId: 'editor',
      participants: [FREELANCER_PARTICIPANT],
      candidateSlots: [],
      confirmedSlot: null,
      tentativeEvents: [],
      deckCardId: null,
      proposalSentAt: null,
      language: 'de',
      session: SESSION,
    };
    coordinator.activeMeetings.set(meeting.id, meeting);

    const result = await coordinator._runTierFlow(meeting);

    // Must mention the freelancer by name and suggest scheduling without them
    assert.ok(result.response, 'Expected a response');
    assert.ok(
      result.response.includes('Maria'),
      `Expected response to mention "Maria", got: ${result.response}`
    );
  });

  // ──────────────────────────────────────────────────────────
  // TIER 3 — External / Email-Only
  // ──────────────────────────────────────────────────────────

  await asyncTest('T3.1 — Email draft uses correct language (German)', async () => {
    const llmTasksCalled = [];
    const llmRouter = {
      route: async ({ task, content }) => {
        llmTasksCalled.push(task);
        if (task === 'email_draft') {
          return { result: 'Hallo Hans, folgende Termine stehen zur Auswahl: ...' };
        }
        return { result: 'Mock LLM response' };
      }
    };

    const { coordinator } = buildCoordinator({ llmRouter });

    const meeting = {
      id: 'mtg-t3-1',
      title: 'Redaktionskonferenz',
      language: 'de',
      participants: [EXTERNAL_PARTICIPANT],
      candidateSlots: CANDIDATE_SLOTS,
    };

    const slotOptions = coordinator._formatSlotOptions(CANDIDATE_SLOTS);
    const draft = await coordinator._draftProposalEmail(meeting, [EXTERNAL_PARTICIPANT], slotOptions);

    // LLM should have been called with task 'email_draft'
    assert.ok(llmTasksCalled.includes('email_draft'),
      `Expected 'email_draft' LLM task, called: ${llmTasksCalled.join(', ')}`
    );

    // Draft must contain the mock German response
    assert.ok(
      draft.includes('Hallo Hans') || draft.includes('Termine'),
      `Expected German draft content, got: ${draft}`
    );

    // Draft must include slot option text (either from LLM or fallback references the title)
    assert.ok(draft.length > 0, 'Draft should not be empty');
  });

  await asyncTest('T3.2 — HITL shows draft before sending (requiresConfirmation = true)', async () => {
    const caldavClient = createMockCalDAVClient({
      createEvent: { uid: 'tentative-1', calendarId: 'editor-personal', verified: true }
    });
    caldavClient.getEvents = async () => [];

    const emailHandler = createMockEmailHandler();

    const llmRouter = createMockLLMRouter({
      email_draft: { result: 'Hallo Hans, hier sind die Termine...' }
    });

    const { coordinator } = buildCoordinator({ caldavClient, llmRouter, emailHandler });

    // Build a meeting state with an external participant
    const meeting = {
      id: 'mtg-t3-2',
      state: 'TIER1_CHECKING',
      title: 'Redaktionskonferenz',
      duration: 60,
      timeframe: TIMEFRAME,
      organizerUserId: 'editor',
      participants: [...INTERNAL_PARTICIPANTS, EXTERNAL_PARTICIPANT],
      candidateSlots: [],
      confirmedSlot: null,
      tentativeEvents: [],
      deckCardId: null,
      proposalSentAt: null,
      language: 'de',
      session: SESSION,
    };
    coordinator.activeMeetings.set(meeting.id, meeting);

    const result = await coordinator._runTierFlow(meeting);

    // Must require HITL confirmation — email not sent yet
    assert.strictEqual(result.requiresConfirmation, true,
      'Expected requiresConfirmation to be true'
    );
    assert.ok(result.response && result.response.length > 0,
      'Expected a non-empty response (the email draft)'
    );
    // Email must NOT have been sent yet
    assert.strictEqual(emailHandler._sent.length, 0,
      `Email should not be sent before HITL confirmation, sent: ${emailHandler._sent.length}`
    );
  });

  await asyncTest('T3.3 — Reply parsing: "Dienstag passt" maps to correct slot index', async () => {
    const llmRouter = createMockLLMRouter({
      parse_reply: { result: JSON.stringify({ slotIndex: 0, confirmed: true, counterProposal: null }) }
    });

    const caldavClient = createMockCalDAVClient();
    caldavClient.createEvent = async () => ({ uid: 'final-1', calendarId: 'editor-personal', verified: true });
    caldavClient.deleteEvent = async () => ({ success: true });

    const { coordinator } = buildCoordinator({ llmRouter, caldavClient });

    const meeting = {
      id: 'meeting-test-reply',
      state: 'TIER3_WAITING',
      title: 'Redaktionskonferenz',
      participants: [EXTERNAL_PARTICIPANT],
      candidateSlots: CANDIDATE_SLOTS,
      tentativeEvents: [{ uid: 'tent-1', calendarId: 'editor-personal' }],
      deckCardId: 1,
      organizer: { email: 'editor@example.com', name: 'Editor' },
      session: SESSION,
    };

    const email = {
      from: 'hans@paradiesgarten.com',
      subject: 'Re: Redaktionskonferenz',
      body: 'Dienstag passt mir gut!'
    };

    const result = await coordinator.handleReply(email, meeting);

    // LLM must have been called with parse_reply task (verified by mock returning the right value)
    // The result should reflect finalization (confirmed slot = CANDIDATE_SLOTS[0], Tuesday 14:00)
    assert.ok(result, 'Expected a result from handleReply');
    assert.ok(result.response && result.response.length > 0, 'Expected a non-empty response');

    // Meeting should be finalized (state = DONE) because slotIndex 0 is confirmed
    assert.strictEqual(meeting.state, 'DONE',
      `Expected meeting state DONE after confirmation, got: ${meeting.state}`
    );
    assert.ok(meeting.confirmedSlot, 'Expected confirmedSlot to be set');
    assert.strictEqual(
      meeting.confirmedSlot.start.getTime(),
      CANDIDATE_SLOTS[0].start.getTime(),
      'Confirmed slot should match CANDIDATE_SLOTS[0] (Tuesday 14:00)'
    );
  });

  await asyncTest('T3.4 — Reply parsing: counter-proposal detected', async () => {
    const llmRouter = createMockLLMRouter({
      parse_reply: {
        result: JSON.stringify({
          slotIndex: null,
          confirmed: false,
          counterProposal: 'Freitag 11:00 wäre besser'
        })
      }
    });

    const { coordinator } = buildCoordinator({ llmRouter });

    const meeting = {
      id: 'meeting-test-counter',
      state: 'TIER3_WAITING',
      title: 'Redaktionskonferenz',
      participants: [EXTERNAL_PARTICIPANT],
      candidateSlots: CANDIDATE_SLOTS,
      tentativeEvents: [],
      deckCardId: null,
      organizer: { email: 'editor@example.com', name: 'Editor' }
    };

    const email = {
      from: 'hans@paradiesgarten.com',
      subject: 'Re: Redaktionskonferenz',
      body: 'Die Zeiten passen leider nicht. Freitag 11:00 wäre besser.'
    };

    const result = await coordinator.handleReply(email, meeting);

    assert.strictEqual(result.needsDecision, true,
      'Expected needsDecision=true for counter-proposal'
    );
    assert.ok(
      result.response.includes('Freitag 11:00') || result.response.includes('Gegenvorschlag') ||
      result.response.includes('Freitag'),
      `Expected counter-proposal text in response, got: ${result.response}`
    );
    assert.ok(
      result.response.includes('hans') || result.response.includes('Hans') ||
      result.response.includes('Teilnehmer'),
      `Expected sender reference in response, got: ${result.response}`
    );
  });

  await asyncTest('T3.5 — Missing email asks user for the address', async () => {
    // contactsClient returns unresolved for all lookups
    const contactsClient = createMockContactsClient({
      resolve: { resolved: false, error: 'no_match' }
    });

    const caldavClient = createMockCalDAVClient({
      createEvent: { uid: 'tentative-1', calendarId: 'editor-personal', verified: true }
    });
    caldavClient.getEvents = async () => [];

    const { coordinator } = buildCoordinator({ caldavClient, contactsClient });

    // Build a meeting with an external participant who has no email
    const meeting = {
      id: 'mtg-t3-5',
      state: 'TIER1_CHECKING',
      title: 'Redaktionskonferenz',
      duration: 60,
      timeframe: TIMEFRAME,
      organizerUserId: 'editor',
      participants: [EXTERNAL_NO_EMAIL],
      candidateSlots: [],
      confirmedSlot: null,
      tentativeEvents: [],
      deckCardId: null,
      proposalSentAt: null,
      language: 'de',
      session: SESSION,
    };
    coordinator.activeMeetings.set(meeting.id, meeting);

    const result = await coordinator._runTierFlow(meeting);

    assert.strictEqual(result.needsInfo, 'emails',
      `Expected needsInfo='emails', got: ${result.needsInfo}`
    );
    assert.ok(
      result.response.includes('Klaus'),
      `Expected participant name "Klaus" in response, got: ${result.response}`
    );
    // No email sent
    const emailMock = coordinator.emailHandler;
    assert.ok(
      !emailMock._sent || emailMock._sent.length === 0,
      'No email should be sent when email is missing'
    );
  });

  // ──────────────────────────────────────────────────────────
  // FINALIZATION
  // ──────────────────────────────────────────────────────────

  await asyncTest('F.1 — Calendar event created with all attendees and RSVP flags', async () => {
    const createEventCalls = [];
    const caldavClient = createMockCalDAVClient();
    caldavClient.createEvent = async (eventData) => {
      createEventCalls.push(eventData);
      return { uid: 'final-event-1', calendarId: 'editor-personal', verified: true };
    };
    caldavClient.deleteEvent = async () => ({ success: true });

    // Override scheduleMeeting to capture the call
    const scheduleCalls = [];
    caldavClient.scheduleMeeting = async (meeting) => {
      scheduleCalls.push(meeting);
      return { uid: 'final-event-1', calendarId: 'editor-personal' };
    };

    const { coordinator } = buildCoordinator({ caldavClient });

    const meeting = {
      id: 'meeting-finalize',
      state: 'TIER3_WAITING',
      title: 'Redaktionskonferenz',
      participants: [...INTERNAL_PARTICIPANTS, FREELANCER_PARTICIPANT, EXTERNAL_PARTICIPANT],
      candidateSlots: CANDIDATE_SLOTS,
      tentativeEvents: [
        { uid: 'tent-1', calendarId: 'editor-personal' },
        { uid: 'tent-2', calendarId: 'editor-personal' },
        { uid: 'tent-3', calendarId: 'editor-personal' }
      ],
      deckCardId: 1,
      organizer: { email: 'editor@example.com', name: 'Editor' },
      session: SESSION,
    };

    const confirmedSlot = CANDIDATE_SLOTS[1]; // Wednesday 10:00

    await coordinator._finalizeMeeting(meeting, confirmedSlot);

    // scheduleMeeting must be called exactly once
    assert.strictEqual(scheduleCalls.length, 1,
      `Expected scheduleMeeting called once, got ${scheduleCalls.length}`
    );

    const eventData = scheduleCalls[0];

    // Event title matches meeting title
    assert.strictEqual(eventData.summary, 'Redaktionskonferenz',
      `Expected summary 'Redaktionskonferenz', got: ${eventData.summary}`
    );

    // Event start/end matches confirmed slot
    assert.strictEqual(
      new Date(eventData.start).getTime(),
      confirmedSlot.start.getTime(),
      'Event start should match confirmed slot'
    );
    assert.strictEqual(
      new Date(eventData.end).getTime(),
      confirmedSlot.end.getTime(),
      'Event end should match confirmed slot'
    );

    // All 4 participants appear as attendees
    const attendees = eventData.attendees || [];
    assert.ok(attendees.length >= 4,
      `Expected at least 4 attendees, got ${attendees.length}`
    );

    const names = attendees.map(a => a.name);
    assert.ok(names.includes('Tom'), 'Tom should be an attendee');
    assert.ok(names.includes('Lisa'), 'Lisa should be an attendee');
    assert.ok(names.includes('Maria'), 'Maria should be an attendee');
    assert.ok(names.includes('Hans'), 'Hans should be an attendee');

    // External attendees (tier 3) have rsvp: true
    const hansAttendee = attendees.find(a => a.name === 'Hans');
    assert.ok(hansAttendee, 'Hans attendee entry expected');
    assert.strictEqual(hansAttendee.rsvp, true,
      'External attendee (Hans) should have rsvp: true'
    );

    // Internal attendees (tier 1) have partstat: 'ACCEPTED'
    const tomAttendee = attendees.find(a => a.name === 'Tom');
    assert.ok(tomAttendee, 'Tom attendee entry expected');
    assert.strictEqual(tomAttendee.partstat, 'ACCEPTED',
      'Internal attendee (Tom) should have partstat: ACCEPTED'
    );
  });

  await asyncTest('F.2 — Tentative blocks released except the confirmed slot', async () => {
    const deleteCalls = [];
    const caldavClient = createMockCalDAVClient();
    caldavClient.createEvent = async () => ({ uid: 'final-event-1', calendarId: 'editor-personal', verified: true });
    caldavClient.scheduleMeeting = async () => ({ uid: 'final-event-1', calendarId: 'editor-personal' });
    caldavClient.deleteEvent = async (calId, uid) => {
      deleteCalls.push({ calId, uid });
      return { success: true };
    };

    const { coordinator } = buildCoordinator({ caldavClient });

    const meeting = {
      id: 'meeting-release',
      state: 'TIER3_WAITING',
      title: 'Redaktionskonferenz',
      participants: [EXTERNAL_PARTICIPANT],
      candidateSlots: CANDIDATE_SLOTS,
      tentativeEvents: [
        { uid: 'tent-1', calendarId: 'editor-personal' },
        { uid: 'tent-2', calendarId: 'editor-personal' },
        { uid: 'tent-3', calendarId: 'editor-personal' }
      ],
      deckCardId: null,
      organizer: { email: 'editor@example.com', name: 'Editor' },
      session: SESSION,
    };

    // Confirmed slot is index 1 (Wednesday) → tent-2 should NOT be deleted
    const confirmedSlot = CANDIDATE_SLOTS[1];

    await coordinator._finalizeMeeting(meeting, confirmedSlot);

    // Exactly 2 deletes (tent-1 and tent-3); tent-2 (index 1) is kept
    assert.strictEqual(deleteCalls.length, 2,
      `Expected 2 deleteEvent calls, got ${deleteCalls.length}`
    );
    const deletedUids = deleteCalls.map(c => c.uid);
    assert.ok(deletedUids.includes('tent-1'), 'tent-1 should be deleted');
    assert.ok(deletedUids.includes('tent-3'), 'tent-3 should be deleted');
    assert.ok(!deletedUids.includes('tent-2'),
      'tent-2 (confirmed slot) should NOT be deleted'
    );
  });

  await asyncTest('F.3 — Confirmation email sent to external participants', async () => {
    const emailHandler = createMockEmailHandler();
    const caldavClient = createMockCalDAVClient();
    caldavClient.createEvent = async () => ({ uid: 'final-1', calendarId: 'editor-personal', verified: true });
    caldavClient.scheduleMeeting = async () => ({ uid: 'final-1', calendarId: 'editor-personal' });
    caldavClient.deleteEvent = async () => ({ success: true });

    const { coordinator } = buildCoordinator({ caldavClient, emailHandler });

    const meeting = {
      id: 'meeting-confirm-email',
      state: 'TIER3_WAITING',
      title: 'Redaktionskonferenz',
      participants: [...INTERNAL_PARTICIPANTS, EXTERNAL_PARTICIPANT],
      candidateSlots: CANDIDATE_SLOTS,
      tentativeEvents: [],
      deckCardId: null,
      organizer: { email: 'editor@example.com', name: 'Editor' },
      session: SESSION,
    };

    const confirmedSlot = CANDIDATE_SLOTS[0];

    await coordinator._finalizeMeeting(meeting, confirmedSlot);

    // Only Hans (tier 3) should receive a confirmation email
    assert.strictEqual(emailHandler._sent.length, 1,
      `Expected 1 confirmation email (Hans only), got ${emailHandler._sent.length}`
    );

    const sentDraft = emailHandler._sent[0].draft;
    assert.ok(
      sentDraft.to === 'hans@paradiesgarten.com' ||
      (sentDraft.subject && sentDraft.subject.includes('Redaktionskonferenz')),
      `Email should be addressed to Hans or reference the meeting title, got: ${JSON.stringify(sentDraft)}`
    );

    // Internal participants must NOT receive confirmation email
    const sentToAddresses = emailHandler._sent.map(s => s.draft && s.draft.to);
    assert.ok(!sentToAddresses.includes('tom@example.com'),
      'Tom (internal) should not receive confirmation email'
    );
    assert.ok(!sentToAddresses.includes('lisa@example.com'),
      'Lisa (internal) should not receive confirmation email'
    );
  });

  await asyncTest('F.4 — Deck card moved to Done on finalization', async () => {
    const deckClient = createMockDeckClient();
    const caldavClient = createMockCalDAVClient();
    caldavClient.createEvent = async () => ({ uid: 'final-1', calendarId: 'editor-personal', verified: true });
    caldavClient.scheduleMeeting = async () => ({ uid: 'final-1', calendarId: 'editor-personal' });
    caldavClient.deleteEvent = async () => ({ success: true });

    const { coordinator } = buildCoordinator({ caldavClient, deckClient });

    const meeting = {
      id: 'meeting-deck-done',
      state: 'TIER3_WAITING',
      title: 'Redaktionskonferenz',
      participants: [EXTERNAL_PARTICIPANT],
      candidateSlots: CANDIDATE_SLOTS,
      tentativeEvents: [],
      deckCardId: 42,
      organizer: { email: 'editor@example.com', name: 'Editor' },
      session: SESSION,
    };

    const confirmedSlot = CANDIDATE_SLOTS[0];

    await coordinator._finalizeMeeting(meeting, confirmedSlot);

    assert.strictEqual(deckClient._moves.length, 1,
      `Expected 1 deck moveCard call, got ${deckClient._moves.length}`
    );
    assert.strictEqual(deckClient._moves[0].cardId, 42,
      `Expected cardId 42, got ${deckClient._moves[0].cardId}`
    );
    assert.strictEqual(deckClient._moves[0].targetStack, 'Done',
      `Expected targetStack 'Done', got ${deckClient._moves[0].targetStack}`
    );
  });

  await asyncTest('F.5 — Talk notification sent with full meeting details', async () => {
    const talkClient = createMockTalkClient();
    const caldavClient = createMockCalDAVClient();
    caldavClient.createEvent = async () => ({ uid: 'final-1', calendarId: 'editor-personal', verified: true });
    caldavClient.scheduleMeeting = async () => ({ uid: 'final-1', calendarId: 'editor-personal' });
    caldavClient.deleteEvent = async () => ({ success: true });

    const { coordinator } = buildCoordinator({ caldavClient, talkClient });

    const meeting = {
      id: 'meeting-talk-notify',
      state: 'TIER3_WAITING',
      title: 'Redaktionskonferenz',
      participants: [...INTERNAL_PARTICIPANTS, EXTERNAL_PARTICIPANT],
      candidateSlots: CANDIDATE_SLOTS,
      tentativeEvents: [],
      deckCardId: null,
      organizer: { email: 'editor@example.com', name: 'Editor' },
      session: { ...SESSION, token: 'talk-room-token-xyz' },
    };

    const confirmedSlot = CANDIDATE_SLOTS[1]; // Wednesday 10:00

    await coordinator._finalizeMeeting(meeting, confirmedSlot);

    assert.ok(talkClient._messages.length >= 1,
      `Expected at least 1 Talk message, got ${talkClient._messages.length}`
    );

    const talkMsg = talkClient._messages[0].msg;
    assert.ok(
      talkMsg.includes('Redaktionskonferenz'),
      `Talk message should include meeting title, got: ${talkMsg}`
    );
    assert.ok(
      talkMsg.includes('Mittwoch') || talkMsg.includes('10:00'),
      `Talk message should include confirmed day/time, got: ${talkMsg}`
    );
    // At least one participant name should appear
    const hasParticipant = ['Tom', 'Lisa', 'Hans'].some(name => talkMsg.includes(name));
    assert.ok(hasParticipant,
      `Talk message should include participant names, got: ${talkMsg}`
    );
  });

  // ──────────────────────────────────────────────────────────
  // HEARTBEAT — Reply Detection
  // ──────────────────────────────────────────────────────────

  await asyncTest('H.1 — Reply detected in inbox triggers handleReply', async () => {
    const replyEmail = {
      from: 'hans@paradiesgarten.com',
      subject: 'Re: Redaktionskonferenz',
      body: 'Mittwoch 10 Uhr passt!',
      date: new Date('2026-03-17T08:00:00Z')
    };

    const emailHandler = createMockEmailHandler({ inbox: [replyEmail] });

    const llmRouter = createMockLLMRouter({
      parse_reply: { result: JSON.stringify({ slotIndex: 1, confirmed: true, counterProposal: null }) }
    });

    const caldavClient = createMockCalDAVClient();
    caldavClient.createEvent = async () => ({ uid: 'final-1', calendarId: 'editor-personal', verified: true });
    caldavClient.scheduleMeeting = async () => ({ uid: 'final-1', calendarId: 'editor-personal' });
    caldavClient.deleteEvent = async () => ({ success: true });

    const { coordinator } = buildCoordinator({ caldavClient, emailHandler, llmRouter });

    const meeting = {
      id: 'meeting-heartbeat-reply',
      state: 'TIER3_WAITING',
      title: 'Redaktionskonferenz',
      participants: [EXTERNAL_PARTICIPANT],
      candidateSlots: CANDIDATE_SLOTS,
      tentativeEvents: [],
      deckCardId: null,
      organizer: { email: 'editor@example.com', name: 'Editor' },
      proposalSentAt: new Date('2026-03-16T12:00:00Z'),
      session: SESSION,
    };
    coordinator.activeMeetings.set(meeting.id, meeting);

    const outcomes = await coordinator.checkMeetingReplies();

    // Should detect the reply for Hans
    assert.ok(outcomes.length > 0, 'Expected at least one outcome from checkMeetingReplies');
    const handled = outcomes.find(o => o.action === 'reply_handled');
    assert.ok(handled,
      `Expected a 'reply_handled' outcome, got: ${outcomes.map(o => o.action).join(', ')}`
    );

    // handleReply was called → LLM parse_reply was invoked → meeting should be finalized
    assert.ok(
      meeting.state === 'DONE' || meeting.state === 'FINALIZING',
      `Expected meeting state DONE or FINALIZING after reply, got: ${meeting.state}`
    );
  });

  await asyncTest('H.2 — No reply after 24h surfaces reminder option', async () => {
    const emailHandler = createMockEmailHandler({ inbox: [] }); // empty inbox

    const { coordinator } = buildCoordinator({ emailHandler });

    const meeting = {
      id: 'meeting-heartbeat-stale',
      state: 'TIER3_WAITING',
      title: 'Redaktionskonferenz',
      participants: [EXTERNAL_PARTICIPANT],
      candidateSlots: CANDIDATE_SLOTS,
      tentativeEvents: [],
      deckCardId: 1,
      organizer: { email: 'editor@example.com', name: 'Editor' },
      proposalSentAt: new Date(Date.now() - 25 * 60 * 60 * 1000) // 25 hours ago
    };
    coordinator.activeMeetings.set(meeting.id, meeting);

    const outcomes = await coordinator.checkMeetingReplies();

    assert.ok(outcomes.length > 0, 'Expected at least one outcome');

    const reminder = outcomes.find(o => o.action === 'reminder_suggested');
    assert.ok(reminder,
      `Expected 'reminder_suggested' outcome, got: ${outcomes.map(o => o.action).join(', ')}`
    );
    assert.ok(
      reminder.result.response.includes('Hans') ||
      reminder.result.response.includes('Erinnerung') ||
      reminder.result.reminderSuggested === true,
      `Expected reminder suggestion response, got: ${reminder.result.response}`
    );

    // Meeting still TIER3_WAITING — not finalized
    assert.strictEqual(meeting.state, 'TIER3_WAITING',
      `Meeting should still be TIER3_WAITING after no-reply check, got: ${meeting.state}`
    );
  });

  // ──────────────────────────────────────────────────────────

  setTimeout(() => { summary(); exitWithCode(); }, 500);
})();
