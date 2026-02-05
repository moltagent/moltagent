/*
 * MoltAgent - Sovereign AI Security Layer
 * Copyright (C) 2026 MoltAgent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * KnowledgeBoard Unit Tests
 *
 * Architecture Brief:
 * -------------------
 * Problem: Verify that KnowledgeBoard correctly initializes a Deck board,
 * creates verification/dispute cards, checks for duplicates, and reports status.
 *
 * Pattern: Mock DeckClient with the ACTUAL method signatures discovered in
 * deck-client.js. Key methods:
 *   - ensureBoard() -> { boardId, stacks: {stackName: stackId}, labels }
 *   - getCardsInStack(stackName) -> [card, ...]
 *   - createCard(stackName, {title, description, duedate}) -> card
 *
 * Run: node test/unit/knowledge/knowledge-board.test.js
 *
 * @module test/unit/knowledge/knowledge-board
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

// Import module under test
const { KnowledgeBoard } = require('../../../src/lib/knowledge/knowledge-board');

// ============================================================
// Test Helpers
// ============================================================

/**
 * Create a mock DeckClient matching the real DeckClient interface.
 * @param {Object} [overrides={}] - Override specific method behaviors
 * @returns {Object} Mock DeckClient
 */
function createMockDeckClient(overrides = {}) {
  const calls = {};

  function track(name, args) {
    if (!calls[name]) calls[name] = [];
    calls[name].push(args);
  }

  const mock = {
    // ensureBoard() is the key method - creates board + stacks if missing
    ensureBoard: async () => {
      track('ensureBoard', []);
      if (overrides.ensureBoard) return overrides.ensureBoard();
      return {
        boardId: 42,
        stacks: {
          verified: 101,
          uncertain: 102,
          stale: 103,
          disputed: 104
        },
        labels: {}
      };
    },

    // getCardsInStack(stackName) -> array of card objects
    getCardsInStack: async (stackName) => {
      track('getCardsInStack', [stackName]);
      if (overrides.getCardsInStack) return overrides.getCardsInStack(stackName);
      return [];
    },

    // createCard(stackName, cardData) -> card object
    createCard: async (stackName, cardData) => {
      track('createCard', [stackName, cardData]);
      if (overrides.createCard) return overrides.createCard(stackName, cardData);
      return { id: 1000, title: cardData.title, description: cardData.description };
    },

    // getCard(cardId, stackName) -> card object
    getCard: async (cardId, stackName) => {
      track('getCard', [cardId, stackName]);
      if (overrides.getCard) return overrides.getCard(cardId, stackName);
      return { id: cardId, title: 'Test Card', stackId: 101 };
    },

    // moveCard(cardId, fromStack, toStack, order)
    moveCard: async (cardId, fromStack, toStack, order) => {
      track('moveCard', [cardId, fromStack, toStack, order]);
    },

    // addComment(cardId, message, type)
    addComment: async (cardId, message, type) => {
      track('addComment', [cardId, message, type]);
    },

    // For test inspection
    _getCalls: () => calls,
    _getCallsFor: (name) => calls[name] || []
  };

  return mock;
}

// ============================================================
// Tests: Constructor
// ============================================================

console.log('');
console.log('=== KnowledgeBoard Tests ===');
console.log('');

test('constructor sets defaults', () => {
  const mockDeck = createMockDeckClient();
  const board = new KnowledgeBoard({ deckClient: mockDeck });

  assert.strictEqual(board.initialized, false);
  assert.strictEqual(board.config.verificationDueDays, 7);
  assert.strictEqual(board.config.disputeDueDays, 3);
});

test('constructor accepts custom config', () => {
  const mockDeck = createMockDeckClient();
  const board = new KnowledgeBoard({
    deckClient: mockDeck,
    config: { verificationDueDays: 14, disputeDueDays: 5 }
  });

  assert.strictEqual(board.config.verificationDueDays, 14);
  assert.strictEqual(board.config.disputeDueDays, 5);
});

// ============================================================
// Tests: initialize()
// ============================================================

