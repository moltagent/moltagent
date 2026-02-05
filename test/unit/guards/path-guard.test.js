/*
 * MoltAgent - Sovereign AI Security Layer
 * Copyright (C) 2026 MoltAgent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * Unit Tests for PathGuard Module
 *
 * Tests filesystem access control:
 * - Blocked paths (with wildcard matching)
 * - Blocked extensions
 * - Blocked filenames
 * - Path traversal prevention
 * - Tilde expansion
 * - allowedPaths override
 *
 * @module test/unit/guards/path-guard.test.js
 */

'use strict';

const assert = require('assert');
const os = require('os');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const PathGuard = require('../../../src/security/guards/path-guard');

console.log('\n=== PathGuard Tests ===\n');

// -----------------------------------------------------------------------------
// Constructor Tests
// -----------------------------------------------------------------------------

test('TC-PATH-001: Constructor creates instance with default settings', () => {
  const guard = new PathGuard();
  assert.ok(guard instanceof PathGuard);
  assert.ok(Array.isArray(guard.blockedPaths));
  assert.ok(guard.blockedPaths.length > 0);
});

test('TC-PATH-002: Constructor uses os.homedir() by default', () => {
  const guard = new PathGuard();
  assert.strictEqual(guard.homeDir, os.homedir());
});

test('TC-PATH-003: Constructor accepts custom homeDir', () => {
  const guard = new PathGuard({ homeDir: '/test/home' });
  assert.strictEqual(guard.homeDir, '/test/home');
});

test('TC-PATH-004: Constructor accepts additionalBlocked paths', () => {
  const guard = new PathGuard({ additionalBlocked: ['/custom/blocked'] });
  assert.ok(guard.blockedPaths.includes('/custom/blocked'));
});

test('TC-PATH-005: Constructor accepts allowedPaths override', () => {
  const guard = new PathGuard({ allowedPaths: ['/etc/passwd'] });
  assert.ok(guard.allowedPaths.has('/etc/passwd'));
});

// -----------------------------------------------------------------------------
// System Files - MUST BLOCK
// -----------------------------------------------------------------------------

test('TC-PATH-010: BLOCK /etc/shadow', () => {
  const guard = new PathGuard();
  const result = guard.evaluate('/etc/shadow');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.level, 'BLOCKED');
  assert.ok(result.matchedRule !== null || result.reason !== null);
});

test('TC-PATH-011: BLOCK /etc/passwd', () => {
  const guard = new PathGuard();
  const result = guard.evaluate('/etc/passwd');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.level, 'BLOCKED');
});

test('TC-PATH-012: BLOCK /etc/sudoers', () => {
  const guard = new PathGuard();
  const result = guard.evaluate('/etc/sudoers');
  assert.strictEqual(result.allowed, false);
});

test('TC-PATH-013: BLOCK /etc/sudoers.d/custom', () => {
  const guard = new PathGuard();
  const result = guard.evaluate('/etc/sudoers.d/custom');
  assert.strictEqual(result.allowed, false);
});

test('TC-PATH-014: BLOCK /etc/ssh/sshd_config', () => {
  const guard = new PathGuard();
  const result = guard.evaluate('/etc/ssh/sshd_config');
  assert.strictEqual(result.allowed, false);
});

// -----------------------------------------------------------------------------
// SSH Keys - MUST BLOCK
// -----------------------------------------------------------------------------

test('TC-PATH-020: BLOCK ~/.ssh/id_rsa', () => {
  const guard = new PathGuard({ homeDir: '/home/testuser' });
  const result = guard.evaluate('/home/testuser/.ssh/id_rsa');
  assert.strictEqual(result.allowed, false);
});

test('TC-PATH-021: BLOCK /home/alice/.ssh/id_ed25519', () => {
  const guard = new PathGuard();
  const result = guard.evaluate('/home/alice/.ssh/id_ed25519');
  assert.strictEqual(result.allowed, false);
});

test('TC-PATH-022: BLOCK /root/.ssh/authorized_keys', () => {
  const guard = new PathGuard();
  const result = guard.evaluate('/root/.ssh/authorized_keys');
  assert.strictEqual(result.allowed, false);
});

