/**
 * AGPL-3.0 License
 * Copyright (C) 2024 Moltagent Contributors
 *
 * gate-detector.js
 *
 * Architecture Brief
 * ------------------
 * Problem:   The old GateDetector used regex patterns to detect GATE cards from
 *            natural-language title/description content — a violation of the
 *            "no regex for intelligence" principle. It also scanned comments to
 *            determine approval/rejection, making comment content load-bearing.
 *
 * Pattern:   Label-based detection. A card IS a gate if it carries the "GATE"
 *            label. A gate IS resolved when the human replaces the GATE label with
 *            APPROVED or REJECTED. This makes the state machine explicit and
 *            auditable in the Deck UI with no comment scanning required.
 *
 *            Regex is still used on CONFIG card text in isGateStack() — that is
 *            human-authored structured config (not LLM output), so pattern
 *            matching there is plumbing, not intelligence.
 *
 * Key Dependencies: deck-card-classifier (hasLabel)
 *
 * Data Flow:
 *   card { labels } → isGate() → boolean
 *   cards[]         → isGateStack() → boolean (scans CONFIG card title/desc)
 *   card { labels } → checkGateResolution() → { resolved, decision }
 *
 * Dependency Map:
 *   gate-detector  <──  workflow-engine
 */

'use strict';

const { hasLabel } = require('../integrations/deck-card-classifier');

/**
 * Reserved workflow labels. Title matches are case-insensitive via hasLabel().
 */
const LABEL_GATE     = 'GATE';
const LABEL_APPROVED = 'APPROVED';
const LABEL_REJECTED = 'REJECTED';

class GateDetector {

  /**
   * Check if a card is a GATE card.
   *
   * Primary signal: the card carries the "GATE" label (explicit, auditable).
   * The LLM stamps the GATE label via workflow_deck_assign_label after
   * completing pre-gate work described in the CONFIG card.
   *
   * Fallback signal: the card title starts with the "GATE:" structural prefix.
   * Title-prefix detection is structural plumbing (like CONFIG: or WORKFLOW:),
   * not natural-language intelligence — no regex for intelligence violation.
   *
   * @param {Object} card - Deck card object with labels array and title
   * @returns {boolean}
   */
  static isGate(card) {
    if (!card || typeof card !== 'object') return false;
    if (hasLabel(card, LABEL_GATE)) return true;
    // Title-prefix fallback for cards not yet stamped with the GATE label
    const title = typeof card.title === 'string' ? card.title.trimStart() : '';
    return title.toUpperCase().startsWith('GATE:');
  }

  /**
   * Check if a stack is configured as a GATE stack.
   *
   * A stack is a GATE stack when its CONFIG card (identified by the "System"
   * label) has the word "GATE" in its title or description. This is a regex
   * on human-authored config text — not LLM output — so pattern matching is
   * appropriate here.
   *
   * @param {Array<Object>} cards - All cards in a stack
   * @returns {boolean}
   */
  static isGateStack(cards) {
    if (!Array.isArray(cards)) return false;

    // Find the CONFIG card — it has the "System" label
    const configCard = cards.find(c => hasLabel(c, 'System'));
    if (!configCard) return false;

    const text = `${configCard.title || ''} ${configCard.description || ''}`;
    // Regex on controlled config text is OK (plumbing, not intelligence)
    return /\bGATE\b/i.test(text);
  }

  /**
   * Check whether a GATE card has been resolved by inspecting its labels.
   *
   * State machine:
   *   APPROVED label  → resolved, decision = 'approved'
   *   REJECTED label  → resolved, decision = 'rejected'
   *   GATE label only → not resolved
   *   No workflow label → pass-through (resolved with no decision)
   *
   * @param {Object} card - Deck card object with labels array
   * @returns {{ resolved: boolean, decision: string|null }}
   */
  static checkGateResolution(card) {
    if (!card || typeof card !== 'object') {
      return { resolved: false, decision: null };
    }

    if (hasLabel(card, LABEL_APPROVED)) {
      return { resolved: true, decision: 'approved' };
    }

    if (hasLabel(card, LABEL_REJECTED)) {
      return { resolved: true, decision: 'rejected' };
    }

    if (hasLabel(card, LABEL_GATE)) {
      // Gate exists and is unresolved
      return { resolved: false, decision: null };
    }

    // Card has no workflow label — treat as pass-through
    return { resolved: true, decision: null };
  }
}

module.exports = GateDetector;
