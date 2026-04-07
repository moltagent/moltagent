/*
 * Moltagent - Sovereign AI Security Layer
 * Copyright (C) 2026 Moltagent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * ClarificationManager Unit Tests
 *
 * Verifies the pending-clarification bypass logic: check() routing decisions,
 * cancel-phrase detection, handler lookup guards, and resolve() lifecycle
 * including chained questions and exception recovery.
 *
 * Run: node test/unit/agent/clarification-manager.test.js
 *
 * @module test/unit/agent/clarification-manager.test.js
 */

'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const ClarificationManager = require('../../../src/lib/agent/clarification-manager');

// ============================================================
// Helpers
// ============================================================

const silentLogger = { log() {}, info() {}, warn() {}, error() {} };

function createMockSessionManager(pending) {
  return {
    getPendingClarification: () => pending || null,
    clearPendingClarification: function() { this._cleared = true; },
    setPendingClarification: function(session, clar) { this._lastSet = clar; },
    _cleared: false,
    _lastSet: null
  };
}

// A minimal session object — ClarificationManager passes it through to
// SessionManager methods but does not inspect its internals.
const mockSession = { id: 'sess-test-001' };

// ============================================================
// Test 1: check() returns {bypass: false} when no pending
// ============================================================

test('check() returns {bypass: false} when no pending clarification', () => {
  const sm = createMockSessionManager(null);
  const mgr = new ClarificationManager({ sessionManager: sm, executors: {}, logger: silentLogger });

  const result = mgr.check(mockSession, 'hello');

  assert.strictEqual(result.bypass, false);
  assert.strictEqual(result.handler, undefined);
  assert.strictEqual(result.cancelled, undefined);
});

// ============================================================
// Test 2: check() returns {bypass: true} with handler when pending exists
// ============================================================

test('check() returns {bypass: true} with handler when pending exists', () => {
  const pending = { executor: 'calendar', prompt: 'What is the event title?' };
  const mockHandler = { resumeWithClarification: async () => ({ response: 'Event created.' }) };
  const sm = createMockSessionManager(pending);
  const mgr = new ClarificationManager({
    sessionManager: sm,
    executors: { calendar: mockHandler },
    logger: silentLogger
  });

  const result = mgr.check(mockSession, 'Team standup');

  assert.strictEqual(result.bypass, true);
  assert.strictEqual(result.handler, mockHandler);
  assert.ok(result.clarification, 'clarification object should be present');
  assert.strictEqual(result.clarification.userResponse, 'Team standup');
  assert.strictEqual(result.clarification.executor, 'calendar');
  assert.strictEqual(result.cancelled, undefined);
});

// ============================================================
// Test 3: check() returns {bypass: true, cancelled: true} for cancel phrases
// ============================================================

test('check() returns {bypass: true, cancelled: true} for "cancel"', () => {
  const pending = { executor: 'calendar', prompt: 'What time?' };
  const sm = createMockSessionManager(pending);
  const mgr = new ClarificationManager({ sessionManager: sm, executors: {}, logger: silentLogger });

  const result = mgr.check(mockSession, 'cancel');

  assert.strictEqual(result.bypass, true);
  assert.strictEqual(result.cancelled, true);
  assert.ok(typeof result.response === 'string' && result.response.length > 0);
  assert.strictEqual(sm._cleared, true, 'clearPendingClarification should be called on cancel');
});

test('check() returns {bypass: true, cancelled: true} for "nevermind"', () => {
  const pending = { executor: 'email', prompt: 'Who to send to?' };
  const sm = createMockSessionManager(pending);
  const mgr = new ClarificationManager({ sessionManager: sm, executors: {}, logger: silentLogger });

  const result = mgr.check(mockSession, 'nevermind');

  assert.strictEqual(result.bypass, true);
  assert.strictEqual(result.cancelled, true);
});

test('check() returns {bypass: true, cancelled: true} for "nvm"', () => {
  const pending = { executor: 'email', prompt: 'Subject line?' };
  const sm = createMockSessionManager(pending);
  const mgr = new ClarificationManager({ sessionManager: sm, executors: {}, logger: silentLogger });

  const result = mgr.check(mockSession, 'nvm');

  assert.strictEqual(result.bypass, true);
  assert.strictEqual(result.cancelled, true);
});

test('check() returns {bypass: true, cancelled: true} for "forget it"', () => {
  const pending = { executor: 'calendar', prompt: 'Duration?' };
  const sm = createMockSessionManager(pending);
  const mgr = new ClarificationManager({ sessionManager: sm, executors: {}, logger: silentLogger });

  const result = mgr.check(mockSession, 'forget it');

  assert.strictEqual(result.bypass, true);
  assert.strictEqual(result.cancelled, true);
});

// ============================================================
// Test 4: check() returns {bypass: false} when handler missing
// ============================================================

test('check() returns {bypass: false} when executor name not in executors map', () => {
  const pending = { executor: 'unknown-executor', prompt: 'Some question?' };
  const sm = createMockSessionManager(pending);
  const mgr = new ClarificationManager({
    sessionManager: sm,
    executors: { calendar: {} },
    logger: silentLogger
  });

  const result = mgr.check(mockSession, 'some reply');

  assert.strictEqual(result.bypass, false);
  assert.strictEqual(result.handler, undefined);
  // Should clear the dangling pending to avoid infinite bypass loop
  assert.strictEqual(sm._cleared, true, 'clearPendingClarification should be called for missing handler');
});

// ============================================================
// Test 5: check() returns {bypass: false} when handler lacks resumeWithClarification
// ============================================================

