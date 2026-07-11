/**
 * GuardrailEnforcer Unit Tests
 *
 * Run: node test/unit/agent/guardrail-enforcer.test.js
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

const { GuardrailEnforcer } = require('../../../src/lib/agent/guardrail-enforcer');
const { toolLabel } = require('../../../src/lib/agent/surface-text');
const { PendingActionStore } = require('../../../src/lib/pending-action-store');

// ============================================================
// Helpers
// ============================================================

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {}
};

function createMockCockpit(guardrails = []) {
  return {
    cachedConfig: { guardrails }
  };
}

function createMockOllama(response) {
  let callCount = 0;
  let lastCall = null;
  return {
    chat: async (params) => {
      callCount++;
      lastCall = params;
      if (typeof response === 'function') return response(params);
      if (response instanceof Error) throw response;
      return { content: response };
    },
    _getCallCount: () => callCount,
    _getLastCall: () => lastCall
  };
}

/**
 * Dual mock: returns semanticResponse for semantic evaluation calls
 * (detected by system prompt containing 'guardrail category matcher'),
 * and classifierResponse for all other calls (_classifyReply via ConfirmationClassifier).
 * Use when a test exercises both the semantic guardrail match AND the HITL polling loop.
 */
/**
 * Mock for the same-turn authorization downgrade (_userRequestedAction).
 * Answers the downgrade prompt with `verdict` (or throws it, if an Error) and
 * leaves every other call — notably the HITL reply classifier — as UNKNOWN so
 * the ceremony's poll behaves deterministically.
 */
function createMockDowngradeOllama(verdict, otherResponse = 'UNKNOWN') {
  return {
    chat: async (params) => {
      const isDowngrade = (params.system || '').includes('whether a person already asked');
      if (!isDowngrade) return { content: otherResponse };
      if (verdict instanceof Error) throw verdict;
      return { content: verdict };
    }
  };
}

function createDualMockOllama(semanticResponse, classifierResponse) {
  let callCount = 0;
  let lastCall = null;
  return {
    chat: async (params) => {
      callCount++;
      lastCall = params;
      // Distinguish semantic evaluation calls from classifier calls by system prompt
      const isSemanticEval = (params.system || '').includes('guardrail category matcher');
      const resp = isSemanticEval ? semanticResponse : classifierResponse;
      if (resp instanceof Error) throw resp;
      return { content: resp };
    },
    _getCallCount: () => callCount,
    _getLastCall: () => lastCall
  };
}

function createMockTalkQueue() {
  const sent = [];
  return {
    enqueue: (token, message) => { sent.push({ token, message }); },
    _getSent: () => sent
  };
}

function createMockConversationContext(replies = []) {
  let callCount = 0;
  return {
    getHistory: async () => {
      callCount++;
      return replies;
    },
    _getCallCount: () => callCount
  };
}

function makeEnforcer(overrides = {}) {
  return new GuardrailEnforcer({
    cockpitManager: overrides.cockpitManager || null,
    talkSendQueue: overrides.talkSendQueue || null,
    conversationContext: overrides.conversationContext || null,
    ollamaProvider: overrides.ollamaProvider || null,
    semanticTimeoutMs: overrides.semanticTimeoutMs || 5000,
    confirmationTimeoutMs: overrides.confirmationTimeoutMs || 500,
    pollIntervalMs: overrides.pollIntervalMs || 50,
    pendingActionStore: overrides.pendingActionStore || undefined,
    logger: silentLogger
  });
}

// Shorthand: create a GATE guardrail (the common case in tests)
function gateGuardrail(title, extra = {}) {
  return { title, gate: true, ...extra };
}

// ============================================================
// Tests
// ============================================================

