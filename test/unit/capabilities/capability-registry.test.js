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
 * CapabilityRegistry Unit Tests
 *
 * Architecture Brief:
 * -------------------
 * Problem: Verify that CapabilityRegistry correctly registers capabilities
 * across all categories, tracks provider statuses, supports search/query,
 * handles idempotent initialization, and serializes to JSON.
 *
 * Pattern: Direct unit testing of the registry class. No mocks needed --
 * CapabilityRegistry is a leaf module with no dependencies.
 *
 * Run: node test/unit/capabilities/capability-registry.test.js
 *
 * @module test/unit/capabilities/capability-registry
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

// Import module under test
const { CapabilityRegistry } = require('../../../src/lib/capabilities/capability-registry');

// ============================================================
// Tests: Constructor
// ============================================================

console.log('');
console.log('=== CapabilityRegistry Tests ===');
console.log('');

test('constructor creates empty registry', () => {
  const registry = new CapabilityRegistry();

  assert.strictEqual(registry._initialized, false);
  assert.strictEqual(registry._capabilities.size, 0);
  assert.strictEqual(registry._providerStatuses.size, 0);
  assert.strictEqual(registry._commandHandlers.size, 0);
});

// ============================================================
// Tests: initialize()
// ============================================================

test('initialize registers built-in capabilities', () => {
  const registry = new CapabilityRegistry();
  registry.initialize();

  // Should register 2 core + 4 commands = 6 total
  assert.strictEqual(registry._capabilities.size, 6);
  assert.strictEqual(registry._initialized, true);

  // Check core capabilities
  assert.ok(registry.hasCapability('conversation'));
  assert.ok(registry.hasCapability('research'));

  // Check commands
  assert.ok(registry.hasCapability('/help'));
  assert.ok(registry.hasCapability('/status'));
  assert.ok(registry.hasCapability('/capabilities'));
  assert.ok(registry.hasCapability('/health'));
});

test('initialize is idempotent', () => {
  const registry = new CapabilityRegistry();
  registry.initialize();
  registry.initialize();
  registry.initialize();

  // Should still have exactly 6, not 18
  assert.strictEqual(registry._capabilities.size, 6);
});

test('core capabilities have correct category', () => {
  const registry = new CapabilityRegistry();
  registry.initialize();

  const conversation = registry.getCapability('conversation');
  assert.strictEqual(conversation.category, 'core');
  assert.strictEqual(conversation.enabled, true);
  assert.ok(conversation.description.length > 0);

  const research = registry.getCapability('research');
  assert.strictEqual(research.category, 'core');
});

test('command capabilities have correct category', () => {
  const registry = new CapabilityRegistry();
  registry.initialize();

  const help = registry.getCapability('/help');
  assert.strictEqual(help.category, 'command');
  assert.strictEqual(help.enabled, true);
});

// ============================================================
// Tests: registerCore()
// ============================================================

test('registerCore adds core capability', () => {
  const registry = new CapabilityRegistry();
  const cap = registry.registerCore({
    name: 'test-core',
    description: 'A test core capability'
  });

  assert.strictEqual(cap.name, 'test-core');
  assert.strictEqual(cap.category, 'core');
  assert.strictEqual(cap.enabled, true);
  assert.deepStrictEqual(cap.metadata, {});
  assert.ok(registry.hasCapability('test-core'));
});

test('registerCore accepts metadata', () => {
  const registry = new CapabilityRegistry();
  const cap = registry.registerCore({
    name: 'versioned',
    description: 'With metadata',
    metadata: { version: '1.0.0' }
  });

  assert.strictEqual(cap.metadata.version, '1.0.0');
});

// ============================================================
// Tests: registerIntegration()
// ============================================================

test('registerIntegration adds integration capability', () => {
  const registry = new CapabilityRegistry();
  const cap = registry.registerIntegration({
    name: 'deck',
    description: 'Nextcloud Deck task management'
  });

  assert.strictEqual(cap.category, 'integration');
  assert.strictEqual(cap.enabled, true);
  assert.ok(registry.hasCapability('deck'));
});

test('registerIntegration respects enabled flag', () => {
  const registry = new CapabilityRegistry();
  const cap = registry.registerIntegration({
    name: 'deck',
    description: 'Deck integration',
    enabled: false
  });

  assert.strictEqual(cap.enabled, false);
});

