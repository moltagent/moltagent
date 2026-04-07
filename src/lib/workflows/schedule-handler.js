/*
 * Moltagent - Sovereign AI Security Layer
 * Copyright (C) 2026 Moltagent Contributors
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

/**
 * Workflow Schedule Handler
 *
 * Architecture Brief:
 * -------------------
 * Problem: Workflow boards can declare timed actions in their WORKFLOW: card
 * (e.g. "Every 24h: Scan NC News feeds"). The workflow engine processes cards
 * through stages but has no mechanism for periodic scheduled actions.
 *
 * Pattern: Self-gating timer. On each heartbeat pulse, parse SCHEDULE lines
 * from the board rules, check elapsed time against _lastRun timestamps, and
 * fire due actions through AgentLoop. The handler is generic — it passes the
 * schedule instruction to the LLM with available tools, letting the LLM
 * decide which capabilities to invoke.
 *
 * Key Dependencies:
 *   - AgentLoop (injected): .processWorkflowTask() for LLM execution
 *   - WorkflowBoard data: board rules card description containing SCHEDULE block
 *
 * Data Flow:
 *   parseScheduleBlock(description)  → [{ interval, action, hash }]
 *   isDue(boardId, hash)             → boolean (checks _lastRun)
 *   executeSchedule(wb, schedule)    → AgentLoop with board context + tools
 *
 * Dependency Map:
 *   ScheduleHandler
 *     ← WorkflowEngine._processBoard() (calls processSchedules per board)
 *     → AgentLoop.processWorkflowTask() (executes due actions)
 *
 * @module workflows/schedule-handler
 * @version 1.0.0
 */

'use strict';

const crypto = require('crypto');

// ─── HTML normalisation ──────────────────────────────────────────────

/**
 * Strip HTML tags from Deck rich-text descriptions and normalise to plain text.
 * Deck's rich editor stores content as HTML — block elements become newlines,
 * inline tags are removed, and HTML entities are decoded.
 * @param {string} html - Raw card description (may be HTML or plain text)
 * @returns {string} Plain text with one line per block element
 */
function stripHtml(html) {
  if (!html) return '';

  let text = html;
  // Block-level elements → newline before content
  text = text.replace(/<\/?(p|div|br|li|ul|ol|h[1-6]|tr|blockquote|pre|hr)\b[^>]*\/?>/gi, '\n');
  // Strip all remaining tags
  text = text.replace(/<[^>]+>/g, '');
  // Decode common HTML entities
  text = text.replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
  // Strip Markdown bold/italic markers: **text**, __text__, *text*, _text_
  text = text.replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1');
  text = text.replace(/_{1,2}([^_]+)_{1,2}/g, '$1');
  // Collapse runs of whitespace-only lines into single newlines, trim
  text = text.replace(/\n[ \t]*\n/g, '\n').trim();
  return text;
}

// ─── Schedule line parsing ────────────────────────────────────────────

/**
 * Parse interval strings like "Every 24h", "Every 30d", "Every 12h".
 * @param {string} intervalStr - e.g. "Every 24h", "every 7d"
 * @returns {number|null} Interval in milliseconds, or null if unparseable
 */
function parseInterval(intervalStr) {
  if (!intervalStr) return null;
  const match = intervalStr.trim().match(/^every\s+(\d+)\s*(h|d)$/i);
  if (!match) return null;

  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  if (!Number.isFinite(value) || value <= 0) return null;

  if (unit === 'h') return value * 60 * 60 * 1000;
  if (unit === 'd') return value * 24 * 60 * 60 * 1000;
  return null;
}

/**
 * Parse SCHEDULE block from a WORKFLOW: card description.
 *
 * Expected format in the card description:
 * ```
 * SCHEDULE:
 * Every 24h: Scan NC News feeds
 * Every 7d: Archive stale Tracking cards
 * ```
 *
 * Also supports inline format: `SCHEDULE: Every 24h: Do something`
 *
 * @param {string} description - Full card description text
 * @returns {Array<{ interval: number, action: string, hash: string, raw: string }>}
 */
/**
 * Extract trailing LLM routing directive from an action string.
 * "Scan feeds. LLM: cloud"      → { action: "Scan feeds.", allowCloud: true, cloudTier: null }
 * "Scan feeds. LLM: cloud-fast" → { action: "Scan feeds.", allowCloud: true, cloudTier: 'fast' }
 * "Scan feeds. LLM: local"      → { action: "Scan feeds.", allowCloud: false, cloudTier: null }
 * @param {string} raw - Action text, possibly with trailing "LLM: cloud[-fast]" or "LLM: local"
 * @returns {{ action: string, allowCloud: boolean, cloudTier: string|null }}
 */