asyncTest('initialize calls ensureBoard on DeckClient', async () => {
  const mockDeck = createMockDeckClient();
  const board = new KnowledgeBoard({ deckClient: mockDeck });

  await board.initialize();

  const calls = mockDeck._getCallsFor('ensureBoard');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(board.initialized, true);
});

asyncTest('initialize is idempotent (only runs once)', async () => {
  const mockDeck = createMockDeckClient();
  const board = new KnowledgeBoard({ deckClient: mockDeck });

  await board.initialize();
  await board.initialize();
  await board.initialize();

  const calls = mockDeck._getCallsFor('ensureBoard');
  assert.strictEqual(calls.length, 1);
});

asyncTest('initialize propagates errors', async () => {
  const mockDeck = createMockDeckClient({
    ensureBoard: async () => { throw new Error('Network error'); }
  });
  const board = new KnowledgeBoard({ deckClient: mockDeck });

  let caught = false;
  try {
    await board.initialize();
  } catch (error) {
    caught = true;
    assert.strictEqual(error.message, 'Network error');
  }
  assert.ok(caught, 'Should have thrown an error');
  assert.strictEqual(board.initialized, false);
});

// ============================================================
// Tests: createVerificationCard()
// ============================================================

asyncTest('createVerificationCard creates card in uncertain stack', async () => {
  const mockDeck = createMockDeckClient();
  const board = new KnowledgeBoard({ deckClient: mockDeck });

  const card = await board.createVerificationCard({
    title: 'Q3 Budget',
    description: 'Is the budget 50k or 60k?',
    source: '@finance'
  });

  // Should have called ensureBoard (via initialize)
  assert.strictEqual(mockDeck._getCallsFor('ensureBoard').length, 1);

  // Should have checked for duplicates
  const getCardsCalls = mockDeck._getCallsFor('getCardsInStack');
  assert.ok(getCardsCalls.some(c => c[0] === 'uncertain'));

  // Should have created the card
  const createCalls = mockDeck._getCallsFor('createCard');
  assert.strictEqual(createCalls.length, 1);
  assert.strictEqual(createCalls[0][0], 'uncertain');
  assert.strictEqual(createCalls[0][1].title, 'Verify: Q3 Budget');
  assert.ok(createCalls[0][1].description.includes('Q3 Budget'));
  assert.ok(createCalls[0][1].description.includes('@finance'));
  assert.ok(createCalls[0][1].duedate); // Should have a due date

  assert.strictEqual(card.id, 1000);
});

asyncTest('createVerificationCard skips duplicate cards', async () => {
  const mockDeck = createMockDeckClient({
    getCardsInStack: async (stackName) => {
      if (stackName === 'uncertain') {
        return [{ id: 500, title: 'Verify: Q3 Budget' }];
      }
      return [];
    }
  });
  const board = new KnowledgeBoard({ deckClient: mockDeck });

  const result = await board.createVerificationCard({
    title: 'Q3 Budget',
    description: 'Duplicate test'
  });

  // Should NOT have called createCard
  assert.strictEqual(mockDeck._getCallsFor('createCard').length, 0);

  // Should return the existing card
  assert.strictEqual(result.id, 500);
});

asyncTest('createVerificationCard detects duplicates by raw title too', async () => {
  const mockDeck = createMockDeckClient({
    getCardsInStack: async (stackName) => {
      if (stackName === 'uncertain') {
        return [{ id: 600, title: 'Q3 Budget' }];
      }
      return [];
    }
  });
  const board = new KnowledgeBoard({ deckClient: mockDeck });

  const result = await board.createVerificationCard({
    title: 'Q3 Budget',
    description: 'Another duplicate test'
  });

  assert.strictEqual(mockDeck._getCallsFor('createCard').length, 0);
  assert.strictEqual(result.id, 600);
});

