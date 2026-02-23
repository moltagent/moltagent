/**
 * Cockpit Modes Unit Tests
 *
 * Tests for mode constants and normalizer.
 *
 * Run: node test/unit/integrations/cockpit-modes.test.js
 */

const assert = require('assert');
const { test, summary, exitWithCode } = require('../../helpers/test-runner');

const { MODES, TITLE_MAP, normalizeModeName } = require('../../../src/lib/integrations/cockpit-modes');

console.log('\n=== Cockpit Modes Tests ===\n');

test('TC-MODE-001: MODES exports all 5 slugs', () => {
  const expected = ['full-auto', 'focus-mode', 'meeting-day', 'creative-session', 'out-of-office'];
  const actual = Object.values(MODES);
  assert.strictEqual(actual.length, 5, 'Should have exactly 5 modes');
  for (const slug of expected) {
    assert.ok(actual.includes(slug), `Missing mode: ${slug}`);
  }
});

test('TC-MODE-002: normalizeModeName maps each card title correctly', () => {
  assert.strictEqual(normalizeModeName('Full Auto'), 'full-auto');
  assert.strictEqual(normalizeModeName('Focus Mode'), 'focus-mode');
  assert.strictEqual(normalizeModeName('Meeting Day'), 'meeting-day');
  assert.strictEqual(normalizeModeName('Creative Session'), 'creative-session');
  assert.strictEqual(normalizeModeName('Out of Office'), 'out-of-office');
});

test('TC-MODE-003: normalizeModeName returns full-auto for unknown/null input', () => {
  assert.strictEqual(normalizeModeName(null), 'full-auto');
  assert.strictEqual(normalizeModeName(undefined), 'full-auto');
  assert.strictEqual(normalizeModeName(''), 'full-auto');
  assert.strictEqual(normalizeModeName('Unknown Mode'), 'full-auto');
});

test('TC-MODE-004: TITLE_MAP covers all 5 card titles', () => {
  const titles = Object.keys(TITLE_MAP);
  assert.strictEqual(titles.length, 5, 'TITLE_MAP should have exactly 5 entries');
  assert.ok(titles.includes('Full Auto'));
  assert.ok(titles.includes('Focus Mode'));
  assert.ok(titles.includes('Meeting Day'));
  assert.ok(titles.includes('Creative Session'));
  assert.ok(titles.includes('Out of Office'));
});

summary();
exitWithCode();