function _extractLlmDirective(raw) {
  const match = raw.match(/^(.*?)\.\s*LLM:\s*(cloud-fast|cloud|local)\s*$/i);
  if (!match) return { action: raw, allowCloud: false, cloudTier: null };
  const directive = match[2].toLowerCase();
  return {
    action: match[1].trim() + '.',
    allowCloud: directive.startsWith('cloud'),
    cloudTier: directive === 'cloud-fast' ? 'fast' : null
  };
}

/**
 * Parse multi-phase schedule action.
 * "Phase 1: Scan feeds. LLM: cloud-fast | Phase 2: Write drafts. LLM: cloud"
 * → [{ action, allowCloud, cloudTier }, ...]
 * Returns null if no phases detected (single-action schedule).
 * @param {string} raw - Full action text after interval
 * @returns {Array|null} Array of phase objects, or null for single-action
 */
function _parsePhases(raw) {
  if (!raw || !raw.includes('Phase 1:')) return null;
  const parts = raw.split(/\s*\|\s*/);
  if (parts.length < 2) return null;

  const phases = [];
  for (const part of parts) {
    const phaseMatch = part.match(/^Phase\s+\d+:\s*(.+)$/i);
    if (!phaseMatch) continue;
    phases.push(_extractLlmDirective(phaseMatch[1].trim()));
  }
  return phases.length >= 2 ? phases : null;
}

function parseScheduleBlock(description) {
  if (!description) return [];

  const plain = stripHtml(description);
  const schedules = [];
  const lines = plain.split('\n');
  let inScheduleBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect start of SCHEDULE block
    if (/^SCHEDULE:\s*$/i.test(trimmed)) {
      inScheduleBlock = true;
      continue;
    }

    // Inline format: "SCHEDULE: Every 24h: Do something"
    const inlineMatch = trimmed.match(/^SCHEDULE:\s*(every\s+\d+\s*[hd]):\s*(.+)$/i);
    if (inlineMatch) {
      const intervalMs = parseInterval(inlineMatch[1]);
      if (intervalMs) {
        const rawAction = inlineMatch[2].trim();
        const phases = _parsePhases(rawAction);
        const { action, allowCloud, cloudTier } = phases ? phases[0] : _extractLlmDirective(rawAction);
        schedules.push({
          interval: intervalMs,
          action,
          allowCloud,
          cloudTier,
          phases: phases || null,
          hash: _hashScheduleLine(inlineMatch[1], rawAction),
          raw: trimmed
        });
      }
      continue;
    }

    // Inside a SCHEDULE block — parse "Every Xh/Xd: action" lines
    if (inScheduleBlock) {
      // Skip blank lines (HTML stripping can leave gaps between entries)
      if (!trimmed) continue;
      // Strip leading list markers: "- ", "* ", "1. ", "• "
      const stripped = trimmed.replace(/^[-*•]\s+|^\d+\.\s+/, '');
      // New section header ends the block
      if (/^[A-Z][A-Z _-]+:/.test(stripped) && !stripped.startsWith('Every')) {
        inScheduleBlock = false;
        continue;
      }

      const schedMatch = stripped.match(/^(every\s+\d+\s*[hd]):\s*(.+)$/i);
      if (schedMatch) {
        const intervalMs = parseInterval(schedMatch[1]);
        if (intervalMs) {
          const rawAction = schedMatch[2].trim();
          const phases = _parsePhases(rawAction);
          const { action, allowCloud, cloudTier } = phases ? phases[0] : _extractLlmDirective(rawAction);
          schedules.push({
            interval: intervalMs,
            action,
            allowCloud,
            cloudTier,
            phases: phases || null,
            hash: _hashScheduleLine(schedMatch[1], rawAction),
            raw: trimmed
          });
        }
      }
    }
  }

  return schedules;
}

/**
 * Find a CONFIG: card in a stack — first card whose title starts with "CONFIG:".
 * @param {Object} stack - Deck stack with .cards array
 * @returns {Object|null} The config card, or null
 */
function findConfigCard(stack) {
  if (!stack?.cards) return null;
  return stack.cards.find(c =>
    c && !c.archived && !c.deletedAt &&
    /^CONFIG:\s*/i.test((c.title || '').trim())
  ) || null;
}

/**
 * Stable hash for a schedule line (interval + action).
 * Used as key in _lastRun map.
 */
function _hashScheduleLine(interval, action) {
  return crypto.createHash('md5')
    .update(`${interval.toLowerCase().replace(/\s+/g, '')}:${action.toLowerCase()}`)
    .digest('hex')
    .substring(0, 12);
}

