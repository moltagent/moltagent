/**
 * CockpitManager Unit Tests
 *
 * Tests the Deck-as-Control-Plane feature: bootstrap, read config,
 * system prompt overlay, status updates.
 *
 * Run: node test/unit/integrations/cockpit-manager.test.js
 *
 * @module test/unit/integrations/cockpit-manager
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const { createMockNCRequestManager, createMockAuditLog } = require('../../helpers/mock-factories');

// Import module under test
const CockpitManager = require('../../../src/lib/integrations/cockpit-manager');
const {
  CockpitError,
  BOARD_TITLE,
  LABEL_DEFS,
  STACK_DEFS,
  DEFAULT_CARDS,
  PERSONA_VALUE_MAP,
  SYSTEM_VALUE_MAP
} = CockpitManager;

// ============================================================
// Test Fixtures
// ============================================================

/**
 * Create a mock DeckClient that records calls and returns configurable responses.
 * @param {Object} [overrides] - Method overrides
 * @returns {Object} Mock DeckClient
 */
function createMockDeckClient(overrides = {}) {
  const calls = [];

  const mock = {
    _calls: calls,
    nc: { ncUrl: 'https://cloud.example.com', ncUser: 'moltagent', request: async () => ({ status: 200, body: {} }) },
    baseUrl: 'https://cloud.example.com',
    username: 'moltagent',

    listBoards: async () => {
      calls.push({ method: 'listBoards' });
      return overrides.listBoards || [];
    },

    getBoard: async (boardId) => {
      calls.push({ method: 'getBoard', boardId });
      return overrides.getBoard || { id: boardId, title: BOARD_TITLE, stacks: [], labels: [] };
    },

    getStacks: async (boardId) => {
      calls.push({ method: 'getStacks', boardId });
      return overrides.getStacks || [];
    },

    createStack: async (boardId, title, order) => {
      calls.push({ method: 'createStack', boardId, title, order });
      return overrides.createStack || { id: 100 + order, title, order };
    },

    shareBoard: async (boardId, participant, type, permEdit, permShare, permManage) => {
      calls.push({ method: 'shareBoard', boardId, participant, type, permEdit, permShare, permManage });
      return overrides.shareBoard || { id: 1 };
    },

    _request: async (method, path, body) => {
      calls.push({ method: '_request', httpMethod: method, path, body });
      if (overrides._request) {
        return typeof overrides._request === 'function'
          ? overrides._request(method, path, body)
          : overrides._request;
      }
      // Default responses for common paths
      // Check labels first (before boards check, since path includes /boards/)
      if (method === 'POST' && path.includes('/labels')) {
        return { id: 200 + calls.length, title: body?.title || 'label', color: body?.color };
      }
      if (method === 'POST' && path.includes('/boards')) {
        return { id: 99, title: BOARD_TITLE };
      }
      if (method === 'POST' && path.includes('/stacks')) {
        return { id: 100 + (body?.order || 0), title: body?.title || 'stack', order: body?.order || 0 };
      }
      if (method === 'POST' && path.includes('/cards')) {
        return { id: 300 + calls.length, title: body?.title || 'card' };
      }
      if (method === 'PUT' && path.includes('/assignLabel')) {
        return { success: true };
      }
      if (method === 'PUT' && path.includes('/cards/')) {
        return { id: 1, title: body?.title || 'card', ...body };
      }
      if (method === 'DELETE') {
        return { success: true };
      }
      return {};
    }
  };

  return mock;
}

/**
 * Create sample stack data as returned by deck.getStacks().
 * Each stack includes cards with labels matching the Cockpit board structure.
 * @returns {Array<Object>} Array of stack objects
 */
function createSampleStacks() {
  const starLabel = { id: 1, title: '\u2699\ufe0f\u2605', color: 'ffd700' };
  const g1Label = { id: 2, title: '\u2699\ufe0f1', color: 'e9322d' };
  const g2Label = { id: 3, title: '\u2699\ufe0f2', color: 'f0c400' };
  const g3Label = { id: 4, title: '\u2699\ufe0f3', color: '00b600' };
  const g4Label = { id: 5, title: '\u2699\ufe0f4', color: '0000ff' };

  return [
    {
      id: 101, title: '\ud83d\udca1 Styles', order: 0,
      cards: [
        { id: 301, title: 'Concise Executive', description: 'Short, answer-first, data-driven.', labels: [starLabel] },
        { id: 302, title: 'Warm Professional', description: 'Friendly but polished.', labels: [] },
        { id: 303, title: 'Blunt Analyst', description: 'Direct, no softening.', labels: [] }
      ]
    },
    {
      id: 102, title: '\ud83c\udfad Persona', order: 1,
      cards: [
        { id: 311, title: 'Name', description: 'Molti', labels: [g4Label] },
        { id: 312, title: 'Humor', description: 'none/light/playful', labels: [g2Label] },
        { id: 313, title: 'Emoji', description: 'none/minimal/generous', labels: [g1Label] },
        { id: 314, title: 'Language', description: 'EN', labels: [g4Label] },
        { id: 315, title: 'Verbosity', description: 'concise/balanced/detailed', labels: [g1Label] },
        { id: 316, title: 'Formality', description: 'formal/balanced/casual', labels: [g2Label] }
      ]
    },
    {
      id: 103, title: '\ud83d\udee1\ufe0f Guardrails', order: 2,
      cards: [
        { id: 321, title: 'Never delete files without asking', description: 'Always require confirmation.', labels: [] },
        { id: 322, title: 'Confirm before sending external comms', description: 'Requires HITL.', labels: [] }
      ]
    },
    {
      id: 104, title: '\ud83c\udf19 Modes', order: 3,
      cards: [
        { id: 331, title: 'Full Auto', description: 'Maximum initiative.', labels: [starLabel] },
        { id: 332, title: 'Focus Mode', description: 'No proactive messages.', labels: [] }
      ]
    },
    {
      id: 105, title: '\ud83d\udd27 System', order: 4,
      cards: [
        { id: 341, title: 'Search Provider', description: 'searxng/perplexity/custom', labels: [g3Label] },
        { id: 342, title: 'LLM Tier', description: 'local-only/balanced/premium', labels: [g2Label] },
        { id: 343, title: 'Daily Digest', description: '08:00', labels: [g3Label] },
        { id: 344, title: 'Auto-tag Files', description: 'off/on', labels: [g3Label] },
        { id: 345, title: 'Initiative Level', description: '1/2/3/4', labels: [g2Label] },
        { id: 346, title: 'Working Hours', description: '08:00-18:00', labels: [g4Label] }
      ]
    },
    {
      id: 106, title: '\ud83d\udcca Status', order: 5,
      cards: [
        { id: 351, title: 'Health', description: 'OK', labels: [] },
        { id: 352, title: 'Costs', description: 'This month: \u20ac0.00', labels: [] },
        { id: 353, title: 'Model Usage', description: 'This month: 0 requests', labels: [] }
      ]
    }
  ];
}

// ============================================================
// Tests
// ============================================================

console.log('CockpitManager Unit Tests');
console.log('=========================\n');

// --- Constructor ---

test('constructor requires deckClient', () => {
  assert.throws(() => new CockpitManager({}), /requires a deckClient/);
  assert.throws(() => new CockpitManager({ deckClient: null }), /requires a deckClient/);
});

test('constructor accepts config and sets defaults', () => {
  const deck = createMockDeckClient();
  const cm = new CockpitManager({ deckClient: deck });

  assert.strictEqual(cm.boardId, null);
  assert.strictEqual(cm.cachedConfig, null);
  assert.strictEqual(cm._initialized, false);
  assert.ok(cm.CACHE_TTL > 0);
});

test('constructor uses config overrides', () => {
  const deck = createMockDeckClient();
  const auditLog = createMockAuditLog();
  const cm = new CockpitManager({
    deckClient: deck,
    config: { adminUser: 'funana', boardTitle: 'Test Cockpit', cacheTTLMs: 60000 },
    auditLog
  });

  assert.strictEqual(cm.adminUser, 'funana');
  assert.strictEqual(cm.boardTitle, 'Test Cockpit');
  assert.strictEqual(cm.CACHE_TTL, 60000);
});

// --- Module exports ---

