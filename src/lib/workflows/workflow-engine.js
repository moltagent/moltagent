'use strict';

const GateDetector = require('./gate-detector');
const { ScheduleHandler, parseScheduleBlock, findConfigCard, stripHtml } = require('./schedule-handler');
const { isStructuralCard } = require('../integrations/deck-card-classifier');

/**
 * WorkflowEngine
 *
 * The glue between Deck boards and the AgentLoop. On each heartbeat pulse:
 *
 * 1. Find all workflow boards (description starts with "WORKFLOW:")
 * 2. For each board, identify actionable events:
 *    - New/unprocessed cards in entry stacks
 *    - GATE cards with human responses
 *    - Cards past their due dates
 * 3. Build context (board rules + card + state) and feed to AgentLoop
 * 4. The LLM reads the rules and decides what to do
 *
 * The LLM IS the workflow engine. This class is just the dispatcher.
 *
 * @module workflows/workflow-engine
 */
class WorkflowEngine {
  /**
   * @param {Object} options
   * @param {import('./workflow-board-detector')} options.workflowDetector
   * @param {import('../integrations/deck-client')} options.deckClient
   * @param {import('../agent/agent-loop').AgentLoop} options.agentLoop
   * @param {import('../talk/talk-send-queue').TalkSendQueue} options.talkSendQueue
   * @param {string} options.talkToken - Primary Talk room token for notifications
   * @param {Object} [options.config]
   */
  constructor({ workflowDetector, deckClient, agentLoop, talkSendQueue, talkToken, config, budgetEnforcer }) {
    this.detector = workflowDetector;
    this.deck = deckClient;
    this.agent = agentLoop;
    this.talkQueue = talkSendQueue;
    this.talkToken = talkToken || null;
    this.config = config || {};
    this.budgetEnforcer = budgetEnforcer || null;
    this.botUsername = this.config.botUsername || 'moltagent';

    // Track which cards we've already processed this session
    // Key: `${boardId}:${cardId}:${stackId}` -> last processed timestamp
    this._processedCards = new Map();

    // Track GATE notifications to avoid re-notifying
    this._notifiedGates = new Set();

    // Schedule handler for timed actions in WORKFLOW: card descriptions
    this._scheduleHandler = new ScheduleHandler({
      agentLoop,
      budgetEnforcer: this.budgetEnforcer
    });
  }

  /**
   * Main entry point. Called from HeartbeatManager.pulse().
   * @returns {Promise<Object>} Processing results
   */
  async processAll() {
    const results = {
      boardsProcessed: 0,
      cardsProcessed: 0,
      gatesFound: 0,
      gatesResolved: 0,
      escalations: 0,
      schedulesExecuted: 0,
      errors: []
    };

    try {
      const workflowBoards = await this.detector.getWorkflowBoards();

      for (const wb of workflowBoards) {
        try {
          const boardResult = await this._processBoard(wb);
          results.boardsProcessed++;
          results.cardsProcessed += boardResult.cardsProcessed;
          results.gatesFound += boardResult.gatesFound;
          results.gatesResolved += boardResult.gatesResolved;
          results.escalations += boardResult.escalations;
          results.schedulesExecuted += boardResult.schedulesExecuted || 0;
        } catch (err) {
          console.error(`[Workflow] Error processing board "${wb.board.title}":`, err.message);
          results.errors.push({ board: wb.board.title, error: err.message });
        }
      }
    } catch (err) {
      console.error('[Workflow] Failed to detect workflow boards:', err.message);
      results.errors.push({ board: 'detection', error: err.message });
    }

    if (results.boardsProcessed > 0) {
      console.log(`[Workflow] Processed ${results.boardsProcessed} board(s), ` +
        `${results.cardsProcessed} card(s), ${results.gatesResolved} gate(s) resolved`);
    }

    return results;
  }

