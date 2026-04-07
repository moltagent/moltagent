/**
 * Deck Client Unit Tests
 *
 * Architecture Brief:
 * -------------------
 * Problem: The Deck client needs automated unit tests that verify client logic,
 * caching, error handling, and task flow methods without requiring a real Nextcloud server.
 *
 * Pattern: Mock-based unit testing with isolated component verification.
 * - Mock NCRequestManager to simulate Deck API responses
 * - Test each public method including task management helpers
 * - Verify cache behavior, error handling, and state management
 *
 * Key Dependencies:
 * - NCRequestManager (mocked)
 * - appConfig for default settings
 *
 * Data Flow:
 * Test -> DeckClient -> MockNCRequestManager -> Simulated Response
 *
 * Run: node test/unit/integrations/deck-client.test.js
 *
 * @module test/unit/integrations/deck-client
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const { createMockNCRequestManager } = require('../../helpers/mock-factories');

// Import module under test
const DeckClient = require('../../../src/lib/integrations/deck-client');
const DECK = require('../../../src/config/deck-names');

// ============================================================
// Test Fixtures
// ============================================================

/**
 * Sample board list response
 */
const SAMPLE_BOARDS = [
  {
    id: 1,
    title: DECK.boards.tasks,
    owner: { uid: 'testuser' },
    color: '0082c9',
    archived: false
  },
  {
    id: 2,
    title: 'Other Board',
    owner: { uid: 'testuser' },
    color: 'ff0000',
    archived: false
  }
];

/**
 * Sample full board with stacks and labels
 */
const SAMPLE_FULL_BOARD = {
  id: 1,
  title: DECK.boards.tasks,
  owner: { uid: 'testuser' },
  color: '0082c9',
  stacks: [
    { id: 101, title: 'Inbox', order: 0, cards: [] },
    { id: 102, title: 'Queued', order: 1, cards: [] },
    { id: 103, title: 'Working', order: 2, cards: [] },
    { id: 104, title: 'Review', order: 3, cards: [] },
    { id: 105, title: 'Done', order: 4, cards: [] },
    { id: 106, title: 'Reference', order: 5, cards: [] }
  ],
  labels: [
    { id: 201, title: 'urgent', color: 'ED1C24' },
    { id: 202, title: 'research', color: '0082C9' },
    { id: 203, title: 'writing', color: '2ECC71' },
    { id: 204, title: 'admin', color: '7F8C8D' },
    { id: 205, title: 'blocked', color: 'F39C12' }
  ],
  users: [
    { uid: 'testuser', primaryKey: 'testuser' },
    { uid: 'moltagent', primaryKey: 'moltagent' }
  ]
};

/**
 * Sample cards in inbox stack
 */
const SAMPLE_INBOX_STACK = {
  id: 101,
  title: 'Inbox',
  cards: [
    {
      id: 1001,
      title: 'Task 1',
      description: 'First task description',
      labels: [{ id: 201, title: 'urgent' }],
      owner: { uid: 'testuser' },
      assignedUsers: [],
      createdAt: Math.floor(Date.now() / 1000) - 3600,
      lastModified: Math.floor(Date.now() / 1000) - 1800
    },
    {
      id: 1002,
      title: 'Task 2',
      description: 'Second task description',
      labels: [],
      owner: { uid: 'testuser' },
      assignedUsers: [{ participant: { uid: 'moltagent' } }],
      createdAt: Math.floor(Date.now() / 1000) - 7200,
      lastModified: Math.floor(Date.now() / 1000) - 3600
    }
  ]
};

/**
 * Sample card detail
 */
const SAMPLE_CARD = {
  id: 1001,
  title: 'Task 1',
  description: 'Task description here',
  type: 'plain',
  owner: { uid: 'testuser' },
  labels: [{ id: 201, title: 'urgent' }],
  assignedUsers: [],
  duedate: null,
  createdAt: Math.floor(Date.now() / 1000) - 3600,
  lastModified: Math.floor(Date.now() / 1000) - 1800
};

/**
 * Sample comments response (OCS format)
 */
const SAMPLE_COMMENTS = {
  ocs: {
    data: [
      {
        id: 5001,
        message: '[STATUS] Task accepted',
        actorId: 'moltagent',
        creationDateTime: '2025-02-05T10:00:00Z'
      },
      {
        id: 5002,
        message: 'Can you also check the budget?',
        actorId: 'testuser',
        creationDateTime: '2025-02-05T11:00:00Z'
      }
    ]
  }
};

// ============================================================
// Mock Factory Helpers
// ============================================================

/**
 * Create Deck-specific mock NCRequestManager
 * @param {Object} overrides - Custom response overrides
 * @returns {Object} Mock NCRequestManager with Deck responses
 */
