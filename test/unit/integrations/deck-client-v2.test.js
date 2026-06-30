/**
 * Moltagent NC Deck Client — Generic CRUD Tests (v2)
 *
 * Architecture Brief:
 * -------------------
 * Problem: The new generic board/stack CRUD methods added in the v2 section of
 * DeckClient need automated unit tests that verify correct HTTP method, path,
 * and body forwarding without requiring a real Nextcloud server.
 *
 * Pattern: Mock-based unit testing — createDeckMockNC captures every request
 * into a `calls` array so tests can assert on method + path + body in one pass.
 *
 * Key Dependencies:
 * - NCRequestManager (mocked via createDeckMockNC)
 * - DeckClient (module under test)
 *
 * Data Flow:
 * Test -> DeckClient -> MockNCRequestManager -> captured call / fixture response
 *
 * Run: node test/unit/integrations/deck-client-v2.test.js
 *
 * @module test/unit/integrations/deck-client-v2
 * @license AGPL-3.0-or-later
 */

/*
 * Moltagent — Sovereign AI Agent for Nextcloud
 * Copyright (C) 2024  Moltagent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

// Module under test
const DeckClient = require('../../../src/lib/integrations/deck-client');

// ============================================================
// Mock Factory
// ============================================================

/**
 * Create a Deck-specific mock NCRequestManager that records every call and
 * returns caller-supplied fixtures. Throws on responses with status >= 400.
 *
 * @param {Object} responses - Keys are "METHOD:/path", values are response objects
 *   or functions (path, options) => response.
 * @returns {{ nc: Object, calls: Array }} nc is the mock; calls tracks invocations
 */
function createDeckMockNC(responses = {}) {
  const calls = [];

  const nc = {
    ncUrl: 'https://cloud.example.com',
    ncUser: 'testuser',
    request: async (path, options = {}) => {
      const method = options.method || 'GET';
      calls.push({ method, path, body: options.body });

      const key = `${method}:${path}`;
      const handler = responses[key];

      if (handler !== undefined) {
        const response = typeof handler === 'function' ? handler(path, options) : handler;
        if (response.status >= 400) {
          const err = new Error(response.body?.message || `HTTP ${response.status}`);
          err.statusCode = response.status;
          err.response = response.body;
          throw err;
        }
        return response;
      }

      // Default success for unregistered paths
      return { status: 200, body: {}, headers: {} };
    },
    getMetrics: () => ({ totalRequests: 0, cacheHits: 0 }),
    invalidateCache: () => {},
    shutdown: async () => {}
  };

  nc._calls = calls;
  return nc;
}

/**
 * Convenience: build a DeckClient backed by a mock NC.
 * Returns { client, nc } so tests can inspect nc._calls.
 */
function makeClient(responses = {}) {
  const nc = createDeckMockNC(responses);
  const client = new DeckClient(nc);
  return { client, nc };
}

// ============================================================
// Tests
// ============================================================

console.log('\n=== DeckClient v2 Generic CRUD Tests ===\n');

// --- createNewBoard ---
console.log('\n--- createNewBoard ---\n');

asyncTest('TC-CNB-001: createNewBoard returns object with id and title', async () => {
  const fixture = { id: 42, title: 'Sprint Board', color: '0800fd' };
  const { client } = makeClient({
    'POST:/index.php/apps/deck/api/v1.0/boards': { status: 200, body: fixture, headers: {} }
  });

  const result = await client.createNewBoard('Sprint Board');

  assert.strictEqual(result.id, 42);
  assert.strictEqual(result.title, 'Sprint Board');
});

asyncTest('TC-CNB-002: createNewBoard uses default color 0800fd when not specified', async () => {
  const { client, nc } = makeClient({
    'POST:/index.php/apps/deck/api/v1.0/boards': { status: 200, body: { id: 7, title: 'X', color: '0800fd' }, headers: {} }
  });

  await client.createNewBoard('X');

  const call = nc._calls.find(c => c.method === 'POST' && c.path === '/index.php/apps/deck/api/v1.0/boards');
  assert.ok(call, 'POST to /boards should have been made');
  assert.strictEqual(call.body.color, '0800fd');
});

asyncTest('TC-CNB-003: createNewBoard without title throws DeckApiError', async () => {
  const { client } = makeClient();

  await assert.rejects(
    () => client.createNewBoard(''),
    (err) => {
      assert.ok(err.message.includes('Board title is required'), `Unexpected message: ${err.message}`);
      return true;
    }
  );
});

