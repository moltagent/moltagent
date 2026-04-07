/*
 * Moltagent - Sovereign AI Security Layer
 * Copyright (C) 2026 Moltagent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 */

/**
 * Unit Tests for SecurityScanner — scanToolDefinitions()
 *
 * Tests the structured tool-definition scanner added to SecurityScanner:
 * - Valid input passes cleanly
 * - Domain allowlist enforcement (missing domain, empty allowlist, blocked domain)
 * - HTTPS-only enforcement
 * - SSRF protection (localhost, private IP ranges, metadata endpoints)
 * - HTTP method validation (valid methods pass, CONNECT and garbage fail)
 * - Path traversal detection (.., //)
 * - Credential name sanity check
 * - Edge cases: null/undefined input, operation count warning
 * - Malformed URL handling
 *
 * @module test/unit/skill-forge/security-scanner-v2.test.js
 */

'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const { SecurityScanner } = require('../../../src/skill-forge/security-scanner');

console.log('\n=== SecurityScanner v2 Tests (scanToolDefinitions) ===\n');

// -----------------------------------------------------------------------------
// Test Fixtures
// -----------------------------------------------------------------------------

const validToolDefs = {
  skillId: 'test-skill',
  apiBase: 'https://api.example.com',
  auth: { type: 'bearer', credentialName: 'test-key' },
  security: { allowedDomains: ['api.example.com'] },
  operations: [
    { name: 'list', method: 'GET', path: '/items', description: 'List items' },
    { name: 'create', method: 'POST', path: '/items', description: 'Create item' },
  ],
};

// -----------------------------------------------------------------------------
// Valid input — happy path
// -----------------------------------------------------------------------------

test('TC-SSV2-001: scanToolDefinitions passes for valid HTTPS operations with correct domains', () => {
  const scanner = new SecurityScanner();
  const result = scanner.scanToolDefinitions(validToolDefs);
  assert.strictEqual(result.safe, true);
});

test('TC-SSV2-002: scanToolDefinitions returns { safe: true, violations: [], warnings: [] } for valid input', () => {
  const scanner = new SecurityScanner();
  const result = scanner.scanToolDefinitions(validToolDefs);
  assert.strictEqual(result.safe, true);
  assert.deepStrictEqual(result.violations, []);
  assert.deepStrictEqual(result.warnings, []);
});

// -----------------------------------------------------------------------------
// Domain validation
// -----------------------------------------------------------------------------

test('TC-SSV2-003: scanToolDefinitions fails when domain not in allowlist', () => {
  const scanner = new SecurityScanner();
  const toolDefs = {
    ...validToolDefs,
    apiBase: 'https://unauthorized.evil.com',
    security: { allowedDomains: ['api.example.com'] },
  };
  const result = scanner.scanToolDefinitions(toolDefs);
  assert.strictEqual(result.safe, false);
  assert.ok(result.violations.some(v => v.includes('unauthorized.evil.com') || v.includes('not in allowlist')));
});

test('TC-SSV2-004: scanToolDefinitions passes when allowedDomains is empty (no domain restriction)', () => {
  const scanner = new SecurityScanner();
  const toolDefs = {
    ...validToolDefs,
    security: { allowedDomains: [] },
  };
  const result = scanner.scanToolDefinitions(toolDefs);
  assert.strictEqual(result.safe, true);
});

test('TC-SSV2-005: scanToolDefinitions fails for blocked exfiltration domain (webhook.site)', () => {
  const scanner = new SecurityScanner();
  const toolDefs = {
    skillId: 'test',
    apiBase: 'https://webhook.site',
    auth: { type: 'none', credentialName: 'my-label' },
    security: { allowedDomains: ['webhook.site'] },
    operations: [
      { name: 'send', method: 'POST', path: '/abc123', description: 'Send data' },
    ],
  };
  const result = scanner.scanToolDefinitions(toolDefs);
  assert.strictEqual(result.safe, false);
  assert.ok(result.violations.some(v => v.includes('webhook.site')));
});

// -----------------------------------------------------------------------------
// HTTPS enforcement
// -----------------------------------------------------------------------------

test('TC-SSV2-006: scanToolDefinitions fails for HTTP URL', () => {
  const scanner = new SecurityScanner();
  const toolDefs = {
    ...validToolDefs,
    apiBase: 'http://api.example.com',
    security: { allowedDomains: ['api.example.com'] },
  };
  const result = scanner.scanToolDefinitions(toolDefs);
  assert.strictEqual(result.safe, false);
  assert.ok(result.violations.some(v => v.includes('non-HTTPS') || v.includes('http:')));
});

test('TC-SSV2-007: scanToolDefinitions passes for HTTPS URL', () => {
  const scanner = new SecurityScanner();
  const result = scanner.scanToolDefinitions(validToolDefs);
  assert.strictEqual(result.safe, true);
});

