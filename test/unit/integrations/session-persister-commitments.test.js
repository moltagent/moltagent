/*
 * Moltagent - Sovereign AI Security Layer
 * Copyright (C) 2026 Moltagent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * SessionPersister + Commitment Detection Integration Tests
 *
 * Validates that SessionPersister creates Personal board cards when
 * commitments are detected in expired sessions.
 *
 * Run: node test/unit/integrations/session-persister-commitments.test.js
 *
 * @module test/unit/integrations/session-persister-commitments
 */

'use strict';

const assert = require('assert');
const { asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const SessionPersister = require('../../../src/lib/integrations/session-persister');

// ============================================================
// Mock Factories
// ============================================================

function createMockWikiClient() {
  return {
    writePageWithFrontmatter: async function (title, frontmatter, body) {
      this._lastWrite = { title, frontmatter, body };
      return `${title}.md`;
    },
    _lastWrite: null
  };
}

function createMockLLMRouter() {
  return {
    route: async function () {
      return { result: '## Summary\nDiscussed project tasks.\n## Open Items\n- Follow up on contracts' };
    }
  };
}

function createMockPersonalBoardManager() {
  const cards = [];
  return {
    _cards: cards,
    createPersonalCard: async ({ title, description, label }) => {
      const card = { id: cards.length + 1, title, description, label };
      cards.push(card);
      return card;
    },
    initialize: async () => {},
    _initialized: true
  };
}

function createSession(context) {
  return {
    id: 'test-session-id',
    roomToken: 'abc12345xyz',
    userId: 'fu',
    createdAt: Date.now() - 10000,
    lastActivityAt: Date.now(),
    context,
    credentialsAccessed: new Set(),
    pendingApprovals: new Map(),
    grantedApprovals: new Map()
  };
}

// ============================================================
// Tests
// ============================================================

console.log('\n=== SessionPersister Commitment Detection Tests ===\n');

asyncTest('TC-SPC-001: Session with commitment creates Personal board card', async () => {
  const wiki = createMockWikiClient();
  const router = createMockLLMRouter();
  const pbm = createMockPersonalBoardManager();

  const persister = new SessionPersister({
    wikiClient: wiki,
    llmRouter: router,
    personalBoardManager: pbm
  });

  const session = createSession([
    { role: 'system', content: 'You are Moltagent.' },
    { role: 'user', content: 'Can you check the ManeraMedia contract?' },
    { role: 'assistant', content: 'I will look into the ManeraMedia contract and get back to you.' },
    { role: 'user', content: 'Thanks' },
    { role: 'assistant', content: 'No problem, I will follow up on this tomorrow.' },
    { role: 'user', content: 'Perfect' }
  ]);

  await persister.persistSession(session);

  assert.ok(pbm._cards.length > 0, `Should create at least one commitment card, got ${pbm._cards.length}`);
  // Cards get promise or follow-up labels depending on detected type
  assert.ok(
    pbm._cards.some(c => c.label === 'promise' || c.label === 'follow-up'),
    'Card should have "promise" or "follow-up" label'
  );
});

asyncTest('TC-SPC-002: Session without commitments creates no cards', async () => {
  const wiki = createMockWikiClient();
  const router = createMockLLMRouter();
  const pbm = createMockPersonalBoardManager();

  const persister = new SessionPersister({
    wikiClient: wiki,
    llmRouter: router,
    personalBoardManager: pbm
  });

  const session = createSession([
    { role: 'system', content: 'You are Moltagent.' },
    { role: 'user', content: 'What time is it?' },
    { role: 'assistant', content: 'It is currently 14:30 local time.' },
    { role: 'user', content: 'Thanks' },
    { role: 'assistant', content: 'You are welcome.' },
    { role: 'user', content: 'Bye' }
  ]);

  await persister.persistSession(session);

  assert.strictEqual(pbm._cards.length, 0, 'Should not create any commitment cards');
});

asyncTest('TC-SPC-003: No personalBoardManager → no error', async () => {
  const wiki = createMockWikiClient();
  const router = createMockLLMRouter();

  const persister = new SessionPersister({
    wikiClient: wiki,
    llmRouter: router
    // personalBoardManager omitted
  });

  const session = createSession([
    { role: 'system', content: 'You are Moltagent.' },
    { role: 'user', content: 'Can you check something?' },
    { role: 'assistant', content: 'I will look into that for you.' },
    { role: 'user', content: 'Thanks' },
    { role: 'assistant', content: 'No problem.' },
    { role: 'user', content: 'Bye' }
  ]);

  // Should not throw even with commitments detected but no PBM
  const result = await persister.persistSession(session);
  assert.ok(result, 'Session should still be persisted');
});

asyncTest('TC-SPC-004: Commitment card includes context from user message', async () => {
  const wiki = createMockWikiClient();
  const router = createMockLLMRouter();
  const pbm = createMockPersonalBoardManager();

  const persister = new SessionPersister({
    wikiClient: wiki,
    llmRouter: router,
    personalBoardManager: pbm
  });

  const session = createSession([
    { role: 'system', content: 'You are Moltagent.' },
    { role: 'user', content: 'The ManeraMedia contract needs review.' },
    { role: 'assistant', content: 'I will review the ManeraMedia contract.' },
    { role: 'user', content: 'Also check the timeline.' },
    { role: 'assistant', content: 'Sure, let me research the project timeline as well.' },
    { role: 'user', content: 'Great' }
  ]);

  await persister.persistSession(session);

  assert.ok(pbm._cards.length > 0, 'Should create commitment cards');

  // At least one card should reference the context
  const hasContext = pbm._cards.some(c =>
    c.description && c.description.includes('Context:')
  );
  assert.ok(hasContext, 'Card description should include user context');
});

asyncTest('TC-SPC-005: PersonalBoardManager failure does not break session persistence', async () => {
  const wiki = createMockWikiClient();
  const router = createMockLLMRouter();

  const failingPBM = {
    createPersonalCard: async () => { throw new Error('Board API down'); }
  };

  const persister = new SessionPersister({
    wikiClient: wiki,
    llmRouter: router,
    personalBoardManager: failingPBM
  });

  const session = createSession([
    { role: 'system', content: 'You are Moltagent.' },
    { role: 'user', content: 'Check the contract.' },
    { role: 'assistant', content: 'I will look into the contract details.' },
    { role: 'user', content: 'Thanks' },
    { role: 'assistant', content: 'No problem.' },
    { role: 'user', content: 'Bye' }
  ]);

  // Should not throw — commitment failure is non-fatal
  const result = await persister.persistSession(session);
  assert.ok(result, 'Session should still be persisted despite PBM failure');
  assert.ok(wiki._lastWrite, 'Wiki write should still have happened');
});

// ============================================================
// Finalize
// ============================================================

setTimeout(() => { summary(); exitWithCode(); }, 500);
