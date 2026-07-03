/*
 * Moltagent - Sovereign AI Security Layer
 * Copyright (C) 2026 Moltagent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

'use strict';

/**
 * ObservationLog — Fire-and-forget log of things noticed during query traversal.
 *
 * Architecture Brief:
 * - Problem: Maintenance workers historically re-read every wiki page just to decide
 *   what needs attention. The agent already reads these pages during normal enrichment
 *   traversal — that reading should generate observations for free.
 * - Pattern: Append-only in-memory ring-of-observations with a configurable TTL.
 *   Producers (enricher, probes, document ingestor) call notice(); consumers
 *   (WikiSteward, Knowledge/Connection/Memory lenses) call getByType() / getNeediest()
 *   to decide where to intervene. Resolved observations remain in the log until
 *   their TTL expires, which keeps prune() idempotent.
 * - Key Dependencies: none — pure data structure. No I/O, no LLM calls.
 * - Data Flow: enricher.read(page) → log.notice({type, cluster, page, detail})
 *   → heartbeat pulse → wikiSteward.tend() → log.getNeediest() → log.resolve()
 *   → log.prune()
 * - Dependency Map: message-processor.js, document-ingestor.js, wiki-steward.js
 *   all depend on observation-log.js. observation-log.js depends on nothing.
 *
 * The OBSERVATION_TYPES enum below is a list of TYPE IDENTIFIERS (machine-readable
 * structural tags), not natural-language words. It is language-agnostic by construction
 * and therefore compatible with the "LLM is the language layer" rule.
 *
 * @module maintenance/observation-log
 * @version 0.1.0
 */

/**
 * Canonical observation type identifiers.
 *
 * Each value is a stable machine string used for filtering and resolution.
 * These are NOT natural-language keywords — they are enum tags.
 *
 * @readonly
 * @enum {string}
 */
const OBSERVATION_TYPES = Object.freeze({
  // Knowledge Steward's domain — truth maintenance
  CONTRADICTION:   'contradiction',    // Two pages disagree on a fact
  STALE_CONTENT:   'stale_content',    // Page past decay with low access
  GAP:             'gap',              // Entity referenced but has no page
  LOW_CONFIDENCE:  'low_confidence',   // Page confidence dropped

  // Connection Steward's domain — relationship growth
  MISSING_LINK:    'missing_link',     // Graph edge exists, no wikilink in page
  ORPHAN_PAGE:     'orphan_page',      // Page with no incoming wikilinks
  NEAR_DUPLICATE:  'near_duplicate',   // Two pages with very similar titles
  SECTION_STALE:   'section_stale',    // Section summary doesn't reflect contents

  // Memory Steward's domain — lifecycle management
  UNEMBEDDED:      'unembedded',       // Wiki page not in vector store
  NEVER_ACCESSED:  'never_accessed',   // Page created but never retrieved
  COMPOST_READY:   'compost_ready',    // Past decay + never accessed + low confidence
  HIGH_ACCESS:     'high_access',      // Frequently accessed, may need strengthening

  // Steward self-observation — the steward instruments its own senses
  EMPTY_NEIGHBORHOOD: 'empty_neighborhood', // Neighborhood read 0 pages while the cluster census reports > 0 (#51 class)
});

// Collect all valid type values for O(1) validation
const _VALID_TYPES = new Set(Object.values(OBSERVATION_TYPES));

/**
 * @typedef {Object} Observation
 * @property {string} type     - One of OBSERVATION_TYPES (machine tag).
 * @property {string} [cluster] - Cluster / section identifier the observation belongs to.
 * @property {string} [page]    - Page title or id the observation concerns.
 * @property {string} [detail]  - Short free-form diagnostic string.
 * @property {number} timestamp - Epoch ms when the observation was logged.
 * @property {boolean} [resolved] - Set true by resolve() after steward intervention.
 */

class ObservationLog {
  /**
   * @param {Object} [options]
   * @param {number} [options.maxAgeMs=86400000] - TTL in ms. Observations older than
   *   this are dropped by prune() and ignored by getByType/getNeediest.
   * @param {number} [options.maxSize=10000] - Hard cap on in-memory observations.
   *   When reached, notice() evicts the oldest 10% before appending. This protects
   *   against unbounded growth during burst ingestion (many pages traversed between
   *   heartbeat pulses). Defaults to 10 000, which at ~100 bytes/obs ≈ 1 MB RSS.
   * @param {Object} [options.logger] - Optional logger with info/warn/debug methods.
   */
  constructor({ maxAgeMs = 24 * 60 * 60 * 1000, maxSize = 10000, logger } = {}) {
    this.maxAgeMs = Number.isFinite(maxAgeMs) && maxAgeMs > 0
      ? maxAgeMs
      : 24 * 60 * 60 * 1000;
    this.maxSize = Number.isFinite(maxSize) && maxSize > 0 ? Math.floor(maxSize) : 10000;
    this.logger = logger || console;
    /** @type {Observation[]} */
    this._observations = [];
  }

