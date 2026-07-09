'use strict';

const { HITL_PROMPT_MARKER } = require('./guardrail-enforcer');

/**
 * ActionGuard - Shared action-hallucination detection
 *
 * The HITL approval ceremony (the 🔐 marker codepoint) is owned exclusively by
 * GuardrailEnforcer's Talk surface. When an LLM stages that ceremony in its own
 * response *text* — instead of calling the destructive tool and letting the
 * enforcer own the approval prompt — the user sees a fake approval that never
 * executes (#81, #85).
 *
 * This module is the single structural predicate both execution engines
 * (AgentLoop and MicroPipeline) share, so the detection is identical regardless
 * of which engine produced the response or how the turn was gated. It is
 * language-free: it keys only on the reserved marker codepoint, never on
 * natural-language phrasing.
 *
 * A response staging the marker is *always* illegitimate — at any gate. A
 * confirmation follow-up ("lösch den dritten") classifies as gate=confirmation,
 * not gate=action, so a gate-conditional check would miss it; the marker check
 * must therefore be unconditional. The "no mutating tool call on an action
 * turn" signal stays gate-conditional and lives in the caller.
 *
 * This module also owns the honesty floor's text (#81 commit 2). The invariant
 * both halves serve:
 *
 *   A gate=action turn that invoked no mutating tool must not deliver a
 *   success claim to the user.
 *
 * The re-prompt (Layer 1) gives the model one chance to do the work it was
 * asked to do; the trailer (Layer 2) makes the turn honest whether or not it
 * takes that chance. Both key on what the turn *did* — its invoked tool names,
 * measured against each tool's own ToolRegistry mutation declaration — never on
 * what it said. Approval (the write class, #266) is a strictly smaller question:
 * deck_create_card mutates and needs no consent.
 * Reading the model's sentences to decide whether the model acted is the
 * same category error as reading conversation history to decide whether the user
 * authorised something, which #264 removed.
 *
 * @module agent/action-guard
 */

/**
 * True when a response stages the HITL approval ceremony in its own text
 * instead of letting GuardrailEnforcer own that surface.
 *
 * @param {string} content - Rendered response text
 * @returns {boolean}
 */
function stagesApprovalCeremony(content) {
  return typeof content === 'string' && content.includes(HITL_PROMPT_MARKER);
}

/**
 * Remove the reserved HITL marker codepoint from a response. Terminal
 * belt-and-suspenders: the re-prompt should already have steered the model into
 * calling the tool, but if a misbehaving model stages the marker again on the
 * re-prompted pass, this guarantees the codepoint never reaches the user (the
 * structural invariant the marker contract depends on). The deeper "don't emit
 * the ceremony prose at all" fix is the structured-pending-action work.
 *
 * @param {string} content
 * @returns {string} content with the marker removed (non-strings returned as-is)
 */
function stripApprovalMarker(content) {
  return typeof content === 'string' ? content.split(HITL_PROMPT_MARKER).join('') : content;
}

/**
 * Corrective directive injected when an action turn produced no state-changing
 * tool call, or staged a fake approval ceremony. Shared so both engines speak
 * with one voice when re-prompting.
 */
const ACTION_REPROMPT_DIRECTIVE =
  '[SYSTEM] You were asked to perform an action but did not issue the state-changing tool call. ' +
  'The guardrail system handles approval prompts on its own surface — do not stage them in your response. ' +
  'If you can perform the action, call the appropriate tool now. If you cannot, explain what prevented you. ' +
  'Do not describe a result the tool has not returned.';

/**
 * The honesty floor's text, per language.
 *
 * This is output templating on a code-owned surface — the same class as the
 * enforcer's approval prompt — not language handling. No prose is read and no
 * language is detected here: the key is the Cockpit language already travelling
 * with the turn on the classification verdict. Unknown languages fall back to EN
 * rather than guessing.
 *
 * The text states a fact about what the turn did, and claims nothing about why.
 * It sits beneath the model's narration, so a specific refusal ("I couldn't find
 * that card") keeps its place as the useful sentence and this only adds the part
 * the model may have omitted or contradicted.
 */
const NO_ACTION_TRAILER = {
  EN: '⚠️ No action was executed — nothing was created, changed, or deleted.',
  DE: '⚠️ Es wurde keine Aktion ausgeführt — nichts wurde erstellt, geändert oder gelöscht.',
  PT: '⚠️ Nenhuma ação foi executada — nada foi criado, alterado ou eliminado.',
};

/**
 * Normalise a Cockpit language tag to a trailer key.
 *
 * Accepts the shapes the verdict actually carries: 'DE', 'de', 'DE+EN' (the
 * bilingual persona setting), null. Anything not templated falls back to EN.
 *
 * @param {string|null|undefined} language
 * @returns {'EN'|'DE'|'PT'}
 */
function _trailerKey(language) {
  const key = String(language || 'EN').toUpperCase().split('+')[0].trim();
  return Object.prototype.hasOwnProperty.call(NO_ACTION_TRAILER, key) ? key : 'EN';
}

/**
 * The honesty floor (#81 commit 2, Layer 2).
 *
 * A gate=action turn that invoked no mutating tool did not act, whatever its
 * prose says. Rather than inspect that prose — the ProvenanceAnnotator's
 * groundedRatio scores a fabricated claim as "grounded" whenever it echoes the
 * user's own nouns, see #267 — the floor appends a code-owned statement of what
 * the turn actually did.
 *
 * Appended, never substituted: replacing the narration would destroy a
 * legitimate specific refusal, and the trailer's job is to add a true sentence,
 * not to remove a useful one.
 *
 * @param {string|null|undefined} language - Cockpit language from the verdict
 * @returns {string}
 */
function buildNoActionTrailer(language) {
  return NO_ACTION_TRAILER[_trailerKey(language)];
}

module.exports = {
  stagesApprovalCeremony,
  stripApprovalMarker,
  buildNoActionTrailer,
  ACTION_REPROMPT_DIRECTIVE,
  NO_ACTION_TRAILER,
};
