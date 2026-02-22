/**
 * Orphan Tools Integration Tests
 *
 * Tests the 7 newly wired tools: calendar_check_availability,
 * calendar_quick_schedule, calendar_schedule_meeting, calendar_cancel_meeting,
 * deck_complete_task, deck_complete_review, contacts_resolve.
 *
 * Run: node --test test/unit/agent/orphan-tools.test.js
 */

const assert = require('assert');
const { asyncTest, test, summary, exitWithCode } = require('../../helpers/test-runner');
const { createMockCalDAVClient, createMockContactsClient, createMockNCRequestManager } = require('../../helpers/mock-factories');
const { ToolRegistry } = require('../../../src/lib/agent/tool-registry');

// ============================================================
// Helpers
// ============================================================

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function createMockDeckClient(overrides = {}) {
  return {
    username: 'moltagent',
    stackNames: { inbox: 'Inbox', queued: 'Queued', working: 'Working', review: 'Review', done: 'Done', reference: 'Reference' },
    getAllCards: async () => ({}),
    getCardsInStack: async () => [],
    createCard: async (stackName, card) => ({ id: 99, title: card.title }),
    moveCard: async () => {},
    ensureBoard: async () => ({ boardId: 1, stacks: {} }),
    listBoards: async () => [],
    getBoard: async () => ({ id: 1, title: 'Test', stacks: [], labels: [] }),
    getStacks: async () => [],
    createStack: async () => ({ id: 50, title: 'New' }),
    getCard: async () => ({ id: 1, title: 'Test', type: 'plain', owner: { uid: 'moltagent' } }),
    updateCard: async () => {},
    deleteCard: async () => {},
    assignUser: async () => {},
    unassignUser: async () => {},
    addLabel: async () => {},
    removeLabel: async () => {},
    addComment: async () => {},
    getComments: async () => [],
    shareBoard: async () => ({ id: 100 }),
    _request: async () => ({ id: 77, title: 'Board' }),
    completeTask: overrides.completeTask || (async () => {}),
    completeReview: overrides.completeReview || (async () => {}),
    ...overrides
  };
}

console.log('Orphan Tools Unit Tests\n');

// ============================================================
// Calendar: calendar_check_availability
// ============================================================

test('calendar_check_availability registered when calDAVClient provided', () => {
  const registry = new ToolRegistry({ calDAVClient: createMockCalDAVClient(), logger: silentLogger });
  assert.ok(registry.has('calendar_check_availability'));
});

asyncTest('calendar_check_availability returns free when no conflicts', async () => {
  const cal = createMockCalDAVClient({ availability: { isFree: true, conflicts: [] } });
  const registry = new ToolRegistry({ calDAVClient: cal, logger: silentLogger });
  const result = await registry.execute('calendar_check_availability', { date_time: '2026-03-01T14:00:00' });
  assert.ok(result.success);
  assert.ok(result.result.includes('free'));
  assert.ok(result.result.includes('No conflicts'));
});

asyncTest('calendar_check_availability returns conflicts when busy', async () => {
  const cal = createMockCalDAVClient({
    availability: {
      isFree: false,
      conflicts: [
        { uid: 'ev1', summary: 'Team standup', start: '2026-03-01T14:00:00Z', end: '2026-03-01T14:30:00Z' }
      ]
    }
  });
  const registry = new ToolRegistry({ calDAVClient: cal, logger: silentLogger });
  const result = await registry.execute('calendar_check_availability', { date_time: '2026-03-01T14:00:00' });
  assert.ok(result.success);
  assert.ok(result.result.includes('Not available'));
  assert.ok(result.result.includes('Team standup'));
});

// ============================================================
// Calendar: calendar_quick_schedule
// ============================================================

test('calendar_quick_schedule registered', () => {
  const registry = new ToolRegistry({ calDAVClient: createMockCalDAVClient(), logger: silentLogger });
  assert.ok(registry.has('calendar_quick_schedule'));
});

asyncTest('calendar_quick_schedule creates event when free', async () => {
  const cal = createMockCalDAVClient({
    quickSchedule: { success: true, event: { uid: 'qs-1', summary: 'Team sync' } }
  });
  const registry = new ToolRegistry({ calDAVClient: cal, logger: silentLogger });
  const result = await registry.execute('calendar_quick_schedule', {
    summary: 'Team sync',
    date_time: '2026-03-01T14:00:00'
  });
  assert.ok(result.success);
  assert.ok(result.result.includes('Scheduled'));
  assert.ok(result.result.includes('Team sync'));
});