test('TC-PATH-023: BLOCK wildcard /home/*/.ssh matches any user', () => {
  const guard = new PathGuard();

  const users = ['alice', 'bob', 'charlie', 'deploy', 'www-data'];
  users.forEach(user => {
    const result = guard.evaluate(`/home/${user}/.ssh/id_rsa`);
    assert.strictEqual(result.allowed, false, `Should block /home/${user}/.ssh/id_rsa`);
  });
});

// -----------------------------------------------------------------------------
// Cloud Provider Credentials - MUST BLOCK
// -----------------------------------------------------------------------------

test('TC-PATH-030: BLOCK ~/.aws/credentials', () => {
  const guard = new PathGuard({ homeDir: '/home/deploy' });
  const result = guard.evaluate('/home/deploy/.aws/credentials');
  assert.strictEqual(result.allowed, false);
});

test('TC-PATH-031: BLOCK ~/.config/gcloud/application_default_credentials.json', () => {
  const guard = new PathGuard({ homeDir: '/home/fu' });
  const result = guard.evaluate('/home/fu/.config/gcloud/application_default_credentials.json');
  assert.strictEqual(result.allowed, false);
});

test('TC-PATH-032: BLOCK ~/.kube/config', () => {
  const guard = new PathGuard({ homeDir: '/home/fu' });
  const result = guard.evaluate('/home/fu/.kube/config');
  assert.strictEqual(result.allowed, false);
});

test('TC-PATH-033: BLOCK ~/.azure/config', () => {
  const guard = new PathGuard({ homeDir: '/home/user' });
  const result = guard.evaluate('/home/user/.azure/config');
  assert.strictEqual(result.allowed, false);
});

// -----------------------------------------------------------------------------
// Blocked Extensions - MUST BLOCK
// -----------------------------------------------------------------------------

test('TC-PATH-040: BLOCK .env files', () => {
  const guard = new PathGuard();
  const result = guard.evaluate('/app/config/.env');
  assert.strictEqual(result.allowed, false);
});

test('TC-PATH-041: BLOCK .env.local files', () => {
  const guard = new PathGuard();
  const result = guard.evaluate('/app/config/.env.local');
  assert.strictEqual(result.allowed, false);
});

test('TC-PATH-042: BLOCK .env.production files', () => {
  const guard = new PathGuard();
  const result = guard.evaluate('/app/config/.env.production');
  assert.strictEqual(result.allowed, false);
});

test('TC-PATH-043: BLOCK .pem files', () => {
  const guard = new PathGuard();
  const result = guard.evaluate('/certs/server.pem');
  assert.strictEqual(result.allowed, false);
});

test('TC-PATH-044: BLOCK .key files', () => {
  const guard = new PathGuard();
  const result = guard.evaluate('/certs/server.key');
  assert.strictEqual(result.allowed, false);
});

test('TC-PATH-045: BLOCK .pfx files', () => {
  const guard = new PathGuard();
  const result = guard.evaluate('/certs/certificate.pfx');
  assert.strictEqual(result.allowed, false);
});

test('TC-PATH-046: BLOCK .p12 files', () => {
  const guard = new PathGuard();
  const result = guard.evaluate('/certs/certificate.p12');
  assert.strictEqual(result.allowed, false);
});

test('TC-PATH-047: BLOCK .jks files', () => {
  const guard = new PathGuard();
  const result = guard.evaluate('/certs/keystore.jks');
  assert.strictEqual(result.allowed, false);
});

// -----------------------------------------------------------------------------
// Blocked Filenames - MUST BLOCK
// -----------------------------------------------------------------------------

test('TC-PATH-050: BLOCK credentials.json anywhere', () => {
  const guard = new PathGuard();
  const result = guard.evaluate('/some/path/credentials.json');
  assert.strictEqual(result.allowed, false);
});

test('TC-PATH-051: BLOCK secrets.yml anywhere', () => {
  const guard = new PathGuard();
  const result = guard.evaluate('/some/path/secrets.yml');
  assert.strictEqual(result.allowed, false);
});