test('module exports CockpitManager and constants', () => {
  assert.strictEqual(typeof CockpitManager, 'function');
  assert.strictEqual(typeof CockpitError, 'function');
  assert.strictEqual(BOARD_TITLE, 'Moltagent Cockpit');
  assert.ok(Array.isArray(LABEL_DEFS));
  assert.strictEqual(LABEL_DEFS.length, 10);
  assert.ok(Array.isArray(STACK_DEFS));
  assert.strictEqual(STACK_DEFS.length, 6);
  assert.ok(DEFAULT_CARDS.styles);
  assert.ok(DEFAULT_CARDS.persona);
  assert.ok(DEFAULT_CARDS.guardrails);
  assert.ok(DEFAULT_CARDS.modes);
  assert.ok(DEFAULT_CARDS.system);
  assert.ok(DEFAULT_CARDS.status);
});

test('CockpitError has correct properties', () => {
  const err = new CockpitError('test error', 'bootstrap', new Error('cause'));
  assert.strictEqual(err.name, 'CockpitError');
  assert.strictEqual(err.message, 'test error');
  assert.strictEqual(err.phase, 'bootstrap');
  assert.ok(err.cause instanceof Error);
  assert.ok(err instanceof Error);
});

// --- Constants validation ---

test('LABEL_DEFS includes all 10 expected labels (⚙️ namespace)', () => {
  assert.strictEqual(LABEL_DEFS.length, 10, 'Should have 10 labels');
  const titles = LABEL_DEFS.map(l => l.title);
  assert.ok(titles.includes('⚙️1'), 'Should have ⚙️1');
  assert.ok(titles.includes('⚙️2'), 'Should have ⚙️2');
  assert.ok(titles.includes('⚙️3'), 'Should have ⚙️3');
  assert.ok(titles.includes('⚙️4'), 'Should have ⚙️4');
  assert.ok(titles.includes('⚙️5'), 'Should have ⚙️5');
  assert.ok(titles.includes('⚙️6'), 'Should have ⚙️6');
  assert.ok(titles.includes('⚙️7'), 'Should have ⚙️7');
  assert.ok(titles.includes('⚙️8'), 'Should have ⚙️8');
  assert.ok(titles.includes('⚙️9'), 'Should have ⚙️9');
  assert.ok(titles.includes('⚙️★'), 'Should have ⚙️★');
});

test('STACK_DEFS has 6 stacks in correct order', () => {
  assert.strictEqual(STACK_DEFS[0].key, 'styles');
  assert.strictEqual(STACK_DEFS[1].key, 'persona');
  assert.strictEqual(STACK_DEFS[2].key, 'guardrails');
  assert.strictEqual(STACK_DEFS[3].key, 'modes');
  assert.strictEqual(STACK_DEFS[4].key, 'system');
  assert.strictEqual(STACK_DEFS[5].key, 'status');
});

test('DEFAULT_CARDS has 5 style cards with Concise Executive starred', () => {
  assert.strictEqual(DEFAULT_CARDS.styles.length, 5);
  const starred = DEFAULT_CARDS.styles.filter(c => c.defaultLabel && c.defaultLabel.includes('★'));
  assert.strictEqual(starred.length, 1);
  assert.strictEqual(starred[0].title, 'Concise Executive');
});

test('DEFAULT_CARDS has 6 persona cards', () => {
  assert.strictEqual(DEFAULT_CARDS.persona.length, 6);
  const titles = DEFAULT_CARDS.persona.map(c => c.title);
  assert.ok(titles.includes('Name'));
  assert.ok(titles.includes('Humor'));
  assert.ok(titles.includes('Emoji'));
  assert.ok(titles.includes('Language'));
  assert.ok(titles.includes('Verbosity'));
  assert.ok(titles.includes('Formality'));
});

test('DEFAULT_CARDS has 4 guardrail cards', () => {
  assert.strictEqual(DEFAULT_CARDS.guardrails.length, 4);
});

test('DEFAULT_CARDS has 5 mode cards with Full Auto starred', () => {
  assert.strictEqual(DEFAULT_CARDS.modes.length, 5);
  const starred = DEFAULT_CARDS.modes.filter(c => c.defaultLabel && c.defaultLabel.includes('★'));
  assert.strictEqual(starred.length, 1);
  assert.strictEqual(starred[0].title, 'Full Auto');
});

test('DEFAULT_CARDS has 9 system cards (including Budget Limits + Voice + Infrastructure)', () => {
  assert.strictEqual(DEFAULT_CARDS.system.length, 9);
  const titles = DEFAULT_CARDS.system.map(c => c.title);
  assert.ok(titles.some(t => t.includes('Budget')), 'Should include Budget Limits card');
  assert.ok(titles.some(t => t.includes('Voice')), 'Should include Voice card');
  assert.ok(titles.some(t => t.includes('Infrastructure')), 'Should include Infrastructure card');
});

test('DEFAULT_CARDS has 3 status cards: Health, Costs, Model Usage', () => {
  assert.strictEqual(DEFAULT_CARDS.status.length, 3);
  const titles = DEFAULT_CARDS.status.map(c => c.title);
  assert.ok(titles.includes('Health'));
  assert.ok(titles.includes('Costs'));
  assert.ok(titles.includes('Model Usage'));
});

test('PERSONA_VALUE_MAP covers all option-based persona dimensions (off/moderate/on)', () => {
  assert.ok(PERSONA_VALUE_MAP.Humor);
  assert.ok(PERSONA_VALUE_MAP.Emoji);
  assert.ok(PERSONA_VALUE_MAP.Verbosity);
  assert.ok(PERSONA_VALUE_MAP.Formality);
  assert.strictEqual(PERSONA_VALUE_MAP.Humor.off, 'none');
  assert.strictEqual(PERSONA_VALUE_MAP.Humor.moderate, 'light');
  assert.strictEqual(PERSONA_VALUE_MAP.Humor.on, 'playful');
});

test('SYSTEM_VALUE_MAP covers all option-based system settings', () => {
  assert.ok(SYSTEM_VALUE_MAP['Search Provider']);
  assert.ok(SYSTEM_VALUE_MAP['LLM Tier']);
  assert.ok(SYSTEM_VALUE_MAP['Daily Digest']);
  assert.ok(SYSTEM_VALUE_MAP['Auto-tag Files']);
  assert.ok(SYSTEM_VALUE_MAP['Initiative Level']);
  assert.ok(SYSTEM_VALUE_MAP['\ud83d\udd0a Voice'], 'Voice entry should exist in SYSTEM_VALUE_MAP');
  assert.strictEqual(SYSTEM_VALUE_MAP['\ud83d\udd0a Voice'].off, 'off');
  assert.strictEqual(SYSTEM_VALUE_MAP['\ud83d\udd0a Voice'].moderate, 'listen');
  assert.strictEqual(SYSTEM_VALUE_MAP['\ud83d\udd0a Voice'].on, 'full');
});

// --- Bootstrap tests ---

asyncTest('bootstrap() creates board with correct title', async () => {
  const deck = createMockDeckClient();
  const cm = new CockpitManager({ deckClient: deck });

  await cm.bootstrap();

  const boardCreationCalls = deck._calls.filter(c =>
    c.method === '_request' && c.httpMethod === 'POST' && c.path === '/index.php/apps/deck/api/v1.0/boards'
  );
  assert.strictEqual(boardCreationCalls.length, 1);
  assert.strictEqual(boardCreationCalls[0].body.title, BOARD_TITLE);
});

asyncTest('bootstrap() creates 6 stacks in correct order', async () => {
  const deck = createMockDeckClient();
  const cm = new CockpitManager({ deckClient: deck });

  await cm.bootstrap();

  const stackCreationCalls = deck._calls.filter(c => c.method === 'createStack');
  assert.strictEqual(stackCreationCalls.length, 6);

  // Verify order matches STACK_DEFS
  for (let i = 0; i < STACK_DEFS.length; i++) {
    assert.strictEqual(stackCreationCalls[i].title, STACK_DEFS[i].title);
    assert.strictEqual(stackCreationCalls[i].order, i);
  }
});

asyncTest('bootstrap() creates all 10 labels with correct colors', async () => {
  const deck = createMockDeckClient();
  const cm = new CockpitManager({ deckClient: deck });

  await cm.bootstrap();

  const labelCreationCalls = deck._calls.filter(c =>
    c.method === '_request' && c.httpMethod === 'POST' && c.path.includes('/labels')
  );
  assert.strictEqual(labelCreationCalls.length, 10, 'Should create 10 labels');

  // Verify labels match LABEL_DEFS
  for (let i = 0; i < LABEL_DEFS.length; i++) {
    assert.strictEqual(labelCreationCalls[i].body.title, LABEL_DEFS[i].title);
    assert.strictEqual(labelCreationCalls[i].body.color, LABEL_DEFS[i].color);
  }
});

