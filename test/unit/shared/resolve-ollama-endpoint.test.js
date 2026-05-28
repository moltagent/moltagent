/**
 * SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2024 Moltagent contributors
 *
 * resolveOllamaEndpoint() Unit Tests
 *
 * Architecture Brief:
 *   Tests the canonical Ollama endpoint resolver. The function exists because
 *   YOUR_OLLAMA_IP placeholders were silently entering five provider
 *   constructors (three in webhook-server, one in providers/index.js, one in
 *   heartbeat-manager) and killing local inference for months — ProviderChain
 *   absorbed every failure as a routing fallback to Claude.
 *
 *   Cases below pin the precedence chain (env > candidate > default), the
 *   placeholder-rejection at every layer, and the warn-once behavior so
 *   journald isn't spammed on every heartbeat.
 *
 * Run: node test/unit/shared/resolve-ollama-endpoint.test.js
 */

'use strict';

const assert = require('assert');
const { test, summary, exitWithCode } = require('../../helpers/test-runner');

const {
  resolveOllamaEndpoint,
  _resetWarnedForTests,
  DEFAULT_FALLBACK,
} = require('../../../src/lib/shared/resolve-ollama-endpoint');

function silentLogger() {
  const warnings = [];
  return {
    warnings,
    warn: (msg) => warnings.push(msg),
    info: () => {},
    error: () => {},
  };
}

console.log('\n=== resolveOllamaEndpoint Tests ===\n');

test('env var wins over candidate when both are valid', () => {
  _resetWarnedForTests();
  const got = resolveOllamaEndpoint('http://192.168.1.100:11434', {
    envUrl: 'http://10.0.0.5:11434',
    logger: silentLogger(),
  });
  assert.strictEqual(got, 'http://10.0.0.5:11434');
});

test('candidate used when env unset', () => {
  _resetWarnedForTests();
  const got = resolveOllamaEndpoint('http://192.168.1.100:11434', {
    envUrl: undefined,
    logger: silentLogger(),
  });
  assert.strictEqual(got, 'http://192.168.1.100:11434');
});

test('candidate used when env empty string', () => {
  _resetWarnedForTests();
  const got = resolveOllamaEndpoint('http://192.168.1.100:11434', {
    envUrl: '',
    logger: silentLogger(),
  });
  assert.strictEqual(got, 'http://192.168.1.100:11434');
});

test('placeholder env var is rejected, candidate wins', () => {
  _resetWarnedForTests();
  const log = silentLogger();
  const got = resolveOllamaEndpoint('http://192.168.1.100:11434', {
    envUrl: 'http://YOUR_OLLAMA_IP:11434',
    logger: log,
  });
  assert.strictEqual(got, 'http://192.168.1.100:11434');
  assert.ok(
    log.warnings.some((w) => w.includes('OLLAMA_URL is a placeholder')),
    'expected placeholder-env warning'
  );
});

test('placeholder candidate is rejected, default wins', () => {
  _resetWarnedForTests();
  const log = silentLogger();
  const got = resolveOllamaEndpoint('http://YOUR_OLLAMA_IP:11434', {
    envUrl: undefined,
    logger: log,
  });
  assert.strictEqual(got, DEFAULT_FALLBACK);
  assert.ok(
    log.warnings.some((w) => w.includes('endpoint is a placeholder')),
    'expected placeholder-candidate warning'
  );
});

test('both placeholders → default localhost', () => {
  _resetWarnedForTests();
  const got = resolveOllamaEndpoint('http://YOUR_OLLAMA_IP:11434', {
    envUrl: 'http://YOUR_OLLAMA_IP:11434',
    logger: silentLogger(),
  });
  assert.strictEqual(got, DEFAULT_FALLBACK);
});

test('null candidate, no env → default localhost', () => {
  _resetWarnedForTests();
  const got = resolveOllamaEndpoint(null, {
    envUrl: undefined,
    logger: silentLogger(),
  });
  assert.strictEqual(got, DEFAULT_FALLBACK);
});

test('undefined candidate, no env → default localhost', () => {
  _resetWarnedForTests();
  const got = resolveOllamaEndpoint(undefined, {
    envUrl: undefined,
    logger: silentLogger(),
  });
  assert.strictEqual(got, DEFAULT_FALLBACK);
});

