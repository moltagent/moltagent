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
 * ProactiveEvaluator Unit Tests
 *
 * Verifies the two-stage post-response intelligence pipeline:
 * initiative level gate, trivial-message heuristics, local-LLM triage,
 * agent-loop execution, NOTIFY extraction, and Talk notification dispatch.
 *
 * Run: node test/unit/agent/proactive-evaluator.test.js
 *
 * @module test/unit/agent/proactive-evaluator.test.js
 */

'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const { ProactiveEvaluator } = require('../../../src/lib/agent/proactive-evaluator');

// ============================================================
// Mock factories
// ============================================================

function createMockLLMRouter(routeResult = { result: 'no' }) {
  let lastCall = null;
  return {
    route: async (request) => { lastCall = request; return routeResult; },
    get lastCall() { return lastCall; }
  };
}

function createMockAgentLoop(processResult = 'NOTIFY: none') {
  let lastCall = null;
  return {
    process: async (prompt, roomToken, opts) => { lastCall = { prompt, roomToken, opts }; return processResult; },
    get lastCall() { return lastCall; }
  };
}

function createMockTalkQueue() {
  let calls = [];
  return {
    enqueue: async (roomToken, message) => { calls.push({ roomToken, message }); },
    get calls() { return calls; }
  };
}

// ============================================================
// TC-PE-01: evaluate() returns initiative_too_low when level < minLevel
// ============================================================

asyncTest('TC-PE-01: evaluate() returns {acted:false, reason:initiative_too_low} when level < minLevel', async () => {
  const evaluator = new ProactiveEvaluator({
    agentLoop: createMockAgentLoop(),
    llmRouter: createMockLLMRouter(),
    talkSendQueue: createMockTalkQueue(),
    config: { proactiveMinLevel: 3, initiativeLevel: 2 }
  });

  const result = await evaluator.evaluate({
    userMessage: 'I spoke with Sarah about the proposal due Friday',
    assistantResponse: 'Got it.',
    classification: 'deck',
    roomToken: 'room-test'
  });

  assert.strictEqual(result.acted, false);
  assert.strictEqual(result.reason, 'initiative_too_low');
});

// ============================================================
// TC-PE-02: _isTrivial() returns true for short messages (< 15 chars)
// ============================================================

test('TC-PE-02: _isTrivial() returns true for short messages (< 15 chars)', () => {
  const evaluator = new ProactiveEvaluator({ config: {} });

  const result = evaluator._isTrivial({ userMessage: 'yes', classification: 'deck' });

  assert.strictEqual(result, true);
});

// ============================================================
// TC-PE-03: _isTrivial() returns true for greeting classification
// ============================================================

test('TC-PE-03: _isTrivial() returns true for greetings', () => {
  const evaluator = new ProactiveEvaluator({ config: {} });

  const result = evaluator._isTrivial({
    userMessage: 'Hello how are you today?',
    classification: 'greeting'
  });

  assert.strictEqual(result, true);
});

// ============================================================
// TC-PE-04: _isTrivial() returns true for confirmations
// ============================================================

test('TC-PE-04: _isTrivial() returns true for confirmations', () => {
  const evaluator = new ProactiveEvaluator({ config: {} });

  const result = evaluator._isTrivial({
    userMessage: 'That sounds good to me',
    classification: 'confirmation'
  });

  assert.strictEqual(result, true);
});

// ============================================================
// TC-PE-05: _isTrivial() returns false for substantive messages
// ============================================================

test('TC-PE-05: _isTrivial() returns false for substantive messages', () => {
  const evaluator = new ProactiveEvaluator({ config: {} });

  const result = evaluator._isTrivial({
    userMessage: 'I just spoke with Sarah from ManeraMedia about the proposal',
    classification: 'deck'
  });

  assert.strictEqual(result, false);
});

// ============================================================
// TC-PE-06: _triage() calls llmRouter.route with job:'quick' and prompt containing user message
// ============================================================

asyncTest('TC-PE-06: _triage() calls llmRouter.route with job:quick and prompt containing user message', async () => {
  const mockRouter = createMockLLMRouter({ result: 'yes' });
  const evaluator = new ProactiveEvaluator({ llmRouter: mockRouter, config: {} });

  const userMessage = 'Sarah from ManeraMedia wants the proposal by Friday';
  await evaluator._triage({ userMessage, assistantResponse: 'OK' });

  assert.ok(mockRouter.lastCall, 'route should have been called');
  assert.strictEqual(mockRouter.lastCall.job, 'quick');
  assert.ok(
    mockRouter.lastCall.content.includes(userMessage),
    'prompt content should include the user message'
  );
  assert.deepStrictEqual(mockRouter.lastCall.context, { source: 'proactive_triage' });
});

// ============================================================
// TC-PE-07: _triage() returns true when LLM says "yes"
// ============================================================

asyncTest('TC-PE-07: _triage() returns true when LLM says "yes"', async () => {
  const mockRouter = createMockLLMRouter({ result: 'yes' });
  const evaluator = new ProactiveEvaluator({ llmRouter: mockRouter, config: {} });

  const result = await evaluator._triage({
    userMessage: 'We need to track the ManeraMedia deal',
    assistantResponse: 'Understood.'
  });

  assert.strictEqual(result, true);
});

