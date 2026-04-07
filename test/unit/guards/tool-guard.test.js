/*
 * Moltagent - Sovereign AI Security Layer
 * Copyright (C) 2026 Moltagent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * Unit Tests for ToolGuard Module
 *
 * Tests tool/operation security level evaluation, fuzzy matching,
 * context-aware prompts, and custom operation lists.
 *
 * @module test/unit/guards/tool-guard.test.js
 */

'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const ToolGuard = require('../../../src/security/guards/tool-guard');

console.log('\n=== ToolGuard Tests ===\n');

// -----------------------------------------------------------------------------
// Constructor Tests
// -----------------------------------------------------------------------------

test('TC-TG-001: Constructor creates instance with default lists', () => {
  const guard = new ToolGuard();
  assert.ok(guard instanceof ToolGuard);
  assert.ok(guard._forbidden instanceof Set);
  assert.ok(guard._approval instanceof Set);
  assert.ok(guard._local instanceof Set);
});

test('TC-TG-002: Constructor accepts additionalForbidden operations', () => {
  const guard = new ToolGuard({ additionalForbidden: ['custom_danger'] });
  const result = guard.evaluate('custom_danger');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.level, 'FORBIDDEN');
});

test('TC-TG-003: Constructor accepts additionalApproval operations', () => {
  const guard = new ToolGuard({ additionalApproval: ['custom_sensitive'] });
  const result = guard.evaluate('custom_sensitive');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.level, 'APPROVAL_REQUIRED');
});

test('TC-TG-004: Constructor accepts additionalLocal operations', () => {
  const guard = new ToolGuard({ additionalLocal: ['custom_private'] });
  const result = guard.evaluate('custom_private');
  assert.strictEqual(result.allowed, true);
  assert.strictEqual(result.level, 'ROUTE_LOCAL');
});

test('TC-TG-005: Constructor accepts multiple additional lists', () => {
  const guard = new ToolGuard({
    additionalForbidden: ['danger1', 'danger2'],
    additionalApproval: ['sensitive1'],
    additionalLocal: ['private1', 'private2']
  });
  assert.strictEqual(guard.evaluate('danger1').level, 'FORBIDDEN');
  assert.strictEqual(guard.evaluate('danger2').level, 'FORBIDDEN');
  assert.strictEqual(guard.evaluate('sensitive1').level, 'APPROVAL_REQUIRED');
  assert.strictEqual(guard.evaluate('private1').level, 'ROUTE_LOCAL');
  assert.strictEqual(guard.evaluate('private2').level, 'ROUTE_LOCAL');
});

test('TC-TG-006: Constructor with empty options works', () => {
  const guard = new ToolGuard({});
  assert.ok(guard instanceof ToolGuard);
  const result = guard.evaluate('read_file');
  assert.strictEqual(result.level, 'ALLOWED');
});

// -----------------------------------------------------------------------------
// FORBIDDEN Tests (always blocked)
// -----------------------------------------------------------------------------

test('TC-TG-010: FORBIDDEN - modify_system_prompt', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('modify_system_prompt');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.level, 'FORBIDDEN');
  assert.strictEqual(result.requiresAction, null);
  assert.strictEqual(result.approvalPrompt, null);
  assert.ok(result.reason.includes('forbidden'));
});

test('TC-TG-011: FORBIDDEN - install_skill', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('install_skill');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.level, 'FORBIDDEN');
  assert.ok(result.reason.includes('forbidden'));
});

test('TC-TG-012: FORBIDDEN - delete_logs', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('delete_logs');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.level, 'FORBIDDEN');
  assert.ok(result.reason.includes('forbidden'));
});

test('TC-TG-013: FORBIDDEN - export_credentials', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('export_credentials');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.level, 'FORBIDDEN');
  assert.ok(result.reason.includes('forbidden'));
});

test('TC-TG-014: FORBIDDEN - disable_guard', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('disable_guard');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.level, 'FORBIDDEN');
  assert.ok(result.reason.includes('forbidden'));
});

test('TC-TG-015: FORBIDDEN - modify_soul', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('modify_soul');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.level, 'FORBIDDEN');
});

test('TC-TG-016: FORBIDDEN - replace_instructions', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('replace_instructions');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.level, 'FORBIDDEN');
});

test('TC-TG-017: FORBIDDEN - modify_config', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('modify_config');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.level, 'FORBIDDEN');
});

