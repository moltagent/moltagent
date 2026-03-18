/*
 * Moltagent - Sovereign AI Agent Platform
 * Copyright (C) 2026 Moltagent Contributors
 * AGPL-3.0
 */
'use strict';

/**
 * SelfRecovery - Deferred Retry via Personal Board
 *
 * Problem: When a multi-step operation partially succeeds, the failed tail
 *   must not be silently dropped. The agent needs a way to park the remainder
 *   so the heartbeat loop can pick it up later.
 * Pattern: Fire-and-forget card creation on the bot's Personal board.
 * Key Dependencies: PersonalBoardManager.
 * Data Flow: caller -> createRecoveryCard -> PersonalBoardManager.createPersonalCard -> Deck API.
 *
 * @module agent/self-recovery
 * @version 1.0.0
 */

class SelfRecovery {
  /**
   * @param {object} opts
   * @param {import('../integrations/personal-board-manager')} opts.personalBoardManager PersonalBoardManager instance
   * @param {object} opts.logger
   */
  constructor({ personalBoardManager, logger }) {
    this.deck = personalBoardManager;
    this.log = logger;
  }

  /**
   * Park a failed action as a recovery card on the Personal board Inbox.
   * Fire-and-forget: never throws, logs internally.
   *
   * @param {object} params
   * @param {string} params.originalRequest  User message that triggered the flow
   * @param {string} params.completedPart    What succeeded before the failure
   * @param {string} params.failedAction     The action that failed
   * @param {string} params.reason           Why it failed
   * @param {string} params.recoveryInstructions  What the heartbeat should do
   * @param {string} params.userId           Nextcloud user id
   * @param {string} [params.sessionId]      Chat session id
   */
  async createRecoveryCard({ originalRequest, completedPart, failedAction, reason, recoveryInstructions, userId, sessionId }) {
    try {
      const title = `Recover: ${failedAction}`.slice(0, 60);
      const description = [
        '## Recovery Card',
        '',
        `**User:** ${userId}`,
        sessionId ? `**Session:** ${sessionId}` : null,
        `**Failed action:** ${failedAction}`,
        `**Reason:** ${reason}`,
        '',
        '### What was completed',
        completedPart || '_Nothing completed before failure._',
        '',
        '### Original request',
        originalRequest || '_Not available._',
        '',
        '### Recovery instructions',
        recoveryInstructions || '_Retry the failed action._',
      ].filter(line => line !== null).join('\n');

      await this.deck.createPersonalCard({
        title,
        description,
        label: 'self-recovery',
      });

      this.log.info(`[SelfRecovery] Card created: ${title}`);
    } catch (err) {
      this.log.error(`[SelfRecovery] Failed to create recovery card: ${err.message}`);
    }
  }
}

module.exports = SelfRecovery;