// -----------------------------------------------------------------------------
// SSRF protection
// -----------------------------------------------------------------------------

test('TC-SSV2-008: scanToolDefinitions fails for localhost', () => {
  const scanner = new SecurityScanner();
  const toolDefs = {
    ...validToolDefs,
    apiBase: 'https://localhost',
    security: { allowedDomains: [] },
  };
  const result = scanner.scanToolDefinitions(toolDefs);
  assert.strictEqual(result.safe, false);
  assert.ok(result.violations.some(v => v.includes('localhost') || v.includes('private')));
});

test('TC-SSV2-009: scanToolDefinitions fails for 127.0.0.1', () => {
  const scanner = new SecurityScanner();
  const toolDefs = {
    ...validToolDefs,
    apiBase: 'https://127.0.0.1',
    security: { allowedDomains: [] },
  };
  const result = scanner.scanToolDefinitions(toolDefs);
  assert.strictEqual(result.safe, false);
  assert.ok(result.violations.some(v => v.includes('127.0.0.1') || v.includes('private')));
});

test('TC-SSV2-010: scanToolDefinitions fails for 10.0.0.1 (Class A private)', () => {
  const scanner = new SecurityScanner();
  const toolDefs = {
    ...validToolDefs,
    apiBase: 'https://10.0.0.1',
    security: { allowedDomains: [] },
  };
  const result = scanner.scanToolDefinitions(toolDefs);
  assert.strictEqual(result.safe, false);
  assert.ok(result.violations.some(v => v.includes('10.0.0.1') || v.includes('private')));
});

test('TC-SSV2-011: scanToolDefinitions fails for 169.254.169.254 (link-local)', () => {
  const scanner = new SecurityScanner();
  const toolDefs = {
    ...validToolDefs,
    apiBase: 'https://169.254.169.254',
    security: { allowedDomains: [] },
  };
  const result = scanner.scanToolDefinitions(toolDefs);
  assert.strictEqual(result.safe, false);
  // 169.254.169.254 is in METADATA_ENDPOINTS — caught by either metadata or private check
  assert.ok(result.violations.some(v =>
    v.includes('169.254.169.254') || v.includes('private') || v.includes('metadata')
  ));
});

test('TC-SSV2-012: scanToolDefinitions fails for metadata.google.internal', () => {
  const scanner = new SecurityScanner();
  const toolDefs = {
    ...validToolDefs,
    apiBase: 'https://metadata.google.internal',
    security: { allowedDomains: [] },
  };
  const result = scanner.scanToolDefinitions(toolDefs);
  assert.strictEqual(result.safe, false);
  assert.ok(result.violations.some(v =>
    v.includes('metadata.google.internal') || v.includes('private') || v.includes('metadata')
  ));
});

// -----------------------------------------------------------------------------
// HTTP method validation
// -----------------------------------------------------------------------------

test('TC-SSV2-013: scanToolDefinitions passes for valid HTTP methods (GET, POST, PUT, PATCH, DELETE)', () => {
  const scanner = new SecurityScanner();
  const toolDefs = {
    skillId: 'test',
    apiBase: 'https://api.example.com',
    auth: { type: 'none', credentialName: 'my-label' },
    security: { allowedDomains: ['api.example.com'] },
    operations: [
      { name: 'op1', method: 'GET',    path: '/a', description: 'a' },
      { name: 'op2', method: 'POST',   path: '/b', description: 'b' },
      { name: 'op3', method: 'PUT',    path: '/c', description: 'c' },
      { name: 'op4', method: 'PATCH',  path: '/d', description: 'd' },
      { name: 'op5', method: 'DELETE', path: '/e', description: 'e' },
    ],
  };
  const result = scanner.scanToolDefinitions(toolDefs);
  assert.strictEqual(result.safe, true);
});

test('TC-SSV2-014: scanToolDefinitions fails for CONNECT method', () => {
  const scanner = new SecurityScanner();
  const toolDefs = {
    ...validToolDefs,
    operations: [
      { name: 'tunnel', method: 'CONNECT', path: '/items', description: 'Tunnel' },
    ],
  };
  const result = scanner.scanToolDefinitions(toolDefs);
  assert.strictEqual(result.safe, false);
  assert.ok(result.violations.some(v => v.includes('CONNECT') || v.includes('method')));
});

test('TC-SSV2-015: scanToolDefinitions fails for invalid method string', () => {
  const scanner = new SecurityScanner();
  const toolDefs = {
    ...validToolDefs,
    operations: [
      { name: 'bogus', method: 'HACK', path: '/items', description: 'Bogus' },
    ],
  };
  const result = scanner.scanToolDefinitions(toolDefs);
  assert.strictEqual(result.safe, false);
  assert.ok(result.violations.some(v => v.includes('HACK') || v.includes('method')));
});