function createDeckMockNC(overrides = {}) {
  const defaultResponses = {
    // List boards
    'GET:/index.php/apps/deck/api/v1.0/boards': {
      status: 200,
      body: SAMPLE_BOARDS,
      headers: {}
    },
    // Get full board
    'GET:/index.php/apps/deck/api/v1.0/boards/1': {
      status: 200,
      body: SAMPLE_FULL_BOARD,
      headers: {}
    },
    // List all stacks with cards (used by getAllCards/getWorkloadSummary)
    'GET:/index.php/apps/deck/api/v1.0/boards/1/stacks': {
      status: 200,
      body: SAMPLE_FULL_BOARD.stacks,
      headers: {}
    },
    // Get inbox stack
    'GET:/index.php/apps/deck/api/v1.0/boards/1/stacks/101': {
      status: 200,
      body: SAMPLE_INBOX_STACK,
      headers: {}
    },
    // Get card
    'GET:/index.php/apps/deck/api/v1.0/boards/1/stacks/101/cards/1001': {
      status: 200,
      body: SAMPLE_CARD,
      headers: {}
    },
    // Create card
    'POST:/index.php/apps/deck/api/v1.0/boards/1/stacks/101/cards': {
      status: 200,
      body: { id: 1003, title: 'New Card', description: '' },
      headers: {}
    },
    // Update card
    'PUT:/index.php/apps/deck/api/v1.0/boards/1/stacks/101/cards/1001': {
      status: 200,
      body: SAMPLE_CARD,
      headers: {}
    },
    // Delete card
    'DELETE:/index.php/apps/deck/api/v1.0/boards/1/stacks/101/cards/1001': {
      status: 200,
      body: { success: true },
      headers: {}
    },
    // Move card (internal endpoint)
    'PUT:/index.php/apps/deck/cards/1001/reorder': {
      status: 200,
      body: { success: true },
      headers: {}
    },
    // Add comment
    'POST:/ocs/v2.php/apps/deck/api/v1.0/cards/1001/comments': {
      status: 200,
      body: { id: 5003, message: 'Test comment' },
      headers: {}
    },
    // Get comments
    'GET:/ocs/v2.php/apps/deck/api/v1.0/cards/1001/comments': {
      status: 200,
      body: SAMPLE_COMMENTS,
      headers: {}
    },
    // Assign label
    'PUT:/index.php/apps/deck/api/v1.0/boards/1/stacks/101/cards/1001/assignLabel': {
      status: 200,
      body: { success: true },
      headers: {}
    },
    // Assign user
    'PUT:/index.php/apps/deck/api/v1.0/boards/1/stacks/101/cards/1001/assignUser': {
      status: 200,
      body: { success: true },
      headers: {}
    }
  };

  const responses = { ...defaultResponses, ...overrides };

  return {
    ncUrl: 'https://cloud.example.com',
    ncUser: 'testuser',
    request: async (path, options = {}) => {
      const method = options.method || 'GET';
      const key = `${method}:${path}`;

      // Try exact match
      if (responses[key]) {
        const response = responses[key];
        if (typeof response === 'function') {
          return response(path, options);
        }
        // Check for error status
        if (response.status >= 400) {
          const error = new Error(response.body?.message || `HTTP ${response.status}`);
          error.statusCode = response.status;
          error.response = response.body;
          throw error;
        }
        return response;
      }

      // Try prefix match
      for (const [matchKey, response] of Object.entries(responses)) {
        if (key.startsWith(matchKey.replace(/\/\d+$/, ''))) {
          if (typeof response === 'function') {
            return response(path, options);
          }
          return response;
        }
      }

      // Default 404
      return { status: 404, body: { message: 'Not found' }, headers: {} };
    },
    getMetrics: () => ({ totalRequests: 0, cacheHits: 0 }),
    invalidateCache: () => {},
    shutdown: async () => {}
  };
}

// ============================================================
// Test Suites
// ============================================================

console.log('\n=== DeckClient Tests ===\n');

// --- Constructor Tests ---
console.log('\n--- Constructor Tests ---\n');

test('TC-CTOR-001: Initialize with NCRequestManager', () => {
  const mockNC = createDeckMockNC();

  const client = new DeckClient(mockNC, { boardName: 'Test Board' });

  assert.strictEqual(client.nc, mockNC);
  assert.strictEqual(client.boardName, 'Test Board');
  assert.strictEqual(client.username, 'testuser');
});

test('TC-CTOR-002: Initialize with default board name', () => {
  const mockNC = createDeckMockNC();

  const client = new DeckClient(mockNC);

  assert.strictEqual(client.boardName, DECK.boards.tasks);
});

test('TC-CTOR-003: Initialize default stack names', () => {
  const mockNC = createDeckMockNC();

  const client = new DeckClient(mockNC);

  assert.strictEqual(client.stackNames.inbox, 'Inbox');
  assert.strictEqual(client.stackNames.queued, 'Queued');
  assert.strictEqual(client.stackNames.working, 'Working');
  assert.strictEqual(client.stackNames.review, 'Review');
  assert.strictEqual(client.stackNames.done, 'Done');
  assert.strictEqual(client.stackNames.reference, 'Reference');
});

test('TC-CTOR-004: Initialize default labels', () => {
  const mockNC = createDeckMockNC();

  const client = new DeckClient(mockNC);

  assert.strictEqual(client.labelDefs.length, 5);
  assert.ok(client.labelDefs.some(l => l.title === 'urgent'));
  assert.ok(client.labelDefs.some(l => l.title === 'blocked'));
});

test('TC-CTOR-005: Initialize empty cache', () => {
  const mockNC = createDeckMockNC();

  const client = new DeckClient(mockNC);

  assert.strictEqual(client._cache.boardId, null);
  assert.deepStrictEqual(client._cache.stacks, {});
  assert.deepStrictEqual(client._cache.labels, {});
});

test('TC-CTOR-006: Accept custom configuration', () => {
  const mockNC = createDeckMockNC();

  const client = new DeckClient(mockNC, {
    boardName: 'Custom Board',
    archiveAfterDays: 30,
    stacks: {
      inbox: 'New Items',
      done: 'Completed'
    }
  });

  assert.strictEqual(client.boardName, 'Custom Board');
  assert.strictEqual(client.archiveAfterDays, 30);
  assert.strictEqual(client.stackNames.inbox, 'New Items');
});

// --- Board Operations Tests ---
console.log('\n--- Board Operations Tests ---\n');

asyncTest('TC-BOARD-001: List all boards', async () => {
  const mockNC = createDeckMockNC();
  const client = new DeckClient(mockNC);

  const boards = await client.listBoards();

  assert.ok(Array.isArray(boards));
  assert.strictEqual(boards.length, 2);
  assert.strictEqual(boards[0].title, DECK.boards.tasks);
});

asyncTest('TC-BOARD-002: Find board by name', async () => {
  const mockNC = createDeckMockNC();
  const client = new DeckClient(mockNC);

  const board = await client.findBoard();

  assert.ok(board);
  assert.strictEqual(board.id, 1);
  assert.strictEqual(board.title, DECK.boards.tasks);
});

asyncTest('TC-BOARD-003: Return null when board not found', async () => {
  const mockNC = createDeckMockNC();
  const client = new DeckClient(mockNC, { boardName: 'Nonexistent Board' });

  const board = await client.findBoard();

  assert.strictEqual(board, null);
});

