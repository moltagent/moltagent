'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const { ModelScout, PRIOR_STRENGTH, CONTEXT_FLOOR } = require('../../../src/lib/providers/model-scout');

// A realistic mixed pool: two tool-capable chat models of different sizes, a
// small text-only chat model, an embedding model, and a vision model.
const TAGS_MODELS = [
  { name: 'qwen3:8b', model: 'qwen3:8b', size: 5200000000, modified_at: '2025-01-20T10:00:00Z', details: { family: 'qwen3', parameter_size: '8.2B', format: 'gguf' } },
  { name: 'qwen2.5:3b', model: 'qwen2.5:3b', size: 2000000000, modified_at: '2025-01-15T10:00:00Z', details: { family: 'qwen2', parameter_size: '3.1B', format: 'gguf' } },
  { name: 'gemma2:2b', model: 'gemma2:2b', size: 1600000000, modified_at: '2025-01-10T10:00:00Z', details: { family: 'gemma2', parameter_size: '2.6B', format: 'gguf' } },
  { name: 'nomic-embed-text:latest', model: 'nomic-embed-text:latest', size: 270000000, modified_at: '2025-01-05T10:00:00Z', details: { family: 'nomic-bert', parameter_size: '137M', format: 'gguf' } },
  { name: 'llava:7b', model: 'llava:7b', size: 4700000000, modified_at: '2025-01-12T10:00:00Z', details: { family: 'llama', parameter_size: '7B', format: 'gguf' } }
];

const SHOW_BY_MODEL = {
  'qwen3:8b': { capabilities: ['completion', 'tools', 'thinking'], model_info: { 'qwen3.context_length': 40960 } },
  'qwen2.5:3b': { capabilities: ['completion', 'tools'], model_info: { 'qwen2.context_length': 32768 } },
  'gemma2:2b': { capabilities: ['completion'], model_info: { 'gemma2.context_length': 8192 } },
  'nomic-embed-text:latest': { capabilities: ['embedding'], model_info: { 'nomic-bert.context_length': 2048 } },
  'llava:7b': { capabilities: ['completion', 'vision'], model_info: { 'llama.context_length': 8192 } }
};

const silentLogger = { log() {}, warn() {}, error() {} };

// These tests swap globalThis.fetch, so they must run sequentially — the async
// discover() now probes /api/show per model, widening the window in which a
// concurrent test could clobber the shared fetch mock. main() awaits each in order.
const suite = [];
function scenario(name, fn) { suite.push({ name, fn }); }

/**
 * Build a fetch mock that routes /api/tags and /api/show by URL.
 * @param {Array} tags - models for /api/tags
 * @param {Object} showByModel - model name → /api/show payload
 * @param {Object} [opts] - { showFails: true } to make /api/show error
 */
function mockFetch(tags, showByModel, opts = {}) {
  return async (url, options) => {
    if (String(url).includes('/api/tags')) {
      return { ok: true, json: async () => ({ models: tags }) };
    }
    if (String(url).includes('/api/show')) {
      if (opts.showFails) return { ok: false, status: 500, json: async () => ({}) };
      const body = JSON.parse(options.body);
      return { ok: true, json: async () => (showByModel[body.model] || {}) };
    }
    throw new Error(`unexpected url ${url}`);
  };
}

