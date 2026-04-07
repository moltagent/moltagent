/*
 * Moltagent - Sovereign AI Security Layer
 * Copyright (C) 2026 Moltagent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

'use strict';
// Mock type: LEGACY — TODO: migrate to realistic mocks

const assert = require('assert');
const { asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const WikiExecutor = require('../../../src/lib/agent/executors/wiki-executor');

// NOTE: Collectives WebDAV requires pages to exist in
// OCS database before PUT. Mocks should reject PUT to
// non-existent pages to catch this class of bug.
// See: 2026-03-05 triple production failure diagnostic.

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

// -- Test 2: Read with possessive stripping --
asyncTest('Read strips possessive to find page', async () => {
  const registry = createMockToolRegistry({
    wiki_read: (args) => {
      if (args.page_title === "Jordan's Preferences") {
        return { success: true, result: 'No wiki page found for "Jordan\'s Preferences"' };
      }
      if (args.page_title === 'Jordan Preferences') {
        return { success: true, result: 'Preferred meeting time: mornings' };
      }
      return { success: true, result: 'No wiki page found' };
    }
  });
  const executor = new WikiExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'read', page_title: "Jordan's Preferences" })
    }),
    toolRegistry: registry,
    logger: silentLogger
  });

  const result = await executor.execute("What does the wiki say about Jordan's Preferences?", { userName: 'alice' });
  const resp = getResponse(result);
  assert.ok(resp.includes('mornings'), `Should find page via stripped possessive, got: ${resp}`);
  assert.strictEqual(registry.getCallsFor('wiki_write').length, 0, 'Should NOT call wiki_write');
});

// -- Test 3: Read with memory_search fallback --
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
  assert.ok(resp.includes("I don't have anything about"), `Should return not-found message, got: ${resp}`);
  assert.ok(resp.includes('Nonexistent Topic'), 'Should include the topic name');
  assert.strictEqual(registry.getCallsFor('wiki_write').length, 0, 'Should NOT call wiki_write');
});

// -- Test 4: Read empty page returns "exists but no content" --
asyncTest('Read empty page reports it exists but has no content', async () => {
  const registry = createMockToolRegistry({
    wiki_read: { success: true, result: '' }
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
  assert.ok(resp.includes('exists') && resp.includes('no content'), `Should report page exists but empty, got: ${resp}`);
  assert.strictEqual(registry.getCallsFor('wiki_write').length, 0, 'Should NOT call wiki_write for empty page');
  assert.ok(result.actionRecord, 'Should return actionRecord for found page');
  assert.strictEqual(result.actionRecord.type, 'wiki_read', 'Action type should be wiki_read');
});

// -- Test 5: Read with empty title asks for clarification --
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
  assert.ok(call.args.page_title, 'Should have page_title');
  assert.ok(call.args.content.includes('Discussion points'), 'Content should include raw text');
  assert.ok(call.args.content.includes('---'), 'Content should include frontmatter delimiters');
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

// -- Test 12: No-match falls back to warmMemory synthesis --
asyncTest('No-match falls back to warmMemory synthesis from enricher', async () => {
  let routeCallCount = 0;
  const registry = createMockToolRegistry({
    wiki_read: { success: true, result: 'No wiki page found for "document reading"' },
    memory_search: { success: true, result: 'No matching memories found.' }
  });

  const executor = new WikiExecutor({
    router: {
      route: async (req) => {
        routeCallCount++;
        if (routeCallCount === 1) {
          // First call: JSON extraction
          return { result: JSON.stringify({ action: 'read', topic: 'document reading' }) };
        }
        // Second call: synthesis from warm memory
        return { result: 'Based on my knowledge, document reading involves using the FileOps tool to process uploaded files.' };
      }
    },
    toolRegistry: registry,
    logger: silentLogger
  });

  const context = {
    userName: 'alice',
    warmMemory: '<agent_knowledge>\n[source: wiki, confidence: high]\nFileOps\nFileOps is the document reading and processing pipeline\n</agent_knowledge>'
  };

  const result = await executor.execute('What do you know about document reading?', context);
  const resp = getResponse(result);

  assert.ok(resp.includes('FileOps'), `Should synthesize answer from warm memory, got: ${resp}`);
  assert.ok(result.actionRecord, 'Should have actionRecord');
  assert.strictEqual(result.actionRecord.refs.source, 'warm_memory', 'Source should be warm_memory');
  assert.strictEqual(routeCallCount, 2, 'Router should be called twice (extraction + synthesis)');
});

// -- Test 13: No warmMemory → returns "I don't have" message --
asyncTest('No warmMemory returns final not-found message', async () => {
  const registry = createMockToolRegistry({
    wiki_read: { success: true, result: 'No wiki page found for "Nonexistent"' },
    memory_search: { success: true, result: 'No matching memories found.' }
  });

  const executor = new WikiExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'read', topic: 'Nonexistent' })
    }),
    toolRegistry: registry,
    logger: silentLogger
  });

  const result = await executor.execute('Tell me about Nonexistent', { userName: 'alice' });
  const resp = getResponse(result);

  assert.ok(resp.includes("I don't have anything about"), `Should say no knowledge, got: ${resp}`);
  assert.ok(resp.includes('Nonexistent'), 'Should include the topic name');
});

// -- Test 14: warmMemory without agent_knowledge tags is ignored --
asyncTest('warmMemory without agent_knowledge tags is ignored', async () => {
  const registry = createMockToolRegistry({
    wiki_read: { success: true, result: 'No wiki page found for "Alex"' },
    memory_search: { success: true, result: 'No matching memories found.' }
  });

  const executor = new WikiExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'read', topic: 'Alex' })
    }),
    toolRegistry: registry,
    logger: silentLogger
  });

  const context = {
    userName: 'alice',
    warmMemory: 'Some random context string without knowledge tags'
  };

  const result = await executor.execute('Tell me about Alex', context);
  const resp = getResponse(result);

  assert.ok(resp.includes("I don't have anything about"), `Should not use non-tagged warmMemory, got: ${resp}`);
});

// -- Test 15: Synthesis failure falls through to not-found --
asyncTest('Synthesis failure falls through to not-found gracefully', async () => {
  let routeCallCount = 0;
  const registry = createMockToolRegistry({
    wiki_read: { success: true, result: 'No wiki page found for "Alex"' },
    memory_search: { success: true, result: 'No matching memories found.' }
  });

  const executor = new WikiExecutor({
    router: {
      route: async () => {
        routeCallCount++;
        if (routeCallCount === 1) {
          return { result: JSON.stringify({ action: 'read', topic: 'Alex' }) };
        }
        // Synthesis call fails
        throw new Error('LLM timeout');
      }
    },
    toolRegistry: registry,
    logger: silentLogger
  });

  const context = {
    userName: 'alice',
    warmMemory: '<agent_knowledge>\n[source: wiki]\nAlex\nSome info\n</agent_knowledge>'
  };

  const result = await executor.execute('Tell me about Alex', context);
  const resp = getResponse(result);

  assert.ok(resp.includes("I don't have anything about"), `Should fall through on synthesis error, got: ${resp}`);
});

// -- Test 16: _executeWrite calls entityExtractor.extractFromPage --
asyncTest('_executeWrite calls entityExtractor.extractFromPage with correct path and content', async () => {
  const extractCalls = [];
  const registry = createMockToolRegistry({
    wiki_write: { success: true, result: 'Page created' }
  });
  const executor = new WikiExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'write', page_title: 'Project Alpha', content: 'Alpha details', parent: 'Projects' })
    }),
    toolRegistry: registry,
    entityExtractor: { extractFromPage: async (p, c) => { extractCalls.push({ p, c }); } },
    logger: silentLogger
  });

  await executor.execute('Write wiki page Project Alpha under Projects', { userName: 'alice' });

  assert.strictEqual(extractCalls.length, 1, 'Should call extractFromPage once');
  assert.ok(extractCalls[0].p.includes('Project Alpha'), 'Path should include page title');
  assert.ok(extractCalls[0].c.includes('Alpha details'), 'Content should include the raw text');
  assert.ok(extractCalls[0].c.includes('---'), 'Content should include frontmatter');
});

// -- Test 17: _executeAppend calls entityExtractor.extractFromPage with merged content --
asyncTest('_executeAppend calls entityExtractor.extractFromPage with merged content', async () => {
  const extractCalls = [];
  const registry = createMockToolRegistry({
    wiki_read: { success: true, result: 'Existing line.' },
    wiki_write: { success: true, result: 'Page updated' }
  });
  const executor = new WikiExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'append', page_title: 'Daily Log', content: 'New entry', topic: 'log' })
    }),
    toolRegistry: registry,
    entityExtractor: { extractFromPage: async (p, c) => { extractCalls.push({ p, c }); } },
    logger: silentLogger
  });

  await executor.execute('Append to daily log', { userName: 'alice' });

  assert.strictEqual(extractCalls.length, 1, 'Should call extractFromPage once');
  assert.strictEqual(extractCalls[0].p, 'Daily Log', 'Path should be the page title');
  assert.ok(extractCalls[0].c.includes('Existing line.'), 'Content should include original');
  assert.ok(extractCalls[0].c.includes('New entry'), 'Content should include appended text');
});

// -- Entity extraction: project type fields --
asyncTest('Entity extraction returns project-type frontmatter fields', async () => {
  const registry = createMockToolRegistry({
    wiki_write: { success: true, result: 'Page created' }
  });
  const executor = new WikiExecutor({
    router: createMockRouter({
      result: JSON.stringify({
        action: 'remember',
        fact: 'Project Phoenix is our Q1 internal tooling initiative, led by Fu',
        topic: 'phoenix'
      })
    }),
    toolRegistry: registry,
    logger: silentLogger
  });

  executor._extractEntityInfo = async () => ({
    page_title: 'Project Phoenix',
    section: 'Projects',
    entity_type: 'project',
    fields: { name: 'Project Phoenix', lead: 'Fu', goal: 'internal tooling initiative', timeline: 'Q1' }
  });

  await executor.execute('Remember this: Project Phoenix is our Q1 internal tooling initiative, led by Fu', { userName: 'alice' });

  const writes = registry.getCallsFor('wiki_write');
  assert.strictEqual(writes.length, 1, 'Should write once');
  const body = writes[0].args.content || '';
  assert.ok(body.includes('type: project'), 'Frontmatter should have type: project');
  assert.ok(body.includes('lead: Fu'), 'Frontmatter should include lead field');
  assert.ok(body.includes('goal: internal tooling initiative'), 'Frontmatter should include goal field');
  assert.ok(body.includes('timeline: Q1'), 'Frontmatter should include timeline field');
});

// -- Entity extraction: decision type fields --
asyncTest('Entity extraction returns decision-type frontmatter fields', async () => {
  const registry = createMockToolRegistry({
    wiki_write: { success: true, result: 'Page created' }
  });
  const executor = new WikiExecutor({
    router: createMockRouter({
      result: JSON.stringify({
        action: 'remember',
        fact: 'We decided to move to Postgres on Jan 15',
        topic: 'postgres'
      })
    }),
    toolRegistry: registry,
    logger: silentLogger
  });

  executor._extractEntityInfo = async () => ({
    page_title: 'Move to Postgres',
    section: 'Decisions',
    entity_type: 'decision',
    fields: { name: 'Move to Postgres', date: 'Jan 15', outcome: 'move to Postgres', rationale: 'better JSON support' }
  });

  await executor.execute('We decided to move to Postgres on Jan 15, rationale: better JSON support', { userName: 'alice' });

  const writes = registry.getCallsFor('wiki_write');
  assert.strictEqual(writes.length, 1);
  const body = writes[0].args.content || '';
  assert.ok(body.includes('type: decision'), 'Frontmatter should have type: decision');
  assert.ok(body.includes('date: Jan 15'), 'Frontmatter should include date field');
  assert.ok(body.includes('rationale: better JSON support'), 'Frontmatter should include rationale');
});

// -- Entity extraction: procedure type fields --
asyncTest('Entity extraction returns procedure-type frontmatter fields', async () => {
  const registry = createMockToolRegistry({
    wiki_write: { success: true, result: 'Page created' }
  });
  const executor = new WikiExecutor({
    router: createMockRouter({
      result: JSON.stringify({
        action: 'remember',
        fact: 'The deploy procedure runs weekly, depends on CI passing',
        topic: 'deploy'
      })
    }),
    toolRegistry: registry,
    logger: silentLogger
  });

  executor._extractEntityInfo = async () => ({
    page_title: 'Deploy Procedure',
    section: 'Procedures',
    entity_type: 'procedure',
    fields: { name: 'Deploy Procedure', frequency: 'weekly', dependencies: 'CI passing' }
  });

  await executor.execute('The deploy procedure runs weekly, depends on CI passing', { userName: 'alice' });

  const writes = registry.getCallsFor('wiki_write');
  assert.strictEqual(writes.length, 1);
  const body = writes[0].args.content || '';
  assert.ok(body.includes('type: procedure'), 'Frontmatter should have type: procedure');
  assert.ok(body.includes('frequency: weekly'), 'Frontmatter should include frequency');
  assert.ok(body.includes('dependencies: CI passing'), 'Frontmatter should include dependencies');
});

// -- Entity extraction: tool type fields --
asyncTest('Entity extraction returns tool-type frontmatter fields', async () => {
  const registry = createMockToolRegistry({
    wiki_write: { success: true, result: 'Page created' }
  });
  const executor = new WikiExecutor({
    router: createMockRouter({
      result: JSON.stringify({
        action: 'remember',
        fact: 'We use Sentry for error tracking, url: https://sentry.io/our-org',
        topic: 'sentry'
      })
    }),
    toolRegistry: registry,
    logger: silentLogger
  });

  executor._extractEntityInfo = async () => ({
    page_title: 'Sentry',
    section: 'Research',
    entity_type: 'tool',
    fields: { name: 'Sentry', purpose: 'error tracking', url: 'https://sentry.io/our-org' }
  });

  await executor.execute('We use Sentry for error tracking, url: https://sentry.io/our-org', { userName: 'alice' });

  const writes = registry.getCallsFor('wiki_write');
  assert.strictEqual(writes.length, 1);
  const body = writes[0].args.content || '';
  assert.ok(body.includes('type: tool'), 'Frontmatter should have type: tool');
  assert.ok(body.includes('purpose: error tracking'), 'Frontmatter should include purpose');
  assert.ok(body.includes('url: https://sentry.io/our-org'), 'Frontmatter should include url');
});

// -- Frontmatter extraction logging --
asyncTest('Entity extraction logs type and field count', async () => {
  const logs = [];
  const trackingLogger = { log() {}, info(msg) { logs.push(msg); }, warn() {}, error() {} };
  const executor = new WikiExecutor({
    router: createMockRouter(),
    toolRegistry: createMockToolRegistry(),
    logger: trackingLogger
  });

  // Call _extractEntityInfo directly with a mock _extractJSON that returns valid entity data
  executor._extractJSON = async () => ({
    page_title: 'Test Project',
    section: 'Projects',
    entity_type: 'project',
    fields: { name: 'Test Project', lead: 'Alice', goal: 'testing' }
  });

  const result = await executor._extractEntityInfo('Test Project led by Alice for testing', {});

  assert.strictEqual(result.entity_type, 'project', 'Should return project type');
  assert.strictEqual(Object.keys(result.fields).length, 3, 'Should have 3 fields');

  const frontmatterLog = logs.find(l => l.includes('[WikiExec] Frontmatter extraction'));
  assert.ok(frontmatterLog, 'Should log frontmatter extraction info');
  assert.ok(frontmatterLog.includes('type=project'), 'Log should include entity type');
  assert.ok(frontmatterLog.includes('fields=3'), 'Log should include field count');
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
