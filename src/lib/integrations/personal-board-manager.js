/**
 * Moltagent - Personal Board Manager (Deck Working Memory)
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
 * Problem: The agent needs persistent working memory that is visible to the
 * owner, supports prioritisation, and survives restarts.  A Nextcloud Deck
 * board ("Personal") serves as a kanban-style scratch pad where the agent
 * tracks its own tasks through Inbox -> Doing -> Done lifecycle.
 *
 * Pattern: Manager wraps a DeckClient configured for the Personal board with
 * five stacks and five labels.  A heartbeat-driven executive loop
 * (processPersonalBoard) enforces time-based policies: overdue planned cards
 * drop to inbox, stale doing cards trigger owner notifications, completed
 * cards are archived after 7 days, and the inbox is auto-picked by priority
 * score when doing is empty.
 *
 * Key Dependencies:
 *   - DeckClient (deck-client.js) — all Deck API operations
 *   - llmRouter — reserved for future AI-driven triage (unused today)
 *   - notifyUser callback — surfaces stale-card alerts to the owner
 *
 * Data Flow:
 *   heartbeat tick
 *     -> processPersonalBoard()
 *       -> _checkPlanned()  : past-due planned cards -> inbox
 *       -> _checkWaiting()  : cards with new human comments -> doing
 *       -> _checkDone()     : cards older than 7 days -> delete (archive)
 *       -> _checkDoing()    : stale doing card -> notify owner
 *       -> _pickFromInbox() : if doing empty, highest-priority inbox card -> doing
 *     -> return { planned, waiting, done, doing, picked }
 *
 * Dependency Map:
 *   personal-board-manager.js depends on: deck-client.js
 *   Used by: heartbeat-manager (future), daily-digester (future)
 *
 * @module integrations/personal-board-manager
 * @version 1.0.0
 */

'use strict';

const DeckClient = require('./deck-client');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOG_PREFIX = '[PersonalBoard]';

const BOARD_NAME = 'Personal';

const STACKS = {
  inbox: 'Inbox',
  doing: 'Doing',
  waiting: 'Waiting',
  planned: 'Planned',
  done: 'Done'
};

const LABELS = [
  { title: 'research', color: '31CC7C' },
  { title: 'follow-up', color: 'ED7D31' },
  { title: 'waiting-input', color: 'FF6F61' },
  { title: 'ingestion', color: '4472C4' },
  { title: 'promise', color: '9B59B6' }
];

const MS_PER_DAY = 24 * 3600 * 1000;