test('TC-TG-018: FORBIDDEN - disable_sandbox', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('disable_sandbox');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.level, 'FORBIDDEN');
});

test('TC-TG-019: FORBIDDEN - bypass_security', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('bypass_security');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.level, 'FORBIDDEN');
});

test('TC-TG-020: FORBIDDEN - install_plugin', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('install_plugin');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.level, 'FORBIDDEN');
});

test('TC-TG-021: FORBIDDEN - modify_audit', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('modify_audit');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.level, 'FORBIDDEN');
});

test('TC-TG-022: FORBIDDEN - clear_history', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('clear_history');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.level, 'FORBIDDEN');
});

test('TC-TG-023: FORBIDDEN - access_other_session', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('access_other_session');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.level, 'FORBIDDEN');
});

// -----------------------------------------------------------------------------
// APPROVAL_REQUIRED Tests (blocked with prompt)
// -----------------------------------------------------------------------------

test('TC-TG-030: APPROVAL_REQUIRED - send_email', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('send_email');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.level, 'APPROVAL_REQUIRED');
  assert.strictEqual(result.requiresAction, 'await_approval');
  assert.ok(result.approvalPrompt !== null);
  assert.ok(result.approvalPrompt.includes('send_email'));
  assert.ok(result.reason.includes('approval'));
});

test('TC-TG-031: APPROVAL_REQUIRED - delete_file', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('delete_file');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.level, 'APPROVAL_REQUIRED');
  assert.strictEqual(result.requiresAction, 'await_approval');
  assert.ok(result.approvalPrompt !== null);
});

test('TC-TG-032: APPROVAL_REQUIRED - execute_shell', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('execute_shell');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.level, 'APPROVAL_REQUIRED');
  assert.strictEqual(result.requiresAction, 'await_approval');
  assert.ok(result.approvalPrompt !== null);
});

test('TC-TG-033: APPROVAL_REQUIRED - webhook_call', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('webhook_call');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.level, 'APPROVAL_REQUIRED');
  assert.strictEqual(result.requiresAction, 'await_approval');
  assert.ok(result.approvalPrompt !== null);
});

test('TC-TG-034: APPROVAL_REQUIRED - send_message_external', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('send_message_external');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.level, 'APPROVAL_REQUIRED');
});

test('TC-TG-035: APPROVAL_REQUIRED - delete_files', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('delete_files');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.level, 'APPROVAL_REQUIRED');
});

test('TC-TG-036: APPROVAL_REQUIRED - delete_folder', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('delete_folder');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.level, 'APPROVAL_REQUIRED');
});

test('TC-TG-037: APPROVAL_REQUIRED - modify_calendar', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('modify_calendar');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.level, 'APPROVAL_REQUIRED');
});

test('TC-TG-038: APPROVAL_REQUIRED - delete_calendar_event', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('delete_calendar_event');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.level, 'APPROVAL_REQUIRED');
});

test('TC-TG-038b: APPROVAL_REQUIRED - calendar_delete_event (executor name)', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('calendar_delete_event');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.level, 'APPROVAL_REQUIRED');
});

test('TC-TG-039: APPROVAL_REQUIRED - modify_contacts', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('modify_contacts');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.level, 'APPROVAL_REQUIRED');
});

test('TC-TG-040: APPROVAL_REQUIRED - run_command', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('run_command');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.level, 'APPROVAL_REQUIRED');
});

test('TC-TG-041: APPROVAL_REQUIRED - access_new_credential', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('access_new_credential');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.level, 'APPROVAL_REQUIRED');
});

test('TC-TG-042: APPROVAL_REQUIRED - external_api_call', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('external_api_call');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.level, 'APPROVAL_REQUIRED');
});

test('TC-TG-043: APPROVAL_REQUIRED - deck_delete_card', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('deck_delete_card');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.level, 'APPROVAL_REQUIRED');
  assert.strictEqual(result.requiresAction, 'await_approval');
  assert.ok(result.approvalPrompt !== null);
});

test('TC-TG-044: APPROVAL_REQUIRED - deck_share_board', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('deck_share_board');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.level, 'APPROVAL_REQUIRED');
  assert.strictEqual(result.requiresAction, 'await_approval');
  assert.ok(result.approvalPrompt !== null);
});

