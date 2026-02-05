'use strict';

/**
 * Unit Tests for MemorySearcher (Session 29b)
 *
 * Tests keyword-based search, scoring, snippet extraction,
 * scope filtering, caching, and cache invalidation.
 *
 * Run: node test/unit/integrations/memory-searcher.test.js
 *
 * @module test/unit/integrations/memory-searcher
 */

const assert = require('assert');
const { asyncTest, test, summary, exitWithCode } = require('../../helpers/test-runner');
const MemorySearcher = require('../../../src/lib/integrations/memory-searcher');

// ============================================================
// Mock Wiki Client
// ============================================================

const MOCK_PAGES = [
  { id: 100, title: 'People', parentId: 0, fileName: 'People.md', filePath: '' },
  { id: 101, title: 'Projects', parentId: 0, fileName: 'Projects.md', filePath: '' },
  { id: 102, title: 'Sessions', parentId: 0, fileName: 'Sessions.md', filePath: '' },
  { id: 200, title: 'John Smith', parentId: 100, fileName: 'John Smith.md', filePath: 'People' },
  { id: 201, title: 'Q3 Budget Campaign', parentId: 101, fileName: 'Q3 Budget Campaign.md', filePath: 'Projects' },
  { id: 202, title: '2026-02-10-abc12345', parentId: 102, fileName: '2026-02-10-abc12345.md', filePath: 'Sessions' },
  { id: 203, title: 'Website Redesign', parentId: 101, fileName: 'Website Redesign.md', filePath: 'Projects' },
];

const MOCK_PAGE_CONTENTS = {
  'People.md': '---\ntype: section\n---\n# People\n',
  'Projects.md': '---\ntype: section\n---\n# Projects\n',
  'Sessions.md': '---\ntype: section\n---\n# Sessions\n',
  'People/John Smith.md': '---\ntype: person\nconfidence: high\ntags: [team, leadership]\n---\n# John Smith\n\nVP of Marketing. Reports to CEO.\n\nJohn manages the Q3 budget campaign and the website redesign project.\nHe joined the company in 2024 and oversees a team of 12.\n',
  'Projects/Q3 Budget Campaign.md': '---\ntype: project\nconfidence: medium\ntags: [budget, finance]\n---\n# Q3 Budget Campaign\n\nApproved budget of $50k for the third quarter.\n\nKey decisions: approved the marketing spend increase.\nAction items: finalize vendor contracts by March.\n',
  'Sessions/2026-02-10-abc12345.md': '---\ntype: session\nroom: abc12345\nuser: fu\ndecay_days: 90\n---\n# Session Summary\n\n- Discussed budget allocation for Q3\n- Decided to increase marketing spend by 20%\n- John will prepare the vendor shortlist\n',
  'Projects/Website Redesign.md': '---\ntype: project\nconfidence: high\ntags: [design, web]\n---\n# Website Redesign\n\nComplete overhaul of the corporate website.\n\nLaunching in Q3 2026. Led by the design team.\nBudget approved for external agency support.\n',
};

function createMockWikiClient() {
  return {
    resolveCollective: async () => 10,
    listPages: async () => MOCK_PAGES,
    _buildPagePath: (page) => {
      if (page.filePath) {
        return `${page.filePath}/${page.fileName}`;
      }
      return page.fileName;
    },
    readPageContent: async (path) => {
      return MOCK_PAGE_CONTENTS[path] || null;
    }
  };
}

// ============================================================
// Tests
// ============================================================

