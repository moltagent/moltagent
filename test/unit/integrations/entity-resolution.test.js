/**
 * Entity Resolution Unit Tests
 *
 * Tests LLM-assisted entity resolution in the ingestion pipeline:
 * - String normalization (case, prefix, diacritics)
 * - LLM entity dedup (_findMatchingEntity)
 * - forceLocal enforcement
 * - Hallucination guard
 * - Integration flow (normalized path vs LLM path)
 *
 * Run: node test/unit/integrations/entity-resolution.test.js
 *
 * @module test/unit/integrations/entity-resolution
 */

'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

// Import normalizeEntityName directly from document-ingestor
const path = require('path');
const ingestorPath = path.resolve(__dirname, '../../../src/lib/integrations/document-ingestor.js');

// We need normalizeEntityName which is a module-level function.
// It's not exported, so we test it indirectly through _pageExists and _findMatchingEntity.
// For direct normalization tests, replicate the logic here for comparison.

// ============================================================
// Helpers
// ============================================================

/**
 * Build a minimal DocumentIngestor with mock dependencies.
 * @param {Object} [overrides]
 * @param {Function} [overrides.routeFn] - Mock LLM route function
 * @param {string[][]} [overrides.sectionPages] - Map of section → page titles
 * @returns {Object} DocumentIngestor instance
 */
function createTestIngestor({ routeFn, sectionPages = {} } = {}) {
  const routeCalls = [];

  const mockRouter = {
    route: async (request) => {
      routeCalls.push(request);
      if (routeFn) return routeFn(request);
      return { result: '{"match": false}' };
    },
  };

  const mockClassifier = routeFn !== undefined ? { router: mockRouter } : null;

  const mockWikiWriter = {
    listPages: async (section) => {
      const titles = sectionPages[section] || [];
      return {
        pages: titles.map((t, i) => ({ id: i + 1, title: t, parentId: 100 })),
        method: 'mock',
      };
    },
    createPage: async () => ({ success: true, method: 'mock' }),
  };

  // Build a minimal ingestor — only wire the deps we need for entity resolution
  const DocumentIngestor = require('../../../src/lib/integrations/document-ingestor');
  const ingestor = new DocumentIngestor({
    ncFilesClient: { readFileBuffer: async () => Buffer.from('test') },
    textExtractor: { extract: async () => 'test text' },
    entityExtractor: { extractEntitiesFromDocument: async () => [] },
    wikiWriter: mockWikiWriter,
    llmRouter: mockRouter,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });

  // Override the classifier with our mock
  if (mockClassifier) {
    ingestor.classifier = mockClassifier;
  }

  return { ingestor, routeCalls, mockWikiWriter };
}

// ============================================================
// String Normalization Tests (via _pageExists)
// ============================================================

asyncTest('1. Case match: "agri-food sector" matches "Agri-Food Sector"', async () => {
  const { ingestor } = createTestIngestor({
    sectionPages: { People: ['Agri-Food Sector'] },
  });
  const exists = await ingestor._pageExists('People', 'agri-food sector');
  assert.strictEqual(exists, true, 'Should match case-insensitively');
});

asyncTest('2. Prefix strip: "From Risk to Resilience" matches "Risk to Resilience"', async () => {
  const { ingestor } = createTestIngestor({
    sectionPages: { Projects: ['Risk to Resilience'] },
  });
  const exists = await ingestor._pageExists('Projects', 'From Risk to Resilience');
  assert.strictEqual(exists, true, 'Should strip "from" prefix');
});

asyncTest('3. No false match: "South America" does NOT match "South Africa"', async () => {
  const { ingestor } = createTestIngestor({
    sectionPages: { Organizations: ['South Africa'] },
  });
  const exists = await ingestor._pageExists('Organizations', 'South America');
  assert.strictEqual(exists, false, 'South America ≠ South Africa');
});

// ============================================================
// LLM Entity Resolution Tests (via _findMatchingEntity)
// ============================================================

