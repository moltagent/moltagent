/**
 * Deck Board Model & @Mention Tests
 *
 * Tests:
 * - Board classification from title
 * - Inbox assignment guard
 * - @Mention detection from comments array
 * - @Mention handler posts response comment
 * - Self-mention ignored
 * - Already-responded mention ignored
 *
 * Run: node test/unit/integrations/deck-board-model.test.js
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const { createMockNCRequestManager } = require('../../helpers/mock-factories');

const DeckClient = require('../../../src/lib/integrations/deck-client');
const DeckTaskProcessor = require('../../../src/lib/integrations/deck-task-processor');
const DECK = require('../../../src/config/deck-names');

// ============================================================
// Mock Helper
// ============================================================

/**
 * Create a mock NC Request Manager with pre-loaded Deck API routes.
 * Each route returns { status: 200, body: <data> } as DeckClient._request expects.
 */
function mockNC(routes = {}) {
  const responses = {};
  for (const [key, body] of Object.entries(routes)) {
    responses[key] = { status: 200, body, headers: {} };
  }
  return createMockNCRequestManager(responses);
}

const SAMPLE_BOARDS = [
  { id: 1, title: DECK.boards.tasks, owner: { uid: 'moltagent' } },
  { id: 2, title: 'Personal', owner: { uid: 'Funana' } },
  { id: 3, title: 'Podcast Scheduling', owner: { uid: 'Funana' } },
  { id: 4, title: DECK.boards.cockpit, owner: { uid: 'moltagent' } }
];

const FULL_BOARD = {
  id: 1, title: DECK.boards.tasks,
  stacks: [
    { id: 101, title: 'Inbox', order: 0 },
    { id: 102, title: 'Queued', order: 1 },
    { id: 103, title: 'Working', order: 2 },
    { id: 104, title: 'Review', order: 3 },
    { id: 105, title: 'Done', order: 4 },
    { id: 106, title: 'Reference', order: 5 }
  ],
  labels: []
};

// ============================================================
// Board Classification Tests
// ============================================================

test('classifyBoard: MoltAgent Tasks → moltagent-tasks', () => {
  const nc = createMockNCRequestManager();
  const client = new DeckClient(nc, { boardName: DECK.boards.tasks });
  assert.strictEqual(client.classifyBoard({ id: 1, title: DECK.boards.tasks }), 'moltagent-tasks');
});

test('classifyBoard: Moltagent Cockpit → cockpit', () => {
  const nc = createMockNCRequestManager();
  const client = new DeckClient(nc, { boardName: DECK.boards.tasks });
  assert.strictEqual(client.classifyBoard({ id: 4, title: DECK.boards.cockpit }), 'cockpit');
});

test('classifyBoard: Personal → personal', () => {
  const nc = createMockNCRequestManager();
  const client = new DeckClient(nc, { boardName: DECK.boards.tasks });
  assert.strictEqual(client.classifyBoard({ id: 2, title: 'Personal' }), 'personal');
});

test('classifyBoard: project board → project', () => {
  const nc = createMockNCRequestManager();
  const client = new DeckClient(nc, { boardName: DECK.boards.tasks });
  assert.strictEqual(client.classifyBoard({ id: 3, title: 'Podcast Scheduling' }), 'project');
});

test('classifyBoard: case-insensitive matching', () => {
  const nc = createMockNCRequestManager();
  const client = new DeckClient(nc, { boardName: DECK.boards.tasks });
  assert.strictEqual(client.classifyBoard({ id: 1, title: 'moltagent tasks' }), 'moltagent-tasks');
  assert.strictEqual(client.classifyBoard({ id: 2, title: 'PERSONAL' }), 'personal');
  assert.strictEqual(client.classifyBoard({ id: 4, title: 'MOLTAGENT COCKPIT' }), 'cockpit');
});

