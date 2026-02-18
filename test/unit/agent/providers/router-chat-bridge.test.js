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