asyncTest('TC-BOARD-004: Get full board details', async () => {
  const mockNC = createDeckMockNC();
  const client = new DeckClient(mockNC);

  const board = await client.getBoard(1);

  assert.strictEqual(board.id, 1);
  assert.ok(Array.isArray(board.stacks));
  assert.ok(Array.isArray(board.labels));
  assert.strictEqual(board.stacks.length, 6);
});

asyncTest('TC-BOARD-005: Ensure board returns cached data', async () => {
  let requestCount = 0;
  const mockNC = createDeckMockNC({
    'GET:/index.php/apps/deck/api/v1.0/boards': () => {
      requestCount++;
      return { status: 200, body: SAMPLE_BOARDS, headers: {} };
    },
    'GET:/index.php/apps/deck/api/v1.0/boards/1': () => {
      requestCount++;
      return { status: 200, body: SAMPLE_FULL_BOARD, headers: {} };
    }
  });
  const client = new DeckClient(mockNC);

  await client.ensureBoard();
  const firstCount = requestCount;

  await client.ensureBoard();

  // Should use cache on second call
  assert.strictEqual(requestCount, firstCount);
});

asyncTest('TC-BOARD-006: Ensure board maps stacks correctly', async () => {
  const mockNC = createDeckMockNC();
  const client = new DeckClient(mockNC);

  const { boardId, stacks, labels } = await client.ensureBoard();

  assert.strictEqual(boardId, 1);
  assert.strictEqual(stacks.inbox, 101);
  assert.strictEqual(stacks.queued, 102);
  assert.strictEqual(stacks.working, 103);
  assert.strictEqual(stacks.done, 105);
  assert.strictEqual(labels.urgent, 201);
  assert.strictEqual(labels.blocked, 205);
});

asyncTest('TC-BOARD-007: Create board when not found', async () => {
  let createCalled = false;
  let stacksCreated = [];

  const mockNC = createDeckMockNC({
    'GET:/index.php/apps/deck/api/v1.0/boards': {
      status: 200,
      body: [], // No boards
      headers: {}
    },
    'POST:/index.php/apps/deck/api/v1.0/boards': () => {
      createCalled = true;
      return { status: 200, body: { id: 99, title: DECK.boards.tasks }, headers: {} };
    },
    'POST:/index.php/apps/deck/api/v1.0/boards/99/stacks': (path, options) => {
      stacksCreated.push(options.body.title);
      return { status: 200, body: { id: 100 + stacksCreated.length, title: options.body.title }, headers: {} };
    },
    'POST:/index.php/apps/deck/api/v1.0/boards/99/labels': {
      status: 200,
      body: { id: 300 },
      headers: {}
    }
  });
  const client = new DeckClient(mockNC);

  const result = await client.ensureBoard();

  assert.strictEqual(createCalled, true);
  assert.ok(stacksCreated.includes('Inbox'));
  assert.ok(stacksCreated.includes('Done'));
  assert.strictEqual(result.created, true);
});

// --- Cache Management Tests ---
console.log('\n--- Cache Management Tests ---\n');

test('TC-CACHE-001: Clear cache resets all state', () => {
  const mockNC = createDeckMockNC();
  const client = new DeckClient(mockNC);

  // Manually set cache
  client._cache = {
    boardId: 1,
    stacks: { inbox: 101 },
    labels: { urgent: 201 },
    lastRefresh: Date.now()
  };

  client.clearCache();

  assert.strictEqual(client._cache.boardId, null);
  assert.deepStrictEqual(client._cache.stacks, {});
  assert.deepStrictEqual(client._cache.labels, {});
  assert.strictEqual(client._cache.lastRefresh, 0);
});

asyncTest('TC-CACHE-002: Cache expires after max age', async () => {
  let requestCount = 0;
  const mockNC = createDeckMockNC({
    'GET:/index.php/apps/deck/api/v1.0/boards': () => {
      requestCount++;
      return { status: 200, body: SAMPLE_BOARDS, headers: {} };
    },
    'GET:/index.php/apps/deck/api/v1.0/boards/1': () => {
      requestCount++;
      return { status: 200, body: SAMPLE_FULL_BOARD, headers: {} };
    }
  });
  const client = new DeckClient(mockNC);
  client._cacheMaxAge = 0; // Expire immediately

  await client.ensureBoard();
  const firstCount = requestCount;

  await client.ensureBoard();

  // Cache should have expired, triggering new requests
  assert.ok(requestCount > firstCount);
});

// --- Stack Operations Tests ---
console.log('\n--- Stack Operations Tests ---\n');

asyncTest('TC-STACK-001: Get cards in stack', async () => {
  const mockNC = createDeckMockNC();
  const client = new DeckClient(mockNC);

  const cards = await client.getCardsInStack('inbox');

  assert.ok(Array.isArray(cards));
  assert.strictEqual(cards.length, 2);
  assert.strictEqual(cards[0].title, 'Task 1');
});

asyncTest('TC-STACK-002: Unknown stack throws error', async () => {
  const mockNC = createDeckMockNC();
  const client = new DeckClient(mockNC);

  try {
    await client.getCardsInStack('nonexistent');
    assert.fail('Should have thrown error');
  } catch (error) {
    assert.ok(error.message.includes('Unknown stack'));
  }
});

asyncTest('TC-STACK-003: Get all cards from all stacks', async () => {
  const mockNC = createDeckMockNC({
    'GET:/index.php/apps/deck/api/v1.0/boards/1/stacks': {
      status: 200,
      body: SAMPLE_FULL_BOARD.stacks.map(s =>
        s.id === 101 ? { ...s, cards: SAMPLE_INBOX_STACK.cards } : s
      ),
      headers: {}
    }
  });
  const client = new DeckClient(mockNC);

  const allCards = await client.getAllCards();

  assert.ok(typeof allCards === 'object');
  assert.ok('inbox' in allCards);
  assert.ok('done' in allCards);
});

// --- Card Operations Tests ---
console.log('\n--- Card Operations Tests ---\n');

