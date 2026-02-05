'use strict';

/**
 * WorkflowBoardDetector
 *
 * Scans all Deck boards and identifies workflow boards by looking for a "rules card".
 * A workflow board has a card (typically the first card in the first stack) whose
 * title starts with "WORKFLOW:" — the card's description contains the full rules.
 *
 * This is intentionally simple — the "detection" is a card title prefix check.
 * The LLM does all the hard work of interpreting the rules.
 *
 * @module workflows/workflow-board-detector
 */
class WorkflowBoardDetector {
  /**
   * @param {Object} options
   * @param {import('../integrations/deck-client')} options.deckClient
   */
  constructor({ deckClient }) {
    this.deck = deckClient;
    this._cache = null;
    this._cacheTime = 0;
    this._cacheTTL = 300000; // 5 min — refresh once per pulse
  }

  /**
   * Get all workflow boards with their full context.
   * @returns {Promise<Array<{board: Object, stacks: Array, description: string, workflowType: string, boardId: number, rulesCardId: number}>>}
   */
  async getWorkflowBoards() {
    if (this._cache && Date.now() - this._cacheTime < this._cacheTTL) {
      return this._cache;
    }

    const boards = await this.deck.listBoards();
    const workflowBoards = [];

    for (const board of boards) {
      if (board.deletedAt) continue;

      // getStacks returns stacks WITH cards already nested
      const stacks = await this.deck.getStacks(board.id);
      const rulesCard = this._findRulesCard(stacks);
      if (!rulesCard) continue;

      workflowBoards.push({
        board,
        stacks,
        description: rulesCard.card.description || '',
        workflowType: this._extractWorkflowType(rulesCard.card.title),
        boardId: board.id,
        rulesCardId: rulesCard.card.id
      });
    }

    this._cache = workflowBoards;
    this._cacheTime = Date.now();

    console.log(`[WorkflowDetector] Found ${workflowBoards.length} workflow board(s)`);
    return workflowBoards;
  }

  /**
   * Find the rules card in a board's stacks.
   * The rules card is identified by a title starting with "WORKFLOW:".
   * @param {Array} stacks
   * @returns {Object|null} {card, stack} or null if not found
   */
  _findRulesCard(stacks) {
    for (const stack of stacks) {
      for (const card of (stack.cards || [])) {
        if (/^WORKFLOW:\s*/i.test((card.title || '').trim())) {
          return { card, stack };
        }
      }
    }
    return null;
  }

  /**
   * Extract workflow type from rules card title.
   * @param {string} title
   * @returns {string} 'pipeline', 'procedure', or 'unknown'
   */
  _extractWorkflowType(title) {
    const match = title.match(/^WORKFLOW:\s*(pipeline|procedure)/i);
    return match ? match[1].toLowerCase() : 'unknown';
  }

  /** Invalidate the cached board list. */
  invalidateCache() {
    this._cache = null;
  }
}

module.exports = WorkflowBoardDetector;