test('BOARD_TYPES: static constants available', () => {
  assert.strictEqual(DeckClient.BOARD_TYPES.MOLTAGENT_TASKS, 'moltagent-tasks');
  assert.strictEqual(DeckClient.BOARD_TYPES.COCKPIT, 'cockpit');
  assert.strictEqual(DeckClient.BOARD_TYPES.PERSONAL, 'personal');
  assert.strictEqual(DeckClient.BOARD_TYPES.PROJECT, 'project');
});

asyncTest('getClassifiedBoards: returns all boards with types', async () => {
  const nc = mockNC({
    'GET:/index.php/apps/deck/api/v1.0/boards': SAMPLE_BOARDS
  });
  const client = new DeckClient(nc, { boardName: DECK.boards.tasks });
  const classified = await client.getClassifiedBoards();

  assert.strictEqual(classified.size, 4);
  assert.strictEqual(classified.get(1).type, 'moltagent-tasks');
  assert.strictEqual(classified.get(2).type, 'personal');
  assert.strictEqual(classified.get(3).type, 'project');
  assert.strictEqual(classified.get(4).type, 'cockpit');
});

asyncTest('getClassifiedBoards: caches results', async () => {
  let callCount = 0;
  const nc = mockNC({
    'GET:/index.php/apps/deck/api/v1.0/boards': SAMPLE_BOARDS
  });
  const origRequest = nc.request.bind(nc);
  nc.request = async (...args) => { callCount++; return origRequest(...args); };
  const client = new DeckClient(nc, { boardName: DECK.boards.tasks });

  await client.getClassifiedBoards();
  await client.getClassifiedBoards();
  assert.strictEqual(callCount, 1, 'Should only call API once due to cache');
});

asyncTest('getBoardType: returns type for known board', async () => {
  const nc = mockNC({
    'GET:/index.php/apps/deck/api/v1.0/boards': SAMPLE_BOARDS
  });
  const client = new DeckClient(nc, { boardName: DECK.boards.tasks });
  assert.strictEqual(await client.getBoardType(1), 'moltagent-tasks');
  assert.strictEqual(await client.getBoardType(3), 'project');
});

asyncTest('getBoardType: returns project for unknown board', async () => {
  const nc = mockNC({
    'GET:/index.php/apps/deck/api/v1.0/boards': SAMPLE_BOARDS
  });
  const client = new DeckClient(nc, { boardName: DECK.boards.tasks });
  assert.strictEqual(await client.getBoardType(999), 'project');
});

// ============================================================
// scanInbox: assignedUsers field
// ============================================================

asyncTest('scanInbox: returns assignedUsers in card objects', async () => {
  const nc = mockNC({
    'GET:/index.php/apps/deck/api/v1.0/boards': [{ id: 1, title: DECK.boards.tasks }],
    'GET:/index.php/apps/deck/api/v1.0/boards/1': FULL_BOARD,
    'GET:/index.php/apps/deck/api/v1.0/boards/1/stacks/101': {
      id: 101, title: 'Inbox',
      cards: [{
        id: 600, title: 'Test', description: '', labels: [],
        assignedUsers: [{ participant: { uid: 'Funana' } }],
        createdAt: Date.now(), lastModified: Date.now()
      }]
    }
  });
  const client = new DeckClient(nc, { boardName: DECK.boards.tasks });
  const inbox = await client.scanInbox();
  assert.strictEqual(inbox.length, 1);
  assert.ok(Array.isArray(inbox[0].assignedUsers));
  assert.strictEqual(inbox[0].assignedUsers[0].participant.uid, 'Funana');
});

// ============================================================
// Inbox Assignment Guard Tests
// ============================================================

