/*
 * Moltagent - Sovereign AI Security Layer
 * Copyright (C) 2026 MoltAgent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

'use strict';

const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const assert = require('assert');

// ---------------------------------------------------------------------------
// Test 1: DeckTaskProcessor done-field fast-track
// ---------------------------------------------------------------------------
asyncTest('DeckTaskProcessor fast-tracks done:true card without LLM classification', async () => {
  // We cannot import DeckTaskProcessor directly because the constructor calls
  // `new DeckClient(config)`, which performs NC HTTP calls on init. Instead
  // we test the _processCard logic directly by grabbing the prototype and
  // invoking it against a minimal mock `this` context, which avoids touching
  // DeckClient's constructor and any real network calls.

  const DeckTaskProcessor = require('../../../src/lib/integrations/deck-task-processor');

  // Track whether the router was ever invoked (it must NOT be for done cards)
  let llmCalled = false;

  // Minimal mock that satisfies everything _processCard touches for done:true
  const mockDeck = {
    username: 'moltagent',
    baseUrl: 'https://nc.example.com',
    moveCard: async () => {},
    assignUser: async () => {}
  };

  const mockRouter = {
    route: async () => {
      llmCalled = true;
      return { result: 'should not be reached' };
    }
  };

  // Build a stripped-down processor instance that bypasses the real DeckClient
  // constructor by using Object.create and manually wiring the prototype.
  const processor = Object.create(DeckTaskProcessor.prototype);
  processor.deck = mockDeck;
  processor.router = mockRouter;
  processor.auditLog = async () => {};
  processor.config = {};
  processor.routeContext = {};
  processor.notifyUser = null;
  processor.reviewUser = null;
  processor._currentTask = null;
  processor._processing = false;
  processor._lastCleanup = 0;
  processor._handlers = new Map();

  // Wire the handlers map so _processCard doesn't crash before the done check
  // (it returns before reaching handler lookup, but be safe)
  processor._handlers.set('generic', async () => ({ summary: 'noop' }));

  const card = {
    id: 1,
    title: 'Test done card',
    done: true,
    description: 'The complete deliverable is here.',
    labels: [],
    owner: 'fu'
  };

  const result = await processor._processCard(card);

  assert.strictEqual(result.taskType, 'done-delivery', 'taskType must be done-delivery');
  assert.ok(!llmCalled, 'LLM router must NOT be called for a done card');
});

// ---------------------------------------------------------------------------
// Test 2: AnthropicProvider sets cache_control on system prompt
// ---------------------------------------------------------------------------
test('AnthropicProvider sets cache_control on system prompt', () => {
  const src = require('fs').readFileSync(
    require.resolve('../../../src/lib/llm/providers/anthropic-provider.js'),
    'utf8'
  );
  assert.ok(
    src.includes("cache_control: { type: 'ephemeral' }"),
    'cache_control marker must be present in anthropic-provider.js system block'
  );
});

// ---------------------------------------------------------------------------
// Test 3: ClaudeToolsProvider sets cache_control on system prompt
// ---------------------------------------------------------------------------
test('ClaudeToolsProvider sets cache_control on system prompt', () => {
  const src = require('fs').readFileSync(
    require.resolve('../../../src/lib/agent/providers/claude-tools.js'),
    'utf8'
  );
  assert.ok(
    src.includes("cache_control: { type: 'ephemeral' }"),
    'cache_control marker must be present in claude-tools.js system block'
  );
});

// ---------------------------------------------------------------------------
// Test 4: _handleThinkingQuery skips enricher
// ---------------------------------------------------------------------------
test('_handleThinkingQuery skips enricher (slim Opus context)', () => {
  const src = require('fs').readFileSync(
    require.resolve('../../../src/lib/server/message-processor.js'),
    'utf8'
  );

  // Extract the _handleThinkingQuery method body
  const methodStart = src.indexOf('async _handleThinkingQuery(');
  assert.ok(methodStart !== -1, '_handleThinkingQuery method must exist in message-processor.js');

  const nextMethod = src.indexOf('\n  async ', methodStart + 1);
  const methodBody = nextMethod !== -1
    ? src.slice(methodStart, nextMethod)
    : src.slice(methodStart);

  assert.ok(
    !methodBody.includes('enricher.enrich'),
    'thinking handler must not call enricher.enrich'
  );
  assert.ok(
    !methodBody.includes('this.enricher'),
    'thinking handler must not reference this.enricher'
  );
  assert.ok(
    methodBody.includes('skip enricher'),
    'thinking handler must contain explicit "skip enricher" comment'
  );
});

// ---------------------------------------------------------------------------
// Test 5: Classification roster puts cheapest provider first
// ---------------------------------------------------------------------------
test('Router roster: CLASSIFICATION uses cheapest-first chain', () => {
  const src = require('fs').readFileSync(
    require.resolve('../../../src/lib/llm/router.js'),
    'utf8'
  );

  // Match the CLASSIFICATION roster assignment line
  // e.g. roster[JOBS.CLASSIFICATION] = [...new Set([cheapest, ...local].filter(Boolean))];
  const match = src.match(/roster\[JOBS\.CLASSIFICATION\]\s*=\s*\[\.\.\.new Set\(\[(.*?)\]/);
  assert.ok(match, 'CLASSIFICATION roster assignment must be found in router.js');

  // The first element in the array literal must be `cheapest`
  const arrayContents = match[1].trim();
  assert.ok(
    arrayContents.startsWith('cheapest'),
    `cheapest provider must be first in CLASSIFICATION roster, got: "${arrayContents}"`
  );
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
