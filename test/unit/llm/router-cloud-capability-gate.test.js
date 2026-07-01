'use strict';

/**
 * LLMRouter Cloud Capability Gate Tests (Session 1: Declared tier, cloud)
 *
 * Architecture Brief:
 * -------------------
 * Problem: Verify the capability gate spans cloud — the tools job draws only
 * from tool-capable cloud models, a non-tool cloud model (an embedding
 * endpoint the descriptor declares) is excluded, and an unrecognized cloud
 * model is kept (never dark) rather than dropped.
 *
 * Pattern: Build a router through the real _initializeProviders path (so each
 * provider carries its adapter), then read the resolved preset roster.
 *
 * Run: node test/unit/llm/router-cloud-capability-gate.test.js
 *
 * @module test/unit/llm/router-cloud-capability-gate
 */

const assert = require('assert');
const { test, summary, exitWithCode } = require('../../helpers/test-runner');

const LLMRouter = require('../../../src/lib/llm/router');

console.log('\n=== LLMRouter Cloud Capability Gate Tests ===\n');

/**
 * Router with a local model, a tool-capable cloud model (Haiku, more
 * expensive), and a CHEAPER cloud embedding endpoint. Without the gate the
 * embedding model — being cheapest — would win the tools job.
 */
function routerWithEmbeddingTrap() {
  const router = new LLMRouter({
    providers: {
      'ollama-local': { adapter: 'ollama', type: 'local', model: 'qwen3:8b', endpoint: 'http://localhost:11434' },
      'claude-haiku': { adapter: 'anthropic', type: 'api', model: 'claude-haiku-4-5-20251001', costModel: { type: 'per_token', inputPer1M: 0.8, outputPer1M: 4.0 } },
      'openai-embed': { adapter: 'openai', type: 'api', model: 'text-embedding-3-small', endpoint: 'https://api.openai.com/v1', costModel: { type: 'per_token', inputPer1M: 0.02, outputPer1M: 0.02 } },
    },
  });
  return router;
}

test('smart-mix tools job draws only from tool-capable cloud models', () => {
  const router = routerWithEmbeddingTrap();
  const roster = router._resolvePreset('smart-mix');

  // The tool-capable cloud model wins tools even though the embedding endpoint
  // is cheaper; the embedding endpoint is excluded from the tools roster.
  assert.strictEqual(roster.tools[0], 'claude-haiku', 'tool-capable cloud leads the tools job');
  assert.ok(!roster.tools.includes('openai-embed'), 'declared non-tool cloud model excluded from tools');
  assert.ok(roster.tools.includes('ollama-local'), 'local fallback retained');
});

test('cloud-first tools job excludes the non-tool cloud model', () => {
  const router = routerWithEmbeddingTrap();
  const roster = router._resolvePreset('cloud-first');
  assert.strictEqual(roster.tools[0], 'claude-haiku');
  assert.ok(!roster.tools.includes('openai-embed'));
});

test('non-tools cloud jobs are untouched this session (scope: tools gate only)', () => {
  // Session 1 gates only the tools job. Other jobs keep cost-tier selection
  // unchanged (broader per-job capability gating is Session 2). The cheapest
  // cloud provider still leads a non-tool job.
  const router = routerWithEmbeddingTrap();
  const roster = router._resolvePreset('smart-mix');
  assert.strictEqual(roster.thinking[0], 'claude-haiku', 'depth job unchanged (Haiku is the priciest → heavy tier here)');
});

test('unrecognized cloud model is kept in the tools roster (never dark) + logged once', () => {
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  let roster;
  try {
    const router = new LLMRouter({
      providers: {
        'ollama-local': { adapter: 'ollama', type: 'local', model: 'qwen3:8b', endpoint: 'http://localhost:11434' },
        'mystery-cloud': { adapter: 'openai-compatible', type: 'api', model: 'some-llama-70b', endpoint: 'https://example.test/v1', costModel: { type: 'per_token', inputPer1M: 1, outputPer1M: 1 } },
      },
    });
    roster = router._resolvePreset('smart-mix');
    // Rebuild once more to prove the unknown warning fires only once.
    router._resolvePreset('smart-mix');
  } finally {
    console.log = origLog;
  }

  assert.strictEqual(roster.tools[0], 'mystery-cloud', 'unknown cloud model kept in tools (fail-open)');
  const unknownWarns = logs.filter(l => l.includes('not in capability descriptor') && l.includes('mystery-cloud'));
  assert.strictEqual(unknownWarns.length, 1, 'unknown cloud capability warned exactly once');
});

test('describeCloudCapabilityClasses classes cloud providers by the shared classifier', () => {
  const router = routerWithEmbeddingTrap();
  const classed = router.describeCloudCapabilityClasses();
  const byId = Object.fromEntries(classed.map(c => [c.id, c]));

  assert.ok(byId['claude-haiku'].classes.includes('tool-capable'), 'Haiku classed tool-capable');
  assert.ok(byId['claude-haiku'].classes.includes('text-generation'));
  assert.deepStrictEqual(byId['openai-embed'].classes, ['embedding'], 'embedding endpoint classed embedding-only');
  // Local provider is not part of the cloud descriptor report.
  assert.ok(!byId['ollama-local']);
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
