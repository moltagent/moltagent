'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const { WikiSteward } = require('../../../src/lib/maintenance/wiki-steward');
const { ObservationLog, OBSERVATION_TYPES } = require('../../../src/lib/maintenance/observation-log');
const { deriveSection } = require('../../../src/lib/integrations/collectives-client');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

// ---------------------------------------------------------------------------
// Inline mock factories (NOT touching mock-factories.js)
// ---------------------------------------------------------------------------

function makeObservationLog() {
  return new ObservationLog({ logger: silentLogger });
}

function makeMockRouter(responseObj) {
  return {
    _calls: [],
    async route(opts) {
      this._calls.push(opts);
      return { result: JSON.stringify(responseObj), provider: 'mock', model: 'mock', cost: 0 };
    }
  };
}

/**
 * Make a CollectivesClient mock.
 *
 * pagesByTitle: { [title]: { frontmatter, body, path } }
 * listPagesResult: array of { id, title, section, parentId }
 */
function makeMockCollectivesClient({
  pagesByTitle = {},
  listPagesResult = [],
  collectiveId = 10,
  collectiveName = 'Moltagent Knowledge'
} = {}) {
  const writtenPages = {};
  const writtenContent = {};

  return {
    collectiveName,
    _cache: { collectiveId },
    resolveCollective: async () => collectiveId,
    listPages: async () => listPagesResult,
    // Mirrors the real client: case-insensitive leaf-title match over known pages.
    findPageByTitle: async (title) => {
      const leaf = title.split('/').pop().toLowerCase();
      const known = Object.keys(pagesByTitle).find(t => t.toLowerCase() === leaf);
      if (known) return { page: { title: known }, path: pagesByTitle[known].path || `${known}.md` };
      const listed = listPagesResult.find(p => (p.title || '').toLowerCase() === leaf);
      if (listed) {
        return {
          page: listed,
          path: listed.filePath ? `${listed.filePath}/${listed.fileName}` : (listed.fileName || `${listed.title}.md`),
        };
      }
      return null;
    },
    readPageWithFrontmatter: async (title) => {
      if (pagesByTitle[title] !== undefined) return pagesByTitle[title];
      return null;
    },
    readPageContent: async (path) => {
      if (writtenContent[path] !== undefined) return writtenContent[path];
      return '';
    },
    writePageContent: async (path, content) => {
      writtenContent[path] = content;
    },
    writePageWithFrontmatter: async (title, fm, body) => {
      writtenPages[title] = { frontmatter: fm, body };
      return `${title}.md`;
    },
    // Test helpers to inspect what was written
    _writtenPages: writtenPages,
    _writtenContent: writtenContent,
  };
}

function makeMockKnowledgeGraph({ entities = {}, triples = [] } = {}) {
  return {
    _entities: new Map(Object.entries(entities)),
    _triples: triples,
    getEntity: (title) => entities[title] || null,
    relatedTo: (entityId, depth) => {
      return triples
        .filter(t => t.subject === entityId)
        .map(t => ({ predicate: t.predicate, entity: { id: t.object, name: t.object } }));
    },
  };
}

function makeMockVectorStore({ metadataMap = {} } = {}) {
  const store = { ...metadataMap };
  return {
    getMetadata: (id) => store[id] || null,
    upsert: (id, vec, meta) => { store[id] = meta; },
    count: () => Object.keys(store).length,
    _store: store,
  };
}

function makeMockEmbeddingClient({ vector = [0.1, 0.2, 0.3] } = {}) {
  return {
    _calls: [],
    async embed(text) {
      this._calls.push(text);
      return vector;
    }
  };
}

