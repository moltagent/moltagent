/**
 * MessageProcessor Unit Tests
 *
 * Test suite for incoming message processing, including
 * Session 37: voice detection, call-aware routing, address detection.
 *
 * Run: node test/unit/server/message-processor.test.js
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

// Import module under test
const MessageProcessor = require('../../../src/lib/server/message-processor');

// ============================================================
// Helper: Create mock dependencies
// ============================================================

function createMockMessageRouter(response = { response: 'Router response', intent: 'general', provider: 'mock' }) {
  return {
    route: async () => response
  };
}

function createMockCommandHandler(response = { response: 'Command response', intent: 'command', provider: 'mock' }) {
  return {
    handle: async () => response
  };
}

function createMockSendTalkReply() {
  const calls = [];
  const fn = async (token, message, replyTo) => {
    calls.push({ token, message, replyTo });
    return true;
  };
  fn.getCalls = () => calls;
  fn.reset = () => { calls.length = 0; };
  return fn;
}

function createMockErrorHandler() {
  return {
    handle: async () => ({ message: 'Something went wrong. Please try again.' })
  };
}

function createProcessor(overrides = {}) {
  return new MessageProcessor({
    messageRouter: createMockMessageRouter(),
    commandHandler: createMockCommandHandler(),
    sendTalkReply: createMockSendTalkReply(),
    botUsername: 'moltagent',
    auditLog: async () => {},
    botNames: ['Molti', 'moltagent', 'molti'],
    ...overrides
  });
}

function createActivityStreamsData(content, opts = {}) {
  return {
    object: {
      content: content,
      id: opts.messageId || 'msg-123',
      message: opts.message || undefined
    },
    actor: {
      id: `users/${opts.user || 'alice'}`,
      type: opts.actorType || 'users'
    },
    target: {
      id: opts.token || 'room-abc'
    }
  };
}

// ============================================================
// Test Suites
// ============================================================

console.log('\n=== MessageProcessor Tests ===\n');

// --- Voice Message Detection Tests (Session 37) ---
console.log('\n--- Voice Message Detection (Session 37) ---\n');

test('TC-VOICE-001: _isVoiceMessage detects messageType voice-message', () => {
  const processor = createProcessor();
  assert.strictEqual(
    processor._isVoiceMessage({ messageType: 'voice-message' }),
    true
  );
});

test('TC-VOICE-002: _isVoiceMessage detects audio/* mimetype', () => {
  const processor = createProcessor();
  assert.strictEqual(
    processor._isVoiceMessage({
      messageParameters: { file: { mimetype: 'audio/ogg', path: '/voice.ogg' } }
    }),
    true
  );
});

test('TC-VOICE-003: _isVoiceMessage detects audio/mpeg', () => {
  const processor = createProcessor();
  assert.strictEqual(
    processor._isVoiceMessage({
      messageParameters: { file: { mimetype: 'audio/mpeg', path: '/voice.mp3' } }
    }),
    true
  );
});

test('TC-VOICE-004: _isVoiceMessage returns false for non-audio', () => {
  const processor = createProcessor();
  assert.strictEqual(
    processor._isVoiceMessage({
      messageParameters: { file: { mimetype: 'image/png', path: '/photo.png' } }
    }),
    false
  );
});

test('TC-VOICE-005: _isVoiceMessage returns false for empty message', () => {
  const processor = createProcessor();
  assert.strictEqual(processor._isVoiceMessage({}), false);
});

test('TC-VOICE-006: _extractMessage sets _isVoice for voice-message type', () => {
  const processor = createProcessor();
  const data = {
    object: {
      content: '{object}',
      id: 'msg-1',
      message: {
        messageType: 'voice-message',
        messageParameters: { file: { path: '/voice.ogg', mimetype: 'audio/ogg' } }
      }
    },
    actor: { id: 'users/alice', type: 'users' },
    target: { id: 'room-abc' }
  };

  const extracted = processor._extractMessage(data);
  assert.strictEqual(extracted._isVoice, true);
  assert.ok(extracted._voiceFile, 'Should have _voiceFile');
  assert.strictEqual(extracted.content, '[Voice message]');
});

test('TC-VOICE-007: _extractMessage sets _isVoice for audio mimetype with {object}', () => {
  const processor = createProcessor();
  const data = {
    object: {
      content: '{object}',
      id: 'msg-1',
      message: {
        messageParameters: { file: { path: '/recording.m4a', mimetype: 'audio/mp4' } }
      }
    },
    actor: { id: 'users/alice', type: 'users' },
    target: { id: 'room-abc' }
  };

  const extracted = processor._extractMessage(data);
  assert.strictEqual(extracted._isVoice, true);
});

test('TC-VOICE-008: _extractMessage keeps rich-object error for non-voice {object}', () => {
  const processor = createProcessor();
  const data = {
    object: {
      content: '{object}',
      id: 'msg-1',
      message: {
        messageParameters: { poll: { id: 42 } }
      }
    },
    actor: { id: 'users/alice', type: 'users' },
    target: { id: 'room-abc' }
  };

  const extracted = processor._extractMessage(data);
  assert.strictEqual(extracted._isVoice, false);
  assert.ok(extracted.content.includes('rich object'), 'Should have rich object error');
});

// --- Address Detection Tests (Session 37) ---
console.log('\n--- Address Detection (Session 37) ---\n');

test('TC-ADDR-001: _isAddressed detects name at start (comma)', () => {
  const processor = createProcessor({ botNames: ['Molti', 'moltagent'] });
  assert.strictEqual(
    processor._isAddressed({ content: 'Molti, what time is it?', _rawMessage: {} }),
    true
  );
});

test('TC-ADDR-002: _isAddressed detects name at start (space)', () => {
  const processor = createProcessor({ botNames: ['Molti', 'moltagent'] });
  assert.strictEqual(
    processor._isAddressed({ content: 'molti what is this?', _rawMessage: {} }),
    true
  );
});

test('TC-ADDR-003: _isAddressed detects name at start (colon)', () => {
  const processor = createProcessor({ botNames: ['Molti', 'moltagent'] });
  assert.strictEqual(
    processor._isAddressed({ content: 'Molti: help me', _rawMessage: {} }),
    true
  );
});

test('TC-ADDR-004: _isAddressed detects name anywhere in message', () => {
  const processor = createProcessor({ botNames: ['Molti', 'moltagent'] });
  assert.strictEqual(
    processor._isAddressed({ content: 'Can you ask Molti about that?', _rawMessage: {} }),
    true
  );
});

test('TC-ADDR-005: _isAddressed detects @mention', () => {
  const processor = createProcessor({ botUsername: 'moltagent' });
  assert.strictEqual(
    processor._isAddressed({
      content: 'hello',
      _rawMessage: { mentions: [{ id: 'moltagent' }] }
    }),
    true
  );
});

test('TC-ADDR-006: _isAddressed detects reply to bot', () => {
  const processor = createProcessor({ botUsername: 'moltagent' });
  assert.strictEqual(
    processor._isAddressed({
      content: 'thanks',
      _rawMessage: { parent: { actorId: 'moltagent' } }
    }),
    true
  );
});

test('TC-ADDR-007: _isAddressed returns false when not addressed', () => {
  const processor = createProcessor({ botNames: ['Molti', 'moltagent'] });
  assert.strictEqual(
    processor._isAddressed({ content: 'Hey everyone, meeting at 3pm', _rawMessage: {} }),
    false
  );
});

test('TC-ADDR-008: _isAddressed ignores short names (< 3 chars) in body', () => {
  const processor = createProcessor({ botNames: ['AI'] });
  // 'AI' is only 2 chars, so it should not match in the body
  assert.strictEqual(
    processor._isAddressed({ content: 'I said something about AI tools', _rawMessage: {} }),
    false
  );
});

test('TC-ADDR-009: _isAddressed detects name with question mark', () => {
  const processor = createProcessor({ botNames: ['Molti'] });
  assert.strictEqual(
    processor._isAddressed({ content: 'Molti?', _rawMessage: {} }),
    true
  );
});

// --- Call-Aware Room Behavior Tests (Session 37) ---
console.log('\n--- Call-Aware Room Behavior (Session 37) ---\n');

asyncTest('TC-ROOM-001: _getRoomBehavior returns respond for <= 2 participants', async () => {
  const processor = createProcessor({
    ncRequestManager: {
      request: async () => ({
        body: { ocs: { data: { participantCount: 2 } } }
      })
    }
  });

  const result = await processor._getRoomBehavior({
    token: 'room-1', content: 'random chat', _rawMessage: {}
  });
  assert.strictEqual(result, 'respond');
});

asyncTest('TC-ROOM-002: _getRoomBehavior returns silent for > 2 participants when not addressed', async () => {
  const processor = createProcessor({
    botNames: ['Molti'],
    ncRequestManager: {
      request: async () => ({
        body: { ocs: { data: { participantCount: 5 } } }
      })
    }
  });

  const result = await processor._getRoomBehavior({
    token: 'room-1', content: 'Hey everyone, meeting at 3pm', _rawMessage: {}
  });
  assert.strictEqual(result, 'silent');
});

asyncTest('TC-ROOM-003: _getRoomBehavior returns respond for > 2 participants when addressed', async () => {
  const processor = createProcessor({
    botNames: ['Molti'],
    ncRequestManager: {
      request: async () => ({
        body: { ocs: { data: { participantCount: 5 } } }
      })
    }
  });

  const result = await processor._getRoomBehavior({
    token: 'room-1', content: 'Molti, what time is the meeting?', _rawMessage: {}
  });
  assert.strictEqual(result, 'respond');
});

asyncTest('TC-ROOM-004: _getRoomBehavior defaults to respond on API error', async () => {
  const processor = createProcessor({
    ncRequestManager: {
      request: async () => { throw new Error('Network error'); }
    }
  });

  const result = await processor._getRoomBehavior({
    token: 'room-1', content: 'hello', _rawMessage: {}
  });
  assert.strictEqual(result, 'respond');
});

asyncTest('TC-ROOM-005: _getRoomBehavior defaults to respond when room data is null', async () => {
  const processor = createProcessor({
    ncRequestManager: {
      request: async () => ({ body: { ocs: { data: null } } })
    }
  });

  const result = await processor._getRoomBehavior({
    token: 'room-1', content: 'hello', _rawMessage: {}
  });
  assert.strictEqual(result, 'respond');
});

// --- Silent Observation Tests (Session 37) ---
console.log('\n--- Silent Observation (Session 37) ---\n');

test('TC-OBSERVE-001: _silentlyObserve stores context', () => {
  const processor = createProcessor();
  processor._silentlyObserve('room-1', { user: 'alice', content: 'Hello' });

  const ctx = processor.roomContext.get('room-1');
  assert.ok(ctx, 'Should have context for room');
  assert.strictEqual(ctx.length, 1);
  assert.strictEqual(ctx[0].author, 'alice');
  assert.strictEqual(ctx[0].text, 'Hello');
  assert.ok(ctx[0].timestamp > 0);
});

test('TC-OBSERVE-002: _silentlyObserve caps at 200 messages', () => {
  const processor = createProcessor();

  // Add 210 messages
  for (let i = 0; i < 210; i++) {
    processor._silentlyObserve('room-1', { user: 'alice', content: `Message ${i}` });
  }

  const ctx = processor.roomContext.get('room-1');
  assert.strictEqual(ctx.length, 200, 'Should be capped at 200');
  // The oldest messages should be removed
  assert.strictEqual(ctx[0].text, 'Message 10', 'First 10 should be trimmed');
});

// --- process() Voice Integration Tests (Session 37) ---
console.log('\n--- process() Voice Integration (Session 37) ---\n');

asyncTest('TC-PROC-001: process() transcribes voice message and routes to agent', async () => {
  let transcribedText = null;

  const processor = createProcessor({
    agentLoop: {
      process: async (content) => {
        transcribedText = content;
        return 'Agent response to voice';
      }
    },
    filesClient: {
      readFileBuffer: async () => Buffer.from('audio data')
    },
    whisperClient: {
      transcribe: async () => 'Hello from voice'
    },
    audioConverter: {
      toWav16kMono: async (buf) => buf
    }
  });

  const data = {
    object: {
      content: '{object}',
      id: 'msg-1',
      message: {
        messageType: 'voice-message',
        messageParameters: { file: { path: '/voice.ogg', mimetype: 'audio/ogg' } }
      }
    },
    actor: { id: 'users/alice', type: 'users' },
    target: { id: 'room-abc' }
  };

  const result = await processor.process(data);
  assert.ok(result.response, 'Should have a response');
  assert.strictEqual(transcribedText, 'Hello from voice', 'Agent should receive transcript');
});

asyncTest('TC-PROC-002: process() adds transcript indicator to response', async () => {
  const processor = createProcessor({
    agentLoop: {
      process: async () => 'Sure, I can help!'
    },
    filesClient: {
      readFileBuffer: async () => Buffer.from('audio')
    },
    whisperClient: {
      transcribe: async () => 'Please help me with this'
    },
    audioConverter: {
      toWav16kMono: async (buf) => buf
    }
  });

  const data = {
    object: {
      content: '{object}',
      id: 'msg-1',
      message: {
        messageType: 'voice-message',
        messageParameters: { file: { path: '/voice.ogg', mimetype: 'audio/ogg' } }
      }
    },
    actor: { id: 'users/alice', type: 'users' },
    target: { id: 'room-abc' }
  };

  const result = await processor.process(data);
  assert.ok(result.response.includes('\ud83c\udfa4'), 'Should have microphone emoji');
  assert.ok(result.response.includes('Please help me with this'), 'Should include transcript');
  assert.ok(result.response.includes('Sure, I can help!'), 'Should include agent response');
});

asyncTest('TC-PROC-003: process() handles transcription failure gracefully', async () => {
  const processor = createProcessor({
    agentLoop: {
      process: async (content) => `You said: ${content}`
    },
    filesClient: {
      readFileBuffer: async () => { throw new Error('File not found'); }
    },
    whisperClient: {
      transcribe: async () => 'should not reach'
    }
  });

  const data = {
    object: {
      content: '{object}',
      id: 'msg-1',
      message: {
        messageType: 'voice-message',
        messageParameters: { file: { path: '/voice.ogg', mimetype: 'audio/ogg' } }
      }
    },
    actor: { id: 'users/alice', type: 'users' },
    target: { id: 'room-abc' }
  };

  const result = await processor.process(data);
  // Should still get a response (the error message gets sent to agent)
  assert.ok(result.response, 'Should have a response even on transcription failure');
});

asyncTest('TC-PROC-004: process() skips not-addressed messages in group rooms', async () => {
  const processor = createProcessor({
    botNames: ['Molti'],
    ncRequestManager: {
      request: async () => ({
        body: { ocs: { data: { participantCount: 5 } } }
      })
    }
  });

  const data = createActivityStreamsData('Hey everyone, meeting at 3pm');
  const result = await processor.process(data);

  assert.strictEqual(result.skipped, true);
  assert.strictEqual(result.reason, 'not_addressed');
});

asyncTest('TC-PROC-005: process() responds to addressed messages in group rooms', async () => {
  const processor = createProcessor({
    botNames: ['Molti'],
    ncRequestManager: {
      request: async () => ({
        body: { ocs: { data: { participantCount: 5 } } }
      })
    },
    agentLoop: {
      process: async () => 'Here you go!'
    }
  });

  const data = createActivityStreamsData('Molti, what is the agenda?');
  const result = await processor.process(data);

  assert.ok(result.response, 'Should have a response');
  assert.ok(result.response.includes('Here you go!'));
});

// --- Smart-Mix Mode Tests ---
console.log('\n--- Smart-Mix Mode Tests ---\n');

test('TC-SMIX-001: _isSmartMixMode() false when no microPipeline', () => {
  // _isSmartMixMode() checks agentLoop.llmProvider — when there is no agentLoop
  // the smart-mix path cannot activate. A processor with no agentLoop (and no
  // microPipeline) must return false.
  const processor = createProcessor();
  // No agentLoop, no microPipeline — _isSmartMixMode must return false
  assert.strictEqual(processor._isSmartMixMode(), false);
});

test('TC-SMIX-002: _isSmartMixMode() false when ProviderChain (no resetConversation)', () => {
  const processor = createProcessor({
    microPipeline: {
      process: async () => 'local response'
    },
    agentLoop: {
      llmProvider: {
        primaryIsLocal: true
        // No resetConversation — simulates ProviderChain, not RouterChatBridge
      },
      process: async () => 'agent response'
    }
  });
  assert.strictEqual(processor._isSmartMixMode(), false);
});

test('TC-SMIX-003: _isSmartMixMode() true when RouterChatBridge with >1 providers', () => {
  const processor = createProcessor({
    microPipeline: {
      process: async () => 'local response'
    },
    agentLoop: {
      llmProvider: {
        resetConversation: function () {},
        chatProviders: new Map([['local', {}], ['cloud', {}]])
      },
      process: async () => 'agent response'
    }
  });
  assert.strictEqual(processor._isSmartMixMode(), true);
});

asyncTest('TC-SMIX-004: Greeting routed to MicroPipeline, AgentLoop not called', async () => {
  let agentLoopCalled = false;

  const processor = createProcessor({
    microPipeline: {
      _classify: async () => ({ intent: 'greeting' }),
      process: async () => 'Hello!'
    },
    agentLoop: {
      llmProvider: {
        resetConversation: function () {},
        clearLocalSkip: function () {},
        chatProviders: new Map([['local', {}], ['cloud', {}]])
      },
      process: async () => {
        agentLoopCalled = true;
        throw new Error('AgentLoop should not be called for greeting');
      }
    }
  });

  const data = createActivityStreamsData('Hi there');
  const result = await processor.process(data);

  assert.ok(result.response.includes('Hello!'), 'Response should contain MicroPipeline output');
  assert.strictEqual(agentLoopCalled, false, 'AgentLoop.process should NOT be called');
});

asyncTest('TC-SMIX-005: Task routed to AgentLoop with skipLocal', async () => {
  let skipLocalCalled = false;

  const processor = createProcessor({
    microPipeline: {
      _classify: async () => ({ intent: 'task' }),
      process: async () => { throw new Error('MicroPipeline.process should not be called for task'); }
    },
    agentLoop: {
      llmProvider: {
        resetConversation: function () {},
        skipLocalForConversation: function () { skipLocalCalled = true; },
        chatProviders: new Map([['local', {}], ['cloud', {}]])
      },
      process: async () => 'Task done'
    }
  });

  const data = createActivityStreamsData('Create a new board');
  const result = await processor.process(data);

  assert.ok(result.response.includes('Task done'), 'Response should contain AgentLoop output');
  assert.strictEqual(skipLocalCalled, true, 'skipLocalForConversation should be called');
});

asyncTest('TC-SMIX-006: Classification error falls through to AgentLoop without skip', async () => {
  let skipLocalCalled = false;

  const processor = createProcessor({
    microPipeline: {
      _classify: async () => { throw new Error('classify failed'); },
      process: async () => { throw new Error('MicroPipeline.process should not be called on classify error'); }
    },
    agentLoop: {
      llmProvider: {
        resetConversation: function () {},
        skipLocalForConversation: function () { skipLocalCalled = true; },
        chatProviders: new Map([['local', {}], ['cloud', {}]])
      },
      process: async () => 'Fallback response'
    }
  });

  const data = createActivityStreamsData('Something complex');
  const result = await processor.process(data);

  assert.ok(result.response.includes('Fallback response'), 'Response should contain AgentLoop fallback output');
  assert.strictEqual(skipLocalCalled, true, 'skipLocalForConversation should be called on classification error');
});

asyncTest('TC-SMIX-007: All-local mode still uses existing MicroPipeline path (regression)', async () => {
  const processor = createProcessor({
    microPipeline: {
      process: async () => 'Local pipeline response'
    },
    agentLoop: {
      llmProvider: {
        primaryIsLocal: true
        // No resetConversation — this is ProviderChain, not RouterChatBridge
      },
      process: async () => { throw new Error('AgentLoop should not be called in all-local mode'); }
    }
  });

  const data = createActivityStreamsData('Hello');
  const result = await processor.process(data);

  assert.ok(result.response.includes('Local pipeline response'), 'Response should come from MicroPipeline in all-local mode');
});

// --- Existing Behavior Tests ---
console.log('\n--- Existing Behavior Tests ---\n');

test('TC-EXTRACT-001: Extract from object.content', () => {
  const processor = createProcessor();
  const data = createActivityStreamsData('Hello world');
  const extracted = processor._extractMessage(data);
  assert.strictEqual(extracted.content, 'Hello world');
});

test('TC-EXTRACT-002: Extract user from actor.id', () => {
  const processor = createProcessor();
  const data = createActivityStreamsData('Hello', { user: 'alice' });
  const extracted = processor._extractMessage(data);
  assert.strictEqual(extracted.user, 'alice');
});

test('TC-EXTRACT-003: Extract token from target.id', () => {
  const processor = createProcessor();
  const data = createActivityStreamsData('Hello', { token: 'room-xyz' });
  const extracted = processor._extractMessage(data);
  assert.strictEqual(extracted.token, 'room-xyz');
});

test('TC-EXTRACT-004: Clean mention placeholders', () => {
  const processor = createProcessor();
  const data = createActivityStreamsData('{mention-user1} Hello');
  const extracted = processor._extractMessage(data);
  assert.strictEqual(extracted.content, 'Hello');
});

test('TC-EXTRACT-005: _rawMessage is included in extracted', () => {
  const processor = createProcessor();
  const data = createActivityStreamsData('Hello');
  const extracted = processor._extractMessage(data);
  assert.ok(extracted._rawMessage, 'Should have _rawMessage');
});

asyncTest('TC-FILTER-001: Skip bot own messages', async () => {
  const processor = createProcessor({ botUsername: 'moltagent' });
  const data = createActivityStreamsData('Hello', { user: 'moltagent' });
  const result = await processor.process(data);
  assert.strictEqual(result.skipped, true);
});

asyncTest('TC-FILTER-002: Skip messages with actorType bots', async () => {
  const processor = createProcessor();
  const data = createActivityStreamsData('Hello', { user: 'somebot', actorType: 'bots' });
  const result = await processor.process(data);
  assert.strictEqual(result.skipped, true);
});

// Summary
setTimeout(() => {
  summary();
  exitWithCode();
}, 500);
