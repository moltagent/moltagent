/**
 * Cockpit Models Card Unit Tests (Session B2)
 *
 * Tests the Models card parsing, custom roster parsing,
 * and HeartbeatManager integration for the new modelsConfig path.
 *
 * Run: node test/unit/integrations/cockpit-models.test.js
 *
 * @module test/unit/integrations/cockpit-models
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

// Import module under test
const CockpitManager = require('../../../src/lib/integrations/cockpit-manager');
const {
  BOARD_TITLE,
  DEFAULT_CARDS,
  MODELS_CARD_TITLES
} = CockpitManager;

// ============================================================
// Test Fixtures
// ============================================================

const g1Label = { id: 2, title: '\u2699\ufe0f1', color: 'e9322d' };
const g2Label = { id: 3, title: '\u2699\ufe0f2', color: 'f0c400' };
const g3Label = { id: 4, title: '\u2699\ufe0f3', color: '00b600' };
const g4Label = { id: 5, title: '\u2699\ufe0f4', color: '0000ff' };

function createMockDeckClient(overrides = {}) {
  const calls = [];
  return {
    _calls: calls,
    nc: { ncUrl: 'https://cloud.example.com', ncUser: 'moltagent', request: async () => ({ status: 200, body: {} }) },
    listBoards: async () => overrides.listBoards || [],
    getBoard: async (boardId) => overrides.getBoard || { id: boardId, title: BOARD_TITLE, labels: [] },
    getStacks: async () => overrides.getStacks || [],
    createStack: async (boardId, title, order) => ({ id: 100 + order, title, order }),
    shareBoard: async () => ({ id: 1 }),
    _request: async (method, path, body) => {
      calls.push({ method, path, body });
      if (method === 'POST' && path.includes('/labels')) return { id: 200 + calls.length, title: body?.title, color: body?.color };
      if (method === 'POST' && path.includes('/boards')) return { id: 99, title: BOARD_TITLE };
      if (method === 'POST' && path.includes('/cards')) return { id: 300 + calls.length, title: body?.title };
      if (method === 'PUT') return { success: true };
      if (method === 'DELETE') return { success: true };
      return {};
    }
  };
}

function makeCM() {
  const deck = createMockDeckClient();
  return new CockpitManager({ deckClient: deck });
}

function makeCard(title, description, labels) {
  return { id: 1, title, description, labels: labels || [] };
}

// ============================================================
// Tests: MODELS_CARD_TITLES constant
// ============================================================

console.log('\nCockpit Models Card Tests (Session B2)');
console.log('======================================\n');

console.log('--- MODELS_CARD_TITLES constant ---\n');

test('TC-MOD-CONST-001: MODELS_CARD_TITLES is exported', () => {
  assert.ok(Array.isArray(MODELS_CARD_TITLES));
  assert.ok(MODELS_CARD_TITLES.includes('models'));
  assert.ok(MODELS_CARD_TITLES.includes('llm tier'));
  assert.ok(MODELS_CARD_TITLES.includes('llm provider'));
});

// ============================================================
// Tests: Card Parsing (_parseModelsCard)
// ============================================================

console.log('\n--- Card Parsing (_parseModelsCard) ---\n');

test('TC-MOD-PARSE-001: \u2699\ufe0f1 label -> all-local preset', () => {
  const cm = makeCM();
  const card = makeCard('Models', '', [g1Label]);
  const result = cm._parseModelsCard(card);
  assert.strictEqual(result.preset, 'all-local');
  assert.strictEqual(result.roster, undefined);
});

test('TC-MOD-PARSE-002: \u2699\ufe0f2 label -> smart-mix preset', () => {
  const cm = makeCM();
  const card = makeCard('Models', '', [g2Label]);
  const result = cm._parseModelsCard(card);
  assert.strictEqual(result.preset, 'smart-mix');
});

test('TC-MOD-PARSE-003: \u2699\ufe0f3 label -> cloud-first preset', () => {
  const cm = makeCM();
  const card = makeCard('Models', '', [g3Label]);
  const result = cm._parseModelsCard(card);
  assert.strictEqual(result.preset, 'cloud-first');
});

test('TC-MOD-PARSE-004: \u2699\ufe0f4 label with valid roster -> custom roster', () => {
  const cm = makeCM();
  const desc = 'quick: qwen3:8b\nthinking: claude-opus, qwen3:8b\n\n---\n\nDocumentation here';
  const card = makeCard('Models', desc, [g4Label]);
  const result = cm._parseModelsCard(card);
  assert.ok(result.roster);
  assert.strictEqual(result.preset, undefined);
  assert.deepStrictEqual(result.roster.quick, ['qwen3:8b']);
  assert.deepStrictEqual(result.roster.thinking, ['claude-opus', 'qwen3:8b']);
});

test('TC-MOD-PARSE-005: no label -> smart-mix default', () => {
  const cm = makeCM();
  const card = makeCard('Models', '', []);
  const result = cm._parseModelsCard(card);
  assert.strictEqual(result.preset, 'smart-mix');
});

test('TC-MOD-PARSE-006: old "Option 2" label -> smart-mix', () => {
  const cm = makeCM();
  const opt2 = { id: 3, title: '\ud83d\udfe1 Option 2', color: 'f0c400' };
  const card = makeCard('Models', '', [opt2]);
  const result = cm._parseModelsCard(card);
  assert.strictEqual(result.preset, 'smart-mix');
});

test('TC-MOD-PARSE-007: card titled "LLM Tier" is found by MODELS_CARD_TITLES', () => {
  assert.ok(MODELS_CARD_TITLES.includes('llm tier'));
  assert.ok(MODELS_CARD_TITLES.includes('LLM Tier'.toLowerCase()));
});

test('TC-MOD-PARSE-008: card titled "Models" is found by MODELS_CARD_TITLES', () => {
  assert.ok(MODELS_CARD_TITLES.includes('models'));
  assert.ok(MODELS_CARD_TITLES.includes('Models'.toLowerCase()));
});

// ============================================================
// Tests: Custom Roster Parsing (_parseCustomRoster)
// ============================================================

console.log('\n--- Custom Roster Parsing (_parseCustomRoster) ---\n');

test('TC-MOD-ROSTER-001: valid 6-job roster parses all jobs', () => {
  const cm = makeCM();
  const desc = [
    'quick: qwen3:8b',
    'tools: qwen3:8b, mistral-small',
    'thinking: claude-opus, gpt-5.2, qwen3:8b',
    'writing: claude-opus, qwen3:8b',
    'research: perplexity, claude-opus',
    'coding: claude-code, qwen3:8b'
  ].join('\n');

  const roster = cm._parseCustomRoster(desc);
  assert.strictEqual(Object.keys(roster).length, 6);
  assert.deepStrictEqual(roster.quick, ['qwen3:8b']);
  assert.deepStrictEqual(roster.tools, ['qwen3:8b', 'mistral-small']);
  assert.deepStrictEqual(roster.thinking, ['claude-opus', 'gpt-5.2', 'qwen3:8b']);
  assert.deepStrictEqual(roster.writing, ['claude-opus', 'qwen3:8b']);
  assert.deepStrictEqual(roster.research, ['perplexity', 'claude-opus']);
  assert.deepStrictEqual(roster.coding, ['claude-code', 'qwen3:8b']);
});

test('TC-MOD-ROSTER-002: 3-job roster returns only specified jobs', () => {
  const cm = makeCM();
  const desc = 'quick: qwen3:8b\nthinking: claude-opus\ncoding: claude-code';
  const roster = cm._parseCustomRoster(desc);
  assert.strictEqual(Object.keys(roster).length, 3);
  assert.ok(roster.quick);
  assert.ok(roster.thinking);
  assert.ok(roster.coding);
  assert.strictEqual(roster.tools, undefined);
});

test('TC-MOD-ROSTER-003: extra whitespace handled gracefully', () => {
  const cm = makeCM();
  const desc = '  quick :  qwen3:8b ,  mistral-small  ';
  const roster = cm._parseCustomRoster(desc);
  assert.deepStrictEqual(roster.quick, ['qwen3:8b', 'mistral-small']);
});

test('TC-MOD-ROSTER-004: empty lines and blank lines skipped', () => {
  const cm = makeCM();
  const desc = '\n\nquick: qwen3:8b\n\n\nthinking: claude-opus\n\n';
  const roster = cm._parseCustomRoster(desc);
  assert.strictEqual(Object.keys(roster).length, 2);
});

test('TC-MOD-ROSTER-005: credentials job ignored (security invariant)', () => {
  const cm = makeCM();
  const desc = 'quick: qwen3:8b\ncredentials: cloud-provider\nthinking: claude-opus';
  const roster = cm._parseCustomRoster(desc);
  assert.strictEqual(roster.credentials, undefined);
  assert.ok(roster.quick);
  assert.ok(roster.thinking);
});

test('TC-MOD-ROSTER-006: unknown job name ignored', () => {
  const cm = makeCM();
  const desc = 'quick: qwen3:8b\nmycustomjob: something\nthinking: claude-opus';
  const roster = cm._parseCustomRoster(desc);
  assert.strictEqual(roster.mycustomjob, undefined);
  assert.strictEqual(Object.keys(roster).length, 2);
});

test('TC-MOD-ROSTER-007: --- separator respected (lines below ignored)', () => {
  const cm = makeCM();
  const desc = 'quick: qwen3:8b\nthinking: claude-opus\n\n---\n\nwriting: should-be-ignored\ncoding: also-ignored';
  const roster = cm._parseCustomRoster(desc);
  assert.strictEqual(Object.keys(roster).length, 2);
  assert.strictEqual(roster.writing, undefined);
  assert.strictEqual(roster.coding, undefined);
});

// ============================================================
// Tests: Integration (getSystemSettings + HeartbeatManager)
// ============================================================

console.log('\n--- Integration ---\n');

asyncTest('TC-MOD-INT-001: getSystemSettings returns modelsConfig with preset', async () => {
  const cm = makeCM();
  const cards = [makeCard('Models', '\u2699\ufe0f2 smart mix', [g2Label])];

  const config = await cm.getSystemSettings(cards);
  assert.ok(config.modelsConfig);
  assert.strictEqual(config.modelsConfig.preset, 'smart-mix');
  assert.strictEqual(config.llmTier, 'balanced');
});

asyncTest('TC-MOD-INT-002: getSystemSettings returns modelsConfig with roster for \u2699\ufe0f4', async () => {
  const cm = makeCM();
  const desc = 'quick: qwen3:8b\nthinking: claude-opus\n\n---\n\nDocs here';
  const cards = [makeCard('Models', desc, [g4Label])];

  const config = await cm.getSystemSettings(cards);
  assert.ok(config.modelsConfig);
  assert.ok(config.modelsConfig.roster);
  assert.deepStrictEqual(config.modelsConfig.roster.quick, ['qwen3:8b']);
  assert.deepStrictEqual(config.modelsConfig.roster.thinking, ['claude-opus']);
  assert.strictEqual(config.llmTier, 'balanced');
});

asyncTest('TC-MOD-INT-003: backward compat — llmTier set from preset', async () => {
  const cm = makeCM();
  const cards = [makeCard('Models', '', [g1Label])];

  const config = await cm.getSystemSettings(cards);
  assert.strictEqual(config.modelsConfig.preset, 'all-local');
  assert.strictEqual(config.llmTier, 'local-only');
});

asyncTest('TC-MOD-INT-004: legacy "LLM Tier" card title still matches', async () => {
  const cm = makeCM();
  const cards = [makeCard('LLM Tier', '', [g3Label])];

  const config = await cm.getSystemSettings(cards);
  assert.ok(config.modelsConfig, 'Should parse LLM Tier as models card');
  assert.strictEqual(config.modelsConfig.preset, 'cloud-first');
  assert.strictEqual(config.llmTier, 'premium');
});

test('TC-MOD-INT-005: empty custom roster falls back to smart-mix', () => {
  const cm = makeCM();
  const card = makeCard('Models', '\n\n---\n\nOnly docs, no roster', [g4Label]);
  const result = cm._parseModelsCard(card);
  assert.strictEqual(result.preset, 'smart-mix');
  assert.strictEqual(result.roster, undefined);
});

// ============================================================
// Tests: DEFAULT_CARDS updated
// ============================================================

console.log('\n--- DEFAULT_CARDS updates ---\n');

test('TC-MOD-DC-001: Models card exists in DEFAULT_CARDS.system', () => {
  const modelsCard = DEFAULT_CARDS.system.find(c => c.title === 'Models');
  assert.ok(modelsCard, 'Should have a Models card in system stack');
  assert.ok(modelsCard.description.includes('all-local'), 'Should mention all-local preset');
  assert.ok(modelsCard.description.includes('---'), 'Should have --- separator');
  assert.ok(modelsCard.description.includes('Jobs:'), 'Should document jobs');
  assert.strictEqual(modelsCard.defaultLabel, '\u2699\ufe0f2');
});

test('TC-MOD-DC-002: LLM Tier card no longer exists in DEFAULT_CARDS', () => {
  const tierCard = DEFAULT_CARDS.system.find(c => c.title === 'LLM Tier');
  assert.strictEqual(tierCard, undefined, 'LLM Tier should be renamed to Models');
});

test('TC-MOD-DC-003: all style cards have --- separator', () => {
  for (const card of DEFAULT_CARDS.styles) {
    assert.ok(card.description.includes('---'), `Style "${card.title}" should have --- separator`);
  }
});

test('TC-MOD-DC-004: all persona cards have --- separator', () => {
  for (const card of DEFAULT_CARDS.persona) {
    assert.ok(card.description.includes('---'), `Persona "${card.title}" should have --- separator`);
  }
});

test('TC-MOD-DC-005: all guardrail cards have --- separator', () => {
  for (const card of DEFAULT_CARDS.guardrails) {
    assert.ok(card.description.includes('---'), `Guardrail "${card.title}" should have --- separator`);
  }
});

test('TC-MOD-DC-006: all mode cards have --- separator', () => {
  for (const card of DEFAULT_CARDS.modes) {
    assert.ok(card.description.includes('---'), `Mode "${card.title}" should have --- separator`);
  }
});

// ============================================================
// Summary
// ============================================================

setTimeout(() => {
  summary();
  exitWithCode();
}, 100);
