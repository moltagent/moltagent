// Mock type: LEGACY — TODO: migrate to realistic mocks
/*
 * MoltAgent - Sovereign AI Security Layer
 * Copyright (C) 2026 MoltAgent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * ContextLoader Unit Tests
 *
 * Architecture Brief:
 * -------------------
 * Problem: Verify that ContextLoader correctly loads learnings and pending
 * verifications, filters by confidence, formats context, and handles errors.
 *
 * Pattern: Mock-based unit testing with mock LearningLog and KnowledgeBoard.
 *
 * Run: node test/unit/knowledge/context-loader.test.js
 *
 * @module test/unit/knowledge/context-loader
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

// Import module under test
const { ContextLoader } = require('../../../src/lib/knowledge/context-loader');

// ============================================================
// Test Helpers
// ============================================================

/**
 * Create a mock LearningLog.
 * @param {Array<Object>} [entries=[]] - Entries to return from getRecent()
 * @returns {Object} Mock LearningLog
 */
function createMockLearningLog(entries = []) {
  return {
    getRecent: async (limit) => entries.slice(0, limit),
    log: async (entry) => entry,
    learned: async (content, source, confidence) => ({ type: 'learned', content, source, confidence }),
    uncertain: async (content, source) => ({ type: 'uncertainty', content, source, confidence: 'low' }),
    shutdown: async () => {}
  };
}

/**
 * Create a mock KnowledgeBoard.
 * @param {Array<Object>} [pendingCards=[]] - Cards to return from getPendingVerifications()
 * @param {Object} [overrides={}] - Override specific methods
 * @returns {Object} Mock KnowledgeBoard
 */
function createMockKnowledgeBoard(pendingCards = [], overrides = {}) {
  return {
    initialize: async () => {},
    getPendingVerifications: async () => {
      if (overrides.getPendingVerifications) return overrides.getPendingVerifications();
      return pendingCards;
    },
    getStatus: async () => ({
      stacks: { verified: 0, uncertain: pendingCards.length, stale: 0, disputed: 0 }
    }),
    createVerificationCard: async (item) => ({ id: 1, title: `Verify: ${item.title}` })
  };
}

// ============================================================
// Sample Data
// ============================================================

const SAMPLE_LEARNINGS = [
  {
    timestamp: '2026-02-06T15:42:00Z',
    type: 'learned',
    content: 'John leads Q3 Campaign',
    source: '@sarah',
    confidence: 'high'
  },
  {
    timestamp: '2026-02-06T14:20:00Z',
    type: 'updated',
    content: 'Budget changed to 60k',
    source: '@finance',
    confidence: 'medium'
  },
  {
    timestamp: '2026-02-06T13:00:00Z',
    type: 'uncertainty',
    content: 'Timeline unclear',
    source: '@pm',
    confidence: 'low'
  },
  {
    timestamp: '2026-02-06T12:00:00Z',
    type: 'contradiction',
    content: 'Budget is 50k or 60k',
    source: '@finance',
    confidence: 'disputed'
  },
  {
    timestamp: '2026-02-06T11:00:00Z',
    type: 'learned',
    content: 'Sarah is CMO',
    source: 'email signature',
    confidence: 'high'
  }
];

const SAMPLE_PENDING_CARDS = [
  { id: 1, title: 'Verify: Timeline', status: 'uncertain' },
  { id: 2, title: 'Dispute: Budget Amount', status: 'disputed' }
];

// ============================================================
// Tests: Constructor
// ============================================================

console.log('');
console.log('=== ContextLoader Tests ===');
console.log('');

test('constructor sets defaults', () => {
  const mockLog = createMockLearningLog();
  const mockBoard = createMockKnowledgeBoard();
  const loader = new ContextLoader({ learningLog: mockLog, knowledgeBoard: mockBoard });

  assert.strictEqual(loader.config.maxRecentLearnings, 20);
  assert.strictEqual(loader.config.maxPendingCards, 5);
});

