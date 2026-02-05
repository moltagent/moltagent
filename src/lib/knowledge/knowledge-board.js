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

/*
 * Architecture Brief
 * ------------------
 * Problem: The agent encounters uncertain or contradictory information but has
 * no mechanism to flag it for human review. Knowledge goes unverified.
 *
 * Pattern: Dedicated Deck board ("MoltAgent Knowledge") with four stacks:
 *   Verified, Uncertain, Stale, Disputed.
 * The agent creates cards when it encounters uncertainty or contradiction.
 * Humans move cards to Verified after review. The agent checks card positions
 * to learn what has been confirmed.
 *
 * Key Dependencies:
 *   - DeckClient: A SEPARATE DeckClient instance configured with
 *     boardName = 'MoltAgent Knowledge'. DeckClient is hardwired to a single
 *     board via this.boardName, so we need a dedicated instance.
 *
 * CRITICAL INTERFACE NOTES (discovered from deck-client.js):
 *   DeckClient methods use stackName strings, NOT stackIds:
 *     - listBoards() -> array of {id, title, ...}
 *     - findBoard() -> {id, title, ...} or null (searches by this.boardName)
 *     - createBoard() -> {boardId, stacks, labels, created} (uses this.boardName)
 *     - ensureBoard() -> {boardId, stacks, labels}
 *     - getCardsInStack(stackName) -> array of card objects
 *     - createCard(stackName, {title, description, duedate, labels}) -> card
 *     - getCard(cardId, stackName) -> card object
 *     - updateCard(cardId, stackName, updates) -> card object
 *     - moveCard(cardId, fromStack, toStack, order) -> void
 *     - addComment(cardId, message, type) -> response
 *
 *   The DeckClient manages its own board creation with ensureBoard().
 *   Stack names are keys like 'inbox', 'queued', etc.
 *   We configure our own stack names via the constructor.
 *
 * Data Flow:
 *   initialize() -> DeckClient.ensureBoard() -> caches boardId/stacks
 *   createVerificationCard(item) -> createCard('uncertain', {...})
 *   getPendingVerifications() -> getCardsInStack('uncertain') + getCardsInStack('stale')
 *   getStatus() -> count cards per stack
 *
 * Dependency Map:
 *   knowledge-board.js depends on: DeckClient (injected, separate instance)
 *   Used by: context-loader.js, heartbeat-manager.js, bot.js
 */

/**
 * Manages the "MoltAgent Knowledge" Deck board for tracking uncertain
 * knowledge that needs human verification.
 *
 * Uses a DEDICATED DeckClient instance (separate from the task board)
 * configured with boardName = 'MoltAgent Knowledge' and the four
 * knowledge stacks: verified, uncertain, stale, disputed.
 *
 * @module knowledge/knowledge-board
 */
class KnowledgeBoard {
  /**
   * @param {Object} options
   * @param {import('../integrations/deck-client')} options.deckClient - DeckClient instance
   *   configured with boardName='MoltAgent Knowledge' and stacks for knowledge tracking
   * @param {Object} [options.config={}] - Additional configuration
   * @param {number} [options.config.verificationDueDays=7] - Days until verification card is due
   * @param {number} [options.config.disputeDueDays=3] - Days until dispute card is due
   */
  constructor({ deckClient, config = {} }) {
    this.deck = deckClient;
    this.config = {
      verificationDueDays: config.verificationDueDays || 7,
      disputeDueDays: config.disputeDueDays || 3,
      ...config
    };

    this.initialized = false;
  }

  /**
   * Initialize the board, creating it and all stacks if they do not exist.
   * Uses DeckClient.ensureBoard() which handles creation and caching.
   */
  async initialize() {
    if (this.initialized) return;

    try {
      const result = await this.deck.ensureBoard();
      console.log(`[KnowledgeBoard] Board ready (ID: ${result.boardId})`);
      this.initialized = true;
    } catch (error) {
      console.error('[KnowledgeBoard] Failed to initialize board:', error.message);
      throw error;
    }
  }

