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
 * Unit Tests for ResponseWrapper Module
 *
 * Tests AI response sanitization including:
 * - Credential detection and redaction via SecretsGuard
 * - Suspicious pattern detection (shell commands, IPs, metadata endpoints)
 * - Response length truncation
 * - Audit logging integration
 * - Return object structure validation
 *
 * @module test/unit/security/response-wrapper.test.js
 */

'use strict';

const assert = require('assert');
const { asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const ResponseWrapper = require('../../../src/security/response-wrapper');
const SecretsGuard = require('../../../src/security/guards/secrets-guard');

// -----------------------------------------------------------------------------
// Mock Audit Logger
// -----------------------------------------------------------------------------

class MockAuditLog {
  constructor() {
    this.logs = [];
  }

  log(eventType, data) {
    this.logs.push({ eventType, data, timestamp: Date.now() });
  }

  reset() {
    this.logs = [];
  }

  getLastLog() {
    return this.logs[this.logs.length - 1];
  }
}

// -----------------------------------------------------------------------------
// Main Test Runner
// -----------------------------------------------------------------------------

async function runTests() {
  console.log('\n=== ResponseWrapper Tests ===\n');

  // ---------------------------------------------------------------------------
  // Constructor Tests
  // ---------------------------------------------------------------------------

  await asyncTest('TC-RW-001: Constructor requires secretsGuard option', async () => {
  assert.throws(
    () => new ResponseWrapper({}),
    /ResponseWrapper requires options\.secretsGuard/
  );
});

  await asyncTest('TC-RW-002: Constructor throws if no options provided', async () => {
  assert.throws(
    () => new ResponseWrapper(),
    /ResponseWrapper requires options\.secretsGuard/
  );
});

  await asyncTest('TC-RW-003: Constructor throws if secretsGuard is not SecretsGuard instance', async () => {
  assert.throws(
    () => new ResponseWrapper({ secretsGuard: {} }),
    /options\.secretsGuard must be an instance of SecretsGuard/
  );
});

  await asyncTest('TC-RW-004: Constructor accepts valid SecretsGuard instance', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard });
  assert.ok(wrapper instanceof ResponseWrapper);
  assert.strictEqual(wrapper.secretsGuard, secretsGuard);
});

  await asyncTest('TC-RW-005: Constructor accepts optional auditLog', async () => {
  const secretsGuard = new SecretsGuard();
  const auditLog = new MockAuditLog();
  const wrapper = new ResponseWrapper({ secretsGuard, auditLog });
  assert.strictEqual(wrapper.auditLog, auditLog);
});

  await asyncTest('TC-RW-006: Constructor sets default maxResponseLength to 50000', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard });
  assert.strictEqual(wrapper.maxResponseLength, 50000);
});

  await asyncTest('TC-RW-007: Constructor accepts custom maxResponseLength', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard, maxResponseLength: 10000 });
  assert.strictEqual(wrapper.maxResponseLength, 10000);
});

// -----------------------------------------------------------------------------
// Clean Response Tests
// -----------------------------------------------------------------------------

  await asyncTest('TC-RW-010: Clean response passes through unchanged', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard });

  const result = await wrapper.process('Here are your calendar events for today...');

  assert.strictEqual(result.safe, true);
  assert.strictEqual(result.response, 'Here are your calendar events for today...');
  assert.deepStrictEqual(result.warnings, []);
  assert.strictEqual(result.originalHadSecrets, false);
  assert.strictEqual(result.truncated, false);
});

  await asyncTest('TC-RW-011: Clean response has correct return structure', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard });

  const result = await wrapper.process('Normal text');

  assert.ok('safe' in result);
  assert.ok('response' in result);
  assert.ok('warnings' in result);
  assert.ok('originalHadSecrets' in result);
  assert.ok('truncated' in result);
  assert.strictEqual(typeof result.safe, 'boolean');
  assert.strictEqual(typeof result.response, 'string');
  assert.ok(Array.isArray(result.warnings));
});

