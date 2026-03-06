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
 * MythDetector — Layer 4 of the Bullshit Protection System
 *
 * Architecture Brief:
 * -------------------
 * Problem: Hallucinated claims can repeat across turns, gaining apparent
 *   confidence through repetition without ever being grounded in a real source.
 *   The model cites its own prior output as evidence, creating self-referential
 *   myths that look authoritative but are fabricated.
 *
 * Chosen Pattern: Structural repetition analysis. Extract entity-token claim
 *   keys from each assistant segment, group by similarity, flag groups with
 *   3+ occurrences and zero grounding. No LLM calls — pure counting.
 *
 * Key Dependencies:
 *   - ProvenanceAnnotator (Layer 1): trust tags on each segment
 *   - DeckClient (optional): creates alert cards for detected myths
 *
 * Data Flow:
 *   session.context[] (with .meta.provenance per assistant entry)
 *     → detect(contextEntries)
 *     → myths[] (claim, occurrences, severity)
 *     → alert(myths) → Deck card creation
 *
 * Dependency Map:
 *   myth-detector.js      ← session-persister (pre-persistence scan)
 *   myth-detector.js      ← provenance-annotator (upstream trust tags)
 *   myth-detector.js      → deck-client (optional alert cards)
 *
 * @module lib/security/myth-detector
 * @version 1.0.0
 */

class MythDetector {
  /**
   * @param {Object} opts
   * @param {Object} [opts.logger]
   * @param {Object} [opts.deckClient] - DeckClient for alert card creation
   */
  constructor({ logger, deckClient } = {}) {
    this.logger = logger || console;
    this.deckClient = deckClient || null;
  }

  /**
   * Scan session context for self-referential myths.
   * A myth is a claim repeated 3+ times across assistant turns with zero grounding.
   *
   * @param {Array} contextEntries - session context with provenance metadata
   * @returns {Array<{claim: string, claimKey: string, occurrences: number, grounded: boolean, severity: string, firstTurn: number, lastTurn: number}>}
   */
  detect(contextEntries) {
    if (!Array.isArray(contextEntries)) return [];

    // Step 1: Collect all assistant segments with provenance
    const segments = [];
    let turnIndex = 0;
    for (const entry of contextEntries) {
      if (entry.role === 'assistant') turnIndex++;
      if (entry.role !== 'assistant' || !entry.meta?.provenance) continue;
      for (const seg of entry.meta.provenance) {
        segments.push({
          text: seg.text,
          trust: seg.trust,
          provenance: seg.provenance,
          sourceRefs: seg.sourceRefs || [],
          turnIndex
        });
      }
    }

    // Step 2: Group by claim key
    const claimGroups = this._groupByClaim(segments);

    // Step 3: Flag groups with 3+ occurrences, zero grounding
    const myths = [];
    for (const [key, group] of claimGroups) {
      if (group.length < 3) continue;

      const groundedCount = group.filter(s =>
        s.trust === 'grounded' || s.trust === 'verified'
      ).length;

      if (groundedCount === 0) {
        myths.push({
          claim: group[0].text,
          claimKey: key,
          occurrences: group.length,
          grounded: false,
          severity: group.length >= 5 ? 'high' : 'medium',
          firstTurn: group[0].turnIndex,
          lastTurn: group[group.length - 1].turnIndex
        });
      }
    }

    if (myths.length > 0) {
      this.logger.warn(
        `[MythDetector] Found ${myths.length} potential self-referential myth(s)`
      );
    }

    return myths;
  }

  /**
   * Create Deck card alerts for detected myths.
   * @param {Array} myths - Detected myths from detect()
   * @returns {Promise<number>} Number of alerts created
   */
  async alert(myths) {
    if (!this.deckClient || !Array.isArray(myths) || myths.length === 0) return 0;

    let created = 0;
    for (const myth of myths) {
      try {
        await this.deckClient.createCard('inbox', {
          title: `Possible myth: ${myth.claim.substring(0, 60)}`,
          description:
            `**Self-referential myth detected**\n\n` +
            `Claim: "${myth.claim}"\n` +
            `Repeated ${myth.occurrences}x without any grounding source.\n` +
            `Severity: ${myth.severity}\n\n` +
            `This claim may be a hallucination that self-reinforced across turns.\n` +
            `Please verify or dismiss.`
        });
        created++;
        this.logger.info(`[MythDetector] Created alert card for: ${myth.claim.substring(0, 40)}`);
      } catch (err) {
        this.logger.warn(`[MythDetector] Alert card creation failed: ${err.message}`);
      }
    }
    return created;
  }

  /**
   * Group segments by claim similarity using entity token overlap.
   * @param {Array} segments
   * @returns {Map<string, Array>}
   */
  _groupByClaim(segments) {
    const groups = new Map();

    for (const seg of segments) {
      const key = this._claimKey(seg.text);
      if (!key) continue;

      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(seg);
    }

    return groups;
  }

  /**
   * Generate a grouping key from claim text.
   * Extracts significant words (4+ chars), sorts, joins.
   * @param {string} text
   * @returns {string|null}
   */
  _claimKey(text) {
    const tokens = (text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length >= 4)
      .sort();

    if (tokens.length < 2) return null;
    return tokens.slice(0, 6).join('_');
  }
}

module.exports = MythDetector;
