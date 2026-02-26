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
 * Cockpit Models Card Parsing Tests
 *
 * Validates _parsePlayersSection and _parseCustomModelsCard
 * correctly handle multi-model Players and Roster chains.
 *
 * Run: node test/unit/integrations/cockpit-models-card.test.js
 */

'use strict';

const assert = require('assert');
const { test, summary, exitWithCode } = require('../../helpers/test-runner');
const CockpitManager = require('../../../src/lib/integrations/cockpit-manager');

console.log('\n=== Cockpit Models Card Parsing Tests ===\n');

// Create a minimal CockpitManager to access parsing methods
function makeManager() {
  // CockpitManager constructor requires deckClient
  return new CockpitManager({
    deckClient: {
      listBoards: async () => [],
      ensureBoard: async () => ({ id: 1 }),
      getCardsInStack: async () => [],
      createCard: async () => ({ id: 1 })
    }
  });
}

// -- Test 1: Parse multiple local models from Players section --
test('_parsePlayersSection handles comma-separated local models', () => {
  const mgr = makeManager();
  const lines = [
    'local: phi4-mini, qwen3:8b (ollama)',
    'cloud: claude-sonnet-4-6, claude-opus-4-6 (anthropic, key: claude-api-key)'
  ];
  const players = mgr._parsePlayersSection(lines);

  assert.ok(players['phi4-mini'], 'Should have phi4-mini');
  assert.ok(players['qwen3:8b'], 'Should have qwen3:8b');
  assert.ok(players['claude-sonnet-4-6'], 'Should have claude-sonnet-4-6');
  assert.ok(players['claude-opus-4-6'], 'Should have claude-opus-4-6');

  assert.strictEqual(players['phi4-mini'].type, 'ollama');
  assert.strictEqual(players['phi4-mini'].local, true);
  assert.strictEqual(players['qwen3:8b'].type, 'ollama');
  assert.strictEqual(players['qwen3:8b'].local, true);

  assert.strictEqual(players['claude-sonnet-4-6'].type, 'anthropic');
  assert.strictEqual(players['claude-sonnet-4-6'].local, false);
  assert.strictEqual(players['claude-sonnet-4-6'].credentialLabel, 'claude-api-key');
});

// -- Test 2: Roster quick chain includes both local models --
test('Roster quick chain includes both local models', () => {
  const mgr = makeManager();
  const description = `Players:
local: phi4-mini, qwen3:8b (ollama)
cloud: claude-sonnet-4-6 (anthropic, key: claude-api-key)

Roster:
quick: phi4-mini \u2192 qwen3:8b \u2192 claude-sonnet-4-6
tools: qwen3:8b \u2192 phi4-mini \u2192 claude-sonnet-4-6

---

Your agent does six types of work.`;

  const result = mgr._parseCustomModelsCard(description);
  assert.ok(result, 'Should parse successfully');
  assert.ok(result.roster.quick, 'Should have quick roster');
  assert.deepStrictEqual(result.roster.quick, ['phi4-mini', 'qwen3:8b', 'claude-sonnet-4-6']);
});

// -- Test 3: Roster tools chain leads with qwen3:8b --
test('Roster tools chain leads with qwen3:8b', () => {
  const mgr = makeManager();
  const description = `Players:
local: phi4-mini, qwen3:8b (ollama)
cloud: claude-sonnet-4-6 (anthropic, key: claude-api-key)

Roster:
tools: qwen3:8b \u2192 phi4-mini \u2192 claude-sonnet-4-6

---

Explanation text.`;

  const result = mgr._parseCustomModelsCard(description);
  assert.ok(result, 'Should parse successfully');
  assert.deepStrictEqual(result.roster.tools, ['qwen3:8b', 'phi4-mini', 'claude-sonnet-4-6']);
});

// -- Test 4: Local fallback for cloud jobs is qwen3:8b --
test('thinking/writing roster uses qwen3:8b as local fallback', () => {
  const mgr = makeManager();
  const description = `Players:
local: phi4-mini, qwen3:8b (ollama)
cloud: claude-opus-4-6, claude-sonnet-4-6 (anthropic, key: claude-api-key)

Roster:
thinking: claude-opus-4-6 \u2192 claude-sonnet-4-6 \u2192 qwen3:8b
writing: claude-opus-4-6 \u2192 claude-sonnet-4-6 \u2192 qwen3:8b

---

Explanation text.`;

  const result = mgr._parseCustomModelsCard(description);
  assert.ok(result, 'Should parse successfully');

  const thinkingChain = result.roster.thinking;
  assert.ok(thinkingChain, 'Should have thinking roster');
  assert.strictEqual(thinkingChain[thinkingChain.length - 1], 'qwen3:8b',
    'Last fallback for thinking should be qwen3:8b');

  const writingChain = result.roster.writing;
  assert.strictEqual(writingChain[writingChain.length - 1], 'qwen3:8b',
    'Last fallback for writing should be qwen3:8b');
});

// -- Test 5: _findLocalDefault returns first local player --
test('_findLocalDefault returns first local player', () => {
  const mgr = makeManager();
  const players = {
    'phi4-mini': { type: 'ollama', local: true },
    'qwen3:8b': { type: 'ollama', local: true },
    'claude-sonnet-4-6': { type: 'anthropic', local: false }
  };
  const result = mgr._findLocalDefault(players);
  assert.strictEqual(result, 'phi4-mini', 'First local player should be phi4-mini');
});

setTimeout(() => { summary(); exitWithCode(); }, 100);
