/**
 * Contacts Tools Unit Tests
 *
 * Tests for contacts_search and contacts_get tools registered via ToolRegistry.
 *
 * Run: node test/unit/agent/contacts-tools.test.js
 *
 * @module test/unit/agent/contacts-tools
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const {
  createMockNCRequestManager,
  createMockCalDAVClient,
  createMockCollectivesClient,
  createMockContactsClient
} = require('../../helpers/mock-factories');

// Import module under test
const { ToolRegistry } = require('../../../src/lib/agent/tool-registry');

// ============================================================
// Tests
// ============================================================

console.log('Contacts Tools Unit Tests');
console.log('=========================\n');

// --- Registration Tests ---

test('contacts_search tool is registered when contactsClient provided', () => {
  const registry = new ToolRegistry({
    contactsClient: createMockContactsClient()
  });
  assert.ok(registry.has('contacts_search'), 'contacts_search should be registered');
});

test('contacts_get tool is registered when contactsClient provided', () => {
  const registry = new ToolRegistry({
    contactsClient: createMockContactsClient()
  });
  assert.ok(registry.has('contacts_get'), 'contacts_get should be registered');
});

test('contacts tools are NOT registered when contactsClient is null', () => {
  const registry = new ToolRegistry({
    contactsClient: null
  });
  assert.ok(!registry.has('contacts_search'), 'contacts_search should NOT be registered');
  assert.ok(!registry.has('contacts_get'), 'contacts_get should NOT be registered');
});

test('contacts tools are NOT registered when contactsClient is undefined', () => {
  const registry = new ToolRegistry({});
  assert.ok(!registry.has('contacts_search'), 'contacts_search should NOT be registered');
  assert.ok(!registry.has('contacts_get'), 'contacts_get should NOT be registered');
});

// --- Tool Definitions ---

test('contacts_search has correct parameter schema', () => {
  const registry = new ToolRegistry({
    contactsClient: createMockContactsClient()
  });

  const defs = registry.getToolDefinitions();
  const searchDef = defs.find(d => d.function.name === 'contacts_search');

  assert.ok(searchDef, 'contacts_search definition should exist');
  assert.strictEqual(searchDef.type, 'function');
  assert.ok(searchDef.function.description.length > 10, 'should have a description');
  assert.deepStrictEqual(searchDef.function.parameters.required, ['query']);
  assert.ok(searchDef.function.parameters.properties.query, 'should have query param');
});

test('contacts_get has correct parameter schema', () => {
  const registry = new ToolRegistry({
    contactsClient: createMockContactsClient()
  });

  const defs = registry.getToolDefinitions();
  const getDef = defs.find(d => d.function.name === 'contacts_get');

  assert.ok(getDef, 'contacts_get definition should exist');
  assert.strictEqual(getDef.type, 'function');
  assert.deepStrictEqual(getDef.function.parameters.required, ['href']);
  assert.ok(getDef.function.parameters.properties.href, 'should have href param');
});

// --- Existing tools still work ---

test('ToolRegistry loads without errors when contactsClient is passed with other clients', () => {
  const registry = new ToolRegistry({
    deckClient: null,
    calDAVClient: createMockCalDAVClient(),
    ncRequestManager: createMockNCRequestManager(),
    collectivesClient: createMockCollectivesClient(),
    contactsClient: createMockContactsClient()
  });

  // Calendar tools should still be registered
  assert.ok(registry.has('calendar_list_events'), 'calendar_list_events should still be registered');
  // Contacts tools should be registered
  assert.ok(registry.has('contacts_search'), 'contacts_search should be registered');
  assert.ok(registry.has('contacts_get'), 'contacts_get should be registered');
});

// ============================================================
// Summary
// ============================================================

setTimeout(() => {
  summary();
  exitWithCode();
}, 100);
