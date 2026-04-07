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
 * Unit Tests for SecretsGuard Module
 *
 * Tests secrets detection, redaction, false positive resistance,
 * and performance characteristics.
 *
 * @module test/unit/guards/secrets-guard.test.js
 */

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const SecretsGuard = require('../../../src/security/guards/secrets-guard');

console.log('\n=== SecretsGuard Tests ===\n');

// -----------------------------------------------------------------------------
// Constructor Tests
// -----------------------------------------------------------------------------

test('TC-SG-001: Constructor creates instance with default patterns', () => {
  const guard = new SecretsGuard();
  assert.ok(guard instanceof SecretsGuard);
  assert.ok(Array.isArray(guard.patterns));
  assert.ok(guard.patterns.length > 0);
});

test('TC-SG-002: Constructor accepts custom patterns', () => {
  const customPattern = {
    name: 'custom_token',
    pattern: /CUSTOM-[A-Z0-9]{10}/g,
    severity: 'HIGH'
  };
  const guard = new SecretsGuard({ customPatterns: [customPattern] });
  assert.ok(guard.patterns.some(p => p.name === 'custom_token'));
});

test('TC-SG-003: Constructor accepts custom redactWith string', () => {
  const guard = new SecretsGuard({ redactWith: '***HIDDEN***' });
  assert.strictEqual(guard.redactWith, '***HIDDEN***');
});

test('TC-SG-004: Constructor defaults redactWith to [REDACTED]', () => {
  const guard = new SecretsGuard();
  assert.strictEqual(guard.redactWith, '[REDACTED]');
});

// -----------------------------------------------------------------------------
// AWS Credentials Detection
// -----------------------------------------------------------------------------

test('TC-SG-010: Detects AWS access key ID', () => {
  const guard = new SecretsGuard();
  const result = guard.scan('My key is AKIAIOSFODNN7EXAMPLE');
  assert.strictEqual(result.hasSecrets, true);
  assert.strictEqual(result.findings.length, 1);
  assert.strictEqual(result.findings[0].type, 'aws_access_key');
  assert.strictEqual(result.findings[0].severity, 'CRITICAL');
});

test('TC-SG-011: Detects AWS secret access key', () => {
  const guard = new SecretsGuard();
  const result = guard.scan('aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"');
  assert.strictEqual(result.hasSecrets, true);
  assert.ok(result.findings.some(f => f.type === 'aws_secret_key'));
  assert.strictEqual(result.findings[0].severity, 'CRITICAL');
});

test('TC-SG-012: Redacts AWS keys in output', () => {
  const guard = new SecretsGuard();
  const result = guard.scan('Key: AKIAIOSFODNN7EXAMPLE');
  assert.ok(result.sanitized.includes('[REDACTED:aws_access_key]'));
  assert.ok(!result.sanitized.includes('AKIAIOSFODNN7EXAMPLE'));
});

// -----------------------------------------------------------------------------
// GitHub Token Detection
// -----------------------------------------------------------------------------

test('TC-SG-020: Detects GitHub personal access token', () => {
  const guard = new SecretsGuard();
  const result = guard.scan('token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef1234');
  assert.strictEqual(result.hasSecrets, true);
  assert.ok(result.findings.some(f => f.type === 'github_token'));
  assert.strictEqual(result.findings[0].severity, 'CRITICAL');
});

test('TC-SG-021: Detects GitHub fine-grained token', () => {
  const guard = new SecretsGuard();
  const result = guard.scan('github_pat_11ABCDEFG_abcdefghijklmnopqrstuvwxyz123456');
  assert.strictEqual(result.hasSecrets, true);
  assert.ok(result.findings.some(f => f.type === 'github_fine'));
  assert.strictEqual(result.findings[0].severity, 'CRITICAL');
});

test('TC-SG-022: Detects GitHub OAuth token', () => {
  const guard = new SecretsGuard();
  const result = guard.scan('gho_1234567890abcdefghijklmnopqrstuvwxyz');
  assert.strictEqual(result.hasSecrets, true);
  assert.ok(result.findings.some(f => f.type === 'github_token'));
});