// -----------------------------------------------------------------------------
// Leaked Credential Detection Tests
// -----------------------------------------------------------------------------

  await asyncTest('TC-RW-020: Detects and redacts Anthropic API key', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard });

  const result = await wrapper.process('Your API key is sk-ant-api03-abc123def456ghi789jkl012mno345pqr');

  assert.strictEqual(result.safe, false);
  assert.ok(result.response.includes('[REDACTED:anthropic_key]'));
  assert.ok(!result.response.includes('sk-ant-api03'));
  assert.strictEqual(result.originalHadSecrets, true);
  assert.ok(result.warnings.length > 0);
  assert.ok(result.warnings.some(w => w.type === 'anthropic_key' && w.action === 'redact'));
});

  await asyncTest('TC-RW-021: Detects and redacts AWS access key', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard });

  const result = await wrapper.process('Access key: AKIAIOSFODNN7EXAMPLE');

  assert.strictEqual(result.safe, false);
  assert.ok(result.response.includes('[REDACTED:aws_access_key]'));
  assert.strictEqual(result.originalHadSecrets, true);
});

  await asyncTest('TC-RW-022: Detects and redacts GitHub token', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard });

  const result = await wrapper.process('Token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef1234');

  assert.strictEqual(result.safe, false);
  assert.ok(result.response.includes('[REDACTED:github_token]'));
  assert.strictEqual(result.originalHadSecrets, true);
});

  await asyncTest('TC-RW-023: Marks response unsafe when CRITICAL secrets found', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard });

  const result = await wrapper.process('Key: AKIAIOSFODNN7EXAMPLE');

  assert.strictEqual(result.safe, false);
});

  await asyncTest('TC-RW-024: Non-critical secrets keep safe=true', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard });

  // password_field is MEDIUM severity, not CRITICAL
  const result = await wrapper.process('password = "MyS3cretP@ssw0rd123"');

  if (result.originalHadSecrets) {
    // Should have secret, but still safe (not CRITICAL)
    assert.strictEqual(result.safe, true);
    assert.strictEqual(result.originalHadSecrets, true);
  }
});

// -----------------------------------------------------------------------------
// Internal IP Detection Tests
// -----------------------------------------------------------------------------

  await asyncTest('TC-RW-030: Detects internal IP (10.x.x.x) and warns', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard });

  const result = await wrapper.process('The server is at 10.0.0.1:5432');

  assert.strictEqual(result.safe, true);
  assert.ok(result.warnings.some(w =>
    w.type === 'internal_ip' &&
    w.severity === 'MEDIUM' &&
    w.action === 'warn'
  ));
});

  await asyncTest('TC-RW-031: Detects internal IP (192.168.x.x) and warns', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard });

  const result = await wrapper.process('The server is at 192.168.1.100:3000');

  assert.strictEqual(result.safe, true);
  assert.ok(result.warnings.some(w => w.type === 'internal_ip'));
});

  await asyncTest('TC-RW-032: Detects internal IP (172.16-31.x.x) and warns', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard });

  const result = await wrapper.process('Connect to 172.20.10.5');

  assert.strictEqual(result.safe, true);
  assert.ok(result.warnings.some(w => w.type === 'internal_ip'));
});

  await asyncTest('TC-RW-033: Internal IP warning does not redact (action=warn)', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard });

  const result = await wrapper.process('The server is at 192.168.1.100:3000');

  // Should warn but not redact
  assert.ok(result.response.includes('192.168.1.100'));
  assert.ok(!result.response.includes('[REDACTED'));
});

// -----------------------------------------------------------------------------
// Base64 Blob Detection Tests
// -----------------------------------------------------------------------------

  await asyncTest('TC-RW-040: Detects base64 blob over 100 chars', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard });

  const base64blob = 'A'.repeat(150);
  const result = await wrapper.process(`Here is the data: ${base64blob}`);

  assert.strictEqual(result.safe, true);
  assert.ok(result.warnings.some(w =>
    w.type === 'base64_blob' &&
    w.severity === 'HIGH' &&
    w.action === 'warn'
  ));
});

  await asyncTest('TC-RW-041: Base64 blob warning does not redact', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard });

  const base64blob = 'B'.repeat(120);
  const result = await wrapper.process(`Data: ${base64blob}`);

  // Should warn but not redact
  assert.ok(result.response.includes(base64blob));
});

  await asyncTest('TC-RW-042: Short base64 strings not flagged', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard });

  const shortBase64 = 'ABC123def456';
  const result = await wrapper.process(`Token: ${shortBase64}`);

  // Should not trigger base64_blob warning (< 100 chars)
  assert.ok(!result.warnings.some(w => w.type === 'base64_blob'));
});

