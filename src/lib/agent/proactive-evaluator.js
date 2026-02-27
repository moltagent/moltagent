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
 * ProactiveEvaluator — Post-Response Background Intelligence
 *
 * Architecture Brief:
 * -------------------
 * Problem: When a user mentions a person, company, or deadline, the primary
 * handler responds to the direct request but doesn't persist knowledge or
 * create implicit tasks. Knowledge gaps, implied tasks, and entity mentions
 * evaporate after the response.
 *
 * Pattern: Two-stage post-response hook. Stage 1 (triage) uses local LLM
 * to cheaply decide if proactive action is warranted. Stage 2 (action)
 * fires a full AgentLoop call with wiki/deck tools when triage says yes.
 * Runs asynchronously — never blocks the user's response.
 *
 * Key Dependencies:
 * - LLMRouter (for cheap local triage via 'quick' job)
 * - AgentLoop (for tool-calling action stage with full registry)
 * - TalkSendQueue (for subtle follow-up notifications)
 *
 * Data Flow:
 * - MessageProcessor sends response to Talk
 * - Fires evaluate() as fire-and-forget (not awaited)
 * - _isTrivial() → fast heuristic filter (no LLM)
 * - _triage() → local LLM 'quick' job: "yes" or "no"
 * - _executeProactive() → AgentLoop with proactive prompt + full tools
 * - Optional notification sent to same room
 *
 * @module agent/proactive-evaluator
 * @version 1.0.0
 */

'use strict';

class ProactiveEvaluator {
  /**
   * @param {Object} opts
   * @param {Object} opts.agentLoop - AgentLoop instance (has tools, LLM access)
   * @param {Object} opts.llmRouter - LLMRouter for local triage (route with job:'quick')
   * @param {Object} opts.talkSendQueue - TalkSendQueue for follow-up notifications
   * @param {Object} [opts.config] - Configuration
   * @param {number} [opts.config.proactiveMinLevel=3] - Minimum initiative level
   * @param {Function} [opts.config.getInitiativeLevel] - Live getter for initiative level (e.g. from HeartbeatManager.settings)
   * @param {number} [opts.config.initiativeLevel] - Static fallback if no getter
   */
  constructor({ agentLoop, llmRouter, talkSendQueue, config } = {}) {
    this.agentLoop = agentLoop || null;
    this.llmRouter = llmRouter || null;
    this.talk = talkSendQueue || null;
    this.config = config || {};
    const rawMin = parseInt(this.config.proactiveMinLevel || '3', 10);
    this.minLevel = Number.isFinite(rawMin) ? rawMin : 3;
  }

  /**
   * Called AFTER the primary response has been sent.
   * Runs asynchronously — does not block the user.
   *
   * @param {Object} context
   * @param {string} context.userMessage - What the user said
   * @param {string} context.assistantResponse - What the handler replied
   * @param {string} context.classification - How the message was classified
   * @param {Object} [context.actionRecord] - Layer 3 action record (if any)
   * @param {Object} [context.session] - The session object
   * @param {string} context.roomToken - For sending follow-up notifications
   * @returns {Promise<{acted: boolean, reason?: string, result?: Object}>}
   */
  async evaluate(context) {
    try {
      const level = this._getInitiativeLevel();
      if (level < this.minLevel) {
        return { acted: false, reason: 'initiative_too_low' };
      }

      if (this._isTrivial(context)) {
        return { acted: false, reason: 'trivial' };
      }

      const shouldAct = await this._triage(context);
      if (!shouldAct) {
        return { acted: false, reason: 'triage_negative' };
      }

      const result = await this._executeProactive(context);

      if (result && result.notification && this.talk && context.roomToken) {
        await this.talk.enqueue(context.roomToken, result.notification);
      }

      console.log('[Proactive] Action taken:', result?.type || 'unknown');
      return { acted: true, result };
    } catch (err) {
      console.error('[Proactive] Error (non-fatal):', err.message);
      return { acted: false, reason: 'error', error: err.message };
    }
  }

  /**
   * Quick filter: skip messages that obviously don't need proactive action.
   * No LLM call — pure heuristics.
   * @param {Object} context
   * @returns {boolean}
   */
  _isTrivial(context) {
    const msg = (context.userMessage || '').trim();

    if (msg.length < 15) return true;
    if (context.classification === 'greeting') return true;
    if (context.classification === 'confirmation') return true;
    if (context.classification === 'selection') return true;

    return false;
  }

