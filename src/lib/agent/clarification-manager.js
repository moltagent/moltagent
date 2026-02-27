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
 * ClarificationManager — Coordinates pending-clarification bypass for the
 * message processing pipeline.
 *
 * Architecture Brief:
 * - Problem: When an executor asks a follow-up question (e.g. "What should I
 *   call this event?"), the user's short reply gets re-classified as chitchat
 *   and the domain context is lost.
 * - Pattern: Before classification, check SessionManager for a pending
 *   clarification. If found, bypass classification and route directly back
 *   to the waiting executor's resumeWithClarification() method.
 * - Key Dependencies: SessionManager (storage), executor instances (handlers)
 * - Data Flow: check() → bypass decision → resolve() → executor.resumeWithClarification()
 *
 * @module agent/clarification-manager
 * @version 1.0.0
 */

const CANCEL_PHRASES = new Set([
  'cancel', 'nevermind', 'forget it', 'nvm', 'skip', 'abort',
  'actually no', 'never mind', 'forget that', 'stop'
]);

class ClarificationManager {
  /**
   * @param {Object} config
   * @param {Object} config.sessionManager - SessionManager instance
   * @param {Object} config.executors - Map of domain name → executor instance
   * @param {Object} [config.logger] - Logger instance
   */
  constructor(config = {}) {
    if (!config.sessionManager) throw new Error('ClarificationManager requires sessionManager');
    this.sessionManager = config.sessionManager;
    this.executors = config.executors || {};
    this.logger = config.logger || console;
  }

  /**
   * Check whether the current message should bypass classification and
   * resume a pending clarification flow.
   *
   * Called synchronously before classification in MessageProcessor.
   *
   * @param {Object} session - Session object from SessionManager
   * @param {string} message - Raw user message text
   * @returns {{ bypass: boolean, cancelled?: boolean, response?: string,
   *             handler?: Object, clarification?: Object }}
   */
  check(session, message) {
    if (!session || !message) return { bypass: false };

    const pending = this.sessionManager.getPendingClarification(session);
    if (!pending) return { bypass: false };

    const normalised = message.trim().toLowerCase();

    // Cancel phrase detection
    if (CANCEL_PHRASES.has(normalised)) {
      this.sessionManager.clearPendingClarification(session);
      return { bypass: true, cancelled: true, response: 'No problem, cancelled.' };
    }

    // Look up the executor that asked the question
    const handler = this.executors[pending.executor];
    if (!handler || typeof handler.resumeWithClarification !== 'function') {
      this.logger.warn(`[ClarificationManager] Handler "${pending.executor}" missing or lacks resumeWithClarification — clearing`);
      this.sessionManager.clearPendingClarification(session);
      return { bypass: false };
    }

    return {
      bypass: true,
      handler,
      clarification: { ...pending, userResponse: message.trim() }
    };
  }

  /**
   * Execute the clarification resumption — call the executor's
   * resumeWithClarification() and manage session state.
   *
   * @param {Object} handler - Executor instance with resumeWithClarification()
   * @param {Object} clarification - Clarification object with userResponse
   * @param {Object} context - { session, roomToken, userId }
   * @returns {Promise<{ response: string, pendingClarification?: Object }>}
   */
  async resolve(handler, clarification, context) {
    const { session } = context;

    try {
      const result = await handler.resumeWithClarification(clarification, {
        userName: context.userId,
        roomToken: context.roomToken
      });

      // Always clear the current pending clarification
      this.sessionManager.clearPendingClarification(session);

      // If handler returns a new pendingClarification (chained question), set it
      if (result && result.pendingClarification) {
        this.sessionManager.setPendingClarification(session, result.pendingClarification);
      }

      return {
        response: (result && result.response) || (typeof result === 'string' ? result : 'Done.')
      };
    } catch (err) {
      this.logger.error(`[ClarificationManager] Resume failed: ${err.message}`);
      this.sessionManager.clearPendingClarification(session);
      return { response: 'Something went wrong resuming that action. Could you start over?' };
    }
  }
}

module.exports = ClarificationManager;