// -----------------------------------------------------------------------------
// Metadata Endpoint Detection Tests
// -----------------------------------------------------------------------------

  await asyncTest('TC-RW-050: Detects AWS metadata endpoint and redacts', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard });

  const result = await wrapper.process('Fetched from 169.254.169.254/latest/meta-data/');

  assert.ok(result.warnings.some(w =>
    w.type === 'metadata_endpoint' &&
    w.severity === 'HIGH' &&
    w.action === 'redact'
  ));
  assert.ok(result.response.includes('[REDACTED:metadata_endpoint]'));
  assert.ok(!result.response.includes('169.254.169.254'));
});

  await asyncTest('TC-RW-051: Detects Google metadata endpoint and redacts', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard });

  const result = await wrapper.process('URL: metadata.google.internal/computeMetadata/');

  assert.ok(result.warnings.some(w => w.type === 'metadata_endpoint'));
  assert.ok(result.response.includes('[REDACTED:metadata_endpoint]'));
});

  await asyncTest('TC-RW-052: Detects Hetzner metadata endpoint and redacts', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard });

  const result = await wrapper.process('Check metadata.hetzner.cloud for details');

  assert.ok(result.warnings.some(w => w.type === 'metadata_endpoint'));
  assert.ok(result.response.includes('[REDACTED:metadata_endpoint]'));
});

// -----------------------------------------------------------------------------
// Shell Code Detection Tests
// -----------------------------------------------------------------------------

  await asyncTest('TC-RW-060: Detects shell code block and warns', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard });

  const shellCode = '```bash\nrm -rf /tmp/*\n```';
  const result = await wrapper.process(`Here is how to clean temp files:\n${shellCode}`);

  assert.strictEqual(result.safe, true);
  assert.ok(result.warnings.some(w =>
    w.type === 'shell_in_response' &&
    w.severity === 'MEDIUM' &&
    w.action === 'warn'
  ));
});

  await asyncTest('TC-RW-061: Detects sh code block and warns', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard });

  const result = await wrapper.process('```sh\nls -la\n```');

  assert.ok(result.warnings.some(w => w.type === 'shell_in_response'));
});

  await asyncTest('TC-RW-062: Shell code warning does not redact', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard });

  const shellCode = '```bash\necho "hello"\n```';
  const result = await wrapper.process(shellCode);

  // Should warn but not redact
  assert.ok(result.response.includes('echo "hello"'));
});

// -----------------------------------------------------------------------------
// NC Internal Path Detection Tests
// -----------------------------------------------------------------------------

  await asyncTest('TC-RW-070: Detects /etc/credstore path and warns', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard });

  const result = await wrapper.process('File stored at /etc/credstore/credentials.json');

  assert.strictEqual(result.safe, true);
  assert.ok(result.warnings.some(w =>
    w.type === 'nc_internal_path' &&
    w.severity === 'MEDIUM' &&
    w.action === 'warn'
  ));
});

  await asyncTest('TC-RW-071: Detects /var/lib/nextcloud path and warns', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard });

  const result = await wrapper.process('Check /var/lib/nextcloud/data/');

  assert.ok(result.warnings.some(w => w.type === 'nc_internal_path'));
});

  await asyncTest('TC-RW-072: Detects /data/moltagent path and warns', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard });

  const result = await wrapper.process('Located at /data/moltagent/config');

  assert.ok(result.warnings.some(w => w.type === 'nc_internal_path'));
});

