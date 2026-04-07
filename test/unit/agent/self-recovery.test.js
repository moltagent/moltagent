/*
 * Moltagent - Sovereign AI Agent Platform
 * Copyright (C) 2026 Moltagent Contributors
 * AGPL-3.0
 */
'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

const SelfRecovery = require('../../../src/lib/agent/self-recovery');

// --- Mock PersonalBoardManager ---
function createMockBoard() {
  const cards = [];
  return {
    cards,
    createPersonalCard: async ({ title, description, label }) => {
      cards.push({ title, description, label });
      return { id: cards.length };
    }
  };
}

// TC-SR-001: createRecoveryCard creates card with self-recovery label
asyncTest('TC-SR-001: createRecoveryCard creates card on Personal board', async () => {
  const board = createMockBoard();
  const sr = new SelfRecovery({ personalBoardManager: board, logger: console });

  await sr.createRecoveryCard({
    originalRequest: 'Look into Nextcloud Analytics. Put results on a card.',
    completedPart: 'Found info about NC Analytics...',
    failedAction: 'Create Deck card with findings',
    reason: 'Compound decomposition failed',
    recoveryInstructions: 'Create card titled "NC Analytics" on Moltagent Tasks, assign to Jordan',
    userId: 'Jordan',
    sessionId: 'strte9d4'
  });

  assert.strictEqual(board.cards.length, 1);
  assert.strictEqual(board.cards[0].label, 'self-recovery');
  assert.ok(board.cards[0].title.startsWith('Recover:'));
});

// TC-SR-002: Card description contains all context fields
asyncTest('TC-SR-002: Card description contains structured context', async () => {
  const board = createMockBoard();
  const sr = new SelfRecovery({ personalBoardManager: board, logger: console });

  await sr.createRecoveryCard({
    originalRequest: 'Test request',
    completedPart: 'Research done',
    failedAction: 'Card creation',
    reason: 'API timeout',
    recoveryInstructions: 'Retry card creation',
    userId: 'TestUser',
    sessionId: 'sess-123'
  });

  const desc = board.cards[0].description;
  assert.ok(desc.includes('TestUser'), 'should contain userId');
  assert.ok(desc.includes('sess-123'), 'should contain sessionId');
  assert.ok(desc.includes('Card creation'), 'should contain failed action');
  assert.ok(desc.includes('API timeout'), 'should contain reason');
  assert.ok(desc.includes('Retry card creation'), 'should contain recovery instructions');
  assert.ok(desc.includes('Test request'), 'should contain original request');
});

// TC-SR-003: Title truncated to 60 chars
asyncTest('TC-SR-003: Title truncated to 60 chars for long actions', async () => {
  const board = createMockBoard();
  const sr = new SelfRecovery({ personalBoardManager: board, logger: console });

  await sr.createRecoveryCard({
    originalRequest: 'x',
    completedPart: 'x',
    failedAction: 'A'.repeat(100),
    reason: 'x',
    recoveryInstructions: 'x',
    userId: 'u'
  });

  assert.ok(board.cards[0].title.length <= 60, `title should be <= 60 chars, got ${board.cards[0].title.length}`);
});

// TC-SR-004: createRecoveryCard never throws
asyncTest('TC-SR-004: createRecoveryCard failure does not throw', async () => {
  const board = {
    createPersonalCard: async () => { throw new Error('Deck API down'); }
  };
  const sr = new SelfRecovery({ personalBoardManager: board, logger: console });

  // Should not throw
  await sr.createRecoveryCard({
    originalRequest: 'test',
    completedPart: 'test',
    failedAction: 'test',
    reason: 'test',
    recoveryInstructions: 'test',
    userId: 'u'
  });

  assert.ok(true, 'did not throw');
});

// TC-SR-005: sessionId is optional
asyncTest('TC-SR-005: Card works without sessionId', async () => {
  const board = createMockBoard();
  const sr = new SelfRecovery({ personalBoardManager: board, logger: console });

  await sr.createRecoveryCard({
    originalRequest: 'test',
    completedPart: 'test',
    failedAction: 'test action',
    reason: 'reason',
    recoveryInstructions: 'instructions',
    userId: 'u'
  });

  assert.strictEqual(board.cards.length, 1);
  assert.ok(!board.cards[0].description.includes('Session:'), 'should not include Session line when sessionId is absent');
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
