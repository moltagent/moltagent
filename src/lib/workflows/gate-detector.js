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
 * Pattern:   Two pure classifiers, no state. isGate() — does a card carry the
 *            "GATE" label (the coarse classifier the engine uses for hygiene and as
 *            the mint TRIGGER, read WITH stack context). isGateStack() — does a
 *            stack's CONFIG card declare it a gate stack. Both return booleans the
 *            engine feeds to the custody substrate.
 *
 *            Phase 3 (Approval Custody Arc) deleted checkGateResolution(): gate
 *            resolution is no longer INFERRED from card surface features. Gate state
 *            lives in a workflow-gate PendingAction record and the enforcer's
 *            resolveGateState() is the single authority; APPROVED/REJECTED labels
 *            and stack membership are projections/inputs, never read here as the
 *            resolution verdict. This killed the GATE quartet (#187/#193/#200/#201),
 *            four read sites that each inferred gate state differently.
 *
 *            Regex is still used on CONFIG card text in isGateStack() — that is
 *            human-authored structured config (not LLM output), so pattern matching
 *            there is plumbing, not intelligence.
 *
 * Key Dependencies: deck-card-classifier (hasLabel)
 *
 * Data Flow:
 *   card { labels }  → isGate()      → boolean (coarse classifier / mint trigger)
 *   cards[]          → isGateStack() → boolean (CONFIG scan; passed to resolver)
 *
 * Dependency Map:
 *   gate-detector  <──  workflow-engine
 */

'use strict';

const { hasLabel } = require('../integrations/deck-card-classifier');

/**
 * Reserved workflow labels. Title matches are case-insensitive via hasLabel().
 */
const LABEL_GATE = 'GATE';

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

  // checkGateResolution() was deleted in Phase 3 (Approval Custody Arc). Gate
  // resolution is no longer INFERRED from card surface features (APPROVED/REJECTED
  // labels + stack membership) — that inference was the GATE quartet
  // (#187/#193/#200/#201), each read site reading differently. Gate state now lives
  // in a workflow-gate PendingAction record; the enforcer's resolveGateState() is the
  // single authority. This module keeps only isGate() (the coarse card classifier,
  // used for hygiene) and isGateStack() (stack detection, whose boolean the engine
  // passes to the resolver). Labels are projections rendered from the record, never
  // read back as truth.
}

module.exports = GateDetector;
