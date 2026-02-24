/**
 * OpenAIToolsProvider Unit Tests
 *
 * Run: node test/unit/agent/providers/openai-tools.test.js
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../../helpers/test-runner');

const { OpenAIToolsProvider } = require('../../../../src/lib/agent/providers/openai-tools');

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {}
};

// ============================================================
// Constructor Tests
// ============================================================

console.log('\n=== OpenAIToolsProvider Tests ===\n');
console.log('--- Constructor ---\n');

test('constructor sets all config properties', () => {
  const getApiKey = async () => 'key';
  const provider = new OpenAIToolsProvider({
    endpoint: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    getApiKey,
    maxTokens: 2048,
    timeout: 60000,
    maxRetries: 5,
    headers: { 'X-Custom': 'value' }
  }, silentLogger);

  assert.strictEqual(provider.endpoint, 'https://api.openai.com/v1');
  assert.strictEqual(provider.model, 'gpt-4o');
  assert.strictEqual(provider.getApiKey, getApiKey);
  assert.strictEqual(provider.maxTokens, 2048);
  assert.strictEqual(provider.timeout, 60000);
  assert.strictEqual(provider.maxRetries, 5);
  assert.deepStrictEqual(provider.additionalHeaders, { 'X-Custom': 'value' });
});

test('constructor applies defaults for optional fields', () => {
  const provider = new OpenAIToolsProvider({
    endpoint: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    getApiKey: async () => 'key'
  }, silentLogger);

  assert.strictEqual(provider.maxTokens, 4096);
  assert.strictEqual(provider.timeout, 30000);
  assert.strictEqual(provider.maxRetries, 2);
  assert.deepStrictEqual(provider.additionalHeaders, {});
});

test('constructor strips trailing slashes from endpoint', () => {
  const provider = new OpenAIToolsProvider({
    endpoint: 'https://api.openai.com/v1///',
    model: 'gpt-4o',
    getApiKey: async () => 'key'
  }, silentLogger);

  assert.strictEqual(provider.endpoint, 'https://api.openai.com/v1');
});

test('constructor throws if endpoint missing', () => {
  assert.throws(() => {
    new OpenAIToolsProvider({ model: 'gpt-4o', getApiKey: async () => 'key' }, silentLogger);
  }, /requires an endpoint/);
});

test('constructor throws if model missing', () => {
  assert.throws(() => {
    new OpenAIToolsProvider({
      endpoint: 'https://api.openai.com/v1',
      getApiKey: async () => 'key'
    }, silentLogger);
  }, /requires a model/);
});

test('constructor accepts maxRetries=0', () => {
  const provider = new OpenAIToolsProvider({
    endpoint: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    getApiKey: async () => 'key',
    maxRetries: 0
  }, silentLogger);

  assert.strictEqual(provider.maxRetries, 0);
});

// ============================================================
// _parseResponse Tests
// ============================================================

console.log('\n--- _parseResponse ---\n');

test('_parseResponse extracts content from standard response', () => {
  const provider = new OpenAIToolsProvider({
    endpoint: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    getApiKey: async () => 'key'
  }, silentLogger);

  const result = provider._parseResponse({
    choices: [{
      message: { role: 'assistant', content: 'Hello, how can I help?' }
    }]
  });

  assert.strictEqual(result.content, 'Hello, how can I help?');
  assert.strictEqual(result.toolCalls, null);
});

test('_parseResponse returns empty string for missing content', () => {
  const provider = new OpenAIToolsProvider({
    endpoint: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    getApiKey: async () => 'key'
  }, silentLogger);

  const result = provider._parseResponse({
    choices: [{
      message: { role: 'assistant' }
    }]
  });

  assert.strictEqual(result.content, '');
  assert.strictEqual(result.toolCalls, null);
});

test('_parseResponse extracts tool calls from response', () => {
  const provider = new OpenAIToolsProvider({
    endpoint: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    getApiKey: async () => 'key'
  }, silentLogger);

  const result = provider._parseResponse({
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_abc123',
          type: 'function',
          function: { name: 'deck_list_cards', arguments: '{"stack":"Working"}' }
        }]
      }
    }]
  });

  assert.ok(result.toolCalls);
  assert.strictEqual(result.toolCalls.length, 1);
  assert.strictEqual(result.toolCalls[0].id, 'call_abc123');
  assert.strictEqual(result.toolCalls[0].name, 'deck_list_cards');
  assert.deepStrictEqual(result.toolCalls[0].arguments, { stack: 'Working' });
  assert.strictEqual(result.content, null);
});

test('_parseResponse parses stringified tool call arguments', () => {
  const provider = new OpenAIToolsProvider({
    endpoint: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    getApiKey: async () => 'key'
  }, silentLogger);

  const result = provider._parseResponse({
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_xyz',
          type: 'function',
          function: { name: 'search', arguments: '{"query":"openai docs","limit":5}' }
        }]
      }
    }]
  });

  assert.deepStrictEqual(result.toolCalls[0].arguments, { query: 'openai docs', limit: 5 });
});

test('_parseResponse handles already-parsed tool call arguments (object)', () => {
  const provider = new OpenAIToolsProvider({
    endpoint: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    getApiKey: async () => 'key'
  }, silentLogger);

  const result = provider._parseResponse({
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_xyz',
          type: 'function',
          function: { name: 'search', arguments: { query: 'already parsed' } }
        }]
      }
    }]
  });

  assert.deepStrictEqual(result.toolCalls[0].arguments, { query: 'already parsed' });
});

test('_parseResponse handles multiple tool calls', () => {
  const provider = new OpenAIToolsProvider({
    endpoint: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    getApiKey: async () => 'key'
  }, silentLogger);

  const result = provider._parseResponse({
    choices: [{
      message: {
        role: 'assistant',
        content: 'Let me check both.',
        tool_calls: [
          {
            id: 'call_1', type: 'function',
            function: { name: 'tool_a', arguments: '{"x":1}' }
          },
          {
            id: 'call_2', type: 'function',
            function: { name: 'tool_b', arguments: '{"y":2}' }
          }
        ]
      }
    }]
  });

  assert.strictEqual(result.toolCalls.length, 2);
  assert.strictEqual(result.toolCalls[0].name, 'tool_a');
  assert.strictEqual(result.toolCalls[1].name, 'tool_b');
  assert.strictEqual(result.content, 'Let me check both.');
});

test('_parseResponse generates fallback id when tool call has no id', () => {
  const provider = new OpenAIToolsProvider({
    endpoint: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    getApiKey: async () => 'key'
  }, silentLogger);

  const result = provider._parseResponse({
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          type: 'function',
          function: { name: 'my_tool', arguments: '{}' }
        }]
      }
    }]
  });

  assert.ok(result.toolCalls[0].id, 'Should have a generated id');
  assert.ok(result.toolCalls[0].id.startsWith('openai_'), 'Generated id should start with openai_');
});

test('_parseResponse throws when choices is empty', () => {
  const provider = new OpenAIToolsProvider({
    endpoint: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    getApiKey: async () => 'key'
  }, silentLogger);

  assert.throws(() => {
    provider._parseResponse({ choices: [] });
  }, /No choices in response/);
});

test('_parseResponse handles empty tool_calls array (treats as text)', () => {
  const provider = new OpenAIToolsProvider({
    endpoint: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    getApiKey: async () => 'key'
  }, silentLogger);

  const result = provider._parseResponse({
    choices: [{
      message: {
        role: 'assistant',
        content: 'No tools needed.',
        tool_calls: []
      }
    }]
  });

  assert.strictEqual(result.content, 'No tools needed.');
  assert.strictEqual(result.toolCalls, null);
});

// ============================================================
// _parseRetryAfter Tests
// ============================================================

console.log('\n--- _parseRetryAfter ---\n');

test('_parseRetryAfter parses seconds format', () => {
  const provider = new OpenAIToolsProvider({
    endpoint: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    getApiKey: async () => 'key'
  }, silentLogger);

  const headers = { get: (k) => k === 'retry-after' ? '30' : null };
  assert.strictEqual(provider._parseRetryAfter(headers), 30000);
});

test('_parseRetryAfter returns exponential backoff when no header', () => {
  const provider = new OpenAIToolsProvider({
    endpoint: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    getApiKey: async () => 'key'
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

// ============================================================
// Async / HTTP Tests
// ============================================================

(async () => {
  console.log('\n--- Async / HTTP Tests ---\n');

  await asyncTest('chat() sends correct URL (endpoint + /chat/completions)', async () => {
    let capturedUrl;
    const origFetch = global.fetch;
    global.fetch = async (url, _opts) => {
      capturedUrl = url;
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
        text: async () => '',
        headers: { get: () => null }
      };
    };

    try {
      const provider = new OpenAIToolsProvider({
        endpoint: 'https://api.perplexity.ai',
        model: 'llama-3.1-sonar-large-128k-online',
        getApiKey: async () => 'pplx-key'
      }, silentLogger);

      await provider.chat({ system: 'Test', messages: [], tools: [] });

      assert.strictEqual(capturedUrl, 'https://api.perplexity.ai/chat/completions');
    } finally {
      global.fetch = origFetch;
    }
  });

  await asyncTest('chat() sends Authorization header with Bearer token', async () => {
    let capturedHeaders;
    const origFetch = global.fetch;
    global.fetch = async (_url, opts) => {
      capturedHeaders = opts.headers;
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
        text: async () => '',
        headers: { get: () => null }
      };
    };

    try {
      const provider = new OpenAIToolsProvider({
        endpoint: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        getApiKey: async () => 'sk-test-secret'
      }, silentLogger);

      await provider.chat({ system: 'Test', messages: [], tools: [] });

      assert.strictEqual(capturedHeaders['Authorization'], 'Bearer sk-test-secret');
      assert.strictEqual(capturedHeaders['Content-Type'], 'application/json');
    } finally {
      global.fetch = origFetch;
    }
  });

  await asyncTest('chat() merges additional headers from config', async () => {
    let capturedHeaders;
    const origFetch = global.fetch;
    global.fetch = async (_url, opts) => {
      capturedHeaders = opts.headers;
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
        text: async () => '',
        headers: { get: () => null }
      };
    };

    try {
      const provider = new OpenAIToolsProvider({
        endpoint: 'https://openrouter.ai/api/v1',
        model: 'mistralai/mistral-7b-instruct',
        getApiKey: async () => 'or-key',
        headers: { 'HTTP-Referer': 'https://myapp.com', 'X-Title': 'MyApp' }
      }, silentLogger);

      await provider.chat({ system: 'Test', messages: [], tools: [] });

      assert.strictEqual(capturedHeaders['HTTP-Referer'], 'https://myapp.com');
      assert.strictEqual(capturedHeaders['X-Title'], 'MyApp');
      assert.strictEqual(capturedHeaders['Authorization'], 'Bearer or-key');
    } finally {
      global.fetch = origFetch;
    }
  });

  await asyncTest('chat() includes system message when provided', async () => {
    let capturedBody;
    const origFetch = global.fetch;
    global.fetch = async (_url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
        text: async () => '',
        headers: { get: () => null }
      };
    };

    try {
      const provider = new OpenAIToolsProvider({
        endpoint: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        getApiKey: async () => 'sk-key'
      }, silentLogger);

      await provider.chat({
        system: 'You are a helpful assistant.',
        messages: [{ role: 'user', content: 'Hello' }],
        tools: []
      });

      assert.strictEqual(capturedBody.messages[0].role, 'system');
      assert.strictEqual(capturedBody.messages[0].content, 'You are a helpful assistant.');
      assert.strictEqual(capturedBody.messages[1].role, 'user');
      assert.strictEqual(capturedBody.messages[1].content, 'Hello');
    } finally {
      global.fetch = origFetch;
    }
  });

  await asyncTest('chat() skips duplicate system messages already in messages array', async () => {
    let capturedBody;
    const origFetch = global.fetch;
    global.fetch = async (_url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
        text: async () => '',
        headers: { get: () => null }
      };
    };

    try {
      const provider = new OpenAIToolsProvider({
        endpoint: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        getApiKey: async () => 'sk-key'
      }, silentLogger);

      await provider.chat({
        system: 'System prompt.',
        messages: [
          { role: 'system', content: 'Duplicate system' },
          { role: 'user', content: 'Hello' }
        ],
        tools: []
      });

      // system msg from param is prepended, duplicates from messages array are skipped
      const systemMessages = capturedBody.messages.filter(m => m.role === 'system');
      assert.strictEqual(systemMessages.length, 1, 'Should have exactly one system message');
      assert.strictEqual(systemMessages[0].content, 'System prompt.');
    } finally {
      global.fetch = origFetch;
    }
  });

  await asyncTest('chat() includes tools when provided', async () => {
    let capturedBody;
    const origFetch = global.fetch;
    global.fetch = async (_url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
        text: async () => '',
        headers: { get: () => null }
      };
    };

    try {
      const provider = new OpenAIToolsProvider({
        endpoint: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        getApiKey: async () => 'sk-key'
      }, silentLogger);

      const tools = [{
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather for a city',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city']
          }
        }
      }];

      await provider.chat({
        system: 'Test',
        messages: [{ role: 'user', content: 'What is the weather?' }],
        tools
      });

      assert.ok(capturedBody.tools, 'body.tools should be present');
      assert.strictEqual(capturedBody.tools.length, 1);
      assert.strictEqual(capturedBody.tools[0].function.name, 'get_weather');
    } finally {
      global.fetch = origFetch;
    }
  });

  await asyncTest('chat() omits tools key when tools array is empty', async () => {
    let capturedBody;
    const origFetch = global.fetch;
    global.fetch = async (_url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
        text: async () => '',
        headers: { get: () => null }
      };
    };

    try {
      const provider = new OpenAIToolsProvider({
        endpoint: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        getApiKey: async () => 'sk-key'
      }, silentLogger);

      await provider.chat({
        system: 'Test',
        messages: [{ role: 'user', content: 'Hello' }],
        tools: []
      });

      assert.ok(!capturedBody.tools, 'body.tools should be absent when tools array is empty');
    } finally {
      global.fetch = origFetch;
    }
  });

  await asyncTest('chat() correctly formats tool result messages (role: tool with tool_call_id)', async () => {
    let capturedBody;
    const origFetch = global.fetch;
    global.fetch = async (_url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'done' } }] }),
        text: async () => '',
        headers: { get: () => null }
      };
    };

    try {
      const provider = new OpenAIToolsProvider({
        endpoint: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        getApiKey: async () => 'sk-key'
      }, silentLogger);

      await provider.chat({
        system: 'Test',
        messages: [
          { role: 'user', content: 'Call a tool' },
          {
            role: 'assistant', content: null,
            tool_calls: [{
              id: 'call_001', type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"London"}' }
            }]
          },
          { role: 'tool', tool_call_id: 'call_001', content: '{"temp":15,"condition":"cloudy"}' }
        ],
        tools: []
      });

      const toolMsg = capturedBody.messages.find(m => m.role === 'tool');
      assert.ok(toolMsg, 'Should have a tool role message');
      assert.strictEqual(toolMsg.tool_call_id, 'call_001');
      assert.strictEqual(toolMsg.content, '{"temp":15,"condition":"cloudy"}');
    } finally {
      global.fetch = origFetch;
    }
  });

  await asyncTest('chat() serializes non-string tool result content to JSON', async () => {
    let capturedBody;
    const origFetch = global.fetch;
    global.fetch = async (_url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'done' } }] }),
        text: async () => '',
        headers: { get: () => null }
      };
    };

    try {
      const provider = new OpenAIToolsProvider({
        endpoint: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        getApiKey: async () => 'sk-key'
      }, silentLogger);

      await provider.chat({
        system: 'Test',
        messages: [
          {
            role: 'assistant', content: null,
            tool_calls: [{
              id: 'call_002', type: 'function',
              function: { name: 'get_data', arguments: '{}' }
            }]
          },
          { role: 'tool', tool_call_id: 'call_002', content: { items: [1, 2, 3] } }
        ],
        tools: []
      });

      const toolMsg = capturedBody.messages.find(m => m.role === 'tool');
      assert.strictEqual(toolMsg.content, '{"items":[1,2,3]}');
    } finally {
      global.fetch = origFetch;
    }
  });

  await asyncTest('chat() correctly formats assistant messages with tool_calls', async () => {
    let capturedBody;
    const origFetch = global.fetch;
    global.fetch = async (_url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'done' } }] }),
        text: async () => '',
        headers: { get: () => null }
      };
    };

    try {
      const provider = new OpenAIToolsProvider({
        endpoint: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        getApiKey: async () => 'sk-key'
      }, silentLogger);

      await provider.chat({
        system: 'Test',
        messages: [
          { role: 'user', content: 'Do something' },
          {
            role: 'assistant',
            content: 'Let me help.',
            tool_calls: [{
              id: 'call_abc',
              type: 'function',
              function: { name: 'my_tool', arguments: '{"param":"val"}' }
            }]
          },
          { role: 'tool', tool_call_id: 'call_abc', content: 'result' }
        ],
        tools: []
      });

      const assistantMsg = capturedBody.messages.find(m => m.role === 'assistant' && m.tool_calls);
      assert.ok(assistantMsg, 'Should have assistant message with tool_calls');
      assert.strictEqual(assistantMsg.tool_calls.length, 1);
      assert.strictEqual(assistantMsg.tool_calls[0].id, 'call_abc');
      assert.strictEqual(assistantMsg.tool_calls[0].type, 'function');
      assert.strictEqual(assistantMsg.tool_calls[0].function.name, 'my_tool');
      // arguments must be a string in OpenAI wire format
      assert.strictEqual(typeof assistantMsg.tool_calls[0].function.arguments, 'string');
      assert.strictEqual(assistantMsg.tool_calls[0].function.arguments, '{"param":"val"}');
    } finally {
      global.fetch = origFetch;
    }
  });

  await asyncTest('chat() re-serializes assistant tool_call arguments when originally an object', async () => {
    let capturedBody;
    const origFetch = global.fetch;
    global.fetch = async (_url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'done' } }] }),
        text: async () => '',
        headers: { get: () => null }
      };
    };

    try {
      const provider = new OpenAIToolsProvider({
        endpoint: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        getApiKey: async () => 'sk-key'
      }, silentLogger);

      await provider.chat({
        system: 'Test',
        messages: [{
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_obj',
            type: 'function',
            function: { name: 'my_tool', arguments: { param: 'val' } } // already an object
          }]
        }],
        tools: []
      });

      const assistantMsg = capturedBody.messages.find(m => m.role === 'assistant' && m.tool_calls);
      assert.strictEqual(assistantMsg.tool_calls[0].function.arguments, '{"param":"val"}');
    } finally {
      global.fetch = origFetch;
    }
  });

  await asyncTest('chat() throws when API key not available', async () => {
    const provider = new OpenAIToolsProvider({
      endpoint: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      getApiKey: async () => null
    }, silentLogger);

    try {
      await provider.chat({ system: 'Test', messages: [], tools: [] });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('API key not available'));
    }
  });

  await asyncTest('chat() throws on non-200 status (non-retryable)', async () => {
    let callCount = 0;
    const origFetch = global.fetch;
    global.fetch = async () => {
      callCount++;
      return {
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
        headers: { get: () => null }
      };
    };

    try {
      const provider = new OpenAIToolsProvider({
        endpoint: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        getApiKey: async () => 'sk-key',
        maxRetries: 2
      }, silentLogger);

      await provider.chat({ system: 'Test', messages: [], tools: [] });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('500'), `Expected 500 in error, got: ${err.message}`);
      assert.strictEqual(callCount, 1, 'Should not retry non-429 errors');
    } finally {
      global.fetch = origFetch;
    }
  });

  await asyncTest('chat() throws on 400 bad request (non-retryable)', async () => {
    const origFetch = global.fetch;
    global.fetch = async () => ({
      ok: false,
      status: 400,
      text: async () => 'Bad request: invalid model',
      headers: { get: () => null }
    });

    try {
      const provider = new OpenAIToolsProvider({
        endpoint: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        getApiKey: async () => 'sk-key'
      }, silentLogger);

      await provider.chat({ system: 'Test', messages: [], tools: [] });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('400'));
    } finally {
      global.fetch = origFetch;
    }
  });

  await asyncTest('chat() throws on timeout (AbortError)', async () => {
    const origFetch = global.fetch;
    global.fetch = async (_url, opts) => {
      // Simulate an aborted request
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    };

    try {
      const provider = new OpenAIToolsProvider({
        endpoint: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        getApiKey: async () => 'sk-key',
        timeout: 100
      }, silentLogger);

      await provider.chat({ system: 'Test', messages: [], tools: [] });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('timed out'), `Expected timeout message, got: ${err.message}`);
      assert.ok(err.message.includes('100ms'), `Expected timeout duration in message, got: ${err.message}`);
    } finally {
      global.fetch = origFetch;
    }
  });

  await asyncTest('chat() retries on 429 and succeeds on next attempt', async () => {
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
        json: async () => ({ choices: [{ message: { content: 'Success after retry' } }] }),
        text: async () => '',
        headers: { get: () => null }
      };
    };

    try {
      const provider = new OpenAIToolsProvider({
        endpoint: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        getApiKey: async () => 'sk-key',
        maxRetries: 2
      }, silentLogger);

      // Bypass sleep delay for test speed
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

  await asyncTest('chat() retries on 529 and succeeds on next attempt', async () => {
    let callCount = 0;
    const origFetch = global.fetch;
    global.fetch = async () => {
      callCount++;
      if (callCount === 1) {
        return {
          ok: false,
          status: 529,
          headers: { get: () => null },
          text: async () => 'overloaded'
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'Back online' } }] }),
        text: async () => '',
        headers: { get: () => null }
      };
    };

    try {
      const provider = new OpenAIToolsProvider({
        endpoint: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        getApiKey: async () => 'sk-key',
        maxRetries: 2
      }, silentLogger);

      provider._sleep = async () => {};

      const result = await provider.chat({
        system: 'Test',
        messages: [{ role: 'user', content: 'Hello' }],
        tools: []
      });

      assert.strictEqual(callCount, 2);
      assert.strictEqual(result.content, 'Back online');
    } finally {
      global.fetch = origFetch;
    }
  });

  await asyncTest('chat() gives up after maxRetries on persistent 429', async () => {
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
      const provider = new OpenAIToolsProvider({
        endpoint: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        getApiKey: async () => 'sk-key',
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
      assert.ok(err.message.includes('Rate limited after 2 retries'), `Got: ${err.message}`);
      assert.strictEqual(callCount, 3, 'Should make initial + 2 retry calls');
    } finally {
      global.fetch = origFetch;
    }
  });

  await asyncTest('chat() respects retry-after header on 429', async () => {
    let sleepCalledWith = null;
    let callCount = 0;
    const origFetch = global.fetch;
    global.fetch = async () => {
      callCount++;
      if (callCount === 1) {
        return {
          ok: false,
          status: 429,
          headers: { get: (k) => k === 'retry-after' ? '10' : null },
          text: async () => 'rate limited'
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'OK' } }] }),
        text: async () => '',
        headers: { get: () => null }
      };
    };

    try {
      const provider = new OpenAIToolsProvider({
        endpoint: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        getApiKey: async () => 'sk-key',
        maxRetries: 2
      }, silentLogger);

      provider._sleep = async (ms) => { sleepCalledWith = ms; };

      await provider.chat({
        system: 'Test',
        messages: [{ role: 'user', content: 'Hello' }],
        tools: []
      });

      assert.strictEqual(sleepCalledWith, 10000, `Expected 10000ms sleep, got ${sleepCalledWith}ms`);
    } finally {
      global.fetch = origFetch;
    }
  });

  await asyncTest('chat() sends model and max_tokens in request body', async () => {
    let capturedBody;
    const origFetch = global.fetch;
    global.fetch = async (_url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
        text: async () => '',
        headers: { get: () => null }
      };
    };

    try {
      const provider = new OpenAIToolsProvider({
        endpoint: 'https://api.groq.com/openai/v1',
        model: 'llama3-70b-8192',
        getApiKey: async () => 'gsk-key',
        maxTokens: 8192
      }, silentLogger);

      await provider.chat({ system: 'Test', messages: [], tools: [] });

      assert.strictEqual(capturedBody.model, 'llama3-70b-8192');
      assert.strictEqual(capturedBody.max_tokens, 8192);
    } finally {
      global.fetch = origFetch;
    }
  });

  await asyncTest('chat() uses per-call timeout override', async () => {
    let capturedSignal;
    const origFetch = global.fetch;
    // Record whether an abort was triggered but resolve successfully
    global.fetch = async (_url, opts) => {
      capturedSignal = opts.signal;
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
        text: async () => '',
        headers: { get: () => null }
      };
    };

    try {
      const provider = new OpenAIToolsProvider({
        endpoint: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        getApiKey: async () => 'sk-key',
        timeout: 30000 // default
      }, silentLogger);

      // Pass a shorter per-call timeout — signal should be attached
      await provider.chat({
        system: 'Test',
        messages: [],
        tools: [],
        timeout: 5000
      });

      assert.ok(capturedSignal, 'AbortSignal should have been passed to fetch');
    } finally {
      global.fetch = origFetch;
    }
  });

  // ============================================================
  // Summary
  // ============================================================

  summary();
  exitWithCode();
})();
