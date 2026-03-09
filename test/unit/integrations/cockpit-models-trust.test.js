/*
 * Moltagent - Sovereign AI Security Layer
 * Copyright (C) 2026 Moltagent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * Cockpit Models Trust-Based System Tests
 *
 * Validates the trust-boundary architecture for the Models card:
 *   - _buildRosterFromTrust: pure roster construction from trust + prefer + infra
 *   - _parseModelsCard: new trust format, default sovereignty, changed flag
 *   - _generateModelsCardDescription: text output for trust states
 *   - _migrateOldModelsCard: legacy preset/label → trust-based config text
 *
 * Run: node test/unit/integrations/cockpit-models-trust.test.js
 */

'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const CockpitManager = require('../../../src/lib/integrations/cockpit-manager');

console.log('\n=== Cockpit Models Trust-Based System Tests ===\n');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockDeckClient() {
  const calls = [];
  return {
    _calls: calls,
    nc: { ncUrl: 'https://cloud.example.com', ncUser: 'moltagent', request: async () => ({ status: 200, body: {} }) },
    listBoards: async () => [],
    getBoard: async (boardId) => ({ id: boardId, title: 'Moltagent Cockpit', labels: [] }),
    getStacks: async () => [],
    createStack: async (boardId, title, order) => ({ id: 100 + order, title, order }),
    shareBoard: async () => ({ id: 1 }),
    _request: async (method, path, body) => {
      calls.push({ method, path, body });
      if (method === 'PUT') return { success: true };
      return {};
    }
  };
}

function makeCM() {
  return new CockpitManager({ deckClient: createMockDeckClient() });
}

function makeCard(title, description, labels) {
  return { id: 1, title, description, labels: labels || [] };
}

// Infra fixtures used across multiple tests
const localOnlyInfra = { localModels: [], gpuDetected: false, cloudProviders: [] };
const anthropicInfra = {
  localModels: [],
  gpuDetected: false,
  cloudProviders: [{ name: 'Anthropic', models: ['Haiku', 'Sonnet'] }]
};

// Local provider IDs the roster must stay within for local-only trust
const LOCAL_PROVIDERS = new Set(['ollama-fast', 'ollama-local']);

// ---------------------------------------------------------------------------
// TC-TRUST-001
// ---------------------------------------------------------------------------

console.log('--- _buildRosterFromTrust ---\n');

