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
 * Unit Tests for EgressGuard Module
 *
 * Tests outbound network control:
 * - Domain allowlist/blocklist
 * - Known exfiltration service blocking
 * - SSRF prevention (private IPs)
 * - Metadata endpoint blocking
 * - Protocol restrictions
 * - Subdomain matching
 *
 * @module test/unit/guards/egress-guard.test.js
 */

'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const EgressGuard = require('../../../src/security/guards/egress-guard');

console.log('\n=== EgressGuard Tests ===\n');

// -----------------------------------------------------------------------------
// Constructor Tests
// -----------------------------------------------------------------------------

test('TC-EG-001: Constructor creates instance with default settings', () => {
  const guard = new EgressGuard();
  assert.ok(guard instanceof EgressGuard);
  assert.strictEqual(guard.mode, 'allowlist');
  assert.ok(guard.allowedDomains.size > 0);
});

test('TC-EG-002: Constructor accepts custom allowedDomains', () => {
  const guard = new EgressGuard({
    allowedDomains: ['api.example.com', 'data.example.com'],
  });
  assert.ok(guard.allowedDomains.has('api.example.com'));
  assert.ok(guard.allowedDomains.has('data.example.com'));
});

test('TC-EG-003: Constructor auto-adds nextcloudDomain', () => {
  const guard = new EgressGuard({
    nextcloudDomain: 'nc.example.com',
  });
  assert.ok(guard.allowedDomains.has('nc.example.com'));
});

test('TC-EG-004: Constructor auto-adds ollamaHost', () => {
  const guard = new EgressGuard({
    ollamaHost: 'YOUR_OLLAMA_IP',
  });
  assert.ok(guard.allowedDomains.has('YOUR_OLLAMA_IP'));
  assert.strictEqual(guard.ollamaHost, 'YOUR_OLLAMA_IP');
});

test('TC-EG-005: Constructor accepts additionalBlocked domains', () => {
  const guard = new EgressGuard({
    additionalBlocked: ['custom-evil.com'],
  });
  assert.ok(guard.blockedDomains.has('custom-evil.com'));
});

test('TC-EG-006: Constructor accepts blocklist mode', () => {
  const guard = new EgressGuard({ mode: 'blocklist' });
  assert.strictEqual(guard.mode, 'blocklist');
});

// -----------------------------------------------------------------------------
// Known Exfiltration Services - MUST BLOCK
// -----------------------------------------------------------------------------

test('TC-EG-010: BLOCK webhook.site', () => {
  const guard = new EgressGuard();
  const result = guard.evaluate('https://webhook.site/abc123');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.category, 'exfiltration');
});

test('TC-EG-011: BLOCK subdomain of webhook.site', () => {
  const guard = new EgressGuard();
  const result = guard.evaluate('https://evil.webhook.site/abc123');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.category, 'exfiltration');
});

test('TC-EG-012: BLOCK requestbin.com', () => {
  const guard = new EgressGuard();
  const result = guard.evaluate('https://requestbin.com/r/abc');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.category, 'exfiltration');
});

test('TC-EG-013: BLOCK pipedream.net', () => {
  const guard = new EgressGuard();
  const result = guard.evaluate('https://pipedream.net/hook/abc');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.category, 'exfiltration');
});

test('TC-EG-014: BLOCK pastebin.com', () => {
  const guard = new EgressGuard();
  const result = guard.evaluate('https://pastebin.com/raw/abc');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.category, 'exfiltration');
});

test('TC-EG-015: BLOCK transfer.sh', () => {
  const guard = new EgressGuard();
  const result = guard.evaluate('https://transfer.sh/abc/file.txt');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.category, 'exfiltration');
});

test('TC-EG-016: BLOCK file.io', () => {
  const guard = new EgressGuard();
  const result = guard.evaluate('https://file.io/abc123');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.category, 'exfiltration');
});

test('TC-EG-017: BLOCK bit.ly', () => {
  const guard = new EgressGuard();
  const result = guard.evaluate('https://bit.ly/abc123');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.category, 'exfiltration');
});

test('TC-EG-018: BLOCK tinyurl.com', () => {
  const guard = new EgressGuard();
  const result = guard.evaluate('https://tinyurl.com/abc123');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.category, 'exfiltration');
});

test('TC-EG-019: BLOCK catbox.moe', () => {
  const guard = new EgressGuard();
  const result = guard.evaluate('https://catbox.moe/upload');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.category, 'exfiltration');
});

// -----------------------------------------------------------------------------
// SSRF Prevention - Private IPs - MUST BLOCK
// -----------------------------------------------------------------------------

test('TC-EG-020: BLOCK 127.0.0.1 (localhost)', () => {
  const guard = new EgressGuard();
  const result = guard.evaluate('http://127.0.0.1:8080/admin');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.category, 'ssrf');
});