// -----------------------------------------------------------------------------
// LOCAL_LLM_ONLY Tests (allowed but routed)
// -----------------------------------------------------------------------------

test('TC-TG-050: LOCAL_LLM_ONLY - process_credential', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('process_credential');
  assert.strictEqual(result.allowed, true);
  assert.strictEqual(result.level, 'ROUTE_LOCAL');
  assert.strictEqual(result.requiresAction, 'use_ollama');
  assert.strictEqual(result.approvalPrompt, null);
  assert.ok(result.reason.includes('local'));
});

test('TC-TG-051: LOCAL_LLM_ONLY - update_memory', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('update_memory');
  assert.strictEqual(result.allowed, true);
  assert.strictEqual(result.level, 'ROUTE_LOCAL');
  assert.strictEqual(result.requiresAction, 'use_ollama');
});

test('TC-TG-052: LOCAL_LLM_ONLY - process_pii', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('process_pii');
  assert.strictEqual(result.allowed, true);
  assert.strictEqual(result.level, 'ROUTE_LOCAL');
  assert.strictEqual(result.requiresAction, 'use_ollama');
});

test('TC-TG-053: LOCAL_LLM_ONLY - process_untrusted_file', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('process_untrusted_file');
  assert.strictEqual(result.allowed, true);
  assert.strictEqual(result.level, 'ROUTE_LOCAL');
});

test('TC-TG-054: LOCAL_LLM_ONLY - process_email_content', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('process_email_content');
  assert.strictEqual(result.allowed, true);
  assert.strictEqual(result.level, 'ROUTE_LOCAL');
});

test('TC-TG-055: LOCAL_LLM_ONLY - process_web_content', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('process_web_content');
  assert.strictEqual(result.allowed, true);
  assert.strictEqual(result.level, 'ROUTE_LOCAL');
});

test('TC-TG-056: LOCAL_LLM_ONLY - process_user_upload', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('process_user_upload');
  assert.strictEqual(result.allowed, true);
  assert.strictEqual(result.level, 'ROUTE_LOCAL');
});

// -----------------------------------------------------------------------------
// ALLOWED Tests (everything else)
// -----------------------------------------------------------------------------

test('TC-TG-060: ALLOWED - read_file', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('read_file');
  assert.strictEqual(result.allowed, true);
  assert.strictEqual(result.level, 'ALLOWED');
  assert.strictEqual(result.reason, null);
  assert.strictEqual(result.requiresAction, null);
  assert.strictEqual(result.approvalPrompt, null);
});

test('TC-TG-061: ALLOWED - list_calendar_events', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('list_calendar_events');
  assert.strictEqual(result.allowed, true);
  assert.strictEqual(result.level, 'ALLOWED');
  assert.strictEqual(result.reason, null);
});

test('TC-TG-062: ALLOWED - search_deck', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('search_deck');
  assert.strictEqual(result.allowed, true);
  assert.strictEqual(result.level, 'ALLOWED');
});

test('TC-TG-063: ALLOWED - generate_summary', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('generate_summary');
  assert.strictEqual(result.allowed, true);
  assert.strictEqual(result.level, 'ALLOWED');
});

test('TC-TG-064: ALLOWED - list_files', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('list_files');
  assert.strictEqual(result.allowed, true);
  assert.strictEqual(result.level, 'ALLOWED');
});

test('TC-TG-065: ALLOWED - search_contacts', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('search_contacts');
  assert.strictEqual(result.allowed, true);
  assert.strictEqual(result.level, 'ALLOWED');
});

test('TC-TG-066: ALLOWED - get_weather', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('get_weather');
  assert.strictEqual(result.allowed, true);
  assert.strictEqual(result.level, 'ALLOWED');
});

test('TC-TG-067: ALLOWED - random_operation', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('random_operation');
  assert.strictEqual(result.allowed, true);
  assert.strictEqual(result.level, 'ALLOWED');
});

// -----------------------------------------------------------------------------
// Fuzzy Matching Tests
// -----------------------------------------------------------------------------

test('TC-TG-070: Fuzzy match - Send Email (title case)', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('Send Email');
  assert.strictEqual(result.level, 'APPROVAL_REQUIRED');
  assert.strictEqual(result.allowed, false);
});

test('TC-TG-071: Fuzzy match - send-email (hyphenated)', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('send-email');
  assert.strictEqual(result.level, 'APPROVAL_REQUIRED');
  assert.strictEqual(result.allowed, false);
});

