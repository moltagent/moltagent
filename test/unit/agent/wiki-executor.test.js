'use strict';

const assert = require('assert');
const { asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const WikiExecutor = require('../../../src/lib/agent/executors/wiki-executor');

const silentLogger = { log() {}, info() {}, warn() {}, error() {} };

function createMockRouter(extractResult) {
  return {
    route: async () => extractResult || { result: '{}' }
  };
}

function createMockToolRegistry(writeResult) {
  const calls = [];
  return {
    execute: async (name, args) => {
      calls.push({ name, args });
      return writeResult || { success: true, result: 'Page created' };
    },
    getCalls: () => calls
  };
}

// -- Test 1: Writes wiki page with extracted params --
asyncTest('Writes wiki page with extracted params', async () => {
  const registry = createMockToolRegistry();
  const executor = new WikiExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'write', page_title: 'Meeting Notes', content: 'Discussion points', topic: 'meeting' })
    }),
    toolRegistry: registry,
    logger: silentLogger
  });

  const result = await executor.execute('Write wiki page Meeting Notes', { userName: 'alice' });
  assert.ok(result.includes('Meeting Notes'), 'Should confirm page title');
  const call = registry.getCalls()[0];
  assert.strictEqual(call.name, 'wiki_write');
  assert.strictEqual(call.args.page_title, 'Meeting Notes');
});

// -- Test 2: Auto-categorizes into parent section --
asyncTest('Auto-categorizes topic into parent section', async () => {
  const registry = createMockToolRegistry();
  const executor = new WikiExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'remember', topic: 'project timeline', fact: 'Project deadline is March 15' })
    }),
    toolRegistry: registry,
    logger: silentLogger
  });

  await executor.execute('Remember project deadline is March 15', { userName: 'alice' });
  const call = registry.getCalls()[0];
  assert.strictEqual(call.args.parent, 'Projects', 'Should auto-categorize under Projects');
});

// -- Test 3: Guardrail check runs before write --
asyncTest('Guardrail check blocks wiki write when denied', async () => {
  const executor = new WikiExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'write', page_title: 'Secret', content: 'classified' })
    }),
    toolRegistry: createMockToolRegistry(),
    guardrailEnforcer: {
      check: async () => ({ allowed: false, reason: 'Wiki write blocked' }),
      checkApproval: async () => ({ allowed: true })
    },
    logger: silentLogger
  });

  const result = await executor.execute('Write secret wiki page', { userName: 'alice' });
  assert.ok(result.includes('blocked'));
});

// -- Test 4: Falls back on parse failure --
asyncTest('Throws DOMAIN_ESCALATE on parse failure', async () => {
  const executor = new WikiExecutor({
    router: createMockRouter({ result: 'not json' }),
    toolRegistry: createMockToolRegistry(),
    logger: silentLogger
  });

  try {
    await executor.execute('Something unparseable', { userName: 'alice' });
    assert.fail('Should have thrown');
  } catch (err) {
    assert.strictEqual(err.code, 'DOMAIN_ESCALATE');
  }
});

// -- Test 5: Handles append action --
asyncTest('Handles append action with correct type', async () => {
  const registry = createMockToolRegistry();
  const executor = new WikiExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'append', page_title: 'Daily Log', content: 'New entry', topic: 'log' })
    }),
    toolRegistry: registry,
    logger: silentLogger
  });

  await executor.execute('Append to daily log', { userName: 'alice' });
  const call = registry.getCalls()[0];
  assert.strictEqual(call.args.type, 'append', 'Should use append type');
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
