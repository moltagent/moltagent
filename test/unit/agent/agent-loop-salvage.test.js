/**
 * AgentLoop — Graceful Degradation: Salvage Successful Tool Results
 *
 * Tests that when an LLM call fails after tools have already executed
 * successfully, the tool results are salvaged and returned to the user
 * instead of a generic error message.
 *
 * Run: node test/unit/agent/agent-loop-salvage.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

const { AgentLoop } = require('../../../src/lib/agent/agent-loop');

// ============================================================
// Helpers
// ============================================================

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {}
};

/**
 * Create a mock LLM provider that returns responses in sequence.
 * If a response is an Error instance, the chat() call throws it.
 */
function createMockProvider(responses) {
  let callIndex = 0;
  return {
    chat: async () => {
      const resp = responses[callIndex++];
      if (resp instanceof Error) throw resp;
      return resp;
    },
    _getCallCount: () => callIndex
  };
}

function createMockToolRegistry(tools = {}) {
  return {
    getToolDefinitions: () => Object.keys(tools).map(name => ({
      type: 'function',
      function: { name, description: `Tool: ${name}`, parameters: {} }
    })),
    execute: async (name, args) => {
      if (tools[name]) return tools[name](args);
      return { success: false, result: '', error: `Unknown tool: ${name}` };
    },
    has: (name) => name in tools
  };
}

function createMockConversationContext(history = []) {
  return {
    getHistory: async () => history
  };
}

// Write a temp SOUL.md for testing
const testSoulPath = path.join(__dirname, 'test-soul-salvage.md');
try {
  fs.writeFileSync(testSoulPath, 'You are a test agent.');
} catch {
  // Will handle in tests
}

// ============================================================
// Tests
// ============================================================

console.log('\n=== AgentLoop Salvage Tests ===\n');

asyncTest('salvages tool result when iteration 2 LLM throws', async () => {
  const provider = createMockProvider([
    // Iteration 1: LLM requests a tool call
    {
      content: null,
      toolCalls: [{ id: 'call_1', name: 'calendar_create', arguments: { title: 'Test 9' } }]
    },
    // Iteration 2: LLM call fails — all providers exhausted
    new Error('All providers exhausted')
  ]);

  const toolRegistry = createMockToolRegistry({
    calendar_create: () => ({
      success: true,
      result: 'Created "Test 9" on 2/26/2026 at 1:00:00 PM. Event ID: mm27gxf6-abc'
    })
  });

  const loop = new AgentLoop({
    toolRegistry,
    conversationContext: createMockConversationContext(),
    llmProvider: provider,
    config: { soulPath: testSoulPath },
    logger: silentLogger
  });

  const response = await loop.process('Create a calendar event', 'room-1');

  // Should contain the tool result
  assert.ok(response.includes('Created "Test 9"'), 'Response should contain tool result');
  assert.ok(response.includes('Event ID: mm27gxf6-abc'), 'Response should contain event ID');
  // Should contain the salvage note
  assert.ok(response.includes('action above completed successfully'), 'Response should contain salvage note');
});

asyncTest('salvages on non-rate-limit errors too', async () => {
  const provider = createMockProvider([
    {
      content: null,
      toolCalls: [{ id: 'call_1', name: 'file_write', arguments: { path: '/test.txt' } }]
    },
    // Generic error (not rate-limit)
    new Error('Connection reset by peer')
  ]);

  const toolRegistry = createMockToolRegistry({
    file_write: () => ({
      success: true,
      result: 'File written successfully to /test.txt (245 bytes)'
    })
  });

  const loop = new AgentLoop({
    toolRegistry,
    conversationContext: createMockConversationContext(),
    llmProvider: provider,
    config: { soulPath: testSoulPath },
    logger: silentLogger
  });

  const response = await loop.process('Write a file', 'room-1');

  // Should salvage instead of throwing
  assert.ok(response.includes('File written successfully'), 'Should salvage on generic errors');
  assert.ok(response.includes('action above completed successfully'), 'Should have salvage note');
});

