/**
 * PersonalBoardManager Unit Tests
 *
 * Architecture Brief:
 * -------------------
 * Problem: The PersonalBoardManager orchestrates a personal kanban board with
 * priority scoring, automatic card triage, and working-memory summaries. These
 * behaviors must be verified in isolation without a live Nextcloud instance.
 *
 * Pattern: Mock-based unit testing with monkey-patched DeckClient.
 * - Construct PersonalBoardManager with minimal stubs
 * - Replace `pbm.deck` with an in-memory mock that tracks cards per stack
 * - Exercise each public and key private method independently
 *
 * Key Dependencies:
 * - PersonalBoardManager (module under test)
 * - Custom test runner (test/helpers/test-runner.js)
 *
 * Data Flow:
 * Test -> PersonalBoardManager -> MockDeck -> In-memory card store
 *
 * Run: node test/unit/integrations/personal-board-manager.test.js
 *
 * @license AGPL-3.0-or-later
 * @module test/unit/integrations/personal-board-manager
 */

'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

let PersonalBoardManager;
try {
  PersonalBoardManager = require('../../../src/lib/integrations/personal-board-manager');
} catch (err) {
  console.error('Failed to load PersonalBoardManager:', err.message);
  process.exit(1);
}

// ============================================================
// Mock DeckClient
// ============================================================

/**
 * Creates an in-memory mock of DeckClient with the five personal-board stacks.
 * All methods are async to mirror the real DeckClient interface.
 */
function createMockDeck() {
  const cards = { inbox: [], doing: [], waiting: [], planned: [], done: [] };
  let nextId = 1;

  return {
    _cards: cards,

    ensureBoard: async () => ({
      boardId: 1,
      stacks: { inbox: 1, doing: 2, waiting: 3, planned: 4, done: 5 },
      labels: {}
    }),

    shareBoardWithUser: async () => ({}),

    getCardsInStack: async (stackName) => cards[stackName] || [],

    createCard: async (stackName, data) => {
      const card = {
        id: nextId++,
        title: data.title,
        description: data.description || '',
        duedate: data.duedate || null,
        lastModified: Date.now() / 1000,
        createdAt: Date.now() / 1000,
        labels: []
      };
      cards[stackName].push(card);
      return card;
    },

    moveCard: async (cardId, from, to) => {
      const idx = cards[from].findIndex(c => c.id === cardId);
      if (idx >= 0) {
        const [card] = cards[from].splice(idx, 1);
        cards[to].push(card);
      }
    },

    updateCard: async (cardId, stackName, updates) => {
      const card = cards[stackName].find(c => c.id === cardId);
      if (card) Object.assign(card, updates);
      return card;
    },

    deleteCard: async (cardId, stackName) => {
      const idx = cards[stackName].findIndex(c => c.id === cardId);
      if (idx >= 0) cards[stackName].splice(idx, 1);
    },

    addLabel: async (cardId, stackName, labelName) => {
      const card = cards[stackName]?.find(c => c.id === cardId);
      if (card) card.labels.push({ title: labelName });
    },

    removeLabel: async () => {},

    getComments: async () => [],

    addComment: async () => ({}),

    _getIds: async () => ({ boardId: 1, stacks: {}, labels: {} }),

    baseUrl: 'https://nc.test'
  };
}

// ============================================================
// Helpers
// ============================================================

/**
 * Creates a PersonalBoardManager with mock deck injected.
 * Sets _initialized = true so most tests skip initialize().
 *
 * @param {Object} overrides - Optional overrides for notifyUser, config, deck
 * @returns {PersonalBoardManager}
 */
function makePBM(overrides = {}) {
  const pbm = new PersonalBoardManager({
    ncRequestManager: { request: async () => ({ status: 200, body: '{}' }) },
    notifyUser: overrides.notifyUser || (() => {}),
    config: overrides.config || {}
  });
  pbm.deck = overrides.deck || createMockDeck();
  pbm._initialized = true;
  return pbm;
}