// -----------------------------------------------------------------------------
// API Key Detection
// -----------------------------------------------------------------------------

test('TC-SG-030: Detects Anthropic API key', () => {
  const guard = new SecretsGuard();
  const result = guard.scan('sk-ant-api03-abc123def456ghi789jkl012mno345pqr');
  assert.strictEqual(result.hasSecrets, true);
  assert.ok(result.findings.some(f => f.type === 'anthropic_key'));
  assert.strictEqual(result.findings[0].severity, 'CRITICAL');
});

test('TC-SG-031: Detects Stripe live key', () => {
  const guard = new SecretsGuard();
  const result = guard.scan('sk_live_51ABC123def456GHI789jklMNOpqrSTUvwxYZ');
  assert.strictEqual(result.hasSecrets, true);
  assert.ok(result.findings.some(f => f.type === 'stripe_key'));
  assert.strictEqual(result.findings[0].severity, 'CRITICAL');
});

test('TC-SG-032: Detects Stripe test key', () => {
  const guard = new SecretsGuard();
  const result = guard.scan('sk_test_51ABC123def456GHI789jklMNOpqrSTUvwxYZ');
  assert.strictEqual(result.hasSecrets, true);
  assert.ok(result.findings.some(f => f.type === 'stripe_key'));
});

test('TC-SG-033: Detects Slack bot token', () => {
  const guard = new SecretsGuard();
  const result = guard.scan('xoxb-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx');
  assert.strictEqual(result.hasSecrets, true);
  assert.ok(result.findings.some(f => f.type === 'slack_token'));
  assert.strictEqual(result.findings[0].severity, 'HIGH');
});

// -----------------------------------------------------------------------------
// Private Key Detection
// -----------------------------------------------------------------------------

test('TC-SG-040: Detects RSA private key', () => {
  const guard = new SecretsGuard();
  const result = guard.scan('-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAK...');
  assert.strictEqual(result.hasSecrets, true);
  assert.ok(result.findings.some(f => f.type === 'private_key'));
  assert.strictEqual(result.findings[0].severity, 'CRITICAL');
});

test('TC-SG-041: Detects EC private key', () => {
  const guard = new SecretsGuard();
  const result = guard.scan('-----BEGIN EC PRIVATE KEY-----\nMHcCAQ...');
  assert.strictEqual(result.hasSecrets, true);
  assert.ok(result.findings.some(f => f.type === 'private_key'));
});

test('TC-SG-042: Detects generic private key', () => {
  const guard = new SecretsGuard();
  const result = guard.scan('-----BEGIN PRIVATE KEY-----\nMIIEvQIBA...');
  assert.strictEqual(result.hasSecrets, true);
  assert.ok(result.findings.some(f => f.type === 'private_key'));
});

// -----------------------------------------------------------------------------
// Database Connection String Detection
// -----------------------------------------------------------------------------

test('TC-SG-050: Detects MongoDB connection string', () => {
  const guard = new SecretsGuard();
  const result = guard.scan('mongodb://admin:sup3rs3cret@db.example.com:27017/mydb');
  assert.strictEqual(result.hasSecrets, true);
  assert.ok(result.findings.some(f => f.type === 'db_connection'));
  assert.strictEqual(result.findings[0].severity, 'CRITICAL');
});

test('TC-SG-051: Detects PostgreSQL connection string', () => {
  const guard = new SecretsGuard();
  const result = guard.scan('postgres://user:p@ssw0rd@localhost:5432/app');
  assert.strictEqual(result.hasSecrets, true);
  assert.ok(result.findings.some(f => f.type === 'db_connection'));
});

test('TC-SG-052: Detects MySQL connection string', () => {
  const guard = new SecretsGuard();
  const result = guard.scan('mysql://dbuser:mypassword@db.host.com:3306/database');
  assert.strictEqual(result.hasSecrets, true);
  assert.ok(result.findings.some(f => f.type === 'db_connection'));
});

// -----------------------------------------------------------------------------
// URL-Embedded Authentication Detection
// -----------------------------------------------------------------------------