asyncTest('TC-CNB-004: createNewBoard with null title throws DeckApiError', async () => {
  const { client } = makeClient();

  await assert.rejects(
    () => client.createNewBoard(null),
    (err) => {
      assert.ok(err.message.includes('Board title is required'));
      return true;
    }
  );
});

// --- updateBoard ---
console.log('\n--- updateBoard ---\n');

asyncTest('TC-UB-001: updateBoard read-modify-writes the full body (title + color)', async () => {
  // Partial PUT (title only) returns HTTP 400 from Deck; updateBoard must merge
  // onto the current board and send the full representation.
  const current = { id: 5, title: 'Old Board', color: 'ff0000', archived: false };
  const updated = { id: 5, title: 'Renamed Board', color: 'ff0000', archived: false };
  const { client, nc } = makeClient({
    'GET:/index.php/apps/deck/api/v1.0/boards/5': { status: 200, body: current, headers: {} },
    'PUT:/index.php/apps/deck/api/v1.0/boards/5': { status: 200, body: updated, headers: {} }
  });

  const result = await client.updateBoard(5, { title: 'Renamed Board' });

  assert.strictEqual(result.title, 'Renamed Board');
  const call = nc._calls.find(c => c.method === 'PUT' && c.path === '/index.php/apps/deck/api/v1.0/boards/5');
  assert.ok(call, 'PUT to /boards/5 should have been made');
  assert.strictEqual(call.body.title, 'Renamed Board');
  assert.strictEqual(call.body.color, 'ff0000', 'color must be preserved from the current board');
});

asyncTest('TC-UB-002: updateBoard without boardId throws DeckApiError', async () => {
  const { client } = makeClient();

  await assert.rejects(
    () => client.updateBoard(null, { title: 'X' }),
    (err) => {
      assert.ok(err.message.includes('boardId is required'));
      return true;
    }
  );
});

// --- deleteBoard ---
console.log('\n--- deleteBoard ---\n');

asyncTest('TC-DB-001: deleteBoard sends DELETE to correct endpoint', async () => {
  const { client, nc } = makeClient({
    'DELETE:/index.php/apps/deck/api/v1.0/boards/9': { status: 200, body: {}, headers: {} }
  });

  await client.deleteBoard(9);

  const call = nc._calls.find(c => c.method === 'DELETE' && c.path === '/index.php/apps/deck/api/v1.0/boards/9');
  assert.ok(call, 'DELETE to /boards/9 should have been made');
});

asyncTest('TC-DB-002: deleteBoard without boardId throws DeckApiError', async () => {
  const { client } = makeClient();

  await assert.rejects(
    () => client.deleteBoard(0),
    (err) => {
      assert.ok(err.message.includes('boardId is required'));
      return true;
    }
  );
});

// --- archiveBoard ---
console.log('\n--- archiveBoard ---\n');

asyncTest('TC-AB-001: archiveBoard sends PUT with archived: true', async () => {
  const archived = { id: 3, title: 'Old Board', archived: true };
  const { client, nc } = makeClient({
    'PUT:/index.php/apps/deck/api/v1.0/boards/3': { status: 200, body: archived, headers: {} }
  });

  const result = await client.archiveBoard(3);

  assert.strictEqual(result.archived, true);
  const call = nc._calls.find(c => c.method === 'PUT' && c.path === '/index.php/apps/deck/api/v1.0/boards/3');
  assert.ok(call, 'PUT to /boards/3 should have been made');
  assert.strictEqual(call.body.archived, true);
});

// --- updateStack ---
console.log('\n--- updateStack ---\n');

asyncTest('TC-US-001: updateStack read-modify-writes the full body (title + order)', async () => {
  // Partial PUT (title only) returns HTTP 400 from Deck; updateStack must merge
  // onto the current stack and send title + order.
  const stacks = [{ id: 201, title: 'To Do', order: 3 }, { id: 202, title: 'Done', order: 4 }];
  const updatedStack = { id: 201, title: 'Backlog', order: 3 };
  const { client, nc } = makeClient({
    'GET:/index.php/apps/deck/api/v1.0/boards/10/stacks': { status: 200, body: stacks, headers: {} },
    'PUT:/index.php/apps/deck/api/v1.0/boards/10/stacks/201': {
      status: 200, body: updatedStack, headers: {}
    }
  });

  const result = await client.updateStack(10, 201, { title: 'Backlog' });

  assert.strictEqual(result.title, 'Backlog');
  const call = nc._calls.find(
    c => c.method === 'PUT' && c.path === '/index.php/apps/deck/api/v1.0/boards/10/stacks/201'
  );
  assert.ok(call, 'PUT to /boards/10/stacks/201 should have been made');
  assert.strictEqual(call.body.title, 'Backlog');
  assert.strictEqual(call.body.order, 3, 'order must be preserved from the current stack (NC partial-PUT 400 fix)');
});