  /**
   * Process a single workflow board.
   * @private
   */
  async _processBoard(wb) {
    const { board, stacks } = wb;
    // Strip HTML once per board — all downstream methods use this
    wb._plainDescription = wb._plainDescription || stripHtml(wb.description);
    const result = { cardsProcessed: 0, gatesFound: 0, gatesResolved: 0, escalations: 0, schedulesExecuted: 0 };

    for (const stack of stacks) {
      for (const card of (stack.cards || [])) {
        try {
          // Skip archived/deleted cards
          if (card.archived || card.deletedAt) continue;

          // Skip the rules card itself
          if (wb.rulesCardId && card.id === wb.rulesCardId) continue;

          // Structural cards: clean stale due dates / assignees, then skip
          if (isStructuralCard(card)) {
            await this._cleanStructuralCard(wb, stack, card);
            continue;
          }

          // Card hygiene: ensure due date and assignment
          await this._ensureDueDate(wb, stack, card);
          await this._ensureAssignment(wb, stack, card);

          // Is this a GATE card?
          if (GateDetector.isGate(card)) {
            result.gatesFound++;
            const gateResolved = await this._handleGate(wb, stack, card);
            if (gateResolved) result.gatesResolved++;
            continue;
          }

          // Should we process this card?
          if (this._shouldProcess(board.id, card, stack)) {
            await this._processCard(wb, stack, card);
            result.cardsProcessed++;
            this._markProcessed(board.id, card, stack);
          }

          // Check for due date escalation
          if (card.duedate && this._isPastDue(card.duedate)) {
            const escalated = await this._handleEscalation(wb, stack, card);
            if (escalated) result.escalations++;
          }
        } catch (err) {
          console.warn(`[Workflow] Error on card "${card.title}" in "${board.title}":`, err.message);
        }
      }
    }

    // Process SCHEDULE block from board rules (timed actions)
    try {
      // Respect board-level MODEL directive for schedule actions
      const boardForceLocal = this._getBoardForceLocal(wb);
      const schedResult = await this._scheduleHandler.processSchedules(wb, { forceLocal: boardForceLocal });
      result.schedulesExecuted = schedResult.executed;
      if (schedResult.executed > 0) {
        console.log(`[Workflow] Schedules on "${board.title}": ${schedResult.executed} executed, ${schedResult.skipped} skipped`);
      }
    } catch (err) {
      console.warn(`[Workflow] Schedule processing failed on "${board.title}":`, err.message);
    }

    // Lifecycle: archive stale Done cards
    await this._archiveStaleDoneCards(wb);

    return result;
  }

  /**
   * Extract LLM routing directive from a CONFIG: card's description.
   * Looks for a line starting with "LLM:" followed by "cloud[-fast]" or "local".
   * @private
   * @param {Object|null} configCard - CONFIG card object with .description
   * @returns {{ allowCloud: boolean, cloudTier: string|null }}
   */
  _extractStackLlmRouting(configCard) {
    if (!configCard?.description) return { allowCloud: false, cloudTier: null };
    const plain = stripHtml(configCard.description);
    const match = plain.match(/^LLM:\s*(cloud-fast|cloud|local)\b/im);
    if (!match) return { allowCloud: false, cloudTier: null };
    const directive = match[1].toLowerCase();
    return {
      allowCloud: directive.startsWith('cloud'),
      cloudTier: directive === 'cloud-fast' ? 'fast' : null
    };
  }

