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

  // Custom graph that simulates entity extraction adding new entities
  const graph = makeKnowledgeGraph();

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
      extractFromPage: async (title, content) => {
        entityCalled = true;
        entityTitle = title;
        // Simulate what EntityExtractor does: add entities to the graph
        graph.addEntity('Sarah Chen', 'person');
        graph.addEntity('Project Phoenix', 'project');
        graph.addEntity('TheCatalyne', 'organization');
      },
    }),
    knowledgeGraph: graph,
    wikiWriter: makeWikiWriter({
      createPage: async (section, name, content) => {
        wikiPages.push({ section, name, content });
        return { success: true, method: 'ocs' };
      },
    }),
    logger: makeSilentLogger(),
  });

  const result = await ingestor.processFile('Documents/report.pdf');

  assert.strictEqual(result.skipped, false, 'Should not be skipped');
  assert.strictEqual(entityCalled, true, 'entityExtractor.extractFromPage should be called');
  assert.strictEqual(entityTitle, 'report', 'Title should be filename without extension');
  assert.strictEqual(result.entitiesFound, 3, 'Should find 3 entities');
  assert.strictEqual(result.entityPagesCreated, 3, 'Should create 3 entity pages');

  // Check entity pages were created with correct sections
  const peoplePage = wikiPages.find(p => p.name === 'Sarah Chen');
  assert.ok(peoplePage, 'Sarah Chen entity page should be created');
  assert.strictEqual(peoplePage.section, 'People', 'Person entity goes to People section');
  assert.ok(peoplePage.content.includes('type: person'), 'Entity page should have typed frontmatter');

  const projectPage = wikiPages.find(p => p.name === 'Project Phoenix');
  assert.ok(projectPage, 'Project Phoenix entity page should be created');
  assert.strictEqual(projectPage.section, 'Projects', 'Project entity goes to Projects section');

  // Check reference stub (last wiki page created)
  const stub = wikiPages.find(p => p.name === 'report');
  assert.ok(stub, 'Reference stub should be created');
  assert.ok(stub.content.includes('type: document-ref'), 'Stub should be type document-ref, not document');
  assert.ok(stub.content.includes('Sarah Chen'), 'Stub should list extracted entities');
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

// ── Teardown ────────────────────────────────────────────────────────────────

setTimeout(() => { summary(); exitWithCode(); }, 500);
