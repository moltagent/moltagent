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
 * must therefore be unconditional. The "no tool call on an action turn" signal
 * stays gate-conditional and lives in the caller.
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

module.exports = { stagesApprovalCeremony, stripApprovalMarker, ACTION_REPROMPT_DIRECTIVE };