// ============================================================
// TC-PE-08: _triage() returns false when LLM says "no"
// ============================================================

asyncTest('TC-PE-08: _triage() returns false when LLM says "no"', async () => {
  const mockRouter = createMockLLMRouter({ result: 'no' });
  const evaluator = new ProactiveEvaluator({ llmRouter: mockRouter, config: {} });

  const result = await evaluator._triage({
    userMessage: 'What meetings do I have today?',
    assistantResponse: 'You have two meetings.'
  });

  assert.strictEqual(result, false);
});

// ============================================================
// TC-PE-09: _triage() returns false on LLM error (fail safe)
// ============================================================

asyncTest('TC-PE-09: _triage() returns false on LLM error (fail safe)', async () => {
  const throwingRouter = {
    route: async () => { throw new Error('LLM connection failed'); }
  };
  const evaluator = new ProactiveEvaluator({ llmRouter: throwingRouter, config: {} });

  const result = await evaluator._triage({
    userMessage: 'Tell me about the project timeline',
    assistantResponse: 'Sure.'
  });

  assert.strictEqual(result, false);
});

// ============================================================
// TC-PE-10: _triage() returns false when llmRouter is null
// ============================================================

asyncTest('TC-PE-10: _triage() returns false when llmRouter is null', async () => {
  const evaluator = new ProactiveEvaluator({ llmRouter: null, config: {} });

  const result = await evaluator._triage({
    userMessage: 'Something important happened with the client',
    assistantResponse: 'Noted.'
  });

  assert.strictEqual(result, false);
});

// ============================================================
// TC-PE-11: _executeProactive() calls agentLoop.process with proactive prompt
// ============================================================

asyncTest('TC-PE-11: _executeProactive() calls agentLoop.process with proactive prompt', async () => {
  const mockLoop = createMockAgentLoop('NOTIFY: Created wiki page');
  const evaluator = new ProactiveEvaluator({ agentLoop: mockLoop, config: {} });

  const context = {
    userMessage: 'Sarah from ManeraMedia is our new contact',
    assistantResponse: 'Noted.',
    classification: 'deck',
    roomToken: 'room-abc'
  };

  const result = await evaluator._executeProactive(context);

  assert.ok(mockLoop.lastCall, 'process should have been called');
  assert.ok(typeof mockLoop.lastCall.prompt === 'string', 'first arg should be a string prompt');
  assert.strictEqual(mockLoop.lastCall.roomToken, 'room-abc');
  assert.deepStrictEqual(mockLoop.lastCall.opts, {
    source: 'proactive_evaluator',
    maxIterations: 4
  });
  assert.ok(result.notification.includes('Created wiki page'));
});

// ============================================================
// TC-PE-12: _executeProactive() includes action ledger in context summary
// ============================================================

asyncTest('TC-PE-12: _executeProactive() includes action ledger entries in prompt', async () => {
  const mockLoop = createMockAgentLoop('NOTIFY: none');
  const evaluator = new ProactiveEvaluator({ agentLoop: mockLoop, config: {} });

  const context = {
    userMessage: 'Add a task for the ManeraMedia proposal',
    assistantResponse: 'Task added.',
    classification: 'deck',
    roomToken: 'room-xyz',
    session: {
      actionLedger: [
        { type: 'calendar_create', refs: { title: 'Meeting' } }
      ]
    }
  };

  await evaluator._executeProactive(context);

  assert.ok(mockLoop.lastCall, 'process should have been called');
  assert.ok(
    mockLoop.lastCall.prompt.includes('calendar_create'),
    'prompt should contain the action ledger entry type'
  );
});

// ============================================================
// TC-PE-13: _executeProactive() returns null when agentLoop is null
// ============================================================

asyncTest('TC-PE-13: _executeProactive() returns null when agentLoop is null', async () => {
  const evaluator = new ProactiveEvaluator({ agentLoop: null, config: {} });

  const result = await evaluator._executeProactive({
    userMessage: 'Tell me about Sarah',
    assistantResponse: 'Sure.',
    roomToken: 'room-1'
  });

  assert.strictEqual(result, null);
});

// ============================================================
// TC-PE-14: _extractNotification() parses "NOTIFY: Created page for Sarah"
// ============================================================

test('TC-PE-14: _extractNotification() parses NOTIFY line correctly', () => {
  const evaluator = new ProactiveEvaluator({ config: {} });

  const result = evaluator._extractNotification('NOTIFY: Created page for Sarah');

  assert.strictEqual(result, 'Created page for Sarah');
});

// ============================================================
// TC-PE-15: _extractNotification() returns "none" for "NOTIFY: none"
// ============================================================

test('TC-PE-15: _extractNotification() returns "none" for "NOTIFY: none"', () => {
  const evaluator = new ProactiveEvaluator({ config: {} });

  const result = evaluator._extractNotification('NOTIFY: none');

  assert.strictEqual(result, 'none');
});

// ============================================================
// TC-PE-16: _extractNotification() returns "none" for null/empty result
// ============================================================