asyncTest('4. Initials: "EHD" matches "Eelco H. Dykstra"', async () => {
  const { ingestor } = createTestIngestor({
    routeFn: () => ({
      result: '{"match": true, "index": 1, "reason": "initials match full name"}',
    }),
  });
  const result = await ingestor._findMatchingEntity(
    { name: 'EHD', type: 'person', description: '' },
    ['Eelco H. Dykstra']
  );
  assert.ok(result, 'Should find a match');
  assert.strictEqual(result.title, 'Eelco H. Dykstra');
});

asyncTest('5. Partial name: "Eelco" matches "Eelco H. Dykstra" (not Roberto)', async () => {
  const { ingestor } = createTestIngestor({
    routeFn: () => ({
      result: '{"match": true, "index": 1, "reason": "partial name matches full name"}',
    }),
  });
  const result = await ingestor._findMatchingEntity(
    { name: 'Eelco', type: 'person', description: '' },
    ['Eelco H. Dykstra', 'Roberto Manunta']
  );
  assert.ok(result, 'Should find a match');
  assert.strictEqual(result.title, 'Eelco H. Dykstra');
});

asyncTest('6. Name with title: "Eelco H. Dykstra, M.D." matches "Eelco H. Dykstra"', async () => {
  const { ingestor } = createTestIngestor({
    routeFn: () => ({
      result: '{"match": true, "index": 1, "reason": "same person with academic title"}',
    }),
  });
  const result = await ingestor._findMatchingEntity(
    { name: 'Eelco H. Dykstra, M.D.', type: 'person', description: '' },
    ['Eelco H. Dykstra']
  );
  assert.ok(result, 'Should find a match');
  assert.strictEqual(result.title, 'Eelco H. Dykstra');
});

asyncTest('7. Abbreviation: "CEN TC 391" matches "CEN Technical Committee TC 391"', async () => {
  const { ingestor } = createTestIngestor({
    routeFn: () => ({
      result: '{"match": true, "index": 1, "reason": "abbreviation of full name"}',
    }),
  });
  const result = await ingestor._findMatchingEntity(
    { name: 'CEN TC 391', type: 'organization', description: '' },
    ['CEN Technical Committee TC 391']
  );
  assert.ok(result, 'Should find a match');
  assert.strictEqual(result.title, 'CEN Technical Committee TC 391');
});

asyncTest('8. URL variant: "SVDC" matches "SVDC (www.svdc.nl)"', async () => {
  const { ingestor } = createTestIngestor({
    routeFn: () => ({
      result: '{"match": true, "index": 1, "reason": "same org, URL variant"}',
    }),
  });
  const result = await ingestor._findMatchingEntity(
    { name: 'SVDC', type: 'organization', description: '' },
    ['SVDC (www.svdc.nl)']
  );
  assert.ok(result, 'Should find a match');
  assert.strictEqual(result.title, 'SVDC (www.svdc.nl)');
});

asyncTest('9. OCR typo: "Ilco" matches "Ilko"', async () => {
  const { ingestor } = createTestIngestor({
    routeFn: () => ({
      result: '{"match": true, "index": 1, "reason": "OCR transcription error"}',
    }),
  });
  const result = await ingestor._findMatchingEntity(
    { name: 'Ilco', type: 'person', description: '' },
    ['Ilko'],
    'ocr'
  );
  assert.ok(result, 'Should find a match');
  assert.strictEqual(result.title, 'Ilko');
});

asyncTest('10. No match: "Roberto Manunta" with unrelated existing pages', async () => {
  const { ingestor } = createTestIngestor({
    routeFn: () => ({
      result: '{"match": false}',
    }),
  });
  const result = await ingestor._findMatchingEntity(
    { name: 'Roberto Manunta', type: 'person', description: '' },
    ['Eelco H. Dykstra', 'Gert-Jan Ludden']
  );
  assert.strictEqual(result, null, 'Should not match unrelated entities');
});

asyncTest('11. Conservative on roles: "Agrifood Lead" does not match people', async () => {
  const { ingestor } = createTestIngestor({
    routeFn: () => ({
      result: '{"match": false}',
    }),
  });
  const result = await ingestor._findMatchingEntity(
    { name: 'Agrifood Lead', type: 'person', description: '' },
    ['Eelco H. Dykstra', 'Gert-Jan Ludden']
  );
  assert.strictEqual(result, null, 'Role descriptions should not match by default');
});

