'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const WorkflowBoardDetector = require('../../../src/lib/workflows/workflow-board-detector');

// --- Mock DeckClient ---
function createMockDeck(boards, boardDetails = {}, stacksByBoard = {}) {
  return {
    listBoards: async () => boards,
    getBoard: async (id) => boardDetails[id] || { id, title: `Board ${id}` },
    getStacks: async (id) => stacksByBoard[id] || []
  };
}

(async () => {
  console.log('\n=== WorkflowBoardDetector Tests ===\n');

  // Test 1: Detects boards with WORKFLOW: prefix in rules card
  await asyncTest('Detects boards with WORKFLOW: prefix in rules card title', async () => {
    const mockDeck = createMockDeck(
      [
        { id: 1 },
        { id: 2 },
        { id: 3 }
      ],
      {
        1: { id: 1, title: 'Pipeline Board' },
        2: { id: 2, title: 'Regular Board' },
        3: { id: 3, title: 'Procedure Board' }
      },
      {
        1: [{ id: 10, title: 'Inbox', cards: [
          { id: 100, title: 'WORKFLOW: pipeline', description: 'RULES: ...' }
        ] }],
        2: [{ id: 20, title: 'Stack', cards: [
          { id: 200, title: 'Regular card', description: 'No workflow here' }
        ] }],
        3: [{ id: 30, title: 'Step 1', cards: [
          { id: 300, title: 'WORKFLOW: procedure', description: 'Do stuff.' }
        ] }]
      }
    );

    const detector = new WorkflowBoardDetector({ deckClient: mockDeck });
    const boards = await detector.getWorkflowBoards();

    assert.strictEqual(boards.length, 2, 'Should find 2 workflow boards');
    assert.strictEqual(boards[0].boardId, 1);
    assert.strictEqual(boards[0].rulesCardId, 100);
    assert.strictEqual(boards[1].boardId, 3);
    assert.strictEqual(boards[1].rulesCardId, 300);
  });

  // Test 2: Ignores non-workflow boards
  await asyncTest('Ignores boards without WORKFLOW: prefix in any card', async () => {
    const mockDeck = createMockDeck(
      [
        { id: 1 },
        { id: 2 },
        { id: 3 }
      ],
      {
        1: { id: 1, title: 'My Tasks' },
        2: { id: 2, title: 'Empty Board' },
        3: { id: 3, title: 'Almost Workflow' }
      },
      {
        1: [{ id: 10, title: 'Stack', cards: [
          { id: 100, title: 'Regular task', description: 'Do something' }
        ] }],
        2: [{ id: 20, title: 'Stack', cards: [] }],
        3: [{ id: 30, title: 'Stack', cards: [
          { id: 300, title: 'WORKFLOWish: not really', description: 'Not a workflow' }
        ] }]
      }
    );

    const detector = new WorkflowBoardDetector({ deckClient: mockDeck });
    const boards = await detector.getWorkflowBoards();

    assert.strictEqual(boards.length, 0, 'Should find 0 workflow boards');
  });

  // Test 3: Extracts workflow type (pipeline/procedure)
  await asyncTest('Extracts workflow type correctly', async () => {
    const mockDeck = createMockDeck(
      [
        { id: 1 },
        { id: 2 },
        { id: 3 }
      ],
      {
        1: { id: 1, title: 'P1' },
        2: { id: 2, title: 'P2' },
        3: { id: 3, title: 'P3' }
      },
      {
        1: [{ id: 10, title: 'Stack', cards: [
          { id: 100, title: 'WORKFLOW: pipeline', description: 'Cards flow through.' }
        ] }],
        2: [{ id: 20, title: 'Stack', cards: [
          { id: 200, title: 'WORKFLOW: procedure', description: 'Steps in order.' }
        ] }],
        3: [{ id: 30, title: 'Stack', cards: [
          { id: 300, title: 'WORKFLOW: something else', description: 'Custom.' }
        ] }]
      }
    );

    const detector = new WorkflowBoardDetector({ deckClient: mockDeck });
    const boards = await detector.getWorkflowBoards();

    assert.strictEqual(boards[0].workflowType, 'pipeline');
    assert.strictEqual(boards[1].workflowType, 'procedure');
    assert.strictEqual(boards[2].workflowType, 'unknown');
  });

  // Test 4: Case-insensitive detection
  await asyncTest('Case-insensitive WORKFLOW: detection', async () => {
    const mockDeck = createMockDeck(
      [
        { id: 1 },
        { id: 2 },
        { id: 3 }
      ],
      {
        1: { id: 1, title: 'B1' },
        2: { id: 2, title: 'B2' },
        3: { id: 3, title: 'B3' }
      },
      {
        1: [{ id: 10, title: 'Stack', cards: [
          { id: 100, title: 'workflow: Pipeline', description: 'Rules here.' }
        ] }],
        2: [{ id: 20, title: 'Stack', cards: [
          { id: 200, title: 'Workflow: PROCEDURE', description: 'Steps here.' }
        ] }],
        3: [{ id: 30, title: 'Stack', cards: [
          { id: 300, title: 'WORKFLOW: pipeline', description: 'Standard.' }
        ] }]
      }
    );

    const detector = new WorkflowBoardDetector({ deckClient: mockDeck });
    const boards = await detector.getWorkflowBoards();

    assert.strictEqual(boards.length, 3, 'Should find all 3 case variants');
  });

  // Test 5: Cache invalidates after TTL
  await asyncTest('Cache respects TTL and invalidation', async () => {
    let callCount = 0;
    const mockDeck = {
      listBoards: async () => { callCount++; return []; },
      getBoard: async () => ({}),
      getStacks: async () => []
    };

    const detector = new WorkflowBoardDetector({ deckClient: mockDeck });

    await detector.getWorkflowBoards();
    assert.strictEqual(callCount, 1, 'First call should query API');

    await detector.getWorkflowBoards();
    assert.strictEqual(callCount, 1, 'Second call should use cache');

    detector.invalidateCache();
    await detector.getWorkflowBoards();
    assert.strictEqual(callCount, 2, 'After invalidation should query API again');
  });

  summary();
  exitWithCode();
})();
