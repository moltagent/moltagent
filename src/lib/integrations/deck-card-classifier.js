/**
 * AGPL-3.0 License
 * Copyright (C) 2024 Moltagent Contributors
 *
 * deck-card-classifier.js
 *
 * Architecture Brief
 * ------------------
 * Problem:   The agent assigns due dates and owners to structural/config cards
 *            (WORKFLOW rules, CONFIG cards, TEMPLATE cards) that are not work
 *            items. Instance-level guards scattered across callers would diverge.
 *
 * Pattern:   Single-source classifier. All callers (WorkflowEngine, ToolRegistry,
 *            DeckTaskProcessor) import and call isStructuralCard(card). Detection
 *            uses a fast first-pass label check ("System" label) followed by
 *            structured markers in card metadata — not natural language parsing,
 *            so no LLM or regex intelligence is needed here.
 *
 * Key Dependencies: None (pure function, no I/O)
 *
 * Data Flow: card { title, description } → boolean
 *
 * Dependency Map:
 *   deck-card-classifier  <──  workflow-engine
 *                         <──  tool-registry
 *                         <──  deck-task-processor
 */

'use strict';

/**
 * Structural marker prefixes that appear at the start of a card title
 * (after stripping leading emoji and whitespace).
 * @type {string[]}
 */
const TITLE_STRUCTURAL_PREFIXES = [
  'CONFIG:',
  'WORKFLOW:',
  'RULES:',
  'TEMPLATE:',
  'FORMAT:',
  'SERIES:',
  'CONTEXT:'
];

/**
 * Structural marker prefixes that appear at the start of a card description.
 * @type {string[]}
 */
const DESCRIPTION_STRUCTURAL_PREFIXES = [
  'WORKFLOW:',
  'TRIGGER:',
  'CONTEXT:',
  'RULES:',
  'CONFIG:',
  'PROCEDURE:'
];

/**
 * Check whether a card carries a specific Deck label (case-insensitive).
 * @param {Object} card
 * @param {string} labelTitle
 * @returns {boolean}
 */
function hasLabel(card, labelTitle) {
  if (!Array.isArray(card.labels)) return false;
  const upper = labelTitle.toUpperCase();
  return card.labels.some(l => typeof l.title === 'string' && l.title.toUpperCase() === upper);
}

/**
 * Strip leading emoji characters and whitespace from a string.
 * Emoji are Unicode characters in the ranges commonly used as visual markers.
 * We strip them so prefix detection works regardless of decorative leaders.
 *
 * @param {string} str
 * @returns {string}
 */
function stripLeadingEmojiAndWhitespace(str) {
  // Unicode emoji ranges: emoticons, misc symbols, dingbats, supplemental symbols, etc.
  return str.replace(/^[\p{Emoji}\s]+/u, '');
}

/**
 * Determine whether a Deck card is a structural/config card rather than a work item.
 *
 * A card is structural if ANY of the following hold:
 * - Card has a "System" label (fast path, checked first)
 * - Title (after stripping leading emoji/whitespace) starts with a structural prefix
 * - Description starts with a structural prefix
 * - Title contains "DO NOT DELETE" or "DO NOT EDIT" (case-insensitive)
 *
 * This is a pure plumbing check against structured markers — not natural-language
 * classification. The LLM does not participate here.
 *
 * @param {Object} card - Deck card object with { title, description }
 * @returns {boolean} true if card is structural metadata, not a work item
 */
function isStructuralCard(card) {
  if (!card || typeof card !== 'object') return false;

  // Fast path: "System" label marks structural cards regardless of content
  if (hasLabel(card, 'System')) return true;

  const rawTitle = typeof card.title === 'string' ? card.title : '';
  const description = typeof card.description === 'string' ? card.description : '';

  const strippedTitle = stripLeadingEmojiAndWhitespace(rawTitle);
  const upperTitle = strippedTitle.toUpperCase();

  // Check title structural prefixes (case-insensitive via uppercase comparison)
  for (const prefix of TITLE_STRUCTURAL_PREFIXES) {
    if (upperTitle.startsWith(prefix.toUpperCase())) return true;
  }

  // Check "DO NOT DELETE" / "DO NOT EDIT" anywhere in raw title
  const upperRawTitle = rawTitle.toUpperCase();
  if (upperRawTitle.includes('DO NOT DELETE') || upperRawTitle.includes('DO NOT EDIT')) {
    return true;
  }

  // Check description structural prefixes
  if (description) {
    const upperDesc = description.trimStart().toUpperCase();
    for (const prefix of DESCRIPTION_STRUCTURAL_PREFIXES) {
      if (upperDesc.startsWith(prefix.toUpperCase())) return true;
    }
  }

  return false;
}

module.exports = { isStructuralCard };
