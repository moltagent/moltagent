/**
 * AGPL-3.0 License - Moltagent
 *
 * ensureMeetingsBoard Unit Tests
 *
 * Run: node test/unit/ensure-meetings-board.test.js
 *
 * @module test/unit/ensure-meetings-board
 */

'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../helpers/test-runner');

const ensureMeetingsBoard = require('../../src/lib/calendar/ensure-meetings-board');
const boardRegistry = require('../../src/lib/integrations/deck-board-registry');
const { ROLES } = require('../../src/lib/integrations/deck-board-registry');

// ============================================================
// Test Fixtures
// ============================================================

const EXPECTED_STACKS = ['Planning', 'Invited', 'Needs Attention', 'Confirmed', 'Done'];

function createMockDeck(overrides = {}) {
  return {
    listBoards: overrides.listBoards || (async () => []),
    createNewBoard: overrides.createNewBoard || (async (title) => ({ id: 99, title })),
    createStack: overrides.createStack || (async (boardId, title, order) => ({ id: 100 + order, title })),
    createCardOnBoard: overrides.createCardOnBoard || (async () => ({ id: 200 }))
  };
}

// ============================================================
// Tests
// ============================================================

console.log('\n=== ensureMeetingsBoard Tests ===\n');

asyncTest('creates board when none exists — calls createNewBoard, createStack x5, createCardOnBoard', async () => {
  boardRegistry._reset();
  const createNewBoardCalls = [];
  const createStackCalls = [];
  const createCardCalls = [];

  const deck = createMockDeck({
    listBoards: async () => [],
    createNewBoard: async (title, color) => {
      createNewBoardCalls.push({ title, color });
      return { id: 99, title };
    },
    createStack: async (boardId, title, order) => {
      createStackCalls.push({ boardId, title, order });
      return { id: 100 + order, title };
    },
    createCardOnBoard: async (boardId, stackId, cardTitle, opts) => {
      createCardCalls.push({ boardId, stackId, cardTitle, opts });
      return { id: 200 };
    }
  });

  const result = await ensureMeetingsBoard(deck);

  assert.strictEqual(createNewBoardCalls.length, 1, 'createNewBoard called once');
  assert.strictEqual(createStackCalls.length, 5, 'createStack called 5 times');
  assert.strictEqual(createCardCalls.length, 1, 'createCardOnBoard called once for rules card');
  assert.strictEqual(result.boardId, 99);
  assert.strictEqual(result.existed, false);
});

asyncTest('skips creation when board is registered — returns { existed: true }', async () => {
  boardRegistry._reset();
  // The registry is canonical: a registered role resolves without any title scan.
  boardRegistry.registerBoard(ROLES.meetings, 42);
  let createNewBoardCalled = false;

  const deck = createMockDeck({
    createNewBoard: async () => {
      createNewBoardCalled = true;
      return { id: 99, title: 'Pending Meetings' };
    }
  });

  const result = await ensureMeetingsBoard(deck);

  assert.strictEqual(createNewBoardCalled, false, 'createNewBoard must not be called');
  assert.strictEqual(result.existed, true);
  assert.strictEqual(result.boardId, 42);
});

asyncTest('resolves a registered board regardless of its live title (#49 canonical)', async () => {
  boardRegistry._reset();
  boardRegistry.registerBoard(ROLES.meetings, 77);
  let createNewBoardCalled = false;

  // The live board carries a divergent/emoji-prefixed title that the old
  // exact-title scan would miss (#99).  Resolution comes from the registry, so
  // the live title is never consulted and creation is skipped.
  const deck = createMockDeck({
    listBoards: async () => [{ id: 77, title: '⭐ pending meetings' }],
    createNewBoard: async () => {
      createNewBoardCalled = true;
      return { id: 99, title: 'Pending Meetings' };
    }
  });

  const result = await ensureMeetingsBoard(deck);

  assert.strictEqual(createNewBoardCalled, false, 'registered board must not be re-created');
  assert.strictEqual(result.existed, true);
  assert.strictEqual(result.boardId, 77);
});

asyncTest('returns boardId from a registered board', async () => {
  boardRegistry._reset();
  boardRegistry.registerBoard(ROLES.meetings, 55);
  const deck = createMockDeck();

  const result = await ensureMeetingsBoard(deck);

  assert.strictEqual(result.boardId, 55);
  assert.strictEqual(result.existed, true);
});

asyncTest('stacks created in correct order: Planning, Invited, Needs Attention, Confirmed, Done', async () => {
  boardRegistry._reset();
  const createStackCalls = [];

  const deck = createMockDeck({
    listBoards: async () => [],
    createStack: async (boardId, title, order) => {
      createStackCalls.push({ boardId, title, order });
      return { id: 100 + order, title };
    }
  });

  await ensureMeetingsBoard(deck);

  assert.strictEqual(createStackCalls.length, EXPECTED_STACKS.length);
  for (let i = 0; i < EXPECTED_STACKS.length; i++) {
    assert.strictEqual(createStackCalls[i].title, EXPECTED_STACKS[i],
      `Stack at index ${i} should be "${EXPECTED_STACKS[i]}"`);
    assert.strictEqual(createStackCalls[i].order, i,
      `Stack "${EXPECTED_STACKS[i]}" should have order ${i}`);
    assert.strictEqual(createStackCalls[i].boardId, 99,
      'Each stack uses the new board id');
  }
});

asyncTest('workflow rules card has correct content', async () => {
  boardRegistry._reset();
  const createCardCalls = [];

  const deck = createMockDeck({
    listBoards: async () => [],
    createCardOnBoard: async (boardId, stackId, cardTitle, opts) => {
      createCardCalls.push({ boardId, stackId, cardTitle, opts });
      return { id: 200 };
    }
  });

  await ensureMeetingsBoard(deck);

  assert.strictEqual(createCardCalls.length, 1);
  const card = createCardCalls[0];

  assert.ok(card.cardTitle.includes('WORKFLOW RULES'), 'card title mentions WORKFLOW RULES');
  assert.ok(card.opts && typeof card.opts.description === 'string', 'card has a description');
  assert.ok(card.opts.description.includes('Planning'), 'description mentions Planning stack');
  assert.ok(card.opts.description.includes('Confirmed'), 'description mentions Confirmed stack');
  assert.ok(card.opts.description.includes('RSVP'), 'description mentions RSVP');
  // Card must be placed on the first stack (Planning, id = 100 + 0 = 100)
  assert.strictEqual(card.stackId, 100, 'rules card goes into Planning stack (order 0)');
  assert.strictEqual(card.boardId, 99, 'rules card goes onto the new board');
});

asyncTest('propagates errors thrown by DeckClient', async () => {
  boardRegistry._reset();
  // Unregistered role → create path; the deck's create call is the failure point.
  const deck = createMockDeck({
    createNewBoard: async () => { throw new Error('network failure'); }
  });

  let caught = null;
  try {
    await ensureMeetingsBoard(deck);
  } catch (err) {
    caught = err;
  }

  assert.ok(caught, 'error must be re-thrown');
  assert.ok(caught.message.includes('network failure'));
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