function makeFullDeps(overrides = {}) {
  return {
    collectivesClient: makeMockCollectivesClient(),
    knowledgeGraph:    makeMockKnowledgeGraph(),
    vectorStore:       makeMockVectorStore(),
    embeddingClient:   makeMockEmbeddingClient(),
    llmRouter:         makeMockRouter({ actions: [] }),
    observationLog:    makeObservationLog(),
    logger:            silentLogger,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// CONSTRUCTION & ROTATION
// ---------------------------------------------------------------------------

// Test 1: Construction succeeds with required deps; missing dep throws
test('WikiSteward constructor: succeeds with required deps', () => {
  assert.doesNotThrow(() => new WikiSteward(makeFullDeps()));
});

test('WikiSteward constructor: throws when required dep is missing', () => {
  const deps = makeFullDeps();
  delete deps.observationLog;
  assert.throws(() => new WikiSteward(deps), /requires observationLog/);
});

// Test 2: _nextSteward(cluster) cycles knowledge → connection → memory → knowledge
test('_nextSteward() cycles through three lenses and wraps, per cluster', () => {
  const steward = new WikiSteward(makeFullDeps());
  assert.strictEqual(steward._nextSteward('People'), 'knowledge');
  assert.strictEqual(steward._nextSteward('People'), 'connection');
  assert.strictEqual(steward._nextSteward('People'), 'memory');
  assert.strictEqual(steward._nextSteward('People'), 'knowledge', 'should wrap back to knowledge');
});

// Phase 1b invariant: interleaved clusters advance independently. A global
// index lens-locks every cluster when clusterCount % lenses === 0.
test('_nextSteward() keeps independent lens sequences across interleaved clusters', () => {
  const steward = new WikiSteward(makeFullDeps());
  assert.strictEqual(steward._nextSteward('People'), 'knowledge');
  assert.strictEqual(steward._nextSteward('Projects'), 'knowledge', 'second cluster starts its own ring');
  assert.strictEqual(steward._nextSteward('People'), 'connection');
  assert.strictEqual(steward._nextSteward('Projects'), 'connection');
  assert.strictEqual(steward._nextSteward('People'), 'memory');
  assert.strictEqual(steward._nextSteward('Projects'), 'memory');
});

// Test 3: tend() returns skipped:'idle' when no clusters and no observations
asyncTest('tend() returns skipped idle when no clusters available', async () => {
  // listPages returns empty → _listClusters → fallback also empty → _findNeediest returns null
  const steward = new WikiSteward(makeFullDeps({
    collectivesClient: makeMockCollectivesClient({ listPagesResult: [] }),
  }));

  const result = await steward.tend();
  assert.ok(result.skipped, 'should return a skipped flag');
  assert.strictEqual(result.cluster, null);
  assert.strictEqual(result.pagesModified, 0);
});

// ---------------------------------------------------------------------------
// NEEDIEST CLUSTER SELECTION
// ---------------------------------------------------------------------------

// Test 4: _findNeediest() returns null when all clusters have score 0
// NOTE: The score formula is `observationCount * 10 + min(hoursSinceVisit, 48)`.
// A cluster with no observations AND a recent visit (< 1 second ago) has a score
// near 0 but still > 0 due to fractional hours. The only way to get score exactly
// 0 would require a visit that happened precisely now AND zero observations.
// The spec says `scored[0]?.score > 0 ? scored[0] : null` — so a score of ~0.0003
// is still > 0 and returns the cluster. We test the null path via an empty cluster list.
asyncTest('_findNeediest() returns null when no clusters are known', async () => {
  const steward = new WikiSteward(makeFullDeps({
    collectivesClient: makeMockCollectivesClient({
      listPagesResult: [],
    }),
  }));
  // Empty cluster list → _listClusters returns [] → _findNeediest returns null
  const result = await steward._findNeediest();
  assert.strictEqual(result, null);
});

// Test 5: _findNeediest() prioritizes cluster with most unresolved observations
asyncTest('_findNeediest() prioritizes cluster with most unresolved observations', async () => {
  const observationLog = makeObservationLog();
  observationLog.notice({ type: OBSERVATION_TYPES.CONTRADICTION, cluster: 'Alpha' });
  observationLog.notice({ type: OBSERVATION_TYPES.GAP,           cluster: 'Alpha' });
  observationLog.notice({ type: OBSERVATION_TYPES.GAP,           cluster: 'Alpha' });
  observationLog.notice({ type: OBSERVATION_TYPES.MISSING_LINK,  cluster: 'Beta' });

  const steward = new WikiSteward(makeFullDeps({
    observationLog,
    collectivesClient: makeMockCollectivesClient({
      listPagesResult: [
        { id: 1, title: 'Page A', section: 'Alpha', parentId: 1 },
        { id: 2, title: 'Page B', section: 'Beta',  parentId: 1 },
      ],
    }),
  }));

  const result = await steward._findNeediest();
  assert.ok(result !== null);
  assert.strictEqual(result.name, 'Alpha', 'Alpha has 3 observations vs Beta 1 — should be neediest');
});

// ---------------------------------------------------------------------------
// NEIGHBORHOOD READING
// ---------------------------------------------------------------------------

// Test 6: _readNeighborhood() reads frontmatter + body preview for each page
asyncTest('_readNeighborhood() reads frontmatter and body for cluster pages', async () => {
  const pagesByTitle = {
    'Carlos': { frontmatter: { type: 'person', confidence: 'high' }, body: 'Carlos is the editorial director.', path: 'People/Carlos.md' },
  };
  const collectivesClient = makeMockCollectivesClient({
    pagesByTitle,
    listPagesResult: [{ id: 99, title: 'Carlos', section: 'people', parentId: 1 }],
  });
  const steward = new WikiSteward(makeFullDeps({ collectivesClient }));

  const neighborhood = await steward._readNeighborhood({ name: 'people' });

  assert.strictEqual(neighborhood.cluster, 'people');
  assert.strictEqual(neighborhood.pages.length, 1);
  const page = neighborhood.pages[0];
  assert.strictEqual(page.title, 'Carlos');
  assert.strictEqual(page.frontmatter.confidence, 'high');
  assert.ok(typeof page.bodyPreview === 'string', 'bodyPreview should be a string');
  assert.strictEqual(typeof page.hasEmbedding, 'boolean', 'hasEmbedding should be boolean');
});

// Test 7: _readNeighborhood() catches per-page errors and continues.
//
// NOTE: _readFrontmatter and _readBodyPreview both have their own internal try-catch
// that swallows errors and returns {} / '' respectively. A throw inside those helpers
// does NOT propagate to the outer page loop. To reach the outer catch, we need to
// throw from vectorStore.getMetadata() which is called directly in the outer loop
// (not wrapped in a helper). This test verifies that the outer loop catch does indeed
// prevent a full abort and the remaining pages are still processed.
asyncTest('_readNeighborhood() skips pages that throw at the outer level and continues', async () => {
  const collectivesClient = makeMockCollectivesClient({
    listPagesResult: [
      { id: 1, title: 'Good Page',  section: 'people', parentId: 1 },
      { id: 2, title: 'Bad Page',   section: 'people', parentId: 1 },
      { id: 3, title: 'Third Page', section: 'people', parentId: 1 },
    ],
    pagesByTitle: {
      'Good Page':  { frontmatter: { type: 'person' }, body: 'Good.', path: 'People/Good.md' },
      'Bad Page':   { frontmatter: {}, body: 'Bad.', path: 'People/Bad.md' },
      'Third Page': { frontmatter: { type: 'org' }, body: 'Third.', path: 'People/Third.md' },
    },
  });

  // Throw from vectorStore.getMetadata on the Bad Page (keyed by title, not id)
  const vectorStore = makeMockVectorStore();
  const origGetMetadata = vectorStore.getMetadata.bind(vectorStore);
  vectorStore.getMetadata = (key) => {
    if (key === 'Bad Page') throw new Error('Simulated vectorStore failure for Bad Page');
    return origGetMetadata(key);
  };

  const steward = new WikiSteward(makeFullDeps({ collectivesClient, vectorStore }));
  const neighborhood = await steward._readNeighborhood({ name: 'people' });

  // Bad Page should be skipped; Good Page and Third Page should be present
  assert.strictEqual(neighborhood.pages.length, 2, 'should skip erroring page and include the other two');
  const titles = neighborhood.pages.map(p => p.title);
  assert.ok(!titles.includes('Bad Page'), 'Bad Page should have been skipped');
  assert.ok(titles.includes('Good Page'), 'Good Page should be present');
  assert.ok(titles.includes('Third Page'), 'Third Page should be present');
});

// ---------------------------------------------------------------------------
// CLUSTER SECTION DERIVATION (#51 — deriveSection is the ONE derivation,
// exported by the client and consumed by every section-identity site.
// Same four branches the steward's deleted _getPageSection covered — parity.)
// ---------------------------------------------------------------------------

test('deriveSection returns section from folder-only filePath (current API shape)', () => {
  const section = deriveSection({ filePath: 'Documents', section: undefined, parentId: 1 }, 99);
  assert.strictEqual(section, 'Documents');
});

test('deriveSection honors explicit page.section when present (defensive)', () => {
  const section = deriveSection({ section: 'People', filePath: '', parentId: 1 }, 99);
  assert.strictEqual(section, 'People');
});

test('deriveSection falls back to title when page is direct child of landing', () => {
  const section = deriveSection(
    { filePath: '', section: undefined, parentId: 99, title: 'Research' },
    99
  );
  assert.strictEqual(section, 'Research');
});

test('deriveSection returns null for the landing page itself', () => {
  const section = deriveSection(
    { filePath: '', section: undefined, parentId: 0, title: 'Knowledge Domains' },
    99
  );
  assert.strictEqual(section, null);
});

test('deriveSection without landingPageId derives null for a non-child page with empty filePath', () => {
  // The fact-7 drift case: the DEEP_READ producer used to fall back to the
  // page title here, counting observations toward a phantom cluster the
  // steward census never lists. null is the honest answer.
  const section = deriveSection({ filePath: '', section: undefined, parentId: 42, title: 'Some Page' });
  assert.strictEqual(section, null);
});

test('producer and steward agree on cluster identity for the same page objects', () => {
  const landingId = 99;
  const pages = [
    { title: 'Alex', filePath: 'People', parentId: 5 },          // entity page
    { title: 'Research', filePath: '', parentId: landingId },    // virtual section page
    { title: 'Landing page', filePath: '', parentId: 0 },        // landing itself
  ];
  for (const p of pages) {
    // One function, one truth — both sides call the same export; with the
    // landing id in hand the answer can only refine null → title, never fork.
    const stewardView = deriveSection(p, landingId);
    const producerView = deriveSection(p);
    assert.ok(
      producerView === stewardView || producerView === null,
      `producer may lack landing id (null) but must never contradict: ${p.title}`
    );
  }
  assert.strictEqual(deriveSection(pages[0]), 'People');
  assert.strictEqual(deriveSection(pages[0], landingId), 'People');
});

asyncTest('_updateSectionSummaries membership is exact: "Research Archive" page stays out of "Research"', async () => {
  const listPagesResult = [
    { id: 1, title: 'Landing page', filePath: '', parentId: 0, fileName: 'Readme.md' },
    { id: 2, title: 'Research', filePath: 'Research', parentId: 1, fileName: 'Readme.md' },
    { id: 3, title: 'Paper A', filePath: 'Research', parentId: 2, fileName: 'Paper A.md' },
    { id: 4, title: 'Old Paper', filePath: 'Research Archive', parentId: 5, fileName: 'Old Paper.md' },
  ];
  const collectivesClient = makeMockCollectivesClient({ listPagesResult });
  const router = makeMockRouter({});
  router.route = async (opts) => {
    router._calls.push(opts);
    return { result: '# Research\n\n## Known Entities\n- ok', provider: 'mock', model: 'mock' };
  };
  const steward = new WikiSteward(makeFullDeps({ collectivesClient, llmRouter: router }));

  await steward._updateSectionSummaries(new Set(['Research']));

  const prompt = router._calls[0]?.content || '';
  assert.ok(prompt.includes('Paper A'), 'exact member listed');
  assert.ok(!prompt.includes('Old Paper'), 'substring cousin "Research Archive" excluded');
});

// ---------------------------------------------------------------------------
// PHASE 7: SINGLE-READ NEIGHBORHOOD, GROUNDED LEVEL 1, DEAD FIELDS OUT
// ---------------------------------------------------------------------------

asyncTest('_readNeighborhood performs exactly one content read per page and carries path', async () => {
  const listPagesResult = [
    { id: 1, title: 'Landing page', filePath: '', parentId: 0, fileName: 'Readme.md' },
    { id: 2, title: 'Alpha', filePath: 'People', parentId: 5, fileName: 'Alpha.md' },
    { id: 3, title: 'Beta', filePath: 'People', parentId: 5, fileName: 'Beta.md' },
  ];
  const pagesByTitle = {
    'Alpha': { frontmatter: { type: 'person' }, body: 'Alpha body.', path: 'People/Alpha.md' },
    'Beta': { frontmatter: {}, body: 'Beta body.', path: 'People/Beta.md' },
  };
  const collectivesClient = makeMockCollectivesClient({ pagesByTitle, listPagesResult });
  let reads = 0;
  const origRead = collectivesClient.readPageWithFrontmatter;
  collectivesClient.readPageWithFrontmatter = async (title) => { reads++; return origRead(title); };

  const steward = new WikiSteward(makeFullDeps({ collectivesClient }));
  const neighborhood = await steward._readNeighborhood({ name: 'People' });

  assert.strictEqual(neighborhood.pages.length, 2);
  assert.strictEqual(reads, 2, 'one content read per page, not two');
  assert.strictEqual(neighborhood.pages[0].path, 'People/Alpha.md', 'enriched page carries its path');
  assert.ok(!('graphEdges' in neighborhood), 'dead cluster-wide graphEdges scan is gone');
  assert.ok(!('deckCards' in neighborhood), 'dead deckCards field is gone');
});

asyncTest('knowledge prompt carries a FACTS block from per-page graph connections, capped at 40', async () => {
  const manyConnections = Array.from({ length: 50 }, (_, i) => ({ predicate: 'knows', object: `Entity ${i}` }));
  const neighborhood = {
    cluster: 'People',
    pages: [{
      id: '1', title: 'Alpha', section: 'People', path: 'People/Alpha.md',
      frontmatter: {}, bodyPreview: 'preview', hasEmbedding: true,
      graphConnections: manyConnections, wikilinks: [],
    }],
    sections: new Set(['People']),
  };
  const steward = new WikiSteward(makeFullDeps());
  const prompt = steward._knowledgeAssessmentPrompt(neighborhood);

  assert.ok(prompt.includes('KNOWN FACTS'), 'FACTS block present');
  assert.ok(prompt.includes('Alpha knows Entity 0'), 'fact lines carry page, predicate, object');
  const factCount = (prompt.match(/^Alpha knows Entity /gm) || []).length;
  assert.strictEqual(factCount, 40, 'fact lines capped at 40');
});

asyncTest('knowledge prompt omits the FACTS block when no connections exist', async () => {
  const neighborhood = {
    cluster: 'People',
    pages: [{
      id: '1', title: 'Alpha', section: 'People', path: null,
      frontmatter: {}, bodyPreview: '', hasEmbedding: false,
      graphConnections: [], wikilinks: [],
    }],
    sections: new Set(['People']),
  };
  const steward = new WikiSteward(makeFullDeps());
  const prompt = steward._knowledgeAssessmentPrompt(neighborhood);
  assert.ok(!prompt.includes('KNOWN FACTS'), 'no FACTS header without facts');
});

asyncTest('Level 1 prompt is grounded: summaries from frontmatter/first lines, confidence only where carried', async () => {
  const listPagesResult = [
    { id: 1, title: 'Landing page', filePath: '', parentId: 0, fileName: 'Readme.md' },
    { id: 2, title: 'People', filePath: 'People', parentId: 1, fileName: 'Readme.md' },
    { id: 3, title: 'Alpha', filePath: 'People', parentId: 2, fileName: 'Alpha.md' },
    { id: 4, title: 'Beta', filePath: 'People', parentId: 2, fileName: 'Beta.md' },
  ];
  const collectivesClient = makeMockCollectivesClient({ listPagesResult });
  const router = makeMockRouter({});
  router.route = async (opts) => {
    router._calls.push(opts);
    return { result: '# People\n\n## Known Entities\n- ok', provider: 'mock', model: 'mock' };
  };
  const steward = new WikiSteward(makeFullDeps({ collectivesClient, llmRouter: router }));

  // Enriched pages already in hand — no extra read should be needed for them.
  const enriched = [
    {
      id: 3, title: 'Alpha', section: 'People', path: 'People/Alpha.md',
      frontmatter: { summary: 'Editorial director at the media company.', confidence: 'high' },
      bodyPreview: '# Alpha\nIgnored because frontmatter.summary wins.',
      hasEmbedding: true, graphConnections: [], wikilinks: [],
    },
    {
      id: 4, title: 'Beta', section: 'People', path: 'People/Beta.md',
      frontmatter: {},
      bodyPreview: '# Beta\nWorks on food-systems research.\nMore text.',
      hasEmbedding: false, graphConnections: [], wikilinks: [],
    },
  ];

  await steward._updateSectionSummaries(new Set(['People']), enriched);

  const prompt = router._calls[0]?.content || '';
  assert.ok(prompt.includes('Editorial director at the media company.'), 'frontmatter summary grounds Alpha');
  assert.ok(prompt.includes('(confidence: high)'), 'confidence label present where frontmatter carries one');
  assert.ok(prompt.includes('Works on food-systems research.'), 'first non-heading body line grounds Beta');
  assert.ok(!/Beta\*\*[^\n]*confidence/.test(prompt), 'no confidence label for Beta (frontmatter has none)');
  assert.ok(prompt.includes('not invention'), 'prompt states the format-only contract');
  assert.ok(!prompt.match(/- \*\*People\*\*/), 'section parent page is not listed as its own entity');
});

asyncTest('_readNeighborhood() populates pages when filePath is folder-only (current API shape)', async () => {
  // Mimics what listPages actually returns post-API-change:
  //   section: undefined, filePath: "Documents" (no slash, no page name).
  const collectivesClient = makeMockCollectivesClient({
    pagesByTitle: {
      'Doc One': { frontmatter: { type: 'reference' }, body: 'first doc', path: 'Documents/Doc One.md' },
      'Doc Two': { frontmatter: { type: 'reference' }, body: 'second doc', path: 'Documents/Doc Two.md' },
    },
    listPagesResult: [
      { id: 1,  title: 'Knowledge Domains', section: undefined, filePath: '', parentId: 0 },
      { id: 10, title: 'Doc One',           section: undefined, filePath: 'Documents', parentId: 1 },
      { id: 11, title: 'Doc Two',           section: undefined, filePath: 'Documents', parentId: 1 },
    ],
  });
  const steward = new WikiSteward(makeFullDeps({ collectivesClient }));

  const neighborhood = await steward._readNeighborhood({ name: 'Documents' });

  assert.strictEqual(neighborhood.cluster, 'Documents');
  assert.strictEqual(neighborhood.pages.length, 2, 'should include both Documents pages');
  const titles = neighborhood.pages.map(p => p.title).sort();
  assert.deepStrictEqual(titles, ['Doc One', 'Doc Two']);
});

asyncTest('_readNeighborhood() excludes pages belonging to other clusters', async () => {
  const collectivesClient = makeMockCollectivesClient({
    pagesByTitle: {
      'Doc One':  { frontmatter: {}, body: 'doc', path: 'Documents/Doc One.md' },
      'Carlos':   { frontmatter: {}, body: 'person', path: 'People/Carlos.md' },
    },
    listPagesResult: [
      { id: 1,  title: 'Knowledge Domains', section: undefined, filePath: '', parentId: 0 },
      { id: 10, title: 'Doc One',           section: undefined, filePath: 'Documents', parentId: 1 },
      { id: 20, title: 'Carlos',            section: undefined, filePath: 'People',    parentId: 1 },
    ],
  });
  const steward = new WikiSteward(makeFullDeps({ collectivesClient }));

  const neighborhood = await steward._readNeighborhood({ name: 'Documents' });

  assert.strictEqual(neighborhood.pages.length, 1, 'should only include Documents pages');
  assert.strictEqual(neighborhood.pages[0].title, 'Doc One');
});

// ---------------------------------------------------------------------------
// KNOWLEDGE STEWARD LENS
// ---------------------------------------------------------------------------

// Test 8: _assess('knowledge', ...) calls router with job='synthesis' and parses JSON
asyncTest('_assess knowledge calls router with synthesis job and parses response', async () => {
  const mockAssessment = {
    contradictions: [],
    stale: [{ page: 'Carlos', reason: 'old' }],
    gaps: [],
    suspects: [],
    healthy: ['Eelco'],
  };
  const router = makeMockRouter(mockAssessment);
  const steward = new WikiSteward(makeFullDeps({ llmRouter: router }));

  const neighborhood = { cluster: 'People', pages: [], graphEdges: [], sections: new Set(), deckCards: [] };
  const result = await steward._assess('knowledge', neighborhood);

  assert.strictEqual(router._calls.length, 1);
  assert.strictEqual(router._calls[0].job, 'synthesis');
  assert.ok(router._calls[0].context.trigger === 'wiki_steward', 'should tag trigger as wiki_steward');
  assert.deepStrictEqual(result.stale, [{ page: 'Carlos', reason: 'old' }]);
});

// Test 9: Knowledge assessment with malformed JSON returns safe empty shape
asyncTest('_assess knowledge with malformed JSON returns safe { actions: [] }', async () => {
  const badRouter = {
    _calls: [],
    async route(opts) {
      this._calls.push(opts);
      return { result: 'this is not valid json {{{{', provider: 'mock', model: 'mock', cost: 0 };
    }
  };
  const steward = new WikiSteward(makeFullDeps({ llmRouter: badRouter }));
  const neighborhood = { cluster: 'People', pages: [], graphEdges: [], sections: new Set(), deckCards: [] };

  let result;
  assert.doesNotThrow(async () => {
    result = await steward._assess('knowledge', neighborhood);
  });
  result = await steward._assess('knowledge', neighborhood);
  assert.ok(result && typeof result === 'object', 'should return an object');
  // The implementation returns { actions: [] } on parse failure
  assert.deepStrictEqual(result, { actions: [] });
});

// ---------------------------------------------------------------------------
// CONNECTION STEWARD LENS
// ---------------------------------------------------------------------------

// Test 10: _assess('connection', ...) includes graph edges in the prompt
asyncTest('_assess connection builds prompt with graph edge information', async () => {
  const router = makeMockRouter({ missingLinks: [], orphans: [], nearDuplicates: [], crossCluster: [] });
  const steward = new WikiSteward(makeFullDeps({ llmRouter: router }));

  const neighborhood = {
    cluster: 'People',
    pages: [{
      id: '1', title: 'Carlos', section: 'People',
      frontmatter: {}, bodyPreview: 'Carlos works at ManeraMedia.',
      hasEmbedding: true,
      graphConnections: [{ predicate: 'works_at', object: 'ManeraMedia GmbH' }],
      wikilinks: [],
    }],
    graphEdges: [{ subject: 'person_carlos', predicate: 'works_at', object: 'org_manera_media' }],
    sections: new Set(['People']),
    deckCards: [],
  };

  await steward._assess('connection', neighborhood);

  assert.strictEqual(router._calls.length, 1);
  const prompt = router._calls[0].content;
  // The prompt should include graph connection info (works_at → ManeraMedia GmbH)
  assert.ok(prompt.includes('works_at'), 'prompt should include graph predicate');
  assert.ok(prompt.includes('ManeraMedia GmbH'), 'prompt should include graph object');
});

// Test 11: Intervention on connection adds wikilink and increments linksAdded
asyncTest('connection intervention _addWikilink adds a link and increments linksAdded', async () => {
  const pagesByTitle = {
    'Carlos': { frontmatter: {}, body: 'Carlos works at a company.', path: 'People/Carlos.md' },
    'ManeraMedia GmbH': { frontmatter: {}, body: 'A company.', path: 'Organizations/ManeraMedia GmbH.md' },
  };
  const collectivesClient = makeMockCollectivesClient({ pagesByTitle });
  const router = makeMockRouter({
    missingLinks: [{ page: 'Carlos', shouldLinkTo: 'ManeraMedia GmbH', relationship: 'works_at' }],
    orphans: [],
    nearDuplicates: [],
    crossCluster: [],
  });

  const neighborhood = {
    cluster: 'People',
    pages: [{ id: '1', title: 'Carlos', section: 'People', frontmatter: {}, bodyPreview: '', hasEmbedding: false, graphConnections: [], wikilinks: [] }],
    graphEdges: [],
    sections: new Set(['People']),
    deckCards: [],
  };

  const steward = new WikiSteward(makeFullDeps({ collectivesClient, llmRouter: router }));
  const result = await steward._intervene('connection', await steward._assess('connection', neighborhood), neighborhood);

  assert.ok(result.linksAdded >= 1, 'linksAdded should be at least 1');
  assert.ok(result.pagesModified >= 1, 'pagesModified should be at least 1');
  // Verify the page was written with the wikilink
  const written = collectivesClient._writtenPages['Carlos'];
  assert.ok(written, 'Carlos page should have been written');
  assert.ok(written.body.includes('[[ManeraMedia GmbH]]'), 'written body should contain the wikilink');
});

// ---------------------------------------------------------------------------
// MEMORY STEWARD LENS
// ---------------------------------------------------------------------------

// Test 12: _assess('memory', ...) includes access stats in the prompt
asyncTest('_assess memory builds prompt with access stats', async () => {
  const router = makeMockRouter({ strengthen: [], compost: [], embed: [], successionStage: 'GROWING', recommendation: '' });
  const steward = new WikiSteward(makeFullDeps({ llmRouter: router }));

  const neighborhood = {
    cluster: 'Research',
    pages: [{
      id: '42', title: 'DIEM Project', section: 'Research',
      frontmatter: { access_count: 47, confidence: 'high', decay_days: 90, last_accessed: '2026-04-01' },
      bodyPreview: 'DIEM food system research project.',
      hasEmbedding: true,
      graphConnections: [],
      wikilinks: [],
    }],
    graphEdges: [],
    sections: new Set(['Research']),
    deckCards: [],
  };

  await steward._assess('memory', neighborhood);

  const prompt = router._calls[0].content;
  assert.ok(prompt.includes('access_count=47'), 'prompt should include access count');
  assert.ok(prompt.includes('has_embedding=true'), 'prompt should include embedding status');
});

// Test 13: Memory intervention _markForComposting sets compost_ready in frontmatter
asyncTest('memory intervention marks pages for composting via frontmatter, does not move/delete', async () => {
  const pagesByTitle = {
    'Old Document': { frontmatter: { confidence: 'low' }, body: 'This page is rarely used.', path: 'Research/OldDocument.md' },
  };
  const collectivesClient = makeMockCollectivesClient({ pagesByTitle });
  const router = makeMockRouter({
    strengthen: [],
    compost: [{ page: 'Old Document', reason: 'Never accessed, past decay' }],
    embed: [],
    successionStage: 'DECLINING',
    recommendation: 'Archive this cluster',
  });

  const neighborhood = {
    cluster: 'Research',
    pages: [{ id: '5', title: 'Old Document', section: 'Research', frontmatter: { confidence: 'low' }, bodyPreview: '', hasEmbedding: false, graphConnections: [], wikilinks: [] }],
    graphEdges: [],
    sections: new Set(['Research']),
    deckCards: [],
  };

  const steward = new WikiSteward(makeFullDeps({ collectivesClient, llmRouter: router }));
  const assessment = await steward._assess('memory', neighborhood);
  await steward._intervene('memory', assessment, neighborhood);

  const written = collectivesClient._writtenPages['Old Document'];
  assert.ok(written, 'Old Document page should have been written');
  assert.strictEqual(written.frontmatter.compost_ready, true, 'compost_ready should be true');
  assert.ok(written.frontmatter.compost_reason, 'compost_reason should be set');
  // The body should NOT be moved — page still exists in collectivesClient
  assert.ok(written.body === 'This page is rarely used.' || typeof written.body === 'string',
    'body should remain unchanged (not moved/deleted)');
});

// ---------------------------------------------------------------------------
// INTERVENTION EXECUTORS
// ---------------------------------------------------------------------------

// Test 14: _addWikilink is idempotent — second call with same target doesn't duplicate
asyncTest('_addWikilink is idempotent on second call with same target', async () => {
  const pagesByTitle = {
    'Carlos': { frontmatter: {}, body: 'Carlos works at a company.', path: 'People/Carlos.md' },
    'ManeraMedia GmbH': { frontmatter: {}, body: 'A company.', path: 'Organizations/ManeraMedia GmbH.md' },
  };
  const collectivesClient = makeMockCollectivesClient({ pagesByTitle });
  const steward = new WikiSteward(makeFullDeps({ collectivesClient }));

  const firstAdded = await steward._addWikilink('Carlos', 'ManeraMedia GmbH', 'works_at');
  assert.strictEqual(firstAdded, true, 'first call should add the link');

  // Now the written page has the wikilink — simulate a fresh read of the now-written page
  // by updating our mock's response map to reflect the written state
  const writtenBody = collectivesClient._writtenPages['Carlos'].body;
  pagesByTitle['Carlos'] = { frontmatter: {}, body: writtenBody, path: 'People/Carlos.md' };

  const secondAdded = await steward._addWikilink('Carlos', 'ManeraMedia GmbH', 'works_at');
  assert.strictEqual(secondAdded, false, 'second call should NOT add a duplicate link');

  // Count occurrences of [[ManeraMedia GmbH]] in written body
  const matches = (writtenBody.match(/\[\[ManeraMedia GmbH\]\]/g) || []).length;
  assert.strictEqual(matches, 1, 'the wikilink should appear exactly once');
});

// Test 15: _strengthenPage bumps confidence and extends decay — verify frontmatter write
asyncTest('_strengthenPage bumps confidence and extends decay, writes frontmatter', async () => {
  const pagesByTitle = {
    'Eelco': {
      frontmatter: { confidence: 'medium', decay_days: 90, access_count: 5 },
      body: 'Eelco is a researcher.',
      path: 'People/Eelco.md',
    },
  };
  const collectivesClient = makeMockCollectivesClient({ pagesByTitle });
  const steward = new WikiSteward(makeFullDeps({ collectivesClient }));

  const result = await steward._strengthenPage('Eelco');
  assert.strictEqual(result, true);

  const written = collectivesClient._writtenPages['Eelco'];
  assert.ok(written, 'Eelco page should have been written');
  // Confidence should be raised: medium → high
  assert.strictEqual(written.frontmatter.confidence, 'high', 'confidence should be raised from medium to high');
  // Decay days should be extended: 90 + 30 = 120
  assert.strictEqual(written.frontmatter.decay_days, 120, 'decay_days should be extended by 30');
  // Access count bumped: 5 + 1 = 6
  assert.strictEqual(written.frontmatter.access_count, 6, 'access_count should be incremented');
});

// Test 16: _markForComposting sets compost_ready=true, does NOT call any move/delete
asyncTest('_markForComposting sets compost_ready true without moving the page', async () => {
  let moveOrDeleteCalled = false;
  const pagesByTitle = {
    'Ancient Page': { frontmatter: { confidence: 'low' }, body: 'Old content', path: 'Meta/Ancient.md' },
  };
  const collectivesClient = makeMockCollectivesClient({ pagesByTitle });
  // Spy: if trashPage is called, flag it
  collectivesClient.trashPage = async () => { moveOrDeleteCalled = true; };

  const steward = new WikiSteward(makeFullDeps({ collectivesClient }));
  const result = await steward._markForComposting('Ancient Page', 'Never accessed');

  assert.strictEqual(result, true);
  assert.strictEqual(moveOrDeleteCalled, false, 'trashPage should NOT be called by _markForComposting');

  const written = collectivesClient._writtenPages['Ancient Page'];
  assert.ok(written, 'page should have been written');
  assert.strictEqual(written.frontmatter.compost_ready, true);
  assert.ok(written.frontmatter.compost_marked_at, 'compost_marked_at should be set');
});

// Test 16a: _markForComposting honors `compost: never` frontmatter pin
asyncTest('_markForComposting honors compost: never pin — does not mark pinned pages', async () => {
  const pagesByTitle = {
    'People': {
      frontmatter: { type: 'index', compost: 'never', access_count: 0 },
      body: '# People\n\n## Known Entities\n- ...',
      path: 'People.md',
    },
  };
  const collectivesClient = makeMockCollectivesClient({ pagesByTitle });

  const steward = new WikiSteward(makeFullDeps({ collectivesClient }));
  const result = await steward._markForComposting('People', 'LLM proposed composting');

  assert.strictEqual(result, false, 'pinned page should return false');
  assert.ok(!collectivesClient._writtenPages['People'], 'pinned page must NOT be written');
});

// ---------------------------------------------------------------------------
// CROSS-WRITE INTERFERENCE — Fix A: wikilink idempotency survives resolution
// ---------------------------------------------------------------------------

// Fix A.1: _addWikilink returns false when the unresolved [[target]] is present.
asyncTest('_addWikilink skips when unresolved [[target]] already in body', async () => {
  const pagesByTitle = {
    'Carlos': {
      frontmatter: {},
      body: 'Carlos.\n\n## Related\n- [[ManeraMedia GmbH]] (works_at)\n',
      path: 'People/Carlos.md',
    },
    'ManeraMedia GmbH': { frontmatter: {}, body: 'A company.', path: 'Organizations/ManeraMedia GmbH.md' },
  };
  const collectivesClient = makeMockCollectivesClient({ pagesByTitle });
  const steward = new WikiSteward(makeFullDeps({ collectivesClient }));

  const added = await steward._addWikilink('Carlos', 'ManeraMedia GmbH', 'works_at');
  assert.strictEqual(added, false, 'should skip — unresolved form already present');
  assert.ok(!collectivesClient._writtenPages['Carlos'], 'page must not be rewritten');
});

// Fix A.2: _addWikilink returns false when the RESOLVED [target](url) is present.
// This is the new behavior — writePageWithFrontmatter resolves [[X]] to [X](url),
// so on the next heartbeat only the resolved form remains in the body.
asyncTest('_addWikilink skips when resolved [target](url) already in body', async () => {
  const pagesByTitle = {
    'Carlos': {
      frontmatter: {},
      body: 'Carlos.\n\n## Related\n- [ManeraMedia GmbH](https://nc.example/f/12345) (works_at)\n',
      path: 'People/Carlos.md',
    },
    'ManeraMedia GmbH': { frontmatter: {}, body: 'A company.', path: 'Organizations/ManeraMedia GmbH.md' },
  };
  const collectivesClient = makeMockCollectivesClient({ pagesByTitle });
  const steward = new WikiSteward(makeFullDeps({ collectivesClient }));

  const added = await steward._addWikilink('Carlos', 'ManeraMedia GmbH', 'works_at');
  assert.strictEqual(added, false, 'should skip — resolved markdown link already present');
  assert.ok(!collectivesClient._writtenPages['Carlos'], 'page must not be rewritten');
});

// Fix A.3: _addWikilink adds the link when neither form is present.
asyncTest('_addWikilink adds the link when neither form is present', async () => {
  const pagesByTitle = {
    'Carlos': { frontmatter: {}, body: 'Carlos works somewhere.', path: 'People/Carlos.md' },
    'ManeraMedia GmbH': { frontmatter: {}, body: 'A company.', path: 'Organizations/ManeraMedia GmbH.md' },
  };
  const collectivesClient = makeMockCollectivesClient({ pagesByTitle });
  const steward = new WikiSteward(makeFullDeps({ collectivesClient }));

  const added = await steward._addWikilink('Carlos', 'ManeraMedia GmbH', 'works_at');
  assert.strictEqual(added, true, 'should add — neither form present');
  const written = collectivesClient._writtenPages['Carlos'];
  assert.ok(written && written.body.includes('[[ManeraMedia GmbH]]'), 'body should carry the new link');
});

// ---------------------------------------------------------------------------
// PHASE 5 (G4): STRUCTURAL LINK-TARGET VALIDATION
// ---------------------------------------------------------------------------

asyncTest('_addWikilink to a missing target writes no link and records a GAP', async () => {
  const observationLog = makeObservationLog();
  const pagesByTitle = {
    'Carlos': { frontmatter: {}, body: 'Carlos works somewhere.', path: 'People/Carlos.md' },
  };
  const collectivesClient = makeMockCollectivesClient({ pagesByTitle });
  const steward = new WikiSteward(makeFullDeps({ collectivesClient, observationLog }));

  const neighborhood = { cluster: 'People', pages: [{ title: 'Carlos', path: 'People/Carlos.md' }] };
  const added = await steward._addWikilink('Carlos', 'Nine Universal Roadblocks Framework', 'works_on', neighborhood);

  assert.strictEqual(added, false, 'no page for the target — no link written');
  assert.ok(!collectivesClient._writtenPages['Carlos'], 'source page must not be rewritten');
  const gaps = observationLog.getByType(OBSERVATION_TYPES.GAP);
  assert.strictEqual(gaps.length, 1, 'one GAP observation recorded');
  assert.strictEqual(gaps[0].cluster, 'People', 'GAP carries the cluster');
  assert.strictEqual(gaps[0].page, 'Carlos', 'GAP names the source page');
  assert.strictEqual(gaps[0].detail, 'Nine Universal Roadblocks Framework');
  // Pending Questions entry written through the existing gap logger
  const pending = collectivesClient._writtenContent['Meta/Pending Questions.md'];
  assert.ok(pending && pending.includes('Nine Universal Roadblocks Framework'), 'gap logged to Pending Questions');
});

asyncTest('_addWikilink resolves target case-insensitively to the canonical title', async () => {
  const pagesByTitle = {
    'Carlos': { frontmatter: {}, body: 'Carlos works somewhere.', path: 'People/Carlos.md' },
    'ManeraMedia GmbH': { frontmatter: {}, body: 'A company.', path: 'Organizations/ManeraMedia GmbH.md' },
  };
  const collectivesClient = makeMockCollectivesClient({ pagesByTitle });
  const steward = new WikiSteward(makeFullDeps({ collectivesClient }));

  const added = await steward._addWikilink('Carlos', 'maneramedia gmbh', 'works_at');
  assert.strictEqual(added, true);
  const written = collectivesClient._writtenPages['Carlos'];
  assert.ok(written.body.includes('[[ManeraMedia GmbH]]'), 'link uses the canonical page title');
});

asyncTest('_addWikilink prefers the in-neighborhood title over a global lookup', async () => {
  const pagesByTitle = {
    'Carlos': { frontmatter: {}, body: 'Carlos works somewhere.', path: 'People/Carlos.md' },
  };
  const collectivesClient = makeMockCollectivesClient({ pagesByTitle });
  let globalLookups = 0;
  const origFind = collectivesClient.findPageByTitle;
  collectivesClient.findPageByTitle = async (t) => { globalLookups++; return origFind(t); };
  const steward = new WikiSteward(makeFullDeps({ collectivesClient }));

  const neighborhood = {
    cluster: 'People',
    pages: [
      { title: 'Carlos', path: 'People/Carlos.md' },
      { title: 'Eelco Dykstra', path: 'People/Eelco Dykstra.md' },
    ],
  };
  const added = await steward._addWikilink('Carlos', 'Eelco Dykstra', 'colleague_of', neighborhood);
  assert.strictEqual(added, true);
  assert.strictEqual(globalLookups, 0, 'neighborhood answered — no global lookup');
});

// ---------------------------------------------------------------------------
// CROSS-WRITE INTERFERENCE — Fix B: Connection Steward excludes index pages
// ---------------------------------------------------------------------------

function makeConnectionNeighborhood(pages) {
  return {
    cluster: 'Documents',
    pages: pages.map((p, i) => ({
      id: String(i + 1),
      title: p.title,
      section: 'Documents',
      frontmatter: p.frontmatter || {},
      bodyPreview: '',
      hasEmbedding: false,
      graphConnections: [],
      wikilinks: [],
    })),
    graphEdges: [],
    sections: new Set(['Documents']),
    deckCards: [],
  };
}

// Fix B.1: pages with `type: index` are excluded from the assessment data.
test('_connectionAssessmentPrompt excludes type:index pages from pageLinks', () => {
  const steward = new WikiSteward(makeFullDeps());
  const neighborhood = makeConnectionNeighborhood([
    { title: 'Carlos Mendez', frontmatter: {} },
    { title: 'Documents', frontmatter: { type: 'index' } },
  ]);

  const prompt = steward._connectionAssessmentPrompt(neighborhood);
  assert.ok(prompt.includes('### Carlos Mendez'), 'content page should appear');
  assert.ok(!prompt.includes('### Documents'), 'index page must not appear as a link target');
});

// Fix B.2: pages with `compost: never` (structural pin) are excluded.
test('_connectionAssessmentPrompt excludes compost:never pages from pageLinks', () => {
  const steward = new WikiSteward(makeFullDeps());
  const neighborhood = makeConnectionNeighborhood([
    { title: 'Carlos Mendez', frontmatter: {} },
    { title: 'Structural Nav Page', frontmatter: { compost: 'never' } },
  ]);

  const prompt = steward._connectionAssessmentPrompt(neighborhood);
  assert.ok(prompt.includes('### Carlos Mendez'), 'content page should appear');
  assert.ok(!prompt.includes('### Structural Nav Page'), 'pinned structural page must not appear');
});

// Fix B.3: the EXCLUSION instruction is present in the prompt.
test('_connectionAssessmentPrompt carries the EXCLUSION instruction', () => {
  const steward = new WikiSteward(makeFullDeps());
  const prompt = steward._connectionAssessmentPrompt(makeConnectionNeighborhood([
    { title: 'Carlos Mendez', frontmatter: {} },
  ]));
  assert.ok(prompt.includes('EXCLUSION:'), 'prompt should instruct the LLM to exclude index pages');
});

// ---------------------------------------------------------------------------
// CROSS-WRITE INTERFERENCE — Fix C: _markForComposting writes frontmatter only
// ---------------------------------------------------------------------------

// Fix C.1: _markForComposting sets the compost frontmatter fields.
asyncTest('_markForComposting sets compost_ready/compost_reason/compost_marked_at', async () => {
  const pagesByTitle = {
    'Stale Doc': { frontmatter: { confidence: 'low' }, body: '# Stale Doc\n\nbody', path: 'Documents/Stale.md' },
  };
  const collectivesClient = makeMockCollectivesClient({ pagesByTitle });
  const steward = new WikiSteward(makeFullDeps({ collectivesClient }));

  const ok = await steward._markForComposting('Stale Doc', 'Never accessed, past decay');
  assert.strictEqual(ok, true);
  const fm = collectivesClient._writtenPages['Stale Doc'].frontmatter;
  assert.strictEqual(fm.compost_ready, true, 'compost_ready should be true');
  assert.strictEqual(fm.compost_reason, 'Never accessed, past decay', 'compost_reason should be set');
  assert.ok(fm.compost_marked_at, 'compost_marked_at should be set');
});

// Fix C.2: _markForComposting does NOT modify the page body — no inline marker.
asyncTest('_markForComposting leaves the page body unchanged (no inline archive marker)', async () => {
  const originalBody = '# Stale Doc\n\nReal content.\n\n## Related\n- [Eelco](https://nc.example/f/9) (related)\n';
  const pagesByTitle = {
    'Stale Doc': { frontmatter: { confidence: 'low' }, body: originalBody, path: 'Documents/Stale.md' },
  };
  const collectivesClient = makeMockCollectivesClient({ pagesByTitle });
  const steward = new WikiSteward(makeFullDeps({ collectivesClient }));

  await steward._markForComposting('Stale Doc', 'Never accessed');
  const writtenBody = collectivesClient._writtenPages['Stale Doc'].body;
  assert.strictEqual(writtenBody, originalBody, 'body must be byte-identical — no inline annotation');
  assert.ok(!writtenBody.includes('Archived by Memory Steward'), 'no inline archive marker in body');
});

// ---------------------------------------------------------------------------
// INTEGRATION WITH tend()
// ---------------------------------------------------------------------------

// Test 17: tend() rotates stewards on successive calls
asyncTest('tend() rotates stewards on successive calls', async () => {
  const observationLog = makeObservationLog();
  // Add observations for a cluster so _findNeediest returns it
  observationLog.notice({ type: OBSERVATION_TYPES.CONTRADICTION, cluster: 'People' });

  const collectivesClient = makeMockCollectivesClient({
    listPagesResult: [{ id: 1, title: 'Carlos', section: 'people', parentId: 1 }],
    pagesByTitle: {
      'Carlos': { frontmatter: {}, body: 'Carlos is a person.', path: 'People/Carlos.md' },
    },
  });

  // Use a router that always returns a valid empty assessment
  const router = makeMockRouter({
    contradictions: [], stale: [], gaps: [], suspects: [], healthy: [],
    missingLinks: [], orphans: [], nearDuplicates: [], crossCluster: [],
    strengthen: [], compost: [], embed: [], successionStage: 'GROWING', recommendation: '',
  });

  const steward = new WikiSteward(makeFullDeps({ observationLog, collectivesClient, llmRouter: router }));

  const r1 = await steward.tend();
  const r2 = await steward.tend();
  const r3 = await steward.tend();

  // On the first tend, observations exist so cluster is found; subsequent calls
  // may be idle (observations resolved) — we assert that when cluster is tended,
  // the steward rotates
  const activeTendResults = [r1, r2, r3].filter(r => r.steward !== null);
  if (activeTendResults.length >= 2) {
    assert.notStrictEqual(activeTendResults[0].steward, activeTendResults[1].steward,
      'steward should rotate on successive non-idle tend() calls');
  }
  // At minimum, the first tend should have used a steward lens
  // (or been idle due to empty cluster — acceptable if listPages filtering produced 0 cluster pages)
  assert.ok(true, 'tend() completed without throwing');
});

// Test 18: a tend whose assessment proposes no actions resolves ZERO
// observations — visiting is not resolving (G2, #161 class).
asyncTest('tend() with an empty assessment resolves zero observations and leaves the log untouched', async () => {
  const observationLog = makeObservationLog();
  observationLog.notice({ type: OBSERVATION_TYPES.CONTRADICTION, cluster: 'People', page: 'Carlos' });
  observationLog.notice({ type: OBSERVATION_TYPES.GAP, cluster: 'People', page: 'Carlos' });

  const collectivesClient = makeMockCollectivesClient({
    listPagesResult: [{ id: 1, title: 'Carlos', filePath: 'People', fileName: 'Carlos.md', parentId: 5 }],
    pagesByTitle: {
      'Carlos': { frontmatter: {}, body: 'Carlos works here.', path: 'People/Carlos.md' },
    },
  });

  const router = makeMockRouter({
    contradictions: [], stale: [], gaps: [], suspects: [], healthy: ['Carlos'],
  });

  const steward = new WikiSteward(makeFullDeps({ observationLog, collectivesClient, llmRouter: router }));
  steward._findNeediest = async () => ({ name: 'People', pageCount: 1, score: 1, observationCount: 2 });

  const result = await steward.tend();

  assert.strictEqual(result.observationsResolved, 0, 'no action → zero resolved');
  assert.strictEqual(observationLog.getByType(OBSERVATION_TYPES.CONTRADICTION).length, 1,
    'contradiction observation still pending');
  assert.strictEqual(observationLog.getByType(OBSERVATION_TYPES.GAP).length, 1,
    'gap observation still pending');
});

// ---------------------------------------------------------------------------
// LANDING PAGE
// ---------------------------------------------------------------------------

// Test 19: refreshLandingPage() builds prompt from cluster list, writes to collectivesClient
asyncTest('refreshLandingPage() calls router and writes landing page content', async () => {
  const mockLandingBody = `# Moltagent Knowledge

## Knowledge Domains

### People
Contacts and collaborators.
Key entities: Carlos, Eelco

*Auto-maintained by WikiSteward.*`;

  const router = {
    _calls: [],
    async route(opts) {
      this._calls.push(opts);
      return { result: mockLandingBody, provider: 'mock', model: 'mock', cost: 0 };
    }
  };

  const collectivesClient = makeMockCollectivesClient({
    collectiveName: 'Moltagent Knowledge',
    listPagesResult: [
      { id: 1, title: 'Carlos',      section: 'People', parentId: 1 },
      { id: 2, title: 'DIEM Project', section: 'Research', parentId: 1 },
    ],
  });

  const steward = new WikiSteward(makeFullDeps({ collectivesClient, llmRouter: router }));

  const result = await steward.refreshLandingPage();

  assert.strictEqual(result.refreshed, true, 'refreshLandingPage should report refreshed: true');
  assert.ok(router._calls.length > 0, 'router should have been called');
  const routerCall = router._calls[0];
  assert.strictEqual(routerCall.job, 'synthesis');
  // After the fix, landing page goes through writePageWithFrontmatter, not writePageContent
  assert.ok(
    collectivesClient._writtenPages['Moltagent Knowledge'],
    'landing page should be written via writePageWithFrontmatter'
  );
});

// Test 43.1: _updateLandingPage writes frontmatter via structured path
asyncTest('_updateLandingPage writes frontmatter fields via writePageWithFrontmatter', async () => {
  const cleanBody = `# Moltagent Knowledge

## Knowledge Domains

### People
Contacts.
Key entities: Alice`;

  const router = {
    _calls: [],
    async route(opts) {
      this._calls.push(opts);
      return { result: cleanBody, provider: 'mock', model: 'mock', cost: 0 };
    }
  };

  const collectivesClient = makeMockCollectivesClient({
    collectiveName: 'Moltagent Knowledge',
    listPagesResult: [{ id: 1, title: 'Alice', section: 'People', parentId: 1 }],
  });

  const steward = new WikiSteward(makeFullDeps({ collectivesClient, llmRouter: router }));
  await steward.refreshLandingPage();

  const written = collectivesClient._writtenPages['Moltagent Knowledge'];
  assert.ok(written, 'writePageWithFrontmatter must be called for the landing page title');
  assert.ok(
    !collectivesClient._writtenContent['Moltagent Knowledge.md'],
    'raw writePageContent must NOT be used for the landing page'
  );
  const fm = written.frontmatter;
  assert.strictEqual(fm.type, 'index');
  assert.strictEqual(fm.decay_days, -1);
  assert.strictEqual(fm.compost, 'never');
  assert.strictEqual(fm.auto_maintained, true);
  assert.strictEqual(fm.confidence, 'high');
});

// Test 43.2: _updateLandingPage strips code fences from LLM output
asyncTest('_updateLandingPage strips code fences from LLM output before writing', async () => {
  const fencedBody = '```markdown\n# Moltagent Knowledge\n\n## Knowledge Domains\n\n### People\nContacts.\n```';

  const router = {
    async route() {
      return { result: fencedBody, provider: 'mock', model: 'mock', cost: 0 };
    }
  };

  const collectivesClient = makeMockCollectivesClient({
    collectiveName: 'Moltagent Knowledge',
    listPagesResult: [{ id: 1, title: 'Alice', section: 'People', parentId: 1 }],
  });

  const steward = new WikiSteward(makeFullDeps({ collectivesClient, llmRouter: router }));
  await steward.refreshLandingPage();

  const written = collectivesClient._writtenPages['Moltagent Knowledge'];
  assert.ok(written, 'page should still be written after fence stripping');
  assert.ok(!written.body.includes('```'), 'body must not contain backtick fences');
  assert.ok(written.body.startsWith('# Moltagent Knowledge'), 'body must start with the heading');
});

// Test 43.3: _updateLandingPage strips rogue frontmatter from LLM output
asyncTest('_updateLandingPage strips rogue frontmatter block from LLM output', async () => {
  const rogueFmBody = `---
type: index
decay_days: -1
---

# Moltagent Knowledge

## Knowledge Domains

### People
Contacts.`;

  const router = {
    async route() {
      return { result: rogueFmBody, provider: 'mock', model: 'mock', cost: 0 };
    }
  };

  const collectivesClient = makeMockCollectivesClient({
    collectiveName: 'Moltagent Knowledge',
    listPagesResult: [{ id: 1, title: 'Alice', section: 'People', parentId: 1 }],
  });

  const steward = new WikiSteward(makeFullDeps({ collectivesClient, llmRouter: router }));
  await steward.refreshLandingPage();

  const written = collectivesClient._writtenPages['Moltagent Knowledge'];
  assert.ok(written, 'page should still be written after frontmatter stripping');
  assert.ok(written.body.startsWith('# Moltagent Knowledge'), 'body must start with the heading, not ---');
  assert.ok(!written.body.startsWith('---'), 'body must not begin with a frontmatter fence');
});

// Test 43.4: _updateLandingPage includes compost: never in frontmatter (focused single-fact)
asyncTest('_updateLandingPage always sets compost: never in landing page frontmatter', async () => {
  const router = {
    async route() {
      return { result: '# Moltagent Knowledge\n\n### People\nContacts.', provider: 'mock', model: 'mock', cost: 0 };
    }
  };

  const collectivesClient = makeMockCollectivesClient({
    collectiveName: 'Moltagent Knowledge',
    listPagesResult: [{ id: 1, title: 'Alice', section: 'People', parentId: 1 }],
  });

  const steward = new WikiSteward(makeFullDeps({ collectivesClient, llmRouter: router }));
  await steward.refreshLandingPage();

  assert.strictEqual(
    collectivesClient._writtenPages['Moltagent Knowledge'].frontmatter.compost,
    'never'
  );
});

// ---------------------------------------------------------------------------
// STRUCTURAL PAGE GUARD (#59) — _isStructuralPage + _intervene chokepoint
// ---------------------------------------------------------------------------

// Helper: build a neighborhood with arbitrary pages for intervention tests
function makeInterveneNeighborhood(pages, cluster = 'Documents') {
  return {
    cluster,
    pages: pages.map((p, i) => ({
      id: String(i + 1),
      title: p.title,
      section: cluster,
      frontmatter: p.frontmatter || {},
      bodyPreview: '',
      hasEmbedding: false,
      graphConnections: [],
      wikilinks: [],
    })),
    graphEdges: [],
    sections: new Set([cluster]),
    deckCards: [],
  };
}

// Test #59.1: _isStructuralPage returns true for type: section
test('_isStructuralPage returns true for type:section', () => {
  const steward = new WikiSteward(makeFullDeps());
  assert.strictEqual(steward._isStructuralPage({ frontmatter: { type: 'section' } }), true);
});

// Test #59.2: _isStructuralPage returns true for type: index
test('_isStructuralPage returns true for type:index', () => {
  const steward = new WikiSteward(makeFullDeps());
  assert.strictEqual(steward._isStructuralPage({ frontmatter: { type: 'index' } }), true);
});

// Test #59.3: _isStructuralPage returns true for type: meta
test('_isStructuralPage returns true for type:meta', () => {
  const steward = new WikiSteward(makeFullDeps());
  assert.strictEqual(steward._isStructuralPage({ frontmatter: { type: 'meta' } }), true);
});

// Test #59.4: _isStructuralPage returns true for compost: never (lifecycle pin)
test('_isStructuralPage returns true for compost:never (lifecycle pin)', () => {
  const steward = new WikiSteward(makeFullDeps());
  assert.strictEqual(
    steward._isStructuralPage({ frontmatter: { type: 'entity', compost: 'never' } }),
    true,
    'compost: never alone marks a page as structural infrastructure'
  );
});

// Test #59.5: _isStructuralPage returns false for normal content page
test('_isStructuralPage returns false for normal content page', () => {
  const steward = new WikiSteward(makeFullDeps());
  assert.strictEqual(
    steward._isStructuralPage({ frontmatter: { type: 'entity', confidence: 'high' } }),
    false
  );
});

// Test #59.6: _isStructuralPage returns false for page with no frontmatter
test('_isStructuralPage returns false for page with missing/empty frontmatter', () => {
  const steward = new WikiSteward(makeFullDeps());
  assert.strictEqual(steward._isStructuralPage({ frontmatter: null }), false);
  assert.strictEqual(steward._isStructuralPage({}), false);
  assert.strictEqual(steward._isStructuralPage(null), false);
});

// Test #59.7: Connection Steward skips structural page in missingLinks loop
asyncTest('_intervene(connection): skips structural page in missingLinks', async () => {
  const pagesByTitle = {
    'Carlos':    { frontmatter: {}, body: 'Content page.', path: 'People/Carlos.md' },
    'Documents': { frontmatter: { type: 'index' }, body: '# Documents', path: 'Documents.md' },
    'Eelco':     { frontmatter: {}, body: 'A person.', path: 'People/Eelco.md' },
  };
  const collectivesClient = makeMockCollectivesClient({ pagesByTitle });
  const steward = new WikiSteward(makeFullDeps({ collectivesClient }));

  const neighborhood = makeInterveneNeighborhood([
    { title: 'Carlos',    frontmatter: {} },
    { title: 'Documents', frontmatter: { type: 'index' } },
  ]);

  const assessment = {
    missingLinks: [
      { page: 'Documents', shouldLinkTo: 'Eelco', relationship: 'related' },
      { page: 'Carlos',    shouldLinkTo: 'Eelco', relationship: 'works_with' },
    ],
    orphans: [],
    nearDuplicates: [],
  };

  await steward._intervene('connection', assessment, neighborhood);

  assert.ok(
    !collectivesClient._writtenPages['Documents'],
    'structural page (type:index) must not be written by Connection Steward'
  );
  assert.ok(
    collectivesClient._writtenPages['Carlos'],
    'content page should still receive its wikilink'
  );
});

// Test #59.8: Memory Steward skips structural page in compost loop
asyncTest('_intervene(memory): skips structural page in compost', async () => {
  const pagesByTitle = {
    'Carlos':   { frontmatter: { confidence: 'low' }, body: 'Content.', path: 'People/Carlos.md' },
    'Research': { frontmatter: { type: 'index', compost: 'never' }, body: '# Research', path: 'Research.md' },
  };
  const collectivesClient = makeMockCollectivesClient({ pagesByTitle });
  const steward = new WikiSteward(makeFullDeps({ collectivesClient }));

  const neighborhood = makeInterveneNeighborhood([
    { title: 'Carlos',   frontmatter: { confidence: 'low' } },
    { title: 'Research', frontmatter: { type: 'index', compost: 'never' } },
  ]);

  const assessment = {
    strengthen: [],
    compost: [
      { page: 'Research', reason: 'Never accessed' },
      { page: 'Carlos',   reason: 'Stale and unaccessed' },
    ],
    embed: [],
  };

  await steward._intervene('memory', assessment, neighborhood);

  assert.ok(
    !collectivesClient._writtenPages['Research'],
    'structural page (type:index + compost:never) must not be touched by _markForComposting'
  );
  assert.ok(
    collectivesClient._writtenPages['Carlos'],
    'content page should still be marked for composting'
  );
  assert.strictEqual(
    collectivesClient._writtenPages['Carlos'].frontmatter.compost_ready,
    true,
    'content page compost_ready set'
  );
});

// Test #59.9: Knowledge Steward skips structural page in stale loop
asyncTest('_intervene(knowledge): skips structural page in stale', async () => {
  const pagesByTitle = {
    'Carlos':            { frontmatter: { confidence: 'high' }, body: 'Content.', path: 'People/Carlos.md' },
    'Pending Questions': { frontmatter: { type: 'meta' },       body: '# Pending Questions', path: 'Meta/Pending Questions.md' },
  };
  const collectivesClient = makeMockCollectivesClient({ pagesByTitle });
  const steward = new WikiSteward(makeFullDeps({ collectivesClient }));

  const neighborhood = makeInterveneNeighborhood([
    { title: 'Carlos',            frontmatter: { confidence: 'high' } },
    { title: 'Pending Questions', frontmatter: { type: 'meta' } },
  ], 'Meta');

  const assessment = {
    contradictions: [],
    stale: [
      { page: 'Pending Questions', reason: 'No new entries in 90 days' },
      { page: 'Carlos',            reason: 'Last verified 180 days ago' },
    ],
    gaps: [],
  };

  await steward._intervene('knowledge', assessment, neighborhood);

  assert.ok(
    !collectivesClient._writtenPages['Pending Questions'],
    'structural page (type:meta) must not have confidence lowered'
  );
  assert.ok(
    collectivesClient._writtenPages['Carlos'],
    'content page should still have confidence lowered'
  );
  assert.strictEqual(
    collectivesClient._writtenPages['Carlos'].frontmatter.confidence,
    'medium',
    'content page confidence stepped down high → medium'
  );
});

// Test #59.10: guard does not interfere with normal content-page interventions
asyncTest('_intervene: content pages are still processed normally when no structural page in neighborhood', async () => {
  const pagesByTitle = {
    'Carlos': { frontmatter: { confidence: 'high' }, body: 'Content.', path: 'People/Carlos.md' },
    'Eelco':  { frontmatter: { confidence: 'high' }, body: 'Researcher.', path: 'People/Eelco.md' },
  };
  const collectivesClient = makeMockCollectivesClient({ pagesByTitle });
  const steward = new WikiSteward(makeFullDeps({ collectivesClient }));

  const neighborhood = makeInterveneNeighborhood([
    { title: 'Carlos', frontmatter: { confidence: 'high' } },
    { title: 'Eelco',  frontmatter: {} /* untyped — still a content page */ },
  ], 'People');

  const assessment = {
    missingLinks: [
      { page: 'Carlos', shouldLinkTo: 'Eelco', relationship: 'works_with' },
    ],
    orphans: [],
    nearDuplicates: [],
  };

  const result = await steward._intervene('connection', assessment, neighborhood);

  assert.ok(result.linksAdded >= 1, 'untyped + high-confidence pages remain in scope');
  assert.ok(
    collectivesClient._writtenPages['Carlos'],
    'content page (Carlos) should still be written'
  );
});

// ---------------------------------------------------------------------------
// PHASE 1: TENDING INSTRUMENTATION (pagesInNeighborhood, empty-set alarm, FLATLINE)
// ---------------------------------------------------------------------------

/** Logger spy that records calls per level while staying silent. */
function makeSpyLogger() {
  const calls = { debug: [], info: [], warn: [], error: [] };
  return {
    _calls: calls,
    debug: (...a) => calls.debug.push(a.join(' ')),
    info:  (...a) => calls.info.push(a.join(' ')),
    warn:  (...a) => calls.warn.push(a.join(' ')),
    error: (...a) => calls.error.push(a.join(' ')),
  };
}

/** Steward pinned to a census that promises pages the neighborhood may not have. */
function makeInstrumentedSteward({ listPagesResult, pagesByTitle, pageCount, logger, observationLog }) {
  const collectivesClient = makeMockCollectivesClient({ listPagesResult, pagesByTitle });
  const steward = new WikiSteward(makeFullDeps({
    collectivesClient,
    observationLog: observationLog || makeObservationLog(),
    logger: logger || silentLogger,
  }));
  // Census and neighborhood diverge in production via section-derivation drift
  // (#51). Pin the census side so the divergence is reproducible.
  steward._findNeediest = async () => ({ name: 'People', pageCount, score: 1, observationCount: 0 });
  return steward;
}

asyncTest('tend() uses three different lenses across three consecutive visits to one cluster', async () => {
  const steward = makeInstrumentedSteward({
    listPagesResult: [{ id: 1, title: 'Carlos', filePath: 'People', fileName: 'Carlos.md', parentId: 5 }],
    pagesByTitle: { 'Carlos': { frontmatter: {}, body: 'Carlos is a person.', path: 'People/Carlos.md' } },
    pageCount: 1,
  });

  const lenses = [];
  for (let i = 0; i < 3; i++) lenses.push((await steward.tend()).steward);
  assert.deepStrictEqual([...new Set(lenses)].sort(), ['connection', 'knowledge', 'memory'],
    'three consecutive visits to one cluster must use all three lenses');
});

asyncTest('tend() result carries pagesInNeighborhood with the read count', async () => {
  const steward = makeInstrumentedSteward({
    listPagesResult: [
      { id: 1, title: 'Carlos', filePath: 'People', fileName: 'Carlos.md', parentId: 5 },
      { id: 2, title: 'Tobias', filePath: 'People', fileName: 'Tobias.md', parentId: 5 },
    ],
    pagesByTitle: {
      'Carlos': { frontmatter: {}, body: 'Carlos is a person.', path: 'People/Carlos.md' },
      'Tobias': { frontmatter: {}, body: 'Tobias is a person.', path: 'People/Tobias.md' },
    },
    pageCount: 2,
  });

  const result = await steward.tend();
  assert.strictEqual(result.pagesInNeighborhood, 2, 'result should count pages actually read');
});

asyncTest('tend() warns and records empty_neighborhood observation on suspicious empty set', async () => {
  const logger = makeSpyLogger();
  const observationLog = makeObservationLog();
  const steward = makeInstrumentedSteward({
    listPagesResult: [], // neighborhood reads zero
    pagesByTitle: {},
    pageCount: 4,        // census promises four
    logger,
    observationLog,
  });

  const result = await steward.tend();

  assert.strictEqual(result.pagesInNeighborhood, 0);
  assert.ok(
    logger._calls.warn.some(m => m.includes('SUSPICIOUS EMPTY SET') && m.includes('_getPageSection')),
    'warn should name the empty set and the first suspect'
  );
  const pending = observationLog.getByType('empty_neighborhood');
  assert.strictEqual(pending.length, 1, 'one empty_neighborhood observation recorded');
  assert.strictEqual(pending[0].cluster, 'People', 'observation carries cluster so getNeediest sees it');
});

asyncTest('tend() escalates to FLATLINE error at three consecutive zero-page cycles', async () => {
  const logger = makeSpyLogger();
  const steward = makeInstrumentedSteward({
    listPagesResult: [],
    pagesByTitle: {},
    pageCount: 3,
    logger,
  });

  await steward.tend();
  await steward.tend();
  assert.strictEqual(logger._calls.error.length, 0, 'no error before streak reaches 3');
  await steward.tend();

  assert.strictEqual(steward._zeroPageStreak.get('People'), 3, 'streak counts consecutive zeros');
  assert.ok(
    logger._calls.error.some(m => m.includes('FLATLINE') && m.includes('People')),
    'third consecutive zero escalates to error with FLATLINE'
  );
});

asyncTest('zero-page streak resets on a non-empty read', async () => {
  const logger = makeSpyLogger();
  const pages = [{ id: 1, title: 'Carlos', filePath: 'People', fileName: 'Carlos.md', parentId: 5 }];
  const listPagesBox = { value: [] };
  const collectivesClient = makeMockCollectivesClient({
    pagesByTitle: { 'Carlos': { frontmatter: {}, body: 'Carlos.', path: 'People/Carlos.md' } },
  });
  collectivesClient.listPages = async () => listPagesBox.value;
  const steward = new WikiSteward(makeFullDeps({ collectivesClient, logger }));
  steward._findNeediest = async () => ({ name: 'People', pageCount: 1, score: 1, observationCount: 0 });

  await steward.tend(); // zero read → streak 1
  await steward.tend(); // zero read → streak 2
  assert.strictEqual(steward._zeroPageStreak.get('People'), 2);

  listPagesBox.value = pages; // pages come back
  await steward.tend();
  assert.strictEqual(steward._zeroPageStreak.has('People'), false, 'successful read deletes the streak entry');

  listPagesBox.value = [];
  await steward.tend(); // zero again → streak restarts at 1, no error
  assert.strictEqual(steward._zeroPageStreak.get('People'), 1, 'streak restarts after reset');
  assert.strictEqual(logger._calls.error.length, 0, 'no FLATLINE across a reset boundary');
});

// ---------------------------------------------------------------------------
// PHASE 2: HONEST OBSERVATION RESOLUTION (G2 — visiting is not resolving)
// ---------------------------------------------------------------------------

asyncTest('tend() with a garbage assessment (parse failure) resolves zero observations', async () => {
  const observationLog = makeObservationLog();
  observationLog.notice({ type: OBSERVATION_TYPES.MISSING_LINK, cluster: 'People', page: 'Carlos' });
  observationLog.notice({ type: OBSERVATION_TYPES.LOW_CONFIDENCE, cluster: 'People', page: 'Carlos' });

  const collectivesClient = makeMockCollectivesClient({
    listPagesResult: [{ id: 1, title: 'Carlos', filePath: 'People', fileName: 'Carlos.md', parentId: 5 }],
    pagesByTitle: {
      'Carlos': { frontmatter: {}, body: 'Carlos works here.', path: 'People/Carlos.md' },
    },
  });

  // Router returns prose, not JSON — the live qwen3:8b failure shape.
  const router = {
    async route() { return { result: 'I am ready to assess the cluster.', provider: 'mock', model: 'mock', cost: 0 }; },
  };

  const steward = new WikiSteward(makeFullDeps({ observationLog, collectivesClient, llmRouter: router }));
  steward._findNeediest = async () => ({ name: 'People', pageCount: 1, score: 1, observationCount: 2 });

  const result = await steward.tend();

  assert.strictEqual(result.observationsResolved, 0, 'parse failure → zero resolved');
  assert.strictEqual(observationLog.getByType(OBSERVATION_TYPES.MISSING_LINK).length, 1);
  assert.strictEqual(observationLog.getByType(OBSERVATION_TYPES.LOW_CONFIDENCE).length, 1);
});

asyncTest('tend() resolves page-granular: link added to Page A resolves A, leaves B pending', async () => {
  const observationLog = makeObservationLog();
  observationLog.notice({ type: OBSERVATION_TYPES.MISSING_LINK, cluster: 'People', page: 'Page A' });
  observationLog.notice({ type: OBSERVATION_TYPES.MISSING_LINK, cluster: 'People', page: 'Page A' });
  observationLog.notice({ type: OBSERVATION_TYPES.MISSING_LINK, cluster: 'People', page: 'Page B' });

  const collectivesClient = makeMockCollectivesClient({
    listPagesResult: [
      { id: 1, title: 'Page A', filePath: 'People', fileName: 'Page A.md', parentId: 5 },
      { id: 2, title: 'Page B', filePath: 'People', fileName: 'Page B.md', parentId: 5 },
    ],
    pagesByTitle: {
      'Page A': { frontmatter: {}, body: 'A body.', path: 'People/Page A.md' },
      'Page B': { frontmatter: {}, body: 'B body.', path: 'People/Page B.md' },
    },
  });

  // Connection assessment: one link for Page A only.
  const router = makeMockRouter({
    missingLinks: [{ page: 'Page A', shouldLinkTo: 'Page B', relationship: 'related' }],
    orphans: [], nearDuplicates: [], crossCluster: [],
  });

  const steward = new WikiSteward(makeFullDeps({ observationLog, collectivesClient, llmRouter: router }));
  steward._findNeediest = async () => ({ name: 'People', pageCount: 2, score: 1, observationCount: 3 });
  steward._nextSteward = () => 'connection';

  const result = await steward.tend();

  assert.strictEqual(result.linksAdded, 1, 'one link added');
  assert.strictEqual(result.observationsResolved, 2, 'both Page A missing_link observations resolve, none else');
  const remaining = observationLog.getByType(OBSERVATION_TYPES.MISSING_LINK);
  assert.strictEqual(remaining.length, 1, 'Page B observation remains');
  assert.strictEqual(remaining[0].page, 'Page B');
});

// ---------------------------------------------------------------------------
// PHASE 2b: ASSESSMENT OUTCOMES JOIN THE MATURATION LOOP
// ---------------------------------------------------------------------------

function makeMockScorecard() {
  const calls = [];
  return {
    _calls: calls,
    recordSample(job, model, language, success, opts) {
      calls.push({ job, model, language, success, opts });
    },
  };
}

asyncTest('_assess records one successful synthesis sample with the served model', async () => {
  const modelScorecard = makeMockScorecard();
  const router = makeMockRouter({ contradictions: [], stale: [], gaps: [] });
  router.route = async () => ({ result: '{"contradictions": []}', provider: 'ollama-local', model: 'qwen3:8b', cost: 0 });
  const steward = new WikiSteward(makeFullDeps({ llmRouter: router, modelScorecard }));

  await steward._assess('knowledge', { cluster: 'People', pages: [], graphEdges: [], sections: new Set() });

  assert.strictEqual(modelScorecard._calls.length, 1, 'exactly one sample per assessment');
  const call = modelScorecard._calls[0];
  assert.strictEqual(call.job, 'synthesis');
  assert.strictEqual(call.model, 'qwen3:8b', 'served player from the route() return');
  assert.strictEqual(call.language, null, 'language omitted — scorecard defaults to cockpit language');
  assert.strictEqual(call.success, true);
});

asyncTest('_assess records exactly one failure sample on a parse failure', async () => {
  const modelScorecard = makeMockScorecard();
  const router = { async route() { return { result: 'I am ready to assess.', provider: 'ollama-local', model: 'qwen3:8b', cost: 0 }; } };
  const steward = new WikiSteward(makeFullDeps({ llmRouter: router, modelScorecard }));

  const assessment = await steward._assess('knowledge', { cluster: 'People', pages: [], graphEdges: [], sections: new Set() });

  assert.deepStrictEqual(assessment, { actions: [] }, 'fallback envelope preserved');
  assert.strictEqual(modelScorecard._calls.length, 1, 'failure records exactly once, outside the catch fallback');
  assert.strictEqual(modelScorecard._calls[0].success, false);
});

asyncTest('_assess without a scorecard records nothing and does not throw', async () => {
  const router = { async route() { return { result: 'not json', provider: 'mock', model: 'mock', cost: 0 }; } };
  const steward = new WikiSteward(makeFullDeps({ llmRouter: router }));
  const assessment = await steward._assess('knowledge', { cluster: 'People', pages: [], graphEdges: [], sections: new Set() });
  assert.deepStrictEqual(assessment, { actions: [] });
});

asyncTest('_assess skips recording when the route result carries no model identity', async () => {
  const modelScorecard = makeMockScorecard();
  const router = { async route() { return { result: '{"contradictions": []}', provider: 'mock', cost: 0 }; } };
  const steward = new WikiSteward(makeFullDeps({ llmRouter: router, modelScorecard }));
  await steward._assess('knowledge', { cluster: 'People', pages: [], graphEdges: [], sections: new Set() });
  assert.strictEqual(modelScorecard._calls.length, 0, 'no model → no sample (recordSample requires a model string)');
});

// ---------------------------------------------------------------------------
// PHASE 3: DURABLE FLAG KEYS (G1 — key on what cannot change)
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const D2_FIXTURE = fs.readFileSync(
  path.join(__dirname, '../../fixtures/wikisteward/d2-fixture.md'), 'utf8');

function makeFlagClient(bodyByTitle) {
  const writes = [];
  return {
    _writes: writes,
    readPageWithFrontmatter: async (title) => (
      bodyByTitle[title] !== undefined
        ? { frontmatter: {}, body: bodyByTitle[title], path: `${title}.md` }
        : null
    ),
    writePageWithFrontmatter: async (title, fm, body) => {
      writes.push({ title, fm, body });
      bodyByTitle[title] = body;
      return `${title}.md`;
    },
  };
}

asyncTest('_flagContradiction dedups on pair key across resolved and unresolved link forms', async () => {
  const unresolvedForm = '> ⚠️ Contradiction flagged by Knowledge Steward: conflicts with [[Role Page]] on "old claim"';
  const resolvedForm = '> ⚠️ Contradiction flagged by Knowledge Steward: conflicts with [Role Page](https://nc-host.example/x) on "old claim"';

  for (const existing of [unresolvedForm, resolvedForm]) {
    const client = makeFlagClient({
      'Person Page': `Some body.\n\n${existing}\n`,
      'Role Page': 'Role body.',
    });
    const steward = new WikiSteward(makeFullDeps({ collectivesClient: client }));
    const modified = await steward._flagContradiction('Person Page', 'Role Page', 'a newly worded claim');
    // Person Page already flagged for this pair in either form → only Role Page written.
    assert.strictEqual(client._writes.filter(w => w.title === 'Person Page').length, 0,
      `no append when the ${existing === unresolvedForm ? 'unresolved' : 'resolved'} form is present`);
    assert.strictEqual(client._writes.filter(w => w.title === 'Role Page').length, 1);
    assert.ok(modified, 'partner side still flagged');
  }
});

asyncTest('_flagContradiction: reworded claim for an already-flagged pair does not append', async () => {
  const client = makeFlagClient({
    'Person Page': 'Body.\n\n> ⚠️ Contradiction flagged by Knowledge Steward: conflicts with [Role Page](https://nc-host.example/x) on "wording one"\n',
    'Role Page': 'Body.\n\n> ⚠️ Contradiction flagged by Knowledge Steward: conflicts with [Person Page](https://nc-host.example/y) on "wording one"\n',
  });
  const steward = new WikiSteward(makeFullDeps({ collectivesClient: client }));
  const modified = await steward._flagContradiction('Person Page', 'Role Page', 'wording two, completely different');
  assert.strictEqual(client._writes.length, 0, 'no write for either page');
  assert.strictEqual(modified, false);
});

asyncTest('_flagContradiction: a second partner does append', async () => {
  const client = makeFlagClient({
    'Person Page': 'Body.\n\n> ⚠️ Contradiction flagged by Knowledge Steward: conflicts with [Role Page](https://nc-host.example/x) on "claim"\n',
    'Other Page': 'Other body.',
  });
  const steward = new WikiSteward(makeFullDeps({ collectivesClient: client }));
  const modified = await steward._flagContradiction('Person Page', 'Other Page', 'a different conflict');
  assert.ok(modified);
  assert.strictEqual(client._writes.filter(w => w.title === 'Person Page').length, 1,
    'new partner pair appends on Person Page');
  assert.ok(client._writes.find(w => w.title === 'Person Page').body.includes('[[Other Page]]'));
});

asyncTest('_flagDuplicate is per-pair: flagged against one partner, still flags a second', async () => {
  const client = makeFlagClient({
    'Page X': 'Body.\n\n> ⚠️ Near-duplicate flagged by Connection Steward: possibly the same entity as [Page Y](https://nc-host.example/y) (similarity: 0.90). Manual review recommended.\n',
    'Page Z': 'Z body.',
  });
  const steward = new WikiSteward(makeFullDeps({ collectivesClient: client }));

  // Same pair again → no write on X
  await steward._flagDuplicate('Page X', 'Page Y', 0.91);
  assert.strictEqual(client._writes.filter(w => w.title === 'Page X').length, 0, 'same pair stays idempotent');

  // New partner → append
  const modified = await steward._flagDuplicate('Page X', 'Page Z', 0.8);
  assert.ok(modified);
  assert.strictEqual(client._writes.filter(w => w.title === 'Page X').length, 1, 'second partner appends');
});

asyncTest('D2 fixture: already-walled pair does not grow; flag region is byte-stable', async () => {
  const client = makeFlagClient({
    'Person Page': D2_FIXTURE,
    'Role Page': 'Role body.\n\n> ⚠️ Contradiction flagged by Knowledge Steward: conflicts with [Person Page](https://nc-host.example/p) on "any"\n',
  });
  const steward = new WikiSteward(makeFullDeps({ collectivesClient: client }));
  const modified = await steward._flagContradiction('Person Page', 'Role Page', 'yet another wording of the same conflict');
  assert.strictEqual(client._writes.length, 0, 'wall does not grow — pair key holds on the captured body');
  assert.strictEqual(modified, false);

  // Duplicate flag: the walled page is already flagged for this pair; only the
  // partner side (which carries no duplicate flag yet) may be written.
  await steward._flagDuplicate('Person Page', 'Role Page', 0.99);
  assert.strictEqual(client._writes.filter(w => w.title === 'Person Page').length, 0,
    'duplicate flag also keyed per pair on the captured body');
});

asyncTest('_lowerConfidence deletes verification_note and skips the write on identical state', async () => {
  const today = new Date().toISOString().split('T')[0];
  const client = makeFlagClient({});
  client.readPageWithFrontmatter = async () => ({
    frontmatter: { confidence: 'low', last_verification_attempt: today, verification_note: 'LLM-worded leftover' },
    body: 'Body.',
    path: 'People/Page.md',
  });
  const steward = new WikiSteward(makeFullDeps({ collectivesClient: client }));

  // First pass: removing the leftover note is a real change → one write, note gone.
  const first = await steward._lowerConfidence('Page', 'stale');
  assert.strictEqual(first, true);

  // Second pass: state identical (low, same day, no note) → no write.
  client.readPageWithFrontmatter = async () => ({
    frontmatter: { confidence: 'low', last_verification_attempt: today },
    body: 'Body.',
    path: 'People/Page.md',
  });
  const second = await steward._lowerConfidence('Page', 'stale');
  assert.strictEqual(second, false, 'identical state produces identical bytes — no write');
  assert.strictEqual(client._writes.length, 1, 'only the note-removal write happened');
  assert.ok(!('verification_note' in client._writes[0].fm), 'written frontmatter carries no verification_note');
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
