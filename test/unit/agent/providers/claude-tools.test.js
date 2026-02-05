/**
 * ClaudeToolsProvider Unit Tests
 *
 * Run: node test/unit/agent/providers/claude-tools.test.js
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../../helpers/test-runner');

const { ClaudeToolsProvider } = require('../../../../src/lib/agent/providers/claude-tools');

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {}
};

// ============================================================
// Tests
// ============================================================

console.log('\n=== ClaudeToolsProvider Tests ===\n');

test('constructor sets defaults', () => {
  const provider = new ClaudeToolsProvider({
    getApiKey: async () => 'test'
  }, silentLogger);

  assert.strictEqual(provider.model, 'claude-opus-4-6');
  assert.strictEqual(provider.maxTokens, 1024);
  assert.strictEqual(provider.timeout, 30000);
});

test('constructor uses provided config', () => {
  const provider = new ClaudeToolsProvider({
    model: 'claude-opus-4-6',
    maxTokens: 2048,
    timeout: 60000,
    getApiKey: async () => 'test'
  }, silentLogger);

  assert.strictEqual(provider.model, 'claude-opus-4-6');
  assert.strictEqual(provider.maxTokens, 2048);
  assert.strictEqual(provider.timeout, 60000);
});

test('_parseResponse parses text response', () => {
  const provider = new ClaudeToolsProvider({
    getApiKey: async () => 'test'
  }, silentLogger);

  const result = provider._parseResponse({
    content: [
      { type: 'text', text: 'Hello!' }
    ]
  });

  assert.strictEqual(result.content, 'Hello!');
  assert.strictEqual(result.toolCalls, null);
});

test('_parseResponse parses tool_use response', () => {
  const provider = new ClaudeToolsProvider({
    getApiKey: async () => 'test'
  }, silentLogger);

  const result = provider._parseResponse({
    content: [
      { type: 'tool_use', id: 'toolu_123', name: 'deck_list_cards', input: { stack: 'Working' } }
    ]
  });

  assert.ok(result.toolCalls);
  assert.strictEqual(result.toolCalls.length, 1);
  assert.strictEqual(result.toolCalls[0].id, 'toolu_123');
  assert.strictEqual(result.toolCalls[0].name, 'deck_list_cards');
  assert.deepStrictEqual(result.toolCalls[0].arguments, { stack: 'Working' });
});

test('_parseResponse handles mixed text + tool_use', () => {
  const provider = new ClaudeToolsProvider({
    getApiKey: async () => 'test'
  }, silentLogger);

  const result = provider._parseResponse({
    content: [
      { type: 'text', text: 'Let me check that.' },
      { type: 'tool_use', id: 'toolu_1', name: 'calendar_list_events', input: {} }
    ]
  });

  assert.strictEqual(result.content, 'Let me check that.');
  assert.strictEqual(result.toolCalls.length, 1);
  assert.strictEqual(result.toolCalls[0].name, 'calendar_list_events');
});

test('_parseResponse handles empty content', () => {
  const provider = new ClaudeToolsProvider({
    getApiKey: async () => 'test'
  }, silentLogger);

  const result = provider._parseResponse({ content: [] });
  assert.strictEqual(result.content, '');
  assert.strictEqual(result.toolCalls, null);
});

test('_parseResponse handles missing content', () => {
  const provider = new ClaudeToolsProvider({
    getApiKey: async () => 'test'
  }, silentLogger);

  const result = provider._parseResponse({});
  assert.strictEqual(result.content, '');
  assert.strictEqual(result.toolCalls, null);
});

test('_parseResponse handles multiple tool_use blocks', () => {
  const provider = new ClaudeToolsProvider({
    getApiKey: async () => 'test'
  }, silentLogger);

  const result = provider._parseResponse({
    content: [
      { type: 'tool_use', id: 'toolu_1', name: 'tool_a', input: { x: 1 } },
      { type: 'tool_use', id: 'toolu_2', name: 'tool_b', input: { y: 2 } }
    ]
  });

  assert.strictEqual(result.toolCalls.length, 2);
  assert.strictEqual(result.toolCalls[0].name, 'tool_a');
  assert.strictEqual(result.toolCalls[1].name, 'tool_b');
});

// ============================================================
// 429 Retry-with-Backoff Tests (sync)
// ============================================================

test('constructor defaults maxRetries to 3', () => {
  const provider = new ClaudeToolsProvider({
    getApiKey: async () => 'test'
  }, silentLogger);

  assert.strictEqual(provider.maxRetries, 3);
});

test('constructor accepts custom maxRetries', () => {
  const provider = new ClaudeToolsProvider({
    getApiKey: async () => 'test',
    maxRetries: 5
  }, silentLogger);

  assert.strictEqual(provider.maxRetries, 5);
});

test('_parseRetryAfter parses seconds format', () => {
  const provider = new ClaudeToolsProvider({
    getApiKey: async () => 'test'
  }, silentLogger);

  const headers = { get: (key) => key === 'retry-after' ? '30' : null };

  const ms = provider._parseRetryAfter(headers);
  assert.strictEqual(ms, 30000);
});

test('_parseRetryAfter parses HTTP-date format', () => {
  const provider = new ClaudeToolsProvider({
    getApiKey: async () => 'test'
  }, silentLogger);

  const futureDate = new Date(Date.now() + 10000).toUTCString();
  const headers = { get: (key) => key === 'retry-after' ? futureDate : null };

  const ms = provider._parseRetryAfter(headers);
  assert.ok(ms >= 8000 && ms <= 11000, `Expected ~10000ms, got ${ms}ms`);
});

test('_parseRetryAfter returns exponential backoff with jitter when no header', () => {
  const provider = new ClaudeToolsProvider({
    getApiKey: async () => 'test'
  }, silentLogger);

  const headers = { get: () => null };

  // attempt 0 → 2^0 * 1000 + jitter = 1000-2000ms
  const ms0 = provider._parseRetryAfter(headers, 0);
  assert.ok(ms0 >= 1000 && ms0 <= 2000, `Attempt 0: expected 1000-2000ms, got ${ms0}ms`);

  // attempt 1 → 2^1 * 1000 + jitter = 2000-3000ms
  const ms1 = provider._parseRetryAfter(headers, 1);
  assert.ok(ms1 >= 2000 && ms1 <= 3000, `Attempt 1: expected 2000-3000ms, got ${ms1}ms`);

  // attempt 2 → 2^2 * 1000 + jitter = 4000-5000ms
  const ms2 = provider._parseRetryAfter(headers, 2);
  assert.ok(ms2 >= 4000 && ms2 <= 5000, `Attempt 2: expected 4000-5000ms, got ${ms2}ms`);
});

// All async tests must run sequentially (they mock global.fetch)
(async () => {
  console.log('\n--- Async Tests ---\n');

  await asyncTest('chat throws when API key not available', async () => {
    const provider = new ClaudeToolsProvider({
      getApiKey: async () => null
    }, silentLogger);

    try {
      await provider.chat({ system: '', messages: [], tools: [] });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('API key not available'));
    }
  });

  await asyncTest('consecutive tool results merge into single user message', async () => {
    let capturedBody;
    const origFetch = global.fetch;
    global.fetch = async (_url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: 'text', text: 'Done.' }] })
      };
    };

    try {
      const provider = new ClaudeToolsProvider({
        getApiKey: async () => 'test-key'
      }, silentLogger);

      await provider.chat({
        system: 'Test',
        messages: [
          { role: 'user', content: 'Do both' },
          {
            role: 'assistant', content: '',
            tool_calls: [
              { id: 'tc_1', type: 'function', function: { name: 'tool_a', arguments: '{}' } },
              { id: 'tc_2', type: 'function', function: { name: 'tool_b', arguments: '{}' } }
            ]
          },
          { role: 'tool', tool_call_id: 'tc_1', content: 'Result A' },
          { role: 'tool', tool_call_id: 'tc_2', content: 'Result B' }
        ],
        tools: []
      });

      const userMessages = capturedBody.messages.filter(m => m.role === 'user');
      assert.strictEqual(userMessages.length, 2, 'Should have 2 user messages total');
      const toolResultMsg = userMessages[1];
      assert.ok(Array.isArray(toolResultMsg.content), 'Tool result message should have array content');
      assert.strictEqual(toolResultMsg.content.length, 2, 'Should have 2 tool_result blocks in one message');
      assert.strictEqual(toolResultMsg.content[0].type, 'tool_result');
      assert.strictEqual(toolResultMsg.content[0].tool_use_id, 'tc_1');
      assert.strictEqual(toolResultMsg.content[1].type, 'tool_result');
      assert.strictEqual(toolResultMsg.content[1].tool_use_id, 'tc_2');
    } finally {
      global.fetch = origFetch;
    }
  });

  console.log('\n--- 429 Retry Tests ---\n');

  await asyncTest('retries on 429 and succeeds on next attempt', async () => {
    let callCount = 0;
    const origFetch = global.fetch;
    global.fetch = async () => {
      callCount++;
      if (callCount === 1) {
        return {
          ok: false,
          status: 429,
          headers: { get: () => null },
          text: async () => 'rate limited'
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: 'text', text: 'Success after retry' }] })
      };
    };

    try {
      const provider = new ClaudeToolsProvider({
        getApiKey: async () => 'test-key',
        maxRetries: 3
      }, silentLogger);

      provider._sleep = async () => {};

      const result = await provider.chat({
        system: 'Test',
        messages: [{ role: 'user', content: 'Hello' }],
        tools: []
      });

      assert.strictEqual(callCount, 2, 'Should have made 2 fetch calls');
      assert.strictEqual(result.content, 'Success after retry');
    } finally {
      global.fetch = origFetch;
    }
  });

  await asyncTest('respects retry-after header (seconds)', async () => {
    let sleepCalledWith = null;
    let callCount = 0;
    const origFetch = global.fetch;
    global.fetch = async () => {
      callCount++;
      if (callCount === 1) {
        return {
          ok: false,
          status: 429,
          headers: { get: (key) => key === 'retry-after' ? '5' : null },
          text: async () => 'rate limited'
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: 'text', text: 'OK' }] })
      };
    };

    try {
      const provider = new ClaudeToolsProvider({
        getApiKey: async () => 'test-key',
        maxRetries: 3
      }, silentLogger);

      provider._sleep = async (ms) => { sleepCalledWith = ms; };

      await provider.chat({
        system: 'Test',
        messages: [{ role: 'user', content: 'Hello' }],
        tools: []
      });

      assert.strictEqual(sleepCalledWith, 5000, 'Should sleep for 5000ms (5 seconds)');
    } finally {
      global.fetch = origFetch;
    }
  });

  await asyncTest('gives up after maxRetries on persistent 429', async () => {
    let callCount = 0;
    const origFetch = global.fetch;
    global.fetch = async () => {
      callCount++;
      return {
        ok: false,
        status: 429,
        headers: { get: () => null },
        text: async () => 'still rate limited'
      };
    };

    try {
      const provider = new ClaudeToolsProvider({
        getApiKey: async () => 'test-key',
        maxRetries: 2
      }, silentLogger);

      provider._sleep = async () => {};

      await provider.chat({
        system: 'Test',
        messages: [{ role: 'user', content: 'Hello' }],
        tools: []
      });

      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('rate limited after 2 retries'), `Got: ${err.message}`);
      assert.strictEqual(callCount, 3, 'Should have made 3 fetch calls (initial + 2 retries)');
    } finally {
      global.fetch = origFetch;
    }
  });

  await asyncTest('returns immediately on first success (no retry)', async () => {
    let callCount = 0;
    const origFetch = global.fetch;
    global.fetch = async () => {
      callCount++;
      return {
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: 'text', text: 'First try' }] })
      };
    };

    try {
      const provider = new ClaudeToolsProvider({
        getApiKey: async () => 'test-key',
        maxRetries: 3
      }, silentLogger);

      const result = await provider.chat({
        system: 'Test',
        messages: [{ role: 'user', content: 'Hello' }],
        tools: []
      });

      assert.strictEqual(callCount, 1, 'Should have made only 1 fetch call');
      assert.strictEqual(result.content, 'First try');
    } finally {
      global.fetch = origFetch;
    }
  });

  await asyncTest('non-429 errors are not retried', async () => {
    let callCount = 0;
    const origFetch = global.fetch;
    global.fetch = async () => {
      callCount++;
      return {
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error'
      };
    };

    try {
      const provider = new ClaudeToolsProvider({
        getApiKey: async () => 'test-key',
        maxRetries: 3
      }, silentLogger);

      await provider.chat({
        system: 'Test',
        messages: [{ role: 'user', content: 'Hello' }],
        tools: []
      });

      assert.fail('Should have thrown');
    } catch (err) {
      assert.strictEqual(callCount, 1, 'Should not retry non-429 errors');
      assert.ok(err.message.includes('500'));
    } finally {
      global.fetch = origFetch;
    }
  });

  // Summary after all async tests complete
  summary();
  exitWithCode();
})();