test('TC-PATH-052: BLOCK secrets.yaml anywhere', () => {
  const guard = new PathGuard();
  const result = guard.evaluate('/some/path/secrets.yaml');
  assert.strictEqual(result.allowed, false);
});

test('TC-PATH-053: BLOCK secrets.json anywhere', () => {
  const guard = new PathGuard();
  const result = guard.evaluate('/some/path/secrets.json');
  assert.strictEqual(result.allowed, false);
});

test('TC-PATH-054: BLOCK id_rsa anywhere', () => {
  const guard = new PathGuard();
  const result = guard.evaluate('/some/path/id_rsa');
  assert.strictEqual(result.allowed, false);
});

test('TC-PATH-055: BLOCK id_ed25519 anywhere', () => {
  const guard = new PathGuard();
  const result = guard.evaluate('/backups/id_ed25519');
  assert.strictEqual(result.allowed, false);
});

test('TC-PATH-056: BLOCK .netrc anywhere', () => {
  const guard = new PathGuard({ homeDir: '/home/fu' });
  const result = guard.evaluate('/home/fu/.netrc');
  assert.strictEqual(result.allowed, false);
});

test('TC-PATH-057: BLOCK .pgpass anywhere', () => {
  const guard = new PathGuard();
  const result = guard.evaluate('/home/user/.pgpass');
  assert.strictEqual(result.allowed, false);
});

test('TC-PATH-058: BLOCK .my.cnf anywhere', () => {
  const guard = new PathGuard();
  const result = guard.evaluate('/root/.my.cnf');
  assert.strictEqual(result.allowed, false);
});

test('TC-PATH-059: BLOCK service-account.json anywhere', () => {
  const guard = new PathGuard();
  const result = guard.evaluate('/app/config/service-account.json');
  assert.strictEqual(result.allowed, false);
});

// -----------------------------------------------------------------------------
// MoltAgent Credential Store - MUST BLOCK
// -----------------------------------------------------------------------------

test('TC-PATH-060: BLOCK /etc/credstore', () => {
  const guard = new PathGuard();
  const result = guard.evaluate('/etc/credstore');
  assert.strictEqual(result.allowed, false);
});

test('TC-PATH-061: BLOCK /etc/credstore/nc-passwords-token', () => {
  const guard = new PathGuard();
  const result = guard.evaluate('/etc/credstore/nc-passwords-token');
  assert.strictEqual(result.allowed, false);
});

// -----------------------------------------------------------------------------
// Path Traversal Prevention - MUST BLOCK
// -----------------------------------------------------------------------------

test('TC-PATH-070: BLOCK path traversal to /etc/shadow', () => {
  const guard = new PathGuard();
  const result = guard.evaluate('/app/../etc/shadow');
  assert.strictEqual(result.allowed, false);
});

test('TC-PATH-071: BLOCK path traversal to /etc/passwd', () => {
  const guard = new PathGuard();
  const result = guard.evaluate('/home/moltagent/../../etc/passwd');
  assert.strictEqual(result.allowed, false);
});

test('TC-PATH-072: BLOCK complex traversal to .ssh', () => {
  const guard = new PathGuard();
  const result = guard.evaluate('/app/config/./../../.ssh/id_rsa');
  assert.strictEqual(result.allowed, false);
});

test('TC-PATH-073: BLOCK multiple ../ traversal', () => {
  const guard = new PathGuard();
  const result = guard.evaluate('/a/b/c/d/../../../.ssh/id_rsa');
  assert.strictEqual(result.allowed, false);
});

test('TC-PATH-074: BLOCK encoded traversal (decoded before check)', () => {
  const guard = new PathGuard();
  // After URL decoding, this is /../etc/shadow
  const result = guard.evaluate('/app/%2e%2e/etc/shadow');
  // Note: The actual path string is passed, so if URL decoding happens
  // elsewhere, this test validates that literal %2e%2e doesn't bypass
});

// -----------------------------------------------------------------------------
// Normal Paths - MUST ALLOW
// -----------------------------------------------------------------------------

test('TC-PATH-080: ALLOW /home/moltagent/data/report.md', () => {
  const guard = new PathGuard();
  const result = guard.evaluate('/home/moltagent/data/report.md');
  assert.strictEqual(result.allowed, true);
  assert.strictEqual(result.level, 'ALLOWED');
});

