/**
 * Moltagent - Commitment Detector
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
 * Problem: During a conversation the agent makes verbal commitments (promises,
 * research pledges, follow-up offers) that need to be surfaced so the user or
 * the agent itself can track and honour them.  These live only inside message
 * text; no structured signal exists at creation time.
 *
 * Pattern: Pure regex scan over the assistant turn history.  Each assistant
 * message is sentence-tokenised, each sentence is tested against an ordered
 * set of commitment patterns (most specific first so follow-up > promise when
 * both match).  The preceding user message is attached as context.  Results
 * are deduplicated by normalised text and capped at 5.
 *
 * Key Dependencies:
 *   - None (pure logic, no I/O)
 *
 * Data Flow:
 *   context ([{role, content}])
 *     → filter assistant messages
 *     → sentence-split each message
 *     → regex match against COMMITMENT_PATTERNS
 *     → attach preceding user message as context
 *     → deduplicate by normalised sentence
 *     → cap at MAX_RESULTS
 *     → return [{text, context, type}]
 *
 * Dependency Map:
 *   commitment-detector.js depends on: nothing
 *   Used by: proactive-evaluator, heartbeat-intelligence (future)
 *
 * @module integrations/commitment-detector
 * @version 1.0.0
 */

'use strict';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RESULTS = 5;
const MIN_SENTENCE_LENGTH = 10;

/**
 * Ordered pattern list.  Each entry is tested in sequence; the FIRST match
 * wins.  More specific patterns (follow-up) must come before more general
 * ones (promise / action) to avoid wrong classification.
 *
 * @type {Array<{pattern: RegExp, type: string}>}
 */
const COMMITMENT_PATTERNS = [
  // follow-up — must precede plain promise/action because it is more specific
  { pattern: /\bI['']ll\b.*?\b(follow up|get back to you|circle back)\b/i,  type: 'follow-up' },
  { pattern: /\bI will\b.*?\b(follow up|get back to you|circle back)\b/i,   type: 'follow-up' },

  // research offers
  { pattern: /\blet me\s+(research|look into|check|find|investigate|prepare|draft|dig into)\b/i, type: 'research' },
  { pattern: /\bI can\s+(look into|research|check|find|prepare|set up)\b/i,                      type: 'offer' },

  // concrete action commitments
  { pattern: /\bI['']ll\b.*?\b(send|create|write|draft|schedule|set up|prepare)\b/i, type: 'action' },

  // generic promise — broad patterns last so they don't shadow specifics above
  { pattern: /\bI will\b(?!\s+not\b)/i, type: 'promise' },
  { pattern: /\bI['']ll\b(?!\s+not\b)/i, type: 'promise' },
];

/**
 * Sentences containing these phrases are treated as hypothetical and excluded.
 * @type {RegExp}
 */
const HYPOTHETICAL_RE = /\bif I were to\b|\bI would suggest\b/i;

/**
 * Explicit negations that should be excluded despite matching commitment
 * patterns.  The individual patterns already exclude "I will not" and
 * "I'll not" via negative lookahead, but belt-and-suspenders for edge cases.
 * @type {RegExp}
 */
const NEGATION_RE = /\bI will not\b|\bI won't\b|\bI can't\b/i;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Split text into sentences using a simple heuristic: split on punctuation
 * followed by whitespace or end-of-string, while respecting common
 * abbreviations imperfectly (good-enough for commitment detection).
 *
 * @param {string} text
 * @returns {string[]}
 */
function splitSentences(text) {
  if (!text || typeof text !== 'string') return [];

  // Normalise newlines to spaces so multi-line assistant messages work.
  const normalised = text.replace(/\r?\n/g, ' ').trim();

  // Split on sentence-ending punctuation followed by whitespace or EOS.
  // We keep the delimiter attached to the preceding segment.
  const raw = normalised.split(/(?<=[.!?])\s+(?=[A-Z"'(])|(?<=[.!?])$/);

  return raw
    .map(s => s.trim())
    .filter(s => s.length >= MIN_SENTENCE_LENGTH);
}

/**
 * Normalise a sentence for deduplication: lowercase, collapse whitespace,
 * strip trailing punctuation.
 *
 * @param {string} sentence
 * @returns {string}
 */
function normalise(sentence) {
  return sentence
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.!?,;:]+$/, '')
    .trim();
}

/**
 * Return true if the sentence should be excluded from commitment detection.
 *
 * @param {string} sentence
 * @returns {boolean}
 */
function isExcluded(sentence) {
  return HYPOTHETICAL_RE.test(sentence) || NEGATION_RE.test(sentence);
}

/**
 * Find the type of the first matching commitment pattern, or null if none.
 *
 * @param {string} sentence
 * @returns {string|null}
 */
function matchCommitmentType(sentence) {
  for (const { pattern, type } of COMMITMENT_PATTERNS) {
    if (pattern.test(sentence)) {
      return type;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect commitments made by the assistant in a conversation context.
 *
 * @param {Array<{role: string, content: string}>} context - Conversation messages.
 * @returns {Array<{text: string, context: string, type: string}>}
 */
function detectCommitments(context) {
  if (!Array.isArray(context) || context.length === 0) return [];

  const results = [];
  const seen = new Set(); // normalised sentence strings for deduplication

  for (let i = 0; i < context.length; i++) {
    const message = context[i];

    // Only inspect assistant messages.
    if (!message || message.role !== 'assistant') continue;

    const content = message.content;
    if (!content || typeof content !== 'string') continue;

    // Find the nearest preceding user message to attach as context.
    let precedingUserContent = '';
    for (let j = i - 1; j >= 0; j--) {
      if (context[j] && context[j].role === 'user') {
        precedingUserContent = context[j].content || '';
        break;
      }
    }

    const sentences = splitSentences(content);

    for (const sentence of sentences) {
      if (results.length >= MAX_RESULTS) break;

      if (isExcluded(sentence)) continue;

      const type = matchCommitmentType(sentence);
      if (!type) continue;

      const key = normalise(sentence);
      if (seen.has(key)) continue;

      seen.add(key);
      results.push({
        text: sentence,
        context: precedingUserContent,
        type,
      });
    }

    if (results.length >= MAX_RESULTS) break;
  }

  return results;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { detectCommitments };
