/**
 * ModelResolver Unit Tests
 *
 * The single source of truth for "which model serves job X" and its trust level.
 * Covers precedence, the not-installed fallback, trust resolution, refresh, and
 * the startup interoception report (issue #123).
 *
 * Run: node test/unit/llm/model-resolver.test.js
 */

const assert = require('assert');
const { test, summary, exitWithCode } = require('../../helpers/test-runner');

const { ModelResolver } = require('../../../src/lib/llm/model-resolver');

// ============================================================
// Mock Factories
// ============================================================

/**
 * @param {Object} roster - job → model-name[] map (ModelScout shape)
 */
function createMockScout(roster, installed) {
  // `installed` defaults to every model named anywhere in the roster.
  const installedSet = new Set(
    installed || Object.values(roster || {}).flat()
  );
  return {
    generateLocalRoster: () => roster,
    hasModel: (name) => installedSet.has(name),
  };
}

function createMockCockpit(modelsConfig) {
  return { cachedConfig: { system: { modelsConfig } } };
}

const silentLogger = { info: () => {}, warn: () => {}, log: () => {} };

// ============================================================
// Tests
// ============================================================

console.log('\n=== ModelResolver Tests ===\n');

// --- Precedence ---
console.log('\n--- Precedence ---\n');

test('TC-RESOLVER-001: briefing Test 1 — ModelScout wins over static config', () => {
  // providers.json = phi4-mini, env = qwen3:8b, ModelScout discovers qwen3:8b.
  const resolver = new ModelResolver({
    deployerConfig: { model: 'phi4-mini' },
    envModel: 'qwen3:8b',
    modelScout: createMockScout({ tools: ['qwen3:8b'] }),
    logger: silentLogger,
  });
  const r = resolver.resolve('tools');
  assert.strictEqual(r.model, 'qwen3:8b');
  assert.strictEqual(r.source, 'model-scout');
});

test('TC-RESOLVER-002: deployer config used when no env, no scout', () => {
  const resolver = new ModelResolver({
    deployerConfig: { model: 'phi4-mini' },
    envModel: null,
    modelScout: null,
    logger: silentLogger,
  });
  const r = resolver.resolve('tools');
  assert.strictEqual(r.model, 'phi4-mini');
  assert.strictEqual(r.source, 'deployer-config');
});

test('TC-RESOLVER-003: explicit env overrides deployer (no scout)', () => {
  const resolver = new ModelResolver({
    deployerConfig: { model: 'phi4-mini' },
    envModel: 'mistral:7b',
    modelScout: null,
    logger: silentLogger,
  });
  const r = resolver.resolve('tools');
  assert.strictEqual(r.model, 'mistral:7b');
  assert.strictEqual(r.source, 'env-override');
});

test('TC-RESOLVER-004: env at code default (passed null) is NOT an override', () => {
  // The caller passes process.env.OLLAMA_MODEL || null. When unset → null →
  // the deployer config must win, not a phantom env value.
  const resolver = new ModelResolver({
    deployerConfig: { model: 'qwen3:8b' },
    envModel: null,
    modelScout: null,
    logger: silentLogger,
  });
  assert.strictEqual(resolver.resolve('tools').source, 'deployer-config');
});

test('TC-RESOLVER-005: Cockpit localDefault overrides ModelScout', () => {
  const resolver = new ModelResolver({
    deployerConfig: { model: 'phi4-mini' },
    envModel: 'qwen3:8b',
    modelScout: createMockScout({ tools: ['qwen3:8b', 'gemma:9b'] }, ['qwen3:8b', 'gemma:9b']),
    cockpitManager: createMockCockpit({ trust: 'local-only', localDefault: 'gemma:9b' }),
    logger: silentLogger,
  });
  const r = resolver.resolve('tools');
  assert.strictEqual(r.model, 'gemma:9b');
  assert.strictEqual(r.source, 'cockpit-card');
});

