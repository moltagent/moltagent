/**
 * EmailHandler Unit Tests
 *
 * Comprehensive test suite for the EmailHandler class.
 *
 * Run: node test/unit/handlers/email-handler.test.js
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const {
  createMockAuditLog,
  createMockCredentialBroker,
  createMockLLMRouter
} = require('../../helpers/mock-factories');

// Import module under test
const EmailHandler = require('../../../src/lib/handlers/email-handler');

// ============================================================
// Test Suites
// ============================================================

console.log('\n=== EmailHandler Tests ===\n');

// --- Constructor Tests ---
console.log('\n--- Constructor Tests ---\n');

test('TC-CTOR-001: Initialize with all dependencies', () => {
  const mockCredentials = createMockCredentialBroker();
  const mockLLM = createMockLLMRouter();
  const mockAuditLog = createMockAuditLog();

  const handler = new EmailHandler(mockCredentials, mockLLM, mockAuditLog);

  assert.strictEqual(handler.credentials, mockCredentials);
  assert.strictEqual(handler.llm, mockLLM);
  assert.strictEqual(handler.auditLog, mockAuditLog);
});

test('TC-CTOR-002: Initialize without auditLog uses default', () => {
  const mockCredentials = createMockCredentialBroker();
  const mockLLM = createMockLLMRouter();

  const handler = new EmailHandler(mockCredentials, mockLLM);

  assert.strictEqual(typeof handler.auditLog, 'function');
});

test('TC-CTOR-003: Initialize error handler', () => {
  const handler = new EmailHandler(
    createMockCredentialBroker(),
    createMockLLMRouter()
  );

  assert.ok(handler.errorHandler);
  assert.strictEqual(typeof handler.errorHandler.handle, 'function');
});

test('TC-CTOR-004: Initialize IMAP connection as null', () => {
  const handler = new EmailHandler(
    createMockCredentialBroker(),
    createMockLLMRouter()
  );

  assert.strictEqual(handler._imapConnection, null);
});

// --- Fallback Intent Parsing Tests ---
console.log('\n--- Fallback Intent Parsing Tests ---\n');

test('TC-FALLBACK-001: Parse "send" as draft_email', () => {
  const handler = new EmailHandler(
    createMockCredentialBroker(),
    createMockLLMRouter()
  );

  const intent = handler.fallbackIntentParse('send an email to john@example.com');

  assert.strictEqual(intent.action, 'draft_email');
  assert.strictEqual(intent.to, 'john@example.com');
});

test('TC-FALLBACK-002: Parse "draft" as draft_email', () => {
  const handler = new EmailHandler(
    createMockCredentialBroker(),
    createMockLLMRouter()
  );

  const intent = handler.fallbackIntentParse('draft email to sarah@test.org');

  assert.strictEqual(intent.action, 'draft_email');
  assert.strictEqual(intent.to, 'sarah@test.org');
});

test('TC-FALLBACK-003: Parse "compose" as draft_email', () => {
  const handler = new EmailHandler(
    createMockCredentialBroker(),
    createMockLLMRouter()
  );

  const intent = handler.fallbackIntentParse('compose a message');

  assert.strictEqual(intent.action, 'draft_email');
});

test('TC-FALLBACK-004: Parse "write" as draft_email', () => {
  const handler = new EmailHandler(
    createMockCredentialBroker(),
    createMockLLMRouter()
  );

  const intent = handler.fallbackIntentParse('write an email');

  assert.strictEqual(intent.action, 'draft_email');
});

test('TC-FALLBACK-005: Parse "reply" as draft_reply', () => {
  const handler = new EmailHandler(
    createMockCredentialBroker(),
    createMockLLMRouter()
  );

  const intent = handler.fallbackIntentParse('reply to that email');

  assert.strictEqual(intent.action, 'draft_reply');
});

test('TC-FALLBACK-006: Parse "unread" as check_unread', () => {
  const handler = new EmailHandler(
    createMockCredentialBroker(),
    createMockLLMRouter()
  );

  const intent = handler.fallbackIntentParse('show me unread messages');

  assert.strictEqual(intent.action, 'check_unread');
});

test('TC-FALLBACK-007: Parse "search" as search_emails', () => {
  const handler = new EmailHandler(
    createMockCredentialBroker(),
    createMockLLMRouter()
  );

  const intent = handler.fallbackIntentParse('search for emails from John');

  assert.strictEqual(intent.action, 'search_emails');
});

test('TC-FALLBACK-008: Parse "find" as search_emails', () => {
  const handler = new EmailHandler(
    createMockCredentialBroker(),
    createMockLLMRouter()
  );

  const intent = handler.fallbackIntentParse('find emails about project');

  assert.strictEqual(intent.action, 'search_emails');
});

test('TC-FALLBACK-009: Parse "summarize" as summarize_emails', () => {
  const handler = new EmailHandler(
    createMockCredentialBroker(),
    createMockLLMRouter()
  );

  const intent = handler.fallbackIntentParse('summarize my emails');

  assert.strictEqual(intent.action, 'summarize_emails');
});

test('TC-FALLBACK-010: Parse "summary" as summarize_emails', () => {
  const handler = new EmailHandler(
    createMockCredentialBroker(),
    createMockLLMRouter()
  );

  const intent = handler.fallbackIntentParse('give me a summary');

  assert.strictEqual(intent.action, 'summarize_emails');
});

test('TC-FALLBACK-011: Parse "inbox" as check_inbox', () => {
  const handler = new EmailHandler(
    createMockCredentialBroker(),
    createMockLLMRouter()
  );

  const intent = handler.fallbackIntentParse('check my inbox');

  assert.strictEqual(intent.action, 'check_inbox');
});

test('TC-FALLBACK-012: Parse "check" without other keywords as check_inbox', () => {
  const handler = new EmailHandler(
    createMockCredentialBroker(),
    createMockLLMRouter()
  );

  const intent = handler.fallbackIntentParse('check emails');

  assert.strictEqual(intent.action, 'check_inbox');
});

test('TC-FALLBACK-013: Default to check_inbox', () => {
  const handler = new EmailHandler(
    createMockCredentialBroker(),
    createMockLLMRouter()
  );

  const intent = handler.fallbackIntentParse('something about mail');

  assert.strictEqual(intent.action, 'check_inbox');
});

test('TC-FALLBACK-014: Extract email address from message', () => {
  const handler = new EmailHandler(
    createMockCredentialBroker(),
    createMockLLMRouter()
  );

  const intent = handler.fallbackIntentParse('send email to user.name@company.org about project');

  assert.strictEqual(intent.action, 'draft_email');
  assert.strictEqual(intent.to, 'user.name@company.org');
});

test('TC-FALLBACK-015: Extract subject from quoted string', () => {
  const handler = new EmailHandler(
    createMockCredentialBroker(),
    createMockLLMRouter()
  );

  const intent = handler.fallbackIntentParse('draft email subject: "Meeting Request"');

  assert.strictEqual(intent.action, 'draft_email');
  assert.strictEqual(intent.subject, 'Meeting Request');
});

test('TC-FALLBACK-016: Extract body from message', () => {
  const handler = new EmailHandler(
    createMockCredentialBroker(),
    createMockLLMRouter()
  );

  const intent = handler.fallbackIntentParse('send email saying "Hello there"');

  assert.strictEqual(intent.action, 'draft_email');
  assert.strictEqual(intent.body, 'Hello there');
});

// --- Intent Parsing with LLM Tests ---
console.log('\n--- Intent Parsing with LLM Tests ---\n');

asyncTest('TC-INTENT-001: Parse intent via LLM', async () => {
  const mockLLM = createMockLLMRouter({
    email_parse: { response: '{"action": "check_inbox"}' }
  });

  const handler = new EmailHandler(
    createMockCredentialBroker(),
    mockLLM
  );

  const intent = await handler.parseIntent('check my inbox');

  assert.strictEqual(intent.action, 'check_inbox');
});

asyncTest('TC-INTENT-002: Parse intent with markdown wrapper', async () => {
  const mockLLM = createMockLLMRouter({
    email_parse: { response: '```json\n{"action": "check_unread"}\n```' }
  });

  const handler = new EmailHandler(
    createMockCredentialBroker(),
    mockLLM
  );

  const intent = await handler.parseIntent('show unread');

  assert.strictEqual(intent.action, 'check_unread');
});

asyncTest('TC-INTENT-003: Parse complex intent with multiple fields', async () => {
  const mockLLM = createMockLLMRouter({
    email_parse: { response: '{"action": "draft_email", "to": "test@example.com", "subject": "Hello"}' }
  });

  const handler = new EmailHandler(
    createMockCredentialBroker(),
    mockLLM
  );

  const intent = await handler.parseIntent('draft email to test@example.com about Hello');

  assert.strictEqual(intent.action, 'draft_email');
  assert.strictEqual(intent.to, 'test@example.com');
  assert.strictEqual(intent.subject, 'Hello');
});

asyncTest('TC-INTENT-004: Fallback on LLM parse error', async () => {
  const mockLLM = createMockLLMRouter({
    email_parse: { response: 'not valid json' }
  });

  const handler = new EmailHandler(
    createMockCredentialBroker(),
    mockLLM
  );

  const intent = await handler.parseIntent('check my inbox');

  // Should fallback to fallbackIntentParse
  assert.strictEqual(intent.action, 'check_inbox');
});

asyncTest('TC-INTENT-005: Strip thinking tags from response', async () => {
  const mockLLM = createMockLLMRouter({
    email_parse: { response: '<think>thinking...</think>{"action": "search_emails", "from": "John"}' }
  });

  const handler = new EmailHandler(
    createMockCredentialBroker(),
    mockLLM
  );

  const intent = await handler.parseIntent('find emails from John');

  assert.strictEqual(intent.action, 'search_emails');
  assert.strictEqual(intent.from, 'John');
});

asyncTest('TC-INTENT-006: Handle nested response object', async () => {
  const mockLLM = createMockLLMRouter({
    email_parse: { response: { response: '{"action": "check_inbox"}' } }
  });

  const handler = new EmailHandler(
    createMockCredentialBroker(),
    mockLLM
  );

  const intent = await handler.parseIntent('inbox');

  assert.strictEqual(intent.action, 'check_inbox');
});

// --- Handle Method Tests ---
console.log('\n--- Handle Method Tests ---\n');

asyncTest('TC-HANDLE-001: Route to unknown action returns help message', async () => {
  const mockLLM = createMockLLMRouter({
    email_parse: { response: '{"action": "unknown_action"}' }
  });

  const handler = new EmailHandler(
    createMockCredentialBroker(),
    mockLLM
  );

  const result = await handler.handle('something weird', 'testuser');

  assert.strictEqual(result.success, false);
  assert.ok(result.message.includes("didn't understand"));
});

asyncTest('TC-HANDLE-002: Handle error and log audit', async () => {
  const mockAuditLog = createMockAuditLog();
  const mockCredentials = createMockCredentialBroker();
  const mockLLM = createMockLLMRouter({
    email_parse: { response: '{"action": "check_inbox"}' }
  });

  // This will fail because _fetchEmails requires real IMAP
  const handler = new EmailHandler(mockCredentials, mockLLM, mockAuditLog);

  const result = await handler.handle('check inbox', 'testuser');

  // Should return error response (not throw)
  assert.strictEqual(result.success, false);
  assert.ok(result.message);

  // Should have logged the error
  const errorCalls = mockAuditLog.getCallsFor('email_error');
  assert.strictEqual(errorCalls.length, 1);
});

// --- Draft Email Tests ---
console.log('\n--- Draft Email Tests ---\n');

asyncTest('TC-DRAFT-001: Missing recipient returns error', async () => {
  const mockLLM = createMockLLMRouter({
    email_parse: { response: '{"action": "draft_email"}' }
  });

  const handler = new EmailHandler(
    createMockCredentialBroker(),
    mockLLM
  );

  const result = await handler.handleDraftEmail({}, 'testuser', {});

  assert.strictEqual(result.success, false);
  assert.ok(result.message.includes('Who should I send'));
});

asyncTest('TC-DRAFT-002: Draft email with body provided', async () => {
  const handler = new EmailHandler(
    createMockCredentialBroker(),
    createMockLLMRouter()
  );

  const result = await handler.handleDraftEmail({
    to: 'test@example.com',
    subject: 'Test Subject',
    body: 'Test body content'
  }, 'testuser', {});

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.requiresConfirmation, true);
  assert.strictEqual(result.confirmationType, 'send_email');
  assert.strictEqual(result.draft.to, 'test@example.com');
  assert.strictEqual(result.draft.subject, 'Test Subject');
  assert.strictEqual(result.draft.body, 'Test body content');
});

asyncTest('TC-DRAFT-003: Draft email generates body via LLM when topic provided', async () => {
  const mockLLM = createMockLLMRouter({
    email_draft: { response: 'Generated email body from LLM' }
  });

  const handler = new EmailHandler(
    createMockCredentialBroker(),
    mockLLM
  );

  const result = await handler.handleDraftEmail({
    to: 'test@example.com',
    topic: 'project update'
  }, 'testuser', {});

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.requiresConfirmation, true);
  assert.ok(result.draft.body.includes('Generated email body'));
});

asyncTest('TC-DRAFT-004: Draft email with content hint', async () => {
  const mockLLM = createMockLLMRouter({
    email_draft: { response: 'Content-based email body' }
  });

  const handler = new EmailHandler(
    createMockCredentialBroker(),
    mockLLM
  );

  const result = await handler.handleDraftEmail({
    to: 'test@example.com',
    content: 'discuss the quarterly results'
  }, 'testuser', {});

  assert.strictEqual(result.success, true);
  assert.ok(result.draft.body.includes('Content-based'));
});

asyncTest('TC-DRAFT-005: Draft preview includes all fields', async () => {
  const handler = new EmailHandler(
    createMockCredentialBroker(),
    createMockLLMRouter()
  );

  const result = await handler.handleDraftEmail({
    to: 'recipient@example.com',
    subject: 'Important Subject',
    body: 'Email body here'
  }, 'testuser', {});

  assert.ok(result.message.includes('recipient@example.com'));
  assert.ok(result.message.includes('Important Subject'));
  assert.ok(result.message.includes('Email body here'));
  assert.ok(result.message.includes('yes'));
  assert.ok(result.message.includes('edit'));
  assert.ok(result.message.includes('no'));
});

asyncTest('TC-DRAFT-006: Draft email strips thinking tags from LLM response', async () => {
  const mockLLM = createMockLLMRouter({
    email_draft: { response: '<think>planning...</think>Clean email body' }
  });

  const handler = new EmailHandler(
    createMockCredentialBroker(),
    mockLLM
  );

  const result = await handler.handleDraftEmail({
    to: 'test@example.com',
    topic: 'test'
  }, 'testuser', {});

  assert.ok(!result.draft.body.includes('<think>'));
  assert.ok(result.draft.body.includes('Clean email body'));
});

// --- Draft Reply Tests ---
console.log('\n--- Draft Reply Tests ---\n');

asyncTest('TC-REPLY-001: Reply using context.lastEmail', async () => {
  const mockLLM = createMockLLMRouter({
    email_reply: { response: 'Reply body generated' }
  });

  const handler = new EmailHandler(
    createMockCredentialBroker(),
    mockLLM
  );

  const context = {
    lastEmail: {
      from: 'sender@example.com',
      fromAddress: 'sender@example.com',
      subject: 'Original Subject',
      snippet: 'Original email snippet',
      messageId: 'msg-123'
    }
  };

  const result = await handler.handleDraftReply({ content: 'I agree' }, 'testuser', context);

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.requiresConfirmation, true);
  assert.strictEqual(result.draft.to, 'sender@example.com');
  assert.strictEqual(result.draft.subject, 'Re: Original Subject');
  assert.strictEqual(result.draft.inReplyTo, 'msg-123');
});

asyncTest('TC-REPLY-002: Reply adds Re: prefix to subject', async () => {
  const mockLLM = createMockLLMRouter({
    email_reply: { response: 'Reply body' }
  });

  const handler = new EmailHandler(
    createMockCredentialBroker(),
    mockLLM
  );

  const context = {
    lastEmail: {
      from: 'sender@example.com',
      fromAddress: 'sender@example.com',
      subject: 'Meeting Tomorrow',
      snippet: 'Text',
      messageId: 'msg-123'
    }
  };

  const result = await handler.handleDraftReply({}, 'testuser', context);

  assert.strictEqual(result.draft.subject, 'Re: Meeting Tomorrow');
});

asyncTest('TC-REPLY-003: Reply does not double Re: prefix', async () => {
  const mockLLM = createMockLLMRouter({
    email_reply: { response: 'Reply body' }
  });

  const handler = new EmailHandler(
    createMockCredentialBroker(),
    mockLLM
  );

  const context = {
    lastEmail: {
      from: 'sender@example.com',
      fromAddress: 'sender@example.com',
      subject: 'Re: Already has prefix',
      snippet: 'Text',
      messageId: 'msg-123'
    }
  };

  const result = await handler.handleDraftReply({}, 'testuser', context);

  assert.strictEqual(result.draft.subject, 'Re: Already has prefix');
  assert.ok(!result.draft.subject.startsWith('Re: Re:'));
});

// --- Formatting Helper Tests ---
console.log('\n--- Formatting Helper Tests ---\n');

test('TC-FORMAT-001: Format email list with unread count', () => {
  const handler = new EmailHandler(
    createMockCredentialBroker(),
    createMockLLMRouter()
  );

  const emails = [
    { from: 'John <john@example.com>', fromAddress: 'john@example.com', subject: 'Hello', date: new Date(), isRead: false, hasAttachments: false },
    { from: 'Jane <jane@example.com>', fromAddress: 'jane@example.com', subject: 'Hi', date: new Date(), isRead: true, hasAttachments: true }
  ];

  const formatted = handler._formatEmailList(emails, 1);

  assert.ok(formatted.includes('Inbox'));
  assert.ok(formatted.includes('1 unread'));
  assert.ok(formatted.includes('John'));
  assert.ok(formatted.includes('Hello'));
});

test('TC-FORMAT-002: Format full email', () => {
  const handler = new EmailHandler(
    createMockCredentialBroker(),
    createMockLLMRouter()
  );

  const email = {
    from: 'John <john@example.com>',
    subject: 'Test Subject',
    date: new Date('2025-02-05T10:00:00Z'),
    body: 'Email body content here.',
    hasAttachments: true,
    attachmentCount: 2
  };

  const formatted = handler._formatFullEmail(email);

  assert.ok(formatted.includes('Test Subject'));
  assert.ok(formatted.includes('john@example.com'));
  assert.ok(formatted.includes('Email body content'));
  assert.ok(formatted.includes('2 file(s)'));
});

test('TC-FORMAT-003: Format draft preview', () => {
  const handler = new EmailHandler(
    createMockCredentialBroker(),
    createMockLLMRouter()
  );

  const draft = {
    to: 'recipient@example.com',
    subject: 'Draft Subject',
    body: 'Draft body content'
  };

  const formatted = handler._formatDraftPreview(draft);

  assert.ok(formatted.includes('recipient@example.com'));
  assert.ok(formatted.includes('Draft Subject'));
  assert.ok(formatted.includes('Draft body content'));
});

test('TC-FORMAT-004: Format date', () => {
  const handler = new EmailHandler(
    createMockCredentialBroker(),
    createMockLLMRouter()
  );

  const date = new Date('2025-02-05T14:30:00Z');
  const formatted = handler._formatDate(date);

  // Should include day, month, time
  assert.ok(formatted.length > 0);
  assert.ok(formatted.includes('Feb') || formatted.includes('5'));
});

test('TC-FORMAT-005: Format date handles null', () => {
  const handler = new EmailHandler(
    createMockCredentialBroker(),
    createMockLLMRouter()
  );

  const formatted = handler._formatDate(null);

  assert.strictEqual(formatted, '');
});

test('TC-FORMAT-006: Format time ago - just now', () => {
  const handler = new EmailHandler(
    createMockCredentialBroker(),
    createMockLLMRouter()
  );

  const formatted = handler._formatTimeAgo(new Date());

  assert.strictEqual(formatted, 'just now');
});

test('TC-FORMAT-007: Format time ago - minutes', () => {
  const handler = new EmailHandler(
    createMockCredentialBroker(),
    createMockLLMRouter()
  );

  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
  const formatted = handler._formatTimeAgo(fiveMinutesAgo);

  assert.ok(formatted.includes('5m ago') || formatted.includes('4m ago'));
});

test('TC-FORMAT-008: Format time ago - hours', () => {
  const handler = new EmailHandler(
    createMockCredentialBroker(),
    createMockLLMRouter()
  );

  const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const formatted = handler._formatTimeAgo(threeHoursAgo);

  assert.ok(formatted.includes('3h ago') || formatted.includes('2h ago'));
});

test('TC-FORMAT-009: Format time ago - days', () => {
  const handler = new EmailHandler(
    createMockCredentialBroker(),
    createMockLLMRouter()
  );

  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  const formatted = handler._formatTimeAgo(twoDaysAgo);

  assert.ok(formatted.includes('2d ago') || formatted.includes('1d ago'));
});

test('TC-FORMAT-010: Format time ago - old dates show month/day', () => {
  const handler = new EmailHandler(
    createMockCredentialBroker(),
    createMockLLMRouter()
  );

  const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const formatted = handler._formatTimeAgo(twoWeeksAgo);

  assert.ok(!formatted.includes('ago'));
});

test('TC-FORMAT-011: Format time ago handles null', () => {
  const handler = new EmailHandler(
    createMockCredentialBroker(),
    createMockLLMRouter()
  );

  const formatted = handler._formatTimeAgo(null);

  assert.strictEqual(formatted, '');
});

test('TC-FORMAT-012: Get snippet truncates long text', () => {
  const handler = new EmailHandler(
    createMockCredentialBroker(),
    createMockLLMRouter()
  );

  const longText = 'A'.repeat(300);
  const snippet = handler._getSnippet(longText, 200);

  assert.ok(snippet.length <= 203); // 200 + '...'
  assert.ok(snippet.endsWith('...'));
});

test('TC-FORMAT-013: Get snippet returns short text as-is', () => {
  const handler = new EmailHandler(
    createMockCredentialBroker(),
    createMockLLMRouter()
  );

  const shortText = 'Short text';
  const snippet = handler._getSnippet(shortText, 200);

  assert.strictEqual(snippet, 'Short text');
});

test('TC-FORMAT-014: Get snippet handles empty text', () => {
  const handler = new EmailHandler(
    createMockCredentialBroker(),
    createMockLLMRouter()
  );

  const snippet = handler._getSnippet('', 200);

  assert.strictEqual(snippet, '');
});

test('TC-FORMAT-015: Get snippet handles null', () => {
  const handler = new EmailHandler(
    createMockCredentialBroker(),
    createMockLLMRouter()
  );

  const snippet = handler._getSnippet(null, 200);

  assert.strictEqual(snippet, '');
});

// --- Email Footer Tests ---
console.log('\n--- Email Footer Tests ---\n');

asyncTest('TC-FOOTER-001: Default footer when no custom configured', async () => {
  const mockCredentials = createMockCredentialBroker({});

  const handler = new EmailHandler(
    mockCredentials,
    createMockLLMRouter()
  );

  const footer = await handler._getEmailFooter('testuser');

  assert.ok(footer.includes('Moltagent'));
  assert.ok(footer.includes('testuser'));
});

asyncTest('TC-FOOTER-002: Custom string footer', async () => {
  const mockCredentials = createMockCredentialBroker({
    'email-footer': 'Custom footer for [USER]'
  });

  const handler = new EmailHandler(
    mockCredentials,
    createMockLLMRouter()
  );

  const footer = await handler._getEmailFooter('john');

  assert.strictEqual(footer, 'Custom footer for john');
});

asyncTest('TC-FOOTER-003: Custom object footer uses password field', async () => {
  const mockCredentials = createMockCredentialBroker({
    'email-footer': { password: 'Footer from [USER]' }
  });

  const handler = new EmailHandler(
    mockCredentials,
    createMockLLMRouter()
  );

  const footer = await handler._getEmailFooter('jane');

  assert.strictEqual(footer, 'Footer from jane');
});

asyncTest('TC-FOOTER-004: Disable footer with ---NONE--- marker', async () => {
  const mockCredentials = createMockCredentialBroker({
    'email-footer': '---NONE---'
  });

  const handler = new EmailHandler(
    mockCredentials,
    createMockLLMRouter()
  );

  const footer = await handler._getEmailFooter('testuser');

  assert.strictEqual(footer, null);
});

asyncTest('TC-FOOTER-005: Empty footer string returns null', async () => {
  const mockCredentials = createMockCredentialBroker({
    'email-footer': '   '
  });

  const handler = new EmailHandler(
    mockCredentials,
    createMockLLMRouter()
  );

  const footer = await handler._getEmailFooter('testuser');

  assert.strictEqual(footer, null);
});

asyncTest('TC-FOOTER-006: User placeholder is case insensitive', async () => {
  const mockCredentials = createMockCredentialBroker({
    'email-footer': 'Sent by [user] via [USER]'
  });

  const handler = new EmailHandler(
    mockCredentials,
    createMockLLMRouter()
  );

  const footer = await handler._getEmailFooter('bob');

  assert.strictEqual(footer, 'Sent by bob via bob');
});

asyncTest('TC-FOOTER-007: Default user when not provided', async () => {
  const mockCredentials = createMockCredentialBroker({
    'email-footer': 'From [USER]'
  });

  const handler = new EmailHandler(
    mockCredentials,
    createMockLLMRouter()
  );

  const footer = await handler._getEmailFooter(null);

  assert.strictEqual(footer, 'From User');
});

// --- Search Emails Tests ---
console.log('\n--- Search Emails Tests ---\n');

asyncTest('TC-SEARCH-001: Search without criteria returns error', async () => {
  const handler = new EmailHandler(
    createMockCredentialBroker(),
    createMockLLMRouter()
  );

  const result = await handler.handleSearchEmails({}, 'testuser');

  assert.strictEqual(result.success, false);
  assert.ok(result.message.includes('What would you like to search'));
});

// --- Error Handler Integration Tests ---
console.log('\n--- Error Handler Integration Tests ---\n');

asyncTest('TC-ERROR-001: Error handler returns safe message', async () => {
  const mockCredentials = createMockCredentialBroker({});
  const mockLLM = createMockLLMRouter({
    email_parse: { response: '{"action": "check_inbox"}' }
  });
  const mockAuditLog = createMockAuditLog();

  const handler = new EmailHandler(mockCredentials, mockLLM, mockAuditLog);

  // This will fail because no IMAP credentials
  const result = await handler.handle('check inbox', 'testuser');

  assert.strictEqual(result.success, false);
  // Should not expose internal error details
  assert.ok(!result.message.includes('ECONNREFUSED'));
});

// Summary
setTimeout(() => {
  summary();
  exitWithCode();
}, 100);
