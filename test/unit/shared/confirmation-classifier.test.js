/**
 * SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2024 Moltagent contributors
 *
 * ConfirmationClassifier Unit Tests
 *
 * Architecture Brief:
 *   Tests the pure classifyConfirmationReply() utility.
 *   No real Ollama connection required — all LLM calls are mocked.
 *   Covers: short-circuit guards, per-language approvals/denials,
 *   conditional label coercion, prompt-content assertions, and error paths.
 *
 * Run: node test/unit/shared/confirmation-classifier.test.js
 */

const assert = require('assert');
const { asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

const { classifyConfirmationReply } = require('../../../src/lib/shared/confirmation-classifier');

// ============================================================
// Helpers
// ============================================================

function createMockOllama(response) {
  let callCount = 0;
  let lastCall = null;
  return {
    chat: async (params) => {
      callCount++;
      lastCall = params;
      if (typeof response === 'function') return response(params);
      if (response instanceof Error) throw response;
      return { content: response };
    },
    _getCallCount: () => callCount,
    _getLastCall: () => lastCall
  };
}

// ============================================================
// Test cases
// ============================================================

// 1. EN 'yes' → approve
asyncTest("'yes' + default opts + mock returns APPROVE → 'approve'", async () => {
  const mock = createMockOllama('APPROVE');
  const result = await classifyConfirmationReply('yes', mock);
  assert.strictEqual(result, 'approve');
});

// 2. DE 'ja' → approve
asyncTest("'ja' + mock returns APPROVE → 'approve'", async () => {
  const mock = createMockOllama('APPROVE');
  const result = await classifyConfirmationReply('ja', mock);
  assert.strictEqual(result, 'approve');
});

// 3. PT 'sim' → approve
asyncTest("'sim' + mock returns APPROVE → 'approve'", async () => {
  const mock = createMockOllama('APPROVE');
  const result = await classifyConfirmationReply('sim', mock);
  assert.strictEqual(result, 'approve');
});

// 4. EN 'no' → deny
asyncTest("'no' + mock returns DENY → 'deny'", async () => {
  const mock = createMockOllama('DENY');
  const result = await classifyConfirmationReply('no', mock);
  assert.strictEqual(result, 'deny');
});

// 5. DE 'nein' → deny
asyncTest("'nein' + mock returns DENY → 'deny'", async () => {
  const mock = createMockOllama('DENY');
  const result = await classifyConfirmationReply('nein', mock);
  assert.strictEqual(result, 'deny');
});

// 6. PT 'não' → deny
asyncTest("'não' + mock returns DENY → 'deny'", async () => {
  const mock = createMockOllama('DENY');
  const result = await classifyConfirmationReply('não', mock);
  assert.strictEqual(result, 'deny');
});

// 7. EN edit with allowEdit:true → edit
asyncTest("'edit the subject line' + {allowEdit:true} + mock returns EDIT → 'edit'", async () => {
  const mock = createMockOllama('EDIT');
  const result = await classifyConfirmationReply('edit the subject line', mock, { allowEdit: true });
  assert.strictEqual(result, 'edit');
});

// 8. EN edit with allowEdit:false → unknown (structural coercion)
asyncTest("'edit the subject line' + {allowEdit:false} + mock returns EDIT → 'unknown'", async () => {
  const mock = createMockOllama('EDIT');
  const result = await classifyConfirmationReply('edit the subject line', mock, { allowEdit: false });
  assert.strictEqual(result, 'unknown');
});

// 9. DE edit with allowEdit:true → edit
asyncTest("'ändere den Betreff' + {allowEdit:true} + mock returns EDIT → 'edit'", async () => {
  const mock = createMockOllama('EDIT');
  const result = await classifyConfirmationReply('ändere den Betreff', mock, { allowEdit: true });
  assert.strictEqual(result, 'edit');
});

// 10. EN activate with allowActivate:true → activate
asyncTest("'activate' + {allowActivate:true} + mock returns ACTIVATE → 'activate'", async () => {
  const mock = createMockOllama('ACTIVATE');
  const result = await classifyConfirmationReply('activate', mock, { allowActivate: true });
  assert.strictEqual(result, 'activate');
});

// 11. DE activate with allowActivate:true → activate
asyncTest("'mach das live' + {allowActivate:true} + mock returns ACTIVATE → 'activate'", async () => {
  const mock = createMockOllama('ACTIVATE');
  const result = await classifyConfirmationReply('mach das live', mock, { allowActivate: true });
  assert.strictEqual(result, 'activate');
});

// 12. activate with allowActivate:false → unknown (structural coercion)
asyncTest("'activate' + {allowActivate:false} + mock returns ACTIVATE → 'unknown'", async () => {
  const mock = createMockOllama('ACTIVATE');
  const result = await classifyConfirmationReply('activate', mock, { allowActivate: false });
  assert.strictEqual(result, 'unknown');
});

// 13. suggest with allowSuggest:true → suggest
asyncTest("'suggest' + {allowSuggest:true} + mock returns SUGGEST → 'suggest'", async () => {
  const mock = createMockOllama('SUGGEST');
  const result = await classifyConfirmationReply('suggest', mock, { allowSuggest: true });
  assert.strictEqual(result, 'suggest');
});

// 14. accept_anyway with allowAcceptAnyway:true → accept_anyway
asyncTest("'accept anyway' + {allowAcceptAnyway:true} + mock returns ACCEPT_ANYWAY → 'accept_anyway'", async () => {
  const mock = createMockOllama('ACCEPT_ANYWAY');
  const result = await classifyConfirmationReply('accept anyway', mock, { allowAcceptAnyway: true });
  assert.strictEqual(result, 'accept_anyway');
});

// 15. ambiguous input → unknown
asyncTest("'what time is it' + mock returns UNKNOWN → 'unknown'", async () => {
  const mock = createMockOllama('UNKNOWN');
  const result = await classifyConfirmationReply('what time is it', mock);
  assert.strictEqual(result, 'unknown');
});

// 16. empty string → unknown AND no LLM call
asyncTest("'' (empty) → 'unknown' and mock call count is 0", async () => {
  const mock = createMockOllama('APPROVE');
  const result = await classifyConfirmationReply('', mock);
  assert.strictEqual(result, 'unknown');
  assert.strictEqual(mock._getCallCount(), 0);
});

// 17. null → unknown AND no LLM call
asyncTest("null → 'unknown' and no LLM call", async () => {
  const mock = createMockOllama('APPROVE');
  const result = await classifyConfirmationReply(null, mock);
  assert.strictEqual(result, 'unknown');
  assert.strictEqual(mock._getCallCount(), 0);
});

// 18. text.length > 100 → unknown AND no LLM call
asyncTest("'x'.repeat(101) → 'unknown' and no LLM call", async () => {
  const mock = createMockOllama('APPROVE');
  const result = await classifyConfirmationReply('x'.repeat(101), mock);
  assert.strictEqual(result, 'unknown');
  assert.strictEqual(mock._getCallCount(), 0);
});

// 19. mock throws → unknown, no exception escapes
asyncTest('mock throws Error → unknown (no exception escapes)', async () => {
  const mock = createMockOllama(new Error('timeout'));
  const result = await classifyConfirmationReply('yes', mock);
  assert.strictEqual(result, 'unknown');
});

// 20. mock returns garbage token → unknown
asyncTest("mock returns 'maybe?' (no valid token) → 'unknown'", async () => {
  const mock = createMockOllama('maybe?');
  const result = await classifyConfirmationReply('yes', mock);
  assert.strictEqual(result, 'unknown');
});

// 21a. allowEdit:false — system prompt does NOT mention EDIT label or 'edit the subject' example
asyncTest('{allowEdit:false} — system prompt does not contain EDIT label or edit examples', async () => {
  const mock = createMockOllama('DENY');
  // Use a neutral input so the user message doesn't smuggle 'EDIT' or 'edit the subject' in
  await classifyConfirmationReply('cancel please', mock, { allowEdit: false });
  const lastCall = mock._getLastCall();
  const systemText = lastCall.system || '';
  assert.ok(!systemText.includes('EDIT'), 'System prompt must not contain EDIT label when allowEdit=false');
  assert.ok(!systemText.includes('edit the subject'), 'System prompt must not contain edit examples when allowEdit=false');
});

// 21b. allowSuggest:false — prompt does NOT mention SUGGEST
asyncTest('{allowSuggest:false} — prompt does not contain SUGGEST label', async () => {
  const mock = createMockOllama('DENY');
  await classifyConfirmationReply('suggest something', mock, { allowSuggest: false });
  const lastCall = mock._getLastCall();
  const systemText = lastCall.system || '';
  const userText = (lastCall.messages || []).map(m => m.content).join('\n');
  const fullPrompt = systemText + userText;
  assert.ok(!fullPrompt.includes('SUGGEST'), 'Prompt must not contain SUGGEST label when allowSuggest=false');
});

// 22. allowActivate:true — prompt DOES contain ACTIVATE, DE example, PT example
asyncTest('{allowActivate:true} — prompt contains ACTIVATE, DE example (aktivieren), PT example (ativa)', async () => {
  const mock = createMockOllama('ACTIVATE');
  await classifyConfirmationReply('go live', mock, { allowActivate: true });
  const lastCall = mock._getLastCall();
  const systemText = lastCall.system || '';
  const userText = (lastCall.messages || []).map(m => m.content).join('\n');
  const fullPrompt = systemText + userText;
  assert.ok(fullPrompt.includes('ACTIVATE'), 'Prompt must contain ACTIVATE label when allowActivate=true');
  assert.ok(fullPrompt.includes('aktivieren'), 'Prompt must contain DE example "aktivieren" when allowActivate=true');
  assert.ok(fullPrompt.includes('ativa'), 'Prompt must contain PT example "ativa" when allowActivate=true');
});

// ============================================================
// Trailer
// ============================================================

setTimeout(() => {
  summary();
  exitWithCode();
}, 500);