test('registerIntegration defaults enabled to true', () => {
  const registry = new CapabilityRegistry();
  const cap = registry.registerIntegration({
    name: 'calendar',
    description: 'Calendar integration'
  });

  assert.strictEqual(cap.enabled, true);
});

// ============================================================
// Tests: registerSkill()
// ============================================================

test('registerSkill adds skill capability', () => {
  const registry = new CapabilityRegistry();
  const cap = registry.registerSkill({
    name: 'summarize',
    description: 'Text summarization'
  });

  assert.strictEqual(cap.category, 'skill');
  assert.strictEqual(cap.enabled, true);
  assert.ok(registry.hasCapability('summarize'));
});

// ============================================================
// Tests: registerCommand()
// ============================================================

test('registerCommand adds command capability', () => {
  const registry = new CapabilityRegistry();
  const cap = registry.registerCommand({
    name: '/test',
    description: 'A test command'
  });

  assert.strictEqual(cap.category, 'command');
  assert.ok(registry.hasCapability('/test'));
});

test('registerCommand stores handler function', () => {
  const registry = new CapabilityRegistry();
  const handler = async (args) => `result: ${args}`;

  registry.registerCommand({
    name: '/custom',
    description: 'Custom command',
    handler
  });

  const retrieved = registry.getCommandHandler('/custom');
  assert.strictEqual(typeof retrieved, 'function');
});

test('registerCommand without handler does not store handler', () => {
  const registry = new CapabilityRegistry();
  registry.registerCommand({
    name: '/nohandler',
    description: 'No handler'
  });

  const retrieved = registry.getCommandHandler('/nohandler');
  assert.strictEqual(retrieved, null);
});

// ============================================================
// Tests: setProviderStatus()
// ============================================================

test('setProviderStatus stores provider status', () => {
  const registry = new CapabilityRegistry();
  registry.setProviderStatus('ollama', 'online', 'Models loaded');

  const statuses = registry.getProviderStatuses();
  assert.strictEqual(statuses.length, 1);
  assert.strictEqual(statuses[0].name, 'ollama');
  assert.strictEqual(statuses[0].status, 'online');
  assert.strictEqual(statuses[0].message, 'Models loaded');
  assert.ok(statuses[0].lastChecked > 0);
});

test('setProviderStatus updates existing provider', () => {
  const registry = new CapabilityRegistry();
  registry.setProviderStatus('ollama', 'online');
  registry.setProviderStatus('ollama', 'offline', 'Connection refused');

  const statuses = registry.getProviderStatuses();
  assert.strictEqual(statuses.length, 1);
  assert.strictEqual(statuses[0].status, 'offline');
  assert.strictEqual(statuses[0].message, 'Connection refused');
});

test('setProviderStatus defaults message to empty string', () => {
  const registry = new CapabilityRegistry();
  registry.setProviderStatus('nextcloud', 'online');

  const statuses = registry.getProviderStatuses();
  assert.strictEqual(statuses[0].message, '');
});

// ============================================================
// Tests: setIntegrationStatus()
// ============================================================

test('setIntegrationStatus updates enabled flag', () => {
  const registry = new CapabilityRegistry();
  registry.registerIntegration({ name: 'deck', description: 'Deck' });

  const result = registry.setIntegrationStatus('deck', false);
  assert.strictEqual(result, true);

  const cap = registry.getCapability('deck');
  assert.strictEqual(cap.enabled, false);
});

test('setIntegrationStatus returns false for non-integration', () => {
  const registry = new CapabilityRegistry();
  registry.registerCore({ name: 'conversation', description: 'Chat' });

  const result = registry.setIntegrationStatus('conversation', false);
  assert.strictEqual(result, false);
});

test('setIntegrationStatus returns false for unknown capability', () => {
  const registry = new CapabilityRegistry();

  const result = registry.setIntegrationStatus('nonexistent', true);
  assert.strictEqual(result, false);
});

// ============================================================
// Tests: getAllCapabilities()
// ============================================================

test('getAllCapabilities returns all capabilities', () => {
  const registry = new CapabilityRegistry();
  registry.initialize();
  registry.registerIntegration({ name: 'deck', description: 'Deck' });

  const all = registry.getAllCapabilities();
  assert.strictEqual(all.length, 7); // 2 core + 4 commands + 1 integration
});

