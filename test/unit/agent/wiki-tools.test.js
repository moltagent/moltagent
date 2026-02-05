/**
 * Wiki Tools Integration Tests
 *
 * Tests the wiki_read, wiki_write, wiki_search, wiki_list tools
 * registered in ToolRegistry when collectivesClient is provided.
 *
 * Run: node test/unit/agent/wiki-tools.test.js
 *
 * @module test/unit/agent/wiki-tools
 */

const assert = require('assert');
const { asyncTest, test, summary, exitWithCode } = require('../../helpers/test-runner');
const { createMockCollectivesClient } = require('../../helpers/mock-factories');
const { ToolRegistry } = require('../../../src/lib/agent/tool-registry');

// ============================================================
// Tests
// ============================================================

console.log('Wiki Tools Unit Tests\n');

// -- Registration --

test('wiki tools registered when collectivesClient is provided', () => {
  const mockCollectives = createMockCollectivesClient();
  const registry = new ToolRegistry({ collectivesClient: mockCollectives });
  assert.ok(registry.has('wiki_read'));
  assert.ok(registry.has('wiki_write'));
  assert.ok(registry.has('wiki_search'));
  assert.ok(registry.has('wiki_list'));
});

test('wiki tools NOT registered when collectivesClient is missing', () => {
  const registry = new ToolRegistry({});
  assert.ok(!registry.has('wiki_read'));
  assert.ok(!registry.has('wiki_write'));
  assert.ok(!registry.has('wiki_search'));
  assert.ok(!registry.has('wiki_list'));
});

// -- wiki_read --

asyncTest('wiki_read calls collectivesClient.readPageWithFrontmatter', async () => {
  const mockCollectives = createMockCollectivesClient({
    readPageWithFrontmatter: {
      frontmatter: { type: 'person', confidence: 'high', tags: ['team'] },
      body: '# John Smith\n\nVP of Marketing.',
      path: 'People/John Smith/Readme.md'
    }
  });
  const registry = new ToolRegistry({ collectivesClient: mockCollectives });
  const result = await registry.execute('wiki_read', { page_title: 'John Smith' });
  assert.ok(result.success);
  assert.ok(result.result.includes('John Smith'));
  assert.ok(result.result.includes('Type: person'));
  assert.ok(result.result.includes('Confidence: high'));
});

asyncTest('wiki_read returns not found message for missing page', async () => {
  const mockCollectives = createMockCollectivesClient({
    readPageWithFrontmatter: null
  });
  const registry = new ToolRegistry({ collectivesClient: mockCollectives });
  const result = await registry.execute('wiki_read', { page_title: 'Nonexistent' });
  assert.ok(result.success);
  assert.ok(result.result.includes('No wiki page found'));
});

// -- wiki_write --

asyncTest('wiki_write creates page when not found', async () => {
  let createdTitle = null;
  const mockCollectives = createMockCollectivesClient({
    findPageByTitle: null,
    resolveCollective: 10,
    listPages: [
      { id: 100, title: 'People', parentId: 0 }
    ]
  });
  mockCollectives.createPage = async (cId, parentId, title) => {
    createdTitle = title;
    return { id: 500, title };
  };
  mockCollectives.writePageContent = async () => {};

  const registry = new ToolRegistry({ collectivesClient: mockCollectives });
  const result = await registry.execute('wiki_write', {
    page_title: 'Jane Doe',
    content: '# Jane Doe\n\nNew team member.',
    parent: 'People'
  });
  assert.ok(result.success);
  assert.ok(result.result.includes('Created'));
  assert.strictEqual(createdTitle, 'Jane Doe');
});

asyncTest('wiki_write updates page when found', async () => {
  let writtenPath = null;
  const mockCollectives = createMockCollectivesClient({
    findPageByTitle: { page: { id: 200, title: 'John Smith' }, path: 'People/John Smith/Readme.md' }
  });
  mockCollectives.writePageContent = async (path) => { writtenPath = path; };

  const registry = new ToolRegistry({ collectivesClient: mockCollectives });
  const result = await registry.execute('wiki_write', {
    page_title: 'John Smith',
    content: '# John Smith\n\nUpdated content.'
  });
  assert.ok(result.success);
  assert.ok(result.result.includes('Updated'));
  assert.strictEqual(writtenPath, 'People/John Smith/Readme.md');
});

// -- wiki_search --

asyncTest('wiki_search returns formatted results', async () => {
  const mockCollectives = createMockCollectivesClient({
    resolveCollective: 10,
    searchPages: [
      { title: 'John Smith', excerpt: 'VP of Marketing' },
      { title: 'Q3 Campaign', excerpt: 'Led by John' }
    ]
  });
  const registry = new ToolRegistry({ collectivesClient: mockCollectives });
  const result = await registry.execute('wiki_search', { query: 'John' });
  assert.ok(result.success);
  assert.ok(result.result.includes('John Smith'));
  assert.ok(result.result.includes('Q3 Campaign'));
});

asyncTest('wiki_search returns no results message', async () => {
  const mockCollectives = createMockCollectivesClient({
    resolveCollective: 10,
    searchPages: []
  });
  const registry = new ToolRegistry({ collectivesClient: mockCollectives });
  const result = await registry.execute('wiki_search', { query: 'nonexistent' });
  assert.ok(result.success);
  assert.ok(result.result.includes('No wiki pages found'));
});

// -- wiki_list --

asyncTest('wiki_list returns section tree', async () => {
  const mockCollectives = createMockCollectivesClient({
    resolveCollective: 10,
    listPages: [
      { id: 1, title: 'MoltAgent Knowledge', parentId: 0, emoji: '' },
      { id: 100, title: 'People', parentId: 1, emoji: '👥' },
      { id: 101, title: 'Projects', parentId: 1, emoji: '📁' },
      { id: 200, title: 'John Smith', parentId: 100, emoji: '' },
      { id: 201, title: 'Jane Doe', parentId: 100, emoji: '' }
    ]
  });
  const registry = new ToolRegistry({ collectivesClient: mockCollectives });

  // Root level
  const rootResult = await registry.execute('wiki_list', {});
  assert.ok(rootResult.success);
  assert.ok(rootResult.result.includes('People'));
  assert.ok(rootResult.result.includes('Projects'));
  assert.ok(rootResult.result.includes('2 subpages'));

  // Section level
  const sectionResult = await registry.execute('wiki_list', { section: 'People' });
  assert.ok(sectionResult.success);
  assert.ok(sectionResult.result.includes('John Smith'));
  assert.ok(sectionResult.result.includes('Jane Doe'));
});

asyncTest('wiki_list returns message for empty wiki', async () => {
  const mockCollectives = createMockCollectivesClient({
    resolveCollective: 10,
    listPages: []
  });
  const registry = new ToolRegistry({ collectivesClient: mockCollectives });
  const result = await registry.execute('wiki_list', {});
  assert.ok(result.success);
  assert.ok(result.result.includes('empty'));
});

// ============================================================
// Summary
// ============================================================

setTimeout(() => {
  summary();
  exitWithCode();
}, 500);
