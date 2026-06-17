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

/**
 * MessageProcessor — _detectRoomLanguage Unit Tests
 *
 * Architecture Brief:
 * -------------------
 * Phase 1 of the STT language custody fix: the room's working language is
 * detected once at the chokepoint right before voice transcription
 * (MessageProcessor._detectRoomLanguage) and passed forward to VoiceManager
 * → SpeachesClient. This file tests that method in isolation.
 *
 * Pattern: SIGNALS KEEP CUSTODY (#49/#123/#133 — 4th instance).
 * The language is derived ONCE from conversationContext.getHistory, then
 * classified by the LLM (job:'classification'). A structural post-LLM guard
 * extracts a 2-letter alpha token; no semantic language list is maintained
 * in code (Dev Rule 1: LLM is the language layer).
 *
 * Run: node test/unit/server/message-processor-voice.test.js
 */

'use strict';

const assert = require('assert');
const { asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

const MessageProcessor = require('../../../src/lib/server/message-processor');

// ============================================================
// Helpers
// ============================================================

/**
 * Build a minimal MessageProcessor with controlled deps for _detectRoomLanguage.
 *
 * @param {Object} opts
 * @param {Object|null} opts.conversationContext - Mock conversationContext
 * @param {Object|null} opts.microPipeline - Mock microPipeline with .router
 */
function createProcessor({ conversationContext = null, microPipeline = null } = {}) {
  return new MessageProcessor({
    conversationContext,
    microPipeline,
    // Minimal required deps so construction succeeds
    commandHandler: { handle: async () => ({ response: 'ok' }) },
    sendTalkReply: async () => {},
    botUsername: 'moltagent',
    auditLog: async () => {},
    botNames: ['moltagent']
  });
}

/**
 * Build a mock conversationContext whose getHistory resolves to the given array.
 */
function mockConversationContext(history) {
  return {
    getHistory: async () => history
  };
}

/**
 * Build a mock conversationContext whose getHistory throws.
 */
function mockConversationContextThrows(errMessage = 'Network error') {
  return {
    getHistory: async () => { throw new Error(errMessage); }
  };
}

/**
 * Build a mock microPipeline whose router.route resolves to the given raw string.
 */
function mockMicroPipeline(rawResult, { throws = false } = {}) {
  const route = throws
    ? async () => { throw new Error('LLM unavailable'); }
    : async () => ({ result: rawResult });
  return { router: { route } };
}

// ============================================================
// Test Cases for _detectRoomLanguage
// ============================================================

console.log('\n=== MessageProcessor._detectRoomLanguage Tests (Phase 1 STT Language Custody) ===\n');

asyncTest('TC-MP-VL-05: Last assistant message EN → returns "en"', async () => {
  const history = [
    { id: 1, role: 'user', content: 'Show me emails', timestamp: 1000 },
    { id: 2, role: 'assistant', content: 'Here is a summary of the email.', timestamp: 2000 }
  ];
  const mp = createProcessor({
    conversationContext: mockConversationContext(history),
    microPipeline: mockMicroPipeline('en')
  });
  const result = await mp._detectRoomLanguage('room-token-abc', 99);
  assert.strictEqual(result, 'en', 'should return "en" for English assistant content');
});

asyncTest('TC-MP-VL-06: Last assistant message DE → returns "de"', async () => {
  const history = [
    { id: 1, role: 'user', content: 'Zeig mir E-Mails', timestamp: 1000 },
    { id: 2, role: 'assistant', content: 'Hier ist eine Zusammenfassung der E-Mail.', timestamp: 2000 }
  ];
  const mp = createProcessor({
    conversationContext: mockConversationContext(history),
    microPipeline: mockMicroPipeline('de')
  });
  const result = await mp._detectRoomLanguage('room-token-abc', 99);
  assert.strictEqual(result, 'de', 'should return "de" for German assistant content');
});

asyncTest('TC-MP-VL-07: Last assistant message PT → returns "pt"', async () => {
  const history = [
    { id: 1, role: 'user', content: 'Mostra e-mails', timestamp: 1000 },
    { id: 2, role: 'assistant', content: 'Aqui está um resumo do e-mail.', timestamp: 2000 }
  ];
  const mp = createProcessor({
    conversationContext: mockConversationContext(history),
    microPipeline: mockMicroPipeline('pt')
  });
  const result = await mp._detectRoomLanguage('room-token-abc', 99);
  assert.strictEqual(result, 'pt', 'should return "pt" for Portuguese assistant content');
});

asyncTest('TC-MP-VL-08: Empty history → returns null (new room, preserves auto-detect)', async () => {
  const mp = createProcessor({
    conversationContext: mockConversationContext([]),
    microPipeline: mockMicroPipeline('en')
  });
  const result = await mp._detectRoomLanguage('room-token-abc', 99);
  assert.strictEqual(result, null,
    'empty history means no language signal; should fall back to STT auto-detect');
});

asyncTest('TC-MP-VL-09: conversationContext null → returns null (router NOT called)', async () => {
  let routeCalled = false;
  const mp = createProcessor({
    conversationContext: null,
    microPipeline: {
      router: {
        route: async () => { routeCalled = true; return { result: 'en' }; }
      }
    }
  });
  const result = await mp._detectRoomLanguage('room-token-abc', 99);
  assert.strictEqual(result, null, 'null conversationContext should return null immediately');
  assert.strictEqual(routeCalled, false, 'router.route should NOT be called when context is absent');
});

asyncTest('TC-MP-VL-10: microPipeline null → returns null (cannot call router)', async () => {
  const history = [
    { id: 2, role: 'assistant', content: 'Here is a summary.', timestamp: 2000 }
  ];
  const mp = createProcessor({
    conversationContext: mockConversationContext(history),
    microPipeline: null
  });
  const result = await mp._detectRoomLanguage('room-token-abc', 99);
  assert.strictEqual(result, null,
    'absent microPipeline means no router; should return null');
});

asyncTest('TC-MP-VL-11: router.route throws → returns null (graceful degradation)', async () => {
  const history = [
    { id: 2, role: 'assistant', content: 'Here is a summary.', timestamp: 2000 }
  ];
  const mp = createProcessor({
    conversationContext: mockConversationContext(history),
    microPipeline: mockMicroPipeline(null, { throws: true })
  });
  const result = await mp._detectRoomLanguage('room-token-abc', 99);
  assert.strictEqual(result, null,
    'LLM throw should be caught and return null (preserve auto-detect)');
});

asyncTest('TC-MP-VL-12a: LLM returns bare "en." (trailing punctuation) → "en"', async () => {
  // Realistic non-bare answer: the model added a period. The anchored guard
  // accepts a 2-letter code at the start followed by a non-letter.
  const history = [
    { id: 2, role: 'assistant', content: 'Here is a summary.', timestamp: 2000 }
  ];
  const mp = createProcessor({
    conversationContext: mockConversationContext(history),
    microPipeline: mockMicroPipeline('en.\n')
  });
  const result = await mp._detectRoomLanguage('room-token-abc', 99);
  assert.strictEqual(result, 'en',
    'anchored guard should accept a leading 2-letter code trailed by punctuation/whitespace');
});

asyncTest('TC-MP-VL-12a2: LLM returns a full word "english" → null (fail safe)', async () => {
  // A full word is NOT a code. The non-letter lookahead rejects it so we fall
  // through to STT auto-detect rather than emitting a guessed "en".
  const history = [
    { id: 2, role: 'assistant', content: 'Here is a summary.', timestamp: 2000 }
  ];
  const mp = createProcessor({
    conversationContext: mockConversationContext(history),
    microPipeline: mockMicroPipeline('english\n')
  });
  const result = await mp._detectRoomLanguage('room-token-abc', 99);
  assert.strictEqual(result, null,
    'a full word (not a bare 2-letter code) must fall through to auto-detect, not a guessed code');
});

asyncTest('TC-MP-VL-12b: LLM returns prose "the code is en" → null (fail safe)', async () => {
  // The dangerous case the anchored guard is designed for: unanchored matching
  // would extract "th" (Thai) and pass a confidently-wrong hint to Whisper.
  // The anchored guard rejects prose entirely → null → STT auto-detect.
  const history = [
    { id: 2, role: 'assistant', content: 'Here is a summary.', timestamp: 2000 }
  ];
  const mp = createProcessor({
    conversationContext: mockConversationContext(history),
    microPipeline: mockMicroPipeline('the code is en')
  });
  const result = await mp._detectRoomLanguage('room-token-abc', 99);
  assert.strictEqual(result, null,
    'prose output must fall through to auto-detect, never yield a wrong first-2-letter hint');
});

asyncTest('TC-MP-VL-12c: LLM returns empty string → returns null', async () => {
  const history = [
    { id: 2, role: 'assistant', content: 'Here is a summary.', timestamp: 2000 }
  ];
  const mp = createProcessor({
    conversationContext: mockConversationContext(history),
    microPipeline: mockMicroPipeline('')
  });
  const result = await mp._detectRoomLanguage('room-token-abc', 99);
  assert.strictEqual(result, null,
    'empty LLM response should return null (no 2-letter alpha token found)');
});

asyncTest('TC-MP-VL-13: Multiple assistant messages → uses the MOST RECENT one', async () => {
  let capturedContent = null;
  // First assistant msg is DE, second (most recent) is EN.
  // The router should receive a prompt containing the EN content.
  const history = [
    { id: 1, role: 'user', content: 'Hello', timestamp: 1000 },
    { id: 2, role: 'assistant', content: 'Guten Tag! Wie kann ich helfen?', timestamp: 2000 },
    { id: 3, role: 'user', content: 'Switch to English please', timestamp: 3000 },
    { id: 4, role: 'assistant', content: 'Of course! How can I help you today?', timestamp: 4000 }
  ];
  const mp = createProcessor({
    conversationContext: mockConversationContext(history),
    microPipeline: {
      router: {
        route: async (opts) => {
          capturedContent = opts.content || '';
          return { result: 'en' };
        }
      }
    }
  });
  const result = await mp._detectRoomLanguage('room-token-abc', 99);
  assert.strictEqual(result, 'en', 'should return language of most recent assistant message');
  assert.ok(
    capturedContent.includes('Of course! How can I help you today?'),
    'prompt should contain the MOST RECENT assistant message content, not an older one'
  );
});

asyncTest('TC-MP-VL-14: History has no assistant messages → returns null (no role:assistant)', async () => {
  const history = [
    { id: 1, role: 'user', content: 'Hello', timestamp: 1000 },
    { id: 2, role: 'user', content: 'Are you there?', timestamp: 2000 }
  ];
  const mp = createProcessor({
    conversationContext: mockConversationContext(history),
    microPipeline: mockMicroPipeline('en')
  });
  const result = await mp._detectRoomLanguage('room-token-abc', 99);
  assert.strictEqual(result, null,
    'history with no assistant messages should return null (new room pattern)');
});

asyncTest('TC-MP-VL-15: token absent → returns null immediately', async () => {
  let getHistoryCalled = false;
  const mp = createProcessor({
    conversationContext: {
      getHistory: async () => { getHistoryCalled = true; return []; }
    },
    microPipeline: mockMicroPipeline('en')
  });
  const result = await mp._detectRoomLanguage(null, 99);
  assert.strictEqual(result, null, 'null token should return null immediately');
  assert.strictEqual(getHistoryCalled, false, 'getHistory should NOT be called without a token');
});

asyncTest('TC-MP-VL-16: getHistory throws → returns null (network resilience)', async () => {
  const mp = createProcessor({
    conversationContext: mockConversationContextThrows('Talk API 503'),
    microPipeline: mockMicroPipeline('en')
  });
  const result = await mp._detectRoomLanguage('room-token-abc', 99);
  assert.strictEqual(result, null,
    'getHistory throw should be caught and return null (degrade to auto-detect)');
});

// Summary
setTimeout(() => {
  summary();
  exitWithCode();
}, 500);