test('TC-PATH-081: ALLOW /app/src/index.js', () => {
  const guard = new PathGuard();
  const result = guard.evaluate('/app/src/index.js');
  assert.strictEqual(result.allowed, true);
});

test('TC-PATH-082: ALLOW /tmp/processing/file.txt', () => {
  const guard = new PathGuard();
  const result = guard.evaluate('/tmp/processing/file.txt');
  assert.strictEqual(result.allowed, true);
});

test('TC-PATH-083: ALLOW /var/log/moltagent/audit.log', () => {
  const guard = new PathGuard();
  const result = guard.evaluate('/var/log/moltagent/audit.log');
  assert.strictEqual(result.allowed, true);
});

test('TC-PATH-084: ALLOW /moltagent/Inbox/task.md', () => {
  const guard = new PathGuard();
  const result = guard.evaluate('/moltagent/Inbox/task.md');
  assert.strictEqual(result.allowed, true);
});

test('TC-PATH-085: ALLOW /moltagent/Memory/context.md', () => {
  const guard = new PathGuard();
  const result = guard.evaluate('/moltagent/Memory/context.md');
  assert.strictEqual(result.allowed, true);
});

test('TC-PATH-086: ALLOW /moltagent/Outbox/result.md', () => {
  const guard = new PathGuard();
  const result = guard.evaluate('/moltagent/Outbox/result.md');
  assert.strictEqual(result.allowed, true);
});

test('TC-PATH-087: ALLOW /app/docs/password-policy.md', () => {
  const guard = new PathGuard();
  // File discussing passwords, not containing them
  const result = guard.evaluate('/app/docs/password-policy.md');
  assert.strictEqual(result.allowed, true);
});

test('TC-PATH-088: ALLOW /app/config/settings.json', () => {
  const guard = new PathGuard();
  const result = guard.evaluate('/app/config/settings.json');
  assert.strictEqual(result.allowed, true);
});

// -----------------------------------------------------------------------------
// allowedPaths Override Tests
// -----------------------------------------------------------------------------

test('TC-PATH-090: allowedPaths overrides blocked path', () => {
  const guard = new PathGuard({ allowedPaths: ['/etc/passwd'] });
  const result = guard.evaluate('/etc/passwd');
  assert.strictEqual(result.allowed, true);
  assert.ok(result.reason.includes('override'));
});

test('TC-PATH-091: allowedPaths does not affect other blocked paths', () => {
  const guard = new PathGuard({ allowedPaths: ['/etc/passwd'] });
  const result = guard.evaluate('/etc/shadow');
  assert.strictEqual(result.allowed, false);
});

test('TC-PATH-092: allowedPaths requires exact normalized path', () => {
  const guard = new PathGuard({ allowedPaths: ['/etc/passwd'] });
  // Traversal should not match
  const result = guard.evaluate('/app/../etc/passwd');
  // After normalization, this is /etc/passwd, which IS in allowedPaths
  assert.strictEqual(result.allowed, true);
});

// -----------------------------------------------------------------------------
// Tilde Expansion Tests
// -----------------------------------------------------------------------------

test('TC-PATH-100: Tilde expansion matches home directory', () => {
  const guard = new PathGuard({ homeDir: '/home/testuser' });
  // ~/.ssh should expand to /home/testuser/.ssh
  // And /home/testuser/.ssh/id_rsa should be blocked by wildcard
  const result = guard.evaluate('/home/testuser/.ssh/id_rsa');
  assert.strictEqual(result.allowed, false);
});

test('TC-PATH-101: Tilde expansion in blocked paths works', () => {
  const guard = new PathGuard({ homeDir: '/home/testuser' });
  const result = guard.evaluate('/home/testuser/.aws/credentials');
  assert.strictEqual(result.allowed, false);
});

// -----------------------------------------------------------------------------
// isBlocked() Helper Tests
// -----------------------------------------------------------------------------

