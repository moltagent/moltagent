/**
 * Verdict enrichment: language (#273) and expectsMutation (#272)
 *
 * Architecture Brief
 * ------------------
 * The classification verdict states four facts about a message, each with
 * exactly one meaning: gate (which pipeline), domain (which tools), language
 * (what the user wrote in), expectsMutation (whether they want state changed).
 *
 * These tests pin the two new facts where they are resolved and where they are
 * consumed: one resolution point in MessageProcessor (verdict → persona → EN),
 * threaded to every dispatch site; and the PendingAction record, which stores
 * the language at birth because the "ja" that resolves it minutes later is one
 * word and classifies as OTHER.
 *
 * Run: node test/unit/server/verdict-enrichment.test.js
 *
 * Copyright (C) 2026 Moltagent
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

const MessageProcessor = require('../../../src/lib/server/message-processor');
const { GuardrailEnforcer } = require('../../../src/lib/agent/guardrail-enforcer');

// ============================================================
// Harness
// ============================================================

function createProcessor({ verdict, persona = 'EN' }) {
  const bridge = {
    chatProviders: new Map([['ollama-local', {}], ['anthropic', {}]]),
    modelResolver: { resolveTrust: () => 'cloud-ok' },
    router: { hasCloudPlayers: () => true },
    resetConversation() {},
    skipLocalForConversation() {},
    clearLocalSkip() {}
  };

  const seen = [];
  const agentLoop = {
    llmProvider: bridge,
    async process(_message, _token, options) {
      seen.push(options);
      return 'answer';
    }
  };

  const processor = new MessageProcessor({
    commandHandler: { handle: async () => null },
    sendTalkReply: async () => true,
    botUsername: 'moltagent',
    botNames: ['moltagent'],
    auditLog: async () => {},
    errorHandler: { handle: async () => ({ message: 'err' }) },
    agentLoop,
    microPipeline: { process: async () => { throw new Error('local pipeline down'); } },
    intentRouter: {
      getLanguage: () => persona,
      classify: async () => verdict
    }
  });

  return { processor, seen };
}

function talkPayload(content) {
  return {
    object: { content, id: 'msg-1' },
    actor: { id: 'users/alice', type: 'users' },
    target: { id: 'room-abc' }
  };
}

// ============================================================
// The single resolution point
// ============================================================

console.log('\n=== Verdict enrichment (#272 / #273) ===\n');
console.log('\n--- _resolveMessageLanguage ---\n');

test('TC-LANG-001: a detected language wins over the persona', () => {
  const { processor } = createProcessor({ verdict: {}, persona: 'EN' });
  assert.strictEqual(processor._resolveMessageLanguage({ language: 'DE' }), 'DE');
});

test('TC-LANG-002: OTHER falls back to the persona (today\'s behaviour)', () => {
  const { processor } = createProcessor({ verdict: {}, persona: 'PT' });
  assert.strictEqual(processor._resolveMessageLanguage({ language: 'OTHER' }), 'PT');
});

test('TC-LANG-003: an absent field falls back to the persona', () => {
  const { processor } = createProcessor({ verdict: {}, persona: 'DE' });
  assert.strictEqual(processor._resolveMessageLanguage({}), 'DE');
});

test('TC-LANG-004: no verdict and no persona resolves to EN', () => {
  const { processor } = createProcessor({ verdict: {}, persona: null });
  assert.strictEqual(processor._resolveMessageLanguage(null), 'EN');
});

// ============================================================
// Threading: the resolved facts reach the AgentLoop
// ============================================================

console.log('\n--- Threading to the dispatch sites ---\n');

asyncTest('TC-LANG-005: the user\'s language reaches AgentLoop, not the persona\'s', async () => {
  // The exact configuration that produced the mismatch in #268's live run:
  // persona EN, user writing German.
  const { processor, seen } = createProcessor({
    persona: 'EN',
    verdict: { gate: 'action', intent: 'deck', domain: 'deck', language: 'DE', expectsMutation: true }
  });

  await processor.process(talkPayload('Lösch die Karte Onboarding'));

  assert.strictEqual(seen.length, 1, 'the domain path escalated once');
  assert.strictEqual(seen[0].language, 'DE');
  assert.strictEqual(seen[0].expectsMutation, true);
});

asyncTest('TC-LANG-006: expectsMutation=false travels to AgentLoop intact', async () => {
  const { processor, seen } = createProcessor({
    persona: 'EN',
    verdict: { gate: 'action', intent: 'deck', domain: 'deck', language: 'DE', expectsMutation: false }
  });

  await processor.process(talkPayload('Was steht gerade auf meinem Board?'));

  assert.strictEqual(seen[0].gate, 'action', 'still the tool pipeline (#134)');
  assert.strictEqual(seen[0].expectsMutation, false, 'and no mutation expected (#272)');
});

asyncTest('TC-LANG-007: a verdict with neither field arms the guard and speaks the persona', async () => {
  const { processor, seen } = createProcessor({
    persona: 'PT',
    verdict: { gate: 'action', intent: 'deck', domain: 'deck' }
  });

  await processor.process(talkPayload('apaga o cartão'));

  assert.strictEqual(seen[0].language, 'PT', 'persona fallback');
  assert.strictEqual(seen[0].expectsMutation, true, 'absence must not disarm the guard');
});

// ============================================================
// The record stores its birth language
// ============================================================

console.log('\n--- PendingAction birth language ---\n');

function createEnforcer() {
  return new GuardrailEnforcer({
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
  });
}

// The record stores the offer's birth language as `resolvedLanguage` (#273);
// the resolution minutes later reads it rather than re-deriving from a one-word
// reply. Converted to the Phase 2 custody record.
const mintDelete = (enforcer, room, language) => enforcer._mintRecord({
  room, requestingUser: 'fu',
  invocations: [{ tool: 'deck_delete_card', args: { card: '42' }, label: 'Delete Deck card' }],
  language
});

test('TC-LANG-008: a custody record stores its birth language', () => {
  const enforcer = createEnforcer();
  mintDelete(enforcer, 'room-abc', 'DE');

  const record = enforcer.getPendingRecords('room-abc')[0];
  assert.strictEqual(record.resolvedLanguage, 'DE');
  assert.strictEqual(record.heldInvocations[0].tool, 'deck_delete_card');
});

test('TC-LANG-009: an offer born without a language stores null, never a guess', () => {
  const enforcer = createEnforcer();
  mintDelete(enforcer, 'room-abc', undefined);

  assert.strictEqual(enforcer.getPendingRecords('room-abc')[0].resolvedLanguage, null);
});

test('TC-LANG-010: the language survives release — the resolution reads it', () => {
  const enforcer = createEnforcer();
  const record = mintDelete(enforcer, 'room-abc', 'PT');

  assert.strictEqual(enforcer._releaseRecord(record), true);
  assert.strictEqual(record.resolvedLanguage, 'PT', 'the released record still carries its language');
  assert.strictEqual(enforcer.getPendingRecords('room-abc').length, 0, 'record is spent');
});

// Summary
setTimeout(() => {
  summary();
  exitWithCode();
}, 500);
