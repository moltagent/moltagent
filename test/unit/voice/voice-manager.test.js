/**
 * VoiceManager Unit Tests
 *
 * Tests for mode-aware voice orchestration.
 *
 * Run: node test/unit/voice/voice-manager.test.js
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

const VoiceManager = require('../../../src/lib/voice/voice-manager');

// ============================================================
// Helpers
// ============================================================

function createMockSpeachesClient(transcript = 'Hello world') {
  return {
    transcribe: async () => transcript,
    isHealthy: async () => true
  };
}

function createMockFileClient(buffer = Buffer.from('fake audio')) {
  return {
    readFileBuffer: async () => buffer,
    nc: {
      request: async () => ({ status: 200, body: buffer })
    }
  };
}

function createMockAudioConverter() {
  return {
    toWav16kMono: async (buf) => buf
  };
}

function createMockLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {}
  };
}

function createVoiceManager(overrides = {}) {
  return new VoiceManager({
    speachesClient: overrides.speachesClient || createMockSpeachesClient(),
    fileClient: overrides.fileClient || createMockFileClient(),
    audioConverter: overrides.audioConverter || createMockAudioConverter(),
    config: overrides.config || {},
    logger: overrides.logger || createMockLogger()
  });
}

// ============================================================
// Test Suites
// ============================================================

console.log('\n=== VoiceManager Tests ===\n');

// --- isVoiceMessage() Tests ---
console.log('\n--- isVoiceMessage() Tests ---\n');

test('TC-VM-001: Returns true for messageType === voice-message', () => {
  const vm = createVoiceManager();
  const msg = { messageType: 'voice-message', messageParameters: {} };
  assert.strictEqual(vm.isVoiceMessage(msg), true);
});

test('TC-VM-002: Returns true for comment with audio/ogg mimetype', () => {
  const vm = createVoiceManager();
  const msg = {
    messageType: 'comment',
    messageParameters: { file: { mimetype: 'audio/ogg', path: '/test.ogg' } }
  };
  assert.strictEqual(vm.isVoiceMessage(msg), true);
});

test('TC-VM-003: Returns true for comment with audio/mpeg mimetype', () => {
  const vm = createVoiceManager();
  const msg = {
    messageType: 'comment',
    messageParameters: { file: { mimetype: 'audio/mpeg', path: '/test.mp3' } }
  };
  assert.strictEqual(vm.isVoiceMessage(msg), true);
});

test('TC-VM-004: Returns false for normal text comment', () => {
  const vm = createVoiceManager();
  const msg = { messageType: 'comment', messageParameters: {} };
  assert.strictEqual(vm.isVoiceMessage(msg), false);
});

test('TC-VM-005: Returns false for image file share', () => {
  const vm = createVoiceManager();
  const msg = {
    messageType: 'comment',
    messageParameters: { file: { mimetype: 'image/png', path: '/photo.png' } }
  };
  assert.strictEqual(vm.isVoiceMessage(msg), false);
});

// --- processVoiceMessage() Tests ---
console.log('\n--- processVoiceMessage() Tests ---\n');

asyncTest('TC-VM-006: Returns null when mode === off', async () => {
  const vm = createVoiceManager();
  vm.setMode('off');
  const msg = {
    messageType: 'voice-message',
    messageParameters: { file: { path: '/audio.ogg' } }
  };
  const result = await vm.processVoiceMessage(msg);
  assert.strictEqual(result, null);
});

asyncTest('TC-VM-007: Downloads audio via Talk/ folder WebDAV path', async () => {
  let downloadedPath = null;
  const vm = createVoiceManager({
    fileClient: {
      readFileBuffer: async (path) => {
        downloadedPath = path;
        return Buffer.from('audio from Talk folder');
      },
      nc: { ncUrl: 'https://nc.example.com' }
    }
  });
  vm.setMode('listen');
  const msg = {
    messageType: 'voice-message',
    messageParameters: {
      file: {
        path: 'recording.wav',
        link: 'https://nc.example.com/s/abcXYZ123',
        name: 'recording.wav'
      }
    }
  };
  await vm.processVoiceMessage(msg);
  assert.strictEqual(downloadedPath, 'Talk/recording.wav');
});

asyncTest('TC-VM-008: Calls speachesClient.transcribe with audio buffer', async () => {
  let transcribeBuffer = null;
  const vm = createVoiceManager({
    speachesClient: {
      transcribe: async (buf) => {
        transcribeBuffer = buf;
        return 'Test transcript';
      },
      isHealthy: async () => true
    }
  });
  vm.setMode('listen');
  const msg = {
    messageType: 'voice-message',
    messageParameters: { file: { path: '/audio.ogg', link: 'https://nc.example.com/s/abc' } }
  };
  await vm.processVoiceMessage(msg);
  assert.ok(Buffer.isBuffer(transcribeBuffer), 'Should pass a buffer to transcribe');
});

asyncTest('TC-VM-009: Returns transcript and duration on success', async () => {
  const vm = createVoiceManager({
    speachesClient: {
      transcribe: async () => 'Hello from voice',
      isHealthy: async () => true
    }
  });
  vm.setMode('full');
  const msg = {
    messageType: 'voice-message',
    messageParameters: { file: { path: '/audio.ogg' } }
  };
  const result = await vm.processVoiceMessage(msg);
  assert.strictEqual(result.transcript, 'Hello from voice');
  assert.ok(typeof result.duration === 'number');
  assert.ok(result.duration >= 0);
});

asyncTest('TC-VM-010: Returns null on empty transcript', async () => {
  const vm = createVoiceManager({
    speachesClient: {
      transcribe: async () => '   ',
      isHealthy: async () => true
    }
  });
  vm.setMode('listen');
  const msg = {
    messageType: 'voice-message',
    messageParameters: { file: { path: '/audio.ogg' } }
  };
  const result = await vm.processVoiceMessage(msg);
  assert.strictEqual(result, null);
});

asyncTest('TC-VM-011: Returns null when file download fails (graceful degradation)', async () => {
  const vm = createVoiceManager({
    fileClient: {
      readFileBuffer: async () => { throw new Error('404 Not Found'); },
      nc: { ncUrl: 'https://nc.example.com' }
    }
  });
  vm.setMode('listen');
  const msg = {
    messageType: 'voice-message',
    messageParameters: { file: { path: '/missing.ogg', name: 'missing.ogg' } }
  };
  const result = await vm.processVoiceMessage(msg);
  assert.strictEqual(result, null);
});

asyncTest('TC-VM-012: Returns null when transcription fails (graceful degradation)', async () => {
  const vm = createVoiceManager({
    speachesClient: {
      transcribe: async () => { throw new Error('Speaches down'); },
      isHealthy: async () => false
    }
  });
  vm.setMode('listen');
  const msg = {
    messageType: 'voice-message',
    messageParameters: { file: { path: '/audio.ogg' } }
  };
  const result = await vm.processVoiceMessage(msg);
  assert.strictEqual(result, null);
});

// --- setMode() Tests ---
console.log('\n--- setMode() Tests ---\n');

test('TC-VM-013: Sets mode to off', () => {
  const vm = createVoiceManager();
  vm.setMode('listen');
  vm.setMode('off');
  assert.strictEqual(vm.mode, 'off');
});

test('TC-VM-014: Sets mode to listen', () => {
  const vm = createVoiceManager();
  vm.setMode('listen');
  assert.strictEqual(vm.mode, 'listen');
});

test('TC-VM-015: Rejects invalid mode (stays unchanged)', () => {
  const vm = createVoiceManager();
  vm.setMode('listen');
  vm.setMode('invalid');
  assert.strictEqual(vm.mode, 'listen');
});

// --- _extractFileInfo() Tests ---
console.log('\n--- _extractFileInfo() Tests ---\n');

test('TC-VM-016: Extracts file info from messageParameters.file', () => {
  const vm = createVoiceManager();
  const file = { path: '/Talk/voice.ogg', link: 'https://nc.example.com/s/abc', id: '123' };
  const msg = { messageParameters: { file } };
  const info = vm._extractFileInfo(msg);
  assert.strictEqual(info.path, '/Talk/voice.ogg');
  assert.strictEqual(info.link, 'https://nc.example.com/s/abc');
  assert.strictEqual(info.id, '123');
});

test('TC-VM-017: Extracts from numbered file params (file0)', () => {
  const vm = createVoiceManager();
  const file0 = { path: '/Talk/clip0.ogg', name: 'clip0.ogg' };
  const msg = { messageParameters: { file0 } };
  const info = vm._extractFileInfo(msg);
  assert.strictEqual(info.path, '/Talk/clip0.ogg');
});

test('TC-VM-018: Returns null when no file info found', () => {
  const vm = createVoiceManager();
  const msg = { messageParameters: {} };
  assert.strictEqual(vm._extractFileInfo(msg), null);
});

// --- _downloadAudioBuffer() Tests ---
console.log('\n--- _downloadAudioBuffer() Tests ---\n');

asyncTest('TC-VM-021: Downloads via Talk/ folder path using filename', async () => {
  let downloadedPath = null;
  const vm = createVoiceManager({
    fileClient: {
      readFileBuffer: async (path) => {
        downloadedPath = path;
        return Buffer.from('audio from talk');
      },
      nc: { ncUrl: 'https://nc.example.com' }
    }
  });
  vm.setMode('listen');
  const msg = {
    messageType: 'voice-message',
    messageParameters: { file: { path: 'audio.ogg', name: 'audio.ogg' } }
  };
  await vm.processVoiceMessage(msg);
  assert.strictEqual(downloadedPath, 'Talk/audio.ogg');
});

asyncTest('TC-VM-022: Falls back to bare path when Talk folder fails', async () => {
  let callCount = 0;
  let lastPath = null;
  const vm = createVoiceManager({
    fileClient: {
      readFileBuffer: async (path) => {
        callCount++;
        lastPath = path;
        if (path.startsWith('Talk/')) {
          throw new Error('File not found');
        }
        return Buffer.from('audio from bare path');
      },
      nc: { ncUrl: 'https://nc.example.com' }
    }
  });
  vm.setMode('listen');
  const msg = {
    messageType: 'voice-message',
    messageParameters: { file: { path: '/direct/audio.ogg', name: 'audio.ogg' } }
  };
  await vm.processVoiceMessage(msg);
  assert.ok(callCount >= 2, 'Should try Talk/ folder first, then bare path');
  assert.strictEqual(lastPath, '/direct/audio.ogg');
});

// --- isAvailable() Tests ---
console.log('\n--- isAvailable() Tests ---\n');

asyncTest('TC-VM-019: Returns true when speachesClient.isHealthy() returns true', async () => {
  const vm = createVoiceManager({
    speachesClient: { isHealthy: async () => true, transcribe: async () => '' }
  });
  const result = await vm.isAvailable();
  assert.strictEqual(result, true);
});

asyncTest('TC-VM-020: Returns false when speachesClient is null', async () => {
  const vm = createVoiceManager({ speachesClient: null });
  vm.speachesClient = null;
  const result = await vm.isAvailable();
  assert.strictEqual(result, false);
});

// Summary
setTimeout(() => {
  summary();
  exitWithCode();
}, 100);
