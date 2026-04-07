/*
 * Moltagent - Sovereign AI Security Layer
 * Copyright (C) 2026 Moltagent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

'use strict';

const assert = require('assert');
const { asyncTest, test, summary, exitWithCode } = require('../../helpers/test-runner');
const DeckExecutor = require('../../../src/lib/agent/executors/deck-executor');

const silentLogger = { log() {}, info() {}, warn() {}, error() {} };

// Layer 3: executors return {response, actionRecord} objects
function getResponse(result) {
  return typeof result === 'object' && result !== null && result.response ? result.response : result;
}

function createMockRouter(extractResult) {
  return {
    route: async () => extractResult || { result: '{}' }
  };
}

/**
 * Create a mock tool registry that tracks calls per tool name.
 * @param {Object} responses - { toolName: returnValue } map
 * @returns {{ execute, getCalls, getCallsFor }}
 */
function createMockToolRegistry(responses = {}) {
  const calls = [];
  return {
    execute: async (name, args) => {
      calls.push({ name, args });
      if (responses[name]) {
        return typeof responses[name] === 'function' ? responses[name](args) : responses[name];
      }
      return { success: true, result: 'OK' };
    },
    getCalls: () => calls,
    getCallsFor: (name) => calls.filter(c => c.name === name)
  };
}

// ============================================================
// List
// ============================================================

asyncTest('List cards on default board', async () => {
  const registry = createMockToolRegistry({
    deck_list_cards: { success: true, result: '**Inbox** (2):\n- [#1] "Buy milk"\n- [#2] "Fix bug"' }
  });
  const executor = new DeckExecutor({
    router: createMockRouter({ result: JSON.stringify({ action: 'list' }) }),
    toolRegistry: registry,
    logger: silentLogger
  });

  const result = await executor.execute('What are my tasks?', { userName: 'alice' });
  const resp = getResponse(result);
  assert.ok(resp.includes('Buy milk'), `Should list cards, got: ${resp}`);
  assert.strictEqual(registry.getCallsFor('deck_list_cards').length, 1);
  const call = registry.getCallsFor('deck_list_cards')[0];
  assert.strictEqual(call.args.board, undefined, 'Should not pass board for default');
});

asyncTest('List cards on named board', async () => {
  const registry = createMockToolRegistry({
    deck_list_cards: { success: true, result: '**Todo** (1):\n- [#5] "Onboarding"' }
  });
  const executor = new DeckExecutor({
    router: createMockRouter({ result: JSON.stringify({ action: 'list', board_name: 'Client Onboarding' }) }),
    toolRegistry: registry,
    logger: silentLogger
  });

  const result = await executor.execute('Show Client Onboarding board', { userName: 'alice' });
  const resp = getResponse(result);
  assert.ok(resp.includes('Onboarding'), `Should list board cards, got: ${resp}`);
  const call = registry.getCallsFor('deck_list_cards')[0];
  assert.strictEqual(call.args.board, 'Client Onboarding');
});

asyncTest('List returns actionRecord', async () => {
  const registry = createMockToolRegistry({
    deck_list_cards: { success: true, result: 'Board is empty.' }
  });
  const executor = new DeckExecutor({
    router: createMockRouter({ result: JSON.stringify({ action: 'list' }) }),
    toolRegistry: registry,
    logger: silentLogger
  });

  const result = await executor.execute('Show my tasks', { userName: 'alice' });
  assert.ok(result.actionRecord, 'Should return actionRecord');
  assert.strictEqual(result.actionRecord.type, 'deck_list');
});

// ============================================================
// Get
// ============================================================

asyncTest('Get card by title', async () => {
  const registry = createMockToolRegistry({
    deck_get_card: { success: true, result: 'Card #7: "Fix login bug" in Working\nDescription: Auth module issue' }
  });
  const executor = new DeckExecutor({
    router: createMockRouter({ result: JSON.stringify({ action: 'get', card_title: 'login bug' }) }),
    toolRegistry: registry,
    logger: silentLogger
  });

  const result = await executor.execute('Show me the login bug card', { userName: 'alice' });
  const resp = getResponse(result);
  assert.ok(resp.includes('Fix login bug'), `Should return card details, got: ${resp}`);
  const call = registry.getCallsFor('deck_get_card')[0];
  assert.strictEqual(call.args.card, 'login bug');
});

