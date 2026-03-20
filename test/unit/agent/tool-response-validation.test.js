// Mock type: LEGACY — TODO: migrate to realistic mocks
/**
 * Tool Response Validation Tests
 *
 * Verifies that tool handlers guard against empty/missing API responses
 * instead of interpolating `undefined` into success messages.
 *
 * Run: node test/unit/agent/tool-response-validation.test.js
 */

const assert = require('assert');
const { asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const { ToolRegistry } = require('../../../src/lib/agent/tool-registry');
const DECK = require('../../../src/config/deck-names');

// ============================================================
// Mock Clients
// ============================================================

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function createNCRequestManager() {
  return {
    ncUrl: 'https://cloud.example.com',
    ncUser: 'testuser',
    request: async () => ({ status: 200, body: {} }),
    getUserEmail: async (userId) => `${userId}@example.com`
  };
}

function createDeckClient(overrides = {}) {
  return {
    baseUrl: 'https://nc.example.com',
    username: 'moltagent',
    stackNames: {
      inbox: 'Inbox', queued: 'Queued', working: 'Working',
      review: 'Review', done: 'Done', reference: 'Reference'
    },
    getAllCards: async () => ({}),
    getCardsInStack: async () => [],
    createCard: overrides.createCard || (async () => ({ id: 99, title: 'Test' })),
    moveCard: async () => {},
    ensureBoard: async () => ({ boardId: 1, stacks: {} }),
    listBoards: async () => [
      { id: 1, title: DECK.boards.tasks, owner: { uid: 'moltagent' } }
    ],
    getBoard: async () => ({
      id: 1, title: DECK.boards.tasks,
      owner: { uid: 'moltagent' },
      stacks: [{ id: 301, title: 'Inbox', cards: [] }],
      labels: []
    }),
    getStacks: async () => [
      { id: 301, title: 'Inbox', cards: [] },
      { id: 302, title: 'Done', cards: [] }
    ],
    getCard: overrides.getCard || (async () => ({
      id: 10, title: 'Test Card', description: '', duedate: null,
      type: 'plain', owner: { uid: 'moltagent' },
      assignedUsers: [{ participant: { uid: 'alice' } }],
      labels: []
    })),
    updateCard: async () => {},
    deleteCard: async () => {},
    assignUser: overrides.assignUser || (async () => {}),
    unassignUser: async () => {},
    addLabel: async () => {},
    removeLabel: async () => {},
    addComment: async () => {},
    getComments: async () => [],
    shareBoard: async () => ({ id: 100 }),
    createStack: async () => ({ id: 50, title: 'New' }),
    _request: overrides._request || (async (method, path, body) => ({ id: 77, title: body?.title || 'Test' }))
  };
}

function createCalDAVClient(overrides = {}) {
  return {
    getUpcomingEvents: async () => [],
    createEvent: overrides.createEvent || (async (data) => ({ uid: 'evt-123', ...data })),
    checkAvailability: async () => ({ isFree: true, conflicts: [] })
  };
}

function createCollectivesClient(overrides = {}) {
  return {
    resolveCollective: async () => 10,
    listCollectives: async () => [{ id: 10, name: 'Moltagent Knowledge' }],
    getCollective: async (name) => ({ id: 10, name }),
    listPages: async () => overrides.listPages || [],
    getPage: async (cId, pageId) => ({ id: pageId, title: 'Test' }),
    createPage: overrides.createPage || (async (cId, parentId, title) => ({ id: 500, title, fileName: `${title}.md`, filePath: 'Test' })),
    searchPages: async () => [],
    readPageContent: async () => '',
    writePageContent: async () => undefined,
    touchPage: async () => {},
    findPageByTitle: overrides.findPageByTitle !== undefined ? (async () => overrides.findPageByTitle) : (async () => null),
    readPageWithFrontmatter: async () => null,
    writePageWithFrontmatter: async () => 'Test/Readme.md',
    resolveWikilinks: async (c) => c,
    collectiveName: 'Moltagent Knowledge'
  };
}

// ============================================================
// Tests
// ============================================================

console.log('\n=== Tool Response Validation Tests ===\n');

// -- deck_create_card --

asyncTest('deck_create_card: null response from board-targeted path returns failure', async () => {
  const registry = new ToolRegistry({
    deckClient: createDeckClient({
      _request: async () => null
    }),
    logger: silentLogger
  });

  const result = await registry.execute('deck_create_card', {
    title: 'Test Card', board: DECK.boards.tasks
  });

  assert.ok(result.success, 'execute should succeed (handler returns string)');
  assert.ok(result.result.includes('Failed'), `Should contain "Failed", got: ${result.result}`);
  assert.ok(!result.result.includes('undefined'), `Should not contain "undefined", got: ${result.result}`);
});

asyncTest('deck_create_card: empty body {success:true} from board-targeted path returns failure', async () => {
  const registry = new ToolRegistry({
    deckClient: createDeckClient({
      _request: async () => ({ success: true, statusCode: 200 })
    }),
    logger: silentLogger
  });

  const result = await registry.execute('deck_create_card', {
    title: 'Test Card', board: DECK.boards.tasks
  });

  assert.ok(result.result.includes('Failed'), `Should contain "Failed", got: ${result.result}`);
  assert.ok(!result.result.includes('undefined'), `Should not contain "undefined", got: ${result.result}`);
});

asyncTest('deck_create_card: valid response with id returns success', async () => {
  const registry = new ToolRegistry({
    deckClient: createDeckClient({
      _request: async (method, path, body) => ({ id: 1348, title: body?.title || 'Test' })
    }),
    logger: silentLogger
  });

  const result = await registry.execute('deck_create_card', {
    title: 'Research top 5', board: DECK.boards.tasks
  });

  assert.ok(result.result.includes('1348'), `Should contain card ID 1348, got: ${result.result}`);
  assert.ok(result.result.includes('Created'), `Should contain "Created", got: ${result.result}`);
});

asyncTest('deck_create_card: null from default board path returns failure', async () => {
  const registry = new ToolRegistry({
    deckClient: createDeckClient({
      createCard: async () => null
    }),
    logger: silentLogger
  });

  const result = await registry.execute('deck_create_card', { title: 'Test Card' });

  assert.ok(result.result.includes('Failed'), `Should contain "Failed", got: ${result.result}`);
  assert.ok(!result.result.includes('undefined'), `Should not contain "undefined", got: ${result.result}`);
});

asyncTest('deck_create_card: {success:true} without id from default board returns failure', async () => {
  const registry = new ToolRegistry({
    deckClient: createDeckClient({
      createCard: async () => ({ success: true })
    }),
    logger: silentLogger
  });

  const result = await registry.execute('deck_create_card', { title: 'Test Card' });

  assert.ok(result.result.includes('Failed'), `Should contain "Failed", got: ${result.result}`);
});

// -- workflow_deck_create_card --

asyncTest('workflow_deck_create_card: null response returns failure', async () => {
  const deck = createDeckClient({
    _request: async (method, path, body) => {
      // POST for card creation returns null (empty body)
      if (method === 'POST') return null;
      return { id: 77, title: body?.title || 'Test' };
    }
  });
  // Override getStacks to return stacks for any board
  deck.getStacks = async (boardId) => [{ id: 301, title: 'Inbox' }];

  const registry = new ToolRegistry({ deckClient: deck, ncRequestManager: createNCRequestManager(), logger: silentLogger });

  const result = await registry.execute('workflow_deck_create_card', {
    title: 'Workflow Card', board_id: 1, stack_id: 301
  });

  assert.ok(result.result.includes('Failed'), `Should contain "Failed", got: ${result.result}`);
  assert.ok(!result.result.includes('undefined'), `Should not contain "undefined", got: ${result.result}`);
});

asyncTest('workflow_deck_create_card: valid response returns success with ID', async () => {
  const deck = createDeckClient({
    _request: async (method, path, body) => {
      if (method === 'POST') return { id: 42, title: body?.title || 'Test' };
      return { id: 77, title: 'Test' };
    }
  });
  deck.getStacks = async (boardId) => [{ id: 301, title: 'Inbox' }];

  const registry = new ToolRegistry({ deckClient: deck, ncRequestManager: createNCRequestManager(), logger: silentLogger });

  const result = await registry.execute('workflow_deck_create_card', {
    title: 'Workflow Card', board_id: 1, stack_id: 301
  });

  assert.ok(result.result.includes('42'), `Should contain card ID 42, got: ${result.result}`);
  assert.ok(result.result.includes('Created'), `Should contain "Created", got: ${result.result}`);
});

// -- deck_assign_user --

asyncTest('deck_assign_user: user not on board returns failure', async () => {
  // getAllCards must return a card so _resolveCard can find it
  const cardsData = { inbox: [{ id: 10, title: 'Test Card' }] };
  let getCardCallCount = 0;
  const deck = createDeckClient({
    assignUser: async () => undefined,
    getCard: async () => {
      getCardCallCount++;
      if (getCardCallCount <= 1) {
        // First call: _resolveCard's internal getCard
        return { id: 10, title: 'Test Card', description: '', duedate: null, type: 'plain', owner: { uid: 'moltagent' }, assignedUsers: [], labels: [] };
      }
      // Second call: verification re-read — user NOT assigned
      return { id: 10, title: 'Test Card', assignedUsers: [] };
    }
  });
  deck.getAllCards = async () => cardsData;
  deck.getCardsInStack = async (stack) => cardsData[stack] || [];

  const registry = new ToolRegistry({ deckClient: deck, logger: silentLogger });

  const result = await registry.execute('deck_assign_user', { card: '#10', user: 'bob' });

  assert.ok(result.success);
  assert.ok(result.result.includes('Could not assign'), `Should report failure, got: ${result.result}`);
  assert.ok(!result.result.includes('undefined'), `Should not contain "undefined", got: ${result.result}`);
});

asyncTest('deck_assign_user: getCard throws on verification returns uncertainty message', async () => {
  const cardsData = { inbox: [{ id: 10, title: 'Test Card' }] };
  const deck = createDeckClient({
    assignUser: async () => undefined,
    getCard: async () => { throw new Error('Network error'); }
  });
  deck.getAllCards = async () => cardsData;
  deck.getCardsInStack = async (stack) => cardsData[stack] || [];

  const registry = new ToolRegistry({ deckClient: deck, logger: silentLogger });

  const result = await registry.execute('deck_assign_user', { card: '#10', user: 'bob' });

  assert.ok(result.result.includes('could not be confirmed'), `Should report uncertainty, got: ${result.result}`);
});

asyncTest('deck_assign_user: assignUser returns undefined but getCard confirms assignment', async () => {
  const cardsData = { inbox: [{ id: 10, title: 'Test Card' }] };
  const deck = createDeckClient({
    assignUser: async () => undefined,
    // Verification re-read shows bob IS assigned
    getCard: async () => ({
      id: 10, title: 'Test Card', assignedUsers: [{ participant: { uid: 'bob' } }]
    })
  });
  deck.getAllCards = async () => cardsData;
  deck.getCardsInStack = async (stack) => cardsData[stack] || [];

  const registry = new ToolRegistry({ deckClient: deck, logger: silentLogger });

  const result = await registry.execute('deck_assign_user', { card: '#10', user: 'bob' });

  assert.ok(result.result.includes('Assigned'), `Should report success, got: ${result.result}`);
  assert.ok(result.result.includes('bob'), `Should mention user, got: ${result.result}`);
});

// -- wiki_write (create path) --

asyncTest('wiki_write: null from createPage returns failure', async () => {
  const registry = new ToolRegistry({
    collectivesClient: createCollectivesClient({
      createPage: async () => null,
      findPageByTitle: null,
      listPages: [{ id: 100, title: 'Research', parentId: 0 }]
    }),
    logger: silentLogger
  });

  const result = await registry.execute('wiki_write', {
    page_title: 'New Research Page',
    content: '# Test\nSome content',
    parent: 'Research'
  });

  assert.ok(result.success);
  assert.ok(result.result.includes('Failed'), `Should contain "Failed", got: ${result.result}`);
  assert.ok(!result.result.includes('undefined'), `Should not contain "undefined", got: ${result.result}`);
});

asyncTest('wiki_write: response without id returns failure', async () => {
  const registry = new ToolRegistry({
    collectivesClient: createCollectivesClient({
      createPage: async () => ({ success: true }),
      findPageByTitle: null,
      listPages: [{ id: 100, title: 'Research', parentId: 0 }]
    }),
    logger: silentLogger
  });

  const result = await registry.execute('wiki_write', {
    page_title: 'New Research Page',
    content: '# Test\nSome content',
    parent: 'Research'
  });

  assert.ok(result.result.includes('Failed'), `Should contain "Failed", got: ${result.result}`);
});

// -- mail_send --

asyncTest('mail_send: failed result returns failure message', async () => {
  const emailHandler = {
    confirmSendEmail: async () => ({ success: false, error: 'SMTP timeout' })
  };
  const registry = new ToolRegistry({ emailHandler, ncRequestManager: createNCRequestManager(), logger: silentLogger });

  // Verify tool is registered
  assert.ok(registry.has('mail_send'), 'mail_send should be registered');

  const result = await registry.execute('mail_send', {
    to: 'test@example.com', subject: 'Hello', body: 'Test body'
  });

  assert.ok(result.success, `execute should succeed, got: ${JSON.stringify(result)}`);
  assert.ok(result.result.includes('Failed'), `Should contain "Failed", got: ${result.result}`);
  assert.ok(result.result.includes('SMTP timeout'), `Should contain error detail, got: ${result.result}`);
});

asyncTest('mail_send: null result returns failure message', async () => {
  const emailHandler = {
    confirmSendEmail: async () => null
  };
  const registry = new ToolRegistry({ emailHandler, ncRequestManager: createNCRequestManager(), logger: silentLogger });

  const result = await registry.execute('mail_send', {
    to: 'test@example.com', subject: 'Hello', body: 'Test body'
  });

  assert.ok(result.result.includes('Failed'), `Should contain "Failed", got: ${result.result}`);
});

asyncTest('mail_send: success result returns success message', async () => {
  const emailHandler = {
    confirmSendEmail: async () => ({ success: true, message: 'Email sent to test@example.com.' })
  };
  const registry = new ToolRegistry({ emailHandler, ncRequestManager: createNCRequestManager(), logger: silentLogger });

  const result = await registry.execute('mail_send', {
    to: 'test@example.com', subject: 'Hello', body: 'Test body'
  });

  assert.ok(result.result.includes('Email sent'), `Should contain success message, got: ${result.result}`);
  assert.ok(!result.result.includes('Failed'), `Should not contain "Failed", got: ${result.result}`);
});

// -- calendar_create_event --

// Use a date 2 days in the future to avoid the 24h-in-the-past guardrail
const futureDate = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const futureStart = `${futureDate}T10:00:00Z`;

asyncTest('calendar_create_event: null response returns ambiguous message', async () => {
  const registry = new ToolRegistry({
    calDAVClient: createCalDAVClient({
      createEvent: async () => null
    }),
    logger: silentLogger
  });

  const result = await registry.execute('calendar_create_event', {
    title: 'Team Meeting',
    start: futureStart
  });

  assert.ok(result.success);
  assert.ok(result.result.includes('may not have been created'), `Should indicate uncertainty, got: ${result.result}`);
  assert.ok(!result.result.includes('undefined'), `Should not contain "undefined", got: ${result.result}`);
});

asyncTest('calendar_create_event: empty object response returns ambiguous message', async () => {
  const registry = new ToolRegistry({
    calDAVClient: createCalDAVClient({
      createEvent: async () => ({})
    }),
    logger: silentLogger
  });

  const result = await registry.execute('calendar_create_event', {
    title: 'Team Meeting',
    start: futureStart
  });

  assert.ok(result.result.includes('may not have been created'), `Should indicate uncertainty, got: ${result.result}`);
});

asyncTest('calendar_create_event: valid response with uid returns success', async () => {
  const registry = new ToolRegistry({
    calDAVClient: createCalDAVClient({
      createEvent: async (data) => ({ uid: 'cal-uid-456', ...data })
    }),
    logger: silentLogger
  });

  const result = await registry.execute('calendar_create_event', {
    title: 'Team Meeting',
    start: futureStart
  });

  assert.ok(result.result.includes('cal-uid-456'), `Should contain event UID, got: ${result.result}`);
  assert.ok(result.result.includes('Created'), `Should contain "Created", got: ${result.result}`);
});

// ============================================================
// Summary (setTimeout lets async tests finish before reporting)
// ============================================================

setTimeout(() => {
  summary();
  exitWithCode();
}, 1000);
