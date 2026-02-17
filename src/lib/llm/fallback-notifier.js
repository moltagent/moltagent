'use strict';

/**
 * FallbackNotifier — Notifies users in Talk when LLM falls back from cloud to local.
 *
 * Monitors ProviderChain routing metadata and sends debounced notifications
 * to the primary Talk room when cloud→local fallback occurs or recovers.
 *
 * @module llm/fallback-notifier
 * @version 1.0.0
 */

class FallbackNotifier {
  /**
   * @param {Object} options
   * @param {Object} options.talkSendQueue - TalkSendQueue instance for sending messages
   * @param {string} options.primaryRoomToken - Primary Talk room token for notifications
   * @param {number} [options.debounceMinutes=15] - Debounce window in minutes
   * @param {Object} [options.logger] - Logger instance
   */
  constructor({ talkSendQueue, primaryRoomToken, debounceMinutes, logger } = {}) {
    this.talkSendQueue = talkSendQueue || null;
    this.primaryRoomToken = primaryRoomToken || null;
    this.debounceMinutes = debounceMinutes || 15;
    this.logger = logger || console;

    // Track state per provider: { player: { lastNotifiedAt, inFallback } }
    this._state = new Map();
  }

  /**
   * Called after each ProviderChain chat() completion.
   * Checks _routing metadata for fallback and fires notifications.
   *
   * @param {Object} result - The chat result with _routing metadata
   */
  onRouteComplete(result) {
    if (!result || !result._routing) return;
    if (!this.talkSendQueue || !this.primaryRoomToken) return;

    const { isFallback } = result._routing;
    // Use 'chain' as the default key — one ProviderChain = one state.
    // Tests can pass different player values for independent debounce scenarios.
    const providerKey = 'chain';

    if (isFallback && !this._isBothLocal(result._routing)) {
      this._handleFallback(providerKey);
    } else if (!isFallback) {
      this._handleRecovery(providerKey);
    }
  }

  /**
   * Handle a fallback event — send notification if not debounced.
   * @param {string} providerKey
   * @private
   */
  _handleFallback(providerKey) {
    const state = this._getState(providerKey);
    const now = Date.now();
    const debounceMs = this.debounceMinutes * 60 * 1000;

    if (state.lastNotifiedAt && (now - state.lastNotifiedAt) < debounceMs) {
      // Within debounce window — skip
      return;
    }

    state.inFallback = true;
    state.lastNotifiedAt = now;

    const message = '\u26a1 Using local AI \u2014 cloud provider temporarily unavailable';
    this._sendNotification(message);
  }

  /**
   * Handle a recovery event — send notification only if previously in fallback.
   * @param {string} providerKey
   * @private
   */
  _handleRecovery(providerKey) {
    const state = this._getState(providerKey);

    if (!state.inFallback) return;

    state.inFallback = false;
    state.lastNotifiedAt = null; // Reset debounce on recovery

    const message = '\u2705 Cloud AI provider is back online';
    this._sendNotification(message);
  }

  /**
   * Check if routing is local→local (no meaningful fallback to report).
   * @param {Object} routing
   * @returns {boolean}
   * @private
   */
  _isBothLocal(routing) {
    // If primary is local and fallback is also local, no cloud→local transition
    return routing.primaryIsLocal && routing.fallbackIsLocal;
  }

  /**
   * Get or create state for a provider key.
   * @param {string} key
   * @returns {Object}
   * @private
   */
  _getState(key) {
    if (!this._state.has(key)) {
      this._state.set(key, { lastNotifiedAt: null, inFallback: false });
    }
    return this._state.get(key);
  }

  /**
   * Send a notification to the primary Talk room.
   * Fire-and-forget — errors are logged but don't propagate.
   * @param {string} message
   * @private
   */
  _sendNotification(message) {
    try {
      this.talkSendQueue.enqueue(this.primaryRoomToken, message).catch(err => {
        this.logger.warn(`[FallbackNotifier] Send failed: ${err.message}`);
      });
    } catch (err) {
      this.logger.warn(`[FallbackNotifier] Notification error: ${err.message}`);
    }
  }

  /**
   * Get current fallback state map (for health/status endpoints).
   * @returns {Object}
   */
  getState() {
    const result = {};
    for (const [key, state] of this._state.entries()) {
      result[key] = { ...state };
    }
    return result;
  }
}

module.exports = FallbackNotifier;
