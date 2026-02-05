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
 * StatusReporter Unit Tests
 *
 * Architecture Brief:
 * -------------------
 * Problem: Verify that StatusReporter correctly aggregates data from registry,
 * heartbeat, and knowledge board, formats uptime, and produces health checks.
 *
 * Pattern: Uses a real CapabilityRegistry (lightweight) plus mock heartbeat
 * and knowledge board objects. Tests both sync (getHealthCheck, formatUptime)
 * and async (generateStatus) methods.
 *
 * Run: node test/unit/capabilities/status-reporter.test.js
 *
 * @module test/unit/capabilities/status-reporter
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

// Import modules under test
const { CapabilityRegistry } = require('../../../src/lib/capabilities/capability-registry');
const { StatusReporter } = require('../../../src/lib/capabilities/status-reporter');

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
  registry.registerIntegration({ name: 'deck', description: 'Deck' });
  registry.registerIntegration({ name: 'calendar', description: 'Calendar', enabled: false });
  registry.setProviderStatus('ollama', 'online', 'qwen3:8b loaded');
  registry.setProviderStatus('nextcloud', 'online');
  return registry;
}

/**
 * Create a mock HeartbeatManager.
 * @param {Object} [overrides={}]
 * @returns {Object}
 */
function createMockHeartbeat(overrides = {}) {
  return {
    getStatus: () => ({
      isRunning: true,
      lastRun: new Date('2026-02-06T15:00:00Z'),
      tasksProcessedToday: 5,
      consecutiveFailures: 0,
      ...overrides
    })
  };
}

/**
 * Create a mock KnowledgeBoard.
 * @param {Object} [stacks={}]
 * @returns {Object}
 */
function createMockKnowledgeBoard(stacks = {}) {
  return {
    getStatus: async () => ({
      stacks: {
        verified: 10,
        uncertain: 3,
        stale: 1,
        disputed: 0,
        ...stacks
      }
    })
  };
}

// ============================================================
// Tests: Constructor
// ============================================================

console.log('');
console.log('=== StatusReporter Tests ===');
console.log('');

test('constructor stores registry and options', () => {
  const registry = new CapabilityRegistry();
  const reporter = new StatusReporter(registry, { heartbeat: 'hb', knowledgeBoard: 'kb' });

  assert.strictEqual(reporter.registry, registry);
  assert.strictEqual(reporter.heartbeat, 'hb');
  assert.strictEqual(reporter.knowledgeBoard, 'kb');
  assert.ok(reporter.startTime > 0);
});

test('constructor defaults options to null', () => {
  const registry = new CapabilityRegistry();
  const reporter = new StatusReporter(registry);

  assert.strictEqual(reporter.heartbeat, null);
  assert.strictEqual(reporter.knowledgeBoard, null);
});

// ============================================================
// Tests: formatUptime()
// ============================================================

test('formatUptime handles zero', () => {
  const reporter = new StatusReporter(new CapabilityRegistry());
  assert.strictEqual(reporter.formatUptime(0), '0s');
});

test('formatUptime handles seconds only', () => {
  const reporter = new StatusReporter(new CapabilityRegistry());
  assert.strictEqual(reporter.formatUptime(45000), '45s');
});

test('formatUptime handles minutes and seconds', () => {
  const reporter = new StatusReporter(new CapabilityRegistry());
  // 5 minutes 30 seconds = 330000ms
  assert.strictEqual(reporter.formatUptime(330000), '5m 30s');
});

test('formatUptime handles hours, minutes, seconds', () => {
  const reporter = new StatusReporter(new CapabilityRegistry());
  // 2h 15m 10s = 8110000ms
  assert.strictEqual(reporter.formatUptime(8110000), '2h 15m 10s');
});

test('formatUptime handles days', () => {
  const reporter = new StatusReporter(new CapabilityRegistry());
  // 1d 5h 30m 0s = 106200000ms
  assert.strictEqual(reporter.formatUptime(106200000), '1d 5h 30m 0s');
});

test('formatUptime handles negative as zero', () => {
  const reporter = new StatusReporter(new CapabilityRegistry());
  assert.strictEqual(reporter.formatUptime(-1000), '0s');
});

// ============================================================
// Tests: getHealthCheck()
// ============================================================

test('getHealthCheck shows no providers when empty', () => {
  const registry = new CapabilityRegistry();
  const reporter = new StatusReporter(registry);

  const health = reporter.getHealthCheck();
  assert.ok(health.includes('No providers registered'));
});