test('TC-EG-021: BLOCK 10.x.x.x (Class A private)', () => {
  const guard = new EgressGuard();
  const result = guard.evaluate('http://10.0.0.1/internal');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.category, 'ssrf');
});

test('TC-EG-022: BLOCK 192.168.x.x (Class C private)', () => {
  const guard = new EgressGuard();
  const result = guard.evaluate('http://192.168.1.1/router');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.category, 'ssrf');
});

test('TC-EG-023: BLOCK 172.16.x.x (Class B private)', () => {
  const guard = new EgressGuard();
  const result = guard.evaluate('http://172.16.0.1/service');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.category, 'ssrf');
});

test('TC-EG-024: BLOCK 172.31.x.x (Class B private edge)', () => {
  const guard = new EgressGuard();
  const result = guard.evaluate('http://172.31.255.255/api');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.category, 'ssrf');
});

test('TC-EG-025: BLOCK ::1 (IPv6 loopback)', () => {
  const guard = new EgressGuard();
  const result = guard.evaluate('http://[::1]/admin');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.category, 'ssrf');
});

test('TC-EG-026: BLOCK 169.254.x.x (link-local)', () => {
  const guard = new EgressGuard();
  const result = guard.evaluate('http://169.254.1.1/api');
  assert.strictEqual(result.allowed, false);
  // Could be 'ssrf' or 'metadata' depending on implementation
  assert.ok(['ssrf', 'metadata'].includes(result.category));
});

// -----------------------------------------------------------------------------
// Metadata Endpoints - MUST BLOCK
// -----------------------------------------------------------------------------

test('TC-EG-030: BLOCK 169.254.169.254 (AWS/GCP/Azure metadata)', () => {
  const guard = new EgressGuard();
  const result = guard.evaluate('http://169.254.169.254/latest/meta-data/');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.category, 'metadata');
});

test('TC-EG-031: BLOCK metadata.google.internal', () => {
  const guard = new EgressGuard();
  const result = guard.evaluate('http://metadata.google.internal/v1/');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.category, 'metadata');
});

test('TC-EG-032: BLOCK metadata.hetzner.cloud', () => {
  const guard = new EgressGuard();
  const result = guard.evaluate('http://metadata.hetzner.cloud/v1/metadata');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.category, 'metadata');
});

// -----------------------------------------------------------------------------
// Dangerous Protocols - MUST BLOCK
// -----------------------------------------------------------------------------

test('TC-EG-040: BLOCK file:// protocol', () => {
  const guard = new EgressGuard();
  const result = guard.evaluate('file:///etc/passwd');
  assert.strictEqual(result.allowed, false);
});

test('TC-EG-041: BLOCK ftp:// protocol', () => {
  const guard = new EgressGuard();
  const result = guard.evaluate('ftp://files.example.com/data');
  assert.strictEqual(result.allowed, false);
});

test('TC-EG-042: BLOCK javascript: protocol', () => {
  const guard = new EgressGuard();
  const result = guard.evaluate('javascript:alert(1)');
  assert.strictEqual(result.allowed, false);
});

test('TC-EG-043: BLOCK data: protocol', () => {
  const guard = new EgressGuard();
  const result = guard.evaluate('data:text/html,<script>alert(1)</script>');
  assert.strictEqual(result.allowed, false);
});

// -----------------------------------------------------------------------------
// Invalid URLs - MUST BLOCK
// -----------------------------------------------------------------------------

test('TC-EG-050: BLOCK invalid URL (not a URL)', () => {
  const guard = new EgressGuard();
  const result = guard.evaluate('not a url at all');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.category, 'invalid_url');
});

test('TC-EG-051: BLOCK empty string', () => {
  const guard = new EgressGuard();
  const result = guard.evaluate('');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.category, 'invalid_url');
});

test('TC-EG-052: BLOCK null URL', () => {
  const guard = new EgressGuard();
  const result = guard.evaluate(null);
  assert.strictEqual(result.allowed, false);
});

test('TC-EG-053: BLOCK undefined URL', () => {
  const guard = new EgressGuard();
  const result = guard.evaluate(undefined);
  assert.strictEqual(result.allowed, false);
});

// -----------------------------------------------------------------------------
// Not in Allowlist - MUST BLOCK (in allowlist mode)
// -----------------------------------------------------------------------------

test('TC-EG-060: BLOCK domain not in allowlist', () => {
  const guard = new EgressGuard({
    allowedDomains: ['api.anthropic.com'],
  });
  const result = guard.evaluate('https://random-api.example.com/data');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.category, 'not_in_allowlist');
});

