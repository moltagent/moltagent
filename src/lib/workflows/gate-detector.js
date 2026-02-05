'use strict';

/**
 * GateDetector
 *
 * GATE cards are human checkpoints in a workflow. Any card containing
 * "GATE", "wait for human", "wait for approval", or "approval required"
 * in its title or description is treated as a gate.
 *
 * The agent stops processing at gates and notifies the human.
 * When the human comments with approved/rejected,
 * the gate is considered resolved.
 *
 * @module workflows/gate-detector
 */
class GateDetector {

  static GATE_PATTERNS = [
    /\bGATE\b/i,
    /wait\s+for\s+(human|approval|review|sign-?off)/i,
    /approval\s+required/i,
    /human\s+(review|check|confirm)/i
  ];

  static APPROVE_PATTERNS = [
    /\u2705/,           // checkmark emoji
    /\bapproved?\b/i,
    /\blgtm\b/i,
    /\bgood\s+to\s+go\b/i,
    /\bconfirmed?\b/i
  ];

  static REJECT_PATTERNS = [
    /\u274C/,           // cross mark emoji
    /\breject(ed)?\b/i,
    /\bdenied?\b/i,
    /\bnot\s+approved?\b/i,
    /\bchanges?\s+requested?\b/i
  ];

  /**
   * Check if a card is a GATE card.
   * @param {Object} card - Deck card object with title and description
   * @returns {boolean}
   */
  static isGate(card) {
    const text = `${card.title || ''} ${card.description || ''}`;
    return GateDetector.GATE_PATTERNS.some(p => p.test(text));
  }

  /**
   * Check if a GATE card has been resolved by a human comment.
   * Scans comments in reverse chronological order, skipping bot comments.
   *
   * @param {import('../integrations/deck-client')} deckClient
   * @param {number} cardId
   * @param {string} botUsername - Bot's username to skip its own comments
   * @returns {Promise<{resolved: boolean, decision: string|null, comment: Object|null}>}
   */
  static async checkGateResolution(deckClient, cardId, botUsername = 'moltagent') {
    const comments = await deckClient.getComments(cardId);

    // Reverse chronological — most recent first
    for (const comment of [...comments].reverse()) {
      const author = comment.actorId || comment.author || '';
      if (author.toLowerCase() === botUsername.toLowerCase()) continue;

      const text = comment.message || '';

      if (GateDetector.APPROVE_PATTERNS.some(p => p.test(text))) {
        return { resolved: true, decision: 'approved', comment };
      }
      if (GateDetector.REJECT_PATTERNS.some(p => p.test(text))) {
        return { resolved: true, decision: 'rejected', comment };
      }
    }

    return { resolved: false, decision: null, comment: null };
  }

  /**
   * Check if a GATE card needs notification (hasn't been notified yet).
   * Uses a comment marker to avoid re-notifying.
   *
   * @param {import('../integrations/deck-client')} deckClient
   * @param {number} cardId
   * @param {string} botUsername
   * @returns {Promise<boolean>}
   */
  static async needsNotification(deckClient, cardId, botUsername = 'moltagent') {
    const comments = await deckClient.getComments(cardId);
    return !comments.some(c =>
      (c.actorId || '').toLowerCase() === botUsername.toLowerCase() &&
      (c.message || '').includes('\u23F8\uFE0F GATE')
    );
  }
}

module.exports = GateDetector;
