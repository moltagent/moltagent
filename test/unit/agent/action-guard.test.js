'use strict';

const assert = require('assert');
const { test, summary, exitWithCode } = require('../../helpers/test-runner');
const { stagesApprovalCeremony, stripApprovalMarker, ACTION_REPROMPT_DIRECTIVE } = require('../../../src/lib/agent/action-guard');
const { HITL_PROMPT_MARKER } = require('../../../src/lib/agent/guardrail-enforcer');

// -- Test 1: detects the reserved HITL marker anywhere in the content --
test('stagesApprovalCeremony() is true when the response stages the 🔐 marker', () => {
  const staged = `${HITL_PROMPT_MARKER} **Delete Deck card** — requires approval. Reply "approve".`;
  assert.strictEqual(stagesApprovalCeremony(staged), true);
});

// -- Test 2: ordinary responses never trip the guard (no false positive) --
test('stagesApprovalCeremony() is false for normal response text', () => {
  assert.strictEqual(stagesApprovalCeremony('Deleted the card "Q3 planning".'), false);
  assert.strictEqual(stagesApprovalCeremony('Ich habe die Karte gelöscht.'), false);
  assert.strictEqual(stagesApprovalCeremony('Removi o cartão.'), false);
});

// -- Test 3: non-string inputs are safe (null/undefined/object) --
test('stagesApprovalCeremony() is false for non-string inputs', () => {
  assert.strictEqual(stagesApprovalCeremony(null), false);
  assert.strictEqual(stagesApprovalCeremony(undefined), false);
  assert.strictEqual(stagesApprovalCeremony({ response: 'x' }), false);
  assert.strictEqual(stagesApprovalCeremony(42), false);
});

// -- Test 4: marker detection is language-free — only the codepoint matters --
test('stagesApprovalCeremony() keys on the codepoint, not phrasing', () => {
  // English ceremony phrasing WITHOUT the marker → not flagged (the marker, not
  // the words, is the signal; word-matching would be a Rule 1 violation).
  assert.strictEqual(stagesApprovalCeremony('This requires approval. Reply approve to allow.'), false);
  // Marker with no surrounding ceremony words → still flagged.
  assert.strictEqual(stagesApprovalCeremony(`x ${HITL_PROMPT_MARKER} y`), true);
});

// -- Test 5: the shared re-prompt directive is present and on-message --
test('ACTION_REPROMPT_DIRECTIVE instructs calling the tool and not staging prompts', () => {
  assert.strictEqual(typeof ACTION_REPROMPT_DIRECTIVE, 'string');
  assert.ok(ACTION_REPROMPT_DIRECTIVE.length > 0);
  assert.ok(ACTION_REPROMPT_DIRECTIVE.includes('[SYSTEM]'));
  assert.ok(/tool/i.test(ACTION_REPROMPT_DIRECTIVE));
});

// -- Test 6: stripApprovalMarker removes every marker occurrence --
test('stripApprovalMarker() removes the marker codepoint and leaves the rest', () => {
  const dirty = `${HITL_PROMPT_MARKER} a ${HITL_PROMPT_MARKER} b`;
  const cleaned = stripApprovalMarker(dirty);
  assert.strictEqual(stagesApprovalCeremony(cleaned), false);
  assert.ok(cleaned.includes('a') && cleaned.includes('b'));
});

// -- Test 7: stripApprovalMarker is a no-op on clean / non-string input --
test('stripApprovalMarker() leaves clean strings and non-strings untouched', () => {
  assert.strictEqual(stripApprovalMarker('all good'), 'all good');
  assert.strictEqual(stripApprovalMarker(null), null);
  assert.strictEqual(stripApprovalMarker(undefined), undefined);
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
