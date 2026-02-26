/**
 * OllamaProvider Unit Tests
 *
 * Validates _fetchWithRetry retry logic and BaseProvider logger inheritance.
 *
 * Run: node test/unit/llm/providers/ollama-provider.test.js
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../../helpers/test-runner');

const OllamaProvider = require('../../../../src/lib/llm/providers/ollama-provider');

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {}
};

console.log('\n=== OllamaProvider Tests ===\n');

test('constructor inherits logger from BaseProvider', () => {
  const provider = new OllamaProvider({ id: 'test', logger: silentLogger });
  assert.strictEqual(provider.logger, silentLogger);
});

test('constructor defaults logger to console when not provided', () => {
  const provider = new OllamaProvider({ id: 'test' });
  assert.strictEqual(provider.logger, console);
});

asyncTest('_fetchWithRetry retries on network error and succeeds on second attempt', async () => {
  const provider = new OllamaProvider({ id: 'test', logger: silentLogger });

  let attempt = 0;
  provider._fetch = async () => {
    attempt++;
    if (attempt === 1) {
      throw new Error('ECONNREFUSED');
    }
    return { ok: true, json: async () => ({ result: 'ok' }) };
  };

  const result = await provider._fetchWithRetry('http://localhost:11434/api/chat', {}, 1, 10);
  assert.strictEqual(attempt, 2, 'should have made 2 attempts');
  assert.strictEqual(result.ok, true);
});

asyncTest('_fetchWithRetry calls logger.warn on retry', async () => {
  const warnings = [];
  const trackingLogger = {
    info: () => {},
    warn: (msg) => { warnings.push(msg); },
    error: () => {}
  };

  const provider = new OllamaProvider({ id: 'test', logger: trackingLogger });

  let attempt = 0;
  provider._fetch = async () => {
    attempt++;
    if (attempt === 1) {
      throw new Error('ECONNREFUSED');
    }
    return { ok: true, json: async () => ({}) };
  };

  await provider._fetchWithRetry('http://localhost:11434/api/chat', {}, 1, 10);
  assert.strictEqual(warnings.length, 1, 'should have logged 1 warning');
  assert.ok(warnings[0].includes('fetch failed'), `warn message should include "fetch failed": ${warnings[0]}`);
});

asyncTest('_fetchWithRetry throws after all retries exhausted', async () => {
  const provider = new OllamaProvider({ id: 'test', logger: silentLogger });

  provider._fetch = async () => {
    throw new Error('ECONNREFUSED');
  };

  try {
    await provider._fetchWithRetry('http://localhost:11434/api/chat', {}, 1, 10);
    assert.fail('should have thrown');
  } catch (err) {
    assert.strictEqual(err.message, 'ECONNREFUSED');
  }
});

test('constructor defaults model to phi4-mini', () => {
  const provider = new OllamaProvider({ id: 'test', logger: silentLogger });
  assert.strictEqual(provider.model, 'phi4-mini');
});

asyncTest('generate passes format to Ollama request body when provided', async () => {
  const provider = new OllamaProvider({ id: 'test', logger: silentLogger });

  let capturedBody;
  provider._fetch = async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ message: { content: '{"intent":"calendar"}' }, prompt_eval_count: 10, eval_count: 5 }) };
  };

  const schema = { type: 'object', properties: { intent: { type: 'string' } }, required: ['intent'] };
  await provider.generate('classify', 'test message', { format: schema });

  assert.ok(capturedBody.format, 'format should be present in request body');
  assert.deepStrictEqual(capturedBody.format, schema);
});

asyncTest('generate omits format from request body when not provided', async () => {
  const provider = new OllamaProvider({ id: 'test', logger: silentLogger });

  let capturedBody;
  provider._fetch = async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ message: { content: 'hello' }, prompt_eval_count: 10, eval_count: 5 }) };
  };

  await provider.generate('chat', 'test message', {});

  assert.strictEqual(capturedBody.format, undefined, 'format should not be in request body');
});

asyncTest('_fetchWithRetry does not retry HTTP errors (err.status set)', async () => {
  const provider = new OllamaProvider({ id: 'test', logger: silentLogger });

  let attempts = 0;
  provider._fetch = async () => {
    attempts++;
    const err = new Error('Bad Request');
    err.status = 400;
    throw err;
  };

  try {
    await provider._fetchWithRetry('http://localhost:11434/api/chat', {}, 2, 10);
    assert.fail('should have thrown');
  } catch (err) {
    assert.strictEqual(attempts, 1, 'should not retry HTTP errors');
    assert.strictEqual(err.status, 400);
  }
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