test('constructor accepts custom config', () => {
  const mockLog = createMockLearningLog();
  const mockBoard = createMockKnowledgeBoard();
  const loader = new ContextLoader({
    learningLog: mockLog,
    knowledgeBoard: mockBoard,
    config: { maxRecentLearnings: 10, maxPendingCards: 3 }
  });

  assert.strictEqual(loader.config.maxRecentLearnings, 10);
  assert.strictEqual(loader.config.maxPendingCards, 3);
});

// ============================================================
// Tests: loadContext()
// ============================================================

asyncTest('loadContext returns formatted context with learnings and pending', async () => {
  const mockLog = createMockLearningLog(SAMPLE_LEARNINGS);
  const mockBoard = createMockKnowledgeBoard(SAMPLE_PENDING_CARDS);
  const loader = new ContextLoader({ learningLog: mockLog, knowledgeBoard: mockBoard });

  const context = await loader.loadContext();

  assert.ok(context.startsWith('<agent_memory>'));
  assert.ok(context.endsWith('</agent_memory>'));
  assert.ok(context.includes('## Recent Knowledge'));
  assert.ok(context.includes('## Awaiting Verification'));
});

asyncTest('loadContext filters out uncertainties and low confidence', async () => {
  const mockLog = createMockLearningLog(SAMPLE_LEARNINGS);
  const mockBoard = createMockKnowledgeBoard([]);
  const loader = new ContextLoader({ learningLog: mockLog, knowledgeBoard: mockBoard });

  const context = await loader.loadContext();

  // Should include high/medium confidence entries
  assert.ok(context.includes('John leads Q3 Campaign'));
  assert.ok(context.includes('Budget changed to 60k'));
  assert.ok(context.includes('Sarah is CMO'));

  // Should NOT include low confidence / uncertainty / disputed
  assert.ok(!context.includes('Timeline unclear'));
  assert.ok(!context.includes('Budget is 50k or 60k'));
});

asyncTest('loadContext returns empty string when no data', async () => {
  const mockLog = createMockLearningLog([]);
  const mockBoard = createMockKnowledgeBoard([]);
  const loader = new ContextLoader({ learningLog: mockLog, knowledgeBoard: mockBoard });

  const context = await loader.loadContext();

  assert.strictEqual(context, '');
});

asyncTest('loadContext returns only learnings when no pending cards', async () => {
  const mockLog = createMockLearningLog(SAMPLE_LEARNINGS);
  const mockBoard = createMockKnowledgeBoard([]);
  const loader = new ContextLoader({ learningLog: mockLog, knowledgeBoard: mockBoard });

  const context = await loader.loadContext();

  assert.ok(context.includes('## Recent Knowledge'));
  assert.ok(!context.includes('## Awaiting Verification'));
});

asyncTest('loadContext returns only pending when no learnings', async () => {
  // Only uncertainty entries -- all get filtered out from learnings
  const mockLog = createMockLearningLog([
    { timestamp: '2026-02-06T10:00:00Z', type: 'uncertainty', content: 'Test', source: 'x', confidence: 'low' }
  ]);
  const mockBoard = createMockKnowledgeBoard(SAMPLE_PENDING_CARDS);
  const loader = new ContextLoader({ learningLog: mockLog, knowledgeBoard: mockBoard });

  const context = await loader.loadContext();

  assert.ok(!context.includes('## Recent Knowledge'));
  assert.ok(context.includes('## Awaiting Verification'));
});

asyncTest('loadContext handles learning log error gracefully', async () => {
  const mockLog = {
    getRecent: async () => { throw new Error('Log read failed'); }
  };
  const mockBoard = createMockKnowledgeBoard(SAMPLE_PENDING_CARDS);
  const loader = new ContextLoader({ learningLog: mockLog, knowledgeBoard: mockBoard });

  const context = await loader.loadContext();

  // Should still return pending section
  assert.ok(context.includes('## Awaiting Verification'));
});