asyncTest('TC-CARD-001: Create card in stack', async () => {
  let capturedBody = null;

  const mockNC = createDeckMockNC({
    'POST:/index.php/apps/deck/api/v1.0/boards/1/stacks/101/cards': (path, options) => {
      capturedBody = options.body;
      return { status: 200, body: { id: 1003, title: options.body.title }, headers: {} };
    }
  });
  const client = new DeckClient(mockNC);

  const card = await client.createCard('inbox', {
    title: 'New Task',
    description: 'Task description'
  });

  assert.strictEqual(card.id, 1003);
  assert.strictEqual(capturedBody.title, 'New Task');
  assert.strictEqual(capturedBody.description, 'Task description');
});

asyncTest('TC-CARD-002: Create card with labels', async () => {
  let labelAssigned = false;

  const mockNC = createDeckMockNC({
    'POST:/index.php/apps/deck/api/v1.0/boards/1/stacks/101/cards': {
      status: 200,
      body: { id: 1003, title: 'Test' },
      headers: {}
    },
    'PUT:/index.php/apps/deck/api/v1.0/boards/1/stacks/101/cards/1003/assignLabel': () => {
      labelAssigned = true;
      return { status: 200, body: { success: true }, headers: {} };
    }
  });
  const client = new DeckClient(mockNC);

  await client.createCard('inbox', {
    title: 'Urgent Task',
    labels: ['urgent']
  });

  assert.strictEqual(labelAssigned, true);
});

asyncTest('TC-CARD-003: Get card details', async () => {
  const mockNC = createDeckMockNC();
  const client = new DeckClient(mockNC);

  const card = await client.getCard(1001, 'inbox');

  assert.strictEqual(card.id, 1001);
  assert.strictEqual(card.title, 'Task 1');
  assert.strictEqual(card.type, 'plain');
});

asyncTest('TC-CARD-004: Update card', async () => {
  let capturedUpdates = null;

  const mockNC = createDeckMockNC({
    'PUT:/index.php/apps/deck/api/v1.0/boards/1/stacks/101/cards/1001': (path, options) => {
      capturedUpdates = options.body;
      return { status: 200, body: { ...SAMPLE_CARD, ...options.body }, headers: {} };
    }
  });
  const client = new DeckClient(mockNC);

  const updated = await client.updateCard(1001, 'inbox', {
    title: 'Updated Title',
    description: 'Updated description'
  });

  assert.strictEqual(capturedUpdates.title, 'Updated Title');
  assert.strictEqual(capturedUpdates.description, 'Updated description');
});

asyncTest('TC-CARD-005: Delete card', async () => {
  let deleteCalled = false;

  const mockNC = createDeckMockNC({
    'DELETE:/index.php/apps/deck/api/v1.0/boards/1/stacks/101/cards/1001': () => {
      deleteCalled = true;
      return { status: 200, body: { success: true }, headers: {} };
    }
  });
  const client = new DeckClient(mockNC);

  await client.deleteCard(1001, 'inbox');

  assert.strictEqual(deleteCalled, true);
});

asyncTest('TC-CARD-006: Move card between stacks', async () => {
  let moveParams = null;

  const mockNC = createDeckMockNC({
    'PUT:/index.php/apps/deck/cards/1001/reorder': (path, options) => {
      moveParams = options.body;
      return { status: 200, body: { success: true }, headers: {} };
    }
  });
  const client = new DeckClient(mockNC);

  await client.moveCard(1001, 'inbox', 'working');

  assert.strictEqual(moveParams.stackId, 103); // working stack ID
  assert.strictEqual(moveParams.order, 0);
});

asyncTest('TC-CARD-007: Move card with custom order', async () => {
  let moveParams = null;

  const mockNC = createDeckMockNC({
    'PUT:/index.php/apps/deck/cards/1001/reorder': (path, options) => {
      moveParams = options.body;
      return { status: 200, body: { success: true }, headers: {} };
    }
  });
  const client = new DeckClient(mockNC);

  await client.moveCard(1001, 'inbox', 'working', 5);

  assert.strictEqual(moveParams.order, 5);
});

// --- Comment Operations Tests ---
console.log('\n--- Comment Operations Tests ---\n');

asyncTest('TC-COMMENT-001: Add comment to card', async () => {
  let capturedMessage = null;

  const mockNC = createDeckMockNC({
    'POST:/ocs/v2.php/apps/deck/api/v1.0/cards/1001/comments': (path, options) => {
      capturedMessage = options.body.message;
      return { status: 200, body: { id: 5003, message: options.body.message }, headers: {} };
    }
  });
  const client = new DeckClient(mockNC);

  await client.addComment(1001, 'Test comment', 'STATUS');

  assert.ok(capturedMessage.includes('[STATUS]'));
  assert.ok(capturedMessage.includes('Test comment'));
});

asyncTest('TC-COMMENT-002: Get comments from card', async () => {
  const mockNC = createDeckMockNC();
  const client = new DeckClient(mockNC);

  const comments = await client.getComments(1001);

  assert.ok(Array.isArray(comments));
  assert.strictEqual(comments.length, 2);
  assert.ok(comments[0].message.includes('[STATUS]'));
});

asyncTest('TC-COMMENT-003: Comment type prefix is applied', async () => {
  let capturedMessage = null;

  const mockNC = createDeckMockNC({
    'POST:/ocs/v2.php/apps/deck/api/v1.0/cards/1001/comments': (path, options) => {
      capturedMessage = options.body.message;
      return { status: 200, body: {}, headers: {} };
    }
  });
  const client = new DeckClient(mockNC);

  await client.addComment(1001, 'Progress update', 'PROGRESS');

  assert.strictEqual(capturedMessage, '[PROGRESS] Progress update');
});

// --- Label Operations Tests ---
console.log('\n--- Label Operations Tests ---\n');

asyncTest('TC-LABEL-001: Add label to card', async () => {
  let labelRequest = null;

  const mockNC = createDeckMockNC({
    'PUT:/index.php/apps/deck/api/v1.0/boards/1/stacks/101/cards/1001/assignLabel': (path, options) => {
      labelRequest = options.body;
      return { status: 200, body: { success: true }, headers: {} };
    }
  });
  const client = new DeckClient(mockNC);

  await client.addLabel(1001, 'inbox', 'urgent');

  assert.strictEqual(labelRequest.labelId, 201);
});