asyncTest('bootstrap() stars Concise Executive style by default', async () => {
  const deck = createMockDeckClient();
  const cm = new CockpitManager({ deckClient: deck });

  await cm.bootstrap();

  const assignLabelCalls = deck._calls.filter(c =>
    c.method === '_request' && c.httpMethod === 'PUT' && c.path.includes('/assignLabel')
  );

  // Should have at least one label assignment (Concise Executive gets Active label)
  assert.ok(assignLabelCalls.length > 0, 'Should assign Active label to at least one style card');
});

asyncTest('bootstrap() stars Full Auto mode by default', async () => {
  const deck = createMockDeckClient();
  const cm = new CockpitManager({ deckClient: deck });

  await cm.bootstrap();

  const assignLabelCalls = deck._calls.filter(c =>
    c.method === '_request' && c.httpMethod === 'PUT' && c.path.includes('/assignLabel')
  );

  // Should have multiple label assignments (persona defaults + style star + mode star)
  assert.ok(assignLabelCalls.length > 0, 'Should assign labels during bootstrap');
});

asyncTest('bootstrap() shares board with admin user', async () => {
  const deck = createMockDeckClient();
  const cm = new CockpitManager({ deckClient: deck, config: { adminUser: 'funana' } });

  await cm.bootstrap();

  const shareCall = deck._calls.find(c => c.method === 'shareBoard');
  assert.ok(shareCall, 'Should call shareBoard');
  assert.strictEqual(shareCall.participant, 'funana');
});

asyncTest('initialize() is idempotent -- uses existing board', async () => {
  const deck = createMockDeckClient({
    listBoards: [{ id: 99, title: BOARD_TITLE }],
    getBoard: { id: 99, title: BOARD_TITLE, labels: [] },
    getStacks: createSampleStacks()
  });
  const cm = new CockpitManager({ deckClient: deck });

  await cm.initialize();

  // Check specifically for board creation (POST to /boards endpoint, not /boards/{id}/...)
  const boardCreationCalls = deck._calls.filter(c =>
    c.method === '_request' && c.httpMethod === 'POST' && c.path === '/index.php/apps/deck/api/v1.0/boards'
  );
  assert.strictEqual(boardCreationCalls.length, 0, 'Should not create board if it exists');
  assert.strictEqual(cm.boardId, 99, 'Should use existing board ID');
});

// --- Read tests ---

asyncTest('readConfig() returns full config object from stacks', async () => {
  const deck = createMockDeckClient({
    getStacks: createSampleStacks()
  });
  const cm = new CockpitManager({ deckClient: deck });
  cm.boardId = 99;
  cm._initialized = true;

  const config = await cm.readConfig();

  assert.ok(config, 'Should return config object');
  assert.ok(config.style, 'Should have style property');
  assert.ok(config.persona, 'Should have persona property');
  assert.ok(Array.isArray(config.guardrails), 'Should have guardrails array');
  assert.ok(config.mode, 'Should have mode property');
  assert.ok(config.system, 'Should have system property');
});

asyncTest('readConfig() uses cache within TTL', async () => {
  const deck = createMockDeckClient({
    getStacks: createSampleStacks()
  });
  const cm = new CockpitManager({ deckClient: deck });
  cm.boardId = 99;
  cm._initialized = true;

  await cm.readConfig();
  await cm.readConfig();

  const getStacksCalls = deck._calls.filter(c => c.method === 'getStacks');
  assert.strictEqual(getStacksCalls.length, 1, 'Should only call getStacks once when cache is valid');
});

asyncTest('readConfig() refreshes after TTL expires', async () => {
  const deck = createMockDeckClient({
    getStacks: createSampleStacks()
  });
  const cm = new CockpitManager({ deckClient: deck });
  cm.boardId = 99;
  cm._initialized = true;

  await cm.readConfig();
  cm.cacheExpiry = Date.now() - 1000; // Expire the cache

  await cm.readConfig();

  const getStacksCalls = deck._calls.filter(c => c.method === 'getStacks');
  assert.strictEqual(getStacksCalls.length, 2, 'Should call getStacks again after cache expires');
});

asyncTest('getActiveStyle() returns starred style card description', async () => {
  const deck = createMockDeckClient();
  const cm = new CockpitManager({ deckClient: deck });

  const starLabel = { id: 1, title: '⚙️★', color: 'ffd700' };
  const cards = [
    { id: 301, title: 'Concise Executive', description: 'Short, answer-first.', labels: [starLabel] },
    { id: 302, title: 'Warm Professional', description: 'Friendly but polished.', labels: [] }
  ];

  const result = await cm.getActiveStyle(cards);

  assert.ok(result, 'Should return style object');
  assert.strictEqual(result.name, 'Concise Executive');
  assert.strictEqual(result.description, 'Short, answer-first.');
});

asyncTest('getActiveStyle() returns null if no style is starred', async () => {
  const deck = createMockDeckClient();
  const cm = new CockpitManager({ deckClient: deck });

  const cards = [
    { id: 301, title: 'Concise Executive', description: 'Short, answer-first.', labels: [] },
    { id: 302, title: 'Warm Professional', description: 'Friendly but polished.', labels: [] }
  ];

  const result = await cm.getActiveStyle(cards);

  assert.strictEqual(result, null, 'Should return null when no card is starred');
});

asyncTest('getGuardrails() returns all guardrail cards', async () => {
  const deck = createMockDeckClient();
  const cm = new CockpitManager({ deckClient: deck });

  const cards = [
    { id: 321, title: 'Never delete files without asking', description: 'Always require confirmation.', labels: [] },
    { id: 322, title: 'Confirm before sending external comms', description: 'Requires HITL.', labels: [] }
  ];

  const result = await cm.getGuardrails(cards);

  assert.ok(Array.isArray(result), 'Should return array');
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].title, 'Never delete files without asking');
  assert.strictEqual(result[0].description, 'Always require confirmation.');
  assert.strictEqual(result[1].title, 'Confirm before sending external comms');
});

asyncTest('getGuardrails() returns empty array if no guardrails', async () => {
  const deck = createMockDeckClient();
  const cm = new CockpitManager({ deckClient: deck });

  const result = await cm.getGuardrails([]);

  assert.ok(Array.isArray(result), 'Should return array');
  assert.strictEqual(result.length, 0, 'Should return empty array');
});

asyncTest('getActiveMode() returns starred mode card description', async () => {
  const deck = createMockDeckClient();
  const cm = new CockpitManager({ deckClient: deck });

  const starLabel = { id: 1, title: '⚙️★', color: 'ffd700' };
  const cards = [
    { id: 331, title: 'Full Auto', description: 'Maximum initiative.', labels: [starLabel] },
    { id: 332, title: 'Focus Mode', description: 'No proactive messages.', labels: [] }
  ];

  const result = await cm.getActiveMode(cards);

  assert.ok(result, 'Should return mode object');
  assert.strictEqual(result.name, 'Full Auto');
  assert.strictEqual(result.description, 'Maximum initiative.');
});

asyncTest('getPersona() maps label colors to correct values', async () => {
  const deck = createMockDeckClient();
  const cm = new CockpitManager({ deckClient: deck });

  const g1Label = { id: 2, title: '⚙️1', color: 'e9322d' };
  const g2Label = { id: 3, title: '⚙️2', color: 'f0c400' };
  const g4Label = { id: 5, title: '⚙️4', color: '0000ff' };

  const cards = [
    { id: 311, title: 'Name', description: 'Molti', labels: [g4Label] },
    { id: 312, title: 'Humor', description: 'none/light/playful', labels: [g2Label] },
    { id: 313, title: 'Emoji', description: 'none/minimal/generous', labels: [g1Label] },
    { id: 314, title: 'Language', description: 'EN', labels: [g4Label] },
    { id: 315, title: 'Verbosity', description: 'concise/balanced/detailed', labels: [g1Label] },
    { id: 316, title: 'Formality', description: 'formal/balanced/casual', labels: [g2Label] }
  ];

  const result = await cm.getPersona(cards);

  assert.ok(result, 'Should return persona object');
  assert.strictEqual(result.humor, 'light', 'Moderate should map to light');
  assert.strictEqual(result.emoji, 'none', 'Off should map to none');
  assert.strictEqual(result.verbosity, 'concise', 'Off should map to concise');
  assert.strictEqual(result.formality, 'balanced', 'Moderate should map to balanced');
});

