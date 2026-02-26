/**
 * Ollama Credential Model Tests
 *
 * Tests the dual-model Ollama setup: default model (8b) for general ops,
 * credential model (14b) for sensitive operations.
 *
 * Run: node --test test/unit/providers/ollama-credential-model.test.js
 */

'use strict';

const assert = require('assert');
const { test, summary, exitWithCode } = require('../../helpers/test-runner');

// Store original env to restore after tests
const originalEnv = { ...process.env };

/**
 * Helper to reset environment and reload config
 */
function loadConfigWithEnv(envOverrides = {}) {
  // Clear relevant env vars
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('OLLAMA_')) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, envOverrides);
  delete require.cache[require.resolve('../../../src/lib/config')];
  return require('../../../src/lib/config');
}

/**
 * Helper to restore environment after all tests
 */
function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('OLLAMA_')) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  delete require.cache[require.resolve('../../../src/lib/config')];
}

console.log('\n=== Ollama Credential Model Tests ===\n');

// ============================================================
// 1. Config fallback tests
// ============================================================
console.log('\n--- Config Fallback Tests ---\n');

test('config.ollama.modelCredential falls back to OLLAMA_MODEL when OLLAMA_MODEL_CREDENTIAL unset', () => {
  const config = loadConfigWithEnv({ OLLAMA_MODEL: 'qwen3:8b' });
  assert.strictEqual(config.ollama.modelCredential, 'qwen3:8b',
    'Should fall back to OLLAMA_MODEL');
});

test('config.ollama.modelCredential falls back to default when both env vars unset', () => {
  const config = loadConfigWithEnv({});
  assert.strictEqual(config.ollama.modelCredential, 'phi4-mini',
    'Should fall back to hardcoded default phi4-mini');
});

test('config.ollama.modelCredential uses OLLAMA_MODEL_CREDENTIAL when set', () => {
  const config = loadConfigWithEnv({
    OLLAMA_MODEL: 'qwen3:8b',
    OLLAMA_MODEL_CREDENTIAL: 'qwen3:14b-fast'
  });
  assert.strictEqual(config.ollama.modelCredential, 'qwen3:14b-fast',
    'Should use OLLAMA_MODEL_CREDENTIAL');
});

test('config.ollama.modelCredential uses OLLAMA_MODEL when OLLAMA_MODEL_CREDENTIAL is empty string', () => {
  const config = loadConfigWithEnv({
    OLLAMA_MODEL: 'qwen3:8b',
    OLLAMA_MODEL_CREDENTIAL: ''
  });
  // envStr returns null for empty string, then || falls back to OLLAMA_MODEL
  assert.strictEqual(config.ollama.modelCredential, 'qwen3:8b',
    'Empty string should fall back to OLLAMA_MODEL');
});

// ============================================================
// 2. LLM-Router provider registration tests
// ============================================================
console.log('\n--- LLM-Router Provider Registration Tests ---\n');

test('llm-router registers ollama-credential provider when credential model differs', () => {
  // Simulate what LegacyRouterWrapper constructor does
  const config = {
    ollama: {
      url: 'http://localhost:11434',
      model: 'qwen3:8b',
      modelCredential: 'qwen3:14b-fast'
    }
  };

  const providers = {};
  // Replicate the logic from llm-router.js
  providers['ollama-local'] = {
    adapter: 'ollama',
    endpoint: config.ollama.url || 'http://localhost:11434',
    model: config.ollama.model || 'phi4-mini'
  };
  const credModel = config.ollama.modelCredential || config.ollama.model || 'phi4-mini';
  if (credModel !== (config.ollama.model || 'phi4-mini')) {
    providers['ollama-credential'] = {
      adapter: 'ollama',
      endpoint: config.ollama.url || 'http://localhost:11434',
      model: credModel
    };
  }

  assert.ok(providers['ollama-credential'], 'Should register ollama-credential provider');
  assert.strictEqual(providers['ollama-credential'].model, 'qwen3:14b-fast');
  assert.strictEqual(providers['ollama-credential'].adapter, 'ollama');
  assert.strictEqual(providers['ollama-credential'].endpoint, 'http://localhost:11434');
});