test('check() returns {bypass: false} when executor exists but lacks resumeWithClarification', () => {
  const pending = { executor: 'calendar', prompt: 'Date?' };
  // Handler exists but has no resumeWithClarification method
  const incompleteHandler = { someOtherMethod: () => {} };
  const sm = createMockSessionManager(pending);
  const mgr = new ClarificationManager({
    sessionManager: sm,
    executors: { calendar: incompleteHandler },
    logger: silentLogger
  });

  const result = mgr.check(mockSession, 'tomorrow');

  assert.strictEqual(result.bypass, false);
  assert.strictEqual(sm._cleared, true, 'clearPendingClarification should be called when method is missing');
});

// ============================================================
// Test 6: check() respects 5-minute expiry (via SessionManager returning null)
// ============================================================

test('check() returns {bypass: false} when SessionManager returns null for expired pending', () => {
  // SessionManager is responsible for expiry; it returns null when expired.
  // ClarificationManager must honour that null and not bypass.
  const sm = createMockSessionManager(null); // simulates expired entry already cleaned up
  const mgr = new ClarificationManager({
    sessionManager: sm,
    executors: { calendar: { resumeWithClarification: async () => ({}) } },
    logger: silentLogger
  });

  const result = mgr.check(mockSession, 'my answer');

  assert.strictEqual(result.bypass, false);
  assert.strictEqual(sm._cleared, false, 'clearPendingClarification should not be called when nothing was pending');
});

// ============================================================
// Test 7: resolve() calls handler.resumeWithClarification() with correct args
// ============================================================

asyncTest('resolve() calls handler.resumeWithClarification() with correct args', async () => {
  let capturedClarification = null;
  let capturedContext = null;

  const mockHandler = {
    resumeWithClarification: async (clar, ctx) => {
      capturedClarification = clar;
      capturedContext = ctx;
      return { response: 'Event scheduled.' };
    }
  };

  const sm = createMockSessionManager(null);
  const mgr = new ClarificationManager({ sessionManager: sm, executors: {}, logger: silentLogger });

  const clarification = { executor: 'calendar', prompt: 'What date?', userResponse: 'Friday' };
  const context = { session: mockSession, roomToken: 'room-42', userId: 'alice' };

  const result = await mgr.resolve(mockHandler, clarification, context);

  assert.strictEqual(result.response, 'Event scheduled.');
  assert.deepStrictEqual(capturedClarification, clarification);
  assert.strictEqual(capturedContext.userName, 'alice');
  assert.strictEqual(capturedContext.roomToken, 'room-42');
});

// ============================================================
// Test 8: resolve() clears pending from session after handler returns
// ============================================================

asyncTest('resolve() clears pending from session after handler returns', async () => {
  const mockHandler = {
    resumeWithClarification: async () => ({ response: 'Done.' })
  };

  const sm = createMockSessionManager(null);
  const mgr = new ClarificationManager({ sessionManager: sm, executors: {}, logger: silentLogger });

  const clarification = { executor: 'calendar', userResponse: 'Monday' };
  const context = { session: mockSession, roomToken: 'room-1', userId: 'bob' };

  await mgr.resolve(mockHandler, clarification, context);

  assert.strictEqual(sm._cleared, true, 'clearPendingClarification must be called after resolve');
});

// ============================================================
// Test 9: resolve() sets new pending if handler returns one (chained question)
// ============================================================

asyncTest('resolve() sets new pending if handler returns a pendingClarification (chained)', async () => {
  const chainedPending = { executor: 'calendar', prompt: 'What time should the event start?' };

  const mockHandler = {
    resumeWithClarification: async () => ({
      response: 'Got the title. What time should the event start?',
      pendingClarification: chainedPending
    })
  };

  const sm = createMockSessionManager(null);
  const mgr = new ClarificationManager({ sessionManager: sm, executors: {}, logger: silentLogger });

  const clarification = { executor: 'calendar', prompt: 'Event title?', userResponse: 'Team Standup' };
  const context = { session: mockSession, roomToken: 'room-2', userId: 'carol' };

  const result = await mgr.resolve(mockHandler, clarification, context);

  assert.strictEqual(sm._cleared, true, 'old pending must be cleared');
  assert.deepStrictEqual(sm._lastSet, chainedPending, 'new pending should be set via setPendingClarification');
  assert.ok(result.response.includes('time'), 'response should include the follow-up prompt');
});

// ============================================================
// Test 10: resolve() returns error message and clears pending on handler exception
// ============================================================

asyncTest('resolve() returns error message and clears pending on handler exception', async () => {
  const mockHandler = {
    resumeWithClarification: async () => {
      throw new Error('Unexpected calendar API failure');
    }
  };

  const sm = createMockSessionManager(null);
  const mgr = new ClarificationManager({ sessionManager: sm, executors: {}, logger: silentLogger });

  const clarification = { executor: 'calendar', userResponse: 'Wednesday' };
  const context = { session: mockSession, roomToken: 'room-3', userId: 'dave' };

  const result = await mgr.resolve(mockHandler, clarification, context);

  assert.strictEqual(sm._cleared, true, 'pending must be cleared even on exception');
  assert.ok(typeof result.response === 'string' && result.response.length > 0,
    'error response string should be returned');
  // Must not re-throw — caller (MessageProcessor) expects a safe return value
  assert.ok(result.response.toLowerCase().includes('wrong') || result.response.toLowerCase().includes('start over'),
    'error response should guide user to retry');
});

// ============================================================

setTimeout(() => { summary(); exitWithCode(); }, 500);