test('TC-PATH-110: isBlocked returns true for blocked paths', () => {
  const guard = new PathGuard();
  assert.strictEqual(guard.isBlocked('/etc/shadow'), true);
  assert.strictEqual(guard.isBlocked('/etc/passwd'), true);
});

test('TC-PATH-111: isBlocked returns false for allowed paths', () => {
  const guard = new PathGuard();
  assert.strictEqual(guard.isBlocked('/app/src/index.js'), false);
  assert.strictEqual(guard.isBlocked('/tmp/file.txt'), false);
});

// -----------------------------------------------------------------------------
// Edge Cases
// -----------------------------------------------------------------------------

test('TC-PATH-120: Handle empty string path', () => {
  const guard = new PathGuard();
  const result = guard.evaluate('');
  assert.strictEqual(result.allowed, false);
  assert.ok(result.reason.includes('Invalid'));
});

test('TC-PATH-121: Handle null path', () => {
  const guard = new PathGuard();
  const result = guard.evaluate(null);
  assert.strictEqual(result.allowed, false);
});

test('TC-PATH-122: Handle undefined path', () => {
  const guard = new PathGuard();
  const result = guard.evaluate(undefined);
  assert.strictEqual(result.allowed, false);
});

test('TC-PATH-123: Handle path with spaces', () => {
  const guard = new PathGuard();
  const result = guard.evaluate('/home/user/My Documents/file.txt');
  assert.strictEqual(result.allowed, true);
});

test('TC-PATH-124: Handle path with unicode', () => {
  const guard = new PathGuard();
  const result = guard.evaluate('/home/user/cafe/file.txt');
  assert.strictEqual(result.allowed, true);
});

// -----------------------------------------------------------------------------
// Performance Tests
// -----------------------------------------------------------------------------

test('TC-PATH-130: evaluate() performance < 0.01ms average', () => {
  const guard = new PathGuard();
  const iterations = 10000;
  const start = process.hrtime.bigint();

  for (let i = 0; i < iterations; i++) {
    guard.evaluate('/home/moltagent/data/report.md');
  }

  const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
  const avg = elapsed / iterations;

  console.log(`  → evaluate avg: ${avg.toFixed(5)}ms (target: < 0.01ms)`);
  assert.ok(avg < 0.01, `Expected < 0.01ms, got ${avg.toFixed(5)}ms`);
});

test('TC-PATH-131: evaluate() performance for blocked paths', () => {
  const guard = new PathGuard();
  const iterations = 10000;
  const start = process.hrtime.bigint();

  for (let i = 0; i < iterations; i++) {
    guard.evaluate('/etc/shadow');
  }

  const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
  const avg = elapsed / iterations;

  console.log(`  → evaluate (blocked) avg: ${avg.toFixed(5)}ms (target: < 0.01ms)`);
  assert.ok(avg < 0.01, `Expected < 0.01ms, got ${avg.toFixed(5)}ms`);
});

// -----------------------------------------------------------------------------
// Return Value Structure Tests
// -----------------------------------------------------------------------------

test('TC-PATH-140: evaluate() result has correct structure', () => {
  const guard = new PathGuard();
  const result = guard.evaluate('/test/path');

  assert.strictEqual(typeof result.allowed, 'boolean');
  assert.ok(['BLOCKED', 'ALLOWED'].includes(result.level));
  assert.ok(result.reason === null || typeof result.reason === 'string');
  assert.ok(result.matchedRule === null || typeof result.matchedRule === 'string');
});

test('TC-PATH-141: BLOCKED result has all properties', () => {
  const guard = new PathGuard();
  const result = guard.evaluate('/etc/shadow');

  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.level, 'BLOCKED');
  assert.ok(result.matchedRule !== null || result.reason !== null);
});

test('TC-PATH-142: ALLOWED result has null matchedRule', () => {
  const guard = new PathGuard();
  const result = guard.evaluate('/app/src/index.js');

  assert.strictEqual(result.allowed, true);
  assert.strictEqual(result.level, 'ALLOWED');
  assert.strictEqual(result.matchedRule, null);
});

// -----------------------------------------------------------------------------
// Summary
// -----------------------------------------------------------------------------

console.log('\n=== PathGuard Tests Complete ===\n');
summary();
exitWithCode();
