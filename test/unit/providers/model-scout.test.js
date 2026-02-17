'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const { ModelScout, JOB_AFFINITY_MAP } = require('../../../src/lib/providers/model-scout');

const MOCK_TAGS_RESPONSE = {
  models: [
    {
      name: 'qwen3:8b',
      model: 'qwen3:8b',
      size: 4915200000,
      modified_at: '2025-01-15T10:00:00Z',
      details: { family: 'qwen3', parameter_size: '8B', format: 'gguf' }
    },
    {
      name: 'deepseek-coder:6.7b',
      model: 'deepseek-coder:6.7b',
      size: 3800000000,
      modified_at: '2025-01-10T10:00:00Z',
      details: { family: 'deepseek-coder', parameter_size: '6.7B', format: 'gguf' }
    },
    {
      name: 'llama3.1:70b',
      model: 'llama3.1:70b',
      size: 40000000000,
      modified_at: '2025-01-20T10:00:00Z',
      details: { family: 'llama', parameter_size: '70B', format: 'gguf' }
    }
  ]
};

const silentLogger = { log() {}, warn() {}, error() {} };

// -- Test 1: discover() parses Ollama /api/tags response --
asyncTest('discover() parses Ollama /api/tags response', async () => {
  // Mock global fetch
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => MOCK_TAGS_RESPONSE
  });

  try {
    const scout = new ModelScout({ ollamaEndpoint: 'http://localhost:11434', logger: silentLogger });
    const result = await scout.discover();

    assert.strictEqual(result.length, 3);
    assert.strictEqual(result[0].name, 'qwen3:8b');
    assert.strictEqual(result[0].family, 'qwen3');
    assert.strictEqual(result[0].paramSize, 8);
    assert.strictEqual(result[1].name, 'deepseek-coder:6.7b');
    assert.strictEqual(result[1].paramSize, 6.7);
    assert.strictEqual(result[2].paramSize, 70);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// -- Test 2: discover() handles Ollama offline gracefully --
asyncTest('discover() handles Ollama offline gracefully', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Connection refused'); };

  try {
    const scout = new ModelScout({ ollamaEndpoint: 'http://localhost:11434', logger: silentLogger });
    const result = await scout.discover();

    assert.ok(Array.isArray(result));
    assert.strictEqual(result.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// -- Test 3: _extractFamily() parses model name variants --
test('_extractFamily() parses model name variants', () => {
  const scout = new ModelScout({ logger: silentLogger });

  // With details.family
  assert.strictEqual(scout._extractFamily({ details: { family: 'Qwen3' } }), 'qwen3');

  // Without details, parse from name
  assert.strictEqual(scout._extractFamily({ name: 'mistral:7b' }), 'mistral');
  assert.strictEqual(scout._extractFamily({ name: 'llama3.1:70b' }), 'llama3.1');
  assert.strictEqual(scout._extractFamily({ name: 'deepseek-coder:6.7b' }), 'deepseek-coder');
});

// -- Test 4: _extractParamSize() extracts parameter sizes --
test('_extractParamSize() extracts parameter sizes', () => {
  const scout = new ModelScout({ logger: silentLogger });

  // From details.parameter_size
  assert.strictEqual(scout._extractParamSize({ details: { parameter_size: '8B' } }), 8);
  assert.strictEqual(scout._extractParamSize({ details: { parameter_size: '70B' } }), 70);
  assert.strictEqual(scout._extractParamSize({ details: { parameter_size: '6.7B' } }), 6.7);

  // From name tag
  assert.strictEqual(scout._extractParamSize({ name: 'qwen3:8b' }), 8);
  assert.strictEqual(scout._extractParamSize({ name: 'llama:70b' }), 70);

  // No size info
  assert.strictEqual(scout._extractParamSize({ name: 'custom-model' }), null);
});

// -- Test 5: generateLocalRoster() assigns models to jobs --
asyncTest('generateLocalRoster() assigns models to jobs based on affinity', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => MOCK_TAGS_RESPONSE
  });

  try {
    const scout = new ModelScout({ ollamaEndpoint: 'http://localhost:11434', logger: silentLogger });
    await scout.discover();
    const roster = scout.generateLocalRoster();

    assert.ok(roster !== null);
    // quick should include qwen3:8b (preferred for quick)
    assert.ok(roster.quick.includes('qwen3:8b'), `quick roster should include qwen3:8b, got: ${roster.quick}`);
    // coding should include deepseek-coder
    assert.ok(roster.coding.includes('deepseek-coder:6.7b'), `coding roster should include deepseek-coder:6.7b, got: ${roster.coding}`);
    // thinking should include the large model
    assert.ok(roster.thinking.includes('llama3.1:70b'), `thinking roster should include llama3.1:70b, got: ${roster.thinking}`);
    // credentials always gets the largest model
    assert.ok(roster.credentials.includes('llama3.1:70b'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// -- Test 6: generateLocalRoster() uses largest model as fallback --
asyncTest('generateLocalRoster() uses largest model as fallback for unmapped jobs', async () => {
  const originalFetch = globalThis.fetch;
  // Only one model with unusual family that doesn't match any affinity
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      models: [{
        name: 'unusual-model:7b',
        model: 'unusual-model:7b',
        size: 5000000000,
        details: { family: 'unusual', parameter_size: '7B' }
      }]
    })
  });

  try {
    const scout = new ModelScout({ ollamaEndpoint: 'http://localhost:11434', logger: silentLogger });
    await scout.discover();
    const roster = scout.generateLocalRoster();

    assert.ok(roster !== null);
    // All jobs should fall back to the only available model
    assert.deepStrictEqual(roster.quick, ['unusual-model:7b']);
    assert.deepStrictEqual(roster.thinking, ['unusual-model:7b']);
    assert.deepStrictEqual(roster.coding, ['unusual-model:7b']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// -- Test 7: generateLocalRoster() handles single-model scenario --
asyncTest('generateLocalRoster() handles single-model scenario', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      models: [{
        name: 'qwen3:8b',
        model: 'qwen3:8b',
        size: 4915200000,
        details: { family: 'qwen3', parameter_size: '8B' }
      }]
    })
  });

  try {
    const scout = new ModelScout({ ollamaEndpoint: 'http://localhost:11434', logger: silentLogger });
    await scout.discover();
    const roster = scout.generateLocalRoster();

    assert.ok(roster !== null);
    // qwen3 matches several affinities
    assert.ok(roster.quick.includes('qwen3:8b'));
    assert.ok(roster.tools.includes('qwen3:8b'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// -- Test 8: hasModel() matches by name and family --
asyncTest('hasModel() matches by name and family', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => MOCK_TAGS_RESPONSE
  });

  try {
    const scout = new ModelScout({ ollamaEndpoint: 'http://localhost:11434', logger: silentLogger });
    await scout.discover();

    // Exact name match
    assert.strictEqual(scout.hasModel('qwen3:8b'), true);
    // Family match
    assert.strictEqual(scout.hasModel('qwen3'), true);
    // Non-existent model
    assert.strictEqual(scout.hasModel('gpt-4'), false);
    // Before discover
    const scout2 = new ModelScout({ logger: silentLogger });
    assert.strictEqual(scout2.hasModel('qwen3:8b'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// Use setTimeout to allow all asyncTest promises to resolve before exiting.
// This matches the pattern used in audio-converter.test.js and whisper-client.test.js.
setTimeout(() => {
  summary();
  exitWithCode();
}, 100);