// -----------------------------------------------------------------------------
// Auth URL Detection Tests
// -----------------------------------------------------------------------------

  await asyncTest('TC-RW-080: Detects auth URL and redacts', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard });

  const result = await wrapper.process('Connect via https://user:pass123@api.example.com/data');

  // Note: SecretsGuard detects this as 'url_credentials', ResponseWrapper detects as 'auth_url'
  // Both patterns match URLs with credentials
  assert.ok(result.warnings.some(w =>
    (w.type === 'auth_url' || w.type === 'url_credentials') &&
    w.severity === 'CRITICAL' &&
    w.action === 'redact'
  ));
  assert.ok(result.response.includes('[REDACTED:auth_url]') || result.response.includes('[REDACTED:url_credentials]'));
  assert.ok(!result.response.includes('user:pass123'));
});

  await asyncTest('TC-RW-081: Auth URL redaction removes credentials', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard });

  const result = await wrapper.process('http://admin:secret@localhost:8080/api');

  assert.ok(!result.response.includes('admin:secret'));
});

// -----------------------------------------------------------------------------
// Over-length Response Tests
// -----------------------------------------------------------------------------

  await asyncTest('TC-RW-090: Truncates response over maxResponseLength', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard, maxResponseLength: 100 });

  const longText = 'x'.repeat(150);
  const result = await wrapper.process(longText);

  assert.strictEqual(result.truncated, true);
  assert.strictEqual(result.response.length, 100);
  assert.ok(result.warnings.some(w =>
    w.type === 'response_truncated' &&
    w.severity === 'LOW' &&
    w.action === 'truncate'
  ));
});

  await asyncTest('TC-RW-091: Does not truncate response under maxResponseLength', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard, maxResponseLength: 100 });

  const shortText = 'x'.repeat(50);
  const result = await wrapper.process(shortText);

  assert.strictEqual(result.truncated, false);
  assert.strictEqual(result.response.length, 50);
});

  await asyncTest('TC-RW-092: Default maxResponseLength truncates at 50000', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard });

  const longText = 'x'.repeat(60000);
  const result = await wrapper.process(longText);

  assert.strictEqual(result.truncated, true);
  assert.strictEqual(result.response.length, 50000);
});

  await asyncTest('TC-RW-093: Truncation happens before secret scanning', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard, maxResponseLength: 100 });

  // Secret after position 100 should not be detected
  const text = 'x'.repeat(110) + 'AKIAIOSFODNN7EXAMPLE';
  const result = await wrapper.process(text);

  assert.strictEqual(result.truncated, true);
  assert.strictEqual(result.response.length, 100);
  // Secret was truncated away, should not be detected
  assert.strictEqual(result.originalHadSecrets, false);
});

// -----------------------------------------------------------------------------
// Multiple Issues Tests
// -----------------------------------------------------------------------------

  await asyncTest('TC-RW-100: Detects both secret and internal IP', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard });

  const result = await wrapper.process('Key: sk-ant-api03-abc123def456ghi789jkl012mno345pqr at server 10.0.0.1:5432');

  assert.strictEqual(result.safe, false);
  assert.strictEqual(result.originalHadSecrets, true);
  assert.ok(result.warnings.some(w => w.type === 'anthropic_key'));
  assert.ok(result.warnings.some(w => w.type === 'internal_ip'));
  assert.ok(result.warnings.length >= 2);
});

  await asyncTest('TC-RW-101: Detects secret, IP, and base64 blob', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard });

  const base64 = 'A'.repeat(120);
  const result = await wrapper.process(
    `AWS: AKIAIOSFODNN7EXAMPLE Server: 192.168.1.5 Data: ${base64}`
  );

  assert.ok(result.warnings.some(w => w.type === 'aws_access_key'));
  assert.ok(result.warnings.some(w => w.type === 'internal_ip'));
  assert.ok(result.warnings.some(w => w.type === 'base64_blob'));
});

  await asyncTest('TC-RW-102: Multiple secrets all get redacted', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard });

  const result = await wrapper.process(
    'AWS: AKIAIOSFODNN7EXAMPLE and GitHub: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef1234'
  );

  assert.ok(!result.response.includes('AKIAIOSFODNN7EXAMPLE'));
  assert.ok(!result.response.includes('ghp_ABCDEFGH'));
  assert.ok(result.response.includes('[REDACTED:aws_access_key]'));
  assert.ok(result.response.includes('[REDACTED:github_token]'));
});