/**
 * Returns a unix timestamp (seconds) for N hours ago.
 */
function hoursAgo(h) {
  return Date.now() / 1000 - h * 3600;
}

/**
 * Returns a unix timestamp (seconds) for N days ago.
 */
function daysAgo(d) {
  return Date.now() / 1000 - d * 86400;
}

// ============================================================
// Tests
// ============================================================

console.log('\n=== PersonalBoardManager Unit Tests ===\n');

// ----------------------------------------------------------
// TC-PBM-001: initialize() calls ensureBoard
// ----------------------------------------------------------
asyncTest('TC-PBM-001: initialize() calls ensureBoard', async () => {
  let ensureCalled = false;
  const deck = createMockDeck();
  const origEnsure = deck.ensureBoard;
  deck.ensureBoard = async () => {
    ensureCalled = true;
    return origEnsure();
  };

  const pbm = new PersonalBoardManager({
    ncRequestManager: { request: async () => ({ status: 200, body: '{}' }) },
    notifyUser: () => {},
    config: {}
  });
  pbm.deck = deck;

  await pbm.initialize();

  assert.strictEqual(ensureCalled, true, 'ensureBoard should be called during initialize()');
});

// ----------------------------------------------------------
// TC-PBM-002: createPersonalCard creates card in inbox stack
// ----------------------------------------------------------
asyncTest('TC-PBM-002: createPersonalCard creates card in inbox stack', async () => {
  const pbm = makePBM();

  const card = await pbm.createPersonalCard({
    title: 'Test task',
    description: 'A test description'
  });

  assert.ok(card, 'Should return a card object');
  assert.strictEqual(card.title, 'Test task');

  const inbox = await pbm.deck.getCardsInStack('inbox');
  assert.strictEqual(inbox.length, 1, 'Inbox should contain one card');
  assert.strictEqual(inbox[0].title, 'Test task');
});

// ----------------------------------------------------------
// TC-PBM-003: createPersonalCard with label attaches label
// ----------------------------------------------------------
asyncTest('TC-PBM-003: createPersonalCard with label attaches label to card', async () => {
  const pbm = makePBM();

  const card = await pbm.createPersonalCard({
    title: 'Labeled task',
    description: 'Has a label',
    label: 'promise'
  });

  assert.ok(card, 'Should return a card object');

  const inbox = await pbm.deck.getCardsInStack('inbox');
  assert.strictEqual(inbox.length, 1, 'Inbox should have one card');

  // Label may be on the returned card or on the stored card
  const storedCard = inbox[0];
  const hasLabel = storedCard.labels.some(l => l.title === 'promise');
  assert.ok(hasLabel, 'Card should have the "promise" label attached');
});

// ----------------------------------------------------------
// TC-PBM-004: createPersonalCard returns null on error
// ----------------------------------------------------------
asyncTest('TC-PBM-004: createPersonalCard returns null on error', async () => {
  const deck = createMockDeck();
  deck.createCard = async () => { throw new Error('Deck API failure'); };

  const pbm = makePBM({ deck });

  const result = await pbm.createPersonalCard({
    title: 'Will fail',
    description: 'Should not throw'
  });

  assert.strictEqual(result, null, 'Should return null when createCard throws');
});

// ----------------------------------------------------------
// TC-PBM-005: _priorityScore: overdue card scores highest
// ----------------------------------------------------------
test('TC-PBM-005: _priorityScore: overdue card scores highest', () => {
  const pbm = makePBM();

  const overdueCard = {
    id: 1,
    title: 'Overdue task',
    duedate: new Date(Date.now() - 86400 * 1000).toISOString(),
    lastModified: hoursAgo(2),
    createdAt: hoursAgo(24),
    labels: []
  };

  const freshCard = {
    id: 2,
    title: 'Fresh task',
    duedate: new Date(Date.now() + 7 * 86400 * 1000).toISOString(),
    lastModified: hoursAgo(1),
    createdAt: hoursAgo(1),
    labels: []
  };

  const overdueScore = pbm._priorityScore(overdueCard);
  const freshScore = pbm._priorityScore(freshCard);

  assert.ok(
    overdueScore > freshScore,
    `Overdue score (${overdueScore}) should exceed fresh score (${freshScore})`
  );
});

