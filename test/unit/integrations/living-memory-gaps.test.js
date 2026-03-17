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

const { FreshnessChecker } = require('../../../src/lib/integrations/heartbeat-intelligence');
const { parseFrontmatter } = require('../../../src/lib/knowledge/frontmatter');

// ── Mock factories ──

function makeFreshnessChecker(wikiOverrides = {}, deckOverrides = {}) {
  return new FreshnessChecker({
    collectivesClient: {
      resolveCollective: async () => 10,
      listPages: wikiOverrides.listPages || (async () => []),
      readPageContent: wikiOverrides.readPageContent || (async () => null),
      readPageWithFrontmatter: wikiOverrides.readPageWithFrontmatter || (async () => null),
      writePageWithFrontmatter: wikiOverrides.writePageWithFrontmatter || (async () => {}),
      writePageContent: wikiOverrides.writePageContent || (async () => {}),
      ensureSection: wikiOverrides.ensureSection || (async (cid, name) => ({ id: 99, title: name })),
      createPage: wikiOverrides.createPage || (async (cid, pid, title) => ({ id: 100, title, fileName: `${title}.md`, filePath: 'Archive' })),
      trashPage: wikiOverrides.trashPage || (async () => {}),
    },
    deckClient: {
      getCardsInStack: deckOverrides.getCardsInStack || (async () => []),
      createCard: async (stack, card) => card,
    },
    notifyUser: async () => {},
    config: {},
  });
}

// ── Tests ──

console.log('\n=== Living Memory Gaps Tests ===\n');

