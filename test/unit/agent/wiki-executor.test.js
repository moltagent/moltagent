/*
 * MoltAgent - Sovereign AI Security Layer
 * Copyright (C) 2026 MoltAgent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

'use strict';

const assert = require('assert');
const { asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const WikiExecutor = require('../../../src/lib/agent/executors/wiki-executor');

const silentLogger = { log() {}, info() {}, warn() {}, error() {} };

// Layer 3: executors may return {response, actionRecord} objects
function getResponse(result) {
  return typeof result === 'object' && result !== null && result.response ? result.response : result;
}

function createMockRouter(extractResult) {
  return {
    route: async () => extractResult || { result: '{}' }
  };
}

/**
 * Create a mock tool registry that tracks calls per tool name.
 * @param {Object} responses - { toolName: returnValue } map
 * @returns {{ execute, getCalls, getCallsFor }}
 */
function createMockToolRegistry(responses = {}) {
  const calls = [];
  return {
    execute: async (name, args) => {
      calls.push({ name, args });
      if (responses[name]) {
        return typeof responses[name] === 'function' ? responses[name](args) : responses[name];
      }
      return { success: true, result: 'OK' };
    },
    getCalls: () => calls,
    getCallsFor: (name) => calls.filter(c => c.name === name)
  };
}

// -- Test 1: Read existing page by exact title --
asyncTest('Read existing page by exact title', async () => {
  const registry = createMockToolRegistry({
    wiki_read: { success: true, result: 'Christian Fu Mueller is a project lead at ACME Corp.' }
  });
  const executor = new WikiExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'read', page_title: 'Christian Fu Mueller' })
    }),
    toolRegistry: registry,
    logger: silentLogger
  });

  const result = await executor.execute('What does the wiki say about Christian Fu Mueller?', { userName: 'alice' });
  const resp = getResponse(result);
  assert.ok(resp.includes('Christian Fu Mueller'), `Should return page content, got: ${resp}`);
  assert.strictEqual(registry.getCallsFor('wiki_read').length, 1, 'Should call wiki_read once');
  assert.strictEqual(registry.getCallsFor('wiki_write').length, 0, 'Should NOT call wiki_write');
});

// -- Test 2: Read with memory_search fallback --
asyncTest('Read with memory_search fallback when exact title fails', async () => {
  let readCallCount = 0;
  const registry = createMockToolRegistry({
    wiki_read: (args) => {
      readCallCount++;
      if (readCallCount === 1) {
        return { success: true, result: 'No wiki page found for "Chris Mueller"' };
      }
      return { success: true, result: 'Christian Fu Mueller leads the Berlin team.' };
    },
    memory_search: { success: true, result: '**Christian Fu Mueller** [wiki] — project lead at ACME' }
  });
  const executor = new WikiExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'read', topic: 'Chris Mueller' })
    }),
    toolRegistry: registry,
    logger: silentLogger
  });

  const result = await executor.execute('What do we know about Chris Mueller?', { userName: 'alice' });
  const resp = getResponse(result);
  assert.ok(resp.includes('Berlin team'), `Should return page content from fallback, got: ${resp}`);
  assert.strictEqual(registry.getCallsFor('memory_search').length, 1, 'Should call memory_search');
  assert.strictEqual(registry.getCallsFor('wiki_write').length, 0, 'Should NOT call wiki_write');
});

// -- Test 3: Read non-existent page --
asyncTest('Read non-existent page returns friendly message', async () => {
  const registry = createMockToolRegistry({
    wiki_read: { success: true, result: 'No wiki page found for "Nonexistent Topic"' },
    memory_search: { success: true, result: 'No matching memories found.' }
  });
  const executor = new WikiExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'read', page_title: 'Nonexistent Topic' })
    }),
    toolRegistry: registry,
    logger: silentLogger
  });

  const result = await executor.execute('What does the wiki say about Nonexistent Topic?', { userName: 'alice' });
  const resp = getResponse(result);
  assert.ok(resp.includes("I don't have a wiki page"), `Should return not-found message, got: ${resp}`);
  assert.ok(resp.includes('Nonexistent Topic'), 'Should include the topic name');
  assert.strictEqual(registry.getCallsFor('wiki_write').length, 0, 'Should NOT call wiki_write');
});

// -- Test 4: Read with empty title asks for clarification --
asyncTest('Read with empty title returns clarification request', async () => {
  const registry = createMockToolRegistry();
  const executor = new WikiExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'read', page_title: '', topic: '' })
    }),
    toolRegistry: registry,
    logger: silentLogger
  });

  const result = await executor.execute('Look up the wiki', { userName: 'alice' });
  const resp = getResponse(result);
  assert.ok(resp.includes('look up'), `Should ask what to look up, got: ${resp}`);
  assert.strictEqual(registry.getCallsFor('wiki_write').length, 0, 'Should NOT call wiki_write');
});