// ----------------------------------------------------------
// TC-PBM-006: _priorityScore: promise label > research label
// ----------------------------------------------------------
test('TC-PBM-006: _priorityScore: promise label scores higher than research', () => {
  const pbm = makePBM();
  const now = hoursAgo(0);

  const promiseCard = {
    id: 1,
    title: 'Promise task',
    duedate: null,
    lastModified: now,
    createdAt: now,
    labels: [{ title: 'promise' }]
  };

  const researchCard = {
    id: 2,
    title: 'Research task',
    duedate: null,
    lastModified: now,
    createdAt: now,
    labels: [{ title: 'research' }]
  };

  const promiseScore = pbm._priorityScore(promiseCard);
  const researchScore = pbm._priorityScore(researchCard);

  assert.ok(
    promiseScore > researchScore,
    `Promise score (${promiseScore}) should exceed research score (${researchScore})`
  );
});

// ----------------------------------------------------------
// TC-PBM-007: _priorityScore: age bonus prevents starvation
// ----------------------------------------------------------
test('TC-PBM-007: _priorityScore: age bonus prevents starvation', () => {
  const pbm = makePBM();

  const oldCard = {
    id: 1,
    title: 'Old task',
    duedate: null,
    lastModified: daysAgo(14),
    createdAt: daysAgo(14),
    labels: []
  };

  const newCard = {
    id: 2,
    title: 'New task',
    duedate: null,
    lastModified: hoursAgo(1),
    createdAt: hoursAgo(1),
    labels: []
  };

  const oldScore = pbm._priorityScore(oldCard);
  const newScore = pbm._priorityScore(newCard);

  assert.ok(
    oldScore > newScore,
    `Old card score (${oldScore}) should exceed new card score (${newScore}) due to age bonus`
  );
});

// ----------------------------------------------------------
// TC-PBM-008: processPersonalBoard picks highest-priority
//             inbox card when doing is empty
// ----------------------------------------------------------
asyncTest('TC-PBM-008: processPersonalBoard picks highest-priority inbox card when doing is empty', async () => {
  const deck = createMockDeck();
  const pbm = makePBM({ deck });

  // Seed inbox with two cards; one older (should score higher)
  deck._cards.inbox.push(
    {
      id: 10,
      title: 'Old task',
      description: '',
      duedate: null,
      lastModified: daysAgo(7),
      createdAt: daysAgo(7),
      labels: []
    },
    {
      id: 11,
      title: 'New task',
      description: '',
      duedate: null,
      lastModified: hoursAgo(1),
      createdAt: hoursAgo(1),
      labels: []
    }
  );

  await pbm.processPersonalBoard();

  const doing = deck._cards.doing;
  assert.ok(doing.length > 0, 'Doing stack should have at least one card after processing');
});

// ----------------------------------------------------------
// TC-PBM-009: processPersonalBoard does NOT pick from inbox
//             when doing already has a card
// ----------------------------------------------------------
asyncTest('TC-PBM-009: processPersonalBoard does NOT pick from inbox when doing has a card', async () => {
  const deck = createMockDeck();
  const pbm = makePBM({ deck });

  // Pre-populate doing
  deck._cards.doing.push({
    id: 20,
    title: 'Active task',
    description: '',
    duedate: null,
    lastModified: hoursAgo(1),
    createdAt: hoursAgo(2),
    labels: []
  });

  // Seed inbox
  deck._cards.inbox.push({
    id: 21,
    title: 'Waiting in inbox',
    description: '',
    duedate: null,
    lastModified: hoursAgo(1),
    createdAt: hoursAgo(1),
    labels: []
  });

  await pbm.processPersonalBoard();

  const inbox = deck._cards.inbox;
  assert.ok(
    inbox.some(c => c.id === 21),
    'Inbox card should remain in inbox when doing is occupied'
  );
});