asyncTest('Get with missing title asks for clarification', async () => {
  const registry = createMockToolRegistry();
  const executor = new DeckExecutor({
    router: createMockRouter({ result: JSON.stringify({ action: 'get', card_title: '' }) }),
    toolRegistry: registry,
    logger: silentLogger
  });

  const result = await executor.execute('Show me a card', { userName: 'alice' });
  const resp = getResponse(result);
  assert.ok(resp.includes('Which card'), `Should ask which card, got: ${resp}`);
  assert.strictEqual(registry.getCallsFor('deck_get_card').length, 0, 'Should NOT call tool');
});

// ============================================================
// Create
// ============================================================

asyncTest('Create card in default stack', async () => {
  const registry = createMockToolRegistry({
    deck_create_card: { success: true, result: 'Created "Buy groceries" in Inbox.', card: { id: 10, boardId: 1, stackId: 1 } }
  });
  const executor = new DeckExecutor({
    router: createMockRouter({ result: JSON.stringify({ action: 'create', card_title: 'Buy groceries' }) }),
    toolRegistry: registry,
    logger: silentLogger
  });

  const result = await executor.execute('Create a task called Buy groceries', { userName: 'alice' });
  const resp = getResponse(result);
  assert.ok(resp.includes('Buy groceries'), `Should confirm creation, got: ${resp}`);
  const call = registry.getCallsFor('deck_create_card')[0];
  assert.strictEqual(call.args.title, 'Buy groceries');
});

asyncTest('Create card in named stack', async () => {
  const registry = createMockToolRegistry({
    deck_create_card: { success: true, result: 'Created "Deploy v2" in Working.', card: { id: 11, boardId: 1, stackId: 1 } }
  });
  const executor = new DeckExecutor({
    router: createMockRouter({ result: JSON.stringify({ action: 'create', card_title: 'Deploy v2', stack_name: 'Doing' }) }),
    toolRegistry: registry,
    logger: silentLogger
  });

  await executor.execute('Create task Deploy v2 in Doing', { userName: 'alice' });
  const call = registry.getCallsFor('deck_create_card')[0];
  assert.strictEqual(call.args.stack, 'Working', 'Should normalize "Doing" to "Working"');
});

asyncTest('Create with missing title asks for clarification', async () => {
  const registry = createMockToolRegistry();
  const executor = new DeckExecutor({
    router: createMockRouter({ result: JSON.stringify({ action: 'create', card_title: '' }) }),
    toolRegistry: registry,
    logger: silentLogger
  });

  const result = await executor.execute('Create a task', { userName: 'alice' });
  const resp = getResponse(result);
  assert.ok(resp.includes('called'), `Should ask for title, got: ${resp}`);
  assert.strictEqual(registry.getCallsFor('deck_create_card').length, 0);
});

// ============================================================
// Move
// ============================================================

asyncTest('Move card between stacks', async () => {
  const registry = createMockToolRegistry({
    deck_move_card: { success: true, result: 'Moved "Fix bug" (card #7) from Inbox to Done.' }
  });
  const executor = new DeckExecutor({
    router: createMockRouter({ result: JSON.stringify({ action: 'move', card_title: 'Fix bug', stack_name: 'Done' }) }),
    toolRegistry: registry,
    logger: silentLogger
  });

  const result = await executor.execute('Move Fix bug to Done', { userName: 'alice' });
  const resp = getResponse(result);
  assert.ok(resp.includes('Moved'), `Should confirm move, got: ${resp}`);
  assert.ok(resp.includes('Done'), `Should mention target stack, got: ${resp}`);
  const call = registry.getCallsFor('deck_move_card')[0];
  assert.strictEqual(call.args.card, 'Fix bug');
  assert.strictEqual(call.args.target_stack, 'Done');
});

asyncTest('Move with stack alias normalizes correctly', async () => {
  const registry = createMockToolRegistry({
    deck_move_card: { success: true, result: 'Moved "Task A" to Done.' }
  });
  const executor = new DeckExecutor({
    router: createMockRouter({ result: JSON.stringify({ action: 'move', card_title: 'Task A', stack_name: 'completed' }) }),
    toolRegistry: registry,
    logger: silentLogger
  });

  await executor.execute('Mark Task A as completed', { userName: 'alice' });
  const call = registry.getCallsFor('deck_move_card')[0];
  assert.strictEqual(call.args.target_stack, 'Done', '"completed" should normalize to "Done"');
});