  /**
   * Process a single non-GATE card through the AgentLoop.
   * @private
   */
  async _processCard(wb, stack, card) {
    const { board, description, stacks } = wb;
    let { forceLocal } = this._getRoleForCard(wb, card);

    // Budget check before cloud processing
    if (!forceLocal && this.budgetEnforcer) {
      const check = this.budgetEnforcer.canSpend('cloud', 0.02);
      if (!check.allowed) {
        console.log(`[Workflow] Budget exceeded: ${check.reason} — forcing local for "${card.title}"`);
        forceLocal = true;
      }
    }

    // Iteration cap: procedures get more steps (multi-phase), pipelines less
    const maxIterations = wb.workflowType === 'procedure' ? 5 : 3;

    console.log(`[Workflow] Processing card "${card.title}" in "${board.title}" / "${stack.title}" (maxIter=${maxIterations})`);

    // Read CONFIG: card from the current stack (if present)
    const configCard = findConfigCard(stack);
    const { allowCloud, cloudTier } = this._extractStackLlmRouting(configCard);
    const configContext = configCard
      ? `\n**Stack Config (from "${configCard.title}"):**\n${stripHtml(configCard.description) || '(empty)'}\n`
      : '';

    const systemAddition = [
      '## Active Workflow Context',
      '',
      'You are processing a card in a workflow board. Follow the rules exactly.',
      '',
      `**Board:** ${board.title} (ID: ${board.id})`,
      `**Board Rules:**`,
      wb._plainDescription,
      '',
      `**Current Stack:** ${stack.title} (ID: ${stack.id})`,
      configContext,
      `**Card:** ${card.title} (ID: ${card.id})`,
      card.description ? `**Card Description:** ${stripHtml(card.description)}` : '',
      '',
      `**Card Labels:** ${(card.labels || []).map(l => `${l.color}: ${l.title}`).join(', ') || 'none'}`,
      `**Card Due:** ${card.duedate || 'none'}`,
      `**Assigned To:** ${(card.assignedUsers || []).map(u => u.participant?.uid).join(', ') || 'unassigned'}`,
      '',
      `**All Stacks (left to right):**`,
      stacks.map(s => `  - "${s.title}" (ID: ${s.id}, ${(s.cards || []).length} cards)`).join('\n'),
      '',
      '**Instructions:**',
      'Read the board rules above. Based on the card\'s current stack and the',
      'transition rules, determine and execute the appropriate actions.',
      'Use workflow_deck_* tools with numeric IDs to move cards, add comments,',
      'create cards in other boards, etc.',
      'Comment on the card with what you did.',
      'If the rules say to notify in Talk, use the talk_send tool.',
      'If you need to create files, use file tools.',
      'If the rules reference wiki pages with [[Page Name]], search and read them.'
    ].filter(Boolean).join('\n');

    await this.agent.processWorkflowTask({
      systemAddition,
      task: `Process workflow card: "${card.title}" according to the board rules.`,
      boardId: board.id,
      cardId: card.id,
      stackId: stack.id,
      forceLocal,
      allowCloud,
      cloudTier,
      maxIterations
    });
  }

  /**
   * Handle a GATE card — check for human resolution, notify if needed.
   * @returns {boolean} Whether the gate was resolved
   * @private
   */
  async _handleGate(wb, stack, card) {
    const { board } = wb;

    // Check if human has responded
    const resolution = await GateDetector.checkGateResolution(
      this.deck, card.id, this.botUsername
    );

    if (resolution.resolved) {
      console.log(`[Workflow] GATE resolved: "${card.title}" -> ${resolution.decision}`);

      let { forceLocal } = this._getRoleForCard(wb, card);
      const configCard = findConfigCard(stack);
      const { allowCloud, cloudTier } = this._extractStackLlmRouting(configCard);

      // Budget check before cloud processing
      if (!forceLocal && this.budgetEnforcer) {
        const check = this.budgetEnforcer.canSpend('cloud', 0.02);
        if (!check.allowed) {
          console.log(`[Workflow] Budget exceeded: ${check.reason} — forcing local for GATE "${card.title}"`);
          forceLocal = true;
        }
      }

      const context = [
        '## GATE Resolution',
        '',
        `The human has ${resolution.decision} the GATE card.`,
        `Board: ${board.title} (ID: ${board.id})`,
        `Card: ${card.title} (ID: ${card.id})`,
        `Stack: ${stack.title} (ID: ${stack.id})`,
        `Decision: ${resolution.decision}`,
        `Human comment: "${resolution.comment?.message || ''}"`,
        '',
        `**All Stacks:**`,
        wb.stacks.map(s => `  - "${s.title}" (ID: ${s.id})`).join('\n'),
        '',
        'Board Rules:',
        wb._plainDescription,
        '',
        `Follow the board rules for what happens after ${resolution.decision}.`,
        'This may involve moving the card, creating new cards, sending notifications, etc.',
        'Use workflow_deck_* tools with numeric IDs.'
      ].join('\n');

      await this.agent.processWorkflowTask({
        systemAddition: context,
        task: `GATE "${card.title}" was ${resolution.decision}. Follow the workflow rules for this outcome.`,
        boardId: board.id,
        cardId: card.id,
        stackId: stack.id,
        forceLocal,
        allowCloud,
        cloudTier
      });

      return true;
    }

    // Not resolved — notify human if we haven't yet
    const gateKey = `${board.id}:${card.id}`;
    if (!this._notifiedGates.has(gateKey)) {
      const needsNotify = await GateDetector.needsNotification(
        this.deck, card.id, this.botUsername
      );

      if (needsNotify) {
        // Comment on the card
        await this.deck.addComment(card.id,
          '\u23F8\uFE0F GATE \u2014 This card requires human review. ' +
          'Please comment with \u2705 to approve or \u274C to reject.',
          'STATUS', { prefix: false }
        );

        // Notify in Talk
        if (this.talkQueue && this.talkToken) {
          await this.talkQueue.enqueue(this.talkToken,
            `\u23F8\uFE0F Workflow "${wb.board.title}" is waiting for your review.\n` +
            `Card: **${card.title}**\n` +
            'Please add a comment (\u2705 or \u274C) on the card to continue.'
          );
        }

        this._notifiedGates.add(gateKey);
        console.log(`[Workflow] GATE notification sent for "${card.title}"`);
      }
    }

    return false;
  }

