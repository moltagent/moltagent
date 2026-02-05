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
 * Tests for EgressGuard Phase 2: web_read SSRF exemption
 */

'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../../helpers/test-runner');
const EgressGuard = require('../../../../src/security/guards/egress-guard');

// -----------------------------------------------------------------------------
// Tests for web_read SSRF exemption (Phase 2)
// -----------------------------------------------------------------------------

test('web_read with ssrfChecked allows arbitrary HTTPS URLs not in allowlist', () => {
  const guard = new EgressGuard({
    mode: 'allowlist',
    allowedDomains: ['api.anthropic.com', 'example.com']
  });

  // URL not in allowlist, but web_read with ssrfChecked should allow it
  const result = guard.evaluate('https://news.ycombinator.com/item?id=123', {
    tool: 'web_read',
    ssrfChecked: true
  });

  assert.strictEqual(result.allowed, true, 'web_read with ssrfChecked should allow URLs not in allowlist');
  assert.strictEqual(result.level, 'ALLOWED', 'Should be ALLOWED level');
  assert.ok(result.reason.includes('web_read'), 'Reason should mention web_read');
  assert.ok(result.reason.includes('SSRF'), 'Reason should mention SSRF protection');
});

test('web_read with ssrfChecked still blocks exfiltration domains', () => {
  const guard = new EgressGuard({
    mode: 'allowlist',
    allowedDomains: ['api.anthropic.com']
  });

  // webhook.site is an exfiltration domain - should be blocked even for web_read
  const result = guard.evaluate('https://webhook.site/abc123', {
    tool: 'web_read',
    ssrfChecked: true
  });

  assert.strictEqual(result.allowed, false, 'Exfiltration domains should be blocked even for web_read');
  assert.strictEqual(result.level, 'BLOCKED', 'Should be BLOCKED level');
  assert.strictEqual(result.category, 'exfiltration', 'Should be exfiltration category');
  assert.ok(result.reason.includes('webhook.site'), 'Reason should mention blocked domain');
});

test('web_read with ssrfChecked still blocks metadata endpoints', () => {
  const guard = new EgressGuard({
    mode: 'allowlist',
    allowedDomains: ['api.anthropic.com']
  });

  // AWS metadata endpoint - should be blocked even for web_read
  const result = guard.evaluate('http://169.254.169.254/latest/meta-data/', {
    tool: 'web_read',
    ssrfChecked: true
  });

  assert.strictEqual(result.allowed, false, 'Metadata endpoints should be blocked even for web_read');
  assert.strictEqual(result.level, 'BLOCKED', 'Should be BLOCKED level');
  assert.strictEqual(result.category, 'metadata', 'Should be metadata category');
  assert.ok(result.reason.includes('169.254.169.254'), 'Reason should mention blocked endpoint');
});

test('web_read WITHOUT ssrfChecked follows normal allowlist rules', () => {
  const guard = new EgressGuard({
    mode: 'allowlist',
    allowedDomains: ['api.anthropic.com', 'example.com']
  });

  // URL not in allowlist, web_read without ssrfChecked should block
  const result = guard.evaluate('https://news.ycombinator.com/item?id=123', {
    tool: 'web_read',
    ssrfChecked: false
  });

  assert.strictEqual(result.allowed, false, 'web_read without ssrfChecked should follow allowlist');
  assert.strictEqual(result.level, 'BLOCKED', 'Should be BLOCKED level');
  assert.strictEqual(result.category, 'not_in_allowlist', 'Should be not_in_allowlist category');
});

test('Non-web_read tool follows normal allowlist rules', () => {
  const guard = new EgressGuard({
    mode: 'allowlist',
    allowedDomains: ['api.anthropic.com']
  });

  // Other tools should follow normal allowlist rules
  const result = guard.evaluate('https://news.ycombinator.com/item?id=123', {
    tool: 'mail_send',
    ssrfChecked: true
  });

  assert.strictEqual(result.allowed, false, 'Non-web_read tools should follow allowlist');
  assert.strictEqual(result.level, 'BLOCKED', 'Should be BLOCKED level');
  assert.strictEqual(result.category, 'not_in_allowlist', 'Should be not_in_allowlist category');
});