test('TC-TG-072: Fuzzy match - SEND_EMAIL (uppercase)', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('SEND_EMAIL');
  assert.strictEqual(result.level, 'APPROVAL_REQUIRED');
  assert.strictEqual(result.allowed, false);
});

test('TC-TG-073: Fuzzy match - send email (space separated)', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('send email');
  assert.strictEqual(result.level, 'APPROVAL_REQUIRED');
  assert.strictEqual(result.allowed, false);
});

test('TC-TG-074: Fuzzy match - Delete File (various cases)', () => {
  const guard = new ToolGuard();
  assert.strictEqual(guard.evaluate('Delete File').level, 'APPROVAL_REQUIRED');
  assert.strictEqual(guard.evaluate('delete-file').level, 'APPROVAL_REQUIRED');
  assert.strictEqual(guard.evaluate('DELETE_FILE').level, 'APPROVAL_REQUIRED');
});

test('TC-TG-075: Fuzzy match - Process Credential', () => {
  const guard = new ToolGuard();
  assert.strictEqual(guard.evaluate('Process Credential').level, 'ROUTE_LOCAL');
  assert.strictEqual(guard.evaluate('process-credential').level, 'ROUTE_LOCAL');
  assert.strictEqual(guard.evaluate('PROCESS_CREDENTIAL').level, 'ROUTE_LOCAL');
});

test('TC-TG-076: Fuzzy match - Modify System Prompt', () => {
  const guard = new ToolGuard();
  assert.strictEqual(guard.evaluate('Modify System Prompt').level, 'FORBIDDEN');
  assert.strictEqual(guard.evaluate('modify-system-prompt').level, 'FORBIDDEN');
  assert.strictEqual(guard.evaluate('MODIFY_SYSTEM_PROMPT').level, 'FORBIDDEN');
});

test('TC-TG-077: Fuzzy match - Mixed separators', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('send-Email Message');
  // Normalizes to send_email_message which is not in list
  assert.strictEqual(result.level, 'ALLOWED');
});

// -----------------------------------------------------------------------------
// Context-Aware Prompt Tests
// -----------------------------------------------------------------------------

test('TC-TG-080: Context target included in approval prompt', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('send_email', { target: 'boss@company.com' });
  assert.strictEqual(result.level, 'APPROVAL_REQUIRED');
  assert.ok(result.approvalPrompt.includes('boss@company.com'));
  assert.ok(result.approvalPrompt.includes('target:'));
});

test('TC-TG-081: Context target included for delete_file', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('delete_file', { target: '/important/file.txt' });
  assert.strictEqual(result.level, 'APPROVAL_REQUIRED');
  assert.ok(result.approvalPrompt.includes('/important/file.txt'));
});

test('TC-TG-082: Context with no target does not include target', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('send_email', {});
  assert.strictEqual(result.level, 'APPROVAL_REQUIRED');
  assert.ok(!result.approvalPrompt.includes('target:'));
});

test('TC-TG-083: Context with additional fields only uses target', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('webhook_call', {
    target: 'https://example.com/hook',
    user: 'alice',
    data: 'sensitive'
  });
  assert.ok(result.approvalPrompt.includes('https://example.com/hook'));
  assert.ok(!result.approvalPrompt.includes('alice'));
  assert.ok(!result.approvalPrompt.includes('sensitive'));
});

test('TC-TG-084: Approval prompt contains action instructions', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('send_email');
  assert.ok(result.approvalPrompt.includes('approve'));
  assert.ok(result.approvalPrompt.includes('deny'));
});

test('TC-TG-085: Approval prompt format is consistent', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('execute_shell', { target: 'rm -rf /' });
  assert.ok(result.approvalPrompt.startsWith('⚠️ Moltagent wants to:'));
  assert.ok(result.approvalPrompt.includes('execute_shell'));
});

// -----------------------------------------------------------------------------
// Helper Method Tests
// -----------------------------------------------------------------------------

test('TC-TG-090: needsLocalLLM returns true for LOCAL_LLM_ONLY operations', () => {
  const guard = new ToolGuard();
  assert.strictEqual(guard.needsLocalLLM('process_credential'), true);
  assert.strictEqual(guard.needsLocalLLM('update_memory'), true);
  assert.strictEqual(guard.needsLocalLLM('process_pii'), true);
});

