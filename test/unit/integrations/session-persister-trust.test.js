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
 * Integration Tests for SessionPersister + TrustGate + MythDetector wiring
 *
 * Tests that Layer 2 (trust gate) and Layer 4 (myth detector) are properly
 * wired into the session persistence pipeline, and that session pages include
 * filtered claims and myth alert sections.
 *
 * @module test/unit/integrations/session-persister-trust.test
 */

'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const SessionPersister = require('../../../src/lib/integrations/session-persister');

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

console.log('\n=== SessionPersister Trust Pipeline Tests ===\n');

// Mock wiki client
function mockWiki() {
  const pages = {};
  return {
    resolveCollective: async () => 2,
    listPages: async () => Object.values(pages).map((p, i) => ({ id: i + 1, title: p.title, parentId: 0, filePath: '', fileName: p.title + '.md' })),
    ensureSection: async (collectiveId, sectionName) => {
      const existing = Object.values(pages).find(p => p.title === sectionName);
      if (existing) return { id: 50, title: sectionName, filePath: '', fileName: sectionName + '.md' };
      const id = Object.keys(pages).length + 100;
      pages[sectionName] = { title: sectionName, content: '' };
      return { id, title: sectionName, filePath: '', fileName: sectionName + '.md' };
    },
    createPage: async (collectiveId, parentId, title) => {
      const id = Object.keys(pages).length + 100;
      pages[title] = { title, content: '' };
      return { id, title, filePath: '', fileName: title + '.md' };
    },
    writePageContent: async (path, content) => {
      const title = path.replace('.md', '').split('/').pop();
      pages[title] = { title, content };
    },
    _pages: pages,
    _getContent: (title) => {
      for (const [, p] of Object.entries(pages)) {
        if (p.title === title || p.content) return p.content;
      }
      return null;
    }
  };
}

// Mock LLM router
function mockRouter(summaryText = '## Summary\nTest summary.') {
  return {
    route: async () => ({ result: summaryText })
  };
}

// Build a session with provenance-tagged context
function buildSession(contextEntries, opts = {}) {
  return {
    context: contextEntries,
    createdAt: opts.createdAt || new Date().toISOString(),
    roomToken: opts.roomToken || 'test1234',
    roomName: opts.roomName || 'Test Room',
    userId: opts.userId || 'testuser',
    actionLedger: []
  };
}

function assistantEntry(text, segments) {
  return {
    role: 'assistant',
    content: text,
    meta: { provenance: segments }
  };
}

function userEntry(content) {
  return { role: 'user', content };
}

// =============================================================================
// Constructor Tests
// =============================================================================

test('TC-SPT-001: constructor creates TrustGate with default balanced level', () => {
  const sp = new SessionPersister({ wikiClient: mockWiki(), llmRouter: mockRouter() });
  assert.ok(sp.trustGate);
  assert.strictEqual(sp.trustGate.trustLevel, 'balanced');
});

test('TC-SPT-002: constructor accepts custom trust level', () => {
  const sp = new SessionPersister({ wikiClient: mockWiki(), llmRouter: mockRouter(), trustLevel: 'aggressive' });
  assert.strictEqual(sp.trustGate.trustLevel, 'aggressive');
});

test('TC-SPT-003: constructor creates MythDetector', () => {
  const sp = new SessionPersister({ wikiClient: mockWiki(), llmRouter: mockRouter() });
  assert.ok(sp.mythDetector);
});

// =============================================================================
// Trust-Gated Persistence Tests
// =============================================================================

asyncTest('TC-SPT-010: session page includes filtered claims section', async () => {
  const wiki = mockWiki();
  const sp = new SessionPersister({
    wikiClient: wiki,
    llmRouter: mockRouter(),
    trustLevel: 'aggressive'
  });

  const session = buildSession([
    userEntry('Tell me about Carlos'),
    assistantEntry('Carlos works at TheCatalyne', [
      { text: 'Carlos works at TheCatalyne', trust: 'grounded', provenance: 'wiki', sourceRefs: ['wiki:People/Carlos'], confidence: 0.9 }
    ]),
    userEntry('What about Phoenix?'),
    assistantEntry('Phoenix might relate to Berlin office', [
      { text: 'Phoenix might relate to Berlin office', trust: 'ungrounded', provenance: 'model', sourceRefs: [], confidence: 0.1 }
    ]),
    userEntry('And the timeline?'),
    assistantEntry('The timeline seems reasonable for Q1', [
      { text: 'The timeline seems reasonable for Q1', trust: 'ungrounded', provenance: 'model', sourceRefs: [], confidence: 0.15 }
    ]),
  ]);

  const result = await sp.persistSession(session);
  assert.ok(result, 'Should persist session');

  // Check that the written content includes filtered section
  const allContent = Object.values(wiki._pages).map(p => p.content).join('\n');
  assert.ok(allContent.includes('Filtered'), 'Page should include Filtered section');
  assert.ok(allContent.includes('ungrounded'), 'Filtered section should mention ungrounded');
  assert.ok(allContent.includes('trust_level: aggressive'), 'Frontmatter should include trust_level');
});

