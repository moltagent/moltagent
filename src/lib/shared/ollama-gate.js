/**
 * Ollama Activity Gate — shared singleton to prevent heartbeat LLM calls
 * from blocking user message processing on single-slot Ollama instances.
 *
 * Message processor calls markUserActive() on message arrival.
 * Heartbeat checks isUserActive() before making LLM calls and defers if true.
 *
 * @module shared/ollama-gate
 * @license AGPL-3.0
 */

'use strict';

const COOLDOWN_MS = 90_000; // 90s — covers classification + synthesis window

let _lastUserMessageAt = 0;

module.exports = {
  /** Call when a user message arrives and will need Ollama. */
  markUserActive() {
    _lastUserMessageAt = Date.now();
  },

  /** Call when user message processing (including synthesis) is complete. */
  markUserDone() {
    _lastUserMessageAt = 0;
  },

  /**
   * Returns true if a user message is being processed or was very recent.
   * Heartbeat should skip LLM calls when this returns true.
   */
  isUserActive() {
    if (_lastUserMessageAt === 0) return false;
    return (Date.now() - _lastUserMessageAt) < COOLDOWN_MS;
  }
};