test('TC-TG-091: needsLocalLLM returns false for non-LOCAL operations', () => {
  const guard = new ToolGuard();
  assert.strictEqual(guard.needsLocalLLM('read_file'), false);
  assert.strictEqual(guard.needsLocalLLM('send_email'), false);
  assert.strictEqual(guard.needsLocalLLM('modify_system_prompt'), false);
});

test('TC-TG-092: needsLocalLLM supports fuzzy matching', () => {
  const guard = new ToolGuard();
  assert.strictEqual(guard.needsLocalLLM('Process Credential'), true);
  assert.strictEqual(guard.needsLocalLLM('UPDATE-MEMORY'), true);
  assert.strictEqual(guard.needsLocalLLM('process pii'), true);
});

test('TC-TG-093: getForbiddenList returns array', () => {
  const guard = new ToolGuard();
  const list = guard.getForbiddenList();
  assert.ok(Array.isArray(list));
  assert.ok(list.length > 0);
});

test('TC-TG-094: getForbiddenList includes default forbidden operations', () => {
  const guard = new ToolGuard();
  const list = guard.getForbiddenList();
  assert.ok(list.includes('modify_system_prompt'));
  assert.ok(list.includes('install_skill'));
  assert.ok(list.includes('delete_logs'));
  assert.ok(list.includes('export_credentials'));
  assert.ok(list.includes('disable_guard'));
});

test('TC-TG-095: getForbiddenList includes additional forbidden operations', () => {
  const guard = new ToolGuard({ additionalForbidden: ['custom_danger'] });
  const list = guard.getForbiddenList();
  assert.ok(list.includes('custom_danger'));
});

test('TC-TG-096: getAllLists returns object with three arrays', () => {
  const guard = new ToolGuard();
  const lists = guard.getAllLists();
  assert.strictEqual(typeof lists, 'object');
  assert.ok(Array.isArray(lists.forbidden));
  assert.ok(Array.isArray(lists.approval));
  assert.ok(Array.isArray(lists.local));
});

test('TC-TG-097: getAllLists forbidden includes expected operations', () => {
  const guard = new ToolGuard();
  const lists = guard.getAllLists();
  assert.ok(lists.forbidden.includes('modify_system_prompt'));
  assert.ok(lists.forbidden.includes('disable_guard'));
});

test('TC-TG-098: getAllLists approval includes expected operations', () => {
  const guard = new ToolGuard();
  const lists = guard.getAllLists();
  assert.ok(lists.approval.includes('send_email'));
  assert.ok(lists.approval.includes('delete_file'));
  assert.ok(lists.approval.includes('execute_shell'));
});

test('TC-TG-099: getAllLists local includes expected operations', () => {
  const guard = new ToolGuard();
  const lists = guard.getAllLists();
  assert.ok(lists.local.includes('process_credential'));
  assert.ok(lists.local.includes('update_memory'));
  assert.ok(lists.local.includes('process_pii'));
});

test('TC-TG-100: getAllLists includes additional operations', () => {
  const guard = new ToolGuard({
    additionalForbidden: ['danger1'],
    additionalApproval: ['sensitive1'],
    additionalLocal: ['private1']
  });
  const lists = guard.getAllLists();
  assert.ok(lists.forbidden.includes('danger1'));
  assert.ok(lists.approval.includes('sensitive1'));
  assert.ok(lists.local.includes('private1'));
});

// -----------------------------------------------------------------------------
// Forbidden Reason Categorization Tests
// -----------------------------------------------------------------------------

test('TC-TG-110: Forbidden reason identifies self-modification', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('modify_system_prompt');
  assert.ok(result.reason.includes('self-modification'));
});

test('TC-TG-111: Forbidden reason identifies plugin installation', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('install_skill');
  assert.ok(result.reason.includes('plugin installation'));
});

test('TC-TG-112: Forbidden reason identifies audit tampering', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('delete_logs');
  assert.ok(result.reason.includes('audit tampering'));
});

test('TC-TG-113: Forbidden reason identifies cross-session access', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('export_credentials');
  assert.ok(result.reason.includes('cross-session'));
});

test('TC-TG-114: Forbidden reason includes operation name', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('modify_config');
  assert.ok(result.reason.includes('modify_config'));
});