asyncTest('TC-US-002: updateStack without boardId or stackId throws DeckApiError', async () => {
  const { client } = makeClient();

  await assert.rejects(
    () => client.updateStack(null, null, { title: 'X' }),
    (err) => {
      assert.ok(err.message.includes('boardId and stackId are required'));
      return true;
    }
  );
});

asyncTest('TC-US-003: updateStack with boardId but no stackId throws DeckApiError', async () => {
  const { client } = makeClient();

  await assert.rejects(
    () => client.updateStack(10, 0, { title: 'X' }),
    (err) => {
      assert.ok(err.message.includes('boardId and stackId are required'));
      return true;
    }
  );
});

// --- deleteStack ---
console.log('\n--- deleteStack ---\n');

asyncTest('TC-DS-001: deleteStack sends DELETE to correct endpoint', async () => {
  const { client, nc } = makeClient({
    'DELETE:/index.php/apps/deck/api/v1.0/boards/10/stacks/201': {
      status: 200, body: {}, headers: {}
    }
  });

  await client.deleteStack(10, 201);

  const call = nc._calls.find(
    c => c.method === 'DELETE' && c.path === '/index.php/apps/deck/api/v1.0/boards/10/stacks/201'
  );
  assert.ok(call, 'DELETE to /boards/10/stacks/201 should have been made');
});

asyncTest('TC-DS-002: deleteStack without boardId throws DeckApiError', async () => {
  const { client } = makeClient();

  await assert.rejects(
    () => client.deleteStack(0, 201),
    (err) => {
      assert.ok(err.message.includes('boardId and stackId are required'));
      return true;
    }
  );
});

// --- createCardOnBoard ---
console.log('\n--- createCardOnBoard ---\n');

asyncTest('TC-CCOB-001: createCardOnBoard posts card to correct board and stack IDs', async () => {
  const newCard = { id: 999, title: 'Fix the bug', description: '', type: 'plain', order: 0 };
  const { client, nc } = makeClient({
    'POST:/index.php/apps/deck/api/v1.0/boards/10/stacks/201/cards': {
      status: 200, body: newCard, headers: {}
    }
  });

  const result = await client.createCardOnBoard(10, 201, 'Fix the bug');

  assert.strictEqual(result.id, 999);
  assert.strictEqual(result.title, 'Fix the bug');

  const call = nc._calls.find(
    c => c.method === 'POST' && c.path === '/index.php/apps/deck/api/v1.0/boards/10/stacks/201/cards'
  );
  assert.ok(call, 'POST to /boards/10/stacks/201/cards should have been made');
  assert.strictEqual(call.body.title, 'Fix the bug');
  assert.strictEqual(call.body.type, 'plain');
  assert.strictEqual(call.body.order, 0);
});

asyncTest('TC-CCOB-002: createCardOnBoard passes description from opts', async () => {
  const { client, nc } = makeClient({
    'POST:/index.php/apps/deck/api/v1.0/boards/10/stacks/201/cards': {
      status: 200, body: { id: 1000, title: 'My Card', description: 'Some details' }, headers: {}
    }
  });

  await client.createCardOnBoard(10, 201, 'My Card', { description: 'Some details' });

  const call = nc._calls.find(
    c => c.method === 'POST' && c.path === '/index.php/apps/deck/api/v1.0/boards/10/stacks/201/cards'
  );
  assert.ok(call, 'POST should have been made');
  assert.strictEqual(call.body.description, 'Some details');
});

asyncTest('TC-CCOB-003: createCardOnBoard defaults description to empty string when not provided', async () => {
  const { client, nc } = makeClient({
    'POST:/index.php/apps/deck/api/v1.0/boards/10/stacks/201/cards': {
      status: 200, body: { id: 1001, title: 'No Desc' }, headers: {}
    }
  });

  await client.createCardOnBoard(10, 201, 'No Desc');

  const call = nc._calls.find(
    c => c.method === 'POST' && c.path === '/index.php/apps/deck/api/v1.0/boards/10/stacks/201/cards'
  );
  assert.ok(call, 'POST should have been made');
  assert.strictEqual(call.body.description, '');
});