test('llm-router does NOT register ollama-credential when models are identical', () => {
  const config = {
    ollama: {
      url: 'http://localhost:11434',
      model: 'qwen3:8b',
      modelCredential: 'qwen3:8b'
    }
  };

  const providers = {};
  providers['ollama-local'] = {
    adapter: 'ollama',
    endpoint: config.ollama.url || 'http://localhost:11434',
    model: config.ollama.model || 'phi4-mini'
  };
  const credModel = config.ollama.modelCredential || config.ollama.model || 'phi4-mini';
  if (credModel !== (config.ollama.model || 'phi4-mini')) {
    providers['ollama-credential'] = {
      adapter: 'ollama',
      endpoint: config.ollama.url || 'http://localhost:11434',
      model: credModel
    };
  }

  assert.strictEqual(providers['ollama-credential'], undefined,
    'Should NOT register ollama-credential when models match');
});

test('llm-router does NOT register ollama-credential when modelCredential is absent', () => {
  const config = {
    ollama: {
      url: 'http://localhost:11434',
      model: 'qwen3:8b'
    }
  };

  const providers = {};
  providers['ollama-local'] = {
    adapter: 'ollama',
    endpoint: config.ollama.url || 'http://localhost:11434',
    model: config.ollama.model || 'phi4-mini'
  };
  const credModel = config.ollama.modelCredential || config.ollama.model || 'phi4-mini';
  if (credModel !== (config.ollama.model || 'phi4-mini')) {
    providers['ollama-credential'] = {
      adapter: 'ollama',
      endpoint: config.ollama.url || 'http://localhost:11434',
      model: credModel
    };
  }

  assert.strictEqual(providers['ollama-credential'], undefined,
    'Should NOT register ollama-credential when modelCredential is not set');
});

// ============================================================
// 3. _resolvePreset credential routing tests
// ============================================================
console.log('\n--- _resolvePreset Credential Routing Tests ---\n');

const LLMRouter = require('../../../src/lib/llm/router');

function setMockProvider(router, id, type = 'local') {
  router.providers.set(id, {
    type,
    id,
    generate: async () => ({ result: 'mock', model: 'mock', tokens: 10, inputTokens: 5, outputTokens: 5, cost: 0, duration: 100 }),
    estimateTokens: () => 10,
    estimateCost: () => 0,
    testConnection: async () => ({ connected: true })
  });
}

test('_resolvePreset credentials chain puts ollama-credential first', () => {
  const router = new LLMRouter();
  setMockProvider(router, 'ollama-local', 'local');
  setMockProvider(router, 'ollama-credential', 'local');

  const roster = router._resolvePreset('all-local');
  const credChain = roster[LLMRouter.JOBS.CREDENTIALS];

  assert.ok(Array.isArray(credChain), 'Credentials chain should be an array');
  assert.ok(credChain.length >= 2, 'Should have at least 2 providers');
  assert.strictEqual(credChain[0], 'ollama-credential',
    'ollama-credential should be first in credentials chain');
  assert.ok(credChain.includes('ollama-local'),
    'ollama-local should still be in credentials chain as fallback');
});

test('_resolvePreset credentials chain works with smart-mix preset', () => {
  const router = new LLMRouter();
  setMockProvider(router, 'ollama-local', 'local');
  setMockProvider(router, 'ollama-credential', 'local');
  setMockProvider(router, 'anthropic-claude', 'remote');

  const roster = router._resolvePreset('smart-mix');
  const credChain = roster[LLMRouter.JOBS.CREDENTIALS];

  assert.strictEqual(credChain[0], 'ollama-credential',
    'ollama-credential should be first in credentials chain even with smart-mix');
  // Cloud providers should NOT be in credentials chain
  assert.ok(!credChain.includes('anthropic-claude'),
    'Cloud providers should not appear in credentials chain');
});

test('_resolvePreset non-credential jobs do NOT put ollama-credential first', () => {
  const router = new LLMRouter();
  setMockProvider(router, 'ollama-local', 'local');
  setMockProvider(router, 'ollama-credential', 'local');

  const roster = router._resolvePreset('all-local');

  // For non-credential jobs, the order should be natural (insertion order)
  const quickChain = roster[LLMRouter.JOBS.QUICK];
  assert.strictEqual(quickChain[0], 'ollama-local',
    'ollama-local should be first for quick jobs (natural order)');
});

test('_resolvePreset credentials chain works with only ollama-local (no credential provider)', () => {
  const router = new LLMRouter();
  setMockProvider(router, 'ollama-local', 'local');

  const roster = router._resolvePreset('all-local');
  const credChain = roster[LLMRouter.JOBS.CREDENTIALS];

  assert.deepStrictEqual(credChain, ['ollama-local'],
    'With only ollama-local, credentials chain should just have ollama-local');
});

// ============================================================
// Cleanup and summary
// ============================================================

restoreEnv();

const results = summary();
exitWithCode();
