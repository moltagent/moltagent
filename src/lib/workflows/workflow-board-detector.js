'use strict';

/**
 * WorkflowBoardDetector
 *
 * Scans all Deck boards and identifies workflow boards by looking for a "rules card".
 * A workflow board has a card (typically the first card in the first stack) whose
 * title starts with "WORKFLOW:" — the card's description contains the full rules.
 *
 * Also ensures that every detected workflow board carries the reserved workflow
 * labels (GATE, APPROVED, REJECTED, PAUSED). This is idempotent — safe to call
 * every heartbeat.
 *
 * This is intentionally simple — the "detection" is a card title prefix check.
 * The LLM does all the hard work of interpreting the rules.
 *
 * @module workflows/workflow-board-detector
 */

/**
 * Reserved workflow labels and their display colors (hex, no leading #).
 * These are created on every workflow board so the engine can apply them
 * without a separate setup step.
 */
const WORKFLOW_LABELS = [
  { title: 'GATE',     color: 'E9967A' },
  { title: 'APPROVED', color: '4CAF50' },
  { title: 'REJECTED', color: 'F44336' },
  { title: 'PAUSED',   color: '90A4AE' }
];

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
   * Calls ensureWorkflowLabels() on each detected board so the reserved
   * label set is always present.
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

      const rawDesc = rulesCard.card.description || '';
      const isHtml = /<[a-z/][\s\S]*>/i.test(rawDesc);
      console.log(`[WorkflowDetector] Rules card "${rulesCard.card.title}" description: ${rawDesc.length} chars, format=${isHtml ? 'html' : 'plain'}`);

      // Ensure this workflow board has all reserved labels
      await this.ensureWorkflowLabels(board.id);

      workflowBoards.push({
        board,
        stacks,
        description: rawDesc,
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
   * Ensure that a workflow board has all reserved workflow labels.
   * Creates any missing labels; skips labels that already exist.
   * Safe to call on every heartbeat — idempotent.
   *
   * @param {number} boardId
   * @returns {Promise<void>}
   */
  async ensureWorkflowLabels(boardId) {
    if (!boardId) return;

    let fullBoard;
    try {
      fullBoard = await this.deck.getBoard(boardId);
    } catch (err) {
      console.warn(`[WorkflowDetector] Could not fetch board ${boardId} for label check: ${err.message}`);
      return;
    }

    // Build a set of existing label titles (upper-cased for case-insensitive comparison)
    const existing = new Set(
      (fullBoard.labels || []).map(l => (l.title || '').toUpperCase())
    );

    for (const labelDef of WORKFLOW_LABELS) {
      if (existing.has(labelDef.title.toUpperCase())) continue;

      try {
        await this.deck.createLabel(boardId, labelDef.title, labelDef.color);
        console.log(`[WorkflowDetector] Created label "${labelDef.title}" on board ${boardId}`);
      } catch (err) {
        // Non-fatal — log and continue. A duplicate-label error from a race
        // condition is expected and harmless.
        console.warn(`[WorkflowDetector] Could not create label "${labelDef.title}" on board ${boardId}: ${err.message}`);
      }
    }
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