// --- API error handling ---
console.log('\n--- API error propagation ---\n');

asyncTest('TC-ERR-001: 404 response from createNewBoard propagates as error', async () => {
  const { client } = makeClient({
    'POST:/index.php/apps/deck/api/v1.0/boards': {
      status: 404, body: { message: 'Not found' }, headers: {}
    }
  });

  await assert.rejects(
    () => client.createNewBoard('Ghost Board'),
    (err) => {
      // DeckApiError wraps the HTTP error — message may be the HTTP error text
      assert.ok(err, 'An error should have been thrown');
      return true;
    }
  );
});

asyncTest('TC-ERR-002: 403 response from deleteBoard propagates as error', async () => {
  const { client } = makeClient({
    'DELETE:/index.php/apps/deck/api/v1.0/boards/99': {
      status: 403, body: { message: 'Forbidden' }, headers: {}
    }
  });

  await assert.rejects(
    () => client.deleteBoard(99),
    (err) => {
      assert.ok(err, 'An error should have been thrown');
      return true;
    }
  );
});

asyncTest('TC-ERR-003: 500 response from updateStack propagates as error', async () => {
  const { client } = makeClient({
    'PUT:/index.php/apps/deck/api/v1.0/boards/10/stacks/201': {
      status: 500, body: { message: 'Internal Server Error' }, headers: {}
    }
  });

  await assert.rejects(
    () => client.updateStack(10, 201, { title: 'Crash' }),
    (err) => {
      assert.ok(err, 'An error should have been thrown');
      return true;
    }
  );
});

// ============================================================
// --- ID-based card mutation methods (issue #65) ---
// ============================================================
console.log('\n--- *ById card mutation methods ---\n');

asyncTest('TC-GCB-001: getCardById sends GET to /boards/{b}/stacks/{s}/cards/{c}', async () => {
  const fixture = { id: 200, title: 'Shared card' };
  const { client } = makeClient({
    'GET:/index.php/apps/deck/api/v1.0/boards/7/stacks/701/cards/200': { status: 200, body: fixture, headers: {} }
  });

  const result = await client.getCardById(7, 701, 200);
  assert.strictEqual(result.id, 200);
});

asyncTest('TC-GCB-002: getCardById without required IDs throws', async () => {
  const { client } = makeClient();
  await assert.rejects(() => client.getCardById(null, 701, 200), (err) => err.message.includes('required'));
});

asyncTest('TC-UCB-001: updateCardById sends PUT with updates body', async () => {
  const { client, nc } = makeClient({
    'PUT:/index.php/apps/deck/api/v1.0/boards/7/stacks/701/cards/200': { status: 200, body: { id: 200 }, headers: {} }
  });

  await client.updateCardById(7, 701, 200, { title: 'Renamed', duedate: '2026-06-01' });
  const call = nc._calls.find(c => c.method === 'PUT' && c.path.endsWith('/cards/200'));
  assert.ok(call);
  assert.strictEqual(call.body.title, 'Renamed');
  assert.strictEqual(call.body.duedate, '2026-06-01');
});

asyncTest('TC-DCB-001: deleteCardById sends DELETE to correct endpoint', async () => {
  const { client, nc } = makeClient({
    'DELETE:/index.php/apps/deck/api/v1.0/boards/7/stacks/701/cards/200': { status: 200, body: {}, headers: {} }
  });

  await client.deleteCardById(7, 701, 200);
  const call = nc._calls.find(c => c.method === 'DELETE' && c.path.endsWith('/cards/200'));
  assert.ok(call);
});

asyncTest('TC-DCB-002: deleteCardById without cardId throws', async () => {
  const { client } = makeClient();
  await assert.rejects(() => client.deleteCardById(7, 701, null), (err) => err.message.includes('required'));
});

asyncTest('TC-MCB-001: moveCardById PUTs to internal reorder endpoint with destination stackId', async () => {
  const { client, nc } = makeClient({
    'PUT:/index.php/apps/deck/cards/200/reorder': { status: 200, body: {}, headers: {} }
  });

  await client.moveCardById(200, 703, 0);
  const call = nc._calls.find(c => c.method === 'PUT' && c.path === '/index.php/apps/deck/cards/200/reorder');
  assert.ok(call);
  assert.strictEqual(call.body.stackId, 703);
  assert.strictEqual(call.body.order, 0);
});