// Additional tests for edge cases
test('web_read with ssrfChecked blocks pastebin and other exfiltration services', () => {
  const guard = new EgressGuard({
    mode: 'allowlist',
    allowedDomains: ['api.anthropic.com']
  });

  const exfilServices = [
    'https://pastebin.com/raw/abc123',
    'https://requestbin.com/r/abc123',
    'https://pipedream.net/webhook/abc123',
    'https://transfer.sh/abc123'
  ];

  for (const url of exfilServices) {
    const result = guard.evaluate(url, {
      tool: 'web_read',
      ssrfChecked: true
    });

    assert.strictEqual(result.allowed, false, `${url} should be blocked`);
    assert.strictEqual(result.category, 'exfiltration', `${url} should be exfiltration category`);
  }
});

test('web_read with ssrfChecked allows HTTPS URLs in allowlist', () => {
  const guard = new EgressGuard({
    mode: 'allowlist',
    allowedDomains: ['example.com']
  });

  const result = guard.evaluate('https://example.com/page', {
    tool: 'web_read',
    ssrfChecked: true
  });

  assert.strictEqual(result.allowed, true, 'Allowlisted URLs should be allowed');
  assert.strictEqual(result.level, 'ALLOWED', 'Should be ALLOWED level');
});

test('web_read with ssrfChecked handles invalid URLs', () => {
  const guard = new EgressGuard({
    mode: 'allowlist'
  });

  const result = guard.evaluate('not-a-valid-url', {
    tool: 'web_read',
    ssrfChecked: true
  });

  assert.strictEqual(result.allowed, false, 'Invalid URLs should be blocked');
  assert.strictEqual(result.category, 'invalid_url', 'Should be invalid_url category');
});

test('web_read with ssrfChecked blocks Google metadata endpoint', () => {
  const guard = new EgressGuard({
    mode: 'allowlist'
  });

  const result = guard.evaluate('http://metadata.google.internal/computeMetadata/v1/', {
    tool: 'web_read',
    ssrfChecked: true
  });

  assert.strictEqual(result.allowed, false, 'Google metadata should be blocked');
  assert.strictEqual(result.category, 'metadata', 'Should be metadata category');
});

// -- C-1 fix: web_read blocks private IPs (defense in depth) --

test('web_read with ssrfChecked blocks private IPs (10.x)', () => {
  const guard = new EgressGuard({ mode: 'allowlist' });
  const result = guard.evaluate('http://10.0.0.1/internal-api', {
    tool: 'web_read', ssrfChecked: true
  });
  assert.strictEqual(result.allowed, false, '10.x should be blocked');
  assert.strictEqual(result.category, 'ssrf');
});

test('web_read with ssrfChecked blocks private IPs (192.168.x)', () => {
  const guard = new EgressGuard({ mode: 'allowlist' });
  const result = guard.evaluate('http://192.168.1.1/admin', {
    tool: 'web_read', ssrfChecked: true
  });
  assert.strictEqual(result.allowed, false, '192.168.x should be blocked');
  assert.strictEqual(result.category, 'ssrf');
});

test('web_read with ssrfChecked blocks localhost', () => {
  const guard = new EgressGuard({ mode: 'allowlist' });
  const result = guard.evaluate('http://127.0.0.1/secrets', {
    tool: 'web_read', ssrfChecked: true
  });
  assert.strictEqual(result.allowed, false, '127.0.0.1 should be blocked');
  assert.strictEqual(result.category, 'ssrf');
});

// -- C-2 fix: web_read blocks dangerous protocols --

test('web_read with ssrfChecked blocks file:// protocol', () => {
  const guard = new EgressGuard({ mode: 'allowlist' });
  const result = guard.evaluate('file:///etc/passwd', {
    tool: 'web_read', ssrfChecked: true
  });
  assert.strictEqual(result.allowed, false, 'file:// should be blocked');
  assert.strictEqual(result.category, 'blocked_protocol');
});

test('web_read with ssrfChecked blocks ftp:// protocol', () => {
  const guard = new EgressGuard({ mode: 'allowlist' });
  const result = guard.evaluate('ftp://internal.server/data', {
    tool: 'web_read', ssrfChecked: true
  });
  assert.strictEqual(result.allowed, false, 'ftp:// should be blocked');
  assert.strictEqual(result.category, 'blocked_protocol');
});

test('web_read with ssrfChecked blocks javascript: protocol', () => {
  const guard = new EgressGuard({ mode: 'allowlist' });
  const result = guard.evaluate('javascript:alert(1)', {
    tool: 'web_read', ssrfChecked: true
  });
  assert.strictEqual(result.allowed, false, 'javascript: should be blocked');
  assert.strictEqual(result.category, 'blocked_protocol');
});

// -----------------------------------------------------------------------------
// Run Summary
// -----------------------------------------------------------------------------

setTimeout(() => {
  summary();
  exitWithCode();
}, 500);
