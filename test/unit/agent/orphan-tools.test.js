/**
 * Orphan Tools Integration Tests
 *
 * Tests the wired tools: calendar_check_availability, calendar_cancel_meeting,
 * deck_complete_task, deck_complete_review, contacts_resolve.
 * (#169 retired calendar_quick_schedule + calendar_schedule_meeting; their
 * capabilities are now folded into calendar_create_event.)
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
  const result = await registry.execute('calendar_check_availability', { start: '2026-03-01T14:00:00' });
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
  const result = await registry.execute('calendar_check_availability', { start: '2026-03-01T14:00:00' });
  assert.ok(result.success);
  assert.ok(result.result.includes('Not available'));
  assert.ok(result.result.includes('Team standup'));
});

// ============================================================
// Calendar: retired create/schedule tools (#169)
// calendar_quick_schedule and calendar_schedule_meeting are consolidated into
// calendar_create_event (check_availability + duration_minutes + attendees).
// Consolidated behavior is covered in tool-registry.test.js.
// ============================================================

test('calendar_quick_schedule and calendar_schedule_meeting are retired (#169)', () => {
  const registry = new ToolRegistry({ calDAVClient: createMockCalDAVClient(), logger: silentLogger });
  assert.ok(!registry.has('calendar_quick_schedule'), 'calendar_quick_schedule retired');
  assert.ok(!registry.has('calendar_schedule_meeting'), 'calendar_schedule_meeting retired');
});

asyncTest('calendar_create_event absorbs availability-checked scheduling', async () => {
  const cal = createMockCalDAVClient({ availability: { isFree: true, conflicts: [] } });
  const registry = new ToolRegistry({ calDAVClient: cal, logger: silentLogger });
  const start = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const result = await registry.execute('calendar_create_event', {
    title: 'Team sync',
    start: start.toISOString(),
    duration_minutes: 30,
    check_availability: true
  });
  assert.ok(result.success);
  assert.ok(result.result.includes('Team sync'));
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

test('calendar subset reflects the consolidated tool set (#169)', () => {
  const cal = createMockCalDAVClient();
  const registry = new ToolRegistry({ calDAVClient: cal, logger: silentLogger });
  const subset = registry.getToolSubset('calendar');
  const names = subset.map(t => t.function.name);
  assert.ok(names.includes('calendar_list_events'), 'Should include calendar_list_events');
  assert.ok(names.includes('calendar_create_event'), 'Should include calendar_create_event');
  assert.ok(names.includes('calendar_check_availability'), 'Should include calendar_check_availability');
  assert.ok(!names.includes('calendar_quick_schedule'), 'calendar_quick_schedule retired');
  assert.ok(!names.includes('calendar_schedule_meeting'), 'calendar_schedule_meeting retired');
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

test('surviving calendar approval tools have TOOL_APPROVAL_LABELS (#169)', () => {
  const { TOOL_APPROVAL_LABELS } = require('../../../src/lib/agent/guardrail-enforcer');
  assert.ok(TOOL_APPROVAL_LABELS.calendar_cancel_meeting, 'calendar_cancel_meeting label');
  // Retired tools must not linger as ghost references.
  assert.ok(!TOOL_APPROVAL_LABELS.calendar_quick_schedule, 'calendar_quick_schedule label removed');
  assert.ok(!TOOL_APPROVAL_LABELS.calendar_schedule_meeting, 'calendar_schedule_meeting label removed');
});

// ============================================================
// Summary
// ============================================================

setTimeout(() => {
  summary();
  exitWithCode();
}, 500);
