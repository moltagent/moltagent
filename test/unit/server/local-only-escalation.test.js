/**
 * Local-only escalation tests (#269)
 *
 * Architecture Brief
 * ------------------
 * The escalate-to-cloud pattern (skipLocalForConversation + retry through the
 * AgentLoop) is only meaningful where cloud is permitted AND present. Under
 * trust=local-only it demotes the only providers that exist, the chokepoint
 * still forbids cloud, and the retry dies in "all providers exhausted" — a
 * generic error that replaces a classifiable root cause.
 *
 * These tests pin the first-fork predicate (_cloudEscalationAvailable) and the
 * field shape it fixes: a local tools timeout must surface as TIMEOUT, after
 * exactly one provider cycle.
 *
 * Run: node test/unit/server/local-only-escalation.test.js
 *
 * Copyright (C) 2026 Moltagent
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

const MessageProcessor = require('../../../src/lib/server/message-processor');
const { ErrorHandler, ErrorCategory } = require('../../../src/lib/errors/error-handler');

const TIMEOUT_MESSAGE = new ErrorHandler().getUserMessage(ErrorCategory.TIMEOUT);

// ============================================================
// Harness
// ============================================================

/**
 * A RouterChatBridge stand-in: the trust authority (modelResolver) and the
 * cloud-presence authority (router) are the two the predicate reads.
 */
function createBridge({ trust, hasCloud }) {
  const bridge = {
    skipCalls: 0,
    clearCalls: 0,
    chatProviders: new Map([['ollama-local', {}], ['anthropic', {}]]),
    modelResolver: { resolveTrust: () => trust },
    router: { hasCloudPlayers: () => hasCloud },
    resetConversation() {},
    skipLocalForConversation() { bridge.skipCalls++; },
    clearLocalSkip() { bridge.clearCalls++; }
  };
  return bridge;
}

function createProcessor({ trust, hasCloud, domainError }) {
  const bridge = createBridge({ trust, hasCloud });
  const replies = [];

  const agentLoop = {
    llmProvider: bridge,
    processCalls: 0,
    async process() {
      agentLoop.processCalls++;
      return 'cloud answer';
    }
  };

  const microPipeline = {
    async process() { throw domainError; }
  };

  const processor = new MessageProcessor({
    commandHandler: { handle: async () => null },
    sendTalkReply: async (token, message) => { replies.push(message); return true; },
    botUsername: 'moltagent',
    botNames: ['moltagent'],
    auditLog: async () => {},
    errorHandler: new ErrorHandler(),
    agentLoop,
    microPipeline
  });

  // The classifier is not under test: pin the domain-tools path.
  processor._smartMixClassify = async () => ({
    useLocalPipeline: true,
    useDomainTools: true,
    intent: 'calendar',
    compound: false,
    gate: 'action',
    domain: 'calendar'
  });

  return { processor, bridge, agentLoop, replies };
}

function talkPayload(content) {
  return {
    object: { content, id: 'msg-1' },
    actor: { id: 'users/alice', type: 'users' },
    target: { id: 'room-abc' }
  };
}

// ============================================================
// Predicate
// ============================================================

console.log('\n=== Local-only escalation (#269) ===\n');
console.log('\n--- _cloudEscalationAvailable ---\n');

test('TC-ESC-001: local-only → escalation unavailable', () => {
  const { processor } = createProcessor({ trust: 'local-only', hasCloud: true, domainError: new Error('x') });
  assert.strictEqual(processor._cloudEscalationAvailable(), false);
});

test('TC-ESC-002: cloud-ok with cloud players → escalation available', () => {
  const { processor } = createProcessor({ trust: 'cloud-ok', hasCloud: true, domainError: new Error('x') });
  assert.strictEqual(processor._cloudEscalationAvailable(), true);
});

test('TC-ESC-003: cloud-ok without cloud players → escalation unavailable', () => {
  const { processor } = createProcessor({ trust: 'cloud-ok', hasCloud: false, domainError: new Error('x') });
  assert.strictEqual(processor._cloudEscalationAvailable(), false);
});

test('TC-ESC-004: resolver absent → behaves as today (available)', () => {
  const { processor, bridge } = createProcessor({ trust: 'cloud-ok', hasCloud: true, domainError: new Error('x') });
  delete bridge.modelResolver;
  delete bridge.router;
  assert.strictEqual(processor._cloudEscalationAvailable(), true);
});

// ============================================================
// Field shape: a local tools timeout under local-only
// ============================================================

console.log('\n--- Domain-path failure under each trust ---\n');

asyncTest('TC-ESC-005: local-only → no skip, no retry, TIMEOUT surfaced to the user', async () => {
  const timeout = new Error('Ollama request timed out after 60000ms');
  const { processor, bridge, agentLoop, replies } = createProcessor({
    trust: 'local-only', hasCloud: false, domainError: timeout
  });

  const result = await processor.process(talkPayload('Schedule a meeting tomorrow at 19:00 for 90 minutes'));

  assert.strictEqual(bridge.skipCalls, 0, 'local providers must not be demoted');
  assert.strictEqual(agentLoop.processCalls, 0, 'no doomed cloud retry');
  assert.strictEqual(result.error, TIMEOUT_MESSAGE);
  assert.ok(replies.some(r => r === TIMEOUT_MESSAGE));
});

asyncTest('TC-ESC-006: cloud-ok → skip + retry, unchanged (regression pin)', async () => {
  const timeout = new Error('Ollama request timed out after 60000ms');
  const { processor, bridge, agentLoop } = createProcessor({
    trust: 'cloud-ok', hasCloud: true, domainError: timeout
  });

  const result = await processor.process(talkPayload('Schedule a meeting tomorrow at 19:00 for 90 minutes'));

  assert.strictEqual(bridge.skipCalls, 1);
  assert.strictEqual(agentLoop.processCalls, 1);
  assert.strictEqual(result.response, 'cloud answer');
});

asyncTest('TC-ESC-007: local-only → an exhaustion error still classifies by its cause', async () => {
  const exhausted = new Error('All providers exhausted for job tools. Tried: ollama-local');
  exhausted.cause = new Error('Ollama request timed out after 60000ms');
  const { processor, agentLoop } = createProcessor({
    trust: 'local-only', hasCloud: false, domainError: exhausted
  });

  const result = await processor.process(talkPayload('Termin morgen um 19:00 Uhr für 90 Minuten'));

  assert.strictEqual(agentLoop.processCalls, 0);
  assert.strictEqual(result.error, TIMEOUT_MESSAGE);
});

// Summary
setTimeout(() => {
  summary();
  exitWithCode();
}, 500);
