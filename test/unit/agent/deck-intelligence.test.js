/*
 * Moltagent - Sovereign AI Agent Platform
 * Copyright (C) 2026 Moltagent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * Deck Intelligence Tests — Card context, assignment, board routing,
 * reference resolution.
 *
 * Run: node test/unit/agent/deck-intelligence.test.js
 *
 * @module test/unit/agent/deck-intelligence
 */

'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

const DeckExecutor = require('../../../src/lib/agent/executors/deck-executor');

const silentLogger = { log() {}, info() {}, warn() {}, error() {} };

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockRouter(extractResult) {
  return {
    route: async (req) => {
      if (typeof extractResult === 'function') return extractResult(req);
      return extractResult || { result: '{}' };
    }
  };
}

function createMockToolRegistry(responses = {}) {
  const calls = [];
  return {
    execute: async (name, args) => {
      calls.push({ name, args });
      if (responses[name]) {
        return typeof responses[name] === 'function' ? responses[name](args) : responses[name];
      }
      return { success: true, result: 'Created [Test Card](url) in Inbox.', card: { id: 42, boardId: 1, stackId: 1 } };
    },
    getCalls: () => calls,
    getCallsFor: (name) => calls.filter(c => c.name === name)
  };
}

function makeExecutor(opts = {}) {
  const toolRegistry = opts.toolRegistry || createMockToolRegistry(opts.toolResponses);
  const router = opts.router || createMockRouter(opts.routerResult || { result: '{}' });

  const exec = new DeckExecutor({
    toolRegistry,
    deckClient: opts.deckClient || null,
    router,
    logger: silentLogger,
    ...opts
  });

  return { exec, toolRegistry };
}

// ---------------------------------------------------------------------------
// Fix 1: Cards carry conversation context
// ---------------------------------------------------------------------------

console.log('Deck Intelligence Tests');
console.log('=======================\n');

asyncTest('Fix1: Living Context enriches empty description', async () => {
  const { exec, toolRegistry } = makeExecutor();

  await exec._executeCreate({
    card_title: 'NC Analytics Findings'
    // No description
  }, {
    userName: 'jordan',
    roomToken: 'abc123',
    getRecentContext: () => [
      { role: 'user', content: 'What do you know about NC Analytics?' },
      { role: 'assistant', content: 'NC Analytics is a Nextcloud app that provides reporting dashboards. It supports data sources from files, forms, and external APIs. Key features include: real-time chart widgets, CSV export, and shared dashboards.' }
    ]
  });

  const createCalls = toolRegistry.getCallsFor('deck_create_card');
  assert.strictEqual(createCalls.length, 1, 'Should call deck_create_card once');
  assert.ok(createCalls[0].args.description, 'Description should be populated');
  assert.ok(createCalls[0].args.description.includes('NC Analytics'), 'Description should contain conversation findings');
});

asyncTest('Fix1: Provided description is NOT overwritten by context', async () => {
  const { exec, toolRegistry } = makeExecutor();

  await exec._executeCreate({
    card_title: 'Research Task',
    description: 'This is a detailed description that the LLM provided with all the findings and context needed for the card.'
  }, {
    userName: 'jordan',
    roomToken: 'abc123',
    getRecentContext: () => [
      { role: 'assistant', content: 'Some other content from conversation' }
    ]
  });

  const createCalls = toolRegistry.getCallsFor('deck_create_card');
  assert.ok(createCalls[0].args.description.startsWith('This is a detailed description'), 'Original description should be preserved');
  assert.ok(!createCalls[0].args.description.includes('Some other content'), 'Should NOT inject context when description is sufficient');
});

// ---------------------------------------------------------------------------
// Fix 2: Cards assigned to requesting user
// ---------------------------------------------------------------------------

asyncTest('Fix2: Card auto-assigned to requesting user', async () => {
  const { exec, toolRegistry } = makeExecutor();

  await exec._executeCreate({
    card_title: 'Analytics Task'
  }, {
    userName: 'jordan',
    roomToken: 'abc123',
    getRecentContext: () => []
  });

  const assignCalls = toolRegistry.getCallsFor('deck_assign_user');
  assert.strictEqual(assignCalls.length, 1, 'Should call deck_assign_user');
  assert.strictEqual(assignCalls[0].args.user, 'jordan', 'Should assign requesting user');
  assert.strictEqual(assignCalls[0].args.card, '#42', 'Should use card ID from creation result');
});

