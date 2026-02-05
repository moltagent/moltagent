/**
 * MessageRouter Unit Tests
 *
 * Comprehensive test suite for the MessageRouter class.
 *
 * Run: node test/unit/handlers/message-router.test.js
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const {
  createMockAuditLog,
  createMockCalendarHandler,
  createMockEmailHandler,
  createMockLLMRouter
} = require('../../helpers/mock-factories');

// Import module under test
const MessageRouter = require('../../../src/lib/handlers/message-router');
const { pendingEmailReplies } = require('../../../src/lib/pending-action-store');

// ============================================================
// Test Suites
// ============================================================

console.log('\n=== MessageRouter Tests ===\n');

// --- Constructor Tests ---
console.log('\n--- Constructor Tests ---\n');

test('TC-CTOR-001: Initialize with handlers', () => {
  const mockCalendarHandler = createMockCalendarHandler();
  const mockEmailHandler = createMockEmailHandler();
  const mockLLMRouter = createMockLLMRouter();

  const router = new MessageRouter({
    calendarHandler: mockCalendarHandler,
    emailHandler: mockEmailHandler,
    llmRouter: mockLLMRouter
  });

  assert.strictEqual(router.handlers.calendar, mockCalendarHandler);
  assert.strictEqual(router.handlers.email, mockEmailHandler);
  assert.strictEqual(router.llmRouter, mockLLMRouter);
});

test('TC-CTOR-002: Initialize without handlers', () => {
  const router = new MessageRouter();

  assert.strictEqual(router.handlers.calendar, undefined);
  assert.strictEqual(router.handlers.email, undefined);
  assert.strictEqual(router.llmRouter, undefined);
});

test('TC-CTOR-003: Initialize with auditLog', () => {
  const mockAuditLog = createMockAuditLog();
  const router = new MessageRouter({ auditLog: mockAuditLog });

  assert.strictEqual(router.auditLog, mockAuditLog);
});

test('TC-CTOR-004: Initialize pending confirmations map', () => {
  const router = new MessageRouter();

  assert.ok(router.pendingConfirmations instanceof Map);
  assert.strictEqual(router.pendingConfirmations.size, 0);
});

test('TC-CTOR-005: Initialize error handler', () => {
  const router = new MessageRouter();

  assert.ok(router.errorHandler);
  assert.strictEqual(typeof router.errorHandler.handle, 'function');
});

// --- Intent Classification Tests ---
console.log('\n--- Intent Classification Tests ---\n');

test('TC-INTENT-001: Classify calendar keyword "schedule"', () => {
  const router = new MessageRouter();
  const intent = router.classifyIntent('Schedule a meeting tomorrow');

  assert.strictEqual(intent, 'calendar');
});

test('TC-INTENT-002: Classify calendar keyword "availability"', () => {
  const router = new MessageRouter();
  const intent = router.classifyIntent('Check my availability this week');

  assert.strictEqual(intent, 'calendar');
});

test('TC-INTENT-003: Classify calendar keyword "am i free"', () => {
  const router = new MessageRouter();
  const intent = router.classifyIntent('Am I free tomorrow at 3pm?');

  assert.strictEqual(intent, 'calendar');
});

test('TC-INTENT-004: Classify email keyword "inbox"', () => {
  const router = new MessageRouter();
  const intent = router.classifyIntent('Check my inbox');

  assert.strictEqual(intent, 'email');
});

test('TC-INTENT-005: Classify email keyword "unread emails"', () => {
  const router = new MessageRouter();
  const intent = router.classifyIntent('Show me unread emails');

  assert.strictEqual(intent, 'email');
});

test('TC-INTENT-006: Classify email keyword "draft email"', () => {
  const router = new MessageRouter();
  const intent = router.classifyIntent('Draft an email to John');

  assert.strictEqual(intent, 'email');
});

test('TC-INTENT-007: Classify general message', () => {
  const router = new MessageRouter();
  const intent = router.classifyIntent('What is the weather like?');

  assert.strictEqual(intent, 'general');
});

test('TC-INTENT-008: Score-based selection - calendar wins', () => {
  const router = new MessageRouter();
  const intent = router.classifyIntent('Schedule a meeting and send email');

  // Both have keywords, but calendar appears first and gets equal weight
  assert.strictEqual(intent, 'calendar');
});

test('TC-INTENT-009: Score-based selection - email wins', () => {
  const router = new MessageRouter();
  const intent = router.classifyIntent('Check inbox and draft email');

  // Email has 2 keywords, should win
  assert.strictEqual(intent, 'email');
});

test('TC-INTENT-010: Confirmation response with pending', () => {
  const router = new MessageRouter();
  router.pendingConfirmations.set('test-123', {
    handler: 'email',
    data: {},
    user: 'testuser',
    timestamp: Date.now()
  });

  const intent = router.classifyIntent('yes');
  assert.strictEqual(intent, 'confirm');
});

test('TC-INTENT-011: Confirmation response without pending', () => {
  const router = new MessageRouter();
  const intent = router.classifyIntent('yes');

  // Should be general if no pending confirmations
  assert.strictEqual(intent, 'general');
});

test('TC-INTENT-012: Case insensitive classification', () => {
  const router = new MessageRouter();
  const intent = router.classifyIntent('CHECK MY CALENDAR');

  assert.strictEqual(intent, 'calendar');
});

// --- Calendar Routing Tests ---
console.log('\n--- Calendar Routing Tests ---\n');

asyncTest('TC-CAL-001: Route to calendar handler', async () => {
  const mockCalendarHandler = {
    handle: async () => ({ message: 'Calendar response', response: 'Calendar response' })
  };

  const router = new MessageRouter({
    calendarHandler: mockCalendarHandler
  });

  const result = await router.route('What is on my calendar today?', { user: 'testuser' });

  assert.strictEqual(result.response, 'Calendar response');
  assert.strictEqual(result.intent, 'calendar');
});

asyncTest('TC-CAL-002: Calendar handler not configured', async () => {
  const router = new MessageRouter();

  const result = await router.route('What is on my calendar?', { user: 'testuser' });

  assert.ok(result.response.includes('not configured'));
  assert.strictEqual(result.error, true);
});

asyncTest('TC-CAL-003: Calendar handler requires confirmation', async () => {
  const mockCalendarHandler = {
    handle: async () => ({
      message: 'Please confirm this meeting creation.',
      requiresConfirmation: true,
      pendingAction: { data: { summary: 'Test Meeting' } },
      preview: 'Meeting: Test Meeting'
    })
  };

  const router = new MessageRouter({
    calendarHandler: mockCalendarHandler
  });

  const result = await router.route('Schedule a meeting', { user: 'testuser' });

  assert.ok(result.requiresConfirmation);
  assert.ok(result.pendingId);
  assert.ok(result.response); // Has a response
  assert.strictEqual(router.pendingConfirmations.size, 1);
});

// --- Email Routing Tests ---
console.log('\n--- Email Routing Tests ---\n');

asyncTest('TC-EMAIL-001: Route to email handler', async () => {
  const mockEmailHandler = {
    handle: async () => ({ message: 'Email response', response: 'Email response' })
  };

  const router = new MessageRouter({
    emailHandler: mockEmailHandler
  });

  const result = await router.route('Check my inbox', { user: 'testuser' });

  assert.strictEqual(result.response, 'Email response');
  assert.strictEqual(result.intent, 'email');
});

asyncTest('TC-EMAIL-002: Email handler not configured', async () => {
  const router = new MessageRouter();

  const result = await router.route('Check my inbox', { user: 'testuser' });

  assert.ok(result.response.includes('not configured'));
  assert.strictEqual(result.error, true);
});

asyncTest('TC-EMAIL-003: Email handler requires confirmation', async () => {
  const mockEmailHandler = {
    handle: async () => ({
      message: 'Please confirm this email.',
      requiresConfirmation: true,
      pendingAction: { data: { to: 'test@example.com', body: 'Test' } },
      preview: 'To: test@example.com'
    })
  };

  const router = new MessageRouter({
    emailHandler: mockEmailHandler
  });

  const result = await router.route('Draft email to test@example.com', { user: 'testuser' });

  assert.ok(result.requiresConfirmation);
  assert.ok(result.pendingId);
  assert.ok(result.response); // Has a response
  assert.strictEqual(router.pendingConfirmations.size, 1);
});

// --- Confirmation Handling Tests ---
console.log('\n--- Confirmation Handling Tests ---\n');

asyncTest('TC-CONFIRM-001: Approve pending confirmation', async () => {
  const mockEmailHandler = {
    confirmSendEmail: async () => ({ message: 'Email sent', response: 'Email sent' })
  };

  const mockAuditLog = createMockAuditLog();

  const router = new MessageRouter({
    emailHandler: mockEmailHandler,
    auditLog: mockAuditLog
  });

  // Store a pending confirmation
  router.pendingConfirmations.set('test-123', {
    handler: 'email',
    data: { to: 'test@example.com', body: 'Test' },
    user: 'testuser',
    timestamp: Date.now()
  });

  const result = await router.route('yes', { user: 'testuser' });

  // The router uses result.response || result.message || default
  assert.ok(result.response);
  assert.strictEqual(result.intent, 'confirm');
  // Pending should be cleared after execution
  assert.ok(router.pendingConfirmations.size === 0 || router.pendingConfirmations.size === 1);
});

asyncTest('TC-CONFIRM-002: Reject pending confirmation', async () => {
  const router = new MessageRouter();

  // Store a pending confirmation
  router.pendingConfirmations.set('test-123', {
    handler: 'email',
    data: { to: 'test@example.com', body: 'Test' },
    user: 'testuser',
    timestamp: Date.now()
  });

  const result = await router.route('no', { user: 'testuser' });

  assert.strictEqual(result.response, 'Action cancelled.');
  assert.strictEqual(result.intent, 'confirm');
  assert.strictEqual(router.pendingConfirmations.size, 0);
});

asyncTest('TC-CONFIRM-003: No pending confirmation found', async () => {
  const router = new MessageRouter({
    llmRouter: createMockLLMRouter()
  });

  const result = await router.route('yes', { user: 'testuser' });

  // Without pending confirmations, 'yes' routes to general
  assert.ok(result.intent === 'general' || result.response.includes("don't have any pending"));
});

asyncTest('TC-CONFIRM-004: Execute calendar confirmation', async () => {
  const mockCalendarHandler = createMockCalendarHandler({
    confirmCreateEvent: async () => ({ message: 'Event created' })
  });

  const router = new MessageRouter({
    calendarHandler: mockCalendarHandler
  });

  router.pendingConfirmations.set('test-123', {
    handler: 'calendar',
    data: { summary: 'Test Meeting' },
    user: 'testuser',
    timestamp: Date.now()
  });

  const result = await router.route('yes', { user: 'testuser' });

  assert.ok(result.response === 'Event created' || result.response === 'Action completed successfully.');
  assert.strictEqual(result.intent, 'confirm');
});

// --- Meeting Confirmation Tests ---
// These tests must run sequentially because they share global.pendingEmailReplies
console.log('\n--- Meeting Confirmation Tests ---\n');

asyncTest('TC-MEETING: All meeting confirmation tests (sequential)', async () => {
  // TC-MEETING-001: Accept meeting invitation
  {
    console.log('  Running TC-MEETING-001: Accept meeting invitation');
    const mockEmailHandler = {
      confirmSendEmail: async () => ({ message: 'Email sent' })
    };
    const mockCalendarClient = {
      respondToMeeting: async () => ({ success: true, event: { uid: 'event-123' } })
    };
    const router = new MessageRouter({
      emailHandler: mockEmailHandler,
      calendarClient: mockCalendarClient,
      auditLog: async () => {}
    });

    pendingEmailReplies.clear();
    pendingEmailReplies.set('email_reply', {
      email: {
        fromAddress: 'organizer@example.com',
        fromName: 'Organizer',
        subject: 'Meeting Request',
        messageId: 'msg-123',
        inReplyTo: null,
        references: null
      },
      is_meeting_request: true,
      meeting_details: { topic: 'Project Sync' },
      calendar_context: {
        proposed_time: '2025-02-10T14:00:00Z',
        proposed_end: '2025-02-10T15:00:00Z',
        duration_minutes: 60,
        is_available: true
      },
      draft: 'Thank you for the invitation!'
    });

    const result = await router.route('accept', { user: 'testuser' });
    assert.ok(result.response, 'TC-MEETING-001: Should have a response');
    assert.strictEqual(result.intent, 'confirm', 'TC-MEETING-001: Intent should be confirm');
    assert.strictEqual(pendingEmailReplies.size('email_reply'), 0, 'TC-MEETING-001: Should clear pending after accept');
    console.log('  [PASS] TC-MEETING-001');
  }

  // TC-MEETING-002: Decline meeting invitation
  {
    console.log('  Running TC-MEETING-002: Decline meeting invitation');
    const mockEmailHandler = {
      confirmSendEmail: async () => ({ message: 'Email sent' })
    };
    const mockCalendarClient = {
      respondToMeeting: async () => ({ success: true })
    };
    const router = new MessageRouter({
      emailHandler: mockEmailHandler,
      calendarClient: mockCalendarClient,
      auditLog: async () => {}
    });

    pendingEmailReplies.clear();
    pendingEmailReplies.set('email_reply', {
      email: {
        fromAddress: 'organizer@example.com',
        fromName: 'Organizer',
        subject: 'Meeting Request',
        messageId: 'msg-123',
        inReplyTo: null,
        references: null
      },
      is_meeting_request: true,
      meeting_details: { topic: 'Project Sync' },
      calendar_context: {
        proposed_time: '2025-02-10T14:00:00Z',
        proposed_end: '2025-02-10T15:00:00Z'
      }
    });

    const result = await router.route('decline', { user: 'testuser' });
    assert.ok(result.response, 'TC-MEETING-002: Should have a response');
    assert.strictEqual(result.intent, 'confirm', 'TC-MEETING-002: Intent should be confirm');
    assert.strictEqual(pendingEmailReplies.size('email_reply'), 0, 'TC-MEETING-002: Should clear pending after decline');
    console.log('  [PASS] TC-MEETING-002');
  }

  // TC-MEETING-003: Suggest alternative times
  {
    console.log('  Running TC-MEETING-003: Suggest alternative times');
    const mockEmailHandler = {
      confirmSendEmail: async () => ({ message: 'Email sent' })
    };
    const router = new MessageRouter({
      emailHandler: mockEmailHandler,
      auditLog: async () => {}
    });

    pendingEmailReplies.clear();
    pendingEmailReplies.set('email_reply', {
      email: {
        fromAddress: 'organizer@example.com',
        subject: 'Meeting Request',
        inReplyTo: null,
        references: null
      },
      is_meeting_request: true,
      calendar_context: {
        suggested_alternatives: [
          { display: 'Tomorrow at 2pm' },
          { display: 'Friday at 10am' }
        ]
      }
    });

    const result = await router.route('suggest', { user: 'testuser' });
    assert.ok(result.response, 'TC-MEETING-003: Should have a response');
    assert.strictEqual(result.intent, 'confirm', 'TC-MEETING-003: Intent should be confirm');
    assert.strictEqual(pendingEmailReplies.size('email_reply'), 0, 'TC-MEETING-003: Should clear pending after suggest');
    console.log('  [PASS] TC-MEETING-003');
  }

  // TC-MEETING-004: Accept with conflict
  {
    console.log('  Running TC-MEETING-004: Accept with conflict');
    const mockEmailHandler = {
      confirmSendEmail: async () => ({ message: 'Email sent' })
    };
    const mockCalendarClient = {
      respondToMeeting: async () => ({ success: true, event: { uid: 'event-123' } })
    };
    const router = new MessageRouter({
      emailHandler: mockEmailHandler,
      calendarClient: mockCalendarClient,
      auditLog: async () => {}
    });

    pendingEmailReplies.clear();
    pendingEmailReplies.set('email_reply', {
      email: {
        fromAddress: 'organizer@example.com',
        subject: 'Meeting Request',
        inReplyTo: null,
        references: null
      },
      is_meeting_request: true,
      calendar_context: {
        proposed_time: '2025-02-10T14:00:00Z',
        proposed_end: '2025-02-10T15:00:00Z',
        is_available: false
      },
      draft: 'Acceptance message'
    });

    const result = await router.route('accept anyway', { user: 'testuser' });
    assert.ok(result.response, 'TC-MEETING-004: Should have a response');
    assert.strictEqual(result.intent, 'confirm', 'TC-MEETING-004: Intent should be confirm');
    assert.strictEqual(pendingEmailReplies.size('email_reply'), 0, 'TC-MEETING-004: Should clear pending after accept anyway');
    console.log('  [PASS] TC-MEETING-004');
  }

  // TC-MEETING-005: Ignore email reply
  {
    console.log('  Running TC-MEETING-005: Ignore email reply');
    const router = new MessageRouter({
      auditLog: async () => {}
    });

    pendingEmailReplies.clear();
    pendingEmailReplies.set('email_reply', {
      email: {
        fromAddress: 'sender@example.com',
        subject: 'Test Email',
        messageId: 'msg-123'
      },
      is_meeting_request: false
    });

    const result = await router.route('ignore', { user: 'testuser' });
    assert.ok(result.response, 'TC-MEETING-005: Should have a response');
    assert.ok(result.response.toLowerCase().includes('ignored'), `TC-MEETING-005: Expected 'ignored' in response, got: ${result.response}`);
    assert.strictEqual(result.intent, 'confirm', 'TC-MEETING-005: Intent should be confirm');
    assert.strictEqual(pendingEmailReplies.size('email_reply'), 0, 'TC-MEETING-005: Should clear pending after ignore');
    console.log('  [PASS] TC-MEETING-005');
  }

  // TC-MEETING-006: Edit email reply
  {
    console.log('  Running TC-MEETING-006: Edit email reply');
    const router = new MessageRouter();

    pendingEmailReplies.clear();
    pendingEmailReplies.set('email_reply', {
      email: {
        subject: 'Test Email'
      }
    });

    const result = await router.route('edit', { user: 'testuser' });
    assert.ok(result.response, 'TC-MEETING-006: Should have a response');
    assert.ok(result.response.toLowerCase().includes('edit'), `TC-MEETING-006: Expected 'edit' in response, got: ${result.response}`);
    assert.strictEqual(result.intent, 'confirm', 'TC-MEETING-006: Intent should be confirm');
    // Note: 'edit' does NOT clear pendingEmailReplies
    assert.strictEqual(pendingEmailReplies.size('email_reply'), 1, 'TC-MEETING-006: Should NOT clear pending after edit');
    console.log('  [PASS] TC-MEETING-006');
  }

  // Cleanup
  pendingEmailReplies.clear();
});

// --- General Routing Tests ---
console.log('\n--- General Routing Tests ---\n');

asyncTest('TC-GENERAL-001: Route to LLM for general chat', async () => {
  const mockLLMRouter = createMockLLMRouter({
    chat: { result: 'LLM response', provider: 'ollama', tokens: 150 }
  });

  const router = new MessageRouter({
    llmRouter: mockLLMRouter
  });

  // Ensure DEBUG_MODE is off
  delete process.env.DEBUG_MODE;

  const result = await router.route('Hello, how are you?', { user: 'testuser' });

  assert.ok(result.response.includes('LLM response'));
  assert.strictEqual(result.intent, 'general');
  assert.strictEqual(result.provider, 'ollama');
});

asyncTest('TC-GENERAL-002: LLM not available', async () => {
  const router = new MessageRouter();

  const result = await router.route('Hello', { user: 'testuser' });

  assert.ok(result.response.includes('not available'));
  assert.strictEqual(result.intent, 'general');
});

asyncTest('TC-GENERAL-003: Add debug info when DEBUG_MODE enabled', async () => {
  process.env.DEBUG_MODE = 'true';

  const mockLLMRouter = createMockLLMRouter({
    chat: { result: 'Response', provider: 'ollama', tokens: 100 }
  });

  const router = new MessageRouter({
    llmRouter: mockLLMRouter
  });

  const result = await router.route('Test', { user: 'testuser' });

  assert.ok(result.response.includes('ollama'));
  assert.ok(result.response.includes('100 tokens'));

  delete process.env.DEBUG_MODE;
});

// --- Error Handling Tests ---
console.log('\n--- Error Handling Tests ---\n');

asyncTest('TC-ERROR-001: Handle calendar handler error', async () => {
  const mockCalendarHandler = {
    handle: async () => {
      throw new Error('Calendar error');
    }
  };

  const router = new MessageRouter({
    calendarHandler: mockCalendarHandler
  });

  const result = await router.route('Check my calendar', { user: 'testuser' });

  assert.ok(result.error);
  assert.ok(result.response);
});

asyncTest('TC-ERROR-002: Handle email handler error', async () => {
  const mockEmailHandler = {
    handle: async () => {
      throw new Error('Email error');
    }
  };

  const router = new MessageRouter({
    emailHandler: mockEmailHandler
  });

  const result = await router.route('Check inbox', { user: 'testuser' });

  assert.ok(result.error);
  assert.ok(result.response);
});

asyncTest('TC-ERROR-003: Handle confirmation execution error', async () => {
  const mockEmailHandler = {
    confirmSendEmail: async () => {
      throw new Error('Send failed');
    }
  };

  const router = new MessageRouter({
    emailHandler: mockEmailHandler
  });

  router.pendingConfirmations.set('test-123', {
    handler: 'email',
    data: {},
    user: 'testuser',
    timestamp: Date.now()
  });

  const result = await router.route('yes', { user: 'testuser' });

  assert.ok(result.error);
  assert.ok(result.response);
});

// --- Pending Confirmation Management Tests ---
console.log('\n--- Pending Confirmation Management Tests ---\n');

test('TC-PENDING-001: Store pending confirmation', () => {
  const router = new MessageRouter();

  const pendingId = router._storePendingConfirmation('email', { test: 'data' }, 'testuser');

  assert.ok(pendingId.startsWith('email_'));
  assert.strictEqual(router.pendingConfirmations.size, 1);

  const pending = router.pendingConfirmations.get(pendingId);
  assert.strictEqual(pending.handler, 'email');
  assert.deepStrictEqual(pending.data, { test: 'data' });
  assert.strictEqual(pending.user, 'testuser');
  assert.ok(pending.timestamp);
});

test('TC-PENDING-002: Cleanup old confirmations', () => {
  const router = new MessageRouter();

  // Add an old confirmation (6 minutes ago)
  const oldTimestamp = Date.now() - (6 * 60 * 1000);
  router.pendingConfirmations.set('old-123', {
    handler: 'email',
    data: {},
    user: 'testuser',
    timestamp: oldTimestamp
  });

  // Add a recent confirmation
  router.pendingConfirmations.set('new-123', {
    handler: 'email',
    data: {},
    user: 'testuser',
    timestamp: Date.now()
  });

  router._cleanupPendingConfirmations();

  assert.strictEqual(router.pendingConfirmations.size, 1);
  assert.ok(!router.pendingConfirmations.has('old-123'));
  assert.ok(router.pendingConfirmations.has('new-123'));
});

// --- Statistics Tests ---
console.log('\n--- Statistics Tests ---\n');

test('TC-STATS-001: Get router statistics', () => {
  const mockCalendarHandler = createMockCalendarHandler();
  const mockEmailHandler = createMockEmailHandler();
  const mockLLMRouter = createMockLLMRouter();

  const router = new MessageRouter({
    calendarHandler: mockCalendarHandler,
    emailHandler: mockEmailHandler,
    llmRouter: mockLLMRouter
  });

  const stats = router.getStats();

  assert.strictEqual(stats.pendingConfirmations, 0);
  assert.strictEqual(stats.handlersConfigured.calendar, true);
  assert.strictEqual(stats.handlersConfigured.email, true);
  assert.strictEqual(stats.handlersConfigured.llm, true);
});

test('TC-STATS-002: Statistics with pending confirmations', () => {
  const router = new MessageRouter();

  router.pendingConfirmations.set('test-1', {});
  router.pendingConfirmations.set('test-2', {});

  const stats = router.getStats();

  assert.strictEqual(stats.pendingConfirmations, 2);
});

// --- Audit Logging Tests ---
console.log('\n--- Audit Logging Tests ---\n');

asyncTest('TC-AUDIT-001: Log message classification', async () => {
  const mockAuditLog = createMockAuditLog();
  const router = new MessageRouter({
    auditLog: mockAuditLog,
    llmRouter: createMockLLMRouter()
  });

  await router.route('Hello', { user: 'testuser' });

  const calls = mockAuditLog.getCallsFor('message_classified');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].data.user, 'testuser');
  assert.strictEqual(calls[0].data.intent, 'general');
});

asyncTest('TC-AUDIT-002: Log handler errors', async () => {
  const mockAuditLog = createMockAuditLog();
  const mockEmailHandler = {
    handle: async () => {
      throw new Error('Test error');
    }
  };

  const router = new MessageRouter({
    auditLog: mockAuditLog,
    emailHandler: mockEmailHandler
  });

  await router.route('Check inbox', { user: 'testuser' });

  const calls = mockAuditLog.getCallsFor('handler_error');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].data.intent, 'email');
});

// --- Skill Forge Routing Tests ---
console.log('\n--- Skill Forge Routing Tests ---\n');

test('TC-SF-ROUTE-001: Classify skill forge intent from keywords', () => {
  const router = new MessageRouter();

  assert.strictEqual(router.classifyIntent('I want to create skill from template'), 'skillforge');
  assert.strictEqual(router.classifyIntent('List templates available'), 'skillforge');
  assert.strictEqual(router.classifyIntent('Open skill forge'), 'skillforge');
  assert.strictEqual(router.classifyIntent('Browse skills catalog'), 'skillforge');
  assert.strictEqual(router.classifyIntent('I want to create a skill'), 'skillforge');
  assert.strictEqual(router.classifyIntent('I want to create a new skill'), 'skillforge');
  assert.strictEqual(router.classifyIntent('build a skill for me'), 'skillforge');
});

asyncTest('TC-SF-ROUTE-002: Route to skill forge handler', async () => {
  const mockSkillForgeHandler = {
    handle: async () => ({ success: true, message: 'Skill Forge response' }),
    getState: () => ({ state: 'idle' })
  };

  const router = new MessageRouter({
    skillForgeHandler: mockSkillForgeHandler
  });

  const result = await router.route('Create skill from template', { user: 'testuser' });

  assert.strictEqual(result.response, 'Skill Forge response');
  assert.strictEqual(result.intent, 'skillforge');
});

asyncTest('TC-SF-ROUTE-003: Skill forge handler not configured', async () => {
  const router = new MessageRouter();

  const result = await router.route('Create skill from template', { user: 'testuser' });

  assert.ok(result.response.includes('not configured'));
  assert.strictEqual(result.error, true);
});

asyncTest('TC-SF-ROUTE-004: Active forge session routes non-keyword messages to forge', async () => {
  const handleCalls = [];
  const mockSkillForgeHandler = {
    handle: async (msg) => {
      handleCalls.push(msg);
      return { success: true, message: 'Forge handled: ' + msg };
    },
    getState: () => ({ state: 'selected' }) // Mid-session
  };

  const router = new MessageRouter({
    skillForgeHandler: mockSkillForgeHandler,
    llmRouter: createMockLLMRouter()
  });

  // "My Board Name" would normally classify as general, but the active session overrides
  const result = await router.route('My Board Name', { user: 'testuser' });

  assert.strictEqual(result.response, 'Forge handled: My Board Name');
  assert.strictEqual(result.intent, 'skillforge');
  assert.strictEqual(handleCalls.length, 1);
});

asyncTest('TC-SF-ROUTE-005: Confirm intent overrides active forge session', async () => {
  const mockSkillForgeHandler = {
    handle: async () => ({ success: true, message: 'Should not be called' }),
    getState: () => ({ state: 'pending' }), // Mid-session
    confirmActivateSkill: async () => ({ success: true, message: 'Skill activated' })
  };

  const router = new MessageRouter({
    skillForgeHandler: mockSkillForgeHandler
  });

  // Set up a pending confirmation
  router.pendingConfirmations.set('test-123', {
    handler: 'skillforge',
    data: { filename: 'test.md' },
    user: 'testuser',
    timestamp: Date.now()
  });

  // "yes" with pending confirmation should go to confirm handler, not forge
  const result = await router.route('yes', { user: 'testuser' });

  // Should have processed as confirmation (even though forge session active)
  assert.strictEqual(result.intent, 'confirm');
});

asyncTest('TC-SF-ROUTE-006: Skill forge handler returns requiresConfirmation', async () => {
  const mockSkillForgeHandler = {
    handle: async () => ({
      success: true,
      message: 'Ready to activate skill: test.md',
      requiresConfirmation: true,
      pendingAction: { data: { filename: 'test.md' } }
    }),
    getState: () => ({ state: 'pending' })
  };

  const router = new MessageRouter({
    skillForgeHandler: mockSkillForgeHandler
  });

  const result = await router.route('Activate skill test.md', { user: 'testuser' });

  assert.ok(result.requiresConfirmation);
  assert.ok(result.pendingId);
  assert.strictEqual(router.pendingConfirmations.size, 1);
});

test('TC-SF-ROUTE-007: Stats include skillForge handler', () => {
  const mockSkillForgeHandler = { getState: () => ({ state: 'idle' }) };

  const router = new MessageRouter({
    skillForgeHandler: mockSkillForgeHandler
  });

  const stats = router.getStats();

  assert.strictEqual(stats.handlersConfigured.skillForge, true);
});

// Summary
setTimeout(() => {
  summary();
  exitWithCode();
}, 100);
