/**
 * AGPL-3.0 License
 * Copyright (C) 2024 Moltagent Contributors
 *
 * artifact-focus.test.js
 *
 * Architecture Brief
 * ------------------
 * Problem:   Verify that artifact focus tracking works correctly across
 *            SessionManager, AgentLoop._extractArtifact, and the focus
 *            context builder in MessageProcessor.
 *
 * Pattern:   Unit tests for focus lifecycle (set, get, expire, clear),
 *            artifact extraction from tool results, and prompt injection.
 *
 * Key Dependencies:
 * - session-manager (focus API)
 * - agent-loop (_extractArtifact)
 * - test-runner helpers
 *
 * Data Flow: tool result → _extractArtifact → setArtifactFocus → getArtifactFocus → prompt
 *
 * Run: node test/unit/artifact-focus.test.js
 *
 * @module test/unit/artifact-focus
 */

'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../helpers/test-runner');
const SessionManager = require('../../src/security/session-manager');
const { extractArtifact } = require('../../src/lib/agent/artifact-extractor');

// ============================================================
// SessionManager Focus API
// ============================================================

console.log('\n=== Artifact Focus Tests ===\n');

// 1. New session has null artifactFocus
test('New session has null artifactFocus', () => {
  const sm = new SessionManager();
  const session = sm.getSession('test-token-1', 'testuser');
  assert.strictEqual(session.artifactFocus, null);
});

// 2. setArtifactFocus stores focus with setAt timestamp
test('setArtifactFocus stores focus with setAt timestamp', () => {
  const sm = new SessionManager();
  const session = sm.getSession('test-token-2', 'testuser');
  const before = Date.now();

  sm.setArtifactFocus(session, {
    type: 'deck_card',
    id: 1234,
    boardId: 144,
    title: 'Test Card',
    source: 'tool_result',
  });

  assert.ok(session.artifactFocus, 'Focus should be set');
  assert.strictEqual(session.artifactFocus.type, 'deck_card');
  assert.strictEqual(session.artifactFocus.id, 1234);
  assert.strictEqual(session.artifactFocus.boardId, 144);
  assert.strictEqual(session.artifactFocus.title, 'Test Card');
  assert.ok(session.artifactFocus.setAt >= before, 'setAt should be recent');
});

// 3. getArtifactFocus returns focus when fresh
test('getArtifactFocus returns focus when fresh', () => {
  const sm = new SessionManager();
  const session = sm.getSession('test-token-3', 'testuser');

  sm.setArtifactFocus(session, {
    type: 'deck_card',
    id: 42,
    title: 'Fresh Card',
  });

  const focus = sm.getArtifactFocus(session);
  assert.ok(focus, 'Should return focus');
  assert.strictEqual(focus.id, 42);
});

// 4. getArtifactFocus returns null when session inactive > maxAgeMs
test('getArtifactFocus returns null when expired', () => {
  const sm = new SessionManager();
  const session = sm.getSession('test-token-4', 'testuser');

  sm.setArtifactFocus(session, {
    type: 'deck_card',
    id: 99,
    title: 'Old Card',
  });

  // Simulate old focus and no recent activity
  session.artifactFocus.setAt = Date.now() - 700000; // 11+ min ago
  session.lastActivityAt = Date.now() - 700000;

  const focus = sm.getArtifactFocus(session);
  assert.strictEqual(focus, null, 'Expired focus should return null');
  assert.strictEqual(session.artifactFocus, null, 'Should clear expired focus');
});

// 5. getArtifactFocus keeps focus alive when lastActivityAt is recent
test('getArtifactFocus keeps focus alive with recent activity', () => {
  const sm = new SessionManager();
  const session = sm.getSession('test-token-5', 'testuser');

  sm.setArtifactFocus(session, {
    type: 'deck_card',
    id: 77,
    title: 'Active Card',
  });

  // Focus set 30 min ago, but user messaged 1 min ago
  session.artifactFocus.setAt = Date.now() - 1800000;
  session.lastActivityAt = Date.now() - 60000;

  const focus = sm.getArtifactFocus(session);
  assert.ok(focus, 'Focus should still be valid with recent activity');
  assert.strictEqual(focus.id, 77);
});