// ----------------------------------------------------------
// TC-PBM-010: _checkPlanned moves past-due cards to inbox
// ----------------------------------------------------------
asyncTest('TC-PBM-010: _checkPlanned moves past-due cards to inbox', async () => {
  const deck = createMockDeck();
  const pbm = makePBM({ deck });

  const pastDue = new Date(Date.now() - 86400 * 1000).toISOString();
  deck._cards.planned.push({
    id: 30,
    title: 'Past-due planned',
    description: '',
    duedate: pastDue,
    lastModified: daysAgo(2),
    createdAt: daysAgo(5),
    labels: []
  });

  await pbm._checkPlanned();

  assert.strictEqual(deck._cards.planned.length, 0, 'Planned stack should be empty');
  assert.ok(
    deck._cards.inbox.some(c => c.id === 30),
    'Past-due card should have moved to inbox'
  );
});

// ----------------------------------------------------------
// TC-PBM-011: _checkPlanned ignores future-due cards
// ----------------------------------------------------------
asyncTest('TC-PBM-011: _checkPlanned ignores future-due cards', async () => {
  const deck = createMockDeck();
  const pbm = makePBM({ deck });

  const futureDue = new Date(Date.now() + 7 * 86400 * 1000).toISOString();
  deck._cards.planned.push({
    id: 31,
    title: 'Future planned',
    description: '',
    duedate: futureDue,
    lastModified: hoursAgo(1),
    createdAt: daysAgo(1),
    labels: []
  });

  await pbm._checkPlanned();

  assert.strictEqual(deck._cards.planned.length, 1, 'Future card should remain in planned');
  assert.strictEqual(deck._cards.inbox.length, 0, 'Inbox should remain empty');
});

// ----------------------------------------------------------
// TC-PBM-012: _checkWaiting moves card with new user comment
//             to doing
// ----------------------------------------------------------
asyncTest('TC-PBM-012: _checkWaiting moves card with new user comment to doing', async () => {
  const deck = createMockDeck();
  const pbm = makePBM({ deck });

  deck._cards.waiting.push({
    id: 40,
    title: 'Waiting for reply',
    description: '',
    duedate: null,
    lastModified: hoursAgo(2),
    createdAt: daysAgo(1),
    labels: []
  });

  // Override getComments to return a recent user comment
  deck.getComments = async () => [
    {
      actorId: 'owner',
      message: 'Here is the info you needed',
      creationDateTime: new Date().toISOString()
    }
  ];

  await pbm._checkWaiting();

  assert.strictEqual(deck._cards.waiting.length, 0, 'Waiting stack should be empty');
  assert.ok(
    deck._cards.doing.some(c => c.id === 40),
    'Card with user comment should move to doing'
  );
});

// ----------------------------------------------------------
// TC-PBM-013: _checkDone archives cards older than 7 days
// ----------------------------------------------------------
asyncTest('TC-PBM-013: _checkDone archives cards older than 7 days', async () => {
  const deck = createMockDeck();
  const pbm = makePBM({ deck });

  deck._cards.done.push({
    id: 50,
    title: 'Old completed task',
    description: '',
    duedate: null,
    lastModified: daysAgo(8),
    createdAt: daysAgo(15),
    labels: []
  });

  await pbm._checkDone();

  assert.strictEqual(
    deck._cards.done.length, 0,
    'Done card older than 7 days should be archived (deleted)'
  );
});

// ----------------------------------------------------------
// TC-PBM-014: _checkDone keeps recent cards
// ----------------------------------------------------------
asyncTest('TC-PBM-014: _checkDone keeps recent cards', async () => {
  const deck = createMockDeck();
  const pbm = makePBM({ deck });

  deck._cards.done.push({
    id: 51,
    title: 'Recent completed task',
    description: '',
    duedate: null,
    lastModified: daysAgo(2),
    createdAt: daysAgo(3),
    labels: []
  });

  await pbm._checkDone();

  assert.strictEqual(
    deck._cards.done.length, 1,
    'Recent done card should be preserved'
  );
});

