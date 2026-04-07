/**
 * Moltagent Pending Action Store
 *
 * Architecture Brief:
 * -------------------
 * Problem: `global.pendingEmailReplies` pattern creates shared mutable state,
 * makes testing difficult, and lacks TTL/cleanup semantics.
 *
 * Pattern: Encapsulated Map-based store with TTL expiration and cleanup.
 * Replaces global state with a proper class that can be injected as a dependency.
 *
 * Key Dependencies:
 * - src/lib/config.js (for TTL defaults)
 *
 * Data Flow:
 * - EmailMonitor stores pending replies via set()
 * - MessageRouter retrieves via getRecent() and clears via clear()
 * - Automatic cleanup removes expired items
 *
 * Integration Points:
 * - src/lib/services/email-monitor.js (_storePendingReply)
 * - src/lib/handlers/message-router.js (_handleConfirmation)
 * - test/unit/handlers/message-router.test.js
 *
 * @module pending-action-store
 * @version 1.0.0
 */

'use strict';

const config = require('./config');

/**
 * @typedef {Object} PendingEmailReply
 * @property {Object} email - Email metadata
 * @property {string} email.messageId - Original message ID
 * @property {string} email.from - Sender display name
 * @property {string} email.fromAddress - Sender email address
 * @property {string} email.subject - Email subject
 * @property {string} [email.inReplyTo] - In-Reply-To header
 * @property {string} [email.references] - References header
 * @property {string} draft - Draft response text
 * @property {boolean} is_meeting_request - Whether this is a meeting request
 * @property {Object|null} meeting_details - Meeting details if applicable
 * @property {Object|null} calendar_context - Calendar availability context
 * @property {number} timestamp - When this was stored (ms since epoch)
 * @property {number} expiresAt - When this expires (ms since epoch)
 */

/**
 * @typedef {Object} PendingConfirmation
 * @property {string} handler - Handler type ('calendar' | 'email')
 * @property {Object} data - Handler-specific data
 * @property {string} user - User who initiated the action
 * @property {number} timestamp - When this was stored (ms since epoch)
 * @property {number} expiresAt - When this expires (ms since epoch)
 */

/**
 * Generic pending action store with TTL support
 *
 * Thread-safety note: JavaScript is single-threaded, so Map operations
 * are atomic. No additional synchronization is needed.
 */