asyncTest('Move without target stack asks where', async () => {
  const registry = createMockToolRegistry();
  const executor = new DeckExecutor({
    router: createMockRouter({ result: JSON.stringify({ action: 'move', card_title: 'Fix bug', stack_name: '' }) }),
    toolRegistry: registry,
    logger: silentLogger
  });

  const result = await executor.execute('Move Fix bug', { userName: 'alice' });
  const resp = getResponse(result);
  assert.ok(resp.includes('Where'), `Should ask where to move, got: ${resp}`);
  assert.strictEqual(registry.getCallsFor('deck_move_card').length, 0, 'Should NOT call tool');
});

asyncTest('Move non-existent card surfaces tool error', async () => {
  const registry = createMockToolRegistry({
    deck_move_card: { success: true, result: 'No card found matching "Ghost Card".' }
  });
  const executor = new DeckExecutor({
    router: createMockRouter({ result: JSON.stringify({ action: 'move', card_title: 'Ghost Card', stack_name: 'Done' }) }),
    toolRegistry: registry,
    logger: silentLogger
  });

  const result = await executor.execute('Move Ghost Card to Done', { userName: 'alice' });
  const resp = getResponse(result);
  assert.ok(resp.includes('No card found'), `Should surface not-found message, got: ${resp}`);
});

// ============================================================
// Update
// ============================================================

asyncTest('Update card description', async () => {
  const registry = createMockToolRegistry({
    deck_update_card: { success: true, result: 'Updated card #7 "Fix bug". Changes: description updated.' }
  });
  const executor = new DeckExecutor({
    router: createMockRouter({ result: JSON.stringify({ action: 'update', card_title: 'Fix bug', description: 'Auth module login fails' }) }),
    toolRegistry: registry,
    logger: silentLogger
  });

  const result = await executor.execute('Update Fix bug description to Auth module login fails', { userName: 'alice' });
  const resp = getResponse(result);
  assert.ok(resp.includes('Updated'), `Should confirm update, got: ${resp}`);
  const call = registry.getCallsFor('deck_update_card')[0];
  assert.strictEqual(call.args.card, 'Fix bug');
  assert.strictEqual(call.args.description, 'Auth module login fails');
});

asyncTest('Update failure surfaces error', async () => {
  const registry = createMockToolRegistry({
    deck_update_card: { success: false, error: 'Card not found' }
  });
  const executor = new DeckExecutor({
    router: createMockRouter({ result: JSON.stringify({ action: 'update', card_title: 'Ghost', description: 'new desc' }) }),
    toolRegistry: registry,
    logger: silentLogger
  });

  const result = await executor.execute('Update Ghost description', { userName: 'alice' });
  const resp = getResponse(result);
  assert.ok(resp.includes('Card not found'), `Should surface error, got: ${resp}`);
});

asyncTest('Update with nothing to change asks what to update', async () => {
  const registry = createMockToolRegistry();
  const executor = new DeckExecutor({
    router: createMockRouter({ result: JSON.stringify({ action: 'update', card_title: 'Fix bug' }) }),
    toolRegistry: registry,
    logger: silentLogger
  });

  const result = await executor.execute('Update Fix bug', { userName: 'alice' });
  const resp = getResponse(result);
  assert.ok(resp.includes('What should I update'), `Should ask what to update, got: ${resp}`);
  assert.strictEqual(registry.getCallsFor('deck_update_card').length, 0);
});

// ============================================================
// Delete
// ============================================================

asyncTest('Delete card calls tool and confirms', async () => {
  const registry = createMockToolRegistry({
    deck_delete_card: { success: true, result: 'Deleted card #7 "Fix bug" from Working.' }
  });
  const executor = new DeckExecutor({
    router: createMockRouter({ result: JSON.stringify({ action: 'delete', card_title: 'Fix bug' }) }),
    toolRegistry: registry,
    logger: silentLogger
  });

  const result = await executor.execute('Delete the Fix bug card', { userName: 'alice' });
  const resp = getResponse(result);
  assert.ok(resp.includes('Deleted'), `Should confirm deletion, got: ${resp}`);
  assert.strictEqual(registry.getCallsFor('deck_delete_card').length, 1);
});

