/**
 * WhisperClient Unit Tests
 *
 * Tests for the Whisper STT HTTP client.
 *
 * Run: node test/unit/providers/whisper-client.test.js
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

const WhisperClient = require('../../../src/lib/providers/whisper-client');

// ============================================================
// Test Suites
// ============================================================

console.log('\n=== WhisperClient Tests ===\n');

// --- Constructor Tests ---
console.log('\n--- Constructor Tests ---\n');

test('TC-CTOR-001: Default config values', () => {
  const client = new WhisperClient();
  assert.strictEqual(client.baseUrl, 'http://138.201.246.236:8014');
  assert.strictEqual(client.timeout, 60000);
  assert.strictEqual(client.model, 'small');
});

test('TC-CTOR-002: Custom config values', () => {
  const client = new WhisperClient({
    whisperUrl: 'http://localhost:9090/',
    whisperTimeout: 30000,
    whisperModel: 'large'
  });
  assert.strictEqual(client.baseUrl, 'http://localhost:9090');
  assert.strictEqual(client.timeout, 30000);
  assert.strictEqual(client.model, 'large');
});

test('TC-CTOR-003: Strips trailing slashes from URL', () => {
  const client = new WhisperClient({ whisperUrl: 'http://example.com///' });
  assert.strictEqual(client.baseUrl, 'http://example.com');
});

// --- transcribe() Tests ---
console.log('\n--- transcribe() Tests ---\n');

asyncTest('TC-TRANSCRIBE-001: Sends multipart POST with correct structure', async () => {
  // Mock global fetch
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
    const client = new WhisperClient({ whisperUrl: 'http://test:8178' });
    const result = await client.transcribe(Buffer.from('fake audio'), 'en');

    assert.strictEqual(capturedUrl, 'http://test:8178/v1/audio/transcriptions');
    assert.strictEqual(capturedOptions.method, 'POST');
    assert.ok(capturedOptions.body instanceof FormData);
    assert.ok(capturedOptions.signal, 'Should have abort signal');
    assert.strictEqual(result.text, 'Hello world');
    assert.strictEqual(result.confidence, null, 'No segments means null confidence');
  } finally {
    global.fetch = originalFetch;
  }
});

asyncTest('TC-TRANSCRIBE-002: Returns trimmed text', async () => {
  const originalFetch = global.fetch;

  global.fetch = async () => ({
    ok: true,
    json: async () => ({ text: '  Hello world  ' })
  });

  try {
    const client = new WhisperClient({ whisperUrl: 'http://test:8178' });
    const result = await client.transcribe(Buffer.from('fake audio'));
    assert.strictEqual(result.text, 'Hello world');
  } finally {
    global.fetch = originalFetch;
  }
});

asyncTest('TC-TRANSCRIBE-003: Returns empty string when text is missing', async () => {
  const originalFetch = global.fetch;

  global.fetch = async () => ({
    ok: true,
    json: async () => ({})
  });

  try {
    const client = new WhisperClient({ whisperUrl: 'http://test:8178' });
    const result = await client.transcribe(Buffer.from('fake audio'));
    assert.strictEqual(result.text, '');
    assert.strictEqual(result.confidence, null);
  } finally {
    global.fetch = originalFetch;
  }
});

asyncTest('TC-TRANSCRIBE-004: Throws on server error', async () => {
  const originalFetch = global.fetch;

  global.fetch = async () => ({
    ok: false,
    status: 500,
    text: async () => 'Internal Server Error'
  });

  try {
    const client = new WhisperClient({ whisperUrl: 'http://test:8178' });
    await assert.rejects(
      () => client.transcribe(Buffer.from('fake audio')),
      (err) => err.message.includes('Whisper API error 500')
    );
  } finally {
    global.fetch = originalFetch;
  }
});

asyncTest('TC-TRANSCRIBE-005: Throws on network error', async () => {
  const originalFetch = global.fetch;

  global.fetch = async () => {
    throw new Error('fetch failed');
  };

  try {
    const client = new WhisperClient({ whisperUrl: 'http://test:8178' });
    await assert.rejects(
      () => client.transcribe(Buffer.from('fake audio')),
      (err) => err.message.includes('fetch failed')
    );
  } finally {
    global.fetch = originalFetch;
  }
});

// --- healthCheck() Tests ---
console.log('\n--- healthCheck() Tests ---\n');

asyncTest('TC-HEALTH-001: Returns true on 200', async () => {
  const originalFetch = global.fetch;

  global.fetch = async () => ({ ok: true });

  try {
    const client = new WhisperClient({ whisperUrl: 'http://test:8178' });
    const result = await client.healthCheck();
    assert.strictEqual(result, true);
  } finally {
    global.fetch = originalFetch;
  }
});

asyncTest('TC-HEALTH-002: Returns false on connection error', async () => {
  const originalFetch = global.fetch;

  global.fetch = async () => {
    throw new Error('Connection refused');
  };

  try {
    const client = new WhisperClient({ whisperUrl: 'http://test:8178' });
    const result = await client.healthCheck();
    assert.strictEqual(result, false);
  } finally {
    global.fetch = originalFetch;
  }
});

asyncTest('TC-HEALTH-003: Returns false on non-200', async () => {
  const originalFetch = global.fetch;

  global.fetch = async () => ({ ok: false, status: 503 });

  try {
    const client = new WhisperClient({ whisperUrl: 'http://test:8178' });
    const result = await client.healthCheck();
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
