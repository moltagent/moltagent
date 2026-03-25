/**
 * Moltagent - Deck Board Registry Tests
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
 * Tests:
 * - TC-REG-001: ROLES exports all expected board roles
 * - TC-REG-002: resolveBoard returns null when no registry, no deckClient
 * - TC-REG-003: resolveBoard falls back to name match and registers
 * - TC-REG-004: resolveBoard returns cached ID on second call (no listBoards)
 * - TC-REG-005: registerBoard + getAll round-trip
 * - TC-REG-006: invalidateBoard removes entry
 * - TC-REG-007: resolveBoard does case-insensitive title matching
 * - TC-REG-008: resolveBoard returns null when title doesn't match
 * - TC-REG-009: _reset clears all state
 *
 * Run: node test/unit/integrations/deck-board-registry.test.js
 */

'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

const boardRegistry = require('../../../src/lib/integrations/deck-board-registry');
const { ROLES } = require('../../../src/lib/integrations/deck-board-registry');

// ============================================================
// TC-REG-001: ROLES exports all expected board roles
// ============================================================

test('TC-REG-001: ROLES exports all expected board roles', () => {
  boardRegistry._reset();

  assert.strictEqual(typeof ROLES, 'object');
  assert.ok(ROLES !== null && !Array.isArray(ROLES));

  assert.strictEqual(ROLES.tasks,    'tasks');
  assert.strictEqual(ROLES.cockpit,  'cockpit');
  assert.strictEqual(ROLES.personal, 'personal');
  assert.strictEqual(ROLES.knowledge, 'knowledge');
  assert.strictEqual(ROLES.meetings, 'meetings');
});

// ============================================================
// TC-REG-002: resolveBoard returns null when no registry, no deckClient
// ============================================================

asyncTest('TC-REG-002: resolveBoard returns null when no registry, no deckClient', async () => {
  boardRegistry._reset();

  const result = await boardRegistry.resolveBoard(null, 'cockpit', 'Test');
  assert.strictEqual(result, null);
});

// ============================================================
// TC-REG-003: resolveBoard falls back to name match and registers
// ============================================================

asyncTest('TC-REG-003: resolveBoard falls back to name match and registers', async () => {
  boardRegistry._reset();

  const mockDeck = {
    listBoards: async () => [{ id: 42, title: 'My Board' }],
  };

  // Use a unique role ('knowledge') so concurrent async tests targeting
  // 'cockpit' (TC-REG-007) cannot collide with this one.
  const id = await boardRegistry.resolveBoard(mockDeck, 'knowledge', 'My Board');

  assert.strictEqual(id, 42);
  assert.strictEqual(boardRegistry.getAll().knowledge.boardId, 42);
});

// ============================================================
// TC-REG-004: resolveBoard returns cached ID on second call (no listBoards)
// ============================================================

asyncTest('TC-REG-004: resolveBoard returns cached ID on second call (no listBoards)', async () => {
  boardRegistry._reset();

  // Seed the cache using the 'meetings' role to avoid collision with other
  // async tests that use 'cockpit' or 'knowledge'.
  const seedDeck = {
    listBoards: async () => [{ id: 42, title: 'Cache Test Board' }],
  };
  await boardRegistry.resolveBoard(seedDeck, 'meetings', 'Cache Test Board');

  // Second call: deckClient throws if listBoards is ever reached
  const throwingDeck = {
    listBoards: async () => { throw new Error('listBoards must not be called on cache hit'); },
  };

  const id = await boardRegistry.resolveBoard(throwingDeck, 'meetings', 'Cache Test Board');
  assert.strictEqual(id, 42);
});

// ============================================================
// TC-REG-005: registerBoard + getAll round-trip
// ============================================================

test('TC-REG-005: registerBoard + getAll round-trip', () => {
  boardRegistry._reset();

  boardRegistry.registerBoard('tasks', 99);

  const all = boardRegistry.getAll();
  assert.strictEqual(all.tasks.boardId, 99);

  // registeredAt must be a valid ISO date string
  const ts = new Date(all.tasks.registeredAt);
  assert.ok(!isNaN(ts.getTime()), 'registeredAt should be a valid ISO date string');
  assert.strictEqual(typeof all.tasks.registeredAt, 'string');
  assert.ok(all.tasks.registeredAt.includes('T'), 'registeredAt should contain ISO T separator');
});

// ============================================================
// TC-REG-006: invalidateBoard removes entry
// ============================================================

test('TC-REG-006: invalidateBoard removes entry', () => {
  boardRegistry._reset();

  boardRegistry.registerBoard('meetings', 55);
  assert.strictEqual(boardRegistry.getAll().meetings.boardId, 55);

  boardRegistry.invalidateBoard('meetings');

  const all = boardRegistry.getAll();
  assert.ok(!Object.prototype.hasOwnProperty.call(all, 'meetings'), 'meetings entry should be removed after invalidation');
});

// ============================================================
// TC-REG-007: resolveBoard does case-insensitive title matching
// ============================================================

asyncTest('TC-REG-007: resolveBoard does case-insensitive title matching', async () => {
  boardRegistry._reset();

  const mockDeck = {
    listBoards: async () => [{ id: 7, title: '⭐ Moltagent Cockpit' }],
  };

  const id = await boardRegistry.resolveBoard(mockDeck, 'cockpit', '⭐ moltagent cockpit');
  assert.strictEqual(id, 7);
});

// ============================================================
// TC-REG-008: resolveBoard returns null when title doesn't match
// ============================================================

asyncTest('TC-REG-008: resolveBoard returns null when title does not match', async () => {
  boardRegistry._reset();

  const mockDeck = {
    listBoards: async () => [{ id: 1, title: 'Unrelated Board' }],
  };

  const result = await boardRegistry.resolveBoard(mockDeck, 'tasks', 'MoltAgent Tasks');
  assert.strictEqual(result, null);

  const all = boardRegistry.getAll();
  assert.ok(!Object.prototype.hasOwnProperty.call(all, 'tasks'), 'tasks entry should not be registered on title mismatch');
});

// ============================================================
// TC-REG-009: _reset clears all state
// ============================================================

test('TC-REG-009: _reset clears all state', () => {
  // Register two boards first
  boardRegistry.registerBoard('tasks',    10);
  boardRegistry.registerBoard('personal', 20);

  assert.strictEqual(boardRegistry.getAll().tasks.boardId,    10);
  assert.strictEqual(boardRegistry.getAll().personal.boardId, 20);

  boardRegistry._reset();

  const all = boardRegistry.getAll();
  assert.deepStrictEqual(all, {}, '_reset should leave getAll() returning an empty object');
});

// ============================================================
// Summary
// ============================================================

setTimeout(() => {
  summary();
  exitWithCode();
}, 500);
