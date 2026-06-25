'use strict';

/**
 * AGPL-3.0 License
 * Copyright (C) 2024 Moltagent Contributors
 *
 * email-trigger-bridge.test.js
 *
 * Tests for the Email-to-Card Trigger Bridge in WorkflowEngine.
 * Covers: TRIGGER: line parsing, email dedup (idempotency on Message-ID),
 * entry stack resolution, folder forwarding, fallback key, PAUSED gate,
 * card description footer, and dispatch-readiness for non-email kinds.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const WorkflowEngine = require('../../../src/lib/workflows/workflow-engine');

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

/** Minimal mock DeckClient — records createCardOnBoard calls. */
function createMockDeck(opts = {}) {
  const calls = [];
  return {
    createCardOnBoard: async (boardId, stackId, title, cardOpts) => {
      calls.push({ boardId, stackId, title, description: cardOpts && cardOpts.description });
      if (opts.returnNull) return null;
      return { id: 100 + calls.length };
    },
    _calls: calls
  };
}

/** Minimal mock EmailHandler — returns a fixture array. */
function createMockEmailHandler(emails = []) {
  const fetchCalls = [];
  return {
    _fetchEmails: async (options) => {
      fetchCalls.push(options);
      return emails;
    },
    _fetchCalls: fetchCalls
  };
}

/** Minimal mock AgentLoop (needed for WorkflowEngine constructor). */
function createMockAgentLoop() {
  return { processWorkflowTask: async () => 'done' };
}

/** Minimal mock TalkQueue. */
function createMockTalkQueue() {
  return { enqueue: async () => {} };
}

/**
 * Build a WorkflowBoard descriptor (wb) with a rules card that does NOT have
 * the PAUSED label, so _processBoard won't bail early.
 */
function makeWorkflowBoard({
  boardId = 1,
  description = 'WORKFLOW: pipeline',
  stacks = null,
  rulesCardId = 900,
  pauseRulesCard = false
} = {}) {
  const rulesCard = {
    id: rulesCardId,
    title: 'WORKFLOW: pipeline',
    description: 'Rules',
    labels: pauseRulesCard ? [{ title: 'PAUSED' }] : []
  };
  const defaultStacks = [
    { id: 10, title: 'Inbox', order: 0, cards: [rulesCard] },
    { id: 20, title: 'In Progress', order: 1, cards: [] },
    { id: 30, title: 'Done', order: 2, cards: [] }
  ];
  return {
    board: { id: boardId, title: 'Test Board' },
    boardId,
    stacks: stacks || defaultStacks,
    description,
    workflowType: 'pipeline',
    rulesCardId,
    _plainDescription: description
  };
}

/** Build a minimal WorkflowEngine without disk persistence. */
function makeEngine({ emailHandler, deck, ncMailClient } = {}) {
  return new WorkflowEngine({
    workflowDetector: { getWorkflowBoards: async () => [], invalidateCache: () => {} },
    deckClient: deck || createMockDeck(),
    agentLoop: createMockAgentLoop(),
    talkSendQueue: createMockTalkQueue(),
    talkToken: 'tok',
    emailHandler: emailHandler || null,
    ncMailClient: ncMailClient || null
    // no config.dataDir → in-memory only
  });
}

/**
 * Mark a board as already-seeded (past its first pulse) so the normal
 * ingest/dedup path runs. Seeding (#194) makes a board's FIRST pulse record the
 * folder's existing mail without creating cards; tests that exercise ongoing
 * ingestion start from a board that has already had that first pulse. An empty
 * set is sufficient: it makes the .has() first-run check false while leaving no
 * Message-ID marked, so any fetched mail flows through the normal ingest path.
 */
function markSeeded(engine, boardId = 1) {
  engine._ingestedEmails.set(String(boardId), new Set());
}