test('TC-EG-061: BLOCK malicious domain not in allowlist', () => {
  const guard = new EgressGuard({
    allowedDomains: ['api.anthropic.com'],
  });
  const result = guard.evaluate('https://malicious-site.com/steal');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.category, 'not_in_allowlist');
});

// -----------------------------------------------------------------------------
// Allowed Domains - MUST ALLOW
// -----------------------------------------------------------------------------

test('TC-EG-070: ALLOW api.anthropic.com', () => {
  const guard = new EgressGuard({
    allowedDomains: ['api.anthropic.com', 'api.openai.com'],
  });
  const result = guard.evaluate('https://api.anthropic.com/v1/messages');
  assert.strictEqual(result.allowed, true);
  assert.strictEqual(result.level, 'ALLOWED');
});

test('TC-EG-071: ALLOW api.openai.com', () => {
  const guard = new EgressGuard({
    allowedDomains: ['api.anthropic.com', 'api.openai.com'],
  });
  const result = guard.evaluate('https://api.openai.com/v1/chat');
  assert.strictEqual(result.allowed, true);
});

test('TC-EG-072: ALLOW configured Nextcloud domain', () => {
  const guard = new EgressGuard({
    allowedDomains: ['api.anthropic.com'],
    nextcloudDomain: 'nc.example.com',
  });
  const result = guard.evaluate('https://nc.example.com/ocs/v2.php/apps');
  assert.strictEqual(result.allowed, true);
});

test('TC-EG-073: ALLOW configured Ollama host (HTTP)', () => {
  const guard = new EgressGuard({
    allowedDomains: ['api.anthropic.com'],
    ollamaHost: 'YOUR_OLLAMA_IP',
  });
  // Ollama typically runs on HTTP
  const result = guard.evaluate('http://YOUR_OLLAMA_IP:11434/api/generate');
  assert.strictEqual(result.allowed, true);
});

test('TC-EG-074: ALLOW localhost HTTP for Ollama', () => {
  const guard = new EgressGuard({
    ollamaHost: 'localhost',
  });
  const result = guard.evaluate('http://localhost:11434/api/generate');
  assert.strictEqual(result.allowed, true);
});

// -----------------------------------------------------------------------------
// isInternal() Helper Tests
// -----------------------------------------------------------------------------

test('TC-EG-080: isInternal returns true for 127.0.0.1', () => {
  const guard = new EgressGuard();
  assert.strictEqual(guard.isInternal('http://127.0.0.1:3000'), true);
});

test('TC-EG-081: isInternal returns true for 10.x.x.x', () => {
  const guard = new EgressGuard();
  assert.strictEqual(guard.isInternal('http://10.0.0.5/api'), true);
});

test('TC-EG-082: isInternal returns true for 192.168.x.x', () => {
  const guard = new EgressGuard();
  assert.strictEqual(guard.isInternal('http://192.168.1.100/data'), true);
});

test('TC-EG-083: isInternal returns false for public domain', () => {
  const guard = new EgressGuard();
  assert.strictEqual(guard.isInternal('https://api.anthropic.com'), false);
});

test('TC-EG-084: isInternal returns false for public IP', () => {
  const guard = new EgressGuard();
  assert.strictEqual(guard.isInternal('https://8.8.8.8/dns'), false);
});

// -----------------------------------------------------------------------------
// getAllowedDomains() and getBlockedDomains() Tests
// -----------------------------------------------------------------------------

test('TC-EG-090: getAllowedDomains returns array', () => {
  const guard = new EgressGuard();
  const domains = guard.getAllowedDomains();
  assert.ok(Array.isArray(domains));
  assert.ok(domains.length > 0);
});

test('TC-EG-091: getBlockedDomains returns array', () => {
  const guard = new EgressGuard();
  const domains = guard.getBlockedDomains();
  assert.ok(Array.isArray(domains));
  assert.ok(domains.length > 0);
});

test('TC-EG-092: getBlockedDomains includes known exfiltration services', () => {
  const guard = new EgressGuard();
  const domains = guard.getBlockedDomains();
  assert.ok(domains.includes('webhook.site'));
  assert.ok(domains.includes('pastebin.com'));
  assert.ok(domains.includes('bit.ly'));
});

// -----------------------------------------------------------------------------
// Subdomain Matching Tests
// -----------------------------------------------------------------------------

test('TC-EG-100: Subdomain matching blocks deep subdomains', () => {
  const guard = new EgressGuard();
  const result = guard.evaluate('https://a.b.c.webhook.site/data');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.category, 'exfiltration');
});

test('TC-EG-101: Subdomain matching does not false positive on similar domains', () => {
  const guard = new EgressGuard({
    allowedDomains: ['webhooksite.example.com'], // Similar but not webhook.site
  });
  // This should NOT be blocked as exfiltration (it's not webhook.site)
  const result = guard.evaluate('https://webhooksite.example.com/api');
  // It should be allowed because it's in the allowlist
  assert.strictEqual(result.allowed, true);
});