asyncTest('does NOT salvage when no tools were called', async () => {
  const provider = createMockProvider([
    // First LLM call fails immediately — no tool calls made
    new Error('Connection refused')
  ]);

  const loop = new AgentLoop({
    toolRegistry: createMockToolRegistry(),
    conversationContext: createMockConversationContext(),
    llmProvider: provider,
    config: { soulPath: testSoulPath },
    logger: silentLogger
  });

  // Should throw since there's nothing to salvage and it's not a rate-limit error
  await assert.rejects(
    () => loop.process('Hello', 'room-1'),
    { message: 'Connection refused' }
  );
});

asyncTest('skips Error results — does not salvage failures', async () => {
  const provider = createMockProvider([
    {
      content: null,
      toolCalls: [{ id: 'call_1', name: 'email_send', arguments: {} }]
    },
    // Rate-limit error after tool failure
    (() => { const e = new Error('rate limit exceeded'); e.status = 429; return e; })()
  ]);

  const toolRegistry = createMockToolRegistry({
    email_send: () => ({
      success: false,
      error: 'SMTP connection failed'
    })
  });

  const loop = new AgentLoop({
    toolRegistry,
    conversationContext: createMockConversationContext(),
    llmProvider: provider,
    config: { soulPath: testSoulPath },
    logger: silentLogger
  });

  const response = await loop.process('Send email', 'room-1');

  // Tool result starts with "Error:" → not salvaged → falls through to rate-limit handler
  assert.ok(!response.includes('SMTP'), 'Should not include error tool result');
  assert.ok(response.includes('try again'), 'Should use friendly LLM error message');
});

asyncTest('salvages multiple successful results', async () => {
  const provider = createMockProvider([
    // Iteration 1: LLM requests two tool calls
    {
      content: null,
      toolCalls: [
        { id: 'call_1', name: 'calendar_create', arguments: { title: 'Meeting' } },
        { id: 'call_2', name: 'deck_create_card', arguments: { title: 'Follow up' } }
      ]
    },
    // Iteration 2: LLM call fails
    new Error('All providers exhausted')
  ]);

  const toolRegistry = createMockToolRegistry({
    calendar_create: () => ({
      success: true,
      result: 'Created "Meeting" on 3/1/2026 at 10:00 AM. Event ID: evt-111'
    }),
    deck_create_card: () => ({
      success: true,
      result: 'Created card "Follow up" in stack "To Do" (card #42)'
    })
  });

  const loop = new AgentLoop({
    toolRegistry,
    conversationContext: createMockConversationContext(),
    llmProvider: provider,
    config: { soulPath: testSoulPath },
    logger: silentLogger
  });

  const response = await loop.process('Create event and task', 'room-1');

  assert.ok(response.includes('Created "Meeting"'), 'Should include first tool result');
  assert.ok(response.includes('Created card "Follow up"'), 'Should include second tool result');
  assert.ok(response.includes('action above completed successfully'), 'Should have salvage note');
});

asyncTest('preserves rate-limit handler when nothing to salvage', async () => {
  const provider = createMockProvider([
    {
      content: null,
      toolCalls: [{ id: 'call_1', name: 'broken_tool', arguments: {} }]
    },
    (() => { const e = new Error('rate limit exceeded'); e.status = 429; return e; })()
  ]);

  const toolRegistry = createMockToolRegistry({
    broken_tool: () => ({
      success: false,
      error: 'Internal failure'
    })
  });

  const loop = new AgentLoop({
    toolRegistry,
    conversationContext: createMockConversationContext(),
    llmProvider: provider,
    config: { soulPath: testSoulPath },
    logger: silentLogger
  });

  const response = await loop.process('Do something', 'room-1');

  // No salvageable results → rate-limit handler should run
  assert.ok(!response.includes('action above completed'), 'Should NOT salvage error results');
  assert.ok(
    response.includes('try again') || response.includes('busy') || response.includes('capacity'),
    'Should use friendly rate-limit message'
  );
});

// ============================================================
// Cleanup and Summary
// ============================================================

setTimeout(() => {
  try { fs.unlinkSync(testSoulPath); } catch { /* ignore */ }
  summary();
  exitWithCode();
}, 500);
