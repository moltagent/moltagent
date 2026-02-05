'use strict';

/**
 * Unit Tests for SessionPersister (Session 29b)
 *
 * Tests session persistence to wiki, trivial session skipping,
 * summary generation via LLM, and wiki write with correct frontmatter.
 *
 * Run: node test/unit/integrations/session-persister.test.js
 *
 * @module test/unit/integrations/session-persister
 */

const assert = require('assert');
const { asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const SessionPersister = require('../../../src/lib/integrations/session-persister');

// ============================================================
// Mock Factories
// ============================================================

function createMockWikiClient(overrides = {}) {
  return {
    writePageWithFrontmatter: overrides.writePageWithFrontmatter || async function (title, frontmatter, body) {
      this._lastWrite = { title, frontmatter, body };
      return `${title}.md`;
    },
    _lastWrite: null,
    ...overrides
  };
}

function createMockLLMRouter(overrides = {}) {
  return {
    route: overrides.route || async function () {
      return { content: '- Decision: approved budget\n- Action: schedule meeting\n- Fact: Q3 shortfall confirmed' };
    },
    ...overrides
  };
}

function createSession(overrides = {}) {
  const context = overrides.context || [
    { role: 'system', content: 'You are MoltAgent.', timestamp: Date.now() - 5000 },
    { role: 'user', content: 'What about the budget?', timestamp: Date.now() - 4000 },
    { role: 'assistant', content: 'The budget looks tight.', timestamp: Date.now() - 3000 },
    { role: 'user', content: 'Can we approve it?', timestamp: Date.now() - 2000 },
    { role: 'assistant', content: 'Yes, I recommend approval.', timestamp: Date.now() - 1000 },
    { role: 'user', content: 'Great, lets do it.', timestamp: Date.now() }
  ];

  return {
    id: 'test-session-id',
    roomToken: 'abc12345xyz',
    userId: 'fu',
    createdAt: Date.now() - 10000,
    lastActivityAt: Date.now(),
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
  console.log('\n=== SessionPersister Tests (Session 29b) ===\n');

  await asyncTest('TC-SP-001: Persists session with sufficient context', async () => {
    const wiki = createMockWikiClient();
    const router = createMockLLMRouter();
    const persister = new SessionPersister({ wikiClient: wiki, llmRouter: router });

    const session = createSession();
    const result = await persister.persistSession(session);

    assert.ok(result !== null, 'Should return page title');
    assert.ok(result.startsWith('Sessions/'), 'Page should be under Sessions/');
    assert.ok(result.includes('abc12345'), 'Page should include room token prefix');
  });

  await asyncTest('TC-SP-002: Skips trivial sessions (< 6 messages)', async () => {
    const wiki = createMockWikiClient();
    const router = createMockLLMRouter();
    const persister = new SessionPersister({ wikiClient: wiki, llmRouter: router });

    const session = createSession({
      context: [
        { role: 'user', content: 'Hi', timestamp: Date.now() },
        { role: 'assistant', content: 'Hello!', timestamp: Date.now() }
      ]
    });

    const result = await persister.persistSession(session);
    assert.strictEqual(result, null, 'Should skip trivial session');
  });

  await asyncTest('TC-SP-003: Skips sessions with too few user/assistant exchanges', async () => {
    const wiki = createMockWikiClient();
    const router = createMockLLMRouter();
    const persister = new SessionPersister({ wikiClient: wiki, llmRouter: router });

    // 6 entries total, but only 2 are user/assistant (< 4 threshold)
    const session = createSession({
      context: [
        { role: 'system', content: 'You are MoltAgent.', timestamp: Date.now() },
        { role: 'system', content: 'Context loaded.', timestamp: Date.now() },
        { role: 'system', content: 'Tools available.', timestamp: Date.now() },
        { role: 'system', content: 'Wiki loaded.', timestamp: Date.now() },
        { role: 'user', content: 'Hi', timestamp: Date.now() },
        { role: 'assistant', content: 'Hello!', timestamp: Date.now() }
      ]
    });

    const result = await persister.persistSession(session);
    assert.strictEqual(result, null, 'Should skip session with too few exchanges');
  });

  await asyncTest('TC-SP-004: Generates summary using LLM route()', async () => {
    let routeCalledWith = null;
    const router = createMockLLMRouter({
      route: async (request) => {
        routeCalledWith = request;
        return { content: '- Summary point 1\n- Summary point 2' };
      }
    });
    const wiki = createMockWikiClient();
    const persister = new SessionPersister({ wikiClient: wiki, llmRouter: router });

    const session = createSession();
    await persister.persistSession(session);

    assert.ok(routeCalledWith !== null, 'LLM router should have been called');
    assert.strictEqual(routeCalledWith.task, 'session_summary');
    assert.ok(routeCalledWith.content.includes('Summarize this conversation'), 'Prompt should ask for summary');
    assert.ok(routeCalledWith.requirements.role === 'sovereign', 'Should use sovereign role in requirements');
  });

  await asyncTest('TC-SP-005: Writes to wiki with correct frontmatter', async () => {
    const wiki = createMockWikiClient();
    const router = createMockLLMRouter();
    const persister = new SessionPersister({ wikiClient: wiki, llmRouter: router });

    const session = createSession();
    await persister.persistSession(session);

    assert.ok(wiki._lastWrite !== null, 'Wiki write should have been called');

    const { title, frontmatter, body } = wiki._lastWrite;

    // Title check
    assert.ok(title.startsWith('Sessions/'), 'Title should start with Sessions/');

    // Frontmatter checks
    assert.strictEqual(frontmatter.type, 'session');
    assert.strictEqual(frontmatter.room, session.roomToken);
    assert.strictEqual(frontmatter.user, session.userId);
    assert.strictEqual(frontmatter.messages, session.context.length);
    assert.strictEqual(frontmatter.decay_days, 90);
    assert.ok(frontmatter.created, 'Should have created date');
    assert.ok(frontmatter.expired, 'Should have expired date');

    // Body check
    assert.ok(body.includes('# Session Summary'), 'Body should have heading');
  });

  await asyncTest('TC-SP-006: Handles wiki write failure gracefully', async () => {
    const wiki = createMockWikiClient({
      writePageWithFrontmatter: async () => {
        throw new Error('WebDAV write failed: 503');
      }
    });
    const router = createMockLLMRouter();
    const persister = new SessionPersister({ wikiClient: wiki, llmRouter: router });

    const session = createSession();
    const result = await persister.persistSession(session);

    assert.strictEqual(result, null, 'Should return null on wiki failure');
  });

  await asyncTest('TC-SP-007: Handles LLM summary failure gracefully', async () => {
    const wiki = createMockWikiClient();
    const router = createMockLLMRouter({
      route: async () => {
        throw new Error('Ollama connection refused');
      }
    });
    const persister = new SessionPersister({ wikiClient: wiki, llmRouter: router });

    const session = createSession();
    const result = await persister.persistSession(session);

    assert.strictEqual(result, null, 'Should return null on LLM failure');
  });

  await asyncTest('TC-SP-008: Skips session with null context', async () => {
    const wiki = createMockWikiClient();
    const router = createMockLLMRouter();
    const persister = new SessionPersister({ wikiClient: wiki, llmRouter: router });

    const session = createSession({ context: null });
    const result = await persister.persistSession(session);

    assert.strictEqual(result, null, 'Should skip session with null context');
  });

  console.log('\n=== SessionPersister Tests Complete ===\n');
  summary();
  exitWithCode();
}

runTests();
