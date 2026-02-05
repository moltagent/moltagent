/**
 * Unit Tests for Centralized Config Module
 *
 * Tests configuration loading, environment variable parsing,
 * defaults, and immutability.
 *
 * @module test/unit/config.test.js
 */

'use strict';

const assert = require('assert');

// Store original env to restore after tests
const originalEnv = { ...process.env };

/**
 * Helper to run async test with proper error handling
 * @param {string} name - Test name
 * @param {Function} fn - Test function
 */
function test(name, fn) {
  try {
    fn();
    console.log(`[PASS] ${name}`);
  } catch (error) {
    console.error(`[FAIL] ${name}`);
    console.error(`       ${error.message}`);
    process.exitCode = 1;
  }
}

/**
 * Helper to reset environment and reload config
 * @param {Object} envOverrides - Environment variables to set
 * @returns {Object} Fresh config module
 */
function loadConfigWithEnv(envOverrides = {}) {
  // Reset env
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('NC_') || key.startsWith('OLLAMA_') ||
        key.startsWith('TIMEOUT_') || key.startsWith('CACHE_') ||
        key.startsWith('HEARTBEAT_') || key.startsWith('LLM_') ||
        key.startsWith('PENDING_') || key.startsWith('DECK_') ||
        key.startsWith('EMAIL_') || key === 'PORT' || key === 'HOST' ||
        key === 'STRICT_MODE' || key === 'DEBUG_MODE') {
      delete process.env[key];
    }
  }

  // Apply overrides
  Object.assign(process.env, envOverrides);

  // Clear require cache and reload
  delete require.cache[require.resolve('../../src/lib/config')];
  return require('../../src/lib/config');
}

// -----------------------------------------------------------------------------
// Test Suite
// -----------------------------------------------------------------------------

console.log('\n=== Config Module Tests ===\n');

// --- Default Values ---

test('TC-CFG-001: Default nextcloud.url is set', () => {
  const config = loadConfigWithEnv({});
  assert.strictEqual(typeof config.nextcloud.url, 'string');
  assert.ok(config.nextcloud.url.startsWith('https://'));
});

test('TC-CFG-002: Default nextcloud.username is moltagent', () => {
  const config = loadConfigWithEnv({});
  assert.strictEqual(config.nextcloud.username, 'moltagent');
});

test('TC-CFG-003: Default server.port is 3000', () => {
  const config = loadConfigWithEnv({});
  assert.strictEqual(config.server.port, 3000);
});

test('TC-CFG-004: Default timeouts are reasonable', () => {
  const config = loadConfigWithEnv({});
  assert.strictEqual(config.timeouts.httpRequest, 30000);
  assert.strictEqual(config.timeouts.ollamaHealth, 5000);
});

test('TC-CFG-005: Default cache TTLs are set', () => {
  const config = loadConfigWithEnv({});
  assert.strictEqual(config.cacheTTL.passwords, 5 * 60 * 1000);
  assert.strictEqual(config.cacheTTL.caldav, 60 * 1000);
  assert.strictEqual(config.cacheTTL.credentials, 30 * 1000);
});

// --- Environment Variable Overrides ---

test('TC-CFG-010: NC_URL env overrides default', () => {
  const config = loadConfigWithEnv({ NC_URL: 'https://custom.example.com' });
  assert.strictEqual(config.nextcloud.url, 'https://custom.example.com');
});

test('TC-CFG-011: PORT env overrides default', () => {
  const config = loadConfigWithEnv({ PORT: '8080' });
  assert.strictEqual(config.server.port, 8080);
});

test('TC-CFG-012: Invalid PORT falls back to default', () => {
  const config = loadConfigWithEnv({ PORT: 'invalid' });
  assert.strictEqual(config.server.port, 3000);
});

test('TC-CFG-013: Boolean env parsing - true', () => {
  const config = loadConfigWithEnv({ DEBUG_MODE: 'true' });
  assert.strictEqual(config.debugMode, true);
});

test('TC-CFG-014: Boolean env parsing - false', () => {
  const config = loadConfigWithEnv({ DEBUG_MODE: 'false' });
  assert.strictEqual(config.debugMode, false);
});

test('TC-CFG-015: Boolean env parsing - 1', () => {
  const config = loadConfigWithEnv({ DEBUG_MODE: '1' });
  assert.strictEqual(config.debugMode, true);
});

test('TC-CFG-016: List env parsing', () => {
  const config = loadConfigWithEnv({ NC_TALK_BACKENDS: 'https://a.com,https://b.com' });
  assert.deepStrictEqual(config.security.allowedBackends, ['https://a.com', 'https://b.com']);
});

test('TC-CFG-017: Empty list env uses nextcloud URL', () => {
  const config = loadConfigWithEnv({ NC_URL: 'https://test.com', NC_TALK_BACKENDS: '' });
  assert.deepStrictEqual(config.security.allowedBackends, ['https://test.com']);
});

// --- Immutability ---

test('TC-CFG-020: Config object is frozen', () => {
  const config = loadConfigWithEnv({});
  assert.ok(Object.isFrozen(config));
});

test('TC-CFG-021: Nested config objects are frozen', () => {
  const config = loadConfigWithEnv({});
  assert.ok(Object.isFrozen(config.nextcloud));
  assert.ok(Object.isFrozen(config.timeouts));
  assert.ok(Object.isFrozen(config.cacheTTL));
});

test('TC-CFG-022: Cannot modify config values', () => {
  const config = loadConfigWithEnv({});
  assert.throws(() => {
    config.server.port = 9999;
  }, TypeError);
});

test('TC-CFG-023: Cannot add new config properties', () => {
  const config = loadConfigWithEnv({});
  assert.throws(() => {
    config.newProperty = 'value';
  }, TypeError);
});

// --- Specific Config Groups ---

test('TC-CFG-030: Heartbeat config has all required fields', () => {
  const config = loadConfigWithEnv({});
  assert.strictEqual(typeof config.heartbeat.intervalMs, 'number');
  assert.strictEqual(typeof config.heartbeat.quietHoursStart, 'number');
  assert.strictEqual(typeof config.heartbeat.quietHoursEnd, 'number');
  assert.strictEqual(typeof config.heartbeat.maxTasksPerCycle, 'number');
  assert.strictEqual(typeof config.heartbeat.deckEnabled, 'boolean');
});

test('TC-CFG-031: LLM config has all required fields', () => {
  const config = loadConfigWithEnv({});
  assert.strictEqual(typeof config.llm.maxTokens, 'number');
  assert.strictEqual(typeof config.llm.circuitBreakerThreshold, 'number');
  assert.strictEqual(typeof config.llm.backoffInitialMs, 'number');
});

test('TC-CFG-032: Pending actions config has TTLs', () => {
  const config = loadConfigWithEnv({});
  assert.strictEqual(typeof config.pendingActions.confirmationTTLMs, 'number');
  assert.strictEqual(typeof config.pendingActions.emailReplyTTLMs, 'number');
  assert.ok(config.pendingActions.emailReplyTTLMs > config.pendingActions.confirmationTTLMs);
});

test('TC-CFG-033: Ports config has standard values', () => {
  const config = loadConfigWithEnv({});
  assert.strictEqual(config.ports.imapDefault, 993);
  assert.strictEqual(config.ports.smtpDefault, 587);
});

// --- Cleanup ---

// Restore original environment
Object.keys(process.env).forEach(key => {
  if (!(key in originalEnv)) {
    delete process.env[key];
  }
});
Object.assign(process.env, originalEnv);

console.log('\n=== Config Tests Complete ===\n');
