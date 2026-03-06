'use strict';

/**
 * Unit Tests for SessionPersister v2 (Enhanced prompt + frontmatter changes)
 *
 * Tests the updated session-persister that uses structured LLM prompt sections,
 * session_transcript frontmatter type, room_name field, raw body (no heading),
 * and lastSummary tracking.
 *
 * Run: node test/unit/integrations/session-persister-v2.test.js
 *
 * @module test/unit/integrations/session-persister-v2
 */

const assert = require('assert');
const { asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const SessionPersister = require('../../../src/lib/integrations/session-persister');

// ============================================================
// Mock Factories
// ============================================================

/**
 * The enhanced LLM response includes all three structured sections.
 */
const STRUCTURED_SUMMARY =
  '## Summary\n- Did stuff\n\n## Continuation\nContinue stuff.\n\n## Open Items\nNone';

function createMockWikiClient(overrides = {}) {
  const client = {
    _lastWrite: null,
    writePageWithFrontmatter: overrides.writePageWithFrontmatter || async function (title, frontmatter, body) {
      this._lastWrite = { title, frontmatter, body };
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

/**
 * Session with at least 8 messages (alternating user/assistant) and a roomName.
 */
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
    id: 'test-session-v2',
    roomToken: 'abc12345xyz',
    userId: 'user1',
    roomName: 'TestRoom',
    createdAt: Date.now() - 86400000,
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
  console.log('\n=== SessionPersister v2 Tests ===\n');

  // TC-SPV2-001: Enhanced prompt requests structured sections
  await asyncTest('TC-SPV2-001: Enhanced prompt requests structured sections', async () => {
    let capturedRequest = null;
    const router = createMockLLMRouter({
      route: async (request) => {
        capturedRequest = request;
        return { result: STRUCTURED_SUMMARY };
      }
    });
    const wiki = createMockWikiClient();
    const persister = new SessionPersister({ wikiClient: wiki, llmRouter: router });

    const session = createSession();
    await persister.persistSession(session);

    assert.ok(capturedRequest !== null, 'router.route() should have been called');
    assert.ok(
      capturedRequest.content.includes('## Summary'),
      'Prompt should include ## Summary section marker'
    );
    assert.ok(
      capturedRequest.content.includes('## Continuation'),
      'Prompt should include ## Continuation section marker'
    );
    assert.ok(
      capturedRequest.content.includes('## Open Items'),
      'Prompt should include ## Open Items section marker'
    );
  });

  // TC-SPV2-002: Frontmatter uses type session_transcript
  await asyncTest('TC-SPV2-002: Frontmatter uses type session_transcript', async () => {
    const wiki = createMockWikiClient();
    const router = createMockLLMRouter();
    const persister = new SessionPersister({ wikiClient: wiki, llmRouter: router });

    const session = createSession();
    await persister.persistSession(session);

    assert.ok(wiki._lastWrite !== null, 'Wiki write should have been called');
    assert.strictEqual(
      wiki._lastWrite.frontmatter.type,
      'session_transcript',
      'frontmatter.type should be session_transcript'
    );
  });

  // TC-SPV2-003: Frontmatter includes room_name field
  await asyncTest('TC-SPV2-003: Frontmatter includes room_name field', async () => {
    const wiki = createMockWikiClient();
    const router = createMockLLMRouter();
    const persister = new SessionPersister({ wikiClient: wiki, llmRouter: router });

    const session = createSession();
    await persister.persistSession(session);

    assert.ok(wiki._lastWrite !== null, 'Wiki write should have been called');
    assert.ok(
      Object.prototype.hasOwnProperty.call(wiki._lastWrite.frontmatter, 'room_name'),
      'frontmatter should have a room_name field (may be null)'
    );
    // Value should be the session roomName or null — both are acceptable
    const roomName = wiki._lastWrite.frontmatter.room_name;
    assert.ok(
      roomName === 'TestRoom' || roomName === null,
      `room_name should be 'TestRoom' or null, got: ${roomName}`
    );
  });

  // TC-SPV2-004: Body does not duplicate heading
  await asyncTest('TC-SPV2-004: Body does not duplicate heading', async () => {
    const wiki = createMockWikiClient();
    const router = createMockLLMRouter();
    const persister = new SessionPersister({ wikiClient: wiki, llmRouter: router });

    const session = createSession();
    await persister.persistSession(session);

    assert.ok(wiki._lastWrite !== null, 'Wiki write should have been called');
    const body = wiki._lastWrite.body;
    assert.ok(
      !body.startsWith('# Session Summary'),
      'Body should NOT start with "# Session Summary" heading'
    );
  });

  // TC-SPV2-005: lastSummary is stored after persistence
  await asyncTest('TC-SPV2-005: lastSummary is stored after persistence', async () => {
    const wiki = createMockWikiClient();
    const router = createMockLLMRouter();
    const persister = new SessionPersister({ wikiClient: wiki, llmRouter: router });

    // lastSummary starts null
    assert.strictEqual(persister.lastSummary, null, 'lastSummary should start as null');

    const session = createSession();
    await persister.persistSession(session);

    assert.ok(
      persister.lastSummary !== null,
      'lastSummary should be set after successful persistence'
    );
    assert.ok(
      typeof persister.lastSummary === 'string',
      'lastSummary should be a string'
    );
    assert.ok(
      persister.lastSummary.length > 0,
      'lastSummary should not be empty'
    );
  });

  // TC-SPV2-006: lastSummary is null when session is skipped
  await asyncTest('TC-SPV2-006: lastSummary is null when session is skipped', async () => {
    const wiki = createMockWikiClient();
    const router = createMockLLMRouter();
    const persister = new SessionPersister({ wikiClient: wiki, llmRouter: router });

    // Trivial session: fewer than 6 messages
    const session = createSession({
      context: [
        { role: 'user',      content: 'Hello', timestamp: Date.now() - 1000 },
        { role: 'assistant', content: 'Hi!',   timestamp: Date.now() }
      ]
    });

    const result = await persister.persistSession(session);

    assert.strictEqual(result, null, 'persistSession should return null for trivial session');
    assert.strictEqual(
      persister.lastSummary,
      null,
      'lastSummary should remain null after a skipped session'
    );
  });

  console.log('\n=== SessionPersister v2 Tests Complete ===\n');
  summary();
  exitWithCode();
}

runTests();