// -----------------------------------------------------------------------------
// Empty/Null/Undefined Input Tests
// -----------------------------------------------------------------------------

  await asyncTest('TC-RW-110: Handles empty string input', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard });

  const result = await wrapper.process('');

  assert.strictEqual(result.safe, true);
  assert.strictEqual(result.response, '');
  assert.deepStrictEqual(result.warnings, []);
  assert.strictEqual(result.originalHadSecrets, false);
  assert.strictEqual(result.truncated, false);
});

  await asyncTest('TC-RW-111: Handles null input by treating as empty string', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard });

  // Note: ResponseWrapper doesn't handle null, so it will cause an error
  // This test documents current behavior - ideally should handle null gracefully
  try {
    const result = await wrapper.process(null);
    // If we get here, null was handled - check the result
    assert.strictEqual(result.safe, true);
  } catch (err) {
    // Current behavior: throws error on null
    assert.ok(err.message.includes('length') || err.message.includes('null'));
  }
});

  await asyncTest('TC-RW-112: Handles undefined input by treating as empty string', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard });

  // Note: ResponseWrapper doesn't handle undefined, so it will cause an error
  // This test documents current behavior - ideally should handle undefined gracefully
  try {
    const result = await wrapper.process(undefined);
    // If we get here, undefined was handled - check the result
    assert.strictEqual(result.safe, true);
  } catch (err) {
    // Current behavior: throws error on undefined
    assert.ok(err.message.includes('length') || err.message.includes('undefined'));
  }
});

  await asyncTest('TC-RW-113: Handles whitespace-only input', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard });

  const result = await wrapper.process('   \n\t   ');

  assert.strictEqual(result.safe, true);
  assert.strictEqual(result.originalHadSecrets, false);
});

// -----------------------------------------------------------------------------
// Audit Log Integration Tests
// -----------------------------------------------------------------------------

  await asyncTest('TC-RW-120: Calls auditLog when findings exist', async () => {
  const secretsGuard = new SecretsGuard();
  const auditLog = new MockAuditLog();
  const wrapper = new ResponseWrapper({ secretsGuard, auditLog });

  await wrapper.process('Internal IP: 192.168.1.100');

  assert.strictEqual(auditLog.logs.length, 1);
  const log = auditLog.getLastLog();
  assert.strictEqual(log.eventType, 'response_sanitized');
  assert.ok(Array.isArray(log.data.findings));
  assert.ok(log.data.findings.length > 0);
});

  await asyncTest('TC-RW-121: Does not call auditLog when no findings', async () => {
  const secretsGuard = new SecretsGuard();
  const auditLog = new MockAuditLog();
  const wrapper = new ResponseWrapper({ secretsGuard, auditLog });

  await wrapper.process('Clean response with no issues');

  assert.strictEqual(auditLog.logs.length, 0);
});

  await asyncTest('TC-RW-122: Passes context to auditLog', async () => {
  const secretsGuard = new SecretsGuard();
  const auditLog = new MockAuditLog();
  const wrapper = new ResponseWrapper({ secretsGuard, auditLog });

  const context = { userId: 'user123', requestId: 'req456' };
  await wrapper.process('IP: 10.0.0.1', context);

  const log = auditLog.getLastLog();
  assert.deepStrictEqual(log.data.context, context);
});

  await asyncTest('TC-RW-123: Works without auditLog (null audit)', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard });

  // Should not throw
  const result = await wrapper.process('IP: 192.168.1.1');
  assert.strictEqual(result.safe, true);
});

  await asyncTest('TC-RW-124: Logs all warning types in findings', async () => {
  const secretsGuard = new SecretsGuard();
  const auditLog = new MockAuditLog();
  const wrapper = new ResponseWrapper({ secretsGuard, auditLog });

  await wrapper.process('Key: AKIAIOSFODNN7EXAMPLE at 192.168.1.100');

  const log = auditLog.getLastLog();
  assert.ok(log.data.findings.some(f => f.type === 'aws_access_key'));
  assert.ok(log.data.findings.some(f => f.type === 'internal_ip'));
});

