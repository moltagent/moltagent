/**
 * SpeachesClient Unit Tests
 *
 * Tests for the Speaches STT/TTS HTTP client.
 *
 * Run: node test/unit/voice/speaches-client.test.js
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

const SpeachesClient = require('../../../src/lib/voice/speaches-client');

// ============================================================
// Test Suites
// ============================================================

console.log('\n=== SpeachesClient Tests ===\n');

// --- Constructor Tests ---
console.log('\n--- Constructor Tests ---\n');

test('TC-CTOR-001: Throws if no endpoint', () => {
  assert.throws(
    () => new SpeachesClient(),
    (err) => err.message.includes('requires an endpoint')
  );
});

test('TC-CTOR-002: Uses defaults for models/voice/timeout', () => {
  const client = new SpeachesClient({ endpoint: 'http://localhost:8014' });
  assert.strictEqual(client.baseUrl, 'http://localhost:8014');
  assert.strictEqual(client.sttModel, 'Systran/faster-whisper-large-v3');
  assert.strictEqual(client.ttsModel, 'piper');
  assert.strictEqual(client.ttsVoice, 'en_US-amy-medium');
  assert.strictEqual(client.timeout, 30000);
});

test('TC-CTOR-003: Accepts custom options', () => {
  const client = new SpeachesClient({
    endpoint: 'http://custom:9000/',
    sttModel: 'custom-stt',
    ttsModel: 'custom-tts',
    ttsVoice: 'de_DE-thorsten-high',
    timeout: 60000
  });
  assert.strictEqual(client.baseUrl, 'http://custom:9000');
  assert.strictEqual(client.sttModel, 'custom-stt');
  assert.strictEqual(client.ttsModel, 'custom-tts');
  assert.strictEqual(client.ttsVoice, 'de_DE-thorsten-high');
  assert.strictEqual(client.timeout, 60000);
});

// --- transcribe() Tests ---
console.log('\n--- transcribe() Tests ---\n');

asyncTest('TC-STT-001: Sends POST to /v1/audio/transcriptions', async () => {
  const originalFetch = global.fetch;
  let capturedUrl = null;
  let capturedOptions = null;

  global.fetch = async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return {
      ok: true,
      json: async () => ({ text: 'Hello world' })
    };
  };

  try {
    const client = new SpeachesClient({ endpoint: 'http://test:8014' });
    await client.transcribe(Buffer.from('fake audio'));

    assert.strictEqual(capturedUrl, 'http://test:8014/v1/audio/transcriptions');
    assert.strictEqual(capturedOptions.method, 'POST');
  } finally {
    global.fetch = originalFetch;
  }
});

asyncTest('TC-STT-002: Uses multipart form-data with file blob', async () => {
  const originalFetch = global.fetch;
  let capturedBody = null;

  global.fetch = async (url, options) => {
    capturedBody = options.body;
    return {
      ok: true,
      json: async () => ({ text: 'test' })
    };
  };

  try {
    const client = new SpeachesClient({ endpoint: 'http://test:8014' });
    await client.transcribe(Buffer.from('fake audio'));

    assert.ok(capturedBody instanceof FormData, 'Body should be FormData');
    assert.ok(capturedBody.get('file') instanceof Blob, 'file field should be a Blob');
  } finally {
    global.fetch = originalFetch;
  }
});

asyncTest('TC-STT-003: Includes model field', async () => {
  const originalFetch = global.fetch;
  let capturedBody = null;

  global.fetch = async (url, options) => {
    capturedBody = options.body;
    return {
      ok: true,
      json: async () => ({ text: 'test' })
    };
  };

  try {
    const client = new SpeachesClient({ endpoint: 'http://test:8014', sttModel: 'my-model' });
    await client.transcribe(Buffer.from('fake audio'));

    assert.strictEqual(capturedBody.get('model'), 'my-model');
  } finally {
    global.fetch = originalFetch;
  }
});

asyncTest('TC-STT-004: Includes language when provided', async () => {
  const originalFetch = global.fetch;
  let capturedBody = null;

  global.fetch = async (url, options) => {
    capturedBody = options.body;
    return {
      ok: true,
      json: async () => ({ text: 'Hallo' })
    };
  };

  try {
    const client = new SpeachesClient({ endpoint: 'http://test:8014' });
    await client.transcribe(Buffer.from('fake audio'), { language: 'de' });

    assert.strictEqual(capturedBody.get('language'), 'de');
  } finally {
    global.fetch = originalFetch;
  }
});

asyncTest('TC-STT-005: Throws on non-200 with error body', async () => {
  const originalFetch = global.fetch;

  global.fetch = async () => ({
    ok: false,
    status: 500,
    text: async () => 'Internal Server Error'
  });

  try {
    const client = new SpeachesClient({ endpoint: 'http://test:8014' });
    await assert.rejects(
      () => client.transcribe(Buffer.from('fake audio')),
      (err) => err.message.includes('Speaches STT error 500')
    );
  } finally {
    global.fetch = originalFetch;
  }
});

// --- synthesize() Tests ---
console.log('\n--- synthesize() Tests ---\n');

asyncTest('TC-TTS-001: Sends POST to /v1/audio/speech with JSON', async () => {
  const originalFetch = global.fetch;
  let capturedUrl = null;
  let capturedOptions = null;

  global.fetch = async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return {
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8)
    };
  };

  try {
    const client = new SpeachesClient({ endpoint: 'http://test:8014' });
    await client.synthesize('Hello world');

    assert.strictEqual(capturedUrl, 'http://test:8014/v1/audio/speech');
    assert.strictEqual(capturedOptions.method, 'POST');
    assert.strictEqual(capturedOptions.headers['Content-Type'], 'application/json');
  } finally {
    global.fetch = originalFetch;
  }
});

asyncTest('TC-TTS-002: Includes model, input, voice, response_format', async () => {
  const originalFetch = global.fetch;
  let capturedBody = null;

  global.fetch = async (url, options) => {
    capturedBody = JSON.parse(options.body);
    return {
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8)
    };
  };

  try {
    const client = new SpeachesClient({ endpoint: 'http://test:8014' });
    await client.synthesize('Hello');

    assert.strictEqual(capturedBody.model, 'piper');
    assert.strictEqual(capturedBody.input, 'Hello');
    assert.strictEqual(capturedBody.voice, 'en_US-amy-medium');
    assert.strictEqual(capturedBody.response_format, 'wav');
  } finally {
    global.fetch = originalFetch;
  }
});

asyncTest('TC-TTS-003: Returns Buffer', async () => {
  const originalFetch = global.fetch;

  global.fetch = async () => ({
    ok: true,
    arrayBuffer: async () => new Uint8Array([0x52, 0x49, 0x46, 0x46]).buffer
  });

  try {
    const client = new SpeachesClient({ endpoint: 'http://test:8014' });
    const result = await client.synthesize('Hello');

    assert.ok(Buffer.isBuffer(result), 'Result should be a Buffer');
    assert.strictEqual(result.length, 4);
  } finally {
    global.fetch = originalFetch;
  }
});

asyncTest('TC-TTS-004: Throws on non-200', async () => {
  const originalFetch = global.fetch;

  global.fetch = async () => ({
    ok: false,
    status: 422,
    text: async () => 'Unprocessable Entity'
  });

  try {
    const client = new SpeachesClient({ endpoint: 'http://test:8014' });
    await assert.rejects(
      () => client.synthesize('Hello'),
      (err) => err.message.includes('Speaches TTS error 422')
    );
  } finally {
    global.fetch = originalFetch;
  }
});

// --- isHealthy() Tests ---
console.log('\n--- isHealthy() Tests ---\n');

asyncTest('TC-HEALTH-001: Returns true on 200', async () => {
  const originalFetch = global.fetch;

  global.fetch = async () => ({ ok: true });

  try {
    const client = new SpeachesClient({ endpoint: 'http://test:8014' });
    const result = await client.isHealthy();
    assert.strictEqual(result, true);
  } finally {
    global.fetch = originalFetch;
  }
});

asyncTest('TC-HEALTH-002: Returns false on network error', async () => {
  const originalFetch = global.fetch;

  global.fetch = async () => {
    throw new Error('Connection refused');
  };

  try {
    const client = new SpeachesClient({ endpoint: 'http://test:8014' });
    const result = await client.isHealthy();
    assert.strictEqual(result, false);
  } finally {
    global.fetch = originalFetch;
  }
});

asyncTest('TC-HEALTH-003: Returns false on non-200', async () => {
  const originalFetch = global.fetch;

  global.fetch = async () => ({ ok: false, status: 503 });

  try {
    const client = new SpeachesClient({ endpoint: 'http://test:8014' });
    const result = await client.isHealthy();
    assert.strictEqual(result, false);
  } finally {
    global.fetch = originalFetch;
  }
});

// Summary
setTimeout(() => {
  summary();
  exitWithCode();
}, 100);
