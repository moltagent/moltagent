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
 * BootPreflight Unit Tests (#87)
 *
 * The manifest is one declared object; required-and-definitively-absent
 * halts, unreachable-required only warns, optional-missing degrades visibly.
 *
 * Run: node test/unit/boot/preflight.test.js
 */

'use strict';

const assert = require('assert');
const { asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const { BootPreflight, STATUS } = require('../../../src/lib/boot/preflight');

console.log('\n=== BootPreflight Tests (#87) ===\n');

const CAPS_FULL = { spreed: {}, deck: {}, theming: {} };
const CAPS_NO_DECK = { spreed: {}, theming: {} };

function capsBody(caps) {
  return JSON.stringify({ ocs: { data: { capabilities: caps } } });
}

/**
 * Mock NCRequestManager. `overrides` maps path substrings to responses
 * ({status, body}) or Error instances.
 */
function mockNc(caps, overrides = {}) {
  return {
    request: async (path) => {
      for (const [needle, value] of Object.entries(overrides)) {
        if (path.includes(needle)) {
          if (value instanceof Error) throw value;
          return value;
        }
      }
      if (path.includes('/cloud/capabilities')) {
        if (caps instanceof Error) throw caps;
        return { status: 200, body: capsBody(caps) };
      }
      return { status: 200, body: '[]' };
    },
  };
}

function captureLogger() {
  const lines = { info: [], warn: [], error: [] };
  return {
    lines,
    info: (m) => lines.info.push(String(m)),
    warn: (m) => lines.warn.push(String(m)),
    error: (m) => lines.error.push(String(m)),
  };
}

/** Fetch mock: ollama tags OK with the embedding model present. */
function mockFetch({ tags = ['nomic-embed-text:latest'], fail = false } = {}) {
  return async (url) => {
    if (fail) throw new Error('connect ECONNREFUSED');
    if (String(url).includes('/api/tags')) {
      return { ok: true, status: 200, json: async () => ({ models: tags.map((n) => ({ name: n })) }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
}

const BASE_CONFIG = {
  ollama: { url: 'http://ollama.test:11434', embeddingModel: 'nomic-embed-text' },
  search: { searxng: { url: 'http://searx.test' } },
  voice: { speachesUrl: 'http://voice.test:8014' },
};

(async () => {
  // TC-PF-001: everything present → no halt, all OK.
  await asyncTest('TC-PF-001: full composition → all OK, no halt', async () => {
    const logger = captureLogger();
    const pf = new BootPreflight({
      config: BASE_CONFIG, ncRequestManager: mockNc(CAPS_FULL), logger, fetchImpl: mockFetch(),
    });
    const { halt, results } = await pf.run();
    assert.strictEqual(halt, false);
    assert.ok(results.every((r) => r.status === STATUS.OK), JSON.stringify(results));
    assert.strictEqual(logger.lines.error.length, 0);
  });

  // TC-PF-002: required app definitively absent (2xx caps without the key) → halt + fatal line.
  await asyncTest('TC-PF-002: Deck absent from capabilities → halt with remediation', async () => {
    const logger = captureLogger();
    const pf = new BootPreflight({
      config: BASE_CONFIG, ncRequestManager: mockNc(CAPS_NO_DECK), logger, fetchImpl: mockFetch(),
    });
    const { halt, results } = await pf.run();
    assert.strictEqual(halt, true, 'definitive absence of a required app must halt');
    const deck = results.find((r) => r.name === 'NC Deck');
    assert.strictEqual(deck.status, STATUS.MISSING);
    const fatal = logger.lines.error.find((l) => l.includes('NC Deck') && l.includes('[PREFLIGHT][FATAL]'));
    assert.ok(fatal, 'one fatal line names the dependency');
    assert.ok(fatal.includes('apps.nextcloud.com/apps/deck'), 'fatal line carries the remediation URL');
  });

  // TC-PF-003: required unreachable (network error) → NO halt, warn only.
  await asyncTest('TC-PF-003: capabilities unreachable → warn, never halt (no bricking on hiccups)', async () => {
    const logger = captureLogger();
    const pf = new BootPreflight({
      config: BASE_CONFIG, ncRequestManager: mockNc(new Error('ETIMEDOUT')), logger, fetchImpl: mockFetch(),
    });
    const { halt } = await pf.run();
    assert.strictEqual(halt, false, 'unreachable is not absence — must not halt');
    assert.ok(logger.lines.warn.some((l) => l.includes('[PREFLIGHT][WARN]')), 'warn lines emitted');
    assert.strictEqual(logger.lines.error.length, 0, 'no fatal lines');
  });

  // TC-PF-004: required app API 404 (Collectives removed) → halt.
  await asyncTest('TC-PF-004: Collectives API 404 → definitive absence, halt', async () => {
    const logger = captureLogger();
    const pf = new BootPreflight({
      config: BASE_CONFIG,
      ncRequestManager: mockNc(CAPS_FULL, { '/apps/collectives/': { status: 404, body: '' } }),
      logger, fetchImpl: mockFetch(),
    });
    const { halt, results } = await pf.run();
    assert.strictEqual(halt, true);
    assert.strictEqual(results.find((r) => r.name === 'NC Collectives').status, STATUS.MISSING);
  });

  // TC-PF-005: optional unreachable → boot continues, one visible degrade line.
  await asyncTest('TC-PF-005: Speaches down → optional degrade line, no halt', async () => {
    const logger = captureLogger();
    const fetchImpl = async (url) => {
      if (String(url).startsWith('http://voice.test')) throw new Error('connect ECONNREFUSED');
      return mockFetch()(url);
    };
    const pf = new BootPreflight({
      config: BASE_CONFIG, ncRequestManager: mockNc(CAPS_FULL), logger, fetchImpl,
    });
    const { halt, results } = await pf.run();
    assert.strictEqual(halt, false, 'optional absence never halts');
    assert.strictEqual(results.find((r) => r.name === 'Speaches STT/TTS').status, STATUS.UNREACHABLE);
    const line = logger.lines.warn.find((l) => l.includes('Speaches STT/TTS') && l.includes('voice disabled this boot'));
    assert.ok(line, 'degrade line names the feature that turns off');
  });

  // TC-PF-006: optional not configured → says so once, no warning noise.
  await asyncTest('TC-PF-006: unset optional endpoint → not-configured info line', async () => {
    const logger = captureLogger();
    const config = { ...BASE_CONFIG, voice: { speachesUrl: '' } };
    const pf = new BootPreflight({
      config, ncRequestManager: mockNc(CAPS_FULL), logger, fetchImpl: mockFetch(),
    });
    const { halt, results } = await pf.run();
    assert.strictEqual(halt, false);
    assert.strictEqual(results.find((r) => r.name === 'Speaches STT/TTS').status, STATUS.NOT_CONFIGURED);
    assert.ok(logger.lines.info.some((l) => l.includes('Speaches STT/TTS') && l.includes('not configured')));
  });

  // TC-PF-007: embedding model missing from Ollama tags → definitive optional MISSING with pull hint.
  await asyncTest('TC-PF-007: embedding model not pulled → missing with remediation detail', async () => {
    const logger = captureLogger();
    const pf = new BootPreflight({
      config: BASE_CONFIG, ncRequestManager: mockNc(CAPS_FULL),
      logger, fetchImpl: mockFetch({ tags: ['qwen3:8b'] }),
    });
    const { halt, results } = await pf.run();
    assert.strictEqual(halt, false);
    const emb = results.find((r) => r.name.startsWith('Embedding model'));
    assert.strictEqual(emb.status, STATUS.MISSING);
    assert.ok(emb.detail.includes('ollama pull nomic-embed-text'));
  });

  setTimeout(() => { summary(); exitWithCode(); }, 500);
})();