asyncTest('loadContext handles knowledge board error gracefully', async () => {
  const mockLog = createMockLearningLog(SAMPLE_LEARNINGS);
  const mockBoard = createMockKnowledgeBoard([], {
    getPendingVerifications: async () => { throw new Error('Board read failed'); }
  });
  const loader = new ContextLoader({ learningLog: mockLog, knowledgeBoard: mockBoard });

  const context = await loader.loadContext();

  // Should still return learnings section
  assert.ok(context.includes('## Recent Knowledge'));
});

asyncTest('loadContext limits pending cards to maxPendingCards', async () => {
  const manyCards = Array.from({ length: 20 }, (_, i) => ({
    id: i, title: `Verify: Item ${i}`, status: 'uncertain'
  }));
  const mockLog = createMockLearningLog([]);
  const mockBoard = createMockKnowledgeBoard(manyCards);
  const loader = new ContextLoader({
    learningLog: mockLog,
    knowledgeBoard: mockBoard,
    config: { maxPendingCards: 3 }
  });

  const context = await loader.loadContext();

  // Should include at most 3 items
  const itemMatches = context.match(/Item \d+/g);
  assert.ok(itemMatches.length <= 3);
});

// ============================================================
// Tests: _formatLearningsSection()
// ============================================================

test('_formatLearningsSection formats entries correctly', () => {
  const mockLog = createMockLearningLog();
  const mockBoard = createMockKnowledgeBoard();
  const loader = new ContextLoader({ learningLog: mockLog, knowledgeBoard: mockBoard });

  const section = loader._formatLearningsSection([
    {
      timestamp: '2026-02-06T15:42:00Z',
      type: 'learned',
      content: 'John leads Q3',
      source: '@sarah',
      confidence: 'high'
    }
  ]);

  assert.ok(section.includes('## Recent Knowledge'));
  assert.ok(section.includes('Things I have learned recently'));
  assert.ok(section.includes('John leads Q3'));
  assert.ok(section.includes('@sarah'));
});

test('_formatLearningsSection handles missing source', () => {
  const mockLog = createMockLearningLog();
  const mockBoard = createMockKnowledgeBoard();
  const loader = new ContextLoader({ learningLog: mockLog, knowledgeBoard: mockBoard });

  const section = loader._formatLearningsSection([
    {
      timestamp: '2026-02-06T15:42:00Z',
      type: 'learned',
      content: 'Fact without source',
      confidence: 'medium'
    }
  ]);

  assert.ok(section.includes('unknown'));
});

// ============================================================
// Tests: _formatPendingSection()
// ============================================================

test('_formatPendingSection formats cards correctly', () => {
  const mockLog = createMockLearningLog();
  const mockBoard = createMockKnowledgeBoard();
  const loader = new ContextLoader({ learningLog: mockLog, knowledgeBoard: mockBoard });

  const section = loader._formatPendingSection([
    { id: 1, title: 'Verify: Q3 Budget', status: 'uncertain' },
    { id: 2, title: 'Dispute: Team Lead', status: 'disputed' }
  ]);

  assert.ok(section.includes('## Awaiting Verification'));
  assert.ok(section.includes('Q3 Budget'));
  assert.ok(section.includes('Team Lead'));
  assert.ok(section.includes('uncertain'));
  assert.ok(section.includes('disputed'));
  assert.ok(section.includes('I should note my uncertainty'));
});

test('_formatPendingSection strips Verify: and Dispute: prefixes', () => {
  const mockLog = createMockLearningLog();
  const mockBoard = createMockKnowledgeBoard();
  const loader = new ContextLoader({ learningLog: mockLog, knowledgeBoard: mockBoard });

  const section = loader._formatPendingSection([
    { id: 1, title: 'Verify: Budget', status: 'uncertain' }
  ]);

  // Should not have "Verify: " prefix in the formatted output
  assert.ok(!section.includes('Verify: Budget'));
  assert.ok(section.includes('Budget'));
});

// ============================================================
// Tests: _formatDate()
// ============================================================