asyncTest('TC-MCB-002: moveCardById defaults order to 0 when omitted', async () => {
  const { client, nc } = makeClient({
    'PUT:/index.php/apps/deck/cards/200/reorder': { status: 200, body: {}, headers: {} }
  });

  await client.moveCardById(200, 703);
  const call = nc._calls.find(c => c.method === 'PUT');
  assert.strictEqual(call.body.order, 0);
});

asyncTest('TC-ALB-001: assignLabelById PUTs labelId to assignLabel endpoint', async () => {
  const { client, nc } = makeClient({
    'PUT:/index.php/apps/deck/api/v1.0/boards/7/stacks/701/cards/200/assignLabel': { status: 200, body: {}, headers: {} }
  });

  await client.assignLabelById(7, 701, 200, 1001);
  const call = nc._calls.find(c => c.method === 'PUT' && c.path.endsWith('/assignLabel'));
  assert.ok(call);
  assert.strictEqual(call.body.labelId, 1001);
});

asyncTest('TC-RLB-001: removeLabelById PUTs labelId to removeLabel endpoint', async () => {
  const { client, nc } = makeClient({
    'PUT:/index.php/apps/deck/api/v1.0/boards/7/stacks/701/cards/200/removeLabel': { status: 200, body: {}, headers: {} }
  });

  await client.removeLabelById(7, 701, 200, 1001);
  const call = nc._calls.find(c => c.method === 'PUT' && c.path.endsWith('/removeLabel'));
  assert.ok(call);
});

asyncTest('TC-AUB-001: assignUserById looks up case-insensitive uid and assigns', async () => {
  const { client, nc } = makeClient({
    'GET:/index.php/apps/deck/api/v1.0/boards/7': {
      status: 200,
      body: { id: 7, users: [{ uid: 'Alice', primaryKey: 'Alice' }] },
      headers: {}
    },
    'PUT:/index.php/apps/deck/api/v1.0/boards/7/stacks/701/cards/200/assignUser': { status: 200, body: {}, headers: {} }
  });

  const matched = await client.assignUserById(7, 701, 200, 'alice');
  assert.strictEqual(matched, 'Alice');
  const assignCall = nc._calls.find(c => c.path.endsWith('/assignUser'));
  assert.ok(assignCall);
  assert.strictEqual(assignCall.body.userId, 'Alice');
});

asyncTest('TC-AUB-002: assignUserById returns null when user not a board member', async () => {
  const { client } = makeClient({
    'GET:/index.php/apps/deck/api/v1.0/boards/7': {
      status: 200,
      body: { id: 7, users: [{ uid: 'jordan', primaryKey: 'jordan' }] },
      headers: {}
    }
  });

  const matched = await client.assignUserById(7, 701, 200, 'stranger');
  assert.strictEqual(matched, null);
});

asyncTest('TC-AUB-003: assignUserById swallows "already assigned" and returns uid', async () => {
  const { client } = makeClient({
    'GET:/index.php/apps/deck/api/v1.0/boards/7': {
      status: 200,
      body: { id: 7, users: [{ uid: 'alice', primaryKey: 'alice' }] },
      headers: {}
    },
    'PUT:/index.php/apps/deck/api/v1.0/boards/7/stacks/701/cards/200/assignUser': {
      status: 400, body: { message: 'User already assigned' }, headers: {}
    }
  });

  const matched = await client.assignUserById(7, 701, 200, 'alice');
  assert.strictEqual(matched, 'alice');
});

asyncTest('TC-UUB-001: unassignUserById PUTs to unassignUser endpoint', async () => {
  const { client, nc } = makeClient({
    'GET:/index.php/apps/deck/api/v1.0/boards/7': {
      status: 200,
      body: { id: 7, users: [{ uid: 'alice', primaryKey: 'alice' }] },
      headers: {}
    },
    'PUT:/index.php/apps/deck/api/v1.0/boards/7/stacks/701/cards/200/unassignUser': { status: 200, body: {}, headers: {} }
  });

  const matched = await client.unassignUserById(7, 701, 200, 'alice');
  assert.strictEqual(matched, 'alice');
  const call = nc._calls.find(c => c.path.endsWith('/unassignUser'));
  assert.ok(call);
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