// ============================================================
// Assign
// ============================================================

asyncTest('Assign user to card', async () => {
  const registry = createMockToolRegistry({
    deck_assign_user: { success: true, result: 'Assigned bob to card #7 "Fix bug".' }
  });
  const executor = new DeckExecutor({
    router: createMockRouter({ result: JSON.stringify({ action: 'assign', card_title: 'Fix bug', assignee: 'bob' }) }),
    toolRegistry: registry,
    logger: silentLogger
  });

  const result = await executor.execute('Assign Fix bug to bob', { userName: 'alice' });
  const resp = getResponse(result);
  assert.ok(resp.includes('bob'), `Should confirm assignment, got: ${resp}`);
  const call = registry.getCallsFor('deck_assign_user')[0];
  assert.strictEqual(call.args.user, 'bob');
});

asyncTest('Assign without assignee asks who', async () => {
  const registry = createMockToolRegistry();
  const executor = new DeckExecutor({
    router: createMockRouter({ result: JSON.stringify({ action: 'assign', card_title: 'Fix bug', assignee: '' }) }),
    toolRegistry: registry,
    logger: silentLogger
  });

  const result = await executor.execute('Assign Fix bug', { userName: 'alice' });
  const resp = getResponse(result);
  assert.ok(resp.includes('Who'), `Should ask who to assign, got: ${resp}`);
  assert.strictEqual(registry.getCallsFor('deck_assign_user').length, 0);
});

// ============================================================
// Label
// ============================================================

asyncTest('Label card', async () => {
  const registry = createMockToolRegistry({
    deck_add_label: { success: true, result: 'Added label "urgent" to card #7.' }
  });
  const executor = new DeckExecutor({
    router: createMockRouter({ result: JSON.stringify({ action: 'label', card_title: 'Fix bug', label_name: 'urgent' }) }),
    toolRegistry: registry,
    logger: silentLogger
  });

  const result = await executor.execute('Label Fix bug as urgent', { userName: 'alice' });
  const resp = getResponse(result);
  assert.ok(resp.includes('urgent'), `Should confirm label, got: ${resp}`);
});

// ============================================================
// Routing
// ============================================================

asyncTest('Default/unknown action falls to list', async () => {
  const registry = createMockToolRegistry({
    deck_list_cards: { success: true, result: 'Board is empty.' }
  });
  const executor = new DeckExecutor({
    router: createMockRouter({ result: JSON.stringify({ action: 'search' }) }),
    toolRegistry: registry,
    logger: silentLogger
  });

  await executor.execute('Search my tasks', { userName: 'alice' });
  assert.strictEqual(registry.getCallsFor('deck_list_cards').length, 1, 'Unknown action should fall to list');
});

test('Stack alias normalization', () => {
  const executor = new DeckExecutor({
    router: createMockRouter(),
    toolRegistry: createMockToolRegistry(),
    logger: silentLogger
  });

  assert.strictEqual(executor._normalizeStackName('completed'), 'Done');
  assert.strictEqual(executor._normalizeStackName('finished'), 'Done');
  assert.strictEqual(executor._normalizeStackName('in progress'), 'Working');
  assert.strictEqual(executor._normalizeStackName('doing'), 'Working');
  assert.strictEqual(executor._normalizeStackName('todo'), 'Inbox');
  assert.strictEqual(executor._normalizeStackName('to do'), 'Inbox');
  assert.strictEqual(executor._normalizeStackName('planned'), 'Queued');
  assert.strictEqual(executor._normalizeStackName('on hold'), 'Review');
  assert.strictEqual(executor._normalizeStackName('Custom Stack'), 'Custom Stack', 'Unknown names pass through');
  assert.strictEqual(executor._normalizeStackName(null), 'Inbox', 'null defaults to Inbox');
  assert.strictEqual(executor._normalizeStackName(''), 'Inbox', 'empty defaults to Inbox');
});

// ============================================================
// Guardrails
// ============================================================