asyncTest('12. Empty existing list → no match, no LLM call', async () => {
  const { ingestor, routeCalls } = createTestIngestor({
    routeFn: () => {
      throw new Error('Should not be called');
    },
  });
  const result = await ingestor._findMatchingEntity(
    { name: 'Test Entity', type: 'person', description: '' },
    []
  );
  assert.strictEqual(result, null, 'Empty list should return null');
  assert.strictEqual(routeCalls.length, 0, 'LLM should not be called');
});

asyncTest('13. Hallucination guard: LLM returns index out of range → treated as no match', async () => {
  const { ingestor } = createTestIngestor({
    routeFn: () => ({
      result: '{"match": true, "index": 99, "reason": "hallucinated match"}',
    }),
  });
  const result = await ingestor._findMatchingEntity(
    { name: 'Test', type: 'person', description: '' },
    ['Eelco H. Dykstra']
  );
  assert.strictEqual(result, null, 'Out-of-range index should be rejected');
});

// ============================================================
// Integration Tests
// ============================================================

asyncTest('14. Full flow: normalized match → LLM not called', async () => {
  const { ingestor, routeCalls } = createTestIngestor({
    routeFn: () => {
      throw new Error('LLM should not be called for normalized match');
    },
    sectionPages: { People: ['Eelco H. Dykstra'] },
  });

  // _pageExists checks all sections — seed the People section
  const exists = await ingestor._pageExists('People', 'eelco h. dykstra');
  assert.strictEqual(exists, true, 'Normalized match should find existing page');
  assert.strictEqual(routeCalls.length, 0, 'LLM should not be called');
});

asyncTest('15. Full flow: no normalized match → LLM called → match → merge', async () => {
  const { ingestor, routeCalls } = createTestIngestor({
    routeFn: () => ({
      result: '{"match": true, "index": 1, "reason": "initials match"}',
    }),
    sectionPages: { People: ['Eelco H. Dykstra'] },
  });

  // "EHD" won't normalize-match "Eelco H. Dykstra"
  const exists = await ingestor._pageExists('People', 'EHD');
  assert.strictEqual(exists, false, 'Normalized match should NOT find EHD');

  // But LLM should catch it
  const match = await ingestor._findMatchingEntity(
    { name: 'EHD', type: 'person', description: '' },
    ['Eelco H. Dykstra']
  );
  assert.ok(match, 'LLM should find match');
  assert.strictEqual(match.title, 'Eelco H. Dykstra');
  assert.strictEqual(routeCalls.length, 1, 'LLM should be called once');
});

asyncTest('16. Full flow: no match → new page created', async () => {
  const { ingestor, routeCalls } = createTestIngestor({
    routeFn: () => ({
      result: '{"match": false}',
    }),
    sectionPages: { People: ['Eelco H. Dykstra'] },
  });

  const exists = await ingestor._pageExists('People', 'Roberto Manunta');
  assert.strictEqual(exists, false, 'No normalized match for new entity');

  const match = await ingestor._findMatchingEntity(
    { name: 'Roberto Manunta', type: 'person', description: '' },
    ['Eelco H. Dykstra']
  );
  assert.strictEqual(match, null, 'LLM should confirm no match');
  assert.strictEqual(routeCalls.length, 1, 'LLM should be called');
});

asyncTest('17. forceLocal is set on LLM entity dedup call', async () => {
  const { ingestor, routeCalls } = createTestIngestor({
    routeFn: () => ({
      result: '{"match": false}',
    }),
  });

  await ingestor._findMatchingEntity(
    { name: 'Test', type: 'person', description: '' },
    ['Existing Person']
  );

  assert.strictEqual(routeCalls.length, 1, 'Should have made one LLM call');
  const call = routeCalls[0];
  assert.strictEqual(call.context?.forceLocal, true,
    'Entity resolution must use forceLocal: true — entity names may be client data');
});

// ============================================================
// Run
// ============================================================

setTimeout(() => { summary(); exitWithCode(); }, 500);
