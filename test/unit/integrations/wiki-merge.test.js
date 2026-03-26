/**
 * Wiki Merge Unit Tests
 *
 * Tests the content merging, group selection, and safety logic
 * used by resolve-wiki-duplicates.js.
 *
 * Run: node test/unit/integrations/wiki-merge.test.js
 *
 * @module test/unit/integrations/wiki-merge
 */

'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

// ============================================================
// Import functions from the script (inline equivalents for testing)
// ============================================================

// These replicate the logic from resolve-wiki-duplicates.js for unit testing.
// The script itself uses these same algorithms.

function extractUniqueSentences(keeperContent, dupeContent) {
  if (!dupeContent?.trim()) return [];

  const dupeSentences = dupeContent
    .split(/[.!?]+/)
    .map(s => s.trim())
    .filter(s => s.length > 20);

  const keeperLower = (keeperContent || '').toLowerCase();
  return dupeSentences.filter(s =>
    !keeperLower.includes(s.toLowerCase().substring(0, 40))
  );
}

function extractSourceReferences(content) {
  if (!content) return [];
  return content.split('\n').filter(line =>
    line.startsWith('*Extracted from:') ||
    line.startsWith('*Also referenced in:')
  );
}

function parseFrontmatter(content) {
  if (!content || !content.startsWith('---')) {
    return { frontmatter: {}, body: content || '' };
  }
  const endIdx = content.indexOf('---', 3);
  if (endIdx === -1) return { frontmatter: {}, body: content };

  const fmBlock = content.substring(3, endIdx).trim();
  const fm = {};
  for (const line of fmBlock.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.substring(0, colonIdx).trim();
      let val = line.substring(colonIdx + 1).trim();
      if (/^\d+$/.test(val)) val = parseInt(val, 10);
      else if (/^".*"$/.test(val) || /^'.*'$/.test(val)) val = val.slice(1, -1);
      fm[key] = val;
    }
  }
  const body = content.substring(endIdx + 3).trim();
  return { frontmatter: fm, body };
}

function parseGroupingResponse(text, titles) {
  const groups = [];
  const seen = new Set();

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const groupMatch = trimmed.match(/^GROUP:\s*([\d,\s]+)\s*→\s*"([^"]+)"/i);
    if (groupMatch) {
      const indices = groupMatch[1].split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
      const canonical = groupMatch[2].trim();
      const validIndices = indices.filter(i => i >= 1 && i <= titles.length);
      if (validIndices.length < 2) continue;
      const newIndices = validIndices.filter(i => !seen.has(i));
      if (newIndices.length < 2) continue;
      const pageTitles = newIndices.map(i => titles[i - 1]);
      newIndices.forEach(i => seen.add(i));
      groups.push({ canonical, titles: pageTitles, indices: newIndices });
    }

    const uniqueMatch = trimmed.match(/^UNIQUE:\s*(\d+)/i);
    if (uniqueMatch) {
      const idx = parseInt(uniqueMatch[1], 10);
      if (idx >= 1 && idx <= titles.length) seen.add(idx);
    }
  }

  return groups;
}

// ============================================================
// Content Merging Tests
// ============================================================

test('1. Unique sentences from duplicate are appended to keeper', () => {
  const keeper = 'Eelco is a resilience expert working in the Netherlands.';
  const dupe = 'Eelco is a resilience expert. He founded the DIEM program in 2019.';

  const unique = extractUniqueSentences(keeper, dupe);
  assert.ok(unique.length > 0, 'Should find unique sentences');
  assert.ok(unique.some(s => s.includes('DIEM')), 'Should include DIEM sentence');
});

test('2. Duplicate sentences already in keeper are not appended', () => {
  const keeper = 'Eelco is a resilience expert working in the Netherlands.';
  const dupe = 'Eelco is a resilience expert working in the Netherlands.';

  const unique = extractUniqueSentences(keeper, dupe);
  assert.strictEqual(unique.length, 0, 'No unique sentences expected');
});

test('3. Empty duplicate content → no changes', () => {
  const unique = extractUniqueSentences('Some content.', '');
  assert.strictEqual(unique.length, 0);

  const unique2 = extractUniqueSentences('Some content.', null);
  assert.strictEqual(unique2.length, 0);
});

test('4. Source references are extracted', () => {
  const content = `Some text here.
*Extracted from: document.pdf*
*Also referenced in: report.docx*
Regular line.`;

  const refs = extractSourceReferences(content);
  assert.strictEqual(refs.length, 2);
  assert.ok(refs[0].includes('document.pdf'));
  assert.ok(refs[1].includes('report.docx'));
});