// -----------------------------------------------------------------------------
// Edge Cases and Input Validation
// -----------------------------------------------------------------------------

test('TC-TG-120: Empty string operation defaults to ALLOWED', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('');
  assert.strictEqual(result.level, 'ALLOWED');
  assert.strictEqual(result.allowed, true);
});

test('TC-TG-121: Null operation handled gracefully', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate(null);
  assert.strictEqual(result.level, 'ALLOWED');
  assert.strictEqual(result.allowed, true);
});

test('TC-TG-122: Undefined operation handled gracefully', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate(undefined);
  assert.strictEqual(result.level, 'ALLOWED');
  assert.strictEqual(result.allowed, true);
});

test('TC-TG-123: Number operation converted to string', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate(12345);
  assert.strictEqual(result.level, 'ALLOWED');
});

test('TC-TG-124: Object operation converted to string', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate({ operation: 'test' });
  assert.strictEqual(result.level, 'ALLOWED');
});

test('TC-TG-125: Whitespace-only operation defaults to ALLOWED', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('   ');
  assert.strictEqual(result.level, 'ALLOWED');
});

test('TC-TG-126: Operation with special characters', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('send@email#test');
  // Normalizes to send_email_test
  assert.strictEqual(result.level, 'ALLOWED');
});

test('TC-TG-127: Very long operation name', () => {
  const guard = new ToolGuard();
  const longName = 'a'.repeat(1000);
  const result = guard.evaluate(longName);
  assert.strictEqual(result.level, 'ALLOWED');
});

test('TC-TG-128: Context without target field works', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('send_email', { user: 'alice', other: 'data' });
  assert.strictEqual(result.level, 'APPROVAL_REQUIRED');
  assert.ok(!result.approvalPrompt.includes('target:'));
});

test('TC-TG-129: Null context handled same as empty context', () => {
  const guard = new ToolGuard();
  const result1 = guard.evaluate('send_email', null);
  const result2 = guard.evaluate('send_email', {});
  assert.strictEqual(result1.level, result2.level);
  assert.strictEqual(result1.allowed, result2.allowed);
});

// -----------------------------------------------------------------------------
// Priority Tests (FORBIDDEN > APPROVAL > LOCAL > ALLOWED)
// -----------------------------------------------------------------------------

test('TC-TG-130: FORBIDDEN takes priority over custom APPROVAL', () => {
  const guard = new ToolGuard({ additionalApproval: ['modify_system_prompt'] });
  const result = guard.evaluate('modify_system_prompt');
  // Should still be FORBIDDEN because it's in the hardcoded list
  assert.strictEqual(result.level, 'FORBIDDEN');
});

test('TC-TG-131: FORBIDDEN takes priority over custom LOCAL', () => {
  const guard = new ToolGuard({ additionalLocal: ['disable_guard'] });
  const result = guard.evaluate('disable_guard');
  assert.strictEqual(result.level, 'FORBIDDEN');
});

test('TC-TG-132: APPROVAL takes priority over custom LOCAL', () => {
  const guard = new ToolGuard({ additionalLocal: ['send_email'] });
  const result = guard.evaluate('send_email');
  // Should still be APPROVAL_REQUIRED
  assert.strictEqual(result.level, 'APPROVAL_REQUIRED');
});

test('TC-TG-133: Custom forbidden overrides default allowed', () => {
  const guard = new ToolGuard({ additionalForbidden: ['read_file'] });
  const result = guard.evaluate('read_file');
  assert.strictEqual(result.level, 'FORBIDDEN');
  assert.strictEqual(result.allowed, false);
});

// -----------------------------------------------------------------------------
// Performance Tests
// -----------------------------------------------------------------------------

test('TC-TG-140: evaluate() performance is under 0.01ms average', () => {
  const guard = new ToolGuard();
  const operations = [
    'read_file',
    'send_email',
    'process_credential',
    'modify_system_prompt',
    'list_calendar_events'
  ];

  const iterations = 10000;
  const start = process.hrtime.bigint();

  for (let i = 0; i < iterations; i++) {
    const op = operations[i % operations.length];
    guard.evaluate(op);
  }

  const end = process.hrtime.bigint();
  const avgTimeNs = Number(end - start) / iterations;
  const avgTimeMs = avgTimeNs / 1000000;

  assert.ok(avgTimeMs < 0.01, `Average time ${avgTimeMs}ms exceeds 0.01ms threshold`);
});

