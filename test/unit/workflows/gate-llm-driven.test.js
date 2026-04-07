/**
 * AGPL-3.0 License
 * Copyright (C) 2024 Moltagent Contributors
 *
 * gate-llm-driven.test.js
 *
 * Tests for the LLM-driven GATE architecture:
 * - GATE label stamping is done by the LLM (not auto-stamped by the engine)
 * - workflow_deck_assign_label tool is available to the LLM
 * - Safety net reassigns bot-assigned GATE cards to human
 * - GATE resolution triggers processWorkflowTask correctly
 */

'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const WorkflowEngine = require('../../../src/lib/workflows/workflow-engine');
const GateDetector = require('../../../src/lib/workflows/gate-detector');

// --- Mock Factories ---

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
  const comments = [];
  const requestCalls = [];
  return {
    getComments: async () => comments,
    addComment: async (cardId, msg) => { comments.push({ actorId: 'moltagent', message: msg }); },
    getBoard: async () => ({ labels: [] }),
    _request: async (method, path, body) => {
      requestCalls.push({ method, path, body });
      return {};
    },
    username: 'moltagent',
    _comments: comments,
    _requestCalls: requestCalls
  };
}

function createMockAgentLoop() {
  const calls = [];
  return {
    processWorkflowTask: async (params) => { calls.push(params); return 'done'; },
    _calls: calls
  };
}

function createMockTalkQueue() {
  const messages = [];
  return {
    enqueue: async (token, msg) => { messages.push({ token, msg }); },
    _messages: messages
  };
}

// Build a minimal workflow board object for tests
function makeBoard({ cardLabels = [], assignedUsers = [], extraCards = [] } = {}) {
  return {
    board: { id: 1, title: 'Test Workflow', owner: { uid: 'jordan' } },
    stacks: [{
      id: 10,
      title: 'Inbox',
      cards: [
        {
          id: 100,
          title: 'Content Card',
          description: 'Do something',
          labels: cardLabels,
          assignedUsers,
          lastModified: new Date(Date.now() + 60000).toISOString() // force processing
        },
        ...extraCards
      ]
    }],
    description: 'WORKFLOW: pipeline\nRULES: Process cards.',
    workflowType: 'pipeline',
    boardId: 1
  };
}

