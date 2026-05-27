/**
 * SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2024 Moltagent contributors
 *
 * ConfirmationClassifier Integration Tests
 *
 * Requires a live Ollama instance at http://localhost:11434 with qwen2.5:3b.
 * If Ollama is unreachable, the suite skips gracefully (all tests pass with [SKIP]).
 *
 * Run: node test/integration/shared/confirmation-classifier.integration.test.js
 *      or via: npm run test:integration
 */

'use strict';

const assert = require('assert');
const { asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const { classifyConfirmationReply } = require('../../../src/lib/shared/confirmation-classifier');
const { OllamaToolsProvider } = require('../../../src/lib/agent/providers/ollama-tools');

console.log('\n=== ConfirmationClassifier Integration Tests ===\n');

// ============================================================
// Probe Ollama reachability before running any real tests
// ============================================================

async function buildProvider() {
  const provider = new OllamaToolsProvider(
    { endpoint: 'http://localhost:11434', model: 'qwen2.5:3b', timeout: 10000 },
    { info: () => {}, warn: () => {}, error: () => {} }
  );
  // Quick connectivity probe
  await provider.chat({
    system: 'Reply with the single word: READY',
    messages: [{ role: 'user', content: 'Reply READY' }],
    tools: [],
    timeout: 6000,
    model: 'qwen2.5:3b',
    options: { temperature: 0 }
  });
  return provider;
}

// ============================================================
// Test fixtures: [text, options, expectedLabel]
// Pass threshold: 4-of-5 per language (LLMs are stochastic)
// ============================================================

const EN_CASES = [
  ['yes',             {},   'approve'],
  ['go ahead',        {},   'approve'],
  ['no',              {},   'deny'],
  ['cancel',          {},   'deny'],
  ['what time is it', {},   'unknown'],
];

const DE_CASES = [
  ['ja',              {},   'approve'],
  ['klar mach das',   {},   'approve'],
  ['nein',            {},   'deny'],
  ['abbrechen',       {},   'deny'],
  ['wie viel Uhr',    {},   'unknown'],
];

const PT_CASES = [
  ['sim',             {},   'approve'],
  ['pode mandar',     {},   'approve'],
  ['não',             {},   'deny'],
  ['cancela',         {},   'deny'],
  ['que horas são',   {},   'unknown'],
];

async function runLanguageTable(provider, cases, langTag) {
  let correct = 0;
  for (const [text, opts, expected] of cases) {
    const result = await classifyConfirmationReply(text, provider, { ...opts, timeoutMs: 8000 });
    if (result === expected) {
      correct++;
      console.log(`  [OK]   ${langTag} "${text}" → ${result}`);
    } else {
      console.log(`  [MISS] ${langTag} "${text}" → ${result} (expected ${expected})`);
    }
  }
  return correct;
}

// ============================================================
// Main — drive async work, then summarise and exit
// ============================================================

(async () => {
  await asyncTest('Integration: EN/DE/PT classification table (requires live Ollama + qwen2.5:3b)', async () => {
    let provider;
    try {
      provider = await buildProvider();
    } catch (err) {
      console.log(`[SKIP] Ollama unreachable or qwen2.5:3b not available: ${err.message}`);
      console.log('[SKIP] Skipping integration tests — suite passes.');
      return; // graceful skip — test counts as PASS
    }

    const THRESHOLD = 4; // 4-of-5 per language

    console.log('\n--- English ---');
    const enCorrect = await runLanguageTable(provider, EN_CASES, 'EN');
    console.log('\n--- German ---');
    const deCorrect = await runLanguageTable(provider, DE_CASES, 'DE');
    console.log('\n--- Portuguese ---');
    const ptCorrect = await runLanguageTable(provider, PT_CASES, 'PT');

    console.log(`\nResults: EN ${enCorrect}/5  DE ${deCorrect}/5  PT ${ptCorrect}/5  (threshold: ${THRESHOLD}/5 each)`);

    assert.ok(enCorrect >= THRESHOLD, `EN: expected >= ${THRESHOLD}/5 correct, got ${enCorrect}/5`);
    assert.ok(deCorrect >= THRESHOLD, `DE: expected >= ${THRESHOLD}/5 correct, got ${deCorrect}/5`);
    assert.ok(ptCorrect >= THRESHOLD, `PT: expected >= ${THRESHOLD}/5 correct, got ${ptCorrect}/5`);
  });

  console.log('\n=== ConfirmationClassifier Integration Tests Complete ===\n');
  summary();
  exitWithCode();
})();
