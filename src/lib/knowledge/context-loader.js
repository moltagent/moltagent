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

// Per-source character budgets (approximate token budget at ~4 chars/token)
const SOURCE_BUDGETS = {
  wiki: 3000,
  file: 3000,
  deck: 1500,
  calendar: 1000,
  email: 2000,
  web: 3000,
  system: 2000
};

const TOTAL_CONTEXT_CAP = 20000;

// Trim priority: first in list gets trimmed first when over total cap
const TRIM_PRIORITY = ['web', 'email', 'deck', 'calendar', 'file', 'wiki', 'system'];

/*
 * Architecture Brief
 * ------------------
 * Problem: The agent needs recent knowledge context injected into its system
 * prompt so it can reference past learnings during conversations and tasks.
 *
 * Pattern: On-demand context builder that reads from LearningLog and
 * KnowledgeBoard, filtering for relevance and confidence, then formatting
 * as a structured text block for prompt injection.
 *
 * Key Dependencies:
 *   - LearningLog: getRecent() for recent learning entries
 *   - KnowledgeBoard: getPendingVerifications() for items needing human review
 *
 * Data Flow:
 *   loadContext() -> loadRecentLearnings() + loadPendingVerifications()
 *                 -> formatLearningsSection() + formatPendingSection()
 *                 -> '<agent_memory>...'
 *
 * Dependency Map:
 *   context-loader.js depends on: LearningLog, KnowledgeBoard (both injected)
 *   Used by: heartbeat-manager.js, bot.js
 */

/**
 * Loads recent knowledge context for the agent's system prompt.
 * Provides memory across conversations by reading the learning log
 * and pending verification cards.
 *
 * @module knowledge/context-loader
 */
class ContextLoader {
  /**
   * @param {Object} options
   * @param {import('./learning-log').LearningLog} options.learningLog
   * @param {import('./knowledge-board').KnowledgeBoard} options.knowledgeBoard
   * @param {Object} [options.collectivesClient] - Optional CollectivesClient for wiki summary
   * @param {Object} [options.config={}]
   * @param {number} [options.config.maxRecentLearnings=20] - Max entries to load from log
   * @param {number} [options.config.maxPendingCards=5] - Max pending verification cards to show
   */
  constructor({ learningLog, knowledgeBoard, deckClient, collectivesClient, config = {} }) {
    this.log = learningLog;
    this.board = knowledgeBoard;
    this.deckClient = deckClient || null;
    this.collectivesClient = collectivesClient || null;
    this.config = {
      maxRecentLearnings: config.maxRecentLearnings || 20,
      maxPendingCards: config.maxPendingCards || 5,
      maxBoards: config.maxBoards || 10,
      ...config
    };
  }

  /**
   * Load context for the agent's system prompt.
   * Called during bot startup or before processing messages.
   *
   * Applies per-source character budgets and a total cap.
   * Sources exceeding their budget are truncated at paragraph boundaries.
   * When total exceeds TOTAL_CONTEXT_CAP, lowest-priority sources are trimmed first.
   *
   * @returns {Promise<string>} Context string wrapped in <agent_memory> tags,
   *   or empty string if no context is available
   */
  async loadContext() {
    // Collect sections with their source type for budget enforcement
    const tagged = [];

    // Recent learnings → system source
    const learnings = await this._loadRecentLearnings();
    if (learnings.length > 0) {
      tagged.push({ source: 'system', content: this._formatLearningsSection(learnings) });
    }

    // Pending verifications → system source
    const pending = await this._loadPendingVerifications();
    if (pending.length > 0) {
      tagged.push({ source: 'system', content: this._formatPendingSection(pending) });
    }

    // Wiki summary → wiki source
    const wikiSummary = await this._loadWikiSummary();
    if (wikiSummary) {
      tagged.push({ source: 'wiki', content: wikiSummary });
    }

    // Deck board discovery → deck source
    const boardSummary = await this._loadBoardSummary();
    if (boardSummary.length > 0) {
      tagged.push({ source: 'deck', content: this._formatBoardSection(boardSummary) });
    }

    if (tagged.length === 0) {
      return '';
    }

    // Phase 1: Apply per-source budget
    const truncations = [];
    for (const entry of tagged) {
      const budget = SOURCE_BUDGETS[entry.source] || SOURCE_BUDGETS.system;
      if (entry.content.length > budget) {
        const original = entry.content.length;
        entry.content = this._truncateAtParagraph(entry.content, budget);
        truncations.push(`[ContextLoader] Truncated ${entry.source}: ${original} → ${entry.content.length} chars (budget: ${budget})`);
      }
    }

    // Phase 2: Total cap — trim lowest-priority sources first
    let total = tagged.reduce((sum, e) => sum + e.content.length, 0);
    if (total > TOTAL_CONTEXT_CAP) {
      for (const source of TRIM_PRIORITY) {
        if (total <= TOTAL_CONTEXT_CAP) break;
        for (const entry of tagged) {
          if (entry.source !== source || entry.content.length === 0) continue;
          const excess = total - TOTAL_CONTEXT_CAP;
          const targetLen = Math.max(0, entry.content.length - excess);
          if (targetLen === 0) {
            total -= entry.content.length;
            truncations.push(`[ContextLoader] Dropped ${entry.source} section entirely (total cap)`);
            entry.content = '';
          } else {
            const original = entry.content.length;
            entry.content = this._truncateAtParagraph(entry.content, targetLen);
            total -= (original - entry.content.length);
            truncations.push(`[ContextLoader] Cap-trimmed ${entry.source}: ${original} → ${entry.content.length} chars`);
          }
        }
      }
    }

    // Log truncations
    for (const msg of truncations) {
      console.warn(msg);
    }

    const sections = tagged.filter(e => e.content.length > 0).map(e => e.content);
    if (sections.length === 0) return '';

    return `<agent_memory>\n${sections.join('\n\n')}\n</agent_memory>`;
  }

