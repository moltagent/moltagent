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
 * Tests for ToolGuard Phase 2: New approval-required operations
 */

'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../../helpers/test-runner');
const ToolGuard = require('../../../../src/security/guards/tool-guard');

// -----------------------------------------------------------------------------
// Tests for Phase 2 additions to REQUIRES_APPROVAL list
// -----------------------------------------------------------------------------

test('wiki_write is allowed (HITL moved to GuardrailEnforcer SENSITIVE_TOOLS)', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('wiki_write');

  assert.strictEqual(result.allowed, true, 'wiki_write should be allowed (Cockpit-governed, not hardcoded)');
  assert.strictEqual(result.level, 'ALLOWED', 'Should be ALLOWED level');
  assert.strictEqual(result.requiresAction, null, 'Should not require any action');
});

test('mail_send is allowed (HITL handled by SOUL.md instruction, not guard)', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('mail_send');

  assert.strictEqual(result.allowed, true, 'mail_send should be allowed (HITL in SOUL.md)');
  assert.strictEqual(result.level, 'ALLOWED', 'Should be ALLOWED level');
});

test('notification_send requires approval', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('notification_send');

  assert.strictEqual(result.allowed, false, 'notification_send should require approval');
  assert.strictEqual(result.level, 'APPROVAL_REQUIRED', 'Should be APPROVAL_REQUIRED level');
  assert.strictEqual(result.requiresAction, 'await_approval', 'Should require await_approval action');
  assert.ok(result.approvalPrompt, 'Should provide approval prompt');
  assert.ok(result.approvalPrompt.includes('notification_send'), 'Prompt should mention operation name');
});

test('web_search is allowed (not in restricted lists)', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('web_search');

  assert.strictEqual(result.allowed, true, 'web_search should be allowed');
  assert.strictEqual(result.level, 'ALLOWED', 'Should be ALLOWED level');
  assert.strictEqual(result.requiresAction, null, 'Should not require any action');
  assert.strictEqual(result.approvalPrompt, null, 'Should not have approval prompt');
  assert.strictEqual(result.reason, null, 'Should not have a reason');
});

test('web_read is allowed (not in restricted lists)', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('web_read');

  assert.strictEqual(result.allowed, true, 'web_read should be allowed');
  assert.strictEqual(result.level, 'ALLOWED', 'Should be ALLOWED level');
  assert.strictEqual(result.requiresAction, null, 'Should not require any action');
});

test('wiki_read is allowed (not in restricted lists)', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('wiki_read');

  assert.strictEqual(result.allowed, true, 'wiki_read should be allowed');
  assert.strictEqual(result.level, 'ALLOWED', 'Should be ALLOWED level');
  assert.strictEqual(result.requiresAction, null, 'Should not require any action');
});

test('wiki_search is allowed (not in restricted lists)', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('wiki_search');

  assert.strictEqual(result.allowed, true, 'wiki_search should be allowed');
  assert.strictEqual(result.level, 'ALLOWED', 'Should be ALLOWED level');
  assert.strictEqual(result.requiresAction, null, 'Should not require any action');
});

// Additional tests to verify the guard is working correctly
test('Approval prompt includes operation name for notification_send', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('notification_send', { target: 'user123' });

  assert.ok(result.approvalPrompt, 'Should have approval prompt');
  assert.ok(result.approvalPrompt.includes('notification_send'), 'Prompt should mention operation');
  assert.ok(result.approvalPrompt.includes('user123'), 'Prompt should mention target when provided');
});

test('Forbidden operations still blocked', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('modify_system_prompt');

  assert.strictEqual(result.allowed, false, 'Forbidden ops should be blocked');
  assert.strictEqual(result.level, 'FORBIDDEN', 'Should be FORBIDDEN level');
  assert.strictEqual(result.requiresAction, null, 'Forbidden ops have no action');
});

test('Local LLM operations still routed', () => {
  const guard = new ToolGuard();
  const result = guard.evaluate('process_credential');

  assert.strictEqual(result.allowed, true, 'Local-only ops should be allowed');
  assert.strictEqual(result.level, 'ROUTE_LOCAL', 'Should be ROUTE_LOCAL level');
  assert.strictEqual(result.requiresAction, 'use_ollama', 'Should require use_ollama');
});

// -----------------------------------------------------------------------------
// Run Summary
// -----------------------------------------------------------------------------

setTimeout(() => {
  summary();
  exitWithCode();
}, 500);