asyncTest('TC-LABEL-002: Unknown label throws error', async () => {
  const mockNC = createDeckMockNC();
  const client = new DeckClient(mockNC);

  try {
    await client.addLabel(1001, 'inbox', 'nonexistent');
    assert.fail('Should have thrown error');
  } catch (error) {
    assert.ok(error.message.includes('Unknown label'));
  }
});

asyncTest('TC-LABEL-003: Remove label from card', async () => {
  let removeRequest = null;

  const mockNC = createDeckMockNC({
    'PUT:/index.php/apps/deck/api/v1.0/boards/1/stacks/101/cards/1001/removeLabel': (path, options) => {
      removeRequest = options.body;
      return { status: 200, body: { success: true }, headers: {} };
    }
  });
  const client = new DeckClient(mockNC);

  await client.removeLabel(1001, 'inbox', 'urgent');

  assert.strictEqual(removeRequest.labelId, 201);
});

// --- Task Management Helpers Tests ---
console.log('\n--- Task Management Helpers Tests ---\n');

asyncTest('TC-TASK-001: Scan inbox returns formatted tasks', async () => {
  const mockNC = createDeckMockNC();
  const client = new DeckClient(mockNC);

  const tasks = await client.scanInbox();

  assert.ok(Array.isArray(tasks));
  assert.strictEqual(tasks.length, 2);
  assert.strictEqual(tasks[0].id, 1001);
  assert.strictEqual(tasks[0].title, 'Task 1');
  assert.strictEqual(tasks[0].urgent, true);
  assert.strictEqual(tasks[1].urgent, false);
});

asyncTest('TC-TASK-002: Get workload summary', async () => {
  const mockNC = createDeckMockNC({
    'GET:/index.php/apps/deck/api/v1.0/boards/1/stacks': {
      status: 200,
      body: SAMPLE_FULL_BOARD.stacks.map(s =>
        s.id === 101 ? { ...s, cards: SAMPLE_INBOX_STACK.cards } : s
      ),
      headers: {}
    }
  });
  const client = new DeckClient(mockNC);

  const summary = await client.getWorkloadSummary();

  assert.strictEqual(summary.inbox, 2);
  assert.strictEqual(summary.total, 2);
  assert.ok('queued' in summary);
  assert.ok('working' in summary);
  assert.ok('done' in summary);
});

asyncTest('TC-TASK-003: Accept task moves to queued', async () => {
  let movedTo = null;
  let commentAdded = false;

  const mockNC = createDeckMockNC({
    'POST:/ocs/v2.php/apps/deck/api/v1.0/cards/1001/comments': () => {
      commentAdded = true;
      return { status: 200, body: {}, headers: {} };
    },
    'PUT:/index.php/apps/deck/cards/1001/reorder': (path, options) => {
      movedTo = options.body.stackId;
      return { status: 200, body: { success: true }, headers: {} };
    }
  });
  const client = new DeckClient(mockNC);

  await client.acceptTask(1001);

  assert.strictEqual(movedTo, 102); // queued stack
  assert.strictEqual(commentAdded, true);
});

asyncTest('TC-TASK-004: Start task moves to working', async () => {
  let movedTo = null;

  const mockNC = createDeckMockNC({
    'POST:/ocs/v2.php/apps/deck/api/v1.0/cards/1001/comments': {
      status: 200,
      body: {},
      headers: {}
    },
    'PUT:/index.php/apps/deck/cards/1001/reorder': (path, options) => {
      movedTo = options.body.stackId;
      return { status: 200, body: { success: true }, headers: {} };
    }
  });
  const client = new DeckClient(mockNC);

  await client.startTask(1001);

  assert.strictEqual(movedTo, 103); // working stack
});

asyncTest('TC-TASK-005: Complete task moves to done', async () => {
  let movedTo = null;

  const mockNC = createDeckMockNC({
    'POST:/ocs/v2.php/apps/deck/api/v1.0/cards/1001/comments': {
      status: 200,
      body: {},
      headers: {}
    },
    'PUT:/index.php/apps/deck/cards/1001/reorder': (path, options) => {
      movedTo = options.body.stackId;
      return { status: 200, body: { success: true }, headers: {} };
    }
  });
  const client = new DeckClient(mockNC);

  await client.completeTask(1001, 'Task completed successfully');

  assert.strictEqual(movedTo, 105); // done stack
});

asyncTest('TC-TASK-006: Block task moves to inbox with question', async () => {
  let movedTo = null;
  let commentType = null;

  const mockNC = createDeckMockNC({
    'GET:/index.php/apps/deck/api/v1.0/boards/1/stacks/103/cards/1001': {
      status: 200,
      body: SAMPLE_CARD,
      headers: {}
    },
    'POST:/ocs/v2.php/apps/deck/api/v1.0/cards/1001/comments': (path, options) => {
      commentType = options.body.message.match(/\[(\w+)\]/)?.[1];
      return { status: 200, body: {}, headers: {} };
    },
    'PUT:/index.php/apps/deck/api/v1.0/boards/1/stacks/103/cards/1001/assignLabel': {
      status: 200,
      body: {},
      headers: {}
    },
    'PUT:/index.php/apps/deck/cards/1001/reorder': (path, options) => {
      movedTo = options.body.stackId;
      return { status: 200, body: { success: true }, headers: {} };
    }
  });
  const client = new DeckClient(mockNC);

  await client.blockTask(1001, 'Need clarification on requirements');

  assert.strictEqual(movedTo, 101); // inbox stack
  assert.strictEqual(commentType, 'QUESTION');
});

asyncTest('TC-TASK-007: Fail task adds error comment and moves to inbox', async () => {
  let commentType = null;
  let commentMessage = null;
  let movedTo = null;

  const mockNC = createDeckMockNC({
    'POST:/ocs/v2.php/apps/deck/api/v1.0/cards/1001/comments': (path, options) => {
      commentType = options.body.message.match(/\[(\w+)\]/)?.[1];
      commentMessage = options.body.message;
      return { status: 200, body: {}, headers: {} };
    },
    'PUT:/index.php/apps/deck/cards/1001/reorder': (path, options) => {
      movedTo = options.body.stackId;
      return { status: 200, body: { success: true }, headers: {} };
    }
  });
  const client = new DeckClient(mockNC);

  await client.failTask(1001, 'working', 'Error occurred');

  assert.strictEqual(commentType, 'ERROR');
  assert.ok(commentMessage.includes('Could not complete task'));
  assert.strictEqual(movedTo, 101); // moves back to inbox
});

