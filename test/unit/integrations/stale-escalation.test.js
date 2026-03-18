/*
 * Moltagent - Sovereign AI Agent Platform
 * Copyright (C) 2026 Moltagent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * Stale Escalation Tiers Tests
 *
 * Tests the three-tier escalation logic in PersonalBoardManager._checkDoing():
 *   Tier 1: self-manage (no Talk)
 *   Tier 2: notify human (24h cooldown)
 *   Tier 3: urgent promise past due (no cooldown)
 *
 * Run: node test/unit/integrations/stale-escalation.test.js
 *
 * @module test/unit/integrations/stale-escalation
 */

'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

const PersonalBoardManager = require('../../../src/lib/integrations/personal-board-manager');

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function hoursAgo(h) {
  return Math.floor((Date.now() - h * 3600 * 1000) / 1000);
}

function daysAgo(d) {
  return hoursAgo(d * 24);
}

function createMockDeck({ doingCards = [], comments = {}, baseUrl = 'https://nc.test' } = {}) {
  const movedCards = [];
  const addedComments = [];

  return {
    baseUrl,
    _ensureInit: async () => {},
    _getIds: async () => ({ boardId: 42, stacks: {}, labels: {} }),
    getCardsInStack: async (stack) => {
      if (stack === 'doing') return doingCards;
      return [];
    },
    getComments: async (cardId) => comments[cardId] || [],
    addComment: async (cardId, message, type) => {
      addedComments.push({ cardId, message, type });
    },
    moveCard: async (cardId, from, to) => {
      movedCards.push({ cardId, from, to });
    },
    createCard: async () => ({}),
    addLabel: async () => {},
    _movedCards: movedCards,
    _addedComments: addedComments,
  };
}

function makePBM({ deck, notifyUser }) {
  const pbm = Object.create(PersonalBoardManager.prototype);
  pbm.deck = deck;
  pbm.notifyUser = notifyUser || (() => {});
  pbm.llmRouter = null;
  pbm._initialized = true;
  pbm._ownerUser = 'fu';
  pbm.STALE_DOING_MS = 48 * 3600 * 1000;
  pbm.STALE_WAITING_DAYS = 7;
  pbm.DONE_ARCHIVE_DAYS = 7;
  return pbm;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log('Stale Escalation Tiers Tests');
console.log('============================\n');

// --- TC-SE-001: 14+ days, no assignee → auto-move to Planned ---

asyncTest('TC-SE-001: card stuck 14+ days with no assignee → auto-moved to Planned', async () => {
  const notifications = [];
  const deck = createMockDeck({
    doingCards: [{
      id: 20,
      title: 'Ancient agent task',
      lastModified: daysAgo(16), // 16 days stale
      assignedUsers: [],
      duedate: null,
      labels: [],
    }],
  });

  const pbm = makePBM({ deck, notifyUser: (msg) => notifications.push(msg) });
  const result = await pbm._checkDoing();

  // Should auto-move to planned
  assert.ok(deck._movedCards.some(m => m.cardId === 20 && m.to === 'planned'),
    'Should move card from doing to planned');
  // Should add a comment explaining why
  assert.ok(deck._addedComments.some(c => c.cardId === 20 && c.message.includes('Auto-moving to Planned')),
    'Should add comment explaining auto-move');
  // Should NOT notify Talk
  assert.strictEqual(notifications.length, 0, 'Tier 1 auto-move should not Talk-notify');
  // Actions should record the auto-move
  assert.ok(result.actions.some(a => a.startsWith('tier1-auto-move')),
    'Actions should include tier1-auto-move');
});

// --- TC-SE-002: 8 days, has assignee → Talk notification (Tier 2) ---

asyncTest('TC-SE-002: card stuck 8 days with assignee → Talk notification', async () => {
  const notifications = [];
  const deck = createMockDeck({
    doingCards: [{
      id: 21,
      title: 'Assigned task',
      lastModified: daysAgo(8),
      assignedUsers: [{ participant: { uid: 'fu' } }],
      duedate: null,
      labels: [],
    }],
  });

  const pbm = makePBM({ deck, notifyUser: (msg) => notifications.push(msg) });
  const result = await pbm._checkDoing();

  assert.strictEqual(notifications.length, 1, 'Tier 2 should notify via Talk');
  assert.ok(result.actions.some(a => a.startsWith('tier2-notify')),
    'Actions should include tier2-notify');
  // Should stamp comment for cooldown tracking
  assert.ok(deck._addedComments.some(c => c.cardId === 21 && c.message.includes('Stale check')),
    'Should stamp Stale check comment for cooldown');
});

// --- TC-SE-003: Promise label + past due → Talk notification (Tier 3, no cooldown) ---

asyncTest('TC-SE-003: card with #promise label + past due → urgent Talk notification', async () => {
  const notifications = [];
  const deck = createMockDeck({
    doingCards: [{
      id: 22,
      title: 'Overdue promise',
      lastModified: daysAgo(5),
      assignedUsers: [],
      duedate: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(), // 2 days past due
      labels: [{ title: 'promise', color: '9B59B6' }],
    }],
    // Even with a recent stale check, tier 3 should still fire (no cooldown)
    comments: {
      22: [{
        actorId: 'moltagent',
        message: '[STATUS] Stale check: in Doing for 4 days. Notified user in Talk (tier-3 urgent).',
        creationDateTime: new Date(Date.now() - 2 * 3600 * 1000).toISOString(), // 2 hours ago
      }]
    }
  });

  const pbm = makePBM({ deck, notifyUser: (msg) => notifications.push(msg) });
  const result = await pbm._checkDoing();

  assert.strictEqual(notifications.length, 1, 'Tier 3 should always notify (no cooldown)');
  assert.ok(notifications[0].message.includes('past due'), 'Message should mention past due');
  assert.ok(result.actions.some(a => a.startsWith('tier3-urgent')),
    'Actions should include tier3-urgent');
});

// --- TC-SE-004: fresh card (< 48h) → no action ---

asyncTest('TC-SE-004: fresh card in doing (< 48h) → no stale action', async () => {
  const notifications = [];
  const deck = createMockDeck({
    doingCards: [{
      id: 23,
      title: 'Fresh task',
      lastModified: hoursAgo(24), // Only 24 hours old
      assignedUsers: [{ participant: { uid: 'fu' } }],
      duedate: null,
      labels: [],
    }],
  });

  const pbm = makePBM({ deck, notifyUser: (msg) => notifications.push(msg) });
  const result = await pbm._checkDoing();

  assert.strictEqual(notifications.length, 0, 'Fresh card should not trigger notifications');
  assert.strictEqual(result.stale, false, 'Should not be marked stale');
  assert.strictEqual(result.actions.length, 0, 'No actions for fresh card');
});

// --- TC-SE-005: empty doing stack → no action ---

asyncTest('TC-SE-005: empty doing stack → returns stale=false', async () => {
  const deck = createMockDeck({ doingCards: [] });
  const pbm = makePBM({ deck });
  const result = await pbm._checkDoing();

  assert.strictEqual(result.stale, false);
  assert.strictEqual(result.cardTitle, null);
});

// ---------------------------------------------------------------------------

setTimeout(() => { summary(); exitWithCode(); }, 200);