test('TC-RESOLVER-006: fallbackModel is last resort; default null', () => {
  const resolver = new ModelResolver({ logger: silentLogger });
  assert.strictEqual(resolver.resolve('tools').model, null);
  assert.strictEqual(resolver.resolve('tools').source, 'fallback');

  const withFallback = new ModelResolver({ fallbackModel: 'llama3:8b', logger: silentLogger });
  assert.strictEqual(withFallback.resolve('tools').model, 'llama3:8b');
});

// --- Not-installed fallback (inflammation rule) ---
console.log('\n--- Not-installed fallback ---\n');

test('TC-RESOLVER-010: briefing Test 5 — configured model not installed falls to scout pick', () => {
  const resolver = new ModelResolver({
    deployerConfig: { model: 'nonexistent-model' },
    modelScout: createMockScout({ tools: ['qwen3:8b'] }), // qwen3:8b installed, nonexistent not
    logger: silentLogger,
  });
  const r = resolver.resolve('tools');
  // deployer model not installed → ModelScout pick wins
  assert.strictEqual(r.model, 'qwen3:8b');
  assert.strictEqual(r.source, 'model-scout');
  assert.ok(r.fellBack, 'fellBack should be set');
  assert.strictEqual(r.fellBack.from, 'nonexistent-model');
  assert.strictEqual(r.fellBack.to, 'qwen3:8b');
});

test('TC-RESOLVER-011: Cockpit model not installed also falls back (operator typo)', () => {
  const resolver = new ModelResolver({
    modelScout: createMockScout({ tools: ['qwen3:8b'] }, ['qwen3:8b']),
    cockpitManager: createMockCockpit({ trust: 'local-only', localDefault: 'qwen3:80b-typo' }),
    logger: silentLogger,
  });
  const r = resolver.resolve('tools');
  assert.strictEqual(r.model, 'qwen3:8b');
  assert.strictEqual(r.source, 'model-scout');
  assert.ok(r.fellBack);
});

test('TC-RESOLVER-012: no fallback applied when ModelScout is down (cannot verify)', () => {
  const resolver = new ModelResolver({
    deployerConfig: { model: 'phi4-mini' },
    modelScout: null, // Ollama unreachable
    logger: silentLogger,
  });
  const r = resolver.resolve('tools');
  assert.strictEqual(r.model, 'phi4-mini');
  assert.strictEqual(r.fellBack, null);
});

// --- Trust ---
console.log('\n--- Trust ---\n');

test('TC-RESOLVER-020: default trust is cloud-ok', () => {
  const resolver = new ModelResolver({ deployerConfig: { model: 'x' }, logger: silentLogger });
  assert.strictEqual(resolver.resolve('tools').trust, 'cloud-ok');
});

test('TC-RESOLVER-021: Cockpit local-only wins', () => {
  const resolver = new ModelResolver({
    deployerConfig: { model: 'x' },
    cockpitManager: createMockCockpit({ trust: 'local-only' }),
    logger: silentLogger,
  });
  assert.strictEqual(resolver.resolve('tools').trust, 'local-only');
});

test('TC-RESOLVER-022: credentials job is always local-only regardless of card', () => {
  const resolver = new ModelResolver({
    deployerConfig: { model: 'x' },
    cockpitManager: createMockCockpit({ trust: 'cloud-ok' }),
    logger: silentLogger,
  });
  assert.strictEqual(resolver.resolve('credentials').trust, 'local-only');
});

test('TC-RESOLVER-023: malformed trust value ignored → default cloud-ok', () => {
  const resolver = new ModelResolver({
    deployerConfig: { model: 'x' },
    cockpitManager: createMockCockpit({ trust: 'banana' }),
    logger: silentLogger,
  });
  assert.strictEqual(resolver.resolve('tools').trust, 'cloud-ok');
});

// --- Provider label ---
console.log('\n--- Provider label ---\n');

