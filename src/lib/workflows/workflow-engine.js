'use strict';

const fs   = require('fs');
const path = require('path');
const GateDetector = require('./gate-detector');
const { ScheduleHandler, parseScheduleBlock, findConfigCard, stripHtml } = require('./schedule-handler');
const { isStructuralCard, hasLabel } = require('../integrations/deck-card-classifier');

const DEFAULT_DATA_DIR = path.resolve(process.cwd(), 'data');

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

    // Resolve data directory. Disk persistence is only enabled when config.dataDir
    // is explicitly provided (or config.dataDir === true to use the default).
    // Unit tests that do not pass config.dataDir get an in-memory-only store.
    let dataDir;
    if (this.config.dataDir === true) {
      dataDir = DEFAULT_DATA_DIR;
    } else if (this.config.dataDir) {
      dataDir = this.config.dataDir;
    } else {
      dataDir = null; // no disk persistence
    }
    this._dataDir = dataDir;
    this._processedFile = this._dataDir
      ? path.join(this._dataDir, 'workflow-processed-cards.json')
      : null;

    // Track which cards we've already processed.
    // Key: `${boardId}:${cardId}:${stackId}` -> last processed timestamp (seconds)
    // Persisted to disk so restarts don't trigger re-evaluation of every card.
    this._processedCards = this._loadProcessedCards();

    // Track error state for cards that have failed processing.
    // Key: `${boardId}:${cardId}`
    // Value: { retryCount: number, lastError: string, lastAttempt: number, permanent: boolean }
    // Loaded from and persisted to the same JSON file as _processedCards (under '_errors' key).
    this._errorState = this._loadErrorState();

    // Track GATE notifications to avoid re-notifying.
    // Persisted to disk so service restarts don't re-notify.
    this._notifiedGatesFile = this._dataDir
      ? path.join(this._dataDir, 'workflow-notified-gates.json')
      : null;
    this._notifiedGates = this._loadNotifiedGates();

    // Reentrancy guard — prevents concurrent processAll() when a pulse
    // outlasts the heartbeat interval.
    this._processing = false;

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

    // Reentrancy guard: if a previous pulse is still running, skip this one.
    if (this._processing) {
      console.log('[Workflow] Previous processAll() still running — skipping this pulse');
      return results;
    }
    this._processing = true;

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
    } finally {
      this._processing = false;
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

    // Board-level PAUSED check: find the WORKFLOW rules card; if it has the
    // PAUSED label, skip the entire board for this pulse.
    const rulesCard = stacks.flatMap(s => s.cards || []).find(c => wb.rulesCardId && c.id === wb.rulesCardId);
    if (rulesCard && hasLabel(rulesCard, 'PAUSED')) {
      console.log(`[Workflow] Board "${board.title}" is PAUSED — skipping`);
      return result;
    }

    for (const stack of stacks) {
      // Stack-level PAUSED check: if the CONFIG card in this stack has the
      // PAUSED label, skip all cards in this stack.
      const stackConfigCard = findConfigCard(stack);
      if (stackConfigCard && hasLabel(stackConfigCard, 'PAUSED')) {
        console.log(`[Workflow] Stack "${stack.title}" in "${board.title}" is PAUSED — skipping stack`);
        continue;
      }

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

          // Card-level PAUSED check: skip individual paused work items
          if (hasLabel(card, 'PAUSED')) {
            console.log(`[Workflow] Card "${card.title}" is PAUSED — skipping`);
            continue;
          }

          // SCHEDULED check: if card has SCHEDULED label, handle activation or skip
          if (hasLabel(card, 'SCHEDULED')) {
            const activated = await this._handleScheduledCard(wb, stack, card);
            if (!activated) continue;
            // Activated: fall through to normal processing this pulse
          }

          // ERROR check: handle retry backoff and permanent failures
          {
            const errorState = this._getErrorState(board.id, card.id);
            if (errorState && !hasLabel(card, 'ERROR')) {
              // Human removed the ERROR label — clear state and fall through to processing
              this._clearErrorState(board.id, card.id);
            } else if (hasLabel(card, 'ERROR')) {
              if (!errorState) {
                // No error state but ERROR label present — human may have re-added it
                // manually; treat as fresh start: clear any stale state and fall through
                this._clearErrorState(board.id, card.id);
              } else if (errorState.permanent) {
                // Permanent failure — do not retry
                continue;
              } else if (!this._isRetryReady(board.id, card.id)) {
                // Back-off period not yet elapsed — skip this pulse
                continue;
              }
              // Retry-ready: fall through to normal processing
            }
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

          // If this card is in a GATE stack (CONFIG card mentions GATE) and has
          // no workflow label yet, stamp it with the GATE label so the engine
          // tracks it correctly on the next pulse.
          if (GateDetector.isGateStack(stack.cards || [])) {
            await this._ensureGateLabel(wb, stack, card);
            // Re-check — the label may have just been added (local object is stale,
            // but re-reading on next pulse is sufficient; don't block this pulse).
          }

          // Should we process this card?
          let cardWasTouched = false;
          if (this._shouldProcess(board.id, card, stack)) {
            try {
              await this._processCard(wb, stack, card);
              result.cardsProcessed++;
              cardWasTouched = true;
              // Successful processing — clear error state and remove ERROR label
              if (this._getErrorState(board.id, card.id) || hasLabel(card, 'ERROR')) {
                this._clearErrorState(board.id, card.id);
                await this._removeLabelFromCard(board.id, stack.id, card.id, 'ERROR');
              }
            } catch (processingErr) {
              cardWasTouched = true;
              await this._handleProcessingError(wb, stack, card, processingErr);
            }
          }

          // Check for due date escalation (suppressed for PAUSED and SCHEDULED cards)
          if (card.duedate && this._isPastDue(card.duedate)) {
            const escalated = await this._handleEscalation(wb, stack, card);
            if (escalated) {
              result.escalations++;
              cardWasTouched = true;
            }
          }

          // Stamp the SOURCE stack ONLY when the card was actually touched.
          // Uses the server's lastModified so both sides of the comparison
          // use the same clock. Only stamps this stack — if processing moved
          // the card to another stack, the destination is not pre-stamped.
          if (cardWasTouched) {
            this._markProcessed(board.id, card, stack);
          }
        } catch (err) {
          console.warn(`[Workflow] Error on card "${card.title}" in "${board.title}":`, err.message);
        }
      }
    }

    // Process SCHEDULE block from board rules (timed actions)
    try {
      // Filter out PAUSED stacks so schedules cannot target them.
      // The schedule handler builds LLM context from wb.stacks — if a stack
      // is absent, the LLM cannot see it, reference it, or create cards in it.
      const pausedStackNames = [];
      const activeStacks = stacks.filter(stack => {
        const cfg = findConfigCard(stack);
        if (cfg && hasLabel(cfg, 'PAUSED')) {
          console.log(`[Workflow] Stack "${stack.title}" skipped for schedules — CONFIG card has PAUSED label`);
          pausedStackNames.push(stack.title);
          return false;
        }
        return true;
      });
      const schedWb = activeStacks.length < stacks.length
        ? { ...wb, stacks: activeStacks, _pausedStacks: pausedStackNames }
        : wb;
      // Respect board-level MODEL directive for schedule actions
      const boardForceLocal = this._getBoardForceLocal(wb);
      const schedResult = await this._scheduleHandler.processSchedules(schedWb, { forceLocal: boardForceLocal });
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
      ? [
          '',
          '═══════════════════════════════════════════',
          'MANDATORY OPERATING INSTRUCTIONS FOR THIS STACK',
          'These rules are set by the board operator. You MUST follow',
          'them exactly. Violating these instructions is a system error.',
          '═══════════════════════════════════════════',
          '',
          stripHtml(configCard.description) || '(empty)',
          '',
          '═══════════════════════════════════════════',
          'END OF MANDATORY INSTRUCTIONS',
          '═══════════════════════════════════════════',
          '',
        ].join('\n')
      : '';

    // Fetch card comments for context — the LLM needs to see what humans said
    // and what work was already done. Filter out pure status noise.
    let commentBlock = '';
    try {
      const comments = await this.deck.getComments(card.id);
      if (comments && comments.length > 0) {
        const NOISE_PREFIXES = ['[STATUS]', '[GATE]', '[RETRY]'];
        const relevant = comments
          .filter(c => {
            const msg = (c.message || '').trimStart();
            return !NOISE_PREFIXES.some(p => msg.startsWith(p));
          })
          .sort((a, b) => (a.id || 0) - (b.id || 0))
          .slice(-10); // last 10 relevant comments — cap context size
        if (relevant.length > 0) {
          commentBlock = '\n**Comment History:**\n' + relevant.map(c => {
            const author = c.actorDisplayName || c.actorId || 'unknown';
            const time = c.creationDateTime || '';
            const msg = stripHtml(c.message || '');
            return `  [${author}${time ? ' · ' + time : ''}]: ${msg}`;
          }).join('\n') + '\n';
        }
      }
    } catch (err) {
      // Non-fatal — process card without comment context
      console.warn(`[Workflow] Could not fetch comments for card ${card.id}: ${err.message}`);
    }

    // Strip schedule definitions and evaluation criteria from board rules.
    // Per-card processing should only see the workflow type, system card rules,
    // and the CONFIG instructions for the current stack. Schedule blocks and
    // PICK/SKIP logic are for the schedule handler — including them causes the
    // LLM to follow schedule instructions (e.g. "Create card in Ideas") while
    // processing unrelated Drafting cards.
    const boardRules = this._stripScheduleContext(wb._plainDescription);

    const systemAddition = [
      '## Active Workflow Context',
      '',
      'You are processing a card in a workflow board. Follow the CONFIG instructions for this stack exactly.',
      '',
      `**Board:** ${board.title} (ID: ${board.id})`,
      `**Board Rules:**`,
      boardRules,
      '',
      `**Current Stack:** ${stack.title} (ID: ${stack.id})`,
      configContext,
      `**Card:** ${card.title} (ID: ${card.id})`,
      card.description ? `**Card Description:** ${stripHtml(card.description)}` : '',
      commentBlock,
      `**Card Labels:** ${(card.labels || []).map(l => `${l.color}: ${l.title}`).join(', ') || 'none'}`,
      `**Card Due:** ${card.duedate || 'none'}`,
      `**Assigned To:** ${(card.assignedUsers || []).map(u => u.participant?.uid).join(', ') || 'unassigned'}`,
      '',
      `**All Stacks (left to right):**`,
      stacks.map(s => `  - "${s.title}" (ID: ${s.id}, ${(s.cards || []).length} cards)`).join('\n'),
      '',
      '**Instructions:**',
      'Follow the CONFIG instructions for this stack. The CONFIG card defines',
      'exactly what to do with cards in this stack.',
      'Use workflow_deck_update_card to write or rewrite the card description.',
      'Use workflow_deck_* tools with numeric IDs to move cards, add comments, etc.',
      'Comment on the card with what you did.',
      'If the CONFIG says to notify in Talk, use the talk_send tool.',
      'If you need to create files, use file tools.',
      'If the CONFIG references wiki pages with [[Page Name]], search and read them.'
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

    // Label-based resolution check — synchronous, no comment scanning
    const resolution = GateDetector.checkGateResolution(card);

    if (resolution.resolved && resolution.decision) {
      // Human has applied APPROVED or REJECTED label
      console.log(`[Workflow] GATE resolved: "${card.title}" -> ${resolution.decision}`);

      // Clear notification dedup so card can be re-gated later if needed
      const gateKey = `${board.id}:${card.id}`;
      this._notifiedGates.delete(gateKey);
      this._saveNotifiedGates();

      // Handoff back: unassign human, assign bot for automated processing
      const botUser = this.deck.username || this.botUsername;
      const humanUser = wb.board.owner?.uid || wb.board.owner || this._getHumanUser();
      await this._safeUnassign(board.id, stack.id, card.id, humanUser);
      await this._safeAssign(board.id, stack.id, card.id, botUser);
      console.log(`[Workflow] GATE resolution handoff: "${card.title}" → ${botUser}`);

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

    // Not resolved (has GATE label, no APPROVED/REJECTED) — notify human once
    const gateKey = `${board.id}:${card.id}`;
    if (!this._notifiedGates.has(gateKey)) {
      // Label presence IS the notification state — no comment scan needed.
      // Notify in Talk once per process lifecycle (in-memory dedup via _notifiedGates).
      if (this.talkQueue && this.talkToken) {
        await this.talkQueue.enqueue(this.talkToken,
          `\u23F8\uFE0F Workflow "${wb.board.title}" is waiting for your review.\n` +
          `Card: **${card.title}**\n` +
          'Apply the \u2705 APPROVED or \u274C REJECTED label on the card to continue.'
        );
      }

      // Also comment on the card so the GATE state is visible in the Deck UI.
      // This is informational only — state is tracked by label, not comment content.
      if (this.deck.addComment) {
        try {
          await this.deck.addComment(card.id,
            `\u23F8\uFE0F **GATE**: Waiting for human review.\n` +
            'Apply the APPROVED or REJECTED label to continue the workflow.'
          );
        } catch (_err) {
          // Non-fatal — Talk notification is the primary channel
        }
      }

      this._notifiedGates.add(gateKey);
      this._saveNotifiedGates();
      console.log(`[Workflow] GATE notification sent for "${card.title}"`);
    }

    return false;
  }

  /**
   * Stamp a card with the GATE label when it is in a GATE stack but does not
   * yet carry any workflow label (GATE/APPROVED/REJECTED).
   * Idempotent — skips if the card already has any workflow label.
   * @private
   */
  async _ensureGateLabel(wb, stack, card) {
    const hasWorkflowLabel =
      hasLabel(card, 'GATE') ||
      hasLabel(card, 'APPROVED') ||
      hasLabel(card, 'REJECTED');

    if (hasWorkflowLabel) return;

    // Dedup: if we already stamped this gate (label may be invisible due to
    // stale cache), skip. Uses the same _notifiedGates set that _handleGate
    // checks before sending notifications.
    const gateKey = `${wb.board.id}:${card.id}`;
    if (this._notifiedGates.has(gateKey)) return;

    // Find the GATE label ID on this board so we can assign it
    try {
      const fullBoard = await this.deck.getBoard(wb.board.id);
      const gateLabel = (fullBoard.labels || []).find(
        l => (l.title || '').toUpperCase() === 'GATE'
      );
      if (!gateLabel) {
        console.warn(`[Workflow] GATE label not found on board "${wb.board.title}" — run ensureWorkflowLabels first`);
        return;
      }

      const labelPath = `/index.php/apps/deck/api/v1.0/boards/${wb.board.id}/stacks/${stack.id}/cards/${card.id}/assignLabel`;
      await this.deck._request('PUT', labelPath, { labelId: gateLabel.id });
      console.log(`[Workflow] Stamped GATE label on card "${card.title}"`);

      // Record the stamp so we don't re-stamp on stale cache AND so
      // _handleGate on the next pulse skips re-notification.
      this._notifiedGates.add(gateKey);
      this._saveNotifiedGates();

      // Handoff: unassign bot, assign board owner for human review
      const botUser = this.deck.username || this.botUsername;
      const humanUser = wb.board.owner?.uid || wb.board.owner || this._getHumanUser();
      await this._safeUnassign(wb.board.id, stack.id, card.id, botUser);
      await this._safeAssign(wb.board.id, stack.id, card.id, humanUser);
      console.log(`[Workflow] GATE handoff: "${card.title}" → ${humanUser}`);
    } catch (err) {
      console.warn(`[Workflow] Could not stamp GATE label on card "${card.title}": ${err.message}`);
    }
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
    // PAUSED and SCHEDULED cards must not generate escalation noise
    if (hasLabel(card, 'PAUSED')) return false;
    if (hasLabel(card, 'SCHEDULED')) return false;

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
   * Avoids re-processing cards that haven't changed since the agent last touched them.
   * Both timestamps are in Unix seconds for consistent comparison.
   * @param {number} boardId
   * @param {Object} card
   * @param {Object} stack
   * @returns {boolean}
   */
  _shouldProcess(boardId, card, stack) {
    const key = `${boardId}:${card.id}:${stack.id}`;
    const lastProcessed = this._processedCards.get(key);

    if (!lastProcessed) return true;

    // card.lastModified may be Unix seconds (number) or ISO 8601 string.
    // Normalize to Unix seconds before comparing so both forms work correctly.
    const raw = card.lastModified || 0;
    const cardModified = typeof raw === 'string'
      ? Math.floor(new Date(raw).getTime() / 1000)
      : raw;
    return cardModified > lastProcessed;
  }

  /**
   * Stamp a card+stack as processed. Only stamps the source stack — if
   * processing moved the card to another stack, the destination is not
   * pre-stamped and will be picked up on the next heartbeat with its
   * own CONFIG rules.
   *
   * Uses Unix seconds to match card.lastModified from the Deck API.
   * @private
   */
  _markProcessed(boardId, card, stack) {
    const key = `${boardId}:${card.id}:${stack.id}`;
    this._processedCards.set(key, Math.floor(Date.now() / 1000));
    this._saveProcessedCards();
  }

  /** @private */
  _loadProcessedCards() {
    if (!this._processedFile) return new Map(); // no disk persistence
    try {
      const raw = fs.readFileSync(this._processedFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // Exclude the _errors sub-key — it holds error state, not processed-card timestamps
        const entries = Object.entries(parsed).filter(([k]) => k !== '_errors');
        return new Map(entries);
      }
    } catch (_err) {
      // Missing file or corrupt JSON — start fresh
    }
    return new Map();
  }

  /** @private */
  _saveProcessedCards() {
    if (!this._processedFile) return; // no disk persistence
    try {
      if (!fs.existsSync(this._dataDir)) {
        fs.mkdirSync(this._dataDir, { recursive: true });
      }
      // Persist processed cards flat (for backward compatibility) plus _errors sub-key
      const obj = Object.fromEntries(this._processedCards);
      obj._errors = Object.fromEntries(this._errorState);
      const tmp = this._processedFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
      fs.renameSync(tmp, this._processedFile);
    } catch (err) {
      console.error('[Workflow] Failed to persist processed cards:', err.message);
    }
  }

  /** @private */
  _loadNotifiedGates() {
    if (!this._notifiedGatesFile) return new Set();
    try {
      const raw = fs.readFileSync(this._notifiedGatesFile, 'utf8');
      const arr = JSON.parse(raw);
      return new Set(Array.isArray(arr) ? arr : []);
    } catch (_) {
      return new Set();
    }
  }

  /** @private */
  _saveNotifiedGates() {
    if (!this._notifiedGatesFile) return;
    try {
      if (!fs.existsSync(this._dataDir)) {
        fs.mkdirSync(this._dataDir, { recursive: true });
      }
      const tmp = this._notifiedGatesFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify([...this._notifiedGates]), 'utf8');
      fs.renameSync(tmp, this._notifiedGatesFile);
    } catch (err) {
      console.error('[Workflow] Failed to persist notified gates:', err.message);
    }
  }

  /**
   * Strip schedule definitions and evaluation criteria from board rules.
   * Per-card processing only needs the workflow type and system card rules.
   * Schedule blocks (SCHEDULE:, EVALUATION CRITERIA:, PICK/SKIP) are for
   * the schedule handler and confuse the LLM during per-card processing.
   * @private
   */
  _stripScheduleContext(plainDescription) {
    if (!plainDescription) return '';
    // Remove everything from **SCHEDULE:** onward. The schedule block and
    // evaluation criteria are always at the end of the WORKFLOW card.
    const schedIdx = plainDescription.search(/\*{0,2}SCHEDULE\*{0,2}\s*:/i);
    if (schedIdx > 0) {
      return plainDescription.substring(0, schedIdx).trim();
    }
    return plainDescription;
  }

  /**
   * Safely assign a user to a card. Skips if already assigned.
   * @private
   */
  async _safeAssign(boardId, stackId, cardId, userId) {
    try {
      const p = `/index.php/apps/deck/api/v1.0/boards/${boardId}/stacks/${stackId}/cards/${cardId}/assignUser`;
      await this.deck._request('PUT', p, { userId });
    } catch (err) {
      const msg = err.responseBody?.message || err.message || '';
      // "already assigned" is expected — not an error
      if (msg.includes('already assigned')) return;
      console.warn(`[Workflow] Could not assign ${userId} to card ${cardId}: ${msg} (status: ${err.status || 'unknown'})`);
    }
  }

  /**
   * Safely unassign a user from a card. Ignores errors.
   * @private
   */
  async _safeUnassign(boardId, stackId, cardId, userId) {
    try {
      const p = `/index.php/apps/deck/api/v1.0/boards/${boardId}/stacks/${stackId}/cards/${cardId}/unassignUser`;
      await this.deck._request('PUT', p, { userId });
    } catch (err) {
      const msg = err.responseBody?.message || err.message || '';
      // "not assigned" is expected — not an error
      if (msg.includes('not assigned')) return;
      console.warn(`[Workflow] Could not unassign ${userId} from card ${cardId}: ${msg} (status: ${err.status || 'unknown'})`);
    }
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
    // Skip if already assigned to anyone
    if (card.assignedUsers && card.assignedUsers.length > 0) return;

    const isGate = GateDetector.isGate(card);
    const isDone = this._isDoneStack(wb, stack);
    if (isDone) return; // Don't assign Done cards

    const userId = isGate ? this._getHumanUser() : (this.deck.username || this.botUsername);
    await this._safeAssign(wb.board.id, stack.id, card.id, userId);
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

  // ===========================================================================
  // Label Helpers
  // ===========================================================================

  /**
   * Add a workflow label to a card by title.
   * Looks up the label ID from the full board then calls assignLabel.
   * @private
   */
  async _addLabelToCard(boardId, stackId, cardId, labelTitle) {
    try {
      const fullBoard = await this.deck.getBoard(boardId);
      const label = (fullBoard.labels || []).find(
        l => (l.title || '').toUpperCase() === labelTitle.toUpperCase()
      );
      if (!label) {
        console.warn(`[Workflow] Label "${labelTitle}" not found on board ${boardId} — run ensureWorkflowLabels first`);
        return;
      }
      const apiPath = `/index.php/apps/deck/api/v1.0/boards/${boardId}/stacks/${stackId}/cards/${cardId}/assignLabel`;
      await this.deck._request('PUT', apiPath, { labelId: label.id });
      console.log(`[Workflow] Added label "${labelTitle}" to card ${cardId}`);
    } catch (err) {
      console.warn(`[Workflow] Could not add label "${labelTitle}" to card ${cardId}: ${err.message}`);
    }
  }

  /**
   * Remove a workflow label from a card by title.
   * Looks up the label ID from the full board then calls the DELETE API.
   * @private
   */
  async _removeLabelFromCard(boardId, stackId, cardId, labelTitle) {
    try {
      const fullBoard = await this.deck.getBoard(boardId);
      const label = (fullBoard.labels || []).find(
        l => (l.title || '').toUpperCase() === labelTitle.toUpperCase()
      );
      if (!label) {
        console.warn(`[Workflow] Label "${labelTitle}" not found on board ${boardId} — nothing to remove`);
        return;
      }
      const apiPath = `/index.php/apps/deck/api/v1.0/boards/${boardId}/stacks/${stackId}/cards/${cardId}/assignLabel`;
      await this.deck._request('DELETE', apiPath, { labelId: label.id });
      console.log(`[Workflow] Removed label "${labelTitle}" from card ${cardId}`);
    } catch (err) {
      console.warn(`[Workflow] Could not remove label "${labelTitle}" from card ${cardId}: ${err.message}`);
    }
  }

  // ===========================================================================
  // SCHEDULED Card Handling
  // ===========================================================================

  /**
   * Handle a card that carries the SCHEDULED label.
   * - If PAUSED wins (already checked above, but guard here defensively).
   * - If no due date: warn and skip.
   * - If due date is in the future: skip.
   * - If due date is now or past: remove SCHEDULED label; returns true (activate).
   * @returns {boolean} true if the card should be processed this pulse
   * @private
   */
  async _handleScheduledCard(wb, stack, card) {
    // Defensive: PAUSED wins
    if (hasLabel(card, 'PAUSED')) return false;

    if (!card.duedate) {
      console.warn(`[Workflow] SCHEDULED card "${card.title}" has no due date — skipping`);
      return false;
    }

    const dueDate = new Date(card.duedate);
    if (isNaN(dueDate.getTime())) {
      console.warn(`[Workflow] SCHEDULED card "${card.title}" has unparseable due date "${card.duedate}" — skipping`);
      return false;
    }

    if (dueDate > new Date()) {
      // Not yet time — skip silently
      return false;
    }

    // Due date has arrived — remove SCHEDULED label to activate the card
    await this._removeLabelFromCard(wb.board.id, stack.id, card.id, 'SCHEDULED');
    console.log(`[Workflow] SCHEDULED card "${card.title}" activated (due: ${card.duedate})`);
    return true;
  }

  /**
   * Schedule a card for future activation.
   * Adds the SCHEDULED label and sets the card's due date.
   * @param {Object} wb - Workflow board descriptor
   * @param {Object} stack - Stack containing the card
   * @param {Object} card - Card to schedule
   * @param {string|Date|number} activateAt - When to activate (ISO string, Date, or ms timestamp)
   * @returns {Promise<void>}
   */
  async scheduleCard(wb, stack, card, activateAt) {
    const date = new Date(activateAt);
    if (isNaN(date.getTime())) throw new Error('scheduleCard requires a valid date');

    await this._addLabelToCard(wb.board.id, stack.id, card.id, 'SCHEDULED');
    await this._updateCardDueDate(wb.board.id, stack.id, card.id, date.toISOString());
    console.log(`[Workflow] Card "${card.title}" scheduled for ${date.toISOString()}`);
  }

  // ===========================================================================
  // ERROR State Management
  // ===========================================================================

  /**
   * Get the error state for a card, or null if none exists.
   * @private
   */
  _getErrorState(boardId, cardId) {
    const key = `${boardId}:${cardId}`;
    return this._errorState.get(key) || null;
  }

  /**
   * Set (upsert) error state for a card and persist.
   * @private
   */
  _setErrorState(boardId, cardId, state) {
    const key = `${boardId}:${cardId}`;
    this._errorState.set(key, state);
    this._saveProcessedCards(); // persists both _processedCards and _errorState
  }

  /**
   * Clear error state for a card (called when human removes ERROR label).
   * @private
   */
  _clearErrorState(boardId, cardId) {
    const key = `${boardId}:${cardId}`;
    if (this._errorState.has(key)) {
      this._errorState.delete(key);
      this._saveProcessedCards();
    }
  }

  /**
   * Determine if a card in error state is ready to retry.
   * Retry schedule: 1st retry → immediate (1 pulse), 2nd retry → 2 pulses wait.
   * lastAttempt is a Unix ms timestamp; pulseIntervalMs defaults to 5 minutes.
   * @private
   */
  _isRetryReady(boardId, cardId) {
    const state = this._getErrorState(boardId, cardId);
    if (!state) return true; // No error state — card is processable
    if (state.permanent) return false;

    const pulseMs = (this.config.pulseIntervalMs) || (5 * 60 * 1000);
    const waitPulses = state.retryCount; // 1 pulse wait after 1st fail, 2 after 2nd
    const waitMs = waitPulses * pulseMs;
    return (Date.now() - (state.lastAttempt || 0)) >= waitMs;
  }

  /**
   * Handle a processing error: add ERROR label, comment, track retries,
   * notify Talk on permanent failure.
   * @private
   */
  async _handleProcessingError(wb, stack, card, error) {
    const { board } = wb;
    const currentState = this._getErrorState(board.id, card.id) || { retryCount: 0, lastError: null, lastAttempt: 0, permanent: false };
    const attemptNumber = currentState.retryCount + 1;

    console.warn(`[Workflow] Processing error on card "${card.title}" (attempt ${attemptNumber}/3):`, error.message);

    // Add ERROR label on first failure (or if not already present)
    if (currentState.retryCount === 0) {
      await this._addLabelToCard(board.id, stack.id, card.id, 'ERROR');
    }

    // Post comment on card
    if (this.deck.addComment) {
      try {
        await this.deck.addComment(card.id,
          `\u26A0\uFE0F Processing error (attempt ${attemptNumber}/3): ${error.message}`
        );
      } catch (_err) {
        // Non-fatal
      }
    }

    const permanent = attemptNumber >= 3;
    this._setErrorState(board.id, card.id, {
      retryCount: attemptNumber,
      lastError: error.message,
      lastAttempt: Date.now(),
      permanent
    });

    if (permanent && this.talkQueue && this.talkToken) {
      await this.talkQueue.enqueue(this.talkToken,
        `\u274C Workflow card permanently failed in "${board.title}":\n` +
        `**${card.title}** \u2014 ${error.message}\n` +
        'Manual intervention required. Remove the ERROR label after resolving.'
      );
      console.error(`[Workflow] Permanent failure on card "${card.title}" — Talk notification sent`);
    }
  }

  // ===========================================================================
  // Error State Persistence
  // ===========================================================================

  /** @private */
  _loadErrorState() {
    if (!this._processedFile) return new Map(); // no disk persistence
    try {
      const raw = fs.readFileSync(this._processedFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed._errors) {
        return new Map(Object.entries(parsed._errors));
      }
    } catch (_err) {
      // Missing file or corrupt JSON — start fresh
    }
    return new Map();
  }

  /**
   * Reset session state. Call on service restart or daily reset.
   */
  resetState() {
    this._processedCards.clear();
    this._errorState.clear();
    this._saveProcessedCards();
    this._notifiedGates.clear();
    this._saveNotifiedGates();
    this._scheduleHandler.resetState();
    this.detector.invalidateCache();
  }
}

module.exports = WorkflowEngine;
