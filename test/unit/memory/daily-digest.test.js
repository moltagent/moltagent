/*
 * Moltagent - Sovereign AI Security Layer
 * Copyright (C) 2026 Moltagent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

'use strict';

const assert = require('assert');
const { asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const DailyDigest = require('../../../src/lib/memory/daily-digest');

const silentLogger = { log() {}, info() {}, warn() {}, error() {} };

function createMockWikiClient({ sessionPages = [], activityLog = null } = {}) {
  const pages = {};
  return {
    resolveCollective: async () => 1,
    searchPages: async (collectiveId, query) => sessionPages,
    readPageContent: async (path) => {
      if (pages[path]) return pages[path];
      if (activityLog && path.includes('Activity Log')) return activityLog;
      return null;
    },
    writePageContent: async (path, content) => { pages[path] = content; },
    getPages: () => pages
  };
}

function createMockRouter(narrative = 'A productive day.') {
  return {
    route: async () => ({ result: narrative })
  };
}

// TC-DD-01: generate() creates page for date with activity
asyncTest('TC-DD-01: generate() creates page for date with activity', async () => {
  const wiki = createMockWikiClient({ sessionPages: [{ title: 'Session 2026-03-01', id: 1 }] });
  const digest = new DailyDigest({ wikiClient: wiki, llmRouter: createMockRouter(), logger: silentLogger });

  const result = await digest.generate('2026-03-01');

  assert.strictEqual(result.written, true, 'Result should have written === true');

  const pages = wiki.getPages();
  assert.ok('Memory/Episodes/2026-03-01' in pages, 'Wiki pages should contain the episode path');

  const content = pages['Memory/Episodes/2026-03-01'];
  assert.ok(content && content.length > 0, 'Page content should not be empty');
});

// TC-DD-02: generate() skips when no activity
asyncTest('TC-DD-02: generate() skips when no activity', async () => {
  const wiki = createMockWikiClient({ sessionPages: [], activityLog: null });
  const digest = new DailyDigest({ wikiClient: wiki, logger: silentLogger });

  const result = await digest.generate('2026-03-02');

  assert.strictEqual(result.skipped, true, 'Result should have skipped === true when no activity');

  const pages = wiki.getPages();
  assert.ok(!('Memory/Episodes/2026-03-02' in pages), 'Wiki pages should NOT contain an episode for the date');
});

// TC-DD-03: generate() is idempotent (second call returns skipped)
asyncTest('TC-DD-03: generate() is idempotent (second call returns skipped)', async () => {
  const wiki = createMockWikiClient({ sessionPages: [{ title: 'Session 2026-03-01', id: 1 }] });
  const digest = new DailyDigest({ wikiClient: wiki, llmRouter: createMockRouter(), logger: silentLogger });

  const first = await digest.generate('2026-03-01');
  assert.strictEqual(first.written, true, 'First call should return written === true');

  const second = await digest.generate('2026-03-01');
  assert.strictEqual(second.skipped, true, 'Second call for same date should return skipped === true');
});

// TC-DD-04: _gatherSessions() returns found session pages
asyncTest('TC-DD-04: _gatherSessions() returns found session pages', async () => {
  const wiki = createMockWikiClient({
    sessionPages: [
      { title: 'Session 2026-03-01', id: 1 },
      { title: 'Other page', id: 2 }
    ]
  });
  const digest = new DailyDigest({ wikiClient: wiki, logger: silentLogger });

  const result = await digest._gatherSessions('2026-03-01');

  assert.ok(Array.isArray(result), '_gatherSessions() should return an array');

  // The filter keeps pages whose title includes 'session' (case-insensitive) OR the dateStr.
  // 'Session 2026-03-01' matches both criteria; 'Other page' matches neither.
  const hasSessionPage = result.some(p => {
    const t = (p.title || '').toLowerCase();
    return t.includes('session') || t.includes('2026-03-01');
  });
  assert.ok(hasSessionPage, 'Result should include the session page matching the date');
});

// TC-DD-05: _buildPage() includes frontmatter with decay_days: 30
asyncTest('TC-DD-05: _buildPage() includes frontmatter with decay_days: 30', async () => {
  const wiki = createMockWikiClient();
  const digest = new DailyDigest({ wikiClient: wiki, logger: silentLogger });

  const content = digest._buildPage(
    '2026-03-01',
    'A productive day.',
    { sessions: [{ title: 'S1' }], wikiChanges: [], deckActions: [] }
  );

  assert.ok(typeof content === 'string' && content.length > 0, '_buildPage() should return non-empty string');
  assert.ok(content.includes('decay_days: 30'), 'Content should include decay_days: 30');
  assert.ok(content.includes('type: episode'), 'Content should include type: episode');
  assert.ok(content.includes('date: 2026-03-01'), 'Content should include date: 2026-03-01');
});

// TC-DD-06: _buildPage() creates wikilinks to session pages
asyncTest('TC-DD-06: _buildPage() creates wikilinks to session pages', async () => {
  const wiki = createMockWikiClient();
  const digest = new DailyDigest({ wikiClient: wiki, logger: silentLogger });

  const content = digest._buildPage(
    '2026-03-01',
    'Summary.',
    {
      sessions: [{ title: 'Session Alpha' }, { title: 'Session Beta' }],
      wikiChanges: [],
      deckActions: []
    }
  );

  assert.ok(content.includes('[[Session Alpha]]'), 'Content should include wikilink [[Session Alpha]]');
  assert.ok(content.includes('[[Session Beta]]'), 'Content should include wikilink [[Session Beta]]');
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