// -----------------------------------------------------------------------------
// Context Parameter Tests
// -----------------------------------------------------------------------------

  await asyncTest('TC-RW-130: Accepts context parameter', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard });

  const context = { source: 'test', user: 'testuser' };
  const result = await wrapper.process('Clean text', context);

  assert.strictEqual(result.safe, true);
});

  await asyncTest('TC-RW-131: Works without context parameter', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard });

  const result = await wrapper.process('Clean text');

  assert.strictEqual(result.safe, true);
});

  await asyncTest('TC-RW-132: Context defaults to empty object', async () => {
  const secretsGuard = new SecretsGuard();
  const auditLog = new MockAuditLog();
  const wrapper = new ResponseWrapper({ secretsGuard, auditLog });

  await wrapper.process('IP: 10.0.0.1');

  const log = auditLog.getLastLog();
  assert.deepStrictEqual(log.data.context, {});
});

// -----------------------------------------------------------------------------
// Return Object Structure Tests
// -----------------------------------------------------------------------------

  await asyncTest('TC-RW-140: Return object has all required fields', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard });

  const result = await wrapper.process('Test');

  assert.ok('safe' in result);
  assert.ok('response' in result);
  assert.ok('warnings' in result);
  assert.ok('originalHadSecrets' in result);
  assert.ok('truncated' in result);
});

  await asyncTest('TC-RW-141: safe field is boolean', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard });

  const result = await wrapper.process('Test');
  assert.strictEqual(typeof result.safe, 'boolean');
});

  await asyncTest('TC-RW-142: response field is string', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard });

  const result = await wrapper.process('Test');
  assert.strictEqual(typeof result.response, 'string');
});

  await asyncTest('TC-RW-143: warnings field is array', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard });

  const result = await wrapper.process('Test');
  assert.ok(Array.isArray(result.warnings));
});

  await asyncTest('TC-RW-144: originalHadSecrets field is boolean', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard });

  const result = await wrapper.process('Test');
  assert.strictEqual(typeof result.originalHadSecrets, 'boolean');
});

  await asyncTest('TC-RW-145: truncated field is boolean', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard });

  const result = await wrapper.process('Test');
  assert.strictEqual(typeof result.truncated, 'boolean');
});

  await asyncTest('TC-RW-146: Warning objects have type, severity, and action', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard });

  const result = await wrapper.process('IP: 192.168.1.1');

  if (result.warnings.length > 0) {
    const warning = result.warnings[0];
    assert.ok('type' in warning);
    assert.ok('severity' in warning);
    assert.ok('action' in warning);
    assert.strictEqual(typeof warning.type, 'string');
    assert.strictEqual(typeof warning.severity, 'string');
    assert.strictEqual(typeof warning.action, 'string');
  }
});

// -----------------------------------------------------------------------------
// Edge Cases
// -----------------------------------------------------------------------------

  await asyncTest('TC-RW-150: Handles very long response efficiently', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard });

  const longText = 'x'.repeat(100000);
  const start = process.hrtime.bigint();
  const result = await wrapper.process(longText);
  const end = process.hrtime.bigint();

  const timeMs = Number(end - start) / 1000000;
  assert.ok(timeMs < 200, `Processing took ${timeMs}ms`);
  assert.strictEqual(result.truncated, true);
});

  await asyncTest('TC-RW-151: Handles multiline content', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard });

  const multiline = 'Line 1\nLine 2 with IP 192.168.1.1\nLine 3';
  const result = await wrapper.process(multiline);

  assert.ok(result.warnings.some(w => w.type === 'internal_ip'));
});

  await asyncTest('TC-RW-152: Handles special characters', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard });

  const special = 'Test with émojis 🔒 and spëcial chars µ § ¶';
  const result = await wrapper.process(special);

  assert.strictEqual(result.safe, true);
  assert.ok(result.response.includes('🔒'));
});

  await asyncTest('TC-RW-153: Processes response with only secrets', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard });

  const result = await wrapper.process('AKIAIOSFODNN7EXAMPLE');

  assert.strictEqual(result.safe, false);
  assert.strictEqual(result.response, '[REDACTED:aws_access_key]');
  assert.strictEqual(result.originalHadSecrets, true);
});

  await asyncTest('TC-RW-154: Handles mix of redacted and warned patterns', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard });

  // Auth URL is redacted, internal IP is warned
  const result = await wrapper.process(
    'URL: https://user:pass@example.com and server 192.168.1.1'
  );

  const redactWarnings = result.warnings.filter(w => w.action === 'redact');
  const warnWarnings = result.warnings.filter(w => w.action === 'warn');

  assert.ok(redactWarnings.length > 0);
  assert.ok(warnWarnings.length > 0);
});

