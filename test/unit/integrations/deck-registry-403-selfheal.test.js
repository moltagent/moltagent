/**
 * Moltagent - DeckClient.findBoard() 403 self-heal tests
 *
 * Copyright (C) 2026 Moltagent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 * Architecture Brief:
 * -------------------
 * Problem: A board cached in the registry under a given role can become
 * unreachable for two distinct reasons: the board was deleted (404) or the
 * identity no longer has access (403 — board recreated with a new id, trashed,
 * or unshared). In both cases the registry entry is stale and must be
 * invalidated so findBoard() can re-resolve by name scan.
 *
 * These tests verify:
 * 1. 404 from getBoard() still invalidates and falls through (regression guard)
 * 2. 403 from getBoard() now also invalidates and falls through (new behavior)
 * 3. 500 from getBoard() is re-thrown; invalidateBoard is NOT called
 * 4. After a 403 fall-through, a matching board in listBoards is returned and
 *    registerBoard is called with the new id (cockpit heal shape)
 * 5. After a 403 fall-through, an empty listBoards returns null (knowledge
 *    shape; ensureBoard then creates the board)
 * 6. ensureBoard() listBoards rejection propagates; createBoard is NOT called
 *    (proves create-on-confirmed-absence without a new guard)
 *
 * Isolation note: boardRegistry is a module singleton. A single _reset()
 * call at module load puts it in test-mode (no disk writes, empty cache).
 * Each test uses a globally unique role string; tests do NOT call _reset()
 * themselves so they cannot wipe each other's seeded entries, even when
 * asyncTests execute concurrently.
 *
 * Run: NC_URL=https://test.example.com node test/unit/integrations/deck-registry-403-selfheal.test.js
 *
 * @module test/unit/integrations/deck-registry-403-selfheal
 */

'use strict';

