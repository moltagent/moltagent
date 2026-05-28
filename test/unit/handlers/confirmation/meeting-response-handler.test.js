/**
 * MeetingResponseHandler Unit Tests
 *
 * Test suite for meeting invitation response handling.
 *
 * Run: node test/unit/handlers/confirmation/meeting-response-handler.test.js
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../../helpers/test-runner');
const { createMockAuditLog, createMockEmailHandler } = require('../../../helpers/mock-factories');

// Import module under test
const MeetingResponseHandler = require('../../../../src/lib/handlers/confirmation/meeting-response-handler');
const { pendingEmailReplies } = require('../../../../src/lib/pending-action-store');

// ============================================================
// Helper: Create mock calendar client
// ============================================================

function createMockCalendarClient(responses = {}) {
  return {
    respondToMeeting: async (event, status) => {
      return responses.respondToMeeting || { success: true, event: { uid: 'mock-uid' } };
    }
  };
}

// ============================================================
// Helper: Create mock Ollama provider (mirrors guardrail-enforcer pattern)
// ============================================================

function createMockOllama(response) {
  let callCount = 0;
  let lastCall = null;
  return {
    chat: async (params) => {
      callCount++;
      lastCall = params;
      if (typeof response === 'function') return response(params);
      if (response instanceof Error) throw response;
      return { content: response };
    },
    _getCallCount: () => callCount,
    _getLastCall: () => lastCall
  };
}

// ============================================================
// Test Suites
// ============================================================

async function runAllTests() {
  console.log('\n=== MeetingResponseHandler Tests ===\n');

// --- canHandle Tests ---
console.log('\n--- canHandle Tests ---\n');

test('TC-CANHANDLE-001: Return true for meeting request', () => {
  const handler = new MeetingResponseHandler();
  const result = handler.canHandle({ data: { is_meeting_request: true } });
  assert.strictEqual(result, true);
});

test('TC-CANHANDLE-002: Return false for non-meeting email', () => {
  const handler = new MeetingResponseHandler();
  const result = handler.canHandle({ data: { is_meeting_request: false } });
  assert.strictEqual(result, false);
});

// --- classifyAction Tests ---
console.log('\n--- classifyAction Tests ---\n');

// TC-CLASSIFY-001: 'sim' with mock returning 'APPROVE' → 'accept'
await asyncTest('TC-CLASSIFY-001: Classify multilingual approve → accept', async () => {
  const mockOllama = createMockOllama('APPROVE');
  const handler = new MeetingResponseHandler({ ollamaProvider: mockOllama });
  const result = await handler.classifyAction('sim', false, false);
  assert.strictEqual(result, 'accept');
  assert.strictEqual(mockOllama._getCallCount(), 1);
});

// TC-CLASSIFY-002: 'nein, danke' with mock returning 'DENY' → 'decline'
await asyncTest('TC-CLASSIFY-002: Classify multilingual deny → decline', async () => {
  const mockOllama = createMockOllama('DENY');
  const handler = new MeetingResponseHandler({ ollamaProvider: mockOllama });
  const result = await handler.classifyAction('nein, danke', true, true);
  assert.strictEqual(result, 'decline');
});

// TC-CLASSIFY-003: 'vorschlagen' with mock returning 'SUGGEST' → 'suggest'
await asyncTest('TC-CLASSIFY-003: Classify multilingual suggest → suggest', async () => {
  const mockOllama = createMockOllama('SUGGEST');
  const handler = new MeetingResponseHandler({ ollamaProvider: mockOllama });
  const result = await handler.classifyAction('vorschlagen', true, true);
  assert.strictEqual(result, 'suggest');
});

// TC-CLASSIFY-004: 'trotzdem annehmen' with mock returning 'ACCEPT_ANYWAY' → 'accept_anyway'
await asyncTest('TC-CLASSIFY-004: Classify accept_anyway intent → accept_anyway', async () => {
  const mockOllama = createMockOllama('ACCEPT_ANYWAY');
  const handler = new MeetingResponseHandler({ ollamaProvider: mockOllama });
  const result = await handler.classifyAction('trotzdem annehmen', true, false);
  assert.strictEqual(result, 'accept_anyway');
});

// TC-CLASSIFY-005: Structural prompt assertion — SUGGEST and ACCEPT_ANYWAY absent when flags false
await asyncTest('TC-CLASSIFY-005: Prompt excludes SUGGEST and ACCEPT_ANYWAY when flags are false', async () => {
  const mockOllama = createMockOllama('UNKNOWN');
  const handler = new MeetingResponseHandler({ ollamaProvider: mockOllama });
  await handler.classifyAction('whatever', false, false);
  const lastCall = mockOllama._getLastCall();
  assert.ok(lastCall, 'Ollama should have been called');
  const systemPrompt = lastCall.system || '';
  assert.ok(!systemPrompt.includes('SUGGEST'), 'SUGGEST label must not appear when hasConflict/hasAlternatives are false');
  assert.ok(!systemPrompt.includes('ACCEPT_ANYWAY'), 'ACCEPT_ANYWAY label must not appear when hasConflict is false');
});

// TC-CLASSIFY-006: 'what time is it' with mock returning 'UNKNOWN' → null
await asyncTest('TC-CLASSIFY-006: Unknown intent returns null', async () => {
  const mockOllama = createMockOllama('UNKNOWN');
  const handler = new MeetingResponseHandler({ ollamaProvider: mockOllama });
  const result = await handler.classifyAction('what time is it', true, true);
  assert.strictEqual(result, null);
});

// --- handleAccept Tests ---
console.log('\n--- handleAccept Tests ---\n');

asyncTest('TC-ACCEPT-001: Send acceptance email', async () => {
  // TODO: Implement test
  // Setup: pending meeting request
  // Call: handleAccept
  // Assert: emailHandler.confirmSendEmail called with acceptance body
});

asyncTest('TC-ACCEPT-002: Add meeting to calendar', async () => {
  // TODO: Implement test
  // Setup: pending meeting with calendar_context
  // Call: handleAccept with calendarClient
  // Assert: calendarClient.respondToMeeting called with ACCEPTED
});

asyncTest('TC-ACCEPT-003: Handle missing calendar client gracefully', async () => {
  // TODO: Implement test
  // Call: handleAccept without calendarClient
  // Assert: no error, email still sent
});

asyncTest('TC-ACCEPT-004: Use draft body if available', async () => {
  // TODO: Implement test
  // Setup: pending with draft: "Custom acceptance"
  // Assert: email body is "Custom acceptance"
});

// --- handleAcceptAnyway Tests ---
console.log('\n--- handleAcceptAnyway Tests ---\n');

asyncTest('TC-ACCEPT_ANYWAY-001: Include double-booking warning', async () => {
  // TODO: Implement test
  // Call: handleAcceptAnyway
  // Assert: response includes warning about double-booking
});

asyncTest('TC-ACCEPT_ANYWAY-002: Audit log includes conflict info', async () => {
  // TODO: Implement test
  // Assert: auditLog called with 'meeting_accepted_with_conflict'
});

// --- handleDecline Tests ---
console.log('\n--- handleDecline Tests ---\n');

asyncTest('TC-DECLINE-001: Send polite decline email', async () => {
  // TODO: Implement test
  // Assert: email body is polite decline message
});

asyncTest('TC-DECLINE-002: Log decline to calendar', async () => {
  // TODO: Implement test
  // Assert: calendarClient.respondToMeeting called with DECLINED
});

asyncTest('TC-DECLINE-003: Handle calendar error gracefully', async () => {
  // TODO: Implement test
  // Setup: calendarClient.respondToMeeting throws
  // Assert: no error propagated, decline email still sent
});

// --- handleSuggestAlternatives Tests ---
console.log('\n--- handleSuggestAlternatives Tests ---\n');

asyncTest('TC-SUGGEST-001: Format alternatives as bullet list', async () => {
  // TODO: Implement test
  // Setup: calendar_context with suggested_alternatives
  // Assert: email body includes formatted alternatives
});

asyncTest('TC-SUGGEST-002: Handle no alternatives gracefully', async () => {
  // TODO: Implement test
  // Setup: empty suggested_alternatives
  // Assert: appropriate error response
});

// --- Cleanup and Clear Tests ---
console.log('\n--- Cleanup Tests ---\n');

asyncTest('TC-CLEANUP-001: Clear pending after accept', async () => {
  // TODO: Implement test
});

asyncTest('TC-CLEANUP-002: Clear pending after decline', async () => {
  // TODO: Implement test
});

asyncTest('TC-CLEANUP-003: Clear pending after suggest', async () => {
  // TODO: Implement test
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
