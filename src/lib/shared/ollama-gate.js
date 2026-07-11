/**
 * Ollama Activity Gate — shared singleton that keeps background LLM work from
 * competing with live user message processing on single-slot Ollama instances.
 *
 * Two consumers, one truth ("is the box serving a user right now?"):
 *   - Heartbeat / idle extractors call isUserActive() and skip their LLM work
 *     while it is true (the original #-gate role).
 *   - The boot/idle calibration probes (golden-set, tool-capability) call
 *     isServing() between measurement items and await idle(cap) when it is true,
 *     so a boot re-measurement walk yields to a live scheduling turn instead of
 *     stampeding it (the measure-vs-serve admission gate, second instance of
 *     the #260 class). isServing() is an alias of isUserActive() — deliberately
 *     ONE serving signal, not a parallel latch that could drift from it.
 *
 * The turn is bracketed by the message processor: markUserActive() at process()
 * entry, markUserDone() at every exit. The COOLDOWN_MS window is the safety net
 * for exits that return before markUserDone() (skipped/deferred messages) — it
 * bounds a leaked "active" to at most the cooldown rather than forever, which is
 * why admission control here can trust a timestamp and needs no reference count.
 *
 * @module shared/ollama-gate
 * @license AGPL-3.0
 */

'use strict';

const COOLDOWN_MS = 90_000; // 90s — covers classification + synthesis window

// How often idle() re-checks the serving state. The probe yield granularity is
// seconds (a paused example resumes ~a poll after the turn ends), not ms — a
// coarse poll is enough and keeps the gate a plain timestamp with no waitlist.
// A probe only polls while it is actively waiting for a turn to end (rare,
// short-lived), so a sub-second interval costs nothing.
const IDLE_POLL_MS = 200;

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
  },

  /**
   * Admission-gate alias of isUserActive(), read by the calibration probes.
   * Same truth, named for the reader: "is the box serving a user right now?"
   * @returns {boolean}
   */
  isServing() {
    return this.isUserActive();
  },

  /**
   * Resolve once the box is no longer serving a user, or after maxWaitMs —
   * whichever comes first. A probe loop calls this between measurement items so
   * a boot walk that collides with a live turn pauses and resumes after the
   * turn, instead of contending for the single Ollama slot.
   *
   * The cap prevents starvation on a chatty deployment: measurement must
   * eventually happen, so after maxWaitMs the probe proceeds anyway. The gate
   * trades measurement latency, never its existence.
   *
   * @param {number} maxWaitMs - Upper bound on the wait (generous; minutes).
   * @returns {Promise<{waited: boolean, timedOut: boolean}>}
   */
  idle(maxWaitMs) {
    if (!this.isServing()) return Promise.resolve({ waited: false, timedOut: false });
    const cap = Number.isFinite(maxWaitMs) && maxWaitMs > 0 ? maxWaitMs : COOLDOWN_MS;
    const start = Date.now();
    return new Promise(resolve => {
      const tick = () => {
        if (!this.isServing()) return resolve({ waited: true, timedOut: false });
        if (Date.now() - start >= cap) return resolve({ waited: true, timedOut: true });
        setTimeout(tick, IDLE_POLL_MS);
      };
      setTimeout(tick, IDLE_POLL_MS);
    });
  },
};