test('TC-TRUST-001: local-only trust → no cloud providers in any chain', () => {
  const cm = makeCM();
  const roster = cm._buildRosterFromTrust('local-only', 'speed', localOnlyInfra);

  // All expected job keys must exist
  const expectedJobs = ['quick', 'synthesis', 'tools', 'thinking', 'writing', 'research', 'coding'];
  for (const job of expectedJobs) {
    assert.ok(Array.isArray(roster[job]), `${job} chain should be an array`);
    assert.ok(roster[job].length > 0, `${job} chain should not be empty`);
    for (const provider of roster[job]) {
      assert.ok(
        LOCAL_PROVIDERS.has(provider),
        `local-only: ${job} chain contains non-local provider "${provider}"`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// TC-TRUST-002
// ---------------------------------------------------------------------------

test('TC-TRUST-002: cloud-ok / speed → synthesis chain starts with claude-haiku', () => {
  const cm = makeCM();
  const roster = cm._buildRosterFromTrust('cloud-ok', 'speed', anthropicInfra);

  assert.ok(Array.isArray(roster.synthesis), 'synthesis chain should exist');
  assert.strictEqual(
    roster.synthesis[0],
    'claude-haiku',
    `synthesis[0] should be claude-haiku, got "${roster.synthesis[0]}"`
  );
});

// ---------------------------------------------------------------------------
// TC-TRUST-003
// ---------------------------------------------------------------------------

test('TC-TRUST-003: cloud-ok / quality → synthesis chain starts with claude-sonnet', () => {
  const cm = makeCM();
  const roster = cm._buildRosterFromTrust('cloud-ok', 'quality', anthropicInfra);

  assert.ok(Array.isArray(roster.synthesis), 'synthesis chain should exist');
  assert.strictEqual(
    roster.synthesis[0],
    'claude-sonnet',
    `synthesis[0] should be claude-sonnet, got "${roster.synthesis[0]}"`
  );
});

// ---------------------------------------------------------------------------
// TC-TRUST-004
// ---------------------------------------------------------------------------

test('TC-TRUST-004: cloud-ok / cost → synthesis haiku first; thinking/writing/coding local first', () => {
  const cm = makeCM();
  const roster = cm._buildRosterFromTrust('cloud-ok', 'cost', anthropicInfra);

  // Synthesis: haiku first (cheapest cloud)
  assert.ok(Array.isArray(roster.synthesis), 'synthesis chain should exist');
  assert.strictEqual(
    roster.synthesis[0],
    'claude-haiku',
    `cost/synthesis[0] should be claude-haiku, got "${roster.synthesis[0]}"`
  );

  // thinking, writing, coding: local first, cloud as fallback
  for (const job of ['thinking', 'writing', 'coding']) {
    assert.ok(Array.isArray(roster[job]), `${job} chain should exist`);
    assert.ok(
      LOCAL_PROVIDERS.has(roster[job][0]),
      `cost/${job}[0] should be a local provider, got "${roster[job][0]}"`
    );
  }
});

// ---------------------------------------------------------------------------
// TC-TRUST-005
// ---------------------------------------------------------------------------

console.log('\n--- _parseModelsCard (new trust format) ---\n');

test('TC-TRUST-005: trust format with inline roster section parses correctly', () => {
  const cm = makeCM();
  const description = 'trust: cloud-ok\nroster:\n  synthesis: claude-haiku \u2192 ollama-fast\n---\nDocs';
  const card = makeCard('Models', description, []);
  const result = cm._parseModelsCard(card);

  assert.ok(result, 'result should not be null');
  assert.strictEqual(result.trust, 'cloud-ok', `trust should be 'cloud-ok', got "${result.trust}"`);
  assert.ok(result.customRoster, 'customRoster should be present');
  assert.ok(result.customRoster.synthesis, 'customRoster.synthesis should be present');
});

// ---------------------------------------------------------------------------
// TC-TRUST-006
// ---------------------------------------------------------------------------

console.log('\n--- _generateModelsCardDescription ---\n');

test('TC-TRUST-006: local-only description contains trust badge, model count, and zero cost', () => {
  const cm = makeCM();
  const infra = {
    localModels: [{ name: 'qwen2.5:3b' }, { name: 'qwen3:8b' }],
    gpuDetected: false,
    cloudProviders: []
  };
  const desc = cm._generateModelsCardDescription('local-only', 'speed', infra);

  assert.ok(typeof desc === 'string', 'description should be a string');
  // Trust badge
  assert.ok(
    desc.includes('\ud83d\udd12 Trust: Local only') || desc.includes('Trust: Local only'),
    'should contain local trust badge'
  );
  // Model count: 2 model(s) ready
  assert.ok(desc.includes('2 model(s) ready'), `should report 2 model(s) ready; got: ${desc.slice(0, 300)}`);
  // Zero cost
  assert.ok(desc.includes('\u20ac0/month'), 'should show €0/month for local-only');
});

// ---------------------------------------------------------------------------
// TC-TRUST-007
// ---------------------------------------------------------------------------

test('TC-TRUST-007: cloud-ok description contains cloud trust badge and Anthropic provider', () => {
  const cm = makeCM();
  const infra = {
    localModels: [{ name: 'qwen2.5:3b' }],
    gpuDetected: false,
    cloudProviders: [{ name: 'Anthropic', models: ['Haiku', 'Sonnet'] }]
  };
  const desc = cm._generateModelsCardDescription('cloud-ok', 'speed', infra);

  assert.ok(typeof desc === 'string', 'description should be a string');
  // Cloud trust badge
  assert.ok(
    desc.includes('\ud83c\udf10 Trust: Cloud allowed') || desc.includes('Trust: Cloud allowed'),
    'should contain cloud trust badge'
  );
  // Provider with checkmark
  assert.ok(desc.includes('Anthropic \u2705'), 'should show Anthropic ✅');
});

// ---------------------------------------------------------------------------
// TC-TRUST-008
// ---------------------------------------------------------------------------

console.log('\n--- _migrateOldModelsCard ---\n');

test('TC-TRUST-008: old ⚙️1 all-local preset migrates to trust: local-only', () => {
  const cm = makeCM();
  // Old format with ⚙️1 gear tag (all-local indicator)
  const description = '\u2699\ufe0f1 all-local / \u2699\ufe0f2 smart mix / \u2699\ufe0f3 cloud-first\n\nActive preset: all-local\n---\nDocs';
  const result = cm._migrateOldModelsCard(description);

  assert.ok(result !== null, 'migration should return a value for old format');
  assert.ok(result.includes('trust: local-only'), `should contain 'trust: local-only', got: "${result}"`);
});

// ---------------------------------------------------------------------------
// TC-TRUST-009
// ---------------------------------------------------------------------------

test('TC-TRUST-009: old synthesis_provider: haiku migrates to trust: cloud-ok', () => {
  const cm = makeCM();
  const description = 'synthesis_provider: haiku\n---\nSome docs';
  const result = cm._migrateOldModelsCard(description);

  assert.ok(result !== null, 'migration should return a value');
  assert.ok(result.includes('trust: cloud-ok'), `should contain 'trust: cloud-ok', got: "${result}"`);
});

// ---------------------------------------------------------------------------
// TC-TRUST-010
// ---------------------------------------------------------------------------

console.log('\n--- _parseModelsCard (sovereignty defaults) ---\n');

test('TC-TRUST-010: empty description with no labels defaults to local-only (sovereignty)', () => {
  const cm = makeCM();
  const card = makeCard('Models', '', []);
  const result = cm._parseModelsCard(card);

  assert.ok(result, 'result should not be null');
  assert.strictEqual(
    result.trust,
    'local-only',
    `default trust should be 'local-only', got "${result.trust}"`
  );
});

// ---------------------------------------------------------------------------
// TC-TRUST-011
// ---------------------------------------------------------------------------

console.log('\n--- _buildRosterFromTrust: quick chain invariant ---\n');

test('TC-TRUST-011: quick chain is always local-only regardless of trust setting', () => {
  const cm = makeCM();

  // local-only trust
  const localRoster = cm._buildRosterFromTrust('local-only', 'speed', localOnlyInfra);
  for (const provider of localRoster.quick) {
    assert.ok(LOCAL_PROVIDERS.has(provider), `local-only quick chain: "${provider}" is not a local provider`);
  }

  // cloud-ok trust, all prefer variants
  for (const prefer of ['speed', 'quality', 'cost']) {
    const cloudRoster = cm._buildRosterFromTrust('cloud-ok', prefer, anthropicInfra);
    for (const provider of cloudRoster.quick) {
      assert.ok(
        LOCAL_PROVIDERS.has(provider),
        `cloud-ok/${prefer} quick chain: "${provider}" is not a local provider`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// TC-TRUST-012
// ---------------------------------------------------------------------------

console.log('\n--- _parseModelsCard (prefer field) ---\n');

test('TC-TRUST-012: new format with trust and prefer fields is fully parsed', () => {
  const cm = makeCM();
  const description = 'trust: cloud-ok\nprefer: quality\n---\nDocs';
  const card = makeCard('Models', description, []);
  const result = cm._parseModelsCard(card);

  assert.ok(result, 'result should not be null');
  assert.strictEqual(result.trust, 'cloud-ok', `trust should be 'cloud-ok', got "${result.trust}"`);
  assert.strictEqual(result.prefer, 'quality', `prefer should be 'quality', got "${result.prefer}"`);
  assert.strictEqual(result.customRoster, null, 'customRoster should be null when no roster block present');
  assert.strictEqual(result.changed, true, 'first parse should report changed=true');
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

setTimeout(() => {
  summary();
  exitWithCode();
}, 100);
