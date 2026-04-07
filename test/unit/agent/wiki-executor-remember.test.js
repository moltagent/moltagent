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

/**
 * Create a mock router that returns LLM extraction results in sequence.
 * First call = action extraction, second call = entity extraction.
 */
function createSequenceRouter(responses) {
  let callIdx = 0;
  return {
    route: async () => {
      const resp = responses[callIdx] || responses[responses.length - 1];
      callIdx++;
      return resp;
    }
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

// -- Test 1: Remember creates page titled with entity name, not "contacts" --
asyncTest('Remember creates page titled with entity name from LLM extraction', async () => {
  const registry = createMockToolRegistry({
    wiki_write: { success: true, result: 'Page created' }
  });

  // First route call: action extraction → remember
  // Second route call: entity extraction → proper entity info
  const executor = new WikiExecutor({
    router: createSequenceRouter([
      { result: JSON.stringify({ action: 'remember', fact: 'Alex from @user-123, email alex@example.com', topic: 'contacts' }) },
      { result: JSON.stringify({ page_title: 'Alex', section: 'People', entity_type: 'person', fields: { name: 'Alex', company: '@user-123', email: 'alex@example.com' } }) }
    ]),
    toolRegistry: registry,
    logger: silentLogger
  });

  const result = await executor.execute('Remember Alex from @user-123, email alex@example.com', { userName: 'alice' });
  const resp = getResponse(result);
  assert.ok(resp.includes('Alex'), `Should confirm entity name in response, got: ${resp}`);

  const writeCall = registry.getCallsFor('wiki_write')[0];
  assert.ok(writeCall, 'Should call wiki_write');
  assert.strictEqual(writeCall.args.page_title, 'Alex', 'Page title should be entity name "Alex", not "contacts"');
  assert.strictEqual(writeCall.args.parent, 'People', 'Parent should be "People" from entity extraction');
});

// -- Test 2: Remember page has frontmatter with type and fields --
asyncTest('Remember page has frontmatter with type and structured fields', async () => {
  const registry = createMockToolRegistry({
    wiki_write: { success: true, result: 'Page created' }
  });

  const executor = new WikiExecutor({
    router: createSequenceRouter([
      { result: JSON.stringify({ action: 'remember', fact: 'Alex from @user-123, email alex@example.com' }) },
      { result: JSON.stringify({ page_title: 'Alex', section: 'People', entity_type: 'person', fields: { name: 'Alex', company: '@user-123', email: 'alex@example.com' } }) }
    ]),
    toolRegistry: registry,
    logger: silentLogger
  });

  await executor.execute('Remember Alex from @user-123', { userName: 'alice' });

  const writeCall = registry.getCallsFor('wiki_write')[0];
  const content = writeCall.args.content;
  assert.ok(content.includes('---'), 'Content should have frontmatter delimiters');
  assert.ok(content.includes('type: person'), 'Frontmatter should include type: person');
  assert.ok(content.includes('confidence: medium'), 'Frontmatter should include confidence');
  assert.ok(content.includes('last_verified:'), 'Frontmatter should include last_verified');
  assert.ok(content.includes('email: alex@example.com'), 'Frontmatter should include email field');
  assert.ok(content.includes('company: @user-123'), 'Frontmatter should include company field');
  assert.ok(content.includes('# Alex'), 'Content should have entity name as heading');
});

// -- Test 3: Remember project creates page under Projects --
asyncTest('Remember project creates page under Projects section', async () => {
  const registry = createMockToolRegistry({
    wiki_write: { success: true, result: 'Page created' }
  });

  const executor = new WikiExecutor({
    router: createSequenceRouter([
      { result: JSON.stringify({ action: 'remember', fact: 'Project X is our Q3 initiative for automation' }) },
      { result: JSON.stringify({ page_title: 'Project X', section: 'Projects', entity_type: 'project', fields: { name: 'Project X', description: 'Q3 initiative for automation' } }) }
    ]),
    toolRegistry: registry,
    logger: silentLogger
  });

  const result = await executor.execute('Remember: Project X is our Q3 initiative for automation', { userName: 'alice' });
  const resp = getResponse(result);

  const writeCall = registry.getCallsFor('wiki_write')[0];
  assert.strictEqual(writeCall.args.page_title, 'Project X', 'Page title should be "Project X"');
  assert.strictEqual(writeCall.args.parent, 'Projects', 'Parent should be "Projects"');
  assert.ok(resp.includes('Project X'), `Response should mention entity, got: ${resp}`);
});

// -- Test 4: EntityExtractor called after wiki write --
asyncTest('EntityExtractor.extractFromPage called after successful wiki write', async () => {
  const registry = createMockToolRegistry({
    wiki_write: { success: true, result: 'Page created' }
  });

  const extractorCalls = [];
  const mockExtractor = {
    extractFromPage: async (title, content) => {
      extractorCalls.push({ title, content });
      return { entities: [{ name: 'Alex', type: 'person' }] };
    }
  };

  const executor = new WikiExecutor({
    router: createSequenceRouter([
      { result: JSON.stringify({ action: 'remember', fact: 'Alex from @user-123' }) },
      { result: JSON.stringify({ page_title: 'Alex', section: 'People', entity_type: 'person', fields: {} }) }
    ]),
    toolRegistry: registry,
    entityExtractor: mockExtractor,
    logger: silentLogger
  });

  await executor.execute('Remember Alex from @user-123', { userName: 'alice' });

  assert.strictEqual(extractorCalls.length, 1, 'EntityExtractor.extractFromPage should be called once');
  assert.ok(extractorCalls[0].title.includes('Alex'), 'Should pass page path containing entity name');
  assert.ok(extractorCalls[0].content.includes('Alex from @user-123'), 'Should pass page content');
});

// -- Test 5: EntityExtractor failure doesn't block wiki write --
asyncTest('EntityExtractor failure does not block wiki write response', async () => {
  const registry = createMockToolRegistry({
    wiki_write: { success: true, result: 'Page created' }
  });

  const mockExtractor = {
    extractFromPage: async () => { throw new Error('Graph DB connection failed'); }
  };

  const executor = new WikiExecutor({
    router: createSequenceRouter([
      { result: JSON.stringify({ action: 'remember', fact: 'Alex from @user-123' }) },
      { result: JSON.stringify({ page_title: 'Alex', section: 'People', entity_type: 'person', fields: {} }) }
    ]),
    toolRegistry: registry,
    entityExtractor: mockExtractor,
    logger: silentLogger
  });

  const result = await executor.execute('Remember Alex from @user-123', { userName: 'alice' });
  const resp = getResponse(result);

  // Wiki write should still succeed
  assert.ok(resp.includes('Alex'), `Response should confirm wiki write despite extractor failure, got: ${resp}`);
  assert.ok(resp.includes('Saved'), `Should report saved, got: ${resp}`);
  assert.strictEqual(registry.getCallsFor('wiki_write').length, 1, 'Wiki write should complete');
});

// -- Test 6: Remember with empty fact asks for clarification --
asyncTest('Remember with empty fact asks what to remember', async () => {
  const registry = createMockToolRegistry();

  const executor = new WikiExecutor({
    router: createSequenceRouter([
      { result: JSON.stringify({ action: 'remember', fact: '', content: '' }) }
    ]),
    toolRegistry: registry,
    logger: silentLogger
  });

  const result = await executor.execute('Remember something', { userName: 'alice' });
  const resp = getResponse(result);
  assert.ok(resp.toLowerCase().includes('remember'), `Should ask what to remember, got: ${resp}`);
  assert.strictEqual(registry.getCallsFor('wiki_write').length, 0, 'Should NOT call wiki_write');
});

// -- Test 7: Entity extraction fallback uses existing params --
asyncTest('Entity extraction fallback uses existing params when LLM fails', async () => {
  const registry = createMockToolRegistry({
    wiki_write: { success: true, result: 'Page created' }
  });

  // Second route call (entity extraction) returns invalid result
  const executor = new WikiExecutor({
    router: createSequenceRouter([
      { result: JSON.stringify({ action: 'remember', fact: 'Some note to self', topic: 'My Notes', page_title: 'My Notes' }) },
      { result: JSON.stringify({ page_title: '' }) } // Invalid — too short
    ]),
    toolRegistry: registry,
    logger: silentLogger
  });

  const result = await executor.execute('Remember: Some note to self', { userName: 'alice' });
  const resp = getResponse(result);

  const writeCall = registry.getCallsFor('wiki_write')[0];
  assert.strictEqual(writeCall.args.page_title, 'My Notes', 'Should fall back to existing page_title from params');
  assert.ok(resp.includes('My Notes'), `Response should use fallback title, got: ${resp}`);
});

// -- Test 8: _formatKnowledgePage produces correct structure --
asyncTest('_formatKnowledgePage produces correct frontmatter + content structure', async () => {
  const executor = new WikiExecutor({
    router: { route: async () => ({ result: '{}' }) },
    toolRegistry: createMockToolRegistry(),
    logger: silentLogger
  });

  const page = executor._formatKnowledgePage('Alex', {
    entity_type: 'person',
    fields: { email: 'alex@example.com', company: '@user-123', role: 'CTO' }
  }, 'Alex from @user-123 is our partner contact');

  const lines = page.split('\n');
  assert.strictEqual(lines[0], '---', 'First line should be frontmatter delimiter');
  assert.ok(lines[1].includes('type: person'), 'Should have type');
  assert.ok(page.includes('email: alex@example.com'), 'Should have email field');
  assert.ok(page.includes('company: @user-123'), 'Should have company field');
  assert.ok(page.includes('role: CTO'), 'Should have role field');
  assert.ok(page.includes('# Alex'), 'Should have entity heading');
  assert.ok(page.includes('Alex from @user-123 is our partner contact'), 'Should include raw content');

  // Frontmatter should be closed
  const fmEnd = page.indexOf('---', 3);
  assert.ok(fmEnd > 3, 'Should have closing frontmatter delimiter');
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
