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
 * Pattern:   Label-based detection plus stack-move detection (#197). A card IS a
 *            gate if it carries the "GATE" label. A gate IS resolved either when
 *            the human applies APPROVED/REJECTED (legacy, backward-compatible) OR
 *            when the human drags the still-GATE-labelled card OUT of the gate
 *            stack — the move itself is the approval gesture (Option B, #197).
 *            Forward moves are approvals; a move into a stack declared
 *            `REJECTED: true` on its CONFIG card is a rejection. This makes the
 *            state machine explicit and auditable in the Deck UI with no comment
 *            scanning required.
 *
 *            Regex is still used on CONFIG card text in isGateStack() — that is
 *            human-authored structured config (not LLM output), so pattern
 *            matching there is plumbing, not intelligence. The REJECTED: marker is
 *            read by the engine (_isRejectionStack, mirrors #196 TERMINAL) and the
 *            resulting boolean is passed in, so this module stays lean (no
 *            schedule-handler dependency).
 *
 * Key Dependencies: deck-card-classifier (hasLabel)
 *
 * Data Flow:
 *   card { labels }                       → isGate() → boolean
 *   cards[]                               → isGateStack() → boolean (CONFIG scan)
 *   card, currentStack, isRejectionStack  → checkGateResolution()
 *                                         → { resolved, decision, via }
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
   * A stack is a GATE stack when its CONFIG card has the word "GATE" in its
   * title or description. This is a regex on human-authored config text — not
   * LLM output — so pattern matching is appropriate here.
   *
   * The CONFIG card is located by EITHER structural convention — a "System"
   * label OR a "CONFIG:" title prefix — mirroring isStructuralCard() and the
   * findConfigCard() helper used by the engine's TERMINAL/REJECTED/REVIEWER
   * markers. This dual locator is load-bearing for #197: it decides whether a
   * GATE card is still HELD (in the gate stack) or has been dragged OUT
   * (approval). Matching by the System label alone would false-negate on a
   * board whose gate CONFIG card uses only the "CONFIG:" title convention,
   * silently reading a held gate as approved. Robust to both conventions.
   *
   * @param {Array<Object>} cards - All cards in a stack
   * @returns {boolean}
   */
  static isGateStack(cards) {
    if (!Array.isArray(cards)) return false;

    // Locate the CONFIG card by either structural convention (System label OR
    // "CONFIG:" title prefix) — the same dual rule isStructuralCard() applies.
    const configCard = cards.find(c =>
      hasLabel(c, 'System') ||
      /^CONFIG:\s*/i.test((typeof c?.title === 'string' ? c.title : '').trimStart())
    );
    if (!configCard) return false;

    const text = `${configCard.title || ''} ${configCard.description || ''}`;
    // Regex on controlled config text is OK (plumbing, not intelligence)
    return /\bGATE\b/i.test(text);
  }

  /**
   * Check whether a GATE card has been resolved.
   *
   * Resolution sources, evaluated IN ORDER:
   *
   *   1. APPROVED label  → resolved, decision = 'approved', via = 'label'
   *   2. REJECTED label  → resolved, decision = 'rejected', via = 'label'
   *      (Backward-compat MUST stay first: a transition card may carry GATE +
   *       APPROVED while still sitting in the gate stack. It must resolve as
   *       approved here, never be mis-read as an unresolved in-stack gate below.)
   *   3. GATE label present (no APPROVED/REJECTED):
   *        - still in a gate stack  → unresolved (decision = null, via = null)
   *        - moved OUT of gate stack → resolved via the drag gesture (#197):
   *            decision = isRejectionStack ? 'rejected' : 'approved', via = 'move'
   *   4. No workflow label → pass-through (resolved with no decision, via = null)
   *
   * `currentStack` carries the cards needed to call isGateStack() on the card's
   * present location. `isRejectionStack` is precomputed by the engine
   * (_isRejectionStack, which reads the REJECTED: CONFIG marker off the same
   * CONFIG card as #196 TERMINAL) and passed in, so this module needs no
   * schedule-handler dependency. `allStacks` is intentionally NOT a parameter:
   * both gate-stack and rejection-stack detection resolve from `currentStack`
   * alone, so a board-wide list would be dead weight.
   *
   * When `currentStack` is omitted (legacy direct callers that cannot observe a
   * move), a GATE-only card is reported unresolved — preserving prior behavior.
   *
   * @param {Object} card - Deck card object with labels array and title
   * @param {Object|null} [currentStack] - The stack the card is in now ({ cards })
   * @param {boolean} [isRejectionStack] - True when currentStack is a declared
   *                                        REJECTED: true stack (engine-computed)
   * @returns {{ resolved: boolean, decision: string|null, via: ('label'|'move'|null) }}
   */
  static checkGateResolution(card, currentStack = null, isRejectionStack = false) {
    if (!card || typeof card !== 'object') {
      return { resolved: false, decision: null, via: null };
    }

    // (1)/(2) Legacy label path — MUST stay first (see JSDoc).
    if (hasLabel(card, LABEL_APPROVED)) {
      return { resolved: true, decision: 'approved', via: 'label' };
    }

    if (hasLabel(card, LABEL_REJECTED)) {
      return { resolved: true, decision: 'rejected', via: 'label' };
    }

    // (3) GATE label present, no explicit decision label.
    if (hasLabel(card, LABEL_GATE)) {
      // Stack-move detection (#197).
      if (currentStack) {
        if (GateDetector.isGateStack(currentStack.cards)) {
          // Card is still in the gate stack — waiting for human drag.
          return { resolved: false, decision: null, via: null };
        }
        // Card has been dragged OUT of the gate stack — the move is the approval gesture.
        return {
          resolved: true,
          decision: isRejectionStack ? 'rejected' : 'approved',
          via: 'move'
        };
      }

      // currentStack omitted — legacy caller, no move observable → unresolved.
      return { resolved: false, decision: null, via: null };
    }

    // (4) Card has no workflow label — treat as pass-through.
    return { resolved: true, decision: null, via: null };
  }
}

module.exports = GateDetector;
