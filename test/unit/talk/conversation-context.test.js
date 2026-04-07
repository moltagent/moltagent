/**
 * ConversationContext Unit Tests
 *
 * Comprehensive test suite for the ConversationContext class.
 *
 * Run: node test/unit/talk/conversation-context.test.js
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const { ConversationContext } = require('../../../src/lib/talk/conversation-context');

// ============================================================
// Mock Helpers
// ============================================================

function createMockNC(messages = []) {
  return {
    ncUrl: 'https://cloud.example.com',
    ncUser: 'moltagent',
    request: async (path, options) => ({
      status: 200,
      body: {
        ocs: {
          data: messages
        }
      }
    })
  };
}

function makeMessage(id, actorId, displayName, message, timestamp, systemMessage = '') {
  return {
    id,
    actorType: 'users',
    actorId,
    actorDisplayName: displayName,
    message,
    timestamp,
    messageType: 'comment',
    systemMessage
  };
}

// ============================================================
// Test Suites
// ============================================================

console.log('\n=== ConversationContext Tests ===\n');

// --- Constructor Tests ---
console.log('\n--- Constructor Tests ---\n');

test('TC-CC-001: Constructor stores config and nc reference', () => {
  const config = { enabled: true, maxMessages: 10 };
  const nc = createMockNC();
  const ctx = new ConversationContext(config, nc);

  assert.strictEqual(ctx.config, config);
  assert.strictEqual(ctx.nc, nc);
  assert.strictEqual(ctx.enabled, true);
});

test('TC-CC-002: Returns empty array when disabled', async () => {
  const ctx = new ConversationContext({ enabled: false }, createMockNC());
  const result = await ctx.getHistory('room-token');
  assert.deepStrictEqual(result, []);
});

// --- getHistory Tests ---
console.log('\n--- getHistory Tests ---\n');

asyncTest('TC-CC-010: getHistory calls Talk API with correct URL', async () => {
  let calledPath = null;
  const nc = {
    ncUrl: 'https://cloud.example.com',
    ncUser: 'moltagent',
    request: async (path, options) => {
      calledPath = path;
      return { status: 200, body: { ocs: { data: [] } } };
    }
  };

  const ctx = new ConversationContext({
    enabled: true, maxMessages: 15, maxTokenEstimate: 2000, maxMessageAge: 3600000
  }, nc);

  await ctx.getHistory('room-xyz');

  assert.ok(calledPath.includes('/ocs/v2.php/apps/spreed/api/v1/chat/room-xyz'));
  assert.ok(calledPath.includes('limit=15'));
  assert.ok(calledPath.includes('lookIntoFuture=0'));
});

asyncTest('TC-CC-011: getHistory returns chronological messages', async () => {
  const now = Math.floor(Date.now() / 1000);
  const nc = createMockNC([
    // Talk API returns newest-first
    makeMessage(3, 'moltagent', 'MoltAgent', 'Task Board Summary:\nInbox: 1', now - 5),
    makeMessage(2, 'jordan', 'Jordan', 'Do I have open tasks?', now - 10),
    makeMessage(1, 'jordan', 'Jordan', 'Hello', now - 60),
  ]);

  const ctx = new ConversationContext({
    enabled: true,
    maxMessages: 20,
    maxTokenEstimate: 2000,
    maxMessageAge: 3600000
  }, nc);

  const history = await ctx.getHistory('room-abc');

  // Should be chronological (oldest first)
  assert.strictEqual(history.length, 3);
  assert.strictEqual(history[0].content, 'Hello');
  assert.strictEqual(history[0].role, 'user');
  assert.strictEqual(history[0].name, 'Jordan');
  assert.strictEqual(history[1].content, 'Do I have open tasks?');
  assert.strictEqual(history[2].content, 'Task Board Summary:\nInbox: 1');
  assert.strictEqual(history[2].role, 'assistant');
});

asyncTest('TC-CC-012: getHistory filters system messages', async () => {
  const now = Math.floor(Date.now() / 1000);
  const nc = createMockNC([
    makeMessage(3, 'jordan', 'Jordan', 'Hello', now - 5),
    makeMessage(2, '', '', 'Jordan joined the conversation', now - 10, 'user_added'),
    makeMessage(1, 'jordan', 'Jordan', 'Hey', now - 15),
  ]);

  const ctx = new ConversationContext({
    enabled: true, maxMessages: 20, maxTokenEstimate: 2000, maxMessageAge: 3600000
  }, nc);

  const history = await ctx.getHistory('room-abc');
  assert.strictEqual(history.length, 2);
  assert.ok(history.every(m => m.content !== 'Jordan joined the conversation'));
});

asyncTest('TC-CC-013: getHistory excludes specified message ID', async () => {
  const now = Math.floor(Date.now() / 1000);
  const nc = createMockNC([
    makeMessage(3, 'jordan', 'Jordan', 'This is the trigger', now - 5),
    makeMessage(2, 'moltagent', 'MoltAgent', 'Previous response', now - 10),
  ]);

  const ctx = new ConversationContext({
    enabled: true, maxMessages: 20, maxTokenEstimate: 2000, maxMessageAge: 3600000
  }, nc);

  const history = await ctx.getHistory('room-abc', { excludeMessageId: 3 });
  assert.strictEqual(history.length, 1);
  assert.strictEqual(history[0].content, 'Previous response');
});

asyncTest('TC-CC-014: getHistory filters messages older than maxAge', async () => {
  const now = Math.floor(Date.now() / 1000);
  const nc = createMockNC([
    makeMessage(2, 'jordan', 'Jordan', 'Recent', now - 60),
    makeMessage(1, 'jordan', 'Jordan', 'Very old', now - 7200),  // 2 hours ago
  ]);

  const ctx = new ConversationContext({
    enabled: true, maxMessages: 20, maxTokenEstimate: 2000,
    maxMessageAge: 3600000  // 1 hour
  }, nc);

  const history = await ctx.getHistory('room-abc');
  assert.strictEqual(history.length, 1);
  assert.strictEqual(history[0].content, 'Recent');
});

asyncTest('TC-CC-015: getHistory trims to token budget (keeps most recent)', async () => {
  const now = Math.floor(Date.now() / 1000);
  const longMessage = 'A'.repeat(5000);  // ~1250 tokens
  const nc = createMockNC([
    makeMessage(3, 'jordan', 'Jordan', 'Most recent', now - 5),
    makeMessage(2, 'jordan', 'Jordan', longMessage, now - 10),
    makeMessage(1, 'jordan', 'Jordan', 'Oldest', now - 15),
  ]);

  const ctx = new ConversationContext({
    enabled: true, maxMessages: 20,
    maxTokenEstimate: 500,  // Very small budget
    maxMessageAge: 3600000
  }, nc);

  const history = await ctx.getHistory('room-abc');
  // Should keep most recent messages that fit
  assert.ok(history.length < 3);
  assert.strictEqual(history[history.length - 1].content, 'Most recent');
});

asyncTest('TC-CC-016: getHistory maps actorId to role correctly', async () => {
  const now = Math.floor(Date.now() / 1000);
  const nc = createMockNC([
    makeMessage(2, 'moltagent', 'MoltAgent', 'I am the assistant', now - 5),
    makeMessage(1, 'jordan', 'Jordan', 'I am the user', now - 10),
  ]);

  const ctx = new ConversationContext({
    enabled: true, maxMessages: 20, maxTokenEstimate: 2000, maxMessageAge: 3600000
  }, nc);

  const history = await ctx.getHistory('room-abc');
  assert.strictEqual(history.length, 2);
  assert.strictEqual(history[0].role, 'user');
  assert.strictEqual(history[0].name, 'Jordan');
  assert.strictEqual(history[1].role, 'assistant');
  assert.strictEqual(history[1].name, 'MoltAgent');
});

// --- formatForPrompt Tests ---
console.log('\n--- formatForPrompt Tests ---\n');

test('TC-CC-020: formatForPrompt produces conversation_history block', () => {
  const ctx = new ConversationContext({ enabled: true }, createMockNC());

  const history = [
    { role: 'user', name: 'Jordan', content: 'Do I have tasks?', timestamp: 100 },
    { role: 'assistant', name: 'MoltAgent', content: 'Yes, 4 open tasks.', timestamp: 101 },
    { role: 'user', name: 'Jordan', content: 'Close the first one', timestamp: 102 },
  ];

  const formatted = ctx.formatForPrompt(history);

  assert.ok(formatted.includes('<conversation_history>'));
  assert.ok(formatted.includes('Jordan: Do I have tasks?'));
  assert.ok(formatted.includes('Moltagent: Yes, 4 open tasks.'));
  assert.ok(formatted.includes('Jordan: Close the first one'));
  assert.ok(formatted.includes('</conversation_history>'));
});

test('TC-CC-021: formatForPrompt returns empty string for empty history', () => {
  const ctx = new ConversationContext({ enabled: true }, createMockNC());
  assert.strictEqual(ctx.formatForPrompt([]), '');
});

test('TC-CC-022: formatForPrompt returns empty string for null', () => {
  const ctx = new ConversationContext({ enabled: true }, createMockNC());
  assert.strictEqual(ctx.formatForPrompt(null), '');
});

// --- Error Handling Tests ---
console.log('\n--- Error Handling Tests ---\n');

asyncTest('TC-CC-030: getHistory returns empty array on API error', async () => {
  const nc = {
    ncUrl: 'https://cloud.example.com',
    ncUser: 'moltagent',
    request: async () => {
      throw new Error('Network timeout');
    }
  };

  const ctx = new ConversationContext({
    enabled: true, maxMessages: 20, maxTokenEstimate: 2000, maxMessageAge: 3600000
  }, nc);

  const history = await ctx.getHistory('room-abc');
  assert.deepStrictEqual(history, []);
});

asyncTest('TC-CC-031: getHistory returns empty array on malformed response', async () => {
  const nc = {
    ncUrl: 'https://cloud.example.com',
    ncUser: 'moltagent',
    request: async () => ({
      status: 200,
      body: { malformed: 'data' }  // Missing ocs.data
    })
  };

  const ctx = new ConversationContext({
    enabled: true, maxMessages: 20, maxTokenEstimate: 2000, maxMessageAge: 3600000
  }, nc);

  const history = await ctx.getHistory('room-abc');
  assert.deepStrictEqual(history, []);
});

// ============================================================
// Summary and Exit
// ============================================================

setTimeout(() => {
  summary();
  exitWithCode();
}, 100);
