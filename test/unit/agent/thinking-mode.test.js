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

/**
 * Thinking Mode Tests
 *
 * Architecture Brief:
 * -------------------
 * Problem: Validate that thinking intent bypasses AgentLoop and routes directly
 *   through the LLM router with rich context (SOUL.md + enrichment + living context).
 *
 * Pattern: Unit tests using custom test runner. Mock the LLM router and verify
 *   the thinking path assembles the correct prompt and makes one direct call.
 *
 * Key Dependencies: message-processor (MessageProcessor), test-runner helpers, assert.
 *
 * @module test/unit/agent/thinking-mode
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

console.log('\n=== Thinking Mode Tests ===\n');

// ============================================================
// Mock: minimal MessageProcessor with _handleThinkingQuery
// ============================================================

// We test _handleThinkingQuery directly by constructing a minimal
// MessageProcessor-shaped object with the dependencies it needs.

function buildThinkingHandler(opts = {}) {
  const routerCalls = [];
  const mockRouter = {
    route: async (request) => {
      routerCalls.push(request);
      return { result: opts.llmResponse || 'A thoughtful reflection.' };
    }
  };

  const enricherCalls = [];
  const mockEnricher = opts.enricher === false ? null : {
    enrich: async (msg, intent) => {
      enricherCalls.push({ msg, intent });
      return opts.enrichment || '';
    }
  };

  // Minimal shape matching what _handleThinkingQuery reads
  const handler = {
    microPipeline: {
      router: mockRouter,
      memoryContextEnricher: mockEnricher
    },
    agentLoop: {
      soul: opts.soul || 'You are Moltagent, a sovereign AI assistant.',
      timezone: opts.timezone || 'Europe/Lisbon'
    }
  };

  // Import the actual method (bound to our mock)
  const MessageProcessor = require('../../../src/lib/server/message-processor');
  const proto = MessageProcessor.prototype;
  handler._handleThinkingQuery = proto._handleThinkingQuery.bind(handler);

  return { handler, routerCalls, enricherCalls };
}

// ============================================================
// Direct route tests (no AgentLoop)
// ============================================================

asyncTest('TK-01: _handleThinkingQuery calls router.route with job=thinking', async () => {
  const { handler, routerCalls } = buildThinkingHandler();
  const result = await handler._handleThinkingQuery(
    'What do you think about our architecture?', null, null
  );

  assert.strictEqual(routerCalls.length, 1, 'Should make exactly one router call');
  assert.strictEqual(routerCalls[0].job, 'thinking');
  assert.strictEqual(routerCalls[0].task, 'thinking');
  assert.ok(result.response, 'Should return a response');
  assert.strictEqual(result.response, 'A thoughtful reflection.');
});

asyncTest('TK-02: Prompt includes SOUL.md content', async () => {
  const soul = 'I am Moltagent. I run on sovereignty principles.';
  const { handler, routerCalls } = buildThinkingHandler({ soul });
  await handler._handleThinkingQuery('Reflect on yourself', null, null);

  const content = routerCalls[0].content;
  assert.ok(content.includes(soul), 'Prompt should contain SOUL.md');
});

asyncTest('TK-03: Prompt includes enrichment when available', async () => {
  const { handler, routerCalls, enricherCalls } = buildThinkingHandler({
    enrichment: '<wiki>Architecture page content</wiki>'
  });
  await handler._handleThinkingQuery('Think about our architecture', null, null);

  assert.strictEqual(enricherCalls.length, 1);
  assert.strictEqual(enricherCalls[0].intent, 'thinking');
  const content = routerCalls[0].content;
  assert.ok(content.includes('WORKSPACE KNOWLEDGE'), 'Should label enrichment block');
  assert.ok(content.includes('Architecture page content'), 'Should include enrichment');
});

asyncTest('TK-04: Prompt includes living context when provided', async () => {
  const { handler, routerCalls } = buildThinkingHandler();
  const liveContext = { summary: 'User asked about security. Agent explained trust layers.' };
  await handler._handleThinkingQuery('What do you think about that?', null, liveContext);

  const content = routerCalls[0].content;
  assert.ok(content.includes('RECENT CONVERSATION'), 'Should include conversation header');
  assert.ok(content.includes('trust layers'), 'Should include conversation summary');
});

asyncTest('TK-05: Prompt includes warm memory when session has it', async () => {
  const { handler, routerCalls } = buildThinkingHandler();
  const session = { warmMemory: 'User prefers direct answers' };
  await handler._handleThinkingQuery('Your honest opinion?', session, null);

  const content = routerCalls[0].content;
  assert.ok(content.includes('User prefers direct answers'), 'Should include warm memory');
});

asyncTest('TK-06: Uses temperature 0.7 and maxTokens 2000', async () => {
  const { handler, routerCalls } = buildThinkingHandler();
  await handler._handleThinkingQuery('Think deeply', null, null);

  assert.strictEqual(routerCalls[0].requirements.temperature, 0.7);
  assert.strictEqual(routerCalls[0].requirements.maxTokens, 2000);
});

asyncTest('TK-07: Returns actionRecord with type thinking_query', async () => {
  const { handler } = buildThinkingHandler();
  const result = await handler._handleThinkingQuery('What is sovereignty?', null, null);

  assert.strictEqual(result.actionRecord.type, 'thinking_query');
  assert.ok(result.actionRecord.refs.query.includes('sovereignty'));
});

asyncTest('TK-08: Throws when no router available', async () => {
  const handler = {
    microPipeline: { router: null },
    agentLoop: { soul: 'test' }
  };
  const MessageProcessor = require('../../../src/lib/server/message-processor');
  handler._handleThinkingQuery = MessageProcessor.prototype._handleThinkingQuery.bind(handler);

  try {
    await handler._handleThinkingQuery('Think', null, null);
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err.message.includes('No LLM router'), 'Should mention missing router');
  }
});

asyncTest('TK-09: Prompt includes thinking instruction block', async () => {
  const { handler, routerCalls } = buildThinkingHandler();
  await handler._handleThinkingQuery('What do you think?', null, null);

  const content = routerCalls[0].content;
  assert.ok(content.includes('asked to THINK'), 'Should include thinking instruction');
  assert.ok(content.includes('Be thoughtful'), 'Should encourage authenticity');
});

asyncTest('TK-10: Works without enricher (enricher === null)', async () => {
  const { handler, routerCalls } = buildThinkingHandler({ enricher: false });
  await handler._handleThinkingQuery('Reflect on the project', null, null);

  assert.strictEqual(routerCalls.length, 1, 'Should still make the router call');
  const content = routerCalls[0].content;
  assert.ok(!content.includes('WORKSPACE KNOWLEDGE'), 'No enrichment block when enricher is null');
});

// ============================================================
// AgentLoop no longer has _jobHint
// ============================================================

test('TK-11: AgentLoop._classifyJob does NOT check for _jobHint', () => {
  const { AgentLoop } = require('../../../src/lib/agent/agent-loop');
  const source = AgentLoop.prototype._classifyJob.toString();
  assert.ok(!source.includes('_jobHint'), '_classifyJob should not reference _jobHint');
});

test('TK-12: AgentLoop.process does NOT set _jobHint', () => {
  const { AgentLoop } = require('../../../src/lib/agent/agent-loop');
  const source = AgentLoop.prototype.process.toString();
  assert.ok(!source.includes('_jobHint'), 'process() should not reference _jobHint');
});

setTimeout(() => { summary(); exitWithCode(); }, 200);