asyncTest('TC-SPT-011: session page includes trust metadata in frontmatter', async () => {
  const wiki = mockWiki();
  const sp = new SessionPersister({
    wikiClient: wiki,
    llmRouter: mockRouter(),
    trustLevel: 'balanced'
  });

  const session = buildSession([
    userEntry('Hello'),
    assistantEntry('Hi there', [
      { text: 'Hi there', trust: 'stated', provenance: 'user', sourceRefs: [], confidence: 0.8 }
    ]),
    userEntry('How are you?'),
    assistantEntry('I am well', [
      { text: 'I am well', trust: 'stated', provenance: 'user', sourceRefs: [], confidence: 0.8 }
    ]),
    userEntry('Great'),
    assistantEntry('Thanks', [
      { text: 'Thanks', trust: 'stated', provenance: 'user', sourceRefs: [], confidence: 0.8 }
    ]),
  ]);

  await sp.persistSession(session);

  const allContent = Object.values(wiki._pages).map(p => p.content).join('\n');
  assert.ok(allContent.includes('trust_level: balanced'));
});

// =============================================================================
// Myth Detection Integration Tests
// =============================================================================

asyncTest('TC-SPT-020: myth alerts section appears in session page', async () => {
  const wiki = mockWiki();
  const sp = new SessionPersister({
    wikiClient: wiki,
    llmRouter: mockRouter(),
    trustLevel: 'relaxed'  // relaxed so nothing is filtered, only myths shown
  });

  const mythClaim = 'Sarah runs the Q3 campaign at ManeraMedia';
  const mythSeg = { text: mythClaim, trust: 'ungrounded', provenance: 'model', sourceRefs: [], confidence: 0.1 };

  const session = buildSession([
    userEntry('Tell me about Sarah'),
    assistantEntry(mythClaim, [mythSeg]),
    userEntry('More about Sarah'),
    assistantEntry(mythClaim, [mythSeg]),
    userEntry('Sarah details'),
    assistantEntry(mythClaim, [mythSeg]),
  ]);

  await sp.persistSession(session);

  const allContent = Object.values(wiki._pages).map(p => p.content).join('\n');
  assert.ok(allContent.includes('Myth Alerts'), 'Page should include Myth Alerts section');
  assert.ok(allContent.includes('myth detected'), 'Should mention myth detected');
  assert.ok(allContent.includes('myths_detected: 1'), 'Frontmatter should show myths_detected');
});

asyncTest('TC-SPT-021: no myths → no myth alerts section', async () => {
  const wiki = mockWiki();
  const sp = new SessionPersister({
    wikiClient: wiki,
    llmRouter: mockRouter(),
    trustLevel: 'relaxed'
  });

  const session = buildSession([
    userEntry('Hello'),
    assistantEntry('Hi', [
      { text: 'Hi', trust: 'stated', provenance: 'user', sourceRefs: [], confidence: 0.8 }
    ]),
    userEntry('Bye'),
    assistantEntry('Goodbye', [
      { text: 'Goodbye', trust: 'stated', provenance: 'user', sourceRefs: [], confidence: 0.8 }
    ]),
    userEntry('Later'),
    assistantEntry('See you', [
      { text: 'See you', trust: 'stated', provenance: 'user', sourceRefs: [], confidence: 0.8 }
    ]),
  ]);

  await sp.persistSession(session);

  const allContent = Object.values(wiki._pages).map(p => p.content).join('\n');
  assert.ok(!allContent.includes('Myth Alerts'), 'No Myth Alerts section when no myths');
  assert.ok(allContent.includes('myths_detected: 0'));
});

// =============================================================================
// Summary
// =============================================================================

setTimeout(() => { summary(); exitWithCode(); }, 500);
