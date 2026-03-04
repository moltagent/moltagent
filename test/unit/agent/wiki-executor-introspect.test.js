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

const silentLogger = { log() {}, info() {}, warn() {}, error() {}, debug() {} };

function getResponse(result) {
  return typeof result === 'object' && result !== null && result.response ? result.response : result;
}

function createMockRouter(extractResult) {
  return {
    route: async () => extractResult || { result: '{}' }
  };
}

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

// -- Test 1: Introspect action triggers _executeIntrospect --
asyncTest('Introspect action triggers _executeIntrospect and returns wiki content', async () => {
  const registry = createMockToolRegistry({
    wiki_read: (args) => {
      // Simulate "People" and "Projects" sections existing
      if (args.page_title === 'People') return { success: true, result: 'Alice, Bob' };
      if (args.page_title === 'Projects') return { success: true, result: 'Project Alpha' };
      // All other sections return not found
      return { success: true, result: 'No wiki page found for the requested page' };
    },
    memory_search: { success: true, result: 'No matching memories found.' }
  });

  const executor = new WikiExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'introspect' })
    }),
    toolRegistry: registry,
    logger: silentLogger
  });

  const result = await executor.execute("What's in your wiki?", { userName: 'alice' });
  const resp = getResponse(result);

  assert.ok(resp.toLowerCase().includes('wiki'), `Response should mention wiki, got: ${resp}`);
  assert.ok(resp.includes('People'), `Response should list People section, got: ${resp}`);
  assert.ok(resp.includes('Projects'), `Response should list Projects section, got: ${resp}`);
  assert.ok(result.actionRecord, 'Should return actionRecord');
  assert.strictEqual(result.actionRecord.type, 'wiki_introspect', 'actionRecord type should be wiki_introspect');
});

// -- Test 2: Empty wiki returns "no pages" message --
asyncTest('Empty wiki returns message indicating no pages exist', async () => {
  const registry = createMockToolRegistry({
    // All wiki_read calls return not-found
    wiki_read: { success: true, result: 'No wiki page found for the requested page' },
    // memory_search returns nothing
    memory_search: { success: true, result: 'No matching memories found.' }
  });

  const executor = new WikiExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'introspect' })
    }),
    toolRegistry: registry,
    logger: silentLogger
  });

  const result = await executor.execute("What's in your wiki?", { userName: 'alice' });
  const resp = getResponse(result);

  assert.ok(resp.toLowerCase().includes('empty'), `Response should indicate empty wiki, got: ${resp}`);
  assert.ok(result.actionRecord, 'Should return actionRecord even for empty wiki');
  assert.strictEqual(result.actionRecord.refs.pageCount, 0, 'pageCount should be 0');
});

// -- Test 3: Introspect lists known pages from memory_search --
asyncTest('Introspect lists known pages extracted from memory_search results', async () => {
  const registry = createMockToolRegistry({
    // No sections found via wiki_read
    wiki_read: { success: true, result: 'No wiki page found for the requested page' },
    // memory_search returns formatted pages
    memory_search: {
      success: true,
      result: '**Carlos** [wiki] — contact at TheCatalyne\n**Project Alpha** [wiki] — Q3 initiative\n**Meeting Notes 2026** [wiki] — quarterly review'
    }
  });

  const executor = new WikiExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'introspect' })
    }),
    toolRegistry: registry,
    logger: silentLogger
  });

  const result = await executor.execute("What pages are in your wiki?", { userName: 'alice' });
  const resp = getResponse(result);

  assert.ok(resp.includes('Carlos'), `Response should include Carlos page, got: ${resp}`);
  assert.ok(resp.includes('Project Alpha'), `Response should include Project Alpha page, got: ${resp}`);
  assert.ok(resp.includes('Meeting Notes 2026'), `Response should include Meeting Notes page, got: ${resp}`);
  assert.ok(result.actionRecord.refs.pageCount > 0, 'pageCount should reflect found pages');
});

// -- Test 4: Introspect never calls wiki_write --
asyncTest('Introspect action never calls wiki_write', async () => {
  const registry = createMockToolRegistry({
    wiki_read: { success: true, result: 'Some section content' },
    memory_search: {
      success: true,
      result: '**SomePage** [wiki] — some content'
    }
  });

  const executor = new WikiExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'introspect' })
    }),
    toolRegistry: registry,
    logger: silentLogger
  });

  await executor.execute("What's in your wiki?", { userName: 'alice' });

  assert.strictEqual(
    registry.getCallsFor('wiki_write').length,
    0,
    'wiki_write must NEVER be called for action: introspect'
  );
});

