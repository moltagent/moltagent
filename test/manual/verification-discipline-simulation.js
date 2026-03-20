#!/usr/bin/env node
/**
 * Verification Discipline — Failure Simulation Test
 *
 * Tests that tool handlers report honest failures when the API returns
 * empty/null responses, instead of hallucinating success with "card #undefined".
 *
 * Uses the real ToolRegistry class with failure-injected clients.
 * No production credentials or auth changes needed.
 *
 * Run: node test/manual/verification-discipline-simulation.js
 */

const { ToolRegistry } = require('../../src/lib/agent/tool-registry');
const DECK = require('../../src/config/deck-names');

const logger = { info: () => {}, warn: () => {}, error: () => {} };

// DeckClient that simulates the exact failure mode:
// API returns 200 with empty body → falls back to { success: true, statusCode: 200 }
function createFailingDeckClient() {
  return {
    username: 'moltagent',
    stackNames: { inbox: 'Inbox', queued: 'Queued', working: 'Working', review: 'Review', done: 'Done', reference: 'Reference' },
    getAllCards: async () => ({ inbox: [{ id: 10, title: 'Existing Card' }] }),
    getCardsInStack: async (stack) => stack === 'inbox' ? [{ id: 10, title: 'Existing Card' }] : [],
    createCard: async () => ({ success: true, statusCode: 200 }),  // ← THE BUG: no .id field
    moveCard: async () => {},
    ensureBoard: async () => ({ boardId: 1, stacks: {} }),
    listBoards: async () => [
      { id: 1, title: DECK.boards.tasks, owner: { uid: 'moltagent' } },
      { id: 5, title: 'Test Board', owner: { uid: 'moltagent' } }
    ],
    getBoard: async (boardId) => ({
      id: boardId, title: 'Test Board', owner: { uid: 'moltagent' },
      stacks: [{ id: 301, title: 'Inbox', cards: [] }], labels: []
    }),
    getStacks: async () => [{ id: 301, title: 'Inbox', cards: [] }],
    getCard: async () => ({ id: 10, title: 'Existing Card', description: '', assignedUsers: [], labels: [], duedate: null, type: 'plain', owner: { uid: 'moltagent' } }),
    updateCard: async () => {},
    deleteCard: async () => {},
    assignUser: async () => {},
    unassignUser: async () => {},
    addLabel: async () => {},
    removeLabel: async () => {},
    addComment: async () => {},
    getComments: async () => [],
    shareBoard: async () => ({ id: 100 }),
    createStack: async () => ({ id: 50, title: 'New' }),
    _request: async (method, path, body) => {
      if (method === 'POST' && path.includes('/cards')) {
        // Simulate empty body response → no .id field
        return { success: true, statusCode: 200 };
      }
      return { id: 1, title: 'Test' };
    }
  };
}

// CalDAV client that simulates empty response
function createFailingCalDAVClient() {
  return {
    getUpcomingEvents: async () => [],
    createEvent: async () => null,  // ← empty response
    checkAvailability: async () => ({ isFree: true, conflicts: [] })
  };
}

// NC Request Manager stub (needed for workflow tools registration)
function createStubNCRequestManager() {
  return {
    ncUrl: 'https://test.example.com',
    ncUser: 'testuser',
    request: async () => ({ status: 200, body: {} }),
    getUserEmail: async (userId) => `${userId}@example.com`
  };
}

