// Mock type: LEGACY — TODO: migrate to realistic mocks
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

// --- HITL-gate dedup (#108): id-keyed, classifier-free, timeout-proof ---
console.log('\n--- HITL-gate dedup (#108) ---\n');

// Stub enforcer with explicit gate verdicts. The new gate never calls the
// classifier; isConfirmationResponse is a spy that fails loudly if invoked, to
// prove the dedup is fully deterministic (timeout-proof by construction).
function makeGateEnforcer(over = {}) {
  let classifyCalls = 0;
  return {
    isPendingConfirmation: () => over.pending === true,
    isMessageConsumed: (id) => over.consumed === true && Number.isFinite(id) && id > 0,
    isConfirmationResponse: async () => { classifyCalls++; return true; },
    _classifyCalls: () => classifyCalls
  };
}

const jaData = (id = '16895') => createActivityStreamsData('ja', { user: 'alice', messageId: id });

asyncTest('TC-HITL-108-A: pending → deferred to poll, classifier never called (timeout-proof)', async () => {
  // The proven repro: a confirmation is pending and the reply arrives. The gate
  // defers deterministically — no classifier, so no double-fire on timeout.
  const enforcer = makeGateEnforcer({ pending: true, consumed: false });
  const processor = createProcessor({ agentLoop: { guardrailEnforcer: enforcer } });
  const result = await processor.process(jaData());
  assert.strictEqual(result.skipped, true);
  assert.strictEqual(result.reason, 'hitl_deferred_to_poll');
  assert.strictEqual(enforcer._classifyCalls(), 0, 'gate must not call the classifier');
});

asyncTest('TC-HITL-108-consumed: not pending but id ≤ watermark → already-consumed skip', async () => {
  // The other ordering: poll consumed the reply and cleared pending before this
  // webhook copy reached the gate. Layer B drops the redelivery by id.
  const enforcer = makeGateEnforcer({ pending: false, consumed: true });
  const processor = createProcessor({ agentLoop: { guardrailEnforcer: enforcer } });
  const result = await processor.process(jaData());
  assert.strictEqual(result.skipped, true);
  assert.strictEqual(result.reason, 'hitl_already_consumed');
  assert.strictEqual(enforcer._classifyCalls(), 0);
});