// ─── ScheduleHandler class ───────────────────────────────────────────

class ScheduleHandler {
  /**
   * @param {Object} options
   * @param {Object} options.agentLoop - AgentLoop instance
   * @param {Object} [options.budgetEnforcer] - BudgetEnforcer (optional)
   */
  constructor({ agentLoop, budgetEnforcer }) {
    this.agent = agentLoop;
    this.budgetEnforcer = budgetEnforcer || null;

    /**
     * Last run timestamps: Map<boardId, Map<scheduleHash, timestamp>>
     * Persists across pulses within a session. Reset on daily reset.
     */
    this._lastRun = new Map();
  }

  /**
   * Process all SCHEDULE lines for a workflow board.
   * Called from WorkflowEngine._processBoard() after card processing.
   *
   * @param {Object} wb - Workflow board object from WorkflowBoardDetector
   * @param {Object} wb.board - Board object with .id, .title
   * @param {string} wb.description - WORKFLOW: card description (contains SCHEDULE block)
   * @param {Array} wb.stacks - Stacks with cards
   * @param {Object} [options={}]
   * @param {boolean} [options.forceLocal=false] - Force local LLM (from board MODEL directive)
   * @returns {Promise<{ executed: number, skipped: number, errors: number }>}
   */
  async processSchedules(wb, options = {}) {
    const result = { executed: 0, skipped: 0, errors: 0 };
    const schedules = parseScheduleBlock(wb.description);

    console.log(`[Schedule] Parsed ${schedules.length} schedule(s) from "${wb.board.title}"`);
    if (schedules.length === 0) return result;

    for (const schedule of schedules) {
      try {
        if (!this._isDue(wb.board.id, schedule)) {
          result.skipped++;
          continue;
        }

        // Budget check
        if (this.budgetEnforcer) {
          const check = this.budgetEnforcer.canSpend('cloud', 0.03);
          if (!check.allowed) {
            console.log(`[Schedule] Budget exceeded for "${schedule.action}" — skipping`);
            result.skipped++;
            continue;
          }
        }

        console.log(`[Schedule] Executing: "${schedule.action}" on board "${wb.board.title}"`);

        await this._executeSchedule(wb, schedule, options);
        this._markRun(wb.board.id, schedule);
        result.executed++;
      } catch (err) {
        console.error(`[Schedule] Error executing "${schedule.action}":`, err.message);
        // Still mark as run to prevent retry-storm on persistent errors
        this._markRun(wb.board.id, schedule);
        result.errors++;
      }
    }

    return result;
  }

  /**
   * Check if a schedule is due to run.
   * @private
   */
  _isDue(boardId, schedule) {
    const boardRuns = this._lastRun.get(boardId);
    if (!boardRuns) return true;

    const lastRun = boardRuns.get(schedule.hash);
    if (!lastRun) return true;

    return Date.now() - lastRun >= schedule.interval;
  }

  /**
   * Record that a schedule has been executed.
   * @private
   */
  _markRun(boardId, schedule) {
    if (!this._lastRun.has(boardId)) {
      this._lastRun.set(boardId, new Map());
    }
    this._lastRun.get(boardId).set(schedule.hash, Date.now());
  }

  /**
   * Build board context (rules + CONFIG cards) for schedule system prompts.
   * @private
   */
  _buildBoardContext(wb) {
    const { board, description, stacks } = wb;
    const configContextParts = [];
    for (const stack of stacks) {
      const configCard = findConfigCard(stack);
      if (configCard) {
        configContextParts.push(
          '═══════════════════════════════════════════',
          `MANDATORY OPERATING INSTRUCTIONS FOR STACK "${stack.title}"`,
          'These rules are set by the board operator. You MUST follow',
          'them exactly. Violating these instructions is a system error.',
          '═══════════════════════════════════════════',
          '',
          stripHtml(configCard.description) || '(empty)',
          '',
          '═══════════════════════════════════════════',
          'END OF MANDATORY INSTRUCTIONS',
          '═══════════════════════════════════════════',
          ''
        );
      }
    }
    return {
      boardHeader: [
        `**Board:** ${board.title} (ID: ${board.id})`,
        `**Board Rules:**`,
        stripHtml(description),
      ],
      configContext: configContextParts.length > 0 ? [
        '', ...configContextParts,
      ] : [],
      stackList: [
        `**All Stacks:**`,
        stacks.map(s => `  - "${s.title}" (ID: ${s.id}, ${(s.cards || []).length} cards)`).join('\n'),
      ],
      pausedWarning: Array.isArray(wb._pausedStacks) && wb._pausedStacks.length > 0
        ? [
          '',
          `**PAUSED STACKS (do NOT create, move, or modify cards in these):** ${wb._pausedStacks.map(n => `"${n}"`).join(', ')}`,
          ''
        ]
        : []
    };
  }

