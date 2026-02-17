'use strict';

/**
 * Unit Tests for WarmMemory (Session M1)
 *
 * Tests warm memory load/save/consolidate, caching, line cap enforcement,
 * deduplication, and initial file creation.
 *
 * Run: node test/unit/integrations/warm-memory.test.js
 *
 * @module test/unit/integrations/warm-memory
 */

const assert = require('assert');
const { asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const WarmMemory = require('../../../src/lib/integrations/warm-memory');

// --- Mock NCFilesClient ---

function createMockNCFiles(store = {}) {
  let readCount = 0;
  let writeCount = 0;
  let mkdirCount = 0;

  return {
    readFile: async (path) => {
      readCount++;
      if (store[path] !== undefined) {
        return { content: store[path], truncated: false, totalSize: store[path].length };
      }
      const err = new Error('File not found');
      err.statusCode = 404;
      throw err;
    },
    writeFile: async (path, content) => {
      writeCount++;
      store[path] = content;
      return { success: true };
    },
    mkdir: async () => {
      mkdirCount++;
      return { success: true };
    },
    _store: store,
    getReadCount: () => readCount,
    getWriteCount: () => writeCount,
    getMkdirCount: () => mkdirCount
  };
}

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {}
};

// --- Tests ---

async function runTests() {
  console.log('\n=== WarmMemory Tests (Session M1) ===\n');

  await asyncTest('TC-WM-001: Load creates initial file on 404', async () => {
    const ncFiles = createMockNCFiles({});
    const wm = new WarmMemory({ ncFilesClient: ncFiles, logger: silentLogger });

    const content = await wm.load();

    assert.ok(content.includes('# Working Memory'), 'Should contain header');
    assert.ok(content.includes('## Where We Left Off'), 'Should contain continuation section');
    assert.ok(content.includes('## Open Items'), 'Should contain open items section');
    assert.ok(content.includes('## Key Context'), 'Should contain key context section');
    assert.strictEqual(ncFiles.getMkdirCount(), 1, 'Should create Memory/ dir');
    assert.strictEqual(ncFiles.getWriteCount(), 1, 'Should write initial file');
    assert.ok(ncFiles._store['Memory/WARM.md'], 'File should exist in store');
  });

  await asyncTest('TC-WM-002: Load returns cached content within TTL', async () => {
    const ncFiles = createMockNCFiles({ 'Memory/WARM.md': '# Cached content' });
    const wm = new WarmMemory({ ncFilesClient: ncFiles, logger: silentLogger });

    await wm.load();
    assert.strictEqual(ncFiles.getReadCount(), 1);

    const content = await wm.load();
    assert.strictEqual(ncFiles.getReadCount(), 1, 'Should NOT make second WebDAV call');
    assert.strictEqual(content, '# Cached content');
  });

  await asyncTest('TC-WM-003: Load fetches fresh after cache expires', async () => {
    const ncFiles = createMockNCFiles({ 'Memory/WARM.md': '# Original' });
    const wm = new WarmMemory({
      ncFilesClient: ncFiles,
      logger: silentLogger,
      config: { cacheTTLMs: 10 }
    });

    await wm.load();
    assert.strictEqual(ncFiles.getReadCount(), 1);

    await new Promise(r => setTimeout(r, 20));
    ncFiles._store['Memory/WARM.md'] = '# Updated';

    const content = await wm.load();
    assert.strictEqual(ncFiles.getReadCount(), 2, 'Should make second WebDAV call after TTL');
    assert.strictEqual(content, '# Updated');
  });

  await asyncTest('TC-WM-004: Load returns stale cache on non-404 error', async () => {
    let callCount = 0;
    const ncFiles = {
      readFile: async () => {
        callCount++;
        if (callCount === 1) {
          return { content: '# Stale data', truncated: false, totalSize: 12 };
        }
        throw new Error('Network timeout');
      },
      writeFile: async () => ({ success: true }),
      mkdir: async () => ({ success: true })
    };

    const wm = new WarmMemory({
      ncFilesClient: ncFiles,
      logger: silentLogger,
      config: { cacheTTLMs: 1 }
    });

    const first = await wm.load();
    assert.strictEqual(first, '# Stale data');

    await new Promise(r => setTimeout(r, 5));

    const second = await wm.load();
    assert.strictEqual(second, '# Stale data', 'Should return stale cache on error');
  });

  await asyncTest('TC-WM-005: Save writes content and updates cache', async () => {
    const ncFiles = createMockNCFiles({});
    const wm = new WarmMemory({ ncFilesClient: ncFiles, logger: silentLogger });

    await wm.save('# New content\nLine 2');

    assert.strictEqual(ncFiles._store['Memory/WARM.md'], '# New content\nLine 2');
    assert.strictEqual(ncFiles.getWriteCount(), 1);

    const content = await wm.load();
    assert.strictEqual(content, '# New content\nLine 2');
    assert.strictEqual(ncFiles.getReadCount(), 0, 'Should use cache from save, not call readFile');
  });

  await asyncTest('TC-WM-006: Save enforces line cap', async () => {
    const ncFiles = createMockNCFiles({});
    const wm = new WarmMemory({ ncFilesClient: ncFiles, logger: silentLogger, config: { maxLines: 20 } });

    const lines = ['# Working Memory', '', '## Where We Left Off'];
    for (let i = 0; i < 25; i++) {
      lines.push(`- Entry ${i}`);
    }
    lines.push('', '## Open Items');
    for (let i = 0; i < 15; i++) {
      lines.push(`- Item ${i}`);
    }
    lines.push('', '## Key Context', 'Some context');

    await wm.save(lines.join('\n'));

    const saved = ncFiles._store['Memory/WARM.md'];
    const savedLines = saved.split('\n');
    assert.ok(savedLines.length <= 20, `Should be <=20 lines, got ${savedLines.length}`);
  });

  await asyncTest('TC-WM-007: Consolidate merges continuation', async () => {
    const initial = [
      '# Working Memory', '',
      '## Where We Left Off',
      '- **2026-02-15:** Working on auth module.',
      '',
      '## Open Items', 'No open items.', '',
      '## Key Context', 'No context recorded yet.', '',
      '---', 'Last updated: 2026-02-15T00:00:00.000Z'
    ].join('\n');

    const ncFiles = createMockNCFiles({ 'Memory/WARM.md': initial });
    const wm = new WarmMemory({ ncFilesClient: ncFiles, logger: silentLogger });

    await wm.consolidate({
      continuation: 'Finished auth module, starting memory layer.',
      timestamp: '2026-02-17T10:00:00.000Z'
    });

    const saved = ncFiles._store['Memory/WARM.md'];
    assert.ok(saved.includes('Finished auth module'), 'Should contain new continuation');
    assert.ok(saved.includes('Working on auth module'), 'Should preserve old continuation');
    const newIdx = saved.indexOf('2026-02-17');
    const oldIdx = saved.indexOf('2026-02-15');
    assert.ok(newIdx < oldIdx, 'Newest continuation should be first');
  });

  await asyncTest('TC-WM-008: Consolidate merges open items', async () => {
    const initial = [
      '# Working Memory', '',
      '## Where We Left Off', 'No previous sessions yet.', '',
      '## Open Items',
      '- Review PR #42',
      '',
      '## Key Context', 'No context recorded yet.', '',
      '---', 'Last updated: 2026-02-15T00:00:00.000Z'
    ].join('\n');

    const ncFiles = createMockNCFiles({ 'Memory/WARM.md': initial });
    const wm = new WarmMemory({ ncFilesClient: ncFiles, logger: silentLogger });

    await wm.consolidate({
      openItems: '- Deploy staging\n- Test memory search'
    });

    const saved = ncFiles._store['Memory/WARM.md'];
    assert.ok(saved.includes('Review PR #42'), 'Should preserve existing item');
    assert.ok(saved.includes('Deploy staging'), 'Should add new item');
    assert.ok(saved.includes('Test memory search'), 'Should add second new item');
  });

  await asyncTest('TC-WM-009: Consolidate deduplicates open items', async () => {
    const initial = [
      '# Working Memory', '',
      '## Where We Left Off', 'No previous sessions yet.', '',
      '## Open Items',
      '- Deploy staging',
      '',
      '## Key Context', 'No context recorded yet.', '',
      '---', 'Last updated: 2026-02-15T00:00:00.000Z'
    ].join('\n');

    const ncFiles = createMockNCFiles({ 'Memory/WARM.md': initial });
    const wm = new WarmMemory({ ncFilesClient: ncFiles, logger: silentLogger });

    await wm.consolidate({
      openItems: '- Deploy staging\n- New item'
    });

    const saved = ncFiles._store['Memory/WARM.md'];
    const matches = saved.match(/Deploy staging/g);
    assert.strictEqual(matches.length, 1, 'Should not duplicate existing item');
    assert.ok(saved.includes('New item'), 'Should add genuinely new item');
  });

  await asyncTest('TC-WM-010: invalidateCache forces fresh load', async () => {
    const ncFiles = createMockNCFiles({ 'Memory/WARM.md': '# Version 1' });
    const wm = new WarmMemory({ ncFilesClient: ncFiles, logger: silentLogger });

    await wm.load();
    assert.strictEqual(ncFiles.getReadCount(), 1);

    ncFiles._store['Memory/WARM.md'] = '# Version 2';

    const cached = await wm.load();
    assert.strictEqual(cached, '# Version 1');
    assert.strictEqual(ncFiles.getReadCount(), 1);

    wm.invalidateCache();
    const fresh = await wm.load();
    assert.strictEqual(fresh, '# Version 2', 'Should fetch fresh after invalidation');
    assert.strictEqual(ncFiles.getReadCount(), 2);
  });

  console.log('\n=== WarmMemory Tests Complete ===\n');
  summary();
  exitWithCode();
}

runTests();