test('_formatDate formats ISO timestamp as short date', () => {
  const mockLog = createMockLearningLog();
  const mockBoard = createMockKnowledgeBoard();
  const loader = new ContextLoader({ learningLog: mockLog, knowledgeBoard: mockBoard });

  const date = loader._formatDate('2026-02-06T15:42:00Z');

  // Should be something like "Feb 6" (locale-dependent, but should contain month)
  assert.ok(date.includes('Feb') || date.includes('6'));
});

test('_formatDate handles invalid timestamp gracefully', () => {
  const mockLog = createMockLearningLog();
  const mockBoard = createMockKnowledgeBoard();
  const loader = new ContextLoader({ learningLog: mockLog, knowledgeBoard: mockBoard });

  const date = loader._formatDate('not-a-date');
  // Should return some fallback, not throw
  assert.ok(typeof date === 'string');
});

test('_formatDate handles empty/null timestamp', () => {
  const mockLog = createMockLearningLog();
  const mockBoard = createMockKnowledgeBoard();
  const loader = new ContextLoader({ learningLog: mockLog, knowledgeBoard: mockBoard });

  const date = loader._formatDate(null);
  assert.strictEqual(date, 'Unknown');

  const date2 = loader._formatDate(undefined);
  assert.strictEqual(date2, 'Unknown');
});

// ============================================================
// Tests: getSummary()
// ============================================================

asyncTest('getSummary returns correct counts', async () => {
  const mockLog = createMockLearningLog(SAMPLE_LEARNINGS);
  const mockBoard = createMockKnowledgeBoard(SAMPLE_PENDING_CARDS);
  const loader = new ContextLoader({ learningLog: mockLog, knowledgeBoard: mockBoard });

  const summary_result = await loader.getSummary();

  assert.strictEqual(summary_result.totalLearnings, 5);
  assert.strictEqual(summary_result.highConfidence, 2); // John leads Q3, Sarah is CMO
  assert.strictEqual(summary_result.pendingVerifications, 2);
  assert.ok(Array.isArray(summary_result.recentTopics));
  assert.ok(summary_result.recentTopics.length <= 10);
});

asyncTest('getSummary handles board initialization error', async () => {
  const mockLog = createMockLearningLog(SAMPLE_LEARNINGS);
  const mockBoard = createMockKnowledgeBoard([], {
    getPendingVerifications: async () => { throw new Error('Not initialized'); }
  });
  const loader = new ContextLoader({ learningLog: mockLog, knowledgeBoard: mockBoard });

  const summary_result = await loader.getSummary();

  assert.strictEqual(summary_result.totalLearnings, 5);
  assert.strictEqual(summary_result.pendingVerifications, 0);
});

asyncTest('getSummary returns zero counts when empty', async () => {
  const mockLog = createMockLearningLog([]);
  const mockBoard = createMockKnowledgeBoard([]);
  const loader = new ContextLoader({ learningLog: mockLog, knowledgeBoard: mockBoard });

  const summary_result = await loader.getSummary();

  assert.strictEqual(summary_result.totalLearnings, 0);
  assert.strictEqual(summary_result.highConfidence, 0);
  assert.strictEqual(summary_result.pendingVerifications, 0);
  assert.deepStrictEqual(summary_result.recentTopics, []);
});

// ============================================================
// Session 24 GAP-8: Token Budget Per Context Source
// ============================================================

console.log('\n--- GAP-8: Source Budget Tests ---\n');

test('_truncateAtParagraph returns short text unchanged', () => {
  const mockLog = createMockLearningLog();
  const mockBoard = createMockKnowledgeBoard();
  const loader = new ContextLoader({ learningLog: mockLog, knowledgeBoard: mockBoard });

  assert.strictEqual(loader._truncateAtParagraph('short text', 100), 'short text');
});

