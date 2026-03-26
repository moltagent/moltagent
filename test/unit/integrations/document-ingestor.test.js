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

/**
 * DocumentIngestor Unit Tests
 *
 * Run: node test/unit/integrations/document-ingestor.test.js
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const DocumentIngestor = require('../../../src/lib/integrations/document-ingestor');

// ── Mock factories ──────────────────────────────────────────────────────────

function makeNcFilesClient(overrides = {}) {
  return {
    readFileBuffer: overrides.readFileBuffer || (async () => Buffer.from('sample document content for testing purposes - enough characters')),
    listDirectory: overrides.listDirectory || (async () => [
      { name: 'report.pdf', type: 'file' },
      { name: 'notes.txt', type: 'file' },
      { name: 'image.jpg', type: 'file' },
    ]),
    getFileInfo: overrides.getFileInfo || (async () => ({ name: 'test', size: 1024 })),
  };
}

function makeTextExtractor(overrides = {}) {
  return {
    extract: overrides.extract || (async (buffer, filePath) => ({
      text: 'This is the extracted text content from the document. It has more than one hundred characters total.',
      truncated: false,
      totalLength: 100,
    })),
  };
}

function makeEntityExtractor(overrides = {}) {
  return {
    extractFromPage: overrides.extractFromPage || (async () => {}),
    extractEntitiesFromDocument: overrides.extractEntitiesFromDocument || (async () => ({
      summary: '',
      entities: [],
    })),
  };
}

function makeKnowledgeGraph(overrides = {}) {
  // Simulate a real KnowledgeGraph with _entities Map
  const graph = {
    _entities: new Map(),
    addEntity: overrides.addEntity || ((name, type) => {
      const id = `${type}:${name.toLowerCase()}`;
      graph._entities.set(id, { id, name, type, created: new Date().toISOString() });
      return id;
    }),
  };
  return graph;
}

function makeWikiWriter(overrides = {}) {
  return {
    createPage: overrides.createPage || (async () => ({ success: true, method: 'ocs' })),
    listPages: overrides.listPages || (async () => ({ pages: [], method: 'ocs' })),
  };
}

function makeSilentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function makeIngestor(ncOverrides = {}, textOverrides = {}, entityOverrides = {}, wikiOverrides = {}, opts = {}) {
  return new DocumentIngestor({
    ncFilesClient:   makeNcFilesClient(ncOverrides),
    textExtractor:   makeTextExtractor(textOverrides),
    entityExtractor: makeEntityExtractor(entityOverrides),
    knowledgeGraph:  makeKnowledgeGraph(),
    wikiWriter:      makeWikiWriter(wikiOverrides),
    logger:          makeSilentLogger(),
    ...opts,
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

console.log('\n=== DocumentIngestor Tests ===\n');

// 1. processFile: extracts entities, creates entity pages + reference stub
asyncTest('processFile extracts text and runs entity extraction', async () => {
  let entityCalled = false;
  let entityTitle;
  const wikiPages = [];

  const ingestor = new DocumentIngestor({
    ncFilesClient: makeNcFilesClient(),
    textExtractor: makeTextExtractor({
      extract: async () => ({
        text: 'Sarah Chen leads Project Phoenix at TheCatalyne. More text to pass the minimum threshold check here.',
        truncated: false,
        totalLength: 100,
      }),
    }),
    entityExtractor: makeEntityExtractor({
      extractEntitiesFromDocument: async (title, content) => {
        entityCalled = true;
        entityTitle = title;
        return {
          summary: 'This document discusses Project Phoenix led by Sarah Chen at TheCatalyne.',
          entities: [
            { name: 'Sarah Chen',      type: 'person',       significance: 'high', description: 'Leads Project Phoenix at TheCatalyne as principal engineer and project director.' },
            { name: 'Project Phoenix', type: 'project',      significance: 'high', description: 'Main project at TheCatalyne focused on cloud infrastructure modernization.' },
            { name: 'TheCatalyne',     type: 'organization', significance: 'high', description: 'Parent company for all projects in the enterprise solutions division.' },
          ],
        };
      },
    }),
    wikiWriter: makeWikiWriter({
      createPage: async (section, name, content) => {
        wikiPages.push({ section, name, content });
        return { success: true, method: 'ocs' };
      },
      listPages: async (section) => ({ pages: [], method: 'ocs' }),
    }),
    logger: makeSilentLogger(),
  });

  const result = await ingestor.processFile('Documents/report.pdf');

  assert.strictEqual(result.skipped, false, 'Should not be skipped');
  assert.strictEqual(entityCalled, true, 'entityExtractor.extractEntitiesFromDocument should be called');
  assert.strictEqual(entityTitle, 'report', 'Title should be filename without extension');
  assert.strictEqual(result.entitiesFound, 3, 'Should find 3 entities');
  assert.strictEqual(result.entityPagesCreated, 3, 'Should create 3 entity pages');

  // Check entity pages were created with correct sections
  const peoplePage = wikiPages.find(p => p.name === 'Sarah Chen');
  assert.ok(peoplePage, 'Sarah Chen entity page should be created');
  assert.strictEqual(peoplePage.section, 'People', 'Person entity goes to People section');
  assert.ok(peoplePage.content.includes('type: person'), 'Entity page should have typed frontmatter');
  assert.ok(peoplePage.content.includes('Leads Project Phoenix'), 'Entity page should include description');

  const projectPage = wikiPages.find(p => p.name === 'Project Phoenix');
  assert.ok(projectPage, 'Project Phoenix entity page should be created');
  assert.strictEqual(projectPage.section, 'Projects', 'Project entity goes to Projects section');

  // Check reference stub
  const stub = wikiPages.find(p => p.name === 'report');
  assert.ok(stub, 'Reference stub should be created');
  assert.ok(stub.content.includes('type: document-ref'), 'Stub should be type document-ref, not document');
  assert.ok(stub.content.includes('Sarah Chen'), 'Stub should list extracted entities');
  assert.ok(stub.content.includes('This document discusses Project Phoenix'), 'Stub should include LLM summary');
  assert.ok(!stub.content.includes('leads Project Phoenix at'), 'Stub should NOT contain the full extracted text');
});

// 2. processFile: skips already-processed files
asyncTest('processFile skips already-processed files', async () => {
  let downloadCount = 0;

  const ingestor = makeIngestor({
    readFileBuffer: async () => {
      downloadCount++;
      return Buffer.from('content with enough chars to pass minimum threshold requirement here');
    },
  });

  await ingestor.processFile('Documents/report.pdf');
  const second = await ingestor.processFile('Documents/report.pdf');

  assert.strictEqual(second.skipped, true, 'Second call should be skipped');
  assert.strictEqual(second.reason, 'already processed');
  assert.strictEqual(downloadCount, 1, 'File should only be downloaded once');
});

// 3. processFile: skips files with < 100 chars of text
asyncTest('processFile skips files with < 100 chars of text', async () => {
  const ingestor = makeIngestor(
    {},
    {
      extract: async () => ({
        text: 'Too short.',
        truncated: false,
        totalLength: 10,
      }),
    }
  );

  const result = await ingestor.processFile('Documents/tiny.txt');

  assert.strictEqual(result.skipped, true, 'Should be skipped');
  assert.ok(result.reason.includes('text too short'), `Expected 'text too short' in reason, got: ${result.reason}`);
});

// 4. processFile: handles unsupported file types
asyncTest('processFile handles unsupported file types', async () => {
  const ingestor = makeIngestor();

  const result = await ingestor.processFile('Documents/archive.zip');

  assert.strictEqual(result.skipped, true);
  assert.strictEqual(result.reason, 'unsupported file type');
});

// 5. processFile: handles download failure gracefully
asyncTest('processFile handles download failure gracefully', async () => {
  const ingestor = makeIngestor({
    readFileBuffer: async () => { throw new Error('Network timeout'); },
  });

  const result = await ingestor.processFile('Documents/report.pdf');

  assert.strictEqual(result.skipped, true);
  assert.ok(result.reason.includes('download failed'), `Expected 'download failed' in reason, got: ${result.reason}`);
  assert.ok(result.reason.includes('Network timeout'));
});

// 6. onFileEvent: filters non-file events (calendar, deck, etc.)
asyncTest('onFileEvent filters non-file events', async () => {
  let processFileCalled = false;

  const ingestor = makeIngestor();
  ingestor.processFile = async () => { processFileCalled = true; };

  await ingestor.onFileEvent({
    type: 'deck_card_created',
    objectType: 'deck_card',
    objectName: 'some-card',
  });

  assert.strictEqual(processFileCalled, false, 'processFile should not be called for non-file events');
});

// 7. onFileEvent: filters non-create/change event types
asyncTest('onFileEvent filters non-create/change events', async () => {
  let processFileCalled = false;

  const ingestor = makeIngestor();
  ingestor.processFile = async () => { processFileCalled = true; };

  await ingestor.onFileEvent({
    type: 'file_deleted',
    objectType: 'files',
    objectName: 'Documents/report.pdf',
  });

  assert.strictEqual(processFileCalled, false, 'processFile should not be called for file_deleted');
});

// 8. onFileEvent: processes file_created events
asyncTest('onFileEvent processes file_created events', async () => {
  let processedPath;

  const ingestor = makeIngestor();
  ingestor.processFile = async (filePath) => {
    processedPath = filePath;
    return { filePath, skipped: false, textLength: 200 };
  };

  await ingestor.onFileEvent({
    type: 'file_created',
    objectType: 'files',
    objectName: 'Documents/newfile.pdf',
  });

  assert.strictEqual(processedPath, 'Documents/newfile.pdf');
});

// 9. onFileEvent: re-ingests on file_changed (clears processed set)
asyncTest('onFileEvent re-ingests on file_changed (clears processed set)', async () => {
  let callCount = 0;

  const ingestor = makeIngestor();

  // Manually mark the file as already processed
  ingestor._processed.add('Documents/updated.txt');

  // Override processFile to count calls
  ingestor.processFile = async (filePath) => {
    callCount++;
    ingestor._processed.add(filePath);
    return { filePath, skipped: false, textLength: 200 };
  };

  await ingestor.onFileEvent({
    type: 'file_changed',
    objectType: 'file',
    objectName: 'Documents/updated.txt',
  });

  assert.strictEqual(callCount, 1, 'processFile should be called once after change');
  // Verify the processed set was cleared before the call
  // (processFile was called, which re-adds it)
  assert.ok(ingestor._processed.has('Documents/updated.txt'), 'File should be back in processed set after re-ingest');
});

// 10. ingestDirectory: processes a batch of files (recursive)
asyncTest('ingestDirectory processes batch of files', async () => {
  const processedPaths = [];

  const ingestor = makeIngestor({
    listDirectory: async (dir) => {
      if (dir === 'Documents') {
        return [
          { name: 'doc1.pdf', type: 'file' },
          { name: 'doc2.txt', type: 'file' },
          { name: 'image.png', type: 'file' },
          { name: 'archive.zip', type: 'file' },  // unsupported — should be filtered
          { name: 'subdir', type: 'directory' },   // directory — recursed into
        ];
      }
      if (dir === 'Documents/subdir') {
        return [
          { name: 'nested.md', type: 'file' },
        ];
      }
      return [];
    },
  });

  // Override processFile to capture calls
  ingestor.processFile = async (filePath) => {
    processedPaths.push(filePath);
    return { filePath, skipped: false, textLength: 200 };
  };

  const result = await ingestor.ingestDirectory('Documents');

  // 3 supported files in root + 1 in subdir = 4 total
  assert.strictEqual(result.total, 4, `Expected 4 supported files, got ${result.total}`);
  assert.ok(processedPaths.some(p => p.includes('doc1.pdf')), 'doc1.pdf should be processed');
  assert.ok(processedPaths.some(p => p.includes('doc2.txt')), 'doc2.txt should be processed');
  assert.ok(processedPaths.some(p => p.includes('image.png')), 'image.png should be processed');
  assert.ok(processedPaths.some(p => p.includes('subdir/nested.md')), 'nested.md in subdir should be processed');
});

// 11. ingestDirectory: calls progress callback
asyncTest('ingestDirectory calls progress callback', async () => {
  const progressUpdates = [];

  const ingestor = makeIngestor({
    listDirectory: async () => [
      { name: 'a.pdf', type: 'file' },
      { name: 'b.txt', type: 'file' },
    ],
  });

  ingestor.processFile = async (filePath) => {
    return { filePath, skipped: false, textLength: 150 };
  };

  await ingestor.ingestDirectory('Documents', {
    batchSize: 5,
    onProgress: (processed, total) => {
      progressUpdates.push({ processed, total });
    },
  });

  assert.ok(progressUpdates.length >= 1, 'onProgress should be called at least once');
  const last = progressUpdates[progressUpdates.length - 1];
  assert.strictEqual(last.total, 2, 'Total should be 2');
});

// 13. onFileEvent: handles share_created by scanning shared folder
asyncTest('onFileEvent handles share_created by scanning shared folder', async () => {
  let dirScanned = null;

  const ingestor = makeIngestor({
    listDirectory: async (dir) => {
      dirScanned = dir;
      return [{ name: 'shared-doc.pdf', type: 'file' }];
    },
  });

  ingestor.processFile = async (filePath) => {
    return { filePath, skipped: false, textLength: 200 };
  };

  ingestor.onFileEvent({
    type: 'share_created',
    objectType: 'share',
    objectName: 'SharedFolder',
  });

  // Wait for the serial queue to drain
  await ingestor._queue;

  assert.strictEqual(dirScanned, 'SharedFolder', 'Should scan the shared folder path');
});

// 14. onFileEvent: handles share_created for single file
asyncTest('onFileEvent handles share_created for single shared file', async () => {
  let processedPath = null;

  const ingestor = makeIngestor({
    listDirectory: async () => { throw new Error('Not a directory'); },
  });

  ingestor.processFile = async (filePath) => {
    processedPath = filePath;
    return { filePath, skipped: false, textLength: 200 };
  };

  // onFileEvent enqueues share events — call and then await the queue
  ingestor.onFileEvent({
    type: 'share_created',
    objectType: 'share',
    objectName: 'SharedFolder/report.pdf',
  });

  // Wait for the serial queue to drain
  await ingestor._queue;

  assert.strictEqual(processedPath, 'SharedFolder/report.pdf', 'Should process the shared file');
});

// 12. _truncateForExtraction truncates long text correctly
test('_truncateForExtraction truncates long text correctly', () => {
  const ingestor = makeIngestor();

  // Short text passes through unchanged
  const shortText = 'a'.repeat(100);
  assert.strictEqual(ingestor._truncateForExtraction(shortText), shortText);

  // Text exactly at threshold passes through unchanged
  const exactText = 'b'.repeat(12 * 1024);
  assert.strictEqual(ingestor._truncateForExtraction(exactText), exactText);

  // Long text gets truncated: head + separator + tail
  const head  = 'H'.repeat(10 * 1024);
  const mid   = 'M'.repeat(5000);
  const tail  = 'T'.repeat(2 * 1024);
  const long  = head + mid + tail;

  const result = ingestor._truncateForExtraction(long);

  // Should start with the head section
  assert.ok(result.startsWith('H'), 'Result should start with head content');
  // Should contain the truncation marker
  assert.ok(result.includes('middle truncated'), 'Result should include truncation marker');
  // Should end with the tail content
  assert.ok(result.endsWith('T'), 'Result should end with tail content');
  // Overall must be smaller than original
  assert.ok(result.length < long.length, 'Truncated result should be shorter than original');
});

// 15. processFile: skips entity wiki page when page already exists (dedup)
asyncTest('processFile skips entity wiki page when page already exists', async () => {
  const wikiPages = [];

  const ingestor = new DocumentIngestor({
    ncFilesClient: makeNcFilesClient(),
    textExtractor: makeTextExtractor({
      extract: async () => ({
        text: 'Carlos leads the team at TheCatalyne. More text to pass the minimum threshold check here and there, yes.',
        truncated: false,
        totalLength: 100,
      }),
    }),
    entityExtractor: makeEntityExtractor({
      extractEntitiesFromDocument: async () => ({
        summary: 'About Carlos at TheCatalyne.',
        entities: [
          { name: 'Carlos', type: 'person', significance: 'high', description: 'Team lead' },
        ],
      }),
    }),
    wikiWriter: makeWikiWriter({
      createPage: async (section, name, content) => {
        wikiPages.push({ section, name, content });
        return { success: true, method: 'ocs' };
      },
      listPages: async (section) => {
        if (section === 'People') {
          return { pages: [{ title: 'Carlos' }], method: 'ocs' };
        }
        return { pages: [], method: 'ocs' };
      },
    }),
    logger: makeSilentLogger(),
  });

  const result = await ingestor.processFile('Documents/team.txt');

  assert.strictEqual(result.entityPagesCreated, 0, 'Should not create page for existing entity');
  // Reference stub should still be created
  const stub = wikiPages.find(p => p.name === 'team');
  assert.ok(stub, 'Reference stub should still be created');
});

// 16. processFile: only creates wiki pages for high-significance entities
asyncTest('processFile only creates wiki pages for high-significance entities', async () => {
  const wikiPages = [];

  const ingestor = new DocumentIngestor({
    ncFilesClient: makeNcFilesClient(),
    textExtractor: makeTextExtractor({
      extract: async () => ({
        text: 'DeepSeek and Claude are used in the pipeline. Carlos manages it. Enough text to pass the threshold here.',
        truncated: false,
        totalLength: 100,
      }),
    }),
    entityExtractor: makeEntityExtractor({
      extractEntitiesFromDocument: async () => ({
        summary: 'Pipeline uses DeepSeek and Claude, managed by Carlos.',
        entities: [
          { name: 'Carlos',     type: 'person',  significance: 'high',   description: 'Pipeline manager at the team responsible for coordinating LLM model deployments.' },
          { name: 'DeepSeek',   type: 'tool',    significance: 'medium', description: 'LLM model used in the pipeline for inference tasks and classification.' },
          { name: 'Claude',     type: 'tool',    significance: 'medium', description: 'LLM model developed by Anthropic used for reasoning and analysis tasks.' },
          { name: 'Zero Trust', type: 'concept', significance: 'low',    description: 'Security concept that requires verification of every request to the system.' },
        ],
      }),
    }),
    wikiWriter: makeWikiWriter({
      createPage: async (section, name, content) => {
        wikiPages.push({ section, name, content });
        return { success: true, method: 'ocs' };
      },
      listPages: async () => ({ pages: [], method: 'ocs' }),
    }),
    logger: makeSilentLogger(),
  });

  const result = await ingestor.processFile('Documents/pipeline.txt');

  assert.strictEqual(result.entityPagesCreated, 1, 'Only Carlos (high significance person) should get a page');
  assert.strictEqual(result.entitiesFound, 4, 'All 4 entities should be counted');

  const entityPage = wikiPages.find(p => p.section === 'People');
  assert.ok(entityPage, 'People page should exist');
  assert.strictEqual(entityPage.name, 'Carlos');

  // No tool or concept pages
  assert.ok(!wikiPages.find(p => p.name === 'DeepSeek'),   'No page for medium-significance tool');
  assert.ok(!wikiPages.find(p => p.name === 'Claude'),     'No page for medium-significance tool');
  assert.ok(!wikiPages.find(p => p.name === 'Zero Trust'), 'No page for low-significance concept');
});

// 17. normalizeEntityName: strips (N) suffixes and collapses whitespace
test('normalizeEntityName handles edge cases', () => {
  // Access the module-scoped function via a fresh ingestor's _shouldCreateWikiPage
  const ingestor = makeIngestor();

  // Test via _shouldCreateWikiPage + _pageExists behavior
  // Protected page "Learning Log" blocks entity creation
  assert.strictEqual(
    ingestor._shouldCreateWikiPage({ name: 'Learning Log', type: 'organization', significance: 'high', description: 'test' }),
    false, 'Protected page "Learning Log" should be blocked'
  );
  assert.strictEqual(
    ingestor._shouldCreateWikiPage({ name: 'learning log', type: 'organization', significance: 'high', description: 'test' }),
    false, 'Protected page "learning log" (lowercase) should be blocked'
  );
  assert.strictEqual(
    ingestor._shouldCreateWikiPage({ name: '  Learning  Log  ', type: 'organization', significance: 'high', description: 'test' }),
    false, 'Protected page with extra whitespace should be blocked'
  );
});

// 17b. normalizeEntityName: articles, diacritics, trailing punctuation, prepositions
asyncTest('normalizeEntityName strips articles, diacritics, prepositions, and trailing punctuation', async () => {
  // We exercise the function indirectly via _pageExists, which normalizes both
  // the stored page title and the lookup name before comparing.

  // Helper: ingestor whose wiki has exactly one page in Organizations
  function makeIngestorWithPage(storedTitle) {
    return new DocumentIngestor({
      ncFilesClient: makeNcFilesClient(),
      textExtractor: makeTextExtractor(),
      entityExtractor: makeEntityExtractor(),
      knowledgeGraph: makeKnowledgeGraph(),
      wikiWriter: makeWikiWriter({
        listPages: async (section) => {
          if (section === 'Organizations') {
            return { pages: [{ title: storedTitle }], method: 'ocs' };
          }
          return { pages: [], method: 'ocs' };
        },
      }),
      logger: makeSilentLogger(),
    });
  }

  // Leading article EN: "The DIEM Foundation" ↔ "DIEM Foundation"
  let ingestor = makeIngestorWithPage('The DIEM Foundation');
  assert.strictEqual(
    await ingestor._pageExists('Organizations', 'DIEM Foundation'),
    true, '"DIEM Foundation" should match stored "The DIEM Foundation"'
  );

  // Leading article PT: "A Associação" ↔ "Associação"
  ingestor = makeIngestorWithPage('A Associação');
  assert.strictEqual(
    await ingestor._pageExists('Organizations', 'Associação'),
    true, '"Associação" should match stored "A Associação"'
  );

  // Leading article DE: "Die Bundesbank" ↔ "Bundesbank"
  ingestor = makeIngestorWithPage('Die Bundesbank');
  assert.strictEqual(
    await ingestor._pageExists('Organizations', 'Bundesbank'),
    true, '"Bundesbank" should match stored "Die Bundesbank"'
  );

  // Leading preposition: "From Risk to Resilience Movement" ↔ "Risk to Resilience Movement"
  ingestor = makeIngestorWithPage('Risk to Resilience Movement');
  assert.strictEqual(
    await ingestor._pageExists('Organizations', 'From Risk to Resilience Movement'),
    true, '"From Risk to Resilience Movement" should match stored "Risk to Resilience Movement"'
  );

  // Leading preposition: "Re: Budget Draft" ↔ "Budget Draft"
  ingestor = makeIngestorWithPage('Budget Draft');
  assert.strictEqual(
    await ingestor._pageExists('Organizations', 'Re: Budget Draft'),
    true, '"Re: Budget Draft" should match stored "Budget Draft"'
  );

  // Diacritics: "Associação" ↔ "Associacao"
  ingestor = makeIngestorWithPage('Associacao');
  assert.strictEqual(
    await ingestor._pageExists('Organizations', 'Associação'),
    true, '"Associação" should match stored "Associacao" after diacritic normalization'
  );

  // Trailing period: "DIEM Foundation." ↔ "DIEM Foundation"
  ingestor = makeIngestorWithPage('DIEM Foundation');
  assert.strictEqual(
    await ingestor._pageExists('Organizations', 'DIEM Foundation.'),
    true, '"DIEM Foundation." (trailing period) should match stored "DIEM Foundation"'
  );

  // Combined: article + diacritics + trailing punctuation
  ingestor = makeIngestorWithPage('Associacao');
  assert.strictEqual(
    await ingestor._pageExists('Organizations', 'A Associação.'),
    true, '"A Associação." should match stored "Associacao" after all normalizations'
  );

  // Collectives (N) suffix + article (existing behaviour preserved)
  ingestor = makeIngestorWithPage('The DIEM Foundation (2)');
  assert.strictEqual(
    await ingestor._pageExists('Organizations', 'DIEM Foundation'),
    true, '"DIEM Foundation" should match "(N)"-suffixed stored "The DIEM Foundation (2)"'
  );

  // Negative: genuinely different names must NOT match
  ingestor = makeIngestorWithPage('DIEM Foundation');
  assert.strictEqual(
    await ingestor._pageExists('Organizations', 'Something Else'),
    false, 'Different entity names must not collide after normalization'
  );
});

// 18. _shouldCreateWikiPage blocks entities with null descriptions
test('_shouldCreateWikiPage blocks null/empty descriptions', () => {
  const ingestor = makeIngestor();

  assert.strictEqual(
    ingestor._shouldCreateWikiPage({ name: 'Acme Corp', type: 'organization', significance: 'high', description: null }),
    false, 'null description should block page creation'
  );
  assert.strictEqual(
    ingestor._shouldCreateWikiPage({ name: 'Acme Corp', type: 'organization', significance: 'high', description: '' }),
    false, 'empty description should block page creation'
  );
  assert.strictEqual(
    ingestor._shouldCreateWikiPage({ name: 'Acme Corp', type: 'organization', significance: 'high', description: 'null' }),
    false, '"null" string description should block page creation'
  );
  assert.strictEqual(
    ingestor._shouldCreateWikiPage({ name: 'Acme Corp', type: 'organization', significance: 'high', description: 'A real established company that provides enterprise solutions globally.' }),
    true, 'Valid description (>= 50 chars) should allow page creation'
  );
});

// 22. _shouldCreateWikiPage rejects thin descriptions (< 20 chars)
test('_shouldCreateWikiPage rejects thin descriptions under 50 chars', () => {
  const ingestor = makeIngestor();

  assert.strictEqual(
    ingestor._shouldCreateWikiPage({ name: 'Acme Corp', type: 'organization', significance: 'high', description: 'Short desc' }),
    false, 'Description under 50 chars should be rejected'
  );
  assert.strictEqual(
    ingestor._shouldCreateWikiPage({ name: 'Acme Corp', type: 'organization', significance: 'high', description: 'A company providing enterprise solutions and tools.' }),
    true, 'Description of 51 chars should be accepted'
  );
  assert.strictEqual(
    ingestor._shouldCreateWikiPage({ name: 'Bob Smith', type: 'person', significance: 'high', description: 'A person mentioned here briefly.' }),
    false, 'Person with 31-char description should be rejected'
  );
});

// 23. _shouldCreateWikiPage rejects academic citations ("et al")
test('_shouldCreateWikiPage rejects academic citation names containing "et al"', () => {
  const ingestor = makeIngestor();

  assert.strictEqual(
    ingestor._shouldCreateWikiPage({ name: 'Zhang et al', type: 'person', significance: 'high', description: 'Authors of a referenced academic paper about climate' }),
    false, '"Zhang et al" should be rejected as an academic citation'
  );
  assert.strictEqual(
    ingestor._shouldCreateWikiPage({ name: 'Smith et al.', type: 'person', significance: 'high', description: 'Authors of a referenced academic paper about climate' }),
    false, '"Smith et al." (with period) should be rejected'
  );
  assert.strictEqual(
    ingestor._shouldCreateWikiPage({ name: 'Müller ET AL', type: 'person', significance: 'high', description: 'Authors of a referenced academic paper about climate' }),
    false, '"et al" check should be case-insensitive'
  );
  // Regular name containing no "et al" should still pass
  assert.strictEqual(
    ingestor._shouldCreateWikiPage({ name: 'Ethan Alvarez', type: 'person', significance: 'high', description: 'Lead engineer at the infrastructure team responsible for cloud deployments.' }),
    true, 'Name starting with "Et" but not "et al" should not be rejected'
  );
});

// 19. _pageExists checks all sections (cross-section dedup)
asyncTest('_pageExists checks all sections for cross-section dedup', async () => {
  const ingestor = new DocumentIngestor({
    ncFilesClient: makeNcFilesClient(),
    textExtractor: makeTextExtractor(),
    entityExtractor: makeEntityExtractor(),
    knowledgeGraph: makeKnowledgeGraph(),
    wikiWriter: makeWikiWriter({
      listPages: async (section) => {
        // "Sarah Chen" exists in People section
        if (section === 'People') {
          return { pages: [{ title: 'Sarah Chen' }], method: 'ocs' };
        }
        return { pages: [], method: 'ocs' };
      },
    }),
    logger: makeSilentLogger(),
  });

  // Even when checking Projects section, should find Sarah Chen from People
  const exists = await ingestor._pageExists('Projects', 'Sarah Chen');
  assert.strictEqual(exists, true, 'Should detect entity in a different section');

  // Non-existent entity
  const missing = await ingestor._pageExists('People', 'Nobody');
  assert.strictEqual(missing, false, 'Should return false for truly missing entity');
});

// 20. _pageExists blocks protected page names
asyncTest('_pageExists blocks protected page names', async () => {
  const ingestor = makeIngestor();

  const exists = await ingestor._pageExists('Documents', 'Knowledge Stats');
  assert.strictEqual(exists, true, 'Protected page "Knowledge Stats" should be blocked');

  const exists2 = await ingestor._pageExists('Documents', 'Pending Questions');
  assert.strictEqual(exists2, true, 'Protected page "Pending Questions" should be blocked');
});

// 21. _pageExists normalizes (N) suffixes for dedup
asyncTest('_pageExists normalizes Collectives (N) suffix collisions', async () => {
  const warnMessages = [];

  const ingestor = new DocumentIngestor({
    ncFilesClient: makeNcFilesClient(),
    textExtractor: makeTextExtractor(),
    entityExtractor: makeEntityExtractor(),
    knowledgeGraph: makeKnowledgeGraph(),
    wikiWriter: makeWikiWriter({
      listPages: async (section) => {
        if (section === 'Organizations') {
          return { pages: [{ title: 'Acme Corp (2)' }], method: 'ocs' };
        }
        return { pages: [], method: 'ocs' };
      },
    }),
    logger: { info: () => {}, warn: (msg) => warnMessages.push(msg), error: () => {} },
  });

  const exists = await ingestor._pageExists('Organizations', 'Acme Corp');
  assert.strictEqual(exists, true, '"Acme Corp (2)" should match "Acme Corp" after normalization');
  assert.ok(warnMessages.some(m => m.includes('Collision detected')), 'Should log collision warning');
});

// ── Teardown ────────────────────────────────────────────────────────────────

setTimeout(() => { summary(); exitWithCode(); }, 500);