test('TC-SG-060: Detects URL with embedded credentials', () => {
  const guard = new SecretsGuard();
  const result = guard.scan('https://user:password123@api.example.com/v1/data');
  assert.strictEqual(result.hasSecrets, true);
  assert.ok(result.findings.some(f => f.type === 'url_credentials'));
  assert.strictEqual(result.findings[0].severity, 'CRITICAL');
});

test('TC-SG-061: Detects HTTP URL with credentials', () => {
  const guard = new SecretsGuard();
  const result = guard.scan('http://admin:secret@internal.server.local/api');
  assert.strictEqual(result.hasSecrets, true);
  assert.ok(result.findings.some(f => f.type === 'url_credentials'));
});

// -----------------------------------------------------------------------------
// Generic Field Detection
// -----------------------------------------------------------------------------

test('TC-SG-070: Detects password field assignment', () => {
  const guard = new SecretsGuard();
  const result = guard.scan('password = "MyS3cretP@ss!"');
  assert.strictEqual(result.hasSecrets, true);
  assert.ok(result.findings.some(f => f.type === 'password_field'));
  assert.strictEqual(result.findings[0].severity, 'MEDIUM');
});

test('TC-SG-071: Detects api_key field assignment', () => {
  const guard = new SecretsGuard();
  const result = guard.scan('api_key: "abcdef1234567890abcdef"');
  assert.strictEqual(result.hasSecrets, true);
  assert.ok(result.findings.some(f => f.type === 'api_key_field'));
  assert.strictEqual(result.findings[0].severity, 'HIGH');
});

test('TC-SG-072: Detects Bearer token in Authorization header', () => {
  const guard = new SecretsGuard();
  const result = guard.scan('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOi');
  assert.strictEqual(result.hasSecrets, true);
  assert.ok(result.findings.some(f => f.type === 'bearer_token'));
  assert.strictEqual(result.findings[0].severity, 'HIGH');
});

test('TC-SG-073: Detects Basic authentication', () => {
  const guard = new SecretsGuard();
  const result = guard.scan('Authorization: Basic dXNlcm5hbWU6cGFzc3dvcmQ=');
  assert.strictEqual(result.hasSecrets, true);
  assert.ok(result.findings.some(f => f.type === 'basic_auth'));
  assert.strictEqual(result.findings[0].severity, 'HIGH');
});

// -----------------------------------------------------------------------------
// Nextcloud App Password Detection
// -----------------------------------------------------------------------------

test('TC-SG-080: Detects Nextcloud app password', () => {
  const guard = new SecretsGuard();
  const result = guard.scan('Login with yH7kN-rT2mQ-bX9fL-wK4pD-nJ6vS');
  assert.strictEqual(result.hasSecrets, true);
  assert.ok(result.findings.some(f => f.type === 'nc_app_password'));
  assert.strictEqual(result.findings[0].severity, 'CRITICAL');
});

// -----------------------------------------------------------------------------
// False Positive Resistance Tests
// -----------------------------------------------------------------------------

test('TC-SG-100: Does not detect normal conversation about passwords', () => {
  const guard = new SecretsGuard();
  const result = guard.scan('The password policy requires 8 characters');
  assert.strictEqual(result.hasSecrets, false);
});

test('TC-SG-101: Does not detect normal conversation about API keys', () => {
  const guard = new SecretsGuard();
  const result = guard.scan('I need to update my API key rotation schedule');
  assert.strictEqual(result.hasSecrets, false);
});

test('TC-SG-102: Does not detect normal use of word "secret"', () => {
  const guard = new SecretsGuard();
  const result = guard.scan('The secret to good pasta is fresh ingredients');
  assert.strictEqual(result.hasSecrets, false);
});

test('TC-SG-103: Does not detect normal use of word "token"', () => {
  const guard = new SecretsGuard();
  const result = guard.scan('My token of appreciation for your help');
  assert.strictEqual(result.hasSecrets, false);
});

test('TC-SG-104: Does not detect normal use of word "bearer"', () => {
  const guard = new SecretsGuard();
  const result = guard.scan('The bearer of bad news arrived early');
  assert.strictEqual(result.hasSecrets, false);
});

