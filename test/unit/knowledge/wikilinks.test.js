/**
 * Wikilinks Unit Tests
 *
 * Run: node test/unit/knowledge/wikilinks.test.js
 *
 * @module test/unit/knowledge/wikilinks
 */

const assert = require('assert');
const { test, summary, exitWithCode } = require('../../helpers/test-runner');
const { extractWikilinks, replaceWikilinks } = require('../../../src/lib/knowledge/wikilinks');

// ============================================================
// Tests
// ============================================================

console.log('Wikilinks Unit Tests\n');

// -- extractWikilinks tests --

test('extractWikilinks extracts page names from [[wikilinks]]', () => {
  const result = extractWikilinks('See [[Page A]] and [[Page B]] for details.');
  assert.deepStrictEqual(result, ['Page A', 'Page B']);
});

test('extractWikilinks deduplicates repeated links', () => {
  const result = extractWikilinks('See [[Alpha]] then [[Beta]] then [[Alpha]] again.');
  assert.deepStrictEqual(result, ['Alpha', 'Beta']);
});

test('extractWikilinks returns empty array for text without wikilinks', () => {
  const result = extractWikilinks('This is plain text with no links.');
  assert.deepStrictEqual(result, []);
});

test('extractWikilinks handles nested brackets gracefully', () => {
  // [[inner]] inside regular brackets should still work
  const result = extractWikilinks('Some [text with [[Inner Link]] inside]');
  assert.deepStrictEqual(result, ['Inner Link']);
});

test('extractWikilinks skips empty [[]]', () => {
  const result = extractWikilinks('Empty [[]] should be skipped but [[Valid]] kept.');
  assert.deepStrictEqual(result, ['Valid']);
});

test('extractWikilinks handles null/undefined input', () => {
  assert.deepStrictEqual(extractWikilinks(null), []);
  assert.deepStrictEqual(extractWikilinks(undefined), []);
  assert.deepStrictEqual(extractWikilinks(''), []);
});

test('extractWikilinks handles wikilinks with special characters', () => {
  const result = extractWikilinks('See [[Q3 Report (2026)]] and [[John O\'Brien]]');
  assert.deepStrictEqual(result, ['Q3 Report (2026)', 'John O\'Brien']);
});

test('extractWikilinks trims whitespace from page names', () => {
  const result = extractWikilinks('See [[ Spaced Name ]] here.');
  assert.deepStrictEqual(result, ['Spaced Name']);
});

// -- replaceWikilinks tests --

test('replaceWikilinks calls replacer for each link', () => {
  const called = [];
  replaceWikilinks('See [[Alpha]] and [[Beta]].', (name) => {
    called.push(name);
    return `[${name}]`;
  });
  assert.deepStrictEqual(called, ['Alpha', 'Beta']);
});

test('replaceWikilinks preserves non-link text', () => {
  const result = replaceWikilinks('Hello [[World]] bye', (name) => `<${name}>`);
  assert.strictEqual(result, 'Hello <World> bye');
});

test('replaceWikilinks returns original if no links', () => {
  const result = replaceWikilinks('No links here', (name) => `<${name}>`);
  assert.strictEqual(result, 'No links here');
});

test('replaceWikilinks handles null input', () => {
  const result = replaceWikilinks(null, (name) => name);
  assert.strictEqual(result, '');
});

test('replaceWikilinks handles non-function replacer', () => {
  const result = replaceWikilinks('See [[Link]]', 'not a function');
  assert.strictEqual(result, 'See [[Link]]');
});

// -- Summary --
summary();
exitWithCode();