  /**
   * Stage 1: Local LLM triage.
   * Ask the local model: "Does this conversation contain entities, tasks,
   * or decisions worth persisting?"
   * Routes via 'quick' job — local-first, fast, zero cloud cost.
   *
   * @param {Object} context
   * @returns {Promise<boolean>}
   */
  async _triage(context) {
    if (!this.llmRouter) return false;

    const prompt = `You are a triage filter. Read this conversation exchange and decide:
Does it contain ANY of the following?
1. A person, company, or project name the agent should remember
2. A task, deadline, or commitment that should become a task card
3. A decision or agreement worth recording in the knowledge base
4. Information about someone or something worth updating an existing wiki page

Conversation:
User: ${(context.userMessage || '').substring(0, 500)}
Assistant: ${(context.assistantResponse || '').substring(0, 300)}

Answer ONLY "yes" or "no". Nothing else.`;

    try {
      const result = await this.llmRouter.route({
        job: 'quick',
        content: prompt,
        context: { source: 'proactive_triage' }
      });
      const answer = (result?.result || '').trim().toLowerCase();
      return answer.startsWith('yes');
    } catch (err) {
      console.warn('[Proactive] Triage failed, skipping:', err.message);
      return false;
    }
  }

  /**
   * Stage 2: Execute the proactive action.
   * Uses AgentLoop with full tool access + proactive-specific system prompt.
   *
   * @param {Object} context
   * @returns {Promise<Object|null>}
   */
  async _executeProactive(context) {
    if (!this.agentLoop) return null;

    const recentContext = this._buildContextSummary(context);

    const proactivePrompt = `You just observed this conversation between a user and an AI assistant.
Your job is to take BACKGROUND ACTIONS that persist useful knowledge and track commitments.
You are NOT replying to the user. They already got their response. You are the agent's memory and task system.

${recentContext}

The exchange you're evaluating:
User: ${(context.userMessage || '').substring(0, 800)}
Assistant: ${(context.assistantResponse || '').substring(0, 500)}
Classification: ${context.classification || 'unknown'}
${context.actionRecord ? `Action taken: ${JSON.stringify(context.actionRecord)}` : ''}

DO the following as needed (only if genuinely useful, not for every message):

1. **Knowledge gaps:** If a person, company, or project was mentioned that might not have a wiki page:
   - Search the wiki first: wiki_search("{name}")
   - If no page exists AND the entity seems important to the user's work:
     - wiki_write a stub page in the appropriate section (People/, Companies/, Projects/)
     - Set confidence: low, decay_days: 14
     - Include what you learned from the conversation
   - Do NOT create pages for generic concepts, only for specific entities relevant to this user.

2. **Implied tasks:** If the user committed to something or a deadline was mentioned that wasn't already tracked:
   - deck_create_card with title and due date
   - Only if the task wasn't already created as part of the primary response

3. **Knowledge updates:** If new information was shared about a person/project that already has a wiki page:
   - wiki_search first, then wiki_write to update

4. **Do nothing** if the conversation was routine (simple calendar check, file listing, small talk).

After completing any actions, output a SINGLE LINE starting with "NOTIFY:" describing what you did.
If you took no action, output "NOTIFY: none".
Example: "NOTIFY: Created knowledge page for Sarah (ManeraMedia) and task card for proposal deadline"`;

    try {
      const result = await this.agentLoop.process(proactivePrompt, context.roomToken, {
        source: 'proactive_evaluator',
        maxIterations: 4
      });

      const notification = this._extractNotification(result);

      return {
        type: 'proactive_action',
        notification: notification !== 'none' ? `\ud83d\udca1 ${notification}` : null,
        rawResult: result
      };
    } catch (err) {
      console.error('[Proactive] Execution failed:', err.message);
      return null;
    }
  }

  /**
   * Build context summary from session state.
   * @param {Object} context
   * @returns {string}
   */
  _buildContextSummary(context) {
    const parts = [];

    if (context.session?.actionLedger?.length > 0) {
      const recent = context.session.actionLedger.slice(-3);
      parts.push('Recent actions by the assistant:');
      for (const a of recent) {
        parts.push(`- ${a.type}: ${JSON.stringify(a.refs || {})}`);
      }
    }

    return parts.length > 0 ? parts.join('\n') : '';
  }

  /**
   * Extract the NOTIFY: line from the AgentLoop result.
   * @param {*} result
   * @returns {string}
   */
  _extractNotification(result) {
    if (!result) return 'none';

    const text = typeof result === 'string' ? result : (result.response || result.content || '');
    const match = text.match(/NOTIFY:\s*(.+)/i);
    if (match) return match[1].trim();

    return 'none';
  }

  /**
   * Get current initiative level.
   * @returns {number}
   */
  _getInitiativeLevel() {
    // Prefer live getter (reads HeartbeatManager.settings.initiativeLevel),
    // fall back to static config, then env, then default 2.
    if (typeof this.config.getInitiativeLevel === 'function') {
      const live = this.config.getInitiativeLevel();
      if (Number.isFinite(live)) return live;
    }
    const raw = parseInt(
      this.config.initiativeLevel ||
      process.env.INITIATIVE_LEVEL ||
      '2',
      10
    );
    return Number.isFinite(raw) ? raw : 2;
  }
}

module.exports = { ProactiveEvaluator };
