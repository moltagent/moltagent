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
 * CapabilitiesCommandHandler Unit Tests
 *
 * Architecture Brief:
 * -------------------
 * Problem: Verify that CapabilitiesCommandHandler correctly parses commands,
 * routes to built-in handlers, delegates to custom handlers, and handles
 * unknown commands gracefully.
 *
 * Pattern: Uses real CapabilityRegistry, HelpGenerator, and StatusReporter
 * (all lightweight, no I/O). Tests command parsing, routing, and output.
 *
 * Run: node test/unit/capabilities/command-handler.test.js
 *
 * @module test/unit/capabilities/command-handler
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

// Import modules under test
const { CapabilityRegistry } = require('../../../src/lib/capabilities/capability-registry');
const { HelpGenerator } = require('../../../src/lib/capabilities/help-generator');
const { StatusReporter } = require('../../../src/lib/capabilities/status-reporter');
const { CapabilitiesCommandHandler } = require('../../../src/lib/capabilities/command-handler');

// ============================================================
// Test Helpers
// ============================================================

/**
 * Create a fully wired command handler for testing.
 * @returns {CapabilitiesCommandHandler}
 */
function createTestHandler() {
  const registry = new CapabilityRegistry();
  registry.initialize();
  registry.registerIntegration({ name: 'deck', description: 'Deck integration' });
  registry.registerIntegration({ name: 'calendar', description: 'Calendar integration' });
  registry.setProviderStatus('ollama', 'online');

  const helpGenerator = new HelpGenerator(registry);
  const statusReporter = new StatusReporter(registry);

  return new CapabilitiesCommandHandler({
    registry,
    helpGenerator,
    statusReporter
  });
}

// ============================================================
// Tests: isCommand()
// ============================================================

console.log('');
console.log('=== CapabilitiesCommandHandler Tests ===');
console.log('');

test('isCommand returns true for /help', () => {
  const handler = createTestHandler();
  assert.strictEqual(handler.isCommand('/help'), true);
});

test('isCommand returns true for /status', () => {
  const handler = createTestHandler();
  assert.strictEqual(handler.isCommand('/status'), true);
});

test('isCommand returns true for command with args', () => {
  const handler = createTestHandler();
  assert.strictEqual(handler.isCommand('/help calendar'), true);
});

test('isCommand returns false for regular message', () => {
  const handler = createTestHandler();
  assert.strictEqual(handler.isCommand('hello world'), false);
});

test('isCommand returns false for empty string', () => {
  const handler = createTestHandler();
  assert.strictEqual(handler.isCommand(''), false);
});

test('isCommand returns false for null', () => {
  const handler = createTestHandler();
  assert.strictEqual(handler.isCommand(null), false);
});

test('isCommand returns false for undefined', () => {
  const handler = createTestHandler();
  assert.strictEqual(handler.isCommand(undefined), false);
});

test('isCommand returns false for single slash', () => {
  const handler = createTestHandler();
  assert.strictEqual(handler.isCommand('/'), false);
});

test('isCommand handles whitespace-prefixed commands', () => {
  const handler = createTestHandler();
  assert.strictEqual(handler.isCommand('  /help'), true);
});

// ============================================================
// Tests: parseCommand()
// ============================================================

test('parseCommand extracts command and args', () => {
  const handler = createTestHandler();
  const result = handler.parseCommand('/help calendar');

  assert.strictEqual(result.command, '/help');
  assert.strictEqual(result.args, 'calendar');
});

test('parseCommand handles command without args', () => {
  const handler = createTestHandler();
  const result = handler.parseCommand('/status');

  assert.strictEqual(result.command, '/status');
  assert.strictEqual(result.args, '');
});

test('parseCommand lowercases command', () => {
  const handler = createTestHandler();
  const result = handler.parseCommand('/HELP Topic');

  assert.strictEqual(result.command, '/help');
  assert.strictEqual(result.args, 'Topic');
});

test('parseCommand preserves args casing', () => {
  const handler = createTestHandler();
  const result = handler.parseCommand('/help CalDAV');

  assert.strictEqual(result.args, 'CalDAV');
});

test('parseCommand trims whitespace', () => {
  const handler = createTestHandler();
  const result = handler.parseCommand('  /help  calendar  ');

  assert.strictEqual(result.command, '/help');
  assert.strictEqual(result.args, 'calendar');
});

// ============================================================
// Tests: handle() - /help
// ============================================================