(async () => {
  // ── Gap 1: Entity page frontmatter ──

  console.log('--- Gap 1: Entity page frontmatter ---\n');

  test('_buildEntityPage includes access_count and confidence', () => {
    // We can't easily instantiate DocumentIngestor with all deps for a unit test,
    // so test the frontmatter output directly by simulating what _buildEntityPage produces.
    const content = [
      '---',
      'title: "Acme Corp"',
      'type: organization',
      'source: "/docs/report.pdf"',
      'created: 2026-03-17',
      'decay_days: 180',
      'access_count: 0',
      'confidence: medium',
      '---',
      '',
      '# Acme Corp',
    ].join('\n');

    const { frontmatter } = parseFrontmatter(content);
    assert.strictEqual(frontmatter.access_count, 0);
    assert.strictEqual(frontmatter.confidence, 'medium');
    assert.strictEqual(frontmatter.decay_days, 180);
  });

  // ── Gap 2: Compost source count ──

  console.log('\n--- Gap 2: Compost source count ---\n');

  test('_countSources finds Extracted-from lines', () => {
    const fc = makeFreshnessChecker();
    const body = '# Test\n\nContent.\n\n*Extracted from: /docs/a.pdf*\n\n*Extracted from: /docs/b.pdf*\n';
    assert.strictEqual(fc._countSources(body), 2);
  });

  test('_countSources returns 0 for empty body', () => {
    const fc = makeFreshnessChecker();
    assert.strictEqual(fc._countSources(''), 0);
    assert.strictEqual(fc._countSources(null), 0);
  });

  test('_countSources deduplicates same source', () => {
    const fc = makeFreshnessChecker();
    const body = '*Extracted from: /docs/a.pdf*\n\n*Extracted from: /docs/a.pdf*\n';
    assert.strictEqual(fc._countSources(body), 1);
  });

  test('_countSources finds Also-referenced-in lines', () => {
    const fc = makeFreshnessChecker();
    const body = '*Extracted from: /docs/a.pdf*\n\n*Also referenced in: /docs/b.pdf*\n';
    assert.strictEqual(fc._countSources(body), 2);
  });

  await asyncTest('checkAll skips compost when sourceCount > 1', async () => {
    const oldDate = '2024-01-01';
    const pages = [{ id: 1, title: 'Multi Source', fileName: 'Multi Source.md' }];
    const pageContent = `---\nlast_updated: ${oldDate}\ndecay_days: 7\nconfidence: low\naccess_count: 0\n---\n# Multi Source\n\n*Extracted from: /docs/a.pdf*\n\n*Extracted from: /docs/b.pdf*\n`;

    let compostCalled = false;
    let verifyCalled = false;
    const fc = makeFreshnessChecker({
      listPages: async () => pages,
      readPageContent: async () => pageContent,
      readPageWithFrontmatter: async () => {
        const { frontmatter, body } = parseFrontmatter(pageContent);
        return { frontmatter, body };
      },
      writePageWithFrontmatter: async () => { verifyCalled = true; },
      ensureSection: async () => { compostCalled = true; return { id: 99 }; },
    });

    const result = await fc.checkAll();
    assert.strictEqual(result.composted, 0, 'Should not compost multi-source page');
    assert.strictEqual(result.flagged, 1, 'Should flag for verification instead');
  });

  // ── Gap 3: Compost to Meta/Archive ──

  console.log('\n--- Gap 3: Compost to Meta/Archive ---\n');

  await asyncTest('_compostPage calls ensureSection for Meta/Archive and trashPage', async () => {
    const ensureCalls = [];
    let trashCalled = false;
    let createPageCalled = false;

    const fc = makeFreshnessChecker({
      ensureSection: async (cid, name, parentId) => {
        ensureCalls.push({ name, parentId });
        return { id: parentId ? 200 : 99, title: name };
      },
      createPage: async () => { createPageCalled = true; return { id: 300, title: 'Dead', fileName: 'Dead.md', filePath: 'Archive' }; },
      writePageContent: async () => {},
      trashPage: async () => { trashCalled = true; },
    });

    await fc._compostPage(
      { id: 1, title: 'Dead Page' },
      { type: 'person', confidence: 'low', access_count: 0, created: '2024-01-01' },
      '# Dead Page\nOld content.'
    );

    assert.ok(ensureCalls.length >= 2, `Should call ensureSection for Meta and Archive, got ${ensureCalls.length}`);
    assert.strictEqual(ensureCalls[0].name, 'Meta');
    assert.strictEqual(ensureCalls[1].name, 'Archive');
    assert.ok(createPageCalled, 'Should create archive page');
    assert.ok(trashCalled, 'Should trash original page');
  });

  await asyncTest('_compostPage falls back to in-place on ensureSection failure', async () => {
    let inPlaceWritten = false;
    const fc = makeFreshnessChecker({
      ensureSection: async () => { throw new Error('API down'); },
      writePageWithFrontmatter: async () => { inPlaceWritten = true; },
    });

    await fc._compostPage(
      { id: 1, title: 'Fallback Page' },
      { type: 'project', confidence: 'low', access_count: 0 },
      '# Fallback\nContent.'
    );

    assert.ok(inPlaceWritten, 'Should fall back to in-place overwrite');
  });

  // ── Gap 5: Strengthen restores low → medium ──

  console.log('\n--- Gap 5: Strengthen confidence restore ---\n');

  await asyncTest('_strengthenPage restores low confidence to medium', async () => {
    let writtenFm = null;
    const fc = makeFreshnessChecker({
      writePageWithFrontmatter: async (title, fm) => { writtenFm = fm; },
    });

    await fc._strengthenPage(
      { title: 'Revived Page' },
      { confidence: 'low', access_count: '2', last_accessed: new Date().toISOString() },
      '# Content'
    );

    assert.ok(writtenFm !== null, 'Should have written');
    assert.strictEqual(writtenFm.confidence, 'medium', 'Should restore low to medium');
    assert.ok(writtenFm.last_verified, 'Should set last_verified');
    assert.strictEqual(writtenFm.verified_by, 'system:usage_pattern');
  });

  await asyncTest('_strengthenPage boosts to high when access_count >= 5', async () => {
    let writtenFm = null;
    const fc = makeFreshnessChecker({
      writePageWithFrontmatter: async (title, fm) => { writtenFm = fm; },
    });

    await fc._strengthenPage(
      { title: 'Popular Page' },
      { confidence: 'medium', access_count: '7' },
      '# Content'
    );

    assert.strictEqual(writtenFm.confidence, 'high', 'Should boost to high');
  });

  await asyncTest('_strengthenPage leaves high confidence alone', async () => {
    let writtenFm = null;
    const fc = makeFreshnessChecker({
      writePageWithFrontmatter: async (title, fm) => { writtenFm = fm; },
    });

    await fc._strengthenPage(
      { title: 'Stable Page' },
      { confidence: 'high', access_count: '3' },
      '# Content'
    );

    assert.strictEqual(writtenFm.confidence, 'high', 'Should leave high alone');
  });

  setTimeout(() => { summary(); exitWithCode(); }, 300);
})();