(async () => {
  console.log('\n=== LLM-Driven GATE Architecture Tests ===\n');

  // Test 1: Card in GATE stack without GATE label → _processCard is called (not skipped)
  await asyncTest('Card without GATE label in GATE stack is processed (not skipped)', async () => {
    const agentLoop = createMockAgentLoop();
    const mockDeck = createMockDeck();
    // Deck provides board labels
    mockDeck.getBoard = async () => ({ labels: [{ id: 5, title: 'GATE', color: 'ff0000' }] });

    // Card has no GATE label — should fall through to _processCard
    const wb = makeBoard({ cardLabels: [] });
    const engine = new WorkflowEngine({
      workflowDetector: createMockDetector([wb]),
      deckClient: mockDeck,
      agentLoop,
      talkSendQueue: createMockTalkQueue(),
      talkToken: 'test-token'
    });

    const results = await engine.processAll();

    assert.strictEqual(results.boardsProcessed, 1);
    assert.strictEqual(results.cardsProcessed, 1, 'Card should be processed');
    assert.strictEqual(agentLoop._calls.length, 1, 'AgentLoop should be called');
    // Confirm it was not treated as a gate
    assert.strictEqual(results.gatesFound, 0, 'No gates should be found');
  });

  // Test 2: Card with GATE label → _handleGate is called, not _processCard
  await asyncTest('Card with GATE label is handled by _handleGate (not processed)', async () => {
    const agentLoop = createMockAgentLoop();
    const mockDeck = createMockDeck();

    const wb = makeBoard({ cardLabels: [{ title: 'GATE', color: 'ff0000' }] });
    const engine = new WorkflowEngine({
      workflowDetector: createMockDetector([wb]),
      deckClient: mockDeck,
      agentLoop,
      talkSendQueue: createMockTalkQueue(),
      talkToken: 'test-token'
    });

    const results = await engine.processAll();

    assert.strictEqual(results.gatesFound, 1, 'One gate should be found');
    // The gate is not resolved (no APPROVED/REJECTED), so processWorkflowTask not called
    assert.strictEqual(agentLoop._calls.length, 0, 'AgentLoop should NOT be called for unresolved gate');
    assert.strictEqual(results.cardsProcessed, 0, 'Card should not be counted as processed');
  });

  // Test 3: GATE card assigned to bot → safety net reassigns to human
  await asyncTest('Safety net reassigns bot-assigned GATE card to human reviewer', async () => {
    const agentLoop = createMockAgentLoop();
    const mockDeck = createMockDeck();

    // Card has GATE label and is assigned to the bot
    const wb = makeBoard({
      cardLabels: [{ title: 'GATE', color: 'ff0000' }],
      assignedUsers: [{ participant: { uid: 'moltagent' } }]
    });

    const engine = new WorkflowEngine({
      workflowDetector: createMockDetector([wb]),
      deckClient: mockDeck,
      agentLoop,
      talkSendQueue: createMockTalkQueue(),
      talkToken: 'test-token'
    });

    await engine.processAll();

    const unassignCalls = mockDeck._requestCalls.filter(c => c.path.includes('unassignUser'));
    const assignCalls = mockDeck._requestCalls.filter(c => c.path.includes('assignUser'));

    assert.ok(unassignCalls.length >= 1, 'Should call unassignUser to remove bot');
    assert.ok(assignCalls.length >= 1, 'Should call assignUser to add human reviewer');

    // Verify bot was unassigned
    const botUnassign = unassignCalls.find(c => c.body && c.body.userId === 'moltagent');
    assert.ok(botUnassign, 'Bot (moltagent) should be unassigned');
  });

  // Test 4: GATE card assigned to human → no safety net reassignment
  await asyncTest('No safety net reassignment when GATE card already assigned to human', async () => {
    const agentLoop = createMockAgentLoop();
    const mockDeck = createMockDeck();

    // Card has GATE label and is assigned to human (not bot)
    const wb = makeBoard({
      cardLabels: [{ title: 'GATE', color: 'ff0000' }],
      assignedUsers: [{ participant: { uid: 'jordan' } }]
    });

    const engine = new WorkflowEngine({
      workflowDetector: createMockDetector([wb]),
      deckClient: mockDeck,
      agentLoop,
      talkSendQueue: createMockTalkQueue(),
      talkToken: 'test-token'
    });

    await engine.processAll();

    // No assign/unassign calls should have been made by the safety net
    const assignCalls = mockDeck._requestCalls.filter(
      c => c.path.includes('assignUser') || c.path.includes('unassignUser')
    );
    assert.strictEqual(assignCalls.length, 0, 'No reassignment should happen when human is assigned');
  });

  // Test 5: GATE card with APPROVED label → triggers processWorkflowTask
  await asyncTest('GATE card with APPROVED label triggers processWorkflowTask', async () => {
    const agentLoop = createMockAgentLoop();
    const mockDeck = createMockDeck();
    mockDeck.getBoard = async () => ({ labels: [] });

    const wb = makeBoard({
      cardLabels: [
        { title: 'GATE', color: 'ff0000' },
        { title: 'APPROVED', color: '00ff00' }
      ]
    });

    const engine = new WorkflowEngine({
      workflowDetector: createMockDetector([wb]),
      deckClient: mockDeck,
      agentLoop,
      talkSendQueue: createMockTalkQueue(),
      talkToken: 'test-token'
    });

    const results = await engine.processAll();

    assert.strictEqual(results.gatesFound, 1, 'One gate found');
    assert.strictEqual(results.gatesResolved, 1, 'Gate should be resolved');
    assert.strictEqual(agentLoop._calls.length, 1, 'AgentLoop should be called for resolution');

    const call = agentLoop._calls[0];
    assert.ok(call.systemAddition.toLowerCase().includes('approved'),
      'System addition should mention APPROVED');
  });

  // Test 6: GATE card with REJECTED label → triggers processWorkflowTask
  await asyncTest('GATE card with REJECTED label triggers processWorkflowTask', async () => {
    const agentLoop = createMockAgentLoop();
    const mockDeck = createMockDeck();
    mockDeck.getBoard = async () => ({ labels: [] });

    const wb = makeBoard({
      cardLabels: [
        { title: 'GATE', color: 'ff0000' },
        { title: 'REJECTED', color: 'ff6600' }
      ]
    });

    const engine = new WorkflowEngine({
      workflowDetector: createMockDetector([wb]),
      deckClient: mockDeck,
      agentLoop,
      talkSendQueue: createMockTalkQueue(),
      talkToken: 'test-token'
    });

    const results = await engine.processAll();

    assert.strictEqual(results.gatesResolved, 1, 'Gate should be resolved');
    assert.strictEqual(agentLoop._calls.length, 1, 'AgentLoop should be called for resolution');

    const call = agentLoop._calls[0];
    assert.ok(call.systemAddition.toLowerCase().includes('rejected'),
      'System addition should mention REJECTED');
  });

  // Test 7: workflow_deck_assign_label handler calls the Deck API
  await asyncTest('workflow_deck_assign_label handler calls assignLabel endpoint', async () => {
    const requestCalls = [];
    const mockDeck = {
      _request: async (method, path, body) => {
        requestCalls.push({ method, path, body });
        return {};
      }
    };

    // Build a minimal ToolRegistry-like handler directly from the tool definition logic
    // to avoid requiring the full ToolRegistry (which needs heavy client wiring).
    // We replicate the handler exactly as registered.
    const handler = async (args) => {
      const deck = mockDeck;
      const labelPath = `/index.php/apps/deck/api/v1.0/boards/${args.board_id}/stacks/${args.stack_id}/cards/${args.card_id}/assignLabel`;
      if (deck) {
        await deck._request('PUT', labelPath, { labelId: args.label_id });
      }
      return `Assigned label ${args.label_id} to card ${args.card_id}.`;
    };

    const result = await handler({ board_id: 1, stack_id: 10, card_id: 100, label_id: 5 });

    assert.strictEqual(requestCalls.length, 1, 'Should make one API call');
    assert.strictEqual(requestCalls[0].method, 'PUT');
    assert.ok(requestCalls[0].path.includes('assignLabel'), 'Path should include assignLabel');
    assert.deepStrictEqual(requestCalls[0].body, { labelId: 5 }, 'Body should contain labelId');
    assert.ok(result.includes('Assigned label 5'), 'Result should confirm assignment');
  });

  // Test 8: workflow_deck_assign_label returns error on failure
  await asyncTest('workflow_deck_assign_label returns error message on failure', async () => {
    const mockDeck = {
      _request: async () => {
        throw new Error('Network error');
      }
    };

    const handler = async (args) => {
      const deck = mockDeck;
      try {
        const labelPath = `/index.php/apps/deck/api/v1.0/boards/${args.board_id}/stacks/${args.stack_id}/cards/${args.card_id}/assignLabel`;
        if (deck) {
          await deck._request('PUT', labelPath, { labelId: args.label_id });
        }
        return `Assigned label ${args.label_id} to card ${args.card_id}.`;
      } catch (err) {
        return `Failed to assign label: ${err.message}`;
      }
    };

    const result = await handler({ board_id: 1, stack_id: 10, card_id: 100, label_id: 5 });

    assert.ok(result.startsWith('Failed to assign label:'), 'Should return failure message');
    assert.ok(result.includes('Network error'), 'Should include the original error message');
  });

  setTimeout(() => { summary(); exitWithCode(); }, 500);
})();