test('getHealthCheck shows provider statuses', () => {
  const registry = createTestRegistry();
  const reporter = new StatusReporter(registry);

  const health = reporter.getHealthCheck();

  assert.ok(health.includes('Health Check'));
  assert.ok(health.includes('ollama'));
  assert.ok(health.includes('online'));
  assert.ok(health.includes('nextcloud'));
  assert.ok(health.includes('All systems operational'));
});

test('getHealthCheck reports degraded system', () => {
  const registry = new CapabilityRegistry();
  registry.setProviderStatus('ollama', 'offline', 'Connection refused');
  registry.setProviderStatus('nextcloud', 'online');

  const reporter = new StatusReporter(registry);
  const health = reporter.getHealthCheck();

  assert.ok(health.includes('require attention'));
  assert.ok(health.includes('[DOWN]'));
  assert.ok(health.includes('[OK]'));
});

// ============================================================
// Tests: generateStatus() (async)
// ============================================================

asyncTest('generateStatus includes uptime', async () => {
  const registry = createTestRegistry();
  const reporter = new StatusReporter(registry);

  const status = await reporter.generateStatus();

  assert.ok(status.includes('MoltAgent Status Report'));
  assert.ok(status.includes('Uptime'));
});

asyncTest('generateStatus includes provider section', async () => {
  const registry = createTestRegistry();
  const reporter = new StatusReporter(registry);

  const status = await reporter.generateStatus();

  assert.ok(status.includes('Providers'));
  assert.ok(status.includes('ollama'));
  assert.ok(status.includes('nextcloud'));
});

asyncTest('generateStatus includes integration section', async () => {
  const registry = createTestRegistry();
  const reporter = new StatusReporter(registry);

  const status = await reporter.generateStatus();

  assert.ok(status.includes('Integrations'));
  assert.ok(status.includes('deck'));
  assert.ok(status.includes('[ON]'));
  assert.ok(status.includes('[OFF]'));
});

asyncTest('generateStatus includes heartbeat when available', async () => {
  const registry = createTestRegistry();
  const heartbeat = createMockHeartbeat();
  const reporter = new StatusReporter(registry, { heartbeat });

  const status = await reporter.generateStatus();

  assert.ok(status.includes('Heartbeat'));
  assert.ok(status.includes('Running: Yes'));
  assert.ok(status.includes('Tasks today: 5'));
});

asyncTest('generateStatus includes knowledge board when available', async () => {
  const registry = createTestRegistry();
  const kb = createMockKnowledgeBoard();
  const reporter = new StatusReporter(registry, { knowledgeBoard: kb });

  const status = await reporter.generateStatus();

  assert.ok(status.includes('Knowledge Board'));
  assert.ok(status.includes('Verified: 10'));
  assert.ok(status.includes('Uncertain: 3'));
});

asyncTest('generateStatus handles heartbeat error gracefully', async () => {
  const registry = createTestRegistry();
  const heartbeat = {
    getStatus: () => { throw new Error('Heartbeat error'); }
  };
  const reporter = new StatusReporter(registry, { heartbeat });

  const status = await reporter.generateStatus();

  assert.ok(status.includes('Heartbeat'));
  assert.ok(status.includes('Error reading status'));
});

asyncTest('generateStatus handles knowledge board error gracefully', async () => {
  const registry = createTestRegistry();
  const kb = {
    getStatus: async () => { throw new Error('KB error'); }
  };
  const reporter = new StatusReporter(registry, { knowledgeBoard: kb });

  const status = await reporter.generateStatus();

  assert.ok(status.includes('Knowledge Board'));
  assert.ok(status.includes('Error reading status'));
});

asyncTest('generateStatus includes total capability count', async () => {
  const registry = createTestRegistry();
  const reporter = new StatusReporter(registry);

  const status = await reporter.generateStatus();

  assert.ok(status.includes('Total capabilities'));
});

asyncTest('generateStatus works with minimal registry', async () => {
  const registry = new CapabilityRegistry();
  const reporter = new StatusReporter(registry);

  const status = await reporter.generateStatus();

  assert.ok(status.includes('MoltAgent Status Report'));
  assert.ok(status.includes('Uptime'));
});

// ============================================================
// Summary
// ============================================================

setTimeout(() => {
  summary();
  exitWithCode();
}, 500);
