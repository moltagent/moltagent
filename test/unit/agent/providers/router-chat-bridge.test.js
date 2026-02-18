/**
 * RouterChatBridge Unit Tests
 *
 * Tests the bridge between LLMRouter v3 routing and AgentLoop's chat() interface.
 *
 * Run: node test/unit/agent/providers/router-chat-bridge.test.js
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../../helpers/test-runner');

const { RouterChatBridge } = require('../../../../src/lib/agent/providers/router-chat-bridge');

// ============================================================
// Mock Factories
// ============================================================

function createMockRouter(overrides = {}) {
  return {
    stats: { failovers: 0, errors: 0, successfulCalls: 0, byProvider: {} },
    buildProviderChain: overrides.buildProviderChain || ((job, ctx) => ({
      chain: [
        { id: 'anthropic-claude', provider: { type: 'remote' } },
        { id: 'ollama-local', provider: { type: 'local' } }
      ],
      skipped: []
    })),
    recordOutcome: overrides.recordOutcome || (() => {}),
    setPreset: overrides.setPreset || (() => {})
  };
}

function createMockChatProvider(overrides = {}) {
  return {
    chat: overrides.chat || (async (params) => ({
      content: overrides.content || 'Hello from mock provider',
      toolCalls: overrides.toolCalls || null
    }))
  };
}

const silentLogger = { info: () => {}, warn: () => {} };

// ============================================================
// Tests (wrapped in async IIFE so asyncTest awaits properly)
// ============================================================

(async () => {
  console.log('\n=== RouterChatBridge Tests ===\n');

  // --- Constructor Tests ---
  console.log('\n--- Constructor Tests ---\n');

  test('TC-BRIDGE-CTOR-001: requires router', () => {
    assert.throws(() => new RouterChatBridge({ chatProviders: new Map([['x', {}]]) }), /requires a router/);
  });

  test('TC-BRIDGE-CTOR-002: requires chatProviders', () => {
    assert.throws(() => new RouterChatBridge({ router: {} }), /requires at least one chatProvider/);
  });

  test('TC-BRIDGE-CTOR-003: requires non-empty chatProviders', () => {
    assert.throws(() => new RouterChatBridge({ router: {}, chatProviders: new Map() }), /requires at least one chatProvider/);
  });

  test('TC-BRIDGE-CTOR-004: initializes with valid config', () => {
    const bridge = new RouterChatBridge({
      router: createMockRouter(),
      chatProviders: new Map([['ollama-local', createMockChatProvider()]])
    });
    assert.strictEqual(bridge.defaultJob, 'tools');
    assert.strictEqual(bridge.fallbackNotifier, null);
  });

  // --- Happy Path ---
  console.log('\n--- Happy Path ---\n');

  await asyncTest('TC-BRIDGE-HAPPY-001: routes to first available provider', async () => {
    const recordedOutcomes = [];
    const router = createMockRouter({
      recordOutcome: (id, o) => recordedOutcomes.push({ id, ...o })
    });

    const bridge = new RouterChatBridge({
      router,
      chatProviders: new Map([
        ['anthropic-claude', createMockChatProvider({ content: 'Claude response' })],
        ['ollama-local', createMockChatProvider({ content: 'Ollama response' })]
      ])
    });

    const result = await bridge.chat({ system: 'test', messages: [], tools: [] });

    assert.strictEqual(result.content, 'Claude response');
    assert.strictEqual(result._routing.isFallback, false);
    assert.strictEqual(result._routing.player, 'primary');
    assert.strictEqual(result._routing.provider, 'anthropic-claude');
    assert.strictEqual(result._routing.primaryIsLocal, false);
    assert.strictEqual(result._routing.job, 'tools');

    // Should have recorded success
    assert.strictEqual(recordedOutcomes.length, 1);
    assert.strictEqual(recordedOutcomes[0].id, 'anthropic-claude');
    assert.strictEqual(recordedOutcomes[0].success, true);
  });

  await asyncTest('TC-BRIDGE-HAPPY-002: passes job hint through', async () => {
    let receivedJob = null;
    const router = createMockRouter({
      buildProviderChain: (job, ctx) => {
        receivedJob = job;
        return {
          chain: [{ id: 'ollama-local', provider: { type: 'local' } }],
          skipped: []
        };
      }
    });

    const bridge = new RouterChatBridge({
      router,
      chatProviders: new Map([['ollama-local', createMockChatProvider()]])
    });

    await bridge.chat({ system: 'test', messages: [], tools: [], job: 'quick' });
    assert.strictEqual(receivedJob, 'quick');
  });

  await asyncTest('TC-BRIDGE-HAPPY-003: defaults job to "tools"', async () => {
    let receivedJob = null;
    const router = createMockRouter({
      buildProviderChain: (job) => {
        receivedJob = job;
        return {
          chain: [{ id: 'ollama-local', provider: { type: 'local' } }],
          skipped: []
        };
      }
    });

    const bridge = new RouterChatBridge({
      router,
      chatProviders: new Map([['ollama-local', createMockChatProvider()]])
    });

    await bridge.chat({ system: 'test', messages: [], tools: [] });
    assert.strictEqual(receivedJob, 'tools');
  });

  // --- Failover ---
  console.log('\n--- Failover ---\n');

  await asyncTest('TC-BRIDGE-FAILOVER-001: fails over to next provider on error', async () => {
    const recordedOutcomes = [];
    const router = createMockRouter({
      recordOutcome: (id, o) => recordedOutcomes.push({ id, ...o })
    });

    const failingClaude = createMockChatProvider({
      chat: async () => { throw new Error('Claude API rate limited'); }
    });

    const bridge = new RouterChatBridge({
      router,
      chatProviders: new Map([
        ['anthropic-claude', failingClaude],
        ['ollama-local', createMockChatProvider({ content: 'Ollama fallback' })]
      ]),
      logger: silentLogger
    });

    const result = await bridge.chat({ system: 'test', messages: [], tools: [] });

    assert.strictEqual(result.content, 'Ollama fallback');
    assert.strictEqual(result._routing.isFallback, true);
    assert.strictEqual(result._routing.player, 'fallback');
    assert.strictEqual(result._routing.provider, 'ollama-local');
    assert.strictEqual(result._routing.primaryIsLocal, false);
    assert.strictEqual(result._routing.fallbackIsLocal, true);
    assert.deepStrictEqual(result._routing.failoverPath, ['anthropic-claude']);

    // Should have recorded failure then success
    assert.strictEqual(recordedOutcomes.length, 2);
    assert.strictEqual(recordedOutcomes[0].success, false);
    assert.strictEqual(recordedOutcomes[1].success, true);
  });

  await asyncTest('TC-BRIDGE-FAILOVER-002: increments router failover stats', async () => {
    const router = createMockRouter();
    router.stats.failovers = 0;

    const bridge = new RouterChatBridge({
      router,
      chatProviders: new Map([
        ['anthropic-claude', createMockChatProvider({ chat: async () => { throw new Error('fail'); } })],
        ['ollama-local', createMockChatProvider({ content: 'ok' })]
      ]),
      logger: silentLogger
    });

    await bridge.chat({ system: 'test', messages: [], tools: [] });
    assert.strictEqual(router.stats.failovers, 1);
  });

  // --- ForceLocal ---
  console.log('\n--- ForceLocal ---\n');

  await asyncTest('TC-BRIDGE-FORCELOCAL-001: passes forceLocal context to router', async () => {
    let receivedCtx = null;
    const router = createMockRouter({
      buildProviderChain: (job, ctx) => {
        receivedCtx = ctx;
        return {
          chain: [{ id: 'ollama-local', provider: { type: 'local' } }],
          skipped: []
        };
      }
    });

    const bridge = new RouterChatBridge({
      router,
      chatProviders: new Map([['ollama-local', createMockChatProvider()]])
    });

    await bridge.chat({ system: 'test', messages: [], tools: [], forceLocal: true });
    assert.strictEqual(receivedCtx.forceLocal, true);
  });

  // --- All Exhausted ---
  console.log('\n--- All Exhausted ---\n');

  await asyncTest('TC-BRIDGE-EXHAUSTED-001: throws with _errorChain when all fail', async () => {
    const router = createMockRouter();

    const bridge = new RouterChatBridge({
      router,
      chatProviders: new Map([
        ['anthropic-claude', createMockChatProvider({ chat: async () => { throw new Error('Claude down'); } })],
        ['ollama-local', createMockChatProvider({ chat: async () => { throw new Error('Ollama down'); } })]
      ]),
      logger: silentLogger
    });

    try {
      await bridge.chat({ system: 'test', messages: [], tools: [] });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('All providers exhausted'));
      assert.ok(err._errorChain, 'Should have _errorChain');
      assert.ok(err._errorChain.primary.includes('anthropic-claude'));
      assert.ok(err._errorChain.fallback.includes('ollama-local'));
    }
  });

  await asyncTest('TC-BRIDGE-EXHAUSTED-002: throws with status 429 when rate limited', async () => {
    const router = createMockRouter();
    const rateLimitErr = new Error('rate limited');
    rateLimitErr.status = 429;

    const bridge = new RouterChatBridge({
      router,
      chatProviders: new Map([
        ['anthropic-claude', createMockChatProvider({ chat: async () => { throw rateLimitErr; } })],
        ['ollama-local', createMockChatProvider({ chat: async () => { throw new Error('also down'); } })]
      ]),
      logger: silentLogger
    });

    try {
      await bridge.chat({ system: 'test', messages: [], tools: [] });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.strictEqual(err.status, 429);
    }
  });

  await asyncTest('TC-BRIDGE-EXHAUSTED-003: throws when no chat providers match router chain', async () => {
    const router = createMockRouter({
      buildProviderChain: () => ({
        chain: [{ id: 'deepseek', provider: { type: 'remote' } }],
        skipped: []
      })
    });

    const bridge = new RouterChatBridge({
      router,
      chatProviders: new Map([['ollama-local', createMockChatProvider()]])
    });

    try {
      await bridge.chat({ system: 'test', messages: [], tools: [] });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('All providers exhausted'));
      assert.ok(err._errorChain);
    }
  });

  // --- FallbackNotifier Integration ---
  console.log('\n--- FallbackNotifier Integration ---\n');

  await asyncTest('TC-BRIDGE-NOTIFY-001: calls fallbackNotifier on success', async () => {
    let notifiedResult = null;
    const router = createMockRouter();

    const bridge = new RouterChatBridge({
      router,
      chatProviders: new Map([
        ['anthropic-claude', createMockChatProvider({ content: 'ok' })],
        ['ollama-local', createMockChatProvider()]
      ])
    });
    bridge.fallbackNotifier = { onRouteComplete: (r) => { notifiedResult = r; } };

    await bridge.chat({ system: 'test', messages: [], tools: [] });

    assert.ok(notifiedResult, 'FallbackNotifier should have been called');
    assert.ok(notifiedResult._routing, '_routing should be attached');
    assert.strictEqual(notifiedResult._routing.isFallback, false);
  });

  await asyncTest('TC-BRIDGE-NOTIFY-002: calls fallbackNotifier on fallback', async () => {
    let notifiedResult = null;
    const router = createMockRouter();

    const bridge = new RouterChatBridge({
      router,
      chatProviders: new Map([
        ['anthropic-claude', createMockChatProvider({ chat: async () => { throw new Error('fail'); } })],
        ['ollama-local', createMockChatProvider({ content: 'fallback ok' })]
      ]),
      logger: silentLogger
    });
    bridge.fallbackNotifier = { onRouteComplete: (r) => { notifiedResult = r; } };

    await bridge.chat({ system: 'test', messages: [], tools: [] });

    assert.ok(notifiedResult, 'FallbackNotifier should have been called');
    assert.strictEqual(notifiedResult._routing.isFallback, true);
    assert.strictEqual(notifiedResult._routing.primaryIsLocal, false);
    assert.strictEqual(notifiedResult._routing.fallbackIsLocal, true);
  });

  await asyncTest('TC-BRIDGE-NOTIFY-003: silent on fallbackNotifier error', async () => {
    const router = createMockRouter();

    const bridge = new RouterChatBridge({
      router,
      chatProviders: new Map([
        ['anthropic-claude', createMockChatProvider({ content: 'ok' })],
        ['ollama-local', createMockChatProvider()]
      ])
    });
    bridge.fallbackNotifier = { onRouteComplete: () => { throw new Error('notifier exploded'); } };

    // Should not throw
    const result = await bridge.chat({ system: 'test', messages: [], tools: [] });
    assert.strictEqual(result.content, 'ok');
  });

  // --- Conversation Circuit Breaker ---
  console.log('\n--- Conversation Circuit Breaker ---\n');

  await asyncTest('TC-BRIDGE-CONVCB-001: skips provider that timed out earlier in conversation', async () => {
    const router = createMockRouter({
      buildProviderChain: () => ({
        chain: [
          { id: 'ollama-local', provider: { type: 'local' } },
          { id: 'anthropic-claude', provider: { type: 'remote' } }
        ],
        skipped: []
      })
    });

    let ollamaCallCount = 0;
    const ollamaProvider = createMockChatProvider({
      chat: async () => {
        ollamaCallCount++;
        throw new Error('Ollama request timed out after 60000ms');
      }
    });

    const bridge = new RouterChatBridge({
      router,
      chatProviders: new Map([
        ['ollama-local', ollamaProvider],
        ['anthropic-claude', createMockChatProvider({ content: 'Claude response' })]
      ]),
      logger: silentLogger
    });

    // First call: Ollama times out, falls back to Claude
    const result1 = await bridge.chat({ system: 'test', messages: [], tools: [] });
    assert.strictEqual(result1.content, 'Claude response');
    assert.strictEqual(ollamaCallCount, 1, 'Ollama should be called once');

    // Second call: Ollama should be SKIPPED (conversation circuit breaker)
    const result2 = await bridge.chat({ system: 'test', messages: [], tools: [] });
    assert.strictEqual(result2.content, 'Claude response');
    assert.strictEqual(ollamaCallCount, 1, 'Ollama should NOT be called again');
    assert.strictEqual(result2._routing.provider, 'anthropic-claude');
  });

  await asyncTest('TC-BRIDGE-CONVCB-002: resetConversation clears conversation failures', async () => {
    const router = createMockRouter({
      buildProviderChain: () => ({
        chain: [
          { id: 'ollama-local', provider: { type: 'local' } },
          { id: 'anthropic-claude', provider: { type: 'remote' } }
        ],
        skipped: []
      })
    });

    let ollamaCallCount = 0;
    const ollamaProvider = createMockChatProvider({
      chat: async () => {
        ollamaCallCount++;
        if (ollamaCallCount === 1) {
          throw new Error('Ollama request timed out after 60000ms');
        }
        return { content: 'Ollama response', toolCalls: null };
      }
    });

    const bridge = new RouterChatBridge({
      router,
      chatProviders: new Map([
        ['ollama-local', ollamaProvider],
        ['anthropic-claude', createMockChatProvider({ content: 'Claude response' })]
      ]),
      logger: silentLogger
    });

    // First call: Ollama times out
    await bridge.chat({ system: 'test', messages: [], tools: [] });
    assert.strictEqual(ollamaCallCount, 1);

    // Reset conversation — new user message
    bridge.resetConversation();

    // Third call: Ollama should be tried again
    const result = await bridge.chat({ system: 'test', messages: [], tools: [] });
    assert.strictEqual(ollamaCallCount, 2, 'Ollama should be retried after reset');
    assert.strictEqual(result.content, 'Ollama response');
  });

  await asyncTest('TC-BRIDGE-CONVCB-003: non-timeout errors do NOT trigger conversation skip', async () => {
    const router = createMockRouter({
      buildProviderChain: () => ({
        chain: [
          { id: 'ollama-local', provider: { type: 'local' } },
          { id: 'anthropic-claude', provider: { type: 'remote' } }
        ],
        skipped: []
      })
    });

    let ollamaCallCount = 0;
    const ollamaProvider = createMockChatProvider({
      chat: async () => {
        ollamaCallCount++;
        if (ollamaCallCount === 1) {
          throw new Error('Ollama error 500: internal server error');
        }
        return { content: 'Ollama recovered', toolCalls: null };
      }
    });

    const bridge = new RouterChatBridge({
      router,
      chatProviders: new Map([
        ['ollama-local', ollamaProvider],
        ['anthropic-claude', createMockChatProvider({ content: 'Claude response' })]
      ]),
      logger: silentLogger
    });

    // First call: Ollama 500 error (not a timeout), falls back to Claude
    await bridge.chat({ system: 'test', messages: [], tools: [] });
    assert.strictEqual(ollamaCallCount, 1);

    // Second call: Ollama should still be tried (not a timeout failure)
    const result = await bridge.chat({ system: 'test', messages: [], tools: [] });
    assert.strictEqual(ollamaCallCount, 2, 'Ollama should be retried after non-timeout error');
    assert.strictEqual(result.content, 'Ollama recovered');
  });

  await asyncTest('TC-BRIDGE-CONVCB-004: conversation skip shows in error chain when all exhausted', async () => {
    const router = createMockRouter({
      buildProviderChain: () => ({
        chain: [
          { id: 'ollama-local', provider: { type: 'local' } }
        ],
        skipped: []
      })
    });

    const bridge = new RouterChatBridge({
      router,
      chatProviders: new Map([
        ['ollama-local', createMockChatProvider({
          chat: async () => { throw new Error('Ollama request timed out after 60000ms'); }
        })]
      ]),
      logger: silentLogger
    });

    // First call: Ollama times out
    try {
      await bridge.chat({ system: 'test', messages: [], tools: [] });
    } catch (_e) { /* expected — only provider */ }

    // Second call: Ollama skipped, no providers left → should throw
    try {
      await bridge.chat({ system: 'test', messages: [], tools: [] });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('All providers exhausted'));
      assert.ok(err._errorChain.primary.includes('timed out in conversation') ||
                err._errorChain.fallback.includes('timed out in conversation'),
                'Error chain should mention conversation timeout');
    }
  });

  // --- Smart-Mix Local Skip ---
  console.log('\n--- Smart-Mix Local Skip ---\n');

  test('TC-BRIDGE-SKIP-001: skipLocalForConversation adds local providers to failures', () => {
    const router = createMockRouter();
    router.providers = new Map([
      ['ollama-local', { type: 'local' }],
      ['anthropic-claude', { type: 'remote' }]
    ]);

    const bridge = new RouterChatBridge({
      router,
      chatProviders: new Map([
        ['ollama-local', createMockChatProvider()],
        ['anthropic-claude', createMockChatProvider()]
      ]),
      logger: silentLogger
    });

    bridge.skipLocalForConversation();

    assert.ok(bridge._conversationFailures.has('ollama-local'),
      'ollama-local (local) should be in _conversationFailures');
    assert.ok(!bridge._conversationFailures.has('anthropic-claude'),
      'anthropic-claude (remote) should NOT be in _conversationFailures');
  });

  test('TC-BRIDGE-SKIP-002: skipLocalForConversation does NOT add cloud providers', () => {
    const router = createMockRouter();
    router.providers = new Map([
      ['ollama-local', { type: 'local' }],
      ['anthropic-claude', { type: 'remote' }]
    ]);

    const bridge = new RouterChatBridge({
      router,
      chatProviders: new Map([
        ['ollama-local', createMockChatProvider()],
        ['anthropic-claude', createMockChatProvider()]
      ]),
      logger: silentLogger
    });

    bridge.skipLocalForConversation();

    assert.ok(!bridge._conversationFailures.has('anthropic-claude'),
      'anthropic-claude (remote) should NOT be in _conversationFailures after skipLocalForConversation');
  });

  test('TC-BRIDGE-SKIP-003: resetConversation re-applies skip when _preSkipLocal is true', () => {
    const router = createMockRouter();
    router.providers = new Map([
      ['ollama-local', { type: 'local' }],
      ['anthropic-claude', { type: 'remote' }]
    ]);

    const bridge = new RouterChatBridge({
      router,
      chatProviders: new Map([
        ['ollama-local', createMockChatProvider()],
        ['anthropic-claude', createMockChatProvider()]
      ]),
      logger: silentLogger
    });

    // skipLocalForConversation sets _preSkipLocal = true
    bridge.skipLocalForConversation();
    assert.ok(bridge._preSkipLocal, '_preSkipLocal should be true');

    // resetConversation should re-apply the local skip
    bridge.resetConversation();

    assert.ok(bridge._conversationFailures.has('ollama-local'),
      'ollama-local should remain in _conversationFailures after resetConversation when _preSkipLocal is true');
  });

  test('TC-BRIDGE-SKIP-004: resetConversation fully clears when _preSkipLocal is false', () => {
    const router = createMockRouter();
    router.providers = new Map([
      ['ollama-local', { type: 'local' }],
      ['anthropic-claude', { type: 'remote' }]
    ]);

    const bridge = new RouterChatBridge({
      router,
      chatProviders: new Map([
        ['ollama-local', createMockChatProvider()],
        ['anthropic-claude', createMockChatProvider()]
      ]),
      logger: silentLogger
    });

    // Manually add ollama to failures without setting _preSkipLocal
    bridge._conversationFailures.add('ollama-local');
    assert.ok(!bridge._preSkipLocal, '_preSkipLocal should be false');

    bridge.resetConversation();

    assert.strictEqual(bridge._conversationFailures.size, 0,
      '_conversationFailures should be empty after resetConversation when _preSkipLocal is false');
  });

  test('TC-BRIDGE-SKIP-005: clearLocalSkip resets the flag and removes local from failures', () => {
    const router = createMockRouter();
    router.providers = new Map([
      ['ollama-local', { type: 'local' }],
      ['anthropic-claude', { type: 'remote' }]
    ]);

    const bridge = new RouterChatBridge({
      router,
      chatProviders: new Map([
        ['ollama-local', createMockChatProvider()],
        ['anthropic-claude', createMockChatProvider()]
      ]),
      logger: silentLogger
    });

    bridge.skipLocalForConversation();
    assert.ok(bridge._preSkipLocal, '_preSkipLocal should be true after skip');
    assert.ok(bridge._conversationFailures.has('ollama-local'), 'ollama-local should be in failures after skip');

    bridge.clearLocalSkip();

    assert.strictEqual(bridge._preSkipLocal, false,
      '_preSkipLocal should be false after clearLocalSkip');
    assert.ok(!bridge._conversationFailures.has('ollama-local'),
      'ollama-local should NOT be in _conversationFailures after clearLocalSkip');
  });

  await asyncTest('TC-BRIDGE-SKIP-006: chat() skips pre-skipped local providers', async () => {
    let ollamaCallCount = 0;
    const router = createMockRouter({
      buildProviderChain: () => ({
        chain: [
          { id: 'ollama-local', provider: { type: 'local' } },
          { id: 'anthropic-claude', provider: { type: 'remote' } }
        ],
        skipped: []
      })
    });
    router.providers = new Map([
      ['ollama-local', { type: 'local' }],
      ['anthropic-claude', { type: 'remote' }]
    ]);

    const ollamaProvider = createMockChatProvider({
      chat: async () => {
        ollamaCallCount++;
        return { content: 'Ollama response', toolCalls: null };
      }
    });

    const bridge = new RouterChatBridge({
      router,
      chatProviders: new Map([
        ['ollama-local', ollamaProvider],
        ['anthropic-claude', createMockChatProvider({ content: 'Claude response' })]
      ]),
      logger: silentLogger
    });

    // Pre-skip local providers (e.g. MicroPipeline classified as non-local)
    bridge.skipLocalForConversation();

    const result = await bridge.chat({ system: 'test', messages: [], tools: [] });

    assert.strictEqual(ollamaCallCount, 0, 'ollama should never be called when pre-skipped');
    assert.strictEqual(result.content, 'Claude response', 'result should come from Claude');
    assert.strictEqual(result._routing.provider, 'anthropic-claude');
  });

  // --- _routing Shape ---
  console.log('\n--- _routing Shape ---\n');

  await asyncTest('TC-BRIDGE-ROUTING-001: _routing has all required fields', async () => {
    const router = createMockRouter();

    const bridge = new RouterChatBridge({
      router,
      chatProviders: new Map([
        ['anthropic-claude', createMockChatProvider()],
        ['ollama-local', createMockChatProvider()]
      ])
    });

    const result = await bridge.chat({ system: 'test', messages: [], tools: [] });
    const r = result._routing;

    assert.strictEqual(typeof r.isFallback, 'boolean');
    assert.strictEqual(typeof r.primaryIsLocal, 'boolean');
    assert.strictEqual(typeof r.fallbackIsLocal, 'boolean');
    assert.ok(['primary', 'fallback'].includes(r.player));
    assert.strictEqual(typeof r.provider, 'string');
    assert.strictEqual(typeof r.job, 'string');
  });

  // --- Run ---
  summary();
  exitWithCode();
})();