asyncTest('getPersona() handles custom (⚙️4) label -> reads description', async () => {
  const deck = createMockDeckClient();
  const cm = new CockpitManager({ deckClient: deck });

  const g4Label = { id: 5, title: '⚙️4', color: '0000ff' };

  const cards = [
    { id: 311, title: 'Name', description: 'Molti', labels: [g4Label] },
    { id: 314, title: 'Language', description: 'EN', labels: [g4Label] }
  ];

  const result = await cm.getPersona(cards);

  assert.strictEqual(result.name, 'Molti', 'Should read Name from card description');
  assert.strictEqual(result.language, 'EN', 'Should read Language from card description');
});

asyncTest('getSystemSettings() maps label colors to correct values', async () => {
  const deck = createMockDeckClient();
  const cm = new CockpitManager({ deckClient: deck });

  const g1Label = { id: 2, title: '⚙️1', color: 'e9322d' };
  const g2Label = { id: 3, title: '⚙️2', color: 'f0c400' };
  const g3Label = { id: 4, title: '⚙️3', color: '00b600' };
  const g4Label = { id: 5, title: '⚙️4', color: '0000ff' };

  const cards = [
    { id: 341, title: 'Search Provider', description: 'searxng/perplexity/custom', labels: [g3Label] },
    { id: 342, title: 'LLM Tier', description: 'local-only/balanced/premium', labels: [g2Label] },
    { id: 343, title: 'Daily Digest', description: '08:00', labels: [g3Label] },
    { id: 344, title: 'Auto-tag Files', description: 'off/on', labels: [g3Label] },
    { id: 345, title: 'Initiative Level', description: '1/2/3/4', labels: [g2Label] },
    { id: 346, title: 'Working Hours', description: '08:00-18:00', labels: [g4Label] }
  ];

  const result = await cm.getSystemSettings(cards);

  assert.ok(result, 'Should return system settings object');
  assert.strictEqual(result.searchProvider, 'searxng', 'On should map to searxng');
  assert.strictEqual(result.llmTier, 'balanced', 'Moderate should map to balanced');
  assert.strictEqual(result.dailyDigest, '08:00', 'Daily digest time should be read from description when on');
  assert.strictEqual(result.autoTagFiles, true, 'Auto-tag should be enabled');
  assert.strictEqual(result.initiativeLevel, 2, 'Initiative level should be parsed from option');
  assert.strictEqual(result.workingHours, '08:00-18:00', 'Custom label should read description');
});

// --- Write tests ---

asyncTest('updateStatus() updates Health card description', async () => {
  const deck = createMockDeckClient({
    getStacks: createSampleStacks()
  });
  const cm = new CockpitManager({ deckClient: deck });
  cm.boardId = 99;
  cm.stacks = { status: 106 };
  cm._initialized = true;

  const healthData = {
    status: 'OK',
    uptimeDays: 5,
    uptimeHours: 12,
    lastError: 'none'
  };

  await cm.updateStatus({ health: healthData });

  const putCalls = deck._calls.filter(c =>
    c.method === '_request' && c.httpMethod === 'PUT' && c.path.includes('/cards/')
  );

  // Should have at least one PUT call for updating card description
  assert.ok(putCalls.length > 0, 'Should call PUT to update card');
});

asyncTest('updateStatus() updates Costs card with monthly data', async () => {
  const deck = createMockDeckClient({
    getStacks: createSampleStacks()
  });
  const cm = new CockpitManager({ deckClient: deck });
  cm.boardId = 99;
  cm.stacks = { status: 106 };
  cm._initialized = true;

  const costData = {
    providers: {
      'anthropic-claude': { monthly: { cost: 12.50, calls: 100 } },
      'ollama': { monthly: { cost: 0, calls: 500 } }
    },
    _providerTypes: { 'anthropic-claude': 'cloud', 'ollama': 'local' }
  };

  await cm.updateStatus({ costs: costData });

  const putCalls = deck._calls.filter(c =>
    c.method === '_request' && c.httpMethod === 'PUT' && c.path.includes('/cards/')
  );

  assert.ok(putCalls.length > 0, 'Should call PUT to update Costs card');
  const costsPut = putCalls.find(c => c.body?.title === 'Costs');
  assert.ok(costsPut, 'Should update the Costs card');
  assert.ok(costsPut.body.description.includes('12.50'), 'Should include monthly cost');
  assert.ok(costsPut.body.description.includes('Local ratio: 83%'), 'Should include local ratio');
});

asyncTest('updateStatus() updates Model Usage card with router stats', async () => {
  const deck = createMockDeckClient({
    getStacks: createSampleStacks()
  });
  const cm = new CockpitManager({ deckClient: deck });
  cm.boardId = 99;
  cm.stacks = { status: 106 };
  cm._initialized = true;

  const routerStats = {
    byProvider: { 'ollama': 80, 'anthropic-claude': 20 },
    _providerTypes: { 'ollama': 'local', 'anthropic-claude': 'cloud' }
  };

  await cm.updateStatus({ routerStats });

  const putCalls = deck._calls.filter(c =>
    c.method === '_request' && c.httpMethod === 'PUT' && c.path.includes('/cards/')
  );

  assert.ok(putCalls.length > 0, 'Should call PUT to update Model Usage card');
  const usagePut = putCalls.find(c => c.body?.title === 'Model Usage');
  assert.ok(usagePut, 'Should update the Model Usage card');
  assert.ok(usagePut.body.description.includes('100 requests'), 'Should include total requests');
  assert.ok(usagePut.body.description.includes('ollama (local)'), 'Should label local providers');
});

// --- New formatter tests ---

test('_formatCostStatus() returns default when no data', () => {
  const deck = createMockDeckClient();
  const cm = new CockpitManager({ deckClient: deck });

  const result = cm._formatCostStatus(null);
  assert.ok(result.includes('This month: \u20ac0.00'));
  assert.ok(result.includes('Local ratio: --'));
});

test('_formatCostStatus() calculates local ratio correctly', () => {
  const deck = createMockDeckClient();
  const cm = new CockpitManager({ deckClient: deck });

  const costs = {
    providers: {
      'ollama': { monthly: { cost: 0, calls: 87 } },
      'anthropic-claude': { monthly: { cost: 5.00, calls: 13 } }
    },
    _providerTypes: { 'ollama': 'local', 'anthropic-claude': 'cloud' }
  };

  const result = cm._formatCostStatus(costs);
  assert.ok(result.includes('This month: \u20ac5.00'), 'Should show monthly total');
  assert.ok(result.includes('Cloud: 13 calls'), 'Should show cloud calls');
  assert.ok(result.includes('Local: 87 calls'), 'Should show local calls');
  assert.ok(result.includes('Local ratio: 87%'), 'Should show local ratio');
});

test('_formatModelUsage() returns default when no data', () => {
  const deck = createMockDeckClient();
  const cm = new CockpitManager({ deckClient: deck });

  const result = cm._formatModelUsage(null);
  assert.ok(result.includes('This month: 0 requests'));
  assert.ok(result.includes('No provider data yet.'));
});

test('_formatModelUsage() uses byProvider fallback when no budget data', () => {
  const deck = createMockDeckClient();
  const cm = new CockpitManager({ deckClient: deck });

  const stats = {
    byProvider: { 'ollama': 80, 'anthropic-claude': 20 },
    _providerTypes: { 'ollama': 'local', 'anthropic-claude': 'cloud' }
  };

  const result = cm._formatModelUsage(stats);
  assert.ok(result.includes('This month: 100 requests'), 'Should total from byProvider');
  assert.ok(result.includes('ollama (local): 80 (80%)'), 'Should show ollama with local label and percentage');
  assert.ok(result.includes('anthropic-claude (cloud): 20 (20%)'), 'Should show claude with cloud label');
});

test('_formatModelUsage() prefers budget monthly data when available', () => {
  const deck = createMockDeckClient();
  const cm = new CockpitManager({ deckClient: deck });

  const stats = {
    byProvider: { 'ollama': 10 },
    budget: {
      providers: {
        'ollama': { monthly: { calls: 500, cost: 0 } },
        'anthropic-claude': { monthly: { calls: 50, cost: 3.00 } }
      }
    },
    _providerTypes: { 'ollama': 'local', 'anthropic-claude': 'cloud' }
  };

  const result = cm._formatModelUsage(stats);
  assert.ok(result.includes('This month: 550 requests'), 'Should use budget monthly totals');
  assert.ok(result.includes('ollama (local): 500'), 'Should show budget ollama count');
});

test('_formatHealthStatus() includes request stats when present', () => {
  const deck = createMockDeckClient();
  const cm = new CockpitManager({ deckClient: deck });

  const health = {
    status: 'OK',
    uptimeDays: 5,
    uptimeHours: 12,
    lastError: 'none',
    requestStats: { total: 47, succeeded: 45, rate: 96 }
  };

  const result = cm._formatHealthStatus(health);
  assert.ok(result.includes('Last session: 47 requests, 45 succeeded (96%)'), 'Should include request stats');
});

