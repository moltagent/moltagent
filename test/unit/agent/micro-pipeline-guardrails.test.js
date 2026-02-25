'use strict';

const assert = require('assert');
const { asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const MicroPipeline = require('../../../src/lib/agent/micro-pipeline');

const silentLogger = { log() {}, info() {}, warn() {}, error() {} };

function createMockRouter(routeResponse) {
  return {
    route: async () => routeResponse || { result: 'Mock response', provider: 'mock', tokens: 10 },
    hasCloudPlayers: () => false,
    isCloudAvailable: async () => false
  };
}

function createMockToolRegistry() {
  const calls = [];
  return {
    execute: async (name, args) => {
      calls.push({ name, args });
      return { success: true, result: `Executed ${name}` };
    },
    getToolSubset: () => [{
      function: { name: 'deck_list_cards', parameters: {} }
    }],
    setRequestContext: () => {},
    getCalls: () => calls
  };
}

function createMockToolGuard(evaluateResult) {
  return {
    evaluate: (_name) => evaluateResult || { allowed: true, reason: '', level: 'ALLOWED' }
  };
}

function createMockGuardrailEnforcer(checkResult, approvalResult) {
  return {
    check: async (_name, _args, _roomToken) => checkResult || { allowed: true },
    checkApproval: async (_name, _args, _roomToken, _history) => approvalResult || { allowed: true }
  };
}

function createMockOllamaToolsProvider(chatResult) {
  return {
    model: 'test-model',
    chat: async () => chatResult || { content: 'Done.', toolCalls: [] }
  };
}

// -- Test 1: _executeWithGuards() passes through when no guards set --
asyncTest('_executeWithGuards() passes through when no guards set', async () => {
  const registry = createMockToolRegistry();
  const pipeline = new MicroPipeline({
    llmRouter: createMockRouter(),
    toolRegistry: registry,
    logger: silentLogger
  });
  const result = await pipeline._executeWithGuards({ name: 'deck_list_cards', arguments: {} }, null);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.result, 'Executed deck_list_cards');
});

// -- Test 2: ToolGuard FORBIDDEN blocks tool entirely --
asyncTest('ToolGuard FORBIDDEN blocks tool entirely', async () => {
  const pipeline = new MicroPipeline({
    llmRouter: createMockRouter(),
    toolRegistry: createMockToolRegistry(),
    toolGuard: createMockToolGuard({ allowed: false, reason: 'Forbidden operation', level: 'FORBIDDEN' }),
    logger: silentLogger
  });
  const result = await pipeline._executeWithGuards({ name: 'modify_system_prompt', arguments: {} }, null);
  assert.strictEqual(result.success, false);
  assert.ok(result.error.includes('security policy'));
});

// -- Test 3: ToolGuard APPROVAL_REQUIRED → checkApproval() approved → executes --
asyncTest('ToolGuard APPROVAL_REQUIRED + approved → executes', async () => {
  const registry = createMockToolRegistry();
  const pipeline = new MicroPipeline({
    llmRouter: createMockRouter(),
    toolRegistry: registry,
    toolGuard: createMockToolGuard({ allowed: false, reason: 'Needs approval', level: 'APPROVAL_REQUIRED' }),
    guardrailEnforcer: createMockGuardrailEnforcer({ allowed: true }, { allowed: true }),
    logger: silentLogger
  });
  const result = await pipeline._executeWithGuards({ name: 'mail_send', arguments: { to: 'test@test.com' } }, 'room1');
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.result, 'Executed mail_send');
});

// -- Test 4: ToolGuard APPROVAL_REQUIRED → checkApproval() denied → blocks --
asyncTest('ToolGuard APPROVAL_REQUIRED + denied → blocks', async () => {
  const pipeline = new MicroPipeline({
    llmRouter: createMockRouter(),
    toolRegistry: createMockToolRegistry(),
    toolGuard: createMockToolGuard({ allowed: false, reason: 'Needs approval', level: 'APPROVAL_REQUIRED' }),
    guardrailEnforcer: createMockGuardrailEnforcer(
      { allowed: true },
      { allowed: false, reason: 'User denied' }
    ),
    logger: silentLogger
  });
  const result = await pipeline._executeWithGuards({ name: 'mail_send', arguments: {} }, 'room1');
  assert.strictEqual(result.success, false);
  assert.ok(result.error.includes('User denied'));
});

// -- Test 5: ToolGuard APPROVAL_REQUIRED without guardrailEnforcer → hard block --
asyncTest('ToolGuard APPROVAL_REQUIRED without guardrailEnforcer → hard block', async () => {
  const pipeline = new MicroPipeline({
    llmRouter: createMockRouter(),
    toolRegistry: createMockToolRegistry(),
    toolGuard: createMockToolGuard({ allowed: false, reason: 'Needs approval', level: 'APPROVAL_REQUIRED' }),
    logger: silentLogger
  });
  const result = await pipeline._executeWithGuards({ name: 'mail_send', arguments: {} }, 'room1');
  assert.strictEqual(result.success, false);
  assert.ok(result.error.includes('security policy'));
});