  /**
   * Create a verification card for uncertain knowledge.
   * Placed in the 'uncertain' stack. Checks for duplicates first.
   *
   * @param {Object} item
   * @param {string} item.title - What needs verification
   * @param {string} item.description - Details and context
   * @param {string} [item.source='Unknown'] - Where the uncertainty came from
   * @returns {Promise<Object>} Created card object, or existing duplicate
   */
  async createVerificationCard(item) {
    await this.initialize();

    // Check for duplicates in the uncertain stack
    try {
      const existingCards = await this.deck.getCardsInStack('uncertain');
      const cardTitle = `Verify: ${item.title}`;
      const duplicate = existingCards.find(c =>
        c.title === cardTitle || c.title === item.title
      );

      if (duplicate) {
        console.log(`[KnowledgeBoard] Skipping duplicate: ${item.title}`);
        return duplicate;
      }
    } catch (error) {
      // If we cannot check for duplicates, proceed with creation
      console.warn('[KnowledgeBoard] Could not check for duplicates:', error.message);
    }

    const description = this._formatVerificationDescription(item);
    const duedate = this._addDays(new Date(), this.config.verificationDueDays);

    const card = await this.deck.createCard('uncertain', {
      title: `Verify: ${item.title}`,
      description,
      duedate
    });

    console.log(`[KnowledgeBoard] Created verification card: ${card.id}`);
    return card;
  }

  /**
   * Create a card for a detected contradiction.
   * Placed in the 'disputed' stack.
   *
   * @param {Object} item
   * @param {string} item.title - Topic of the contradiction
   * @param {string} item.sourceA - First source name
   * @param {string} item.claimA - First source's claim
   * @param {string} item.sourceB - Second source name
   * @param {string} item.claimB - Second source's claim
   * @returns {Promise<Object>} Created card object
   */
  async createDisputeCard(item) {
    await this.initialize();

    const description = `## Contradiction Detected

**Topic:** ${item.title}

### Conflicting Information

**Source A:** ${item.sourceA}
> ${item.claimA}

**Source B:** ${item.sourceB}
> ${item.claimB}

### Please Resolve

Which information is correct? Move this card to "Verified" after resolution.

---
*Auto-generated by MoltAgent*`;

    const duedate = this._addDays(new Date(), this.config.disputeDueDays);

    const card = await this.deck.createCard('disputed', {
      title: `Dispute: ${item.title}`,
      description,
      duedate
    });

    console.log(`[KnowledgeBoard] Created dispute card: ${card.id}`);
    return card;
  }

  /**
   * Get all cards needing verification (in uncertain + stale stacks).
   * @returns {Promise<Array<Object>>} Cards with status annotation
   */
  async getPendingVerifications() {
    await this.initialize();

    const pending = [];

    for (const stackName of ['uncertain', 'stale']) {
      try {
        const cards = await this.deck.getCardsInStack(stackName);
        pending.push(...cards.map(c => ({ ...c, status: stackName })));
      } catch (error) {
        console.warn(`[KnowledgeBoard] Could not read ${stackName} stack:`, error.message);
      }
    }

    return pending;
  }

  /**
   * Get all verified cards (cards that humans have confirmed).
   * @returns {Promise<Array<Object>>} Verified cards
   */
  async getVerifiedCards() {
    await this.initialize();

    try {
      return await this.deck.getCardsInStack('verified');
    } catch (error) {
      console.warn('[KnowledgeBoard] Could not read verified stack:', error.message);
      return [];
    }
  }

  /**
   * Get board status summary with card counts per stack.
   * @returns {Promise<Object>} Status object with boardId and stack counts
   */
  async getStatus() {
    await this.initialize();

    const status = { stacks: {} };

    for (const stackName of ['verified', 'uncertain', 'stale', 'disputed']) {
      try {
        const cards = await this.deck.getCardsInStack(stackName);
        status.stacks[stackName] = cards.length;
      } catch (error) {
        status.stacks[stackName] = -1; // Error indicator
      }
    }

    return status;
  }

  /**
   * Format the description for a verification card.
   * @private
   * @param {Object} item
   * @returns {string} Markdown description
   */
  _formatVerificationDescription(item) {
    return `## Verification Needed

**Item:** ${item.title}
**Source:** ${item.source || 'Unknown'}
**Logged:** ${new Date().toISOString().split('T')[0]}

### Current Understanding

${item.description}

### Please Confirm

1. Is this information accurate?
2. If not, what's the correct information?
3. Add a comment with corrections, then move to "Verified".

---
*This card was auto-generated by MoltAgent.*`;
  }

  /**
   * Add days to a date and return ISO date string (YYYY-MM-DD).
   * @private
   * @param {Date} date
   * @param {number} days
   * @returns {string} ISO date string
   */
  _addDays(date, days) {
    const result = new Date(date);
    result.setDate(result.getDate() + days);
    return result.toISOString().split('T')[0];
  }
}

module.exports = { KnowledgeBoard };