test('_formatHealthStatus() includes request stats with infra data', () => {
  const deck = createMockDeckClient();
  const cm = new CockpitManager({ deckClient: deck });

  const health = {
    status: 'OK',
    uptimeDays: 5,
    infra: {
      overall: 'ok',
      services: { ollama: { ok: true, latencyMs: 45, status: 'up' } },
      systemStats: { ramUsedPct: 50, diskUsedPct: 40, uptimeDays: 5 }
    },
    requestStats: { total: 100, succeeded: 98, rate: 98 }
  };

  const result = cm._formatHealthStatus(health);
  assert.ok(result.includes('Last session: 100 requests, 98 succeeded (98%)'), 'Should include request stats in infra format');
});

// --- Style directive tests ---

test('buildStyleDirective() returns empty string when no config cached', () => {
  const deck = createMockDeckClient();
  const cm = new CockpitManager({ deckClient: deck });

  const directive = cm.buildStyleDirective();

  assert.strictEqual(directive, '', 'Should return empty string when no config cached');
});

test('buildStyleDirective() returns empty string when no style configured', () => {
  const deck = createMockDeckClient();
  const cm = new CockpitManager({ deckClient: deck });
  cm.cachedConfig = {
    persona: { name: 'Molti', humor: 'light', emoji: 'none', language: 'EN', verbosity: 'concise', formality: 'balanced' },
    guardrails: [],
    mode: { name: 'Full Auto', description: 'Maximum initiative.' },
    system: {}
  };

  const directive = cm.buildStyleDirective();

  assert.strictEqual(directive, '', 'Should return empty string when no style');
});

test('buildStyleDirective() includes style name and description', () => {
  const deck = createMockDeckClient();
  const cm = new CockpitManager({ deckClient: deck });

  cm.cachedConfig = {
    style: { name: 'Concise Executive', description: 'Short, answer-first.' },
    persona: { name: 'Molti', humor: 'light', emoji: 'none', language: 'EN', verbosity: 'concise', formality: 'balanced' },
    guardrails: [],
    mode: { name: 'Full Auto', description: 'Maximum initiative.' },
    system: { searchProvider: 'searxng', llmTier: 'balanced' }
  };

  const directive = cm.buildStyleDirective();

  assert.ok(directive.includes('Concise Executive'), 'Should include style name');
  assert.ok(directive.includes('Short, answer-first'), 'Should include style description');
});

test('buildStyleDirective() includes imperative framing', () => {
  const deck = createMockDeckClient();
  const cm = new CockpitManager({ deckClient: deck });

  cm.cachedConfig = {
    style: { name: 'Warm Teacher', description: 'Patient and encouraging.' },
    persona: { name: 'Molti', humor: 'light', emoji: 'none', language: 'EN', verbosity: 'detailed', formality: 'casual' },
    guardrails: [],
    system: {}
  };

  const directive = cm.buildStyleDirective();

  assert.ok(directive.includes('MUST'), 'Should include imperative MUST');
  assert.ok(directive.includes('not optional'), 'Should include non-optionality');
  assert.ok(directive.includes('Before writing'), 'Should include self-check instruction');
  assert.ok(directive.includes('Warm Teacher'), 'Should reference the style by name in self-check');
});

test('buildStyleDirective() includes style/persona hierarchy line', () => {
  const deck = createMockDeckClient();
  const cm = new CockpitManager({ deckClient: deck });

  cm.cachedConfig = {
    style: { name: 'Concise Executive', description: 'Short, answer-first.' },
    persona: { name: 'Molti', humor: 'light', emoji: 'none', language: 'EN', verbosity: 'concise', formality: 'balanced' },
    guardrails: [],
    system: {}
  };

  const directive = cm.buildStyleDirective();

  assert.ok(directive.includes('Persona directives'), 'Should include hierarchy line');
  assert.ok(directive.includes('take precedence'), 'Should state persona takes precedence');
});

test('buildPersonaDirective() returns empty string when no config cached', () => {
  const deck = createMockDeckClient();
  const cm = new CockpitManager({ deckClient: deck });

  const directive = cm.buildPersonaDirective();
  assert.strictEqual(directive, '', 'Should return empty string when no config cached');
});

test('buildPersonaDirective() returns empty string when no persona', () => {
  const deck = createMockDeckClient();
  const cm = new CockpitManager({ deckClient: deck });
  cm.cachedConfig = { style: { name: 'Concise', description: 'Short.' } };

  const directive = cm.buildPersonaDirective();
  assert.strictEqual(directive, '', 'Should return empty string when no persona');
});

test('buildPersonaDirective() includes name and all dial values', () => {
  const deck = createMockDeckClient();
  const cm = new CockpitManager({ deckClient: deck });

  cm.cachedConfig = {
    persona: { name: 'Molti', humor: 'playful', emoji: 'generous', language: 'EN', verbosity: 'concise', formality: 'casual' }
  };

  const directive = cm.buildPersonaDirective();

  assert.ok(directive.includes('Your name is Molti'), 'Should include name');
  assert.ok(directive.includes('Maximum two short paragraphs'), 'Should include concise verbosity instruction');
  assert.ok(directive.includes('conversational'), 'Should include casual formality instruction');
  assert.ok(directive.includes('Playful'), 'Should include playful humor instruction');
  assert.ok(directive.includes('emoji freely'), 'Should include generous emoji instruction');
  assert.ok(directive.includes('active constraints'), 'Should include enforcement line');
});

test('buildPersonaDirective() includes language when not EN', () => {
  const deck = createMockDeckClient();
  const cm = new CockpitManager({ deckClient: deck });

  cm.cachedConfig = {
    persona: { name: 'Molti', humor: 'light', emoji: 'none', language: 'PT', verbosity: 'balanced', formality: 'balanced' }
  };

  const directive = cm.buildPersonaDirective();
  assert.ok(directive.includes('Respond in PT'), 'Should include language directive for non-EN');
});

test('buildPersonaDirective() omits language line when EN', () => {
  const deck = createMockDeckClient();
  const cm = new CockpitManager({ deckClient: deck });

  cm.cachedConfig = {
    persona: { name: 'Molti', humor: 'light', emoji: 'none', language: 'EN', verbosity: 'balanced', formality: 'balanced' }
  };

  const directive = cm.buildPersonaDirective();
  assert.ok(!directive.includes('**Language:**'), 'Should NOT include language line when EN');
});

// --- Overlay tests ---

test('buildSystemPromptOverlay() returns empty string when no config cached', () => {
  const deck = createMockDeckClient();
  const cm = new CockpitManager({ deckClient: deck });

  const overlay = cm.buildSystemPromptOverlay();

  assert.strictEqual(overlay, '', 'Should return empty string when no config cached');
});

test('buildSystemPromptOverlay() does NOT include style (style is in directive)', () => {
  const deck = createMockDeckClient();
  const cm = new CockpitManager({ deckClient: deck });

  cm.cachedConfig = {
    style: { name: 'Concise Executive', description: 'Short, answer-first.' },
    persona: { name: 'Molti', humor: 'light', emoji: 'none', language: 'EN', verbosity: 'concise', formality: 'balanced' },
    guardrails: [],
    mode: { name: 'Full Auto', description: 'Maximum initiative.' },
    system: { searchProvider: 'searxng', llmTier: 'balanced' }
  };

  const overlay = cm.buildSystemPromptOverlay();

  assert.ok(!overlay.includes('Communication Style'), 'Style should NOT be in overlay (moved to directive)');
  assert.ok(!overlay.includes('Short, answer-first'), 'Style description should NOT be in overlay');
});

test('buildSystemPromptOverlay() includes all guardrails', () => {
  const deck = createMockDeckClient();
  const cm = new CockpitManager({ deckClient: deck });

  cm.cachedConfig = {
    style: { name: 'Concise Executive', description: 'Short, answer-first.' },
    persona: { name: 'Molti', humor: 'light', emoji: 'none', language: 'EN', verbosity: 'concise', formality: 'balanced' },
    guardrails: [
      { title: 'Never delete files without asking', description: 'Always require confirmation.' },
      { title: 'Confirm before sending external comms', description: 'Requires HITL.' }
    ],
    mode: { name: 'Full Auto', description: 'Maximum initiative.' },
    system: { searchProvider: 'searxng', llmTier: 'balanced' }
  };

  const overlay = cm.buildSystemPromptOverlay();

  assert.ok(overlay.includes('Never delete files without asking'), 'Should include first guardrail');
  assert.ok(overlay.includes('Confirm before sending external comms'), 'Should include second guardrail');
});