test('TC-TG-141: needsLocalLLM() performance is fast', () => {
  const guard = new ToolGuard();
  const iterations = 10000;
  const start = process.hrtime.bigint();

  for (let i = 0; i < iterations; i++) {
    guard.needsLocalLLM('process_credential');
  }

  const end = process.hrtime.bigint();
  const avgTimeNs = Number(end - start) / iterations;
  const avgTimeMs = avgTimeNs / 1000000;

  assert.ok(avgTimeMs < 0.01, `Average time ${avgTimeMs}ms exceeds threshold`);
});

test('TC-TG-142: getAllLists() performance is acceptable', () => {
  const guard = new ToolGuard();
  const start = process.hrtime.bigint();

  for (let i = 0; i < 1000; i++) {
    guard.getAllLists();
  }

  const end = process.hrtime.bigint();
  const avgTimeNs = Number(end - start) / 1000;
  const avgTimeMs = avgTimeNs / 1000000;

  assert.ok(avgTimeMs < 0.1, `Average time ${avgTimeMs}ms exceeds threshold`);
});

// -----------------------------------------------------------------------------
// Return Value Structure Tests
// -----------------------------------------------------------------------------

test('TC-TG-150: FORBIDDEN result has correct structure', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('modify_system_prompt');
  assert.strictEqual(typeof result.allowed, 'boolean');
  assert.strictEqual(typeof result.reason, 'string');
  assert.strictEqual(typeof result.level, 'string');
  assert.strictEqual(result.requiresAction, null);
  assert.strictEqual(result.approvalPrompt, null);
});

test('TC-TG-151: APPROVAL_REQUIRED result has correct structure', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('send_email');
  assert.strictEqual(typeof result.allowed, 'boolean');
  assert.strictEqual(typeof result.reason, 'string');
  assert.strictEqual(typeof result.level, 'string');
  assert.strictEqual(typeof result.requiresAction, 'string');
  assert.strictEqual(typeof result.approvalPrompt, 'string');
});

test('TC-TG-152: ROUTE_LOCAL result has correct structure', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('process_credential');
  assert.strictEqual(typeof result.allowed, 'boolean');
  assert.strictEqual(typeof result.reason, 'string');
  assert.strictEqual(typeof result.level, 'string');
  assert.strictEqual(typeof result.requiresAction, 'string');
  assert.strictEqual(result.approvalPrompt, null);
});

test('TC-TG-153: ALLOWED result has correct structure', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('read_file');
  assert.strictEqual(typeof result.allowed, 'boolean');
  assert.strictEqual(result.reason, null);
  assert.strictEqual(typeof result.level, 'string');
  assert.strictEqual(result.requiresAction, null);
  assert.strictEqual(result.approvalPrompt, null);
});

test('TC-TG-154: All results have exactly 5 properties', () => {
  const guard = new ToolGuard();
  const operations = ['modify_system_prompt', 'send_email', 'process_credential', 'read_file'];

  operations.forEach(op => {
    const result = guard.evaluate(op);
    const keys = Object.keys(result);
    assert.strictEqual(keys.length, 5, `Operation ${op} result has ${keys.length} properties`);
    assert.ok(keys.includes('allowed'));
    assert.ok(keys.includes('reason'));
    assert.ok(keys.includes('level'));
    assert.ok(keys.includes('requiresAction'));
    assert.ok(keys.includes('approvalPrompt'));
  });
});

// -----------------------------------------------------------------------------
// Session 17: File operation security tests
// -----------------------------------------------------------------------------

test('TC-TG-160: file_delete requires approval', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('file_delete');
  assert.strictEqual(result.level, 'APPROVAL_REQUIRED');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.requiresAction, 'await_approval');
});

test('TC-TG-161: file_share requires approval', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('file_share');
  assert.strictEqual(result.level, 'APPROVAL_REQUIRED');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.requiresAction, 'await_approval');
});

test('TC-TG-162: file_read is allowed', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('file_read');
  assert.strictEqual(result.level, 'ALLOWED');
  assert.strictEqual(result.allowed, true);
});

// -----------------------------------------------------------------------------
// Summary
// -----------------------------------------------------------------------------

console.log('\n=== ToolGuard Tests Complete ===\n');
summary();
exitWithCode();