asyncTest('handle /help returns main help', async () => {
  const handler = createTestHandler();
  const result = await handler.handle('/help');

  assert.strictEqual(result.handled, true);
  assert.strictEqual(result.command, '/help');
  assert.ok(result.response.includes('Moltagent Help'));
  assert.ok(result.response.includes('/help'));
  assert.ok(result.response.includes('/status'));
});

asyncTest('handle /help with topic returns topic help', async () => {
  const handler = createTestHandler();
  const result = await handler.handle('/help calendar');

  assert.strictEqual(result.handled, true);
  assert.ok(result.response.includes('calendar'));
});

asyncTest('handle /help with unknown topic returns no-results', async () => {
  const handler = createTestHandler();
  const result = await handler.handle('/help xyznonexistent');

  assert.strictEqual(result.handled, true);
  assert.ok(result.response.includes('No capabilities found'));
});

// ============================================================
// Tests: handle() - /status
// ============================================================

asyncTest('handle /status returns status report', async () => {
  const handler = createTestHandler();
  const result = await handler.handle('/status');

  assert.strictEqual(result.handled, true);
  assert.strictEqual(result.command, '/status');
  assert.ok(result.response.includes('Moltagent Status Report'));
  assert.ok(result.response.includes('Uptime'));
});

// ============================================================
// Tests: handle() - /capabilities and /caps
// ============================================================

asyncTest('handle /capabilities lists all capabilities', async () => {
  const handler = createTestHandler();
  const result = await handler.handle('/capabilities');

  assert.strictEqual(result.handled, true);
  assert.strictEqual(result.command, '/capabilities');
  assert.ok(result.response.includes('Registered Capabilities'));
  assert.ok(result.response.includes('conversation'));
  assert.ok(result.response.includes('deck'));
  assert.ok(result.response.includes('/help'));
});

asyncTest('handle /caps is alias for /capabilities', async () => {
  const handler = createTestHandler();
  const result = await handler.handle('/caps');

  assert.strictEqual(result.handled, true);
  assert.ok(result.response.includes('Registered Capabilities'));
});

// ============================================================
// Tests: handle() - /health
// ============================================================

asyncTest('handle /health returns health check', async () => {
  const handler = createTestHandler();
  const result = await handler.handle('/health');

  assert.strictEqual(result.handled, true);
  assert.strictEqual(result.command, '/health');
  assert.ok(result.response.includes('Health Check'));
  assert.ok(result.response.includes('ollama'));
});

// ============================================================
// Tests: handle() - custom commands
// ============================================================

asyncTest('handle routes to custom registered handler', async () => {
  const registry = new CapabilityRegistry();
  registry.initialize();
  registry.registerCommand({
    name: '/ping',
    description: 'Ping test',
    handler: async (args) => `pong: ${args}`
  });

  const helpGenerator = new HelpGenerator(registry);
  const statusReporter = new StatusReporter(registry);
  const handler = new CapabilitiesCommandHandler({ registry, helpGenerator, statusReporter });

  const result = await handler.handle('/ping world');

  assert.strictEqual(result.handled, true);
  assert.strictEqual(result.command, '/ping');
  assert.strictEqual(result.response, 'pong: world');
});

asyncTest('handle custom command error returns error message', async () => {
  const registry = new CapabilityRegistry();
  registry.initialize();
  registry.registerCommand({
    name: '/fail',
    description: 'Failing command',
    handler: async () => { throw new Error('Boom'); }
  });

  const helpGenerator = new HelpGenerator(registry);
  const statusReporter = new StatusReporter(registry);
  const handler = new CapabilitiesCommandHandler({ registry, helpGenerator, statusReporter });

  const result = await handler.handle('/fail');

  assert.strictEqual(result.handled, true);
  assert.ok(result.response.includes('Error executing'));
  assert.ok(result.response.includes('Boom'));
});

// ============================================================
// Tests: handle() - unknown commands
// ============================================================

asyncTest('handle unknown command returns fallback', async () => {
  const handler = createTestHandler();
  const result = await handler.handle('/nonexistent');

  assert.strictEqual(result.handled, false);
  assert.ok(result.response.includes('Unknown command'));
  assert.ok(result.response.includes('/nonexistent'));
  assert.ok(result.response.includes('/help'));
});

// ============================================================
// Summary
// ============================================================

setTimeout(() => {
  summary();
  exitWithCode();
}, 500);
