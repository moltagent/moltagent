/**
 * LLMRouter Job-Based Routing Tests
 *
 * Tests for the roster/job routing system (Session B1).
 * When roster is null (default), all legacy behavior is preserved.
 *
 * Run: node test/unit/llm/router-jobs.test.js
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const { createMockAuditLog, createMockNotifyUser } = require('../../helpers/mock-factories');

const LLMRouter = require('../../../src/lib/llm/router');

// ============================================================
// Mock Provider Factory
// ============================================================

function createMockProvider(overrides = {}) {
  return {
    type: overrides.type || 'remote',
    id: overrides.id || 'mock-provider',
    generate: overrides.generate || (async (task, content, options) => ({
      result: `Response from ${overrides.id || 'mock-provider'}`,
      model: 'mock-model',
      tokens: 150,
      inputTokens: 50,
      outputTokens: 100,
      cost: overrides.type === 'local' ? 0 : 0.001,
      duration: 500,
      headers: {}
    })),
    estimateTokens: overrides.estimateTokens || ((content) => Math.ceil(String(content).length / 4)),
    estimateCost: overrides.estimateCost || ((input, output) => overrides.type === 'local' ? 0 : (input + output) * 0.00001),
    testConnection: overrides.testConnection || (async () => ({ connected: true }))
  };
}

function createRouterWithProviders() {
  const router = new LLMRouter({
    roles: {
      sovereign: ['ollama-local'],
      free: ['ollama-local'],
      value: ['ollama-local', 'cloud-1'],
      premium: ['cloud-1']
    }
  });
  router.providers.set('ollama-local', createMockProvider({ id: 'ollama-local', type: 'local' }));
  router.providers.set('cloud-1', createMockProvider({ id: 'cloud-1', type: 'api' }));
  return router;
}

// ============================================================
// Test Suites
// ============================================================

console.log('\n=== LLMRouter Job-Based Routing Tests ===\n');

// --- Constants Validation ---
console.log('\n--- Constants Validation ---\n');

test('TC-JOB-CONST-001: JOBS has 10 keys', () => {
  const keys = Object.keys(LLMRouter.JOBS);
  assert.strictEqual(keys.length, 10);
  assert.ok(keys.includes('QUICK'));
  assert.ok(keys.includes('CLASSIFICATION'));
  assert.ok(keys.includes('TOOLS'));
  assert.ok(keys.includes('THINKING'));
  assert.ok(keys.includes('WRITING'));
  assert.ok(keys.includes('RESEARCH'));
  assert.ok(keys.includes('CODING'));
  assert.ok(keys.includes('CREDENTIALS'));
  assert.ok(keys.includes('SYNTHESIS'));
});

test('TC-JOB-CONST-002: JOBS values are lowercase strings', () => {
  for (const val of Object.values(LLMRouter.JOBS)) {
    assert.strictEqual(typeof val, 'string');
    assert.strictEqual(val, val.toLowerCase());
  }
});

test('TC-JOB-CONST-003: PRESET_NAMES has 3 entries', () => {
  assert.strictEqual(LLMRouter.PRESET_NAMES.length, 3);
  assert.ok(LLMRouter.PRESET_NAMES.includes('all-local'));
  assert.ok(LLMRouter.PRESET_NAMES.includes('smart-mix'));
  assert.ok(LLMRouter.PRESET_NAMES.includes('cloud-first'));
});

test('TC-JOB-CONST-004: VALID_JOBS is a Set with 10 entries', () => {
  assert.ok(LLMRouter.VALID_JOBS instanceof Set);
  assert.strictEqual(LLMRouter.VALID_JOBS.size, 10);
  assert.ok(LLMRouter.VALID_JOBS.has('quick'));
  assert.ok(LLMRouter.VALID_JOBS.has('classification'));
  assert.ok(LLMRouter.VALID_JOBS.has('credentials'));
  assert.ok(LLMRouter.VALID_JOBS.has('synthesis'));
});

// --- Constructor Defaults ---
console.log('\n--- Constructor Defaults ---\n');

test('TC-JOB-CTOR-001: Constructor defaults roster to null', () => {
  const router = new LLMRouter();
  assert.strictEqual(router._roster, null);
  assert.strictEqual(router._activePreset, null);
});

test('TC-JOB-CTOR-002: getStats shows legacy routingMode by default', () => {
  const router = new LLMRouter();
  const stats = router.getStats();
  assert.strictEqual(stats.routingMode, 'legacy');
  assert.strictEqual(stats.roster, null);
  assert.strictEqual(stats.activePreset, null);
});

// --- _resolvePreset ---
console.log('\n--- Preset Resolution ---\n');

test('TC-JOB-PRESET-001: all-local preset assigns only local providers', () => {
  const router = createRouterWithProviders();
  const roster = router._resolvePreset('all-local');

  for (const job of LLMRouter.VALID_JOBS) {
    assert.ok(Array.isArray(roster[job]), `roster[${job}] should be an array`);
    for (const id of roster[job]) {
      const p = router.providers.get(id);
      assert.strictEqual(p.type, 'local', `${job} chain should only have local providers, found ${id}`);
    }
  }
});

test('TC-JOB-PRESET-002: smart-mix puts cheapest cloud first for quick and tools', () => {
  const router = createRouterWithProviders();
  const roster = router._resolvePreset('smart-mix');

  // quick: cheapest cloud first (Haiku — fast, reliable), local fallback
  assert.strictEqual(roster['quick'][0], 'cloud-1');
  assert.strictEqual(roster['quick'][1], 'ollama-local');
  // tools: cheapest cloud first, local fallback
  assert.strictEqual(roster['tools'][0], 'cloud-1');
  assert.strictEqual(roster['tools'][1], 'ollama-local');
});

test('TC-JOB-PRESET-003: smart-mix puts cloud first for thinking/writing/research/coding', () => {
  const router = createRouterWithProviders();
  const roster = router._resolvePreset('smart-mix');

  assert.strictEqual(roster['thinking'][0], 'cloud-1');
  assert.strictEqual(roster['writing'][0], 'cloud-1');
  assert.strictEqual(roster['research'][0], 'cloud-1');
  assert.strictEqual(roster['coding'][0], 'cloud-1');
});

test('TC-JOB-PRESET-004: cloud-first puts cloud providers first for all jobs', () => {
  const router = createRouterWithProviders();
  const roster = router._resolvePreset('cloud-first');

  for (const job of ['quick', 'tools', 'thinking', 'writing', 'research', 'coding']) {
    assert.strictEqual(roster[job][0], 'cloud-1', `${job} should start with cloud-1`);
  }
});

test('TC-JOB-PRESET-005: credentials job always local-only regardless of preset', () => {
  const router = createRouterWithProviders();

  for (const preset of ['all-local', 'smart-mix', 'cloud-first']) {
    const roster = router._resolvePreset(preset);
    for (const id of roster['credentials']) {
      const p = router.providers.get(id);
      assert.strictEqual(p.type, 'local', `credentials in ${preset} should be local-only`);
    }
  }
});

// --- setPreset / setRoster / getRoster / getPreset ---
console.log('\n--- Preset & Roster Management ---\n');

test('TC-JOB-MGMT-001: setPreset activates roster', () => {
  const router = createRouterWithProviders();
  router.setPreset('smart-mix');

  assert.ok(router._roster !== null);
  assert.strictEqual(router._activePreset, 'smart-mix');
  assert.strictEqual(router.getPreset(), 'smart-mix');
});

test('TC-JOB-MGMT-002: setPreset rejects invalid preset', () => {
  const router = createRouterWithProviders();
  router.setPreset('invalid-preset');

  assert.strictEqual(router._roster, null);
  assert.strictEqual(router._activePreset, null);
});

test('TC-JOB-MGMT-003: getRoster returns null when legacy', () => {
  const router = new LLMRouter();
  assert.strictEqual(router.getRoster(), null);
});

test('TC-JOB-MGMT-004: getRoster returns copy after setPreset', () => {
  const router = createRouterWithProviders();
  router.setPreset('smart-mix');

  const roster = router.getRoster();
  assert.ok(roster !== null);
  assert.ok(Array.isArray(roster['quick']));
  // Mutating copy should not affect internal state
  roster['quick'].push('fake-provider');
  assert.ok(!router._roster['quick'].includes('fake-provider'));
});

test('TC-JOB-MGMT-005: setRoster merges with smart-mix base', () => {
  const router = createRouterWithProviders();
  router.setRoster({
    quick: ['cloud-1', 'ollama-local']
  });

  assert.ok(router._roster !== null);
  assert.strictEqual(router._activePreset, null);
  // quick was overridden
  assert.strictEqual(router._roster['quick'][0], 'cloud-1');
  // thinking should still have smart-mix default
  assert.ok(router._roster['thinking'].length > 0);
});

test('TC-JOB-MGMT-006: setRoster ignores unknown provider IDs', () => {
  const router = createRouterWithProviders();
  router.setRoster({
    quick: ['nonexistent-provider']
  });

  // quick should keep the smart-mix default since the custom chain was invalid
  assert.ok(router._roster['quick'].length > 0);
  assert.ok(!router._roster['quick'].includes('nonexistent-provider'));
});

// --- _mapLegacyTask ---
console.log('\n--- Legacy Task Mapping ---\n');

test('TC-JOB-MAP-001: chat maps to quick', () => {
  const router = new LLMRouter();
  assert.strictEqual(router._mapLegacyTask('chat', 'value'), 'quick');
});

test('TC-JOB-MAP-002: email_parse maps to tools', () => {
  const router = new LLMRouter();
  assert.strictEqual(router._mapLegacyTask('email_parse', 'value'), 'tools');
});

test('TC-JOB-MAP-003: writing maps to writing', () => {
  const router = new LLMRouter();
  assert.strictEqual(router._mapLegacyTask('writing', 'value'), 'writing');
});

test('TC-JOB-MAP-004: research maps to research', () => {
  const router = new LLMRouter();
  assert.strictEqual(router._mapLegacyTask('research', 'value'), 'research');
});

test('TC-JOB-MAP-005: sovereign role maps to credentials', () => {
  const router = new LLMRouter();
  assert.strictEqual(router._mapLegacyTask('anything', 'sovereign'), 'credentials');
});

test('TC-JOB-MAP-006: unknown task maps to thinking', () => {
  const router = new LLMRouter();
  assert.strictEqual(router._mapLegacyTask('unknown_task', 'value'), 'thinking');
});

// --- route() with job-style calls ---
console.log('\n--- Route with Job-Style Calls ---\n');

asyncTest('TC-JOB-ROUTE-001: route({ job: "quick" }) uses local first in smart-mix', async () => {
  const router = createRouterWithProviders();
  router.setPreset('smart-mix');

  const result = await router.route({
    job: 'quick',
    task: 'chat',
    content: 'Hello'
  });

  assert.ok(result.result);
  assert.ok(result.provider);
  // smart-mix quick → cheapest cloud first (Haiku — fast, reliable)
  assert.strictEqual(result.provider, 'cloud-1');
});

asyncTest('TC-JOB-ROUTE-002: route({ job: "research" }) uses cloud first in smart-mix', async () => {
  const router = createRouterWithProviders();
  router.setPreset('smart-mix');

  const result = await router.route({
    job: 'research',
    task: 'research',
    content: 'Analyze this'
  });

  assert.ok(result.result);
  // smart-mix research → cloud first
  assert.strictEqual(result.provider, 'cloud-1');
});

asyncTest('TC-JOB-ROUTE-003: route({ job: "credentials" }) uses only local', async () => {
  const router = createRouterWithProviders();
  router.setPreset('cloud-first');

  const result = await router.route({
    job: 'credentials',
    task: 'cred_check',
    content: 'Check creds'
  });

  assert.ok(result.result);
  assert.strictEqual(result.provider, 'ollama-local');
});

asyncTest('TC-JOB-ROUTE-004: unknown job defaults to quick', async () => {
  const router = createRouterWithProviders();
  router.setPreset('smart-mix');

  const result = await router.route({
    job: 'nonexistent',
    task: 'test',
    content: 'Hello'
  });

  assert.ok(result.result);
  // quick in smart-mix → cheapest cloud first
  assert.strictEqual(result.provider, 'cloud-1');
});

asyncTest('TC-JOB-ROUTE-005: job usage tracked in stats.byJob', async () => {
  const router = createRouterWithProviders();
  router.setPreset('smart-mix');

  await router.route({ job: 'quick', task: 'chat', content: 'Hello' });
  await router.route({ job: 'quick', task: 'chat', content: 'World' });
  await router.route({ job: 'research', task: 'research', content: 'Analyze' });

  assert.strictEqual(router.stats.byJob['quick'], 2);
  assert.strictEqual(router.stats.byJob['research'], 1);
});

// --- route() backward compatibility ---
console.log('\n--- Route Backward Compatibility ---\n');

asyncTest('TC-JOB-COMPAT-001: legacy call with active roster maps task to job', async () => {
  const router = createRouterWithProviders();
  router.setPreset('smart-mix');

  // Legacy-style call (no job field)
  const result = await router.route({
    task: 'chat',
    content: 'Hello',
    requirements: { role: 'value' }
  });

  assert.ok(result.result);
  // chat → quick → smart-mix cheapest cloud first
  assert.strictEqual(result.provider, 'cloud-1');
  assert.strictEqual(router.stats.byJob['quick'], 1);
});

asyncTest('TC-JOB-COMPAT-002: legacy call without roster uses pure legacy path', async () => {
  const router = createRouterWithProviders();
  // Do NOT setPreset — roster is null

  const result = await router.route({
    task: 'chat',
    content: 'Hello',
    requirements: { role: 'value' }
  });

  assert.ok(result.result);
  // Should use _buildChain('value') — value role has ['ollama-local', 'cloud-1']
  assert.strictEqual(result.provider, 'ollama-local');
  // No byJob tracking in legacy mode
  assert.strictEqual(router.stats.byJob, undefined);
});

// --- setTier backward compat ---
console.log('\n--- setTier Backward Compatibility ---\n');

test('TC-JOB-TIER-001: setTier local-only syncs to all-local when roster active', () => {
  const router = createRouterWithProviders();
  router.setPreset('smart-mix');
  assert.strictEqual(router.getPreset(), 'smart-mix');

  router.setTier('local-only');

  assert.strictEqual(router.getPreset(), 'all-local');
});

test('TC-JOB-TIER-002: setTier without roster does not create roster', () => {
  const router = createRouterWithProviders();
  // No setPreset — roster is null

  router.setTier('local-only');

  assert.strictEqual(router._roster, null);
  assert.strictEqual(router.getPreset(), null);
});

// --- getStats roster info ---
console.log('\n--- getStats Roster Info ---\n');

test('TC-JOB-STATS-001: getStats shows roster mode after setPreset', () => {
  const router = createRouterWithProviders();
  router.setPreset('cloud-first');

  const stats = router.getStats();
  assert.strictEqual(stats.routingMode, 'roster');
  assert.strictEqual(stats.activePreset, 'cloud-first');
  assert.ok(stats.roster !== null);
  assert.ok(Array.isArray(stats.roster['quick']));
});

// --- 3-Tier Smart-Mix Routing ---
console.log('\n--- 3-Tier Smart-Mix Routing ---\n');

function createRouterWith3Tiers() {
  const router = new LLMRouter({
    roles: {
      sovereign: ['ollama-local'],
      free: ['ollama-local'],
      value: ['workhorse-cloud', 'ollama-local'],
      premium: ['heavy-cloud', 'workhorse-cloud', 'ollama-local']
    }
  });
  router.providers.set('ollama-local', createMockProvider({ id: 'ollama-local', type: 'local' }));
  // Heavy cloud: expensive (like Opus)
  const heavyProvider = createMockProvider({ id: 'heavy-cloud', type: 'api' });
  heavyProvider.costModel = { type: 'per_token', inputPer1M: 15.00, outputPer1M: 75.00 };
  router.providers.set('heavy-cloud', heavyProvider);
  // Workhorse cloud: cheaper (like Sonnet)
  const workhorseProvider = createMockProvider({ id: 'workhorse-cloud', type: 'api' });
  workhorseProvider.costModel = { type: 'per_token', inputPer1M: 3.00, outputPer1M: 15.00 };
  router.providers.set('workhorse-cloud', workhorseProvider);
  return router;
}

test('TC-JOB-3TIER-001: _classifyCloudProviders sorts by cost', () => {
  const router = createRouterWith3Tiers();
  const { heavy, workhorse, rest } = router._classifyCloudProviders(['heavy-cloud', 'workhorse-cloud']);
  assert.strictEqual(heavy, 'heavy-cloud', 'Most expensive should be heavy');
  assert.strictEqual(workhorse, 'workhorse-cloud', 'Cheaper should be workhorse');
  assert.deepStrictEqual(rest, [], 'No remaining providers with 2 clouds');
});

test('TC-JOB-3TIER-002: _classifyCloudProviders with 1 provider returns same for both', () => {
  const router = createRouterWith3Tiers();
  const { heavy, workhorse, rest } = router._classifyCloudProviders(['heavy-cloud']);
  assert.strictEqual(heavy, 'heavy-cloud');
  assert.strictEqual(workhorse, 'heavy-cloud');
  assert.deepStrictEqual(rest, []);
});

test('TC-JOB-3TIER-003: _classifyCloudProviders with 0 providers returns nulls', () => {
  const router = createRouterWith3Tiers();
  const { heavy, workhorse, rest } = router._classifyCloudProviders([]);
  assert.strictEqual(heavy, null);
  assert.strictEqual(workhorse, null);
  assert.deepStrictEqual(rest, []);
});

test('TC-JOB-3TIER-004: smart-mix quick → cheapest cloud first, tools → cheapest cloud first', () => {
  const router = createRouterWith3Tiers();
  const roster = router._resolvePreset('smart-mix');

  // quick: cheapest cloud first (Haiku — fast, reliable), local fallback
  assert.strictEqual(roster['quick'][0], 'workhorse-cloud', 'quick should start with cheapest cloud');
  assert.strictEqual(roster['quick'][1], 'ollama-local', 'quick local fallback');
  assert.ok(!roster['quick'].includes('heavy-cloud'), 'quick should not include heavy');

  // tools: cheapest cloud first, local fallback
  assert.strictEqual(roster['tools'][0], 'workhorse-cloud', 'tools should start with cheapest cloud');
  assert.strictEqual(roster['tools'][1], 'ollama-local', 'tools local fallback');
});

test('TC-JOB-3TIER-005: smart-mix thinking/writing → heavy first; research → cheapest; coding → mid-tier', () => {
  const router = createRouterWith3Tiers();
  const roster = router._resolvePreset('smart-mix');

  // thinking/writing: heavy (Opus) → mid → cheapest → local
  assert.strictEqual(roster['thinking'][0], 'heavy-cloud', 'thinking should start with heavy');
  assert.strictEqual(roster['thinking'][1], 'workhorse-cloud', 'thinking fallback should be mid-tier');
  assert.strictEqual(roster['thinking'][2], 'ollama-local', 'thinking last should be local');

  assert.strictEqual(roster['writing'][0], 'heavy-cloud', 'writing should start with heavy');
  assert.strictEqual(roster['writing'][1], 'workhorse-cloud', 'writing fallback should be mid-tier');

  // research: cheapest cloud first (Haiku-tier), local fallback
  // With 2 clouds: cheapest = workhorse
  assert.strictEqual(roster['research'][0], 'workhorse-cloud', 'research should start with cheapest cloud');
  assert.strictEqual(roster['research'][1], 'ollama-local', 'research fallback should be local');

  // coding: mid-tier → cheapest → local
  // With 2 clouds: midTier = heavy, cheapest = workhorse
  assert.strictEqual(roster['coding'][0], 'heavy-cloud', 'coding should start with mid-tier');
  assert.strictEqual(roster['coding'][1], 'workhorse-cloud', 'coding fallback should be cheapest');
});

test('TC-JOB-3TIER-006: smart-mix synthesis/decomposition → cheapest cloud first', () => {
  const router = createRouterWith3Tiers();
  const roster = router._resolvePreset('smart-mix');

  // synthesis: cheapest cloud (Haiku-tier) → local
  assert.strictEqual(roster['synthesis'][0], 'workhorse-cloud', 'synthesis should start with cheapest cloud');
  assert.strictEqual(roster['synthesis'][1], 'ollama-local', 'synthesis fallback should be local');
  assert.ok(!roster['synthesis'].includes('heavy-cloud'), 'synthesis should not include heavy');

  assert.strictEqual(roster['decomposition'][0], 'workhorse-cloud', 'decomposition should start with cheapest');
});

test('TC-JOB-3TIER-006b: smart-mix with 3+ clouds: correct tier mapping per job', () => {
  const router = createRouterWith3Tiers();
  // Add a third cheap cloud provider (like Haiku)
  const cheapProvider = createMockProvider({ id: 'value-cloud', type: 'api' });
  cheapProvider.costModel = { type: 'per_token', inputPer1M: 0.14, outputPer1M: 0.28 };
  router.providers.set('value-cloud', cheapProvider);

  const { heavy, workhorse, rest } = router._classifyCloudProviders(['heavy-cloud', 'workhorse-cloud', 'value-cloud']);
  assert.strictEqual(heavy, 'heavy-cloud');
  assert.strictEqual(workhorse, 'workhorse-cloud');
  assert.deepStrictEqual(rest, ['value-cloud']);

  const roster = router._resolvePreset('smart-mix');

  // thinking: heavy → workhorse → cheapest → local
  assert.strictEqual(roster['thinking'][0], 'heavy-cloud');
  assert.strictEqual(roster['thinking'][1], 'workhorse-cloud');
  assert.strictEqual(roster['thinking'][2], 'value-cloud');
  assert.strictEqual(roster['thinking'][3], 'ollama-local');

  // research: cheapest → local
  assert.strictEqual(roster['research'][0], 'value-cloud');
  assert.strictEqual(roster['research'][1], 'ollama-local');

  // coding: midTier (workhorse) → cheapest → local
  assert.strictEqual(roster['coding'][0], 'workhorse-cloud');
  assert.strictEqual(roster['coding'][1], 'value-cloud');
  assert.strictEqual(roster['coding'][2], 'ollama-local');

  // synthesis: cheapest → local
  assert.strictEqual(roster['synthesis'][0], 'value-cloud');
  assert.strictEqual(roster['synthesis'][1], 'ollama-local');

  // quick: cheapest → local (no heavy, no mid)
  assert.strictEqual(roster['quick'][0], 'value-cloud');
  assert.strictEqual(roster['quick'][1], 'ollama-local');
  assert.ok(!roster['quick'].includes('heavy-cloud'), 'quick should not include heavy');
});

test('TC-JOB-3TIER-007: smart-mix with 1 cloud: job→tier mapping still applies', () => {
  // With 1 cloud provider, all tiers collapse to the same provider
  const router = createRouterWithProviders();
  const roster = router._resolvePreset('smart-mix');

  // quick: cheapest cloud first (all tiers = cloud-1), local fallback
  assert.strictEqual(roster['quick'][0], 'cloud-1');
  assert.strictEqual(roster['quick'][1], 'ollama-local');

  // tools: cheapest cloud first, local fallback
  assert.strictEqual(roster['tools'][0], 'cloud-1');
  assert.strictEqual(roster['tools'][1], 'ollama-local');

  // synthesis: cloud first (cheapest = only cloud), local fallback
  assert.strictEqual(roster['synthesis'][0], 'cloud-1');
  assert.strictEqual(roster['synthesis'][1], 'ollama-local');

  // thinking/writing: cloud first (heavy = only cloud), local fallback
  assert.strictEqual(roster['thinking'][0], 'cloud-1');
  assert.strictEqual(roster['writing'][0], 'cloud-1');

  // research/coding: cloud first (midTier = only cloud), local fallback
  assert.strictEqual(roster['research'][0], 'cloud-1');
  assert.strictEqual(roster['coding'][0], 'cloud-1');
});

asyncTest('TC-JOB-3TIER-008: route quick in 3-tier smart-mix uses cheapest cloud', async () => {
  const router = createRouterWith3Tiers();
  router.setPreset('smart-mix');

  const result = await router.route({ job: 'quick', task: 'chat', content: 'Hello' });
  assert.strictEqual(result.provider, 'workhorse-cloud');
});

asyncTest('TC-JOB-3TIER-009: route thinking in 3-tier smart-mix uses heavy cloud', async () => {
  const router = createRouterWith3Tiers();
  router.setPreset('smart-mix');

  const result = await router.route({ job: 'thinking', task: 'analyze', content: 'Think deeply' });
  assert.strictEqual(result.provider, 'heavy-cloud');
});

asyncTest('TC-JOB-3TIER-010: route research in 3-tier smart-mix uses cheapest cloud', async () => {
  const router = createRouterWith3Tiers();
  router.setPreset('smart-mix');

  const result = await router.route({ job: 'research', task: 'research', content: 'Search this' });
  // research → cheapest cloud (workhorse with 2 providers)
  assert.strictEqual(result.provider, 'workhorse-cloud');
});

// Summary
setTimeout(() => {
  summary();
  exitWithCode();
}, 100);