asyncTest('calendar_quick_schedule returns conflicts when busy', async () => {
  const cal = createMockCalDAVClient({
    quickSchedule: {
      success: false,
      reason: 'conflict',
      conflicts: [
        { uid: 'ev1', summary: 'Existing call', start: '2026-03-01T14:00:00Z', end: '2026-03-01T15:00:00Z' }
      ]
    }
  });
  const registry = new ToolRegistry({ calDAVClient: cal, logger: silentLogger });
  const result = await registry.execute('calendar_quick_schedule', {
    summary: 'Team sync',
    date_time: '2026-03-01T14:00:00'
  });
  assert.ok(result.success);
  assert.ok(result.result.includes('not available'));
  assert.ok(result.result.includes('Existing call'));
});

// ============================================================
// Calendar: calendar_schedule_meeting
// ============================================================

test('calendar_schedule_meeting registered', () => {
  const registry = new ToolRegistry({ calDAVClient: createMockCalDAVClient(), logger: silentLogger });
  assert.ok(registry.has('calendar_schedule_meeting'));
});

asyncTest('calendar_schedule_meeting creates meeting with invitations', async () => {
  const cal = createMockCalDAVClient({
    scheduleMeeting: { uid: 'mtg-1', summary: 'Q1 Review' }
  });
  const ncMgr = createMockNCRequestManager({ userEmails: { testuser: 'molti@example.com' } });
  const registry = new ToolRegistry({ calDAVClient: cal, ncRequestManager: ncMgr, logger: silentLogger });
  const result = await registry.execute('calendar_schedule_meeting', {
    summary: 'Q1 Review',
    start: '2026-03-01T10:00:00',
    end: '2026-03-01T11:00:00',
    attendees: ['alice@example.com', 'bob@example.com']
  });
  assert.ok(result.success);
  assert.ok(result.result.includes('Meeting scheduled'));
  assert.ok(result.result.includes('Q1 Review'));
  assert.ok(result.result.includes('alice@example.com'));
  assert.ok(result.result.includes('Invitations sent'));
});

asyncTest('calendar_schedule_meeting fails without organizer email', async () => {
  const cal = createMockCalDAVClient();
  // No ncRequestManager → no organizer email
  const registry = new ToolRegistry({ calDAVClient: cal, logger: silentLogger });
  const result = await registry.execute('calendar_schedule_meeting', {
    summary: 'Q1 Review',
    start: '2026-03-01T10:00:00',
    end: '2026-03-01T11:00:00',
    attendees: ['alice@example.com']
  });
  assert.ok(result.success);
  assert.ok(result.result.includes('could not resolve organizer email'));
});

// ============================================================
// Calendar: calendar_cancel_meeting
// ============================================================

test('calendar_cancel_meeting registered', () => {
  const registry = new ToolRegistry({ calDAVClient: createMockCalDAVClient(), logger: silentLogger });
  assert.ok(registry.has('calendar_cancel_meeting'));
});

asyncTest('calendar_cancel_meeting cancels and returns confirmation', async () => {
  const cal = createMockCalDAVClient({ cancelMeeting: true });
  const registry = new ToolRegistry({ calDAVClient: cal, logger: silentLogger });
  const result = await registry.execute('calendar_cancel_meeting', {
    calendar_id: 'personal',
    event_uid: 'mtg-1',
    reason: 'Rescheduling'
  });
  assert.ok(result.success);
  assert.ok(result.result.includes('cancelled'));
  assert.ok(result.result.includes('Rescheduling'));
});

// ============================================================
// Calendar subset
// ============================================================

test('calendar subset includes new scheduling tools', () => {
  const cal = createMockCalDAVClient();
  const registry = new ToolRegistry({ calDAVClient: cal, logger: silentLogger });
  const subset = registry.getToolSubset('calendar');
  const names = subset.map(t => t.function.name);
  assert.ok(names.includes('calendar_list_events'), 'Should include calendar_list_events');
  assert.ok(names.includes('calendar_create_event'), 'Should include calendar_create_event');
  assert.ok(names.includes('calendar_check_availability'), 'Should include calendar_check_availability');
  assert.ok(names.includes('calendar_quick_schedule'), 'Should include calendar_quick_schedule');
  assert.ok(names.includes('calendar_schedule_meeting'), 'Should include calendar_schedule_meeting');
});

// ============================================================
// Deck: deck_complete_task
// ============================================================

test('deck_complete_task registered when deckClient provided', () => {
  const registry = new ToolRegistry({ deckClient: createMockDeckClient(), logger: silentLogger });
  assert.ok(registry.has('deck_complete_task'));
});

asyncTest('deck_complete_task moves card to Done with comment', async () => {
  let completedId = null;
  let completedMsg = null;
  const deck = createMockDeckClient({
    completeTask: async (cardId, message) => { completedId = cardId; completedMsg = message; }
  });
  const registry = new ToolRegistry({ deckClient: deck, logger: silentLogger });
  const result = await registry.execute('deck_complete_task', { card_id: 42, message: 'All done!' });
  assert.ok(result.success);
  assert.ok(result.result.includes('#42'));
  assert.ok(result.result.includes('Done'));
  assert.strictEqual(completedId, 42);
  assert.strictEqual(completedMsg, 'All done!');
});