// --- Review Flow Tests ---
console.log('\n--- Review Flow Tests ---\n');

asyncTest('TC-REVIEW-001: Submit for review updates description and moves card', async () => {
  let updatedDescription = null;
  let movedTo = null;

  const mockNC = createDeckMockNC({
    'GET:/index.php/apps/deck/api/v1.0/boards/1/stacks/103/cards/1001': {
      status: 200,
      body: { ...SAMPLE_CARD, description: 'Original description' },
      headers: {}
    },
    'PUT:/index.php/apps/deck/api/v1.0/boards/1/stacks/103/cards/1001': (path, options) => {
      updatedDescription = options.body.description;
      return { status: 200, body: options.body, headers: {} };
    },
    'POST:/ocs/v2.php/apps/deck/api/v1.0/cards/1001/comments': {
      status: 200,
      body: {},
      headers: {}
    },
    'PUT:/index.php/apps/deck/cards/1001/reorder': (path, options) => {
      movedTo = options.body.stackId;
      return { status: 200, body: { success: true }, headers: {} };
    }
  });
  const client = new DeckClient(mockNC);

  await client.submitForReview(1001, 'working', 'Original task', 'LLM response here');

  assert.ok(updatedDescription.includes('## Original Task'));
  assert.ok(updatedDescription.includes('## Moltagent Response'));
  assert.ok(updatedDescription.includes('LLM response here'));
  assert.strictEqual(movedTo, 104); // review stack
});

asyncTest('TC-REVIEW-002: Scan review cards filters human comments', async () => {
  const reviewStack = {
    id: 104,
    title: 'Review',
    cards: [{
      id: 2001,
      title: 'Review Task',
      description: 'Test',
      labels: [],
      createdAt: Math.floor(Date.now() / 1000),
      lastModified: Math.floor(Date.now() / 1000)
    }]
  };

  const mockNC = createDeckMockNC({
    'GET:/index.php/apps/deck/api/v1.0/boards/1/stacks/104': {
      status: 200,
      body: reviewStack,
      headers: {}
    },
    'GET:/ocs/v2.php/apps/deck/api/v1.0/cards/2001/comments': {
      status: 200,
      body: SAMPLE_COMMENTS,
      headers: {}
    }
  });
  const client = new DeckClient(mockNC);

  const reviewCards = await client.scanReviewCards();

  assert.ok(Array.isArray(reviewCards));
  // Should have human comments (the second comment in SAMPLE_COMMENTS)
  if (reviewCards.length > 0) {
    assert.ok(reviewCards[0].humanComments.length > 0);
    // Human comment should not have bot prefix
    assert.ok(!reviewCards[0].humanComments[0].message.startsWith('[STATUS]'));
  }
});

asyncTest('TC-REVIEW-003: Complete review moves to done', async () => {
  let movedTo = null;

  const mockNC = createDeckMockNC({
    'POST:/ocs/v2.php/apps/deck/api/v1.0/cards/1001/comments': {
      status: 200,
      body: {},
      headers: {}
    },
    'PUT:/index.php/apps/deck/cards/1001/reorder': (path, options) => {
      movedTo = options.body.stackId;
      return { status: 200, body: { success: true }, headers: {} };
    }
  });
  const client = new DeckClient(mockNC);

  await client.completeReview(1001);

  assert.strictEqual(movedTo, 105); // done stack
});

asyncTest('TC-REVIEW-004: Respond to feedback adds comment', async () => {
  let commentMessage = null;

  const mockNC = createDeckMockNC({
    'POST:/ocs/v2.php/apps/deck/api/v1.0/cards/1001/comments': (path, options) => {
      commentMessage = options.body.message;
      return { status: 200, body: {}, headers: {} };
    }
  });
  const client = new DeckClient(mockNC);

  await client.respondToFeedback(1001, 'Here is the additional info');

  assert.ok(commentMessage.includes('[FOLLOWUP]'));
  assert.ok(commentMessage.includes('additional info'));
});

// --- User Assignment Tests ---
console.log('\n--- User Assignment Tests ---\n');

asyncTest('TC-ASSIGN-001: Assign user to card', async () => {
  let assignedUser = null;

  const mockNC = createDeckMockNC({
    'PUT:/index.php/apps/deck/api/v1.0/boards/1/stacks/101/cards/1001/assignUser': (path, options) => {
      assignedUser = options.body.userId;
      return { status: 200, body: { success: true }, headers: {} };
    }
  });
  const client = new DeckClient(mockNC);

  await client.assignUser(1001, 'inbox', 'moltagent');

  assert.strictEqual(assignedUser, 'moltagent');
});

asyncTest('TC-ASSIGN-002: Ensure assignments adds both bot and creator', async () => {
  const assignedUsers = [];

  const mockNC = createDeckMockNC({
    'PUT:/index.php/apps/deck/api/v1.0/boards/1/stacks/101/cards/1001/assignUser': (path, options) => {
      assignedUsers.push(options.body.userId);
      return { status: 200, body: { success: true }, headers: {} };
    }
  });
  const client = new DeckClient(mockNC);
  client.username = 'moltagent';

  await client.ensureAssignments(1001, 'inbox', 'testuser');

  assert.ok(assignedUsers.includes('moltagent'));
  assert.ok(assignedUsers.includes('testuser'));
});

asyncTest('TC-ASSIGN-003: Skip assignment if user not on board', async () => {
  let assignCalled = false;

  const mockNC = createDeckMockNC({
    'PUT:/index.php/apps/deck/api/v1.0/boards/1/stacks/101/cards/1001/assignUser': () => {
      assignCalled = true;
      return { status: 200, body: {}, headers: {} };
    }
  });
  const client = new DeckClient(mockNC);

  await client.assignUser(1001, 'inbox', 'nonexistent_user');

  assert.strictEqual(assignCalled, false);
});