test('TC-RESOLVER-030: quick job maps to ollama-fast, tools to ollama-local', () => {
  const resolver = new ModelResolver({ deployerConfig: { model: 'x' }, logger: silentLogger });
  assert.strictEqual(resolver.resolve('quick').provider, 'ollama-fast');
  assert.strictEqual(resolver.resolve('tools').provider, 'ollama-local');
});

// --- refresh() ---
console.log('\n--- refresh() ---\n');

test('TC-RESOLVER-040: refresh picks up a ModelScout assigned after construction', () => {
  // Mirrors webhook-server: resolver built with scout=null, scout assigned and
  // refresh() called once discovery completes.
  const resolver = new ModelResolver({
    deployerConfig: { model: 'phi4-mini' },
    modelScout: null,
    logger: silentLogger,
  });
  assert.strictEqual(resolver.resolve('tools').source, 'deployer-config');

  resolver.modelScout = createMockScout({ tools: ['qwen3:8b'] });
  resolver.refresh();
  const r = resolver.resolve('tools');
  assert.strictEqual(r.model, 'qwen3:8b');
  assert.strictEqual(r.source, 'model-scout');
});

test('TC-RESOLVER-041: refresh picks up a Cockpit trust change', () => {
  const cockpit = createMockCockpit({ trust: 'cloud-ok' });
  const resolver = new ModelResolver({
    deployerConfig: { model: 'x' },
    cockpitManager: cockpit,
    logger: silentLogger,
  });
  assert.strictEqual(resolver.resolve('tools').trust, 'cloud-ok');

  cockpit.cachedConfig.system.modelsConfig.trust = 'local-only';
  resolver.refresh();
  assert.strictEqual(resolver.resolve('tools').trust, 'local-only');
});

// --- describe() interoception ---
console.log('\n--- describe() interoception ---\n');

test('TC-RESOLVER-050: describe summarises resolved model + source per job', () => {
  const resolver = new ModelResolver({
    deployerConfig: { model: 'phi4-mini' },
    envModel: 'qwen3:8b',
    modelScout: createMockScout({ tools: ['qwen3:8b'], thinking: ['qwen3:8b'], quick: ['qwen2.5:3b'] }),
    logger: silentLogger,
  });
  const { summary: s, divergences } = resolver.describe(['tools', 'thinking', 'quick']);
  assert.ok(s.includes('tools→qwen3:8b (model-scout)'));
  assert.ok(s.includes('quick→qwen2.5:3b (model-scout)'));
  // deployer (phi4-mini) and scout (qwen3:8b) disagree → divergence reported
  assert.ok(divergences.some(d => d.includes("job 'tools'") && d.includes('model-scout wins')));
});

test('TC-RESOLVER-051: no divergence when all present sources agree', () => {
  const resolver = new ModelResolver({
    deployerConfig: { model: 'qwen3:8b' },
    envModel: 'qwen3:8b',
    modelScout: createMockScout({ tools: ['qwen3:8b'] }),
    logger: silentLogger,
  });
  const { divergences } = resolver.describe(['tools']);
  assert.strictEqual(divergences.length, 0);
});

// --- Robustness ---
console.log('\n--- Robustness ---\n');

test('TC-RESOLVER-060: empty job defaults to tools, never throws', () => {
  const resolver = new ModelResolver({ deployerConfig: { model: 'x' }, logger: silentLogger });
  assert.strictEqual(resolver.resolve('').provider, 'ollama-local');
});

test('TC-RESOLVER-061: ModelScout that throws on generateLocalRoster is tolerated', () => {
  const resolver = new ModelResolver({
    deployerConfig: { model: 'phi4-mini' },
    modelScout: { generateLocalRoster: () => { throw new Error('boom'); }, hasModel: () => false },
    logger: silentLogger,
  });
  assert.strictEqual(resolver.resolve('tools').model, 'phi4-mini');
});

// Summary
setTimeout(() => {
  summary();
  exitWithCode();
}, 100);