asyncTest('processInbox: skips cards assigned to other users', async () => {
  const nc = mockNC({
    'GET:/index.php/apps/deck/api/v1.0/boards': [{ id: 1, title: DECK.boards.tasks }],
    'GET:/index.php/apps/deck/api/v1.0/boards/1': FULL_BOARD,
    'GET:/index.php/apps/deck/api/v1.0/boards/1/stacks/101': {
      id: 101, title: 'Inbox',
      cards: [{
        id: 500, title: 'User task', description: '', labels: [],
        assignedUsers: [{ participant: { uid: 'Funana' } }],
        createdAt: Date.now(), lastModified: Date.now()
      }]
    }
  });

  const mockRouter = { route: async () => ({ result: 'done', provider: 'test' }) };
  const processor = new DeckTaskProcessor({}, mockRouter, async () => {});
  processor.deck = new DeckClient(nc, { boardName: DECK.boards.tasks });
  processor.deck.username = 'moltagent';

  const results = await processor.processInbox();
  assert.strictEqual(results.skippedAssigned, 1);
  assert.strictEqual(results.processed, 0);
});

asyncTest('processInbox: processes unassigned cards', async () => {
  const nc = mockNC({
    'GET:/index.php/apps/deck/api/v1.0/boards': [{ id: 1, title: DECK.boards.tasks }],
    'GET:/index.php/apps/deck/api/v1.0/boards/1': FULL_BOARD,
    'GET:/index.php/apps/deck/api/v1.0/boards/1/stacks/101': {
      id: 101, title: 'Inbox',
      cards: [{
        id: 501, title: 'Research topic', description: 'Do some research', labels: [],
        assignedUsers: [],
        createdAt: Date.now(), lastModified: Date.now()
      }]
    },
    'POST:/ocs/v2.php/apps/deck/api/v1.0/cards/501/comments': { ocs: { data: { id: 1 } } },
    'PUT:/index.php/apps/deck/api/v1.0/boards/1/stacks/102/cards/501': { id: 501 },
    'PUT:/index.php/apps/deck/api/v1.0/boards/1/stacks/103/cards/501': { id: 501 },
    'PUT:/index.php/apps/deck/api/v1.0/boards/1/stacks/104/cards/501': { id: 501 }
  });

  const mockRouter = { route: async () => ({ result: 'Research completed.', provider: 'test' }) };
  const processor = new DeckTaskProcessor({}, mockRouter, async () => {});
  processor.deck = new DeckClient(nc, { boardName: DECK.boards.tasks });
  processor.deck.username = 'moltagent';

  const results = await processor.processInbox();
  assert.strictEqual(results.skippedAssigned || 0, 0);
  assert.strictEqual(results.processed, 1);
});

asyncTest('processInbox: processes cards assigned to Moltagent', async () => {
  const nc = mockNC({
    'GET:/index.php/apps/deck/api/v1.0/boards': [{ id: 1, title: DECK.boards.tasks }],
    'GET:/index.php/apps/deck/api/v1.0/boards/1': FULL_BOARD,
    'GET:/index.php/apps/deck/api/v1.0/boards/1/stacks/101': {
      id: 101, title: 'Inbox',
      cards: [{
        id: 502, title: 'My own task', description: 'Self-assigned', labels: [],
        assignedUsers: [{ participant: { uid: 'moltagent' } }],
        createdAt: Date.now(), lastModified: Date.now()
      }]
    },
    'POST:/ocs/v2.php/apps/deck/api/v1.0/cards/502/comments': { ocs: { data: { id: 1 } } },
    'PUT:/index.php/apps/deck/api/v1.0/boards/1/stacks/102/cards/502': { id: 502 },
    'PUT:/index.php/apps/deck/api/v1.0/boards/1/stacks/103/cards/502': { id: 502 },
    'PUT:/index.php/apps/deck/api/v1.0/boards/1/stacks/104/cards/502': { id: 502 }
  });

  const mockRouter = { route: async () => ({ result: 'Done.', provider: 'test' }) };
  const processor = new DeckTaskProcessor({}, mockRouter, async () => {});
  processor.deck = new DeckClient(nc, { boardName: DECK.boards.tasks });
  processor.deck.username = 'moltagent';

  const results = await processor.processInbox();
  assert.strictEqual(results.skippedAssigned || 0, 0);
  assert.strictEqual(results.processed, 1);
});

// ============================================================
// @Mention Detection Tests
// ============================================================

