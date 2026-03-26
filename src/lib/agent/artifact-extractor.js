/**
 * AGPL-3.0 License
 * Copyright (C) 2024 Moltagent Contributors
 *
 * artifact-extractor.js
 *
 * Architecture Brief
 * ------------------
 * Problem:   When a tool call resolves to a single artifact (card, wiki page,
 *            calendar event), the session needs to record that artifact as the
 *            "active focus" so subsequent messages are grounded to it.
 *
 * Pattern:   Pure extraction function. Inspects tool result shape and returns
 *            a normalized artifact descriptor, or null if the result does not
 *            contain a single focusable artifact. No I/O, no side effects.
 *
 * Key Dependencies: None (pure function)
 *
 * Data Flow: toolResult → extractArtifact() → { type, id, ... } | null
 *
 * Dependency Map:
 *   artifact-extractor  <──  agent-loop
 *                       <──  micro-pipeline
 */

'use strict';

/**
 * Extract a focusable artifact from a tool result.
 * Only tools that resolve to a single artifact produce focus.
 *
 * Tool handlers that return structured data use the {text, ...rest} pattern
 * in ToolRegistry.execute(), so toolResult will contain the spread fields
 * alongside success and result. Currently only deck_create_card returns a
 * card object; other tools return plain strings.
 *
 * @param {string} _toolName - Reserved for future per-tool disambiguation
 * @param {Object} toolResult - { success, result, card?, page?, event?, ... }
 * @returns {Object|null} - { type, id, boardId?, stackId?, title, source }
 */
function extractArtifact(_toolName, toolResult) {
  if (!toolResult || !toolResult.success) return null;

  // Deck tools that return a single card (deck_create_card)
  if (toolResult.card && toolResult.card.id) {
    return {
      type: 'deck_card',
      id: toolResult.card.id,
      boardId: toolResult.card.boardId || null,
      stackId: toolResult.card.stackId || null,
      title: toolResult.card.title || '',
      source: 'tool_result',
    };
  }

  // Wiki tools — none currently return structured page objects
  if (toolResult.page && toolResult.page.id) {
    return {
      type: 'wiki_page',
      id: toolResult.page.id,
      title: toolResult.page.title || '',
      source: 'tool_result',
    };
  }

  // Calendar tools — none currently return structured event objects
  if (toolResult.event && toolResult.event.uid) {
    return {
      type: 'calendar_event',
      id: toolResult.event.uid,
      title: toolResult.event.summary || '',
      source: 'tool_result',
    };
  }

  return null;
}

module.exports = { extractArtifact };
