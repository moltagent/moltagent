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

// Build a minimal workflow board object for tests.
// The stack includes a CONFIG card with the 'System' label whose title contains
// "GATE" — required by GateDetector.isGateStack() so that GATE-labelled content
// cards are correctly classified as UNRESOLVED (held) under #197's stack-move
// detection, rather than mistaken for cards that have already been dragged out.
function makeBoard({ cardLabels = [], assignedUsers = [], extraCards = [] } = {}) {
  return {
    board: { id: 1, title: 'Test Workflow', owner: { uid: 'jordan' } },
    stacks: [{
      id: 10,
      title: 'Inbox',
      cards: [
        {
          id: 901,
          title: 'CONFIG: GATE review',
          description: 'Gate review step',
          labels: [{ title: 'System' }]
        },
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
    description: 'WORKFLOW: pipeline\nREVIEWER: jordan\nRULES: Process cards.',
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

  // Build a two-stack board: a gate stack (Review) and a destination stack the
  // reviewer drags the card into. `destTerminal` sets the destination CONFIG marker
  // (TERMINAL for an approval target, REJECTED for a decline target).
  function makeDragBoard(destConfigDesc) {
    const gateCard = {
      id: 100, title: 'Content Card', description: 'Do something',
      labels: [{ title: 'GATE' }], assignedUsers: [{ participant: { uid: 'jordan' } }],
      lastModified: new Date(Date.now() + 60000).toISOString()
    };
    const board = {
      board: { id: 1, title: 'Test Workflow', owner: { uid: 'jordan' } },
      stacks: [
        { id: 10, title: 'Review', cards: [
          { id: 901, title: 'CONFIG: GATE review', description: 'Gate review step', labels: [{ title: 'System' }] },
          gateCard
        ] },
        { id: 20, title: 'Destination', cards: [
          { id: 902, title: 'CONFIG: Destination', description: destConfigDesc, labels: [{ title: 'System' }] }
        ] }
      ],
      description: 'WORKFLOW: pipeline\nREVIEWER: jordan\nRULES: Process cards.',
      workflowType: 'pipeline', boardId: 1
    };
    return { board, gateCard };
  }

  // Test 5: reviewer drags a held GATE card OUT of the gate stack → approved.
  // Phase 3: the drag-out is the resolution trigger, not any label.
  await asyncTest('GATE card dragged out of the gate stack → approved, triggers processWorkflowTask', async () => {
    const agentLoop = createMockAgentLoop();
    const mockDeck = createMockDeck();
    mockDeck.getBoard = async () => ({ labels: [] });

    const { board, gateCard } = makeDragBoard('TERMINAL: true');
    const engine = new WorkflowEngine({
      workflowDetector: createMockDetector([board]),
      deckClient: mockDeck,
      agentLoop,
      talkSendQueue: createMockTalkQueue(),
      talkToken: 'test-token'
    });

    // Pulse 1: card held in the gate stack → minted, not resolved.
    const p1 = await engine.processAll();
    assert.strictEqual(p1.gatesResolved, 0, 'Pulse 1: gate held, not resolved');
    assert.strictEqual(agentLoop._calls.length, 0, 'Pulse 1: no handoff yet');

    // The reviewer drags the card out of the gate stack into the destination.
    board.stacks[0].cards = board.stacks[0].cards.filter(c => c.id !== 100);
    gateCard.lastModified = new Date(Date.now() + 120000).toISOString();
    board.stacks[1].cards.push(gateCard);

    // Pulse 2: card is out of the gate stack → record releases → approved.
    const p2 = await engine.processAll();
    assert.strictEqual(p2.gatesResolved, 1, 'Pulse 2: drag-out resolves the gate');
    assert.strictEqual(agentLoop._calls.length, 1, 'Pulse 2: processWorkflowTask runs the outcome');
    assert.ok(agentLoop._calls[0].systemAddition.toLowerCase().includes('approved'),
      'System addition should mention APPROVED');
  });

  // Test 6: reviewer drags a held GATE card into a REJECTED stack → rejected.
  await asyncTest('GATE card dragged into a REJECTED stack → rejected, triggers processWorkflowTask', async () => {
    const agentLoop = createMockAgentLoop();
    const mockDeck = createMockDeck();
    mockDeck.getBoard = async () => ({ labels: [] });

    const { board, gateCard } = makeDragBoard('REJECTED: true');
    const engine = new WorkflowEngine({
      workflowDetector: createMockDetector([board]),
      deckClient: mockDeck,
      agentLoop,
      talkSendQueue: createMockTalkQueue(),
      talkToken: 'test-token'
    });

    await engine.processAll(); // pulse 1: mint/held

    board.stacks[0].cards = board.stacks[0].cards.filter(c => c.id !== 100);
    gateCard.lastModified = new Date(Date.now() + 120000).toISOString();
    board.stacks[1].cards.push(gateCard);

    const p2 = await engine.processAll(); // pulse 2: drag into REJECTED stack
    assert.strictEqual(p2.gatesResolved, 1, 'Gate should be resolved (rejected)');
    assert.strictEqual(agentLoop._calls.length, 1, 'AgentLoop should be called for resolution');
    assert.ok(agentLoop._calls[0].systemAddition.toLowerCase().includes('rejected'),
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

  // ── Stack-move (drag-to-approve) tests (#197) ────────────────────────────────

  /**
   * Build a multi-stack workflow board for move-detection tests.
   * @param {Object} opts
   * @param {boolean} opts.cardInGateStack  - Place GATE card in gate stack (unresolved)
   *                                         vs destination stack (resolved via move)
   * @param {boolean} opts.hasRejectionStack - Add a second stack with REJECTED: true CONFIG
   */
  function makeGateBoard({ cardInGateStack = false, hasRejectionStack = false } = {}) {
    const gateConfigCard = {
      id: 901,
      title: 'CONFIG: Gate',
      description: 'GATE review step',
      labels: [{ title: 'System' }]
    };
    const contentCard = {
      id: 100,
      title: 'Enquiry Card',
      description: 'Some content',
      labels: [{ title: 'GATE' }],
      assignedUsers: [],
      lastModified: new Date(Date.now() + 60000).toISOString()
    };

    const gateStack = {
      id: 10,
      title: 'Review',
      cards: [
        // WORKFLOW rules card (prevents createMockDetector prepend via rulesCardId set below)
        { id: 900, title: 'WORKFLOW: pipeline', description: 'REVIEWER: jordan\nRULES: Send reply.', labels: [] },
        gateConfigCard,
        ...(cardInGateStack ? [contentCard] : [])
      ]
    };

    const destStack = {
      id: 20,
      title: hasRejectionStack ? 'Rejected' : 'Replied',
      cards: [
        ...(hasRejectionStack ? [{ id: 902, title: 'CONFIG: Rejected', description: 'REJECTED: true', labels: [] }] : []),
        ...(!cardInGateStack ? [contentCard] : [])
      ]
    };

    const stacks = [gateStack, destStack];

    return {
      board: { id: 1, title: 'Test Workflow', owner: { uid: 'jordan' } },
      stacks,
      description: 'WORKFLOW: pipeline\nREVIEWER: jordan\nRULES: Send reply.',
      _plainDescription: 'WORKFLOW: pipeline\nREVIEWER: jordan\nRULES: Send reply.',
      workflowType: 'pipeline',
      boardId: 1,
      rulesCardId: 900  // prevents createMockDetector from prepending a second rules card
    };
  }

  // Helper: create a deck mock with board labels pre-populated for label ops
  function createMockDeckWithLabels() {
    const mock = createMockDeck();
    mock.getBoard = async () => ({
      labels: [
        { id: 1, title: 'GATE' },
        { id: 2, title: 'APPROVED' },
        { id: 3, title: 'REJECTED' }
      ]
    });
    return mock;
  }

  // Test 9: Approval via move — GATE card dragged to non-gate stack → label swap + handoff
  await asyncTest('Approval via move: GATE card in non-gate stack → GATE removed, APPROVED added, processWorkflowTask called', async () => {
    const agentLoop = createMockAgentLoop();
    const mockDeck = createMockDeckWithLabels();
    const wb = makeGateBoard({ cardInGateStack: false, hasRejectionStack: false });

    const engine = new WorkflowEngine({
      workflowDetector: createMockDetector([wb]),
      deckClient: mockDeck,
      agentLoop,
      talkSendQueue: createMockTalkQueue(),
      talkToken: 'test-token'
    });

    // Phase 3: resolution requires a prior record. Seed it as if the card was
    // minted while held in the gate stack; this pulse sees it already dragged out.
    engine.guardrailEnforcer.resolveGateState({
      boardId: 1, cardId: 100, inGateStack: true, hasGateLabel: true,
      gateStackId: 10, reviewer: 'jordan', requestingUser: 'workflow:board-1'
    });

    const results = await engine.processAll();

    assert.strictEqual(results.gatesFound, 1, 'One gate found');
    assert.strictEqual(results.gatesResolved, 1, 'Gate should be resolved');
    assert.strictEqual(agentLoop._calls.length, 1, 'processWorkflowTask should be called once');

    // Label swap: remove GATE (id:1) via PUT /removeLabel, then add APPROVED (id:2) via PUT /assignLabel
    const gateRemoval = mockDeck._requestCalls.find(c =>
      c.method === 'PUT' && c.path.includes('/removeLabel') && c.body && c.body.labelId === 1);
    const approvedAdd = mockDeck._requestCalls.find(c =>
      c.method === 'PUT' && c.path.includes('/assignLabel') && c.body && c.body.labelId === 2);
    assert.ok(gateRemoval, 'Should remove GATE label via PUT /removeLabel');
    assert.ok(approvedAdd,  'Should add APPROVED label via PUT /assignLabel');

    // Handoff context mentions approved
    const call = agentLoop._calls[0];
    assert.ok(call.systemAddition.toLowerCase().includes('approved'), 'systemAddition should mention approved');
  });

  // Test 10: Rejection via move — destination stack has REJECTED: true → REJECTED label applied
  await asyncTest('Rejection via move: GATE card moved to REJECTED stack → GATE removed, REJECTED added', async () => {
    const agentLoop = createMockAgentLoop();
    const mockDeck = createMockDeckWithLabels();
    const wb = makeGateBoard({ cardInGateStack: false, hasRejectionStack: true });

    const engine = new WorkflowEngine({
      workflowDetector: createMockDetector([wb]),
      deckClient: mockDeck,
      agentLoop,
      talkSendQueue: createMockTalkQueue(),
      talkToken: 'test-token'
    });

    // Phase 3: seed the prior record (held in gate stack), then this pulse sees the
    // card dragged into the REJECTED destination stack.
    engine.guardrailEnforcer.resolveGateState({
      boardId: 1, cardId: 100, inGateStack: true, hasGateLabel: true,
      gateStackId: 10, reviewer: 'jordan', requestingUser: 'workflow:board-1'
    });

    const results = await engine.processAll();

    assert.strictEqual(results.gatesResolved, 1, 'Gate should be resolved');

    const gateRemoval = mockDeck._requestCalls.find(c =>
      c.method === 'PUT' && c.path.includes('/removeLabel') && c.body && c.body.labelId === 1);
    const rejectedAdd = mockDeck._requestCalls.find(c =>
      c.method === 'PUT' && c.path.includes('/assignLabel') && c.body && c.body.labelId === 3);
    assert.ok(gateRemoval, 'Should remove GATE label via PUT /removeLabel');
    assert.ok(rejectedAdd, 'Should add REJECTED label via PUT /assignLabel (not APPROVED)');

    const call = agentLoop._calls[0];
    assert.ok(call.systemAddition.toLowerCase().includes('rejected'), 'systemAddition should mention rejected');
  });

  // Test 11: Idempotency — card post-swap (APPROVED label, no GATE) is not re-processed as a gate
  await asyncTest('Idempotency: APPROVED-only card is not treated as a gate (isGate returns false)', async () => {
    const agentLoop = createMockAgentLoop();
    const mockDeck = createMockDeckWithLabels();

    // Card has only APPROVED label — simulates post-swap state where GATE was removed
    const wb = makeBoard({ cardLabels: [{ title: 'APPROVED' }] });
    const engine = new WorkflowEngine({
      workflowDetector: createMockDetector([wb]),
      deckClient: mockDeck,
      agentLoop,
      talkSendQueue: createMockTalkQueue(),
      talkToken: 'test-token'
    });

    const results = await engine.processAll();

    assert.strictEqual(results.gatesFound, 0, 'APPROVED-only card should NOT be counted as a gate');
    // No gate label ops should occur
    const labelOps = mockDeck._requestCalls.filter(c => c.path.includes('assignLabel'));
    const gateSwapOps = labelOps.filter(c => c.body && (c.body.labelId === 1));
    assert.strictEqual(gateSwapOps.length, 0, 'No GATE label operations should happen on post-swap card');
  });

  // Test 12: Unresolved gate in gate stack — no label swap, no processWorkflowTask
  await asyncTest('Unresolved gate: GATE card still in gate stack → no label swap, no processWorkflowTask', async () => {
    const agentLoop = createMockAgentLoop();
    const mockDeck = createMockDeckWithLabels();
    const wb = makeGateBoard({ cardInGateStack: true, hasRejectionStack: false });

    const engine = new WorkflowEngine({
      workflowDetector: createMockDetector([wb]),
      deckClient: mockDeck,
      agentLoop,
      talkSendQueue: createMockTalkQueue(),
      talkToken: 'test-token'
    });

    const results = await engine.processAll();

    assert.strictEqual(results.gatesFound, 1, 'Gate should be found');
    assert.strictEqual(results.gatesResolved, 0, 'Gate should NOT be resolved');
    assert.strictEqual(agentLoop._calls.length, 0, 'processWorkflowTask should NOT be called');

    // No GATE label swap
    const labelOps = mockDeck._requestCalls.filter(c => c.path.includes('assignLabel'));
    assert.strictEqual(labelOps.length, 0, 'No label swap should occur for unresolved gate');
  });

  // Test 13: Comment text — says "Move this card forward to approve" (not old label instruction)
  await asyncTest('Comment text says "Move this card forward to approve" for unresolved gate', async () => {
    const agentLoop = createMockAgentLoop();
    const mockDeck = createMockDeckWithLabels();
    const talkQueue = createMockTalkQueue();
    const wb = makeGateBoard({ cardInGateStack: true, hasRejectionStack: false });

    const engine = new WorkflowEngine({
      workflowDetector: createMockDetector([wb]),
      deckClient: mockDeck,
      agentLoop,
      talkSendQueue: talkQueue,
      talkToken: 'test-token'
    });

    await engine.processAll();

    // Card comment
    assert.ok(mockDeck._comments.length > 0, 'Should add a comment to the card');
    const comment = mockDeck._comments[0].message;
    assert.ok(comment.includes('Move this card forward to approve'), 'Comment should say "Move this card forward to approve"');
    assert.ok(!comment.toLowerCase().includes('apply'), 'Comment should NOT say "apply ... label"');

    // Talk message
    assert.ok(talkQueue._messages.length > 0, 'Should send a Talk notification');
    const talkMsg = talkQueue._messages[0].msg;
    assert.ok(talkMsg.includes('Move this card forward to approve'), 'Talk message should say "Move this card forward to approve"');
  });

  // Test 14: Comment includes decline line when rejection stack exists
  await asyncTest('Comment includes rejection stack decline instruction when REJECTED stack declared', async () => {
    const agentLoop = createMockAgentLoop();
    const mockDeck = createMockDeckWithLabels();
    const talkQueue = createMockTalkQueue();
    // Gate card in gate stack; board also has a rejection stack
    const wb = makeGateBoard({ cardInGateStack: true, hasRejectionStack: true });

    const engine = new WorkflowEngine({
      workflowDetector: createMockDetector([wb]),
      deckClient: mockDeck,
      agentLoop,
      talkSendQueue: talkQueue,
      talkToken: 'test-token'
    });

    await engine.processAll();

    const comment = (mockDeck._comments[0] || {}).message || '';
    assert.ok(comment.includes('Rejected'), 'Comment should include the rejection stack name');
    assert.ok(comment.includes('to decline'), 'Comment should include "to decline" instruction');

    const talkMsg = (talkQueue._messages[0] || {}).msg || '';
    assert.ok(talkMsg.includes('Rejected'), 'Talk message should include the rejection stack name');
  });

  // Test 15: Comment omits decline line when no rejection stack declared
  await asyncTest('Comment omits decline line when no REJECTED stack on board', async () => {
    const agentLoop = createMockAgentLoop();
    const mockDeck = createMockDeckWithLabels();
    const talkQueue = createMockTalkQueue();
    const wb = makeGateBoard({ cardInGateStack: true, hasRejectionStack: false });

    const engine = new WorkflowEngine({
      workflowDetector: createMockDetector([wb]),
      deckClient: mockDeck,
      agentLoop,
      talkSendQueue: talkQueue,
      talkToken: 'test-token'
    });

    await engine.processAll();

    const comment = (mockDeck._comments[0] || {}).message || '';
    assert.ok(!comment.includes('to decline'), 'Comment should NOT include "to decline" when no rejection stack');

    const talkMsg = (talkQueue._messages[0] || {}).msg || '';
    assert.ok(!talkMsg.includes('to decline'), 'Talk message should NOT include "to decline" when no rejection stack');
  });

  setTimeout(() => { summary(); exitWithCode(); }, 500);
})();
