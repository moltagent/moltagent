/**
 * ProviderChain Unit Tests
 *
 * Run: node test/unit/agent/providers/provider-chain.test.js
 */

const assert = require('assert');
const { asyncTest, summary, exitWithCode } = require('../../../helpers/test-runner');

const { ProviderChain } = require('../../../../src/lib/agent/providers/provider-chain');

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {}
};

// ============================================================
// Helpers
// ============================================================

/** Creates a mock provider that resolves with given result */
function mockProvider(result) {
  return {
    chat: async () => result,
    _callCount: 0,
    get callCount() { return this._callCount; },
    _wrapChat() {
      const orig = this.chat;
      const self = this;
      this.chat = async (params) => { self._callCount++; return orig(params); };
    }
  };
}

/** Creates a mock provider that always rejects with given error */
function failingProvider(errorMessage) {
  return {
    chat: async () => { throw new Error(errorMessage); },
    _callCount: 0,
    get callCount() { return this._callCount; },
    _wrapChat() {
      const orig = this.chat;
      const self = this;
      this.chat = async (params) => { self._callCount++; return orig(params); };
    }
  };
}

function tracked(provider) {
  provider._wrapChat();
  return provider;
}

// ============================================================
// Tests
// ============================================================

console.log('\n=== ProviderChain Tests ===\n');