// -----------------------------------------------------------------------------
// Path traversal
// -----------------------------------------------------------------------------

test('TC-SSV2-016: scanToolDefinitions fails for path with ..', () => {
  const scanner = new SecurityScanner();
  const toolDefs = {
    ...validToolDefs,
    operations: [
      { name: 'traverse', method: 'GET', path: '/../../etc/passwd', description: 'Traversal' },
    ],
  };
  const result = scanner.scanToolDefinitions(toolDefs);
  assert.strictEqual(result.safe, false);
  assert.ok(result.violations.some(v => v.includes('path') || v.includes('..')));
});

test('TC-SSV2-017: scanToolDefinitions fails for path with //', () => {
  const scanner = new SecurityScanner();
  const toolDefs = {
    ...validToolDefs,
    operations: [
      { name: 'double_slash', method: 'GET', path: '//admin', description: 'Double slash' },
    ],
  };
  const result = scanner.scanToolDefinitions(toolDefs);
  assert.strictEqual(result.safe, false);
  assert.ok(result.violations.some(v => v.includes('path') || v.includes('//')));
});

// -----------------------------------------------------------------------------
// Credential name check
// -----------------------------------------------------------------------------

test('TC-SSV2-018: scanToolDefinitions passes for clean credential label name', () => {
  const scanner = new SecurityScanner();
  // 'trello-api' matches no CREDENTIAL_PATTERNS — just a label name
  const toolDefs = {
    ...validToolDefs,
    auth: { type: 'bearer', credentialName: 'trello-api' },
  };
  const result = scanner.scanToolDefinitions(toolDefs);
  assert.strictEqual(result.safe, true);
});

test('TC-SSV2-019: scanToolDefinitions fails when credentialName looks like a hardcoded secret (sk- key)', () => {
  const scanner = new SecurityScanner();
  // sk- followed by 20+ alphanumeric chars matches api_key_generic pattern
  const toolDefs = {
    ...validToolDefs,
    auth: { type: 'bearer', credentialName: 'sk-' + 'a'.repeat(25) },
  };
  const result = scanner.scanToolDefinitions(toolDefs);
  assert.strictEqual(result.safe, false);
  assert.ok(result.violations.some(v => v.includes('Credential') || v.includes('secret')));
});

// -----------------------------------------------------------------------------
// Edge cases
// -----------------------------------------------------------------------------

test('TC-SSV2-020: scanToolDefinitions fails gracefully for null input', () => {
  const scanner = new SecurityScanner();
  const result = scanner.scanToolDefinitions(null);
  assert.strictEqual(result.safe, false);
  assert.ok(result.violations.length > 0);
});

test('TC-SSV2-021: scanToolDefinitions fails gracefully for undefined input', () => {
  const scanner = new SecurityScanner();
  const result = scanner.scanToolDefinitions(undefined);
  assert.strictEqual(result.safe, false);
  assert.ok(result.violations.length > 0);
});

test('TC-SSV2-022: scanToolDefinitions warns for >20 operations', () => {
  const scanner = new SecurityScanner();
  const manyOps = Array.from({ length: 21 }, (_, i) => ({
    name: `op${i}`,
    method: 'GET',
    path: `/items/${i}`,
    description: `Operation ${i}`,
  }));
  const toolDefs = {
    skillId: 'big-skill',
    apiBase: 'https://api.example.com',
    auth: { type: 'none', credentialName: 'my-label' },
    security: { allowedDomains: ['api.example.com'] },
    operations: manyOps,
  };
  const result = scanner.scanToolDefinitions(toolDefs);
  assert.ok(result.warnings.some(w => w.includes('21') || w.includes('operation')));
});

// -----------------------------------------------------------------------------
// Malformed / invalid URL
// -----------------------------------------------------------------------------

test('TC-SSV2-023: scanToolDefinitions fails for malformed URL (non-parseable)', () => {
  const scanner = new SecurityScanner();
  const toolDefs = {
    skillId: 'test',
    apiBase: 'not-a-url-at-all',
    auth: { type: 'none', credentialName: 'my-label' },
    security: { allowedDomains: [] },
    operations: [
      { name: 'op', method: 'GET', path: '/things', description: 'Do thing' },
    ],
  };
  const result = scanner.scanToolDefinitions(toolDefs);
  assert.strictEqual(result.safe, false);
  assert.ok(result.violations.some(v => v.includes('invalid URL') || v.includes('URL')));
});

// -----------------------------------------------------------------------------
// Summary
// -----------------------------------------------------------------------------

console.log('\n=== SecurityScanner v2 Tests Complete ===\n');

setTimeout(() => { summary(); exitWithCode(); }, 500);
