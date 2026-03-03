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

/**
 * ReferenceResolver — Pre-routing reference resolution.
 *
 * Architecture Brief:
 * - Problem: Executors receive messages with unresolved references ("that", "the biggest one")
 *   and either hallucinate or ask for clarification on things already known from context.
 * - Pattern: One LLM call before classification. Sees conversation context + last action,
 *   rewrites ambiguous references into explicit values. Returns original if nothing to resolve.
 * - Key Dependencies: LLM Router (local model, zero cloud cost)
 * - Data Flow: raw message + context → heuristic gates → LLM rewrite → enriched message
 *
 * @module agent/reference-resolver
 * @version 1.0.0
 */

/** Reference patterns that indicate a message may need resolution */
const REFERENCE_PATTERNS = [
  /\b(that|this|it|those|these|them)\b/i,                   // pronouns
  /\b(the same|the one|the first|the last)\b/i,            // definite references
  /\b(biggest|smallest|newest|oldest|latest|most recent)\b/i, // superlatives
  /\b(previous|above|earlier|just now|you just)\b/i,       // temporal references
  /\b(again|also|too|as well)\b/i,                         // repetition references
  /\b(save|move|copy|share|send|post|write)\b.*\b(it|that|this|there)\b/i, // cross-domain action+ref
];

/** Patterns indicating the message is already explicit (no resolution needed) */
const EXPLICIT_PATH_PATTERN = /[\w-]+\.(md|pdf|docx|txt|json|yaml|yml|xlsx|xls|csv|png|jpg|html|xml|py|js|sh)\b/i;
const EXPLICIT_QUOTED_PATTERN = /"[^"]{3,}"/;

const NOOP_RESULT = Object.freeze({ enrichedMessage: null, wasEnriched: false, resolvedRefs: [] });

class ReferenceResolver {
  /**
   * @param {Object} options
   * @param {Object} options.router - LLM router (router.route())
   * @param {Object} [options.logger]
   */
  constructor({ router, logger } = {}) {
    this.router = router;
    this.logger = logger || console;
  }

  /**
   * Resolve references in a user message using conversation context.
   *
   * @param {string} message - Raw user message
   * @param {Object} context
   * @param {Array} [context.recentTurns] - Last N conversation turns [{role, content}]
   * @param {Object|null} [context.lastAction] - Last action from the action ledger
   * @param {string|null} [context.lastAssistantMessage] - Molti's last response
   * @returns {Promise<{enrichedMessage: string|null, wasEnriched: boolean, resolvedRefs: Array}>}
   */
  async resolve(message, context = {}) {
    if (!message || typeof message !== 'string') return NOOP_RESULT;

    // Gate 1: No context to resolve against
    if (!context.recentTurns?.length && !context.lastAction && !context.lastAssistantMessage) {
      return NOOP_RESULT;
    }

    // Gate 2: Message is already explicit (has filenames, paths, quoted strings)
    if (this._isExplicit(message)) return NOOP_RESULT;

    // Gate 3: Message has no reference patterns to resolve
    if (!this._hasReferences(message)) return NOOP_RESULT;

    // Gate 4: Router not available
    if (!this.router) return NOOP_RESULT;

    try {
      return await this._resolveViaLLM(message, context);
    } catch (err) {
      this.logger.warn?.(`[ReferenceResolver] Resolution failed, using original: ${err.message}`);
      return NOOP_RESULT;
    }
  }

  /**
   * Detect messages that likely contain unresolved references.
   * @param {string} message
   * @returns {boolean}
   */
  _hasReferences(message) {
    return REFERENCE_PATTERNS.some(p => p.test(message));
  }

  /**
   * Detect messages that are already fully explicit.
   * @param {string} message
   * @returns {boolean}
   */
  _isExplicit(message) {
    if (EXPLICIT_PATH_PATTERN.test(message)) return true;
    if (EXPLICIT_QUOTED_PATTERN.test(message)) return true;
    return false;
  }

  /**
   * Core resolution via LLM (local model — fast, zero cloud cost).
   * @param {string} message
   * @param {Object} context
   * @returns {Promise<{enrichedMessage: string, wasEnriched: boolean, resolvedRefs: Array}>}
   */
  async _resolveViaLLM(message, context) {
    const prompt = this._buildPrompt(message, context);

    const result = await this.router.route({
      job: 'quick',
      content: prompt,
      requirements: { maxTokens: 300, temperature: 0.1 }
    });

    const response = (result?.result || '').trim();

    // If LLM returned UNCHANGED or empty, no enrichment
    if (!response || response === 'UNCHANGED' || response === message) {
      return NOOP_RESULT;
    }

    // Strip any quotes the model may have wrapped around the rewrite
    const cleaned = response.replace(/^["']|["']$/g, '').trim();
    if (!cleaned || cleaned === message) return NOOP_RESULT;

    this.logger.log?.(`[ReferenceResolver] "${message}" → "${cleaned}"`);
    return { enrichedMessage: cleaned, wasEnriched: true, resolvedRefs: [] };
  }

  /**
   * Build the resolution prompt with conversation context.
   * @param {string} message
   * @param {Object} context
   * @returns {string}
   */
  _buildPrompt(message, context) {
    const parts = [];

    parts.push(`You are a reference resolver. Rewrite the user message so ambiguous references are replaced with explicit values from the conversation context.

RULES:
- Replace pronouns and vague references with the specific thing they refer to
- Keep the user's intent and tone intact
- If a reference is to content from the assistant's last response, include enough to identify it (title, key phrase) — do NOT paste the entire response
- If the message has no ambiguous references, respond with exactly: UNCHANGED
- If you cannot confidently resolve a reference, leave it as-is rather than guessing
- Be concise — this is a rewrite, not a response to the user
- Never add information the user didn't request
- Preserve the action verb (read, save, write, share, delete, move, etc.)
- For file references like "the biggest one", resolve to the actual filename from the listing

CONVERSATION CONTEXT:`);

    // Recent turns (last 4)
    if (context.recentTurns?.length) {
      for (const turn of context.recentTurns.slice(-4)) {
        const role = turn.role === 'assistant' ? 'Molti' : 'User';
        const content = typeof turn.content === 'string'
          ? turn.content.slice(0, 500)
          : '';
        if (content) parts.push(`${role}: ${content}`);
      }
    }

    // Last action summary
    if (context.lastAction) {
      const actionStr = typeof context.lastAction === 'string'
        ? context.lastAction
        : JSON.stringify(context.lastAction).slice(0, 1000);
      parts.push(`\nLAST ACTION: ${actionStr}`);
    }

    // Last assistant message
    if (context.lastAssistantMessage) {
      parts.push(`\nMOLTI'S LAST RESPONSE (truncated): ${context.lastAssistantMessage.slice(0, 800)}`);
    }

    parts.push(`\nUSER MESSAGE TO REWRITE: "${message}"\n\nREWRITTEN MESSAGE (or UNCHANGED if no references need resolving):`);

    return parts.join('\n');
  }
}

module.exports = { ReferenceResolver };