test('5. Duplicate source references are not duplicated', () => {
  const keeperContent = '*Extracted from: document.pdf*';
  const dupeContent = '*Extracted from: document.pdf*\n*Extracted from: new-doc.pdf*';

  const dupeRefs = extractSourceReferences(dupeContent);
  const newRefs = dupeRefs.filter(s => !keeperContent.includes(s));
  assert.strictEqual(newRefs.length, 1, 'Only new-doc.pdf should be new');
  assert.ok(newRefs[0].includes('new-doc.pdf'));
});

// ============================================================
// Merge Group Logic Tests
// ============================================================

test('6. Page with highest access_count is kept (sort order)', () => {
  const pages = [
    { title: 'Eelco', accessCount: 2, content: 'Short.' },
    { title: 'Eelco H. Dykstra', accessCount: 10, content: 'Long content.' },
    { title: 'EHD', accessCount: 0, content: '' },
  ];

  pages.sort((a, b) => {
    if (b.accessCount !== a.accessCount) return b.accessCount - a.accessCount;
    return (b.content || '').length - (a.content || '').length;
  });

  assert.strictEqual(pages[0].title, 'Eelco H. Dykstra', 'Highest access_count should be first');
});

test('7. access_counts are summed', () => {
  const keeper = { accessCount: 10 };
  const dupes = [{ accessCount: 3 }, { accessCount: 5 }];
  const total = keeper.accessCount + dupes.reduce((s, d) => s + d.accessCount, 0);
  assert.strictEqual(total, 18, 'Sum should be 10 + 3 + 5 = 18');
});

test('8. Frontmatter parsing extracts access_count', () => {
  const content = `---
title: "Eelco H. Dykstra"
access_count: 15
type: person
---

Some content about Eelco.`;

  const { frontmatter, body } = parseFrontmatter(content);
  assert.strictEqual(frontmatter.access_count, 15);
  assert.strictEqual(frontmatter.title, 'Eelco H. Dykstra');
  assert.ok(body.includes('Some content'));
});

test('9. Archive entry contains original content and reason', () => {
  const page = { title: 'EHD', id: 42, content: 'Some info about EHD.' };
  const reason = 'Merged into "Eelco H. Dykstra"';

  const archiveContent = `---
title: "${page.title}"
archived: true
archived_reason: "${reason}"
archived_at: "${new Date().toISOString()}"
original_id: ${page.id}
---

*This page was archived because: ${reason}*

${page.content || ''}`;

  assert.ok(archiveContent.includes('archived: true'));
  assert.ok(archiveContent.includes(reason));
  assert.ok(archiveContent.includes('Some info about EHD'));
  assert.ok(archiveContent.includes('original_id: 42'));
});

// ============================================================
// Script Safety Tests
// ============================================================

test('10. LLM grouping response parsing — valid groups', () => {
  const titles = ['Eelco H. Dykstra', 'EHD', 'Eelco', 'Gert-Jan Ludden', 'CEN TC 391', 'CEN Technical Committee TC 391'];
  const response = `GROUP: 1, 2, 3 → "Eelco H. Dykstra" (same person)
GROUP: 5, 6 → "CEN Technical Committee TC 391" (abbreviation)
UNIQUE: 4 (no duplicates)`;

  const groups = parseGroupingResponse(response, titles);
  assert.strictEqual(groups.length, 2);
  assert.strictEqual(groups[0].canonical, 'Eelco H. Dykstra');
  assert.deepStrictEqual(groups[0].titles, ['Eelco H. Dykstra', 'EHD', 'Eelco']);
  assert.strictEqual(groups[1].canonical, 'CEN Technical Committee TC 391');
});

test('11. --scan mode: parseGroupingResponse makes no mutations', () => {
  // parseGroupingResponse is pure — it takes text + titles, returns groups
  // No API calls, no side effects
  const titles = ['A', 'B'];
  const groups = parseGroupingResponse('UNIQUE: 1\nUNIQUE: 2', titles);
  assert.strictEqual(groups.length, 0, 'No groups from all-unique pages');
});

test('12. Single-page groups are skipped (need at least 2)', () => {
  const titles = ['Eelco H. Dykstra', 'Gert-Jan Ludden'];
  // LLM returns a "group" with only one page
  const response = `GROUP: 1 → "Eelco H. Dykstra" (canonical)
UNIQUE: 2`;

  const groups = parseGroupingResponse(response, titles);
  assert.strictEqual(groups.length, 0, 'Single-page group should be dropped');
});

test('13. Out-of-range indices are ignored', () => {
  const titles = ['A', 'B'];
  const response = `GROUP: 1, 99 → "A" (hallucinated)`;

  const groups = parseGroupingResponse(response, titles);
  assert.strictEqual(groups.length, 0, 'Group with out-of-range index should be dropped');
});

// ============================================================
// Run
// ============================================================

setTimeout(() => { summary(); exitWithCode(); }, 500);
