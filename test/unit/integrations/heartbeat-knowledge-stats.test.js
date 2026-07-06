// Mock type: LEGACY — TODO: migrate to realistic mocks
/**
 * HeartbeatManager Knowledge Stats Tests
 *
 * Tests for the auto-updating "Meta/Knowledge Stats" wiki page.
 *
 * Run: node test/unit/integrations/heartbeat-knowledge-stats.test.js
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

const HeartbeatManager = require('../../../src/lib/integrations/heartbeat-manager');

// ============================================================================
// Factory
// ============================================================================

function createMinimalHeartbeat(overrides = {}) {
  return new HeartbeatManager({
    nextcloud: { url: 'https://nc.test', username: 'moltagent' },
    deck: { boardId: 1, stacks: {} },
    caldav: {},
    heartbeat: { intervalMs: 999999 },
    ncRequestManager: { request: async () => ({ body: { ocs: { data: {} } } }) },
    llmRouter: {
      route: async () => ({ result: '' }),
      budget: null,
      stats: { failovers: 0, errors: 0, successfulCalls: 0, byProvider: {} },
      buildProviderChain: () => ({ chain: [], skipped: [] }),
      recordOutcome: () => {}
    },
    credentialBroker: { getCredential: async () => 'test', prefetchAll: async () => {} },
    collectivesClient: overrides.collectivesClient || null,
    ncFilesClient: overrides.ncFilesClient || null,
    ...overrides
  });
}

// ============================================================================
// Main (async)
// ============================================================================

(async () => {
  console.log('\n=== HeartbeatManager Knowledge Stats Tests ===\n');

  // --------------------------------------------------------------------------
  // _formatKnowledgeStats Tests
  // --------------------------------------------------------------------------

  console.log('--- _formatKnowledgeStats ---\n');

  test('TC-KSTATS-FMT-001: _formatKnowledgeStats produces valid markdown with section table', () => {
    const hb = createMinimalHeartbeat();
    const stats = {
      totalPages: 10,
      contentPages: 7,
      sectionCounts: { People: 3, Projects: 4, Meta: 2, '(root)': 1 }
    };

    const result = hb._formatKnowledgeStats(stats);

    assert.ok(result.includes('# Knowledge Stats'), 'should include h1 heading');
    assert.ok(result.includes('| Total pages | 10 |'), 'should include total pages row');
    assert.ok(result.includes('| People | 3 |'), 'should include People section count');
  });

  test('TC-KSTATS-FMT-003: _formatKnowledgeStats never emits Freshness Health section (removed with legacy workers)', () => {
    const hb = createMinimalHeartbeat();

    const stats = {
      totalPages: 3,
      contentPages: 2,
      sectionCounts: { People: 2, Meta: 1 }
    };

    const result = hb._formatKnowledgeStats(stats);

    assert.ok(!result.includes('Freshness Health'), 'Freshness Health section was removed with FreshnessChecker');
  });

  // --------------------------------------------------------------------------
  // _updateKnowledgeStats Tests
  // --------------------------------------------------------------------------

  console.log('\n--- _updateKnowledgeStats ---\n');

  await asyncTest('TC-KSTATS-UPD-001: Hash unchanged means no write', async () => {
    const writeCalls = [];
    const pages = [
      { filePath: 'People', fileName: 'Alice.md' },
      { filePath: 'Meta', fileName: 'Stats.md' }
    ];

    const collectivesClient = {
      resolveCollective: async () => 1,
      listPages: async () => pages,
      writePageContent: async (path, content) => {
        writeCalls.push({ path, content });
      }
    };

    const hb = createMinimalHeartbeat({ collectivesClient });

    await hb._updateKnowledgeStats();
    await hb._updateKnowledgeStats();

    assert.strictEqual(writeCalls.length, 1, 'writePageContent should be called exactly once when stats do not change');
  });

  await asyncTest('TC-KSTATS-UPD-002: Hash changed means write called', async () => {
    const writeCalls = [];
    let callCount = 0;
    const pageVariants = [
      [
        { filePath: 'People', fileName: 'Alice.md' },
        { filePath: 'Meta', fileName: 'Stats.md' }
      ],
      [
        { filePath: 'People', fileName: 'Alice.md' },
        { filePath: 'Meta', fileName: 'Stats.md' },
        { filePath: 'Projects', fileName: 'NewProject.md' }
      ]
    ];

    const collectivesClient = {
      resolveCollective: async () => 1,
      listPages: async () => pageVariants[callCount++ < 1 ? 0 : 1],
      writePageContent: async (path, content) => {
        writeCalls.push({ path, content });
      }
    };

    const hb = createMinimalHeartbeat({ collectivesClient });

    await hb._updateKnowledgeStats(); // first call — writes
    await hb._updateKnowledgeStats(); // second call — different pages, writes again

    assert.strictEqual(writeCalls.length, 2, 'writePageContent should be called twice when stats change between calls');
  });

  await asyncTest('TC-KSTATS-CNT-001: Section counts correct from filePath', async () => {
    let writtenContent = null;
    const pages = [
      { filePath: 'People', fileName: 'A.md' },
      { filePath: 'People', fileName: 'B.md' },
      { filePath: 'Projects', fileName: 'C.md' },
      { filePath: 'Meta', fileName: 'D.md' },
      { filePath: '', fileName: 'Readme.md' }
    ];

    const collectivesClient = {
      resolveCollective: async () => 1,
      listPages: async () => pages,
      writePageContent: async (path, content) => {
        writtenContent = content;
      }
    };

    const hb = createMinimalHeartbeat({ collectivesClient });
    await hb._updateKnowledgeStats();

    assert.ok(writtenContent !== null, 'writePageContent should have been called');
    assert.ok(writtenContent.includes('| People | 2 |'), 'should show People count of 2');
    assert.ok(writtenContent.includes('| Projects | 1 |'), 'should show Projects count of 1');
  });

  await asyncTest('TC-KSTATS-CNT-002: Empty page list produces no error', async () => {
    let writtenContent = null;

    const collectivesClient = {
      resolveCollective: async () => 1,
      listPages: async () => [],
      writePageContent: async (path, content) => {
        writtenContent = content;
      }
    };

    const hb = createMinimalHeartbeat({ collectivesClient });

    // Should not throw
    await hb._updateKnowledgeStats();

    assert.ok(writtenContent !== null, 'writePageContent should have been called');
    assert.ok(writtenContent.includes('| Total pages | 0 |'), 'should report 0 total pages');
  });

  await asyncTest('TC-KSTATS-CNT-003: Content pages exclude Meta and root', async () => {
    let writtenContent = null;
    const pages = [
      { filePath: 'Meta', fileName: 'X.md' },
      { filePath: '', fileName: 'Y.md' },
      { filePath: 'People', fileName: 'Z.md' }
    ];

    const collectivesClient = {
      resolveCollective: async () => 1,
      listPages: async () => pages,
      writePageContent: async (path, content) => {
        writtenContent = content;
      }
    };

    const hb = createMinimalHeartbeat({ collectivesClient });
    await hb._updateKnowledgeStats();

    assert.ok(writtenContent !== null, 'writePageContent should have been called');
    assert.ok(writtenContent.includes('| Content pages | 1 |'), 'should count only People page as content (not Meta or root)');
  });

  await asyncTest('TC-KSTATS-CNT-004: virtual section pages (empty filePath, child of landing) count under their title, not (root)', async () => {
    let writtenContent = null;
    const pages = [
      { id: 1, title: 'Landing page', filePath: '', fileName: 'Readme.md', parentId: 0 },
      { id: 2, title: 'Research', filePath: '', fileName: 'Research.md', parentId: 1 },
      { id: 3, title: 'Paper', filePath: 'Research', fileName: 'Paper.md', parentId: 2 },
    ];

    const collectivesClient = {
      resolveCollective: async () => 1,
      listPages: async () => pages,
      writePageContent: async (path, content) => {
        writtenContent = content;
      }
    };

    const hb = createMinimalHeartbeat({ collectivesClient });
    await hb._updateKnowledgeStats();

    assert.ok(writtenContent !== null, 'writePageContent should have been called');
    assert.ok(writtenContent.includes('| Research | 2 |'), 'virtual section page and its member both count under Research');
    assert.ok(writtenContent.includes('| (root) | 1 |'), 'only the landing page itself remains at (root)');
  });

  // --------------------------------------------------------------------------
  // Summary
  // --------------------------------------------------------------------------

  summary();
  exitWithCode();
})();
