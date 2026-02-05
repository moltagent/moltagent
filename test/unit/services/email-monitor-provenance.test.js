/**
 * EmailMonitor ContentProvenance + Route Context Tests
 *
 * Tests that email body is wrapped with ContentProvenance frameExternalContent()
 * and that LLM route calls include proactive budget context.
 *
 * Run: node test/unit/services/email-monitor-provenance.test.js
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

const EmailMonitor = require('../../../src/lib/services/email-monitor');

console.log('\n=== EmailMonitor Provenance + Route Context Tests ===\n');

// Helper: create minimal EmailMonitor instance without IMAP
function createMonitor(llmMock) {
  return new EmailMonitor({
    credentialBroker: { get: async () => null },
    llmRouter: llmMock,
    auditLog: async () => {},
    sendTalkMessage: async () => {},
    defaultToken: 'test-room',
    heartbeatInterval: 60000
  });
}

// Sample email for testing
const sampleEmail = {
  messageId: 'test-123',
  from: 'alice@example.com',
  fromAddress: 'alice@example.com',
  to: 'moltagent@example.com',
  cc: '',
  subject: 'Test Email',
  date: new Date().toISOString(),
  text: 'Hello, can you help me with something?',
  html: ''
};

(async () => {
  // --- ContentProvenance Wrapping Tests ---
  console.log('\n--- ContentProvenance Wrapping ---\n');

  await asyncTest('_analyzeEmail() wraps email body with <external_content> tags', async () => {
    let capturedContent = null;
    const llm = {
      route: async (params) => {
        capturedContent = params.content;
        return { result: '{"needs_response":false,"urgency":"low","reason":"test","summary":"test","is_meeting_request":false,"draft_response":null}' };
      }
    };
    const monitor = createMonitor(llm);
    await monitor._analyzeEmail(sampleEmail);

    assert.ok(capturedContent, 'LLM should have been called');
    assert.ok(capturedContent.includes('<external_content'), 'Body should be wrapped in external_content tags');
    assert.ok(capturedContent.includes('</external_content>'), 'Body should have closing external_content tag');
    assert.ok(capturedContent.includes('trust="untrusted"'), 'Should include trust=untrusted attribute');
  });

  await asyncTest('_analyzeEmail() preserves email metadata outside boundary', async () => {
    let capturedContent = null;
    const llm = {
      route: async (params) => {
        capturedContent = params.content;
        return { result: '{"needs_response":false,"urgency":"low","reason":"test","summary":"test","is_meeting_request":false,"draft_response":null}' };
      }
    };
    const monitor = createMonitor(llm);
    await monitor._analyzeEmail(sampleEmail);

    // Metadata should appear before the external_content boundary
    const externalIdx = capturedContent.indexOf('<external_content');
    const fromIdx = capturedContent.indexOf('From: alice@example.com');
    const subjectIdx = capturedContent.indexOf('Subject: Test Email');

    assert.ok(fromIdx >= 0, 'From should be in prompt');
    assert.ok(subjectIdx >= 0, 'Subject should be in prompt');
    assert.ok(fromIdx < externalIdx, 'From should appear before external_content boundary');
    assert.ok(subjectIdx < externalIdx, 'Subject should appear before external_content boundary');
  });

  await asyncTest('_analyzeEmail() passes context.trigger = heartbeat_email to route()', async () => {
    let capturedContext = null;
    const llm = {
      route: async (params) => {
        capturedContext = params.context;
        return { result: '{"needs_response":false,"urgency":"low","reason":"test","summary":"test","is_meeting_request":false,"draft_response":null}' };
      }
    };
    const monitor = createMonitor(llm);
    await monitor._analyzeEmail(sampleEmail);

    assert.ok(capturedContext, 'Context should be passed to route()');
    assert.strictEqual(capturedContext.trigger, 'heartbeat_email', 'Trigger should be heartbeat_email');
  });

  await asyncTest('_analyzeEmail() truncates body to 2000 chars before wrapping', async () => {
    let capturedContent = null;
    const llm = {
      route: async (params) => {
        capturedContent = params.content;
        return { result: '{"needs_response":false,"urgency":"low","reason":"test","summary":"test","is_meeting_request":false,"draft_response":null}' };
      }
    };
    const monitor = createMonitor(llm);

    // Create email with very long body
    const longEmail = { ...sampleEmail, text: 'A'.repeat(5000) };
    await monitor._analyzeEmail(longEmail);

    // The framed content should contain at most 2000 chars of the original body
    // (plus the external_content wrapper text)
    assert.ok(!capturedContent.includes('A'.repeat(2001)), 'Body should be truncated to 2000 chars');
    assert.ok(capturedContent.includes('A'.repeat(2000)), 'Body should contain exactly 2000 chars');
  });

  await asyncTest('_analyzeEmail() handles empty body gracefully', async () => {
    let capturedContent = null;
    const llm = {
      route: async (params) => {
        capturedContent = params.content;
        return { result: '{"needs_response":false,"urgency":"low","reason":"test","summary":"test","is_meeting_request":false,"draft_response":null}' };
      }
    };
    const monitor = createMonitor(llm);

    const emptyEmail = { ...sampleEmail, text: null };
    await monitor._analyzeEmail(emptyEmail);

    assert.ok(capturedContent.includes('(empty)'), 'Empty body should use "(empty)" placeholder');
    assert.ok(capturedContent.includes('<external_content'), 'Empty body should still be wrapped');
  });

  await asyncTest('_analyzeEmail() fallback still works on LLM error', async () => {
    const llm = {
      route: async () => { throw new Error('LLM unavailable'); }
    };
    const monitor = createMonitor(llm);

    const directEmail = { ...sampleEmail, to: 'moltagent@example.com' };
    const result = await monitor._analyzeEmail(directEmail);

    assert.ok(result, 'Should return fallback result');
    assert.strictEqual(result.reason, 'Analysis failed, using fallback');
    assert.strictEqual(result.needs_response, true, 'Direct email should default to needs_response');
  });

  // --- isAvailable() Tests ---
  console.log('\n--- isAvailable() Tests ---\n');

  test('isAvailable() returns true when idle', () => {
    const monitor = createMonitor({ route: async () => ({}) });
    assert.strictEqual(monitor.isAvailable(), true);
  });

  test('isAvailable() returns false during check', () => {
    const monitor = createMonitor({ route: async () => ({}) });
    // Simulate checking state
    monitor._isChecking = true;
    assert.strictEqual(monitor.isAvailable(), false);
  });

  summary();
  exitWithCode();
})();