// --- Cleanup Tests ---
console.log('\n--- Cleanup Tests ---\n');

asyncTest('TC-CLEANUP-001: Cleanup old cards deletes old done cards', async () => {
  const oldTimestamp = Math.floor(Date.now() / 1000) - (200 * 24 * 60 * 60); // 200 days ago
  const deletedCards = [];

  const mockNC = createDeckMockNC({
    'GET:/index.php/apps/deck/api/v1.0/boards/1/stacks/105': {
      status: 200,
      body: {
        id: 105,
        title: 'Done',
        cards: [
          { id: 3001, title: 'Old Task', lastModified: oldTimestamp },
          { id: 3002, title: 'Recent Task', lastModified: Math.floor(Date.now() / 1000) }
        ]
      },
      headers: {}
    },
    'DELETE:/index.php/apps/deck/api/v1.0/boards/1/stacks/105/cards/3001': () => {
      deletedCards.push(3001);
      return { status: 200, body: { success: true }, headers: {} };
    },
    'DELETE:/index.php/apps/deck/api/v1.0/boards/1/stacks/105/cards/3002': () => {
      deletedCards.push(3002);
      return { status: 200, body: { success: true }, headers: {} };
    }
  });
  const client = new DeckClient(mockNC);
  client.archiveAfterDays = 180;

  const archived = await client.cleanupOldCards();

  assert.strictEqual(archived, 1);
  assert.ok(deletedCards.includes(3001));
  assert.ok(!deletedCards.includes(3002)); // Recent card not deleted
});

// --- Error Handling Tests ---
console.log('\n--- Error Handling Tests ---\n');

asyncTest('TC-ERR-001: Throws when NCRequestManager not provided', async () => {
  const client = new DeckClient(null);

  try {
    await client.listBoards();
    assert.fail('Should have thrown error');
  } catch (error) {
    assert.ok(error.message.includes('requires NCRequestManager'));
  }
});

asyncTest('TC-ERR-002: DeckApiError includes status code', async () => {
  const mockNC = createDeckMockNC({
    'GET:/index.php/apps/deck/api/v1.0/boards': () => {
      const error = new Error('Forbidden');
      error.statusCode = 403;
      throw error;
    }
  });
  const client = new DeckClient(mockNC);

  try {
    await client.listBoards();
    assert.fail('Should have thrown error');
  } catch (error) {
    assert.strictEqual(error.statusCode, 403);
  }
});

asyncTest('TC-ERR-003: Task operations continue on comment failure', async () => {
  let moveCalled = false;

  const mockNC = createDeckMockNC({
    'POST:/ocs/v2.php/apps/deck/api/v1.0/cards/1001/comments': () => {
      throw new Error('Comment failed');
    },
    'PUT:/index.php/apps/deck/cards/1001/reorder': () => {
      moveCalled = true;
      return { status: 200, body: { success: true }, headers: {} };
    }
  });
  const client = new DeckClient(mockNC);

  // Should not throw, should continue to move card
  await client.acceptTask(1001, 'Test');

  assert.strictEqual(moveCalled, true);
});

// --- Scan Assigned Cards Tests ---
console.log('\n--- Scan Assigned Cards Tests ---\n');

asyncTest('TC-SCAN-001: Scan assigned cards returns filtered results', async () => {
  const assignedCard = {
    ...SAMPLE_CARD,
    assignedUsers: [{ participant: { uid: 'moltagent' } }]
  };

  const mockNC = createDeckMockNC({
    'GET:/index.php/apps/deck/api/v1.0/boards/1/stacks/101': {
      status: 200,
      body: { id: 101, title: 'Inbox', cards: [assignedCard] },
      headers: {}
    },
    'GET:/index.php/apps/deck/api/v1.0/boards/1/stacks/102': {
      status: 200,
      body: { id: 102, title: 'Queued', cards: [] },
      headers: {}
    },
    'GET:/index.php/apps/deck/api/v1.0/boards/1/stacks/103': {
      status: 200,
      body: { id: 103, title: 'Working', cards: [] },
      headers: {}
    },
    'GET:/index.php/apps/deck/api/v1.0/boards/1/stacks/104': {
      status: 200,
      body: { id: 104, title: 'Review', cards: [] },
      headers: {}
    }
  });
  const client = new DeckClient(mockNC);
  client.username = 'moltagent';

  const assigned = await client.scanAssignedCards();

  assert.ok(Array.isArray(assigned));
  assert.strictEqual(assigned.length, 1);
  assert.strictEqual(assigned[0].id, 1001);
  assert.strictEqual(assigned[0].stack, 'inbox');
});

// ============================================================
// hasNewerBotResponse utility tests
// ============================================================

const { hasNewerBotResponse, isAwaitingHumanResponse, BOT_PREFIXES } = require('../../../src/lib/integrations/deck-client');

test('TC-DEDUP-001: hasNewerBotResponse returns true when bot comment has higher ID', () => {
  const comments = [
    { id: 100, message: 'Please fix the typo', actorId: 'Jordan' },
    { id: 101, message: '[FOLLOWUP] Done', actorId: 'Moltagent' },
  ];
  assert.strictEqual(hasNewerBotResponse(comments, 'moltagent'), true);
});

test('TC-DEDUP-002: hasNewerBotResponse returns false when human comment has higher ID', () => {
  const comments = [
    { id: 100, message: 'Please fix the typo', actorId: 'Jordan' },
    { id: 101, message: '[FOLLOWUP] Done', actorId: 'Moltagent' },
    { id: 102, message: 'Actually, one more thing...', actorId: 'Jordan' },
  ];
  assert.strictEqual(hasNewerBotResponse(comments, 'moltagent'), false);
});

test('TC-DEDUP-003: hasNewerBotResponse returns false on empty comments', () => {
  assert.strictEqual(hasNewerBotResponse([], 'moltagent'), false);
  assert.strictEqual(hasNewerBotResponse(null, 'moltagent'), false);
});

