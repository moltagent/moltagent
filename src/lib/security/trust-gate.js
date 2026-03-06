/*
 * MoltAgent - Sovereign AI Security Layer
 * Copyright (C) 2026 MoltAgent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

'use strict';

/**
 * TrustGate — Layer 2 of the Bullshit Protection System
 *
 * Architecture Brief:
 * -------------------
 * Problem: Session summaries persist every assistant claim to wiki without
 *   distinguishing grounded facts from hallucinated content. Once written,
 *   ungrounded claims become authoritative — future retrieval treats them
 *   as established knowledge, creating a self-poisoning loop.
 *
 * Chosen Pattern: Pre-persistence filter gate. Before SessionPersister writes
 *   a session summary, TrustGate examines each assistant segment's provenance
 *   tags (from Layer 1 ProvenanceAnnotator) and filters based on configurable
 *   trust level: aggressive, balanced, relaxed, or off.
 *
 * Key Dependencies:
 *   - ProvenanceAnnotator (Layer 1): provides per-segment trust tags on
 *     session context entries via entry.meta.provenance
 *   - CockpitManager: reads trust_level from "Memory Trust Gate" card
 *
 * Data Flow:
 *   session.context[] (with .meta.provenance per assistant entry)
 *     → filter(contextEntries)
 *     → kept segments + filtered segments
 *     → SessionPersister._generateSummary() uses only kept content
 *
 * Dependency Map:
 *   trust-gate.js        ← session-persister (pre-summary filter)
 *   trust-gate.js        ← provenance-annotator (upstream provenance tags)
 *   trust-gate.js        ← cockpit-manager (trust_level config)
 *
 * @module lib/security/trust-gate
 * @version 1.0.0
 */

const VALID_LEVELS = new Set(['aggressive', 'balanced', 'relaxed', 'off']);

class TrustGate {
  /**
   * @param {Object} opts
   * @param {string} [opts.trustLevel='balanced'] - 'aggressive'|'balanced'|'relaxed'|'off'
   * @param {Object} [opts.logger]
   */
  constructor({ trustLevel = 'balanced', logger } = {}) {
    this.trustLevel = VALID_LEVELS.has(trustLevel) ? trustLevel : 'balanced';
    this.logger = logger || console;
  }

  /**
   * Filter session context entries before summary generation.
   * Reads provenance from entry.meta.provenance if available.
   *
   * @param {Array} contextEntries - session.context or equivalent
   * @returns {{kept: Array, filtered: Array}} kept entries for summary, filtered entries for visibility
   */
  filter(contextEntries) {
    if (!Array.isArray(contextEntries)) return { kept: [], filtered: [] };
    if (this.trustLevel === 'off') return { kept: contextEntries, filtered: [] };

    const kept = [];
    const filtered = [];

    for (const entry of contextEntries) {
      // User and tool messages always pass
      if (entry.role === 'user' || entry.role === 'tool') {
        kept.push(entry);
        continue;
      }

      // Assistant messages without provenance — pass through (legacy or annotation failure)
      if (!entry.meta || !Array.isArray(entry.meta.provenance)) {
        kept.push(entry);
        continue;
      }

      const segments = entry.meta.provenance;
      const keptSegments = [];
      const filteredSegments = [];

      for (const seg of segments) {
        if (this._passesGate(seg, contextEntries)) {
          keptSegments.push(seg);
        } else {
          filteredSegments.push(seg);
        }
      }

      if (keptSegments.length > 0) {
        kept.push({
          ...entry,
          content: keptSegments.map(s => s.text).join(' '),
          meta: {
            ...entry.meta,
            provenance: keptSegments,
            groundedRatio: keptSegments.length / segments.length,
            originalSegmentCount: segments.length,
            filteredSegments: filteredSegments.length
          }
        });
      }

      for (const seg of filteredSegments) {
        filtered.push({
          text: seg.text,
          trust: seg.trust,
          reason: this.trustLevel
        });
      }
    }

    if (filtered.length > 0) {
      this.logger.info(
        `[TrustGate] Filtered ${filtered.length} ungrounded segment(s) (level: ${this.trustLevel})`
      );
    }

    return { kept, filtered };
  }

  /**
   * Determine if a segment passes the trust gate.
   * @param {Object} segment - Provenance segment with .trust field
   * @param {Array} allEntries - Full context for repetition checking
   * @returns {boolean}
   */
  _passesGate(segment, allEntries) {
    switch (this.trustLevel) {
      case 'aggressive':
        return segment.trust === 'grounded' || segment.trust === 'verified';

      case 'balanced':
        if (segment.trust === 'grounded' || segment.trust === 'verified') return true;
        if (segment.trust === 'stated') return true;
        if (segment.trust === 'ungrounded') {
          return this._isRepeatedAndUncontradicted(segment, allEntries);
        }
        return false;

      case 'relaxed':
        return true; // Everything passes, tags preserved for visibility

      default:
        return true;
    }
  }

  /**
   * Check if an ungrounded claim was repeated 3+ times without contradiction.
   * Used in 'balanced' mode to allow persistent ungrounded claims that the
   * user never corrected.
   */
  _isRepeatedAndUncontradicted(segment, allEntries) {
    const entityTokens = this._extractTokens(segment.text);
    if (entityTokens.length === 0) return false;

    let matches = 0;
    for (const entry of allEntries) {
      if (entry.role !== 'assistant' || !entry.meta?.provenance) continue;
      for (const seg of entry.meta.provenance) {
        const overlap = this._extractTokens(seg.text)
          .filter(t => entityTokens.includes(t));
        if (overlap.length >= 2) matches++;
      }
    }
    return matches >= 3;
  }

  /**
   * Extract significant words from text for repetition matching.
   * @param {string} text
   * @returns {string[]}
   */
  _extractTokens(text) {
    return (text || '').toLowerCase().split(/\s+/).filter(w => w.length > 3);
  }
}

module.exports = TrustGate;
