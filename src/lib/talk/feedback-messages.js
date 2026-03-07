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
 * FeedbackMessages — Intent-specific chat messages sent immediately after
 * classification, before the heavy pipeline work begins.
 *
 * Architecture Brief:
 * - Problem: The agent takes 30-70s to respond. The user stares at nothing.
 * - Pattern: After classification (~2-3s), send a short in-chat message
 *   acknowledging the request and indicating what the agent is doing.
 *   Fire-and-forget — never blocks the pipeline.
 * - Key Dependencies: None (pure logic). Called by message-processor.
 * - Data Flow: intent + action → feedback string | null
 *
 * @module talk/feedback-messages
 * @version 1.0.0
 */

const FEEDBACK_MESSAGES = {
  // Deck operations
  deck: {
    deck_create:     '\u{1F4CB} Setting up that board for you...',
    deck_move:       '\u{1F4CB} Moving that card...',
    deck_query:      '\u{1F4CB} Checking your tasks...',
    default:         '\u{1F4CB} Working on your tasks...'
  },

  // Wiki / Knowledge
  wiki: {
    wiki_write:      '\u{1F4BE} Saving that to my knowledge base...',
    wiki_read:       '\u{1F50D} Looking that up...',
    default:         '\u{1F50D} Searching my memory...'
  },

  // Calendar
  calendar: {
    calendar_create: '\u{1F4C5} Adding that to your calendar...',
    calendar_query:  '\u{1F4C5} Checking your schedule...',
    calendar_update: '\u{1F4C5} Updating that event...',
    calendar_delete: '\u{1F4C5} Removing that event...',
    default:         '\u{1F4C5} Looking at your calendar...'
  },

  // Email
  email: {
    email_send:      '\u{2709}\u{FE0F} Drafting that email...',
    email_read:      '\u{2709}\u{FE0F} Checking your inbox...',
    default:         '\u{2709}\u{FE0F} Working on email...'
  },

  // Web search
  search: {
    default:         '\u{1F310} Searching the web for that...'
  },

  // File operations
  file: {
    file_upload:     '\u{1F4C4} Working on that file...',
    file_query:      '\u{1F4C4} Reading that file...',
    default:         '\u{1F4C4} Handling files...'
  },

  // Knowledge queries — cross-domain information synthesis
  knowledge: {
    default:         '\u{1F50D} Searching my knowledge base...'
  },

  // Complex / escalation (cloud path)
  complex: {
    default:         '\u{1F914} Let me think about that...'
  },

  // Confirmation/selection — needs cloud, but is usually quick
  confirmation: null,
  selection: null,

  // Chitchat/greeting — fast local response, no feedback needed
  chitchat: null,
  greeting: null
};

/** Fallback for unknown intents routed to cloud */
const UNKNOWN_FEEDBACK = '\u{1F4AD} Working on that...';

/**
 * Get the appropriate feedback message for an intent + fine-grained action.
 *
 * @param {string} intent - Classified intent domain (deck, wiki, calendar, etc.)
 * @param {string} [action] - Fine-grained action (deck_create, wiki_read, etc.)
 * @returns {string|null} Feedback message, or null if no feedback should be sent
 */
function getFeedbackMessage(intent, action) {
  if (!intent) return null;

  const domain = FEEDBACK_MESSAGES[intent];

  // Explicitly null = no feedback (chitchat, greeting, confirmation)
  if (domain === null) return null;

  // Unknown intent going to cloud — generic feedback
  if (domain === undefined) return UNKNOWN_FEEDBACK;

  // Try action-specific, then default for the domain
  if (action && domain[action]) return domain[action];
  return domain.default || UNKNOWN_FEEDBACK;
}

module.exports = { getFeedbackMessage, FEEDBACK_MESSAGES };
