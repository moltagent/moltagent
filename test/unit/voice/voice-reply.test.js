// Mock type: LEGACY — TODO: migrate to realistic mocks
/**
 * Voice Reply Unit Tests (V3)
 *
 * Tests for replyWithVoice(), _sanitizeForSpeech(), and pipeline integration.
 *
 * Run: node test/unit/voice/voice-reply.test.js
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

const VoiceManager = require('../../../src/lib/voice/voice-manager');
const MessageProcessor = require('../../../src/lib/server/message-processor');

// ============================================================
// Helpers
// ============================================================

function createMockLogger() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function createMockSpeachesClient(options = {}) {
  return {
    transcribe: async () => options.transcript || 'Hello world',
    synthesize: async (text, opts) => {
      if (options.synthesizeFail) throw new Error('TTS failed');
      return options.audioBuffer || Buffer.from('fake-audio-data');
    },
    isHealthy: async () => true
  };
}

function createMockNcRequestManager(options = {}) {
  return {
    ncUser: 'moltagent',
    request: async (url, opts) => {
      if (options.uploadFail && opts?.method === 'PUT') {
        throw new Error('Upload failed');
      }
      if (options.shareFail && opts?.method === 'POST') {
        throw new Error('Share failed');
      }
      return { status: 200, body: { ocs: { data: {} } } };
    }
  };
}

function createMockFileClient(buffer = Buffer.from('fake audio')) {
  return {
    readFileBuffer: async () => buffer,
    nc: { ncUrl: 'https://nc.example.com' }
  };
}

function createVoiceManager(overrides = {}) {
  return new VoiceManager({
    speachesClient: overrides.speachesClient || createMockSpeachesClient(),
    fileClient: overrides.fileClient || createMockFileClient(),
    audioConverter: overrides.audioConverter || { toWav16kMono: async (buf) => buf },
    ncRequestManager: overrides.ncRequestManager || createMockNcRequestManager(),
    config: overrides.config || {},
    logger: overrides.logger || createMockLogger()
  });
}

// ============================================================
// Test Suites
// ============================================================

console.log('\n=== Voice Reply Tests (V3) ===\n');

// --- replyWithVoice() Tests ---
console.log('\n--- replyWithVoice() Tests ---\n');

asyncTest('TC-VR-001: Returns {success: false, reason: voice_reply_disabled} when mode !== full', async () => {
  const vm = createVoiceManager();
  vm.setMode('listen');
  const result = await vm.replyWithVoice('room123', 'Hello');
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.reason, 'voice_reply_disabled');
});

asyncTest('TC-VR-002: Returns {success: false, reason: empty_text} for empty/null text', async () => {
  const vm = createVoiceManager();
  vm.setMode('full');

  const r1 = await vm.replyWithVoice('room123', '');
  assert.strictEqual(r1.success, false);
  assert.strictEqual(r1.reason, 'empty_text');

  const r2 = await vm.replyWithVoice('room123', null);
  assert.strictEqual(r2.success, false);
  assert.strictEqual(r2.reason, 'empty_text');

  const r3 = await vm.replyWithVoice('room123', '   ');
  assert.strictEqual(r3.success, false);
  assert.strictEqual(r3.reason, 'empty_text');
});

asyncTest('TC-VR-003: Calls speachesClient.synthesize() with sanitized text', async () => {
  let capturedText = null;
  const vm = createVoiceManager({
    speachesClient: {
      transcribe: async () => '',
      synthesize: async (text) => { capturedText = text; return Buffer.from('audio'); },
      isHealthy: async () => true
    }
  });
  vm.setMode('full');
  await vm.replyWithVoice('room123', '**Bold text** with `code`');
  assert.ok(capturedText !== null, 'synthesize should have been called');
  assert.ok(!capturedText.includes('**'), 'Should strip bold markers');
  assert.ok(!capturedText.includes('`'), 'Should strip inline code markers');
  assert.ok(capturedText.includes('Bold text'), 'Should preserve text content');
});

asyncTest('TC-VR-004: Uploads audio buffer via ncRequestManager PUT to Talk/voice-reply-{ts}.mp3', async () => {
  let uploadUrl = null;
  let uploadOpts = null;
  const vm = createVoiceManager({
    ncRequestManager: {
      ncUser: 'moltagent',
      request: async (url, opts) => {
        if (opts?.method === 'PUT') {
          uploadUrl = url;
          uploadOpts = opts;
        }
        return { status: 200, body: { ocs: { data: {} } } };
      }
    }
  });
  vm.setMode('full');
  await vm.replyWithVoice('room123', 'Hello world');
  assert.ok(uploadUrl, 'Should have made a PUT request');
  assert.ok(uploadUrl.includes('/remote.php/dav/files/moltagent/Talk/voice-reply-'), 'Path should target Talk folder');
  assert.ok(uploadUrl.endsWith('.mp3'), 'Should upload as .mp3');
  assert.strictEqual(uploadOpts.headers['Content-Type'], 'audio/mpeg');
});

asyncTest('TC-VR-005: Calls OCS Share API with shareType=10 and roomToken', async () => {
  let shareUrl = null;
  let shareBody = null;
  const vm = createVoiceManager({
    ncRequestManager: {
      ncUser: 'moltagent',
      request: async (url, opts) => {
        if (opts?.method === 'POST' && url.includes('files_sharing')) {
          shareUrl = url;
          shareBody = opts.body;
        }
        return { status: 200, body: { ocs: { data: {} } } };
      }
    }
  });
  vm.setMode('full');
  await vm.replyWithVoice('room_abc', 'Hello world');
  assert.ok(shareUrl, 'Should have called OCS Share API');
  assert.ok(shareUrl.includes('/ocs/v2.php/apps/files_sharing/api/v1/shares'));
  assert.ok(shareBody.includes('shareType=10'), 'Should use shareType 10 (Talk room)');
  assert.ok(shareBody.includes('shareWith=room_abc'), 'Should share with room token');
});

asyncTest('TC-VR-006: Returns {success: true, filename, duration} on success', async () => {
  const vm = createVoiceManager();
  vm.setMode('full');
  const result = await vm.replyWithVoice('room123', 'Hello world');
  assert.strictEqual(result.success, true);
  assert.ok(result.filename, 'Should have a filename');
  assert.ok(result.filename.startsWith('voice-reply-'), 'Filename should start with voice-reply-');
  assert.ok(result.filename.endsWith('.mp3'), 'Filename should end with .mp3');
  assert.ok(typeof result.size === 'number', 'Should have a size');
});

asyncTest('TC-VR-007: Returns {success: false} when TTS fails (graceful degradation)', async () => {
  const vm = createVoiceManager({
    speachesClient: createMockSpeachesClient({ synthesizeFail: true })
  });
  vm.setMode('full');
  const result = await vm.replyWithVoice('room123', 'Hello world');
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.reason, 'tts_failed');
});

asyncTest('TC-VR-008: Returns {success: false} when upload fails (graceful degradation)', async () => {
  const vm = createVoiceManager({
    ncRequestManager: createMockNcRequestManager({ uploadFail: true })
  });
  vm.setMode('full');
  const result = await vm.replyWithVoice('room123', 'Hello world');
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.reason, 'upload_failed');
});

// --- _sanitizeForSpeech() Tests ---
console.log('\n--- _sanitizeForSpeech() Tests ---\n');

test('TC-VR-009: Strips markdown headers', () => {
  const vm = createVoiceManager();
  assert.strictEqual(vm._sanitizeForSpeech('# Title'), 'Title');
  assert.strictEqual(vm._sanitizeForSpeech('## Sub Title'), 'Sub Title');
  assert.strictEqual(vm._sanitizeForSpeech('### Deep'), 'Deep');
});

test('TC-VR-010: Strips bold/italic markers', () => {
  const vm = createVoiceManager();
  assert.strictEqual(vm._sanitizeForSpeech('**bold**'), 'bold');
  assert.strictEqual(vm._sanitizeForSpeech('__underline__'), 'underline');
  assert.strictEqual(vm._sanitizeForSpeech('*italic*'), 'italic');
  assert.strictEqual(vm._sanitizeForSpeech('_emphasis_'), 'emphasis');
});

test('TC-VR-011: Strips inline code', () => {
  const vm = createVoiceManager();
  assert.strictEqual(vm._sanitizeForSpeech('Use `npm install` to install'), 'Use npm install to install');
});

test('TC-VR-012: Strips code blocks', () => {
  const vm = createVoiceManager();
  const input = 'Before\n```js\nconst x = 1;\n```\nAfter';
  const result = vm._sanitizeForSpeech(input);
  assert.ok(!result.includes('const x'), 'Code block content should be removed');
  assert.ok(result.includes('Before'), 'Text before code block preserved');
  assert.ok(result.includes('After'), 'Text after code block preserved');
});

test('TC-VR-013: Replaces URLs with "link"', () => {
  const vm = createVoiceManager();
  const result = vm._sanitizeForSpeech('Visit https://example.com for more');
  assert.ok(!result.includes('https://'), 'URL should be removed');
  assert.ok(result.includes('link'), 'URL should be replaced with "link"');
});

test('TC-VR-014: Strips bullet markers', () => {
  const vm = createVoiceManager();
  const result = vm._sanitizeForSpeech('- Item one\n- Item two\n* Item three\n1. Numbered');
  assert.ok(!result.includes('- '), 'Dash markers stripped');
  assert.ok(!result.includes('* '), 'Asterisk markers stripped');
  assert.ok(!result.includes('1. '), 'Numbered markers stripped');
  assert.ok(result.includes('Item one'), 'Text preserved');
});

test('TC-VR-015: Preserves normal conversational text unchanged', () => {
  const vm = createVoiceManager();
  const input = 'Sure, I can help you with that. Let me check the calendar.';
  assert.strictEqual(vm._sanitizeForSpeech(input), input);
});

// --- Pipeline Integration Tests ---
console.log('\n--- Pipeline Integration Tests ---\n');

asyncTest('TC-VR-016: Voice input + mode full → replyWithVoice called', async () => {
  let replyWithVoiceCalled = false;
  const mockVoiceManager = {
    mode: 'full',
    processVoiceMessage: async () => ({ transcript: 'Hello', duration: 100 }),
    replyWithVoice: async () => { replyWithVoiceCalled = true; return { success: true, filename: 'test.mp3', size: 100 }; },
    isVoiceMessage: () => true
  };

  const processor = new MessageProcessor({
    messageRouter: { route: async () => ({ response: 'Hi there', intent: 'chat' }) },
    commandHandler: { handle: async () => ({ response: '' }) },
    sendTalkReply: async () => true,
    auditLog: async () => {},
    botUsername: 'moltagent',
    voiceManager: mockVoiceManager,
    agentLoop: {
      process: async () => 'Hi there'
    }
  });

  const data = {
    actor: { id: 'users/testuser', name: 'testuser', type: 'users' },
    target: { id: 'room123' },
    object: {
      id: '456',
      content: '{file}',
      message: {
        id: '456',
        token: 'room123',
        messageType: 'voice-message',
        messageParameters: { file: { mimetype: 'audio/ogg', path: '/audio.ogg' } }
      }
    }
  };

  await processor.process(data);
  assert.ok(replyWithVoiceCalled, 'replyWithVoice should be called for voice input in full mode');
});

asyncTest('TC-VR-017: Voice input + mode listen → text reply only (no voice reply)', async () => {
  let replyWithVoiceCalled = false;
  const mockVoiceManager = {
    mode: 'listen',
    processVoiceMessage: async () => ({ transcript: 'Hello', duration: 100 }),
    replyWithVoice: async () => { replyWithVoiceCalled = true; return { success: true }; },
    isVoiceMessage: () => true
  };

  const processor = new MessageProcessor({
    messageRouter: { route: async () => ({ response: 'Hi there', intent: 'chat' }) },
    commandHandler: { handle: async () => ({ response: '' }) },
    sendTalkReply: async () => true,
    auditLog: async () => {},
    botUsername: 'moltagent',
    voiceManager: mockVoiceManager,
    agentLoop: {
      process: async () => 'Hi there'
    }
  });

  const data = {
    actor: { id: 'users/testuser', name: 'testuser', type: 'users' },
    target: { id: 'room123' },
    object: {
      id: '456',
      content: '{file}',
      message: {
        id: '456',
        token: 'room123',
        messageType: 'voice-message',
        messageParameters: { file: { mimetype: 'audio/ogg', path: '/audio.ogg' } }
      }
    }
  };

  await processor.process(data);
  assert.ok(!replyWithVoiceCalled, 'replyWithVoice should NOT be called in listen mode');
});

asyncTest('TC-VR-018: replyWithVoice failure → falls back to text reply (text still sent)', async () => {
  let textReplySent = false;
  const mockVoiceManager = {
    mode: 'full',
    processVoiceMessage: async () => ({ transcript: 'Hello', duration: 100 }),
    replyWithVoice: async () => ({ success: false, reason: 'tts_failed' }),
    isVoiceMessage: () => true
  };

  const processor = new MessageProcessor({
    messageRouter: { route: async () => ({ response: 'Hi there', intent: 'chat' }) },
    commandHandler: { handle: async () => ({ response: '' }) },
    sendTalkReply: async () => { textReplySent = true; return true; },
    auditLog: async () => {},
    botUsername: 'moltagent',
    voiceManager: mockVoiceManager,
    agentLoop: {
      process: async () => 'Hi there'
    }
  });

  const data = {
    actor: { id: 'users/testuser', name: 'testuser', type: 'users' },
    target: { id: 'room123' },
    object: {
      id: '456',
      content: '{file}',
      message: {
        id: '456',
        token: 'room123',
        messageType: 'voice-message',
        messageParameters: { file: { mimetype: 'audio/ogg', path: '/audio.ogg' } }
      }
    }
  };

  const result = await processor.process(data);
  assert.ok(textReplySent, 'Text reply should still be sent even when voice reply fails');
  assert.ok(result.response, 'Should return a response');
});

// Summary
(async () => {
  // Wait for all async tests to complete
  await new Promise(resolve => setTimeout(resolve, 200));
  summary();
  exitWithCode();
})();