class PersonalBoardManager {
  /**
   * Create a new PersonalBoardManager.
   *
   * @param {Object} opts
   * @param {Object} opts.ncRequestManager - NCRequestManager instance for Deck API calls
   * @param {Object} opts.llmRouter - LLM router for future AI-driven triage
   * @param {Function} opts.notifyUser - Callback to send notifications to the owner
   * @param {Object} [opts.config] - Optional configuration overrides
   * @param {string} [opts.config.ownerUser] - Nextcloud username to share the board with
   */
  constructor({ ncRequestManager, llmRouter, notifyUser, config }) {
    if (!ncRequestManager) {
      throw new Error(`${LOG_PREFIX} ncRequestManager is required`);
    }

    this.deck = new DeckClient(ncRequestManager, {
      boardName: BOARD_NAME,
      stacks: STACKS,
      labels: LABELS
    });

    this.llmRouter = llmRouter || null;
    this.notifyUser = notifyUser || (() => {});
    this._initialized = false;
    this._ownerUser = config?.ownerUser || null;

    /** @type {number} Max age (ms) before a doing card is considered stale */
    this.STALE_DOING_MS = 48 * 3600 * 1000;

    /** @type {number} Days before a waiting card is considered stale */
    this.STALE_WAITING_DAYS = 7;

    /** @type {number} Days after which done cards are archived (deleted) */
    this.DONE_ARCHIVE_DAYS = 7;
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /**
   * Initialize the Personal board, creating it if necessary and sharing with
   * the owner user when configured.
   *
   * Safe to call multiple times; subsequent calls are no-ops.
   *
   * @returns {Promise<void>}
   */
  async initialize() {
    if (this._initialized) return;

    try {
      const result = await this.deck.ensureBoard();
      console.log(`${LOG_PREFIX} Board ensured (id=${result.boardId})`);

      if (this._ownerUser && result.boardId) {
        try {
          await this.deck.shareBoardWithUser(result.boardId, this._ownerUser);
          console.log(`${LOG_PREFIX} Board shared with user: ${this._ownerUser}`);
        } catch (shareErr) {
          // Sharing may fail if already shared or user doesn't exist — log and continue
          console.log(`${LOG_PREFIX} Could not share board with ${this._ownerUser}: ${shareErr.message}`);
        }
      }

      this._initialized = true;
    } catch (err) {
      console.log(`${LOG_PREFIX} Initialization failed: ${err.message}`);
    }
  }

  /**
   * Create a new card in the Inbox stack of the Personal board.
   *
   * @param {Object} opts
   * @param {string} opts.title - Card title
   * @param {string} [opts.description] - Card description / body
   * @param {string} [opts.label] - Label name to attach (must match a configured label)
   * @param {string} [opts.duedate] - ISO 8601 due date string
   * @returns {Promise<Object|null>} The created card object, or null on error
   */
  async createPersonalCard({ title, description, label, duedate }) {
    try {
      await this._ensureInit();

      const card = await this.deck.createCard('inbox', { title, description, duedate });
      console.log(`${LOG_PREFIX} Created card "${title}" (id=${card?.id})`);

      if (label && card?.id) {
        try {
          await this.deck.addLabel(card.id, 'inbox', label);
        } catch (labelErr) {
          console.log(`${LOG_PREFIX} Could not add label "${label}" to card ${card.id}: ${labelErr.message}`);
        }
      }

      return card;
    } catch (err) {
      console.log(`${LOG_PREFIX} Failed to create card "${title}": ${err.message}`);
      return null;
    }
  }

  /**
   * Executive loop — run once per heartbeat tick.
   *
   * Performs all time-based policies in sequence: planned overflow, waiting
   * check, done archival, doing staleness check, and inbox auto-pick.
   *
   * @returns {Promise<Object>} Summary of actions taken:
   *   { planned: number, waiting: number, done: number,
   *     doing: { stale: boolean, cardTitle: string|null },
   *     picked: string|null }
   */
  async processPersonalBoard() {
    try {
      await this._ensureInit();
    } catch (err) {
      console.log(`${LOG_PREFIX} Cannot process board — not initialized: ${err.message}`);
      return { planned: 0, waiting: 0, done: 0, doing: { stale: false, cardTitle: null }, picked: null };
    }

    const planned = await this._checkPlanned();
    const waiting = await this._checkWaiting();
    const done = await this._checkDone();
    const doing = await this._checkDoing();
    const picked = await this._pickFromInbox();

    console.log(
      `${LOG_PREFIX} Heartbeat: planned=${planned} waiting=${waiting} done=${done}` +
      ` doing.stale=${doing.stale} picked=${picked || 'none'}`
    );

    return { planned, waiting, done, doing, picked };
  }

  /**
   * Build a human-readable summary of the board's current state for the
   * daily digest or context injection.
   *
   * @returns {Promise<string>} Markdown-formatted summary
   */
  async getWorkingMemorySummary() {
    try {
      await this._ensureInit();
    } catch (err) {
      return '\u{1F4CB} Working Memory: unavailable (board not initialized)';
    }

    try {
      const [doingCards, waitingCards, plannedCards, inboxCards, doneCards] = await Promise.all([
        this._safeGetCards('doing'),
        this._safeGetCards('waiting'),
        this._safeGetCards('planned'),
        this._safeGetCards('inbox'),
        this._safeGetCards('done')
      ]);

      const lines = ['\u{1F4CB} Working Memory:'];

      // Doing
      if (doingCards.length > 0) {
        const card = doingCards[0];
        const since = this._formatDate(card.lastModified || card.createdAt);
        lines.push(`\u2022 Doing: ${card.title} (since ${since})`);
      } else {
        lines.push('\u2022 Doing: nothing active');
      }

      // Waiting
      if (waitingCards.length > 0) {
        const titles = waitingCards.map(c => c.title).join(', ');
        lines.push(`\u2022 Waiting (${waitingCards.length}): ${titles}`);
      }

      // Planned
      if (plannedCards.length > 0) {
        const titles = plannedCards.map(c => c.title).join(', ');
        const nextDue = this._findNextDue(plannedCards);
        const dueStr = nextDue ? `, next due ${this._formatDate(nextDue)}` : '';
        lines.push(`\u2022 Planned (${plannedCards.length}): ${titles}${dueStr}`);
      }

      // Inbox
      if (inboxCards.length > 0) {
        const titles = inboxCards.map(c => c.title).join(', ');
        lines.push(`\u2022 Inbox (${inboxCards.length}): ${titles}`);
      }

      // Done
      if (doneCards.length > 0) {
        lines.push(`\u2022 Done (${doneCards.length}): completed recently`);
      }

      return lines.join('\n');
    } catch (err) {
      console.log(`${LOG_PREFIX} Failed to build summary: ${err.message}`);
      return '\u{1F4CB} Working Memory: error reading board';
    }
  }

  // =========================================================================
  // Private — Policy checks
  // =========================================================================

  /**
   * Move planned cards whose due date has passed into the inbox.
   *
   * @returns {Promise<number>} Count of cards moved
   * @private
   */
  async _checkPlanned() {
    let moved = 0;
    try {
      const cards = await this.deck.getCardsInStack('planned');
      const now = Date.now();

      for (const card of cards) {
        if (!card.duedate) continue;
        const due = new Date(card.duedate).getTime();
        if (Number.isFinite(due) && due <= now) {
          await this.deck.moveCard(card.id, 'planned', 'inbox');
          console.log(`${LOG_PREFIX} Planned card "${card.title}" is past due — moved to inbox`);
          moved++;
        }
      }
    } catch (err) {
      console.log(`${LOG_PREFIX} _checkPlanned error: ${err.message}`);
    }
    return moved;
  }

  /**
   * Check waiting cards for new human comments and move them to doing.
   *
   * A card is moved when its newest comment is from a user (not the agent).
   *
   * @returns {Promise<number>} Count of cards moved
   * @private
   */
  async _checkWaiting() {
    let moved = 0;
    try {
      const cards = await this.deck.getCardsInStack('waiting');
      const botUser = (this.deck.username || 'moltagent').toLowerCase();

      for (const card of cards) {
        try {
          const comments = await this.deck.getComments(card.id);
          if (!comments || comments.length === 0) continue;

          // Find newest comment by ID (higher = newer)
          let newest = null;
          for (const c of comments) {
            if (!newest || (c.id || 0) > (newest.id || 0)) {
              newest = c;
            }
          }

          if (newest && (newest.actorId || '').toLowerCase() !== botUser) {
            await this.deck.moveCard(card.id, 'waiting', 'doing');
            console.log(`${LOG_PREFIX} Waiting card "${card.title}" has new human comment — moved to doing`);
            moved++;
          }
        } catch (commentErr) {
          console.log(`${LOG_PREFIX} Could not check comments for card ${card.id}: ${commentErr.message}`);
        }
      }
    } catch (err) {
      console.log(`${LOG_PREFIX} _checkWaiting error: ${err.message}`);
    }
    return moved;
  }

  /**
   * Archive (delete) done cards older than DONE_ARCHIVE_DAYS.
   *
   * Uses lastModified falling back to createdAt to determine age.
   *
   * @returns {Promise<number>} Count of cards archived
   * @private
   */
  async _checkDone() {
    let archived = 0;
    try {
      const cards = await this.deck.getCardsInStack('done');
      const cutoffSec = Math.floor(Date.now() / 1000) - (this.DONE_ARCHIVE_DAYS * 86400);

      for (const card of cards) {
        const ts = this._toEpochSec(card.lastModified || card.createdAt);
        if (Number.isFinite(ts) && ts < cutoffSec) {
          await this.deck.deleteCard(card.id, 'done');
          console.log(`${LOG_PREFIX} Done card "${card.title}" archived (older than ${this.DONE_ARCHIVE_DAYS}d)`);
          archived++;
        }
      }
    } catch (err) {
      console.log(`${LOG_PREFIX} _checkDone error: ${err.message}`);
    }
    return archived;
  }

  /**
   * Check whether the active doing card is stale (no update in 48h) and
   * notify the owner if so.
   *
   * @returns {Promise<{stale: boolean, cardTitle: string|null}>}
   * @private
   */
  async _checkDoing() {
    try {
      const cards = await this.deck.getCardsInStack('doing');
      if (cards.length === 0) return { stale: false, cardTitle: null };

      const card = cards[0];
      const lastModSec = this._toEpochSec(card.lastModified || card.createdAt);
      const age = Date.now() - (lastModSec * 1000);

      if (Number.isFinite(age) && age > this.STALE_DOING_MS) {
        const daysSince = Math.round(age / MS_PER_DAY);
        const message = `Task "${card.title}" has been in Doing for ${daysSince} day(s) without updates. Need help or should it move to Waiting?`;
        console.log(`${LOG_PREFIX} Stale doing card: "${card.title}" (${daysSince}d)`);

        try {
          await this.notifyUser({ type: 'working-memory', message });
        } catch (notifyErr) {
          console.log(`${LOG_PREFIX} Could not notify user about stale card: ${notifyErr.message}`);
        }

        return { stale: true, cardTitle: card.title };
      }

      return { stale: false, cardTitle: card.title };
    } catch (err) {
      console.log(`${LOG_PREFIX} _checkDoing error: ${err.message}`);
      return { stale: false, cardTitle: null };
    }
  }

  /**
   * If the doing stack is empty, pick the highest-priority card from inbox
   * and move it to doing.
   *
   * @returns {Promise<string|null>} Title of the picked card, or null
   * @private
   */
  async _pickFromInbox() {
    try {
      const doingCards = await this.deck.getCardsInStack('doing');
      if (doingCards.length > 0) return null;

      const inboxCards = await this.deck.getCardsInStack('inbox');
      if (inboxCards.length === 0) return null;

      // Score and sort descending
      const scored = inboxCards
        .map(card => ({ card, score: this._priorityScore(card) }))
        .sort((a, b) => b.score - a.score);

      const winner = scored[0].card;
      await this.deck.moveCard(winner.id, 'inbox', 'doing');
      console.log(`${LOG_PREFIX} Picked "${winner.title}" from inbox (score=${scored[0].score}) — moved to doing`);

      return winner.title;
    } catch (err) {
      console.log(`${LOG_PREFIX} _pickFromInbox error: ${err.message}`);
      return null;
    }
  }

  // =========================================================================
  // Private — Utilities
  // =========================================================================

  /**
   * Compute a priority score for an inbox card.
   *
   * Scoring rules (additive):
   *   - Overdue (has duedate in the past): +100
   *   - Due within 24 hours:              +50
   *   - Label 'promise':                  +30
   *   - Label 'follow-up':                +20
   *   - Label 'research':                 +5
   *   - Age bonus:                        +1 per day old (prevents starvation)
   *
   * @param {Object} card - Deck card object
   * @returns {number} Numeric priority score
   */
  _priorityScore(card) {
    let score = 0;
    const now = Date.now();

    // Due date scoring
    if (card.duedate) {
      const due = new Date(card.duedate).getTime();
      if (Number.isFinite(due)) {
        if (due <= now) {
          score += 100; // overdue
        } else if (due - now <= MS_PER_DAY) {
          score += 50; // due within 24h
        }
      }
    }

    // Label scoring
    const labels = Array.isArray(card.labels) ? card.labels : [];
    for (const lbl of labels) {
      const name = (lbl.title || '').toLowerCase();
      if (name === 'promise') score += 30;
      else if (name === 'follow-up') score += 20;
      else if (name === 'research') score += 5;
    }

    // Age bonus: +1 per day old (prevent starvation)
    const createdSec = this._toEpochSec(card.createdAt || card.lastModified);
    if (Number.isFinite(createdSec) && createdSec > 0) {
      const ageDays = Math.max(0, Math.floor((now - createdSec * 1000) / MS_PER_DAY));
      score += ageDays;
    }

    return score;
  }

  /**
   * Ensure the board is initialized, calling initialize() if needed.
   *
   * @throws {Error} If initialization fails
   * @private
   */
  async _ensureInit() {
    if (!this._initialized) {
      await this.initialize();
    }
    if (!this._initialized) {
      throw new Error('Board initialization failed');
    }
  }

  /**
   * Safely get cards from a stack, returning an empty array on error.
   *
   * @param {string} stackName - Logical stack name
   * @returns {Promise<Array>} Array of card objects
   * @private
   */
  async _safeGetCards(stackName) {
    try {
      return await this.deck.getCardsInStack(stackName) || [];
    } catch (err) {
      console.log(`${LOG_PREFIX} Could not read stack "${stackName}": ${err.message}`);
      return [];
    }
  }

  /**
   * Format a timestamp or ISO string into a short date (YYYY-MM-DD).
   *
   * @param {string|number} ts - Timestamp (epoch ms, epoch s, or ISO string)
   * @returns {string} Formatted date or 'unknown'
   * @private
   */
  _formatDate(ts) {
    if (!ts) return 'unknown';
    try {
      const epochMs = this._toEpochSec(ts) * 1000;
      const d = new Date(epochMs);
      if (isNaN(d.getTime())) return 'unknown';
      return d.toISOString().slice(0, 10);
    } catch {
      return 'unknown';
    }
  }

  /**
   * Normalise a timestamp to epoch seconds.
   *
   * Deck API returns lastModified/createdAt as epoch seconds (small numbers).
   * ISO strings are also accepted and converted.
   *
   * @param {number|string} ts - Epoch seconds, epoch ms, or ISO string
   * @returns {number} Epoch seconds
   * @private
   */
  _toEpochSec(ts) {
    if (!ts && ts !== 0) return 0;
    if (typeof ts === 'string') {
      const d = new Date(ts);
      return isNaN(d.getTime()) ? 0 : Math.floor(d.getTime() / 1000);
    }
    // Heuristic: if number > 1e12 it is likely epoch ms, otherwise epoch sec
    if (typeof ts === 'number') {
      return ts > 1e12 ? Math.floor(ts / 1000) : ts;
    }
    return 0;
  }

  /**
   * Find the earliest due date among a set of cards.
   *
   * @param {Array} cards - Array of card objects
   * @returns {string|null} ISO date string of the nearest due date, or null
   * @private
   */
  _findNextDue(cards) {
    let earliest = null;
    for (const card of cards) {
      if (!card.duedate) continue;
      const d = new Date(card.duedate).getTime();
      if (Number.isFinite(d) && (earliest === null || d < earliest)) {
        earliest = d;
      }
    }
    if (earliest === null) return null;
    return new Date(earliest).toISOString().slice(0, 10);
  }
}

module.exports = PersonalBoardManager;