// -- Test 6: GuardrailEnforcer.check() blocks sensitive tool --
asyncTest('GuardrailEnforcer.check() blocks sensitive tool (mail_send)', async () => {
  const pipeline = new MicroPipeline({
    llmRouter: createMockRouter(),
    toolRegistry: createMockToolRegistry(),
    guardrailEnforcer: createMockGuardrailEnforcer({ allowed: false, reason: 'Email requires confirmation' }),
    logger: silentLogger
  });
  const result = await pipeline._executeWithGuards({ name: 'mail_send', arguments: {} }, 'room1');
  assert.strictEqual(result.success, false);
  assert.ok(result.error.includes('Email requires confirmation'));
});

// -- Test 7: GuardrailEnforcer.check() passes non-sensitive tool --
asyncTest('GuardrailEnforcer.check() passes non-sensitive tool (deck_list_cards)', async () => {
  const registry = createMockToolRegistry();
  const pipeline = new MicroPipeline({
    llmRouter: createMockRouter(),
    toolRegistry: registry,
    guardrailEnforcer: createMockGuardrailEnforcer({ allowed: true }),
    logger: silentLogger
  });
  const result = await pipeline._executeWithGuards({ name: 'deck_list_cards', arguments: {} }, null);
  assert.strictEqual(result.success, true);
});

// -- Test 8: Edit requests treated as blocks --
asyncTest('Edit requests from GuardrailEnforcer treated as blocks', async () => {
  const pipeline = new MicroPipeline({
    llmRouter: createMockRouter(),
    toolRegistry: createMockToolRegistry(),
    guardrailEnforcer: createMockGuardrailEnforcer({
      allowed: false,
      reason: 'User wants to edit',
      editRequest: true,
      editMessage: 'change the subject'
    }),
    logger: silentLogger
  });
  const result = await pipeline._executeWithGuards({ name: 'mail_send', arguments: {} }, 'room1');
  assert.strictEqual(result.success, false);
  assert.ok(result.error.includes('blocked'));
});

// -- Test 9: Guard chain order: ToolGuard before GuardrailEnforcer --
asyncTest('Guard chain: ToolGuard runs before GuardrailEnforcer', async () => {
  let guardrailCalled = false;
  const pipeline = new MicroPipeline({
    llmRouter: createMockRouter(),
    toolRegistry: createMockToolRegistry(),
    toolGuard: createMockToolGuard({ allowed: false, reason: 'Forbidden', level: 'FORBIDDEN' }),
    guardrailEnforcer: {
      check: async () => { guardrailCalled = true; return { allowed: true }; },
      checkApproval: async () => { guardrailCalled = true; return { allowed: true }; }
    },
    logger: silentLogger
  });
  const result = await pipeline._executeWithGuards({ name: 'evil_tool', arguments: {} }, null);
  assert.strictEqual(result.success, false);
  assert.strictEqual(guardrailCalled, false, 'GuardrailEnforcer should NOT be called when ToolGuard FORBIDDEN');
});

// -- Test 10: _handleDomainTask() routes tool calls through guards --
asyncTest('_handleDomainTask() routes tool calls through guards', async () => {
  let guardChecked = false;
  const pipeline = new MicroPipeline({
    llmRouter: createMockRouter(),
    toolRegistry: {
      getToolSubset: () => [{ function: { name: 'mail_send', parameters: {} } }],
      execute: async () => ({ success: true, result: 'Sent' }),
      setRequestContext: () => {}
    },
    ollamaToolsProvider: createMockOllamaToolsProvider({
      content: '',
      toolCalls: [{ name: 'mail_send', arguments: { to: 'a@b.com', subject: 'Hi', body: 'Hello' } }]
    }),
    guardrailEnforcer: {
      check: async (_name) => { guardChecked = true; return { allowed: false, reason: 'Blocked by test' }; },
      checkApproval: async () => ({ allowed: true })
    },
    logger: silentLogger
  });
  await pipeline._handleDomainTask('Send email to a@b.com', 'email', { roomToken: 'r1' });
  assert.strictEqual(guardChecked, true, 'GuardrailEnforcer.check() should have been called');
});

// -- Test 11: No roomToken: GuardrailEnforcer still runs --
asyncTest('No roomToken: GuardrailEnforcer still runs (handles null internally)', async () => {
  let enforceCalledWithNull = false;
  const pipeline = new MicroPipeline({
    llmRouter: createMockRouter(),
    toolRegistry: createMockToolRegistry(),
    guardrailEnforcer: {
      check: async (_name, _args, roomToken) => {
        enforceCalledWithNull = (roomToken === null);
        return { allowed: true };
      },
      checkApproval: async () => ({ allowed: true })
    },
    logger: silentLogger
  });
  await pipeline._executeWithGuards({ name: 'deck_list_cards', arguments: {} }, null);
  assert.strictEqual(enforceCalledWithNull, true, 'GuardrailEnforcer should be called with null roomToken');
});

// -- Test 12: Graceful when both guards null — direct execute --
asyncTest('Graceful when both guards null — direct execute', async () => {
  const registry = createMockToolRegistry();
  const pipeline = new MicroPipeline({
    llmRouter: createMockRouter(),
    toolRegistry: registry,
    logger: silentLogger
  });
  // Both guards are null by default
  assert.strictEqual(pipeline.toolGuard, null);
  assert.strictEqual(pipeline.guardrailEnforcer, null);
  const result = await pipeline._executeWithGuards({ name: 'deck_list_cards', arguments: {} }, null);
  assert.strictEqual(result.success, true);
  assert.deepStrictEqual(registry.getCalls(), [{ name: 'deck_list_cards', args: {} }]);
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
