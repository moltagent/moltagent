'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const EmbeddingClient = require('../../../src/lib/memory/embedding-client');

const silentLogger = { log() {}, info() {}, warn() {}, error() {} };

let fetchMock;
function installFetchMock(handler) {
  fetchMock = handler;
  global.fetch = fetchMock;
}
function restoreFetch() { /* noop since test ends */ }

/**
 * Build a minimal Response-like object that mimics the fetch Response API.
 */
function makeFetchResponse({ ok = true, status = 200, json = null, text = '' }) {
  return {
    ok,
    status,
    json: async () => json,
    text: async () => text
  };
}

// TC-EC-01: embed() sends correct payload — model and input fields
asyncTest('TC-EC-01: embed() sends correct payload with model and input', async () => {
  let capturedBody = null;

  installFetchMock(async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return makeFetchResponse({
      ok: true,
      json: { embeddings: [new Array(768).fill(0.1)] }
    });
  });

  const client = new EmbeddingClient({
    ollamaUrl: 'http://localhost:11434',
    model: 'nomic-embed-text',
    logger: silentLogger
  });

  await client.embed('hello world');

  assert.ok(capturedBody, 'Fetch should have been called');
  assert.strictEqual(capturedBody.model, 'nomic-embed-text', 'Payload should include model');
  assert.strictEqual(capturedBody.input, 'hello world', 'Payload should include input text');
});

// TC-EC-02: embed() returns Float64Array of correct dimensions
asyncTest('TC-EC-02: embed() returns Float64Array of correct dimensions', async () => {
  const dims = 768;
  installFetchMock(async () =>
    makeFetchResponse({ ok: true, json: { embeddings: [new Array(dims).fill(0.5)] } })
  );

  const client = new EmbeddingClient({
    ollamaUrl: 'http://localhost:11434',
    logger: silentLogger
  });

  const result = await client.embed('test text');

  assert.ok(result instanceof Float64Array, 'Result should be a Float64Array');
  assert.strictEqual(result.length, dims, `Result should have ${dims} dimensions`);
});

// TC-EC-03: embed() truncates long text — input to fetch must be ≤ 32000 chars
asyncTest('TC-EC-03: embed() truncates long text to 32000 chars', async () => {
  let capturedBody = null;

  installFetchMock(async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return makeFetchResponse({ ok: true, json: { embeddings: [new Array(768).fill(0.1)] } });
  });

  const client = new EmbeddingClient({
    ollamaUrl: 'http://localhost:11434',
    logger: silentLogger
  });

  // Generate text longer than 32000 characters
  const longText = 'x'.repeat(40000);
  await client.embed(longText);

  assert.ok(capturedBody, 'Fetch should have been called');
  assert.ok(
    capturedBody.input.length <= 32000,
    `Input should be truncated to ≤32000 chars, got ${capturedBody.input.length}`
  );
});

// TC-EC-04: embedBatch() returns array of vectors
asyncTest('TC-EC-04: embedBatch() returns array of vectors', async () => {
  installFetchMock(async () =>
    makeFetchResponse({
      ok: true,
      json: {
        embeddings: [
          new Array(768).fill(0.1),
          new Array(768).fill(0.2),
          new Array(768).fill(0.3)
        ]
      }
    })
  );

  const client = new EmbeddingClient({
    ollamaUrl: 'http://localhost:11434',
    logger: silentLogger
  });

  const results = await client.embedBatch(['text one', 'text two', 'text three']);

  assert.ok(Array.isArray(results), 'embedBatch result should be an array');
  assert.strictEqual(results.length, 3, 'Should return 3 vectors');
  results.forEach((vec, i) => {
    assert.ok(vec instanceof Float64Array, `Result[${i}] should be a Float64Array`);
    assert.strictEqual(vec.length, 768, `Result[${i}] should have 768 dimensions`);
  });
});

// TC-EC-05: healthCheck() returns true when model available
asyncTest('TC-EC-05: healthCheck() returns true when model available', async () => {
  installFetchMock(async (url) => {
    if (url.includes('/api/tags')) {
      return makeFetchResponse({
        ok: true,
        json: {
          models: [
            { name: 'nomic-embed-text:latest' },
            { name: 'llama2' }
          ]
        }
      });
    }
    return makeFetchResponse({ ok: false, status: 404 });
  });

  const client = new EmbeddingClient({
    ollamaUrl: 'http://localhost:11434',
    model: 'nomic-embed-text',
    logger: silentLogger
  });

  const healthy = await client.healthCheck();
  assert.strictEqual(healthy, true, 'healthCheck should return true when model is available');
});

// TC-EC-06: healthCheck() returns false on connection error
asyncTest('TC-EC-06: healthCheck() returns false on connection error', async () => {
  installFetchMock(async () => {
    throw new Error('ECONNREFUSED');
  });

  const client = new EmbeddingClient({
    ollamaUrl: 'http://localhost:11434',
    logger: silentLogger
  });

  const healthy = await client.healthCheck();
  assert.strictEqual(healthy, false, 'healthCheck should return false on connection error');
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
