/**
 * MoltAgent NC Deck Client — Generic CRUD Tests (v2)
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
 * MoltAgent — Sovereign AI Agent for Nextcloud
 * Copyright (C) 2024  MoltAgent Contributors
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

asyncTest('TC-UB-001: updateBoard sends PUT with updates and returns updated board', async () => {
  const updated = { id: 5, title: 'Renamed Board', color: 'ff0000', archived: false };
  const { client, nc } = makeClient({
    'PUT:/index.php/apps/deck/api/v1.0/boards/5': { status: 200, body: updated, headers: {} }
  });

  const result = await client.updateBoard(5, { title: 'Renamed Board' });

  assert.strictEqual(result.title, 'Renamed Board');
  const call = nc._calls.find(c => c.method === 'PUT' && c.path === '/index.php/apps/deck/api/v1.0/boards/5');
  assert.ok(call, 'PUT to /boards/5 should have been made');
  assert.strictEqual(call.body.title, 'Renamed Board');
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

asyncTest('TC-US-001: updateStack sends PUT to correct path with updates', async () => {
  const updatedStack = { id: 201, title: 'Backlog', order: 1 };
  const { client, nc } = makeClient({
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

setTimeout(() => { summary(); exitWithCode(); }, 500);
