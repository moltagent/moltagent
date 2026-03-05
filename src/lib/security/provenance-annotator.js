/*
 * MoltAgent - Sovereign AI Security Layer
 * Copyright (C) 2026 MoltAgent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 */

/**
 * ProvenanceAnnotator - Layer 1 of the Bullshit Protection System
 *
 * Architecture Brief:
 * -------------------
 * Problem: LLM responses mix grounded facts (from wiki, deck, user input, tool
 *   output) with model-generated statements. Without provenance tagging, downstream
 *   layers cannot distinguish verified claims from hallucinations.
 *
 * Chosen Pattern: Segment-then-ground heuristic pipeline. The response is split
 *   into sentence-level segments, then each segment is scored against known source
 *   material using entity-token overlap. No LLM calls — pure string matching to
 *   stay under 50ms. Jaccard-variant overlap (|intersection| / |segmentTokens|)
 *   measures what fraction of a claim's entities are grounded in sources.
 *
 * Key Dependencies:
 *   - MemoryContextEnricher: produces the <agent_knowledge> block (upstream input)
 *   - ContentProvenance (src/security/content-provenance.js): trust-level tagging
 *     for content entering the LLM; this module tags content leaving it
 *   - None at runtime — standalone, zero I/O, pure computation
 *
 * Data Flow:
 *   LLM response string + contextSources
 *     -> _segmentResponse(response)          => [{ text }]
 *     -> _parseAgentKnowledge(block)          => [{ type, content, ref, confidence }]
 *     -> _findGrounding(segment, sources)     => { source, trust, refs, score }
 *     -> annotate() assembles segments[]      => { segments, groundedRatio }
 *
 * Dependency Map:
 *   provenance-annotator.js   (this file — standalone, no imports beyond logger)
 *   provenance-annotator.js   <- bullshit-detector (Layer 2, future consumer)
 *   provenance-annotator.js   <- micro-pipeline (called post-LLM, pre-delivery)
 *
 * @module lib/security/provenance-annotator
 * @version 1.0.0
 */

'use strict';

// Grounding thresholds — tuned conservatively for precision over recall
const THRESHOLD_GROUNDED = 0.5;
const THRESHOLD_STATED   = 0.3;
const THRESHOLD_VERIFIED = 0.3;

// Default confidence score when no grounding source matches
const DEFAULT_UNGROUNDED_SCORE = 0.2;

// Confidence label -> numeric score mapping for agent_knowledge entries
const CONFIDENCE_SCORES = {
  high:   0.95,
  medium: 0.75,
  low:    0.5,
};

// Sentence boundary regex: split on . ! ? followed by whitespace or end-of-string
const SENTENCE_BOUNDARY = /(?<=[.!?])(?:\s+|$)/;

// Pattern to parse [source: ..., confidence: ...] header lines in agent_knowledge
const SOURCE_HEADER_RE = /^\[source:\s*(\w+)(?:,\s*match:\s*(\w+))?,\s*confidence:\s*(\w+)\]/;

// Token extraction patterns
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const ISO_DATE_RE = /\d{4}-\d{2}-\d{2}/g;
const NATURAL_DATE_RE = /(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:,?\s+\d{4})?/gi;
const NUMBER_RE = /\b\d+(?:\.\d+)?\b/g;
const CAPITALIZED_WORD_RE = /\b[A-Z][a-zA-Z]*(?:\s+[A-Z][a-zA-Z]*)*/g;

// Common words that start with a capital letter but are not entity names
const COMMON_STARTERS = new Set([
  'the', 'this', 'that', 'these', 'those', 'what', 'when', 'where', 'which',
  'who', 'how', 'why', 'can', 'could', 'would', 'should', 'will', 'does',
  'did', 'has', 'have', 'are', 'were', 'was', 'been', 'being',
  'please', 'help', 'show', 'tell', 'find', 'get', 'set', 'add', 'remove',
  'delete', 'create', 'update', 'move', 'send', 'check', 'list',
  'hey', 'hello', 'thanks', 'sure', 'yes', 'yeah', 'okay',
  'remember', 'search', 'look', 'save', 'write', 'read',
  'also', 'but', 'and', 'not', 'all', 'any', 'some', 'just',
  'here', 'there', 'they', 'their', 'its', 'our', 'your',
  'if', 'so', 'or', 'no', 'do', 'for', 'it', 'is', 'be', 'as', 'at',
  'by', 'in', 'on', 'to', 'up', 'of', 'an', 'a', 'i',
]);