const assert = require('assert');
const { asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

const DeckClient = require('../../../src/lib/integrations/deck-client');
const boardRegistry = require('../../../src/lib/integrations/deck-board-registry');

// Single reset at module load — puts registry in test mode (no disk I/O),
// empty cache. Individual tests do NOT reset; each uses a unique role string.
boardRegistry._reset();

// ============================================================
// Helpers
// ============================================================

/**
 * Build a minimal NC mock that covers the two paths exercised by findBoard():
 *   - GET /boards          (listBoards)
 *   - GET /boards/<id>     (getBoard)
 *
 * Each handler can be a function (receives path, options) or a plain object.
 * A missing handler falls through to a safe 200 default.
 */
function makeMockNC({ listBoards, getBoard } = {}) {
  return {
    ncUrl: 'https://cloud.example.com',
    ncUser: 'testuser',
    request: async (path, options = {}) => {
      const method = options.method || 'GET';

      // GET /index.php/apps/deck/api/v1.0/boards  (list all boards)
      if (method === 'GET' && path === '/index.php/apps/deck/api/v1.0/boards') {
        if (typeof listBoards === 'function') return listBoards(path, options);
        if (listBoards !== undefined) return listBoards;
        return { status: 200, body: [], headers: {} };
      }

      // GET /index.php/apps/deck/api/v1.0/boards/<id>  (single board)
      if (method === 'GET' && /^\/index\.php\/apps\/deck\/api\/v1\.0\/boards\/\d+$/.test(path)) {
        if (typeof getBoard === 'function') return getBoard(path, options);
        if (getBoard !== undefined) return getBoard;
        return { status: 200, body: {}, headers: {} };
      }

      return { status: 200, body: {}, headers: {} };
    },
    getMetrics: () => ({}),
    invalidateCache: () => {},
    shutdown: async () => {}
  };
}

/** Create an error with an HTTP status code, as DeckClient._request produces */
function makeHttpError(statusCode, message) {
  const err = new Error(message || `HTTP ${statusCode}`);
  err.statusCode = statusCode;
  return err;
}

// ============================================================
// Tests
// ============================================================

console.log('\n=== DeckClient findBoard() 403 self-heal tests ===\n');

// ---------------------------------------------------------------------------
// TC-403-001: 404 from getBoard() invalidates and falls through (regression)
// ---------------------------------------------------------------------------
asyncTest('TC-403-001: 404 from getBoard() invalidates registry and falls through to name scan', async () => {
  const role = 'tc403001-tasks';
  boardRegistry.registerBoard(role, 42);

  const nc = makeMockNC({
    // 404 — simulates a board that was deleted
    getBoard: () => { throw makeHttpError(404, 'Not Found'); },
    // name scan returns empty — findBoard returns null after invalidation
    listBoards: () => ({ status: 200, body: [], headers: {} })
  });

  const client = new DeckClient(nc, { role, boardName: 'Moltagent Tasks' });
  const result = await client.findBoard();

  // The registry entry must have been removed by invalidateBoard()
  const all = boardRegistry.getAll();
  assert.ok(
    !Object.prototype.hasOwnProperty.call(all, role),
    'registry entry must be removed after 404'
  );
  assert.strictEqual(result, null, 'findBoard returns null when name scan yields nothing');
});

// ---------------------------------------------------------------------------
// TC-403-002: 403 from getBoard() invalidates and falls through (new behavior)
// ---------------------------------------------------------------------------
asyncTest('TC-403-002: 403 from getBoard() invalidates registry and falls through to name scan', async () => {
  const role = 'tc403002-tasks';
  boardRegistry.registerBoard(role, 99);

  const nc = makeMockNC({
    // 403 — simulates a stale id (board recreated, trashed, or unshared)
    getBoard: () => { throw makeHttpError(403, 'Permission denied'); },
    listBoards: () => ({ status: 200, body: [], headers: {} })
  });

  const client = new DeckClient(nc, { role, boardName: 'Moltagent Tasks' });
  const result = await client.findBoard();

  const all = boardRegistry.getAll();
  assert.ok(
    !Object.prototype.hasOwnProperty.call(all, role),
    'registry entry must be removed after 403'
  );
  assert.strictEqual(result, null, 'findBoard returns null when name scan yields nothing');
});

// ---------------------------------------------------------------------------
// TC-403-003: 500 from getBoard() re-throws; registry entry is preserved
// ---------------------------------------------------------------------------
asyncTest('TC-403-003: 500 from getBoard() re-throws; invalidateBoard is NOT called', async () => {
  const role = 'tc403003-tasks';
  boardRegistry.registerBoard(role, 77);

  const nc = makeMockNC({
    // 500 must propagate — it is a real server error, not a stale-id signal
    getBoard: () => { throw makeHttpError(500, 'Internal Server Error'); }
  });

  const client = new DeckClient(nc, { role, boardName: 'Moltagent Tasks' });

  let thrownError = null;
  try {
    await client.findBoard();
  } catch (err) {
    thrownError = err;
  }

  assert.ok(thrownError !== null, 'findBoard must re-throw on 500');
  assert.strictEqual(thrownError.statusCode, 500, 'thrown error must preserve statusCode 500');

  // Registry entry must still be present — invalidateBoard must NOT have fired
  const all = boardRegistry.getAll();
  assert.ok(
    Object.prototype.hasOwnProperty.call(all, role),
    'registry entry must remain intact after a 500 (no invalidation)'
  );
  assert.strictEqual(all[role].boardId, 77, 'cached boardId must still be 77');
});

// ---------------------------------------------------------------------------
// TC-403-004: 403 fall-through, name scan finds board → return & re-register
// ---------------------------------------------------------------------------
asyncTest('TC-403-004: 403 fall-through + matching board in listBoards → returns board, registerBoard called', async () => {
  const role = 'tc403004-cockpit';
  boardRegistry.registerBoard(role, 200); // stale id

  const nc = makeMockNC({
    getBoard: () => { throw makeHttpError(403, 'Permission denied'); },
    listBoards: () => ({
      status: 200,
      body: [
        { id: 201, title: 'Moltagent Cockpit', stacks: [], labels: [] }
      ],
      headers: {}
    })
  });

  const client = new DeckClient(nc, { role, boardName: 'Moltagent Cockpit' });
  const result = await client.findBoard();

  assert.ok(result !== null, 'findBoard must return the discovered board');
  assert.strictEqual(result.id, 201, 'board id must be 201 from the name scan');

  // registerBoard must have been called with the new id
  const all = boardRegistry.getAll();
  assert.ok(
    Object.prototype.hasOwnProperty.call(all, role),
    'role must be re-registered after name scan'
  );
  assert.strictEqual(all[role].boardId, 201, 'registered boardId must be the new id 201');
});

// ---------------------------------------------------------------------------
// TC-403-005: 403 fall-through, name scan finds no match → null
// ---------------------------------------------------------------------------
asyncTest('TC-403-005: 403 fall-through + no match in listBoards → returns null', async () => {
  const role = 'tc403005-knowledge';
  boardRegistry.registerBoard(role, 300);

  const nc = makeMockNC({
    getBoard: () => { throw makeHttpError(403, 'Permission denied'); },
    listBoards: () => ({
      status: 200,
      body: [
        { id: 999, title: 'Unrelated Board', stacks: [], labels: [] }
      ],
      headers: {}
    })
  });

  const client = new DeckClient(nc, { role, boardName: 'Moltagent Knowledge' });
  const result = await client.findBoard();

  assert.strictEqual(result, null, 'findBoard must return null when no title matches');
});

// ---------------------------------------------------------------------------
// TC-403-006: ensureBoard() listBoards rejection propagates; createBoard NOT called
// ---------------------------------------------------------------------------
asyncTest('TC-403-006: ensureBoard() listBoards rejection propagates; createBoard is NOT called', async () => {
  // No registry entry for this role — findBoard goes straight to listBoards
  const role = 'tc403006-tasks';

  let createBoardCalled = false;

  const nc = makeMockNC({
    // listBoards throws — simulates an instance-wide failure (e.g. auth down)
    listBoards: () => { throw makeHttpError(503, 'Service Unavailable'); }
  });

  const client = new DeckClient(nc, { role, boardName: 'Moltagent Tasks' });

  // Spy on createBoard to confirm it is never called
  const origCreateBoard = client.createBoard.bind(client);
  client.createBoard = async (...args) => {
    createBoardCalled = true;
    return origCreateBoard(...args);
  };

  let thrownError = null;
  try {
    await client.ensureBoard();
  } catch (err) {
    thrownError = err;
  }

  assert.ok(thrownError !== null, 'ensureBoard must propagate the listBoards error');
  assert.strictEqual(thrownError.statusCode, 503, 'error statusCode must be 503');
  assert.strictEqual(createBoardCalled, false, 'createBoard must NOT be called when listBoards rejects');
});

// ============================================================
// Summary
// ============================================================

setTimeout(() => {
  summary();
  exitWithCode();
}, 500);
