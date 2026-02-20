/**
 * flush-integration.js
 *
 * End-to-end integration test for the memory flush handler.
 * Tests three things:
 *   Part 1 — SessionManager: flushNeeded fires at 80% of maxContextLength
 *   Part 2 — AgentLoop: systemSuffix appears in the messages array sent to LLM
 *   Part 3 — MessageProcessor: flush prompt flows from sessionManager → agentLoop
 */

'use strict';

// Wrap everything in an async IIFE so we can use await in a CJS module
(async () => {

const assert = require('assert');

// --------------------------------------------------------------------------
// Colour helpers (no external deps)
// --------------------------------------------------------------------------
const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET  = '\x1b[0m';

let passed = 0;
let failed = 0;

function ok(label, condition) {
  if (condition) {
    console.log(`  ${GREEN}PASS${RESET}  ${label}`);
    passed++;
  } else {
    console.log(`  ${RED}FAIL${RESET}  ${label}`);
    failed++;
  }
}

function section(title) {
  console.log(`\n${YELLOW}== ${title} ==${RESET}`);
}

// --------------------------------------------------------------------------
// PART 1: SessionManager flush threshold
// --------------------------------------------------------------------------
section('Part 1 — SessionManager: flushNeeded fires at 80%');

const SessionManager = require('/opt/moltagent/src/security/session-manager');

// maxContextLength=10, so 80% threshold is Math.floor(10 * 0.8) = 8
const sm = new SessionManager({ maxContextLength: 10 });
const session = sm.getSession('room-test', 'user-test');

let flushFiredAt = null;
let flushCount = 0;

for (let i = 1; i <= 12; i++) {
  const { flushNeeded } = sm.addContext(session, 'user', `message ${i}`);
  if (flushNeeded) {
    flushCount++;
    flushFiredAt = i;
    console.log(`    [SessionManager] flushNeeded=true at message ${i} (context.length=${session.context.length})`);
  }
}

const threshold = Math.floor(10 * 0.8); // 8
ok(`flushNeeded fires exactly once before truncation`, flushCount === 1);
ok(`flushNeeded fires at message #${threshold} (80% of 10)`, flushFiredAt === threshold);
ok(`_flushRequested flag is reset after truncation (allows future cycle)`, session._flushRequested === false);
ok(`context length stays at or below maxContextLength after truncation`, session.context.length <= 10);

// Verify the flag prevents double-fire: add more messages without crossing threshold again
// Reset the session and run a second cycle
const session2 = sm.getSession('room-test2', 'user-test2');
let secondCycleFlushCount = 0;
for (let i = 1; i <= 7; i++) {
  const { flushNeeded } = sm.addContext(session2, 'user', `msg ${i}`);
  if (flushNeeded) secondCycleFlushCount++;
}
ok(`No spurious flush on messages 1-7 (below threshold)`, secondCycleFlushCount === 0);

// Add message 8 — should fire
const { flushNeeded: fireAt8 } = sm.addContext(session2, 'user', 'msg 8');
ok(`flushNeeded=true at message 8`, fireAt8 === true);

// Add message 9 immediately — _flushRequested is set, should NOT fire again
const { flushNeeded: noFireAt9 } = sm.addContext(session2, 'user', 'msg 9');
ok(`flushNeeded=false at message 9 (flag debounces double-fire)`, noFireAt9 === false);

// --------------------------------------------------------------------------
// PART 2: AgentLoop — systemSuffix appears in messages array
// --------------------------------------------------------------------------
section('Part 2 — AgentLoop: systemSuffix injected into messages array');

// We build a minimal AgentLoop by mocking only the parts that matter.
// The real process() does: messages = [...history, {role:'user', content}]
// then if options.systemSuffix: messages.push({role:'system', content: options.systemSuffix})
// We verify this by intercepting the llmProvider.chat() call.

const { AgentLoop } = require('/opt/moltagent/src/lib/agent/agent-loop');

// Minimal mock tool registry
const mockToolRegistry = {
  getToolDefinitions: () => [],
  has: () => false,
  execute: async () => ({ success: true, result: 'ok' }),
  setRequestContext: () => {}
};

// Capture the messages array that reaches chat()
let capturedMessages = null;
let capturedMessagesWithSuffix = null;

const mockLlmProvider = {
  resetConversation: () => {},
  chat: async ({ messages }) => {
    capturedMessages = messages;
    return { content: 'mock response', toolCalls: [] };
  }
};

// Minimal conversation context (no history)
const mockConversationContext = {
  getHistory: async () => []
};

const agentLoop = new AgentLoop({
  toolRegistry: mockToolRegistry,
  conversationContext: mockConversationContext,
  llmProvider: mockLlmProvider,
  config: { maxIterations: 1, soulPath: '/nonexistent/SOUL.md' }  // soulPath won't exist — falls back gracefully
});

// Run 1: No systemSuffix
await agentLoop.process('hello', 'room1', {});
const messagesWithoutSuffix = capturedMessages.slice();

ok(`Messages without systemSuffix does NOT contain a trailing system message`,
  !messagesWithoutSuffix.some(m => m.role === 'system' && m.content && m.content.includes('Memory Flush')));

// Run 2: With systemSuffix
const testFlushPrompt = '[SYSTEM — Memory Flush]\nYou are approaching context limits. wiki_write the 5–10 most important facts.';
await agentLoop.process('hello', 'room1', { systemSuffix: testFlushPrompt });
capturedMessagesWithSuffix = capturedMessages.slice();

const systemMsg = capturedMessagesWithSuffix.find(m => m.role === 'system' && m.content === testFlushPrompt);
ok(`Messages WITH systemSuffix contains a system message with flush prompt content`, !!systemMsg);
ok(`System message is appended AFTER the user message`,
  capturedMessagesWithSuffix.indexOf(systemMsg) > capturedMessagesWithSuffix.findIndex(m => m.role === 'user'));
ok(`Flush prompt contains 'wiki_write'`, testFlushPrompt.includes('wiki_write'));

console.log(`    [AgentLoop] messages array (with suffix) roles: [${capturedMessagesWithSuffix.map(m => m.role).join(', ')}]`);

// --------------------------------------------------------------------------
// PART 3: MessageProcessor end-to-end — flush flows from sessionManager → agentLoop
// --------------------------------------------------------------------------
section('Part 3 — MessageProcessor end-to-end: flush prompt reaches agentLoop');

const MessageProcessor = require('/opt/moltagent/src/lib/server/message-processor');

// Fresh SessionManager with low threshold: maxContextLength=10, 80% threshold = 8 entries.
// With alternating user+assistant entries the context grows:
//   after round 1: user1 + asst1 = 2 entries
//   after round 2: user2 + asst2 = 4 entries
//   after round 3: user3 + asst3 = 6 entries
//   after round 4: user4 (7) + asst4 (8 = threshold!) → flush fires on assistant side
//   after round 4 asst: _pendingFlush is set on the session
//   round 5 user message: _pendingFlush consumed → flush prompt injected into agentLoop call
//
// Therefore the flush prompt first appears on USER MESSAGE 5, not message 8.
const sm3 = new SessionManager({ maxContextLength: 10 });

// Track all systemSuffix values seen by agentLoop.process()
const capturedSuffixes = [];
const mockAgentLoop = {
  toolRegistry: mockToolRegistry,
  llmProvider: {
    resetConversation: () => {},
    primaryIsLocal: false,
    chatProviders: null,
  },
  process: async (message, token, opts) => {
    capturedSuffixes.push(opts.systemSuffix || null);
    console.log(`    [MessageProcessor] Message "${message.substring(0,30)}" → systemSuffix=${opts.systemSuffix ? '"[flush prompt]"' : 'null'}`);
    return 'ok';
  }
};

// Build the minimal Activity Streams payload that _extractMessage() can parse.
// Looking at _extractMessage():
//   content  = data.object?.content
//   user     = data.actor?.id (without 'users/' prefix)
//   token    = data.target?.id
//   messageId = data.object?.id
function makePayload(content, i) {
  return {
    actor:  { id: 'users/testuser', type: 'users' },
    object: { id: `msg-${i}`, content },
    target: { id: 'room-tok3' }
  };
}

const processor = new MessageProcessor({
  agentLoop: mockAgentLoop,
  sessionManager: sm3,
  botUsername: 'moltagent',
  commandHandler: { handle: async () => ({ response: 'cmd ok' }) },
  sendTalkReply: async () => {},
  auditLog: async () => {}
});

// Process 9 messages (flush fires at user message 5 — see comment above)
for (let i = 1; i <= 9; i++) {
  await processor.process(makePayload(`Tell me something interesting number ${i}`, i));
}

console.log(`\n    [MessageProcessor] systemSuffix per message:`);
capturedSuffixes.forEach((s, idx) => {
  console.log(`      msg ${idx+1}: ${s ? '"[flush prompt present]"' : 'null'}`);
});

// Messages 1-4: no flush (threshold not crossed yet)
const pre4 = capturedSuffixes.slice(0, 4);
ok(`Messages 1-4: systemSuffix is null (no flush yet)`, pre4.every(s => s === null));

// Message 5: flush triggered (pending from assistant 4 crossing threshold)
const msg5suffix = capturedSuffixes[4];
ok(`Message 5: systemSuffix is non-null (flush triggered via pending flag)`,
  msg5suffix !== null && msg5suffix !== undefined);
ok(`Message 5: systemSuffix contains 'wiki_write'`,
  typeof msg5suffix === 'string' && msg5suffix.includes('wiki_write'));
ok(`Message 5: systemSuffix contains '5' and '10' (5-10 facts)`,
  typeof msg5suffix === 'string' && msg5suffix.includes('5') && msg5suffix.includes('10'));
ok(`Message 5: systemSuffix contains '[SYSTEM — Memory Flush]'`,
  typeof msg5suffix === 'string' && msg5suffix.includes('[SYSTEM — Memory Flush]'));

// Message 6: flush flag consumed/debounced — no second prompt
const msg6suffix = capturedSuffixes[5];
ok(`Message 6: systemSuffix is null again (debounced after flush)`,
  msg6suffix === null || msg6suffix === undefined);

// --------------------------------------------------------------------------
// Summary
// --------------------------------------------------------------------------
console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${GREEN}${passed} passed${RESET}, ${failed > 0 ? RED : ''}${failed} failed${RESET}`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log(`${GREEN}All assertions passed.${RESET}`);
}

})().catch(err => {
  console.error('Unexpected error during test run:', err);
  process.exit(2);
});
