'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const GateDetector = require('./gate-detector');
const { ScheduleHandler, parseScheduleBlock, findConfigCard, stripHtml } = require('./schedule-handler');
const { isStructuralCard, hasLabel } = require('../integrations/deck-card-classifier');
const DeckClient = require('../integrations/deck-client');
const { proposeSlots, parseHoursMarker } = require('./slot-proposer');

const DEFAULT_DATA_DIR = path.resolve(process.cwd(), 'data');

// Upper bound for a CONFIG-declared MAX_ITERATIONS. A research stage legitimately
// needs more steps than the pipeline default of 3, but a typo (70 vs 7) must not
// run cloud cost away — the cap is clamped to this ceiling.
const MAX_ITERATION_CEILING = 15;

/**
 * Extract a CONFIG/WORKFLOW marker value from a plain-text block.
 * Matches `^NAME: value$` (case-insensitive, multiline) and trims the capture —
 * trailing whitespace in a marker value is never meaningful. Returns null when
 * the marker is absent. Shared by the scheduling and iteration-cap resolvers so
 * a single reader owns marker extraction.
 * @param {string} text
 * @param {string} name
 * @returns {string|null}
 */
function getConfigMarker(text, name) {
  if (!text) return null;
  const re = new RegExp(`^${name}:\\s*(.+)$`, 'im');
  const m = text.match(re);
  return m ? m[1].trim() : null;
}

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
   * @param {Object} [options.emailHandler] - EmailHandler instance; when provided, boards with a
   *   TRIGGER: email:<folder> line will have new emails ingested as cards each pulse.
   * @param {Object} [options.ncMailClient] - NCMailClient instance; when provided, ingested cards
   *   receive a best-effort deep-link back to the original message in NC Mail.
   * @param {Object} [options.config]
   */
  constructor({ workflowDetector, deckClient, agentLoop, talkSendQueue, talkToken, emailHandler, ncMailClient, config, budgetEnforcer }) {
    this.detector = workflowDetector;
    this.deck = deckClient;
    this.agent = agentLoop;
    this.talkQueue = talkSendQueue;
    this.talkToken = talkToken || null;
    this.config = config || {};
    this.budgetEnforcer = budgetEnforcer || null;
    this.botUsername    = this.config.botUsername || 'moltagent';
    this.emailHandler   = emailHandler || null;
    this.ncMailClient   = ncMailClient || null;

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

    // Track emails already ingested as cards to guarantee idempotency.
    // On-disk shape: { "<boardId>": ["<msgId>", ...] }
    // In memory: Map<string, Set<string>>
    // Keyed by Message-ID (or a sha1 fallback for emails that lack one).
    // Persisted to disk so service restarts don't re-ingest.
    this._ingestedEmailsFile = this._dataDir
      ? path.join(this._dataDir, 'workflow-ingested-emails.json')
      : null;
    this._ingestedEmails = this._loadIngestedEmails(); // Map<boardId(string), Set<messageId>>

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
    // Fail-safe: if the rules card is not resolvable, treat as PAUSED.
    const rulesCard = wb.rulesCardId
      ? stacks.flatMap(s => s.cards || []).find(c => c.id === wb.rulesCardId)
      : null;
    if (!rulesCard) {
      console.warn(`[Workflow] Board "${board.title}" — rules card not resolvable (id=${wb.rulesCardId}), treating as PAUSED`);
      return result;
    }
    if (hasLabel(rulesCard, 'PAUSED')) {
      console.log(`[Workflow] Board "${board.title}" is PAUSED — skipping`);
      return result;
    }

    // External-event ingestion: a TRIGGER: line pulls emails from a folder into
    // this board as cards, once per email (idempotent on Message-ID), before the
    // per-card processing loop. Inherits the board PAUSED gate above.
    try {
      await this._ingestTriggerEmails(wb);
    } catch (err) {
      console.error('[Workflow] Email trigger ingestion error on "' + board.title + '": ' + err.message);
    }

    for (const stack of stacks) {
      // Stack-level PAUSED check via canonical predicate (#23).
      if (DeckClient.stackHasPausedConfig(stack)) {
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

    // Process SCHEDULE block from board rules (timed actions).
    // PAUSED-stack handling lives inside ScheduleHandler.processSchedules
    // (#28): if any stack on this board has a PAUSED CONFIG card, every
    // schedule on the board is skipped before its LLM agent loop fires.
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
   * Looks for a line starting with "LLM:" followed by a directive.
   *   cloud         → writing job (Opus → Sonnet → Haiku)
   *   cloud-writing → coding job  (Sonnet → Haiku, no Opus)
   *   cloud-fast    → tools job   (Haiku only)
   *   local         → local only
   * @private
   * @param {Object|null} configCard - CONFIG card object with .description
   * @returns {{ allowCloud: boolean, cloudTier: string|null }}
   */
  _extractStackLlmRouting(configCard) {
    if (!configCard?.description) return { allowCloud: false, cloudTier: null };
    const plain = stripHtml(configCard.description);
    const match = plain.match(/^LLM:\s*(cloud-writing|cloud-fast|cloud|local)\b/im);
    if (!match) return { allowCloud: false, cloudTier: null };
    const directive = match[1].toLowerCase();
    const tierMap = { 'cloud-fast': 'fast', 'cloud-writing': 'writing' };
    return {
      allowCloud: directive.startsWith('cloud'),
      cloudTier: tierMap[directive] || null
    };
  }

  /**
   * Process a single non-GATE card through the AgentLoop.
   * @private
   */
  async _processCard(wb, stack, card) {
    const { board, description, stacks } = wb;

    // Terminal stack: the pipeline's end. A card resting here has nothing
    // further to do, so skip the beat entirely — no LLM call, no cost. A stack
    // is terminal only when its CONFIG card explicitly declares TERMINAL: true
    // (opt-in; the default is non-terminal).
    if (this._isTerminalStack(stack)) {
      console.log(`[Workflow] Skipping terminal stack "${stack.title}" for card "${card.title}"`);
      return;
    }

    let { forceLocal } = this._getRoleForCard(wb, card);

    // Budget check before cloud processing
    if (!forceLocal && this.budgetEnforcer) {
      const check = this.budgetEnforcer.canSpend('cloud', 0.02);
      if (!check.allowed) {
        console.log(`[Workflow] Budget exceeded: ${check.reason} — forcing local for "${card.title}"`);
        forceLocal = true;
      }
    }

    // Iteration cap: stack CONFIG → board WORKFLOW → code default. A research/
    // grounding stage writes a profile to two surfaces, attributes web sources,
    // drafts a reply and moves the card — more steps than the pipeline default.
    const maxIterations = this._resolveMaxIterations(wb, stack);

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

    // Fetch board labels so the LLM can assign them by ID
    let labelBlock = '';
    try {
      const fullBoard = await this.deck.getBoard(board.id);
      const boardLabels = (fullBoard.labels || []);
      if (boardLabels.length > 0) {
        labelBlock = '\n**Available Labels:**\n' +
          boardLabels.map(l => `  - "${l.title}" (ID: ${l.id})`).join('\n') + '\n';
      }
    } catch (err) {
      console.warn(`[Workflow] Could not fetch labels for board ${board.id}: ${err.message}`);
    }

    // Resolve parent card content when description references "Parent: #ID" or "Parent card: #ID"
    let parentBlock = '';
    const cardDesc = stripHtml(card.description || '');
    const parentMatch = cardDesc.match(/\bParent(?:\s+card)?:\s*#(\d+)/i);
    if (parentMatch) {
      const parentId = parseInt(parentMatch[1], 10);
      try {
        // Find the parent card across all stacks on this board
        let parentCard = null;
        for (const s of stacks) {
          parentCard = (s.cards || []).find(c => c.id === parentId);
          if (parentCard) break;
        }
        if (parentCard && parentCard.description) {
          const parentDesc = stripHtml(parentCard.description);
          if (parentDesc.length > 0) {
            parentBlock = `**Parent Content (card #${parentId} "${parentCard.title}"):**\n${parentDesc}\n`;
            console.log(`[Workflow] Resolved parent card #${parentId} for "${card.title}" (${parentDesc.length} chars)`);
          }
        }
      } catch (err) {
        console.warn(`[Workflow] Could not resolve parent card #${parentId}: ${err.message}`);
      }
    }

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
      parentBlock,
      card.description ? `**Card Description:** ${stripHtml(card.description)}` : '',
      commentBlock,
      `**Card Labels:** ${(card.labels || []).map(l => `${l.color}: ${l.title}`).join(', ') || 'none'}`,
      labelBlock,
      `**Card Due:** ${card.duedate || 'none'}`,
      `**Assigned To:** ${(card.assignedUsers || []).map(u => u.participant?.uid).join(', ') || 'unassigned'}`,
      '',
      `**All Stacks (left to right):**`,
      stacks.filter(s => !DeckClient.stackHasPausedConfig(s))
        .map(s => `  - "${s.title}" (ID: ${s.id}, ${(s.cards || []).length} cards)`).join('\n'),
      '',
      '**Instructions:**',
      'Follow the CONFIG instructions for this stack. The CONFIG card defines',
      'exactly what to do with cards in this stack.',
      'Use workflow_deck_update_card to write or rewrite the card description.',
      'Use workflow_deck_* tools with numeric IDs to move cards, add comments, etc.',
      'Comment on the card with what you did.',
      'If the CONFIG says to notify in Talk, use the talk_send tool.',
      'If you need to create files, use file tools.',
      'If the CONFIG references wiki pages with [[Page Name]], search and read them.',
      'When the CONFIG mentions GATE, first complete all work described before the GATE instruction,',
      'then use workflow_deck_assign_label to add the GATE label (check Available Labels for the ID),',
      'and assign the human reviewer. Do not proceed past the GATE point.',
    ].filter(Boolean).join('\n');

    // ── Research grounding block (Part 5 / #188) ─────────────────────────────
    // Self-scoping: only injected when the card description contains a parseable
    // From: footer line (structural signal that this is an ingested inquiry card).
    // Generic cards and other boards receive no grounding block.
    //
    // The From: footer is written by the email trigger ingest path (#185) as:
    //   <body>\n\n---\nFrom: <Name> <addr>\nDate: ...\nMessage-ID: ...
    // We parse from the RAW description (not the stripHtml version) because
    // stripHtml strips angle-bracket content (e.g. <alice@acme.com> → stripped).
    // This is structural parsing of a machine-authored marker — Rule 1 clean.
    //
    // Custody: the parse is bound to the trailing footer segment (after the last
    // "\n---\n" delimiter the ingest path appends), NOT the whole description.
    // A quoted/forwarded inbound body can contain its own "From: x@other.com"
    // line; matching that would let third-party content masquerade as the
    // established contact fact and steer the web_search domain anchor. The footer
    // is always the final segment, so .pop() isolates the machine-authored region.
    const searchPolicy = this.agent.cockpitManager?.cachedConfig?.system?.searchPolicy || 'research';
    let groundingBlock = '';
    const rawCardDesc = card.description || '';
    const footerSegment = rawCardDesc.split(/\n---\n/).pop();
    const fromFooterMatch = footerSegment.match(/^From:\s*(.+)$/im);
    if (fromFooterMatch) {
      const fromRaw = fromFooterMatch[1].trim();
      // Parse "Name <addr>" or "<addr>" or "addr" forms structurally.
      let contactName    = '';
      let contactAddress = '';
      const angleMatch = fromRaw.match(/^(.*?)\s*<([^>]+)>\s*$/);
      if (angleMatch) {
        contactName    = angleMatch[1].trim();
        contactAddress = angleMatch[2].trim();
      } else {
        // No angle-bracket form — treat the whole string as the address
        contactAddress = fromRaw;
      }

      // Mail link: the NC Mail deep-link is on a separate line in the footer
      // as "[Open the original email in Mail](url)".  Extract it structurally.
      let mailLinkLine = '';
      const mailLinkMatch = footerSegment.match(/\[Open the original email in Mail\]\(([^)]+)\)/i);
      if (mailLinkMatch) {
        mailLinkLine = `\n- Source: [NC Mail thread](${mailLinkMatch[1]})`;
      }

      // ── Section A: structured contact facts (always present when From present)
      const sectionA = [
        '## Known contact details (from the inbound message)',
        `- Name: ${contactName || '(not provided)'}`,
        `- Email: ${contactAddress}`,
        mailLinkLine || '',
        '',
        'These details are established facts. Include them in the profile as-is.',
        'Do not omit or fabricate the email address.',
      ].filter(s => s !== null).join('\n');

      // ── Section B: research instructions (web-dependent)
      let sectionB;
      if (searchPolicy !== 'sovereign') {
        // Derive the domain from the sender address as a concrete company anchor.
        const domainMatch = contactAddress.match(/@([^@>]+)$/);
        const senderDomain = domainMatch ? domainMatch[1] : '';
        sectionB = [
          '## Research task',
          'Find publicly available information about the company associated with this inquiry.',
          senderDomain ? `The sender's email domain is @${senderDomain} — use this as a concrete anchor.` : '',
          'Identify the company from the inquiry text (do NOT fabricate a company name if one is not clear).',
          '',
          'Useful signals: what the company does, its size/stage, its relevance to the inquiry topic,',
          'any public contact or team pages.',
          '',
          'Source attribution rules (strictly enforced):',
          '- Every claim from web results MUST include its source URL.',
          '- Claims without a source URL are NOT included in the profile.',
          '- Keep internal facts (from the email), provided contact details, and web findings',
          '  as distinct attributed sections in both the card description and the Collectives page.',
          '',
          'Write the profile to BOTH:',
          '  1. The card description (appended below the email text) — the reviewer\'s primary surface.',
          '  2. The partner\'s Collectives page — the durable record.',
        ].filter(Boolean).join('\n');
      } else {
        sectionB = [
          '## Research note',
          'Web research is disabled by system policy (sovereign mode).',
          'Compile the profile from the email content and internal knowledge only.',
          'Write the profile to both the card description and the Collectives page.',
        ].join('\n');
      }

      // ── Section C: scheduling slots (only when hoursExplicit)
      let sectionC = '';
      const schedulingCfg = this._resolveSchedulingConfig(wb, stack);
      if (schedulingCfg.hoursExplicit) {
        // Fetch busy events via CalDAV client (guard for null / absent client)
        let busyBlocks = [];
        const calClient = this.agent.toolRegistry?.clients?.calDAVClient;
        if (calClient) {
          try {
            const now       = new Date();
            // Search 5 business days forward (matches proposeSlots default windowDays)
            const WINDOW_DAYS = 5;
            const rangeEnd  = new Date(now.getTime() + WINDOW_DAYS * 24 * 60 * 60 * 1000);
            // getEvents needs a calendarId; use the default calendar name.
            // Fall back to 'personal' if not configured.
            const calId     = calClient.defaultCalendar || 'personal';
            const events    = await calClient.getEvents(calId, now, rangeEnd);
            // Drop events with missing start/end (malformed ICS yields null DTSTART/
            // DTEND → new Date(null) = epoch, a spurious busy block). proposeSlots
            // also re-filters NaN, but excluding incomplete events here is cleaner.
            busyBlocks = (events || [])
              .filter(e => e && e.start && e.end)
              .map(e => ({
                start: e.start instanceof Date ? e.start : new Date(e.start),
                end:   e.end   instanceof Date ? e.end   : new Date(e.end)
              }));
          } catch (err) {
            console.warn(`[Workflow] Could not fetch calendar events for slot proposal: ${err.message}`);
          }
        }

        // Detect locale from card language — but since the model handles language
        // and the contact details determine the response language, we default to
        // 'en' here and let the model render them in the appropriate language.
        // The slot strings carry machine-correct dates; the model may translate
        // surrounding prose but must not recompute the dates.
        const slots = proposeSlots({
          busyBlocks,
          hours:        schedulingCfg.hours,
          timezone:     schedulingCfg.timezone,
          slotDuration: schedulingCfg.slotDuration,
          locale:       'en',
          now:          new Date(),
          maxSlots:     3,
          windowDays:   5
        });

        if (slots.length > 0) {
          sectionC = [
            '## Available meeting slots',
            'The following slots are confirmed available and correctly labeled.',
            'Include these in the profile as proposed meeting times.',
            'Weekday labels are pre-computed and correct — do NOT recompute them.',
            ...slots.map(s => `- ${s}`),
          ].join('\n');
        } else {
          sectionC = '## Available meeting slots\nNo availability found in the current window. Omit scheduling from the profile.';
        }
      }

      groundingBlock = [
        '',
        '---',
        '## Structured Research Grounding',
        '',
        sectionA,
        '',
        sectionB,
        sectionC ? '' : null,
        sectionC || null,
      ].filter(s => s !== null).join('\n');
    }

    const finalSystemAddition = groundingBlock
      ? systemAddition + groundingBlock
      : systemAddition;

    await this.agent.processWorkflowTask({
      systemAddition: finalSystemAddition,
      task: `Process workflow card: "${card.title}" according to the board rules.`,
      boardId: board.id,
      cardId: card.id,
      stackId: stack.id,
      forceLocal,
      allowCloud,
      cloudTier,
      maxIterations,
      searchPolicy
    });
  }

  /**
   * Handle a GATE card — check for human resolution, notify if needed.
   * @returns {boolean} Whether the gate was resolved
   * @private
   */
  async _handleGate(wb, stack, card) {
    const { board } = wb;

    // Resolution check (#197): two sources, evaluated in GateDetector —
    //   via 'label' → legacy APPROVED/REJECTED stamp (backward-compat)
    //   via 'move'  → reviewer dragged the GATE card OUT of the gate stack.
    // The engine computes whether the card's CURRENT stack is a declared
    // rejection target; GateDetector decides gate-stack membership from `stack`.
    const isRejectionStack = this._isRejectionStack(stack);
    const resolution = GateDetector.checkGateResolution(card, stack, isRejectionStack);

    if (resolution.resolved && resolution.decision) {
      // Post-resolution label swap (#197, Part 2). Only for via==='move' — a
      // 'label' resolution already carries its record-keeping label, so re-stamping
      // would be redundant. Run BEFORE the processWorkflowTask handoff so the
      // record-keeping state is deterministic regardless of what the LLM does downstream.
      if (resolution.via === 'move') {
        await this._removeLabelFromCard(board.id, stack.id, card.id, 'GATE');
        await this._addLabelToCard(board.id, stack.id, card.id,
          resolution.decision === 'rejected' ? 'REJECTED' : 'APPROVED');
        // Idempotency: removing the GATE label makes isGate() false next pulse,
        // so the card is not re-handled. Known edge: isGate() also matches a
        // "GATE:" TITLE prefix, so a move-resolved card whose title starts
        // "GATE:" could re-enter via the APPROVED label path — tracked in #200.
        console.log(`[Workflow] GATE resolved: card "${card.title}" ` +
          `${resolution.decision} (moved from gate stack to "${stack.title}")`);
      } else {
        // Legacy label-stamp resolution (backward-compat path).
        console.log(`[Workflow] GATE resolved: "${card.title}" -> ${resolution.decision}`);
      }

      // Clear notification dedup so card can be re-gated later if needed
      const gateKey = `${board.id}:${card.id}`;
      this._notifiedGates.delete(gateKey);
      this._saveNotifiedGates();

      // Handoff back: unassign human, assign bot for automated processing
      const botUser = this.deck.username || this.botUsername;
      const humanUser = this._resolveGateReviewer(wb, stack);
      if (humanUser && humanUser !== botUser) {
        await this._safeUnassign(board.id, stack.id, card.id, humanUser);
      }
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

      // Fetch board labels so the LLM can assign them by ID during resolution
      let gateLabelBlock = '';
      try {
        const fullBoard = await this.deck.getBoard(board.id);
        const boardLabels = (fullBoard.labels || []);
        if (boardLabels.length > 0) {
          gateLabelBlock = '\n**Available Labels:**\n' +
            boardLabels.map(l => `  - "${l.title}" (ID: ${l.id})`).join('\n') + '\n';
        }
      } catch (err) {
        console.warn(`[Workflow] Could not fetch labels for GATE resolution on board ${board.id}: ${err.message}`);
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
        gateLabelBlock,
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
      // Notification text reflects the new gesture (#197, Part 4): the approval
      // signal is the stack MOVE, not a label. These are fixed system strings
      // (not NL classification), so a static template is acceptable.
      const rej = wb.stacks.find(s => this._isRejectionStack(s));
      const declineLine = rej ? `\nMove to "${rej.title}" to decline.` : '';

      // Notify in Talk once per process lifecycle (in-memory dedup via _notifiedGates).
      if (this.talkQueue && this.talkToken) {
        await this.talkQueue.enqueue(this.talkToken,
          `\u23F8\uFE0F Workflow "${wb.board.title}" is waiting for your review.\n` +
          `Card: **${card.title}**\n` +
          'Move this card forward to approve.' + declineLine
        );
      }

      // Also comment on the card so the GATE state is visible in the Deck UI.
      // This is informational only — state is tracked by label, not comment content.
      if (this.deck.addComment) {
        try {
          await this.deck.addComment(card.id,
            `\u23F8\uFE0F **GATE**: Waiting for human review.\n` +
            'Move this card forward to approve.' + declineLine
          );
        } catch (_err) {
          // Non-fatal — Talk notification is the primary channel
        }
      }

      this._notifiedGates.add(gateKey);
      this._saveNotifiedGates();
      console.log(`[Workflow] GATE notification sent for "${card.title}"`);
    }

    // Safety net: if GATE card is still assigned to bot, reassign to human.
    // This catches cases where the LLM stamped GATE but forgot to reassign.
    {
      const bot = this.deck.username || this.botUsername;
      const assignedUids = (card.assignedUsers || []).map(u => u.participant?.uid).filter(Boolean);
      // Terminal: already assigned to a real (non-bot) human → done, never touch.
      if (!assignedUids.some(uid => uid !== bot)) {
        // Only act if the card is still assigned to the bot.
        if (assignedUids.includes(bot)) {
          const human = this._resolveGateReviewer(wb, stack);
          // No human resolvable → do NOT churn (notification already fired once above).
          if (human && human !== bot) {
            await this._safeUnassign(board.id, stack.id, card.id, bot);
            await this._safeAssign(board.id, stack.id, card.id, human);
            console.log(`[Workflow] GATE safety net: reassigned "${card.title}" from ${bot} to ${human}`);
          }
        }
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

  // ===========================================================================
  // Ingested Emails Persistence  (email-trigger-bridge)
  // ===========================================================================

  /**
   * Load the per-board ingested-email sets from disk.
   * On-disk shape: { "<boardId>": ["<msgId>", ...] }
   * Returns Map<string, Set<string>>; starts fresh on missing/corrupt file.
   * @private
   */
  _loadIngestedEmails() {
    if (!this._ingestedEmailsFile) return new Map();
    try {
      const raw = fs.readFileSync(this._ingestedEmailsFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const map = new Map();
        for (const [boardId, ids] of Object.entries(parsed)) {
          map.set(boardId, new Set(Array.isArray(ids) ? ids : []));
        }
        return map;
      }
    } catch (_err) {
      // Missing file or corrupt JSON — start fresh
    }
    return new Map();
  }

  /**
   * Persist the ingested-emails Map to disk (atomic tmp + rename).
   * @private
   */
  _saveIngestedEmails() {
    if (!this._ingestedEmailsFile) return;
    try {
      if (!fs.existsSync(this._dataDir)) {
        fs.mkdirSync(this._dataDir, { recursive: true });
      }
      const obj = {};
      for (const [boardId, set] of this._ingestedEmails.entries()) {
        obj[boardId] = [...set];
      }
      const tmp = this._ingestedEmailsFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
      fs.renameSync(tmp, this._ingestedEmailsFile);
    } catch (err) {
      console.error('[Workflow] Failed to persist ingested emails:', err.message);
    }
  }

  /**
   * Check whether an email has already been ingested for a given board.
   * @param {string|number} boardId
   * @param {string} msgId
   * @returns {boolean}
   * @private
   */
  _isEmailIngested(boardId, msgId) {
    const set = this._ingestedEmails.get(String(boardId));
    return set ? set.has(msgId) : false;
  }

  /**
   * Mark an email as ingested for a given board and persist to disk.
   * Caps each board's set at 1000 most-recent entries (insertion-order).
   * @param {string|number} boardId
   * @param {string} msgId
   * @private
   */
  _markEmailIngested(boardId, msgId) {
    const key = String(boardId);
    let set = this._ingestedEmails.get(key);
    if (!set) {
      set = new Set();
      this._ingestedEmails.set(key, set);
    }
    set.add(msgId);
    // Cap at 1000 most-recent entries to prevent unbounded growth
    if (set.size > 1000) {
      this._ingestedEmails.set(key, new Set([...set].slice(-1000)));
    }
    this._saveIngestedEmails();
  }

  // ===========================================================================
  // Email Trigger Bridge  (email-trigger-bridge)
  // ===========================================================================

  /**
   * Parse a TRIGGER: line from the board rules. Structured metadata, not NL.
   * Form: TRIGGER: <kind>:<locator>  (optionally  -> <stack name>)
   * The locator is a folder path (e.g. INBOX.INQUIRIES) for email triggers.
   * The locator must be whitespace-free (dotted IMAP paths like INBOX.INQUIRIES);
   * folder names containing spaces are not supported by this unquoted form, and
   * the optional stack-target separator is ASCII "->" (not the Unicode arrow).
   * Returns { kind, locator, stackName } or null.
   * @private
   */
  _parseTrigger(wb) {
    const desc = wb._plainDescription || stripHtml(wb.description || '');
    const m = desc.match(/^TRIGGER:\s*(\w+):(\S+?)(?:\s*->\s*(.+?))?\s*$/im);
    if (!m) return null;
    return { kind: m[1].toLowerCase(), locator: m[2], stackName: m[3] ? m[3].trim() : null };
  }

  /**
   * Compute a stable fallback dedup key for emails that lack a Message-ID.
   * Uses a sha1 of folder|uid|date|from|subject so the same physical email
   * always maps to the same key across pulses.
   * @private
   */
  _fallbackEmailKey(folder, email) {
    const parts = [
      folder,
      String(email.id ?? ''),
      String(email.date ?? ''),
      String(email.from ?? ''),
      String(email.subject ?? '')
    ].join('|');
    return 'nomsgid:' + crypto.createHash('sha1').update(parts).digest('hex');
  }

  /**
   * Ingest emails from a TRIGGER: email:<folder> declaration into this board as
   * Deck cards. Idempotent on the Message-ID store (data/workflow-ingested-emails.json),
   * NOT on the IMAP \Seen flag (#194) — a flag the engine does not own. The mailbox
   * is opened read-only and \Seen is never mutated. On a board's first pulse the
   * folder's existing contents are seeded into the store (zero cards) so historical
   * mail is not bulk-ingested.
   * @param {Object} wb - WorkflowBoard descriptor
   * @returns {Promise<number>} Number of cards created this pulse
   * @private
   */
  async _ingestTriggerEmails(wb) {
    const trigger = this._parseTrigger(wb);
    if (!trigger) return 0;

    // Dispatch on kind — only 'email' is implemented; future kinds add here.
    if (trigger.kind !== 'email') {
      console.warn('[Workflow] Unsupported TRIGGER kind: ' + trigger.kind + ' — skipping');
      return 0;
    }

    // Graceful no-op when emailHandler was not injected (e.g. unit tests).
    if (!this.emailHandler) return 0;

    // Resolve the entry stack: named target takes precedence; else first by order.
    let stack;
    if (trigger.stackName) {
      stack = (wb.stacks || []).find(
        s => s.title.toLowerCase() === trigger.stackName.toLowerCase()
      );
    } else {
      const sorted = [...(wb.stacks || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      stack = sorted[0];
    }

    if (!stack) {
      console.warn('[Workflow] Email trigger: no entry stack resolved for board "' + wb.board.title + '" (stackName=' + (trigger.stackName || 'null') + ')');
      return 0;
    }

    // Fetch ALL emails in the folder — opens the mailbox READ-ONLY (never mutates
    // \Seen). Dedup is the Message-ID store's job (#194), not the \Seen flag's: a
    // human who reads then curates a mail into the trigger folder leaves it \Seen,
    // and the old unreadOnly filter made that mail permanently invisible.
    let emails;
    try {
      emails = await this.emailHandler._fetchEmails({
        folder: trigger.locator,
        unreadOnly: false,
        limit: 50
      });
    } catch (err) {
      console.error('[Workflow] Email trigger fetch failed for board "' + wb.board.title + '": ' + err.message);
      return 0;
    }

    if (emails.length === 50) {
      // Soft warning: a full fetch window may silently cap a backlog.
      console.warn('[Workflow] Email trigger fetch hit the limit (50) for folder ' + trigger.locator + ' — older mail may wait for the next pulse');
    }

    // Process oldest-first so card order on the board reflects email arrival order.
    // _fetchEmails returns newest-first (sorted descending); reverse to get oldest-first.
    const orderedEmails = [...emails].reverse();

    // First-run seeding (#194): now that the fetch returns ALL mail, a board whose
    // trigger folder already holds messages would bulk-create a card per message on
    // its first pulse. A board is on its first pulse when the store holds no entry
    // for it (the .has() signal — NOT an empty set, which an empty starting folder
    // would also produce, re-triggering seeding forever). Record the folder's
    // current Message-IDs, persist the board entry even when the folder is empty,
    // and create zero cards. Genuinely new mail arriving on later pulses ingests
    // normally because the store entry now exists.
    if (!this._ingestedEmails.has(String(wb.boardId))) {
      for (const email of orderedEmails) {
        const key = email.messageId || this._fallbackEmailKey(trigger.locator, email);
        this._markEmailIngested(wb.boardId, key);
      }
      // Guarantee a board entry persists even when the folder was empty, so an
      // email arriving on a later pulse is ingested rather than re-seeded.
      if (!this._ingestedEmails.has(String(wb.boardId))) {
        this._ingestedEmails.set(String(wb.boardId), new Set());
        this._saveIngestedEmails();
      }
      console.log('[Workflow] Seeded ingested-emails store for board ' + wb.boardId + ' with ' + orderedEmails.length + ' existing Message-ID(s)');
      return 0;
    }

    let ingested = 0;
    for (const email of orderedEmails) {
      const key = email.messageId || this._fallbackEmailKey(trigger.locator, email);

      if (this._isEmailIngested(wb.boardId, key)) continue;

      // Build the card title and description.
      const title = email.subject || '(No subject)';
      const bodyText = (email.body || '').slice(0, 2000);

      // Custody fix (#185): carry the canonical fromAddress so downstream beats
      // do not need to re-derive or fabricate it. Use RFC 5322 "Name <addr>" form.
      // Invariant: when the display string already contains the address, do NOT
      // duplicate it (handles the common "Name <addr>" production from IMAP).
      const fromDisplay = email.from || '';
      const fromAddr    = email.fromAddress || '';
      let fromLine;
      if (!fromAddr || fromDisplay.includes(fromAddr)) {
        // Address absent or already embedded in the display string — preserve as-is.
        fromLine = fromDisplay;
      } else if (fromDisplay) {
        fromLine = fromDisplay + ' <' + fromAddr + '>';
      } else {
        fromLine = '<' + fromAddr + '>';
      }

      let description = bodyText + '\n\n---\nFrom: ' + fromLine +
        '\nDate: ' + (email.date || '') +
        '\nMessage-ID: ' + key;

      // Best-effort: append a deep-link back to the original message in NC Mail.
      // Only attempt resolution when the real Message-ID header is available
      // (key may be a sha1 fallback when messageId is absent — not resolvable).
      if (this.ncMailClient && email.messageId) {
        try {
          const mailUrl = await this.ncMailClient.resolveThreadUrl(trigger.locator, email.messageId);
          if (mailUrl) {
            description += '\n[Open the original email in Mail](' + mailUrl + ')';
          } else {
            console.log('[Workflow] NC Mail back-link: no match for Message-ID ' + email.messageId + ' (message may not yet be synced) — keeping Message-ID footer');
          }
        } catch (err) {
          console.log('[Workflow] NC Mail back-link: resolution errored for Message-ID ' + email.messageId + ': ' + err.message + ' — keeping Message-ID footer');
        }
      }

      const card = await this.deck.createCardOnBoard(wb.boardId, stack.id, title, { description });

      if (card) {
        // Only mark ingested after successful card creation.
        // If createCardOnBoard returned null (entry stack is PAUSED) we do NOT
        // mark, so the email is retried on the next pulse when unpaused.
        this._markEmailIngested(wb.boardId, key);
        ingested++;
      }
    }

    if (ingested > 0) {
      console.log('[Workflow] Email trigger ingested ' + ingested + ' card(s) into "' + wb.board.title + '" from ' + trigger.locator);
    }

    return ingested;
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

    const userId = isGate ? this._resolveGateReviewer(wb, stack) : (this.deck.username || this.botUsername);
    if (!userId) return;
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
   * Resolve the declared GATE reviewer uid for a given stack/board.
   * Never returns the bot uid — the convergence guard depends on this guarantee.
   *
   * Source of truth: a structural `REVIEWER: <uid>` marker declared in the board
   * WORKFLOW rules card or the stack CONFIG card — same convention as TRIGGER:/MODEL:/
   * SLA:/LLM: markers.  Board ownership and ACL are NOT consulted (declared intent
   * is the only authority; inferring from NC ownership was the #183 generator).
   *
   * Resolution order (first hit wins):
   * 1. Stack CONFIG card `REVIEWER: <uid>` — most specific override.
   * 2. Board WORKFLOW rules `REVIEWER: <uid>` from wb._plainDescription.
   * 3. config.adminUser, if explicitly set and !== bot.
   * 4. null — no resolvable reviewer; callers must NOT churn assignments.
   *
   * @param {Object} wb    - Workflow board descriptor (wb._plainDescription)
   * @param {Object} stack - Current stack (used to locate the CONFIG card)
   * @returns {string|null}
   * @private
   */
  _resolveGateReviewer(wb, stack) {
    const bot = this.deck.username || this.botUsername;

    // Step 1: stack CONFIG card — most specific (mirrors _extractStackLlmRouting pattern).
    const configCard = findConfigCard(stack);
    if (configCard?.description) {
      const plain = stripHtml(configCard.description);
      const m = plain.match(/^REVIEWER:\s*(\S+)\s*$/im);
      if (m) {
        const uid = m[1].trim();
        // A declared reviewer that equals the bot uid is a misconfiguration — treat as absent.
        if (uid && uid !== bot) return uid;
      }
    }

    // Step 2: board WORKFLOW rules card.
    const boardDesc = wb._plainDescription || '';
    const bm = boardDesc.match(/^REVIEWER:\s*(\S+)\s*$/im);
    if (bm) {
      const uid = bm[1].trim();
      if (uid && uid !== bot) return uid;
    }

    // Step 3: deterministic config default — only the explicitly configured
    // value, never a fallback sentinel that could resolve to a non-existent user.
    const admin = this.config.adminUser;
    if (admin && admin !== bot) return admin;

    // Step 4: unresolvable — return null so callers never churn.
    return null;
  }

  /**
   * Is this stack a declared terminal stack?
   *
   * A terminal stack is the pipeline's end (e.g. "Replied"): a card resting
   * there needs no further processing. Declared by a TERMINAL: true marker on
   * the stack's CONFIG card. This is explicit opt-in only — there is no
   * resolution chain and no code default. TERMINAL: false or an absent marker
   * both mean non-terminal.
   *
   * @param {Object} stack - Current stack (used to locate the CONFIG card)
   * @returns {boolean}
   * @private
   */
  _isTerminalStack(stack) {
    const configCard = findConfigCard(stack);
    const stackPlain = configCard?.description ? stripHtml(configCard.description) : '';
    const raw = getConfigMarker(stackPlain, 'TERMINAL');
    return raw !== null && raw.trim().toLowerCase() === 'true';
  }

  /**
   * Is this stack a declared rejection target for GATE drag-to-decline (#197)?
   *
   * A stack is a rejection target when its CONFIG card declares `REJECTED: true`.
   * The marker MUST live on the SAME CONFIG card as #196 TERMINAL — i.e. located
   * via findConfigCard (the 'CONFIG:' title-prefix card), NOT GateDetector's
   * 'System'-label gate-stack card — so a deployer declares all stack policy in
   * one place. Explicit opt-in only: `REJECTED: false` or an absent marker both
   * mean "not a rejection stack" (all other moves out of the gate stack are
   * approvals).
   *
   * @param {Object} stack - Stack to test (used to locate the CONFIG card)
   * @returns {boolean}
   * @private
   */
  _isRejectionStack(stack) {
    const configCard = findConfigCard(stack);
    const stackPlain = configCard?.description ? stripHtml(configCard.description) : '';
    const raw = getConfigMarker(stackPlain, 'REJECTED');
    return raw !== null && raw.trim().toLowerCase() === 'true';
  }

  /**
   * Resolve the per-card iteration cap for a stack.
   *
   * Resolution chain (mirrors _resolveSchedulingConfig):
   *   1. Stack CONFIG card `MAX_ITERATIONS:` — most specific override
   *   2. Board WORKFLOW rules card `MAX_ITERATIONS:` — board-wide default
   *   3. Code default: procedure ? 5 : 3
   *
   * The pipeline default of 3 is too few for a research/grounding stage that
   * web-researches, writes a profile to two surfaces, drafts a reply and moves
   * the card. Boards declare the cap they need in CONFIG rather than the cap
   * being hardcoded per workflow type. The resolved value is clamped to
   * [1, MAX_ITERATION_CEILING] so a typo cannot run cloud cost away.
   *
   * @param {Object} wb    - Workflow board descriptor (wb._plainDescription, wb.workflowType)
   * @param {Object} stack - Current stack (used to locate the CONFIG card)
   * @returns {number}
   * @private
   */
  _resolveMaxIterations(wb, stack) {
    const codeDefault = wb.workflowType === 'procedure' ? 5 : 3;

    const configCard = findConfigCard(stack);
    const stackPlain = configCard?.description ? stripHtml(configCard.description) : '';
    const boardPlain = wb._plainDescription || '';

    const raw = getConfigMarker(stackPlain, 'MAX_ITERATIONS')
      || getConfigMarker(boardPlain, 'MAX_ITERATIONS');
    if (raw === null) return codeDefault;

    const parsed = parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      // Non-integer or non-positive → fall through to code default
      return codeDefault;
    }
    if (parsed > MAX_ITERATION_CEILING) {
      console.warn(`[Workflow] MAX_ITERATIONS ${parsed} exceeds ceiling ${MAX_ITERATION_CEILING} — clamping`);
      return MAX_ITERATION_CEILING;
    }
    return parsed;
  }

  /**
   * Resolve scheduling CONFIG markers for a given stack/board.
   *
   * Reads HOURS:, TIMEZONE:, and SLOT_DURATION: markers from:
   *   1. Stack CONFIG card  — most specific override
   *   2. Board WORKFLOW rules card (wb._plainDescription) — board-wide default
   *   3. System timezone from Intl  (TIMEZONE only)
   *   4. Code defaults: Mon-Fri 09:00-17:00, system tz, 30 min
   *
   * Each marker resolves independently — a stack CONFIG can override TIMEZONE
   * while the board WORKFLOW card supplies HOURS.
   *
   * `hoursExplicit` is true only when a HOURS: marker was actually found
   * (at stack or board level).  The grounding block (Part 5) uses this flag
   * to decide whether to inject Section C (scheduling slots).
   *
   * @param {Object} wb    - Workflow board descriptor (wb._plainDescription)
   * @param {Object} stack - Current stack (used to locate the CONFIG card)
   * @returns {{
   *   hours: { days: Set<number>, startMinutes: number, endMinutes: number },
   *   timezone: string,
   *   slotDuration: number,
   *   hoursExplicit: boolean
   * }}
   * @private
   */
  _resolveSchedulingConfig(wb, stack) {
    const DEFAULT_HOURS     = { days: new Set([1, 2, 3, 4, 5]), startMinutes: 9 * 60, endMinutes: 17 * 60 };
    const DEFAULT_SLOT      = 30;
    const systemTz          = (() => {
      try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
      catch (_) { return 'UTC'; }
    })();

    const configCard  = findConfigCard(stack);
    const stackPlain  = configCard?.description ? stripHtml(configCard.description) : '';
    const boardPlain  = wb._plainDescription || '';

    // Marker extraction (trim included) is shared via module-level getConfigMarker.
    const _getMarker = getConfigMarker;

    // ── HOURS ──────────────────────────────────────────────────────────────
    // Resolution: stack CONFIG → board WORKFLOW → code default
    let hours = null;
    let hoursExplicit = false;
    const hoursRaw = _getMarker(stackPlain, 'HOURS') || _getMarker(boardPlain, 'HOURS');
    if (hoursRaw) {
      const parsed = parseHoursMarker(hoursRaw);
      if (parsed) {
        hours = parsed;
        hoursExplicit = true;
      }
      // Invalid value → fall through to code default (hoursExplicit stays false)
    }
    if (!hours) hours = DEFAULT_HOURS;

    // ── TIMEZONE ───────────────────────────────────────────────────────────
    // Resolution: stack CONFIG → board WORKFLOW → system tz → 'UTC'
    let timezone = systemTz;
    const tzRaw = _getMarker(stackPlain, 'TIMEZONE') || _getMarker(boardPlain, 'TIMEZONE');
    if (tzRaw) {
      // Validate: Intl.DateTimeFormat throws on unknown identifiers
      try {
        Intl.DateTimeFormat(undefined, { timeZone: tzRaw }).resolvedOptions();
        timezone = tzRaw;
      } catch (_) {
        // Unknown timezone string — fall through to system tz (already set)
        console.warn(`[Workflow] Unknown TIMEZONE value "${tzRaw}" — falling back to system tz`);
      }
    }

    // ── SLOT_DURATION ──────────────────────────────────────────────────────
    // Resolution: stack CONFIG → board WORKFLOW → code default (30 min)
    let slotDuration = DEFAULT_SLOT;
    const sdRaw = _getMarker(stackPlain, 'SLOT_DURATION') || _getMarker(boardPlain, 'SLOT_DURATION');
    if (sdRaw !== null) {
      const parsed = parseInt(sdRaw, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        slotDuration = parsed;
      }
      // Non-integer or non-positive → fall through to default
    }

    return { hours, timezone, slotDuration, hoursExplicit };
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
