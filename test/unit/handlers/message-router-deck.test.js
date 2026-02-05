/**
 * MessageRouter Deck Enhancement Tests
 *
 * Tests for enhanced deck action handling, multi-card operations,
 * and conversation-aware intent classification.
 *
 * Run: node test/unit/handlers/message-router-deck.test.js
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const MessageRouter = require('../../../src/lib/handlers/message-router');

// ============================================================
// Mock Helpers
// ============================================================

function createMockDeckClient(allCards = {}) {
  return {
    ensureBoard: async () => ({ boardId: 1, stacks: {} }),
    getAllCards: async () => allCards,
    getCardsInStack: async (stack) => allCards[stack] || [],
    moveCard: async (cardId, from, to) => {},
    createCard: async (stack, data) => ({ id: 999, title: data.title }),
    getWorkloadSummary: async () => {
      const summary = { inbox: 0, queued: 0, working: 0, review: 0, done: 0, total: 0 };
      for (const [stack, cards] of Object.entries(allCards)) {
        summary[stack] = cards.length;
        summary.total += cards.length;
      }
      return summary;
    }
  };
}

function createMockAuditLog() {
  return async (event, data) => {};
}

// ============================================================
// Test Suites
// ============================================================

console.log('\n=== MessageRouter Deck Enhancement Tests ===\n');

// --- Intent Classification Tests ---
console.log('\n--- Intent Classification Tests ---\n');

test('TC-DECK-001: classifyIntent returns deck for "close X"', () => {
  const router = new MessageRouter();
  const intent = router.classifyIntent('close the report task');
  assert.strictEqual(intent, 'deck');
});

test('TC-DECK-002: classifyIntent returns deck for "put X into done"', () => {
  const router = new MessageRouter();
  const intent = router.classifyIntent('put the website redesign into done');
  assert.strictEqual(intent, 'deck');
});

test('TC-DECK-003: classifyIntent returns deck for "mark as done: X"', () => {
  const router = new MessageRouter();
  const intent = router.classifyIntent('mark as done: quarterly report');
  assert.strictEqual(intent, 'deck');
});

test('TC-DECK-004: classifyIntent returns deck for "reconfirm if X is done"', () => {
  const router = new MessageRouter();
  const intent = router.classifyIntent('reconfirm if the report is done');
  assert.strictEqual(intent, 'deck');
});

test('TC-DECK-005: classifyIntent returns deck for "move X to working"', () => {
  const router = new MessageRouter();
  const intent = router.classifyIntent('move task analysis to working');
  assert.strictEqual(intent, 'deck');
});

test('TC-DECK-006: classifyIntent returns deck for "finish X and Y"', () => {
  const router = new MessageRouter();
  const intent = router.classifyIntent('finish report and presentation');
  assert.strictEqual(intent, 'deck');
});

test('TC-DECK-007: classifyIntent returns deck for "complete X"', () => {
  const router = new MessageRouter();
  const intent = router.classifyIntent('complete the onboarding');
  assert.strictEqual(intent, 'deck');
});

// --- Multi-Card Parsing Tests ---
console.log('\n--- Multi-Card Parsing Tests ---\n');

test('TC-DECK-010: _parseMultipleCards splits "X and Y"', () => {
  const router = new MessageRouter();
  const titles = router._parseMultipleCards('close report and presentation');
  assert.strictEqual(titles.length, 2);
  assert.strictEqual(titles[0], 'report');
  assert.strictEqual(titles[1], 'presentation');
});

test('TC-DECK-011: _parseMultipleCards splits "X, Y, Z"', () => {
  const router = new MessageRouter();
  const titles = router._parseMultipleCards('finish task A, task B, task C');
  assert.strictEqual(titles.length, 3);
  assert.ok(titles.includes('task A'));
  assert.ok(titles.includes('task B'));
  assert.ok(titles.includes('task C'));
});

test('TC-DECK-012: _parseMultipleCards handles quoted titles', () => {
  const router = new MessageRouter();
  const titles = router._parseMultipleCards('close "Task with spaces" and simple');
  assert.strictEqual(titles.length, 2);
  assert.ok(titles[0].includes('Task with spaces') || titles[0] === 'simple');
});

test('TC-DECK-013: _parseMultipleCards handles single title', () => {
  const router = new MessageRouter();
  const titles = router._parseMultipleCards('close the quarterly report');
  assert.strictEqual(titles.length, 1);
  assert.ok(titles[0].includes('quarterly report'));
});

// --- Card Finding Tests ---
console.log('\n--- Card Finding Tests ---\n');

test('TC-DECK-020: _findCardByTitle finds card by partial title', () => {
  const router = new MessageRouter();
  const allCards = {
    inbox: [
      { id: 1, title: 'Complete quarterly report' },
      { id: 2, title: 'Review presentation' }
    ],
    working: []
  };

  const found = router._findCardByTitle(allCards, 'quarterly');
  assert.ok(found);
  assert.strictEqual(found.card.id, 1);
  assert.strictEqual(found.stack, 'inbox');
});

test('TC-DECK-021: _findCardByTitle returns null for no match', () => {
  const router = new MessageRouter();
  const allCards = {
    inbox: [{ id: 1, title: 'Task A' }]
  };

  const found = router._findCardByTitle(allCards, 'nonexistent');
  assert.strictEqual(found, null);
});

test('TC-DECK-022: _findCardByTitle is case insensitive', () => {
  const router = new MessageRouter();
  const allCards = {
    inbox: [{ id: 1, title: 'Complete QUARTERLY Report' }]
  };

  const found = router._findCardByTitle(allCards, 'quarterly');
  assert.ok(found);
  assert.strictEqual(found.card.id, 1);
});

// --- Deck Close Tests ---
console.log('\n--- Deck Close Tests ---\n');

asyncTest('TC-DECK-030: _handleDeckClose moves card to done', async () => {
  const allCards = {
    inbox: [{ id: 1, title: 'Task to close' }],
    done: []
  };
  const deckClient = createMockDeckClient(allCards);

  let movedCard = null;
  deckClient.moveCard = async (cardId, from, to) => {
    movedCard = { cardId, from, to };
  };

  const router = new MessageRouter({
    deckClient,
    auditLog: createMockAuditLog()
  });

  const result = await router._handleDeckClose(['Task to close'], { user: 'test' });
  assert.ok(result.response.includes('Moved'));
  assert.ok(result.response.includes('Task to close'));
  assert.strictEqual(movedCard.to, 'done');
});

asyncTest('TC-DECK-031: _handleDeckClose handles multiple cards', async () => {
  const allCards = {
    inbox: [
      { id: 1, title: 'Task A' },
      { id: 2, title: 'Task B' }
    ],
    done: []
  };
  const deckClient = createMockDeckClient(allCards);

  const movedCards = [];
  deckClient.moveCard = async (cardId, from, to) => {
    movedCards.push(cardId);
  };

  const router = new MessageRouter({
    deckClient,
    auditLog: createMockAuditLog()
  });

  const result = await router._handleDeckClose(['Task A', 'Task B'], { user: 'test' });
  assert.strictEqual(movedCards.length, 2);
  assert.ok(result.response.includes('Task A'));
  assert.ok(result.response.includes('Task B'));
});

asyncTest('TC-DECK-032: _handleDeckClose reports already-done cards', async () => {
  const allCards = {
    inbox: [],
    done: [{ id: 1, title: 'Already done task' }]
  };
  const deckClient = createMockDeckClient(allCards);

  const router = new MessageRouter({
    deckClient,
    auditLog: createMockAuditLog()
  });

  const result = await router._handleDeckClose(['Already done'], { user: 'test' });
  assert.ok(result.response.includes('already in Done'));
});

asyncTest('TC-DECK-033: _handleDeckClose reports not-found cards', async () => {
  const allCards = { inbox: [] };
  const deckClient = createMockDeckClient(allCards);

  const router = new MessageRouter({
    deckClient,
    auditLog: createMockAuditLog()
  });

  const result = await router._handleDeckClose(['Nonexistent'], { user: 'test' });
  assert.ok(result.response.includes('Could not find'));
});

// --- Deck Verify Tests ---
console.log('\n--- Deck Verify Tests ---\n');

asyncTest('TC-DECK-040: _handleDeckVerify reports card stack correctly', async () => {
  const allCards = {
    working: [{ id: 1, title: 'Task in progress' }]
  };
  const deckClient = createMockDeckClient(allCards);

  const router = new MessageRouter({
    deckClient,
    auditLog: createMockAuditLog()
  });

  const result = await router._handleDeckVerify('verify Task in progress', { user: 'test' });
  assert.ok(result.response.includes('Working') || result.response.includes('working'));
  assert.ok(result.response.includes('Task in progress'));
});

// --- Conversation-Aware Classification Tests ---
console.log('\n--- Conversation-Aware Classification Tests ---\n');

test('TC-DECK-050: classifyIntent with history resolves "close it" to deck', () => {
  const router = new MessageRouter();

  const history = [
    { role: 'user', name: 'User', content: 'What tasks do I have?' },
    { role: 'assistant', name: 'MoltAgent', content: 'Task Board Summary:\nInbox: 2\nOpen tasks:\n- Quarterly report' }
  ];

  const intent = router.classifyIntent('close it', history);
  assert.strictEqual(intent, 'deck');
});

test('TC-DECK-051: classifyIntent with history resolves "move those to done"', () => {
  const router = new MessageRouter();

  const history = [
    { role: 'assistant', name: 'MoltAgent', content: 'Task Board Summary:\nInbox: 2\nOpen tasks:\n- Task A\n- Task B' }
  ];

  const intent = router.classifyIntent('move those to done', history);
  assert.strictEqual(intent, 'deck');
});

// ============================================================
// Summary and Exit
// ============================================================

setTimeout(() => {
  summary();
  exitWithCode();
}, 100);