// -- Test 5: Topic-bearing "know about X" routes to read, NOT introspect --
asyncTest('Topic-bearing query routes to read with memory_search, not introspect', async () => {
  const registry = createMockToolRegistry({
    wiki_read: (args) => {
      if (args.page_title === 'Document Handling') {
        return { success: true, result: 'Procedures for reading and processing documents' };
      }
      return { success: true, result: 'No wiki page found for the requested page' };
    },
    memory_search: {
      success: true,
      result: '**Document Handling** [wiki] — procedures for reading and processing documents'
    }
  });

  const executor = new WikiExecutor({
    router: createMockRouter({
      // LLM correctly classifies as read (not introspect) because there's a topic
      result: JSON.stringify({ action: 'read', topic: 'reading documents' })
    }),
    toolRegistry: registry,
    logger: silentLogger
  });

  const result = await executor.execute('What do you know about reading documents?', { userName: 'alice' });
  const resp = getResponse(result);

  // Should search, not list structure
  assert.ok(registry.getCallsFor('memory_search').length >= 1, 'Should call memory_search for topic query');
  assert.ok(resp.includes('reading and processing documents'), `Should return search result, got: ${resp}`);
  // Should NOT produce wiki_introspect actionRecord
  if (result.actionRecord) {
    assert.notStrictEqual(result.actionRecord.type, 'wiki_introspect',
      'Topic query should NOT produce wiki_introspect actionRecord');
  }
});

// -- Test 6: "about Carlos" routes to read, not introspect --
asyncTest('"What do you know about Carlos" routes to read', async () => {
  const registry = createMockToolRegistry({
    wiki_read: { success: true, result: 'Carlos is the contact at TheCatalyne.' }
  });

  const executor = new WikiExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'read', topic: 'Carlos' })
    }),
    toolRegistry: registry,
    logger: silentLogger
  });

  const result = await executor.execute('What do you know about Carlos?', { userName: 'alice' });
  const resp = getResponse(result);

  assert.ok(resp.includes('Carlos'), `Should return Carlos page, got: ${resp}`);
  assert.ok(result.actionRecord, 'Should have actionRecord');
  assert.strictEqual(result.actionRecord.type, 'wiki_read', 'Should be wiki_read, not wiki_introspect');
});

// -- Test 7: No-topic structural query still routes to introspect --
asyncTest('Structural query with no topic still routes to introspect', async () => {
  const registry = createMockToolRegistry({
    wiki_read: (args) => {
      if (args.page_title === 'People') return { success: true, result: 'Alice, Bob' };
      return { success: true, result: 'No wiki page found for the requested page' };
    },
    memory_search: { success: true, result: 'No matching memories found.' }
  });

  const executor = new WikiExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'introspect' })
    }),
    toolRegistry: registry,
    logger: silentLogger
  });

  const result = await executor.execute('Show me your knowledge base', { userName: 'alice' });
  const resp = getResponse(result);

  assert.ok(resp.toLowerCase().includes('wiki') || resp.includes('People'), `Response should mention wiki or sections, got: ${resp}`);
  assert.ok(result.actionRecord, 'Should have actionRecord');
  assert.strictEqual(result.actionRecord.type, 'wiki_introspect', 'No-topic query should be wiki_introspect');
});

// -- Test 8: Safety net reclassifies introspect+topic to read --
asyncTest('Safety net: introspect with topic reclassified to read', async () => {
  const registry = createMockToolRegistry({
    wiki_read: { success: true, result: 'Carlos is the contact at TheCatalyne.' }
  });

  const executor = new WikiExecutor({
    router: createMockRouter({
      // LLM misclassified as introspect despite having a topic
      result: JSON.stringify({ action: 'introspect', topic: 'Carlos' })
    }),
    toolRegistry: registry,
    logger: silentLogger
  });

  const result = await executor.execute('What do you know about Carlos?', { userName: 'alice' });
  const resp = getResponse(result);

  assert.ok(resp.includes('Carlos'), `Should search for Carlos, got: ${resp}`);
  assert.ok(result.actionRecord, 'Should have actionRecord');
  assert.strictEqual(result.actionRecord.type, 'wiki_read',
    'Safety net should reclassify introspect+topic to wiki_read');
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