async function runSimulation() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  Verification Discipline — Failure Simulation Test      ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const registry = new ToolRegistry({
    deckClient: createFailingDeckClient(),
    calDAVClient: createFailingCalDAVClient(),
    ncRequestManager: createStubNCRequestManager(),
    emailHandler: {
      confirmSendEmail: async () => null  // ← no confirmation
    },
    logger
  });

  let passed = 0;
  let failed = 0;

  async function test(name, toolName, args, expectContains, expectNotContains) {
    const result = await registry.execute(toolName, args);
    const text = result.result;

    const containsOk = expectContains.every(s => text.includes(s));
    const notContainsOk = expectNotContains.every(s => !text.includes(s));

    if (containsOk && notContainsOk) {
      console.log(`  [PASS] ${name}`);
      console.log(`         → "${text.slice(0, 120)}"`);
      passed++;
    } else {
      console.log(`  [FAIL] ${name}`);
      console.log(`         → "${text}"`);
      if (!containsOk) console.log(`         Expected to contain: ${expectContains.filter(s => !text.includes(s)).join(', ')}`);
      if (!notContainsOk) console.log(`         Should NOT contain: ${expectNotContains.filter(s => text.includes(s)).join(', ')}`);
      failed++;
    }
  }

  // === Scenario 1: deck_create_card on default board (empty body, no .id) ===
  console.log('Scenario 1: deck_create_card — default board, API returns {success:true} with no .id');
  await test(
    'Guard catches missing card ID',
    'deck_create_card',
    { title: 'Research top 5 competitors' },
    ['Failed'],
    ['undefined', '#undefined', 'Created']
  );

  // === Scenario 2: deck_create_card on named board (empty body via _request) ===
  console.log('\nScenario 2: deck_create_card — board-targeted, _request returns {success:true}');
  await test(
    'Guard catches missing card ID on board path',
    'deck_create_card',
    { title: 'Draft welcome email', board: 'Test Board' },
    ['Failed'],
    ['undefined', '#undefined', 'Created']
  );

  // === Scenario 3: workflow_deck_create_card (null response) ===
  console.log('\nScenario 3: workflow_deck_create_card — null from createFn');
  const wfDeck = createFailingDeckClient();
  wfDeck._request = async (method) => {
    if (method === 'POST') return null;
    return [{ id: 301, title: 'Inbox' }];
  };
  wfDeck.getStacks = async () => [{ id: 301, title: 'Inbox' }];
  const wfRegistry = new ToolRegistry({
    deckClient: wfDeck,
    ncRequestManager: createStubNCRequestManager(),
    logger
  });
  const wfResult = await wfRegistry.execute('workflow_deck_create_card', {
    title: 'Workflow test card', board_id: 1, stack_id: 301
  });
  if (wfResult.result.includes('Failed') && !wfResult.result.includes('undefined')) {
    console.log(`  [PASS] Guard catches null response`);
    console.log(`         → "${wfResult.result.slice(0, 120)}"`);
    passed++;
  } else {
    console.log(`  [FAIL] Guard missed null response`);
    console.log(`         → "${wfResult.result}"`);
    failed++;
  }

  // === Scenario 4: calendar_create_event (null response) ===
  console.log('\nScenario 4: calendar_create_event — null from createEvent');
  await test(
    'Guard catches missing event UID',
    'calendar_create_event',
    { title: 'Team sync', start: '2026-03-01T10:00:00Z' },
    ['may not have been created'],
    ['undefined']
  );

  // === Scenario 5: mail_send (null response) ===
  console.log('\nScenario 5: mail_send — null from confirmSendEmail');
  await test(
    'Guard catches null send result',
    'mail_send',
    { to: 'test@example.com', subject: 'Test', body: 'Hello' },
    ['Failed'],
    ['undefined']
  );

  // === Scenario 6: Positive control — working deck_create_card ===
  console.log('\nScenario 6: Positive control — deck_create_card with valid response');
  const goodDeck = createFailingDeckClient();
  goodDeck.createCard = async (stack, data) => ({ id: 1348, title: data.title });
  const goodRegistry = new ToolRegistry({ deckClient: goodDeck, logger });
  const goodResult = await goodRegistry.execute('deck_create_card', { title: 'Valid card test' });
  if (goodResult.result.includes('1348') && goodResult.result.includes('Created')) {
    console.log(`  [PASS] Valid response returns success with ID`);
    console.log(`         → "${goodResult.result.slice(0, 120)}"`);
    passed++;
  } else {
    console.log(`  [FAIL] Valid response didn't return proper success`);
    console.log(`         → "${goodResult.result}"`);
    failed++;
  }

  // === Summary ===
  console.log('\n══════════════════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log('  ✓ All verification guards fired correctly.');
    console.log('  ✓ No "card #undefined" or hallucinated confirmations.');
  } else {
    console.log('  ✗ Some guards did not fire. See failures above.');
  }
  console.log('══════════════════════════════════════════════════════════\n');
  process.exit(failed > 0 ? 1 : 0);
}

runSimulation().catch(err => {
  console.error('Simulation crashed:', err);
  process.exit(1);
});
