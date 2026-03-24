'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const WorkflowEngine = require('../../../src/lib/workflows/workflow-engine');

// --- Mock Factories ---

function createMockDetector(boards = []) {
  return {
    getWorkflowBoards: async () => boards,
    invalidateCache: () => {}
  };
}

function createMockDeck() {
  const comments = [];
  return {
    getComments: async () => comments,
    addComment: async (cardId, msg) => { comments.push({ actorId: 'moltagent', message: msg }); },
    _comments: comments
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

(async () => {
  console.log('\n=== WorkflowEngine Tests ===\n');

  // Test 1: processAll returns empty results for no workflow boards
  await asyncTest('processAll() returns empty results when no workflow boards exist', async () => {
    const engine = new WorkflowEngine({
      workflowDetector: createMockDetector([]),
      deckClient: createMockDeck(),
      agentLoop: createMockAgentLoop(),
      talkSendQueue: createMockTalkQueue(),
      talkToken: 'test-token'
    });

    const results = await engine.processAll();

    assert.strictEqual(results.boardsProcessed, 0);
    assert.strictEqual(results.cardsProcessed, 0);
    assert.strictEqual(results.gatesFound, 0);
    assert.strictEqual(results.errors.length, 0);
  });

  // Test 2: Card processing through AgentLoop
  await asyncTest('processAll() processes non-GATE cards through AgentLoop', async () => {
    const agentLoop = createMockAgentLoop();
    const engine = new WorkflowEngine({
      workflowDetector: createMockDetector([{
        board: { id: 1, title: 'Test Workflow' },
        stacks: [{
          id: 10, title: 'Inbox',
          cards: [
            { id: 100, title: 'Test Card', description: 'Do something', labels: [], lastModified: new Date().toISOString() }
          ]
        }],
        description: 'WORKFLOW: pipeline\nRULES: Process cards.',
        workflowType: 'pipeline',
        boardId: 1
      }]),
      deckClient: createMockDeck(),
      agentLoop,
      talkSendQueue: createMockTalkQueue(),
      talkToken: 'test-token'
    });

    const results = await engine.processAll();

    assert.strictEqual(results.boardsProcessed, 1);
    assert.strictEqual(results.cardsProcessed, 1);
    assert.strictEqual(agentLoop._calls.length, 1, 'AgentLoop should be called once');
    assert.strictEqual(agentLoop._calls[0].boardId, 1);
    assert.strictEqual(agentLoop._calls[0].cardId, 100);
  });

  // Test 3: GATE card identification and notification
  await asyncTest('processAll() identifies GATE cards and sends notification', async () => {
    const mockDeck = createMockDeck();
    const talkQueue = createMockTalkQueue();

    const engine = new WorkflowEngine({
      workflowDetector: createMockDetector([{
        board: { id: 1, title: 'Test Workflow' },
        stacks: [{
          id: 10, title: 'Review',
          cards: [
            { id: 200, title: 'GATE: Approval Required', description: 'Wait for human', labels: [] }
          ]
        }],
        description: 'WORKFLOW: pipeline',
        workflowType: 'pipeline',
        boardId: 1
      }]),
      deckClient: mockDeck,
      agentLoop: createMockAgentLoop(),
      talkSendQueue: talkQueue,
      talkToken: 'test-token'
    });

    const results = await engine.processAll();

    assert.strictEqual(results.gatesFound, 1, 'Should detect 1 GATE');
    assert.strictEqual(mockDeck._comments.length, 1, 'Should add GATE comment');
    assert.ok(mockDeck._comments[0].message.includes('GATE'), 'Comment should mention GATE');
    assert.strictEqual(talkQueue._messages.length, 1, 'Should send Talk notification');
  });

  // Test 4: _shouldProcess skips already-processed cards
  await asyncTest('_shouldProcess() skips already-processed unchanged cards', async () => {
    const agentLoop = createMockAgentLoop();
    const past = new Date(Date.now() - 60000).toISOString();

    const engine = new WorkflowEngine({
      workflowDetector: createMockDetector([{
        board: { id: 1, title: 'Test' },
        stacks: [{
          id: 10, title: 'Inbox',
          cards: [{ id: 100, title: 'Card', description: '', labels: [], lastModified: past }]
        }],
        description: 'WORKFLOW: pipeline',
        workflowType: 'pipeline',
        boardId: 1
      }]),
      deckClient: createMockDeck(),
      agentLoop,
      talkSendQueue: createMockTalkQueue(),
      talkToken: 'test-token'
    });

    await engine.processAll();
    assert.strictEqual(agentLoop._calls.length, 1, 'First run should process card');

    await engine.processAll();
    assert.strictEqual(agentLoop._calls.length, 1, 'Second run should skip unchanged card');
  });

  // Test 5: _isPastDue correctly identifies overdue cards
  test('_isPastDue() correctly identifies overdue cards', () => {
    const engine = new WorkflowEngine({
      workflowDetector: createMockDetector(),
      deckClient: createMockDeck(),
      agentLoop: createMockAgentLoop(),
      talkSendQueue: createMockTalkQueue(),
      talkToken: 'test-token'
    });

    const pastDate = new Date(Date.now() - 86400000).toISOString();
    const futureDate = new Date(Date.now() + 86400000).toISOString();

    assert.strictEqual(engine._isPastDue(pastDate), true, 'Past date should be overdue');
    assert.strictEqual(engine._isPastDue(futureDate), false, 'Future date should not be overdue');
  });

  // Test 6: MODEL directive parsing
  test('_getRoleForCard() parses MODEL directive from card and board', () => {
    const engine = new WorkflowEngine({
      workflowDetector: createMockDetector(),
      deckClient: createMockDeck(),
      agentLoop: createMockAgentLoop(),
      talkSendQueue: createMockTalkQueue(),
      talkToken: 'test-token'
    });

    // Card-level override
    const wb = { description: 'WORKFLOW: pipeline' };
    const cardSovereign = { description: 'Do task.\nMODEL: sovereign' };
    const result1 = engine._getRoleForCard(wb, cardSovereign);
    assert.strictEqual(result1.forceLocal, true, 'sovereign should force local');

    // Board-level MODEL: auto
    const wbExplicitAuto = { description: 'WORKFLOW: pipeline\nMODEL: auto\nRULES: ...' };
    const cardNone = { description: 'Just a task' };
    const result2 = engine._getRoleForCard(wbExplicitAuto, cardNone);
    assert.strictEqual(result2.forceLocal, false, 'auto should not force local');

    // No MODEL directive (implicit auto)
    const wbAuto = { description: 'WORKFLOW: pipeline\nRULES: ...' };
    const result3 = engine._getRoleForCard(wbAuto, cardNone);
    assert.strictEqual(result3.forceLocal, false, 'auto should not force local');
    assert.strictEqual(result3.role, 'workflow_cloud');
  });

  // Test 7: Rules card is skipped during processing
  await asyncTest('processAll() skips the rules card itself', async () => {
    const agentLoop = createMockAgentLoop();
    const engine = new WorkflowEngine({
      workflowDetector: createMockDetector([{
        board: { id: 1, title: 'Test Workflow' },
        stacks: [{
          id: 10, title: 'Inbox',
          cards: [
            { id: 100, title: 'WORKFLOW: pipeline', description: 'RULES: Process cards.', labels: [] },
            { id: 101, title: 'Regular Card', description: 'Do something', labels: [], lastModified: new Date().toISOString() }
          ]
        }],
        description: 'RULES: Process cards.',
        workflowType: 'pipeline',
        boardId: 1,
        rulesCardId: 100
      }]),
      deckClient: createMockDeck(),
      agentLoop,
      talkSendQueue: createMockTalkQueue(),
      talkToken: 'test-token'
    });

    const results = await engine.processAll();

    assert.strictEqual(results.cardsProcessed, 1, 'Should process only 1 card');
    assert.strictEqual(agentLoop._calls.length, 1, 'AgentLoop should be called once');
    assert.strictEqual(agentLoop._calls[0].cardId, 101, 'Should process regular card, not rules card');
  });

  // Test 8: Iteration cap is passed to processWorkflowTask (pipeline=3)
  await asyncTest('_processCard() passes maxIterations=3 for pipeline boards', async () => {
    const agentLoop = createMockAgentLoop();
    const engine = new WorkflowEngine({
      workflowDetector: createMockDetector([{
        board: { id: 1, title: 'Pipeline Board' },
        stacks: [{
          id: 10, title: 'Inbox',
          cards: [{ id: 100, title: 'Card', description: '', labels: [], lastModified: new Date().toISOString() }]
        }],
        description: 'WORKFLOW: pipeline\nRULES: Process cards.',
        workflowType: 'pipeline',
        boardId: 1
      }]),
      deckClient: createMockDeck(),
      agentLoop,
      talkSendQueue: createMockTalkQueue(),
      talkToken: 'test-token'
    });

    await engine.processAll();

    assert.strictEqual(agentLoop._calls.length, 1);
    assert.strictEqual(agentLoop._calls[0].maxIterations, 3, 'Pipeline should get maxIterations=3');
  });

  // Test 9: Iteration cap is passed to processWorkflowTask (procedure=5)
  await asyncTest('_processCard() passes maxIterations=5 for procedure boards', async () => {
    const agentLoop = createMockAgentLoop();
    const engine = new WorkflowEngine({
      workflowDetector: createMockDetector([{
        board: { id: 2, title: 'Procedure Board' },
        stacks: [{
          id: 20, title: 'Step 1',
          cards: [{ id: 200, title: 'Procedure Card', description: '', labels: [], lastModified: new Date().toISOString() }]
        }],
        description: 'WORKFLOW: procedure\nRULES: Follow steps.',
        workflowType: 'procedure',
        boardId: 2
      }]),
      deckClient: createMockDeck(),
      agentLoop,
      talkSendQueue: createMockTalkQueue(),
      talkToken: 'test-token'
    });

    await engine.processAll();

    assert.strictEqual(agentLoop._calls.length, 1);
    assert.strictEqual(agentLoop._calls[0].maxIterations, 5, 'Procedure should get maxIterations=5');
  });

  // Test 10: Budget check forces local when exceeded
  await asyncTest('_processCard() forces local when budget exceeded', async () => {
    const agentLoop = createMockAgentLoop();
    const mockBudgetEnforcer = {
      canSpend: (provider, cost) => ({ allowed: false, reason: 'daily_budget_exceeded' })
    };

    const engine = new WorkflowEngine({
      workflowDetector: createMockDetector([{
        board: { id: 1, title: 'Cloud Board' },
        stacks: [{
          id: 10, title: 'Inbox',
          cards: [{ id: 100, title: 'Expensive Card', description: '', labels: [], lastModified: new Date().toISOString() }]
        }],
        description: 'WORKFLOW: pipeline\nMODEL: auto\nRULES: Process.',
        workflowType: 'pipeline',
        boardId: 1
      }]),
      deckClient: createMockDeck(),
      agentLoop,
      talkSendQueue: createMockTalkQueue(),
      talkToken: 'test-token',
      budgetEnforcer: mockBudgetEnforcer
    });

    await engine.processAll();

    assert.strictEqual(agentLoop._calls.length, 1);
    assert.strictEqual(agentLoop._calls[0].forceLocal, true, 'Should force local when budget exceeded');
  });

  // Test 11: Budget check allows cloud when within budget
  await asyncTest('_processCard() allows cloud when within budget', async () => {
    const agentLoop = createMockAgentLoop();
    const mockBudgetEnforcer = {
      canSpend: (provider, cost) => ({ allowed: true })
    };

    const engine = new WorkflowEngine({
      workflowDetector: createMockDetector([{
        board: { id: 1, title: 'Cloud Board' },
        stacks: [{
          id: 10, title: 'Inbox',
          cards: [{ id: 100, title: 'Cheap Card', description: '', labels: [], lastModified: new Date().toISOString() }]
        }],
        description: 'WORKFLOW: pipeline\nMODEL: auto\nRULES: Process.',
        workflowType: 'pipeline',
        boardId: 1
      }]),
      deckClient: createMockDeck(),
      agentLoop,
      talkSendQueue: createMockTalkQueue(),
      talkToken: 'test-token',
      budgetEnforcer: mockBudgetEnforcer
    });

    await engine.processAll();

    assert.strictEqual(agentLoop._calls.length, 1);
    assert.strictEqual(agentLoop._calls[0].forceLocal, false, 'Should allow cloud when within budget');
  });

  // Test 12: _resolveDirective for local, auto, sovereign
  test('_resolveDirective() returns correct config for local, auto, sovereign', () => {
    const engine = new WorkflowEngine({
      workflowDetector: createMockDetector(),
      deckClient: createMockDeck(),
      agentLoop: createMockAgentLoop(),
      talkSendQueue: createMockTalkQueue(),
      talkToken: 'test-token'
    });

    const localResult = engine._resolveDirective('local');
    assert.strictEqual(localResult.role, 'workflow_cloud', 'local should map to workflow_cloud');
    assert.strictEqual(localResult.forceLocal, true, 'local should force local');

    const autoResult = engine._resolveDirective('auto');
    assert.strictEqual(autoResult.role, 'workflow_cloud', 'auto should map to workflow_cloud');
    assert.strictEqual(autoResult.forceLocal, false, 'auto should not force local');

    const sovereignResult = engine._resolveDirective('sovereign');
    assert.strictEqual(sovereignResult.role, 'agent_loop', 'sovereign should stay agent_loop');
    assert.strictEqual(sovereignResult.forceLocal, true);
  });

  // Test 13: System default role is workflow_cloud
  test('_getRoleForCard() defaults to workflow_cloud when no MODEL directive', () => {
    const engine = new WorkflowEngine({
      workflowDetector: createMockDetector(),
      deckClient: createMockDeck(),
      agentLoop: createMockAgentLoop(),
      talkSendQueue: createMockTalkQueue(),
      talkToken: 'test-token'
    });

    const wb = { description: 'WORKFLOW: pipeline\nRULES: ...' };
    const card = { description: 'Just a task' };
    const result = engine._getRoleForCard(wb, card);
    assert.strictEqual(result.role, 'workflow_cloud', 'Default should be workflow_cloud');
    assert.strictEqual(result.forceLocal, false);
  });

  // --- Card Hygiene: _isDoneStack ---

  test('_isDoneStack() recognizes Done/Live/Won/Resolved/Track stacks', () => {
    const engine = new WorkflowEngine({
      workflowDetector: createMockDetector(),
      deckClient: createMockDeck(),
      agentLoop: createMockAgentLoop(),
      talkSendQueue: createMockTalkQueue(),
      talkToken: 'test-token'
    });

    const wb = { board: { id: 1 }, stacks: [] };
    assert.strictEqual(engine._isDoneStack(wb, { title: '✅ Done' }), true);
    assert.strictEqual(engine._isDoneStack(wb, { title: '✅ Live' }), true);
    assert.strictEqual(engine._isDoneStack(wb, { title: '🎉 Won' }), true);
    assert.strictEqual(engine._isDoneStack(wb, { title: '✅ Resolved' }), true);
    assert.strictEqual(engine._isDoneStack(wb, { title: '📊 Track' }), true);
    assert.strictEqual(engine._isDoneStack(wb, { title: '📥 Inbox' }), false);
    assert.strictEqual(engine._isDoneStack(wb, { title: '🔧 Setup' }), false);
    assert.strictEqual(engine._isDoneStack(wb, { title: '✋ Review' }), false);
  });

  // --- Card Hygiene: _ensureDueDate ---

  await asyncTest('_ensureDueDate() skips cards that already have due dates', async () => {
    const mockDeck = createMockDeck();
    mockDeck._request = async () => ({});
    const engine = new WorkflowEngine({
      workflowDetector: createMockDetector(),
      deckClient: mockDeck,
      agentLoop: createMockAgentLoop(),
      talkSendQueue: createMockTalkQueue(),
      talkToken: 'test-token'
    });

    const requestCalls = [];
    mockDeck._request = async (method, path, body) => {
      requestCalls.push({ method, path, body });
      return {};
    };

    const card = { id: 100, title: 'Has Due', duedate: '2026-03-01T00:00:00Z' };
    const wb = { board: { id: 1 }, stacks: [], description: 'WORKFLOW: pipeline' };
    const stack = { id: 10, title: 'Inbox' };

    await engine._ensureDueDate(wb, stack, card);

    const putCalls = requestCalls.filter(c => c.method === 'PUT');
    assert.strictEqual(putCalls.length, 0, 'Should not update card that already has due date');
  });

  await asyncTest('_ensureDueDate() sets 7-day default for active non-GATE cards', async () => {
    const mockDeck = createMockDeck();
    const requestCalls = [];
    mockDeck._request = async (method, path, body) => {
      requestCalls.push({ method, path, body });
      if (method === 'GET') return { title: 'Test Card', type: 'plain', owner: '', description: '' };
      return {};
    };

    const engine = new WorkflowEngine({
      workflowDetector: createMockDetector(),
      deckClient: mockDeck,
      agentLoop: createMockAgentLoop(),
      talkSendQueue: createMockTalkQueue(),
      talkToken: 'test-token'
    });

    const card = { id: 100, title: 'Active Card', labels: [] };
    const wb = { board: { id: 1 }, stacks: [], description: 'WORKFLOW: pipeline' };
    const stack = { id: 10, title: 'Inbox' };

    await engine._ensureDueDate(wb, stack, card);

    const putCall = requestCalls.find(c => c.method === 'PUT');
    assert.ok(putCall, 'Should PUT to update card');
    const duedate = new Date(putCall.body.duedate);
    const daysDiff = (duedate.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    assert.ok(daysDiff > 6.5 && daysDiff < 7.5, `Should be ~7 days from now, got ${daysDiff.toFixed(1)}`);
  });

  await asyncTest('_ensureDueDate() sets 2-day for GATE cards', async () => {
    const mockDeck = createMockDeck();
    const requestCalls = [];
    mockDeck._request = async (method, path, body) => {
      requestCalls.push({ method, path, body });
      if (method === 'GET') return { title: 'GATE Card', type: 'plain', owner: '', description: '' };
      return {};
    };

    const engine = new WorkflowEngine({
      workflowDetector: createMockDetector(),
      deckClient: mockDeck,
      agentLoop: createMockAgentLoop(),
      talkSendQueue: createMockTalkQueue(),
      talkToken: 'test-token'
    });

    const card = { id: 200, title: 'GATE: Approval Required', description: 'Wait for human', labels: [] };
    const wb = { board: { id: 1 }, stacks: [], description: 'WORKFLOW: pipeline' };
    const stack = { id: 10, title: 'Review' };

    await engine._ensureDueDate(wb, stack, card);

    const putCall = requestCalls.find(c => c.method === 'PUT');
    assert.ok(putCall, 'Should PUT to update GATE card');
    const duedate = new Date(putCall.body.duedate);
    const daysDiff = (duedate.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    assert.ok(daysDiff > 1.5 && daysDiff < 2.5, `Should be ~2 days from now, got ${daysDiff.toFixed(1)}`);
  });

  await asyncTest('_ensureDueDate() sets today for Done-stack cards', async () => {
    const mockDeck = createMockDeck();
    const requestCalls = [];
    mockDeck._request = async (method, path, body) => {
      requestCalls.push({ method, path, body });
      if (method === 'GET') return { title: 'Done Card', type: 'plain', owner: '', description: '' };
      return {};
    };

    const engine = new WorkflowEngine({
      workflowDetector: createMockDetector(),
      deckClient: mockDeck,
      agentLoop: createMockAgentLoop(),
      talkSendQueue: createMockTalkQueue(),
      talkToken: 'test-token'
    });

    const card = { id: 300, title: 'Completed task', labels: [] };
    const wb = { board: { id: 1 }, stacks: [], description: 'WORKFLOW: pipeline' };
    const stack = { id: 10, title: '✅ Done' };

    await engine._ensureDueDate(wb, stack, card);

    const putCall = requestCalls.find(c => c.method === 'PUT');
    assert.ok(putCall, 'Should PUT to update Done card');
    const duedate = new Date(putCall.body.duedate);
    const daysDiff = Math.abs(duedate.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    assert.ok(daysDiff < 0.1, `Should be ~today, got ${daysDiff.toFixed(2)} days away`);
  });

  // --- Card Hygiene: _ensureAssignment ---

  await asyncTest('_ensureAssignment() assigns bot for active, human for GATE', async () => {
    const mockDeck = createMockDeck();
    const requestCalls = [];
    mockDeck._request = async (method, path, body) => {
      requestCalls.push({ method, path, body });
      return {};
    };

    const engine = new WorkflowEngine({
      workflowDetector: createMockDetector(),
      deckClient: mockDeck,
      agentLoop: createMockAgentLoop(),
      talkSendQueue: createMockTalkQueue(),
      talkToken: 'test-token',
      config: { adminUser: 'funana' }
    });

    const wb = { board: { id: 1 }, stacks: [], description: 'WORKFLOW: pipeline' };
    const stack = { id: 10, title: 'Inbox' };

    // Active card -> bot
    const activeCard = { id: 100, title: 'Regular Task', labels: [] };
    await engine._ensureAssignment(wb, stack, activeCard);

    let putCall = requestCalls.find(c => c.method === 'PUT' && c.path.includes('/assignUser'));
    assert.ok(putCall, 'Should assign user for active card');
    assert.strictEqual(putCall.body.userId, 'moltagent', 'Active card should be assigned to bot');

    requestCalls.length = 0;

    // GATE card -> human
    const gateCard = { id: 200, title: 'GATE: Review', description: 'Wait for human', labels: [] };
    await engine._ensureAssignment(wb, stack, gateCard);

    putCall = requestCalls.find(c => c.method === 'PUT' && c.path.includes('/assignUser'));
    assert.ok(putCall, 'Should assign user for GATE card');
    assert.strictEqual(putCall.body.userId, 'funana', 'GATE card should be assigned to admin');
  });

  await asyncTest('_ensureAssignment() skips cards that are already assigned', async () => {
    const mockDeck = createMockDeck();
    const requestCalls = [];
    mockDeck._request = async (method, path, body) => {
      requestCalls.push({ method, path, body });
      return {};
    };

    const engine = new WorkflowEngine({
      workflowDetector: createMockDetector(),
      deckClient: mockDeck,
      agentLoop: createMockAgentLoop(),
      talkSendQueue: createMockTalkQueue(),
      talkToken: 'test-token'
    });

    const wb = { board: { id: 1 }, stacks: [], description: 'WORKFLOW: pipeline' };
    const stack = { id: 10, title: 'Inbox' };
    const card = { id: 100, title: 'Assigned Card', labels: [], assignedUsers: [{ participant: { uid: 'someone' } }] };

    await engine._ensureAssignment(wb, stack, card);

    const putCalls = requestCalls.filter(c => c.method === 'PUT');
    assert.strictEqual(putCalls.length, 0, 'Should not reassign already-assigned card');
  });

  await asyncTest('_ensureAssignment() skips Done stack cards', async () => {
    const mockDeck = createMockDeck();
    const requestCalls = [];
    mockDeck._request = async (method, path, body) => {
      requestCalls.push({ method, path, body });
      return {};
    };

    const engine = new WorkflowEngine({
      workflowDetector: createMockDetector(),
      deckClient: mockDeck,
      agentLoop: createMockAgentLoop(),
      talkSendQueue: createMockTalkQueue(),
      talkToken: 'test-token'
    });

    const wb = { board: { id: 1 }, stacks: [], description: 'WORKFLOW: pipeline' };
    const stack = { id: 10, title: '✅ Done' };
    const card = { id: 100, title: 'Done Card', labels: [] };

    await engine._ensureAssignment(wb, stack, card);

    const putCalls = requestCalls.filter(c => c.method === 'PUT');
    assert.strictEqual(putCalls.length, 0, 'Should not assign Done stack cards');
  });

  // --- Card Hygiene: _archiveStaleDoneCards ---

  await asyncTest('_archiveStaleDoneCards() archives old cards, skips fresh ones', async () => {
    const mockDeck = createMockDeck();
    const requestCalls = [];
    mockDeck._request = async (method, path, body) => {
      requestCalls.push({ method, path, body });
      if (method === 'GET') return { title: 'Old card', type: 'plain', owner: '', description: '', duedate: null };
      return {};
    };

    const engine = new WorkflowEngine({
      workflowDetector: createMockDetector(),
      deckClient: mockDeck,
      agentLoop: createMockAgentLoop(),
      talkSendQueue: createMockTalkQueue(),
      talkToken: 'test-token',
      config: { archiveAfterDays: 30 }
    });

    const oldDate = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString(); // 45 days ago
    const freshDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(); // 5 days ago

    const wb = {
      board: { id: 1, title: 'Test' },
      stacks: [{
        id: 10, title: '✅ Done',
        cards: [
          { id: 100, title: 'Old Done Card', lastModified: oldDate },
          { id: 101, title: 'Fresh Done Card', lastModified: freshDate },
          { id: 102, title: 'Archived Card', lastModified: oldDate, archived: true }
        ]
      }, {
        id: 20, title: 'Inbox',
        cards: [
          { id: 200, title: 'Active Card', lastModified: oldDate }
        ]
      }],
      description: 'WORKFLOW: pipeline'
    };

    await engine._archiveStaleDoneCards(wb);

    // Should only archive the old non-archived Done card
    const putCalls = requestCalls.filter(c => c.method === 'PUT');
    assert.strictEqual(putCalls.length, 1, 'Should archive exactly 1 card');
    assert.strictEqual(putCalls[0].body.archived, true, 'Should set archived=true');
  });

  await asyncTest('_archiveStaleDoneCards() never archives rules card', async () => {
    const mockDeck = createMockDeck();
    const requestCalls = [];
    mockDeck._request = async (method, path, body) => {
      requestCalls.push({ method, path, body });
      return {};
    };

    const engine = new WorkflowEngine({
      workflowDetector: createMockDetector(),
      deckClient: mockDeck,
      agentLoop: createMockAgentLoop(),
      talkSendQueue: createMockTalkQueue(),
      talkToken: 'test-token',
      config: { archiveAfterDays: 30 }
    });

    const oldDate = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();

    const wb = {
      board: { id: 1, title: 'Test' },
      stacks: [{
        id: 10, title: '✅ Done',
        cards: [
          { id: 999, title: 'WORKFLOW: pipeline', lastModified: oldDate }
        ]
      }],
      description: 'WORKFLOW: pipeline',
      rulesCardId: 999
    };

    await engine._archiveStaleDoneCards(wb);

    const putCalls = requestCalls.filter(c => c.method === 'PUT');
    assert.strictEqual(putCalls.length, 0, 'Should never archive the rules card');
  });

  // --- _getHumanUser ---

  test('_getHumanUser() returns configured admin or default', () => {
    const engine1 = new WorkflowEngine({
      workflowDetector: createMockDetector(),
      deckClient: createMockDeck(),
      agentLoop: createMockAgentLoop(),
      talkSendQueue: createMockTalkQueue(),
      talkToken: 'test-token',
      config: { adminUser: 'funana' }
    });
    assert.strictEqual(engine1._getHumanUser(), 'funana');

    const engine2 = new WorkflowEngine({
      workflowDetector: createMockDetector(),
      deckClient: createMockDeck(),
      agentLoop: createMockAgentLoop(),
      talkSendQueue: createMockTalkQueue(),
      talkToken: 'test-token'
    });
    assert.strictEqual(engine2._getHumanUser(), 'admin');
  });

  // ─── _extractStackLlmRouting tests ────────────────────────────────────

  await asyncTest('_extractStackLlmRouting: extracts LLM: cloud from CONFIG card', async () => {
    const engine = new WorkflowEngine({
      workflowDetector: createMockDetector([]),
      deckClient: createMockDeck(),
      agentLoop: createMockAgentLoop(),
      talkSendQueue: createMockTalkQueue(),
      talkToken: 'test-token'
    });

    const configCard = { description: 'Criteria: only tech articles\nLLM: cloud\nMax: 5 items' };
    const result = engine._extractStackLlmRouting(configCard);
    assert.strictEqual(result.allowCloud, true);
  });

  await asyncTest('_extractStackLlmRouting: LLM: local returns allowCloud false', async () => {
    const engine = new WorkflowEngine({
      workflowDetector: createMockDetector([]),
      deckClient: createMockDeck(),
      agentLoop: createMockAgentLoop(),
      talkSendQueue: createMockTalkQueue(),
      talkToken: 'test-token'
    });

    const configCard = { description: 'Criteria: sensitive data\nLLM: local' };
    const result = engine._extractStackLlmRouting(configCard);
    assert.strictEqual(result.allowCloud, false);
  });

  await asyncTest('_extractStackLlmRouting: no LLM line defaults to false', async () => {
    const engine = new WorkflowEngine({
      workflowDetector: createMockDetector([]),
      deckClient: createMockDeck(),
      agentLoop: createMockAgentLoop(),
      talkSendQueue: createMockTalkQueue(),
      talkToken: 'test-token'
    });

    assert.strictEqual(engine._extractStackLlmRouting({ description: 'Just criteria' }).allowCloud, false);
    assert.strictEqual(engine._extractStackLlmRouting(null).allowCloud, false);
    assert.strictEqual(engine._extractStackLlmRouting({}).allowCloud, false);
  });

  await asyncTest('_extractStackLlmRouting: handles HTML CONFIG card', async () => {
    const engine = new WorkflowEngine({
      workflowDetector: createMockDetector([]),
      deckClient: createMockDeck(),
      agentLoop: createMockAgentLoop(),
      talkSendQueue: createMockTalkQueue(),
      talkToken: 'test-token'
    });

    const configCard = { description: '<p>Criteria: tech only</p><p>LLM: cloud</p>' };
    const result = engine._extractStackLlmRouting(configCard);
    assert.strictEqual(result.allowCloud, true);
  });

  // ─── allowCloud propagation to AgentLoop ─────────────────────────────

  await asyncTest('_processCard passes allowCloud from CONFIG card to AgentLoop', async () => {
    const agentLoop = createMockAgentLoop();
    const engine = new WorkflowEngine({
      workflowDetector: createMockDetector([{
        board: { id: 1, title: 'Content Pipeline' },
        stacks: [{
          id: 10, title: 'Intelligence',
          cards: [
            { id: 99, title: 'CONFIG: Intelligence settings', description: 'Criteria: AI news only\nLLM: cloud', archived: false, deletedAt: null },
            { id: 100, title: 'Test Article', description: 'Some content', labels: [], lastModified: new Date().toISOString() }
          ]
        }],
        description: 'WORKFLOW: pipeline\nRULES: Process.',
        workflowType: 'pipeline',
        boardId: 1
      }]),
      deckClient: createMockDeck(),
      agentLoop,
      talkSendQueue: createMockTalkQueue(),
      talkToken: 'test-token'
    });

    await engine.processAll();
    assert.ok(agentLoop._calls.length >= 1, 'AgentLoop should be called');
    const call = agentLoop._calls[0];
    assert.strictEqual(call.allowCloud, true, 'allowCloud should be true from CONFIG card');
  });

  await asyncTest('_processCard defaults allowCloud to false without LLM: line', async () => {
    const agentLoop = createMockAgentLoop();
    const engine = new WorkflowEngine({
      workflowDetector: createMockDetector([{
        board: { id: 1, title: 'Pipeline' },
        stacks: [{
          id: 10, title: 'Inbox',
          cards: [
            { id: 100, title: 'Test Card', description: 'content', labels: [], lastModified: new Date().toISOString() }
          ]
        }],
        description: 'WORKFLOW: pipeline\nRULES: Process.',
        workflowType: 'pipeline',
        boardId: 1
      }]),
      deckClient: createMockDeck(),
      agentLoop,
      talkSendQueue: createMockTalkQueue(),
      talkToken: 'test-token'
    });

    await engine.processAll();
    assert.ok(agentLoop._calls.length >= 1);
    assert.strictEqual(agentLoop._calls[0].allowCloud, false, 'allowCloud defaults false');
  });

  summary();
  exitWithCode();
})();