asyncTest('Fix2: Agent user (moltagent) NOT auto-assigned', async () => {
  const { exec, toolRegistry } = makeExecutor();

  await exec._executeCreate({
    card_title: 'Agent Task'
  }, {
    userName: 'moltagent',
    roomToken: 'abc123',
    getRecentContext: () => []
  });

  const assignCalls = toolRegistry.getCallsFor('deck_assign_user');
  assert.strictEqual(assignCalls.length, 0, 'Should NOT auto-assign the agent itself');
});

asyncTest('Fix2: Explicit assignee skips auto-assign of requester', async () => {
  const { exec, toolRegistry } = makeExecutor();

  await exec._executeCreate({
    card_title: 'Delegated Task',
    assignee: 'alice'
  }, {
    userName: 'jordan',
    roomToken: 'abc123',
    getRecentContext: () => []
  });

  const assignCalls = toolRegistry.getCallsFor('deck_assign_user');
  const aliceAssign = assignCalls.find(c => c.args.user === 'alice');
  const jordanAssign = assignCalls.find(c => c.args.user === 'jordan');
  assert.ok(aliceAssign, 'Should assign explicit user');
  assert.ok(!jordanAssign, 'Should NOT auto-assign requester when explicit assignee provided');
});

// ---------------------------------------------------------------------------
// Fix 3: Board routing logic
// ---------------------------------------------------------------------------

test('Fix3: _resolveTargetBoard returns explicit board name', () => {
  const { exec } = makeExecutor();
  assert.strictEqual(
    exec._resolveTargetBoard({ board_name: 'Content Pipeline' }, {}),
    'Content Pipeline'
  );
});

test('Fix3: _resolveTargetBoard returns Personal for commitment_detector', () => {
  const { exec } = makeExecutor();
  assert.strictEqual(
    exec._resolveTargetBoard({}, { source: 'commitment_detector' }),
    'Personal'
  );
});

test('Fix3: _resolveTargetBoard returns undefined for user requests (default board)', () => {
  const { exec } = makeExecutor();
  assert.strictEqual(
    exec._resolveTargetBoard({}, { userName: 'jordan' }),
    undefined
  );
});

// ---------------------------------------------------------------------------
// Fix 4: Card reference resolution
// ---------------------------------------------------------------------------

asyncTest('Fix4: resolves "that" from ActionLedger', async () => {
  const { exec } = makeExecutor();

  const resolved = await exec._resolveCardReference('that', {
    getRecentActions: (domain) => {
      if (domain === 'deck') {
        return [
          { type: 'deck_create', refs: { card: 'Analytics Report', cardId: '55' } }
        ];
      }
      return [];
    }
  });

  assert.strictEqual(resolved, '#55', 'Should resolve "that" to card ID from ActionLedger');
});

asyncTest('Fix4: resolves "the stale card" from conversation context', async () => {
  const { exec } = makeExecutor();

  const resolved = await exec._resolveCardReference('the stale card', {
    getRecentActions: () => [], // No recent deck actions
    getRecentContext: () => [
      { role: 'assistant', content: '📋 Task "Fix login bug" has been in Doing for 8 days.' }
    ]
  });

  assert.strictEqual(resolved, 'Fix login bug', 'Should resolve from notification format in context');
});

asyncTest('Fix4: passes through explicit card titles unchanged', async () => {
  const { exec } = makeExecutor();

  const resolved = await exec._resolveCardReference('Analytics Report', {});
  assert.strictEqual(resolved, 'Analytics Report', 'Explicit title should pass through');
});

asyncTest('Fix4: returns original reference when nothing can be resolved', async () => {
  const { exec } = makeExecutor();

  const resolved = await exec._resolveCardReference('that', {
    getRecentActions: () => [],
    getRecentContext: () => []
  });

  assert.strictEqual(resolved, 'that', 'Should fall through to original when no match');
});

// ---------------------------------------------------------------------------
// ActionRecord enrichment
// ---------------------------------------------------------------------------

asyncTest('Fix4: actionRecord includes cardId for reference resolution', async () => {
  const { exec } = makeExecutor();

  const result = await exec._executeCreate({
    card_title: 'Test Card'
  }, {
    userName: 'jordan',
    roomToken: 'abc123',
    getRecentContext: () => []
  });

  assert.ok(result.actionRecord, 'Should return actionRecord');
  assert.strictEqual(result.actionRecord.type, 'deck_create');
  assert.strictEqual(result.actionRecord.refs.cardId, '42', 'Should include cardId from creation result');
  assert.strictEqual(result.actionRecord.refs.card, 'Test Card');
});

// ---------------------------------------------------------------------------

setTimeout(() => { summary(); exitWithCode(); }, 200);