class ProvenanceAnnotator {
  /**
   * Create a ProvenanceAnnotator instance.
   *
   * @param {Object} [opts={}] - Configuration options
   * @param {Object} [opts.logger] - Logger with info/warn/error methods; defaults to console
   */
  constructor({ logger } = {}) {
    this.logger = logger || console;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Annotate an LLM response with provenance metadata for each sentence segment.
   *
   * @param {string} response - The LLM response text
   * @param {Object} contextSources - Sources available for grounding
   * @param {string|null} contextSources.agentKnowledge - Raw <agent_knowledge> block or null
   * @param {string} contextSources.userMessage - The user's message text
   * @param {Array<{type: string, refs: string[]}>} contextSources.actionLedger - Session action records
   * @returns {{
   *   segments: Array<{text: string, provenance: string, trust: string, sourceRefs: string[], confidence: number}>,
   *   groundedRatio: number
   * }}
   */
  annotate(response, contextSources) {
    // Guard: non-string or falsy response returns empty result
    if (!response || typeof response !== 'string') {
      return { segments: [], groundedRatio: 1.0 };
    }

    // Normalize contextSources with safe defaults
    const ctx = contextSources || {};
    const agentKnowledgeRaw = (typeof ctx.agentKnowledge === 'string') ? ctx.agentKnowledge : '';
    const userMessage = (typeof ctx.userMessage === 'string') ? ctx.userMessage : '';
    const actionLedger = Array.isArray(ctx.actionLedger) ? ctx.actionLedger : [];

    // Build structured sources
    const parsedKnowledge = this._parseAgentKnowledge(agentKnowledgeRaw);
    const sources = {
      agentKnowledge: parsedKnowledge,
      userMessage,
      actionLedger,
    };

    // Segment the response and annotate each segment
    const segments = this._segmentResponse(response);

    for (const segment of segments) {
      const grounding = this._findGrounding(segment, sources);
      segment.provenance  = grounding.source;
      segment.trust       = grounding.trust;
      segment.sourceRefs  = grounding.refs;
      segment.confidence  = grounding.score;
    }

    // Avoid division by zero — empty response is considered fully grounded
    if (segments.length === 0) {
      return { segments, groundedRatio: 1.0 };
    }

    const groundedCount = segments.filter(s => s.trust !== 'ungrounded').length;
    const groundedRatio = groundedCount / segments.length;

    return { segments, groundedRatio };
  }

  // ---------------------------------------------------------------------------
  // Private Methods
  // ---------------------------------------------------------------------------

  /**
   * Split LLM response text into sentence-level segments.
   *
   * Splits on sentence boundaries (. ! ? followed by space/end) and newlines.
   * Filters out empty/whitespace-only segments.
   *
   * @param {string} text - Response text to segment
   * @returns {Array<{text: string}>} Array of segment objects
   * @private
   */
  _segmentResponse(text) {
    if (!text || typeof text !== 'string') {
      return [];
    }

    // Split on newlines first, then split each line on sentence boundaries
    const lines = text.split('\n');
    const pieces = [];

    for (const line of lines) {
      const sentences = line.split(SENTENCE_BOUNDARY);
      for (const sentence of sentences) {
        const trimmed = sentence.trim();
        if (trimmed.length > 0) {
          pieces.push(trimmed);
        }
      }
    }

    return pieces.map(t => ({ text: t }));
  }

  /**
   * Parse the raw <agent_knowledge> block into structured source entries.
   *
   * Each entry starts with a header like:
   *   [source: wiki, confidence: high]
   *   [source: deck, match: title, confidence: high]
   *
   * Followed by content lines (title, snippet, etc).
   *
   * @param {string|null} block - Raw agent_knowledge block including XML tags, or null
   * @returns {Array<{type: string, content: string, ref: string, confidence: string}>}
   * @private
   */
  _parseAgentKnowledge(block) {
    if (!block || typeof block !== 'string') {
      return [];
    }

    // Strip XML wrapper tags if present
    const stripped = block
      .replace(/<agent_knowledge>/gi, '')
      .replace(/<\/agent_knowledge>/gi, '')
      .trim();

    if (!stripped) {
      return [];
    }

    // Each entry is separated by a blank line
    const rawEntries = stripped.split(/\n\n+/);
    const results = [];

    for (const entry of rawEntries) {
      const lines = entry.split('\n');
      const headerLine = lines[0] ? lines[0].trim() : '';
      const match = SOURCE_HEADER_RE.exec(headerLine);

      if (!match) {
        // No recognizable header — skip this entry
        continue;
      }

      const type       = match[1];           // e.g. 'wiki', 'deck'
      // match[2] is matchType (optional, may be undefined)
      const confidence = match[3] || 'medium';

      // Content is everything after the header line
      const contentLines = lines.slice(1);
      const content = contentLines.join('\n').trim();

      // Build a stable ref string for downstream citation
      let ref;
      if (type === 'wiki') {
        const title = contentLines.length > 0 ? contentLines[0].trim() : '';
        ref = 'wiki:' + title;
      } else if (type === 'deck') {
        // Look for "Card #NNN" pattern anywhere in the content
        const cardMatch = content.match(/Card\s+#\d+/);
        if (cardMatch) {
          ref = 'deck:' + cardMatch[0];
        } else {
          const firstContentLine = contentLines.length > 0 ? contentLines[0].trim() : '';
          ref = 'deck:' + firstContentLine;
        }
      } else {
        // Generic fallback: type:firstLine
        const firstContentLine = contentLines.length > 0 ? contentLines[0].trim() : '';
        ref = type + ':' + firstContentLine;
      }

      results.push({ type, content, ref, confidence });
    }

    return results;
  }

  /**
   * Find the best grounding source for a single segment.
   *
   * Extracts entity tokens from the segment and computes overlap against each
   * available source. Returns the highest-scoring match above threshold, or
   * falls back to 'model'/'ungrounded'.
   *
   * @param {{text: string}} segment - A single segment object
   * @param {Object} sources - Structured sources for comparison
   * @param {Array<{type: string, content: string, ref: string, confidence: string}>} sources.agentKnowledge
   * @param {string} sources.userMessage
   * @param {Array<{type: string, refs: string[]}>} sources.actionLedger
   * @returns {{source: string, trust: string, refs: string[], score: number}}
   * @private
   */
  _findGrounding(segment, sources) {
    const segmentTokens = this._extractTokens(segment.text);

    // No entity tokens to match against — cannot ground this segment
    if (segmentTokens.size === 0) {
      return { source: 'model', trust: 'ungrounded', refs: [], score: DEFAULT_UNGROUNDED_SCORE };
    }

    // --- Priority 1: agent_knowledge (grounded) ---
    let bestGrounded = null;

    for (const entry of (sources.agentKnowledge || [])) {
      const sourceTokens = this._extractTokens(entry.content);
      const overlap = this._overlapScore(segmentTokens, sourceTokens);

      if (overlap >= THRESHOLD_GROUNDED) {
        const confidenceMultiplier = CONFIDENCE_SCORES[entry.confidence] || 0.75;
        const score = Math.min(overlap * confidenceMultiplier, 1.0);

        if (!bestGrounded || score > bestGrounded.score) {
          bestGrounded = {
            source: entry.type,
            trust: 'grounded',
            refs: [entry.ref],
            score,
          };
        }
      }
    }

    // --- Priority 2: action ledger (verified) ---
    // Only checked when no grounded candidate found
    if (!bestGrounded) {
      for (const action of (sources.actionLedger || [])) {
        // Stringify all ref values in the action record
        const refsText = Array.isArray(action.refs) ? action.refs.join(' ') : '';
        const actionText = (action.type || '') + ' ' + refsText;
        const actionTokens = this._extractTokens(actionText);
        const overlap = this._overlapScore(segmentTokens, actionTokens);

        if (overlap >= THRESHOLD_VERIFIED) {
          return {
            source: 'tool',
            trust: 'verified',
            refs: ['tool:' + (action.type || 'unknown')],
            score: 0.95,
          };
        }
      }

      // --- Priority 3: user message (stated) ---
      const userTokens = this._extractTokens(sources.userMessage || '');
      const userOverlap = this._overlapScore(segmentTokens, userTokens);

      if (userOverlap >= THRESHOLD_STATED) {
        return { source: 'user', trust: 'stated', refs: ['user:current'], score: 0.8 };
      }
    }

    // Return grounded candidate if found (deferred from step 3)
    if (bestGrounded) {
      return bestGrounded;
    }

    // Fallback — model-generated, not grounded in any known source
    return { source: 'model', trust: 'ungrounded', refs: [], score: DEFAULT_UNGROUNDED_SCORE };
  }

  /**
   * Extract entity-level tokens from text for overlap checking.
   *
   * Extracts: capitalized words/phrases (proper nouns, filtering common starters),
   * email addresses, dates (ISO and natural language), and numbers > 0.
   *
   * All tokens are normalized to lowercase and trimmed.
   *
   * @param {string} text - Text to extract tokens from
   * @returns {Set<string>} Set of normalized token strings
   * @private
   */
  _extractTokens(text) {
    if (!text || typeof text !== 'string') {
      return new Set();
    }

    const tokens = new Set();

    // Email addresses (use match() to avoid stateful /g regex issues)
    for (const email of (text.match(EMAIL_RE) || [])) {
      tokens.add(email.toLowerCase());
    }

    // ISO dates (YYYY-MM-DD)
    for (const date of (text.match(ISO_DATE_RE) || [])) {
      tokens.add(date);
    }

    // Natural language dates (e.g. "March 5, 2026")
    for (const date of (text.match(NATURAL_DATE_RE) || [])) {
      tokens.add(date.toLowerCase());
    }

    // Numbers — only include values greater than 0
    for (const numStr of (text.match(NUMBER_RE) || [])) {
      const val = parseFloat(numStr);
      if (Number.isFinite(val) && val > 0) {
        tokens.add(numStr);
      }
    }

    // Capitalized words/phrases — proper nouns and named entities
    for (const phrase of (text.match(CAPITALIZED_WORD_RE) || [])) {
      const words = phrase.split(/\s+/);

      // Filter out common starters
      const surviving = words.filter(w => !COMMON_STARTERS.has(w.toLowerCase()));

      // Add each surviving word individually (lowercased)
      for (const word of surviving) {
        tokens.add(word.toLowerCase());
      }

      // If 2+ words survived, also add the full multi-word phrase lowercased
      if (surviving.length >= 2) {
        tokens.add(surviving.join(' ').toLowerCase());
      }
    }

    return tokens;
  }

  /**
   * Compute directional overlap score between two token sets.
   *
   * Uses |intersection| / |tokensA| (not Jaccard union) to measure what fraction
   * of the segment's entity tokens are present in the source.
   *
   * @param {Set<string>} tokensA - Segment tokens (denominator)
   * @param {Set<string>} tokensB - Source tokens to check against
   * @returns {number} Overlap ratio 0.0-1.0; returns 0 if tokensA is empty
   * @private
   */
  _overlapScore(tokensA, tokensB) {
    if (tokensA.size === 0) {
      return 0;
    }

    let intersectionCount = 0;
    for (const token of tokensA) {
      if (tokensB.has(token)) {
        intersectionCount++;
      }
    }

    return intersectionCount / tokensA.size;
  }
}

module.exports = ProvenanceAnnotator;
