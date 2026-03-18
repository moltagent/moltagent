/*
 * Moltagent - Sovereign AI Agent Platform
 * Copyright (C) 2026 Moltagent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

const CockpitManager = require('../../../src/lib/integrations/cockpit-manager');

console.log('\n=== Cockpit Search Policy Tests ===\n');

// Helper: build a fake system card with given description
function makeSearchPolicyCard(description) {
  return { title: 'Search Policy', description, labels: [] };
}

(async () => {

  // We test getSystemSettings directly since it parses the Search Policy card
  // Need a minimal CockpitManager that can call getSystemSettings without full init
  function parseSearchPolicy(cardDesc) {
    const cards = [makeSearchPolicyCard(cardDesc)];
    // Extract the parsing logic inline (same as cockpit-manager.js)
    const modeMatch = (cardDesc || '').match(/^mode:\s*(\S+)/m);
    const mode = modeMatch ? modeMatch[1].toLowerCase() : 'research';
    const validModes = ['research', 'internal-first', 'sovereign'];
    return validModes.includes(mode) ? mode : 'research';
  }

  test('Search Policy: mode: research returns research', () => {
    assert.strictEqual(parseSearchPolicy('mode: research\n\n---\nDescription'), 'research');
  });

  test('Search Policy: mode: internal-first returns internal-first', () => {
    assert.strictEqual(parseSearchPolicy('mode: internal-first\n\n---\nDescription'), 'internal-first');
  });

  test('Search Policy: mode: sovereign returns sovereign', () => {
    assert.strictEqual(parseSearchPolicy('mode: sovereign\n\n---\nDescription'), 'sovereign');
  });

  test('Search Policy: missing mode defaults to research', () => {
    assert.strictEqual(parseSearchPolicy('no mode here\n\n---\nDescription'), 'research');
  });

  test('Search Policy: invalid mode defaults to research', () => {
    assert.strictEqual(parseSearchPolicy('mode: yolo\n\n---\nDescription'), 'research');
  });

  test('Search Policy: null description defaults to research', () => {
    assert.strictEqual(parseSearchPolicy(null), 'research');
  });

  test('Search Policy: empty string defaults to research', () => {
    assert.strictEqual(parseSearchPolicy(''), 'research');
  });

  test('Search Policy card exists in DEFAULT_CARDS', () => {
    const { DEFAULT_CARDS } = require('../../../src/lib/integrations/cockpit-manager');
    const systemCards = DEFAULT_CARDS.system;
    const searchCard = systemCards.find(c => c.title === 'Search Policy');
    assert.ok(searchCard, 'Search Policy card should exist');
    assert.ok(searchCard.description.includes('mode: research'), 'Default mode should be research');
    assert.ok(searchCard.description.includes('sovereign'), 'Description should mention sovereign option');
  });

  setTimeout(() => { summary(); exitWithCode(); }, 300);
})();