(async () => {
  await asyncTest('primary succeeds — returns primary result, fallback never called', async () => {
    const primary = tracked(mockProvider({ content: 'primary result', toolCalls: null }));
    const fallback = tracked(mockProvider({ content: 'fallback result', toolCalls: null }));

    const chain = new ProviderChain(primary, fallback, silentLogger);
    const result = await chain.chat({ system: 'test', messages: [], tools: [] });

    assert.strictEqual(result.content, 'primary result');
    assert.strictEqual(primary.callCount, 1);
    assert.strictEqual(fallback.callCount, 0);
  });

  await asyncTest('primary throws 429 — falls back to secondary', async () => {
    const primary = tracked(failingProvider('Claude API rate limited after 3 retries: too many requests'));
    const fallback = tracked(mockProvider({ content: 'fallback saved us', toolCalls: null }));

    const chain = new ProviderChain(primary, fallback, silentLogger);
    const result = await chain.chat({ system: 'test', messages: [], tools: [] });

    assert.strictEqual(result.content, 'fallback saved us');
    assert.strictEqual(primary.callCount, 1);
    assert.strictEqual(fallback.callCount, 1);
  });

  await asyncTest('primary throws non-429 error — error propagates, fallback not called', async () => {
    const primary = tracked(failingProvider('Claude API error 500: Internal Server Error'));
    const fallback = tracked(mockProvider({ content: 'should not reach', toolCalls: null }));

    const chain = new ProviderChain(primary, fallback, silentLogger);

    try {
      await chain.chat({ system: 'test', messages: [], tools: [] });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('500'));
      assert.strictEqual(fallback.callCount, 0);
    }
  });

  await asyncTest('no fallback configured — 429 error propagates normally', async () => {
    const primary = tracked(failingProvider('Claude API rate limited after 3 retries: overloaded'));

    const chain = new ProviderChain(primary, null, silentLogger);

    try {
      await chain.chat({ system: 'test', messages: [], tools: [] });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('rate limited'));
    }
  });

  await asyncTest('fallback also fails — fallback error propagates', async () => {
    const primary = tracked(failingProvider('Claude API rate limited after 3 retries: overloaded'));
    const fallback = tracked(failingProvider('Ollama error 503: model not loaded'));

    const chain = new ProviderChain(primary, fallback, silentLogger);

    try {
      await chain.chat({ system: 'test', messages: [], tools: [] });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('Ollama error 503'), `Expected Ollama error, got: ${err.message}`);
      assert.strictEqual(primary.callCount, 1);
      assert.strictEqual(fallback.callCount, 1);
    }
  });

  await asyncTest('passes params through to fallback unchanged', async () => {
    let capturedParams = null;
    const primary = tracked(failingProvider('Claude API rate limited after 3 retries: overloaded'));
    const fallback = {
      chat: async (params) => {
        capturedParams = params;
        return { content: 'ok', toolCalls: null };
      }
    };

    const chain = new ProviderChain(primary, fallback, silentLogger);
    const params = {
      system: 'You are helpful',
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [{ function: { name: 'test_tool', description: 'A test', parameters: {} } }]
    };

    await chain.chat(params);

    assert.deepStrictEqual(capturedParams, params);
  });

  await asyncTest('_isRateLimitError detects rate-limit messages', async () => {
    const chain = new ProviderChain({}, null, silentLogger);

    // Claude-style errors
    assert.strictEqual(chain._isRateLimitError(new Error('Claude API rate limited after 3 retries: foo')), true);
    assert.strictEqual(chain._isRateLimitError(new Error('rate limited')), true);
    // Ollama-style errors
    assert.strictEqual(chain._isRateLimitError(new Error('Ollama error 429: too many requests')), true);
    // NC-style errors (uppercase)
    assert.strictEqual(chain._isRateLimitError(new Error('Rate limited after 5 retries')), true);
    // Error with status property
    const statusErr = new Error('overloaded'); statusErr.status = 429;
    assert.strictEqual(chain._isRateLimitError(statusErr), true);
    // Non-429 errors
    assert.strictEqual(chain._isRateLimitError(new Error('Claude API error 500: bad')), false);
    assert.strictEqual(chain._isRateLimitError(new Error('timeout')), false);
    assert.strictEqual(chain._isRateLimitError(new Error('')), false);
    // Edge cases: missing message
    assert.strictEqual(chain._isRateLimitError({}), false);
    assert.strictEqual(chain._isRateLimitError({ message: null }), false);
  });

  await asyncTest('logs warning when falling back', async () => {
    let loggedMessage = null;
    const warnLogger = {
      info: () => {},
      warn: (msg) => { loggedMessage = msg; },
      error: () => {}
    };

    const primary = tracked(failingProvider('Claude API rate limited after 3 retries: overloaded'));
    const fallback = tracked(mockProvider({ content: 'ok', toolCalls: null }));

    const chain = new ProviderChain(primary, fallback, warnLogger);
    await chain.chat({ system: 'test', messages: [], tools: [] });

    assert.ok(loggedMessage, 'Should have logged a warning');
    assert.ok(loggedMessage.includes('ProviderChain'));
    assert.ok(loggedMessage.includes('429'));
    assert.ok(loggedMessage.includes('rate limited'), 'Should include original error message');
  });

  // ============================================================
  // forceLocal Tests
  // ============================================================

  await asyncTest('forceLocal=true uses local primary', async () => {
    const primary = tracked(mockProvider({ content: 'local result', toolCalls: null }));
    const fallback = tracked(mockProvider({ content: 'cloud result', toolCalls: null }));

    const chain = new ProviderChain(primary, fallback, silentLogger, {
      primaryIsLocal: true,
      fallbackIsLocal: false
    });
    const result = await chain.chat({ system: 'test', messages: [], tools: [], forceLocal: true });

    assert.strictEqual(result.content, 'local result');
    assert.strictEqual(primary.callCount, 1);
    assert.strictEqual(fallback.callCount, 0);
  });

  await asyncTest('forceLocal=true skips cloud primary, uses local fallback', async () => {
    const primary = tracked(mockProvider({ content: 'cloud result', toolCalls: null }));
    const fallback = tracked(mockProvider({ content: 'local fallback', toolCalls: null }));

    const chain = new ProviderChain(primary, fallback, silentLogger, {
      primaryIsLocal: false,
      fallbackIsLocal: true
    });
    const result = await chain.chat({ system: 'test', messages: [], tools: [], forceLocal: true });

    assert.strictEqual(result.content, 'local fallback');
    assert.strictEqual(primary.callCount, 0);
    assert.strictEqual(fallback.callCount, 1);
  });

  await asyncTest('forceLocal=true throws when no local provider available', async () => {
    const primary = tracked(mockProvider({ content: 'cloud', toolCalls: null }));
    const fallback = tracked(mockProvider({ content: 'also cloud', toolCalls: null }));

    const chain = new ProviderChain(primary, fallback, silentLogger, {
      primaryIsLocal: false,
      fallbackIsLocal: false
    });

    try {
      await chain.chat({ system: 'test', messages: [], tools: [], forceLocal: true });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('forceLocal'));
      assert.ok(err.message.includes('no local provider'));
      assert.strictEqual(primary.callCount, 0);
      assert.strictEqual(fallback.callCount, 0);
    }
  });

  await asyncTest('without forceLocal behaves as before (uses primary)', async () => {
    const primary = tracked(mockProvider({ content: 'cloud primary', toolCalls: null }));
    const fallback = tracked(mockProvider({ content: 'local fallback', toolCalls: null }));

    const chain = new ProviderChain(primary, fallback, silentLogger, {
      primaryIsLocal: false,
      fallbackIsLocal: true
    });
    const result = await chain.chat({ system: 'test', messages: [], tools: [] });

    assert.strictEqual(result.content, 'cloud primary');
    assert.strictEqual(primary.callCount, 1);
    assert.strictEqual(fallback.callCount, 0);
  });

  summary();
  exitWithCode();
})();