test('TC-SG-105: Does not detect SHA-256 hash', () => {
  const guard = new SecretsGuard();
  const result = guard.scan('SHA-256 hash: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.strictEqual(result.hasSecrets, false);
});

test('TC-SG-106: Does not detect UUID', () => {
  const guard = new SecretsGuard();
  const result = guard.scan('UUID: 550e8400-e29b-41d4-a716-446655440000');
  assert.strictEqual(result.hasSecrets, false);
});

test('TC-SG-107: Does not detect Base64 discussion', () => {
  const guard = new SecretsGuard();
  const result = guard.scan('The function returns a Base64-encoded string');
  assert.strictEqual(result.hasSecrets, false);
});

test('TC-SG-108: Does not detect short password values (< 8 chars)', () => {
  const guard = new SecretsGuard();
  const result = guard.scan('password = "short"');
  assert.strictEqual(result.hasSecrets, false);
});

test('TC-SG-109: Does not detect short key values (< 16 chars)', () => {
  const guard = new SecretsGuard();
  const result = guard.scan('key = "abc"');
  assert.strictEqual(result.hasSecrets, false);
});

// -----------------------------------------------------------------------------
// Preview Format Tests
// -----------------------------------------------------------------------------

test('TC-SG-120: Preview shows first 4 + last 4 chars for long secrets', () => {
  const guard = new SecretsGuard();
  const result = guard.scan('AKIAIOSFODNN7EXAMPLE');
  assert.strictEqual(result.findings.length, 1);
  assert.strictEqual(result.findings[0].preview, 'AKIA...MPLE');
});

test('TC-SG-121: Preview handles short secrets gracefully', () => {
  const guard = new SecretsGuard();
  const result = guard.scan('password = "short123"');
  if (result.findings.length > 0) {
    assert.ok(result.findings[0].preview.includes('...'));
  }
});

// -----------------------------------------------------------------------------
// Redaction Format Tests
// -----------------------------------------------------------------------------

test('TC-SG-130: Redaction includes secret type', () => {
  const guard = new SecretsGuard();
  const result = guard.scan('Key: AKIAIOSFODNN7EXAMPLE');
  assert.ok(result.sanitized.includes('[REDACTED:aws_access_key]'));
});

test('TC-SG-131: Redaction removes original secret completely', () => {
  const guard = new SecretsGuard();
  const input = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef1234';
  const result = guard.scan(input);
  assert.ok(!result.sanitized.includes('ghp_ABCDEFGH'));
  assert.ok(result.sanitized.includes('[REDACTED:github_token]'));
});

// -----------------------------------------------------------------------------
// quickCheck() Tests
// -----------------------------------------------------------------------------

test('TC-SG-140: quickCheck returns true for secrets', () => {
  const guard = new SecretsGuard();
  assert.strictEqual(guard.quickCheck('AKIAIOSFODNN7EXAMPLE'), true);
});

test('TC-SG-141: quickCheck returns false for clean content', () => {
  const guard = new SecretsGuard();
  assert.strictEqual(guard.quickCheck('The password policy requires 8 characters'), false);
});

test('TC-SG-142: quickCheck returns boolean only', () => {
  const guard = new SecretsGuard();
  const result = guard.quickCheck('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef1234');
  assert.strictEqual(typeof result, 'boolean');
});

test('TC-SG-143: quickCheck handles empty string', () => {
  const guard = new SecretsGuard();
  assert.strictEqual(guard.quickCheck(''), false);
});

test('TC-SG-144: quickCheck handles null', () => {
  const guard = new SecretsGuard();
  assert.strictEqual(guard.quickCheck(null), false);
});

test('TC-SG-145: quickCheck handles undefined', () => {
  const guard = new SecretsGuard();
  assert.strictEqual(guard.quickCheck(undefined), false);
});

// -----------------------------------------------------------------------------
// hash() Tests
// -----------------------------------------------------------------------------

test('TC-SG-150: hash returns correct SHA-256', () => {
  const guard = new SecretsGuard();
  const input = 'test-string';
  const expected = crypto.createHash('sha256').update(input, 'utf8').digest('hex');
  assert.strictEqual(guard.hash(input), expected);
});

test('TC-SG-151: hash returns hex string', () => {
  const guard = new SecretsGuard();
  const result = guard.hash('test');
  assert.strictEqual(typeof result, 'string');
  assert.strictEqual(result.length, 64); // SHA-256 hex is 64 chars
  assert.ok(/^[a-f0-9]+$/.test(result));
});

test('TC-SG-152: hash handles non-string input', () => {
  const guard = new SecretsGuard();
  const result = guard.hash(12345);
  assert.strictEqual(typeof result, 'string');
  assert.strictEqual(result.length, 64);
});

test('TC-SG-153: hash is deterministic', () => {
  const guard = new SecretsGuard();
  const input = 'same-input';
  const hash1 = guard.hash(input);
  const hash2 = guard.hash(input);
  assert.strictEqual(hash1, hash2);
});

// -----------------------------------------------------------------------------
// Empty/Null/Undefined Handling Tests
// -----------------------------------------------------------------------------

test('TC-SG-160: scan handles empty string', () => {
  const guard = new SecretsGuard();
  const result = guard.scan('');
  assert.strictEqual(result.hasSecrets, false);
  assert.strictEqual(result.findings.length, 0);
  assert.strictEqual(result.sanitized, '');
  assert.strictEqual(result.criticalCount, 0);
});

test('TC-SG-161: scan handles null', () => {
  const guard = new SecretsGuard();
  const result = guard.scan(null);
  assert.strictEqual(result.hasSecrets, false);
  assert.strictEqual(result.findings.length, 0);
  assert.strictEqual(result.criticalCount, 0);
});

test('TC-SG-162: scan handles undefined', () => {
  const guard = new SecretsGuard();
  const result = guard.scan(undefined);
  assert.strictEqual(result.hasSecrets, false);
  assert.strictEqual(result.findings.length, 0);
  assert.strictEqual(result.criticalCount, 0);
});

test('TC-SG-163: scan handles non-string gracefully', () => {
  const guard = new SecretsGuard();
  const result = guard.scan(12345);
  assert.strictEqual(result.hasSecrets, false);
});

// -----------------------------------------------------------------------------
// Multiple Secrets Tests
// -----------------------------------------------------------------------------

test('TC-SG-170: Detects multiple secrets in one string', () => {
  const guard = new SecretsGuard();
  const content = 'AWS key: AKIAIOSFODNN7EXAMPLE and GitHub token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef1234';
  const result = guard.scan(content);
  assert.strictEqual(result.hasSecrets, true);
  assert.ok(result.findings.length >= 2);
});

test('TC-SG-171: Redacts all secrets in multi-secret content', () => {
  const guard = new SecretsGuard();
  const content = 'Key1: AKIAIOSFODNN7EXAMPLE Key2: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef1234';
  const result = guard.scan(content);
  assert.ok(!result.sanitized.includes('AKIAIOSFODNN7EXAMPLE'));
  assert.ok(!result.sanitized.includes('ghp_ABCDEFGH'));
});

// -----------------------------------------------------------------------------
// Critical Count Tests
// -----------------------------------------------------------------------------

test('TC-SG-180: criticalCount counts CRITICAL severity findings', () => {
  const guard = new SecretsGuard();
  const result = guard.scan('AKIAIOSFODNN7EXAMPLE');
  assert.strictEqual(result.criticalCount, 1);
});

test('TC-SG-181: criticalCount excludes non-CRITICAL findings', () => {
  const guard = new SecretsGuard();
  const result = guard.scan('password = "longenoughpassword"');
  // password_field is MEDIUM severity
  if (result.hasSecrets) {
    assert.strictEqual(result.criticalCount, 0);
  }
});

test('TC-SG-182: criticalCount counts multiple CRITICAL secrets', () => {
  const guard = new SecretsGuard();
  const content = 'AKIAIOSFODNN7EXAMPLE and ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef1234';
  const result = guard.scan(content);
  assert.ok(result.criticalCount >= 2);
});

test('TC-SG-183: criticalCount is zero for clean content', () => {
  const guard = new SecretsGuard();
  const result = guard.scan('No secrets here');
  assert.strictEqual(result.criticalCount, 0);
});

// -----------------------------------------------------------------------------
// Performance Tests
// -----------------------------------------------------------------------------

test('TC-SG-190: quickCheck performance is under 0.05ms', () => {
  const guard = new SecretsGuard();
  const content = 'This is a normal message without any secrets in it at all';

  const iterations = 1000;
  const start = process.hrtime.bigint();

  for (let i = 0; i < iterations; i++) {
    guard.quickCheck(content);
  }

  const end = process.hrtime.bigint();
  const avgTimeNs = Number(end - start) / iterations;
  const avgTimeMs = avgTimeNs / 1000000;

  assert.ok(avgTimeMs < 0.05, `Average time ${avgTimeMs}ms exceeds 0.05ms threshold`);
});

test('TC-SG-191: scan performance is reasonable for typical content', () => {
  const guard = new SecretsGuard();
  const content = 'A typical chat message that might contain some technical discussion about API keys and passwords but no actual secrets';

  const start = process.hrtime.bigint();
  guard.scan(content);
  const end = process.hrtime.bigint();

  const timeMs = Number(end - start) / 1000000;
  assert.ok(timeMs < 5, `Scan time ${timeMs}ms exceeds reasonable threshold`);
});

// -----------------------------------------------------------------------------
// Custom Patterns Tests
// -----------------------------------------------------------------------------

test('TC-SG-200: Custom patterns are detected', () => {
  const customPattern = {
    name: 'custom_secret',
    pattern: /CUSTOM-[A-Z0-9]{10}/g,
    severity: 'HIGH'
  };
  const guard = new SecretsGuard({ customPatterns: [customPattern] });
  const result = guard.scan('My secret is CUSTOM-ABC1234567');
  assert.strictEqual(result.hasSecrets, true);
  assert.ok(result.findings.some(f => f.type === 'custom_secret'));
});

test('TC-SG-201: Custom patterns work with quickCheck', () => {
  const customPattern = {
    name: 'custom_token',
    pattern: /MYTOKEN-[A-Z0-9]{8}/g,
    severity: 'CRITICAL'
  };
  const guard = new SecretsGuard({ customPatterns: [customPattern] });
  assert.strictEqual(guard.quickCheck('MYTOKEN-ABCD1234'), true);
});

// -----------------------------------------------------------------------------
// Edge Cases
// -----------------------------------------------------------------------------

test('TC-SG-210: Handles secrets at start of string', () => {
  const guard = new SecretsGuard();
  const result = guard.scan('AKIAIOSFODNN7EXAMPLE is the key');
  assert.strictEqual(result.hasSecrets, true);
});

test('TC-SG-211: Handles secrets at end of string', () => {
  const guard = new SecretsGuard();
  const result = guard.scan('The key is AKIAIOSFODNN7EXAMPLE');
  assert.strictEqual(result.hasSecrets, true);
});

test('TC-SG-212: Handles secrets with no surrounding whitespace', () => {
  const guard = new SecretsGuard();
  const result = guard.scan('key:AKIAIOSFODNN7EXAMPLE,other:value');
  assert.strictEqual(result.hasSecrets, true);
});

test('TC-SG-213: Handles multiline content', () => {
  const guard = new SecretsGuard();
  const content = 'Line 1\nAKIAIOSFODNN7EXAMPLE\nLine 3';
  const result = guard.scan(content);
  assert.strictEqual(result.hasSecrets, true);
});

test('TC-SG-214: Handles very long content efficiently', () => {
  const guard = new SecretsGuard();
  const longContent = 'x'.repeat(100000) + 'AKIAIOSFODNN7EXAMPLE' + 'x'.repeat(100000);

  const start = process.hrtime.bigint();
  const result = guard.scan(longContent);
  const end = process.hrtime.bigint();

  assert.strictEqual(result.hasSecrets, true);
  const timeMs = Number(end - start) / 1000000;
  assert.ok(timeMs < 100, `Long content scan took ${timeMs}ms`);
});

// -----------------------------------------------------------------------------
// Summary
// -----------------------------------------------------------------------------

console.log('\n=== SecretsGuard Tests Complete ===\n');
summary();
exitWithCode();