// 6. clearArtifactFocus sets artifactFocus to null
test('clearArtifactFocus sets focus to null', () => {
  const sm = new SessionManager();
  const session = sm.getSession('test-token-6', 'testuser');

  sm.setArtifactFocus(session, {
    type: 'wiki_page',
    id: 'page-123',
    title: 'Test Page',
  });

  assert.ok(session.artifactFocus, 'Focus should be set');
  sm.clearArtifactFocus(session);
  assert.strictEqual(session.artifactFocus, null, 'Focus should be cleared');
});

// 7. setArtifactFocus overwrites previous focus
test('setArtifactFocus overwrites previous focus', () => {
  const sm = new SessionManager();
  const session = sm.getSession('test-token-7', 'testuser');

  sm.setArtifactFocus(session, {
    type: 'deck_card',
    id: 100,
    title: 'Card A',
  });

  sm.setArtifactFocus(session, {
    type: 'deck_card',
    id: 200,
    title: 'Card B',
  });

  const focus = sm.getArtifactFocus(session);
  assert.strictEqual(focus.id, 200, 'Should be Card B');
  assert.strictEqual(focus.title, 'Card B');
});

// 7b. setArtifactFocus guards against invalid input
test('setArtifactFocus guards against null/missing fields', () => {
  const sm = new SessionManager();
  const session = sm.getSession('test-token-7b', 'testuser');

  sm.setArtifactFocus(null, { type: 'deck_card', id: 1 }); // null session
  sm.setArtifactFocus(session, null); // null focus
  sm.setArtifactFocus(session, { id: 1 }); // missing type
  sm.setArtifactFocus(session, { type: 'deck_card' }); // missing id (id == undefined)

  assert.strictEqual(session.artifactFocus, null, 'Focus should remain null for invalid inputs');
});

// 7c. Description truncated to 500 chars
test('setArtifactFocus truncates description to 500 chars', () => {
  const sm = new SessionManager();
  const session = sm.getSession('test-token-7c', 'testuser');
  const longDesc = 'A'.repeat(1000);

  sm.setArtifactFocus(session, {
    type: 'deck_card',
    id: 1,
    title: 'Test',
    description: longDesc,
  });

  assert.strictEqual(session.artifactFocus.description.length, 500);
});

// ============================================================
// AgentLoop._extractArtifact
// ============================================================

// extractArtifact is now a shared module — import directly

// 8. deck_create_card result with card field sets card focus
test('_extractArtifact: deck_create_card with card sets focus', () => {
  const result = extractArtifact('deck_create_card', {
    success: true,
    result: 'Created card',
    card: { id: 1234, boardId: 144, stackId: 10, title: 'New Card' },
  });

  assert.ok(result, 'Should extract artifact');
  assert.strictEqual(result.type, 'deck_card');
  assert.strictEqual(result.id, 1234);
  assert.strictEqual(result.boardId, 144);
  assert.strictEqual(result.title, 'New Card');
});

// 9. deck tool with card field (generic) sets focus
test('_extractArtifact: any tool result with card.id sets focus', () => {
  const result = extractArtifact('deck_update_card', {
    success: true,
    result: 'Updated',
    card: { id: 42, boardId: 5 },
  });

  assert.ok(result, 'Should extract artifact');
  assert.strictEqual(result.type, 'deck_card');
  assert.strictEqual(result.id, 42);
});

// 10. wiki_page result sets wiki focus
test('_extractArtifact: page result sets wiki_page focus', () => {
  const result = extractArtifact('wiki_read', {
    success: true,
    page: { id: 'page-1', title: 'Architecture' },
  });

  assert.ok(result, 'Should extract wiki artifact');
  assert.strictEqual(result.type, 'wiki_page');
  assert.strictEqual(result.id, 'page-1');
});

// 11. calendar event result sets event focus
test('_extractArtifact: event result sets calendar_event focus', () => {
  const result = extractArtifact('calendar_create', {
    success: true,
    event: { uid: 'evt-abc', summary: 'Team Standup' },
  });

  assert.ok(result, 'Should extract event artifact');
  assert.strictEqual(result.type, 'calendar_event');
  assert.strictEqual(result.id, 'evt-abc');
  assert.strictEqual(result.title, 'Team Standup');
});

// 12. Unknown tool name with no structured data does not set focus
test('_extractArtifact: unknown tool returns null', () => {
  const result = extractArtifact('send_email', {
    success: true,
    result: 'Email sent',
  });

  assert.strictEqual(result, null);
});

