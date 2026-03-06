'use strict';
// Mock type: LEGACY — TODO: migrate to realistic mocks

/**
 * Unit Tests for MemorySearcher (M2: NC Unified Search)
 *
 * Tests NC Unified Search delegation, scope mapping, provider discovery,
 * time filtering, result formatting, and graceful failure handling.
 *
 * Run: node test/unit/integrations/memory-searcher.test.js
 *
 * @module test/unit/integrations/memory-searcher
 */

const assert = require('assert');
const { asyncTest, test, summary, exitWithCode } = require('../../helpers/test-runner');
const MemorySearcher = require('../../../src/lib/integrations/memory-searcher');
const { createMockNCSearchClient } = require('../../helpers/mock-factories');

// ============================================================
// Tests
// ============================================================

async function runTests() {
  console.log('\n=== MemorySearcher Tests (M2: NC Unified Search) ===\n');

  // -----------------------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------------------

  test('TC-MS-001: Constructor accepts { ncSearchClient }', () => {
    const mock = createMockNCSearchClient();
    const searcher = new MemorySearcher({ ncSearchClient: mock });
    assert.ok(searcher, 'Should create MemorySearcher instance');
    assert.strictEqual(searcher.nc, mock, 'Should store ncSearchClient');
  });

  test('TC-MS-002: Constructor throws if ncSearchClient missing', () => {
    assert.throws(
      () => new MemorySearcher({}),
      /ncSearchClient is required/,
      'Should throw when ncSearchClient is missing'
    );
  });

  // -----------------------------------------------------------------------
  // discoverProviders
  // -----------------------------------------------------------------------

  await asyncTest('TC-MS-003: discoverProviders() delegates to NCSearchClient.getProviders() and caches', async () => {
    let callCount = 0;
    const mock = createMockNCSearchClient({
      getProviders: async () => {
        callCount++;
        return [{ id: 'files', name: 'Files' }];
      }
    });
    const searcher = new MemorySearcher({ ncSearchClient: mock });

    const providers = await searcher.discoverProviders();
    assert.strictEqual(callCount, 1, 'Should call getProviders once');
    assert.deepStrictEqual(providers, [{ id: 'files', name: 'Files' }]);
    assert.deepStrictEqual(searcher._providers, providers, 'Should cache providers');
  });

  await asyncTest('TC-MS-004: discoverProviders() returns empty array on failure', async () => {
    const mock = createMockNCSearchClient({
      getProviders: async () => { throw new Error('NC unreachable'); }
    });
    const searcher = new MemorySearcher({ ncSearchClient: mock, logger: { error: () => {} } });

    const providers = await searcher.discoverProviders();
    assert.deepStrictEqual(providers, [], 'Should return empty array on failure');
  });

  // -----------------------------------------------------------------------
  // search — scope "all"
  // -----------------------------------------------------------------------

  await asyncTest('TC-MS-005: search() with scope "all" calls multiple providers', async () => {
    const calledProviders = [];
    const mock = createMockNCSearchClient({
      searchProvider: async (pid, term, limit, options) => {
        calledProviders.push(pid);
        return [];
      }
    });
    const searcher = new MemorySearcher({ ncSearchClient: mock });

    await searcher.search('test query', { scope: 'all' });
    assert.ok(calledProviders.includes('collectives-page-content'), 'Should search collectives-page-content');
    assert.ok(calledProviders.includes('talk-message'), 'Should search talk-message');
    assert.ok(calledProviders.includes('files'), 'Should search files');
    assert.strictEqual(calledProviders.length, 3, 'Should search 3 providers for scope all');
  });

  // -----------------------------------------------------------------------
  // search — result formatting and sorting
  // -----------------------------------------------------------------------

  await asyncTest('TC-MS-006: search() returns formatted results from multiple providers, sorted by priority', async () => {
    const mock = createMockNCSearchClient({
      searchProvider: async (pid) => {
        if (pid === 'collectives-page-content') {
          return [{ title: 'Wiki Page', subline: 'excerpt from wiki', resourceUrl: '/wiki/page' }];
        }
        if (pid === 'talk-message') {
          return [{ title: 'Chat Message', subline: 'hello world', resourceUrl: '/talk/1' }];
        }
        return [];
      }
    });
    const searcher = new MemorySearcher({ ncSearchClient: mock });

    const results = await searcher.search('test');
    assert.strictEqual(results.length, 2, 'Should have 2 results');
    // Wiki should come before Talk (priority 1 vs 3)
    assert.strictEqual(results[0].source, 'Wiki', 'First result should be Wiki');
    assert.strictEqual(results[0].title, 'Wiki Page');
    assert.strictEqual(results[0].excerpt, 'excerpt from wiki');
    assert.strictEqual(results[1].source, 'Conversation', 'Second result should be Conversation');
  });

  // -----------------------------------------------------------------------
  // search — since/until
  // -----------------------------------------------------------------------

  await asyncTest('TC-MS-007: search() passes since/until to provider search', async () => {
    let capturedOptions = null;
    const mock = createMockNCSearchClient({
      searchProvider: async (pid, term, limit, options) => {
        capturedOptions = options;
        return [];
      }
    });
    const searcher = new MemorySearcher({ ncSearchClient: mock });

    await searcher.search('test', { scope: 'conversations', since: '2026-01-01', until: '2026-02-01' });
    assert.ok(capturedOptions, 'Should pass options');
    assert.strictEqual(capturedOptions.since, '2026-01-01', 'Should pass since');
    assert.strictEqual(capturedOptions.until, '2026-02-01', 'Should pass until');
  });

  // -----------------------------------------------------------------------
  // search — empty results
  // -----------------------------------------------------------------------

  await asyncTest('TC-MS-008: search() returns empty array when no results', async () => {
    const mock = createMockNCSearchClient();
    const searcher = new MemorySearcher({ ncSearchClient: mock });

    const results = await searcher.search('xyznonexistent');
    assert.ok(Array.isArray(results), 'Should return array');
    assert.strictEqual(results.length, 0, 'Should have no results');
  });

  // -----------------------------------------------------------------------
  // search — provider failure (partial results)
  // -----------------------------------------------------------------------

  await asyncTest('TC-MS-009: search() handles provider failure gracefully (partial results)', async () => {
    const mock = createMockNCSearchClient({
      searchProvider: async (pid) => {
        if (pid === 'talk-message') throw new Error('Talk is down');
        if (pid === 'collectives-page-content') {
          return [{ title: 'Result', subline: 'ok', resourceUrl: '/ok' }];
        }
        return [];
      }
    });
    const searcher = new MemorySearcher({ ncSearchClient: mock });

    const results = await searcher.search('test', { scope: 'all' });
    assert.ok(results.length >= 1, 'Should return partial results on provider failure');
    assert.strictEqual(results[0].title, 'Result');
  });

  // -----------------------------------------------------------------------
  // search — scope filtering
  // -----------------------------------------------------------------------

  await asyncTest('TC-MS-010: Scope "people" filters to results containing "People" in link', async () => {
    const mock = createMockNCSearchClient({
      searchProvider: async () => [
        { title: 'John Smith', subline: 'VP of Marketing', resourceUrl: '/apps/collectives/People/John+Smith' },
        { title: 'Q3 Budget', subline: 'project info', resourceUrl: '/apps/collectives/Projects/Q3+Budget' },
      ]
    });
    const searcher = new MemorySearcher({ ncSearchClient: mock });

    const results = await searcher.search('John', { scope: 'people' });
    assert.strictEqual(results.length, 1, 'Should filter to only People/ results');
    assert.strictEqual(results[0].title, 'John Smith');
  });

  await asyncTest('TC-MS-011: Scope "conversations" only searches talk-message provider', async () => {
    const calledProviders = [];
    const mock = createMockNCSearchClient({
      searchProvider: async (pid) => {
        calledProviders.push(pid);
        return [];
      }
    });
    const searcher = new MemorySearcher({ ncSearchClient: mock });

    await searcher.search('meeting', { scope: 'conversations' });
    assert.deepStrictEqual(calledProviders, ['talk-message'], 'Should only search talk-message');
  });

  await asyncTest('TC-MS-012: Scope "files" only searches files provider', async () => {
    const calledProviders = [];
    const mock = createMockNCSearchClient({
      searchProvider: async (pid) => {
        calledProviders.push(pid);
        return [];
      }
    });
    const searcher = new MemorySearcher({ ncSearchClient: mock });

    await searcher.search('report', { scope: 'files' });
    assert.deepStrictEqual(calledProviders, ['files'], 'Should only search files');
  });

  // -----------------------------------------------------------------------
  // maxResults
  // -----------------------------------------------------------------------

  await asyncTest('TC-MS-013: maxResults limits total results', async () => {
    const mock = createMockNCSearchClient({
      searchProvider: async () => [
        { title: 'R1', subline: '', resourceUrl: '/1' },
        { title: 'R2', subline: '', resourceUrl: '/2' },
        { title: 'R3', subline: '', resourceUrl: '/3' },
        { title: 'R4', subline: '', resourceUrl: '/4' },
      ]
    });
    const searcher = new MemorySearcher({ ncSearchClient: mock });

    const results = await searcher.search('test', { maxResults: 2 });
    assert.strictEqual(results.length, 2, 'Should respect maxResults');
  });

  console.log('\n=== MemorySearcher Tests Complete ===\n');
  summary();
  exitWithCode();
}

runTests();
