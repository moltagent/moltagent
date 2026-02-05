/**
 * Frontmatter Parser/Serializer Unit Tests
 *
 * Run: node test/unit/knowledge/frontmatter.test.js
 *
 * @module test/unit/knowledge/frontmatter
 */

const assert = require('assert');
const { test, summary, exitWithCode } = require('../../helpers/test-runner');

// Import module under test
const { parseFrontmatter, serializeFrontmatter } = require('../../../src/lib/knowledge/frontmatter');

// ============================================================
// Tests
// ============================================================

console.log('Frontmatter Parser/Serializer Unit Tests\n');

// -- Parse Tests --

test('parse basic frontmatter (type, confidence, tags)', () => {
  const md = `---
type: person
confidence: high
last_verified: 2026-02-08
tags: [team, leadership]
---
# John Smith

VP of Marketing.
`;

  const { frontmatter, body } = parseFrontmatter(md);
  assert.strictEqual(frontmatter.type, 'person');
  assert.strictEqual(frontmatter.confidence, 'high');
  assert.strictEqual(frontmatter.last_verified, '2026-02-08');
  assert.ok(Array.isArray(frontmatter.tags));
  assert.strictEqual(frontmatter.tags.length, 2);
  assert.strictEqual(frontmatter.tags[0], 'team');
  assert.strictEqual(frontmatter.tags[1], 'leadership');
  assert.ok(body.includes('# John Smith'));
  assert.ok(body.includes('VP of Marketing'));
});

test('parse relationships array', () => {
  const md = `---
type: person
relationships:
  - leads: "[[Q3 Campaign]]"
  - reports_to: "[[CEO]]"
---
Content here.
`;

  const { frontmatter } = parseFrontmatter(md);
  assert.ok(Array.isArray(frontmatter.relationships));
  assert.strictEqual(frontmatter.relationships.length, 2);
  assert.strictEqual(frontmatter.relationships[0].leads, '[[Q3 Campaign]]');
  assert.strictEqual(frontmatter.relationships[1].reports_to, '[[CEO]]');
});

test('parse page with no frontmatter → empty object + full body', () => {
  const md = `# Just a Page

No frontmatter here.
`;

  const { frontmatter, body } = parseFrontmatter(md);
  assert.deepStrictEqual(frontmatter, {});
  assert.ok(body.includes('# Just a Page'));
});

test('parse numeric values', () => {
  const md = `---
decay_days: 90
version: 1.5
enabled: true
archived: false
---
Body.
`;

  const { frontmatter } = parseFrontmatter(md);
  assert.strictEqual(frontmatter.decay_days, 90);
  assert.strictEqual(frontmatter.version, 1.5);
  assert.strictEqual(frontmatter.enabled, true);
  assert.strictEqual(frontmatter.archived, false);
});

test('parse null values', () => {
  const md = `---
empty_field: null
tilde_null: ~
---
Body.
`;

  const { frontmatter } = parseFrontmatter(md);
  assert.strictEqual(frontmatter.empty_field, null);
  assert.strictEqual(frontmatter.tilde_null, null);
});

test('parse handles empty/null input gracefully', () => {
  assert.deepStrictEqual(parseFrontmatter('').frontmatter, {});
  assert.deepStrictEqual(parseFrontmatter(null).frontmatter, {});
  assert.deepStrictEqual(parseFrontmatter(undefined).frontmatter, {});
});

test('parse handles missing closing --- gracefully', () => {
  const md = `---
type: broken
no closing delimiter here
`;

  const { frontmatter, body } = parseFrontmatter(md);
  assert.deepStrictEqual(frontmatter, {});
  assert.ok(body.includes('---'));
});

test('parse block array with simple items', () => {
  const md = `---
items:
  - first
  - second
  - third
---
Body.
`;

  const { frontmatter } = parseFrontmatter(md);
  assert.ok(Array.isArray(frontmatter.items));
  assert.strictEqual(frontmatter.items.length, 3);
  assert.strictEqual(frontmatter.items[0], 'first');
});

// -- Serialize Tests --

test('serialize basic frontmatter', () => {
  const fm = { type: 'person', confidence: 'high' };
  const body = '# John Smith\n\nContent.';
  const result = serializeFrontmatter(fm, body);

  assert.ok(result.startsWith('---\n'));
  assert.ok(result.includes('type: person'));
  assert.ok(result.includes('confidence: high'));
  assert.ok(result.includes('\n---\n'));
  assert.ok(result.includes('# John Smith'));
});

test('serialize empty frontmatter returns body only', () => {
  const result = serializeFrontmatter({}, 'Just body');
  assert.strictEqual(result, 'Just body');
});

test('serialize null frontmatter returns body only', () => {
  const result = serializeFrontmatter(null, 'Just body');
  assert.strictEqual(result, 'Just body');
});

test('serialize inline array', () => {
  const fm = { tags: ['team', 'leadership'] };
  const result = serializeFrontmatter(fm, 'Body');
  assert.ok(result.includes('tags: [team, leadership]'));
});

test('serialize block array with objects', () => {
  const fm = {
    relationships: [
      { leads: '[[Q3 Campaign]]' },
      { reports_to: '[[CEO]]' }
    ]
  };
  const result = serializeFrontmatter(fm, 'Body');
  assert.ok(result.includes('relationships:'));
  assert.ok(result.includes('leads:'));
  assert.ok(result.includes('reports_to:'));
});

test('serialize boolean and number values', () => {
  const fm = { enabled: true, count: 42 };
  const result = serializeFrontmatter(fm, 'Body');
  assert.ok(result.includes('enabled: true'));
  assert.ok(result.includes('count: 42'));
});

test('serialize null value', () => {
  const fm = { removed: null };
  const result = serializeFrontmatter(fm, 'Body');
  assert.ok(result.includes('removed: null'));
});

// -- Roundtrip Tests --

test('serialize roundtrip: parse then serialize preserves data', () => {
  const original = `---
type: person
confidence: high
last_verified: 2026-02-08
tags: [team, leadership]
---
# John Smith

VP of Marketing.
`;

  const { frontmatter, body } = parseFrontmatter(original);
  const reserialized = serializeFrontmatter(frontmatter, body);
  const { frontmatter: fm2, body: body2 } = parseFrontmatter(reserialized);

  assert.strictEqual(fm2.type, 'person');
  assert.strictEqual(fm2.confidence, 'high');
  assert.strictEqual(fm2.last_verified, '2026-02-08');
  assert.deepStrictEqual(fm2.tags, ['team', 'leadership']);
  assert.ok(body2.includes('VP of Marketing'));
});

// ============================================================
// Summary
// ============================================================

summary();
exitWithCode();