asyncTest('createVerificationCard proceeds if duplicate check fails', async () => {
  const mockDeck = createMockDeckClient({
    getCardsInStack: async (stackName) => {
      if (stackName === 'uncertain') {
        throw new Error('Stack read failed');
      }
      return [];
    }
  });
  const board = new KnowledgeBoard({ deckClient: mockDeck });

  const card = await board.createVerificationCard({
    title: 'Resilient Card',
    description: 'Should still create'
  });

  // Should still create the card
  assert.strictEqual(mockDeck._getCallsFor('createCard').length, 1);
  assert.strictEqual(card.id, 1000);
});

asyncTest('createVerificationCard includes formatted description', async () => {
  const mockDeck = createMockDeckClient();
  const board = new KnowledgeBoard({ deckClient: mockDeck });

  await board.createVerificationCard({
    title: 'Meeting Schedule',
    description: 'Weekly on Tuesdays or Wednesdays?',
    source: '@calendar'
  });

  const createCalls = mockDeck._getCallsFor('createCard');
  const description = createCalls[0][1].description;

  assert.ok(description.includes('## Verification Needed'));
  assert.ok(description.includes('Meeting Schedule'));
  assert.ok(description.includes('@calendar'));
  assert.ok(description.includes('Weekly on Tuesdays or Wednesdays?'));
  assert.ok(description.includes('Please Confirm'));
});

// ============================================================
// Tests: createDisputeCard()
// ============================================================

asyncTest('createDisputeCard creates card in disputed stack', async () => {
  const mockDeck = createMockDeckClient();
  const board = new KnowledgeBoard({ deckClient: mockDeck });

  const card = await board.createDisputeCard({
    title: 'Budget Amount',
    sourceA: '@finance',
    claimA: 'Budget is 50k',
    sourceB: '@marketing',
    claimB: 'Budget is 60k'
  });

  const createCalls = mockDeck._getCallsFor('createCard');
  assert.strictEqual(createCalls.length, 1);
  assert.strictEqual(createCalls[0][0], 'disputed');
  assert.strictEqual(createCalls[0][1].title, 'Dispute: Budget Amount');

  const desc = createCalls[0][1].description;
  assert.ok(desc.includes('Contradiction Detected'));
  assert.ok(desc.includes('@finance'));
  assert.ok(desc.includes('Budget is 50k'));
  assert.ok(desc.includes('@marketing'));
  assert.ok(desc.includes('Budget is 60k'));
});

// ============================================================
// Tests: getPendingVerifications()
// ============================================================

asyncTest('getPendingVerifications returns cards from uncertain and stale', async () => {
  const mockDeck = createMockDeckClient({
    getCardsInStack: async (stackName) => {
      if (stackName === 'uncertain') {
        return [
          { id: 1, title: 'Verify: Item A' },
          { id: 2, title: 'Verify: Item B' }
        ];
      }
      if (stackName === 'stale') {
        return [
          { id: 3, title: 'Verify: Item C' }
        ];
      }
      return [];
    }
  });
  const board = new KnowledgeBoard({ deckClient: mockDeck });

  const pending = await board.getPendingVerifications();

  assert.strictEqual(pending.length, 3);
  assert.strictEqual(pending[0].status, 'uncertain');
  assert.strictEqual(pending[1].status, 'uncertain');
  assert.strictEqual(pending[2].status, 'stale');
});

asyncTest('getPendingVerifications handles stack read errors gracefully', async () => {
  const mockDeck = createMockDeckClient({
    getCardsInStack: async (stackName) => {
      if (stackName === 'uncertain') {
        throw new Error('Stack error');
      }
      if (stackName === 'stale') {
        return [{ id: 1, title: 'Item' }];
      }
      return [];
    }
  });
  const board = new KnowledgeBoard({ deckClient: mockDeck });

  const pending = await board.getPendingVerifications();

  // Should still return stale cards even though uncertain failed
  assert.strictEqual(pending.length, 1);
  assert.strictEqual(pending[0].status, 'stale');
});

asyncTest('getPendingVerifications returns empty array when both stacks empty', async () => {
  const mockDeck = createMockDeckClient();
  const board = new KnowledgeBoard({ deckClient: mockDeck });

  const pending = await board.getPendingVerifications();

  assert.deepStrictEqual(pending, []);
});

