/**
 * EmailReplyHandler Unit Tests
 *
 * Test suite for email reply confirmation handling.
 *
 * Run: node test/unit/handlers/confirmation/email-reply-handler.test.js
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../../helpers/test-runner');
const { createMockAuditLog, createMockEmailHandler } = require('../../../helpers/mock-factories');

// Import module under test
const EmailReplyHandler = require('../../../../src/lib/handlers/confirmation/email-reply-handler');
const { pendingEmailReplies } = require('../../../../src/lib/pending-action-store');

// ============================================================
// Test Suites
// ============================================================

async function runAllTests() {
  console.log('\n=== EmailReplyHandler Tests ===\n');

  // --- Constructor Tests ---
  console.log('\n--- Constructor Tests ---\n');

  test('TC-CTOR-001: Initialize with default options', () => {
    const handler = new EmailReplyHandler();
    assert.ok(handler.auditLog);
    assert.ok(handler.errorHandler);
  });

  test('TC-CTOR-002: Initialize with custom auditLog', () => {
    const mockAuditLog = createMockAuditLog();
    const handler = new EmailReplyHandler({ auditLog: mockAuditLog });
    assert.strictEqual(handler.auditLog, mockAuditLog);
  });

  // --- canHandle Tests ---
  console.log('\n--- canHandle Tests ---\n');

  test('TC-CANHANDLE-001: Return true for non-meeting email reply', () => {
    const handler = new EmailReplyHandler();
    const result = handler.canHandle({ data: { is_meeting_request: false } });
    assert.strictEqual(result, true);
  });

  test('TC-CANHANDLE-002: Return false for meeting request', () => {
    const handler = new EmailReplyHandler();
    const result = handler.canHandle({ data: { is_meeting_request: true } });
    assert.strictEqual(result, false);
  });

  test('TC-CANHANDLE-003: Return false for null/undefined', () => {
    const handler = new EmailReplyHandler();
    assert.strictEqual(handler.canHandle(null), false);
    assert.strictEqual(handler.canHandle(undefined), false);
    assert.strictEqual(handler.canHandle({ data: undefined }), false);
  });

  // --- handleApprove Tests ---
  console.log('\n--- handleApprove Tests ---\n');

  await asyncTest('TC-APPROVE-001: Send drafted reply successfully', async () => {
  const handler = new EmailReplyHandler();
  let sendCalled = false;
  const mockEmailHandler = {
    confirmSendEmail: async (draft, user) => {
      sendCalled = true;
      return { message: 'Email sent' };
    }
  };

  // Setup pending email reply
  pendingEmailReplies.clear();
  pendingEmailReplies.set('email_reply', {
    email: {
      messageId: 'msg-123',
      subject: 'Test Subject',
      fromAddress: 'sender@example.com',
      inReplyTo: '<prev-msg>',
      references: '<ref-1> <ref-2>'
    },
    draft: 'Test reply body',
    is_meeting_request: false
  });

  const pendingReply = pendingEmailReplies.getRecent('email_reply');
  const result = await handler.handleApprove(
    pendingReply,
    { user: 'testuser' },
    { emailHandler: mockEmailHandler }
  );

  assert.ok(sendCalled);
  assert.strictEqual(pendingEmailReplies.size('email_reply'), 0);
  assert.ok(result.response); // Should have a response message
  assert.strictEqual(result.intent, 'confirm');
  });

  await asyncTest('TC-APPROVE-002: Handle email send error', async () => {
  const handler = new EmailReplyHandler();
  const mockEmailHandler = {
    confirmSendEmail: async () => {
      throw new Error('SMTP error');
    }
  };

  pendingEmailReplies.clear();
  pendingEmailReplies.set('email_reply', {
    email: { messageId: 'msg-123', subject: 'Test', fromAddress: 'sender@example.com' },
    draft: 'Test reply',
    is_meeting_request: false
  });

  const pendingReply = pendingEmailReplies.getRecent('email_reply');
  const result = await handler.handleApprove(
    pendingReply,
    { user: 'testuser' },
    { emailHandler: mockEmailHandler }
  );

  assert.strictEqual(result.error, true);
  assert.ok(result.response); // Safe error message
  });

  await asyncTest('TC-APPROVE-003: Clear all pending replies on approval', async () => {
  const handler = new EmailReplyHandler();
  const mockEmailHandler = createMockEmailHandler();

  // Setup multiple pending replies
  pendingEmailReplies.clear();
  for (let i = 0; i < 3; i++) {
    pendingEmailReplies.set('email_reply', {
      email: { messageId: `msg-${i}`, subject: `Test ${i}`, fromAddress: 'sender@example.com' },
      draft: `Reply ${i}`,
      is_meeting_request: false
    });
  }

  assert.strictEqual(pendingEmailReplies.size('email_reply'), 3);

  const pendingReply = pendingEmailReplies.getRecent('email_reply');
  await handler.handleApprove(
    pendingReply,
    { user: 'testuser' },
    { emailHandler: mockEmailHandler }
  );

  // All should be cleared
  assert.strictEqual(pendingEmailReplies.size('email_reply'), 0);
  });

  // --- handleIgnore Tests ---
  console.log('\n--- handleIgnore Tests ---\n');

  await asyncTest('TC-IGNORE-001: Clear pending and return count', async () => {
  const handler = new EmailReplyHandler();

  // Setup 3 pending email replies
  pendingEmailReplies.clear();
  for (let i = 0; i < 3; i++) {
    pendingEmailReplies.set('email_reply', {
      email: { messageId: `msg-${i}`, subject: `Test ${i}`, fromAddress: 'sender@example.com' },
      draft: `Reply ${i}`,
      is_meeting_request: false
    });
  }

  const pendingReply = pendingEmailReplies.getRecent('email_reply');
  const result = await handler.handleIgnore(
    pendingReply,
    { user: 'testuser' },
    {}
  );

  assert.strictEqual(pendingEmailReplies.size('email_reply'), 0);
  assert.ok(result.response.includes('3 pending notifications'));
  assert.strictEqual(result.intent, 'confirm');
  });

  await asyncTest('TC-IGNORE-002: Audit log ignore action', async () => {
  const mockAuditLog = createMockAuditLog();
  const handler = new EmailReplyHandler({ auditLog: mockAuditLog });

  pendingEmailReplies.clear();
  pendingEmailReplies.set('email_reply', {
    email: { messageId: 'msg-123', subject: 'Test', fromAddress: 'sender@example.com' },
    draft: 'Test reply',
    is_meeting_request: false
  });

  const pendingReply = pendingEmailReplies.getRecent('email_reply');
  await handler.handleIgnore(
    pendingReply,
    { user: 'testuser' },
    {}
  );

  const calls = mockAuditLog.getCallsFor('email_reply_ignored');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].data.messageId, 'msg-123');
  });

  // --- handleEdit Tests ---
  console.log('\n--- handleEdit Tests ---\n');

  await asyncTest('TC-EDIT-001: Return edit prompt with subject', async () => {
  const handler = new EmailReplyHandler();

  pendingEmailReplies.clear();
  pendingEmailReplies.set('email_reply', {
    email: { messageId: 'msg-123', subject: 'Test Subject', fromAddress: 'sender@example.com' },
    draft: 'Test reply',
    is_meeting_request: false
  });

  const pendingReply = pendingEmailReplies.getRecent('email_reply');
  const result = await handler.handleEdit(
    pendingReply,
    { user: 'testuser' },
    {}
  );

  assert.ok(result.response.includes('Test Subject'));
  assert.ok(result.response.includes('edited response'));
  assert.strictEqual(result.intent, 'confirm');
  });

  await asyncTest('TC-EDIT-002: Do not clear pending on edit', async () => {
  const handler = new EmailReplyHandler();

  pendingEmailReplies.clear();
  pendingEmailReplies.set('email_reply', {
    email: { messageId: 'msg-123', subject: 'Test', fromAddress: 'sender@example.com' },
    draft: 'Test reply',
    is_meeting_request: false
  });

  const pendingReply = pendingEmailReplies.getRecent('email_reply');
  await handler.handleEdit(
    pendingReply,
    { user: 'testuser' },
    {}
  );

  // Pending should still exist (not cleared)
  assert.strictEqual(pendingEmailReplies.size('email_reply'), 1);
  });

  // Summary
  summary();
  exitWithCode();
}

// Run all tests
runAllTests().catch((error) => {
  console.error('Test suite error:', error);
  process.exit(1);
});
