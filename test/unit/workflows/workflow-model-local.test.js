'use strict';

/**
 * Workflow MODEL: local Override Tests (Session B4)
 *
 * Tests that MODEL: local in board/card descriptions forces local-only routing,
 * that cards can only ADD restrictions (never weaken board-level constraints),
 * and that MODEL: cloud is not a recognized directive.
 *
 * Run: node test/unit/workflows/workflow-model-local.test.js
 *
 * @module test/unit/workflows/workflow-model-local
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const WorkflowEngine = require('../../../src/lib/workflows/workflow-engine');

// ============================================================
// Mock Factories
// ============================================================

function createMockDetector(boards = []) {
  for (const wb of boards) {
    if (!wb.rulesCardId && wb.stacks && wb.stacks.length) {
      const rulesCard = { id: 900, title: 'WORKFLOW: pipeline', description: 'RULES', labels: [] };
      wb.stacks[0].cards = [rulesCard, ...(wb.stacks[0].cards || [])];
      wb.rulesCardId = 900;
    }
  }
  return {
    getWorkflowBoards: async () => boards,
    invalidateCache: () => {}
  };
}

function createMockDeck() {
  return {
    getComments: async () => [],
    addComment: async () => {},
    _request: async () => ({})
  };
}

function createMockAgentLoop() {
  const calls = [];
  return {
    processWorkflowTask: async (params) => { calls.push(params); return 'done'; },
    _calls: calls
  };
}

function createEngine() {
  return new WorkflowEngine({
    workflowDetector: createMockDetector(),
    deckClient: createMockDeck(),
    agentLoop: createMockAgentLoop(),
    talkSendQueue: { enqueue: async () => {} },
    talkToken: 'test-token'
  });
}

// ============================================================
// Tests
// ============================================================

console.log('\nWorkflow MODEL: local Override Tests (Session B4)');
console.log('=================================================\n');

console.log('--- Board-level MODEL: local ---\n');

// Test 1: Board with MODEL: local → cards route with forceLocal: true
test('TC-B4-001: board MODEL: local forces local on cards', () => {
  const engine = createEngine();
  const wb = { description: 'WORKFLOW: pipeline\nMODEL: local\nRULES: ...' };
  const card = { description: 'Just a regular card' };

  const result = engine._getRoleForCard(wb, card);

  assert.strictEqual(result.forceLocal, true, 'Board MODEL: local should force local');
});

// Test 2: Board without directive → cards route normally
test('TC-B4-002: board without MODEL directive routes normally', () => {
  const engine = createEngine();
  const wb = { description: 'WORKFLOW: pipeline\nRULES: Process cards.' };
  const card = { description: 'A task' };

  const result = engine._getRoleForCard(wb, card);

  assert.strictEqual(result.forceLocal, false, 'No directive should not force local');
  assert.strictEqual(result.role, 'workflow_cloud');
});

console.log('\n--- Card-level MODEL: local ---\n');

// Test 3: Card with MODEL: local on normal board → that card is local-only
test('TC-B4-003: card MODEL: local on normal board forces local for that card', () => {
  const engine = createEngine();
  const wb = { description: 'WORKFLOW: pipeline\nRULES: ...' };
  const card = { description: 'Process this data.\nMODEL: local' };

  const result = engine._getRoleForCard(wb, card);

  assert.strictEqual(result.forceLocal, true, 'Card MODEL: local should force local');
});

// Test 4: Card without directive on MODEL: local board → inherits local-only
test('TC-B4-004: card inherits board MODEL: local', () => {
  const engine = createEngine();
  const wb = { description: 'WORKFLOW: pipeline\nMODEL: local\nRULES: ...' };
  const card = { description: 'No directive here' };

  const result = engine._getRoleForCard(wb, card);

  assert.strictEqual(result.forceLocal, true, 'Card should inherit board forceLocal');
});

console.log('\n--- Parsing robustness ---\n');

// Test 5: MODEL: local parsing is case-insensitive
test('TC-B4-005: MODEL: local parsing is case-insensitive', () => {
  const engine = createEngine();

  const variants = [
    'WORKFLOW: pipeline\nMODEL: local\nRULES: ...',
    'WORKFLOW: pipeline\nmodel: local\nRULES: ...',
    'WORKFLOW: pipeline\nModel: Local\nRULES: ...',
    'WORKFLOW: pipeline\nMODEL:local\nRULES: ...',
  ];

  for (const desc of variants) {
    const wb = { description: desc };
    const card = { description: '' };
    const result = engine._getRoleForCard(wb, card);
    assert.strictEqual(result.forceLocal, true, `Should parse: ${desc.split('\n')[1]}`);
  }
});

// Test 6: MODEL: cloud in description → ignored (not a recognized directive)
test('TC-B4-006: MODEL: cloud is not recognized', () => {
  const engine = createEngine();
  const wb = { description: 'WORKFLOW: pipeline\nMODEL: cloud\nRULES: ...' };
  const card = { description: '' };

  const result = engine._getRoleForCard(wb, card);

  // MODEL: cloud is not in the regex, so no directive matched → default
  assert.strictEqual(result.forceLocal, false, 'cloud should be ignored');
  assert.strictEqual(result.role, 'workflow_cloud', 'Should fall through to default');
});

// Test 7: Directive in middle of multiline description → still detected
test('TC-B4-007: directive detected in middle of multiline description', () => {
  const engine = createEngine();
  const wb = {
    description: [
      'WORKFLOW: pipeline',
      'RULES: Process each card carefully.',
      'Each card goes through review.',
      'MODEL: local',
      'SLA: 3 days'
    ].join('\n')
  };
  const card = { description: '' };

  const result = engine._getRoleForCard(wb, card);

  assert.strictEqual(result.forceLocal, true, 'Should detect MODEL: local in middle of description');
});

// Test 8: Directive below --- separator → still detected
test('TC-B4-008: directive below --- separator still detected', () => {
  const engine = createEngine();
  const wb = {
    description: [
      'WORKFLOW: procedure',
      'RULES: Follow the steps below.',
      '---',
      'MODEL: local',
      'Extra config here.'
    ].join('\n')
  };
  const card = { description: '' };

  const result = engine._getRoleForCard(wb, card);

  assert.strictEqual(result.forceLocal, true, 'MODEL: local below --- should still be detected');
});

console.log('\n--- Restriction hierarchy ---\n');

// Test 9: Card cannot weaken board's MODEL: local
test('TC-B4-009: card MODEL: auto cannot weaken board MODEL: local', () => {
  const engine = createEngine();
  const wb = { description: 'WORKFLOW: pipeline\nMODEL: local\nRULES: ...' };
  const card = { description: 'MODEL: auto' };

  const result = engine._getRoleForCard(wb, card);

  assert.strictEqual(result.forceLocal, true, 'Card auto should not weaken board local');
});

// Test 10: Board MODEL: local + card MODEL: local → still local (redundant but fine)
test('TC-B4-010: board + card both MODEL: local → still local', () => {
  const engine = createEngine();
  const wb = { description: 'WORKFLOW: pipeline\nMODEL: local\nRULES: ...' };
  const card = { description: 'MODEL: local' };

  const result = engine._getRoleForCard(wb, card);

  assert.strictEqual(result.forceLocal, true, 'Redundant local should still be local');
});

console.log('\n--- Integration: processCard passes forceLocal ---\n');

// Test 11: Full path — board MODEL: local reaches AgentLoop with forceLocal: true
asyncTest('TC-B4-011: board MODEL: local reaches AgentLoop with forceLocal: true', async () => {
  const agentLoop = createMockAgentLoop();
  const engine = new WorkflowEngine({
    workflowDetector: createMockDetector([{
      board: { id: 1, title: 'Local Board' },
      stacks: [{
        id: 10, title: 'Inbox',
        cards: [{ id: 100, title: 'Private Card', description: 'Sensitive data', labels: [], lastModified: new Date().toISOString() }]
      }],
      description: 'WORKFLOW: pipeline\nMODEL: local\nRULES: Process privately.',
      workflowType: 'pipeline',
      boardId: 1
    }]),
    deckClient: createMockDeck(),
    agentLoop,
    talkSendQueue: { enqueue: async () => {} },
    talkToken: 'test-token'
  });

  await engine.processAll();

  assert.strictEqual(agentLoop._calls.length, 1, 'AgentLoop should be called');
  assert.strictEqual(agentLoop._calls[0].forceLocal, true, 'forceLocal should be true from MODEL: local');
});

// ============================================================
// Summary
// ============================================================

setTimeout(() => {
  summary();
  exitWithCode();
}, 200);