// ============================================================
// Tests: getVerifiedCards()
// ============================================================

asyncTest('getVerifiedCards returns cards from verified stack', async () => {
  const mockDeck = createMockDeckClient({
    getCardsInStack: async (stackName) => {
      if (stackName === 'verified') {
        return [
          { id: 10, title: 'Verified: Budget confirmed' },
          { id: 11, title: 'Verified: Team structure correct' }
        ];
      }
      return [];
    }
  });
  const board = new KnowledgeBoard({ deckClient: mockDeck });

  const verified = await board.getVerifiedCards();

  assert.strictEqual(verified.length, 2);
});

asyncTest('getVerifiedCards returns empty array on error', async () => {
  const mockDeck = createMockDeckClient({
    getCardsInStack: async () => { throw new Error('Read error'); }
  });
  const board = new KnowledgeBoard({ deckClient: mockDeck });

  const verified = await board.getVerifiedCards();

  assert.deepStrictEqual(verified, []);
});

// ============================================================
// Tests: getStatus()
// ============================================================

asyncTest('getStatus returns card counts per stack', async () => {
  const mockDeck = createMockDeckClient({
    getCardsInStack: async (stackName) => {
      const counts = { verified: 5, uncertain: 3, stale: 2, disputed: 1 };
      return Array(counts[stackName] || 0).fill({ id: 1, title: 'card' });
    }
  });
  const board = new KnowledgeBoard({ deckClient: mockDeck });

  const status = await board.getStatus();

  assert.strictEqual(status.stacks.verified, 5);
  assert.strictEqual(status.stacks.uncertain, 3);
  assert.strictEqual(status.stacks.stale, 2);
  assert.strictEqual(status.stacks.disputed, 1);
});

asyncTest('getStatus marks failed stacks with -1', async () => {
  let callCount = 0;
  const mockDeck = createMockDeckClient({
    getCardsInStack: async (stackName) => {
      callCount++;
      if (stackName === 'stale') throw new Error('Read error');
      return [{ id: 1, title: 'card' }];
    }
  });
  const board = new KnowledgeBoard({ deckClient: mockDeck });

  const status = await board.getStatus();

  assert.strictEqual(status.stacks.verified, 1);
  assert.strictEqual(status.stacks.uncertain, 1);
  assert.strictEqual(status.stacks.stale, -1);
  assert.strictEqual(status.stacks.disputed, 1);
});

// ============================================================
// Tests: _addDays() and _formatVerificationDescription()
// ============================================================

test('_addDays returns correct ISO date string', () => {
  const mockDeck = createMockDeckClient();
  const board = new KnowledgeBoard({ deckClient: mockDeck });

  const baseDate = new Date('2026-02-06T12:00:00Z');
  const result = board._addDays(baseDate, 7);

  assert.strictEqual(result, '2026-02-13');
});

test('_formatVerificationDescription includes all fields', () => {
  const mockDeck = createMockDeckClient();
  const board = new KnowledgeBoard({ deckClient: mockDeck });

  const desc = board._formatVerificationDescription({
    title: 'Test Item',
    description: 'Some details here',
    source: '@testuser'
  });

  assert.ok(desc.includes('## Verification Needed'));
  assert.ok(desc.includes('Test Item'));
  assert.ok(desc.includes('@testuser'));
  assert.ok(desc.includes('Some details here'));
  assert.ok(desc.includes('Please Confirm'));
  assert.ok(desc.includes('auto-generated by MoltAgent'));
});

test('_formatVerificationDescription handles missing source', () => {
  const mockDeck = createMockDeckClient();
  const board = new KnowledgeBoard({ deckClient: mockDeck });

  const desc = board._formatVerificationDescription({
    title: 'No Source',
    description: 'Details'
  });

  assert.ok(desc.includes('Unknown'));
});

// ============================================================
// Summary
// ============================================================

setTimeout(() => {
  summary();
  exitWithCode();
}, 500);