async function withMock(fetchImpl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

// -- discover() parses /api/tags and senses capabilities via /api/show --
scenario('discover() parses tags and attaches declared capabilities', async () => {
  await withMock(mockFetch(TAGS_MODELS, SHOW_BY_MODEL), async () => {
    const scout = new ModelScout({ ollamaEndpoint: 'http://localhost:11434', logger: silentLogger });
    const result = await scout.discover();

    assert.strictEqual(result.length, 5);
    const qwen3 = result.find(m => m.name === 'qwen3:8b');
    assert.strictEqual(qwen3.paramSize, 8.2);
    assert.strictEqual(qwen3.family, 'qwen3');
    assert.deepStrictEqual(qwen3.capabilities, ['completion', 'tools', 'thinking']);
    assert.strictEqual(qwen3.contextLength, 40960);

    const nomic = result.find(m => m.name === 'nomic-embed-text:latest');
    assert.deepStrictEqual(nomic.capabilities, ['embedding']);
  });
});

// -- discover() handles Ollama offline gracefully --
scenario('discover() handles Ollama offline gracefully', async () => {
  await withMock(async () => { throw new Error('Connection refused'); }, async () => {
    const scout = new ModelScout({ ollamaEndpoint: 'http://localhost:11434', logger: silentLogger });
    const result = await scout.discover();
    assert.ok(Array.isArray(result));
    assert.strictEqual(result.length, 0);
  });
});

// -- discover() falls back to text-capable when /api/show is unreachable --
scenario('discover() defaults to text-generation when /api/show fails', async () => {
  await withMock(mockFetch(TAGS_MODELS, SHOW_BY_MODEL, { showFails: true }), async () => {
    const scout = new ModelScout({ ollamaEndpoint: 'http://localhost:11434', logger: silentLogger });
    const result = await scout.discover();
    // Every model should be treated as text-generation-capable, never dark.
    assert.ok(result.every(m => m.capabilities.includes('completion')));
    assert.ok(result.every(m => m.contextLength === null));
  });
});

// -- _extractFamily() parses model name variants --
test('_extractFamily() parses model name variants', () => {
  const scout = new ModelScout({ logger: silentLogger });
  assert.strictEqual(scout._extractFamily({ details: { family: 'Qwen3' } }), 'qwen3');
  assert.strictEqual(scout._extractFamily({ name: 'mistral:7b' }), 'mistral');
  assert.strictEqual(scout._extractFamily({ name: 'llama3.1:70b' }), 'llama3.1');
  assert.strictEqual(scout._extractFamily({ name: 'deepseek-coder:6.7b' }), 'deepseek-coder');
});

// -- _extractParamSize() extracts parameter sizes --
test('_extractParamSize() extracts parameter sizes', () => {
  const scout = new ModelScout({ logger: silentLogger });
  assert.strictEqual(scout._extractParamSize({ details: { parameter_size: '8B' } }), 8);
  assert.strictEqual(scout._extractParamSize({ details: { parameter_size: '70B' } }), 70);
  assert.strictEqual(scout._extractParamSize({ details: { parameter_size: '6.7B' } }), 6.7);
  assert.strictEqual(scout._extractParamSize({ name: 'qwen3:8b' }), 8);
  assert.strictEqual(scout._extractParamSize({ name: 'custom-model' }), null);
});

// -- _extractContextLength() reads model_info --
test('_extractContextLength() reads the family context_length key', () => {
  const scout = new ModelScout({ logger: silentLogger });
  assert.strictEqual(scout._extractContextLength({ model_info: { 'qwen3.context_length': 40960 } }), 40960);
  assert.strictEqual(scout._extractContextLength({ context_length: 8192 }), 8192);
  assert.strictEqual(scout._extractContextLength({}), null);
});

// -- capability gate: embedding and vision models excluded from text jobs --
scenario('generateLocalRoster() excludes embedding and vision from text jobs', async () => {
  await withMock(mockFetch(TAGS_MODELS, SHOW_BY_MODEL), async () => {
    const scout = new ModelScout({ ollamaEndpoint: 'http://localhost:11434', logger: silentLogger });
    await scout.discover();
    const roster = scout.generateLocalRoster();

    const everyModel = Object.values(roster).flat();
    assert.ok(!everyModel.includes('nomic-embed-text:latest'), 'embedding model must not appear in any job');
    assert.ok(!everyModel.includes('llava:7b'), 'vision model must not appear in any job');
  });
});

// -- per-job prior: smallest for quick/classification, largest for depth jobs --
scenario('generateLocalRoster() applies the per-job size prior', async () => {
  await withMock(mockFetch(TAGS_MODELS, SHOW_BY_MODEL), async () => {
    const scout = new ModelScout({ ollamaEndpoint: 'http://localhost:11434', logger: silentLogger });
    await scout.discover();
    const roster = scout.generateLocalRoster();

    // Smallest text-gen model leads latency jobs (gemma2:2b at 2.6B).
    assert.strictEqual(roster.quick[0], 'gemma2:2b');
    assert.strictEqual(roster.classification[0], 'gemma2:2b');

    // Largest text-gen model leads depth jobs (qwen3:8b at 8.2B).
    assert.strictEqual(roster.thinking[0], 'qwen3:8b');
    assert.strictEqual(roster.writing[0], 'qwen3:8b');
    assert.strictEqual(roster.research[0], 'qwen3:8b');
    assert.strictEqual(roster.credentials[0], 'qwen3:8b');
  });
});

// -- tools/coding draw only from tool-capable models, largest first --
scenario('generateLocalRoster() routes tools/coding to tool-capable models only', async () => {
  await withMock(mockFetch(TAGS_MODELS, SHOW_BY_MODEL), async () => {
    const scout = new ModelScout({ ollamaEndpoint: 'http://localhost:11434', logger: silentLogger });
    await scout.discover();
    const roster = scout.generateLocalRoster();

    // Only qwen3:8b and qwen2.5:3b declare `tools`; gemma2:2b (text-only) excluded.
    assert.deepStrictEqual(roster.tools, ['qwen3:8b', 'qwen2.5:3b']);
    assert.deepStrictEqual(roster.coding, ['qwen3:8b', 'qwen2.5:3b']);
    assert.ok(!roster.tools.includes('gemma2:2b'), 'non-tool model must not serve tools');
  });
});

// -- fallback: no tool-capable model → tools reuses the text roster (never dark) --
scenario('generateLocalRoster() falls back to text roster when no tool-capable model', async () => {
  const tags = [TAGS_MODELS[2], TAGS_MODELS[3]]; // gemma2:2b (text-only) + nomic (embedding)
  await withMock(mockFetch(tags, SHOW_BY_MODEL), async () => {
    const scout = new ModelScout({ ollamaEndpoint: 'http://localhost:11434', logger: silentLogger });
    await scout.discover();
    const roster = scout.generateLocalRoster();

    assert.deepStrictEqual(roster.tools, ['gemma2:2b']);
    assert.deepStrictEqual(roster.coding, ['gemma2:2b']);
    assert.strictEqual(roster.quick[0], 'gemma2:2b');
  });
});

// -- returns null when nothing is discovered --
scenario('generateLocalRoster() returns null with no models', async () => {
  await withMock(async () => { throw new Error('offline'); }, async () => {
    const scout = new ModelScout({ ollamaEndpoint: 'http://localhost:11434', logger: silentLogger });
    await scout.discover();
    assert.strictEqual(scout.generateLocalRoster(), null);
  });
});

// -- returns null (not {}) when models exist but none can serve a text job --
scenario('generateLocalRoster() returns null when only non-text models exist', async () => {
  const tags = [TAGS_MODELS[3], TAGS_MODELS[4]]; // nomic (embedding) + llava (vision)
  await withMock(mockFetch(tags, SHOW_BY_MODEL), async () => {
    const scout = new ModelScout({ ollamaEndpoint: 'http://localhost:11434', logger: silentLogger });
    await scout.discover();
    assert.strictEqual(scout.generateLocalRoster(), null);
  });
});

// -- context-length gate: excludes a large low-context model from long-context
// jobs, but only for the jobs that carry a CONTEXT_FLOOR. Bespoke pool (not the
// shared TAGS_MODELS/SHOW_BY_MODEL) to avoid cross-test coupling. --
scenario('context gate excludes a large low-context model from long-context jobs', async () => {
  const tags = [
    { name: 'big-shortctx:14b', model: 'big-shortctx:14b', size: 9000000000, modified_at: '2025-02-01T10:00:00Z', details: { family: 'bigmodel', parameter_size: '14B', format: 'gguf' } },
    { name: 'qwen3:8b', model: 'qwen3:8b', size: 5200000000, modified_at: '2025-01-20T10:00:00Z', details: { family: 'qwen3', parameter_size: '8.2B', format: 'gguf' } },
  ];
  const show = {
    'big-shortctx:14b': { capabilities: ['completion'], model_info: { 'bigmodel.context_length': 4096 } },
    'qwen3:8b': { capabilities: ['completion', 'tools'], model_info: { 'qwen3.context_length': 40960 } },
  };
  await withMock(mockFetch(tags, show), async () => {
    const scout = new ModelScout({ ollamaEndpoint: 'http://localhost:11434', logger: silentLogger });
    await scout.discover();
    const roster = scout.generateLocalRoster();

    // The larger model (14B) has a 4096 window — below the 8192 floor — so it
    // is gated out of thinking despite being the largest.
    assert.strictEqual(roster.thinking[0], 'qwen3:8b', 'low-context 14B model must be gated out of thinking');
    assert.ok(!roster.thinking.includes('big-shortctx:14b'), 'low-context model excluded from thinking');

    // quick is ungated (no CONTEXT_FLOOR entry) — the low-context model still
    // serves it, proving the gate is job-scoped, not a global exclusion.
    assert.ok(roster.quick.includes('big-shortctx:14b'), 'quick is ungated — low-context model still eligible');
  });
});

scenario('context gate never goes dark — all-low-context falls back ungated', async () => {
  const tags = [
    { name: 'qwen3:8b', model: 'qwen3:8b', size: 5200000000, modified_at: '2025-01-20T10:00:00Z', details: { family: 'qwen3', parameter_size: '8.2B', format: 'gguf' } },
    { name: 'gemma2:2b', model: 'gemma2:2b', size: 1600000000, modified_at: '2025-01-10T10:00:00Z', details: { family: 'gemma2', parameter_size: '2.6B', format: 'gguf' } },
  ];
  const show = {
    'qwen3:8b': { capabilities: ['completion', 'tools'], model_info: { 'qwen3.context_length': 4096 } },
    'gemma2:2b': { capabilities: ['completion'], model_info: { 'gemma2.context_length': 4096 } },
  };
  await withMock(mockFetch(tags, show), async () => {
    const scout = new ModelScout({ ollamaEndpoint: 'http://localhost:11434', logger: silentLogger });
    await scout.discover();
    const roster = scout.generateLocalRoster();

    // Every model is below the floor — the gate would empty the list, so the
    // never-go-dark fallback returns the ungated largest-first order.
    assert.ok(roster.thinking.length > 0, 'thinking must never go dark');
    assert.strictEqual(roster.thinking[0], 'qwen3:8b', 'ungated largest-first order preserved on fallback');
  });
});

scenario('null contextLength passes the gate (unknown is not evidence of smallness)', async () => {
  const tags = [
    { name: 'huge:20b', model: 'huge:20b', size: 13000000000, modified_at: '2025-02-05T10:00:00Z', details: { family: 'hugemodel', parameter_size: '20B', format: 'gguf' } },
    { name: 'qwen3:8b', model: 'qwen3:8b', size: 5200000000, modified_at: '2025-01-20T10:00:00Z', details: { family: 'qwen3', parameter_size: '8.2B', format: 'gguf' } },
  ];
  const show = {
    // No model_info / context_length at all — _extractContextLength returns null.
    'huge:20b': { capabilities: ['completion'] },
    'qwen3:8b': { capabilities: ['completion', 'tools'], model_info: { 'qwen3.context_length': 40960 } },
  };
  await withMock(mockFetch(tags, show), async () => {
    const scout = new ModelScout({ ollamaEndpoint: 'http://localhost:11434', logger: silentLogger });
    await scout.discover();
    const roster = scout.generateLocalRoster();

    assert.ok(roster.thinking.includes('huge:20b'), 'null contextLength passes the gate — unknown is not evidence of smallness');
    assert.strictEqual(roster.thinking[0], 'huge:20b', 'largest-first order unaffected by an unknown-context model');
  });
});

// -- PRIOR_STRENGTH / CONTEXT_FLOOR shape --
test('PRIOR_STRENGTH shape — tools/coding weak, classification ground-truth', () => {
  assert.strictEqual(PRIOR_STRENGTH.tools, 'weak');
  assert.strictEqual(PRIOR_STRENGTH.coding, 'weak');
  assert.strictEqual(PRIOR_STRENGTH.classification, 'ground-truth');
  assert.strictEqual(PRIOR_STRENGTH.quick, 'latency');
  assert.strictEqual(PRIOR_STRENGTH.thinking, 'strong');
  assert.ok(Object.isFrozen(PRIOR_STRENGTH), 'PRIOR_STRENGTH must be frozen');
});

test('CONTEXT_FLOOR only long-context jobs', () => {
  assert.strictEqual(CONTEXT_FLOOR.thinking, 8192);
  assert.strictEqual(CONTEXT_FLOOR.writing, 8192);
  assert.strictEqual(CONTEXT_FLOOR.research, 8192);
  assert.strictEqual(CONTEXT_FLOOR.quick, undefined);
  assert.strictEqual(CONTEXT_FLOOR.tools, undefined);
  assert.strictEqual(CONTEXT_FLOOR.credentials, undefined);
  assert.ok(Object.isFrozen(CONTEXT_FLOOR), 'CONTEXT_FLOOR must be frozen');
});

// -- hasModel() matches by name and family --
scenario('hasModel() matches by name and family', async () => {
  await withMock(mockFetch(TAGS_MODELS, SHOW_BY_MODEL), async () => {
    const scout = new ModelScout({ ollamaEndpoint: 'http://localhost:11434', logger: silentLogger });
    await scout.discover();
    assert.strictEqual(scout.hasModel('qwen3:8b'), true);
    assert.strictEqual(scout.hasModel('qwen3'), true);
    assert.strictEqual(scout.hasModel('gpt-4'), false);
    const scout2 = new ModelScout({ logger: silentLogger });
    assert.strictEqual(scout2.hasModel('qwen3:8b'), false);
  });
});

// Run the fetch-mocking scenarios sequentially, then report.
(async () => {
  for (const { name, fn } of suite) {
    await asyncTest(name, fn);
  }
  summary();
  exitWithCode();
})();