// -- Test 5: Default/unknown action falls to read --
asyncTest('Default/unknown action falls to read path', async () => {
  const registry = createMockToolRegistry({
    wiki_read: { success: true, result: 'Some wiki content about testing.' }
  });
  const executor = new WikiExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'search', page_title: 'Testing' })
    }),
    toolRegistry: registry,
    logger: silentLogger
  });

  const result = await executor.execute('Search wiki for testing', { userName: 'alice' });
  const resp = getResponse(result);
  assert.ok(resp.includes('wiki content'), `Should return content via read path, got: ${resp}`);
  assert.strictEqual(registry.getCallsFor('wiki_write').length, 0, 'Unknown action should NOT call wiki_write');
});

// -- Test 6: Write new page --
asyncTest('Write new page calls wiki_write and reports created', async () => {
  const registry = createMockToolRegistry({
    wiki_write: { success: true, result: 'Page created' }
  });
  const executor = new WikiExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'write', page_title: 'Meeting Notes', content: 'Discussion points', topic: 'meeting' })
    }),
    toolRegistry: registry,
    logger: silentLogger
  });

  const result = await executor.execute('Write wiki page Meeting Notes', { userName: 'alice' });
  const resp = getResponse(result);
  assert.ok(resp.includes('Meeting Notes'), `Should confirm page title, got: ${resp}`);
  assert.ok(resp.includes('Saved'), `Should report saved, got: ${resp}`);
  const call = registry.getCallsFor('wiki_write')[0];
  assert.strictEqual(call.args.page_title, 'Meeting Notes');
  assert.strictEqual(call.args.content, 'Discussion points');
});

// -- Test 7: Write with missing content returns clarification --
asyncTest('Write with missing content returns clarification', async () => {
  const registry = createMockToolRegistry();
  const executor = new WikiExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'write', page_title: 'Empty Page', content: '' })
    }),
    toolRegistry: registry,
    logger: silentLogger
  });

  const result = await executor.execute('Write a wiki page called Empty Page', { userName: 'alice' });
  const resp = getResponse(result);
  assert.ok(resp.includes('content'), `Should ask for content, got: ${resp}`);
  assert.strictEqual(registry.getCallsFor('wiki_write').length, 0, 'Should NOT call wiki_write without content');
});

// -- Test 8: Write failure surfaces error --
asyncTest('Write failure surfaces error honestly', async () => {
  const registry = createMockToolRegistry({
    wiki_write: { success: false, error: 'API connection refused' }
  });
  const executor = new WikiExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'write', page_title: 'Broken', content: 'Test content' })
    }),
    toolRegistry: registry,
    logger: silentLogger
  });

  const result = await executor.execute('Write wiki page Broken', { userName: 'alice' });
  const resp = getResponse(result);
  assert.ok(resp.includes('failed') || resp.includes('error'), `Should report error, got: ${resp}`);
  assert.ok(resp.includes('API connection refused'), `Should include error detail, got: ${resp}`);
});

// -- Test 9: Append to existing page merges content --
asyncTest('Append to existing page reads then writes merged content', async () => {
  const registry = createMockToolRegistry({
    wiki_read: { success: true, result: 'Existing content line 1.' },
    wiki_write: { success: true, result: 'Page updated' }
  });
  const executor = new WikiExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'append', page_title: 'Daily Log', content: 'New entry today', topic: 'log' })
    }),
    toolRegistry: registry,
    logger: silentLogger
  });

  const result = await executor.execute('Append to daily log', { userName: 'alice' });
  const resp = getResponse(result);
  assert.ok(resp.includes('Appended'), `Should confirm append, got: ${resp}`);
  const writeCall = registry.getCallsFor('wiki_write')[0];
  assert.ok(writeCall.args.content.includes('Existing content line 1.'), 'Merged content should include original');
  assert.ok(writeCall.args.content.includes('New entry today'), 'Merged content should include new entry');
});

// -- Test 10: Append to non-existent page creates new --
asyncTest('Append to non-existent page falls through to create', async () => {
  const registry = createMockToolRegistry({
    wiki_read: { success: true, result: 'No wiki page found for "New Log"' },
    wiki_write: { success: true, result: 'Page created' }
  });
  const executor = new WikiExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'append', page_title: 'New Log', content: 'First entry', topic: 'log' })
    }),
    toolRegistry: registry,
    logger: silentLogger
  });

  const result = await executor.execute('Append to New Log wiki', { userName: 'alice' });
  const resp = getResponse(result);
  assert.ok(resp.includes('Saved') || resp.includes('New Log'), `Should create new page, got: ${resp}`);
  assert.strictEqual(registry.getCallsFor('wiki_write').length, 1, 'Should call wiki_write to create');
});

// -- Test 11: REGRESSION — Read action NEVER triggers wiki_write --
asyncTest('REGRESSION: Read action never triggers wiki_write', async () => {
  const registry = createMockToolRegistry({
    wiki_read: { success: true, result: 'No wiki page found for "Test"' },
    memory_search: { success: true, result: 'No matching memories found.' }
  });
  const executor = new WikiExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'read', page_title: 'Test' })
    }),
    toolRegistry: registry,
    logger: silentLogger
  });

  await executor.execute('What does the wiki say about Test?', { userName: 'alice' });
  assert.strictEqual(
    registry.getCallsFor('wiki_write').length, 0,
    'wiki_write must NEVER be called for action: read'
  );
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