/** Fixture: a single email with a Message-ID. */
function makeEmail(overrides = {}) {
  return {
    id: 42,
    messageId: '<test-001@example.com>',
    from: 'Alice <alice@example.com>',
    fromAddress: 'alice@example.com',
    subject: 'Test Email',
    date: new Date('2026-06-17T10:00:00Z'),
    body: 'Hello from test.',
    snippet: 'Hello from test.',
    isRead: false,
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

(async () => {
  console.log('\n=== Email Trigger Bridge Tests ===\n');

  // TC-TRIGGER-01: No TRIGGER line → returns 0, _fetchEmails NOT called, no card created.
  await asyncTest('TC-TRIGGER-01: No TRIGGER line → 0 ingested, no fetch, no card', async () => {
    const emailHandler = createMockEmailHandler([makeEmail()]);
    const deck = createMockDeck();
    const engine = makeEngine({ emailHandler, deck });
    const wb = makeWorkflowBoard({ description: 'WORKFLOW: pipeline\nRULES: do stuff' });

    const result = await engine._ingestTriggerEmails(wb);

    assert.strictEqual(result, 0, 'should return 0');
    assert.strictEqual(emailHandler._fetchCalls.length, 0, '_fetchEmails should NOT be called');
    assert.strictEqual(deck._calls.length, 0, 'no card should be created');
  });

  // TC-TRIGGER-02: _parseTrigger parses TRIGGER: email:INBOX.INQUIRIES correctly.
  test('TC-TRIGGER-02: _parseTrigger parses email:INBOX.INQUIRIES → {kind,locator,stackName:null}', () => {
    const engine = makeEngine();
    const wb = makeWorkflowBoard({ description: 'WORKFLOW: pipeline\nTRIGGER: email:INBOX.INQUIRIES\n→ Inbox:' });
    const result = engine._parseTrigger(wb);

    assert.ok(result, 'should return a result');
    assert.strictEqual(result.kind, 'email');
    assert.strictEqual(result.locator, 'INBOX.INQUIRIES');
    assert.strictEqual(result.stackName, null);
  });

  // TC-TRIGGER-03: _parseTrigger parses optional -> stack name.
  test('TC-TRIGGER-03: _parseTrigger parses TRIGGER: email:INBOX.X -> Inbox → stackName:Inbox', () => {
    const engine = makeEngine();
    const wb = makeWorkflowBoard({ description: 'WORKFLOW: pipeline\nTRIGGER: email:INBOX.X -> Inbox' });
    const result = engine._parseTrigger(wb);

    assert.ok(result, 'should return a result');
    assert.strictEqual(result.kind, 'email');
    assert.strictEqual(result.locator, 'INBOX.X');
    assert.strictEqual(result.stackName, 'Inbox');
  });

  // TC-TRIGGER-04: _parseTrigger on a description with no TRIGGER → null.
  test('TC-TRIGGER-04: _parseTrigger on description without TRIGGER → null', () => {
    const engine = makeEngine();
    const wb = makeWorkflowBoard({ description: 'WORKFLOW: pipeline\nRULES: do stuff' });
    assert.strictEqual(engine._parseTrigger(wb), null);
  });

  // TC-TRIGGER-05: Idempotency — two consecutive calls with same messageId → card created exactly once.
  await asyncTest('TC-TRIGGER-05: Same messageId on two calls → card created exactly once', async () => {
    const emails = [makeEmail({ messageId: '<dedup-test@example.com>' })];
    const emailHandler = createMockEmailHandler(emails);
    const deck = createMockDeck();
    const engine = makeEngine({ emailHandler, deck });
    markSeeded(engine);
    const wb = makeWorkflowBoard({ description: 'WORKFLOW: pipeline\nTRIGGER: email:INBOX.TEST' });

    await engine._ingestTriggerEmails(wb);
    await engine._ingestTriggerEmails(wb);

    assert.strictEqual(deck._calls.length, 1, 'card should be created exactly once');
  });

  // TC-TRIGGER-06: New messageId on the second call → a new card created.
  await asyncTest('TC-TRIGGER-06: New messageId on second call → second card created', async () => {
    let callCount = 0;
    const emailSets = [
      [makeEmail({ messageId: '<first@example.com>' })],
      [makeEmail({ messageId: '<first@example.com>' }), makeEmail({ messageId: '<second@example.com>', id: 43 })]
    ];
    const fetchCalls = [];
    const emailHandler = {
      _fetchEmails: async (opts) => {
        fetchCalls.push(opts);
        return emailSets[callCount++] || emailSets[1];
      },
      _fetchCalls: fetchCalls
    };
    const deck = createMockDeck();
    const engine = makeEngine({ emailHandler, deck });
    markSeeded(engine);
    const wb = makeWorkflowBoard({ description: 'WORKFLOW: pipeline\nTRIGGER: email:INBOX.TEST' });

    await engine._ingestTriggerEmails(wb);
    await engine._ingestTriggerEmails(wb);

    assert.strictEqual(deck._calls.length, 2, 'two distinct emails → two cards');
  });

  // TC-TRIGGER-07: _fetchEmails is called with the correct options.
  // Post-#194 the trigger fetch is unreadOnly:false — dedup is the Message-ID
  // store's job, not the IMAP \Seen flag's.
  await asyncTest('TC-TRIGGER-07: _fetchEmails called with {folder, unreadOnly:false, limit:50}', async () => {
    const emailHandler = createMockEmailHandler([]);
    const engine = makeEngine({ emailHandler });
    const wb = makeWorkflowBoard({ description: 'WORKFLOW: pipeline\nTRIGGER: email:INBOX.INQUIRIES' });

    await engine._ingestTriggerEmails(wb);

    assert.strictEqual(emailHandler._fetchCalls.length, 1);
    const opts = emailHandler._fetchCalls[0];
    assert.strictEqual(opts.folder, 'INBOX.INQUIRIES');
    assert.strictEqual(opts.unreadOnly, false);
    assert.strictEqual(opts.limit, 50);
  });

  // TC-TRIGGER-08: Entry stack selection — first by order when no stackName.
  await asyncTest('TC-TRIGGER-08: No stackName → first stack by order is chosen', async () => {
    const emailHandler = createMockEmailHandler([makeEmail()]);
    const deck = createMockDeck();
    const engine = makeEngine({ emailHandler, deck });
    markSeeded(engine);

    // Stacks intentionally out of order; lowest order=0 is id=30.
    const stacks = [
      { id: 30, title: 'Inbox', order: 0, cards: [] },
      { id: 10, title: 'In Progress', order: 1, cards: [] },
      { id: 20, title: 'Done', order: 2, cards: [] }
    ];
    const wb = makeWorkflowBoard({
      description: 'WORKFLOW: pipeline\nTRIGGER: email:INBOX.TEST',
      stacks
    });

    await engine._ingestTriggerEmails(wb);

    assert.strictEqual(deck._calls.length, 1, 'card should be created');
    assert.strictEqual(deck._calls[0].stackId, 30, 'should use lowest-order stack (id=30)');
  });

  // TC-TRIGGER-09: Entry stack by name — case-insensitive match.
  await asyncTest('TC-TRIGGER-09: stackName resolves case-insensitively to matching stack id', async () => {
    const emailHandler = createMockEmailHandler([makeEmail()]);
    const deck = createMockDeck();
    const engine = makeEngine({ emailHandler, deck });
    markSeeded(engine);

    const stacks = [
      { id: 10, title: 'Inbox', order: 0, cards: [] },
      { id: 20, title: 'Support', order: 1, cards: [] }
    ];
    // "SUPPORT" in the trigger → should match stack id=20 (title='Support')
    const wb = makeWorkflowBoard({
      description: 'WORKFLOW: pipeline\nTRIGGER: email:INBOX.SUPPORT -> SUPPORT',
      stacks
    });

    await engine._ingestTriggerEmails(wb);

    assert.strictEqual(deck._calls.length, 1);
    assert.strictEqual(deck._calls[0].stackId, 20, 'should match Support stack (id=20) case-insensitively');
  });

  // TC-TRIGGER-10: Missing messageId → fallback key; still idempotent across two calls.
  await asyncTest('TC-TRIGGER-10: No messageId → fallback key used, still idempotent', async () => {
    const emailNoId = makeEmail({ messageId: undefined });
    delete emailNoId.messageId;
    const emailHandler = createMockEmailHandler([emailNoId]);
    const deck = createMockDeck();
    const engine = makeEngine({ emailHandler, deck });
    markSeeded(engine);
    const wb = makeWorkflowBoard({ description: 'WORKFLOW: pipeline\nTRIGGER: email:INBOX.TEST' });

    await engine._ingestTriggerEmails(wb);
    await engine._ingestTriggerEmails(wb);

    assert.strictEqual(deck._calls.length, 1, 'fallback key should still be idempotent');
  });

  // TC-TRIGGER-11: emailHandler absent → returns 0, no throw.
  await asyncTest('TC-TRIGGER-11: No emailHandler → returns 0, no throw', async () => {
    const deck = createMockDeck();
    const engine = makeEngine({ emailHandler: null, deck });
    const wb = makeWorkflowBoard({ description: 'WORKFLOW: pipeline\nTRIGGER: email:INBOX.TEST' });

    let result;
    let threw = false;
    try {
      result = await engine._ingestTriggerEmails(wb);
    } catch (_) {
      threw = true;
    }

    assert.strictEqual(threw, false, 'should not throw');
    assert.strictEqual(result, 0, 'should return 0');
    assert.strictEqual(deck._calls.length, 0);
  });

  // TC-TRIGGER-12: createCardOnBoard returns null (paused entry stack) → email NOT marked;
  //               subsequent call retries (createCardOnBoard called again).
  await asyncTest('TC-TRIGGER-12: createCardOnBoard null → email not marked, retried next call', async () => {
    const emails = [makeEmail({ messageId: '<retry-test@example.com>' })];
    const emailHandler = createMockEmailHandler(emails);
    const deck = createMockDeck({ returnNull: true });
    const engine = makeEngine({ emailHandler, deck });
    markSeeded(engine);
    const wb = makeWorkflowBoard({ description: 'WORKFLOW: pipeline\nTRIGGER: email:INBOX.TEST' });

    await engine._ingestTriggerEmails(wb);
    await engine._ingestTriggerEmails(wb);

    // Both attempts should have tried (since marking never happened)
    assert.strictEqual(deck._calls.length, 2, 'createCardOnBoard should be called on both pulses');
    assert.strictEqual(engine._isEmailIngested(1, '<retry-test@example.com>'), false,
      'email should NOT be marked as ingested when card creation returned null');
  });

  // TC-TRIGGER-13: Card description contains sender, date, and Message-ID footer.
  await asyncTest('TC-TRIGGER-13: Card description has From/Date/Message-ID footer', async () => {
    const email = makeEmail({
      messageId: '<footer-test@example.com>',
      from: 'Bob <bob@example.com>',
      fromAddress: 'bob@example.com',
      date: new Date('2026-06-17T12:00:00Z'),
      body: 'Body content here.'
    });
    const emailHandler = createMockEmailHandler([email]);
    const deck = createMockDeck();
    const engine = makeEngine({ emailHandler, deck });
    markSeeded(engine);
    const wb = makeWorkflowBoard({ description: 'WORKFLOW: pipeline\nTRIGGER: email:INBOX.TEST' });

    await engine._ingestTriggerEmails(wb);

    assert.strictEqual(deck._calls.length, 1);
    const desc = deck._calls[0].description;
    assert.ok(desc.includes('Bob <bob@example.com>'), 'description should contain sender');
    assert.ok(desc.includes('<footer-test@example.com>'), 'description should contain Message-ID');
    // date is included (any format — it's the raw Date object converted to string)
    assert.ok(desc.includes('Date:'), 'description should contain Date: label');
  });

  // TC-TRIGGER-14: Unsupported kind (files:) → returns 0, _fetchEmails NOT called.
  await asyncTest('TC-TRIGGER-14: Unsupported kind "files:" → 0 returned, no email fetch', async () => {
    const emailHandler = createMockEmailHandler([makeEmail()]);
    const deck = createMockDeck();
    const engine = makeEngine({ emailHandler, deck });
    const wb = makeWorkflowBoard({ description: 'WORKFLOW: pipeline\nTRIGGER: files:/some/path' });

    const result = await engine._ingestTriggerEmails(wb);

    assert.strictEqual(result, 0);
    assert.strictEqual(emailHandler._fetchCalls.length, 0, '_fetchEmails should NOT be called for unsupported kind');
    assert.strictEqual(deck._calls.length, 0);
  });

  // TC-TRIGGER-15: Board with PAUSED rules card → _processBoard returns without calling _ingestTriggerEmails.
  await asyncTest('TC-TRIGGER-15: PAUSED rules card → _ingestTriggerEmails never called', async () => {
    const emailHandler = createMockEmailHandler([makeEmail()]);
    const deck = createMockDeck();
    const engine = makeEngine({ emailHandler, deck });

    // Replace with a spy to verify it's not called
    let ingestCalled = 0;
    engine._ingestTriggerEmails = async () => { ingestCalled++; return 0; };

    const wb = makeWorkflowBoard({
      description: 'WORKFLOW: pipeline\nTRIGGER: email:INBOX.TEST',
      pauseRulesCard: true
    });

    // Call _processBoard directly; it should bail at the PAUSED check
    await engine._processBoard(wb);

    assert.strictEqual(ingestCalled, 0, '_ingestTriggerEmails should NOT be called when board is PAUSED');
  });

  // TC-TRIGGER-16: Disk round-trip — the processed-Message-ID store survives a
  //                service restart (a second engine on the same dataDir must not
  //                re-ingest). This locks the briefing's "restarts don't re-ingest"
  //                idempotency guarantee, which the in-memory tests above cannot reach.
  await asyncTest('TC-TRIGGER-16: ingested Message-ID survives restart (disk round-trip)', async () => {
    const tmpDir = path.join(os.tmpdir(), 'moltagent-trigger-test-' + process.pid);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    try {
      const email = makeEmail({ messageId: '<restart-test@example.com>' });
      const desc = 'WORKFLOW: pipeline\nTRIGGER: email:INBOX.TEST';

      // First engine ("before restart") — ingests and persists to disk.
      const deckA = createMockDeck();
      const engineA = new WorkflowEngine({
        workflowDetector: { getWorkflowBoards: async () => [], invalidateCache: () => {} },
        deckClient: deckA,
        agentLoop: createMockAgentLoop(),
        talkSendQueue: createMockTalkQueue(),
        talkToken: 'tok',
        emailHandler: createMockEmailHandler([email]),
        config: { dataDir: tmpDir }
      });
      // This board is already live (past its seeding pulse), so the email ingests
      // rather than being seeded-and-skipped (#194).
      markSeeded(engineA);
      await engineA._ingestTriggerEmails(makeWorkflowBoard({ description: desc }));
      assert.strictEqual(deckA._calls.length, 1, 'first engine creates the card');
      assert.ok(fs.existsSync(path.join(tmpDir, 'workflow-ingested-emails.json')),
        'store file should be written to disk');

      // Second engine ("after restart") — fresh instance, same dataDir, must load
      // the prior record and NOT re-ingest the same email.
      const deckB = createMockDeck();
      const engineB = new WorkflowEngine({
        workflowDetector: { getWorkflowBoards: async () => [], invalidateCache: () => {} },
        deckClient: deckB,
        agentLoop: createMockAgentLoop(),
        talkSendQueue: createMockTalkQueue(),
        talkToken: 'tok',
        emailHandler: createMockEmailHandler([email]),
        config: { dataDir: tmpDir }
      });
      assert.strictEqual(engineB._isEmailIngested(1, '<restart-test@example.com>'), true,
        'reloaded engine should recognize the prior Message-ID');
      await engineB._ingestTriggerEmails(makeWorkflowBoard({ description: desc }));
      assert.strictEqual(deckB._calls.length, 0, 'reloaded engine must NOT re-create the card');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // TC-TRIGGER-17: ncMailClient resolves a URL → description contains Markdown link AND
  //               still contains the Message-ID: footer.
  await asyncTest('TC-TRIGGER-17: ncMailClient resolves URL → description has link AND Message-ID footer', async () => {
    const MAIL_URL = 'https://nc.example.com/apps/mail/box/99/thread/555';
    const ncMailClient = {
      resolveThreadUrl: async (_folder, _msgId) => MAIL_URL
    };
    const email = makeEmail({
      messageId: '<link-test@example.com>',
      from: 'Charlie <charlie@example.com>',
      body: 'Mail body.'
    });
    const emailHandler = createMockEmailHandler([email]);
    const deck = createMockDeck();
    const engine = makeEngine({ emailHandler, deck, ncMailClient });
    markSeeded(engine);
    const wb = makeWorkflowBoard({ description: 'WORKFLOW: pipeline\nTRIGGER: email:INBOX.INQUIRIES' });

    await engine._ingestTriggerEmails(wb);

    assert.strictEqual(deck._calls.length, 1, 'one card should be created');
    const desc = deck._calls[0].description;
    assert.ok(
      desc.includes('[Open the original email in Mail](' + MAIL_URL + ')'),
      'description should contain Markdown link to NC Mail'
    );
    assert.ok(
      desc.includes('Message-ID: <link-test@example.com>'),
      'description should still contain the Message-ID footer'
    );
  });

  // TC-TRIGGER-18: ncMailClient.resolveThreadUrl returns null → description falls back to
  //               Message-ID footer with NO Mail link; ingestion returns 1 card (no throw).
  await asyncTest('TC-TRIGGER-18: ncMailClient returns null → Message-ID footer intact, no link, ingestion completes', async () => {
    const ncMailClient = {
      resolveThreadUrl: async (_folder, _msgId) => null
    };
    const email = makeEmail({ messageId: '<null-link-test@example.com>' });
    const emailHandler = createMockEmailHandler([email]);
    const deck = createMockDeck();
    const engine = makeEngine({ emailHandler, deck, ncMailClient });
    markSeeded(engine);
    const wb = makeWorkflowBoard({ description: 'WORKFLOW: pipeline\nTRIGGER: email:INBOX.INQUIRIES' });

    let threw = false;
    let result;
    try {
      result = await engine._ingestTriggerEmails(wb);
    } catch (_) {
      threw = true;
    }

    assert.strictEqual(threw, false, 'ingestion must not throw when resolveThreadUrl returns null');
    assert.strictEqual(result, 1, 'should return 1 ingested card');
    const desc = deck._calls[0].description;
    assert.ok(
      desc.includes('Message-ID: <null-link-test@example.com>'),
      'Message-ID footer must be present'
    );
    assert.ok(
      !desc.includes('[Open the original email in Mail]'),
      'no Mail link should be present when resolveThreadUrl returned null'
    );
  });

  // TC-TRIGGER-19: ncMailClient.resolveThreadUrl throws → ingestion still completes
  //               (try/catch swallows it), footer is intact, returns 1 card.
  await asyncTest('TC-TRIGGER-19: ncMailClient throws → ingestion completes, footer intact', async () => {
    const ncMailClient = {
      resolveThreadUrl: async () => { throw new Error('simulated NC Mail error'); }
    };
    const email = makeEmail({ messageId: '<throw-test@example.com>' });
    const emailHandler = createMockEmailHandler([email]);
    const deck = createMockDeck();
    const engine = makeEngine({ emailHandler, deck, ncMailClient });
    markSeeded(engine);
    const wb = makeWorkflowBoard({ description: 'WORKFLOW: pipeline\nTRIGGER: email:INBOX.INQUIRIES' });

    let threw = false;
    let result;
    try {
      result = await engine._ingestTriggerEmails(wb);
    } catch (_) {
      threw = true;
    }

    assert.strictEqual(threw, false, 'ingestion must not throw when resolveThreadUrl throws');
    assert.strictEqual(result, 1, 'should return 1 ingested card');
    const desc = deck._calls[0].description;
    assert.ok(
      desc.includes('Message-ID: <throw-test@example.com>'),
      'Message-ID footer must be present after resolveThreadUrl threw'
    );
    assert.ok(
      !desc.includes('[Open the original email in Mail]'),
      'no Mail link should appear when resolveThreadUrl threw'
    );
  });

  // TC-TRIGGER-20: from is display-name only, fromAddress present → From line is
  //               "Name <addr>" — custody fix #185.
  await asyncTest('TC-TRIGGER-20: from=display-name-only + fromAddress → From line is Name <addr>', async () => {
    const email = makeEmail({
      messageId: '<from-addr-20@example.com>',
      from: 'Test Sender',
      fromAddress: 'test@example.com',
      body: 'Body.'
    });
    const emailHandler = createMockEmailHandler([email]);
    const deck = createMockDeck();
    const engine = makeEngine({ emailHandler, deck });
    markSeeded(engine);
    const wb = makeWorkflowBoard({ description: 'WORKFLOW: pipeline\nTRIGGER: email:INBOX.TEST' });

    await engine._ingestTriggerEmails(wb);

    assert.strictEqual(deck._calls.length, 1);
    const desc = deck._calls[0].description;
    assert.ok(
      desc.includes('From: Test Sender <test@example.com>'),
      'From line should be "Test Sender <test@example.com>" — got: ' + desc
    );
  });

  // TC-TRIGGER-21: from is display-name only, fromAddress empty → From line is name
  //               with NO empty angle brackets (custody fix #185).
  await asyncTest('TC-TRIGGER-21: from=display-name-only + fromAddress="" → no empty <>', async () => {
    const email = makeEmail({
      messageId: '<from-addr-21@example.com>',
      from: 'Test Sender',
      fromAddress: '',
      body: 'Body.'
    });
    const emailHandler = createMockEmailHandler([email]);
    const deck = createMockDeck();
    const engine = makeEngine({ emailHandler, deck });
    markSeeded(engine);
    const wb = makeWorkflowBoard({ description: 'WORKFLOW: pipeline\nTRIGGER: email:INBOX.TEST' });

    await engine._ingestTriggerEmails(wb);

    assert.strictEqual(deck._calls.length, 1);
    const desc = deck._calls[0].description;
    assert.ok(
      !desc.includes('<>'),
      'From line must NOT contain empty angle brackets <>'
    );
    assert.ok(
      desc.includes('From: Test Sender'),
      'From line should contain the display name — got: ' + desc
    );
  });

  // TC-TRIGGER-22: from already contains the address → no duplication (no-duplication
  //               invariant from custody fix #185; also guards TC-TRIGGER-13 regression).
  await asyncTest('TC-TRIGGER-22: from already contains address → address appears exactly once', async () => {
    const email = makeEmail({
      messageId: '<from-addr-22@example.com>',
      from: 'Dup <dup@example.com>',
      fromAddress: 'dup@example.com',
      body: 'Body.'
    });
    const emailHandler = createMockEmailHandler([email]);
    const deck = createMockDeck();
    const engine = makeEngine({ emailHandler, deck });
    markSeeded(engine);
    const wb = makeWorkflowBoard({ description: 'WORKFLOW: pipeline\nTRIGGER: email:INBOX.TEST' });

    await engine._ingestTriggerEmails(wb);

    assert.strictEqual(deck._calls.length, 1);
    const desc = deck._calls[0].description;
    // The address must not appear a second time after a closing '>'
    assert.ok(
      !desc.includes('dup@example.com> <dup@example.com>'),
      'address must not be duplicated in the From line — got: ' + desc
    );
    // And it must appear at least once
    const count = (desc.match(/dup@example\.com/g) || []).length;
    assert.strictEqual(count, 1, 'dup@example.com should appear exactly once, found: ' + count);
  });

  // TC-TRIGGER-23: A \Seen (read) email is ingested. Pre-#194 unreadOnly:true made
  //               read mail invisible; now dedup is the store's job, not the flag's.
  await asyncTest('TC-TRIGGER-23: read (isRead:true) email is ingested on a live board', async () => {
    const email = makeEmail({ messageId: '<seen-mail@example.com>', isRead: true });
    const emailHandler = createMockEmailHandler([email]);
    const deck = createMockDeck();
    const engine = makeEngine({ emailHandler, deck });
    markSeeded(engine);
    const wb = makeWorkflowBoard({ description: 'WORKFLOW: pipeline\nTRIGGER: email:INBOX.TEST' });

    const result = await engine._ingestTriggerEmails(wb);

    assert.strictEqual(result, 1, 'a \\Seen email should be ingested');
    assert.strictEqual(deck._calls.length, 1, 'one card should be created from the read email');
  });

  // TC-TRIGGER-24: First pulse on a fresh board with existing mail → seed-and-skip.
  //               Zero cards created; every Message-ID recorded in the store.
  await asyncTest('TC-TRIGGER-24: first pulse seeds existing mail, creates zero cards', async () => {
    const emails = [
      makeEmail({ messageId: '<hist-1@example.com>', id: 1 }),
      makeEmail({ messageId: '<hist-2@example.com>', id: 2 }),
      makeEmail({ messageId: '<hist-3@example.com>', id: 3 })
    ];
    const emailHandler = createMockEmailHandler(emails);
    const deck = createMockDeck();
    const engine = makeEngine({ emailHandler, deck }); // NOT seeded → first run
    const wb = makeWorkflowBoard({ description: 'WORKFLOW: pipeline\nTRIGGER: email:INBOX.TEST' });

    const result = await engine._ingestTriggerEmails(wb);

    assert.strictEqual(result, 0, 'first pulse creates zero cards (seed-and-skip)');
    assert.strictEqual(deck._calls.length, 0, 'no cards on the seeding pulse');
    assert.strictEqual(engine._isEmailIngested(1, '<hist-1@example.com>'), true, 'hist-1 seeded');
    assert.strictEqual(engine._isEmailIngested(1, '<hist-3@example.com>'), true, 'hist-3 seeded');
  });

  // TC-TRIGGER-25: After seeding, a genuinely new email on the next pulse is ingested;
  //               the seeded historical mail stays skipped.
  await asyncTest('TC-TRIGGER-25: second pulse ingests new mail, skips seeded history', async () => {
    let callCount = 0;
    const hist = makeEmail({ messageId: '<hist-only@example.com>', id: 1 });
    const fresh = makeEmail({ messageId: '<brand-new@example.com>', id: 2 });
    const emailSets = [[hist], [hist, fresh]];
    const emailHandler = {
      _fetchEmails: async () => emailSets[callCount++] || emailSets[1],
      _fetchCalls: []
    };
    const deck = createMockDeck();
    const engine = makeEngine({ emailHandler, deck }); // NOT seeded → first run seeds
    const wb = makeWorkflowBoard({ description: 'WORKFLOW: pipeline\nTRIGGER: email:INBOX.TEST' });

    await engine._ingestTriggerEmails(wb); // pulse 1: seeds [hist], zero cards
    await engine._ingestTriggerEmails(wb); // pulse 2: hist skipped, fresh ingested

    assert.strictEqual(deck._calls.length, 1, 'only the new email creates a card');
    assert.strictEqual(deck._calls[0].title, fresh.subject, 'the card is from the new email');
    assert.strictEqual(engine._isEmailIngested(1, '<hist-only@example.com>'), true, 'history stays seeded');
  });

  // TC-TRIGGER-26: An empty trigger folder on first run must NOT swallow the first
  //               real email arriving later. This is why the first-run signal is
  //               store.has(boardId), not set.size === 0 — an empty starting folder
  //               would otherwise re-trigger seeding and skip the first message forever.
  await asyncTest('TC-TRIGGER-26: empty-folder first run still ingests the first later email', async () => {
    let callCount = 0;
    const first = makeEmail({ messageId: '<first-ever@example.com>', id: 1 });
    const emailSets = [[], [first]];
    const emailHandler = {
      _fetchEmails: async () => emailSets[callCount++] || emailSets[1],
      _fetchCalls: []
    };
    const deck = createMockDeck();
    const engine = makeEngine({ emailHandler, deck }); // NOT seeded → first run
    const wb = makeWorkflowBoard({ description: 'WORKFLOW: pipeline\nTRIGGER: email:INBOX.TEST' });

    await engine._ingestTriggerEmails(wb); // pulse 1: empty folder, seeds nothing but records board
    await engine._ingestTriggerEmails(wb); // pulse 2: first real email must ingest

    assert.strictEqual(deck._calls.length, 1, 'the first email after an empty-folder seed must ingest');
    assert.strictEqual(engine._isEmailIngested(1, '<first-ever@example.com>'), true, 'first email recorded');
  });

  setTimeout(() => { summary(); exitWithCode(); }, 500);
})();