asyncTest('Create blocked by guardrail returns action-blocked message', async () => {
  const registry = createMockToolRegistry();
  const executor = new DeckExecutor({
    router: createMockRouter({ result: JSON.stringify({ action: 'create', card_title: 'Forbidden Card' }) }),
    toolRegistry: registry,
    toolGuard: { evaluate: (name) => ({ allowed: false, reason: 'Board is read-only' }) },
    logger: silentLogger
  });

  const result = await executor.execute('Create Forbidden Card', { userName: 'alice' });
  const resp = getResponse(result);
  assert.ok(resp.includes('Action blocked'), `Should report blocked, got: ${resp}`);
  assert.ok(resp.includes('read-only'), `Should include reason, got: ${resp}`);
  assert.strictEqual(registry.getCallsFor('deck_create_card').length, 0, 'Should NOT call tool when blocked');
});

asyncTest('Delete blocked by guardrail returns action-blocked message', async () => {
  const registry = createMockToolRegistry();
  const executor = new DeckExecutor({
    router: createMockRouter({ result: JSON.stringify({ action: 'delete', card_title: 'Critical Task' }) }),
    toolRegistry: registry,
    toolGuard: { evaluate: (name) => ({ allowed: false, reason: 'Destructive ops require approval' }) },
    logger: silentLogger
  });

  const result = await executor.execute('Delete Critical Task', { userName: 'alice' });
  const resp = getResponse(result);
  assert.ok(resp.includes('Action blocked'), `Should report blocked, got: ${resp}`);
  assert.strictEqual(registry.getCallsFor('deck_delete_card').length, 0, 'Should NOT call tool when blocked');
});

// ============================================================
// Create with follow-up (due date + assignee)
// ============================================================

asyncTest('Create with due_date calls deck_set_due_date follow-up', async () => {
  const registry = createMockToolRegistry({
    deck_create_card: { success: true, result: 'Created "Report" in Inbox.', card: { id: 15, boardId: 1, stackId: 1 } },
    deck_set_due_date: { success: true, result: 'Due date set.' }
  });
  const executor = new DeckExecutor({
    router: createMockRouter({ result: JSON.stringify({ action: 'create', card_title: 'Report', due_date: 'tomorrow' }) }),
    toolRegistry: registry,
    logger: silentLogger
  });

  await executor.execute('Create task Report due tomorrow', { userName: 'alice' });
  assert.strictEqual(registry.getCallsFor('deck_set_due_date').length, 1, 'Should call deck_set_due_date');
  const call = registry.getCallsFor('deck_set_due_date')[0];
  assert.strictEqual(call.args.card, '#15', 'Should use structured card ID');
});

asyncTest('Create with assignee calls deck_assign_user follow-up', async () => {
  const registry = createMockToolRegistry({
    deck_create_card: { success: true, result: 'Created "Design" in Inbox.', card: { id: 20, boardId: 1, stackId: 1 } },
    deck_assign_user: { success: true, result: 'Assigned bob.' }
  });
  const executor = new DeckExecutor({
    router: createMockRouter({ result: JSON.stringify({ action: 'create', card_title: 'Design', assignee: 'bob' }) }),
    toolRegistry: registry,
    logger: silentLogger
  });

  await executor.execute('Create task Design assigned to bob', { userName: 'alice' });
  assert.strictEqual(registry.getCallsFor('deck_assign_user').length, 1, 'Should call deck_assign_user');
  const call = registry.getCallsFor('deck_assign_user')[0];
  assert.strictEqual(call.args.user, 'bob');
  assert.strictEqual(call.args.card, '#20');
});

// ============================================================
// List failure
// ============================================================

asyncTest('List failure surfaces error', async () => {
  const registry = createMockToolRegistry({
    deck_list_cards: { success: false, error: 'Board not accessible' }
  });
  const executor = new DeckExecutor({
    router: createMockRouter({ result: JSON.stringify({ action: 'list' }) }),
    toolRegistry: registry,
    logger: silentLogger
  });

  const result = await executor.execute('Show my tasks', { userName: 'alice' });
  const resp = getResponse(result);
  assert.ok(resp.includes('Board not accessible'), `Should surface error, got: ${resp}`);
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
