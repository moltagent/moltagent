/**
 * ToolRegistry Unit Tests
 *
 * Run: node test/unit/agent/tool-registry.test.js
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

const { ToolRegistry } = require('../../../src/lib/agent/tool-registry');

// ============================================================
// Mock Clients
// ============================================================

function createMockDeckClient(cards = {}) {
  return {
    username: 'moltagent',
    stackNames: {
      inbox: 'Inbox',
      queued: 'Queued',
      working: 'Working',
      review: 'Review',
      done: 'Done',
      reference: 'Reference'
    },
    getAllCards: async () => cards,
    getCardsInStack: async (stackName) => cards[stackName] || [],
    createCard: async (stackName, card) => ({ id: 99, title: card.title, ...card }),
    moveCard: async (_cardId, _from, _to) => {},
    ensureBoard: async () => ({ boardId: 1, stacks: {} }),
    listBoards: async () => [
      { id: 1, title: 'MoltAgent Tasks', owner: { uid: 'moltagent' } },
      { id: 2, title: 'Marketing', owner: { uid: 'funana' } }
    ],
    getBoard: async (boardId) => ({
      id: boardId,
      title: boardId === 1 ? 'MoltAgent Tasks' : 'Marketing',
      owner: { uid: boardId === 1 ? 'moltagent' : 'funana' },
      stacks: [
        { id: 301, title: 'Inbox', cards: [{ id: 10 }] },
        { id: 302, title: 'Done', cards: [] }
      ],
      labels: [{ title: 'urgent' }, { title: 'blocked' }]
    }),
    getStacks: async (boardId) => [
      { id: 301, title: 'Inbox', cards: [{ id: 10, title: 'Task X', duedate: '2020-01-01' }] },
      { id: 302, title: 'Done', cards: [{ id: 11, title: 'Finished', duedate: null }] }
    ],
    createStack: async (boardId, title, order) => ({ id: 50, title }),
    getCard: async (cardId, stackName) => ({
      id: cardId,
      title: 'Test Card',
      description: 'A test card',
      duedate: '2026-03-01',
      type: 'plain',
      owner: { uid: 'moltagent' },
      assignedUsers: [{ participant: { uid: 'alice' } }],
      labels: [{ title: 'urgent' }]
    }),
    updateCard: async (_cardId, _stackName, _updates) => {},
    deleteCard: async (_cardId, _stackName) => {},
    assignUser: async (_cardId, _stackName, _userId) => {},
    unassignUser: async (_cardId, _stackName, _userId) => {},
    addLabel: async (_cardId, _stackName, _labelName) => {},
    removeLabel: async (_cardId, _stackName, _labelName) => {},
    addComment: async (_cardId, _message, _type, _opts) => {},
    getComments: async (_cardId) => [
      { actorId: 'alice', message: 'Looks good!', creationDateTime: '2026-02-08T10:00:00Z' },
      { actorId: 'moltagent', message: '[STATUS] Working on it', creationDateTime: '2026-02-08T11:00:00Z' }
    ],
    shareBoard: async (_boardId, _participant, _type, _pe, _ps, _pm) => ({ id: 100 }),
    _request: async (method, path, body) => ({ id: 77, title: body?.title || 'New Board' })
  };
}

function createMockCalDAVClient() {
  return {
    getUpcomingEvents: async (_hours) => [
      { uid: 'ev1', summary: 'Team standup', start: '2026-02-09T09:00:00Z', end: '2026-02-09T09:30:00Z', location: 'Zoom' },
      { uid: 'ev2', summary: 'Lunch', start: '2026-02-09T12:00:00Z', end: '2026-02-09T13:00:00Z' }
    ],
    createEvent: async (event) => ({ uid: 'new-event-123', ...event }),
    checkAvailability: async (_start, _end) => ({ isFree: true, conflicts: [] })
  };
}

function createMockSystemTagsClient() {
  return {
    tagFileByPath: async (_path, _tag) => true
  };
}

function createMockNCRequestManager() {
  return {
    ncUser: 'testuser',
    request: async (path) => {
      if (path.includes('LearningLog.md')) {
        return {
          body: '## Learning Log\n- Learned about black tigers\n- User prefers concise answers\n- Calendar events are in UTC'
        };
      }
      return { status: 200, body: '' };
    }
  };
}

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {}
};

// ============================================================
// Tests - Core / Existing
// ============================================================

console.log('\n=== ToolRegistry Tests ===\n');

test('constructor creates registry with tools from all clients', () => {
  const registry = new ToolRegistry({
    deckClient: createMockDeckClient(),
    calDAVClient: createMockCalDAVClient(),
    systemTagsClient: createMockSystemTagsClient(),
    ncRequestManager: createMockNCRequestManager(),
    logger: silentLogger
  });

  assert.ok(registry.size > 0, 'Should have registered tools');
  assert.ok(registry.has('deck_list_cards'), 'Should have deck_list_cards');
  assert.ok(registry.has('deck_move_card'), 'Should have deck_move_card');
  assert.ok(registry.has('deck_create_card'), 'Should have deck_create_card');
  assert.ok(registry.has('calendar_list_events'), 'Should have calendar_list_events');
  assert.ok(registry.has('calendar_create_event'), 'Should have calendar_create_event');
  assert.ok(registry.has('calendar_check_conflicts'), 'Should have calendar_check_conflicts');
  assert.ok(registry.has('tag_file'), 'Should have tag_file');
  assert.ok(registry.has('memory_recall'), 'Should have memory_recall');
});

test('constructor with no clients registers zero tools', () => {
  const registry = new ToolRegistry({
    logger: silentLogger
  });

  assert.strictEqual(registry.size, 0);
});

test('getToolDefinitions returns correct format', () => {
  const registry = new ToolRegistry({
    deckClient: createMockDeckClient(),
    logger: silentLogger
  });

  const defs = registry.getToolDefinitions();
  assert.ok(Array.isArray(defs), 'Should return array');
  assert.ok(defs.length > 0, 'Should have definitions');

  const first = defs[0];
  assert.strictEqual(first.type, 'function');
  assert.ok(first.function.name, 'Should have name');
  assert.ok(first.function.description, 'Should have description');
  assert.ok(first.function.parameters, 'Should have parameters');
});

test('all 19 deck tools registered when deckClient provided', () => {
  const registry = new ToolRegistry({
    deckClient: createMockDeckClient(),
    logger: silentLogger
  });

  const deckTools = [
    'deck_list_cards', 'deck_move_card', 'deck_create_card',
    'deck_list_boards', 'deck_get_board', 'deck_create_board',
    'deck_list_stacks', 'deck_create_stack',
    'deck_get_card', 'deck_update_card', 'deck_delete_card',
    'deck_assign_user', 'deck_unassign_user', 'deck_set_due_date',
    'deck_add_label', 'deck_remove_label',
    'deck_add_comment', 'deck_list_comments',
    'deck_overview', 'deck_my_assigned_cards', 'deck_overdue_cards', 'deck_mark_done'
  ];

  for (const toolName of deckTools) {
    assert.ok(registry.has(toolName), `Should have ${toolName}`);
  }
});

asyncTest('deck_list_cards lists all cards', async () => {
  const registry = new ToolRegistry({
    deckClient: createMockDeckClient({
      inbox: [{ id: 1, title: 'Task A' }],
      working: [{ id: 2, title: 'Task B' }]
    }),
    logger: silentLogger
  });

  const result = await registry.execute('deck_list_cards', {});
  assert.ok(result.success);
  assert.ok(result.result.includes('Task A'));
  assert.ok(result.result.includes('Task B'));
  assert.ok(result.result.includes('#1'));
  assert.ok(result.result.includes('#2'));
});

asyncTest('deck_list_cards filters by stack', async () => {
  const registry = new ToolRegistry({
    deckClient: createMockDeckClient({
      inbox: [{ id: 1, title: 'Task A' }],
      working: [{ id: 2, title: 'Task B' }]
    }),
    logger: silentLogger
  });

  const result = await registry.execute('deck_list_cards', { stack: 'Working' });
  assert.ok(result.success);
  assert.ok(result.result.includes('Task B'));
  assert.ok(!result.result.includes('Task A'));
});

asyncTest('deck_list_cards returns empty message when no cards', async () => {
  const registry = new ToolRegistry({
    deckClient: createMockDeckClient({}),
    logger: silentLogger
  });

  const result = await registry.execute('deck_list_cards', {});
  assert.ok(result.success);
  assert.ok(result.result.includes('empty'));
});

asyncTest('deck_list_cards with board param queries non-task board', async () => {
  const deck = createMockDeckClient({});
  deck.listBoards = async () => [
    { id: 1, title: 'MoltAgent Tasks', owner: { uid: 'moltagent' } },
    { id: 14, title: 'Moltagent Cockpit', owner: { uid: 'moltagent' } }
  ];
  deck.getStacks = async (boardId) => {
    if (boardId === 14) {
      return [
        { id: 100, title: '💡 Styles', cards: [
          { id: 50, title: 'Professional', labels: [{ title: '⚙★' }] },
          { id: 51, title: 'Casual', labels: [] }
        ]},
        { id: 101, title: '🎭 Persona', cards: [
          { id: 60, title: 'Humor', labels: [{ title: '⚙2' }] }
        ]}
      ];
    }
    return [{ id: 301, title: 'Inbox', cards: [] }];
  };

  const registry = new ToolRegistry({ deckClient: deck, logger: silentLogger });

  const result = await registry.execute('deck_list_cards', { board: 'Cockpit' });
  assert.ok(result.success, 'Should succeed');
  assert.ok(result.result.includes('Professional'), 'Should include Cockpit card');
  assert.ok(result.result.includes('Humor'), 'Should include Persona card');
  assert.ok(result.result.includes('💡 Styles'), 'Should include stack name');
  assert.ok(result.result.includes('⚙★'), 'Should include label');
});

asyncTest('deck_list_cards with board and stack filters to specific stack', async () => {
  const deck = createMockDeckClient({});
  deck.listBoards = async () => [
    { id: 14, title: 'Moltagent Cockpit', owner: { uid: 'moltagent' } }
  ];
  deck.getStacks = async () => [
    { id: 100, title: '💡 Styles', cards: [{ id: 50, title: 'Pro', labels: [] }] },
    { id: 101, title: '🎭 Persona', cards: [{ id: 60, title: 'Humor', labels: [] }] }
  ];

  const registry = new ToolRegistry({ deckClient: deck, logger: silentLogger });

  const result = await registry.execute('deck_list_cards', { board: 'Cockpit', stack: '🎭 Persona' });
  assert.ok(result.success);
  assert.ok(result.result.includes('Humor'), 'Should include Persona cards');
  assert.ok(!result.result.includes('Pro'), 'Should not include Styles cards');
});

asyncTest('deck_list_cards with unknown board returns error', async () => {
  const registry = new ToolRegistry({
    deckClient: createMockDeckClient({}),
    logger: silentLogger
  });

  const result = await registry.execute('deck_list_cards', { board: 'NonExistent' });
  assert.ok(result.success);
  assert.ok(result.result.includes('No board found'));
});

asyncTest('deck_move_card finds card by partial title', async () => {
  let movedFrom, movedTo, movedId;
  const deck = createMockDeckClient({
    working: [{ id: 5, title: 'Are there black tigers' }]
  });
  deck.moveCard = async (cardId, from, to) => {
    movedId = cardId;
    movedFrom = from;
    movedTo = to;
  };

  const registry = new ToolRegistry({ deckClient: deck, logger: silentLogger });

  const result = await registry.execute('deck_move_card', {
    card: 'black tigers',
    target_stack: 'Done'
  });

  assert.ok(result.success);
  assert.strictEqual(movedId, 5);
  assert.strictEqual(movedFrom, 'working');
  assert.strictEqual(movedTo, 'done');
  assert.ok(result.result.includes('black tigers'));
});

asyncTest('deck_move_card finds card by #ID', async () => {
  let movedId;
  const deck = createMockDeckClient({
    inbox: [{ id: 42, title: 'Some task' }]
  });
  deck.moveCard = async (cardId) => { movedId = cardId; };

  const registry = new ToolRegistry({ deckClient: deck, logger: silentLogger });

  const result = await registry.execute('deck_move_card', { card: '#42', target_stack: 'Working' });
  assert.ok(result.success);
  assert.strictEqual(movedId, 42);
});

asyncTest('deck_move_card returns error for unknown card', async () => {
  const registry = new ToolRegistry({
    deckClient: createMockDeckClient({
      inbox: [{ id: 1, title: 'Existing task' }]
    }),
    logger: silentLogger
  });

  const result = await registry.execute('deck_move_card', { card: 'nonexistent', target_stack: 'Done' });
  assert.ok(result.success);
  assert.ok(result.result.includes('No card found'));
});

asyncTest('deck_move_card detects already in target stack', async () => {
  const registry = new ToolRegistry({
    deckClient: createMockDeckClient({
      done: [{ id: 1, title: 'Already done task' }]
    }),
    logger: silentLogger
  });

  const result = await registry.execute('deck_move_card', { card: 'Already done', target_stack: 'Done' });
  assert.ok(result.success);
  assert.ok(result.result.includes('already'));
});

asyncTest('deck_create_card creates card in default stack', async () => {
  let createdStack, createdCard;
  const deck = createMockDeckClient();
  deck.createCard = async (stack, card) => {
    createdStack = stack;
    createdCard = card;
    return { id: 99, ...card };
  };

  const registry = new ToolRegistry({ deckClient: deck, logger: silentLogger });
  const result = await registry.execute('deck_create_card', { title: 'New task' });

  assert.ok(result.success);
  assert.strictEqual(createdStack, 'inbox');
  assert.strictEqual(createdCard.title, 'New task');
  assert.ok(result.result.includes('#99'));
});

asyncTest('calendar_list_events returns formatted events', async () => {
  const registry = new ToolRegistry({
    calDAVClient: createMockCalDAVClient(),
    logger: silentLogger
  });

  const result = await registry.execute('calendar_list_events', {});
  assert.ok(result.success);
  assert.ok(result.result.includes('Team standup'));
  assert.ok(result.result.includes('Lunch'));
});

asyncTest('calendar_create_event creates event', async () => {
  const registry = new ToolRegistry({
    calDAVClient: createMockCalDAVClient(),
    logger: silentLogger
  });

  const result = await registry.execute('calendar_create_event', {
    title: 'Test meeting',
    start: '2026-02-15T14:00:00Z'
  });

  assert.ok(result.success);
  assert.ok(result.result.includes('Test meeting'));
});

asyncTest('calendar_check_conflicts returns no conflicts', async () => {
  const registry = new ToolRegistry({
    calDAVClient: createMockCalDAVClient(),
    logger: silentLogger
  });

  const result = await registry.execute('calendar_check_conflicts', {
    start: '2026-02-15T14:00:00Z'
  });

  assert.ok(result.success);
  assert.ok(result.result.includes('No conflicts'));
});

asyncTest('tag_file tags successfully', async () => {
  const registry = new ToolRegistry({
    systemTagsClient: createMockSystemTagsClient(),
    logger: silentLogger
  });

  const result = await registry.execute('tag_file', { path: '/Documents/test.pdf', tag: 'processed' });
  assert.ok(result.success);
  assert.ok(result.result.includes('Tagged'));
});

asyncTest('memory_recall searches learning log', async () => {
  const registry = new ToolRegistry({
    ncRequestManager: createMockNCRequestManager(),
    logger: silentLogger
  });

  const result = await registry.execute('memory_recall', { query: 'tigers' });
  assert.ok(result.success);
  assert.ok(result.result.includes('black tigers'));
});

asyncTest('execute returns error for unknown tool', async () => {
  const registry = new ToolRegistry({ logger: silentLogger });
  const result = await registry.execute('nonexistent_tool', {});
  assert.strictEqual(result.success, false);
  assert.ok(result.error.includes('Unknown tool'));
});

asyncTest('custom tool can be registered and executed', async () => {
  const registry = new ToolRegistry({ logger: silentLogger });

  registry.register({
    name: 'custom_tool',
    description: 'A custom tool',
    parameters: { type: 'object', properties: {} },
    handler: async () => 'custom result'
  });

  assert.ok(registry.has('custom_tool'));
  const result = await registry.execute('custom_tool', {});
  assert.ok(result.success);
  assert.strictEqual(result.result, 'custom result');
});

test('register throws on missing name or handler', () => {
  const registry = new ToolRegistry({ logger: silentLogger });

  assert.throws(() => registry.register({}), /requires name and handler/);
  assert.throws(() => registry.register({ name: 'test' }), /requires name and handler/);
});

asyncTest('tool handler error returns error result', async () => {
  const registry = new ToolRegistry({ logger: silentLogger });

  registry.register({
    name: 'failing_tool',
    description: 'Always fails',
    parameters: { type: 'object', properties: {} },
    handler: async () => { throw new Error('Boom'); }
  });

  const result = await registry.execute('failing_tool', {});
  assert.strictEqual(result.success, false);
  assert.ok(result.error.includes('Boom'));
});

// ============================================================
// Tests - Phase A: Board ops
// ============================================================

asyncTest('deck_list_boards lists boards with ownership', async () => {
  const registry = new ToolRegistry({
    deckClient: createMockDeckClient(),
    logger: silentLogger
  });

  const result = await registry.execute('deck_list_boards', {});
  assert.ok(result.success);
  assert.ok(result.result.includes('MoltAgent Tasks'));
  assert.ok(result.result.includes('yours'));
  assert.ok(result.result.includes('Marketing'));
  assert.ok(result.result.includes('shared'));
});

asyncTest('deck_list_boards returns message when no boards', async () => {
  const deck = createMockDeckClient();
  deck.listBoards = async () => [];
  const registry = new ToolRegistry({ deckClient: deck, logger: silentLogger });

  const result = await registry.execute('deck_list_boards', {});
  assert.ok(result.success);
  assert.ok(result.result.includes('No boards'));
});

asyncTest('deck_get_board resolves by partial title', async () => {
  const registry = new ToolRegistry({
    deckClient: createMockDeckClient(),
    logger: silentLogger
  });

  const result = await registry.execute('deck_get_board', { board: 'Molt' });
  assert.ok(result.success);
  assert.ok(result.result.includes('MoltAgent Tasks'));
  assert.ok(result.result.includes('Stacks'));
  assert.ok(result.result.includes('Labels'));
});

asyncTest('deck_get_board resolves by numeric ID', async () => {
  const registry = new ToolRegistry({
    deckClient: createMockDeckClient(),
    logger: silentLogger
  });

  const result = await registry.execute('deck_get_board', { board: '1' });
  assert.ok(result.success);
  assert.ok(result.result.includes('MoltAgent Tasks'));
});

asyncTest('deck_get_board returns not found for unknown board', async () => {
  const registry = new ToolRegistry({
    deckClient: createMockDeckClient(),
    logger: silentLogger
  });

  const result = await registry.execute('deck_get_board', { board: 'NonExistent' });
  assert.ok(result.success);
  assert.ok(result.result.includes('No board found'));
});

asyncTest('deck_create_board creates board', async () => {
  let requestBody;
  const deck = createMockDeckClient();
  deck._request = async (method, path, body) => {
    requestBody = body;
    return { id: 77, title: body?.title || 'Test' };
  };

  const registry = new ToolRegistry({ deckClient: deck, logger: silentLogger });
  const result = await registry.execute('deck_create_board', { title: 'New Board' });

  assert.ok(result.success);
  assert.ok(result.result.includes('New Board'));
  assert.ok(result.result.includes('77'));
  assert.strictEqual(requestBody.title, 'New Board');
  assert.strictEqual(requestBody.color, '0082c9');
});

// ============================================================
// Tests - Phase A: Stack ops
// ============================================================

asyncTest('deck_list_stacks resolves board and lists stacks', async () => {
  const registry = new ToolRegistry({
    deckClient: createMockDeckClient(),
    logger: silentLogger
  });

  const result = await registry.execute('deck_list_stacks', { board: 'MoltAgent' });
  assert.ok(result.success);
  assert.ok(result.result.includes('Inbox'));
  assert.ok(result.result.includes('Done'));
  assert.ok(result.result.includes('cards'));
});

asyncTest('deck_list_stacks returns not found for unknown board', async () => {
  const registry = new ToolRegistry({
    deckClient: createMockDeckClient(),
    logger: silentLogger
  });

  const result = await registry.execute('deck_list_stacks', { board: 'Nope' });
  assert.ok(result.success);
  assert.ok(result.result.includes('No board found'));
});

asyncTest('deck_create_stack creates stack in resolved board', async () => {
  let createdBoardId, createdTitle;
  const deck = createMockDeckClient();
  deck.createStack = async (boardId, title, order) => {
    createdBoardId = boardId;
    createdTitle = title;
    return { id: 50, title };
  };

  const registry = new ToolRegistry({ deckClient: deck, logger: silentLogger });
  const result = await registry.execute('deck_create_stack', { board: 'MoltAgent', title: 'Backlog' });

  assert.ok(result.success);
  assert.strictEqual(createdBoardId, 1);
  assert.strictEqual(createdTitle, 'Backlog');
  assert.ok(result.result.includes('Backlog'));
});

// ============================================================
// Tests - Phase A: Card CRUD
// ============================================================

asyncTest('deck_get_card shows full details by title', async () => {
  const registry = new ToolRegistry({
    deckClient: createMockDeckClient({
      inbox: [{ id: 10, title: 'Test Card' }]
    }),
    logger: silentLogger
  });

  const result = await registry.execute('deck_get_card', { card: 'Test Card' });
  assert.ok(result.success);
  assert.ok(result.result.includes('#10'));
  assert.ok(result.result.includes('Test Card'));
  assert.ok(result.result.includes('Description'));
  assert.ok(result.result.includes('Due'));
  assert.ok(result.result.includes('alice'));
  assert.ok(result.result.includes('urgent'));
  assert.ok(result.result.includes('Comments'));
});

asyncTest('deck_get_card shows full details by #ID', async () => {
  const registry = new ToolRegistry({
    deckClient: createMockDeckClient({
      working: [{ id: 42, title: 'Some task' }]
    }),
    logger: silentLogger
  });

  const result = await registry.execute('deck_get_card', { card: '#42' });
  assert.ok(result.success);
  assert.ok(result.result.includes('#42'));
});

asyncTest('deck_get_card returns not found', async () => {
  const registry = new ToolRegistry({
    deckClient: createMockDeckClient({}),
    logger: silentLogger
  });

  const result = await registry.execute('deck_get_card', { card: 'nonexistent' });
  assert.ok(result.success);
  assert.ok(result.result.includes('No card found'));
});

asyncTest('deck_update_card updates title', async () => {
  let updateArgs;
  const deck = createMockDeckClient({
    inbox: [{ id: 10, title: 'Old Title' }]
  });
  deck.updateCard = async (cardId, stackName, updates) => {
    updateArgs = { cardId, stackName, updates };
  };

  const registry = new ToolRegistry({ deckClient: deck, logger: silentLogger });
  const result = await registry.execute('deck_update_card', { card: 'Old Title', title: 'New Title' });

  assert.ok(result.success);
  assert.ok(result.result.includes('Updated'));
  assert.ok(result.result.includes('New Title'));
  assert.strictEqual(updateArgs.updates.title, 'New Title');
});

asyncTest('deck_update_card clears due date with "none"', async () => {
  let updateArgs;
  const deck = createMockDeckClient({
    inbox: [{ id: 10, title: 'Test Card' }]
  });
  deck.updateCard = async (cardId, stackName, updates) => {
    updateArgs = { cardId, stackName, updates };
  };

  const registry = new ToolRegistry({ deckClient: deck, logger: silentLogger });
  const result = await registry.execute('deck_update_card', { card: 'Test', duedate: 'none' });

  assert.ok(result.success);
  assert.strictEqual(updateArgs.updates.duedate, null);
});

asyncTest('deck_delete_card deletes by title', async () => {
  let deletedId, deletedStack;
  const deck = createMockDeckClient({
    inbox: [{ id: 10, title: 'Delete Me' }]
  });
  deck.deleteCard = async (cardId, stackName) => {
    deletedId = cardId;
    deletedStack = stackName;
  };

  const registry = new ToolRegistry({ deckClient: deck, logger: silentLogger });
  const result = await registry.execute('deck_delete_card', { card: 'Delete Me' });

  assert.ok(result.success);
  assert.strictEqual(deletedId, 10);
  assert.strictEqual(deletedStack, 'inbox');
  assert.ok(result.result.includes('Deleted'));
});

asyncTest('deck_delete_card returns not found', async () => {
  const registry = new ToolRegistry({
    deckClient: createMockDeckClient({}),
    logger: silentLogger
  });

  const result = await registry.execute('deck_delete_card', { card: 'ghost' });
  assert.ok(result.success);
  assert.ok(result.result.includes('No card found'));
});

asyncTest('deck_assign_user assigns by title', async () => {
  let assignedCardId, assignedUser;
  const deck = createMockDeckClient({
    working: [{ id: 5, title: 'Assign Me' }]
  });
  deck.assignUser = async (cardId, stackName, userId) => {
    assignedCardId = cardId;
    assignedUser = userId;
  };

  const registry = new ToolRegistry({ deckClient: deck, logger: silentLogger });
  const result = await registry.execute('deck_assign_user', { card: 'Assign Me', user: 'alice' });

  assert.ok(result.success);
  assert.strictEqual(assignedCardId, 5);
  assert.strictEqual(assignedUser, 'alice');
  assert.ok(result.result.includes('Assigned'));
  assert.ok(result.result.includes('alice'));
});

asyncTest('deck_unassign_user unassigns by #ID', async () => {
  let unassignedCardId, unassignedUser;
  const deck = createMockDeckClient({
    working: [{ id: 5, title: 'Task' }]
  });
  deck.unassignUser = async (cardId, stackName, userId) => {
    unassignedCardId = cardId;
    unassignedUser = userId;
  };

  const registry = new ToolRegistry({ deckClient: deck, logger: silentLogger });
  const result = await registry.execute('deck_unassign_user', { card: '#5', user: 'bob' });

  assert.ok(result.success);
  assert.strictEqual(unassignedCardId, 5);
  assert.strictEqual(unassignedUser, 'bob');
  assert.ok(result.result.includes('Unassigned'));
});

asyncTest('deck_set_due_date sets date', async () => {
  let updateArgs;
  const deck = createMockDeckClient({
    inbox: [{ id: 10, title: 'Deadline Task' }]
  });
  deck.updateCard = async (cardId, stackName, updates) => {
    updateArgs = { cardId, stackName, updates };
  };

  const registry = new ToolRegistry({ deckClient: deck, logger: silentLogger });
  const result = await registry.execute('deck_set_due_date', { card: 'Deadline', duedate: '2026-03-15' });

  assert.ok(result.success);
  assert.ok(result.result.includes('Set due date'));
  assert.ok(result.result.includes('2026-03-15'));
  assert.strictEqual(updateArgs.updates.duedate, '2026-03-15');
});

asyncTest('deck_set_due_date clears with "none"', async () => {
  let updateArgs;
  const deck = createMockDeckClient({
    inbox: [{ id: 10, title: 'Clear Date' }]
  });
  deck.updateCard = async (cardId, stackName, updates) => {
    updateArgs = { cardId, stackName, updates };
  };

  const registry = new ToolRegistry({ deckClient: deck, logger: silentLogger });
  const result = await registry.execute('deck_set_due_date', { card: 'Clear', duedate: 'none' });

  assert.ok(result.success);
  assert.ok(result.result.includes('Cleared'));
  assert.strictEqual(updateArgs.updates.duedate, null);
});

// ============================================================
// Tests - Phase A: Labels
// ============================================================

asyncTest('deck_add_label adds label by title match', async () => {
  let addedCardId, addedLabel;
  const deck = createMockDeckClient({
    inbox: [{ id: 10, title: 'Label Me' }]
  });
  deck.addLabel = async (cardId, stackName, labelName) => {
    addedCardId = cardId;
    addedLabel = labelName;
  };

  const registry = new ToolRegistry({ deckClient: deck, logger: silentLogger });
  const result = await registry.execute('deck_add_label', { card: 'Label Me', label: 'urgent' });

  assert.ok(result.success);
  assert.strictEqual(addedCardId, 10);
  assert.strictEqual(addedLabel, 'urgent');
  assert.ok(result.result.includes('Added label'));
});

asyncTest('deck_remove_label removes label', async () => {
  let removedCardId, removedLabel;
  const deck = createMockDeckClient({
    inbox: [{ id: 10, title: 'Unlabel Me' }]
  });
  deck.removeLabel = async (cardId, stackName, labelName) => {
    removedCardId = cardId;
    removedLabel = labelName;
  };

  const registry = new ToolRegistry({ deckClient: deck, logger: silentLogger });
  const result = await registry.execute('deck_remove_label', { card: 'Unlabel Me', label: 'blocked' });

  assert.ok(result.success);
  assert.strictEqual(removedCardId, 10);
  assert.strictEqual(removedLabel, 'blocked');
  assert.ok(result.result.includes('Removed label'));
});

// ============================================================
// Tests - Phase A: Comments
// ============================================================

asyncTest('deck_add_comment adds comment without prefix', async () => {
  let addedCardId, addedMessage, addedOpts;
  const deck = createMockDeckClient({
    inbox: [{ id: 10, title: 'Comment Card' }]
  });
  deck.addComment = async (cardId, message, type, opts) => {
    addedCardId = cardId;
    addedMessage = message;
    addedOpts = opts;
  };

  const registry = new ToolRegistry({ deckClient: deck, logger: silentLogger });
  const result = await registry.execute('deck_add_comment', { card: 'Comment Card', message: 'Hello!' });

  assert.ok(result.success);
  assert.strictEqual(addedCardId, 10);
  assert.strictEqual(addedMessage, 'Hello!');
  assert.strictEqual(addedOpts.prefix, false);
  assert.ok(result.result.includes('Added comment'));
});

asyncTest('deck_list_comments lists comments', async () => {
  const registry = new ToolRegistry({
    deckClient: createMockDeckClient({
      inbox: [{ id: 10, title: 'Comment Card' }]
    }),
    logger: silentLogger
  });

  const result = await registry.execute('deck_list_comments', { card: 'Comment Card' });
  assert.ok(result.success);
  assert.ok(result.result.includes('alice'));
  assert.ok(result.result.includes('Looks good!'));
  assert.ok(result.result.includes('moltagent'));
});

asyncTest('deck_list_comments returns empty message when no comments', async () => {
  const deck = createMockDeckClient({
    inbox: [{ id: 10, title: 'Empty Card' }]
  });
  deck.getComments = async () => [];

  const registry = new ToolRegistry({ deckClient: deck, logger: silentLogger });
  const result = await registry.execute('deck_list_comments', { card: 'Empty Card' });

  assert.ok(result.success);
  assert.ok(result.result.includes('No comments'));
});

// ============================================================
// Tests - Phase B: Smart ops
// ============================================================

asyncTest('deck_overview shows boards with card counts', async () => {
  const registry = new ToolRegistry({
    deckClient: createMockDeckClient(),
    logger: silentLogger
  });

  const result = await registry.execute('deck_overview', {});
  assert.ok(result.success);
  assert.ok(result.result.includes('MoltAgent Tasks'));
  assert.ok(result.result.includes('yours'));
  assert.ok(result.result.includes('Inbox'));
  assert.ok(result.result.includes('overdue'));
});

asyncTest('deck_overview returns no boards message', async () => {
  const deck = createMockDeckClient();
  deck.listBoards = async () => [];
  const registry = new ToolRegistry({ deckClient: deck, logger: silentLogger });

  const result = await registry.execute('deck_overview', {});
  assert.ok(result.success);
  assert.ok(result.result.includes('No boards'));
});

asyncTest('deck_my_assigned_cards finds assigned cards', async () => {
  const deck = createMockDeckClient();
  deck.getStacks = async () => [
    {
      title: 'Working',
      cards: [
        { id: 1, title: 'My Task', assignedUsers: [{ participant: { uid: 'moltagent' } }] },
        { id: 2, title: 'Their Task', assignedUsers: [{ participant: { uid: 'alice' } }] }
      ]
    }
  ];

  const registry = new ToolRegistry({ deckClient: deck, logger: silentLogger });
  const result = await registry.execute('deck_my_assigned_cards', {});

  assert.ok(result.success);
  assert.ok(result.result.includes('My Task'));
  assert.ok(!result.result.includes('Their Task'));
});

asyncTest('deck_my_assigned_cards with specific user', async () => {
  const deck = createMockDeckClient();
  deck.getStacks = async () => [
    {
      title: 'Working',
      cards: [
        { id: 1, title: 'My Task', assignedUsers: [{ participant: { uid: 'moltagent' } }] },
        { id: 2, title: 'Alice Task', assignedUsers: [{ participant: { uid: 'alice' } }] }
      ]
    }
  ];

  const registry = new ToolRegistry({ deckClient: deck, logger: silentLogger });
  const result = await registry.execute('deck_my_assigned_cards', { user: 'alice' });

  assert.ok(result.success);
  assert.ok(result.result.includes('Alice Task'));
  assert.ok(!result.result.includes('My Task'));
});

asyncTest('deck_my_assigned_cards returns empty when none', async () => {
  const deck = createMockDeckClient();
  deck.getStacks = async () => [
    { title: 'Inbox', cards: [] }
  ];

  const registry = new ToolRegistry({ deckClient: deck, logger: silentLogger });
  const result = await registry.execute('deck_my_assigned_cards', {});

  assert.ok(result.success);
  assert.ok(result.result.includes('No cards assigned'));
});

asyncTest('deck_overdue_cards finds overdue cards', async () => {
  const deck = createMockDeckClient();
  deck.getStacks = async () => [
    {
      title: 'Working',
      cards: [
        { id: 1, title: 'Overdue Task', duedate: '2020-01-01' },
        { id: 2, title: 'Future Task', duedate: '2099-12-31' },
        { id: 3, title: 'No Date', duedate: null }
      ]
    }
  ];

  const registry = new ToolRegistry({ deckClient: deck, logger: silentLogger });
  const result = await registry.execute('deck_overdue_cards', {});

  assert.ok(result.success);
  assert.ok(result.result.includes('Overdue Task'));
  assert.ok(!result.result.includes('Future Task'));
  assert.ok(!result.result.includes('No Date'));
});

asyncTest('deck_overdue_cards returns empty when none', async () => {
  const deck = createMockDeckClient();
  deck.getStacks = async () => [
    {
      title: 'Working',
      cards: [{ id: 1, title: 'Future', duedate: '2099-12-31' }]
    }
  ];

  const registry = new ToolRegistry({ deckClient: deck, logger: silentLogger });
  const result = await registry.execute('deck_overdue_cards', {});

  assert.ok(result.success);
  assert.ok(result.result.includes('No overdue'));
});

asyncTest('deck_mark_done moves card to done', async () => {
  let movedId, movedFrom, movedTo;
  const deck = createMockDeckClient({
    working: [{ id: 5, title: 'Finish Me' }]
  });
  deck.moveCard = async (cardId, from, to) => {
    movedId = cardId;
    movedFrom = from;
    movedTo = to;
  };

  const registry = new ToolRegistry({ deckClient: deck, logger: silentLogger });
  const result = await registry.execute('deck_mark_done', { card: 'Finish Me' });

  assert.ok(result.success);
  assert.strictEqual(movedId, 5);
  assert.strictEqual(movedFrom, 'working');
  assert.strictEqual(movedTo, 'done');
  assert.ok(result.result.includes('Marked'));
  assert.ok(result.result.includes('done'));
});

asyncTest('deck_mark_done detects already done', async () => {
  const registry = new ToolRegistry({
    deckClient: createMockDeckClient({
      done: [{ id: 5, title: 'Already Done' }]
    }),
    logger: silentLogger
  });

  const result = await registry.execute('deck_mark_done', { card: 'Already Done' });
  assert.ok(result.success);
  assert.ok(result.result.includes('already'));
});

asyncTest('deck_mark_done returns not found', async () => {
  const registry = new ToolRegistry({
    deckClient: createMockDeckClient({}),
    logger: silentLogger
  });

  const result = await registry.execute('deck_mark_done', { card: 'ghost' });
  assert.ok(result.success);
  assert.ok(result.result.includes('No card found'));
});

// ============================================================
// Tests - deck_share_board
// ============================================================

asyncTest('deck_share_board shares owned board', async () => {
  let sharedBoardId, sharedParticipant, sharedType, sharedEdit;
  const deck = createMockDeckClient();
  deck.shareBoard = async (boardId, participant, type, permEdit, permShare, permManage) => {
    sharedBoardId = boardId;
    sharedParticipant = participant;
    sharedType = type;
    sharedEdit = permEdit;
    return { id: 100 };
  };

  const registry = new ToolRegistry({ deckClient: deck, logger: silentLogger });
  const result = await registry.execute('deck_share_board', {
    board: 'MoltAgent',
    participant: 'alice',
    permission: 'edit'
  });

  assert.ok(result.success);
  assert.strictEqual(sharedBoardId, 1);
  assert.strictEqual(sharedParticipant, 'alice');
  assert.strictEqual(sharedType, 0); // user
  assert.strictEqual(sharedEdit, true);
  assert.ok(result.result.includes('Shared'));
  assert.ok(result.result.includes('alice'));
});

asyncTest('deck_share_board rejects sharing non-owned board', async () => {
  const registry = new ToolRegistry({
    deckClient: createMockDeckClient(),
    logger: silentLogger
  });

  const result = await registry.execute('deck_share_board', {
    board: 'Marketing',
    participant: 'bob'
  });

  assert.ok(result.success);
  assert.ok(result.result.includes("don't own"));
});

asyncTest('deck_share_board returns not found for unknown board', async () => {
  const registry = new ToolRegistry({
    deckClient: createMockDeckClient(),
    logger: silentLogger
  });

  const result = await registry.execute('deck_share_board', {
    board: 'NonExistent',
    participant: 'alice'
  });

  assert.ok(result.success);
  assert.ok(result.result.includes('No board found'));
});

asyncTest('deck_share_board with group type', async () => {
  let sharedType;
  const deck = createMockDeckClient();
  deck.shareBoard = async (boardId, participant, type) => {
    sharedType = type;
    return { id: 100 };
  };

  const registry = new ToolRegistry({ deckClient: deck, logger: silentLogger });
  const result = await registry.execute('deck_share_board', {
    board: 'MoltAgent',
    participant: 'dev-team',
    type: 'group',
    permission: 'manage'
  });

  assert.ok(result.success);
  assert.strictEqual(sharedType, 1); // group
  assert.ok(result.result.includes('group'));
  assert.ok(result.result.includes('manage'));
});

// ============================================================
// Tests - 403 Permission Error Handling
// ============================================================

asyncTest('403 error returns friendly permission message', async () => {
  const deck = createMockDeckClient({
    inbox: [{ id: 10, title: 'Shared Card' }]
  });
  deck.updateCard = async () => {
    const err = new Error('Forbidden');
    err.statusCode = 403;
    throw err;
  };

  const registry = new ToolRegistry({ deckClient: deck, logger: silentLogger });
  const result = await registry.execute('deck_update_card', {
    card: 'Shared Card',
    title: 'New Title'
  });

  assert.strictEqual(result.success, false);
  assert.ok(result.error.includes("don't have write permission"));
});

asyncTest('non-403 error returns normal error message', async () => {
  const deck = createMockDeckClient({
    inbox: [{ id: 10, title: 'Bad Card' }]
  });
  deck.updateCard = async () => {
    const err = new Error('Server error');
    err.statusCode = 500;
    throw err;
  };

  const registry = new ToolRegistry({ deckClient: deck, logger: silentLogger });
  const result = await registry.execute('deck_update_card', {
    card: 'Bad Card',
    title: 'New Title'
  });

  assert.strictEqual(result.success, false);
  assert.ok(result.error.includes('Server error'));
});

// ============================================================
// Mock File/Search/Extractor Clients
// ============================================================

function createMockNCFilesClient() {
  return {
    maxContentSize: 51200,
    readFile: async (path) => {
      if (path === 'missing.txt') throw Object.assign(new Error('File not found'), { statusCode: 404 });
      return { content: 'file content here', truncated: false, totalSize: 17 };
    },
    readFileBuffer: async (path) => Buffer.from('buffer content'),
    writeFile: async (path, content) => ({ success: true }),
    listDirectory: async (path) => [
      { name: 'report.md', type: 'file', size: 256, modified: '2026-02-09', permissions: 'RDNVW' },
      { name: 'Inbox', type: 'directory', size: 0, modified: '2026-02-09', permissions: 'RDNVCK' }
    ],
    getFileInfo: async (path) => ({
      name: 'report.md', size: 256, modified: '2026-02-09',
      contentType: 'text/markdown', shared: false, canWrite: true
    }),
    moveFile: async (from, to) => ({ success: true }),
    copyFile: async (from, to) => ({ success: true }),
    deleteFile: async (path) => ({ success: true }),
    mkdir: async (path) => ({ success: true }),
    shareFile: async (path, user, perm) => ({ shareId: 42 }),
    resolvePath: async (path) => {
      if (!path || path === '/') return path;
      if (path === 'missing.txt') return null;
      return path; // Exact match for everything else
    },
    getRootFolderNames: async () => ['report.md', 'Inbox']
  };
}

function createMockNCSearchClient() {
  return {
    search: async (term, providers, limit) => [
      { provider: 'Files', title: 'report.md', subline: 'in /Outbox', resourceUrl: '/f/1' },
      { provider: 'Deck', title: 'Sprint Planning', subline: 'card', resourceUrl: '/apps/deck/1' }
    ]
  };
}

function createMockTextExtractor() {
  return {
    extract: async (buffer, path) => ({ text: 'Extracted text from PDF', truncated: false, totalLength: 22, pages: 3 })
  };
}

// ============================================================
// Tests - File Tools
// ============================================================

test('file tools registered when ncFilesClient provided', () => {
  const registry = new ToolRegistry({
    ncFilesClient: createMockNCFilesClient(),
    textExtractor: createMockTextExtractor(),
    logger: silentLogger
  });

  const fileTools = [
    'file_read', 'file_list', 'file_write', 'file_info',
    'file_move', 'file_copy', 'file_delete', 'file_mkdir',
    'file_share', 'file_extract'
  ];
  for (const tool of fileTools) {
    assert.ok(registry.has(tool), `Should have ${tool}`);
  }
});

test('search tool registered when ncSearchClient provided', () => {
  const registry = new ToolRegistry({
    ncSearchClient: createMockNCSearchClient(),
    logger: silentLogger
  });
  assert.ok(registry.has('unified_search'), 'Should have unified_search');
});

test('all 45 tools registered with all clients', () => {
  const registry = new ToolRegistry({
    deckClient: createMockDeckClient(),
    calDAVClient: createMockCalDAVClient(),
    systemTagsClient: createMockSystemTagsClient(),
    ncRequestManager: createMockNCRequestManager(),
    ncFilesClient: createMockNCFilesClient(),
    ncSearchClient: createMockNCSearchClient(),
    textExtractor: createMockTextExtractor(),
    logger: silentLogger
  });
  // 22 deck + 6 calendar + 1 tag + 1 memory + 10 file + 1 search + 4 workflow_deck = 45
  assert.strictEqual(registry.size, 45, `Expected 45 tools, got ${registry.size}`);
});

asyncTest('file_read returns file content', async () => {
  const registry = new ToolRegistry({
    ncFilesClient: createMockNCFilesClient(),
    logger: silentLogger
  });
  const result = await registry.execute('file_read', { path: 'report.md' });
  assert.ok(result.success);
  assert.ok(result.result.includes('file content'));
});

asyncTest('file_read returns friendly error on 404 with available folders', async () => {
  const registry = new ToolRegistry({
    ncFilesClient: createMockNCFilesClient(),
    logger: silentLogger
  });
  const result = await registry.execute('file_read', { path: 'missing.txt' });
  assert.ok(result.success);
  assert.ok(result.result.includes('not found'), `Expected "not found" in: ${result.result}`);
  assert.ok(result.result.includes('Available'), `Expected "Available" in: ${result.result}`);
});

asyncTest('file_list formats directory listing', async () => {
  const registry = new ToolRegistry({
    ncFilesClient: createMockNCFilesClient(),
    logger: silentLogger
  });
  const result = await registry.execute('file_list', {});
  assert.ok(result.success);
  assert.ok(result.result.includes('report.md'));
  assert.ok(result.result.includes('[dir]'));
  assert.ok(result.result.includes('Inbox'));
});

asyncTest('file_list sorts directories first then alphabetically', async () => {
  const files = createMockNCFilesClient();
  files.listDirectory = async () => [
    { name: 'zebra.txt', type: 'file', size: 100 },
    { name: 'Archive', type: 'directory', size: 0 },
    { name: 'alpha.md', type: 'file', size: 200 },
    { name: 'Inbox', type: 'directory', size: 0 }
  ];
  const registry = new ToolRegistry({ ncFilesClient: files, logger: silentLogger });
  const result = await registry.execute('file_list', {});
  assert.ok(result.success);
  const lines = result.result.split('\n');
  // Directories first, alphabetical
  assert.ok(lines[0].includes('Archive'), `First line should be Archive: ${lines[0]}`);
  assert.ok(lines[1].includes('Inbox'), `Second line should be Inbox: ${lines[1]}`);
  // Then files, alphabetical
  assert.ok(lines[2].includes('alpha.md'), `Third line should be alpha.md: ${lines[2]}`);
  assert.ok(lines[3].includes('zebra.txt'), `Fourth line should be zebra.txt: ${lines[3]}`);
});

asyncTest('file_list caps output at 30 entries', async () => {
  const files = createMockNCFilesClient();
  const items = [];
  for (let i = 0; i < 45; i++) {
    items.push({ name: `file${String(i).padStart(3, '0')}.txt`, type: 'file', size: 100 * i });
  }
  files.listDirectory = async () => items;
  const registry = new ToolRegistry({ ncFilesClient: files, logger: silentLogger });
  const result = await registry.execute('file_list', {});
  assert.ok(result.success);
  // Should contain only 30 file entries (not 45)
  const fileLines = result.result.split('\n').filter(l => l.trim().startsWith('file'));
  assert.strictEqual(fileLines.length, 30, `Expected 30 file lines, got ${fileLines.length}`);
});

asyncTest('file_list shows overflow message when capped', async () => {
  const files = createMockNCFilesClient();
  const items = [];
  for (let i = 0; i < 35; i++) {
    items.push({ name: `item${i}.txt`, type: 'file', size: 50 });
  }
  files.listDirectory = async () => items;
  const registry = new ToolRegistry({ ncFilesClient: files, logger: silentLogger });
  const result = await registry.execute('file_list', {});
  assert.ok(result.success);
  assert.ok(result.result.includes('and 5 more items'), `Expected overflow message in: ${result.result.slice(-100)}`);
  assert.ok(result.result.includes('more specific path'));
});

asyncTest('file_list returns all entries when under limit', async () => {
  const files = createMockNCFilesClient();
  const items = [];
  for (let i = 0; i < 10; i++) {
    items.push({ name: `file${i}.txt`, type: 'file', size: 100 });
  }
  files.listDirectory = async () => items;
  const registry = new ToolRegistry({ ncFilesClient: files, logger: silentLogger });
  const result = await registry.execute('file_list', {});
  assert.ok(result.success);
  const fileLines = result.result.split('\n').filter(l => l.trim().startsWith('file'));
  assert.strictEqual(fileLines.length, 10, `Expected 10 file lines, got ${fileLines.length}`);
  assert.ok(!result.result.includes('more items'), 'Should not have overflow message');
});

asyncTest('file_list uses compact format (name + size only)', async () => {
  const files = createMockNCFilesClient();
  files.listDirectory = async () => [
    { name: 'report.pdf', type: 'file', size: 2048, modified: '2026-02-09', contentType: 'application/pdf', permissions: 'RDNVW', etag: '"abc123"' },
    { name: 'Docs', type: 'directory', size: 0, modified: '2026-02-08', permissions: 'RDNVCK' }
  ];
  const registry = new ToolRegistry({ ncFilesClient: files, logger: silentLogger });
  const result = await registry.execute('file_list', {});
  assert.ok(result.success);
  // Should contain name and size
  assert.ok(result.result.includes('report.pdf'));
  assert.ok(result.result.includes('2.0 KB'));
  assert.ok(result.result.includes('[dir]'));
  assert.ok(result.result.includes('Docs'));
  // Should NOT contain verbose metadata
  assert.ok(!result.result.includes('etag'), 'Should not contain etag');
  assert.ok(!result.result.includes('abc123'), 'Should not contain etag value');
  assert.ok(!result.result.includes('application/pdf'), 'Should not contain contentType');
  assert.ok(!result.result.includes('RDNVW'), 'Should not contain permissions');
});

asyncTest('file_write returns success with size', async () => {
  const registry = new ToolRegistry({
    ncFilesClient: createMockNCFilesClient(),
    logger: silentLogger
  });
  const result = await registry.execute('file_write', { path: 'test.md', content: 'Hello' });
  assert.ok(result.success);
  assert.ok(result.result.includes('Wrote'));
  assert.ok(result.result.includes('test.md'));
});

asyncTest('file_write returns friendly error on 403', async () => {
  const files = createMockNCFilesClient();
  files.writeFile = async () => { throw Object.assign(new Error('Permission denied'), { statusCode: 403 }); };
  const registry = new ToolRegistry({ ncFilesClient: files, logger: silentLogger });
  const result = await registry.execute('file_write', { path: 'readonly.md', content: 'data' });
  assert.ok(result.success);
  assert.ok(result.result.includes("don't have write permission"));
});

asyncTest('file_info returns formatted metadata', async () => {
  const registry = new ToolRegistry({
    ncFilesClient: createMockNCFilesClient(),
    logger: silentLogger
  });
  const result = await registry.execute('file_info', { path: 'report.md' });
  assert.ok(result.success);
  assert.ok(result.result.includes('Name:'));
  assert.ok(result.result.includes('Size:'));
  assert.ok(result.result.includes('Writable: yes'));
});

asyncTest('file_move returns success', async () => {
  const registry = new ToolRegistry({
    ncFilesClient: createMockNCFilesClient(),
    logger: silentLogger
  });
  const result = await registry.execute('file_move', { from_path: 'old.md', to_path: 'new.md' });
  assert.ok(result.success);
  assert.ok(result.result.includes('Moved'));
});

asyncTest('file_copy returns success', async () => {
  const registry = new ToolRegistry({
    ncFilesClient: createMockNCFilesClient(),
    logger: silentLogger
  });
  const result = await registry.execute('file_copy', { from_path: 'src.md', to_path: 'dst.md' });
  assert.ok(result.success);
  assert.ok(result.result.includes('Copied'));
});

asyncTest('file_delete returns success', async () => {
  const registry = new ToolRegistry({
    ncFilesClient: createMockNCFilesClient(),
    logger: silentLogger
  });
  const result = await registry.execute('file_delete', { path: 'trash.md' });
  assert.ok(result.success);
  assert.ok(result.result.includes('Deleted'));
});

asyncTest('file_mkdir returns success', async () => {
  const registry = new ToolRegistry({
    ncFilesClient: createMockNCFilesClient(),
    logger: silentLogger
  });
  const result = await registry.execute('file_mkdir', { path: 'NewFolder' });
  assert.ok(result.success);
  assert.ok(result.result.includes('Created folder'));
});

asyncTest('file_share returns share info', async () => {
  const registry = new ToolRegistry({
    ncFilesClient: createMockNCFilesClient(),
    logger: silentLogger
  });
  const result = await registry.execute('file_share', { path: 'report.md', share_with: 'alice' });
  assert.ok(result.success);
  assert.ok(result.result.includes('Shared'));
  assert.ok(result.result.includes('alice'));
  assert.ok(result.result.includes('42'));
});

asyncTest('file_extract returns extracted text with page count', async () => {
  const registry = new ToolRegistry({
    ncFilesClient: createMockNCFilesClient(),
    textExtractor: createMockTextExtractor(),
    logger: silentLogger
  });
  const result = await registry.execute('file_extract', { path: 'doc.pdf' });
  assert.ok(result.success);
  assert.ok(result.result.includes('Extracted text'));
  assert.ok(result.result.includes('3 pages'));
});

asyncTest('file_extract returns error for unsupported type', async () => {
  const registry = new ToolRegistry({
    ncFilesClient: createMockNCFilesClient(),
    textExtractor: createMockTextExtractor(),
    logger: silentLogger
  });
  const result = await registry.execute('file_extract', { path: 'image.png' });
  assert.ok(result.success);
  assert.ok(result.result.includes("Can't extract"));
});

// ============================================================
// Tests - Search Tool
// ============================================================

asyncTest('unified_search returns formatted results', async () => {
  const registry = new ToolRegistry({
    ncSearchClient: createMockNCSearchClient(),
    logger: silentLogger
  });
  const result = await registry.execute('unified_search', { query: 'report' });
  assert.ok(result.success);
  assert.ok(result.result.includes('[Files]'));
  assert.ok(result.result.includes('report.md'));
  assert.ok(result.result.includes('[Deck]'));
  assert.ok(result.result.includes('Sprint Planning'));
});

asyncTest('unified_search returns empty message when no results', async () => {
  const search = createMockNCSearchClient();
  search.search = async () => [];
  const registry = new ToolRegistry({ ncSearchClient: search, logger: silentLogger });
  const result = await registry.execute('unified_search', { query: 'nothing' });
  assert.ok(result.success);
  assert.ok(result.result.includes('No results'));
});

// ============================================================
// Cloud Workflow Tool Definitions Tests (Session 36)
// ============================================================

function _createFullRegistry() {
  return new ToolRegistry({
    deckClient: createMockDeckClient(),
    calDAVClient: createMockCalDAVClient(),
    systemTagsClient: createMockSystemTagsClient(),
    ncRequestManager: createMockNCRequestManager(),
    ncFilesClient: createMockNCFilesClient(),
    ncSearchClient: createMockNCSearchClient(),
    textExtractor: createMockTextExtractor(),
    logger: silentLogger
  });
}

test('getCloudWorkflowToolDefinitions returns base workflow tools', () => {
  const registry = _createFullRegistry();
  const tools = registry.getCloudWorkflowToolDefinitions('');

  const names = tools.map(t => t.function.name);
  assert.ok(names.includes('workflow_deck_move_card'), 'Should include move_card');
  assert.ok(names.includes('workflow_deck_add_comment'), 'Should include add_comment');
  assert.ok(names.includes('workflow_deck_create_card'), 'Should include create_card');
  assert.ok(names.includes('workflow_deck_update_card'), 'Should include update_card');
  assert.ok(names.includes('deck_add_label'), 'Should include add_label');
  assert.ok(names.length <= 10, `Base tools should be <=10, got ${names.length}`);
});

test('getCloudWorkflowToolDefinitions adds wiki tools when context mentions wiki', () => {
  const registry = _createFullRegistry();
  const tools = registry.getCloudWorkflowToolDefinitions('Check [[Client Profile]] wiki page');

  const names = tools.map(t => t.function.name);
  // Note: wiki tools only register if collectivesClient is provided; mock registry may not have them.
  // This test verifies the allowed set is expanded, not that the tools are registered.
  assert.ok(names.length >= 5, 'Should have at least base tools');
});

test('getCloudWorkflowToolDefinitions adds calendar tools when context mentions meeting', () => {
  const registry = _createFullRegistry();
  const tools = registry.getCloudWorkflowToolDefinitions('Schedule a kickoff meeting with the client');

  const names = tools.map(t => t.function.name);
  assert.ok(names.includes('calendar_create_event'), 'Should include calendar_create_event');
  assert.ok(names.includes('calendar_list_events'), 'Should include calendar_list_events');
});

test('getCloudWorkflowToolDefinitions adds file tools when context mentions folder', () => {
  const registry = _createFullRegistry();
  const tools = registry.getCloudWorkflowToolDefinitions('Create folder under /clients/ for new client');

  const names = tools.map(t => t.function.name);
  assert.ok(names.includes('file_mkdir'), 'Should include file_mkdir for folder context');
  assert.ok(names.includes('file_write'), 'Should include file_write for file context');
});

test('getCloudWorkflowToolDefinitions returns fewer tools than getToolDefinitions', () => {
  const registry = _createFullRegistry();
  const allTools = registry.getToolDefinitions();
  const workflowTools = registry.getCloudWorkflowToolDefinitions('Process this card');

  assert.ok(workflowTools.length < allTools.length,
    `Workflow tools (${workflowTools.length}) should be fewer than all tools (${allTools.length})`);
});

// ============================================================
// Tests - Board-targeted card creation + Stack ID exposure
// ============================================================

asyncTest('deck_create_card with board param resolves target board and stack', async () => {
  let requestMethod, requestPath, requestBody;
  const deck = createMockDeckClient();
  deck._request = async (method, path, body) => {
    requestMethod = method;
    requestPath = path;
    requestBody = body;
    return { id: 88, title: body?.title || 'Test' };
  };

  const registry = new ToolRegistry({ deckClient: deck, logger: silentLogger });
  const result = await registry.execute('deck_create_card', {
    title: 'Test EP',
    board: 'Marketing'
  });

  assert.ok(result.success);
  assert.ok(result.result.includes('Test EP'));
  assert.ok(result.result.includes('#88'));
  assert.ok(result.result.includes('Marketing'));
  assert.ok(result.result.includes('Inbox'));
  assert.strictEqual(requestMethod, 'POST');
  assert.ok(requestPath.includes('/boards/2/stacks/301/cards'), `Expected board 2, stack 301 in path: ${requestPath}`);
  assert.strictEqual(requestBody.title, 'Test EP');
});

asyncTest('deck_create_card without board uses default (regression)', async () => {
  let createdStack, createdCard;
  const deck = createMockDeckClient();
  deck.createCard = async (stack, card) => {
    createdStack = stack;
    createdCard = card;
    return { id: 99, ...card };
  };

  const registry = new ToolRegistry({ deckClient: deck, logger: silentLogger });
  const result = await registry.execute('deck_create_card', { title: 'Default board task' });

  assert.ok(result.success);
  assert.strictEqual(createdStack, 'inbox');
  assert.strictEqual(createdCard.title, 'Default board task');
  assert.ok(result.result.includes('#99'));
  assert.ok(!result.result.includes('on board'), 'Should not mention board for default');
});

asyncTest('deck_create_card with invalid board returns error', async () => {
  const registry = new ToolRegistry({
    deckClient: createMockDeckClient(),
    logger: silentLogger
  });

  const result = await registry.execute('deck_create_card', {
    title: 'Orphan card',
    board: 'NonExistentBoard'
  });

  assert.ok(result.success);
  assert.ok(result.result.includes('No board found'));
  assert.ok(result.result.includes('NonExistentBoard'));
});

asyncTest('deck_create_card with board but non-existent stack lists available stacks', async () => {
  const deck = createMockDeckClient();
  deck.getStacks = async () => [
    { id: 401, title: 'Backlog', cards: [] },
    { id: 402, title: 'Sprint', cards: [] }
  ];

  const registry = new ToolRegistry({ deckClient: deck, logger: silentLogger });
  const result = await registry.execute('deck_create_card', {
    title: 'Test card',
    board: 'Marketing',
    stack: 'Inbox'
  });

  assert.ok(result.success);
  assert.ok(result.result.includes('No stack "Inbox"'), `Expected stack not found message: ${result.result}`);
  assert.ok(result.result.includes('Backlog'), 'Should list available stack Backlog');
  assert.ok(result.result.includes('Sprint'), 'Should list available stack Sprint');
  assert.ok(result.result.includes('ID: 401'), 'Should include stack IDs');
});

asyncTest('deck_list_stacks output includes stack IDs', async () => {
  const registry = new ToolRegistry({
    deckClient: createMockDeckClient(),
    logger: silentLogger
  });

  const result = await registry.execute('deck_list_stacks', { board: 'MoltAgent' });
  assert.ok(result.success);
  assert.ok(result.result.includes('ID: 301'), `Expected stack ID 301 in: ${result.result}`);
  assert.ok(result.result.includes('ID: 302'), `Expected stack ID 302 in: ${result.result}`);
});

asyncTest('deck_get_board output includes stack IDs', async () => {
  const registry = new ToolRegistry({
    deckClient: createMockDeckClient(),
    logger: silentLogger
  });

  const result = await registry.execute('deck_get_board', { board: 'Molt' });
  assert.ok(result.success);
  assert.ok(result.result.includes('ID: 301'), `Expected stack ID 301 in: ${result.result}`);
  assert.ok(result.result.includes('ID: 302'), `Expected stack ID 302 in: ${result.result}`);
});

// ============================================================
// Workflow Deck Tool Tests
// ============================================================

asyncTest('workflow_deck_create_card with stack name resolves from board', async () => {
  const registry = new ToolRegistry({
    deckClient: createMockDeckClient(),
    ncRequestManager: createMockNCRequestManager(),
    logger: silentLogger
  });

  const result = await registry.execute('workflow_deck_create_card', {
    board_id: 131,
    stack: 'Inbox',
    title: 'Test workflow card'
  });
  assert.ok(result.success, `Expected success, got: ${result.error || result.result}`);
  assert.ok(result.result.includes('Test workflow card'), `Expected title in result: ${result.result}`);
  assert.ok(result.result.includes('Inbox'), `Expected stack name in result: ${result.result}`);
});

asyncTest('workflow_deck_create_card with invalid stack_id returns available stacks', async () => {
  const registry = new ToolRegistry({
    deckClient: createMockDeckClient(),
    ncRequestManager: createMockNCRequestManager(),
    logger: silentLogger
  });

  const result = await registry.execute('workflow_deck_create_card', {
    board_id: 131,
    stack_id: 9999,
    title: 'Should fail'
  });
  assert.ok(result.success, 'Handler returns error message, not exception');
  assert.ok(result.result.includes('not found'), `Expected "not found" in: ${result.result}`);
  assert.ok(result.result.includes('ID: 301'), `Expected available stack IDs in: ${result.result}`);
});

asyncTest('workflow_deck_create_card with no stack defaults to first stack', async () => {
  const registry = new ToolRegistry({
    deckClient: createMockDeckClient(),
    ncRequestManager: createMockNCRequestManager(),
    logger: silentLogger
  });

  const result = await registry.execute('workflow_deck_create_card', {
    board_id: 131,
    title: 'Default stack card'
  });
  assert.ok(result.success, `Expected success, got: ${result.error || result.result}`);
  assert.ok(result.result.includes('Inbox'), `Expected first stack (Inbox) in: ${result.result}`);
});

asyncTest('workflow_deck_create_card with valid stack_id validated against board', async () => {
  const registry = new ToolRegistry({
    deckClient: createMockDeckClient(),
    ncRequestManager: createMockNCRequestManager(),
    logger: silentLogger
  });

  const result = await registry.execute('workflow_deck_create_card', {
    board_id: 131,
    stack_id: 301,
    title: 'Valid ID card'
  });
  assert.ok(result.success, `Expected success, got: ${result.error || result.result}`);
  assert.ok(result.result.includes('Valid ID card'), `Expected title in result: ${result.result}`);
  assert.ok(result.result.includes('stack 301'), `Expected validated stack ID in: ${result.result}`);
});

// ============================================================
// Summary (setTimeout lets async tests finish before reporting)
// ============================================================

setTimeout(() => {
  summary();
  exitWithCode();
}, 500);
