/**
 * PageTemplates Unit Tests
 *
 * Run: node test/unit/knowledge/page-templates.test.js
 *
 * @module test/unit/knowledge/page-templates
 */

const assert = require('assert');
const { test, summary, exitWithCode } = require('../../helpers/test-runner');
const { TEMPLATES, getTemplate, applyTemplate } = require('../../../src/lib/knowledge/page-templates');
const { parseFrontmatter } = require('../../../src/lib/knowledge/frontmatter');

// ============================================================
// Tests
// ============================================================

console.log('PageTemplates Unit Tests\n');

// -- getTemplate tests --

test('getTemplate("research") returns correct frontmatter + body', () => {
  const template = getTemplate('research');
  assert.ok(template);
  assert.strictEqual(template.frontmatter.type, 'research');
  assert.strictEqual(template.frontmatter.decay_days, 30);
  assert.strictEqual(template.frontmatter.confidence, 'medium');
  assert.ok(template.body.includes('Summary'));
  assert.ok(template.body.includes('Key Findings'));
  assert.ok(template.body.includes('Sources'));
  assert.ok(template.body.includes('Confidence Assessment'));
  assert.ok(template.body.includes('Context'));
});

test('getTemplate("person") returns decay_days=90', () => {
  const template = getTemplate('person');
  assert.ok(template);
  assert.strictEqual(template.frontmatter.type, 'person');
  assert.strictEqual(template.frontmatter.decay_days, 90);
  assert.ok(template.body.includes('Role'));
  assert.ok(template.body.includes('Contact'));
  assert.ok(template.body.includes('Key Projects'));
});

test('getTemplate("project") returns decay_days=60', () => {
  const template = getTemplate('project');
  assert.ok(template);
  assert.strictEqual(template.frontmatter.type, 'project');
  assert.strictEqual(template.frontmatter.decay_days, 60);
  assert.strictEqual(template.frontmatter.status, 'active');
  assert.ok(template.body.includes('Overview'));
  assert.ok(template.body.includes('Current Status'));
  assert.ok(template.body.includes('Timeline'));
});

test('getTemplate("procedure") returns decay_days=180', () => {
  const template = getTemplate('procedure');
  assert.ok(template);
  assert.strictEqual(template.frontmatter.type, 'procedure');
  assert.strictEqual(template.frontmatter.decay_days, 180);
  assert.strictEqual(template.frontmatter.confidence, 'high');
  assert.ok(template.body.includes('Purpose'));
  assert.ok(template.body.includes('Prerequisites'));
  assert.ok(template.body.includes('Steps'));
  assert.ok(template.body.includes('Troubleshooting'));
});

test('getTemplate("unknown") returns null', () => {
  const template = getTemplate('unknown');
  assert.strictEqual(template, null);
});

test('getTemplate returns deep clone (mutations do not affect original)', () => {
  const t1 = getTemplate('research');
  t1.frontmatter.decay_days = 999;
  t1.frontmatter.tags.push('mutated');

  const t2 = getTemplate('research');
  assert.strictEqual(t2.frontmatter.decay_days, 30);
  assert.strictEqual(t2.frontmatter.tags.length, 0);
});

// -- applyTemplate tests --

test('applyTemplate("research", { query: "test" }) fills query field', () => {
  const result = applyTemplate('research', { query: 'test query' });
  assert.ok(result);
  const { frontmatter } = parseFrontmatter(result);
  assert.strictEqual(frontmatter.query, 'test query');
});

test('applyTemplate sets last_verified to today', () => {
  const result = applyTemplate('person', { title: 'Test Person' });
  assert.ok(result);
  const { frontmatter } = parseFrontmatter(result);
  const today = new Date().toISOString().split('T')[0];
  assert.strictEqual(frontmatter.last_verified, today);
});

test('applyTemplate merges custom data over defaults', () => {
  const result = applyTemplate('project', {
    confidence: 'high',
    status: 'completed',
    owner: 'Alice'
  });
  assert.ok(result);
  const { frontmatter } = parseFrontmatter(result);
  assert.strictEqual(frontmatter.confidence, 'high');
  assert.strictEqual(frontmatter.status, 'completed');
  assert.strictEqual(frontmatter.owner, 'Alice');
  assert.strictEqual(frontmatter.type, 'project'); // preserved from template
});

test('applyTemplate produces valid frontmatter (roundtrip parse)', () => {
  for (const type of ['research', 'person', 'project', 'procedure']) {
    const result = applyTemplate(type, { title: `Test ${type}` });
    assert.ok(result, `applyTemplate("${type}") returned falsy`);
    const { frontmatter, body } = parseFrontmatter(result);
    assert.strictEqual(frontmatter.type, type);
    assert.ok(body.length > 0, `body for "${type}" is empty`);
  }
});

test('applyTemplate("unknown") returns null', () => {
  const result = applyTemplate('unknown', {});
  assert.strictEqual(result, null);
});

test('all templates include expected body sections', () => {
  const expectations = {
    research: ['Summary', 'Key Findings', 'Sources', 'Confidence Assessment', 'Context'],
    person: ['Role', 'Contact', 'Key Projects', 'Notes'],
    project: ['Overview', 'Current Status', 'Key People', 'Timeline', 'Notes'],
    procedure: ['Purpose', 'Prerequisites', 'Steps', 'Troubleshooting', 'Related']
  };

  for (const [type, sections] of Object.entries(expectations)) {
    const template = getTemplate(type);
    for (const section of sections) {
      assert.ok(template.body.includes(section), `"${type}" template missing section "${section}"`);
    }
  }
});

// -- Summary --
summary();
exitWithCode();