test('custom defaultUrl honored when both env and candidate absent', () => {
  _resetWarnedForTests();
  const got = resolveOllamaEndpoint(null, {
    envUrl: undefined,
    defaultUrl: 'http://custom-default:11434',
    logger: silentLogger(),
  });
  assert.strictEqual(got, 'http://custom-default:11434');
});

test('trailing slash stripped from env value', () => {
  _resetWarnedForTests();
  const got = resolveOllamaEndpoint(null, {
    envUrl: 'http://10.0.0.5:11434/',
    logger: silentLogger(),
  });
  assert.strictEqual(got, 'http://10.0.0.5:11434');
});

test('trailing slash stripped from candidate value', () => {
  _resetWarnedForTests();
  const got = resolveOllamaEndpoint('http://192.168.1.100:11434/', {
    envUrl: undefined,
    logger: silentLogger(),
  });
  assert.strictEqual(got, 'http://192.168.1.100:11434');
});

test('warn-once: same placeholder candidate logged only once across calls', () => {
  _resetWarnedForTests();
  const log = silentLogger();
  resolveOllamaEndpoint('http://YOUR_OLLAMA_IP:11434', { envUrl: undefined, logger: log });
  resolveOllamaEndpoint('http://YOUR_OLLAMA_IP:11434', { envUrl: undefined, logger: log });
  resolveOllamaEndpoint('http://YOUR_OLLAMA_IP:11434', { envUrl: undefined, logger: log });
  const placeholderWarns = log.warnings.filter((w) => w.includes('endpoint is a placeholder'));
  assert.strictEqual(placeholderWarns.length, 1, 'expected exactly one warn-once for the same placeholder');
});

test('source label appears in warning for diagnostic clarity', () => {
  _resetWarnedForTests();
  const log = silentLogger();
  resolveOllamaEndpoint('http://YOUR_OLLAMA_IP:11434', {
    envUrl: undefined,
    logger: log,
    source: 'provider:ollama-local',
  });
  assert.ok(
    log.warnings.some((w) => w.includes('provider:ollama-local')),
    'expected source label in warning'
  );
});

test('createProvider integration: ollama adapter strips placeholder endpoint', () => {
  _resetWarnedForTests();
  const originalEnv = process.env.OLLAMA_URL;
  delete process.env.OLLAMA_URL;
  try {
    const { createProvider } = require('../../../src/lib/llm/providers');
    const provider = createProvider('ollama', {
      id: 'test-ollama',
      endpoint: 'http://YOUR_OLLAMA_IP:11434',
      model: 'phi4-mini',
    });
    assert.strictEqual(provider.endpoint, 'http://localhost:11434');
  } finally {
    if (originalEnv !== undefined) process.env.OLLAMA_URL = originalEnv;
  }
});

test('createProvider integration: OLLAMA_URL env wins over YAML candidate', () => {
  _resetWarnedForTests();
  const originalEnv = process.env.OLLAMA_URL;
  process.env.OLLAMA_URL = 'http://10.0.0.5:11434';
  try {
    const { createProvider } = require('../../../src/lib/llm/providers');
    const provider = createProvider('ollama', {
      id: 'test-ollama-env',
      endpoint: 'http://192.168.1.100:11434',
      model: 'phi4-mini',
    });
    assert.strictEqual(provider.endpoint, 'http://10.0.0.5:11434');
  } finally {
    if (originalEnv !== undefined) process.env.OLLAMA_URL = originalEnv;
    else delete process.env.OLLAMA_URL;
  }
});

test('createProvider integration: non-ollama adapter unaffected by resolver', () => {
  _resetWarnedForTests();
  const originalEnv = process.env.OLLAMA_URL;
  process.env.OLLAMA_URL = 'http://10.0.0.5:11434';
  try {
    const { createProvider } = require('../../../src/lib/llm/providers');
    const provider = createProvider('anthropic', {
      id: 'test-anthropic',
      endpoint: 'https://api.anthropic.com',
    });
    assert.strictEqual(provider.endpoint, 'https://api.anthropic.com');
  } finally {
    if (originalEnv !== undefined) process.env.OLLAMA_URL = originalEnv;
    else delete process.env.OLLAMA_URL;
  }
});

setTimeout(() => {
  const result = summary();
  exitWithCode();
  if (result.failed > 0) process.exitCode = 1;
}, 100);