  /**
   * Log something noticed during query traversal.
   *
   * The caller does not stop to fix the observation — it is answering a question.
   * Stewards later read this log to decide what needs attention.
   *
   * Null / missing type is rejected silently (with a debug log) to keep the
   * call sites fire-and-forget.
   *
   * @param {Partial<Observation>} observation - Must contain a `type`.
   * @returns {void}
   */
  notice(observation) {
    if (observation == null || typeof observation !== 'object') {
      this.logger.debug('[ObservationLog] notice() called with null/non-object — ignored');
      return;
    }
    if (!observation.type || typeof observation.type !== 'string') {
      this.logger.debug('[ObservationLog] notice() called without a string type — ignored');
      return;
    }
    if (!_VALID_TYPES.has(observation.type)) {
      // Unknown type is a bug worth seeing but not worth crashing on.
      this.logger.warn(`[ObservationLog] Unknown observation type: "${observation.type}" — logged anyway`);
    }
    // Bounded-growth guard: during burst ingestion the log can fill faster than
    // the heartbeat prunes it. When the cap is reached, drop the oldest 10% in
    // one slice (amortized O(1) per notice) rather than shift-per-call.
    if (this._observations.length >= this.maxSize) {
      const drop = Math.max(1, Math.floor(this.maxSize / 10));
      this._observations.splice(0, drop);
      this.logger.debug?.(`[ObservationLog] maxSize reached — evicted ${drop} oldest observations`);
    }
    this._observations.push({
      ...observation,
      timestamp: Date.now(),
      resolved: observation.resolved || false,
    });
  }

  /**
   * Return unresolved, non-expired observations matching one or more type tags.
   *
   * @param {string|string[]} types - Single type or list of OBSERVATION_TYPES values.
   * @returns {Observation[]} Matching observations (not a copy of the underlying store).
   */
  getByType(types) {
    const typeList = Array.isArray(types) ? types : [types];
    const cutoff = Date.now() - this.maxAgeMs;
    return this._observations.filter(
      o => o.timestamp > cutoff && !o.resolved && typeList.includes(o.type)
    );
  }

  /**
   * Which clusters have the most unresolved observations?
   *
   * Used by WikiSteward._findNeediest() to pick the next cluster to visit.
   *
   * @returns {Array<{cluster: string, count: number}>} Sorted descending by count.
   *   Observations without a cluster field are skipped.
   */
  getNeediest() {
    const cutoff = Date.now() - this.maxAgeMs;
    const counts = {};
    for (const o of this._observations) {
      if (o.timestamp <= cutoff) continue;
      if (o.resolved) continue;
      if (!o.cluster) continue;
      counts[o.cluster] = (counts[o.cluster] || 0) + 1;
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([cluster, count]) => ({ cluster, count }));
  }

  /**
   * Mark observations as resolved after steward intervention.
   *
   * Resolved observations are excluded from getByType/getNeediest but remain
   * in memory until prune() removes them based on TTL. This keeps resolution
   * idempotent and avoids mutating array length while callers iterate.
   *
   * @param {string} cluster - Cluster name whose observations to resolve.
   * @param {string|string[]} types - Type tag(s) to resolve within that cluster.
   * @returns {number} Count of observations transitioned to resolved.
   */
  resolve(cluster, types) {
    const typeList = Array.isArray(types) ? types : [types];
    let count = 0;
    for (const o of this._observations) {
      if (o.cluster === cluster && typeList.includes(o.type) && !o.resolved) {
        o.resolved = true;
        count++;
      }
    }
    return count;
  }

  /**
   * Drop observations older than maxAgeMs.
   *
   * Called from the heartbeat pulse. Safe to call frequently.
   *
   * @returns {{dropped: number}} Number of observations removed.
   */
  prune() {
    const cutoff = Date.now() - this.maxAgeMs;
    const before = this._observations.length;
    this._observations = this._observations.filter(o => o.timestamp > cutoff);
    return { dropped: before - this._observations.length };
  }

  /**
   * Current number of observations in the log (resolved + unresolved, non-expired
   * only once prune() has run). Useful for tests and metrics.
   *
   * @returns {number}
   */
  size() {
    return this._observations.length;
  }
}

module.exports = { ObservationLog, OBSERVATION_TYPES };
