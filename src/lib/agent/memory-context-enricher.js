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
 * MemoryContextEnricher — Pre-response knowledge injection from wiki (Ring 1) and Deck (Ring 2).
 *
 * Architecture Brief:
 * - Problem: The agent only consults its wiki when classification routes to WikiExecutor.
 *   Messages about known entities ("Who is Sarah?") routed to search/chitchat never
 *   see the wiki or the active Deck task board. The agent has knowledge it cannot access.
 * - Pattern: After classification, before handler dispatch, extract potential entity
 *   references from the user message and search wiki + Deck in parallel. If matches are
 *   found, inject them into context.warmMemory so all downstream handlers (chat, domain,
 *   question) see the agent's own knowledge.
 *   Ring 1 = Wiki (persistent knowledge, via MemorySearcher)
 *   Ring 2 = Deck (ambient working memory — active cards, tasks, due dates)
 * - Key Dependencies: MemorySearcher (three-channel search fusion), DeckClient (getAllCards)
 * - Data Flow: message → extractSearchTerms → [memorySearcher.search, _searchDeck] in parallel
 *              → warmMemory injection
 *
 * Dependency Map:
 *   memory-context-enricher → memory-searcher → nc-request-manager
 *   memory-context-enricher → deck-client → nc-request-manager
 *   memory-context-enricher ← micro-pipeline (called in process())
 *
 * @module agent/memory-context-enricher
 * @version 1.1.0
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
   * @param {Object} [opts.deckClient] - DeckClient instance (Ring 2 ambient working memory)
   * @param {Object} [opts.logger] - Logger instance
   * @param {number} [opts.timeout=3000] - Max ms for enrichment search
   */
  constructor({ memorySearcher, deckClient, logger, timeout } = {}) {
    this.memorySearcher = memorySearcher;
    this.deckClient = deckClient || null;
    this.logger = logger || console;
    this.timeout = timeout || 3000;

    // Deck board state cache (2-minute TTL)
    this._deckCache = null;
    this._deckCacheTime = 0;
    this._deckCacheTTL = 120000; // 2 minutes
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

    // Capitalized multi-word names: "Sarah Miller", "Project X", "AcmeCorp"
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
   * Search wiki (Ring 1) and Deck (Ring 2) for relevant knowledge and format as context string.
   * Runs after classification, before handler dispatch.
   * Never blocks the response pipeline — both probes time out after 3s.
   * Deck failures are silent — wiki results always flow through.
   *
   * @param {string} message - User's message
   * @param {string} intent - The classified intent
   * @returns {Promise<string|null>} Context to inject into warmMemory, or null
   */
  async enrich(message, intent) {
    if (SKIP_INTENTS.has(intent)) return null;

    const searchTerms = this._extractSearchTerms(message);
    if (searchTerms.length === 0) return null;

    try {
      const _timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));

      // Parallel probes — wiki and deck, independent, with timeout
      const [wikiResult, deckResult] = await Promise.allSettled([
        Promise.race([
          this.memorySearcher.search(searchTerms.join(' '), { maxResults: 3, scope: 'all' }),
          _timeout(this.timeout)
        ]),
        Promise.race([
          this._searchDeck(searchTerms),
          _timeout(this.timeout)
        ])
      ]);

      const wikiResults = wikiResult.status === 'fulfilled' && Array.isArray(wikiResult.value) ? wikiResult.value : [];
      const deckResults = deckResult.status === 'fulfilled' && Array.isArray(deckResult.value) ? deckResult.value : [];

      const allResults = [...wikiResults, ...deckResults];
      if (allResults.length === 0) return null;

      // Format results — wiki results use existing format, deck results have their own
      const contextParts = allResults
        .filter(r => r.title || r.excerpt || r.snippet)
        .map(r => {
          if (r.source === 'deck') {
            const confidence = r.matchType === 'title' ? 'high' : 'medium';
            return `[source: deck, match: ${r.matchType}, confidence: ${confidence}]\nCard #${r.cardId}: "${r.title}"${r.boardTitle ? `\nBoard: ${r.boardTitle}` : ''}\nStack: ${r.stackName}${r.duedate ? ` | Due: ${r.duedate}` : ''}${r.description ? '\n' + r.description.substring(0, 300) : ''}`;
          }
          const title = r.title || 'Untitled';
          const snippet = (r.excerpt || r.subline || '').substring(0, 300);
          const source = (r.source || 'wiki').toLowerCase();
          const confidence = this._computeConfidence(r);
          return `[source: ${source}, confidence: ${confidence}]\n${title}\n${snippet}`;
        });

      if (contextParts.length === 0) return null;

      this.logger.info(`[MemoryEnrich] Found ${contextParts.length} matches for: ${searchTerms.join(', ')}`);

      return `<agent_knowledge>\n${contextParts.join('\n\n')}\n</agent_knowledge>`;
    } catch (err) {
      if (err.message !== 'timeout') {
        this.logger.warn(`[MemoryEnrich] Search failed: ${err.message}`);
      }
      return null;
    }
  }

  /**
   * Compute confidence label from search result metadata.
   * Uses channelScores if available, otherwise defaults to medium.
   * @param {Object} result - Search result with optional channelScores
   * @returns {string} 'high' | 'medium' | 'low'
   * @private
   */
  _computeConfidence(result) {
    const cs = result.channelScores;
    if (!cs) return 'medium';

    // Title-level keyword match (score ~1.0) = high confidence
    if (cs.keyword >= 0.8) return 'high';
    // Any strong single-channel match
    if (cs.keyword >= 0.5 || cs.vector >= 0.7 || cs.graph >= 0.7) return 'medium';
    // Weak or tangential match
    return 'low';
  }

  /**
   * Get cached multi-board deck state. Refreshes every 2 minutes.
   * Fetches all non-archived boards and their stacks with cards.
   * @returns {Promise<Object>} Board state: { "BoardTitle/StackTitle": cards[] }
   * @private
   */
  async _getDeckState() {
    const now = Date.now();
    if (this._deckCache && (now - this._deckCacheTime) < this._deckCacheTTL) {
      return this._deckCache;
    }

    try {
      const boards = await this.deckClient.listBoards();
      const activeBoards = (boards || []).filter(b => !b.archived);
      const state = {};

      // Fetch stacks (with cards) for each board in parallel
      const stackResults = await Promise.allSettled(
        activeBoards.map(b => this.deckClient.getStacks(b.id).then(stacks => ({ board: b, stacks })))
      );

      for (const result of stackResults) {
        if (result.status !== 'fulfilled') continue;
        const { board, stacks } = result.value;
        for (const stack of (stacks || [])) {
          const key = `${board.title}/${stack.title}`;
          const cards = (stack.cards || []).map(c => ({ ...c, _boardTitle: board.title, _boardId: board.id }));
          state[key] = cards;
        }
      }

      const boardCount = activeBoards.length;
      const cardCount = Object.values(state).reduce((n, cards) => n + cards.length, 0);
      if (boardCount > 1) {
        this.logger.info(`[MemoryEnrich] Deck: ${cardCount} cards across ${boardCount} boards`);
      }

      this._deckCache = state;
      this._deckCacheTime = now;
      return state;
    } catch (err) {
      this.logger.warn(`[MemoryEnrich] Deck multi-board fetch failed: ${err.message}`);
      // Fallback: try single-board getAllCards
      try {
        const state = await this.deckClient.getAllCards();
        this._deckCache = state;
        this._deckCacheTime = now;
        return state;
      } catch {
        return this._deckCache || {};
      }
    }
  }

  /**
   * Search Deck cards by keyword against cached board state.
   * Returns matching cards with stack context and due dates.
   *
   * @param {string[]} searchTerms
   * @returns {Promise<Array>} Matching card results
   * @private
   */
  async _searchDeck(searchTerms) {
    if (!this.deckClient) {
      this.logger.info('[MemoryEnrich] Deck search skipped: no deckClient');
      return [];
    }

    try {
      const state = await this._getDeckState();
      const stacks = Object.keys(state || {});
      const cardCount = stacks.reduce((n, k) => n + (state[k] || []).length, 0);
      this.logger.info(`[MemoryEnrich] Deck search: ${cardCount} cards in ${stacks.length} stacks, terms: ${searchTerms.join(', ')}`);

      // Build keyword set: split multi-word search terms into individual words,
      // filter out short/common words so "the status of the onboarding automation work"
      // becomes ["status", "onboarding", "automation", "work"] and can match card titles.
      const STOP_WORDS = new Set([
        'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'is', 'it',
        'my', 'and', 'or', 'do', 'you', 'your', 'what', 'how', 'about', 'with'
      ]);
      const keywords = new Set();
      for (const term of searchTerms) {
        const lower = term.toLowerCase();
        // Keep the full term for exact substring matching
        keywords.add(lower);
        // Also split into individual words for fuzzy matching
        for (const word of lower.split(/\s+/)) {
          if (word.length >= 4 && !STOP_WORDS.has(word)) {
            keywords.add(word);
          }
        }
      }
      const keywordArr = Array.from(keywords);

      const results = [];

      for (const [stackKey, cards] of Object.entries(state || {})) {
        for (const card of (cards || [])) {
          const titleLower = (card.title || '').toLowerCase();
          const descLower = (card.description || '').toLowerCase();

          const titleMatch = keywordArr.some(kw => titleLower.includes(kw));
          const descMatch = card.description && keywordArr.some(kw => descLower.includes(kw));

          if (titleMatch || descMatch) {
            const boardTitle = card._boardTitle || '';
            const stackLabel = stackKey.includes('/') ? stackKey.split('/').pop() : stackKey;
            results.push({
              source: 'deck',
              title: card.title,
              snippet: (boardTitle ? `Board: ${boardTitle} | ` : '') +
                `Stack: ${stackLabel} | Card #${card.id}` +
                `${card.duedate ? ` | Due: ${card.duedate}` : ''}` +
                `${card.description ? '\n' + card.description.substring(0, 300) : ''}`,
              matchType: titleMatch ? 'title' : 'content',
              score: titleMatch ? 0.9 : 0.6,
              cardId: card.id,
              boardTitle: boardTitle,
              boardId: card._boardId || null,
              stackName: stackLabel,
              duedate: card.duedate || null,
              description: card.description || null
            });
          }
        }
      }

      if (results.length > 0) {
        this.logger.info(`[MemoryEnrich] Deck matched ${results.length} cards`);
      }

      return results.sort((a, b) => b.score - a.score).slice(0, 3);
    } catch (err) {
      this.logger.warn(`[MemoryEnrich] Deck search failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Invalidate the cached deck board state.
   * Call this after DeckExecutor operations (card created/moved/updated/deleted).
   */
  invalidateDeckCache() {
    this._deckCache = null;
    this._deckCacheTime = 0;
  }
}

module.exports = MemoryContextEnricher;
