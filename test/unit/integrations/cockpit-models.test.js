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
  assert.ok(MODELS_CARD_TITLES.includes('llm provider'));
  assert.ok(!MODELS_CARD_TITLES.includes('llm tier'), 'llm tier should be removed');
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

test('TC-MOD-PARSE-007: card titled "LLM Tier" is no longer in MODELS_CARD_TITLES', () => {
  assert.ok(!MODELS_CARD_TITLES.includes('llm tier'), 'LLM Tier removed as ghost card');
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
  assert.strictEqual(config.llmTier, undefined, 'llmTier removed');
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
  assert.strictEqual(config.llmTier, undefined, 'llmTier removed');
});

asyncTest('TC-MOD-INT-003: llmTier no longer derived from preset', async () => {
  const cm = makeCM();
  const cards = [makeCard('Models', '', [g1Label])];

  const config = await cm.getSystemSettings(cards);
  assert.strictEqual(config.modelsConfig.preset, 'all-local');
  assert.strictEqual(config.llmTier, undefined, 'llmTier backward compat removed');
});

asyncTest('TC-MOD-INT-004: legacy "LLM Tier" card title no longer matches', async () => {
  const cm = makeCM();
  const cards = [makeCard('LLM Tier', '', [g3Label])];

  const config = await cm.getSystemSettings(cards);
  assert.strictEqual(config.modelsConfig, undefined, 'LLM Tier should no longer match as models card');
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
// Tests: _parsePlayersSection
// ============================================================

console.log('\n--- _parsePlayersSection ---\n');

test('TC-MOD-PLAY-001: single provider, single model', () => {
  const cm = makeCM();
  const lines = ['  local: qwen3:8b (ollama)'];
  const players = cm._parsePlayersSection(lines);
  assert.ok(players['qwen3:8b']);
  assert.strictEqual(players['qwen3:8b'].type, 'ollama');
  assert.strictEqual(players['qwen3:8b'].local, true);
  assert.strictEqual(players['qwen3:8b'].credentialLabel, null);
  assert.strictEqual(players['qwen3:8b'].endpoint, null);
});

test('TC-MOD-PLAY-002: single provider, multiple models share type and local flag', () => {
  const cm = makeCM();
  const lines = ['  local: qwen3:8b, qwen3:14b-fast (ollama)'];
  const players = cm._parsePlayersSection(lines);
  assert.ok(players['qwen3:8b']);
  assert.ok(players['qwen3:14b-fast']);
  assert.strictEqual(players['qwen3:8b'].type, 'ollama');
  assert.strictEqual(players['qwen3:14b-fast'].type, 'ollama');
  assert.strictEqual(players['qwen3:8b'].local, true);
  assert.strictEqual(players['qwen3:14b-fast'].local, true);
});

test('TC-MOD-PLAY-003: multiple provider lines produce separate entries', () => {
  const cm = makeCM();
  const lines = [
    '  local: qwen3:8b (ollama)',
    '  cloud: claude-sonnet-4.5 (anthropic)',
  ];
  const players = cm._parsePlayersSection(lines);
  assert.ok(players['qwen3:8b']);
  assert.ok(players['claude-sonnet-4.5']);
  assert.strictEqual(players['qwen3:8b'].local, true);
  assert.strictEqual(players['claude-sonnet-4.5'].local, false);
  assert.strictEqual(players['claude-sonnet-4.5'].type, 'anthropic');
});

test('TC-MOD-PLAY-004: credential label (key:) is captured', () => {
  const cm = makeCM();
  const lines = ['  cloud: pplx-sonar-pro (perplexity, key: perplexity-api-key)'];
  const players = cm._parsePlayersSection(lines);
  assert.ok(players['pplx-sonar-pro']);
  assert.strictEqual(players['pplx-sonar-pro'].credentialLabel, 'perplexity-api-key');
  assert.strictEqual(players['pplx-sonar-pro'].type, 'perplexity');
  assert.strictEqual(players['pplx-sonar-pro'].local, false);
});

test('TC-MOD-PLAY-005: custom endpoint is captured', () => {
  const cm = makeCM();
  const lines = ['  local: llama3 (ollama, endpoint: http://gpu-box:11434)'];
  const players = cm._parsePlayersSection(lines);
  assert.ok(players['llama3']);
  assert.strictEqual(players['llama3'].endpoint, 'http://gpu-box:11434');
  assert.strictEqual(players['llama3'].local, true);
});

// ============================================================
// Tests: _parseRosterSection
// ============================================================

console.log('\n--- _parseRosterSection ---\n');

function makePlayers() {
  return {
    'qwen3:8b':         { type: 'ollama', model: 'qwen3:8b',         credentialLabel: null, endpoint: null, local: true },
    'claude-sonnet':    { type: 'anthropic', model: 'claude-sonnet', credentialLabel: null, endpoint: null, local: false },
    'claude-opus':      { type: 'anthropic', model: 'claude-opus',   credentialLabel: null, endpoint: null, local: false },
    'pplx-sonar-pro':   { type: 'perplexity', model: 'pplx-sonar-pro', credentialLabel: 'ppx', endpoint: null, local: false },
  };
}

test('TC-MOD-ROST-001: standard jobs with unicode → separator', () => {
  const cm = makeCM();
  const lines = [
    '  quick:    claude-sonnet \u2192 qwen3:8b',
    '  thinking: claude-opus \u2192 claude-sonnet \u2192 qwen3:8b',
  ];
  const roster = cm._parseRosterSection(lines, makePlayers(), 'qwen3:8b');
  assert.deepStrictEqual(roster.quick,    ['claude-sonnet', 'qwen3:8b']);
  assert.deepStrictEqual(roster.thinking, ['claude-opus', 'claude-sonnet', 'qwen3:8b']);
});

test('TC-MOD-ROST-002: ASCII -> separator works the same as unicode →', () => {
  const cm = makeCM();
  const lines = ['  quick: claude-sonnet -> qwen3:8b'];
  const roster = cm._parseRosterSection(lines, makePlayers(), 'qwen3:8b');
  assert.deepStrictEqual(roster.quick, ['claude-sonnet', 'qwen3:8b']);
});

test('TC-MOD-ROST-003: custom job names are accepted (not limited to six defaults)', () => {
  const cm = makeCM();
  const lines = ['  summarise: claude-sonnet \u2192 qwen3:8b'];
  const roster = cm._parseRosterSection(lines, makePlayers(), 'qwen3:8b');
  assert.ok(roster.summarise);
  assert.deepStrictEqual(roster.summarise, ['claude-sonnet', 'qwen3:8b']);
});

test('TC-MOD-ROST-004: unknown player name is warned and skipped', () => {
  const cm = makeCM();
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (msg) => warnings.push(msg);
  const lines = ['  quick: ghost-model \u2192 qwen3:8b'];
  const roster = cm._parseRosterSection(lines, makePlayers(), 'qwen3:8b');
  console.warn = origWarn;
  // ghost-model skipped, qwen3:8b remains
  assert.deepStrictEqual(roster.quick, ['qwen3:8b']);
  assert.ok(warnings.some(w => w.includes("ghost-model")));
});

test('TC-MOD-ROST-005: last-local rule appends localDefault when chain ends cloud', () => {
  const cm = makeCM();
  // Chain ends with cloud player claude-sonnet — qwen3:8b should be appended
  const lines = ['  quick: claude-sonnet'];
  const roster = cm._parseRosterSection(lines, makePlayers(), 'qwen3:8b');
  assert.deepStrictEqual(roster.quick, ['claude-sonnet', 'qwen3:8b']);
});

test('TC-MOD-ROST-006: last-local rule not applied when chain already ends with local', () => {
  const cm = makeCM();
  const lines = ['  quick: claude-sonnet \u2192 qwen3:8b'];
  const roster = cm._parseRosterSection(lines, makePlayers(), 'qwen3:8b');
  // Should not double-append qwen3:8b
  assert.deepStrictEqual(roster.quick, ['claude-sonnet', 'qwen3:8b']);
  assert.strictEqual(roster.quick.filter(p => p === 'qwen3:8b').length, 1);
});

// ============================================================
// Tests: _parseCustomModelsCard
// ============================================================

console.log('\n--- _parseCustomModelsCard ---\n');

const FULL_PLAYERS_ROSTER_DESC = [
  'Players:',
  '  local: qwen3:8b, qwen3:14b-fast (ollama)',
  '  cloud: claude-sonnet (anthropic)',
  '  cloud: pplx-sonar-pro (perplexity, key: perplexity-api-key)',
  '',
  'Roster:',
  '  quick:     claude-sonnet \u2192 qwen3:8b',
  '  tools:     claude-sonnet \u2192 qwen3:8b',
  '  thinking:  claude-sonnet \u2192 qwen3:14b-fast',
  '  research:  pplx-sonar-pro \u2192 claude-sonnet \u2192 qwen3:8b',
  '---',
  'Documentation below the line (never parsed)',
].join('\n');

test('TC-MOD-CMC-001: full Players + Roster description parses correctly', () => {
  const cm = makeCM();
  const result = cm._parseCustomModelsCard(FULL_PLAYERS_ROSTER_DESC);
  assert.ok(result, 'should return non-null');
  assert.strictEqual(result.preset, 'custom');
  // Players
  assert.ok(result.players['qwen3:8b']);
  assert.strictEqual(result.players['qwen3:8b'].local, true);
  assert.ok(result.players['claude-sonnet']);
  assert.strictEqual(result.players['claude-sonnet'].local, false);
  assert.ok(result.players['pplx-sonar-pro']);
  assert.strictEqual(result.players['pplx-sonar-pro'].credentialLabel, 'perplexity-api-key');
  // localDefault picks first local player
  assert.strictEqual(result.localDefault, 'qwen3:8b');
  // Roster
  assert.deepStrictEqual(result.roster.quick,    ['claude-sonnet', 'qwen3:8b']);
  assert.deepStrictEqual(result.roster.tools,    ['claude-sonnet', 'qwen3:8b']);
  assert.deepStrictEqual(result.roster.research, ['pplx-sonar-pro', 'claude-sonnet', 'qwen3:8b']);
});

test('TC-MOD-CMC-002: empty description returns null', () => {
  const cm = makeCM();
  assert.strictEqual(cm._parseCustomModelsCard(null), null);
  assert.strictEqual(cm._parseCustomModelsCard(''), null);
  assert.strictEqual(cm._parseCustomModelsCard('   '), null);
});

test('TC-MOD-CMC-003: description without Players section returns null (legacy fallback)', () => {
  const cm = makeCM();
  const legacyDesc = 'quick: qwen3:8b\nthinking: claude-opus\n---\ndocs';
  assert.strictEqual(cm._parseCustomModelsCard(legacyDesc), null);
});

// ============================================================
// Tests: _parseModelsCard with ⚙4 new/legacy/error behaviour
// ============================================================

console.log('\n--- _parseModelsCard ⚙4 new/legacy/error paths ---\n');

test('TC-MOD-PARSE-009: ⚙4 with new Players/Roster format takes priority over legacy', () => {
  const cm = makeCM();
  const card = makeCard('Models', FULL_PLAYERS_ROSTER_DESC, [g4Label]);
  const result = cm._parseModelsCard(card);
  assert.ok(result, 'should return non-null');
  assert.strictEqual(result.preset, 'custom');
  assert.ok(result.players, 'new format returns players map');
  assert.ok(result.roster, 'new format returns roster map');
  assert.strictEqual(result.roster.quick[0], 'claude-sonnet');
});

test('TC-MOD-PARSE-010: ⚙4 falls back to legacy format when no Players section', () => {
  const cm = makeCM();
  const legacyDesc = 'quick: qwen3:8b\nthinking: claude-opus\n---\ndocs';
  const card = makeCard('Models', legacyDesc, [g4Label]);
  const result = cm._parseModelsCard(card);
  assert.ok(result, 'should return non-null');
  // Legacy format returns { roster } without players/localDefault
  assert.ok(result.roster, 'legacy roster present');
  assert.strictEqual(result.players, undefined);
  assert.deepStrictEqual(result.roster.quick, ['qwen3:8b']);
});

test('TC-MOD-PARSE-011: ⚙4 parse error returns null (HeartbeatManager keeps current config)', () => {
  const cm = makeCM();
  // Force a throw by patching the internal method
  cm._parseCustomModelsCard = () => { throw new Error('simulated parse failure'); };
  cm._parseCustomRoster = () => { throw new Error('simulated legacy failure'); };
  const errors = [];
  const origError = console.error;
  console.error = (msg) => errors.push(msg);
  const card = makeCard('Models', 'some description', [g4Label]);
  const result = cm._parseModelsCard(card);
  console.error = origError;
  assert.strictEqual(result, null);
  assert.ok(errors.some(e => e.includes('Failed to parse Models card')));
});

// ============================================================
// Tests: Change detection (fingerprint-based)
// ============================================================

console.log('\n--- Change detection (fingerprint-based) ---\n');

test('TC-MOD-CHG-001: first parse returns changed=true (needs initial registration)', () => {
  const cm = makeCM();
  const card = makeCard('Models', '', [g2Label]);
  const result = cm._parseModelsCard(card);
  assert.strictEqual(result.changed, true);
  assert.strictEqual(result.preset, 'smart-mix');
});

test('TC-MOD-CHG-002: same card twice returns changed=false on second call', () => {
  const cm = makeCM();
  const card = makeCard('Models', '', [g2Label]);
  cm._parseModelsCard(card);
  const result = cm._parseModelsCard(card);
  assert.strictEqual(result.changed, false);
  assert.strictEqual(result.preset, 'smart-mix');
});

test('TC-MOD-CHG-003: label change triggers changed=true', () => {
  const cm = makeCM();
  cm._parseModelsCard(makeCard('Models', '', [g2Label]));
  const result = cm._parseModelsCard(makeCard('Models', '', [g1Label]));
  assert.strictEqual(result.changed, true);
  assert.strictEqual(result.preset, 'all-local');
});

test('TC-MOD-CHG-004: description change within ⚙4 triggers changed=true', () => {
  const cm = makeCM();
  const desc1 = 'quick: qwen3:8b\n---\ndocs';
  const desc2 = 'quick: claude-opus\n---\ndocs';
  cm._parseModelsCard(makeCard('Models', desc1, [g4Label]));
  const result = cm._parseModelsCard(makeCard('Models', desc2, [g4Label]));
  assert.strictEqual(result.changed, true);
});

test('TC-MOD-CHG-005: doc section change below --- does NOT trigger changed', () => {
  const cm = makeCM();
  const desc1 = 'quick: qwen3:8b\n---\nold docs';
  const desc2 = 'quick: qwen3:8b\n---\nnew docs';
  cm._parseModelsCard(makeCard('Models', desc1, [g4Label]));
  const result = cm._parseModelsCard(makeCard('Models', desc2, [g4Label]));
  assert.strictEqual(result.changed, false);
});

test('TC-MOD-CHG-006: invalidateCache clears cached config', () => {
  const cm = makeCM();
  cm.cachedConfig = { test: true };
  cm.cacheExpiry = Date.now() + 60000;
  cm.invalidateCache();
  assert.strictEqual(cm.cachedConfig, null);
  assert.strictEqual(cm.cacheExpiry, 0);
});

// ============================================================
// Summary
// ============================================================

setTimeout(() => {
  summary();
  exitWithCode();
}, 100);