  /**
   * Execute a schedule action via AgentLoop.
   * Supports single-action and multi-phase schedules.
   * @private
   */
  async _executeSchedule(wb, schedule, options = {}) {
    if (schedule.phases) {
      await this._executeMultiPhase(wb, schedule, options);
    } else {
      await this._executeSingleAction(wb, schedule, options);
    }
  }

  /**
   * Execute a single-action schedule (no phases).
   * @private
   */
  async _executeSingleAction(wb, schedule, options = {}) {
    const ctx = this._buildBoardContext(wb);

    const systemAddition = [
      '## Scheduled Workflow Action',
      '',
      'You are executing a scheduled action for a workflow board.',
      '',
      ...ctx.boardHeader,
      '',
      ...ctx.configContext,
      ...ctx.stackList,
      ...ctx.pausedWarning,
      '',
      '**Scheduled Action:**',
      schedule.action,
      '',
      '**Instructions:**',
      'Execute the scheduled action described above using the available tools.',
      'Follow the board rules and any CONFIG context for evaluation criteria.',
      'Use workflow_deck_* tools with numeric IDs for card operations.',
      'Use news_* tools for RSS feed operations.',
      'Be thorough but efficient — process all items in a single pass.',
    ].join('\n');

    await this.agent.processWorkflowTask({
      systemAddition,
      task: `Execute scheduled action: "${schedule.action}"`,
      boardId: wb.board.id,
      cardId: 0,
      stackId: 0,
      forceLocal: options.forceLocal || false,
      allowCloud: schedule.allowCloud || false,
      cloudTier: schedule.cloudTier || null,
      maxIterations: 8
    });
  }

  /**
   * Execute a multi-phase schedule. Each phase runs as a separate workflow task.
   * Phase 1 output feeds into Phase 2 context. Only PICK items proceed.
   * @private
   */
  async _executeMultiPhase(wb, schedule, options = {}) {
    const ctx = this._buildBoardContext(wb);
    let previousOutput = null;

    for (let i = 0; i < schedule.phases.length; i++) {
      const phase = schedule.phases[i];
      const phaseNum = i + 1;

      console.log(`[Schedule] Phase ${phaseNum}/${schedule.phases.length}: "${phase.action}" (${phase.allowCloud ? (phase.cloudTier === 'fast' ? 'cloud-fast' : 'cloud') : 'local'})`);

      const systemParts = [
        `## Scheduled Workflow Action — Phase ${phaseNum}/${schedule.phases.length}`,
        '',
        'You are executing a scheduled action for a workflow board.',
        '',
        ...ctx.boardHeader,
        '',
        ...ctx.configContext,
        ...ctx.stackList,
        ...ctx.pausedWarning,
        '',
        `**Phase ${phaseNum} Action:**`,
        phase.action,
      ];

      if (previousOutput) {
        systemParts.push(
          '',
          `**Output from Phase ${phaseNum - 1}:**`,
          previousOutput,
          '',
          'Only process items marked PICK from the previous phase. Skip items marked SKIP.'
        );
      }

      systemParts.push(
        '',
        '**Instructions:**',
        'Execute the phase action using the available tools.',
        'Follow the board rules and any CONFIG context.',
        'Use workflow_deck_* tools with numeric IDs for card operations.',
        'Use news_* tools for RSS feed operations.',
      );

      if (phaseNum < schedule.phases.length) {
        systemParts.push(
          '',
          '**Output format:** For each item, output PICK or SKIP with a one-line reason.',
          'Example: PICK: "Article title" — relevant to criteria',
          'Example: SKIP: "Article title" — off-topic'
        );
      }

      const systemAddition = systemParts.join('\n');

      const result = await this.agent.processWorkflowTask({
        systemAddition,
        task: `Execute phase ${phaseNum}: "${phase.action}"`,
        boardId: wb.board.id,
        cardId: 0,
        stackId: 0,
        forceLocal: options.forceLocal || false,
        allowCloud: phase.allowCloud || false,
        cloudTier: phase.cloudTier || null,
        maxIterations: phaseNum < schedule.phases.length ? 3 : 8
      });

      previousOutput = typeof result === 'string' ? result : null;
    }
  }

  /**
   * Reset all timing state. Called on daily reset.
   */
  resetState() {
    this._lastRun.clear();
  }
}

module.exports = { ScheduleHandler, parseScheduleBlock, parseInterval, findConfigCard, stripHtml, _extractLlmDirective, _parsePhases };