test('TC-DEDUP-004: hasNewerBotResponse detects bot by actorId even without prefix', () => {
  const comments = [
    { id: 50, message: 'Hello', actorId: 'Jordan' },
    { id: 51, message: 'No prefix here', actorId: 'moltagent' },
  ];
  assert.strictEqual(hasNewerBotResponse(comments, 'moltagent'), true);
});

test('TC-DEDUP-005: hasNewerBotResponse is case-insensitive for bot username', () => {
  const comments = [
    { id: 10, message: 'Check this', actorId: 'jordan' },
    { id: 11, message: '[STATUS] Updated', actorId: 'Moltagent' },
  ];
  assert.strictEqual(hasNewerBotResponse(comments, 'moltagent'), true);
});

test('TC-DEDUP-007: hasNewerBotResponse returns true when only bot comments exist', () => {
  const comments = [
    { id: 1, message: '[STATUS] Started', actorId: 'moltagent' },
  ];
  assert.strictEqual(hasNewerBotResponse(comments, 'moltagent'), true);
});

test('TC-DEDUP-008: hasNewerBotResponse returns false when only human comments exist', () => {
  const comments = [
    { id: 1, message: 'Need help', actorId: 'Jordan' },
  ];
  assert.strictEqual(hasNewerBotResponse(comments, 'moltagent'), false);
});

test('TC-DEDUP-006: BOT_PREFIXES includes all expected prefixes', () => {
  const expected = ['[STATUS]', '[PROGRESS]', '[DONE]', '[QUESTION]', '[ERROR]', '[BLOCKED]', '[REVIEW]', '[FOLLOWUP]', '[MENTION]', '[GATE]'];
  for (const prefix of expected) {
    assert.ok(BOT_PREFIXES.includes(prefix), `Missing prefix: ${prefix}`);
  }
});

// ============================================================
// isAwaitingHumanResponse utility tests
// ============================================================

test('TC-AWAIT-001: bot [QUESTION] as last comment → awaiting human response', () => {
  const comments = [
    { id: 100, message: 'Do this task', actorId: 'Jordan' },
    { id: 101, message: '[QUESTION] Should I proceed with option A or B?', actorId: 'moltagent' },
  ];
  assert.strictEqual(isAwaitingHumanResponse(comments, 'moltagent'), true);
});

test('TC-AWAIT-002: human replied after bot [QUESTION] → not awaiting', () => {
  const comments = [
    { id: 100, message: 'Do this task', actorId: 'Jordan' },
    { id: 101, message: '[QUESTION] Should I proceed with option A or B?', actorId: 'moltagent' },
    { id: 102, message: 'Option A please', actorId: 'Jordan' },
  ];
  assert.strictEqual(isAwaitingHumanResponse(comments, 'moltagent'), false);
});

test('TC-AWAIT-003: bot [STATUS] as last comment → not awaiting (not a question)', () => {
  const comments = [
    { id: 100, message: 'Do this task', actorId: 'Jordan' },
    { id: 101, message: '[STATUS] Task accepted, queued for processing.', actorId: 'moltagent' },
  ];
  assert.strictEqual(isAwaitingHumanResponse(comments, 'moltagent'), false);
});

test('TC-AWAIT-004: no comments → not awaiting', () => {
  assert.strictEqual(isAwaitingHumanResponse([], 'moltagent'), false);
  assert.strictEqual(isAwaitingHumanResponse(null, 'moltagent'), false);
});

test('TC-AWAIT-005: bot [GATE] as last comment → awaiting', () => {
  const comments = [
    { id: 200, message: '[GATE] This requires manual approval before proceeding.', actorId: 'moltagent' },
  ];
  assert.strictEqual(isAwaitingHumanResponse(comments, 'moltagent'), true);
});

test('TC-AWAIT-006: bot [BLOCKED] as last comment → awaiting', () => {
  const comments = [
    { id: 300, message: '[BLOCKED] Waiting for external input.', actorId: 'moltagent' },
  ];
  assert.strictEqual(isAwaitingHumanResponse(comments, 'moltagent'), true);
});

test('TC-AWAIT-007: bot "please confirm" in message → awaiting', () => {
  const comments = [
    { id: 400, message: '[STATUS] Ready to send email. Please confirm the action.', actorId: 'moltagent' },
  ];
  assert.strictEqual(isAwaitingHumanResponse(comments, 'moltagent'), true);
});

test('TC-AWAIT-008: bot [PROGRESS] as last comment → not awaiting', () => {
  const comments = [
    { id: 500, message: '[PROGRESS] Working on research...', actorId: 'moltagent' },
  ];
  assert.strictEqual(isAwaitingHumanResponse(comments, 'moltagent'), false);
});

test('TC-AWAIT-009: bot [DONE] as last comment → not awaiting', () => {
  const comments = [
    { id: 600, message: '[DONE] Task completed.', actorId: 'moltagent' },
  ];
  assert.strictEqual(isAwaitingHumanResponse(comments, 'moltagent'), false);
});

test('TC-AWAIT-010: comments in non-ID order still finds latest by ID', () => {
  // Array order doesn't match ID order
  const comments = [
    { id: 102, message: '[QUESTION] Confirm?', actorId: 'moltagent' },
    { id: 100, message: 'Start this', actorId: 'Jordan' },
    { id: 101, message: '[STATUS] Accepted', actorId: 'moltagent' },
  ];
  assert.strictEqual(isAwaitingHumanResponse(comments, 'moltagent'), true);
});

test('TC-AWAIT-011: bot [ERROR] as last comment → not awaiting (permanent failure)', () => {
  const comments = [
    { id: 700, message: '[ERROR] Could not complete task: timeout', actorId: 'moltagent' },
  ];
  assert.strictEqual(isAwaitingHumanResponse(comments, 'moltagent'), false);
});

test('TC-AWAIT-012: bot [RETRY] as last comment → not awaiting (transient failure)', () => {
  const comments = [
    { id: 800, message: '[RETRY] Processing failed: provider budget exceeded. Will retry next heartbeat.', actorId: 'moltagent' },
  ];
  assert.strictEqual(isAwaitingHumanResponse(comments, 'moltagent'), false);
});

// --- Summary ---
setTimeout(() => {
  summary();
  exitWithCode();
}, 100);