test('getAllCapabilities filters by category', () => {
  const registry = new CapabilityRegistry();
  registry.initialize();
  registry.registerIntegration({ name: 'deck', description: 'Deck' });

  const core = registry.getAllCapabilities('core');
  assert.strictEqual(core.length, 2);
  assert.ok(core.every(c => c.category === 'core'));

  const commands = registry.getAllCapabilities('command');
  assert.strictEqual(commands.length, 4);

  const integrations = registry.getAllCapabilities('integration');
  assert.strictEqual(integrations.length, 1);
});

test('getAllCapabilities returns empty array for empty category', () => {
  const registry = new CapabilityRegistry();
  registry.initialize();

  const skills = registry.getAllCapabilities('skill');
  assert.deepStrictEqual(skills, []);
});

// ============================================================
// Tests: search()
// ============================================================

test('search finds by name', () => {
  const registry = new CapabilityRegistry();
  registry.initialize();

  const results = registry.search('conversation');
  assert.ok(results.length >= 1);
  assert.ok(results.some(c => c.name === 'conversation'));
});

test('search finds by description', () => {
  const registry = new CapabilityRegistry();
  registry.registerIntegration({ name: 'deck', description: 'Task management via Nextcloud Deck' });

  const results = registry.search('task management');
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].name, 'deck');
});

test('search is case-insensitive', () => {
  const registry = new CapabilityRegistry();
  registry.initialize();

  const results = registry.search('CONVERSATION');
  assert.ok(results.length >= 1);
});

test('search returns empty array for no matches', () => {
  const registry = new CapabilityRegistry();
  registry.initialize();

  const results = registry.search('xyznonexistent');
  assert.deepStrictEqual(results, []);
});

// ============================================================
// Tests: getCommand()
// ============================================================

test('getCommand returns command by name', () => {
  const registry = new CapabilityRegistry();
  registry.initialize();

  const cmd = registry.getCommand('/help');
  assert.ok(cmd);
  assert.strictEqual(cmd.name, '/help');
  assert.strictEqual(cmd.category, 'command');
});

test('getCommand returns null for non-command', () => {
  const registry = new CapabilityRegistry();
  registry.initialize();

  const result = registry.getCommand('conversation');
  assert.strictEqual(result, null);
});

test('getCommand returns null for unknown command', () => {
  const registry = new CapabilityRegistry();

  const result = registry.getCommand('/nonexistent');
  assert.strictEqual(result, null);
});

// ============================================================
// Tests: hasCapability() / getCapability()
// ============================================================

test('hasCapability returns true for existing', () => {
  const registry = new CapabilityRegistry();
  registry.initialize();

  assert.strictEqual(registry.hasCapability('conversation'), true);
});

test('hasCapability returns false for missing', () => {
  const registry = new CapabilityRegistry();

  assert.strictEqual(registry.hasCapability('nonexistent'), false);
});

test('getCapability returns descriptor for existing', () => {
  const registry = new CapabilityRegistry();
  registry.initialize();

  const cap = registry.getCapability('conversation');
  assert.ok(cap);
  assert.strictEqual(cap.name, 'conversation');
});

test('getCapability returns null for missing', () => {
  const registry = new CapabilityRegistry();

  assert.strictEqual(registry.getCapability('missing'), null);
});

// ============================================================
// Tests: toJSON()
// ============================================================

test('toJSON serializes registry state', () => {
  const registry = new CapabilityRegistry();
  registry.initialize();
  registry.registerIntegration({ name: 'deck', description: 'Deck' });
  registry.setProviderStatus('ollama', 'online');

  const json = registry.toJSON();

  assert.ok(json.capabilities);
  assert.ok(json.capabilities.core);
  assert.ok(json.capabilities.command);
  assert.ok(json.capabilities.integration);
  assert.strictEqual(json.capabilities.core.length, 2);
  assert.strictEqual(json.capabilities.command.length, 4);
  assert.strictEqual(json.capabilities.integration.length, 1);

  assert.ok(Array.isArray(json.providers));
  assert.strictEqual(json.providers.length, 1);
  assert.strictEqual(json.providers[0].name, 'ollama');

  assert.strictEqual(json.initialized, true);
  assert.strictEqual(json.totalCapabilities, 7);
});

test('toJSON works on empty registry', () => {
  const registry = new CapabilityRegistry();
  const json = registry.toJSON();

  assert.deepStrictEqual(json.capabilities, {});
  assert.deepStrictEqual(json.providers, []);
  assert.strictEqual(json.initialized, false);
  assert.strictEqual(json.totalCapabilities, 0);
});

// ============================================================
// Summary
// ============================================================

setTimeout(() => {
  summary();
  exitWithCode();
}, 500);
