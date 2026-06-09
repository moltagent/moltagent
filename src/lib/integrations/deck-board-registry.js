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
 * Pattern: Role-to-ID registry persisted as a small JSON file, treated as the
 * canonical source of truth.  resolveBoard falls through memory → disk → null;
 * it never scans live Deck titles (#49), so an emoji-prefixed or renamed board
 * cannot break resolution.  A cache miss re-reads disk, so a registerBoard run
 * from a separate process is picked up without a restart.  Atomic writes (tmp +
 * rename) keep the file consistent even if the process crashes mid-write.
 *
 * Key Dependencies:
 *   - fs (Node built-in) — file I/O, atomic rename
 *   - path (Node built-in) — cross-platform path resolution
 *
 * Data Flow:
 *   resolveBoard(role)
 *     -> cold cache?          -> _loadFromDisk()
 *     -> role still missing?  -> _loadFromDisk() again (picks up out-of-process writes)
 *     -> return _cache[role]?.boardId ?? null   (no live title scan)
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
   * Resolve a board by role.  The registry is canonical: memory → disk → null.
   * It never scans live Deck titles (#49), so an emoji-prefixed or renamed board
   * cannot break resolution.  An unregistered role returns null; the caller
   * raises an actionable "register it" error.
   *
   * @param {Object} _deckClient - Unused; retained for signature stability (callers pass their DeckClient).
   * @param {string} role - One of ROLES.*
   * @param {string} _fallbackTitle - Unused; retained for signature stability (was the live-scan title).
   * @returns {Promise<number|string|null>} boardId, or null if not registered
   */
  // eslint-disable-next-line require-await -- async retained for the caller contract (callers await this); resolution is now a pure memory/disk read with no async work
  async resolveBoard(_deckClient, role, _fallbackTitle) {
    // Cold cache — load from disk once.
    if (this._cache === null) {
      this._loadFromDisk();
    }

    // Re-read disk on a miss so a registerBoard from a separate process is
    // picked up without a restart (#49 Part B).  Skipped in test mode, where
    // _reset() pins a clean in-memory slate and the disk must not be re-read.
    if (!this._cache[role] && !this._testMode) {
      this._loadFromDisk();
    }

    return this._cache[role]?.boardId ?? null;
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