test('_truncateAtParagraph cuts at paragraph boundary', () => {
  const mockLog = createMockLearningLog();
  const mockBoard = createMockKnowledgeBoard();
  const loader = new ContextLoader({ learningLog: mockLog, knowledgeBoard: mockBoard });

  const text = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph that is very long.';
  const result = loader._truncateAtParagraph(text, 40);

  assert.ok(result.includes('First paragraph.'));
  assert.ok(result.includes('[... truncated]'));
  assert.ok(!result.includes('Third paragraph'));
});

test('_truncateAtParagraph falls back to newline boundary', () => {
  const mockLog = createMockLearningLog();
  const mockBoard = createMockKnowledgeBoard();
  const loader = new ContextLoader({ learningLog: mockLog, knowledgeBoard: mockBoard });

  // No double newlines, only single newlines
  const text = 'Line one\nLine two\nLine three\nLine four very very long to exceed budget';
  const result = loader._truncateAtParagraph(text, 30);

  assert.ok(result.includes('[... truncated]'));
  assert.ok(result.length < text.length);
});

asyncTest('loadContext truncates sections exceeding source budget', async () => {
  // Generate a lot of learnings to exceed the system budget of 2000 chars
  const manyLearnings = Array.from({ length: 100 }, (_, i) => ({
    timestamp: `2026-02-06T${String(i % 24).padStart(2, '0')}:00:00Z`,
    type: 'learned',
    content: `Learning ${i}: ${'x'.repeat(50)}`,
    source: `source_${i}`,
    confidence: 'high'
  }));

  const mockLog = createMockLearningLog(manyLearnings);
  const mockBoard = createMockKnowledgeBoard([]);
  const loader = new ContextLoader({ learningLog: mockLog, knowledgeBoard: mockBoard });

  const context = await loader.loadContext();

  // Context should exist and be under the total cap
  assert.ok(context.length > 0, 'Should have context');
  assert.ok(context.length <= 21000, `Context should be under total cap, got ${context.length}`);
});

asyncTest('loadContext does not exceed total cap of 20000', async () => {
  // Generate large learnings, large wiki, large deck — all trying to exceed total
  const manyLearnings = Array.from({ length: 200 }, (_, i) => ({
    timestamp: `2026-02-06T${String(i % 24).padStart(2, '0')}:00:00Z`,
    type: 'learned',
    content: `Learning ${i}: ${'x'.repeat(80)}`,
    source: `source_${i}`,
    confidence: 'high'
  }));

  // Mock a collectivesClient that returns a large wiki
  const mockCollectives = {
    resolveCollective: async () => 1,
    listPages: async () => Array.from({ length: 100 }, (_, i) => ({
      id: i + 1, title: `Page ${i}: ${'x'.repeat(50)}`, parentId: i < 5 ? 0 : (i % 5) + 1
    }))
  };

  // Mock a deckClient that returns many boards
  const mockDeck = {
    listBoards: async () => Array.from({ length: 20 }, (_, i) => ({
      id: i + 1, title: `Board ${i}: ${'x'.repeat(40)}`, owner: { uid: 'test' }
    })),
    getStacks: async () => Array.from({ length: 10 }, (_, i) => ({
      title: `Stack ${i}`, cards: Array.from({ length: 5 }, () => ({}))
    })),
    username: 'test'
  };

  const mockLog = createMockLearningLog(manyLearnings);
  const mockBoard = createMockKnowledgeBoard(
    Array.from({ length: 10 }, (_, i) => ({
      id: i, title: `Verify: Item ${i}`, status: 'uncertain'
    }))
  );

  const loader = new ContextLoader({
    learningLog: mockLog,
    knowledgeBoard: mockBoard,
    collectivesClient: mockCollectives,
    deckClient: mockDeck
  });

  const context = await loader.loadContext();

  // Total cap is 20000 + wrapper tags
  const wrapperOverhead = '<agent_memory>\n\n</agent_memory>'.length;
  assert.ok(context.length <= 20000 + wrapperOverhead + 500,
    `Context should be near total cap, got ${context.length}`);
});

// ============================================================
// Summary
// ============================================================

setTimeout(() => {
  summary();
  exitWithCode();
}, 500);