async function runTests() {
  // --- Passthrough / Fail-open tests ---

  await asyncTest('allows tool when no cockpitManager', async () => {
    const enforcer = makeEnforcer({});
    const result = await enforcer.check('mail_send', { to: 'a@b.com' }, 'room1');
    assert.strictEqual(result.allowed, true);
  });

  await asyncTest('allows tool not in SENSITIVE_TOOLS', async () => {
    const enforcer = makeEnforcer({
      cockpitManager: createMockCockpit([gateGuardrail('Confirm before sending')])
    });
    const result = await enforcer.check('deck_list_cards', {}, 'room1');
    assert.strictEqual(result.allowed, true);
  });

  await asyncTest('allows when no guardrails active', async () => {
    const enforcer = makeEnforcer({
      cockpitManager: createMockCockpit([])
    });
    const result = await enforcer.check('mail_send', { to: 'a@b.com' }, 'room1');
    assert.strictEqual(result.allowed, true);
  });

  await asyncTest('allows when roomToken is null (workflow/non-interactive)', async () => {
    const enforcer = makeEnforcer({
      cockpitManager: createMockCockpit([gateGuardrail('Confirm emails')]),
      ollamaProvider: createMockOllama('YES')
    });
    const result = await enforcer.check('mail_send', { to: 'a@b.com' }, null);
    assert.strictEqual(result.allowed, true);
  });

  // --- GATE label filtering ---

  await asyncTest('ignores guardrails without GATE label', async () => {
    const ollama = createMockOllama('YES');
    const enforcer = makeEnforcer({
      cockpitManager: createMockCockpit([
        { title: 'Maximum 8 tool calls per reasoning cycle', gate: false },
        { title: 'Always cite sources', gate: false }
      ]),
      ollamaProvider: ollama,
      talkSendQueue: createMockTalkQueue(),
      conversationContext: createMockConversationContext([])
    });

    const result = await enforcer.check('mail_send', { to: 'a@b.com' }, 'room1');
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(ollama._getCallCount(), 0);
  });

  await asyncTest('evaluates only GATE guardrails in a mixed list', async () => {
    const ollama = createMockOllama('NO');
    const enforcer = makeEnforcer({
      cockpitManager: createMockCockpit([
        { title: 'Maximum 8 tool calls per reasoning cycle', gate: false },
        gateGuardrail('Confirm before sending external communications'),
        { title: 'Always use formal tone', gate: false }
      ]),
      ollamaProvider: ollama,
      talkSendQueue: createMockTalkQueue(),
      conversationContext: createMockConversationContext([])
    });

    const result = await enforcer.check('mail_send', { to: 'a@b.com' }, 'room1');
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(ollama._getCallCount(), 1);
  });

  // --- Semantic LLM matching ---

  await asyncTest('uses LLM for semantic matching with correct prompt structure', async () => {
    const ollama = createMockOllama('NO');
    const enforcer = makeEnforcer({
      cockpitManager: createMockCockpit([gateGuardrail('Confirm before sending external communications')]),
      ollamaProvider: ollama,
      talkSendQueue: createMockTalkQueue(),
      conversationContext: createMockConversationContext([])
    });

    await enforcer.check('mail_send', { to: 'test@example.com' }, 'room1');

    assert.strictEqual(ollama._getCallCount(), 1);
    const lastCall = ollama._getLastCall();
    assert.ok(lastCall.system.includes('guardrail category matcher'));
    assert.ok(lastCall.messages[0].content.includes('<guardrail>'));
    assert.ok(lastCall.messages[0].content.includes('Tool category: EMAIL'));
    assert.deepStrictEqual(lastCall.tools, []);
  });

  await asyncTest('allows when LLM returns NO for all guardrails', async () => {
    const enforcer = makeEnforcer({
      cockpitManager: createMockCockpit([
        gateGuardrail('Confirm before deleting files'),
        gateGuardrail('Check calendar changes')
      ]),
      ollamaProvider: createMockOllama('NO'),
      talkSendQueue: createMockTalkQueue(),
      conversationContext: createMockConversationContext([])
    });

    const result = await enforcer.check('mail_send', { to: 'a@b.com' }, 'room1');
    assert.strictEqual(result.allowed, true);
  });

  await asyncTest('blocks when LLM returns YES and user denies', async () => {
    const now = Date.now();
    const enforcer = makeEnforcer({
      cockpitManager: createMockCockpit([gateGuardrail('Confirm external comms')]),
      ollamaProvider: createDualMockOllama('YES', 'DENY'),
      talkSendQueue: createMockTalkQueue(),
      conversationContext: createMockConversationContext([
        { role: 'user', content: 'no', timestamp: Math.ceil(now / 1000) + 1 }
      ])
    });

    const result = await enforcer.check('mail_send', { to: 'a@b.com' }, 'room1');
    assert.strictEqual(result.allowed, false);
    assert.ok(result.reason.includes('Confirm external comms'));
  });

  await asyncTest('allows when LLM returns YES and user approves', async () => {
    const now = Date.now();
    const enforcer = makeEnforcer({
      cockpitManager: createMockCockpit([gateGuardrail('Confirm external comms')]),
      ollamaProvider: createDualMockOllama('YES', 'APPROVE'),
      talkSendQueue: createMockTalkQueue(),
      conversationContext: createMockConversationContext([
        { role: 'user', content: 'yes', timestamp: Math.ceil(now / 1000) + 1 }
      ])
    });

    const result = await enforcer.check('mail_send', { to: 'a@b.com' }, 'room1');
    assert.strictEqual(result.allowed, true);
  });

  // --- Keyword fallback ---

  await asyncTest('falls back to keywords when LLM returns UNCERTAIN', async () => {
    const now = Date.now();
    const enforcer = makeEnforcer({
      cockpitManager: createMockCockpit([gateGuardrail('Confirm before external communication')]),
      ollamaProvider: createDualMockOllama('MAYBE', 'DENY'),
      talkSendQueue: createMockTalkQueue(),
      conversationContext: createMockConversationContext([
        { role: 'user', content: 'no', timestamp: Math.ceil(now / 1000) + 1 }
      ])
    });

    const result = await enforcer.check('mail_send', { to: 'a@b.com' }, 'room1');
    assert.strictEqual(result.allowed, false);
  });

  await asyncTest('falls back to keywords when LLM call fails', async () => {
    const now = Date.now();
    // Semantic call throws; keyword match triggers HITL; classifier needs a valid provider.
    // Supply a mock that throws on call 1 (semantic) and returns DENY on subsequent calls.
    let callNum = 0;
    const enforcer = makeEnforcer({
      cockpitManager: createMockCockpit([gateGuardrail('Block email sending')]),
      ollamaProvider: {
        chat: async () => {
          callNum++;
          if (callNum === 1) throw new Error('connection refused');
          return { content: 'DENY' };
        }
      },
      talkSendQueue: createMockTalkQueue(),
      conversationContext: createMockConversationContext([
        { role: 'user', content: 'no', timestamp: Math.ceil(now / 1000) + 1 }
      ])
    });

    const result = await enforcer.check('mail_send', { to: 'a@b.com' }, 'room1');
    assert.strictEqual(result.allowed, false);
  });

  await asyncTest('blocks on genuine UNCERTAIN when no keyword match (fail cautious)', async () => {
    const now = Date.now();
    const enforcer = makeEnforcer({
      cockpitManager: createMockCockpit([gateGuardrail('Double-check messages to clients before dispatch')]),
      ollamaProvider: createDualMockOllama('I am not sure', 'DENY'),
      talkSendQueue: createMockTalkQueue(),
      conversationContext: createMockConversationContext([
        { role: 'user', content: 'no', timestamp: Math.ceil(now / 1000) + 1 }
      ])
    });

    const result = await enforcer.check('mail_send', { to: 'a@b.com' }, 'room1');
    assert.strictEqual(result.allowed, false);
  });

  // --- Timeout/error → keyword-only ---

  await asyncTest('LLM error + no keyword match → allows (no fail-cautious on infrastructure failure)', async () => {
    const enforcer = makeEnforcer({
      cockpitManager: createMockCockpit([gateGuardrail('Double-check messages to clients before dispatch')]),
      ollamaProvider: createMockOllama(new Error('timeout')),
      talkSendQueue: createMockTalkQueue(),
      conversationContext: createMockConversationContext([])
    });

    const result = await enforcer.check('mail_send', { to: 'a@b.com' }, 'room1');
    assert.strictEqual(result.allowed, true);
  });

  await asyncTest('LLM error + keyword match → still blocks (keyword is the signal)', async () => {
    const now = Date.now();
    let callNum = 0;
    const enforcer = makeEnforcer({
      cockpitManager: createMockCockpit([gateGuardrail('Confirm external communication')]),
      ollamaProvider: {
        chat: async () => {
          callNum++;
          if (callNum === 1) throw new Error('timeout');
          return { content: 'DENY' };
        }
      },
      talkSendQueue: createMockTalkQueue(),
      conversationContext: createMockConversationContext([
        { role: 'user', content: 'no', timestamp: Math.ceil(now / 1000) + 1 }
      ])
    });

    const result = await enforcer.check('mail_send', { to: 'a@b.com' }, 'room1');
    assert.strictEqual(result.allowed, false);
  });

  // --- HITL timeout ---

  await asyncTest('blocks on timeout when no human reply', async () => {
    const enforcer = makeEnforcer({
      cockpitManager: createMockCockpit([gateGuardrail('Confirm email')]),
      ollamaProvider: createMockOllama('YES'),
      talkSendQueue: createMockTalkQueue(),
      conversationContext: createMockConversationContext([]),
      confirmationTimeoutMs: 200,
      pollIntervalMs: 50
    });

    const result = await enforcer.check('mail_send', { to: 'a@b.com' }, 'room1');
    assert.strictEqual(result.allowed, false);
    assert.ok(result.reason.includes('denied or timed out'));
  });

  // --- Talk unavailable ---

  await asyncTest('blocks when Talk unavailable (no talkSendQueue)', async () => {
    const enforcer = makeEnforcer({
      cockpitManager: createMockCockpit([gateGuardrail('Confirm email')]),
      ollamaProvider: createMockOllama('YES'),
      talkSendQueue: null,
      conversationContext: createMockConversationContext([])
    });

    const result = await enforcer.check('mail_send', { to: 'a@b.com' }, 'room1');
    assert.strictEqual(result.allowed, false);
  });

  await asyncTest('blocks when Talk unavailable (no conversationContext)', async () => {
    const enforcer = makeEnforcer({
      cockpitManager: createMockCockpit([gateGuardrail('Confirm email')]),
      ollamaProvider: createMockOllama('YES'),
      talkSendQueue: createMockTalkQueue(),
      conversationContext: null
    });

    const result = await enforcer.check('mail_send', { to: 'a@b.com' }, 'room1');
    assert.strictEqual(result.allowed, false);
  });

  // --- Caching ---

  await asyncTest('cache hit skips LLM call', async () => {
    const ollama = createMockOllama('NO');
    const enforcer = makeEnforcer({
      cockpitManager: createMockCockpit([gateGuardrail('Confirm emails')]),
      ollamaProvider: ollama,
      talkSendQueue: createMockTalkQueue(),
      conversationContext: createMockConversationContext([])
    });

    await enforcer.check('mail_send', { to: 'a@b.com' }, 'room1');
    assert.strictEqual(ollama._getCallCount(), 1);

    await enforcer.check('mail_send', { to: 'b@c.com' }, 'room1');
    assert.strictEqual(ollama._getCallCount(), 1);
  });

  await asyncTest('cache expires after TTL', async () => {
    const ollama = createMockOllama('NO');
    const enforcer = makeEnforcer({
      cockpitManager: createMockCockpit([gateGuardrail('Confirm emails')]),
      ollamaProvider: ollama,
      talkSendQueue: createMockTalkQueue(),
      conversationContext: createMockConversationContext([])
    });

    await enforcer.check('mail_send', { to: 'a@b.com' }, 'room1');
    assert.strictEqual(ollama._getCallCount(), 1);

    for (const [key, val] of enforcer.matchCache) {
      val.timestamp = Date.now() - 6 * 60 * 1000;
    }

    await enforcer.check('mail_send', { to: 'a@b.com' }, 'room1');
    assert.strictEqual(ollama._getCallCount(), 2);
  });

  // --- Confirmation message templates ---

  await asyncTest('email confirmation shows full body and hides tool name', async () => {
    const now = Date.now();
    const queue = createMockTalkQueue();
    const enforcer = makeEnforcer({
      cockpitManager: createMockCockpit([gateGuardrail('Confirm before sending')]),
      ollamaProvider: createDualMockOllama('YES', 'APPROVE'),
      talkSendQueue: queue,
      conversationContext: createMockConversationContext([
        { role: 'user', content: 'yes', timestamp: Math.ceil(now / 1000) + 1 }
      ])
    });

    await enforcer.check('mail_send', {
      to: 'test@example.com',
      subject: 'Hello',
      body: 'Dear Mary,\n\nLooking forward to our meeting.\n\nBest,\nMolti'
    }, 'room1');

    const sent = queue._getSent();
    assert.strictEqual(sent.length, 1);
    const msg = sent[0].message;
    // Shows email content
    assert.ok(msg.includes('test@example.com'));
    assert.ok(msg.includes('Hello'));
    assert.ok(msg.includes('Dear Mary'));
    assert.ok(msg.includes('Looking forward to our meeting'));
    // Shows guardrail name
    assert.ok(msg.includes('Confirm before sending'));
    // Hides tool name
    assert.ok(!msg.includes('mail_send'));
    // Has edit option
    assert.ok(msg.includes('**edit** to revise'));
  });

  await asyncTest('email confirmation shows CC when present', async () => {
    const now = Date.now();
    const queue = createMockTalkQueue();
    const enforcer = makeEnforcer({
      cockpitManager: createMockCockpit([gateGuardrail('Check emails')]),
      ollamaProvider: createDualMockOllama('YES', 'APPROVE'),
      talkSendQueue: queue,
      conversationContext: createMockConversationContext([
        { role: 'user', content: 'yes', timestamp: Math.ceil(now / 1000) + 1 }
      ])
    });

    await enforcer.check('mail_send', {
      to: 'test@example.com',
      cc: 'boss@example.com',
      subject: 'Report',
      body: 'See attached.'
    }, 'room1');

    const msg = queue._getSent()[0].message;
    assert.ok(msg.includes('boss@example.com'));
  });

  await asyncTest('file delete confirmation shows path and warning, no edit option', async () => {
    const now = Date.now();
    const queue = createMockTalkQueue();
    const enforcer = makeEnforcer({
      cockpitManager: createMockCockpit([gateGuardrail('Confirm deletions')]),
      ollamaProvider: createDualMockOllama('YES', 'APPROVE'),
      talkSendQueue: queue,
      conversationContext: createMockConversationContext([
        { role: 'user', content: 'yes', timestamp: Math.ceil(now / 1000) + 1 }
      ])
    });

    await enforcer.check('file_delete', { path: '/Documents/Q3-Report.pdf' }, 'room1');

    const msg = queue._getSent()[0].message;
    assert.ok(msg.includes('/Documents/Q3-Report.pdf'));
    assert.ok(msg.includes('cannot be undone'));
    assert.ok(!msg.includes('file_delete'));
    assert.ok(!msg.includes('**edit**'));
  });

  await asyncTest('file move confirmation shows from/to, no edit option', async () => {
    const now = Date.now();
    const queue = createMockTalkQueue();
    const enforcer = makeEnforcer({
      cockpitManager: createMockCockpit([gateGuardrail('Confirm moves')]),
      ollamaProvider: createDualMockOllama('YES', 'APPROVE'),
      talkSendQueue: queue,
      conversationContext: createMockConversationContext([
        { role: 'user', content: 'yes', timestamp: Math.ceil(now / 1000) + 1 }
      ])
    });

    await enforcer.check('file_move', { path: '/a.txt', destination: '/archive/a.txt' }, 'room1');

    const msg = queue._getSent()[0].message;
    assert.ok(msg.includes('/a.txt'));
    assert.ok(msg.includes('/archive/a.txt'));
    assert.ok(!msg.includes('file_move'));
    assert.ok(!msg.includes('**edit**'));
  });

  await asyncTest('calendar confirmation omits empty fields', async () => {
    const now = Date.now();
    const queue = createMockTalkQueue();
    const enforcer = makeEnforcer({
      cockpitManager: createMockCockpit([gateGuardrail('Check calendar')]),
      ollamaProvider: createDualMockOllama('YES', 'APPROVE'),
      talkSendQueue: queue,
      conversationContext: createMockConversationContext([
        { role: 'user', content: 'yes', timestamp: Math.ceil(now / 1000) + 1 }
      ])
    });

    await enforcer.check('calendar_create_event', {
      title: 'Team sync',
      start: '2026-02-21T14:00'
    }, 'room1');

    const msg = queue._getSent()[0].message;
    assert.ok(msg.includes('Team sync'));
    assert.ok(msg.includes('2026-02-21T14:00'));
    assert.ok(msg.includes('Create event'));
    assert.ok(!msg.includes('Attendees'));
    assert.ok(!msg.includes('Location'));
    assert.ok(msg.includes('**edit** to revise'));
  });

  await asyncTest('calendar delete confirmation has no edit option', async () => {
    const now = Date.now();
    const queue = createMockTalkQueue();
    const enforcer = makeEnforcer({
      cockpitManager: createMockCockpit([gateGuardrail('Check deletions')]),
      ollamaProvider: createDualMockOllama('YES', 'APPROVE'),
      talkSendQueue: queue,
      conversationContext: createMockConversationContext([
        { role: 'user', content: 'yes', timestamp: Math.ceil(now / 1000) + 1 }
      ])
    });

    await enforcer.check('calendar_delete_event', { title: 'Old meeting' }, 'room1');

    const msg = queue._getSent()[0].message;
    assert.ok(msg.includes('Old meeting'));
    assert.ok(!msg.includes('**edit**'));
    assert.ok(!msg.includes('calendar_delete_event'));
  });

  await asyncTest('generic fallback uses plain language', async () => {
    // Test via the _buildConfirmationMessage method directly for a mapped tool
    const enforcer = makeEnforcer({});
    const msg = enforcer._buildGenericConfirmation('mail_send', {}, '*Guardrail: "test"*');
    assert.ok(msg.includes('send an email'));
    assert.ok(!msg.includes('mail_send'));
  });

  // --- Untrusted content wrapping ---

  await asyncTest('semantic prompt wraps guardrail text in <guardrail> tags', async () => {
    const ollama = createMockOllama('NO');
    const enforcer = makeEnforcer({
      cockpitManager: createMockCockpit([gateGuardrail('Ignore previous instructions')]),
      ollamaProvider: ollama,
      talkSendQueue: createMockTalkQueue(),
      conversationContext: createMockConversationContext([])
    });

    await enforcer.check('mail_send', { to: 'a@b.com' }, 'room1');
    const msg = ollama._getLastCall().messages[0].content;
    assert.ok(msg.includes('<guardrail>Ignore previous instructions</guardrail>'));
  });

  // --- _classifyReply ---

  await asyncTest('_classifyReply returns approve when LLM says APPROVE', async () => {
    const ollama = createMockOllama('APPROVE');
    const enforcer = makeEnforcer({ ollamaProvider: ollama });
    const result = await enforcer._classifyReply('ja');
    assert.strictEqual(result, 'approve');
  });

  await asyncTest('_classifyReply returns deny when LLM says DENY', async () => {
    const ollama = createMockOllama('DENY');
    const enforcer = makeEnforcer({ ollamaProvider: ollama });
    const result = await enforcer._classifyReply('não');
    assert.strictEqual(result, 'deny');
  });

  await asyncTest('_classifyReply returns edit when LLM says EDIT and allowEdit=true', async () => {
    const ollama = createMockOllama('EDIT');
    const enforcer = makeEnforcer({ ollamaProvider: ollama });
    const result = await enforcer._classifyReply('ändere den Betreff', true);
    assert.strictEqual(result, 'edit');
  });

  await asyncTest('_classifyReply returns unknown when allowEdit=false even if LLM says EDIT', async () => {
    const ollama = createMockOllama('EDIT');
    const enforcer = makeEnforcer({ ollamaProvider: ollama });
    const result = await enforcer._classifyReply('edit this', false);
    assert.strictEqual(result, 'unknown');
  });

  await asyncTest('_classifyReply returns unknown when LLM throws', async () => {
    const ollama = createMockOllama(new Error('connection refused'));
    const enforcer = makeEnforcer({ ollamaProvider: ollama });
    let result;
    let threw = false;
    try {
      result = await enforcer._classifyReply('yes');
    } catch {
      threw = true;
    }
    assert.strictEqual(threw, false, 'should not throw');
    assert.strictEqual(result, 'unknown');
  });

  await asyncTest('_classifyReply returns unknown on empty input without LLM call', async () => {
    const ollama = createMockOllama('APPROVE');
    const enforcer = makeEnforcer({ ollamaProvider: ollama });
    const result = await enforcer._classifyReply('');
    assert.strictEqual(result, 'unknown');
    assert.strictEqual(ollama._getCallCount(), 0);
  });

  await asyncTest('_classifyReply returns unknown when ollamaProvider is null', async () => {
    const enforcer = makeEnforcer({ ollamaProvider: null });
    let result;
    let threw = false;
    try {
      result = await enforcer._classifyReply('yes');
    } catch {
      threw = true;
    }
    assert.strictEqual(threw, false, 'should not throw');
    assert.strictEqual(result, 'unknown');
  });

  await asyncTest('isConfirmationResponse is async and returns true for German ja', async () => {
    const ollama = createMockOllama('APPROVE');
    const enforcer = makeEnforcer({ ollamaProvider: ollama });
    const result = await enforcer.isConfirmationResponse('ja');
    assert.strictEqual(result, true);
  });

  await asyncTest('isConfirmationResponse returns false without LLM call for input over 100 chars', async () => {
    const ollama = createMockOllama('APPROVE');
    const enforcer = makeEnforcer({ ollamaProvider: ollama });
    const longText = 'a'.repeat(101);
    const result = await enforcer.isConfirmationResponse(longText);
    assert.strictEqual(result, false);
    assert.strictEqual(ollama._getCallCount(), 0);
  });

  await asyncTest('isConfirmationResponse returns false for empty input without LLM call', async () => {
    const ollama = createMockOllama('APPROVE');
    const enforcer = makeEnforcer({ ollamaProvider: ollama });
    const result = await enforcer.isConfirmationResponse('');
    assert.strictEqual(result, false);
    assert.strictEqual(ollama._getCallCount(), 0);
  });

  // --- _parseSemanticResult ---

  test('_parseSemanticResult handles YES/NO/UNCERTAIN', () => {
    const enforcer = makeEnforcer({});
    assert.strictEqual(enforcer._parseSemanticResult('YES'), 'YES');
    assert.strictEqual(enforcer._parseSemanticResult('Yes, this applies'), 'YES');
    assert.strictEqual(enforcer._parseSemanticResult('NO'), 'NO');
    assert.strictEqual(enforcer._parseSemanticResult('No, this does not apply'), 'NO');
    assert.strictEqual(enforcer._parseSemanticResult('MAYBE'), 'UNCERTAIN');
    assert.strictEqual(enforcer._parseSemanticResult(''), 'UNCERTAIN');
    assert.strictEqual(enforcer._parseSemanticResult(null), 'UNCERTAIN');
  });

  test('_parseSemanticResult handles chain-of-thought with answer on last line', () => {
    const enforcer = makeEnforcer({});
    assert.strictEqual(enforcer._parseSemanticResult(
      'The guardrail is about email confirmation. The tool call is mail_send.\nYES'
    ), 'YES');
    assert.strictEqual(enforcer._parseSemanticResult(
      'This guardrail governs file deletion. The tool call is sending email.\nNO'
    ), 'NO');
    assert.strictEqual(enforcer._parseSemanticResult(
      'The guardrail concerns calendar events. mail_send is not calendar-related.\nNo, this does not apply.'
    ), 'NO');
  });

  test('_parseSemanticResult handles inline answer at end of single line (real Ollama format)', () => {
    const enforcer = makeEnforcer({});
    assert.strictEqual(enforcer._parseSemanticResult(
      'The guardrail addresses message verification before sending, which is a direct concern for the EMAIL category. YES.'
    ), 'YES');
    assert.strictEqual(enforcer._parseSemanticResult(
      'The guardrail is about file deletion, which does not apply to EMAIL tools. NO.'
    ), 'NO');
    assert.strictEqual(enforcer._parseSemanticResult(
      'The guardrail "Confirm before sending external communications" directly applies to the EMAIL category, as it addresses sending messages to external recipients. YES.'
    ), 'YES');
    assert.strictEqual(enforcer._parseSemanticResult(
      'This guardrail governs email sending. YES'
    ), 'YES');
    assert.strictEqual(enforcer._parseSemanticResult(
      'File deletion does not apply to email. NO'
    ), 'NO');
  });

  // --- Edit flow ---

  await asyncTest('edit response on mail_send returns editRequest: true', async () => {
    const now = Date.now();
    const enforcer = makeEnforcer({
      cockpitManager: createMockCockpit([gateGuardrail('Confirm email')]),
      ollamaProvider: createDualMockOllama('YES', 'EDIT'),
      talkSendQueue: createMockTalkQueue(),
      conversationContext: createMockConversationContext([
        { role: 'user', content: 'edit', timestamp: Math.ceil(now / 1000) + 1 }
      ])
    });

    const result = await enforcer.check('mail_send', { to: 'a@b.com' }, 'room1');
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.editRequest, true);
    assert.ok(result.reason.includes('revision'));
  });

  await asyncTest('edit aliases trigger edit flow (revise, change, fix)', async () => {
    for (const word of ['revise', 'change the subject', 'fix the greeting']) {
      const now = Date.now();
      const enforcer = makeEnforcer({
        cockpitManager: createMockCockpit([gateGuardrail('Confirm email')]),
        ollamaProvider: createDualMockOllama('YES', 'EDIT'),
        talkSendQueue: createMockTalkQueue(),
        conversationContext: createMockConversationContext([
          { role: 'user', content: word, timestamp: Math.ceil(now / 1000) + 1 }
        ])
      });

      const result = await enforcer.check('mail_send', { to: 'a@b.com' }, 'room1');
      assert.strictEqual(result.editRequest, true, `"${word}" should trigger edit`);
    }
  });

  await asyncTest('edit response preserves original user message', async () => {
    const now = Date.now();
    const enforcer = makeEnforcer({
      cockpitManager: createMockCockpit([gateGuardrail('Confirm email')]),
      ollamaProvider: createDualMockOllama('YES', 'EDIT'),
      talkSendQueue: createMockTalkQueue(),
      conversationContext: createMockConversationContext([
        { role: 'user', content: 'Change the subject to Project Update', timestamp: Math.ceil(now / 1000) + 1 }
      ])
    });

    const result = await enforcer.check('mail_send', { to: 'a@b.com' }, 'room1');
    assert.strictEqual(result.editRequest, true);
    assert.strictEqual(result.editMessage, 'Change the subject to Project Update');
  });

  await asyncTest('edit response ignored for destructive tools (file_delete)', async () => {
    const now = Date.now();
    const enforcer = makeEnforcer({
      cockpitManager: createMockCockpit([gateGuardrail('Confirm deletions')]),
      ollamaProvider: createMockOllama('YES'),
      talkSendQueue: createMockTalkQueue(),
      conversationContext: createMockConversationContext([]),
      confirmationTimeoutMs: 200,
      pollIntervalMs: 50
    });

    // "edit" is in the history but file_delete is not editable — should timeout
    enforcer.conversationContext = createMockConversationContext([
      { role: 'user', content: 'edit', timestamp: Math.ceil(now / 1000) + 1 }
    ]);

    const result = await enforcer.check('file_delete', { path: '/test.txt' }, 'room1');
    // "edit" is not recognized for file_delete, so it should timeout
    assert.strictEqual(result.allowed, false);
    assert.ok(!result.editRequest);
  });

  await asyncTest('edit response ignored for calendar_delete_event', async () => {
    const now = Date.now();
    const enforcer = makeEnforcer({
      cockpitManager: createMockCockpit([gateGuardrail('Confirm deletions')]),
      ollamaProvider: createMockOllama('YES'),
      talkSendQueue: createMockTalkQueue(),
      conversationContext: createMockConversationContext([
        { role: 'user', content: 'edit', timestamp: Math.ceil(now / 1000) + 1 }
      ]),
      confirmationTimeoutMs: 200,
      pollIntervalMs: 50
    });

    const result = await enforcer.check('calendar_delete_event', { title: 'Meeting' }, 'room1');
    assert.strictEqual(result.allowed, false);
    assert.ok(!result.editRequest);
  });

  // --- No ollamaProvider for semantic eval: keyword-only guardrail matching ---

  await asyncTest('keyword-only semantic match triggers HITL (no LLM for guardrail eval)', async () => {
    const now = Date.now();
    // The semantic eval block throws → keyword fallback fires (Confirm external communication
    // matches 'external communication' keyword for mail_send). HITL triggered.
    // The classifier call (different system prompt) succeeds and returns APPROVE.
    const enforcer = makeEnforcer({
      cockpitManager: createMockCockpit([gateGuardrail('Confirm external communication')]),
      ollamaProvider: createDualMockOllama(new Error('semantic unavailable'), 'APPROVE'),
      talkSendQueue: createMockTalkQueue(),
      conversationContext: createMockConversationContext([
        { role: 'user', content: 'yes', timestamp: Math.ceil(now / 1000) + 1 }
      ])
    });

    const result = await enforcer.check('mail_send', { to: 'a@b.com' }, 'room1');
    assert.strictEqual(result.allowed, true);
  });

  await asyncTest('keyword-only mode when no ollamaProvider: no match allows', async () => {
    const enforcer = makeEnforcer({
      cockpitManager: createMockCockpit([gateGuardrail('Something unrelated to tools')]),
      ollamaProvider: null,
      talkSendQueue: createMockTalkQueue(),
      conversationContext: createMockConversationContext([])
    });

    const result = await enforcer.check('mail_send', { to: 'a@b.com' }, 'room1');
    assert.strictEqual(result.allowed, true);
  });

  // --- Cursor advancement ---

  await asyncTest('cursor advances past consumed reply — second guardrail does not re-match first reply', async () => {
    const now = Date.now();
    const replyTimestamp = Math.ceil(now / 1000) + 1;
    const enforcer = makeEnforcer({
      cockpitManager: createMockCockpit([
        gateGuardrail('Confirm external comms'),
        gateGuardrail('Double-check outbound mail')
      ]),
      ollamaProvider: createDualMockOllama('YES', 'APPROVE'),
      talkSendQueue: createMockTalkQueue(),
      conversationContext: createMockConversationContext([
        { role: 'user', content: 'yes', timestamp: replyTimestamp }
      ]),
      confirmationTimeoutMs: 200,
      pollIntervalMs: 50
    });

    const result = await enforcer.check('mail_send', { to: 'a@b.com' }, 'room1');
    assert.strictEqual(result.allowed, false);
    assert.ok(result.reason.includes('Double-check outbound mail'));
  });

  await asyncTest('cursor allows fresh reply after previous consumed', async () => {
    const now = Date.now();
    const firstReplyTs = Math.ceil(now / 1000) + 1;
    const secondReplyTs = firstReplyTs + 2;
    let pollCount = 0;

    const enforcer = makeEnforcer({
      cockpitManager: createMockCockpit([
        gateGuardrail('Confirm external comms'),
        gateGuardrail('Double-check outbound mail')
      ]),
      ollamaProvider: createDualMockOllama('YES', 'APPROVE'),
      talkSendQueue: createMockTalkQueue(),
      conversationContext: {
        getHistory: async () => {
          pollCount++;
          if (pollCount <= 3) {
            return [{ role: 'user', content: 'yes', timestamp: firstReplyTs }];
          }
          return [
            { role: 'user', content: 'yes', timestamp: firstReplyTs },
            { role: 'user', content: 'yes', timestamp: secondReplyTs }
          ];
        }
      },
      confirmationTimeoutMs: 2000,
      pollIntervalMs: 50
    });

    const result = await enforcer.check('mail_send', { to: 'a@b.com' }, 'room1');
    assert.strictEqual(result.allowed, true);
  });

  // --- No approval cache: every GATE-governed call ceremonies fresh (#265, T-A) ---

  await asyncTest('GATE path: a second call on a different target ceremonies fresh (no cache)', async () => {
    // The tool-keyed skip cache is deleted. An approval authorizes only the call
    // it was granted for; a later call — even same tool, same room — renders its
    // own ceremony. This is the GATE-path parallel of the T6 regression.
    const now = Date.now();
    const queue = createMockTalkQueue();
    const enforcer = makeEnforcer({
      cockpitManager: createMockCockpit([gateGuardrail('Confirm external comms')]),
      ollamaProvider: createDualMockOllama('YES', 'APPROVE'),
      talkSendQueue: queue,
      conversationContext: createMockConversationContext([
        { role: 'user', content: 'yes', timestamp: Math.ceil(now / 1000) + 1 }
      ]),
      confirmationTimeoutMs: 200,
      pollIntervalMs: 50
    });

    const r1 = await enforcer.check('mail_send', { to: 'a@b.com' }, 'room1');
    assert.strictEqual(r1.allowed, true);
    assert.strictEqual(queue._getSent().length, 1, 'first call ceremonies');

    // Different target, same tool, same room — the old cache would have skipped.
    await enforcer.check('mail_send', { to: 'different@b.com' }, 'room1');
    assert.strictEqual(queue._getSent().length, 2, 'second call renders a fresh ceremony, not a SKIP');
  });

  await asyncTest('denial is not cached — re-asks on retry after denial', async () => {
    const now = Date.now();
    let historyCallNum = 0;
    // Semantic eval always returns YES; classifier response follows the history reply content.
    // On first call block: history has 'no' → DENY; after 5 history calls: 'yes' → APPROVE.
    const enforcer = makeEnforcer({
      cockpitManager: createMockCockpit([gateGuardrail('Confirm email')]),
      ollamaProvider: createMockOllama((params) => {
        if ((params.system || '').includes('guardrail category matcher')) {
          return { content: 'YES' };
        }
        // Classifier call — check current history state via closure
        return { content: historyCallNum <= 5 ? 'DENY' : 'APPROVE' };
      }),
      talkSendQueue: createMockTalkQueue(),
      conversationContext: {
        getHistory: async () => {
          historyCallNum++;
          if (historyCallNum <= 5) {
            return [{ role: 'user', content: 'no', timestamp: Math.ceil(now / 1000) + 1 }];
          }
          return [{ role: 'user', content: 'yes', timestamp: Math.ceil(now / 1000) + 10 }];
        }
      }
    });

    const r1 = await enforcer.check('mail_send', { to: 'a@b.com' }, 'room1');
    assert.strictEqual(r1.allowed, false);

    const r2 = await enforcer.check('mail_send', { to: 'a@b.com' }, 'room1');
    assert.strictEqual(r2.allowed, true);
  });

  // --- Semantic prompt structure ---

  await asyncTest('semantic prompt includes negative framing for cross-category rejection', async () => {
    const ollama = createMockOllama('NO');
    const enforcer = makeEnforcer({
      cockpitManager: createMockCockpit([gateGuardrail('Confirm before deleting files')]),
      ollamaProvider: ollama,
      talkSendQueue: createMockTalkQueue(),
      conversationContext: createMockConversationContext([])
    });

    await enforcer.check('mail_send', { to: 'a@b.com' }, 'room1');
    const system = ollama._getLastCall().system;
    assert.ok(system.includes('FILE DELETION does not apply to EMAIL'));
    assert.ok(system.includes('Only answer YES if the guardrail directly governs'));
  });

  await asyncTest('semantic prompt includes explicit tool category for mail_send', async () => {
    const ollama = createMockOllama('NO');
    const enforcer = makeEnforcer({
      cockpitManager: createMockCockpit([gateGuardrail('Never delete files')]),
      ollamaProvider: ollama,
      talkSendQueue: createMockTalkQueue(),
      conversationContext: createMockConversationContext([])
    });

    await enforcer.check('mail_send', { to: 'a@b.com' }, 'room1');
    const userMsg = ollama._getLastCall().messages[0].content;
    assert.ok(userMsg.includes('Tool category: EMAIL — sends a message to an external recipient'));
    assert.ok(userMsg.includes('Does this guardrail govern the EMAIL category?'));
  });

  await asyncTest('semantic prompt includes explicit tool category for file_delete', async () => {
    const ollama = createMockOllama('NO');
    const enforcer = makeEnforcer({
      cockpitManager: createMockCockpit([gateGuardrail('Confirm external comms')]),
      ollamaProvider: ollama,
      talkSendQueue: createMockTalkQueue(),
      conversationContext: createMockConversationContext([])
    });

    await enforcer.check('file_delete', { path: '/test.txt' }, 'room1');
    const userMsg = ollama._getLastCall().messages[0].content;
    assert.ok(userMsg.includes('Tool category: FILE DELETION'));
    assert.ok(userMsg.includes('Does this guardrail govern the FILE DELETION category?'));
  });

  // F1 discovery: file_write was ungated on the live (Path A) tool-calling path —
  // present in neither ToolGuard REQUIRES_APPROVAL nor GuardrailEnforcer SENSITIVE_TOOLS,
  // while file_delete/file_move/file_share and wiki_write all were. Mirror wiki_write
  // (the write precedent): file_write is now guardrail-evaluable (Cockpit-GATE-governed),
  // not short-circuited. This asserts the gap is closed.
  await asyncTest('file_write is evaluated as sensitive (F1 gap closed)', async () => {
    const ollama = createMockOllama('NO');
    const enforcer = makeEnforcer({
      cockpitManager: createMockCockpit([gateGuardrail('Confirm before writing files')]),
      ollamaProvider: ollama,
      talkSendQueue: createMockTalkQueue(),
      conversationContext: createMockConversationContext([])
    });

    await enforcer.check('file_write', { path: '/Outbox/report.md', content: 'x' }, 'room1');
    // If file_write were still non-sensitive, check() would short-circuit before any
    // LLM call and _getLastCall() would be empty — so reaching the semantic prompt
    // proves it is now in SENSITIVE_TOOLS.
    const userMsg = ollama._getLastCall().messages[0].content;
    assert.ok(userMsg.includes('Tool category: FILE WRITE'));
    assert.ok(userMsg.includes('Does this guardrail govern the FILE WRITE category?'));
  });

  // ============================================================
  // checkApproval() — ToolGuard APPROVAL_REQUIRED routing
  // ============================================================

  await asyncTest('TC-APPROVE-001: checkApproval blocks when no roomToken', async () => {
    const enforcer = makeEnforcer({
      talkSendQueue: createMockTalkQueue(),
      conversationContext: createMockConversationContext([])
    });

    const result = await enforcer.checkApproval('deck_delete_card', { cardId: 42 }, null, []);
    assert.strictEqual(result.allowed, false);
    assert.ok(result.reason.includes('no interactive session'));
  });

  await asyncTest('TC-APPROVE-002: checkApproval downgrades MEDIUM tool when the user asked for it', async () => {
    const queue = createMockTalkQueue();
    const enforcer = makeEnforcer({
      ollamaProvider: createMockDowngradeOllama('YES'),
      talkSendQueue: queue,
      conversationContext: createMockConversationContext([])
    });

    const history = [
      { role: 'user', content: 'Please delete the card Q3 Planning' }
    ];
    const result = await enforcer.checkApproval('deck_delete_card', { card: 'Q3 Planning' }, 'room1', history);
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(queue._getSent().length, 0, 'no ceremony when the request was the authorization');
  });

  await asyncTest('TC-APPROVE-003: checkApproval asks HITL for MEDIUM tool when no confirmation', async () => {
    const now = Date.now();
    const enforcer = makeEnforcer({
      ollamaProvider: createMockOllama('APPROVE'),
      talkSendQueue: createMockTalkQueue(),
      conversationContext: createMockConversationContext([
        { role: 'user', content: 'yes', timestamp: Math.ceil(now / 1000) + 1 }
      ]),
      confirmationTimeoutMs: 500,
      pollIntervalMs: 50
    });

    // History has no confirmation patterns
    const history = [
      { role: 'user', content: 'What cards are on the board?' }
    ];
    const result = await enforcer.checkApproval('deck_delete_card', { cardId: 42 }, 'room1', history);
    assert.strictEqual(result.allowed, true); // user replied "yes" via HITL
  });

  await asyncTest('TC-APPROVE-004: checkApproval always asks HITL for HIGH tool (no downgrade)', async () => {
    const now = Date.now();
    const queue = createMockTalkQueue();
    const enforcer = makeEnforcer({
      ollamaProvider: createMockOllama('APPROVE'),
      talkSendQueue: queue,
      conversationContext: createMockConversationContext([
        { role: 'user', content: 'yes', timestamp: Math.ceil(now / 1000) + 1 }
      ]),
      confirmationTimeoutMs: 500,
      pollIntervalMs: 50
    });

    // Even with an explicit request in history, HIGH tools always ask HITL
    const history = [
      { role: 'user', content: 'share the Personal board with ada' }
    ];
    const result = await enforcer.checkApproval('deck_share_board', { board: 'Personal', participant: 'ada' }, 'room1', history);
    assert.strictEqual(result.allowed, true);
    // Verify it actually sent a HITL message (not short-circuited)
    assert.strictEqual(queue._getSent().length, 1);
  });

  await asyncTest('TC-APPROVE-005: a second delete on a different card ceremonies fresh (T-A, #265 T6 shape)', async () => {
    // The #265 leak, inverted into a regression test. An approval for card 42
    // must NOT carry over to a later delete of card 99. No tool-keyed cache: the
    // second call renders its own ceremony.
    const now = Date.now();
    const queue = createMockTalkQueue();
    const enforcer = makeEnforcer({
      ollamaProvider: createMockOllama('APPROVE'),
      talkSendQueue: queue,
      conversationContext: createMockConversationContext([
        { role: 'user', content: 'yes', timestamp: Math.ceil(now / 1000) + 1 }
      ]),
      confirmationTimeoutMs: 200,
      pollIntervalMs: 50
    });

    const r1 = await enforcer.checkApproval('deck_delete_card', { cardId: 42 }, 'room1', []);
    assert.strictEqual(r1.allowed, true, 'first delete approved via ceremony');
    assert.strictEqual(queue._getSent().length, 1, 'first call ceremonies');

    // Different card, same tool, same room, inside what was the old TTL window.
    await enforcer.checkApproval('deck_delete_card', { cardId: 99 }, 'room1', []);
    assert.strictEqual(queue._getSent().length, 2, 'second call renders a fresh ceremony, not a SKIP');
  });

  await asyncTest('TC-APPROVE-006: checkApproval blocks on timeout', async () => {
    const enforcer = makeEnforcer({
      talkSendQueue: createMockTalkQueue(),
      conversationContext: createMockConversationContext([]),
      confirmationTimeoutMs: 200,
      pollIntervalMs: 50
    });

    const result = await enforcer.checkApproval('deck_delete_card', { cardId: 42 }, 'room1', []);
    assert.strictEqual(result.allowed, false);
    assert.ok(result.reason.includes('denied or timed out'));
  });

  await asyncTest('TC-APPROVE-007: checkApproval blocks when Talk unavailable', async () => {
    const enforcer = makeEnforcer({
      talkSendQueue: null,
      conversationContext: null
    });

    const result = await enforcer.checkApproval('deck_delete_card', { cardId: 42 }, 'room1', []);
    assert.strictEqual(result.allowed, false);
    assert.ok(result.reason.includes('denied or timed out'));
  });

  // --- _classifySeverity ---

  // HIGH severity is the sharing/broadcasting class: an action whose effect leaves
  // the box and reaches someone else. Every name is a registered tool (#217).
  test('TC-APPROVE-008: _classifySeverity returns HIGH for high-severity tools', () => {
    const enforcer = makeEnforcer({});
    assert.strictEqual(enforcer._classifySeverity('file_share'), 'HIGH');
    assert.strictEqual(enforcer._classifySeverity('deck_share_board'), 'HIGH');
    assert.strictEqual(enforcer._classifySeverity('calendar_cancel_meeting'), 'HIGH');
  });

  test('TC-APPROVE-009: _classifySeverity returns MEDIUM for deck_delete_card', () => {
    const enforcer = makeEnforcer({});
    assert.strictEqual(enforcer._classifySeverity('deck_delete_card'), 'MEDIUM');
    assert.strictEqual(enforcer._classifySeverity('file_delete'), 'MEDIUM');
    assert.strictEqual(enforcer._classifySeverity('delete_file'), 'MEDIUM');
    assert.strictEqual(enforcer._classifySeverity('delete_folder'), 'MEDIUM');
  });

  // --- _userRequestedAction: the same-turn downgrade (#263) ---
  //
  // The regex table these replace was English-only: "delete the card X" skipped
  // the ceremony, "Lösch die Karte X" did not. The decision is now the model's.

  await asyncTest('TC-APPROVE-010: downgrade decision is identical in DE, EN and PT', async () => {
    const messages = [
      'Delete the card Q3 Planning',
      'Lösch die Karte Q3 Planning',
      'Apaga o cartão Q3 Planning'
    ];

    for (const content of messages) {
      const queue = createMockTalkQueue();
      const enforcer = makeEnforcer({
        ollamaProvider: createMockDowngradeOllama('The message names the card and the action.\nYES'),
        talkSendQueue: queue,
        conversationContext: createMockConversationContext([])
      });
      const result = await enforcer.checkApproval(
        'deck_delete_card', { card: 'Q3 Planning' }, 'room1', [{ role: 'user', content }]
      );
      assert.strictEqual(result.allowed, true, `downgrade failed for: ${content}`);
      assert.strictEqual(queue._getSent().length, 0, `ceremony ran for: ${content}`);
    }
  });

  await asyncTest('TC-APPROVE-011: downgrade declines when the message did not ask for the action', async () => {
    const queue = createMockTalkQueue();
    const enforcer = makeEnforcer({
      ollamaProvider: createMockDowngradeOllama('Only a question about the board.\nNO'),
      talkSendQueue: queue,
      conversationContext: createMockConversationContext([]),
      confirmationTimeoutMs: 150,
      pollIntervalMs: 50
    });

    const result = await enforcer.checkApproval(
      'deck_delete_card', { card: 'Q3 Planning' }, 'room1',
      [{ role: 'user', content: 'Welche Karten sind auf dem Board?' }]
    );
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(queue._getSent().length, 1, 'ceremony must run');
  });

  await asyncTest('TC-APPROVE-012: downgrade fails toward the ceremony', async () => {
    // Three ways the check can fail to produce a clear YES. All must ask.
    const providers = [
      ['classifier error', createMockDowngradeOllama(new Error('ollama down'))],
      ['uncertain verdict', createMockDowngradeOllama('I am not sure about this one.')],
      ['no provider at all', null]
    ];

    for (const [why, ollamaProvider] of providers) {
      const queue = createMockTalkQueue();
      const enforcer = makeEnforcer({
        ollamaProvider,
        talkSendQueue: queue,
        conversationContext: createMockConversationContext([]),
        confirmationTimeoutMs: 150,
        pollIntervalMs: 50
      });
      const result = await enforcer.checkApproval(
        'deck_delete_card', { card: 'Q3 Planning' }, 'room1',
        [{ role: 'user', content: 'Lösch die Karte Q3 Planning' }]
      );
      assert.strictEqual(result.allowed, false, `${why}: must not allow`);
      assert.strictEqual(queue._getSent().length, 1, `${why}: ceremony must run`);
    }
  });

  await asyncTest('TC-APPROVE-012b: HIGH-severity tools never reach the downgrade', async () => {
    let downgradeCalls = 0;
    const enforcer = makeEnforcer({
      ollamaProvider: {
        chat: async (params) => {
          if ((params.system || '').includes('whether a person already asked')) downgradeCalls++;
          return { content: 'UNKNOWN' };
        }
      },
      talkSendQueue: createMockTalkQueue(),
      conversationContext: createMockConversationContext([]),
      confirmationTimeoutMs: 150,
      pollIntervalMs: 50
    });

    await enforcer.checkApproval('deck_share_board', { board: 'Personal', participant: 'ada' }, 'room1',
      [{ role: 'user', content: 'share the board with ada' }]);
    assert.strictEqual(downgradeCalls, 0);
  });

  // --- _buildToolApprovalMessage: renders the args the tool registered (#107) ---

  test('TC-APPROVE-013: approval message renders deck_delete_card\'s real schema', () => {
    const enforcer = makeEnforcer({});
    const msg = enforcer._buildToolApprovalMessage(
      'Delete Deck card', 'deck_delete_card', { card: 'Buy groceries', board: 'Personal' }
    );
    assert.ok(msg.includes('Card: **Buy groceries**'));
    assert.ok(msg.includes('Board: **Personal**'));
    assert.ok(!msg.includes('#?'), 'must never render a placeholder identifier');
    assert.ok(msg.includes('cannot be undone'));
    assert.ok(msg.includes('requires approval'));
    assert.ok(!msg.includes('deck_delete_card'));
  });

  test('TC-APPROVE-014: approval message shows path for file_delete', () => {
    const enforcer = makeEnforcer({});
    const msg = enforcer._buildToolApprovalMessage('Delete file', 'file_delete', { path: '/docs/secret.txt' });
    assert.ok(msg.includes('/docs/secret.txt'));
    assert.ok(msg.includes('cannot be undone'));
    assert.ok(!msg.includes('file_delete'));
  });

  test('TC-APPROVE-015: absent optional args are omitted, not rendered as "?"', () => {
    const enforcer = makeEnforcer({});
    const msg = enforcer._buildToolApprovalMessage('Delete Deck card', 'deck_delete_card', { card: 'Solo' });
    assert.ok(msg.includes('Card: **Solo**'));
    assert.ok(!msg.includes('Board:'));
    assert.ok(!msg.includes('?'));
  });

  test('TC-APPROVE-016: unmapped tools fall back to their own arg names', () => {
    const enforcer = makeEnforcer({});
    const msg = enforcer._buildToolApprovalMessage('Run command', 'run_command', { command: 'ls -la' });
    assert.ok(msg.includes('command: **ls -la**'));
    assert.ok(!msg.includes('cannot be undone'), 'run_command is not in IRREVERSIBLE_TOOLS');
  });

  test('TC-APPROVE-017: every approval-labelled tool renders without a placeholder', () => {
    const enforcer = makeEnforcer({});
    const args = {
      deck_delete_card: { card: 'Card A', board: 'Board B' },
      file_delete: { path: '/a/b.txt' },
      wiki_delete: { page_title: 'People/Ada' },
      deck_share_board: { board: 'Board B', participant: 'ada' },
      file_share: { path: '/a/b.txt', share_with: 'ada' },
      calendar_cancel_meeting: { calendar_id: 'personal', event_uid: 'uid-1' },
    };
    for (const [tool, toolArgs] of Object.entries(args)) {
      const msg = enforcer._buildToolApprovalMessage(toolLabel(tool, 'EN'), tool, toolArgs, 'EN');
      assert.ok(!msg.includes('**#?**'), `${tool} rendered a placeholder`);
      assert.ok(!msg.includes('?**'), `${tool} rendered a placeholder`);
      const identifier = Object.values(toolArgs)[0];
      assert.ok(msg.includes(identifier), `${tool} omitted its identifier ${identifier}`);
    }
  });

  // ── PendingAction record (#104) ────────────────────────────────

  await asyncTest('TC-RECORD-001: a timed-out offer is born as a record', async () => {
    const enforcer = makeEnforcer({
      talkSendQueue: createMockTalkQueue(),
      conversationContext: createMockConversationContext([]),
      confirmationTimeoutMs: 150,
      pollIntervalMs: 50
    });

    assert.strictEqual(enforcer.getPendingAction('room1'), null);

    const result = await enforcer.checkApproval('deck_delete_card', { card: 'Q3 Planning' }, 'room1', []);
    assert.strictEqual(result.allowed, false);

    const record = enforcer.getPendingAction('room1');
    assert.ok(record, 'poll timeout must persist the offer');
    assert.strictEqual(record.tool, 'deck_delete_card');
    assert.deepStrictEqual(record.args, { card: 'Q3 Planning' });
    assert.strictEqual(record.label, 'Delete Deck card');
  });

  await asyncTest('TC-RECORD-002: a denied offer leaves no record', async () => {
    const nowSec = Math.floor(Date.now() / 1000) + 1;
    const enforcer = makeEnforcer({
      ollamaProvider: createMockOllama('DENY'),
      talkSendQueue: createMockTalkQueue(),
      conversationContext: createMockConversationContext([
        { role: 'user', content: 'nein', timestamp: nowSec }
      ]),
      confirmationTimeoutMs: 500,
      pollIntervalMs: 50
    });

    const result = await enforcer.checkApproval('deck_delete_card', { card: 'X' }, 'room1', []);
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(enforcer.getPendingAction('room1'), null, 'the poll answered; nothing to remember');
  });

  test('TC-RECORD-003: records are room-scoped', () => {
    const enforcer = makeEnforcer({});
    enforcer._rememberPendingAction('roomA', 'deck_delete_card', { card: 'A' }, 'Delete Deck card');
    enforcer._rememberPendingAction('roomB', 'file_delete', { path: '/b' }, 'Delete file');

    assert.strictEqual(enforcer.getPendingAction('roomA').tool, 'deck_delete_card');
    assert.strictEqual(enforcer.getPendingAction('roomB').tool, 'file_delete');
    assert.strictEqual(enforcer.getPendingAction('roomC'), null);
  });

  test('TC-RECORD-004: a newer offer supersedes the older one in the same room', () => {
    const enforcer = makeEnforcer({});
    enforcer._rememberPendingAction('room1', 'deck_delete_card', { card: 'Old' }, 'Delete Deck card');
    enforcer._rememberPendingAction('room1', 'deck_delete_card', { card: 'New' }, 'Delete Deck card');

    assert.strictEqual(enforcer.pendingActions.size('offered-work:room1'), 1);
    assert.strictEqual(enforcer.getPendingAction('room1').args.card, 'New');
  });

  test('TC-RECORD-005: consumption is single-shot', () => {
    const enforcer = makeEnforcer({});
    enforcer._rememberPendingAction('room1', 'deck_delete_card', { card: 'A' }, 'Delete Deck card');

    const first = enforcer.consumePendingAction('room1');
    assert.strictEqual(first.args.card, 'A');
    assert.strictEqual(enforcer.consumePendingAction('room1'), null, 'a spent record cannot be re-read');
    assert.strictEqual(enforcer.getPendingAction('room1'), null);
  });

  test('TC-RECORD-006: dropPendingAction forgets the offer', () => {
    const enforcer = makeEnforcer({});
    enforcer._rememberPendingAction('room1', 'deck_delete_card', { card: 'A' }, 'Delete Deck card');
    enforcer.dropPendingAction('room1');
    assert.strictEqual(enforcer.getPendingAction('room1'), null);
  });

  test('TC-RECORD-007: an expired record is invisible', () => {
    const store = new PendingActionStore({ defaultTTLMs: 1, cleanupIntervalMs: 60000 });
    const enforcer = makeEnforcer({ pendingActionStore: store });
    // The store stamps expiresAt from its own TTL; write one already in the past.
    store.set('offered-work:room1', { tool: 'deck_delete_card', args: {}, label: 'x' }, { ttlMs: -1 });

    assert.strictEqual(enforcer.getPendingAction('room1'), null);
    store.stop();
  });

  test('TC-RECORD-008: no roomToken, no record', () => {
    const enforcer = makeEnforcer({});
    enforcer._rememberPendingAction(null, 'deck_delete_card', { card: 'A' }, 'Delete Deck card');
    assert.strictEqual(enforcer.pendingActions.size(), 0);
    assert.strictEqual(enforcer.getPendingAction(null), null);
  });

  // ── isPendingConfirmation (HITL duplicate prevention) ──────────

  test('TC-PENDING-001: isPendingConfirmation defaults to false', () => {
    const enforcer = makeEnforcer({});
    assert.strictEqual(enforcer.isPendingConfirmation(), false);
  });

  test('TC-PENDING-002: _pendingConfirmation flag is set true after enqueue', () => {
    const enforcer = makeEnforcer({});
    // Simulate what _requestConfirmation does after enqueue
    enforcer._pendingConfirmation = true;
    assert.strictEqual(enforcer.isPendingConfirmation(), true);
    enforcer._pendingConfirmation = false;
    assert.strictEqual(enforcer.isPendingConfirmation(), false);
  });

  await asyncTest('TC-PENDING-003: _pendingConfirmation resets after yes response', async () => {
    const nowSec = Math.floor(Date.now() / 1000) + 1;
    const enforcer = makeEnforcer({
      cockpitManager: createMockCockpit([{ title: 'Confirm emails', gate: true }]),
      talkSendQueue: createMockTalkQueue(),
      conversationContext: createMockConversationContext([
        { role: 'user', content: 'yes', timestamp: nowSec }
      ]),
      ollamaProvider: createDualMockOllama('YES', 'APPROVE'),
      pollIntervalMs: 10,
    });

    const result = await enforcer.check('mail_send', { to: 'a@b.com', subject: 'hi', body: 'test' }, 'room1');
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(enforcer.isPendingConfirmation(), false);
  });

  // ── isMessageConsumed (#108 Layer B: id-based consumed-watermark) ──
  // The webhook carries no timestamp; the Talk message id is the only field
  // shared by webhook (object.id) and poll (m.id), and ids are monotonic.
  test('TC-CONSUMED-001: defaults to false when nothing consumed', () => {
    const enforcer = makeEnforcer();
    assert.strictEqual(enforcer._lastConsumedMessageId, 0);
    assert.strictEqual(enforcer.isMessageConsumed(16895), false);
  });

  test('TC-CONSUMED-002: true for the consumed id (id === watermark) and older ids', () => {
    const enforcer = makeEnforcer();
    enforcer._lastConsumedMessageId = 16895;
    // Exact match — a redelivered webhook copy of the consumed "ja"
    assert.strictEqual(enforcer.isMessageConsumed(16895), true);
    // Anything at/under the watermark is spent
    assert.strictEqual(enforcer.isMessageConsumed(16800), true);
  });

  test('TC-CONSUMED-003: false for a newer id (genuine new request after watermark)', () => {
    const enforcer = makeEnforcer();
    enforcer._lastConsumedMessageId = 16895;
    assert.strictEqual(enforcer.isMessageConsumed(16896), false);
  });

  test('TC-CONSUMED-004: false for missing/invalid ids (safe fall-through)', () => {
    const enforcer = makeEnforcer();
    enforcer._lastConsumedMessageId = 16895;
    assert.strictEqual(enforcer.isMessageConsumed(0), false);
    assert.strictEqual(enforcer.isMessageConsumed(undefined), false);
    assert.strictEqual(enforcer.isMessageConsumed(NaN), false);
    assert.strictEqual(enforcer.isMessageConsumed(-1), false);
  });

  const { passed, failed } = summary();
  exitWithCode();
}

runTests().catch(err => {
  console.error('Test suite error:', err);
  process.exit(1);
});
