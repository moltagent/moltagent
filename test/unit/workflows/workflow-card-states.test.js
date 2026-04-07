'use strict';

/**
 * AGPL-3.0 License
 * Copyright (C) 2024 Moltagent Contributors
 *
 * workflow-card-states.test.js
 *
 * Tests for SCHEDULED label, ERROR label with retry backoff,
 * priority chain ordering, and PAUSED escalation suppression.
 *
 * These tests exercise the new card state handlers added to WorkflowEngine
 * without duplicating the existing workflow-engine.test.js coverage.
 */

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

/**
 * Create a mock DeckClient with full support for label ops and card updates.
 * Tracks all _request calls so tests can inspect what the engine called.
 */
function createMockDeck() {
  const comments = [];
  const requestCalls = [];
  return {
    getComments: async () => comments,
    addComment: async (cardId, msg) => {
      comments.push({ cardId, actorId: 'moltagent', message: msg });
    },
    getBoard: async (boardId) => ({
      id: boardId,
      labels: [
        { id: 1, title: 'GATE',      color: 'E9967A' },
        { id: 2, title: 'APPROVED',  color: '4CAF50' },
        { id: 3, title: 'REJECTED',  color: 'F44336' },
        { id: 4, title: 'PAUSED',    color: '90A4AE' },
        { id: 5, title: 'SCHEDULED', color: '0097A7' },
        { id: 6, title: 'ERROR',     color: 'B71C1C' }
      ]
    }),
    _request: async (method, path, body) => {
      requestCalls.push({ method, path, body });
      // GET for card data (used by _updateCardDueDate / scheduleCard)
      if (method === 'GET') {
        return { title: 'Card', type: 'plain', owner: '', description: '', duedate: null };
      }
      return {};
    },
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

function createMockAgentLoopThrowing(errorMessage) {
  const calls = [];
  return {
    processWorkflowTask: async (params) => {
      calls.push(params);
      throw new Error(errorMessage);
    },
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

/**
 * Build a label array entry (as Deck API returns).
 */
function label(title) {
  const map = { GATE: 1, APPROVED: 2, REJECTED: 3, PAUSED: 4, SCHEDULED: 5, ERROR: 6 };
  return { id: map[title] || 99, title, color: '000000' };
}

/**
 * Create a minimal card for testing.
 */
function makeCard(overrides = {}) {
  return {
    id: overrides.id || 100,
    title: overrides.title || 'Test Card',
    description: overrides.description || '',
    labels: overrides.labels || [],
    duedate: overrides.duedate !== undefined ? overrides.duedate : null,
    assignedUsers: overrides.assignedUsers || [],
    lastModified: overrides.lastModified || new Date().toISOString(),
    archived: false,
    deletedAt: null,
    ...overrides
  };
}

/**
 * Create a minimal workflow board descriptor for tests.
 */
function makeWorkflowBoard(cards = [], overrides = {}) {
  const rulesCard = { id: 900, title: 'WORKFLOW: pipeline', description: 'RULES: Process cards.', labels: [] };
  const stack = { id: 10, title: 'Inbox', cards: [rulesCard, ...cards] };
  return {
    board: { id: 1, title: 'Test Workflow' },
    stacks: [stack],
    description: 'WORKFLOW: pipeline\nRULES: Process cards.',
    workflowType: 'pipeline',
    boardId: 1,
    rulesCardId: 900,
    ...overrides
  };
}

/**
 * Create a WorkflowEngine wired with provided mocks (no disk persistence).
 */
function makeEngine({ detector, deck, agent, talkQueue, config } = {}) {
  return new WorkflowEngine({
    workflowDetector: detector || createMockDetector([]),
    deckClient: deck || createMockDeck(),
    agentLoop: agent || createMockAgentLoop(),
    talkSendQueue: talkQueue || createMockTalkQueue(),
    talkToken: 'test-room-token',
    config: config || {}
    // No config.dataDir → no disk persistence
  });
}

(async () => {
  console.log('\n=== Workflow Card States Tests ===\n');

  // ─── SCHEDULED Label ───────────────────────────────────────────────────

  // Test 1: SCHEDULED card with future due date is skipped
  await asyncTest('SCHEDULED card with future due date is skipped', async () => {
    const agent = createMockAgentLoop();
    const tomorrow = new Date(Date.now() + 86400000).toISOString();
    const card = makeCard({ labels: [label('SCHEDULED')], duedate: tomorrow });
    const wb = makeWorkflowBoard([card]);

    const engine = makeEngine({
      detector: createMockDetector([wb]),
      agent
    });

    const results = await engine.processAll();

    // Card must not be processed (SCHEDULED, not yet due)
    assert.strictEqual(agent._calls.length, 0, 'AgentLoop must not be called for future SCHEDULED card');
    assert.strictEqual(results.cardsProcessed, 0);
  });

  // Test 2: SCHEDULED card with past due date has SCHEDULED label removed
  await asyncTest('SCHEDULED card with past due date has label removed', async () => {
    const agent = createMockAgentLoop();
    const deck = createMockDeck();
    const yesterday = new Date(Date.now() - 86400000).toISOString();
    const card = makeCard({ labels: [label('SCHEDULED')], duedate: yesterday });
    const wb = makeWorkflowBoard([card]);

    const engine = makeEngine({
      detector: createMockDetector([wb]),
      deck,
      agent
    });

    await engine.processAll();

    // The SCHEDULED label must have been removed: DELETE to assignLabel endpoint with labelId=5
    const removeCalls = deck._requestCalls.filter(r =>
      r.method === 'DELETE' && r.path.includes('/assignLabel') && r.body && r.body.labelId === 5
    );
    assert.ok(removeCalls.length > 0, 'SCHEDULED label (id=5) must be removed via DELETE /assignLabel');
  });

  // Test 3: SCHEDULED card with no due date is skipped with warning
  await asyncTest('SCHEDULED card with no due date is skipped', async () => {
    const agent = createMockAgentLoop();
    const card = makeCard({ labels: [label('SCHEDULED')], duedate: null });
    const wb = makeWorkflowBoard([card]);

    const engine = makeEngine({
      detector: createMockDetector([wb]),
      agent
    });

    const results = await engine.processAll();

    // Card must be skipped — no processing
    assert.strictEqual(agent._calls.length, 0, 'AgentLoop must not be called for SCHEDULED card with no due date');
    assert.strictEqual(results.cardsProcessed, 0);
  });

  // Test 4: PAUSED + SCHEDULED → PAUSED wins, SCHEDULED label not removed
  await asyncTest('PAUSED + SCHEDULED: PAUSED wins, SCHEDULED not removed', async () => {
    const agent = createMockAgentLoop();
    const deck = createMockDeck();
    const yesterday = new Date(Date.now() - 86400000).toISOString();
    // Card has both PAUSED and SCHEDULED, with past due date
    const card = makeCard({ labels: [label('PAUSED'), label('SCHEDULED')], duedate: yesterday });
    const wb = makeWorkflowBoard([card]);

    const engine = makeEngine({
      detector: createMockDetector([wb]),
      deck,
      agent
    });

    await engine.processAll();

    // PAUSED wins — card must be skipped, no SCHEDULED removal
    assert.strictEqual(agent._calls.length, 0, 'AgentLoop must not be called — PAUSED wins');
    const removeCalls = deck._requestCalls.filter(r =>
      r.method === 'DELETE' && r.path.includes('/assignLabel') && r.body && r.body.labelId === 5
    );
    assert.strictEqual(removeCalls.length, 0, 'SCHEDULED label must NOT be removed when PAUSED wins');
  });

  // Test 5: scheduleCard() rejects an invalid (non-date) value
  // NOTE: The implementation only guards against NaN dates (not past dates).
  // Calling with an invalid string results in isNaN → throws.
  await asyncTest('scheduleCard() rejects invalid date string', async () => {
    const deck = createMockDeck();
    const engine = makeEngine({ deck });

    const wb = makeWorkflowBoard([]);
    const stack = wb.stacks[0];
    const card = makeCard();

    let threw = false;
    try {
      await engine.scheduleCard(wb, stack, card, 'not-a-date');
    } catch (err) {
      threw = true;
      assert.ok(err.message.includes('valid date'), `Expected "valid date" in error but got: ${err.message}`);
    }
    assert.ok(threw, 'scheduleCard must throw for invalid date input');
  });

  // Test 6: scheduleCard() sets due date AND SCHEDULED label
  await asyncTest('scheduleCard() sets due date and SCHEDULED label', async () => {
    const deck = createMockDeck();
    const engine = makeEngine({ deck });

    const wb = makeWorkflowBoard([]);
    const stack = wb.stacks[0];
    const card = makeCard({ id: 200 });
    const activateAt = new Date(Date.now() + 3600000); // 1 hour from now

    await engine.scheduleCard(wb, stack, card, activateAt);

    // Must add SCHEDULED label (PUT /assignLabel with labelId=5)
    const labelAdds = deck._requestCalls.filter(r =>
      r.method === 'PUT' && r.path.includes('/assignLabel') && r.body && r.body.labelId === 5
    );
    assert.ok(labelAdds.length > 0, 'SCHEDULED label (id=5) must be added via PUT /assignLabel');

    // Must set duedate on card (PUT .../cards/200 with duedate)
    const dueDateSets = deck._requestCalls.filter(r =>
      r.method === 'PUT' && r.path.includes(`/cards/${card.id}`) &&
      !r.path.includes('/assignLabel') && !r.path.includes('/assignUser') &&
      r.body && r.body.duedate
    );
    assert.ok(dueDateSets.length > 0, 'Card due date must be set via PUT .../cards/:id');
    assert.ok(dueDateSets[0].body.duedate.includes('T'), 'Due date must be ISO 8601');
  });

  // ─── ERROR Label ───────────────────────────────────────────────────────

  // Test 7: Processing failure adds ERROR label + error comment
  await asyncTest('Processing failure adds ERROR label and comment', async () => {
    const deck = createMockDeck();
    const agent = createMockAgentLoopThrowing('Simulated processing failure');
    const card = makeCard({ id: 300, lastModified: new Date().toISOString() });
    const wb = makeWorkflowBoard([card]);

    const engine = makeEngine({
      detector: createMockDetector([wb]),
      deck,
      agent
    });

    await engine.processAll();

    // ERROR label must have been added (PUT /assignLabel with labelId=6)
    const errorLabelAdds = deck._requestCalls.filter(r =>
      r.method === 'PUT' && r.path.includes('/assignLabel') && r.body && r.body.labelId === 6
    );
    assert.ok(errorLabelAdds.length > 0, 'ERROR label (id=6) must be added after processing failure');

    // Comment with error message must be posted
    const errorComments = deck._comments.filter(c =>
      c.message && c.message.includes('Simulated processing failure')
    );
    assert.ok(errorComments.length > 0, 'Error comment must be posted on card');
  });

  // Test 8: ERROR card with retryCount=1 retries on next pulse (immediate retry)
  await asyncTest('ERROR card with retryCount=1 retries on next pulse', async () => {
    const agent = createMockAgentLoop();
    const card = makeCard({
      id: 400,
      labels: [label('ERROR')],
      lastModified: new Date().toISOString()
    });
    const wb = makeWorkflowBoard([card]);

    const engine = makeEngine({
      detector: createMockDetector([wb]),
      agent
    });

    // Seed error state: retryCount=1 means first failure already happened.
    // lastAttempt far enough in the past that retry is ready (1 pulse = 5 min ago+).
    const pastAttempt = Date.now() - 6 * 60 * 1000; // 6 minutes ago
    engine._setErrorState(1, 400, {
      retryCount: 1,
      lastError: 'previous error',
      lastAttempt: pastAttempt,
      permanent: false
    });

    await engine.processAll();

    // Card should be processed (retry attempt)
    assert.strictEqual(agent._calls.length, 1, 'ERROR card with retryCount=1 should be retried');
    assert.strictEqual(agent._calls[0].cardId, 400);
  });

  // Test 9: ERROR card with retryCount=2 skips one pulse (needs 2 pulse intervals)
  await asyncTest('ERROR card with retryCount=2 skips one pulse when last attempt was recent', async () => {
    const agent = createMockAgentLoop();
    const card = makeCard({
      id: 500,
      labels: [label('ERROR')],
      lastModified: new Date().toISOString()
    });
    const wb = makeWorkflowBoard([card]);

    const engine = makeEngine({
      detector: createMockDetector([wb]),
      agent,
      config: { pulseIntervalMs: 300000 } // 5 minutes
    });

    // Seed error state: retryCount=2 → needs 2 * 5min = 10 min wait
    // lastAttempt was 6 minutes ago → NOT yet ready
    const recentAttempt = Date.now() - 6 * 60 * 1000;
    engine._setErrorState(1, 500, {
      retryCount: 2,
      lastError: 'second failure',
      lastAttempt: recentAttempt,
      permanent: false
    });

    await engine.processAll();

    // Card must NOT be processed this pulse
    assert.strictEqual(agent._calls.length, 0, 'ERROR card with retryCount=2 must be skipped during back-off');
  });

  // Test 10: Third error → permanent failure + Talk notification
  await asyncTest('Third processing failure marks card permanent and sends Talk notification', async () => {
    const deck = createMockDeck();
    const agent = createMockAgentLoopThrowing('Third strike failure');
    const talkQueue = createMockTalkQueue();
    // Card already carries ERROR label — two previous failures have already stamped it
    const card = makeCard({ id: 600, labels: [label('ERROR')], lastModified: new Date().toISOString() });
    const wb = makeWorkflowBoard([card]);

    const engine = makeEngine({
      detector: createMockDetector([wb]),
      deck,
      agent,
      talkQueue
    });

    // Seed state: 2 failures already happened (retryCount=2), retry is now ready
    engine._setErrorState(1, 600, {
      retryCount: 2,
      lastError: 'second failure',
      lastAttempt: Date.now() - 15 * 60 * 1000, // 15 min ago → ready
      permanent: false
    });

    await engine.processAll();

    // State must now be permanent
    const state = engine._getErrorState(1, 600);
    assert.ok(state && state.permanent === true, 'Error state must be permanent after 3rd failure');
    assert.ok(state.retryCount >= 3, 'retryCount must be at least 3');

    // Talk notification must have been sent
    assert.ok(talkQueue._messages.length > 0, 'Talk notification must be sent on permanent failure');
    assert.ok(
      talkQueue._messages.some(m => m.msg.includes('permanently failed') || m.msg.toLowerCase().includes('permanent')),
      'Talk message must mention permanent failure'
    );
  });

  // Test 11: Human removes ERROR label → error state is cleared, card processes normally
  await asyncTest('Removing ERROR label resets error state and allows processing', async () => {
    const agent = createMockAgentLoop();
    // Card has NO ERROR label (human removed it), but engine has error state
    const card = makeCard({
      id: 700,
      labels: [],
      lastModified: new Date().toISOString()
    });
    const wb = makeWorkflowBoard([card]);

    const engine = makeEngine({
      detector: createMockDetector([wb]),
      agent
    });

    // Seed error state (as if 2 failures happened)
    engine._setErrorState(1, 700, {
      retryCount: 2,
      lastError: 'old error',
      lastAttempt: Date.now() - 60000,
      permanent: false
    });

    await engine.processAll();

    // Error state must be cleared
    const state = engine._getErrorState(1, 700);
    assert.strictEqual(state, null, 'Error state must be cleared when ERROR label is absent');

    // Card must process normally
    assert.strictEqual(agent._calls.length, 1, 'Card must be processed after error state cleared');
  });

  // Test 12: Error comment is posted with attempt number and error message
  await asyncTest('_handleProcessingError posts comment with attempt count and error message', async () => {
    const deck = createMockDeck();
    const agent = createMockAgentLoopThrowing('Specific failure message');
    const card = makeCard({ id: 800, lastModified: new Date().toISOString() });
    const wb = makeWorkflowBoard([card]);

    const engine = makeEngine({
      detector: createMockDetector([wb]),
      deck,
      agent
    });

    await engine.processAll();

    // Comment must include attempt number and specific error text
    const errorComment = deck._comments.find(c =>
      c.message && c.message.includes('Specific failure message')
    );
    assert.ok(errorComment, 'Comment must include the specific error message');
    assert.ok(
      errorComment.message.includes('1/3') || errorComment.message.includes('attempt'),
      'Comment must include attempt count indicator'
    );
  });

  // ─── Priority Chain ────────────────────────────────────────────────────

  // Test 13: Priority order: PAUSED checked before SCHEDULED
  await asyncTest('PAUSED is checked before SCHEDULED in priority chain', async () => {
    const agent = createMockAgentLoop();
    const deck = createMockDeck();
    const yesterday = new Date(Date.now() - 86400000).toISOString();
    // Card has PAUSED label only (no SCHEDULED)
    const card = makeCard({
      id: 900,
      labels: [label('PAUSED')],
      duedate: yesterday
    });
    const wb = makeWorkflowBoard([card]);

    const engine = makeEngine({
      detector: createMockDetector([wb]),
      deck,
      agent
    });

    await engine.processAll();

    // Card must be skipped — PAUSED wins
    assert.strictEqual(agent._calls.length, 0, 'PAUSED card must be skipped');
    // No label removal calls (SCHEDULED handler must not run)
    const scheduledRemovals = deck._requestCalls.filter(r =>
      r.method === 'DELETE' && r.path.includes('/assignLabel') && r.body && r.body.labelId === 5
    );
    assert.strictEqual(scheduledRemovals.length, 0, 'SCHEDULED handler must not run when card is PAUSED');
  });

  // Test 14: Priority order: SCHEDULED checked before ERROR
  await asyncTest('SCHEDULED is checked before ERROR in priority chain', async () => {
    const agent = createMockAgentLoop();
    const deck = createMockDeck();
    const tomorrow = new Date(Date.now() + 86400000).toISOString();
    // Card has both SCHEDULED (future) and ERROR labels
    const card = makeCard({
      id: 1000,
      labels: [label('SCHEDULED'), label('ERROR')],
      duedate: tomorrow
    });
    const wb = makeWorkflowBoard([card]);

    const engine = makeEngine({
      detector: createMockDetector([wb]),
      deck,
      agent
    });

    await engine.processAll();

    // SCHEDULED fires first — card is skipped (future due date)
    // The ERROR handler must not have processed the card
    assert.strictEqual(agent._calls.length, 0, 'Card with future SCHEDULED must be skipped before ERROR check');
  });

  // Test 15: Priority order: ERROR checked before GATE
  await asyncTest('ERROR permanent card is skipped before GATE processing', async () => {
    const agent = createMockAgentLoop();
    const talkQueue = createMockTalkQueue();
    // Card has both ERROR and GATE labels; error state is permanent
    const card = makeCard({
      id: 1100,
      labels: [label('ERROR'), label('GATE')],
      duedate: null
    });
    const wb = makeWorkflowBoard([card]);

    const engine = makeEngine({
      detector: createMockDetector([wb]),
      agent,
      talkQueue
    });

    // Seed permanent error state
    engine._setErrorState(1, 1100, {
      retryCount: 3,
      lastError: 'permanent',
      lastAttempt: Date.now() - 60000,
      permanent: true
    });

    await engine.processAll();

    // Permanent ERROR → card skipped, GATE not processed
    assert.strictEqual(agent._calls.length, 0, 'Permanent ERROR card must be skipped');
    // No GATE Talk notification should be sent
    const gateNotifications = talkQueue._messages.filter(m =>
      m.msg.toLowerCase().includes('gate') || m.msg.includes('GATE')
    );
    assert.strictEqual(gateNotifications.length, 0, 'GATE notification must not be sent for permanent ERROR card');
  });

  // ─── PAUSED Escalation Suppression ─────────────────────────────────────

  // Test 16: PAUSED card with overdue date does NOT trigger escalation
  await asyncTest('PAUSED card suppresses overdue escalation', async () => {
    const talkQueue = createMockTalkQueue();
    const overdue = new Date(Date.now() - 3 * 3600000).toISOString(); // 3 hours ago
    const card = makeCard({
      id: 1200,
      labels: [label('PAUSED')],
      duedate: overdue
    });
    const wb = makeWorkflowBoard([card]);

    const engine = makeEngine({
      detector: createMockDetector([wb]),
      talkQueue
    });

    const results = await engine.processAll();

    assert.strictEqual(results.escalations, 0, 'PAUSED card must not generate escalation');
    const escalationMessages = talkQueue._messages.filter(m =>
      m.msg.includes('Overdue') || m.msg.includes('overdue') || m.msg.includes('past due')
    );
    assert.strictEqual(escalationMessages.length, 0, 'No escalation Talk message for PAUSED card');
  });

  // Test 17: Non-PAUSED card with overdue date DOES trigger escalation
  await asyncTest('Non-PAUSED overdue card triggers escalation', async () => {
    const talkQueue = createMockTalkQueue();
    const agent = createMockAgentLoop();
    // Card is already marked processed to avoid triggering _processCard; just test escalation
    const overdue = new Date(Date.now() - 3 * 3600000).toISOString(); // 3 hours overdue
    const card = makeCard({
      id: 1300,
      labels: [],
      duedate: overdue,
      lastModified: new Date(Date.now() - 86400000).toISOString() // modified yesterday
    });
    const wb = makeWorkflowBoard([card]);

    const engine = makeEngine({
      detector: createMockDetector([wb]),
      agent,
      talkQueue
    });

    // Pre-mark as processed so the card loop skips _processCard but still checks escalation
    engine._markProcessed(1, card, wb.stacks[0]);

    const results = await engine.processAll();

    assert.strictEqual(results.escalations, 1, 'Overdue non-PAUSED card must generate 1 escalation');
    const escalationMessages = talkQueue._messages.filter(m =>
      m.msg.includes('Overdue') || m.msg.includes('past due') || m.msg.includes('hours')
    );
    assert.ok(escalationMessages.length > 0, 'Escalation Talk message must be sent');
  });

  // ─── Backward Compatibility ────────────────────────────────────────────

  // Test 18: Legacy processed-cards entries (plain number) still work
  test('Legacy processed-cards entries (plain number) are handled by _shouldProcess', () => {
    const engine = makeEngine();

    // Manually seed a legacy processed-cards entry (plain Unix-second timestamp)
    const futureModified = Math.floor(Date.now() / 1000) + 1000; // modified in the future
    engine._processedCards.set('1:100:10', Math.floor(Date.now() / 1000) - 60); // processed 60s ago

    // Card modified before the processed timestamp → should NOT reprocess
    const oldCard = makeCard({ id: 100, lastModified: Math.floor(Date.now() / 1000) - 120 });
    assert.strictEqual(
      engine._shouldProcess(1, oldCard, { id: 10 }),
      false,
      'Card modified before last-processed must be skipped'
    );

    // Card modified after the processed timestamp → should reprocess
    const newCard = makeCard({ id: 100, lastModified: new Date(Date.now() + 2000000).toISOString() });
    assert.strictEqual(
      engine._shouldProcess(1, newCard, { id: 10 }),
      true,
      'Card modified after last-processed must be re-processed'
    );

    // _getErrorState on a never-errored card returns null (not zero)
    assert.strictEqual(
      engine._getErrorState(1, 100),
      null,
      '_getErrorState must return null for cards with no error state'
    );
  });

  // ─── Fail-safe: unresolvable rules card ──────────────────────────────

  await asyncTest('Board with unresolvable rulesCardId is treated as PAUSED (fail-safe)', async () => {
    const agent = createMockAgentLoop();
    const card = makeCard({ labels: [] });
    const wb = makeWorkflowBoard([card], { rulesCardId: 9999 });
    // Remove the auto-injected rules card so 9999 is unresolvable
    wb.stacks[0].cards = wb.stacks[0].cards.filter(c => c.id !== 900);

    const engine = makeEngine({
      detector: createMockDetector([wb]),
      agent
    });

    const results = await engine.processAll();
    assert.strictEqual(agent._calls.length, 0, 'No cards should be processed when rules card is unresolvable');
    assert.strictEqual(results.cardsProcessed, 0);
  });

  await asyncTest('Board with null rulesCardId is treated as PAUSED (fail-safe)', async () => {
    const agent = createMockAgentLoop();
    const card = makeCard({ labels: [] });
    const wb = makeWorkflowBoard([card], { rulesCardId: null });
    // Remove the auto-injected rules card
    wb.stacks[0].cards = wb.stacks[0].cards.filter(c => c.id !== 900);

    const engine = makeEngine({
      detector: createMockDetector([wb]),
      agent
    });

    const results = await engine.processAll();
    assert.strictEqual(agent._calls.length, 0, 'No cards should be processed when rulesCardId is null');
    assert.strictEqual(results.cardsProcessed, 0);
  });

  summary();
  exitWithCode();
})();
