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
 * Tests for SecretsGuard Phase 2: evaluate() method
 */

'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../../helpers/test-runner');
const SecretsGuard = require('../../../../src/security/guards/secrets-guard');

// -----------------------------------------------------------------------------
// Tests for evaluate() method (Phase 2)
// -----------------------------------------------------------------------------

test('evaluate() - Returns allowed:true for clean content', () => {
  const guard = new SecretsGuard();
  const result = guard.evaluate('This is a normal blog post about technology trends.');

  assert.strictEqual(result.allowed, true, 'Clean content should be allowed');
  assert.strictEqual(result.reason, null, 'No reason should be provided for clean content');
  assert.strictEqual(result.evidence, null, 'No evidence should be provided for clean content');
});

test('evaluate() - Returns allowed:false for AWS access key', () => {
  const guard = new SecretsGuard();
  const content = 'My AWS key is AKIAIOSFODNN7EXAMPLE and I want to write it to a file.';
  const result = guard.evaluate(content);

  assert.strictEqual(result.allowed, false, 'Content with AWS key should be blocked');
  assert.ok(result.reason, 'Should provide a reason');
  assert.ok(result.reason.includes('credentials'), 'Reason should mention credentials');
  assert.ok(Array.isArray(result.evidence), 'Evidence should be an array');
  assert.ok(result.evidence.length > 0, 'Evidence should not be empty');
});

test('evaluate() - Returns allowed:false for GitHub token', () => {
  const guard = new SecretsGuard();
  const content = 'Using token ghp_1234567890abcdefghijklmnopqrstuvwxyz to access the API.';
  const result = guard.evaluate(content);

  assert.strictEqual(result.allowed, false, 'Content with GitHub token should be blocked');
  assert.ok(result.reason, 'Should provide a reason');
  assert.ok(Array.isArray(result.evidence), 'Evidence should be an array');
  assert.ok(result.evidence.length > 0, 'Evidence should not be empty');
});

test('evaluate() - Evidence array contains type and severity', () => {
  const guard = new SecretsGuard();
  const content = 'AWS key: AKIAIOSFODNN7EXAMPLE';
  const result = guard.evaluate(content);

  assert.strictEqual(result.allowed, false, 'Should be blocked');
  assert.ok(Array.isArray(result.evidence), 'Evidence should be an array');
  assert.ok(result.evidence.length > 0, 'Evidence should not be empty');

  const finding = result.evidence[0];
  assert.ok(finding.type, 'Finding should have type');
  assert.ok(finding.severity, 'Finding should have severity');
  assert.ok(finding.preview, 'Finding should have preview');
  assert.strictEqual(finding.severity, 'CRITICAL', 'AWS key should be CRITICAL severity');
});

test('evaluate() - Returns descriptive reason string', () => {
  const guard = new SecretsGuard();
  const content = 'My password=secretpassword123 and I want to save it.';
  const result = guard.evaluate(content);

  assert.strictEqual(result.allowed, false, 'Should be blocked');
  assert.ok(result.reason, 'Should provide a reason');
  assert.ok(typeof result.reason === 'string', 'Reason should be a string');
  assert.ok(result.reason.length > 20, 'Reason should be descriptive');
  assert.ok(
    result.reason.toLowerCase().includes('credentials') ||
    result.reason.toLowerCase().includes('sensitive'),
    'Reason should mention credentials or sensitive data'
  );
});

test('evaluate() - Handles multiple secret types in one content', () => {
  const guard = new SecretsGuard();
  const content = `
    AWS Key: AKIAIOSFODNN7EXAMPLE
    GitHub Token: ghp_1234567890abcdefghijklmnopqrstuvwxyz
    Password: password=secretpassword123
  `;
  const result = guard.evaluate(content);

  assert.strictEqual(result.allowed, false, 'Should be blocked');
  assert.ok(Array.isArray(result.evidence), 'Evidence should be an array');
  assert.ok(result.evidence.length >= 2, 'Should detect multiple secret types');

  // Check that different types are detected
  const types = result.evidence.map(e => e.type);
  assert.ok(types.length > 1, 'Should detect more than one secret type');
});

test('evaluate() - Empty content is allowed', () => {
  const guard = new SecretsGuard();
  const result = guard.evaluate('');

  assert.strictEqual(result.allowed, true, 'Empty content should be allowed');
  assert.strictEqual(result.reason, null, 'No reason for empty content');
  assert.strictEqual(result.evidence, null, 'No evidence for empty content');
});

test('evaluate() - Private key detection', () => {
  const guard = new SecretsGuard();
  const content = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...';
  const result = guard.evaluate(content);

  assert.strictEqual(result.allowed, false, 'Private key should be blocked');
  assert.ok(Array.isArray(result.evidence), 'Evidence should be an array');
  const finding = result.evidence.find(e => e.type === 'private_key');
  assert.ok(finding, 'Should detect private_key type');
  assert.strictEqual(finding.severity, 'CRITICAL', 'Private key should be CRITICAL');
});

// -----------------------------------------------------------------------------
// Run Summary
// -----------------------------------------------------------------------------

setTimeout(() => {
  summary();
  exitWithCode();
}, 500);
