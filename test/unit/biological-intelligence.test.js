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
 * Biological Intelligence — Unit Tests
 *
 * Tests three biologically-inspired information processing strategies:
 *   1. Prediction-error extraction (only process what's NEW)
 *   2. Competitive filtering (winners suppress losers)
 *   3. Conversational mode inference (context-dependent gating)
 *
 * Run: node test/unit/biological-intelligence.test.js
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../helpers/test-runner');

// ============================================================
// 1. Prediction-Error Extraction
// ============================================================

asyncTest('1. With existing knowledge: extraction prompt includes wiki summary', async () => {
  const EntityExtractor = require('../../src/lib/memory/entity-extractor');
  const extractor = new EntityExtractor({
    knowledgeGraph: { addEntity: () => 'id', addTriple: () => {} },
    router: {
      route: async (req) => {
        // Verify the prompt includes existing knowledge
        assert.ok(req.content.includes('ALREADY KNOW'),
          'Prompt should include existing knowledge context');
        assert.ok(req.content.includes('Eelco H. Dykstra'),
          'Prompt should include the existing entity');
        return { result: '{"summary":"","entities":[],"relationships":[]}' };
      },
    },
  });

  await extractor.extractEntitiesFromDocument(
    'test-doc',
    'A long enough content string that passes the minimum threshold for extraction processing.',
    '- Eelco H. Dykstra: Dutch resilience expert and founder of DIEM program'
  );
});

asyncTest('2. Without existing knowledge: prompt says no prior knowledge', async () => {
  const EntityExtractor = require('../../src/lib/memory/entity-extractor');
  const extractor = new EntityExtractor({
    knowledgeGraph: { addEntity: () => 'id', addTriple: () => {} },
    router: {
      route: async (req) => {
        // Without existing knowledge, no "ALREADY KNOW" block
        assert.ok(!req.content.includes('ALREADY KNOW'),
          'Prompt should NOT include knowledge block when none provided');
        return { result: '{"summary":"","entities":[],"relationships":[]}' };
      },
    },
  });

  await extractor.extractEntitiesFromDocument(
    'test-doc',
    'A long enough content string that passes the minimum threshold for extraction processing.'
  );
});

test('3. memorySearcher accepted by DocumentIngestor constructor', () => {
  const DocumentIngestor = require('../../src/lib/integrations/document-ingestor');
  const mockSearcher = { search: async () => [] };

  const ingestor = new DocumentIngestor({
    ncFilesClient: { readFileBuffer: async () => Buffer.from('x') },
    textExtractor: { extract: async () => 'x' },
    entityExtractor: { extractEntitiesFromDocument: async () => ({ summary: '', entities: [] }) },
    wikiWriter: { createPage: async () => ({ success: true }), listPages: async () => ({ pages: [] }) },
    memorySearcher: mockSearcher,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });

  assert.strictEqual(ingestor.memorySearcher, mockSearcher,
    'memorySearcher should be stored on the ingestor');
});

test('4. extractEntitiesFromDocument accepts existingKnowledge parameter', () => {
  const EntityExtractor = require('../../src/lib/memory/entity-extractor');
  const extractor = new EntityExtractor({
    knowledgeGraph: { addEntity: () => 'id', addTriple: () => {} },
    router: null, // no router = returns empty
  });

  // Should not throw with 3 args
  assert.doesNotThrow(() => {
    extractor.extractEntitiesFromDocument('title', 'content', 'existing knowledge');
  });
});

// ============================================================
// 2. Competitive Filtering
// ============================================================

test('6. Same-title results: only winner survives', () => {
  const MemorySearcher = require('../../src/lib/integrations/memory-searcher');
  const searcher = new MemorySearcher({
    ncSearchClient: { searchProvider: async () => [] },
    collectivesClient: { readPageContent: async () => '' },
  });

  const results = [
    { title: 'Risk to Resilience Movement', _fusionScore: 0.9 },
    { title: 'risk to resilience movement', _fusionScore: 0.6 },
    { title: 'From Risk to Resilience Movement', _fusionScore: 0.5 },
    { title: 'Unrelated Topic', _fusionScore: 0.4 },
  ];

  const filtered = searcher._suppressRelatedResults(results, 5);
  const titles = filtered.map(r => r.title);

  assert.ok(titles.includes('Risk to Resilience Movement'), 'Winner should survive');
  assert.ok(titles.includes('Unrelated Topic'), 'Unrelated should survive');
  // The normalized "risk to resilience movement" variants should be suppressed
  assert.ok(filtered.length <= 3, 'At most 3 results (winner + from-variant + unrelated)');
});

test('7. Unrelated results: all survive', () => {
  const MemorySearcher = require('../../src/lib/integrations/memory-searcher');
  const searcher = new MemorySearcher({
    ncSearchClient: { searchProvider: async () => [] },
    collectivesClient: { readPageContent: async () => '' },
  });

  const results = [
    { title: 'Eelco H. Dykstra', _fusionScore: 0.9 },
    { title: 'DIEM Program', _fusionScore: 0.7 },
    { title: 'CEN TC 391', _fusionScore: 0.5 },
  ];

  const filtered = searcher._suppressRelatedResults(results, 5);
  assert.strictEqual(filtered.length, 3, 'All unrelated results should survive');
});

test('8. maxResults respected after suppression', () => {
  const MemorySearcher = require('../../src/lib/integrations/memory-searcher');
  const searcher = new MemorySearcher({
    ncSearchClient: { searchProvider: async () => [] },
    collectivesClient: { readPageContent: async () => '' },
  });

  const results = [];
  for (let i = 0; i < 20; i++) {
    results.push({ title: `Unique Entity ${i}`, _fusionScore: 1 - i * 0.04 });
  }

  const filtered = searcher._suppressRelatedResults(results, 5);
  assert.strictEqual(filtered.length, 5, 'Should respect maxResults=5');
});

test('9. Empty results handled gracefully', () => {
  const MemorySearcher = require('../../src/lib/integrations/memory-searcher');
  const searcher = new MemorySearcher({
    ncSearchClient: { searchProvider: async () => [] },
    collectivesClient: { readPageContent: async () => '' },
  });

  assert.deepStrictEqual(searcher._suppressRelatedResults([], 5), []);
  assert.deepStrictEqual(searcher._suppressRelatedResults(null, 5), null);
});

test('10. _normalizeForSuppress strips articles and case', () => {
  const MemorySearcher = require('../../src/lib/integrations/memory-searcher');
  const searcher = new MemorySearcher({
    ncSearchClient: { searchProvider: async () => [] },
    collectivesClient: { readPageContent: async () => '' },
  });

  assert.strictEqual(
    searcher._normalizeForSuppress('The Risk to Resilience'),
    searcher._normalizeForSuppress('risk to resilience'),
    'Should normalize case and strip articles'
  );
  assert.strictEqual(
    searcher._normalizeForSuppress('Organizations (2)'),
    searcher._normalizeForSuppress('Organizations'),
    'Should strip collision suffixes'
  );
});

// ============================================================
// 3. Conversational Mode Inference
// ============================================================

test('11. Short rapid messages → focused', () => {
  const { AgentLoop } = require('../../src/lib/agent/agent-loop');
  const loop = new AgentLoop({
    llmProvider: { call: async () => ({ content: '' }) },
    config: {},
  });

  const history = [
    { role: 'user', content: 'status' },
    { role: 'assistant', content: 'All systems operational.' },
    { role: 'user', content: 'restart' },
    { role: 'assistant', content: 'Done.' },
    { role: 'user', content: 'check logs' },
    { role: 'assistant', content: 'No errors.' },
  ];

  assert.strictEqual(loop._inferConversationalMode(history), 'focused');
});

test('12. Long messages with "what if" → exploratory', () => {
  const { AgentLoop } = require('../../src/lib/agent/agent-loop');
  const loop = new AgentLoop({
    llmProvider: { call: async () => ({ content: '' }) },
    config: {},
  });

  const history = [
    { role: 'user', content: 'What if we restructured the entire ingestion pipeline to use a prediction-error model? Could we brainstorm some approaches that might work with our current architecture? I want to explore different angles before committing.' },
    { role: 'assistant', content: 'Great question. Let me think about several approaches...' },
  ];

  assert.strictEqual(loop._inferConversationalMode(history), 'exploratory');
});

test('13. Mixed messages → balanced', () => {
  const { AgentLoop } = require('../../src/lib/agent/agent-loop');
  const loop = new AgentLoop({
    llmProvider: { call: async () => ({ content: '' }) },
    config: {},
  });

  const history = [
    { role: 'user', content: 'Can you check the current state of the wiki and tell me how many pages there are?' },
    { role: 'assistant', content: 'There are 112 pages across 10 sections.' },
  ];

  assert.strictEqual(loop._inferConversationalMode(history), 'balanced');
});

test('14. Empty session → balanced', () => {
  const { AgentLoop } = require('../../src/lib/agent/agent-loop');
  const loop = new AgentLoop({
    llmProvider: { call: async () => ({ content: '' }) },
    config: {},
  });

  assert.strictEqual(loop._inferConversationalMode([]), 'balanced');
  assert.strictEqual(loop._inferConversationalMode(null), 'balanced');
});

test('15. Mode instruction injected into system prompt', () => {
  const { AgentLoop } = require('../../src/lib/agent/agent-loop');
  const loop = new AgentLoop({
    llmProvider: { call: async () => ({ content: '' }) },
    config: {},
  });

  // Focused mode
  const focusedHistory = [
    { role: 'user', content: 'ok' },
    { role: 'user', content: 'next' },
    { role: 'user', content: 'done' },
  ];
  const prompt = loop._buildSystemPrompt('', '', {}, '', focusedHistory);
  assert.ok(prompt.includes('CONVERSATIONAL MODE: Focused'),
    'Focused mode should appear in system prompt');

  // Balanced mode — no injection
  const balancedPrompt = loop._buildSystemPrompt('', '', {}, '', []);
  assert.ok(!balancedPrompt.includes('CONVERSATIONAL MODE'),
    'Balanced mode should NOT inject any mode instruction');
});

// ============================================================
// Run
// ============================================================

setTimeout(() => { summary(); exitWithCode(); }, 500);
