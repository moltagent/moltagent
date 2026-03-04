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

'use strict';

/**
 * MemoryContextEnricher — Pre-response wiki knowledge injection.
 *
 * Architecture Brief:
 * - Problem: The agent only consults its wiki when classification routes to WikiExecutor.
 *   Messages about known entities ("Who is Sarah?") routed to search/chitchat never
 *   see the wiki. The agent has knowledge it cannot access.
 * - Pattern: After classification, before handler dispatch, extract potential entity
 *   references from the user message and search wiki. If matches are found, inject
 *   them into context.warmMemory so all downstream handlers (chat, domain, question)
 *   see the agent's own knowledge.
 * - Key Dependencies: MemorySearcher (three-channel search fusion)
 * - Data Flow: message → extractSearchTerms → memorySearcher.search → warmMemory injection
 *
 * Dependency Map:
 *   memory-context-enricher → memory-searcher → nc-request-manager
 *   memory-context-enricher ← micro-pipeline (called in process())
 *
 * @module agent/memory-context-enricher
 * @version 1.0.0
 */

// Intents that never need memory enrichment
const SKIP_INTENTS = new Set(['greeting', 'confirmation', 'selection']);

// Common sentence starters that are capitalized but not entity names
const COMMON_STARTERS = new Set([
  'The', 'This', 'That', 'These', 'Those', 'What', 'When', 'Where', 'Which',
  'Who', 'How', 'Why', 'Can', 'Could', 'Would', 'Should', 'Will', 'Does',
  'Did', 'Has', 'Have', 'Are', 'Were', 'Was', 'Been', 'Being',
  'Please', 'Help', 'Show', 'Tell', 'Find', 'Get', 'Set', 'Add', 'Remove',
  'Delete', 'Create', 'Update', 'Move', 'Send', 'Check', 'List',
  'Hey', 'Hello', 'Thanks', 'Sure', 'Yes', 'Yeah', 'Okay',
  'Remember', 'Search', 'Look', 'Save', 'Write', 'Read',
  'Also', 'But', 'And', 'Not', 'All', 'Any', 'Some', 'Just',
]);

class MemoryContextEnricher {
  /**
   * @param {Object} opts
   * @param {Object} opts.memorySearcher - MemorySearcher instance
   * @param {Object} [opts.logger] - Logger instance
   * @param {number} [opts.timeout=3000] - Max ms for enrichment search
   */
  constructor({ memorySearcher, logger, timeout } = {}) {
    this.memorySearcher = memorySearcher;
    this.logger = logger || console;
    this.timeout = timeout || 3000;
  }

  /**
   * Extract potential entity references from user message.
   * Looks for capitalized words/phrases, quoted terms, and knowledge-query patterns.
   * False positives are cheap (search returns nothing).
   * False negatives are expensive (agent ignores its own knowledge).
   *
   * @param {string} message - User message text
   * @returns {string[]} Search terms
   */
  _extractSearchTerms(message) {
    if (!message || message.length < 3) return [];

    const terms = new Set();

    // Capitalized multi-word names: "Sarah Miller", "Project X", "ManeraMedia"
    const capitalizedPattern = /(?:^|\s)([A-Z][a-zA-Z]{2,}(?:\s+[A-Z][a-zA-Z]{2,})*)/g;
    let match;
    while ((match = capitalizedPattern.exec(message)) !== null) {
      const term = match[1].trim();
      // Skip common sentence starters and noise
      if (!COMMON_STARTERS.has(term)) {
        terms.add(term);
      }
    }

    // Quoted terms: "FileOps", 'onboarding process'
    const quotedPattern = /["'\u201C\u201D]([^"'\u201C\u201D]{2,50})["'\u201C\u201D]/g;
    while ((match = quotedPattern.exec(message)) !== null) {
      terms.add(match[1].trim());
    }

    // Knowledge-query patterns: "who is X", "what do you know about X"
    const knowledgePatterns = [
      /(?:know about|remember about|tell me about|who is|what is|what's)\s+(.+?)(?:\?|$)/i,
      /(?:what do you know about)\s+(.+?)(?:\?|$)/i,
    ];
    for (const pattern of knowledgePatterns) {
      match = pattern.exec(message);
      if (match) {
        terms.add(match[1].trim().replace(/\?$/, ''));
      }
    }

    return Array.from(terms).filter(t => t.length >= 2).slice(0, 5);
  }

  /**
   * Search wiki for relevant knowledge and format as context string.
   * Runs after classification, before handler dispatch.
   * Never blocks the response pipeline — times out after 3s.
   *
   * @param {string} message - User's message
   * @param {string} intent - The classified intent
   * @returns {Promise<string|null>} Context to inject into warmMemory, or null
   */
  async enrich(message, intent) {
    // Skip for intents that never need memory enrichment
    if (SKIP_INTENTS.has(intent)) return null;

    // Skip for wiki domain — WikiExecutor already handles its own lookups
    if (intent === 'wiki') return null;

    const searchTerms = this._extractSearchTerms(message);
    if (searchTerms.length === 0) return null;

    try {
      const results = await Promise.race([
        this.memorySearcher.search(searchTerms.join(' '), {
          maxResults: 3,
          scope: 'all'
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), this.timeout))
      ]);

      if (!results || results.length === 0) return null;

      // Format as concise context block
      const contextParts = results
        .filter(r => r.title || r.excerpt)
        .map(r => {
          const title = r.title || 'Untitled';
          const snippet = (r.excerpt || r.subline || '').substring(0, 300);
          return `[${r.source || 'Wiki'}: ${title}] ${snippet}`;
        });

      if (contextParts.length === 0) return null;

      this.logger.info(`[MemoryEnrich] Found ${contextParts.length} wiki matches for: ${searchTerms.join(', ')}`);

      return `Your knowledge base contains:\n${contextParts.join('\n')}`;
    } catch (err) {
      if (err.message !== 'timeout') {
        this.logger.warn(`[MemoryEnrich] Search failed: ${err.message}`);
      }
      return null;
    }
  }
}

module.exports = MemoryContextEnricher;