asyncTest('deck_complete_task uses default message when none provided', async () => {
  let completedMsg = null;
  const deck = createMockDeckClient({
    completeTask: async (_cardId, message) => { completedMsg = message; }
  });
  const registry = new ToolRegistry({ deckClient: deck, logger: silentLogger });
  await registry.execute('deck_complete_task', { card_id: 1 });
  assert.strictEqual(completedMsg, 'Task complete.');
});

// ============================================================
// Deck: deck_complete_review
// ============================================================

test('deck_complete_review registered when deckClient provided', () => {
  const registry = new ToolRegistry({ deckClient: createMockDeckClient(), logger: silentLogger });
  assert.ok(registry.has('deck_complete_review'));
});

asyncTest('deck_complete_review moves card from Review to Done', async () => {
  let reviewedId = null;
  const deck = createMockDeckClient({
    completeReview: async (cardId) => { reviewedId = cardId; }
  });
  const registry = new ToolRegistry({ deckClient: deck, logger: silentLogger });
  const result = await registry.execute('deck_complete_review', { card_id: 55 });
  assert.ok(result.success);
  assert.ok(result.result.includes('Review complete'));
  assert.ok(result.result.includes('#55'));
  assert.strictEqual(reviewedId, 55);
});

// ============================================================
// Deck subset
// ============================================================

test('deck_complete_task and deck_complete_review in deck tools', () => {
  const registry = new ToolRegistry({ deckClient: createMockDeckClient(), logger: silentLogger });
  assert.ok(registry.has('deck_complete_task'));
  assert.ok(registry.has('deck_complete_review'));
});

// ============================================================
// Contacts: contacts_resolve
// ============================================================

test('contacts_resolve registered when contactsClient provided', () => {
  const registry = new ToolRegistry({ contactsClient: createMockContactsClient(), logger: silentLogger });
  assert.ok(registry.has('contacts_resolve'));
});

asyncTest('contacts_resolve single match returns details', async () => {
  const contacts = createMockContactsClient({
    resolve: { resolved: true, contact: { name: 'Alice Smith', email: 'alice@example.com', phone: '+1-555-0100', org: 'Acme Corp' } }
  });
  const registry = new ToolRegistry({ contactsClient: contacts, logger: silentLogger });
  const result = await registry.execute('contacts_resolve', { name: 'Alice' });
  assert.ok(result.success);
  assert.ok(result.result.includes('Alice Smith'));
  assert.ok(result.result.includes('alice@example.com'));
  assert.ok(result.result.includes('+1-555-0100'));
  assert.ok(result.result.includes('Acme Corp'));
});

asyncTest('contacts_resolve multiple matches returns disambiguation', async () => {
  const contacts = createMockContactsClient({
    resolve: {
      resolved: false,
      options: [
        { name: 'Alice Smith', email: 'alice@example.com' },
        { name: 'Alice Jones', email: 'alicej@example.com' }
      ]
    }
  });
  const registry = new ToolRegistry({ contactsClient: contacts, logger: silentLogger });
  const result = await registry.execute('contacts_resolve', { name: 'Alice' });
  assert.ok(result.success);
  assert.ok(result.result.includes('Multiple contacts'));
  assert.ok(result.result.includes('Alice Smith'));
  assert.ok(result.result.includes('Alice Jones'));
});

asyncTest('contacts_resolve no match returns not found', async () => {
  const contacts = createMockContactsClient({
    resolve: { resolved: false, error: 'no_match' }
  });
  const registry = new ToolRegistry({ contactsClient: contacts, logger: silentLogger });
  const result = await registry.execute('contacts_resolve', { name: 'Nobody' });
  assert.ok(result.success);
  assert.ok(result.result.includes('No contact found'));
  assert.ok(result.result.includes('Nobody'));
});

// ============================================================
// REQUIRES_APPROVAL tools have TOOL_APPROVAL_LABELS
// ============================================================

test('all REQUIRES_APPROVAL calendar tools have TOOL_APPROVAL_LABELS', () => {
  const { TOOL_APPROVAL_LABELS } = require('../../../src/lib/agent/guardrail-enforcer');
  assert.ok(TOOL_APPROVAL_LABELS.calendar_quick_schedule, 'calendar_quick_schedule label');
  assert.ok(TOOL_APPROVAL_LABELS.calendar_schedule_meeting, 'calendar_schedule_meeting label');
  assert.ok(TOOL_APPROVAL_LABELS.calendar_cancel_meeting, 'calendar_cancel_meeting label');
});

// ============================================================
// Summary
// ============================================================

setTimeout(() => {
  summary();
  exitWithCode();
}, 500);
