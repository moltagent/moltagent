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
 * Stale Notification Cooldown Tests
 *
 * Tests the comment-based 24h cooldown and card link generation
 * in PersonalBoardManager._checkDoing().
 *
 * Run: node test/unit/integrations/stale-notification.test.js
 *
 * @module test/unit/integrations/stale-notification
 */

'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

const PersonalBoardManager = require('../../../src/lib/integrations/personal-board-manager');

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 3600 * 1000;

function hoursAgo(h) {
  return Math.floor((Date.now() - h * 3600 * 1000) / 1000);
}

/**
 * Build a mock DeckClient with configurable cards and comment history.
 */
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
    // Expose for assertions
    _movedCards: movedCards,
    _addedComments: addedComments,
  };
}

function makePBM({ deck, notifyUser }) {
  // Construct with a real ncRequestManager mock to avoid the constructor throw
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

console.log('Stale Notification Tests');
console.log('========================\n');

// --- TC-SN-001: Already notified within 24h → no duplicate notification ---

asyncTest('TC-SN-001: card notified within 24h → no duplicate Talk notification', async () => {
  const notifications = [];
  const deck = createMockDeck({
    doingCards: [{
      id: 10,
      title: 'Active task',
      lastModified: hoursAgo(72), // 3 days stale
      assignedUsers: [{ participant: { uid: 'fu' } }], // human assigned → tier 2
      duedate: null,
      labels: [],
    }],
    comments: {
      10: [{
        actorId: 'moltagent',
        message: '[STATUS] Stale check: in Doing for 3 days. Notified user in Talk.',
        creationDateTime: new Date(Date.now() - 12 * 3600 * 1000).toISOString(), // 12 hours ago
      }]
    }
  });

  const pbm = makePBM({ deck, notifyUser: (msg) => notifications.push(msg) });
  await pbm._checkDoing();

  assert.strictEqual(notifications.length, 0, 'Should not send duplicate notification within 24h');
});

// --- TC-SN-002: Notified 25h ago → re-notification allowed ---

asyncTest('TC-SN-002: card notified 25h ago → re-notification allowed', async () => {
  const notifications = [];
  const deck = createMockDeck({
    doingCards: [{
      id: 11,
      title: 'Stale task',
      lastModified: hoursAgo(96), // 4 days stale
      assignedUsers: [{ participant: { uid: 'fu' } }], // human assigned → tier 2
      duedate: null,
      labels: [],
    }],
    comments: {
      11: [{
        actorId: 'moltagent',
        message: '[STATUS] Stale check: in Doing for 3 days. Notified user in Talk.',
        creationDateTime: new Date(Date.now() - 25 * 3600 * 1000).toISOString(), // 25 hours ago
      }]
    }
  });

  const pbm = makePBM({ deck, notifyUser: (msg) => notifications.push(msg) });
  await pbm._checkDoing();

  assert.strictEqual(notifications.length, 1, 'Should re-notify after 24h cooldown expires');
});

// --- TC-SN-003: Card with no assignee + no due date → self-manage, no Talk ---

asyncTest('TC-SN-003: card with no assignee + no due date → self-manage (no Talk)', async () => {
  const notifications = [];
  const deck = createMockDeck({
    doingCards: [{
      id: 12,
      title: 'Agent task',
      lastModified: hoursAgo(10 * 24), // 10 days stale
      assignedUsers: [], // no human
      duedate: null,
      labels: [],
    }],
  });

  const pbm = makePBM({ deck, notifyUser: (msg) => notifications.push(msg) });
  const result = await pbm._checkDoing();

  assert.strictEqual(notifications.length, 0, 'Tier 1 should NOT notify Talk');
  // Should have a self-check comment
  assert.ok(deck._addedComments.some(c => c.message.includes('Stale check')),
    'Should add self-check comment on card');
});

// --- TC-SN-004: Card with human assigned + stale → Talk notification with card link ---

asyncTest('TC-SN-004: card with human assignee → Talk notification with card link', async () => {
  const notifications = [];
  const deck = createMockDeck({
    doingCards: [{
      id: 13,
      title: 'Human-assigned task',
      lastModified: hoursAgo(72), // 3 days stale
      assignedUsers: [{ participant: { uid: 'fu' } }],
      duedate: null,
      labels: [],
    }],
    baseUrl: 'https://cloud.example.com',
  });

  const pbm = makePBM({ deck, notifyUser: (msg) => notifications.push(msg) });
  await pbm._checkDoing();

  assert.strictEqual(notifications.length, 1, 'Tier 2 should notify via Talk');
  const message = notifications[0].message;
  assert.ok(message.includes('Human-assigned task'), 'Notification should include card title');
  assert.ok(message.includes('/apps/deck/board/42/card/13'), 'Notification should include card link');
});

// ---------------------------------------------------------------------------

setTimeout(() => { summary(); exitWithCode(); }, 200);
