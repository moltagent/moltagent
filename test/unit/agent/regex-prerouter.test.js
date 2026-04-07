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
 * Language-Agnostic Classification Tests
 *
 * Validates buildClassificationPrompt() language injection and the removal of
 * the English-only needsSmartClassifier() pre-router (v4.0.0 refactor).
 * All messages now go to the fast model first; the LLM handles all languages.
 *
 * Run: node test/unit/agent/regex-prerouter.test.js
 */

'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const IntentRouter = require('../../../src/lib/agent/intent-router');

console.log('\n=== Language-Agnostic Classification Tests ===\n');

// ---- Confirm needsSmartClassifier is removed ----

test('needsSmartClassifier is no longer exported (removed in v4.0.0)', () => {
  assert.strictEqual(typeof IntentRouter.needsSmartClassifier, 'undefined',
    'needsSmartClassifier was removed — language-agnostic LLM handles all messages');
});

// ---- buildClassificationPrompt: language injection ----

test('buildClassificationPrompt() is exported as a static function', () => {
  assert.strictEqual(typeof IntentRouter.buildClassificationPrompt, 'function');
});

test('buildClassificationPrompt("EN") contains English examples', () => {
  const prompt = IntentRouter.buildClassificationPrompt('EN');
  assert.ok(prompt.includes('Create a board for content planning'), 'Should have EN deck example');
  assert.ok(prompt.includes('Send an email to Alex'), 'Should have EN email example');
  assert.ok(prompt.includes('Book a meeting for Tuesday'), 'Should have EN calendar example');
});

test('buildClassificationPrompt("DE") contains German examples', () => {
  const prompt = IntentRouter.buildClassificationPrompt('DE');
  assert.ok(prompt.includes('Erstelle ein Board'), 'Should have DE deck example');
  assert.ok(prompt.includes('Schicke Alex eine E-Mail'), 'Should have DE email example');
  assert.ok(prompt.includes('Buche ein Meeting'), 'Should have DE calendar example');
  assert.ok(prompt.includes('Hallo'), 'Should have DE greeting example');
});

test('buildClassificationPrompt("PT") contains Portuguese examples', () => {
  const prompt = IntentRouter.buildClassificationPrompt('PT');
  assert.ok(prompt.includes('Cria um board'), 'Should have PT deck example');
  assert.ok(prompt.includes('Envia um email ao Alex'), 'Should have PT email example');
  assert.ok(prompt.includes('Olá'), 'Should have PT greeting example');
});

test('buildClassificationPrompt("FR") contains French examples', () => {
  const prompt = IntentRouter.buildClassificationPrompt('FR');
  assert.ok(prompt.includes('Crée un board'), 'Should have FR deck example');
  assert.ok(prompt.includes('Bonjour'), 'Should have FR greeting example');
});

test('buildClassificationPrompt("ES") contains Spanish examples', () => {
  const prompt = IntentRouter.buildClassificationPrompt('ES');
  assert.ok(prompt.includes('Crea un board'), 'Should have ES deck example');
  assert.ok(prompt.includes('Hola'), 'Should have ES greeting example');
});

test('buildClassificationPrompt falls back to EN for unknown language code', () => {
  const promptUnknown = IntentRouter.buildClassificationPrompt('XX');
  const promptEN = IntentRouter.buildClassificationPrompt('EN');
  assert.strictEqual(promptUnknown, promptEN, 'Unknown language falls back to EN');
});

test('buildClassificationPrompt handles lowercase language code', () => {
  const promptLower = IntentRouter.buildClassificationPrompt('de');
  const promptUpper = IntentRouter.buildClassificationPrompt('DE');
  assert.strictEqual(promptLower, promptUpper, 'Case-insensitive language matching');
});

test('buildClassificationPrompt handles composite code "DE+EN"', () => {
  const prompt = IntentRouter.buildClassificationPrompt('DE+EN');
  // Should split on '+' and use 'DE'
  assert.ok(prompt.includes('Erstelle ein Board'), 'Should use DE portion of composite code');
});

test('buildClassificationPrompt handles null/undefined gracefully', () => {
  const promptNull = IntentRouter.buildClassificationPrompt(null);
  const promptEN = IntentRouter.buildClassificationPrompt('EN');
  assert.strictEqual(promptNull, promptEN, 'null language falls back to EN');
  const promptUndef = IntentRouter.buildClassificationPrompt(undefined);
  assert.strictEqual(promptUndef, promptEN, 'undefined language falls back to EN');
});

// ---- All messages use fast model first (no pre-routing) ----

asyncTest('messages with memory verbs use smart model first', async () => {
  const models = [];
  const router = new IntentRouter({
    provider: {
      chat: async ({ model }) => {
        models.push(model);
        return { content: '{"gate":"action","domain":"wiki","confidence":0.9}' };
      }
    },
    config: { classifyTimeout: 5000 }
  });
  await router.classify('Remember that Sarah prefers video calls');
  assert.strictEqual(models[0], 'qwen3:8b', 'Smart model used first');
  assert.strictEqual(models.length, 1, 'Exactly one model call — smart model succeeded');
});

asyncTest('contextual references use smart model first', async () => {
  const models = [];
  const router = new IntentRouter({
    provider: {
      chat: async ({ model }) => {
        models.push(model);
        return { content: '{"gate":"action","domain":"deck","confidence":0.9}' };
      }
    },
    config: { classifyTimeout: 5000 }
  });
  await router.classify('move the most recent one to done', [
    { role: 'assistant', content: 'Here are your tasks: Fix bug, Update docs' }
  ]);
  assert.strictEqual(models[0], 'qwen3:8b', 'Smart model used first for contextual refs');
  assert.strictEqual(models.length, 1, 'No pre-routing needed — LLM gets context in prompt');
});

asyncTest('explicit action messages use smart model', async () => {
  const models = [];
  const router = new IntentRouter({
    provider: {
      chat: async ({ model }) => {
        models.push(model);
        return { content: '{"gate":"action","domain":"calendar","confidence":0.95}' };
      }
    },
    config: { classifyTimeout: 5000 }
  });
  await router.classify('Delete the Team Sync meeting');
  assert.strictEqual(models[0], 'qwen3:8b');
  assert.strictEqual(models.length, 1);
});

// ---- CLASSIFICATION_EXAMPLES exported correctly ----

test('CLASSIFICATION_EXAMPLES is exported and has expected languages', () => {
  const examples = IntentRouter.CLASSIFICATION_EXAMPLES;
  assert.ok(typeof examples === 'object', 'CLASSIFICATION_EXAMPLES should be an object');
  assert.ok('EN' in examples, 'Should have EN examples');
  assert.ok('DE' in examples, 'Should have DE examples');
  assert.ok('PT' in examples, 'Should have PT examples');
  assert.ok('FR' in examples, 'Should have FR examples');
  assert.ok('ES' in examples, 'Should have ES examples');
});

test('CLASSIFICATION_EXAMPLES each language has action/compound/knowledge/greeting', () => {
  for (const lang of ['EN', 'DE', 'PT', 'FR', 'ES']) {
    const ex = IntentRouter.CLASSIFICATION_EXAMPLES[lang];
    assert.ok('action' in ex, `${lang} should have action examples`);
    assert.ok('compound' in ex, `${lang} should have compound examples`);
    assert.ok('knowledge' in ex, `${lang} should have knowledge examples`);
    assert.ok('greeting' in ex, `${lang} should have greeting examples`);
  }
});

setTimeout(() => { summary(); exitWithCode(); }, 100);