  /**
   * Load recent learnings from the log, filtering out low-confidence entries.
   * @private
   * @returns {Promise<Array<Object>>}
   */
  async _loadRecentLearnings() {
    try {
      const entries = await this.log.getRecent(this.config.maxRecentLearnings);

      // Filter: skip uncertainties and low/disputed confidence entries
      // Those belong in the pending verifications section, not confirmed knowledge
      return entries.filter(e =>
        e.type !== 'uncertainty' &&
        e.confidence !== 'low' &&
        e.confidence !== 'disputed'
      );
    } catch (error) {
      console.error('[ContextLoader] Failed to load recent learnings:', error.message);
      return [];
    }
  }

  /**
   * Load items awaiting verification from the knowledge board.
   * @private
   * @returns {Promise<Array<Object>>}
   */
  async _loadPendingVerifications() {
    if (!this.board) return [];
    try {
      const cards = await this.board.getPendingVerifications();
      return cards.slice(0, this.config.maxPendingCards);
    } catch (error) {
      console.error('[ContextLoader] Failed to load pending verifications:', error.message);
      return [];
    }
  }

  /**
   * Format learnings as a markdown section for the context.
   * @private
   * @param {Array<Object>} learnings
   * @returns {string}
   */
  _formatLearningsSection(learnings) {
    const lines = ['## Recent Knowledge\n'];
    lines.push('Things I have learned recently:\n');

    for (const entry of learnings) {
      const date = this._formatDate(entry.timestamp);
      lines.push(`- **${date}:** ${entry.content} (from ${entry.source || 'unknown'})`);
    }

    return lines.join('\n');
  }

  /**
   * Format pending verifications as a markdown section for the context.
   * @private
   * @param {Array<Object>} pending
   * @returns {string}
   */
  _formatPendingSection(pending) {
    const lines = ['## Awaiting Verification\n'];
    lines.push('These items need human confirmation:\n');

    for (const card of pending) {
      const title = card.title.replace('Verify: ', '').replace('Dispute: ', '');
      const status = card.status || 'pending';
      lines.push(`- ${title} (${status})`);
    }

    lines.push('\n*When asked about these topics, I should note my uncertainty.*');

    return lines.join('\n');
  }