asyncTest('TC-HITL-108-passthrough: not pending and not consumed → gate does not skip', async () => {
  // A fresh message with no pending confirmation must NOT be swallowed by the
  // gate. Use OOO mode for a clean, network-free early return just past the
  // gate — reaching it proves the gate let the message through.
  const enforcer = makeGateEnforcer({ pending: false, consumed: false });
  const processor = createProcessor({ agentLoop: { guardrailEnforcer: enforcer } });
  processor.setMode('out-of-office');
  const result = await processor.process(jaData());
  assert.strictEqual(result.reason, 'ooo_auto_reply', 'gate let the message through to OOO handling');
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

asyncTest('TC-PROC-001: process() transcribes voice message with provenance tag and routes to agent', async () => {
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
      transcribe: async () => ({ text: 'Hello from voice', confidence: null })
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
  assert.strictEqual(transcribedText, '[Voice transcription]: "Hello from voice"', 'Agent should receive provenance-tagged transcript');
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
      transcribe: async () => ({ text: 'Please help me with this', confidence: null })
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
      transcribe: async () => ({ text: 'should not reach', confidence: null })
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

asyncTest('TC-SMIX-004: Greeting routed to AgentLoop in cloud-ok mode (trust boundary)', async () => {
  let agentLoopCalled = false;

  const processor = createProcessor({
    intentRouter: {
      classify: async () => ({ intent: 'greeting', domain: null, needsHistory: false, confidence: 0.9 })
    },
    microPipeline: {
      _classifyFallback: async () => ({ intent: 'chitchat' }),
      memoryContextEnricher: null,
      process: async () => { throw new Error('MicroPipeline should NOT be called in cloud-ok mode'); }
    },
    agentLoop: {
      llmProvider: {
        resetConversation: function () {},
        skipLocalForConversation: function () {},
        chatProviders: new Map([['local', {}], ['cloud', {}]])
      },
      process: async () => {
        agentLoopCalled = true;
        return 'Hi there! How can I help?';
      }
    }
  });

  const data = createActivityStreamsData('Hi there');
  const result = await processor.process(data);

  assert.ok(result.response.includes('Hi there! How can I help?'));
  assert.strictEqual(agentLoopCalled, true, 'AgentLoop should handle greetings in cloud-ok');
});

asyncTest('TC-SMIX-004b: Greeting in cloud-ok routes to AgentLoop, not MicroPipeline', async () => {
  let agentLoopCalled = false;
  let microPipelineCalled = false;

  const processor = createProcessor({
    intentRouter: {
      classify: async () => ({ intent: 'greeting', domain: null, needsHistory: false, confidence: 0.9 })
    },
    microPipeline: {
      _classifyFallback: async () => ({ intent: 'chitchat' }),
      memoryContextEnricher: null,
      process: async () => { microPipelineCalled = true; return 'Local response'; }
    },
    agentLoop: {
      llmProvider: {
        resetConversation: function () {},
        skipLocalForConversation: function () {},
        chatProviders: new Map([['local', {}], ['cloud', {}]])
      },
      process: async () => {
        agentLoopCalled = true;
        return 'Hi there! What can I help with?';
      }
    }
  });

  const data = createActivityStreamsData('Hey Molti, what mode are you in?');
  const result = await processor.process(data);

  // Trust boundary: in cloud-ok, MicroPipeline never fires
  assert.strictEqual(microPipelineCalled, false, 'MicroPipeline should NOT be called in cloud-ok');
  assert.strictEqual(agentLoopCalled, true, 'AgentLoop should handle all intents in cloud-ok');
  assert.ok(result.response.includes('Hi there'), 'Response should come from AgentLoop');
});

asyncTest('TC-SMIX-005: Complex intent routed to AgentLoop via IntentRouter', async () => {
  let agentLoopCalled = false;

  const processor = createProcessor({
    intentRouter: {
      classify: async () => ({ intent: 'complex', domain: null, needsHistory: true, confidence: 0.7 })
    },
    microPipeline: {
      _classifyFallback: async () => ({ intent: 'complex' }),
      memoryContextEnricher: null,
      process: async () => { throw new Error('MicroPipeline.process should not be called for complex'); }
    },
    agentLoop: {
      llmProvider: {
        resetConversation: function () {},
        chatProviders: new Map([['local', {}], ['cloud', {}]])
      },
      process: async () => { agentLoopCalled = true; return 'Complex done'; }
    }
  });

  const data = createActivityStreamsData('Analyze market trends and write a report');
  const result = await processor.process(data);

  assert.ok(result.response.includes('Complex done'), 'Response should contain AgentLoop output');
  assert.strictEqual(agentLoopCalled, true, 'AgentLoop should handle complex intents');
});

asyncTest('TC-SMIX-006: IntentRouter failure falls through to AgentLoop', async () => {
  let agentLoopCalled = false;

  const processor = createProcessor({
    intentRouter: {
      classify: async () => { throw new Error('IntentRouter failed'); }
    },
    microPipeline: {
      _classifyFallback: async () => ({ intent: 'chitchat' }),
      memoryContextEnricher: null,
      process: async () => { throw new Error('MicroPipeline.process should not be called on classify error'); }
    },
    agentLoop: {
      llmProvider: {
        resetConversation: function () {},
        chatProviders: new Map([['local', {}], ['cloud', {}]])
      },
      process: async () => { agentLoopCalled = true; return 'Fallback response'; }
    }
  });

  const data = createActivityStreamsData('Something complex');
  const result = await processor.process(data);

  assert.ok(result.response.includes('Fallback response'), 'Response should contain AgentLoop fallback output');
  assert.strictEqual(agentLoopCalled, true, 'AgentLoop should handle classification errors');
});

asyncTest('TC-SMIX-008: Confirmation intent routed to cloud (not local)', async () => {
  let agentLoopCalled = false;

  const processor = createProcessor({
    intentRouter: {
      classify: async () => ({ intent: 'confirmation', domain: null, needsHistory: true, confidence: 0.8 })
    },
    microPipeline: {
      _classifyFallback: async () => ({ intent: 'complex' }),
      process: async () => { throw new Error('MicroPipeline.process should not be called for confirmation'); }
    },
    agentLoop: {
      llmProvider: {
        resetConversation: function () {},
        skipLocalForConversation: function () {},
        chatProviders: new Map([['local', {}], ['cloud', {}]])
      },
      process: async () => {
        agentLoopCalled = true;
        return 'Confirmed!';
      }
    }
  });

  const data = createActivityStreamsData('yes');
  const result = await processor.process(data);

  assert.strictEqual(agentLoopCalled, true, 'AgentLoop should be called for confirmation');
  assert.ok(result.response.includes('Confirmed!'));
});

asyncTest('TC-SMIX-009: Selection intent routed to cloud (not local)', async () => {
  let agentLoopCalled = false;

  const processor = createProcessor({
    intentRouter: {
      classify: async () => ({ intent: 'selection', domain: null, needsHistory: true, confidence: 0.8 })
    },
    microPipeline: {
      _classifyFallback: async () => ({ intent: 'complex' }),
      process: async () => { throw new Error('MicroPipeline.process should not be called for selection'); }
    },
    agentLoop: {
      llmProvider: {
        resetConversation: function () {},
        skipLocalForConversation: function () {},
        chatProviders: new Map([['local', {}], ['cloud', {}]])
      },
      process: async () => {
        agentLoopCalled = true;
        return 'Selected option 2';
      }
    }
  });

  const data = createActivityStreamsData('2.');
  const result = await processor.process(data);

  assert.strictEqual(agentLoopCalled, true, 'AgentLoop should be called for selection');
  assert.ok(result.response.includes('Selected option 2'));
});

asyncTest('TC-SMIX-010: Domain action routed to AgentLoop in cloud-ok (trust boundary)', async () => {
  let agentLoopCalled = false;
  let microPipelineCalled = false;

  const processor = createProcessor({
    intentRouter: {
      classify: async () => ({ gate: 'action', intent: 'deck', domain: 'deck', needsHistory: false, compound: false, confidence: 0.8 })
    },
    microPipeline: {
      _classifyFallback: async () => ({ intent: 'deck' }),
      memoryContextEnricher: null,
      process: async () => {
        microPipelineCalled = true;
        return 'Local response';
      }
    },
    agentLoop: {
      llmProvider: {
        resetConversation: function () {},
        skipLocalForConversation: function () {},
        chatProviders: new Map([['local', {}], ['cloud', {}]])
      },
      process: async () => {
        agentLoopCalled = true;
        return 'Card created!';
      }
    }
  });

  const data = createActivityStreamsData('create a task for the feature');
  const result = await processor.process(data);

  assert.strictEqual(microPipelineCalled, false, 'MicroPipeline should NOT handle domain actions in cloud-ok');
  assert.strictEqual(agentLoopCalled, true, 'AgentLoop should handle domain actions in cloud-ok');
  assert.ok(result.response.includes('Card created!'));
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

// --- Voice Provenance Tagging Tests ---
console.log('\n--- Voice Provenance Tagging ---\n');

test('TC-PROV-001: _tagVoiceTranscription tags voice-only (no confidence)', () => {
  const processor = createProcessor();
  const result = processor._tagVoiceTranscription('hello world', null, null);
  assert.strictEqual(result, '[Voice transcription]: "hello world"');
});

test('TC-PROV-002: _tagVoiceTranscription includes confidence when available', () => {
  const processor = createProcessor();
  const result = processor._tagVoiceTranscription('hello world', 0.87, null);
  assert.strictEqual(result, '[Voice transcription, confidence: 87%]: "hello world"');
});

test('TC-PROV-003: _tagVoiceTranscription preserves typed text alongside voice', () => {
  const processor = createProcessor();
  const result = processor._tagVoiceTranscription('check this recording', null, 'Look at this');
  assert.strictEqual(result, 'Look at this\n[Voice transcription]: "check this recording"');
});

test('TC-PROV-004: _tagVoiceTranscription with typed text AND confidence', () => {
  const processor = createProcessor();
  const result = processor._tagVoiceTranscription('urgent task', 0.92, 'Please handle:');
  assert.strictEqual(result, 'Please handle:\n[Voice transcription, confidence: 92%]: "urgent task"');
});

test('TC-PROV-005: _extractMessage detects voice with typed text alongside audio', () => {
  const processor = createProcessor();
  const data = {
    object: {
      content: 'Check this out',
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
  assert.strictEqual(extracted._isVoice, true, 'Should detect voice even with typed text');
  assert.strictEqual(extracted._typedContent, 'Check this out', 'Should preserve typed content');
  assert.strictEqual(extracted.content, 'Check this out', 'Content should be the typed text');
});

test('TC-PROV-006: _extractMessage sets _typedContent null for voice-only', () => {
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
  assert.strictEqual(extracted._typedContent, null, 'Voice-only should have null typedContent');
});

test('TC-PROV-007: Typed-only message has no voice tags', () => {
  const processor = createProcessor();
  const data = {
    object: {
      content: 'Just a normal text message',
      id: 'msg-1',
      message: { messageParameters: {} }
    },
    actor: { id: 'users/alice', type: 'users' },
    target: { id: 'room-abc' }
  };

  const extracted = processor._extractMessage(data);
  assert.strictEqual(extracted._isVoice, false, 'Text-only should not be voice');
  assert.strictEqual(extracted._typedContent, null, 'Text-only should have null typedContent');
  assert.strictEqual(extracted.content, 'Just a normal text message', 'Content unchanged');
});

asyncTest('TC-PROV-008: process() voice-only message tagged in agent context', async () => {
  let agentInput = null;

  const processor = createProcessor({
    agentLoop: {
      process: async (content) => {
        agentInput = content;
        return 'Got it';
      }
    },
    voiceManager: {
      mode: 'listen',
      processVoiceMessage: async () => ({ transcript: 'remind me tomorrow', confidence: 0.85, duration: 1200 })
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

  await processor.process(data);
  assert.strictEqual(agentInput, '[Voice transcription, confidence: 85%]: "remind me tomorrow"',
    'Agent should receive provenance-tagged transcription with confidence');
});

asyncTest('TC-PROV-009: process() voice + typed text both present, only transcription tagged', async () => {
  let agentInput = null;

  const processor = createProcessor({
    agentLoop: {
      process: async (content) => {
        agentInput = content;
        return 'Got it';
      }
    },
    voiceManager: {
      mode: 'listen',
      processVoiceMessage: async () => ({ transcript: 'more details here', confidence: null, duration: 800 })
    }
  });

  const data = {
    object: {
      content: 'Check this recording',
      id: 'msg-1',
      message: {
        messageType: 'voice-message',
        messageParameters: { file: { path: '/voice.ogg', mimetype: 'audio/ogg' } }
      }
    },
    actor: { id: 'users/alice', type: 'users' },
    target: { id: 'room-abc' }
  };

  await processor.process(data);
  assert.strictEqual(agentInput, 'Check this recording\n[Voice transcription]: "more details here"',
    'Typed text should be present and untagged, transcription should be tagged');
});

asyncTest('TC-PROV-010: process() voice transcription without confidence omits confidence from tag', async () => {
  let agentInput = null;

  const processor = createProcessor({
    agentLoop: {
      process: async (content) => {
        agentInput = content;
        return 'Done';
      }
    },
    voiceManager: {
      mode: 'listen',
      processVoiceMessage: async () => ({ transcript: 'hello there', confidence: null, duration: 500 })
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

  await processor.process(data);
  assert.strictEqual(agentInput, '[Voice transcription]: "hello there"',
    'Should not include confidence when null');
  assert.ok(!agentInput.includes('confidence'), 'No confidence substring when null');
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

// --- OOO Auto-Responder Tests ---
console.log('\n--- OOO Auto-Responder Tests ---\n');

asyncTest('TC-OOO-001: OOO mode sends auto-reply and returns early', async () => {
  const sendTalkReply = createMockSendTalkReply();
  const processor = createProcessor({
    sendTalkReply,
    agentLoop: {
      process: async () => { throw new Error('AgentLoop should NOT be called in OOO mode'); }
    }
  });
  processor.setMode('out-of-office');

  const data = createActivityStreamsData('Can you help me?');
  const result = await processor.process(data);

  assert.strictEqual(result.reason, 'ooo_auto_reply', 'Should return ooo_auto_reply reason');
  assert.ok(result.response.includes('out of office'), 'Response should mention out of office');
  assert.strictEqual(result.skipped, false, 'Should not be marked as skipped');

  const calls = sendTalkReply.getCalls();
  assert.strictEqual(calls.length, 1, 'Should send exactly one reply');
  assert.ok(calls[0].message.includes('out of office'), 'Reply should mention out of office');
});

asyncTest('TC-OOO-002: OOO mode skips agent loop processing', async () => {
  let agentLoopCalled = false;
  const processor = createProcessor({
    agentLoop: {
      process: async () => {
        agentLoopCalled = true;
        return 'should not happen';
      }
    }
  });
  processor.setMode('out-of-office');

  const data = createActivityStreamsData('Hello');
  await processor.process(data);

  assert.strictEqual(agentLoopCalled, false, 'AgentLoop should NOT be called in OOO mode');
});

asyncTest('TC-OOO-003: Non-OOO modes process normally', async () => {
  const processor = createProcessor({
    agentLoop: {
      process: async () => 'Normal response'
    }
  });
  processor.setMode('full-auto');

  const data = createActivityStreamsData('Hello');
  const result = await processor.process(data);

  assert.ok(result.response.includes('Normal response'), 'Should process normally in full-auto');
  assert.strictEqual(result.reason, undefined, 'Should not have ooo reason');
});

asyncTest('TC-OOO-004: setMode() stores the active mode', async () => {
  const processor = createProcessor();

  assert.strictEqual(processor.activeMode, null, 'Should start as null');

  processor.setMode('focus-mode');
  assert.strictEqual(processor.activeMode, 'focus-mode', 'Should store focus-mode');

  processor.setMode('out-of-office');
  assert.strictEqual(processor.activeMode, 'out-of-office', 'Should store out-of-office');
});

// --- Web-fallback egress decision (#136) ---
// decideWebFallback is pure: it encodes the two gates that sit AHEAD of the
// searchPolicy preference. The precedence is the point — trust and workspace
// truth must beat searchPolicy, never the other way round. These cases pin that
// ordering so a future searchPolicy tweak can't silently widen egress.
console.log('\n--- Web-fallback egress decision (#136) ---\n');

const decide = (over) => MessageProcessor.decideWebFallback({
  wantsMore: true, trust: 'cloud-ok', workspaceAnswered: false, searchPolicy: 'research', ...over
});

test('TC-WEB-136-01: sufficient local knowledge → none (no egress considered)', () => {
  const d = decide({ wantsMore: false });
  assert.strictEqual(d.action, 'none');
});

test('TC-WEB-136-02: cloud-ok + research → fire', () => {
  assert.strictEqual(decide({}).action, 'fire');
});

test('TC-WEB-136-03: internal-first → offer (never auto-fires)', () => {
  assert.strictEqual(decide({ searchPolicy: 'internal-first' }).action, 'offer');
});

test('TC-WEB-136-04: sovereign → suppress', () => {
  assert.strictEqual(decide({ searchPolicy: 'sovereign' }).action, 'suppress');
});

test('TC-WEB-136-05: trust:local-only suppresses even under research policy (trust is the single control)', () => {
  // The gate that matters most: searchPolicy can only narrow within cloud-ok,
  // it cannot widen past trust. local-only + research must NOT fire.
  const d = decide({ trust: 'local-only', searchPolicy: 'research' });
  assert.strictEqual(d.action, 'suppress');
  assert.ok(d.reason.includes('local-only'), 'reason should name the trust gate');
});

test('TC-WEB-136-06: trust:local-only beats workspace gate too (ordering is deterministic)', () => {
  assert.strictEqual(decide({ trust: 'local-only', workspaceAnswered: true }).action, 'suppress');
});

test('TC-WEB-136-07: workspace probe answered suppresses web even under research policy', () => {
  // "found 5 deck cards, escaped to web anyway" — the case #136 closes.
  const d = decide({ workspaceAnswered: true, searchPolicy: 'research' });
  assert.strictEqual(d.action, 'suppress');
  assert.ok(d.reason.includes('workspace'), 'reason should name the workspace gate');
});

test('TC-WEB-136-08: null trust falls through to searchPolicy (resolver-absent, no widening)', () => {
  // trust unknown (resolver absent) must not be treated as cloud permission;
  // it simply defers to searchPolicy. research → fire, sovereign → suppress.
  assert.strictEqual(decide({ trust: null, searchPolicy: 'research' }).action, 'fire');
  assert.strictEqual(decide({ trust: null, searchPolicy: 'sovereign' }).action, 'suppress');
});

// --- #133: _smartMixClassify domain custody ---
console.log('\n--- #133: _smartMixClassify domain custody ---\n');

// Helper: build a smart-mix-capable processor with a stubbed intentRouter
function createSmartMixProcessor(classifyResult) {
  return createProcessor({
    intentRouter: {
      classify: async () => classifyResult
    },
    microPipeline: {
      _classifyFallback: async () => ({ intent: 'chitchat' }),
      memoryContextEnricher: null,
      process: async () => 'local response'
    },
    agentLoop: {
      llmProvider: {
        resetConversation: function () {},
        skipLocalForConversation: function () {},
        chatProviders: new Map([['local', {}], ['cloud', {}]])
      },
      process: async () => 'agent response'
    }
  });
}

asyncTest('TC-D133-01: _smartMixClassify returns domain on confirmation path', async () => {
  const proc = createSmartMixProcessor({ gate: 'confirmation', intent: 'confirmation', domain: null, needsHistory: true, confidence: 0.9, compound: false });
  const result = await proc._smartMixClassify('yes', null, null, null);
  assert.ok('domain' in result, '_smartMixClassify result must have domain key');
});

asyncTest('TC-D133-02: _smartMixClassify returns domain on confirmation_declined path', async () => {
  const proc = createSmartMixProcessor({ gate: 'confirmation_declined', intent: 'confirmation_declined', domain: null, needsHistory: false, confidence: 0.9, compound: false });
  const result = await proc._smartMixClassify('no', null, null, null);
  assert.ok('domain' in result, '_smartMixClassify result must have domain key');
});

asyncTest('TC-D133-03: _smartMixClassify preserves domain on knowledge path (deck domain survives)', async () => {
  const proc = createSmartMixProcessor({ gate: 'knowledge', intent: 'knowledge', domain: 'deck', needsHistory: false, confidence: 0.8, compound: false });
  const result = await proc._smartMixClassify('what cards do I have', null, null, null);
  assert.ok('domain' in result, 'domain key must be present');
  assert.strictEqual(result.domain, 'deck', 'deck domain must survive the knowledge path');
});

asyncTest('TC-D133-04: _smartMixClassify returns domain on compound+domain path', async () => {
  const proc = createSmartMixProcessor({ gate: 'compound', intent: 'deck', domain: 'deck', needsHistory: false, confidence: 0.8, compound: true });
  const result = await proc._smartMixClassify('create a card and send an email', null, null, null);
  assert.ok('domain' in result, 'domain key must be present');
});

asyncTest('TC-D133-05: _smartMixClassify catch-all cloud path — calendar action carries domain', async () => {
  // Specimen: {gate:'action',intent:'calendar',domain:'calendar',compound:false}
  // → domain==='calendar', useLocal===false
  const proc = createSmartMixProcessor({ gate: 'action', intent: 'calendar', domain: 'calendar', needsHistory: false, confidence: 0.9, compound: false });
  const result = await proc._smartMixClassify('book a meeting', null, null, null);
  assert.ok('domain' in result, 'domain key must be present on catch-all cloud path');
  assert.strictEqual(result.domain, 'calendar', 'domain must be calendar');
  assert.strictEqual(result.useLocal, false, 'calendar action must route to cloud in smart-mix mode');
});

asyncTest('TC-D133-06: _smartMixClassify classify-throws → {gate:null, domain:null, intent:\'error\'} no crash', async () => {
  const proc = createProcessor({
    intentRouter: {
      classify: async () => { throw new Error('classification failed'); }
    },
    microPipeline: {
      _classifyFallback: async () => ({ intent: 'chitchat' }),
      memoryContextEnricher: null,
      process: async () => 'local response'
    },
    agentLoop: {
      llmProvider: {
        resetConversation: function () {},
        chatProviders: new Map([['local', {}], ['cloud', {}]])
      },
      process: async () => 'fallback'
    }
  });
  const result = await proc._smartMixClassify('anything', null, null, null);
  assert.ok('domain' in result, 'domain key must be present even on error path');
  assert.strictEqual(result.domain, null, 'error path domain must be null');
  assert.strictEqual(result.gate, null, 'error path gate must be null');
  assert.strictEqual(result.intent, 'error');
});

asyncTest('TC-D133-07: _smartMixClassify universal invariant — every path has domain key', async () => {
  // Run all shaped inputs and assert 'domain' in result for each
  const shapes = [
    { gate: 'confirmation', intent: 'confirmation', domain: null, needsHistory: true, confidence: 0.9, compound: false },
    { gate: 'confirmation_declined', intent: 'confirmation_declined', domain: null, needsHistory: false, confidence: 0.9, compound: false },
    { gate: 'knowledge', intent: 'knowledge', domain: 'deck', needsHistory: false, confidence: 0.8, compound: false },
    { gate: 'compound', intent: 'deck', domain: 'deck', needsHistory: false, confidence: 0.8, compound: true },
    { gate: 'action', intent: 'calendar', domain: 'calendar', needsHistory: false, confidence: 0.9, compound: false }
  ];
  for (const shape of shapes) {
    const proc = createSmartMixProcessor(shape);
    const result = await proc._smartMixClassify('test', null, null, null);
    assert.ok('domain' in result, `domain key missing for shape: ${JSON.stringify(shape)}`);
  }
});

// Summary
setTimeout(() => {
  summary();
  exitWithCode();
}, 500);