asyncTest('processMention: detects @mention and routes through messageProcessor', async () => {
  const nc = mockNC({
    'GET:/index.php/apps/deck/api/v1.0/boards': SAMPLE_BOARDS,
    'GET:/ocs/v2.php/apps/deck/api/v1.0/cards/100/comments': {
      ocs: {
        data: [{
          id: 50, actorId: 'Funana',
          message: '@Moltagent can you find a time slot?',
          mentions: [{ mentionId: 'Moltagent', mentionType: 'user' }],
          creationDateTime: '2026-02-19T12:00:00Z'
        }]
      }
    },
    'GET:/index.php/apps/deck/api/v1.0/boards/8/stacks': [{
      id: 301, title: 'Inbox',
      cards: [{ id: 100, title: 'Schedule recording', description: 'Record ep 5' }]
    }],
    'POST:/ocs/v2.php/apps/deck/api/v1.0/cards/100/comments': { ocs: { data: { id: 51 } } }
  });

  let processedData = null;
  const mockMessageProcessor = {
    process: async (data) => {
      processedData = data;
      return { response: 'I can check the calendar.' };
    }
  };

  const processor = new DeckTaskProcessor({}, {}, async () => {});
  processor.deck = new DeckClient(nc, { boardName: DECK.boards.tasks });
  processor.deck.username = 'moltagent';

  const result = await processor.processMention(
    { type: 'deck_comment_added', objectId: '100', user: 'Funana', data: {} },
    { messageProcessor: mockMessageProcessor }
  );
  assert.strictEqual(result.handled, true);
  assert.strictEqual(result.reason, 'responded');
  assert.strictEqual(result.cardId, 100);
  // Verify the message was routed through processMessage with only user's words
  assert.ok(processedData);
  assert.ok(processedData.object.content.includes('find a time slot'));
  assert.ok(!processedData.object.content.includes('[Card:'), 'card context should NOT be in content');
  assert.strictEqual(processedData.actor.name, 'Funana');
  assert.strictEqual(processedData.target.id, null);
});

asyncTest('processMention: ignores own comments (self-mention)', async () => {
  const nc = createMockNCRequestManager();
  const processor = new DeckTaskProcessor({}, {}, async () => {});
  processor.deck = new DeckClient(nc, { boardName: DECK.boards.tasks });
  processor.deck.username = 'moltagent';

  const result = await processor.processMention({
    type: 'deck_comment_added', objectId: '100', user: 'moltagent', data: {}
  });
  assert.strictEqual(result.handled, false);
  assert.strictEqual(result.reason, 'own_comment');
});

asyncTest('processMention: ignores comments without @mention', async () => {
  const nc = mockNC({
    'GET:/ocs/v2.php/apps/deck/api/v1.0/cards/100/comments': {
      ocs: {
        data: [{
          id: 60, actorId: 'Funana',
          message: 'Just a regular comment',
          mentions: [],
          creationDateTime: '2026-02-19T12:00:00Z'
        }]
      }
    }
  });

  const processor = new DeckTaskProcessor({}, {}, async () => {});
  processor.deck = new DeckClient(nc, { boardName: DECK.boards.tasks });
  processor.deck.username = 'moltagent';

  const result = await processor.processMention({
    type: 'deck_comment_added', objectId: '100', user: 'Funana', data: {}
  });
  assert.strictEqual(result.handled, false);
  assert.strictEqual(result.reason, 'no_mention_found');
});

asyncTest('processMention: ignores already-responded mentions', async () => {
  const nc = mockNC({
    'GET:/ocs/v2.php/apps/deck/api/v1.0/cards/100/comments': {
      ocs: {
        data: [
          // Newer: our response
          {
            id: 62, actorId: 'Moltagent',
            message: '[MENTION] Here is my response.',
            mentions: [],
            creationDateTime: '2026-02-19T12:05:00Z'
          },
          // Older: their mention
          {
            id: 61, actorId: 'Funana',
            message: '@Moltagent help me with this',
            mentions: [{ mentionId: 'Moltagent', mentionType: 'user' }],
            creationDateTime: '2026-02-19T12:00:00Z'
          }
        ]
      }
    }
  });

  const processor = new DeckTaskProcessor({}, {}, async () => {});
  processor.deck = new DeckClient(nc, { boardName: DECK.boards.tasks });
  processor.deck.username = 'moltagent';

  const result = await processor.processMention({
    type: 'deck_comment_added', objectId: '100', user: 'Funana', data: {}
  });
  assert.strictEqual(result.handled, false);
  assert.strictEqual(result.reason, 'already_responded');
});