  /**
   * Handle due date escalation.
   * @private
   */
  /**
   * @returns {boolean} Whether an escalation notification was actually sent
   * @private
   */
  async _handleEscalation(wb, stack, card) {
    const gateKey = `escalation:${wb.board.id}:${card.id}`;
    if (this._notifiedGates.has(gateKey)) return false;

    const hoursOverdue = this._hoursOverdue(card.duedate);
    if (hoursOverdue < 1) return false;

    console.log(`[Workflow] Escalation: "${card.title}" is ${Math.round(hoursOverdue)}h overdue`);

    if (this.talkQueue && this.talkToken) {
      await this.talkQueue.enqueue(this.talkToken,
        `\u26A0\uFE0F Overdue card in "${wb.board.title}":\n` +
        `**${card.title}** \u2014 ${Math.round(hoursOverdue)} hours past due.\n` +
        `Stack: ${stack.title}`
      );
    }

    this._notifiedGates.add(gateKey);
    return true;
  }

  /**
   * Determine if a card should be processed.
   * Avoids re-processing cards that haven't changed.
   * @param {number} boardId
   * @param {Object} card
   * @param {Object} stack
   * @returns {boolean}
   */
  _shouldProcess(boardId, card, stack) {
    const key = `${boardId}:${card.id}:${stack.id}`;
    const lastProcessed = this._processedCards.get(key);

    if (!lastProcessed) return true;

    const cardModified = new Date(card.lastModified || 0).getTime();
    return cardModified > lastProcessed;
  }

  /** @private */
  _markProcessed(boardId, card, stack) {
    const key = `${boardId}:${card.id}:${stack.id}`;
    this._processedCards.set(key, Date.now());
  }

  /** @private */
  _isPastDue(duedate) {
    return new Date(duedate) < new Date();
  }

  /** @private */
  _hoursOverdue(duedate) {
    return (Date.now() - new Date(duedate).getTime()) / (1000 * 60 * 60);
  }

  /**
   * Parse MODEL directive from board and card descriptions.
   * Cards can only ADD restrictions (forceLocal), never remove them.
   * @private
   * @returns {{role: string, forceLocal: boolean}}
   */
  /**
   * Extract board-level forceLocal from MODEL directive.
   * Used for schedule actions (no card context).
   * @private
   */
  _getBoardForceLocal(wb) {
    const boardDesc = wb._plainDescription || stripHtml(wb.description || '');
    const boardModel = boardDesc.match(/^MODEL:\s*(sovereign|local|auto)\b/im);
    if (!boardModel) return false;
    const directive = this._resolveDirective(boardModel[1]);
    return directive?.forceLocal || false;
  }

