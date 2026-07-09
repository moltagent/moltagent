/**
 * SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2026 Moltagent contributors
 *
 * PendingAction resolution — MessageProcessor._resolvePendingAction (#104)
 *
 * Architecture Brief:
 * - Problem: an approval whose poll timed out used to survive only as prose in
 *   the conversation, and a later "ja" was re-derived from that prose.
 * - Pattern: the enforcer holds the offer as a record; the confirmation handler
 *   reads it once, and execution is plumbing — the model never re-decides what
 *   to run, it only narrates the outcome.
 * - Key Dependencies: GuardrailEnforcer (record custody), a stub AgentLoop.
 * - Data Flow: reply → classifier verdict → execute | drop | pass through.
 *
 * Run: node test/unit/server/pending-action-resolution.test.js
 */

'use strict';

const assert = require('assert');
const { asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

const MessageProcessor = require('../../../src/lib/server/message-processor');
const { GuardrailEnforcer } = require('../../../src/lib/agent/guardrail-enforcer');

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/** Enforcer with one live offer for room1, unless `seed` is false. */
function makeEnforcer(verdict, seed = true) {
  const enforcer = new GuardrailEnforcer({
    ollamaProvider: { chat: async () => ({ content: verdict }) },
    logger: silentLogger
  });
  if (seed) {
    enforcer._rememberPendingAction('room1', 'deck_delete_card', { card: 'Q3 Planning' }, 'Delete Deck card');
  }
  return enforcer;
}

/** Stub AgentLoop recording what the resolution asked it to do. */
function makeAgentLoop(enforcer, toolResult = { success: true, result: 'Deleted "Q3 Planning".' }) {
  const calls = { executed: [], narrated: [] };
  return {
    calls,
    guardrailEnforcer: enforcer,
    executeApprovedTool: async (toolCall, roomToken) => {
      calls.executed.push({ toolCall, roomToken });
      return toolResult;
    },
    narrateOutcome: async (params) => {
      calls.narrated.push(params);
      return `narrated: ${params.outcome}`;
    }
  };
}

/** MessageProcessor without its constructor — only agentLoop is in play here. */
function makeProcessor(agentLoop) {
  const mp = Object.create(MessageProcessor.prototype);
  mp.agentLoop = agentLoop;
  return mp;
}

async function main() {
  await asyncTest('no enforcer → the message is not ours', async () => {
    const mp = makeProcessor({});
    assert.strictEqual(await mp._resolvePendingAction({ token: 'room1' }, 'ja'), null);
  });

  await asyncTest('no roomToken → the message is not ours', async () => {
    const enforcer = makeEnforcer('APPROVE');
    const mp = makeProcessor(makeAgentLoop(enforcer));
    assert.strictEqual(await mp._resolvePendingAction({ token: null }, 'ja'), null);
  });

  await asyncTest('no record → the reply routes on, unclassified', async () => {
    let classified = 0;
    const enforcer = makeEnforcer('APPROVE', false);
    enforcer.ollamaProvider = { chat: async () => { classified++; return { content: 'APPROVE' }; } };
    const mp = makeProcessor(makeAgentLoop(enforcer));

    assert.strictEqual(await mp._resolvePendingAction({ token: 'room1' }, 'ja'), null);
    assert.strictEqual(classified, 0, 'no record means nothing to classify');
  });

  await asyncTest('approve → the stored (tool, args) execute, once', async () => {
    const enforcer = makeEnforcer('APPROVE');
    const agentLoop = makeAgentLoop(enforcer);
    const mp = makeProcessor(agentLoop);

    const outcome = await mp._resolvePendingAction({ token: 'room1' }, 'ja');

    assert.ok(outcome, 'the record answers the reply');
    assert.strictEqual(outcome.result.intent, 'pending_action_executed');
    assert.strictEqual(agentLoop.calls.executed.length, 1);
    assert.deepStrictEqual(agentLoop.calls.executed[0].toolCall, {
      name: 'deck_delete_card',
      arguments: { card: 'Q3 Planning' }
    });
    assert.strictEqual(agentLoop.calls.executed[0].roomToken, 'room1');

    // The model narrates the result. It is never asked what to execute.
    assert.strictEqual(agentLoop.calls.narrated.length, 1);
    assert.strictEqual(agentLoop.calls.narrated[0].outcome, 'Deleted "Q3 Planning".');
    assert.ok(outcome.response.includes('Deleted "Q3 Planning".'));

    // Single consumer: the record is spent.
    assert.strictEqual(enforcer.getPendingAction('room1'), null);
  });

  await asyncTest('approve → a failing tool is narrated honestly, not as success', async () => {
    const enforcer = makeEnforcer('APPROVE');
    const agentLoop = makeAgentLoop(enforcer, { success: false, result: '', error: 'card not found' });
    const mp = makeProcessor(agentLoop);

    const outcome = await mp._resolvePendingAction({ token: 'room1' }, 'ja');
    assert.ok(outcome.response.includes('card not found'));
    assert.ok(agentLoop.calls.narrated[0].outcome.startsWith('The action failed'));
  });

  await asyncTest('deny → the record dies and nothing executes', async () => {
    const enforcer = makeEnforcer('DENY');
    const agentLoop = makeAgentLoop(enforcer);
    const mp = makeProcessor(agentLoop);

    const outcome = await mp._resolvePendingAction({ token: 'room1' }, 'nein');

    assert.strictEqual(outcome.result.intent, 'pending_action_denied');
    assert.strictEqual(agentLoop.calls.executed.length, 0);
    assert.strictEqual(enforcer.getPendingAction('room1'), null);
  });

  await asyncTest('edit → the record is dropped and the reply routes on as new work', async () => {
    const enforcer = makeEnforcer('EDIT');
    const agentLoop = makeAgentLoop(enforcer);
    const mp = makeProcessor(agentLoop);

    const outcome = await mp._resolvePendingAction({ token: 'room1' }, 'ja, aber die Karte Budget');

    assert.strictEqual(outcome, null, 'routes onward through the normal pipeline');
    assert.strictEqual(agentLoop.calls.executed.length, 0, 'the record is never mutated into the new request');
    assert.strictEqual(enforcer.getPendingAction('room1'), null, 'and never survives an edit');
  });

  await asyncTest('unknown → the offer stays live and the message routes on', async () => {
    const enforcer = makeEnforcer('UNKNOWN');
    const agentLoop = makeAgentLoop(enforcer);
    const mp = makeProcessor(agentLoop);

    const outcome = await mp._resolvePendingAction({ token: 'room1' }, 'what is on my calendar?');

    assert.strictEqual(outcome, null);
    assert.strictEqual(agentLoop.calls.executed.length, 0);
    assert.ok(enforcer.getPendingAction('room1'), 'an unrelated message does not spend the offer');
  });

  await asyncTest('approve in DE, EN and PT resolves the same record', async () => {
    for (const reply of ['ja', 'yes', 'sim']) {
      const enforcer = makeEnforcer('APPROVE');
      const agentLoop = makeAgentLoop(enforcer);
      const outcome = await makeProcessor(agentLoop)._resolvePendingAction({ token: 'room1' }, reply);
      assert.strictEqual(outcome.result.intent, 'pending_action_executed', `failed for "${reply}"`);
      assert.strictEqual(agentLoop.calls.executed.length, 1, `failed for "${reply}"`);
    }
  });
}

main();

setTimeout(() => {
  summary();
  exitWithCode();
}, 500);