asyncTest('processMention: handles invalid card ID', async () => {
  const processor = new DeckTaskProcessor({}, {}, async () => {});
  processor.deck = new DeckClient(createMockNCRequestManager(), { boardName: DECK.boards.tasks });

  const result = await processor.processMention({
    type: 'deck_comment_added', objectId: '', user: 'Funana', data: {}
  });
  assert.strictEqual(result.handled, false);
  assert.strictEqual(result.reason, 'invalid_card_id');
});

asyncTest('processMention: handles API errors gracefully', async () => {
  const nc = createMockNCRequestManager();
  nc.request = async () => { throw new Error('Network error'); };

  const processor = new DeckTaskProcessor({}, {}, async () => {});
  processor.deck = new DeckClient(nc, { boardName: DECK.boards.tasks });
  processor.deck.username = 'moltagent';

  const result = await processor.processMention({
    type: 'deck_comment_added', objectId: '100', user: 'Funana', data: {}
  });
  assert.strictEqual(result.handled, false);
  assert.strictEqual(result.reason, 'error');
});

// ============================================================
// Heartbeat Flow Event Routing Tests
// ============================================================

asyncTest('_processFlowEvents: routes deck_comment_added to mention handler', async () => {
  const HeartbeatManager = require('../../../src/lib/integrations/heartbeat-manager');

  let mentionProcessed = false;
  const hb = new HeartbeatManager({
    nextcloud: { url: 'http://test', username: 'moltagent' },
    deck: { boardName: DECK.boards.tasks },
    heartbeat: { intervalMs: 999999 },
    ncRequestManager: createMockNCRequestManager(),
    llmRouter: { route: async () => ({ result: 'test', provider: 'test' }) },
    auditLog: async () => {},
    notifyUser: async () => {}
  });

  hb.deckProcessor.processMention = async () => {
    mentionProcessed = true;
    return { handled: true, reason: 'responded', cardId: 100 };
  };

  hb.enqueueExternalEvent({
    type: 'deck_comment_added', objectId: '100', user: 'Funana', data: {}
  });

  const result = await hb._processFlowEvents();
  assert.strictEqual(result.processed, 1);
  assert.strictEqual(result.mentionsHandled, 1);
  assert.ok(mentionProcessed);
});

asyncTest('_processFlowEvents: does not route non-comment events as mentions', async () => {
  const HeartbeatManager = require('../../../src/lib/integrations/heartbeat-manager');

  let mentionCalled = false;
  const hb = new HeartbeatManager({
    nextcloud: { url: 'http://test', username: 'moltagent' },
    deck: { boardName: DECK.boards.tasks },
    heartbeat: { intervalMs: 999999 },
    ncRequestManager: createMockNCRequestManager(),
    llmRouter: { route: async () => ({ result: 'test', provider: 'test' }) },
    auditLog: async () => {},
    notifyUser: async () => {}
  });

  hb.deckProcessor.processMention = async () => {
    mentionCalled = true;
    return { handled: false };
  };

  hb.enqueueExternalEvent({ type: 'deck_card_created', objectId: '50', user: 'Funana', data: {} });
  hb.enqueueExternalEvent({ type: 'file_changed', objectId: '60', user: 'Funana', data: {} });

  const result = await hb._processFlowEvents();
  assert.strictEqual(result.processed, 2);
  assert.strictEqual(result.mentionsHandled, 0);
  assert.ok(!mentionCalled);
});

// ============================================================
// Summary
// ============================================================

setTimeout(() => {
  summary();
  exitWithCode();
}, 3000);