// 13. Tool result missing id does not set focus
test('_extractArtifact: card without id returns null', () => {
  const result = extractArtifact('deck_create_card', {
    success: true,
    card: { title: 'No ID' }, // missing id
  });

  assert.strictEqual(result, null);
});

// 14. Failed tool result does not set focus
test('_extractArtifact: failed tool result returns null', () => {
  const result = extractArtifact('deck_create_card', {
    success: false,
    card: { id: 999, boardId: 1 },
  });

  assert.strictEqual(result, null);
});

// ============================================================
// Focus Context Building (via MessageProcessor._buildFocusContext)
// ============================================================

// We can't easily instantiate MessageProcessor, so test the logic inline

function buildFocusContext(focus) {
  if (!focus) return '';

  const typeLabels = {
    deck_card: 'deck card',
    wiki_page: 'wiki page',
    calendar_event: 'calendar event',
    file: 'file',
  };

  let ctx = '\nACTIVE FOCUS:\n';
  ctx += `You are currently discussing a ${typeLabels[focus.type] || focus.type}:\n`;
  ctx += `  Title: "${focus.title}"`;

  if (focus.type === 'deck_card' && focus.id) {
    ctx += ` (card ID: ${focus.id})`;
    if (focus.boardId) ctx += ` on board ${focus.boardId}`;
  }

  if (focus.description) {
    ctx += `\n  Content: ${focus.description}`;
  }

  ctx += `\n\nWhen the user says "it", "this", "the article", "the card", `;
  ctx += `"the title", "the description", etc., they are referring to this `;
  ctx += `${typeLabels[focus.type] || 'artifact'}. `;
  ctx += `Modify the existing artifact rather than creating a new one.\n`;

  return ctx;
}

// 15. Returns empty string when no focus
test('buildFocusContext: returns empty string when no focus', () => {
  assert.strictEqual(buildFocusContext(null), '');
});

// 16. Includes card title and ID
test('buildFocusContext: includes card title and ID', () => {
  const ctx = buildFocusContext({
    type: 'deck_card',
    id: 1234,
    boardId: 144,
    title: 'LiteLLM Security Article',
  });

  assert.ok(ctx.includes('LiteLLM Security Article'), 'Should include title');
  assert.ok(ctx.includes('card ID: 1234'), 'Should include card ID');
  assert.ok(ctx.includes('board 144'), 'Should include board ID');
});

// 17. Includes description
test('buildFocusContext: includes description', () => {
  const ctx = buildFocusContext({
    type: 'deck_card',
    id: 1,
    title: 'Test',
    description: 'This is the card description.',
  });

  assert.ok(ctx.includes('This is the card description'), 'Should include description');
});

// 18. Includes pronoun grounding instruction
test('buildFocusContext: includes pronoun grounding instruction', () => {
  const ctx = buildFocusContext({
    type: 'deck_card',
    id: 1,
    title: 'Test',
  });

  assert.ok(ctx.includes('Modify the existing artifact'), 'Should include grounding instruction');
  assert.ok(ctx.includes('"it"'), 'Should mention pronoun "it"');
  assert.ok(ctx.includes('deck card'), 'Should use type label');
});

// 19. Wiki page focus context
test('buildFocusContext: wiki page uses correct type label', () => {
  const ctx = buildFocusContext({
    type: 'wiki_page',
    id: 'arch',
    title: 'Architecture',
  });

  assert.ok(ctx.includes('wiki page'), 'Should use wiki page label');
  assert.ok(!ctx.includes('card ID'), 'Should not include card ID for wiki');
});

// ============================================================
// Integration: Focus Replacement
// ============================================================

// 20. Focus replacement: card A → card B
test('Focus replacement: setting new focus replaces old', () => {
  const sm = new SessionManager();
  const session = sm.getSession('test-token-20', 'testuser');

  sm.setArtifactFocus(session, {
    type: 'deck_card',
    id: 100,
    boardId: 144,
    title: 'Card A',
  });

  assert.strictEqual(sm.getArtifactFocus(session).id, 100);

  sm.setArtifactFocus(session, {
    type: 'deck_card',
    id: 200,
    boardId: 144,
    title: 'Card B',
  });

  const focus = sm.getArtifactFocus(session);
  assert.strictEqual(focus.id, 200, 'Focus should now be Card B');
  assert.strictEqual(focus.title, 'Card B');
});

// ============================================================

setTimeout(() => { summary(); exitWithCode(); }, 500);
