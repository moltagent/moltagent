/**
 * AgentLoop Job Classification Tests
 *
 * Tests the _classifyJob method that routes LLM calls to the appropriate
 * job type (quick/tools/thinking/writing/coding/research).
 *
 * Run: node --test test/unit/agent/job-classification.test.js
 */

'use strict';

const assert = require('assert');
const { test, summary, exitWithCode } = require('../../helpers/test-runner');

// Minimal AgentLoop instantiation for testing classification
const { AgentLoop } = require('../../../src/lib/agent/agent-loop');

function createAgentLoop() {
  return new AgentLoop({
    toolRegistry: { getTools: () => [], setRequestContext: () => {} },
    conversationContext: { getHistory: () => [] },
    llmProvider: { chat: async () => ({ content: 'mock' }) },
    logger: { info: () => {}, warn: () => {}, error: () => {} }
  });
}

const agent = createAgentLoop();

console.log('\n=== Job Classification Tests ===\n');

// --- Tools vs Quick ---
console.log('\n--- Tools vs Quick ---\n');

test('TC-CLASSIFY-001: returns "tools" when tools array is non-empty', () => {
  const messages = [{ role: 'user', content: 'Move the card to done' }];
  const tools = [{ type: 'function', function: { name: 'deck_move_card' } }];
  assert.strictEqual(agent._classifyJob(messages, tools), 'tools');
});

test('TC-CLASSIFY-002: returns "quick" for short message with no tools', () => {
  const messages = [{ role: 'user', content: 'Hi' }];
  assert.strictEqual(agent._classifyJob(messages, []), 'quick');
});

test('TC-CLASSIFY-003: returns "quick" for empty tools array and short message', () => {
  const messages = [{ role: 'user', content: 'Yes, do it' }];
  assert.strictEqual(agent._classifyJob(messages, []), 'quick');
});

test('TC-CLASSIFY-004: returns "quick" when no user message found', () => {
  const messages = [{ role: 'system', content: 'You are an assistant' }];
  assert.strictEqual(agent._classifyJob(messages, []), 'quick');
});

// --- Writing (synthesis after tool results) ---
console.log('\n--- Writing (tool result synthesis) ---\n');

test('TC-CLASSIFY-005: returns "writing" when 2+ recent tool results and tools present', () => {
  const messages = [
    { role: 'user', content: 'Get my tasks and summarize them' },
    { role: 'assistant', content: '', tool_calls: [{ id: '1', type: 'function', function: { name: 'deck_list' } }] },
    { role: 'tool', content: 'Task 1: Review PR' },
    { role: 'assistant', content: '', tool_calls: [{ id: '2', type: 'function', function: { name: 'calendar_list' } }] },
    { role: 'tool', content: 'Meeting at 3pm' }
  ];
  const tools = [{ type: 'function', function: { name: 'deck_list' } }];
  assert.strictEqual(agent._classifyJob(messages, tools), 'writing');
});

test('TC-CLASSIFY-006: returns "tools" when only 1 recent tool result', () => {
  const messages = [
    { role: 'user', content: 'Get my tasks' },
    { role: 'assistant', content: '', tool_calls: [{ id: '1' }] },
    { role: 'tool', content: 'Task 1: Review PR' }
  ];
  const tools = [{ type: 'function', function: { name: 'deck_list' } }];
  assert.strictEqual(agent._classifyJob(messages, tools), 'tools');
});

// --- Coding detection ---
console.log('\n--- Coding Detection ---\n');

test('TC-CLASSIFY-007: detects coding job from "debug" keyword', () => {
  const messages = [{ role: 'user', content: 'Can you debug this function that throws a TypeError when called with null?' }];
  assert.strictEqual(agent._classifyJob(messages, []), 'coding');
});

test('TC-CLASSIFY-008: detects coding job from "implement" keyword', () => {
  const messages = [{ role: 'user', content: 'Please implement a retry mechanism for the API client' }];
  assert.strictEqual(agent._classifyJob(messages, []), 'coding');
});

test('TC-CLASSIFY-009: detects coding job from "sql" keyword', () => {
  const messages = [{ role: 'user', content: 'Write me a SQL query to find duplicate entries in the users table' }];
  assert.strictEqual(agent._classifyJob(messages, []), 'coding');
});

// --- Research detection ---
console.log('\n--- Research Detection ---\n');

test('TC-CLASSIFY-010: detects research job from "search" keyword', () => {
  const messages = [{ role: 'user', content: 'Search for the latest information about renewable energy trends in Europe' }];
  assert.strictEqual(agent._classifyJob(messages, []), 'research');
});

test('TC-CLASSIFY-011: detects research job from "compare" keyword', () => {
  const messages = [{ role: 'user', content: 'Compare the pricing of these three cloud hosting providers and their features' }];
  assert.strictEqual(agent._classifyJob(messages, []), 'research');
});

// --- Writing detection ---
console.log('\n--- Writing Detection ---\n');

test('TC-CLASSIFY-012: detects writing job from "draft" keyword', () => {
  const messages = [{ role: 'user', content: 'Draft a professional email to the client about the project timeline change' }];
  assert.strictEqual(agent._classifyJob(messages, []), 'writing');
});

test('TC-CLASSIFY-013: detects writing job from "summarize" keyword', () => {
  const messages = [{ role: 'user', content: 'Summarize the key points from the quarterly review meeting we had yesterday' }];
  assert.strictEqual(agent._classifyJob(messages, []), 'writing');
});

// --- Thinking (default for complex) ---
console.log('\n--- Thinking Detection ---\n');

test('TC-CLASSIFY-014: defaults to "thinking" for complex unclassified messages', () => {
  const messages = [{ role: 'user', content: 'Analyze the trade-offs between microservices and monolithic architecture for our current scale and team size' }];
  assert.strictEqual(agent._classifyJob(messages, []), 'thinking');
});

test('TC-CLASSIFY-015: defaults to "thinking" for long messages without specific keywords', () => {
  const messages = [{ role: 'user', content: 'I need to understand the implications of changing our database schema. We have about 50 million rows and the migration would need to happen without downtime. What are my options here?' }];
  assert.strictEqual(agent._classifyJob(messages, []), 'thinking');
});

// --- Helper methods ---
console.log('\n--- Helper Methods ---\n');

test('TC-CLASSIFY-016: _lastUserContent returns last user message content', () => {
  const messages = [
    { role: 'user', content: 'First message' },
    { role: 'assistant', content: 'Response' },
    { role: 'user', content: 'Second message' }
  ];
  assert.strictEqual(agent._lastUserContent(messages), 'Second message');
});

test('TC-CLASSIFY-017: _lastUserContent returns empty string when no user message', () => {
  const messages = [{ role: 'system', content: 'System prompt' }];
  assert.strictEqual(agent._lastUserContent(messages), '');
});

test('TC-CLASSIFY-018: _recentToolResultCount counts tool results in last 6 messages', () => {
  const messages = [
    { role: 'user', content: 'Do things' },
    { role: 'tool', content: 'Result 1' },
    { role: 'tool', content: 'Result 2' },
    { role: 'tool', content: 'Result 3' },
    { role: 'assistant', content: 'Done' }
  ];
  assert.strictEqual(agent._recentToolResultCount(messages), 3);
});

// Summary
const results = summary();
exitWithCode();