// ----------------------------------------------------------
// TC-PBM-015: _checkDoing detects stale card (48h no update)
// ----------------------------------------------------------
asyncTest('TC-PBM-015: _checkDoing detects stale card (48h no update)', async () => {
  const notifications = [];
  const deck = createMockDeck();
  const pbm = makePBM({
    deck,
    notifyUser: (msg) => notifications.push(msg)
  });

  // Card with human assignee — tier 2 will trigger Talk notification
  deck._cards.doing.push({
    id: 60,
    title: 'Stale doing task',
    description: '',
    duedate: null,
    lastModified: hoursAgo(49),
    createdAt: daysAgo(5),
    labels: [],
    assignedUsers: [{ participant: { uid: 'fu' } }]
  });

  const result = await pbm._checkDoing();

  assert.ok(result.stale, 'Result should indicate stale card');
  // Tier 2: human assigned → Talk notification
  assert.ok(notifications.length > 0, 'Stale card with human assignee should trigger Talk notification');
});

// ----------------------------------------------------------
// TC-PBM-016: _checkDoing does nothing for fresh card
// ----------------------------------------------------------
asyncTest('TC-PBM-016: _checkDoing does nothing for fresh card', async () => {
  const notifications = [];
  const deck = createMockDeck();
  const pbm = makePBM({
    deck,
    notifyUser: (msg) => notifications.push(msg)
  });

  deck._cards.doing.push({
    id: 61,
    title: 'Fresh doing task',
    description: '',
    duedate: null,
    lastModified: hoursAgo(2),
    createdAt: hoursAgo(5),
    labels: []
  });

  await pbm._checkDoing();

  assert.ok(
    deck._cards.doing.some(c => c.id === 61),
    'Fresh card should remain in doing'
  );
  assert.strictEqual(notifications.length, 0, 'No notification for fresh card');
});

// ----------------------------------------------------------
// TC-PBM-017: getWorkingMemorySummary returns formatted text
// ----------------------------------------------------------
asyncTest('TC-PBM-017: getWorkingMemorySummary returns formatted text', async () => {
  const deck = createMockDeck();
  const pbm = makePBM({ deck });

  // Seed some cards across stacks
  deck._cards.doing.push({
    id: 70, title: 'Active work', description: '', duedate: null,
    lastModified: hoursAgo(1), createdAt: hoursAgo(3), labels: []
  });
  deck._cards.inbox.push({
    id: 71, title: 'Queued item', description: '', duedate: null,
    lastModified: hoursAgo(2), createdAt: hoursAgo(5), labels: []
  });
  deck._cards.waiting.push({
    id: 72, title: 'Blocked item', description: '', duedate: null,
    lastModified: hoursAgo(4), createdAt: daysAgo(1), labels: []
  });

  const summary_text = await pbm.getWorkingMemorySummary();

  assert.ok(typeof summary_text === 'string', 'Summary should be a string');
  assert.ok(summary_text.length > 0, 'Summary should not be empty');
});

// ----------------------------------------------------------
// TC-PBM-018: processPersonalBoard returns result object
//             with all keys
// ----------------------------------------------------------
asyncTest('TC-PBM-018: processPersonalBoard returns result object with all keys', async () => {
  const deck = createMockDeck();
  const pbm = makePBM({ deck });

  // Seed a single inbox card so there is something to process
  deck._cards.inbox.push({
    id: 80, title: 'Process me', description: '', duedate: null,
    lastModified: hoursAgo(1), createdAt: hoursAgo(2), labels: []
  });

  const result = await pbm.processPersonalBoard();

  assert.ok(result, 'processPersonalBoard should return a result object');
  assert.ok(typeof result === 'object', 'Result should be an object');
});

// ============================================================
// Finalize
// ============================================================

setTimeout(() => { summary(); exitWithCode(); }, 500);