test('TC-PE-16: _extractNotification() returns "none" for null/empty result', () => {
  const evaluator = new ProactiveEvaluator({ config: {} });

  assert.strictEqual(evaluator._extractNotification(null), 'none');
  assert.strictEqual(evaluator._extractNotification(''), 'none');
});

// ============================================================
// TC-PE-17: evaluate() sends notification to Talk when action taken
// ============================================================

asyncTest('TC-PE-17: evaluate() sends notification to Talk when action taken', async () => {
  const mockRouter = createMockLLMRouter({ result: 'yes' });
  const mockLoop = createMockAgentLoop('NOTIFY: Created page for Sarah from ManeraMedia');
  const mockTalk = createMockTalkQueue();

  const evaluator = new ProactiveEvaluator({
    agentLoop: mockLoop,
    llmRouter: mockRouter,
    talkSendQueue: mockTalk,
    config: { initiativeLevel: 3, proactiveMinLevel: 3 }
  });

  const context = {
    userMessage: 'Sarah from ManeraMedia wants proposal by Friday',
    assistantResponse: 'OK created event',
    classification: 'calendar',
    roomToken: 'room1'
  };

  const result = await evaluator.evaluate(context);

  assert.strictEqual(result.acted, true);
  assert.strictEqual(mockTalk.calls.length, 1, 'enqueue should have been called once');
  assert.strictEqual(mockTalk.calls[0].roomToken, 'room1');
  assert.ok(
    mockTalk.calls[0].message.includes('Created page'),
    'Talk message should contain the notification text'
  );
});

// ============================================================
// TC-PE-18: evaluate() does NOT send notification when result is "NOTIFY: none"
// ============================================================

asyncTest('TC-PE-18: evaluate() does NOT send notification when result is "NOTIFY: none"', async () => {
  const mockRouter = createMockLLMRouter({ result: 'yes' });
  const mockLoop = createMockAgentLoop('NOTIFY: none');
  const mockTalk = createMockTalkQueue();

  const evaluator = new ProactiveEvaluator({
    agentLoop: mockLoop,
    llmRouter: mockRouter,
    talkSendQueue: mockTalk,
    config: { initiativeLevel: 3, proactiveMinLevel: 3 }
  });

  const context = {
    userMessage: 'What time is my next meeting with the team?',
    assistantResponse: 'Your next meeting is at 3pm.',
    classification: 'calendar',
    roomToken: 'room2'
  };

  await evaluator.evaluate(context);

  assert.strictEqual(mockTalk.calls.length, 0, 'enqueue should NOT have been called for NOTIFY: none');
});

// ============================================================
// TC-PE-19: evaluate() catches all errors and never throws
// ============================================================

asyncTest('TC-PE-19: evaluate() catches all errors (never throws)', async () => {
  // Use a throwing talk queue so the error escapes _executeProactive's internal
  // try/catch and is caught by evaluate()'s outer safety net instead.
  const mockRouter = createMockLLMRouter({ result: 'yes' });
  const mockLoop = createMockAgentLoop('NOTIFY: Created page for Sarah');
  const throwingTalk = {
    enqueue: async () => { throw new Error('Talk queue connection failed'); }
  };

  const evaluator = new ProactiveEvaluator({
    agentLoop: mockLoop,
    llmRouter: mockRouter,
    talkSendQueue: throwingTalk,
    config: { initiativeLevel: 3, proactiveMinLevel: 3 }
  });

  const context = {
    userMessage: 'Sarah from ManeraMedia wants the contract reviewed',
    assistantResponse: 'I will handle that.',
    classification: 'deck',
    roomToken: 'room3'
  };

  let result;
  let threw = false;
  try {
    result = await evaluator.evaluate(context);
  } catch (err) {
    threw = true;
  }

  assert.strictEqual(threw, false, 'evaluate() must not propagate exceptions');
  assert.strictEqual(result.acted, false);
  assert.strictEqual(result.reason, 'error');
});

// ============================================================
// TC-PE-20: evaluate() skips trivial messages before triage
// ============================================================

asyncTest('TC-PE-20: evaluate() skips trivial messages before triage (never calls llmRouter)', async () => {
  const mockRouter = createMockLLMRouter({ result: 'yes' });
  const mockLoop = createMockAgentLoop('NOTIFY: none');
  const mockTalk = createMockTalkQueue();

  const evaluator = new ProactiveEvaluator({
    agentLoop: mockLoop,
    llmRouter: mockRouter,
    talkSendQueue: mockTalk,
    config: { initiativeLevel: 3, proactiveMinLevel: 3 }
  });

  const result = await evaluator.evaluate({
    userMessage: 'ok',
    assistantResponse: 'Confirmed.',
    classification: 'confirmation',
    roomToken: 'room4'
  });

  assert.strictEqual(result.acted, false);
  assert.strictEqual(result.reason, 'trivial');
  assert.strictEqual(mockRouter.lastCall, null, 'llmRouter.route must NOT be called for trivial messages');
});

// ============================================================

setTimeout(() => { summary(); exitWithCode(); }, 500);
