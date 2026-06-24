'use strict';

/**
 * Tests for getCloudWorkflowToolDefinitions searchPolicy gate (Part 3 / #188).
 *
 * Verifies:
 *   - searchPolicy 'research'      → web_search + web_read INCLUDED
 *   - searchPolicy 'internal-first' → web_search + web_read INCLUDED
 *   - searchPolicy 'sovereign'     → web_search + web_read EXCLUDED
 *   - searchPolicy undefined       → web_search + web_read INCLUDED (default = 'research')
 */

const assert = require('assert');
const { test, summary, exitWithCode } = require('../../helpers/test-runner');
const { ToolRegistry } = require('../../../src/lib/agent/tool-registry');

// ---------------------------------------------------------------------------
// Minimal ToolRegistry with stub clients
// ---------------------------------------------------------------------------

/**
 * Build a minimal stub DeckClient so the ToolRegistry can register
 * workflow_deck_* tools alongside the web tools.
 */
function makeStubDeckClient() {
  return {
    baseUrl: 'https://nc.test',
    username: 'moltagent',
    stackNames: { inbox: 'Inbox', done: 'Done' },
    getAllCards: async () => ({}),
    getCardsInStack: async () => [],
    createCard: async (_, c) => ({ id: 1, ...c }),
    moveCard: async () => {},
    ensureBoard: async () => ({ boardId: 1, stacks: {} }),
    listBoards: async () => [],
    getBoard: async (id) => ({ id, title: 'Board', owner: { uid: 'moltagent' }, stacks: [], labels: [] }),
    getStacks: async () => [],
    getCard: async (id) => ({ id, title: 'Card', description: '', duedate: null, type: 'plain', owner: { uid: 'moltagent' }, assignedUsers: [], labels: [] }),
    getComments: async () => [],
    addComment: async () => ({ id: 99 }),
    updateCard: async () => ({}),
    assignLabel: async () => ({}),
    stackHasPausedConfig: () => false
  };
}

/**
 * Build a ToolRegistry with stub deck + web clients so all tested tools
 * are registered.
 */
function makeRegistry() {
  const stubSearxng = { search: async () => ({ results: [] }) };
  const stubWebReader = { read: async () => ({ content: '' }) };
  return new ToolRegistry({
    deckClient: makeStubDeckClient(),
    searxngClient: stubSearxng,
    webReader: stubWebReader
  });
}

const registry = makeRegistry();

function toolNames(toolDefs) {
  return toolDefs.map(t => t.function.name);
}

// ---------------------------------------------------------------------------
// searchPolicy: 'research'
// ---------------------------------------------------------------------------

test("searchPolicy 'research' includes web_search", () => {
  const tools = registry.getCloudWorkflowToolDefinitions('', { searchPolicy: 'research' });
  assert.ok(toolNames(tools).includes('web_search'), `web_search not in ${toolNames(tools).join(', ')}`);
});

test("searchPolicy 'research' includes web_read", () => {
  const tools = registry.getCloudWorkflowToolDefinitions('', { searchPolicy: 'research' });
  assert.ok(toolNames(tools).includes('web_read'), `web_read not in ${toolNames(tools).join(', ')}`);
});

// ---------------------------------------------------------------------------
// searchPolicy: 'internal-first'
// ---------------------------------------------------------------------------

test("searchPolicy 'internal-first' includes web_search", () => {
  const tools = registry.getCloudWorkflowToolDefinitions('', { searchPolicy: 'internal-first' });
  assert.ok(toolNames(tools).includes('web_search'), `web_search not in ${toolNames(tools).join(', ')}`);
});

test("searchPolicy 'internal-first' includes web_read", () => {
  const tools = registry.getCloudWorkflowToolDefinitions('', { searchPolicy: 'internal-first' });
  assert.ok(toolNames(tools).includes('web_read'), `web_read not in ${toolNames(tools).join(', ')}`);
});

// ---------------------------------------------------------------------------
// searchPolicy: 'sovereign'
// ---------------------------------------------------------------------------

test("searchPolicy 'sovereign' excludes web_search", () => {
  const tools = registry.getCloudWorkflowToolDefinitions('', { searchPolicy: 'sovereign' });
  assert.ok(!toolNames(tools).includes('web_search'), `web_search should NOT be in ${toolNames(tools).join(', ')}`);
});

test("searchPolicy 'sovereign' excludes web_read", () => {
  const tools = registry.getCloudWorkflowToolDefinitions('', { searchPolicy: 'sovereign' });
  assert.ok(!toolNames(tools).includes('web_read'), `web_read should NOT be in ${toolNames(tools).join(', ')}`);
});

// ---------------------------------------------------------------------------
// searchPolicy: undefined (default = 'research')
// ---------------------------------------------------------------------------

test('searchPolicy undefined (default) includes web_search', () => {
  const tools = registry.getCloudWorkflowToolDefinitions('');
  assert.ok(toolNames(tools).includes('web_search'), `web_search not in default tools: ${toolNames(tools).join(', ')}`);
});

test('searchPolicy undefined (default) includes web_read', () => {
  const tools = registry.getCloudWorkflowToolDefinitions('');
  assert.ok(toolNames(tools).includes('web_read'), `web_read not in default tools: ${toolNames(tools).join(', ')}`);
});

// ---------------------------------------------------------------------------
// Web tool count difference: sovereign has 2 fewer tools than research
// ---------------------------------------------------------------------------

test('sovereign policy results in 2 fewer tools than research (web_search + web_read excluded)', () => {
  const sovereign = registry.getCloudWorkflowToolDefinitions('', { searchPolicy: 'sovereign' });
  const research  = registry.getCloudWorkflowToolDefinitions('', { searchPolicy: 'research' });
  // research has web_search + web_read that sovereign does not
  assert.strictEqual(research.length - sovereign.length, 2,
    `Expected exactly 2 more tools in research vs sovereign (got research=${research.length}, sovereign=${sovereign.length})`);
});

test('searchPolicy changes do not add or remove any non-web tools', () => {
  const sovereign     = new Set(toolNames(registry.getCloudWorkflowToolDefinitions('', { searchPolicy: 'sovereign' })));
  const research      = new Set(toolNames(registry.getCloudWorkflowToolDefinitions('', { searchPolicy: 'research' })));
  // Non-web tools in sovereign should also be in research (research is a superset)
  for (const name of sovereign) {
    assert.ok(research.has(name), `Tool ${name} present in sovereign but missing in research`);
  }
  // The extras in research should ONLY be the web tools
  const extras = [...research].filter(n => !sovereign.has(n)).sort();
  assert.deepStrictEqual(extras, ['web_read', 'web_search']);
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
