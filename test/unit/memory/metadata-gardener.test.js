/*
 * MoltAgent - Sovereign AI Security Layer
 * Copyright (C) 2026 MoltAgent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

// NOTE: Collectives WebDAV requires pages to exist in
// OCS database before PUT. Mocks should reject PUT to
// non-existent pages to catch this class of bug.
// See: 2026-03-05 triple production failure diagnostic.

'use strict';
// Mock type: LEGACY — TODO: migrate to realistic mocks

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const MetadataGardener = require('../../../src/lib/memory/metadata-gardener');

const silentLogger = { log() {}, info() {}, warn() {}, error() {} };

function createMockRouter(yamlResponse) {
  return {
    route: async () => ({ result: yamlResponse || 'type: note\nconfidence: low' })
  };
}

function createMockCollectivesClient(pages = [], contentMap = {}) {
  const written = {};
  return {
    resolveCollective: async () => 1,
    listPages: async () => pages,
    readPageContent: async (path) => {
      if (contentMap[path] !== undefined) return contentMap[path];
      return null;
    },
    writePageContent: async (path, content) => {
      written[path] = content;
    },
    getWritten: () => written
  };
}

// -- Test 1: Page without frontmatter gets type added --
asyncTest('Page without frontmatter gets type + fields added', async () => {
  const content = 'Sarah Chen is a senior developer at TheCatalyne. She works on the onboarding pipeline.';
  const client = createMockCollectivesClient(
    [{ title: 'Sarah Chen', filePath: 'People', fileName: 'Sarah Chen.md' }],
    { 'People/Sarah Chen.md': content }
  );
  const router = createMockRouter('type: person\nconfidence: high\ncompany: TheCatalyne\nrole: senior developer');
  const gardener = new MetadataGardener({ collectivesClient: client, router, logger: silentLogger });

  const result = await gardener.tend();

  assert.strictEqual(result.gardened, 1, 'Should garden 1 page');
  const written = client.getWritten()['People/Sarah Chen.md'];
  assert.ok(written, 'Should have written page back');
  assert.ok(written.includes('type: person'), 'Should include type: person');
  assert.ok(written.includes('company: TheCatalyne'), 'Should include company field');
  assert.ok(written.includes(content), 'Original content should be preserved');
});

// -- Test 2: Page with partial frontmatter preserves existing fields --
asyncTest('Partial frontmatter preserved — type added, last_accessed kept', async () => {
  const content = '---\nlast_accessed: "2026-03-05T13:00:00Z"\naccess_count: 5\n---\n\nSome project details.';
  const client = createMockCollectivesClient(
    [{ title: 'Project X', filePath: 'Projects', fileName: 'Project X.md' }],
    { 'Projects/Project X.md': content }
  );
  const router = createMockRouter('type: project\nconfidence: medium\ngoal: automation');
  const gardener = new MetadataGardener({ collectivesClient: client, router, logger: silentLogger });

  const result = await gardener.tend();

  assert.strictEqual(result.gardened, 1);
  const written = client.getWritten()['Projects/Project X.md'];
  assert.ok(written.includes('type: project'), 'Should add type');
  assert.ok(written.includes('last_accessed:'), 'Should preserve last_accessed');
  assert.ok(written.includes('access_count: 5'), 'Should preserve access_count');
});

// -- Test 3: Page with complete frontmatter (has type) is skipped --
asyncTest('Page with complete frontmatter is skipped', async () => {
  const content = '---\ntype: person\nconfidence: high\n---\n\nAlready typed content.';
  const client = createMockCollectivesClient(
    [{ title: 'Complete Page', filePath: 'People', fileName: 'Complete Page.md' }],
    { 'People/Complete Page.md': content }
  );
  const router = createMockRouter('type: person');
  const gardener = new MetadataGardener({ collectivesClient: client, router, logger: silentLogger });

  const result = await gardener.tend();

  assert.strictEqual(result.gardened, 0, 'Should not garden already-typed pages');
  assert.strictEqual(result.queued, 0, 'Queue should be empty');
});

// -- Test 4: Meta/ pages are skipped --
asyncTest('Meta/ pages excluded from gardening', async () => {
  const client = createMockCollectivesClient(
    [
      { title: 'Learning Log', filePath: 'Meta', fileName: 'Learning Log.md' },
      { title: 'Real Page', filePath: 'Notes', fileName: 'Real Page.md' }
    ],
    {
      'Meta/Learning Log.md': 'Some meta documentation content here, enough chars.',
      'Notes/Real Page.md': 'This is a real knowledge page with enough content.'
    }
  );
  const router = createMockRouter('type: note\nconfidence: low');
  const gardener = new MetadataGardener({ collectivesClient: client, router, logger: silentLogger });

  const result = await gardener.tend();

  assert.strictEqual(result.gardened, 1, 'Should garden 1 page (Meta skipped)');
  const written = client.getWritten();
  assert.ok(!written['Meta/Learning Log.md'], 'Meta page should not be written');
});

// -- Test 5: Stub pages (< 30 chars) are skipped --
asyncTest('Stub pages under 30 chars are skipped', async () => {
  const client = createMockCollectivesClient(
    [{ title: 'Stub', filePath: 'Notes', fileName: 'Stub.md' }],
    { 'Notes/Stub.md': 'too short' }
  );
  const router = createMockRouter('type: note');
  const gardener = new MetadataGardener({ collectivesClient: client, router, logger: silentLogger });

  const result = await gardener.tend();

  assert.strictEqual(result.gardened, 0, 'Should not garden stubs');
  assert.strictEqual(result.queued, 0, 'Queue should be empty');
});

// -- Test 6: Recently accessed pages gardened before old pages --
asyncTest('Priority ordering: recently accessed pages first', async () => {
  const today = new Date().toISOString();
  const oldDate = '2025-01-01T00:00:00Z';
  const client = createMockCollectivesClient(
    [
      { title: 'Old Page', filePath: 'Notes', fileName: 'Old Page.md' },
      { title: 'Recent Page', filePath: 'Notes', fileName: 'Recent Page.md' }
    ],
    {
      'Notes/Old Page.md': `---\nlast_accessed: "${oldDate}"\n---\n\nOld content that needs gardening and is long enough.`,
      'Notes/Recent Page.md': `---\nlast_accessed: "${today}"\n---\n\nRecent content that needs gardening and is long enough.`
    }
  );
  const gardenOrder = [];
  const router = {
    route: async ({ content }) => {
      // Track which page was gardened by checking the prompt content
      if (content.includes('Recent Page')) gardenOrder.push('Recent');
      if (content.includes('Old Page')) gardenOrder.push('Old');
      return { result: 'type: note\nconfidence: low' };
    }
  };
  const gardener = new MetadataGardener({
    collectivesClient: client, router, logger: silentLogger, pagesPerTick: 10
  });

  await gardener.tend();

  assert.strictEqual(gardenOrder[0], 'Recent', 'Recently accessed page should be gardened first');
});

// -- Test 7: LLM failure on one page does not abort batch --
asyncTest('LLM failure on one page does not abort batch', async () => {
  let callCount = 0;
  const client = createMockCollectivesClient(
    [
      { title: 'Page A', filePath: 'Notes', fileName: 'Page A.md' },
      { title: 'Page B', filePath: 'Notes', fileName: 'Page B.md' }
    ],
    {
      'Notes/Page A.md': 'Page A has content that is long enough for processing here.',
      'Notes/Page B.md': 'Page B also has content that is long enough for processing.'
    }
  );
  const router = {
    route: async () => {
      callCount++;
      if (callCount === 1) throw new Error('LLM timeout');
      return { result: 'type: note\nconfidence: low' };
    }
  };
  const gardener = new MetadataGardener({
    collectivesClient: client, router, logger: silentLogger, pagesPerTick: 10
  });

  const result = await gardener.tend();

  assert.strictEqual(result.gardened, 1, 'Should garden 1 page (other failed)');
});

// -- Test 8: pagesPerTick limits gardening --
asyncTest('pagesPerTick=1 limits gardening to 1 page per tick', async () => {
  const client = createMockCollectivesClient(
    [
      { title: 'P1', filePath: 'Notes', fileName: 'P1.md' },
      { title: 'P2', filePath: 'Notes', fileName: 'P2.md' },
      { title: 'P3', filePath: 'Notes', fileName: 'P3.md' }
    ],
    {
      'Notes/P1.md': 'Page 1 content that is long enough for the gardener to process.',
      'Notes/P2.md': 'Page 2 content that is long enough for the gardener to process.',
      'Notes/P3.md': 'Page 3 content that is long enough for the gardener to process.'
    }
  );
  const router = createMockRouter('type: note\nconfidence: low');
  const gardener = new MetadataGardener({
    collectivesClient: client, router, logger: silentLogger, pagesPerTick: 1
  });

  const result1 = await gardener.tend();
  assert.strictEqual(result1.gardened, 1, 'First tick: garden 1');
  assert.strictEqual(result1.queued, 2, 'First tick: 2 remaining');

  const result2 = await gardener.tend();
  assert.strictEqual(result2.gardened, 1, 'Second tick: garden 1');
  assert.strictEqual(result2.queued, 1, 'Second tick: 1 remaining');
});

// -- Test 9: Top-level page (empty filePath) builds path from fileName --
asyncTest('Top-level page with empty filePath builds correct path', async () => {
  const content = 'Landing page content that is long enough for the gardener.';
  const client = createMockCollectivesClient(
    [{ title: 'Landing', filePath: '', fileName: 'Landing.md' }],
    { 'Landing.md': content }
  );
  const router = createMockRouter('type: note\nconfidence: low');
  const gardener = new MetadataGardener({ collectivesClient: client, router, logger: silentLogger });

  const result = await gardener.tend();

  assert.strictEqual(result.gardened, 1, 'Should garden top-level page');
  const written = client.getWritten()['Landing.md'];
  assert.ok(written, 'Should write to fileName-only path');
  assert.ok(written.includes('type: note'), 'Should include type');
});

// -- Test 10: First failed typing attempt → logged, page re-queued --
asyncTest('First failed typing attempt logs warning, page re-queued', async () => {
  const content = 'Hotfix test page with enough content for processing.';
  const client = createMockCollectivesClient(
    [{ id: 99, title: 'Hotfix Test', filePath: 'Notes', fileName: 'Hotfix Test.md' }],
    { 'Notes/Hotfix Test.md': content }
  );
  // Router returns no type field
  const router = createMockRouter('confidence: low\ntopic: unknown');
  const warnings = [];
  const logger = { log() {}, info() {}, warn(m) { warnings.push(m); }, error() {} };
  const gardener = new MetadataGardener({ collectivesClient: client, router, logger, pagesPerTick: 10 });

  await gardener.tend();

  assert.strictEqual(Object.keys(client.getWritten()).length, 0, 'Should not write on first fail');
  assert.ok(warnings.some(w => w.includes('attempt 1/2')), 'Should log attempt 1/2');
});

// -- Test 11: Second failed attempt → type: note assigned --
asyncTest('Second failed attempt assigns type: note with gardener_assigned', async () => {
  const content = 'Hotfix test page with enough content for processing.';
  const client = createMockCollectivesClient(
    [{ id: 99, title: 'Hotfix Test', filePath: 'Notes', fileName: 'Hotfix Test.md' }],
    { 'Notes/Hotfix Test.md': content }
  );
  const router = createMockRouter('confidence: low\ntopic: unknown');
  const infos = [];
  const logger = { log() {}, info(m) { infos.push(m); }, warn() {}, error() {} };
  const gardener = new MetadataGardener({ collectivesClient: client, router, logger, pagesPerTick: 10 });

  // First attempt — fails, re-queued
  await gardener.tend();
  // Second attempt — should fallback to type: note
  await gardener.tend();

  const written = client.getWritten()['Notes/Hotfix Test.md'];
  assert.ok(written, 'Should have written page on second attempt');
  assert.ok(written.includes('type: note'), 'Should assign type: note');
  assert.ok(written.includes('gardener_assigned: true'), 'Should mark gardener_assigned');
  assert.ok(infos.some(i => i.includes('assigning type: note')), 'Should log assignment');
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
