/**
 * Moltagent - Deck Board Registry
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
 * Problem: Board lookups by title break when a board is renamed.  Every caller
 * that does listBoards().find(b => b.title === name) is fragile.  A renamed
 * board becomes invisible until code is changed or a new board is created.
 *
 * Pattern: Role-to-ID registry persisted as a small JSON file.  On first
 * access per role the registry falls through: memory → disk → live name scan.
 * Once an ID is found it is stored and subsequent lookups are O(1) memory
 * reads, with no Deck API traffic at all.  Atomic writes (tmp + rename) keep
 * the file consistent even if the process crashes mid-write.
 *
 * Key Dependencies:
 *   - fs (Node built-in) — file I/O, atomic rename
 *   - path (Node built-in) — cross-platform path resolution
 *   - DeckClient.listBoards() — fallback name scan (caller-supplied)
 *
 * Data Flow:
 *   resolveBoard(deckClient, role, fallbackTitle)
 *     -> _cache hit?          -> return boardId
 *     -> _loadFromDisk()      -> cache populated from file? -> return boardId
 *     -> deckClient.listBoards() -> name match? -> registerBoard() -> return boardId
 *     -> no match             -> return null
 *
 *   registerBoard(role, boardId)
 *     -> update _cache
 *     -> _saveToDisk() (atomic tmp-rename)
 *
 * Dependency Map:
 *   deck-board-registry.js depends on: fs, path (built-ins only)
 *   Used by: cockpit-manager.js, personal-board-manager.js, heartbeat-manager.js
 *
 * @module integrations/deck-board-registry
 * @version 1.0.0
 */

'use strict';

const fs   = require('fs');
const path = require('path');

/** Canonical role identifiers for all known agent boards. */
const ROLES = {
  tasks:    'tasks',
  cockpit:  'cockpit',
  personal: 'personal',
  knowledge: 'knowledge',
  meetings: 'meetings',
};

const DATA_DIR  = path.resolve(process.cwd(), 'data');
const REGISTRY_FILE = path.join(DATA_DIR, 'deck-board-registry.json');
const TMP_FILE      = REGISTRY_FILE + '.tmp';

class DeckBoardRegistry {
  constructor() {
    /** @type {Object.<string, {boardId: number|string, registeredAt: string}>} */
    this._cache = null; // null = not yet loaded
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Resolve a board by role.  Falls through memory → disk → live name scan.
   *
   * @param {Object} deckClient - DeckClient instance (must expose listBoards())
   * @param {string} role - One of ROLES.*
   * @param {string} fallbackTitle - Board title used for the live name scan
   * @returns {Promise<number|string|null>} boardId, or null if not found
   */
  async resolveBoard(deckClient, role, fallbackTitle) {
    // 1. Memory hit
    if (this._cache !== null && this._cache[role]) {
      return this._cache[role].boardId;
    }

    // 2. Cold cache — load from disk first
    if (this._cache === null) {
      this._loadFromDisk();
    }

    if (this._cache[role]) {
      return this._cache[role].boardId;
    }

    // 3. First-boot migration: scan boards by name (runs once, then never again)
    if (!deckClient || typeof deckClient.listBoards !== 'function') {
      return null;
    }

    const boards = await deckClient.listBoards();
    if (!Array.isArray(boards)) return null;

    const needle = (fallbackTitle || '').trim().toLowerCase();
    const match  = boards.find(b => (b.title || '').trim().toLowerCase() === needle);

    if (match) {
      this.registerBoard(role, match.id);
      return match.id;
    }

    // No exact match — log what exists so the operator can resolve manually
    const existing = boards.map(b => `  ${b.id}: "${b.title}"`).join('\n');
    console.warn(
      `[DeckBoardRegistry] No board matching "${fallbackTitle}" for role "${role}".\n` +
      `Existing boards:\n${existing}\n` +
      `If the board was renamed, register it manually:\n` +
      `  node -e "require('./src/lib/integrations/deck-board-registry').registerBoard('${role}', BOARD_ID)"`
    );
    return null;
  }

  /**
   * Register a role → boardId mapping and persist it to disk.
   *
   * @param {string} role - Role key
   * @param {number|string} boardId - Deck board ID
   */
  registerBoard(role, boardId) {
    if (!role || boardId == null) return;
    if (this._cache === null) this._loadFromDisk();

    this._cache[role] = {
      boardId,
      registeredAt: new Date().toISOString(),
    };

    this._saveToDisk();
  }

  /**
   * Remove a role from the registry (call when a 404 confirms the board is gone).
   *
   * @param {string} role - Role key to remove
   */
  invalidateBoard(role) {
    if (this._cache === null) this._loadFromDisk();

    if (Object.prototype.hasOwnProperty.call(this._cache, role)) {
      delete this._cache[role];
      this._saveToDisk();
    }
  }

  /**
   * Return a shallow copy of all current mappings (for diagnostics).
   *
   * @returns {Object}
   */
  getAll() {
    if (this._cache === null) this._loadFromDisk();
    return Object.assign({}, this._cache);
  }

  /**
   * Reset internal state.  Intended for use in tests only.
   * Sets cache to an empty object (not null) so the disk file is not
   * re-read on the next resolveBoard call, giving tests a clean slate.
   * Enables test mode to prevent disk writes from clobbering production data.
   */
  _reset() {
    this._cache = {};
    this._testMode = true;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Load the registry file into _cache.  Initialises _cache to {} on any error
   * (missing file, corrupt JSON) so callers always get a plain object back.
   */
  _loadFromDisk() {
    try {
      const raw = fs.readFileSync(REGISTRY_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      // Validate: must be a plain object
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this._cache = parsed;
        return;
      }
    } catch (_err) {
      // Missing file or corrupt JSON — start fresh
    }
    this._cache = {};
  }

  /**
   * Write _cache to disk atomically: serialise to TMP_FILE then rename over
   * REGISTRY_FILE.  Creates DATA_DIR if it does not exist yet.
   */
  _saveToDisk() {
    if (this._testMode) return; // Tests must not clobber production registry
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      const payload = JSON.stringify(this._cache, null, 2);
      fs.writeFileSync(TMP_FILE, payload, 'utf8');
      fs.renameSync(TMP_FILE, REGISTRY_FILE);
    } catch (err) {
      console.error('[DeckBoardRegistry] Failed to persist registry:', err.message);
      // Non-fatal: in-memory cache still works for the rest of this process run
    }
  }
}

// Singleton instance
const registry = new DeckBoardRegistry();

module.exports = registry;
module.exports.ROLES = ROLES;
