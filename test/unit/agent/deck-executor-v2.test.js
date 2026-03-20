/*
 * MoltAgent - Sovereign AI Security Layer
 * Copyright (C) 2026 MoltAgent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

'use strict';

const assert = require('assert');
const { asyncTest, test, summary, exitWithCode } = require('../../helpers/test-runner');
const DeckExecutor = require('../../../src/lib/agent/executors/deck-executor');
const DECK = require('../../../src/config/deck-names');

const silentLogger = { log() {}, info() {}, warn() {}, error() {} };

function getResponse(result) {
  return typeof result === 'object' && result !== null && result.response ? result.response : result;
}

function createMockRouter(extractResult) {
  return {
    route: async (req) => {
      // If extractResult is a function, call it with the request for dynamic behavior
      if (typeof extractResult === 'function') return extractResult(req);
      return extractResult || { result: '{}' };
    }
  };
}

function createMockToolRegistry(responses = {}) {
  const calls = [];
  return {
    execute: async (name, args) => {
      calls.push({ name, args });
      if (responses[name]) {
        return typeof responses[name] === 'function' ? responses[name](args) : responses[name];
      }
      return { success: true, result: 'OK' };
    },
    getCalls: () => calls,
    getCallsFor: (name) => calls.filter(c => c.name === name)
  };
}

function createMockDeckClient(overrides = {}) {
  const calls = [];
  const track = (method, result) => (...args) => {
    calls.push({ method, args });
    if (overrides[method]) {
      return typeof overrides[method] === 'function'
        ? overrides[method](...args)
        : Promise.resolve(overrides[method]);
    }
    return Promise.resolve(result);
  };

  return {
    calls,
    getCalls: (method) => calls.filter(c => c.method === method),
    listBoards: track('listBoards', [
      { id: 1, title: DECK.boards.tasks, archived: false },
      { id: 2, title: 'Content Pipeline', archived: false },
      { id: 3, title: 'Old Board', archived: true }
    ]),
    getBoard: track('getBoard', { id: 1, title: DECK.boards.tasks }),
    createNewBoard: track('createNewBoard', { id: 10, title: 'New Board' }),
    updateBoard: track('updateBoard', { id: 1, title: 'Updated Board' }),
    deleteBoard: track('deleteBoard', undefined),
    archiveBoard: track('archiveBoard', { id: 1, archived: true }),
    getStacks: track('getStacks', [
      { id: 100, title: 'Inbox', cards: [{ id: 1 }, { id: 2 }] },
      { id: 101, title: 'Working', cards: [{ id: 3 }] },
      { id: 102, title: 'Done', cards: [] }
    ]),
    createStack: track('createStack', { id: 200, title: 'New Stack' }),
    updateStack: track('updateStack', { id: 100, title: 'Renamed Stack' }),
    deleteStack: track('deleteStack', undefined),
    createCardOnBoard: track('createCardOnBoard', { id: 500, title: 'New Card' }),
    shareBoardWithUser: track('shareBoardWithUser', { id: 61, boardId: 1 })
  };
}

// ============================================================
// Deliverable B: Board-level operations
// ============================================================

asyncTest('create_board creates board via DeckClient', async () => {
  const dc = createMockDeckClient({
    createNewBoard: (title, color) => Promise.resolve({ id: 10, title })
  });
  const executor = new DeckExecutor({
    router: createMockRouter({ result: JSON.stringify({ action: 'create_board', board_name: 'Content Pipeline' }) }),
    toolRegistry: createMockToolRegistry(),
    deckClient: dc,
    logger: silentLogger
  });

  const result = await executor.execute('Create a board called Content Pipeline', { userName: 'alice' });
  const resp = getResponse(result);
  assert.ok(resp.includes('Content Pipeline'), `Should confirm board name, got: ${resp}`);
  assert.ok(resp.includes('Created board'), `Should confirm creation, got: ${resp}`);
  assert.strictEqual(dc.getCalls('createNewBoard').length, 1);
  assert.strictEqual(dc.getCalls('createNewBoard')[0].args[0], 'Content Pipeline');
  assert.strictEqual(result.actionRecord.type, 'deck_create_board');
});

asyncTest('list_boards returns formatted list', async () => {
  const dc = createMockDeckClient();
  const executor = new DeckExecutor({
    router: createMockRouter({ result: JSON.stringify({ action: 'list_boards' }) }),
    toolRegistry: createMockToolRegistry(),
    deckClient: dc,
    logger: silentLogger
  });

  const result = await executor.execute('List my boards', { userName: 'alice' });
  const resp = getResponse(result);
  assert.ok(resp.includes(DECK.boards.tasks), `Should list boards, got: ${resp}`);
  assert.ok(resp.includes('Content Pipeline'), `Should list active boards, got: ${resp}`);
  assert.ok(!resp.includes('Old Board'), `Should NOT list archived boards, got: ${resp}`);
});

asyncTest('list_boards with no boards suggests creation', async () => {
  const dc = createMockDeckClient({ listBoards: () => Promise.resolve([]) });
  const executor = new DeckExecutor({
    router: createMockRouter({ result: JSON.stringify({ action: 'list_boards' }) }),
    toolRegistry: createMockToolRegistry(),
    deckClient: dc,
    logger: silentLogger
  });

  const result = await executor.execute('Show my boards', { userName: 'alice' });
  const resp = getResponse(result);
  assert.ok(resp.includes("don't have any boards"), `Should suggest creation, got: ${resp}`);
});

asyncTest('create_stack resolves board and creates stack', async () => {
  const dc = createMockDeckClient({
    createStack: (boardId, title) => Promise.resolve({ id: 200, title })
  });
  const executor = new DeckExecutor({
    router: createMockRouter({ result: JSON.stringify({ action: 'create_stack', stack_name: 'Drafting', board_name: 'Content Pipeline' }) }),
    toolRegistry: createMockToolRegistry(),
    deckClient: dc,
    logger: silentLogger
  });

  const result = await executor.execute('Add a column called Drafting to Content Pipeline', { userName: 'alice' });
  const resp = getResponse(result);
  assert.ok(resp.includes('Drafting'), `Should confirm stack name, got: ${resp}`);
  assert.ok(resp.includes('Content Pipeline'), `Should mention board, got: ${resp}`);
  // Board resolved to id 2 (Content Pipeline)
  assert.strictEqual(dc.getCalls('createStack')[0].args[0], 2);
});

asyncTest('rename_board resolves and renames', async () => {
  const dc = createMockDeckClient({
    updateBoard: (id, updates) => Promise.resolve({ id, title: updates.title })
  });
  const executor = new DeckExecutor({
    router: createMockRouter({ result: JSON.stringify({ action: 'rename_board', board_name: 'Content Pipeline', new_title: 'Blog Pipeline' }) }),
    toolRegistry: createMockToolRegistry(),
    deckClient: dc,
    logger: silentLogger
  });

  const result = await executor.execute('Rename Content Pipeline board to Blog Pipeline', { userName: 'alice' });
  const resp = getResponse(result);
  assert.ok(resp.includes('Renamed'), `Should confirm rename, got: ${resp}`);
  assert.ok(resp.includes('Blog Pipeline'), `Should include new name, got: ${resp}`);
});

asyncTest('delete_board reports stack and card counts', async () => {
  const dc = createMockDeckClient();
  const executor = new DeckExecutor({
    router: createMockRouter({ result: JSON.stringify({ action: 'delete_board', board_name: 'Content Pipeline' }) }),
    toolRegistry: createMockToolRegistry(),
    deckClient: dc,
    logger: silentLogger
  });

  const result = await executor.execute('Delete the Content Pipeline board', { userName: 'alice' });
  const resp = getResponse(result);
  assert.ok(resp.includes('Deleted board'), `Should confirm deletion, got: ${resp}`);
  assert.ok(resp.includes('3 stacks'), `Should report stack count, got: ${resp}`);
  assert.ok(resp.includes('3 cards'), `Should report card count, got: ${resp}`);
  assert.strictEqual(dc.getCalls('deleteBoard').length, 1);
});

asyncTest('archive_board soft-deletes board', async () => {
  const dc = createMockDeckClient();
  const executor = new DeckExecutor({
    router: createMockRouter({ result: JSON.stringify({ action: 'archive_board', board_name: 'Content Pipeline' }) }),
    toolRegistry: createMockToolRegistry(),
    deckClient: dc,
    logger: silentLogger
  });

  const result = await executor.execute('Archive the Content Pipeline board', { userName: 'alice' });
  const resp = getResponse(result);
  assert.ok(resp.includes('Archived'), `Should confirm archive, got: ${resp}`);
  assert.ok(resp.includes('restored'), `Should mention recovery, got: ${resp}`);
  assert.strictEqual(dc.getCalls('archiveBoard').length, 1);
});

// ============================================================
// Board/Stack Resolution
// ============================================================

asyncTest('Board resolution: exact match', async () => {
  const dc = createMockDeckClient();
  const executor = new DeckExecutor({
    router: createMockRouter({ result: JSON.stringify({ action: 'archive_board', board_name: DECK.boards.tasks }) }),
    toolRegistry: createMockToolRegistry(),
    deckClient: dc,
    logger: silentLogger
  });

  const result = await executor.execute('Archive MoltAgent Tasks', { userName: 'alice' });
  const resp = getResponse(result);
  assert.ok(resp.includes('Archived'), `Exact match should work, got: ${resp}`);
});

asyncTest('Board resolution: fuzzy match (substring)', async () => {
  const dc = createMockDeckClient();
  const executor = new DeckExecutor({
    router: createMockRouter({ result: JSON.stringify({ action: 'archive_board', board_name: 'Content' }) }),
    toolRegistry: createMockToolRegistry(),
    deckClient: dc,
    logger: silentLogger
  });

  const result = await executor.execute('Archive Content board', { userName: 'alice' });
  const resp = getResponse(result);
  // "Content" should fuzzy-match "Content Pipeline"
  assert.ok(resp.includes('Archived'), `Fuzzy match should work, got: ${resp}`);
  assert.ok(resp.includes('Content Pipeline'), `Should resolve full name, got: ${resp}`);
});

asyncTest('Board resolution: unknown name returns helpful message', async () => {
  const dc = createMockDeckClient();
  const executor = new DeckExecutor({
    router: createMockRouter({ result: JSON.stringify({ action: 'archive_board', board_name: 'Nonexistent Board' }) }),
    toolRegistry: createMockToolRegistry(),
    deckClient: dc,
    logger: silentLogger
  });

  const result = await executor.execute('Archive Nonexistent Board', { userName: 'alice' });
  const resp = getResponse(result);
  assert.ok(resp.includes('Could not find'), `Should report not found, got: ${resp}`);
  assert.ok(resp.includes('Nonexistent Board'), `Should include searched name, got: ${resp}`);
});

asyncTest('Stack resolution on board', async () => {
  const dc = createMockDeckClient();
  const executor = new DeckExecutor({
    router: createMockRouter({ result: JSON.stringify({ action: 'delete_stack', stack_name: 'Inbox', board_name: DECK.boards.tasks }) }),
    toolRegistry: createMockToolRegistry(),
    deckClient: dc,
    logger: silentLogger
  });

  const result = await executor.execute('Delete the Inbox stack on MoltAgent Tasks', { userName: 'alice' });
  const resp = getResponse(result);
  assert.ok(resp.includes('Deleted stack'), `Should confirm deletion, got: ${resp}`);
  assert.ok(resp.includes('Inbox'), `Should include stack name, got: ${resp}`);
  assert.strictEqual(dc.getCalls('deleteStack')[0].args[1], 100, 'Should resolve stack ID 100');
});

asyncTest('"board" in message never classified as create_card', async () => {
  // Simulate: extraction correctly returns create_board (not create)
  const dc = createMockDeckClient();
  const registry = createMockToolRegistry();
  const executor = new DeckExecutor({
    router: createMockRouter({ result: JSON.stringify({ action: 'create_board', board_name: 'Test Board' }) }),
    toolRegistry: registry,
    deckClient: dc,
    logger: silentLogger
  });

  const result = await executor.execute('Create a board called Test Board', { userName: 'alice' });
  assert.strictEqual(registry.getCallsFor('deck_create_card').length, 0, 'Should NOT call deck_create_card');
  assert.strictEqual(dc.getCalls('createNewBoard').length, 1, 'Should call createNewBoard');
});

asyncTest('No deckClient returns "not available" for board ops', async () => {
  const executor = new DeckExecutor({
    router: createMockRouter({ result: JSON.stringify({ action: 'create_board', board_name: 'X' }) }),
    toolRegistry: createMockToolRegistry(),
    // no deckClient
    logger: silentLogger
  });

  const result = await executor.execute('Create a board called X', { userName: 'alice' });
  const resp = getResponse(result);
  assert.ok(resp.includes('not available'), `Should report unavailable, got: ${resp}`);
});

// ============================================================
// Deliverable D: Delegation Intelligence
// ============================================================

asyncTest('Delegation: create_board with delegation generates name', async () => {
  let routeCalls = 0;
  const dc = createMockDeckClient({
    createNewBoard: (title, color) => Promise.resolve({ id: 10, title })
  });
  const executor = new DeckExecutor({
    router: createMockRouter((req) => {
      routeCalls++;
      // First call: extraction prompt
      if (routeCalls === 1) {
        return { result: JSON.stringify({ action: 'create_board', board_name: '', delegated: true }) };
      }
      // Second call: board name generation
      return { result: 'Content Pipeline' };
    }),
    toolRegistry: createMockToolRegistry(),
    deckClient: dc,
    logger: silentLogger
  });

  const result = await executor.execute('Create a board for content, you decide the name', { userName: 'alice' });
  const resp = getResponse(result);
  assert.ok(resp.includes('Created board'), `Should create board, got: ${resp}`);
  assert.ok(resp.includes('Content Pipeline'), `Should use generated name, got: ${resp}`);
});

asyncTest('Delegation: create card with delegation generates title', async () => {
  let routeCalls = 0;
  const executor = new DeckExecutor({
    router: createMockRouter((req) => {
      routeCalls++;
      if (routeCalls === 1) {
        return { result: JSON.stringify({ action: 'create', card_title: '', delegated: true }) };
      }
      return { result: 'Write Architecture Blog Post' };
    }),
    toolRegistry: createMockToolRegistry({
      deck_create_card: { success: true, result: 'Created "Write Architecture Blog Post" in Inbox.', card: { id: 50, boardId: 1, stackId: 1 } }
    }),
    logger: silentLogger
  });

  const result = await executor.execute('Create a task about the architecture, you decide', { userName: 'alice' });
  const resp = getResponse(result);
  assert.ok(resp.includes('Write Architecture Blog Post'), `Should use generated title, got: ${resp}`);
});

asyncTest('No delegation: missing board_name asks for clarification', async () => {
  const dc = createMockDeckClient();
  const executor = new DeckExecutor({
    router: createMockRouter({ result: JSON.stringify({ action: 'create_board', board_name: '', delegated: false }) }),
    toolRegistry: createMockToolRegistry(),
    deckClient: dc,
    logger: silentLogger
  });

  const result = await executor.execute('Create a board', { userName: 'alice' });
  const resp = getResponse(result);
  assert.ok(resp.includes('called'), `Should ask for name, got: ${resp}`);
  assert.strictEqual(dc.getCalls('createNewBoard').length, 0, 'Should NOT create board');
});

test('_generateDefaultValue returns defaults for deck fields', () => {
  const executor = new DeckExecutor({
    router: createMockRouter(),
    toolRegistry: createMockToolRegistry(),
    logger: silentLogger
  });

  assert.ok(executor._generateDefaultValue('board_name', {}, 'test'), 'Should return board_name default');
  assert.strictEqual(executor._generateDefaultValue('card_title', {}, 'test'), 'New Task');
  assert.strictEqual(executor._generateDefaultValue('stack_name', {}, 'test'), 'Inbox');
  assert.strictEqual(executor._generateDefaultValue('unknown_field', {}, 'test'), null);
});

asyncTest('_generateDefaultBoardName calls LLM router', async () => {
  const executor = new DeckExecutor({
    router: createMockRouter({ result: 'Moltagent Launch Board' }),
    toolRegistry: createMockToolRegistry(),
    logger: silentLogger
  });

  const name = await executor._generateDefaultBoardName('set up something for the launch', '');
  assert.strictEqual(name, 'Moltagent Launch Board');
});

// ============================================================
// Deliverable C: Compound Operations — setup_workflow
// ============================================================

asyncTest('setup_workflow generates plan and executes it', async () => {
  let routeCalls = 0;
  const plan = {
    board_name: 'Content Pipeline',
    stacks: [
      { title: 'Ideation', cards: [{ title: 'Intro Post', description: 'Write intro' }] },
      { title: 'Drafting', cards: [] },
      { title: 'Published', cards: [] }
    ]
  };

  const dc = createMockDeckClient({
    createNewBoard: (title) => Promise.resolve({ id: 10, title }),
    createStack: (boardId, title, order) => Promise.resolve({ id: 200 + order, title }),
    createCardOnBoard: (boardId, stackId, title, opts) => Promise.resolve({ id: 500, title })
  });

  const executor = new DeckExecutor({
    router: createMockRouter((req) => {
      routeCalls++;
      if (routeCalls === 1) {
        return { result: JSON.stringify({ action: 'setup_workflow', purpose: 'content publishing' }) };
      }
      // Plan generation call
      return { result: JSON.stringify(plan) };
    }),
    toolRegistry: createMockToolRegistry(),
    deckClient: dc,
    logger: silentLogger
  });

  const result = await executor.execute('Set up a content pipeline board', { userName: 'alice' });
  const resp = getResponse(result);

  assert.ok(resp.includes('Content Pipeline'), `Should include board name, got: ${resp}`);
  assert.ok(resp.includes('3 stages'), `Should report stage count, got: ${resp}`);
  assert.ok(resp.includes('Ideation'), `Should include stack names, got: ${resp}`);
  assert.ok(resp.includes('Intro Post'), `Should include card names, got: ${resp}`);
  assert.ok(resp.includes('ready'), `Should indicate completion, got: ${resp}`);
  assert.strictEqual(result.actionRecord.type, 'deck_setup_workflow');
  assert.strictEqual(result.actionRecord.refs.stackCount, 3);
  assert.strictEqual(result.actionRecord.refs.cardCount, 1);
});

asyncTest('setup_workflow: stack order matches plan', async () => {
  let routeCalls = 0;
  const stackOrders = [];
  const plan = {
    board_name: 'Test Board',
    stacks: [
      { title: 'First', cards: [] },
      { title: 'Second', cards: [] },
      { title: 'Third', cards: [] }
    ]
  };

  const dc = createMockDeckClient({
    createNewBoard: (title) => Promise.resolve({ id: 10, title }),
    createStack: (boardId, title, order) => {
      stackOrders.push({ title, order });
      return Promise.resolve({ id: 200 + order, title });
    }
  });

  const executor = new DeckExecutor({
    router: createMockRouter((req) => {
      routeCalls++;
      if (routeCalls === 1) return { result: JSON.stringify({ action: 'setup_workflow', purpose: 'test' }) };
      return { result: JSON.stringify(plan) };
    }),
    toolRegistry: createMockToolRegistry(),
    deckClient: dc,
    logger: silentLogger
  });

  await executor.execute('Set up a test workflow', { userName: 'alice' });
  assert.strictEqual(stackOrders[0].order, 0, 'First stack order should be 0');
  assert.strictEqual(stackOrders[1].order, 1, 'Second stack order should be 1');
  assert.strictEqual(stackOrders[2].order, 2, 'Third stack order should be 2');
});

asyncTest('setup_workflow: card failure does not abort plan', async () => {
  let routeCalls = 0;
  let cardAttempts = 0;
  const plan = {
    board_name: 'Resilient Board',
    stacks: [
      { title: 'Inbox', cards: [
        { title: 'Good Card', description: 'Works' },
        { title: 'Bad Card', description: 'Fails' }
      ] }
    ]
  };

  const dc = createMockDeckClient({
    createNewBoard: (title) => Promise.resolve({ id: 10, title }),
    createStack: (boardId, title, order) => Promise.resolve({ id: 200, title }),
    createCardOnBoard: (boardId, stackId, title) => {
      cardAttempts++;
      if (title === 'Bad Card') throw new Error('API error');
      return Promise.resolve({ id: 500, title });
    }
  });

  const executor = new DeckExecutor({
    router: createMockRouter((req) => {
      routeCalls++;
      if (routeCalls === 1) return { result: JSON.stringify({ action: 'setup_workflow', purpose: 'test' }) };
      return { result: JSON.stringify(plan) };
    }),
    toolRegistry: createMockToolRegistry(),
    deckClient: dc,
    logger: silentLogger
  });

  const result = await executor.execute('Set up a resilient board', { userName: 'alice' });
  const resp = getResponse(result);
  assert.strictEqual(cardAttempts, 2, 'Should attempt both cards');
  assert.ok(resp.includes('1 starter cards'), `Should count only successful cards, got: ${resp}`);
  assert.ok(resp.includes('Good Card'), `Should list successful card, got: ${resp}`);
});

asyncTest('setup_workflow: board creation failure returns error', async () => {
  let routeCalls = 0;
  const plan = {
    board_name: 'Doomed Board',
    stacks: [{ title: 'Inbox', cards: [] }]
  };

  const dc = createMockDeckClient({
    createNewBoard: () => { throw new Error('Permission denied'); }
  });

  const executor = new DeckExecutor({
    router: createMockRouter((req) => {
      routeCalls++;
      if (routeCalls === 1) return { result: JSON.stringify({ action: 'setup_workflow', purpose: 'test' }) };
      return { result: JSON.stringify(plan) };
    }),
    toolRegistry: createMockToolRegistry(),
    deckClient: dc,
    logger: silentLogger
  });

  try {
    await executor.execute('Set up a doomed board', { userName: 'alice' });
    assert.fail('Should throw on board creation failure');
  } catch (err) {
    assert.ok(err.message.includes('Permission denied'), `Should propagate error, got: ${err.message}`);
  }
});

asyncTest('setup_workflow: invalid plan returns helpful message', async () => {
  let routeCalls = 0;
  const executor = new DeckExecutor({
    router: createMockRouter((req) => {
      routeCalls++;
      if (routeCalls === 1) return { result: JSON.stringify({ action: 'setup_workflow', purpose: 'test' }) };
      return { result: 'not valid json at all' };
    }),
    toolRegistry: createMockToolRegistry(),
    deckClient: createMockDeckClient(),
    logger: silentLogger
  });

  const result = await executor.execute('Set up something weird', { userName: 'alice' });
  const resp = getResponse(result);
  assert.ok(resp.includes('Could not generate'), `Should report plan failure, got: ${resp}`);
});

asyncTest('setup_workflow: enricher context passed to plan generation', async () => {
  let planPrompt = '';
  let routeCalls = 0;
  const plan = {
    board_name: 'Test Board',
    stacks: [{ title: 'Inbox', cards: [] }]
  };

  const dc = createMockDeckClient({
    createNewBoard: (title) => Promise.resolve({ id: 10, title }),
    createStack: (boardId, title) => Promise.resolve({ id: 200, title })
  });

  const executor = new DeckExecutor({
    router: createMockRouter((req) => {
      routeCalls++;
      if (routeCalls === 1) return { result: JSON.stringify({ action: 'setup_workflow', purpose: 'content' }) };
      // Capture the plan generation prompt
      planPrompt = req.content;
      return { result: JSON.stringify(plan) };
    }),
    toolRegistry: createMockToolRegistry(),
    deckClient: dc,
    logger: silentLogger
  });

  await executor.execute('Set up content pipeline', {
    userName: 'alice',
    warmMemory: '<agent_knowledge>Moltagent runs on three VMs</agent_knowledge>'
  });

  assert.ok(planPrompt.includes('three VMs'), `Enricher context should be in plan prompt, got: ${planPrompt.substring(0, 200)}`);
});

asyncTest('setup_workflow: response includes stack flow summary', async () => {
  let routeCalls = 0;
  const plan = {
    board_name: 'Flow Board',
    stacks: [
      { title: 'Draft', cards: [] },
      { title: 'Review', cards: [] },
      { title: 'Published', cards: [] }
    ]
  };

  const dc = createMockDeckClient({
    createNewBoard: (title) => Promise.resolve({ id: 10, title }),
    createStack: (boardId, title, order) => Promise.resolve({ id: 200 + order, title })
  });

  const executor = new DeckExecutor({
    router: createMockRouter((req) => {
      routeCalls++;
      if (routeCalls === 1) return { result: JSON.stringify({ action: 'setup_workflow', purpose: 'flow' }) };
      return { result: JSON.stringify(plan) };
    }),
    toolRegistry: createMockToolRegistry(),
    deckClient: dc,
    logger: silentLogger
  });

  const result = await executor.execute('Set up a flow board', { userName: 'alice' });
  const resp = getResponse(result);
  // Should show: Draft → Review → Published
  assert.ok(resp.includes('Draft → Review → Published'), `Should show flow, got: ${resp}`);
});

// ============================================================
// Rename/delete stack operations
// ============================================================

asyncTest('rename_stack resolves board and stack', async () => {
  const dc = createMockDeckClient({
    updateStack: (boardId, stackId, updates) => Promise.resolve({ id: stackId, title: updates.title })
  });
  const executor = new DeckExecutor({
    router: createMockRouter({ result: JSON.stringify({ action: 'rename_stack', stack_name: 'Inbox', board_name: DECK.boards.tasks, new_title: 'Triage' }) }),
    toolRegistry: createMockToolRegistry(),
    deckClient: dc,
    logger: silentLogger
  });

  const result = await executor.execute('Rename Inbox to Triage on MoltAgent Tasks', { userName: 'alice' });
  const resp = getResponse(result);
  assert.ok(resp.includes('Renamed'), `Should confirm rename, got: ${resp}`);
  assert.ok(resp.includes('Triage'), `Should include new name, got: ${resp}`);
});

asyncTest('delete_stack includes card count', async () => {
  const dc = createMockDeckClient();
  const executor = new DeckExecutor({
    router: createMockRouter({ result: JSON.stringify({ action: 'delete_stack', stack_name: 'Inbox', board_name: DECK.boards.tasks }) }),
    toolRegistry: createMockToolRegistry(),
    deckClient: dc,
    logger: silentLogger
  });

  const result = await executor.execute('Delete the Inbox stack on MoltAgent Tasks', { userName: 'alice' });
  const resp = getResponse(result);
  assert.ok(resp.includes('2 cards'), `Should report card count, got: ${resp}`);
});

// ============================================================
// Troubleshoot action
// ============================================================

asyncTest('troubleshoot: specific board found and shared', async () => {
  const dc = createMockDeckClient({
    shareBoardWithUser: (boardId, user) => Promise.resolve({ id: 61, boardId, participant: user })
  });
  const executor = new DeckExecutor({
    router: createMockRouter({ result: JSON.stringify({ action: 'troubleshoot', board_name: 'Content Pipeline' }) }),
    toolRegistry: createMockToolRegistry(),
    deckClient: dc,
    logger: silentLogger
  });

  const result = await executor.execute("I can't see the Content Pipeline board", { userName: 'Funana' });
  const resp = getResponse(result);
  assert.ok(resp.includes('shared it with you'), `Should confirm sharing, got: ${resp}`);
  assert.ok(resp.includes('Content Pipeline'), `Should mention board name, got: ${resp}`);
  assert.strictEqual(dc.getCalls('shareBoardWithUser').length, 1);
});

asyncTest('troubleshoot: board already shared returns refresh advice', async () => {
  const dc = createMockDeckClient({
    shareBoardWithUser: () => { throw new Error('HTTP 400: already shared'); }
  });
  const executor = new DeckExecutor({
    router: createMockRouter({ result: JSON.stringify({ action: 'troubleshoot', board_name: 'Content Pipeline' }) }),
    toolRegistry: createMockToolRegistry(),
    deckClient: dc,
    logger: silentLogger
  });

  const result = await executor.execute("I can't find the Content Pipeline board", { userName: 'Funana' });
  const resp = getResponse(result);
  assert.ok(resp.includes('already shared'), `Should say already shared, got: ${resp}`);
  assert.ok(resp.includes('refresh'), `Should suggest refresh, got: ${resp}`);
});

asyncTest('troubleshoot: unknown board returns suggestions', async () => {
  const dc = createMockDeckClient();
  const executor = new DeckExecutor({
    router: createMockRouter({ result: JSON.stringify({ action: 'troubleshoot', board_name: 'Ghost Board' }) }),
    toolRegistry: createMockToolRegistry(),
    deckClient: dc,
    logger: silentLogger
  });

  const result = await executor.execute("I can't access Ghost Board", { userName: 'Funana' });
  const resp = getResponse(result);
  assert.ok(resp.includes("couldn't find"), `Should report not found, got: ${resp}`);
  assert.ok(resp.includes(DECK.boards.tasks), `Should list available boards, got: ${resp}`);
});

asyncTest('troubleshoot: no board mentioned shares all and lists', async () => {
  let shareCount = 0;
  const dc = createMockDeckClient({
    shareBoardWithUser: () => { shareCount++; return Promise.resolve({}); }
  });
  const executor = new DeckExecutor({
    router: createMockRouter({ result: JSON.stringify({ action: 'troubleshoot', board_name: '' }) }),
    toolRegistry: createMockToolRegistry(),
    deckClient: dc,
    logger: silentLogger
  });

  const result = await executor.execute("I can't see my boards", { userName: 'Funana' });
  const resp = getResponse(result);
  assert.ok(resp.includes(DECK.boards.tasks), `Should list boards, got: ${resp}`);
  assert.ok(resp.includes('Content Pipeline'), `Should list all active boards, got: ${resp}`);
  assert.ok(shareCount >= 2, `Should share multiple boards, shared: ${shareCount}`);
  assert.ok(resp.includes('sharing'), `Should mention sharing update, got: ${resp}`);
});

asyncTest('troubleshoot: "I cant see the board" is NOT classified as create_card', async () => {
  const dc = createMockDeckClient();
  const registry = createMockToolRegistry();
  const executor = new DeckExecutor({
    router: createMockRouter({ result: JSON.stringify({ action: 'troubleshoot', board_name: 'Content Pipeline' }) }),
    toolRegistry: registry,
    deckClient: dc,
    logger: silentLogger
  });

  await executor.execute("I can't see the board", { userName: 'Funana' });
  assert.strictEqual(registry.getCallsFor('deck_create_card').length, 0, 'Should NOT call deck_create_card');
  assert.strictEqual(registry.getCallsFor('deck_list_cards').length, 0, 'Should NOT call deck_list_cards');
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