async function runTests() {
  console.log('\n=== MemorySearcher Tests (Session 29b) ===\n');

  // -----------------------------------------------------------------------
  // Basic Search
  // -----------------------------------------------------------------------

  await asyncTest('TC-MS-001: Finds pages matching exact query terms', async () => {
    const searcher = new MemorySearcher({ wikiClient: createMockWikiClient() });

    const results = await searcher.search('John Smith');

    assert.ok(results.length > 0, 'Should find at least one result');
    assert.strictEqual(results[0].page, 'John Smith', 'Top result should be John Smith page');
  });

  await asyncTest('TC-MS-002: Returns snippets from the most relevant paragraph', async () => {
    const searcher = new MemorySearcher({ wikiClient: createMockWikiClient() });

    const results = await searcher.search('budget campaign');

    assert.ok(results.length > 0, 'Should find results');
    const budgetResult = results.find(r => r.page === 'Q3 Budget Campaign');
    assert.ok(budgetResult, 'Should find Q3 Budget Campaign');
    assert.ok(budgetResult.snippet.length > 0, 'Snippet should not be empty');
  });

  await asyncTest('TC-MS-003: Weights title matches higher than content (3x)', async () => {
    const searcher = new MemorySearcher({ wikiClient: createMockWikiClient() });

    // "John Smith" appears in both the title of the person page and the content of Q3 Budget
    const results = await searcher.search('John Smith');

    // The page titled "John Smith" should score higher than pages that just mention him
    const johnPage = results.find(r => r.page === 'John Smith');
    const otherPages = results.filter(r => r.page !== 'John Smith');

    assert.ok(johnPage, 'John Smith page should be in results');
    if (otherPages.length > 0) {
      assert.ok(johnPage.score >= otherPages[0].score, 'Title match should score higher');
    }
  });

  await asyncTest('TC-MS-004: Matches frontmatter fields (tags)', async () => {
    const searcher = new MemorySearcher({ wikiClient: createMockWikiClient() });

    // "leadership" appears only in John Smith's frontmatter tags
    const results = await searcher.search('leadership team');

    assert.ok(results.length > 0, 'Should find results via frontmatter tags');
    const johnResult = results.find(r => r.page === 'John Smith');
    assert.ok(johnResult, 'John Smith should match via frontmatter tags');
  });

  await asyncTest('TC-MS-005: Returns empty array for no matches', async () => {
    const searcher = new MemorySearcher({ wikiClient: createMockWikiClient() });

    const results = await searcher.search('xyznonexistent');

    assert.ok(Array.isArray(results), 'Should return an array');
    assert.strictEqual(results.length, 0, 'Should have no results');
  });

  await asyncTest('TC-MS-006: Respects maxResults limit', async () => {
    const searcher = new MemorySearcher({ wikiClient: createMockWikiClient() });

    const results = await searcher.search('budget', { maxResults: 2 });

    assert.ok(results.length <= 2, 'Should respect maxResults');
  });

  // -----------------------------------------------------------------------
  // Caching
  // -----------------------------------------------------------------------

  await asyncTest('TC-MS-007: Caches pages for 5 minutes, returns stale cache on error', async () => {
    let callCount = 0;
    const wiki = createMockWikiClient();
    const origListPages = wiki.listPages;
    wiki.listPages = async (...args) => {
      callCount++;
      return origListPages(...args);
    };

    const searcher = new MemorySearcher({ wikiClient: wiki });

    // First search populates cache
    await searcher.search('budget');
    const firstCallCount = callCount;

    // Second search should use cache
    await searcher.search('John');
    assert.strictEqual(callCount, firstCallCount, 'Second search should use cache');

    // Make the wiki fail
    wiki.resolveCollective = async () => { throw new Error('NC down'); };

    // Third search should return stale cache
    const results = await searcher.search('budget');
    assert.ok(results.length > 0, 'Should return stale cache results on error');
  });

  await asyncTest('TC-MS-008: invalidateCache forces fresh fetch', async () => {
    let callCount = 0;
    const wiki = createMockWikiClient();
    const origListPages = wiki.listPages;
    wiki.listPages = async (...args) => {
      callCount++;
      return origListPages(...args);
    };

    const searcher = new MemorySearcher({ wikiClient: wiki });

    await searcher.search('budget');
    const countAfterFirst = callCount;

    searcher.invalidateCache();

    await searcher.search('budget');
    assert.ok(callCount > countAfterFirst, 'Should fetch fresh data after cache invalidation');
  });

  // -----------------------------------------------------------------------
  // Scope Filtering
  // -----------------------------------------------------------------------

  await asyncTest('TC-MS-009: Scope filter works (people returns only People/ pages)', async () => {
    const searcher = new MemorySearcher({ wikiClient: createMockWikiClient() });

    const results = await searcher.search('John', { scope: 'people' });

    for (const r of results) {
      assert.ok(
        r.path.toLowerCase().startsWith('people'),
        `Result path "${r.path}" should start with People`
      );
    }
  });

  await asyncTest('TC-MS-010: Scope filter "sessions" returns only Sessions/ pages', async () => {
    const searcher = new MemorySearcher({ wikiClient: createMockWikiClient() });

    const results = await searcher.search('budget', { scope: 'sessions' });

    for (const r of results) {
      assert.ok(
        r.path.toLowerCase().startsWith('sessions'),
        `Result path "${r.path}" should start with Sessions`
      );
    }
  });

  await asyncTest('TC-MS-011: Scope "all" returns results from all sections', async () => {
    const searcher = new MemorySearcher({ wikiClient: createMockWikiClient() });

    const results = await searcher.search('budget', { scope: 'all' });

    // Budget appears in Projects (Q3 Budget Campaign) and Sessions
    assert.ok(results.length > 0, 'Should find results across sections');
  });

  // -----------------------------------------------------------------------
  // Tokenizer
  // -----------------------------------------------------------------------

  test('TC-MS-012: Tokenizer removes stop words and short tokens', () => {
    const searcher = new MemorySearcher({ wikiClient: createMockWikiClient() });

    const tokens = searcher._tokenize('the quick brown fox jumps over a lazy dog');

    // "the", "a" are stop words; "quick", "brown", "fox", "jumps", "over", "lazy", "dog" are not
    // But "fox", "dog" have length 3, which passes the > 2 filter
    assert.ok(!tokens.includes('the'), 'Should remove stop words');
    assert.ok(!tokens.includes('a'), 'Should remove single-char stop words');
    assert.ok(tokens.includes('quick'), 'Should keep meaningful words');
    assert.ok(tokens.includes('brown'), 'Should keep meaningful words');
    assert.ok(tokens.includes('fox'), 'Should keep 3-letter words');
  });

  test('TC-MS-013: Tokenizer handles empty and null input', () => {
    const searcher = new MemorySearcher({ wikiClient: createMockWikiClient() });

    assert.deepStrictEqual(searcher._tokenize(''), []);
    assert.deepStrictEqual(searcher._tokenize(null), []);
    assert.deepStrictEqual(searcher._tokenize(undefined), []);
  });

  // -----------------------------------------------------------------------
  // Match Scoring
  // -----------------------------------------------------------------------

  test('TC-MS-014: Exact match scores higher than prefix match', () => {
    const searcher = new MemorySearcher({ wikiClient: createMockWikiClient() });

    const exactScore = searcher._matchScore(['budget'], ['budget']);
    const prefixScore = searcher._matchScore(['budget'], ['budgeting']);

    assert.ok(exactScore > prefixScore, 'Exact match should score higher than prefix');
  });

  test('TC-MS-015: Empty terms produce zero score', () => {
    const searcher = new MemorySearcher({ wikiClient: createMockWikiClient() });

    assert.strictEqual(searcher._matchScore([], ['budget']), 0);
    assert.strictEqual(searcher._matchScore(['budget'], []), 0);
    assert.strictEqual(searcher._matchScore([], []), 0);
  });

  console.log('\n=== MemorySearcher Tests Complete ===\n');
  summary();
  exitWithCode();
}

runTests();
