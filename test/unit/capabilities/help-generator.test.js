/*
 * MoltAgent - Sovereign AI Security Layer
 * Copyright (C) 2026 MoltAgent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * HelpGenerator Unit Tests
 *
 * Architecture Brief:
 * -------------------
 * Problem: Verify that HelpGenerator correctly reads from CapabilityRegistry
 * and produces well-formatted help text for main help, topic help, capability
 * help, command help, and summaries.
 *
 * Pattern: Uses a real CapabilityRegistry (lightweight, no I/O) populated
 * with test data. Verifies output format and content inclusion.
 *
 * Run: node test/unit/capabilities/help-generator.test.js
 *
 * @module test/unit/capabilities/help-generator
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

// Import modules under test
const { CapabilityRegistry } = require('../../../src/lib/capabilities/capability-registry');
const { HelpGenerator } = require('../../../src/lib/capabilities/help-generator');

// ============================================================
// Test Helpers
// ============================================================

/**
 * Create a populated registry for testing.
 * @returns {CapabilityRegistry}
 */
function createTestRegistry() {
  const registry = new CapabilityRegistry();
  registry.initialize();
  registry.registerIntegration({
    name: 'deck',
    description: 'Nextcloud Deck task management'
  });
  registry.registerIntegration({
    name: 'calendar',
    description: 'CalDAV calendar integration',
    enabled: true
  });
  registry.registerIntegration({
    name: 'email',
    description: 'Email via IMAP/SMTP',
    enabled: false
  });
  registry.registerSkill({
    name: 'summarize',
    description: 'Text summarization'
  });
  return registry;
}

// ============================================================
// Tests: Constructor
// ============================================================

console.log('');
console.log('=== HelpGenerator Tests ===');
console.log('');

test('constructor stores registry reference', () => {
  const registry = new CapabilityRegistry();
  const gen = new HelpGenerator(registry);

  assert.strictEqual(gen.registry, registry);
});

// ============================================================
// Tests: generateMainHelp()
// ============================================================

test('generateMainHelp includes commands section', () => {
  const registry = createTestRegistry();
  const gen = new HelpGenerator(registry);

  const help = gen.generateMainHelp();

  assert.ok(help.includes('MoltAgent Help'));
  assert.ok(help.includes('/help'));
  assert.ok(help.includes('/status'));
  assert.ok(help.includes('/capabilities'));
  assert.ok(help.includes('/health'));
});

test('generateMainHelp includes capabilities summary', () => {
  const registry = createTestRegistry();
  const gen = new HelpGenerator(registry);

  const help = gen.generateMainHelp();

  assert.ok(help.includes('Capabilities'));
  assert.ok(help.includes('conversation'));
  assert.ok(help.includes('research'));
});

test('generateMainHelp includes natural language tip', () => {
  const registry = createTestRegistry();
  const gen = new HelpGenerator(registry);

  const help = gen.generateMainHelp();

  assert.ok(help.includes('natural language'));
});

test('generateMainHelp works with empty registry', () => {
  const registry = new CapabilityRegistry();
  const gen = new HelpGenerator(registry);

  const help = gen.generateMainHelp();

  // Should not throw, should still produce header
  assert.ok(help.includes('MoltAgent Help'));
});

// ============================================================
// Tests: generateTopicHelp()
// ============================================================

test('generateTopicHelp returns matching capabilities', () => {
  const registry = createTestRegistry();
  const gen = new HelpGenerator(registry);

  const help = gen.generateTopicHelp('calendar');

  assert.ok(help.includes('calendar'));
  assert.ok(help.includes('CalDAV'));
});

test('generateTopicHelp returns no-results message for unknown topic', () => {
  const registry = createTestRegistry();
  const gen = new HelpGenerator(registry);

  const help = gen.generateTopicHelp('xyznonexistent');

  assert.ok(help.includes('No capabilities found'));
  assert.ok(help.includes('/help'));
});

test('generateTopicHelp returns main help for empty topic', () => {
  const registry = createTestRegistry();
  const gen = new HelpGenerator(registry);

  const help = gen.generateTopicHelp('');

  assert.ok(help.includes('MoltAgent Help'));
});

test('generateTopicHelp returns main help for whitespace-only topic', () => {
  const registry = createTestRegistry();
  const gen = new HelpGenerator(registry);

  const help = gen.generateTopicHelp('   ');

  assert.ok(help.includes('MoltAgent Help'));
});

test('generateTopicHelp searches descriptions too', () => {
  const registry = createTestRegistry();
  const gen = new HelpGenerator(registry);

  const help = gen.generateTopicHelp('summarization');

  assert.ok(help.includes('summarize'));
});

// ============================================================
// Tests: formatCapabilityHelp()
// ============================================================

test('formatCapabilityHelp formats enabled capability', () => {
  const gen = new HelpGenerator(new CapabilityRegistry());

  const line = gen.formatCapabilityHelp({
    name: 'deck',
    category: 'integration',
    description: 'Task management',
    enabled: true
  });

  assert.ok(line.includes('deck'));
  assert.ok(line.includes('integration'));
  assert.ok(line.includes('Task management'));
  assert.ok(!line.includes('disabled'));
});

test('formatCapabilityHelp marks disabled capability', () => {
  const gen = new HelpGenerator(new CapabilityRegistry());

  const line = gen.formatCapabilityHelp({
    name: 'email',
    category: 'integration',
    description: 'Email service',
    enabled: false
  });

  assert.ok(line.includes('disabled'));
});

// ============================================================
// Tests: formatCommandHelp()
// ============================================================

test('formatCommandHelp formats command', () => {
  const gen = new HelpGenerator(new CapabilityRegistry());

  const line = gen.formatCommandHelp({
    name: '/help',
    description: 'Show help text'
  });

  assert.ok(line.includes('/help'));
  assert.ok(line.includes('Show help text'));
});

// ============================================================
// Tests: generateSummary()
// ============================================================

test('generateSummary lists capabilities by category', () => {
  const registry = createTestRegistry();
  const gen = new HelpGenerator(registry);

  const summary_text = gen.generateSummary();

  assert.ok(summary_text.includes('core'));
  assert.ok(summary_text.includes('conversation'));
  assert.ok(summary_text.includes('research'));
  assert.ok(summary_text.includes('integration'));
  assert.ok(summary_text.includes('deck'));
  assert.ok(summary_text.includes('calendar'));
});

test('generateSummary only shows enabled integrations', () => {
  const registry = createTestRegistry();
  const gen = new HelpGenerator(registry);

  const summary_text = gen.generateSummary();

  // email is disabled, should not appear in integration names list
  assert.ok(!summary_text.includes('email'));
});

test('generateSummary works with empty registry', () => {
  const registry = new CapabilityRegistry();
  const gen = new HelpGenerator(registry);

  const summary_text = gen.generateSummary();

  assert.ok(summary_text.includes('Capabilities'));
});

// ============================================================
// Summary
// ============================================================

setTimeout(() => {
  summary();
  exitWithCode();
}, 500);