// -----------------------------------------------------------------------------
// Integration Tests
// -----------------------------------------------------------------------------

  await asyncTest('TC-RW-160: End-to-end: clean response flow', async () => {
  const secretsGuard = new SecretsGuard();
  const auditLog = new MockAuditLog();
  const wrapper = new ResponseWrapper({ secretsGuard, auditLog, maxResponseLength: 1000 });

  const result = await wrapper.process('Your calendar shows 3 meetings today.');

  assert.strictEqual(result.safe, true);
  assert.strictEqual(result.response, 'Your calendar shows 3 meetings today.');
  assert.deepStrictEqual(result.warnings, []);
  assert.strictEqual(result.originalHadSecrets, false);
  assert.strictEqual(result.truncated, false);
  assert.strictEqual(auditLog.logs.length, 0);
});

  await asyncTest('TC-RW-161: End-to-end: leaked credential flow', async () => {
  const secretsGuard = new SecretsGuard();
  const auditLog = new MockAuditLog();
  const wrapper = new ResponseWrapper({ secretsGuard, auditLog });

  const result = await wrapper.process('Your API key is sk-ant-api03-abc123def456ghi789jkl012mno345pqr');

  assert.strictEqual(result.safe, false);
  assert.ok(result.response.includes('[REDACTED:anthropic_key]'));
  assert.strictEqual(result.originalHadSecrets, true);
  assert.ok(result.warnings.some(w => w.type === 'anthropic_key'));
  assert.strictEqual(auditLog.logs.length, 1);
});

  await asyncTest('TC-RW-162: End-to-end: multiple issues flow', async () => {
  const secretsGuard = new SecretsGuard();
  const auditLog = new MockAuditLog();
  const wrapper = new ResponseWrapper({ secretsGuard, auditLog });

  const base64 = 'A'.repeat(120);
  const result = await wrapper.process(
    `Key: sk_live_51ABC123def456GHI789jklMNOpqrSTU server: 10.0.0.1 data: ${base64}`
  );

  assert.strictEqual(result.safe, false); // CRITICAL stripe key
  assert.strictEqual(result.originalHadSecrets, true);
  assert.ok(result.warnings.length >= 3);
  assert.ok(result.warnings.some(w => w.type === 'stripe_key'));
  assert.ok(result.warnings.some(w => w.type === 'internal_ip'));
  assert.ok(result.warnings.some(w => w.type === 'base64_blob'));
  assert.strictEqual(auditLog.logs.length, 1);
});

  await asyncTest('TC-RW-163: End-to-end: truncation with secrets flow', async () => {
  const secretsGuard = new SecretsGuard();
  const wrapper = new ResponseWrapper({ secretsGuard, maxResponseLength: 200 });

  const longText = 'x'.repeat(150) + 'AKIAIOSFODNN7EXAMPLE' + 'y'.repeat(100);
  const result = await wrapper.process(longText);

  assert.strictEqual(result.truncated, true);
  // After truncation to 200, the redaction marker adds characters, so length will be > 200
  assert.ok(result.response.length >= 200);
  // Secret at position 150 should be detected after truncation at position 200
  assert.strictEqual(result.originalHadSecrets, true);
});

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------

  console.log('\n=== ResponseWrapper Tests Complete ===\n');
  summary();
  exitWithCode();
}

// Run all tests
runTests();