class PendingActionStore {
  /**
   * @param {Object} [options={}]
   * @param {number} [options.defaultTTLMs] - Default TTL in milliseconds
   * @param {number} [options.cleanupIntervalMs] - Cleanup interval in milliseconds
   * @param {Function} [options.auditLog] - Audit logging function
   */
  constructor(options = {}) {
    /** @type {Map<string, Object>} */
    this._store = new Map();

    /** @type {number} */
    this._counter = 0;

    /** @type {number} */
    this.defaultTTLMs = options.defaultTTLMs || config.pendingActions.emailReplyTTLMs;

    /** @type {number} */
    this.cleanupIntervalMs = options.cleanupIntervalMs || config.pendingActions.cleanupIntervalMs;

    /** @type {Function} */
    this.auditLog = options.auditLog || (async () => {});

    /** @type {NodeJS.Timeout|null} */
    this._cleanupTimer = null;

    // Start cleanup timer
    this._startCleanupTimer();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Store a pending action
   *
   * @param {string} type - Action type (e.g., 'email_reply', 'confirmation')
   * @param {Object} data - Action data
   * @param {Object} [options={}]
   * @param {number} [options.ttlMs] - Custom TTL in milliseconds
   * @returns {string} Unique action ID
   */
  set(type, data, options = {}) {
    const id = this._generateId(type);
    const now = Date.now();
    const ttl = options.ttlMs || this.defaultTTLMs;

    this._store.set(id, {
      ...data,
      _type: type,
      timestamp: now,
      expiresAt: now + ttl
    });

    return id;
  }

  /**
   * Get a pending action by ID
   *
   * @param {string} id - Action ID
   * @returns {Object|null} Action data or null if not found/expired
   */
  get(id) {
    const item = this._store.get(id);
    if (!item) {
      return null;
    }

    // Check if expired
    if (Date.now() > item.expiresAt) {
      this._store.delete(id);
      return null;
    }

    return item;
  }

  /**
   * Get the most recent pending action of a given type
   *
   * @param {string} type - Action type to filter by
   * @returns {{ id: string, data: Object }|null} Most recent action or null
   */
  getRecent(type) {
    const now = Date.now();
    let mostRecent = null;
    let mostRecentId = null;

    for (const [id, item] of this._store.entries()) {
      // Skip wrong type
      if (item._type !== type) {
        continue;
      }

      // Skip expired
      if (now > item.expiresAt) {
        continue;
      }

      // Track most recent
      if (!mostRecent || item.timestamp > mostRecent.timestamp) {
        mostRecent = item;
        mostRecentId = id;
      }
    }

    if (!mostRecent) {
      return null;
    }

    return { id: mostRecentId, data: mostRecent };
  }

  /**
   * Get all pending actions of a given type
   *
   * @param {string} type - Action type to filter by
   * @returns {Array<{ id: string, data: Object }>} Array of actions
   */
  getAll(type) {
    const now = Date.now();
    const results = [];

    for (const [id, item] of this._store.entries()) {
      if (item._type !== type) {
        continue;
      }
      if (now > item.expiresAt) {
        continue;
      }
      results.push({ id, data: item });
    }

    return results;
  }

  /**
   * Delete a specific pending action
   *
   * @param {string} id - Action ID
   * @returns {boolean} True if deleted, false if not found
   */
  delete(id) {
    return this._store.delete(id);
  }

  /**
   * Delete all pending actions of a given type
   *
   * @param {string} type - Action type to clear
   * @returns {number} Number of items deleted
   */
  clearType(type) {
    let count = 0;

    for (const [id, item] of this._store.entries()) {
      if (item._type === type) {
        this._store.delete(id);
        count++;
      }
    }

    return count;
  }

  /**
   * Delete all pending actions
   *
   * @returns {number} Number of items deleted
   */
  clear() {
    const count = this._store.size;
    this._store.clear();
    return count;
  }

  /**
   * Get the number of pending actions
   *
   * @param {string} [type] - Optional type filter
   * @returns {number} Count of pending actions
   */
  size(type) {
    if (!type) {
      return this._store.size;
    }

    let count = 0;
    for (const item of this._store.values()) {
      if (item._type === type) {
        count++;
      }
    }
    return count;
  }

  /**
   * Check if any pending actions exist
   *
   * @param {string} [type] - Optional type filter
   * @returns {boolean} True if actions exist
   */
  has(type) {
    if (!type) {
      return this._store.size > 0;
    }

    for (const item of this._store.values()) {
      if (item._type === type && Date.now() <= item.expiresAt) {
        return true;
      }
    }
    return false;
  }

  /**
   * Run cleanup to remove expired items
   *
   * @returns {number} Number of expired items removed
   */
  cleanup() {
    const now = Date.now();
    let count = 0;

    for (const [id, item] of this._store.entries()) {
      if (now > item.expiresAt) {
        this._store.delete(id);
        count++;
      }
    }

    return count;
  }

  /**
   * Stop the cleanup timer (for shutdown)
   */
  stop() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
  }

  /**
   * Get store statistics
   *
   * @returns {Object} Statistics object
   */
  getStats() {
    const byType = {};
    const now = Date.now();
    let expired = 0;

    for (const item of this._store.values()) {
      byType[item._type] = (byType[item._type] || 0) + 1;
      if (now > item.expiresAt) {
        expired++;
      }
    }

    return {
      total: this._store.size,
      byType,
      expired,
      cleanupIntervalMs: this.cleanupIntervalMs,
      defaultTTLMs: this.defaultTTLMs
    };
  }

  // ---------------------------------------------------------------------------
  // Private Methods
  // ---------------------------------------------------------------------------

  /**
   * Generate a unique ID for a pending action
   *
   * @param {string} type - Action type
   * @returns {string} Unique ID
   * @private
   */
  _generateId(type) {
    this._counter++;
    return `${type}_${Date.now()}_${this._counter}`;
  }

  /**
   * Start the periodic cleanup timer
   *
   * @private
   */
  _startCleanupTimer() {
    if (this._cleanupTimer) {
      return;
    }

    this._cleanupTimer = setInterval(() => {
      const removed = this.cleanup();
      if (removed > 0) {
        this.auditLog('pending_actions_cleanup', { removed });
      }
    }, this.cleanupIntervalMs);

    // Don't prevent process exit
    this._cleanupTimer.unref();
  }
}

// -----------------------------------------------------------------------------
// Singleton Instances (for backwards compatibility)
// -----------------------------------------------------------------------------

/**
 * Singleton store for pending email replies
 * Replaces global.pendingEmailReplies
 */
const pendingEmailReplies = new PendingActionStore({
  defaultTTLMs: config.pendingActions.emailReplyTTLMs
});

/**
 * Singleton store for pending confirmations
 * Replaces MessageRouter.pendingConfirmations
 */
const pendingConfirmations = new PendingActionStore({
  defaultTTLMs: config.pendingActions.confirmationTTLMs
});

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = {
  PendingActionStore,
  pendingEmailReplies,
  pendingConfirmations
};