  _getRoleForCard(wb, card) {
    // Board-level directive
    const boardDesc = wb._plainDescription || stripHtml(wb.description || '');
    const boardModel = boardDesc.match(/^MODEL:\s*(sovereign|local|auto)\b/im);
    const boardDirective = boardModel ? this._resolveDirective(boardModel[1]) : null;

    // Card-level directive
    const cardDesc = stripHtml(card.description || '');
    const cardModel = cardDesc.match(/\bMODEL:\s*(sovereign|local|auto)\b/i);
    const cardDirective = cardModel ? this._resolveDirective(cardModel[1]) : null;

    // Role: card overrides board if present
    const role = (cardDirective?.role) || (boardDirective?.role) || 'workflow_cloud';

    // ForceLocal: OR — cards can only add restrictions, never remove them
    const forceLocal = (boardDirective?.forceLocal || false) || (cardDirective?.forceLocal || false);

    return { role, forceLocal };
  }

  /**
   * Resolve a MODEL directive to provider config.
   * @private
   */
  _resolveDirective(directive) {
    switch (directive.toLowerCase()) {
      case 'sovereign':
        return { role: 'agent_loop', forceLocal: true };
      case 'local':
        return { role: 'workflow_cloud', forceLocal: true };
      case 'auto':
      default:
        return { role: 'workflow_cloud', forceLocal: false };
    }
  }

  // ===========================================================================
  // Card Hygiene
  // ===========================================================================