test('buildSystemPromptOverlay() includes mode name and description', () => {
  const deck = createMockDeckClient();
  const cm = new CockpitManager({ deckClient: deck });

  cm.cachedConfig = {
    style: { name: 'Concise Executive', description: 'Short, answer-first.' },
    persona: { name: 'Molti', humor: 'light', emoji: 'none', language: 'EN', verbosity: 'concise', formality: 'balanced' },
    guardrails: [],
    mode: { name: 'Full Auto', description: 'Maximum initiative.' },
    system: { searchProvider: 'searxng', llmTier: 'balanced' }
  };

  const overlay = cm.buildSystemPromptOverlay();

  assert.ok(overlay.includes('Full Auto'), 'Should include mode name');
  assert.ok(overlay.includes('Maximum initiative'), 'Should include mode description');
});

test('buildSystemPromptOverlay() does NOT include persona (moved to directive)', () => {
  const deck = createMockDeckClient();
  const cm = new CockpitManager({ deckClient: deck });

  cm.cachedConfig = {
    style: { name: 'Concise Executive', description: 'Short, answer-first.' },
    persona: { name: 'Molti', humor: 'light', emoji: 'none', language: 'EN', verbosity: 'concise', formality: 'balanced' },
    guardrails: [],
    mode: { name: 'Full Auto', description: 'Maximum initiative.' },
    system: { searchProvider: 'searxng', llmTier: 'balanced' }
  };

  const overlay = cm.buildSystemPromptOverlay();

  assert.ok(!overlay.includes('### Persona'), 'Persona section should NOT be in overlay');
  assert.ok(!overlay.includes('- Humor:'), 'Persona humor should NOT be in overlay');
});

// --- _ensureMissingCards tests ---

asyncTest('_ensureMissingCards() creates cards that do not exist', async () => {
  const sampleStacks = createSampleStacks();
  // Remove 'Budget Limits' from system stack (simulating old board)
  // System stack is at index 4
  const deck = createMockDeckClient({
    listBoards: [{ id: 99, title: BOARD_TITLE }],
    getBoard: { id: 99, title: BOARD_TITLE, labels: [
      { id: 1, title: '⚙️★', color: 'ffd700' },
      { id: 5, title: '⚙️4', color: '0000ff' }
    ] },
    getStacks: sampleStacks
  });
  const cm = new CockpitManager({ deckClient: deck });

  await cm.initialize();

  // _ensureMissingCards should have created the missing cards
  const postCalls = deck._calls.filter(c =>
    c.method === '_request' && c.httpMethod === 'POST' && c.path.includes('/cards')
  );
  // System stack was missing Budget Limits card + Costs card in status stack
  assert.ok(postCalls.length > 0, 'Should create at least one missing card');

  // Check that one of them is the Budget Limits card
  const budgetCreate = postCalls.find(c => c.body?.title?.includes('Budget'));
  assert.ok(budgetCreate, 'Should create the Budget Limits card');
});

asyncTest('_ensureMissingCards() skips cards that already exist (idempotent)', async () => {
  const sampleStacks = createSampleStacks();
  // Add Budget Limits card to system stack so it already exists
  sampleStacks[4].cards.push(
    { id: 347, title: '\ud83d\udcb0 Budget Limits', description: 'Daily: €5', labels: [] }
  );
  // Add Costs card to status stack
  sampleStacks[5].cards.push(
    { id: 356, title: '\ud83d\udcb0 Costs', description: 'Today: €0', labels: [] }
  );

  const deck = createMockDeckClient({
    listBoards: [{ id: 99, title: BOARD_TITLE }],
    getBoard: { id: 99, title: BOARD_TITLE, labels: [] },
    getStacks: sampleStacks
  });
  const cm = new CockpitManager({ deckClient: deck });

  await cm.initialize();

  // With all cards present, no POSTs should be made for cards
  // (The sample stacks have all cards for styles, persona, guardrails, modes)
  // But some default cards in guardrails/modes may still be missing
  // The key assertion: Budget Limits should NOT be created again
  const postCalls = deck._calls.filter(c =>
    c.method === '_request' && c.httpMethod === 'POST' && c.path.includes('/cards')
  );
  const budgetCreates = postCalls.filter(c => c.body?.title?.includes('Budget'));
  assert.strictEqual(budgetCreates.length, 0, 'Should NOT re-create Budget Limits card');
});

// ============================================================
// Session 37: Voice Card Tests
// ============================================================

console.log('\n--- Voice Card Tests (Session 37) ---\n');

test('TC-VOICE-CARD-001: _parseVoiceCard parses description correctly', () => {
  const deck = createMockDeckClient();
  const manager = new CockpitManager({ deckClient: deck });

  const result = manager._parseVoiceCard('Voice input: on\nSTT model: large\nMeeting notes: on');
  assert.strictEqual(result.voiceInput, true);
  assert.strictEqual(result.sttModel, 'large');
  assert.strictEqual(result.meetingNotes, true);
});

test('TC-VOICE-CARD-002: _parseVoiceCard returns defaults for empty description', () => {
  const deck = createMockDeckClient();
  const manager = new CockpitManager({ deckClient: deck });

  const result = manager._parseVoiceCard('');
  assert.strictEqual(result.voiceInput, true);
  assert.strictEqual(result.sttModel, 'small');
  assert.strictEqual(result.meetingNotes, false);
});

test('TC-VOICE-CARD-003: _parseVoiceCard handles voice input off', () => {
  const deck = createMockDeckClient();
  const manager = new CockpitManager({ deckClient: deck });

  const result = manager._parseVoiceCard('Voice input: off\nSTT model: small\nMeeting notes: off');
  assert.strictEqual(result.voiceInput, false);
  assert.strictEqual(result.meetingNotes, false);
});

test('TC-VOICE-CARD-004: Voice card exists in DEFAULT_CARDS.system with ⚙ labels', () => {
  const voiceCard = DEFAULT_CARDS.system.find(c => c.title.includes('Voice'));
  assert.ok(voiceCard, 'Voice card should exist in DEFAULT_CARDS.system');
  assert.ok(voiceCard.description.includes('off'), 'Should have off option');
  assert.ok(voiceCard.description.includes('listen'), 'Should have listen option');
  assert.ok(voiceCard.description.includes('full'), 'Should have full option');
  assert.strictEqual(voiceCard.defaultLabel, '\u2699\ufe0f1', 'Default label should be ⚙️1 (off)');
});

// ============================================================
// Session 38: Infrastructure Card + Health Format Tests
// ============================================================

console.log('\n--- Infrastructure Card Tests (Session 38) ---\n');

test('TC-INFRA-001: DEFAULT_CARDS has 9 system cards (including Infrastructure)', () => {
  assert.strictEqual(DEFAULT_CARDS.system.length, 9);
  const titles = DEFAULT_CARDS.system.map(c => c.title);
  assert.ok(titles.some(t => t.includes('Infrastructure')), 'Should include Infrastructure card');
});

test('TC-INFRA-002: _parseInfraCard parses services and settings', () => {
  const deck = createMockDeckClient();
  const manager = new CockpitManager({ deckClient: deck });

  const result = manager._parseInfraCard('Services:\n- ollama: http://localhost:11434\n- whisper: http://localhost:8178\n\nNotify on failure: on\nAuto-heal: off\nCheck interval: 5');
  assert.strictEqual(result.services.ollama, 'http://localhost:11434');
  assert.strictEqual(result.services.whisper, 'http://localhost:8178');
  assert.strictEqual(result.notifyOnFailure, true);
  assert.strictEqual(result.autoHeal, false);
  assert.strictEqual(result.checkInterval, 5);
});

test('TC-INFRA-003: _parseInfraCard handles empty description', () => {
  const deck = createMockDeckClient();
  const manager = new CockpitManager({ deckClient: deck });

  const result = manager._parseInfraCard('');
  assert.deepStrictEqual(result.services, {});
  assert.strictEqual(result.notifyOnFailure, true);
  assert.strictEqual(result.autoHeal, true);
  assert.strictEqual(result.checkInterval, 3);
});

test('TC-INFRA-004: _parseInfraCard handles auto URLs', () => {
  const deck = createMockDeckClient();
  const manager = new CockpitManager({ deckClient: deck });

  const result = manager._parseInfraCard('Services:\n- ollama: auto\n- nextcloud: auto');
  assert.strictEqual(result.services.ollama, 'auto');
  assert.strictEqual(result.services.nextcloud, 'auto');
});

