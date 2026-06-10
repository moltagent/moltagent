/**
 * OllamaToolsProvider Unit Tests
 *
 * Run: node test/unit/agent/providers/ollama-tools.test.js
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../../helpers/test-runner');

const { OllamaToolsProvider } = require('../../../../src/lib/agent/providers/ollama-tools');

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {}
};

// ============================================================
// Tests
// ============================================================

console.log('\n=== OllamaToolsProvider Tests ===\n');

test('constructor sets defaults', () => {
  const provider = new OllamaToolsProvider({}, silentLogger);
  assert.strictEqual(provider.endpoint, 'http://localhost:11434');
  assert.strictEqual(provider.model, 'phi4-mini');
  assert.strictEqual(provider.timeout, 300000);
});

test('constructor uses provided config', () => {
  const provider = new OllamaToolsProvider({
    endpoint: 'http://custom:11434',
    model: 'mistral:7b',
    timeout: 30000
  }, silentLogger);

  assert.strictEqual(provider.endpoint, 'http://custom:11434');
  assert.strictEqual(provider.model, 'mistral:7b');
  assert.strictEqual(provider.timeout, 30000);
});

test('endpoint trailing slash is stripped', () => {
  const provider = new OllamaToolsProvider({
    endpoint: 'http://localhost:11434/'
  }, silentLogger);
  assert.strictEqual(provider.endpoint, 'http://localhost:11434');
});

test('_parseResponse parses tool call response', () => {
  const provider = new OllamaToolsProvider({}, silentLogger);

  const result = provider._parseResponse({
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [{
        function: { name: 'deck_list_cards', arguments: { stack: 'Working' } }
      }]
    }
  });

  assert.ok(result.toolCalls);
  assert.strictEqual(result.toolCalls.length, 1);
  assert.strictEqual(result.toolCalls[0].name, 'deck_list_cards');
  assert.deepStrictEqual(result.toolCalls[0].arguments, { stack: 'Working' });
  assert.ok(result.toolCalls[0].id, 'Should have auto-generated id');
});

test('_parseResponse parses plain text response', () => {
  const provider = new OllamaToolsProvider({}, silentLogger);

  const result = provider._parseResponse({
    message: {
      role: 'assistant',
      content: 'Hello! How can I help?'
    }
  });

  assert.strictEqual(result.content, 'Hello! How can I help?');
  assert.strictEqual(result.toolCalls, null);
});

test('_parseResponse handles empty tool_calls array', () => {
  const provider = new OllamaToolsProvider({}, silentLogger);

  const result = provider._parseResponse({
    message: {
      role: 'assistant',
      content: 'No tools needed.',
      tool_calls: []
    }
  });

  assert.strictEqual(result.content, 'No tools needed.');
  assert.strictEqual(result.toolCalls, null);
});

test('_parseResponse handles missing message', () => {
  const provider = new OllamaToolsProvider({}, silentLogger);

  const result = provider._parseResponse({});
  assert.strictEqual(result.content, '');
  assert.strictEqual(result.toolCalls, null);
});

test('_parseResponse parses multiple tool calls', () => {
  const provider = new OllamaToolsProvider({}, silentLogger);

  const result = provider._parseResponse({
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [
        { function: { name: 'tool_a', arguments: { x: 1 } } },
        { function: { name: 'tool_b', arguments: { y: 2 } } }
      ]
    }
  });

  assert.strictEqual(result.toolCalls.length, 2);
  assert.strictEqual(result.toolCalls[0].name, 'tool_a');
  assert.strictEqual(result.toolCalls[1].name, 'tool_b');
});

// --- Tool timeout ---
console.log('\n--- Tool Timeout ---\n');

test('constructor defaults toolTimeout to 60000', () => {
  const provider = new OllamaToolsProvider({}, silentLogger);
  assert.strictEqual(provider.toolTimeout, 60000);
});

test('constructor uses provided toolTimeout', () => {
  const provider = new OllamaToolsProvider({
    toolTimeout: 45000
  }, silentLogger);
  assert.strictEqual(provider.toolTimeout, 45000);
});

// --- _fetchWithRetry ---
console.log('\n--- _fetchWithRetry ---\n');

asyncTest('_fetchWithRetry succeeds on first try', async () => {
  const provider = new OllamaToolsProvider({}, silentLogger);
  let attempts = 0;
  provider._fetch = async () => { attempts++; return { ok: true, json: async () => ({}) }; };
  const res = await provider._fetchWithRetry('http://test', {});
  assert.strictEqual(attempts, 1);
  assert.strictEqual(res.ok, true);
});

asyncTest('_fetchWithRetry retries on connection error then succeeds', async () => {
  const provider = new OllamaToolsProvider({}, silentLogger);
  let attempts = 0;
  provider._fetch = async () => {
    attempts++;
    if (attempts === 1) throw new Error('ECONNREFUSED');
    return { ok: true, json: async () => ({}) };
  };
  const res = await provider._fetchWithRetry('http://test', {}, 1, 10);
  assert.strictEqual(attempts, 2);
  assert.strictEqual(res.ok, true);
});

asyncTest('_fetchWithRetry throws after all retries exhausted', async () => {
  const provider = new OllamaToolsProvider({}, silentLogger);
  let attempts = 0;
  provider._fetch = async () => { attempts++; throw new Error('ECONNREFUSED'); };
  try {
    await provider._fetchWithRetry('http://test', {}, 1, 10);
    assert.fail('Should have thrown');
  } catch (err) {
    assert.strictEqual(attempts, 2);
    assert.ok(err.message.includes('ECONNREFUSED'));
  }
});

asyncTest('_fetchWithRetry does not retry HTTP errors (err.status set)', async () => {
  const provider = new OllamaToolsProvider({}, silentLogger);
  let attempts = 0;
  provider._fetch = async () => {
    attempts++;
    const err = new Error('Bad Request');
    err.status = 400;
    throw err;
  };
  try {
    await provider._fetchWithRetry('http://test', {}, 1, 10);
    assert.fail('Should have thrown');
  } catch (err) {
    assert.strictEqual(attempts, 1, 'Should not retry HTTP errors');
    assert.strictEqual(err.status, 400);
  }
});

// ============================================================
// keep_alive knob (#124)
// ============================================================

console.log('\n--- keep_alive knob (#124) ---\n');

// Override _fetch to capture the request body sent to /api/chat.
function captureBody(provider) {
  const captured = {};
  provider._fetch = async (_url, opts) => {
    captured.body = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ message: { role: 'assistant', content: 'ok' } }) };
  };
  return captured;
}

test('constructor: keepAlive is undefined by default', () => {
  const provider = new OllamaToolsProvider({}, silentLogger);
  assert.strictEqual(provider.keepAlive, undefined);
});

test('constructor: keepAlive reads config.keep_alive', () => {
  const provider = new OllamaToolsProvider({ keep_alive: -1 }, silentLogger);
  assert.strictEqual(provider.keepAlive, -1);
});

asyncTest('chat: omits keep_alive from the body when not configured (server governs)', async () => {
  const provider = new OllamaToolsProvider({}, silentLogger);
  const cap = captureBody(provider);
  await provider.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.ok(!('keep_alive' in cap.body), 'keep_alive must be absent so the Ollama server setting wins');
});

asyncTest('chat: sends configured keep_alive (e.g. -1 = indefinite)', async () => {
  const provider = new OllamaToolsProvider({ keep_alive: -1 }, silentLogger);
  const cap = captureBody(provider);
  await provider.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.strictEqual(cap.body.keep_alive, -1);
});

asyncTest('chat: sends a string keep_alive verbatim (e.g. "30m")', async () => {
  const provider = new OllamaToolsProvider({ keep_alive: '30m' }, silentLogger);
  const cap = captureBody(provider);
  await provider.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.strictEqual(cap.body.keep_alive, '30m');
});

// ============================================================
// Summary
// ============================================================

setTimeout(() => { const results = summary(); exitWithCode(results); }, 500);