// -----------------------------------------------------------------------------
// Case Insensitivity Tests
// -----------------------------------------------------------------------------

test('TC-EG-110: Domain matching is case insensitive', () => {
  const guard = new EgressGuard({
    allowedDomains: ['api.anthropic.com'],
  });
  const result = guard.evaluate('https://API.ANTHROPIC.COM/v1/messages');
  assert.strictEqual(result.allowed, true);
});

test('TC-EG-111: Blocked domain matching is case insensitive', () => {
  const guard = new EgressGuard();
  const result = guard.evaluate('https://WEBHOOK.SITE/abc');
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.category, 'exfiltration');
});

// -----------------------------------------------------------------------------
// Edge Cases
// -----------------------------------------------------------------------------

test('TC-EG-120: Handle URL with port', () => {
  const guard = new EgressGuard({
    allowedDomains: ['api.example.com'],
  });
  const result = guard.evaluate('https://api.example.com:8443/data');
  assert.strictEqual(result.allowed, true);
});

test('TC-EG-121: Handle URL with path and query', () => {
  const guard = new EgressGuard({
    allowedDomains: ['api.example.com'],
  });
  const result = guard.evaluate('https://api.example.com/v1/data?key=value&other=test');
  assert.strictEqual(result.allowed, true);
});

test('TC-EG-122: Handle URL with fragment', () => {
  const guard = new EgressGuard({
    allowedDomains: ['docs.example.com'],
  });
  const result = guard.evaluate('https://docs.example.com/page#section');
  assert.strictEqual(result.allowed, true);
});

test('TC-EG-123: Handle URL with authentication (should still check domain)', () => {
  const guard = new EgressGuard({
    allowedDomains: ['api.example.com'],
  });
  // URL with embedded credentials
  const result = guard.evaluate('https://user:pass@api.example.com/data');
  assert.strictEqual(result.allowed, true);
});

// -----------------------------------------------------------------------------
// Performance Tests
// -----------------------------------------------------------------------------

test('TC-EG-130: evaluate() performance < 0.01ms average', () => {
  const guard = new EgressGuard({ allowedDomains: ['api.anthropic.com'] });
  const iterations = 10000;
  const start = process.hrtime.bigint();

  for (let i = 0; i < iterations; i++) {
    guard.evaluate('https://api.anthropic.com/v1/messages');
  }

  const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
  const avg = elapsed / iterations;

  console.log(`  → evaluate avg: ${avg.toFixed(5)}ms (target: < 0.01ms)`);
  assert.ok(avg < 0.01, `Expected < 0.01ms, got ${avg.toFixed(5)}ms`);
});

test('TC-EG-131: evaluate() performance for blocked URLs', () => {
  const guard = new EgressGuard();
  const iterations = 10000;
  const start = process.hrtime.bigint();

  for (let i = 0; i < iterations; i++) {
    guard.evaluate('https://webhook.site/abc123');
  }

  const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
  const avg = elapsed / iterations;

  console.log(`  → evaluate (blocked) avg: ${avg.toFixed(5)}ms (target: < 0.01ms)`);
  assert.ok(avg < 0.01, `Expected < 0.01ms, got ${avg.toFixed(5)}ms`);
});

// -----------------------------------------------------------------------------
// Return Value Structure Tests
// -----------------------------------------------------------------------------

test('TC-EG-140: evaluate() result has correct structure', () => {
  const guard = new EgressGuard();
  const result = guard.evaluate('https://api.anthropic.com/v1');

  assert.strictEqual(typeof result.allowed, 'boolean');
  assert.ok(['BLOCKED', 'ALLOWED'].includes(result.level));
  assert.ok(result.reason === null || typeof result.reason === 'string');
  assert.ok(result.category === null || typeof result.category === 'string');
});

test('TC-EG-141: BLOCKED result has category', () => {
  const guard = new EgressGuard();
  const result = guard.evaluate('https://webhook.site/abc');

  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.level, 'BLOCKED');
  assert.ok(result.category !== null);
});

test('TC-EG-142: ALLOWED result has allowed category', () => {
  const guard = new EgressGuard({
    allowedDomains: ['api.anthropic.com'],
  });
  const result = guard.evaluate('https://api.anthropic.com/v1');

  assert.strictEqual(result.allowed, true);
  assert.strictEqual(result.level, 'ALLOWED');
  assert.strictEqual(result.category, 'allowed');
});

// -----------------------------------------------------------------------------
// Summary
// -----------------------------------------------------------------------------

console.log('\n=== EgressGuard Tests Complete ===\n');
summary();
exitWithCode();