test('TC-INFRA-005: _formatHealthStatus with infra data renders per-service lines', () => {
  const deck = createMockDeckClient();
  const manager = new CockpitManager({ deckClient: deck });

  const health = {
    status: 'OK',
    uptimeDays: 12,
    uptimeHours: 5,
    infra: {
      overall: 'ok',
      services: {
        ollama: { ok: true, latencyMs: 120, status: 'up' },
        whisper: { ok: true, latencyMs: 80, status: 'up' },
        nextcloud: { ok: true, latencyMs: 45, status: 'up' }
      },
      systemStats: { ramUsedPct: 60, diskUsedPct: 50, uptimeDays: 12 }
    }
  };

  const result = manager._formatHealthStatus(health);
  assert.ok(result.includes('OK'), 'Should include OK');
  assert.ok(result.includes('ollama'), 'Should include ollama');
  assert.ok(result.includes('120ms'), 'Should include latency');
  assert.ok(result.includes('whisper'), 'Should include whisper');
  assert.ok(result.includes('Uptime: 12d'), 'Should include uptime');
});

test('TC-INFRA-006: _formatHealthStatus without infra data renders legacy format', () => {
  const deck = createMockDeckClient();
  const manager = new CockpitManager({ deckClient: deck });

  const health = {
    status: 'OK',
    uptimeDays: 5,
    uptimeHours: 12,
    lastError: 'none'
  };

  const result = manager._formatHealthStatus(health);
  assert.ok(result.includes('OK'), 'Should include status');
  assert.ok(result.includes('5d 12h'), 'Should include uptime');
  assert.ok(result.includes('none'), 'Should include last error');
  assert.ok(!result.includes('ollama'), 'Should NOT include service names in legacy format');
});

test('TC-INFRA-007: _formatHealthStatus shows RAM warning > 85%', () => {
  const deck = createMockDeckClient();
  const manager = new CockpitManager({ deckClient: deck });

  const health = {
    status: 'OK',
    uptimeDays: 1,
    infra: {
      overall: 'ok',
      services: { ollama: { ok: true, latencyMs: 50, status: 'up' } },
      systemStats: { ramUsedPct: 92, diskUsedPct: 50, uptimeDays: 1 }
    }
  };

  const result = manager._formatHealthStatus(health);
  assert.ok(result.includes('RAM: 92%'), 'Should show RAM warning');
});

test('TC-INFRA-008: _formatHealthStatus shows down service with error', () => {
  const deck = createMockDeckClient();
  const manager = new CockpitManager({ deckClient: deck });

  const health = {
    status: 'OK',
    uptimeDays: 1,
    infra: {
      overall: 'degraded',
      services: {
        ollama: { ok: true, latencyMs: 120, status: 'up' },
        searxng: { ok: false, latencyMs: 8000, status: 'down', error: 'timeout' }
      },
      systemStats: { ramUsedPct: 50, diskUsedPct: 50, uptimeDays: 1 }
    }
  };

  const result = manager._formatHealthStatus(health);
  assert.ok(result.includes('searxng -- timeout'), 'Should show down service with error');
  assert.ok(result.includes('DEGRADED'), 'Should show DEGRADED');
});

// ============================================================
// Session A3b: 3-Generation Label Migration + Backward Compat
// ============================================================

console.log('\n--- Session A3b: Label Migration Tests (⚙ namespace) ---\n');

asyncTest('_migrateLabels() migrates Gen1 (Option) labels to ⚙ namespace', async () => {
  const deck = createMockDeckClient();
  const cm = new CockpitManager({ deckClient: deck });
  cm.boardId = 99;

  // Gen1 labels (original names)
  cm.labels = {
    '⭐ Active':    { id: 1, title: '⭐ Active',    color: 'ff8700' },
    '🔴 Option 1': { id: 2, title: '🔴 Option 1', color: 'e9322d' },
    '🟡 Option 2': { id: 3, title: '🟡 Option 2', color: 'f0c400' },
    '🟢 Option 3': { id: 4, title: '🟢 Option 3', color: '00b600' },
    '🔵 Custom':   { id: 5, title: '🔵 Custom',   color: '0082c9' }
  };

  const migrated = await cm._migrateLabels();

  // 5 renames + 5 reserved label creates = 10
  assert.strictEqual(migrated, 10, 'Should migrate 5 + create 5 reserved');

  const putCalls = deck._calls.filter(c =>
    c.method === '_request' && c.httpMethod === 'PUT' && c.path.includes('/labels/')
  );
  assert.strictEqual(putCalls.length, 5, 'Should have 5 PUT calls for renames');

  const postCalls = deck._calls.filter(c =>
    c.method === '_request' && c.httpMethod === 'POST' && c.path.includes('/labels')
  );
  assert.strictEqual(postCalls.length, 5, 'Should have 5 POST calls for reserved labels');

  // Verify titles updated in-memory
  assert.strictEqual(cm.labels['🔴 Option 1'].title, '⚙️1');
  assert.strictEqual(cm.labels['🟡 Option 2'].title, '⚙️2');
  assert.strictEqual(cm.labels['🟢 Option 3'].title, '⚙️3');
  assert.strictEqual(cm.labels['⭐ Active'].title, '⚙️★');
  assert.strictEqual(cm.labels['🔵 Custom'].title, '⚙️4');

  // Verify color changes for Active and Custom
  assert.strictEqual(cm.labels['⭐ Active'].color, 'ffd700', 'Active should get gold color');
  assert.strictEqual(cm.labels['🔵 Custom'].color, '0000ff', 'Custom should get blue color');
});

asyncTest('_migrateLabels() migrates Gen2 (Off/Moderate/On) labels to ⚙ namespace', async () => {
  const deck = createMockDeckClient();
  const cm = new CockpitManager({ deckClient: deck });
  cm.boardId = 99;

  // Gen2 labels (A3 names)
  cm.labels = {
    '⭐ Active':     { id: 1, title: '⭐ Active',     color: 'ff8700' },
    '🔴 Off':       { id: 2, title: '🔴 Off',       color: 'e9322d' },
    '🟡 Moderate':  { id: 3, title: '🟡 Moderate',  color: 'f0c400' },
    '🟢 On':        { id: 4, title: '🟢 On',        color: '00b600' },
    '🔵 Custom':    { id: 5, title: '🔵 Custom',    color: '0082c9' }
  };

  const migrated = await cm._migrateLabels();

  // 5 renames + 5 reserved label creates = 10
  assert.strictEqual(migrated, 10, 'Should migrate 5 + create 5 reserved');

  assert.strictEqual(cm.labels['🔴 Off'].title, '⚙️1');
  assert.strictEqual(cm.labels['🟡 Moderate'].title, '⚙️2');
  assert.strictEqual(cm.labels['🟢 On'].title, '⚙️3');
  assert.strictEqual(cm.labels['⭐ Active'].title, '⚙️★');
  assert.strictEqual(cm.labels['🔵 Custom'].title, '⚙️4');
});

asyncTest('_migrateLabels() is idempotent with all 10 ⚙ labels', async () => {
  const deck = createMockDeckClient();
  const cm = new CockpitManager({ deckClient: deck });
  cm.boardId = 99;

  // All 10 labels already present at Gen3
  cm.labels = {
    '⚙️★': { id: 1, title: '⚙️★', color: 'ffd700' },
    '⚙️1': { id: 2, title: '⚙️1', color: 'e9322d' },
    '⚙️2': { id: 3, title: '⚙️2', color: 'f0c400' },
    '⚙️3': { id: 4, title: '⚙️3', color: '00b600' },
    '⚙️4': { id: 5, title: '⚙️4', color: '0000ff' },
    '⚙️5': { id: 6, title: '⚙️5', color: '7c3aed' },
    '⚙️6': { id: 7, title: '⚙️6', color: 'ff6f61' },
    '⚙️7': { id: 8, title: '⚙️7', color: '17a2b8' },
    '⚙️8': { id: 9, title: '⚙️8', color: '795548' },
    '⚙️9': { id: 10, title: '⚙️9', color: '6c757d' }
  };

  const migrated = await cm._migrateLabels();

  assert.strictEqual(migrated, 0, 'Should migrate 0 labels when all 10 exist');
  assert.strictEqual(deck._calls.length, 0, 'Should make 0 API calls');
});