  /**
   * Format a timestamp as a short date string.
   * @private
   * @param {string} timestamp - ISO timestamp
   * @returns {string} Short date like "Feb 6"
   */
  _formatDate(timestamp) {
    if (!timestamp) return 'Unknown';
    try {
      const date = new Date(timestamp);
      if (isNaN(date.getTime())) {
        return timestamp.split('T')[0] || 'Unknown';
      }
      return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric'
      });
    } catch {
      return 'Unknown';
    }
  }

  /**
   * Load a lightweight wiki summary from CollectivesClient.
   * Returns page count per section and any low-confidence pages.
   * @private
   * @returns {Promise<string|null>}
   */
  async _loadWikiSummary() {
    if (!this.collectivesClient) return null;
    try {
      const collectiveId = await this.collectivesClient.resolveCollective();
      if (!collectiveId) return null;
      const pages = await this.collectivesClient.listPages(collectiveId);
      if (!Array.isArray(pages) || pages.length === 0) return null;

      // Find section pages (root level)
      const rootPages = pages.filter(p => !p.parentId || p.parentId === 0);
      const lines = ['## Knowledge Wiki\n'];

      for (const section of rootPages) {
        const children = pages.filter(p => p.parentId === section.id);
        lines.push(`- ${section.title}: ${children.length} page${children.length !== 1 ? 's' : ''}`);
      }

      lines.push(`\nTotal: ${pages.length} pages in wiki`);

      // Add stale page note if KnowledgeBoard is available
      if (this.board) {
        try {
          const status = await this.board.getStatus();
          const staleCount = Math.max(0, status.stacks.stale || 0);
          if (staleCount > 0) {
            lines.push(`\n**${staleCount} page${staleCount !== 1 ? 's' : ''} may be stale** and need re-verification.`);
          }
        } catch {
          // Board may not be initialized
        }
      }

      return lines.join('\n');
    } catch (error) {
      console.error('[ContextLoader] Failed to load wiki summary:', error.message);
      return null;
    }
  }

  /**
   * Load board summary from DeckClient.
   * @private
   * @returns {Promise<Array<Object>>}
   */
  async _loadBoardSummary() {
    if (!this.deckClient) return [];
    try {
      const boards = await this.deckClient.listBoards();
      const summaries = [];

      for (const board of (boards || []).slice(0, this.config.maxBoards)) {
        try {
          const stacks = await this.deckClient.getStacks(board.id);
          const owned = board.owner?.uid === this.deckClient.username || board.owner === this.deckClient.username;
          summaries.push({
            title: board.title,
            id: board.id,
            owned,
            stacks: (stacks || []).map(s => ({
              title: s.title,
              cardCount: (s.cards || []).length
            }))
          });
        } catch (e) {
          summaries.push({ title: board.title, id: board.id, owned: false, stacks: [] });
        }
      }
      return summaries;
    } catch (error) {
      console.error('[ContextLoader] Failed to load board summary:', error.message);
      return [];
    }
  }

  /**
   * Format board summary as a markdown section for the context.
   * @private
   * @param {Array<Object>} boards
   * @returns {string}
   */
  _formatBoardSection(boards) {
    const lines = ['## Available Deck Boards\n'];

    for (const board of boards) {
      const stackInfo = board.stacks.map(s => `${s.title} (${s.cardCount})`).join(', ');
      lines.push(`- "${board.title}" (${board.owned ? 'yours' : 'shared'}, ID: ${board.id}): ${stackInfo || 'no stacks'}`);
    }

    return lines.join('\n');
  }

  /**
   * Truncate text at a paragraph boundary (double newline) within the budget.
   * Falls back to single newline boundary, then hard cut.
   * @private
   * @param {string} text
   * @param {number} maxChars
   * @returns {string}
   */
  _truncateAtParagraph(text, maxChars) {
    if (text.length <= maxChars) return text;

    const slice = text.substring(0, maxChars);

    // Try paragraph boundary (double newline)
    const paraBreak = slice.lastIndexOf('\n\n');
    if (paraBreak > maxChars * 0.5) {
      return slice.substring(0, paraBreak) + '\n\n[... truncated]';
    }

    // Try single newline
    const lineBreak = slice.lastIndexOf('\n');
    if (lineBreak > maxChars * 0.5) {
      return slice.substring(0, lineBreak) + '\n[... truncated]';
    }

    // Hard cut
    return slice + '\n[... truncated]';
  }

  /**
   * Get a summary of what the agent remembers.
   * Useful for responding to "what do you know?" type queries.
   *
   * @returns {Promise<Object>} Summary with counts and recent topics
   */
  async getSummary() {
    const learnings = await this.log.getRecent(50);
    let pending = [];
    if (this.board) {
      try {
        pending = await this.board.getPendingVerifications();
      } catch {
        // Board may not be initialized yet
      }
    }

    return {
      totalLearnings: learnings.length,
      highConfidence: learnings.filter(e => e.confidence === 'high').length,
      pendingVerifications: pending.length,
      recentTopics: learnings.slice(0, 10).map(e => e.content)
    };
  }
}

module.exports = { ContextLoader };