  /**
   * Ensure a card has a due date. Assigns a default based on stack type.
   * @private
   */
  async _ensureDueDate(wb, stack, card) {
    if (card.duedate) return; // Already has one

    let daysFromNow;
    const isGate = GateDetector.isGate(card);
    const isDone = this._isDoneStack(wb, stack);

    if (isDone) {
      daysFromNow = 0; // Due now (marks as "done today" in NC)
    } else if (isGate) {
      daysFromNow = 2; // 48h SLA for human review
    } else {
      // Check board rules for SLA override: "SLA: 3 days" or "SLA: 24h"
      const slaMatch = (wb._plainDescription || stripHtml(wb.description)).match(/\bSLA:\s*(\d+)\s*(days?|hours?|h|d)\b/i);
      if (slaMatch) {
        const val = parseInt(slaMatch[1], 10);
        const unit = slaMatch[2].toLowerCase();
        daysFromNow = (unit.startsWith('h')) ? val / 24 : val;
      } else {
        daysFromNow = 7; // Default: 7 days
      }
    }

    const due = new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000).toISOString();
    try {
      await this._updateCardDueDate(wb.board.id, stack.id, card.id, due);
    } catch (err) {
      console.warn(`[Workflow] Could not set due date on card ${card.id}: ${err.message}`);
    }
  }

  /**
   * Check if a stack is a "Done" stack by its title.
   * @private
   */
  _isDoneStack(wb, stack) {
    const title = (stack.title || '').toLowerCase();
    return title.includes('done') || title.includes('live') ||
           title.includes('won') || title.includes('resolved') ||
           title.includes('track');
  }

  /**
   * Update a card's due date via the Deck API.
   * @private
   */
  async _updateCardDueDate(boardId, stackId, cardId, duedate) {
    const path = `/index.php/apps/deck/api/v1.0/boards/${boardId}/stacks/${stackId}/cards/${cardId}`;
    const current = await this.deck._request('GET', path);
    const cardData = current.body || current;

    await this.deck._request('PUT', path, {
      title: cardData.title,
      type: cardData.type || 'plain',
      owner: cardData.owner?.uid || cardData.owner || '',
      description: cardData.description || '',
      duedate
    });
  }

  /**
   * Ensure a card is assigned to someone. Bot for active, human for GATE.
   * @private
   */
  async _ensureAssignment(wb, stack, card) {
    // Skip if already assigned
    if (card.assignedUsers && card.assignedUsers.length > 0) return;

    const isGate = GateDetector.isGate(card);
    const isDone = this._isDoneStack(wb, stack);
    if (isDone) return; // Don't assign Done cards

    // Use canonical username from DeckClient (resolved by NCRequestManager)
    const userId = isGate ? this._getHumanUser() : (this.deck.username || this.botUsername);

    try {
      const path = `/index.php/apps/deck/api/v1.0/boards/${wb.board.id}/stacks/${stack.id}/cards/${card.id}/assignUser`;
      await this.deck._request('PUT', path, { userId });
    } catch (err) {
      // Ignore errors (user not board member, already assigned, etc.)
      if (!err.message?.includes('already assigned')) {
        console.warn(`[Workflow] Could not assign ${userId} to card ${card.id}: ${err.message}`);
      }
    }
  }

  /**
   * Remove stale due dates and assignees from structural/config cards.
   * Self-healing: runs every heartbeat so legacy metadata is cleaned automatically.
   * @private
   */
  async _cleanStructuralCard(wb, stack, card) {
    const hasDueDate = !!card.duedate;
    const hasAssignees = card.assignedUsers && card.assignedUsers.length > 0;
    if (!hasDueDate && !hasAssignees) return;

    const label = card.title?.slice(0, 40);
    try {
      if (hasDueDate) {
        await this._updateCardDueDate(wb.board.id, stack.id, card.id, null);
        console.log(`[Workflow] Cleaned due date from structural card "${label}"`);
      }
      if (hasAssignees) {
        for (const au of card.assignedUsers) {
          const uid = au.participant?.uid || au.uid;
          if (!uid) continue;
          const path = `/index.php/apps/deck/api/v1.0/boards/${wb.board.id}/stacks/${stack.id}/cards/${card.id}/unassignUser`;
          await this.deck._request('PUT', path, { userId: uid });
          console.log(`[Workflow] Unassigned ${uid} from structural card "${label}"`);
        }
      }
    } catch (err) {
      console.warn(`[Workflow] Could not clean structural card "${label}": ${err.message}`);
    }
  }

  /**
   * Get the human user for GATE assignments.
   * @private
   */
  _getHumanUser() {
    return this.config.adminUser || 'admin';
  }

  /**
   * Archive cards in Done stacks that haven't been modified in N days.
   * @private
   */
  async _archiveStaleDoneCards(wb) {
    const archiveAfterDays = this.config.archiveAfterDays || 30;
    const cutoff = Date.now() - archiveAfterDays * 24 * 60 * 60 * 1000;

    for (const stack of wb.stacks) {
      if (!this._isDoneStack(wb, stack)) continue;

      for (const card of (stack.cards || [])) {
        if (card.archived || card.deletedAt) continue;
        // Never archive the WORKFLOW rules card
        if (wb.rulesCardId && card.id === wb.rulesCardId) continue;

        const lastMod = new Date(card.lastModified || 0).getTime();
        if (lastMod < cutoff) {
          try {
            const path = `/index.php/apps/deck/api/v1.0/boards/${wb.board.id}/stacks/${stack.id}/cards/${card.id}`;
            const current = await this.deck._request('GET', path);
            const cardData = current.body || current;

            await this.deck._request('PUT', path, {
              title: cardData.title,
              type: cardData.type || 'plain',
              owner: cardData.owner?.uid || cardData.owner || '',
              description: cardData.description || '',
              duedate: cardData.duedate || null,
              archived: true
            });
            console.log(`[Workflow] Archived stale card: "${card.title}" (${archiveAfterDays}+ days in Done)`);
          } catch (err) {
            console.warn(`[Workflow] Could not archive card ${card.id}: ${err.message}`);
          }
        }
      }
    }
  }

  /**
   * Reset session state. Call on service restart or daily reset.
   */
  resetState() {
    this._processedCards.clear();
    this._notifiedGates.clear();
    this._scheduleHandler.resetState();
    this.detector.invalidateCache();
  }
}

module.exports = WorkflowEngine;