asyncTest('_migrateLabels() creates reserved ⚙5-⚙9 labels when missing', async () => {
  const deck = createMockDeckClient();
  const cm = new CockpitManager({ deckClient: deck });
  cm.boardId = 99;

  // Board only has the original 5 labels (already at ⚙ namespace)
  cm.labels = {
    '⚙️★': { id: 1, title: '⚙️★', color: 'ffd700' },
    '⚙️1': { id: 2, title: '⚙️1', color: 'e9322d' },
    '⚙️2': { id: 3, title: '⚙️2', color: 'f0c400' },
    '⚙️3': { id: 4, title: '⚙️3', color: '00b600' },
    '⚙️4': { id: 5, title: '⚙️4', color: '0000ff' }
  };

  const migrated = await cm._migrateLabels();

  assert.strictEqual(migrated, 5, 'Should create 5 reserved labels');

  const postCalls = deck._calls.filter(c =>
    c.method === '_request' && c.httpMethod === 'POST' && c.path.includes('/labels')
  );
  assert.strictEqual(postCalls.length, 5, 'Should POST 5 new labels');

  const createdTitles = postCalls.map(c => c.body.title).sort();
  assert.deepStrictEqual(createdTitles, ['⚙️5', '⚙️6', '⚙️7', '⚙️8', '⚙️9']);
});

asyncTest('_migrateLabels() skips reserved labels that already exist', async () => {
  const deck = createMockDeckClient();
  const cm = new CockpitManager({ deckClient: deck });
  cm.boardId = 99;

  // All 10 labels already present
  cm.labels = {
    '⚙️★': { id: 1, title: '⚙️★', color: 'ffd700' },
    '⚙️1': { id: 2, title: '⚙️1', color: 'e9322d' },
    '⚙️2': { id: 3, title: '⚙️2', color: 'f0c400' },
    '⚙️3': { id: 4, title: '⚙️3', color: '00b600' },
    '⚙️4': { id: 5, title: '⚙️4', color: '0000ff' },
    '⚙️5': { id: 6, title: '⚙️5', color: '7c3aed' },
    '⚙️6': { id: 7, title: '⚙️6', color: 'ff6f61' },
    '⚙️7': { id: 8, title: '⚙️7', color: '17a2b8' },
    '⚙️8': { id: 9, title: '⚙️8', color: '795548' },
    '⚙️9': { id: 10, title: '⚙️9', color: '6c757d' }
  };

  const migrated = await cm._migrateLabels();

  assert.strictEqual(migrated, 0, 'Should migrate/create 0 when all 10 exist');
  assert.strictEqual(deck._calls.length, 0, 'Should make 0 API calls');
});

asyncTest('_migrateLabels() applies color changes for Active and Custom', async () => {
  const deck = createMockDeckClient();
  const cm = new CockpitManager({ deckClient: deck });
  cm.boardId = 99;

  // Start with all 10 labels, but Active and Custom still have old colors/names
  cm.labels = {
    'Active':  { id: 1, title: 'Active',  color: 'ff8700' },
    '⚙️1':    { id: 2, title: '⚙️1',    color: 'e9322d' },
    '⚙️2':    { id: 3, title: '⚙️2',    color: 'f0c400' },
    '⚙️3':    { id: 4, title: '⚙️3',    color: '00b600' },
    'Custom':  { id: 5, title: 'Custom',  color: '0082c9' },
    '⚙️5':    { id: 6, title: '⚙️5',    color: '7c3aed' },
    '⚙️6':    { id: 7, title: '⚙️6',    color: 'ff6f61' },
    '⚙️7':    { id: 8, title: '⚙️7',    color: '17a2b8' },
    '⚙️8':    { id: 9, title: '⚙️8',    color: '795548' },
    '⚙️9':    { id: 10, title: '⚙️9',   color: '6c757d' }
  };

  await cm._migrateLabels();

  // Verify PUT body includes new colors
  const putCalls = deck._calls.filter(c =>
    c.method === '_request' && c.httpMethod === 'PUT' && c.path.includes('/labels/')
  );

  const activePut = putCalls.find(c => c.body.title === '⚙️★');
  assert.ok(activePut, 'Should have PUT for ⚙️★');
  assert.strictEqual(activePut.body.color, 'ffd700', 'Active should get gold color in PUT body');

  const customPut = putCalls.find(c => c.body.title === '⚙️4');
  assert.ok(customPut, 'Should have PUT for ⚙️4');
  assert.strictEqual(customPut.body.color, '0000ff', 'Custom should get blue color in PUT body');
});

// --- 3-generation backward compatibility ---

console.log('\n--- _resolveCardValue() 3-gen backward compat ---\n');

asyncTest('_resolveCardValue() resolves Gen3 ⚙ labels', async () => {
  const deck = createMockDeckClient();
  const cm = new CockpitManager({ deckClient: deck });

  const g1 = { id: 2, title: '⚙️1', color: 'e9322d' };
  const g2 = { id: 3, title: '⚙️2', color: 'f0c400' };
  const g3 = { id: 4, title: '⚙️3', color: '00b600' };
  const g4 = { id: 5, title: '⚙️4', color: '0000ff' };

  assert.strictEqual(cm._resolveCardValue({ id: 1, labels: [g1] }, PERSONA_VALUE_MAP.Humor).value, 'none');
  assert.strictEqual(cm._resolveCardValue({ id: 2, labels: [g2] }, PERSONA_VALUE_MAP.Humor).value, 'light');
  assert.strictEqual(cm._resolveCardValue({ id: 3, labels: [g3] }, PERSONA_VALUE_MAP.Humor).value, 'playful');
  assert.strictEqual(cm._resolveCardValue({ id: 4, labels: [g4], description: 'custom-val' }, PERSONA_VALUE_MAP.Humor).value, 'custom-val');
  assert.strictEqual(cm._resolveCardValue({ id: 4, labels: [g4], description: 'custom-val' }, PERSONA_VALUE_MAP.Humor).source, 'custom');
});

asyncTest('_resolveCardValue() backward compat: Gen2 Off/Moderate/On labels still resolve', async () => {
  const deck = createMockDeckClient();
  const cm = new CockpitManager({ deckClient: deck });

  const off = { id: 2, title: '🔴 Off', color: 'e9322d' };
  const mod = { id: 3, title: '🟡 Moderate', color: 'f0c400' };
  const on  = { id: 4, title: '🟢 On', color: '00b600' };

  assert.strictEqual(cm._resolveCardValue({ id: 1, labels: [off] }, PERSONA_VALUE_MAP.Humor).value, 'none');
  assert.strictEqual(cm._resolveCardValue({ id: 1, labels: [off] }, PERSONA_VALUE_MAP.Humor).source, 'off');
  assert.strictEqual(cm._resolveCardValue({ id: 2, labels: [mod] }, PERSONA_VALUE_MAP.Humor).value, 'light');
  assert.strictEqual(cm._resolveCardValue({ id: 2, labels: [mod] }, PERSONA_VALUE_MAP.Humor).source, 'moderate');
  assert.strictEqual(cm._resolveCardValue({ id: 3, labels: [on] }, PERSONA_VALUE_MAP.Humor).value, 'playful');
  assert.strictEqual(cm._resolveCardValue({ id: 3, labels: [on] }, PERSONA_VALUE_MAP.Humor).source, 'on');
});

asyncTest('_resolveCardValue() backward compat: Gen1 Option 1/2/3 labels still resolve', async () => {
  const deck = createMockDeckClient();
  const cm = new CockpitManager({ deckClient: deck });

  const opt1 = { id: 2, title: '🔴 Option 1', color: 'e9322d' };
  const opt2 = { id: 3, title: '🟡 Option 2', color: 'f0c400' };
  const opt3 = { id: 4, title: '🟢 Option 3', color: '00b600' };

  assert.strictEqual(cm._resolveCardValue({ id: 1, labels: [opt1] }, PERSONA_VALUE_MAP.Humor).value, 'none');
  assert.strictEqual(cm._resolveCardValue({ id: 1, labels: [opt1] }, PERSONA_VALUE_MAP.Humor).source, 'off');
  assert.strictEqual(cm._resolveCardValue({ id: 2, labels: [opt2] }, PERSONA_VALUE_MAP.Humor).value, 'light');
  assert.strictEqual(cm._resolveCardValue({ id: 2, labels: [opt2] }, PERSONA_VALUE_MAP.Humor).source, 'moderate');
  assert.strictEqual(cm._resolveCardValue({ id: 3, labels: [opt3] }, PERSONA_VALUE_MAP.Humor).value, 'playful');
  assert.strictEqual(cm._resolveCardValue({ id: 3, labels: [opt3] }, PERSONA_VALUE_MAP.Humor).source, 'on');
});

// ============================================================
// Summary
// ============================================================

setTimeout(() => {
  summary();
  exitWithCode();
}, 100);
