/*
 * Moltagent - Sovereign AI Security Layer
 * Copyright (C) 2026 Moltagent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 */

'use strict';
// Mock type: LEGACY — TODO: migrate to realistic mocks

/**
 * Unit Tests for SessionPersister v3
 *
 * Covers:
 *   - Session expiry event triggers persistSession (SessionManager integration)
 *   - Trivial sessions are skipped (< 6 messages, < 4 user/assistant exchanges)
 *   - Wiki write failure returns null
 *   - OCS-backed page creation (_writeSessionPage via full CollectivesClient API)
 *   - Sessions parent auto-created when missing
 *   - persistNow() public alias works correctly
 *   - _sessionsParentId cache is reused within TTL
 *
 * Run: node test/unit/integrations/session-persister-v3.test.js
 *
 * @module test/unit/integrations/session-persister-v3
 */

const assert = require('assert');
const { EventEmitter } = require('events');
const { asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const SessionPersister = require('../../../src/lib/integrations/session-persister');
const SessionManager = require('../../../src/security/session-manager');

// ============================================================
// Constants
// ============================================================

const STRUCTURED_SUMMARY =
  '## Summary\n- Did stuff\n\n## Continuation\nContinue stuff.\n\n## Open Items\nNone';

// ============================================================
// Mock Factories
// ============================================================

/**
 * Minimal wiki client: only has writePageWithFrontmatter.
 * Tests that use this will exercise the fallback path.
 */
function createMinimalWikiClient(overrides = {}) {
  const client = {
    _calls: [],
    writePageWithFrontmatter: async function (title, frontmatter, body) {
      this._calls.push({ method: 'writePageWithFrontmatter', title, frontmatter, body });
      return `${title}.md`;
    },
    ...overrides
  };
  return client;
}

/**
 * Full OCS wiki client stub: exposes resolveCollective, listPages, createPage,
 * writePageContent. Models a Nextcloud Collectives instance where Sessions/ does
 * not yet exist.
 *
 * @param {Object} opts
 * @param {Array}  [opts.pages=[]]        - Pre-existing pages from listPages()
 * @param {Object} [opts.createPageResult] - What createPage() returns
 * @param {Function} [opts.writePageContent] - Override writePageContent
 * @param {Function} [opts.writePageWithFrontmatter] - Override writePageWithFrontmatter
 */
function createOcsWikiClient(opts = {}) {
  const { pages = [], writePageContentFn, overrides = {} } = opts;

  const nextPageId = { value: 100 };
  const createdPages = [];

  const client = {
    _calls: [],

    async resolveCollective() {
      this._calls.push({ method: 'resolveCollective' });
      return 1;
    },

    async listPages(collectiveId) {
      this._calls.push({ method: 'listPages', collectiveId });
      // Return base pages plus any pages created via createPage()
      return [...pages, ...createdPages];
    },

    async ensureSection(collectiveId, sectionName) {
      const existing = [...pages, ...createdPages].find(p => (p.title || '').toLowerCase() === sectionName.toLowerCase());
      if (existing) {
        this._calls.push({ method: 'ensureSection', collectiveId, sectionName, result: existing });
        return existing;
      }
      const page = await this.createPage(collectiveId, 0, sectionName);
      this._calls.push({ method: 'ensureSection', collectiveId, sectionName, result: page });
      return page;
    },

    async createPage(collectiveId, parentId, title) {
      const id = nextPageId.value++;
      const page = { id, collectiveId, parentId, title, fileName: `${title}.md`, filePath: '' };
      createdPages.push(page);
      this._calls.push({ method: 'createPage', collectiveId, parentId, title, result: page });
      if (opts.createPageResult) return opts.createPageResult;
      return page;
    },

    async writePageContent(pagePath, content) {
      this._calls.push({ method: 'writePageContent', pagePath, content });
      if (writePageContentFn) return writePageContentFn(pagePath, content);
    },

    async writePageWithFrontmatter(title, frontmatter, body) {
      this._calls.push({ method: 'writePageWithFrontmatter', title, frontmatter, body });
      return `${title}.md`;
    },

    ...overrides
  };
  return client;
}

function createMockLLMRouter(overrides = {}) {
  return {
    route: overrides.route || async function () {
      return { result: STRUCTURED_SUMMARY };
    },
    ...overrides
  };
}

function createSession(overrides = {}) {
  const context = overrides.context !== undefined ? overrides.context : [
    { role: 'user',      content: 'What is the plan?',           timestamp: Date.now() - 8000 },
    { role: 'assistant', content: 'The plan is to proceed.',      timestamp: Date.now() - 7000 },
    { role: 'user',      content: 'What about the budget?',       timestamp: Date.now() - 6000 },
    { role: 'assistant', content: 'Budget looks manageable.',     timestamp: Date.now() - 5000 },
    { role: 'user',      content: 'Can we approve it?',           timestamp: Date.now() - 4000 },
    { role: 'assistant', content: 'Yes, I recommend approval.',   timestamp: Date.now() - 3000 },
    { role: 'user',      content: 'What are the next steps?',     timestamp: Date.now() - 2000 },
    { role: 'assistant', content: 'Schedule a follow-up meeting.', timestamp: Date.now() - 1000 },
  ];

  return {
    id: 'test-session-v3',
    roomToken: 'room1234xyz',
    userId: 'user1',
    roomName: 'TestRoom',
    createdAt: Date.now() - 3600000,
    lastActivityAt: Date.now() - 100,
    context,
    credentialsAccessed: new Set(),
    pendingApprovals: new Map(),
    grantedApprovals: new Map(),
    ...overrides
  };
}

// ============================================================
// Tests
// ============================================================

async function runTests() {
  console.log('\n=== SessionPersister v3 Tests ===\n');

  // ----------------------------------------------------------
  // Integration: SessionManager emits sessionExpired → persists
  // ----------------------------------------------------------

  await asyncTest('TC-SP3-001: SessionManager sessionExpired event triggers persistSession', async () => {
    const wiki = createMinimalWikiClient();
    const router = createMockLLMRouter();
    const persister = new SessionPersister({ wikiClient: wiki, llmRouter: router });

    const manager = new SessionManager({ sessionTimeoutMs: 1 }); // 1ms timeout

    let persistedPage = null;
    manager.on('sessionExpired', async (session) => {
      persistedPage = await persister.persistSession(session);
    });

    // Create a session with a rich context
    const session = manager.getSession('room-abc', 'user1');
    const richContext = [
      { role: 'user',      content: 'Hello',             timestamp: Date.now() - 8000 },
      { role: 'assistant', content: 'Hi there',           timestamp: Date.now() - 7000 },
      { role: 'user',      content: 'Budget question',    timestamp: Date.now() - 6000 },
      { role: 'assistant', content: 'Budget is fine.',    timestamp: Date.now() - 5000 },
      { role: 'user',      content: 'Anything else?',     timestamp: Date.now() - 4000 },
      { role: 'assistant', content: 'No, all done.',      timestamp: Date.now() - 3000 },
      { role: 'user',      content: 'Perfect.',           timestamp: Date.now() - 2000 },
      { role: 'assistant', content: 'Great talking.',     timestamp: Date.now() - 1000 },
    ];
    session.context = richContext;

    // Wait for session to expire, then trigger cleanup
    await new Promise(resolve => setTimeout(resolve, 10));
    manager.cleanup();

    // Allow async persist to complete
    await new Promise(resolve => setTimeout(resolve, 50));

    assert.ok(persistedPage !== null, 'persistedPage should not be null after sessionExpired');
    assert.ok(persistedPage.startsWith('Sessions/'), `Page should be under Sessions/, got: ${persistedPage}`);
  });

  // ----------------------------------------------------------
  // Trivial session skipping
  // ----------------------------------------------------------

  await asyncTest('TC-SP3-002: Trivial session (< 6 messages) is skipped', async () => {
    const wiki = createMinimalWikiClient();
    const router = createMockLLMRouter();
    const persister = new SessionPersister({ wikiClient: wiki, llmRouter: router });

    const session = createSession({
      context: [
        { role: 'user', content: 'Hi', timestamp: Date.now() - 1000 },
        { role: 'assistant', content: 'Hello!', timestamp: Date.now() }
      ]
    });

    const result = await persister.persistSession(session);
    assert.strictEqual(result, null, 'Should return null for trivial session');
    assert.strictEqual(wiki._calls.length, 0, 'Wiki should not be called for trivial sessions');
  });

  await asyncTest('TC-SP3-003: Session with 6 messages but < 4 user/assistant is skipped', async () => {
    const wiki = createMinimalWikiClient();
    const router = createMockLLMRouter();
    const persister = new SessionPersister({ wikiClient: wiki, llmRouter: router });

    const session = createSession({
      context: [
        { role: 'system', content: 'You are Moltagent.', timestamp: Date.now() - 5000 },
        { role: 'system', content: 'Context loaded.',    timestamp: Date.now() - 4000 },
        { role: 'system', content: 'Tools available.',   timestamp: Date.now() - 3000 },
        { role: 'system', content: 'Wiki loaded.',       timestamp: Date.now() - 2000 },
        { role: 'user',   content: 'Hi',                 timestamp: Date.now() - 1000 },
        { role: 'assistant', content: 'Hello!',          timestamp: Date.now() }
      ]
    });

    const result = await persister.persistSession(session);
    assert.strictEqual(result, null, 'Should skip when fewer than 4 user/assistant messages');
  });

  await asyncTest('TC-SP3-004: Null context is skipped gracefully', async () => {
    const wiki = createMinimalWikiClient();
    const router = createMockLLMRouter();
    const persister = new SessionPersister({ wikiClient: wiki, llmRouter: router });

    const result = await persister.persistSession(createSession({ context: null }));
    assert.strictEqual(result, null, 'Should return null for null context');
  });

  // ----------------------------------------------------------
  // Wiki write failure
  // ----------------------------------------------------------

  await asyncTest('TC-SP3-005: Wiki write failure returns null and clears lastSummary', async () => {
    const wiki = createMinimalWikiClient({
      writePageWithFrontmatter: async () => {
        throw new Error('WebDAV 503 Service Unavailable');
      }
    });
    const router = createMockLLMRouter();
    const persister = new SessionPersister({ wikiClient: wiki, llmRouter: router });

    const session = createSession();
    const result = await persister.persistSession(session);

    assert.strictEqual(result, null, 'Should return null on wiki write failure');
    assert.strictEqual(persister.lastSummary, null, 'lastSummary should remain null after failed write');
  });

  await asyncTest('TC-SP3-006: OCS wiki write failure (writePageContent throws) returns null', async () => {
    const wiki = createOcsWikiClient({
      writePageContentFn: async () => {
        throw new Error('WebDAV 409 Conflict');
      }
    });
    const router = createMockLLMRouter();
    const persister = new SessionPersister({ wikiClient: wiki, llmRouter: router });

    const session = createSession();
    const result = await persister.persistSession(session);

    assert.strictEqual(result, null, 'Should return null when OCS writePageContent throws');
    assert.strictEqual(persister.lastSummary, null, 'lastSummary should remain null');
  });

  // ----------------------------------------------------------
  // OCS page creation path
  // ----------------------------------------------------------

  await asyncTest('TC-SP3-007: Creates Sessions parent page when it does not exist', async () => {
    // No pre-existing pages — Sessions/ must be created
    const wiki = createOcsWikiClient({ pages: [] });
    const router = createMockLLMRouter();
    const persister = new SessionPersister({ wikiClient: wiki, llmRouter: router });

    const session = createSession();
    const result = await persister.persistSession(session);

    assert.ok(result !== null, 'Should succeed and return page title');
    assert.ok(result.startsWith('Sessions/'), `Page title should start with Sessions/, got: ${result}`);

    // createPage should have been called at least twice:
    // once for Sessions parent, once for the leaf session page
    const createPageCalls = wiki._calls.filter(c => c.method === 'createPage');
    assert.ok(createPageCalls.length >= 2, `Expected at least 2 createPage calls, got ${createPageCalls.length}`);

    const sessionsCreate = createPageCalls[0];
    assert.strictEqual(sessionsCreate.title, 'Sessions', 'First createPage should create "Sessions" parent');
  });

  await asyncTest('TC-SP3-008: Reuses existing Sessions parent page (no duplicate creation)', async () => {
    // Pre-populate with a Sessions page at root level
    const sessionsPage = { id: 42, parentId: 0, title: 'Sessions', fileName: 'Sessions.md', filePath: '' };
    const wiki = createOcsWikiClient({ pages: [sessionsPage] });
    const router = createMockLLMRouter();
    const persister = new SessionPersister({ wikiClient: wiki, llmRouter: router });

    await persister.persistSession(createSession());

    const createPageCalls = wiki._calls.filter(c => c.method === 'createPage');
    // Only one createPage call — for the leaf session page, not for Sessions
    assert.strictEqual(createPageCalls.length, 1, 'Should create only the leaf page, not a duplicate Sessions parent');
    assert.notStrictEqual(createPageCalls[0].title, 'Sessions', 'Should not re-create the Sessions parent');
  });

  await asyncTest('TC-SP3-009: _sessionsParentId is cached and reused within TTL', async () => {
    const sessionsPage = { id: 55, parentId: 0, title: 'Sessions', fileName: 'Sessions.md', filePath: '' };
    const wiki = createOcsWikiClient({ pages: [sessionsPage] });
    const router = createMockLLMRouter();
    const persister = new SessionPersister({ wikiClient: wiki, llmRouter: router });

    // First persist — populates cache
    await persister.persistSession(createSession());
    const resolveCallCount1 = wiki._calls.filter(c => c.method === 'resolveCollective').length;

    // Second persist — should hit cache for Sessions parent lookup
    await persister.persistSession(createSession());
    const resolveCallCount2 = wiki._calls.filter(c => c.method === 'resolveCollective').length;

    // Second call still resolves collective (for createPage call), but listPages
    // for the parent lookup should not be called again beyond the 1 needed for leaf page check
    assert.ok(resolveCallCount2 > resolveCallCount1, 'resolveCollective may be called again for leaf page creation');
    assert.strictEqual(
      persister._sessionsParentId,
      55,
      'Cached sessionsParentId should be 55'
    );
  });

  await asyncTest('TC-SP3-010: Writes content with frontmatter serialized correctly', async () => {
    const contentWritten = [];
    const wiki = createOcsWikiClient({
      writePageContentFn: async (pagePath, content) => {
        contentWritten.push({ pagePath, content });
      }
    });
    const router = createMockLLMRouter();
    const persister = new SessionPersister({ wikiClient: wiki, llmRouter: router });

    const session = createSession();
    await persister.persistSession(session);

    // The session page content write (not the Sessions stub) should contain frontmatter
    const sessionPageWrite = contentWritten.find(w => w.content.includes('session_transcript'));
    assert.ok(sessionPageWrite, 'Should write content with session_transcript frontmatter');
    assert.ok(sessionPageWrite.content.includes('---'), 'Content should contain YAML frontmatter delimiters');
    assert.ok(sessionPageWrite.content.includes('decay_days'), 'Frontmatter should include decay_days');
  });

  // ----------------------------------------------------------
  // persistNow
  // ----------------------------------------------------------

  await asyncTest('TC-SP3-011: persistNow() is a public alias for persistSession()', async () => {
    const wiki = createMinimalWikiClient();
    const router = createMockLLMRouter();
    const persister = new SessionPersister({ wikiClient: wiki, llmRouter: router });

    const session = createSession();
    const result = await persister.persistNow(session);

    assert.ok(result !== null, 'persistNow should return page title for a valid session');
    assert.ok(result.startsWith('Sessions/'), `Page title should start with Sessions/, got: ${result}`);
  });

  await asyncTest('TC-SP3-012: persistNow() returns null for trivial session', async () => {
    const wiki = createMinimalWikiClient();
    const router = createMockLLMRouter();
    const persister = new SessionPersister({ wikiClient: wiki, llmRouter: router });

    const result = await persister.persistNow(createSession({ context: [] }));
    assert.strictEqual(result, null, 'persistNow should return null for trivial session');
  });

  // ----------------------------------------------------------
  // LLM failure
  // ----------------------------------------------------------

  await asyncTest('TC-SP3-013: LLM summary failure skips wiki write and returns null', async () => {
    const wiki = createOcsWikiClient();
    const router = createMockLLMRouter({
      route: async () => { throw new Error('Ollama connection refused'); }
    });
    const persister = new SessionPersister({ wikiClient: wiki, llmRouter: router });

    const session = createSession();
    const result = await persister.persistSession(session);

    assert.strictEqual(result, null, 'Should return null when LLM fails');
    const writeContentCalls = wiki._calls.filter(c => c.method === 'writePageContent');
    // The Sessions stub might still be written if parent was created; the session page should NOT be written
    const sessionPageWrite = writeContentCalls.find(c => c.content && c.content.includes('session_transcript'));
    assert.ok(!sessionPageWrite, 'Session page content should not be written when LLM fails');
  });

  // ----------------------------------------------------------
  // Fallback path: minimal mock without OCS API
  // ----------------------------------------------------------

  await asyncTest('TC-SP3-014: Falls back to writePageWithFrontmatter when OCS API absent', async () => {
    // Minimal mock has only writePageWithFrontmatter (no resolveCollective etc.)
    const wiki = createMinimalWikiClient();
    const router = createMockLLMRouter();
    const persister = new SessionPersister({ wikiClient: wiki, llmRouter: router });

    const session = createSession();
    const result = await persister.persistSession(session);

    assert.ok(result !== null, 'Should succeed using fallback path');
    const call = wiki._calls.find(c => c.method === 'writePageWithFrontmatter');
    assert.ok(call, 'writePageWithFrontmatter should have been called as fallback');
    assert.ok(call.title.startsWith('Sessions/'), `Title should start with Sessions/, got: ${call.title}`);
  });

  // ----------------------------------------------------------
  // Summary quality: captures key topics, not just last message
  // ----------------------------------------------------------

  await asyncTest('TC-SP3-015: Summary prompt includes full transcript, not just last message', async () => {
    let promptContent = null;
    const wiki = createMinimalWikiClient();
    const router = {
      route: async ({ content }) => {
        promptContent = content;
        return { result: STRUCTURED_SUMMARY };
      }
    };
    const persister = new SessionPersister({ wikiClient: wiki, llmRouter: router });

    const session = createSession();
    await persister.persistSession(session);

    assert.ok(promptContent, 'Router should have been called with content');
    // The transcript should include messages from the beginning, not just the last one
    assert.ok(promptContent.includes('plan'), 'Transcript should include early message about "plan"');
    assert.ok(promptContent.includes('budget'), 'Transcript should include middle message about "budget"');
    assert.ok(promptContent.includes('next steps'), 'Transcript should include later message about "next steps"');
  });

  // ----------------------------------------------------------
  // getAllSessions: used by graceful shutdown
  // ----------------------------------------------------------

  await asyncTest('TC-SP3-016: SessionManager.getAllSessions() returns all active sessions', async () => {
    const manager = new SessionManager();
    const s1 = manager.getSession('room-a', 'user1');
    const s2 = manager.getSession('room-b', 'user2');

    const all = manager.getAllSessions();
    assert.strictEqual(all.length, 2, `Expected 2 sessions, got ${all.length}`);
    assert.ok(all.includes(s1), 'Should include first session');
    assert.ok(all.includes(s2), 'Should include second session');
  });

  // ----------------------------------------------------------
  // Frontmatter includes required fields
  // ----------------------------------------------------------

  await asyncTest('TC-SP3-017: Page frontmatter includes room, user, dates, decay_days', async () => {
    const wiki = createMinimalWikiClient();
    const router = createMockLLMRouter();
    const persister = new SessionPersister({ wikiClient: wiki, llmRouter: router });

    const session = createSession();
    await persister.persistSession(session);

    const call = wiki._calls.find(c => c.method === 'writePageWithFrontmatter');
    assert.ok(call, 'writePageWithFrontmatter should have been called');
    const fm = call.frontmatter;
    assert.strictEqual(fm.type, 'session_transcript', 'type should be session_transcript');
    assert.strictEqual(fm.room, 'room1234xyz', 'room should match session roomToken');
    assert.strictEqual(fm.user, 'user1', 'user should match session userId');
    assert.strictEqual(fm.decay_days, 90, 'decay_days should be 90');
    assert.ok(fm.created, 'created should be set');
    assert.ok(fm.expired, 'expired should be set');
    assert.ok(fm.messages > 0, 'messages count should be > 0');
  });

  console.log('\n=== SessionPersister v3 Tests Complete ===\n');
  summary();
  exitWithCode();
}

runTests();
