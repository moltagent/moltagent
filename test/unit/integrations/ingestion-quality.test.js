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
 * Ingestion Quality — Unit Tests
 *
 * Validates upstream ingestion quality improvements:
 *   Fix A: context field flows through entity extraction
 *   Fix B: 50-char minimum description for wiki page creation
 *   Fix C: fidelity-adjusted significance threshold (OCR → require high)
 *   Fix D: "Also mentioned" section in reference stubs
 *   Fix E: entity significance maps to frontmatter confidence
 *
 * Run: node test/unit/integrations/ingestion-quality.test.js
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const DocumentIngestor = require('../../../src/lib/integrations/document-ingestor');

// ── Minimal mock factories ──────────────────────────────────────────────────

function makeDeps(overrides = {}) {
  return {
    ncFilesClient: { readFileBuffer: async () => Buffer.from('x'), listDirectory: async () => [] },
    textExtractor: { extract: async () => ({ text: 'x', totalLength: 1 }) },
    entityExtractor: {
      extractFromPage: async () => {},
      extractEntitiesFromDocument: async () => ({ summary: '', entities: [] }),
    },
    wikiWriter: {
      createPage: async () => ({ success: true }),
      listPages: async () => ({ pages: [] }),
      readPage: async () => null,
      updatePage: async () => ({ success: true }),
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    ...overrides,
  };
}

function makeIngestor(overrides = {}) {
  return new DocumentIngestor(makeDeps(overrides));
}

// ── Fix B: 50-char minimum description ──────────────────────────────────────

test('rejects entities with description < 50 chars', () => {
  // TODO: Implement — call _shouldCreateWikiPage with a 49-char description,
  //       assert returns false. Entity: { name: 'Acme Corp', type: 'organization',
  //       significance: 'high', description: 'A software company based in Europe.' } (35 chars)
  const ingestor = makeIngestor();
  const entity = {
    name: 'Acme Corp',
    type: 'organization',
    significance: 'high',
    description: 'A software company based in Europe, doing stuff.', // 49 chars
  };
  assert.strictEqual(ingestor._shouldCreateWikiPage(entity), false);
});

test('accepts entities with description >= 50 chars', () => {
  // TODO: Implement — call _shouldCreateWikiPage with a 50-char description,
  //       assert returns true. Entity: org with high significance and 50+ char description.
  const ingestor = makeIngestor();
  const entity = {
    name: 'Acme Corp',
    type: 'organization',
    significance: 'high',
    description: 'A software company based in Europe that builds tools.', // 53 chars
  };
  assert.strictEqual(ingestor._shouldCreateWikiPage(entity), true);
});

// ── Fix C: Fidelity-adjusted significance threshold ─────────────────────────

test('OCR fidelity requires high significance for orgs', () => {
  // TODO: Implement — org with medium significance + fidelity='ocr' should be rejected
  const ingestor = makeIngestor();
  const entity = {
    name: 'Acme Corp',
    type: 'organization',
    significance: 'medium',
    description: 'A software company that provides enterprise solutions and tools.',
  };
  assert.strictEqual(ingestor._shouldCreateWikiPage(entity, 'ocr'), false);
});

test('OCR fidelity requires high significance for agents', () => {
  // TODO: Implement — agent with medium significance + fidelity='ocr' should be rejected
  const ingestor = makeIngestor();
  const entity = {
    name: 'SmartBot',
    type: 'agent',
    significance: 'medium',
    description: 'An AI assistant that helps with document processing tasks daily.',
  };
  assert.strictEqual(ingestor._shouldCreateWikiPage(entity, 'ocr'), false);
});

test('OCR fidelity allows high-significance entities', () => {
  // TODO: Implement — org with high significance + fidelity='ocr' should pass
  const ingestor = makeIngestor();
  const entity = {
    name: 'Anthropic',
    type: 'organization',
    significance: 'high',
    description: 'An AI safety company that develops Claude and other language models.',
  };
  assert.strictEqual(ingestor._shouldCreateWikiPage(entity, 'ocr'), true);
});

test('authored fidelity accepts medium-significance orgs', () => {
  // TODO: Implement — org with medium significance + fidelity='authored' should pass
  //       (orgs always qualify when not OCR-gated)
  const ingestor = makeIngestor();
  const entity = {
    name: 'Hetzner',
    type: 'organization',
    significance: 'medium',
    description: 'A German cloud hosting provider that offers dedicated and virtual servers.',
  };
  assert.strictEqual(ingestor._shouldCreateWikiPage(entity, 'authored'), true);
});

test('transcribed fidelity accepts medium-significance orgs', () => {
  // TODO: Implement — org with medium significance + fidelity='transcribed' should pass
  const ingestor = makeIngestor();
  const entity = {
    name: 'Hetzner',
    type: 'organization',
    significance: 'medium',
    description: 'A German cloud hosting provider that offers dedicated and virtual servers.',
  };
  assert.strictEqual(ingestor._shouldCreateWikiPage(entity, 'transcribed'), true);
});

// ── Fix E: Entity significance → frontmatter confidence ─────────────────────

test('buildEntityPage uses entity significance as confidence', () => {
  // TODO: Implement — entity with significance:'high' should produce
  //       frontmatter with confidence: high (not hardcoded medium)
  const ingestor = makeIngestor();
  const entity = {
    name: 'Anthropic',
    type: 'organization',
    significance: 'high',
    description: 'An AI safety company that develops Claude and other language models.',
  };
  const page = ingestor._buildEntityPage(entity, '/test/doc.pdf');
  assert.ok(page.includes('confidence: high'), 'should use entity significance as confidence');
  assert.ok(!page.includes('confidence: medium'), 'should NOT hardcode medium');
});

test('buildEntityPage falls back to medium when no significance', () => {
  // TODO: Implement — entity without significance field should default to medium
  const ingestor = makeIngestor();
  const entity = {
    name: 'SomeEntity',
    type: 'concept',
    description: 'A concept that appears in the document with some supporting context.',
  };
  const page = ingestor._buildEntityPage(entity, '/test/doc.pdf');
  assert.ok(page.includes('confidence: medium'), 'should fall back to medium');
});

// ── Fix D: "Also mentioned" section in reference stubs ──────────────────────

test('buildReferenceStub includes Also Mentioned section', () => {
  // TODO: Implement — pass alsoMentioned array to _buildReferenceStub,
  //       assert output contains "## Also Mentioned" heading and entity names
  const ingestor = makeIngestor();
  const extraction = { text: 'test content', totalLength: 100 };
  const entities = [
    { name: 'Anthropic', type: 'organization', significance: 'high',
      description: 'An AI safety company that develops Claude and other language models.' },
  ];
  const alsoMentioned = [
    { name: 'Node.js', type: 'tool', significance: 'low',
      description: 'A runtime for server-side JavaScript used in many projects.' },
    { name: 'WebDAV', type: 'concept', significance: 'low',
      description: 'A protocol for file access over HTTP used by Nextcloud for storage.' },
  ];

  const stub = ingestor._buildReferenceStub('/test/doc.pdf', extraction, 'A test doc', entities, alsoMentioned);
  assert.ok(stub.includes('## Also Mentioned'), 'should have Also Mentioned heading');
  assert.ok(stub.includes('Node.js'), 'should list Node.js');
  assert.ok(stub.includes('WebDAV'), 'should list WebDAV');
});

test('buildReferenceStub omits Also Mentioned when empty', () => {
  // TODO: Implement — empty alsoMentioned should NOT produce the heading
  const ingestor = makeIngestor();
  const extraction = { text: 'test content', totalLength: 100 };
  const entities = [];
  const alsoMentioned = [];

  const stub = ingestor._buildReferenceStub('/test/doc.pdf', extraction, 'A test doc', entities, alsoMentioned);
  assert.ok(!stub.includes('## Also Mentioned'), 'should NOT have Also Mentioned heading');
});

// ── Fix A: context field flows through ──────────────────────────────────────

test('entity context field flows through extraction result', () => {
  // TODO: Implement — verify EntityExtractor._processExtractionResult preserves context field
  //       This tests the data contract: context should survive the filter pipeline
  const EntityExtractor = require('../../../src/lib/memory/entity-extractor');
  const mockGraph = {
    addEntity: () => 'id-1',
    addTriple: () => {},
  };
  const extractor = new EntityExtractor({ knowledgeGraph: mockGraph });

  const parsed = {
    summary: 'A document about AI companies.',
    entities: [
      {
        name: 'Anthropic',
        type: 'organization',
        significance: 'high',
        description: 'An AI safety company.',
        context: 'Anthropic was founded in 2021 and focuses on AI safety research. They developed Claude.',
      },
    ],
    relationships: [],
  };

  const result = extractor._processExtractionResult(parsed);
  assert.strictEqual(result.entities.length, 1);
  assert.strictEqual(result.entities[0].context, 'Anthropic was founded in 2021 and focuses on AI safety research. They developed Claude.');
});

// ── Regression: existing behavior ───────────────────────────────────────────

test('shouldCreateWikiPage rejects null description', () => {
  // TODO: Implement — entity with description=null should be rejected
  const ingestor = makeIngestor();
  const entity = {
    name: 'SomeName',
    type: 'organization',
    significance: 'high',
    description: null,
  };
  assert.strictEqual(ingestor._shouldCreateWikiPage(entity), false);
});

// ── Run ─────────────────────────────────────────────────────────────────────

setTimeout(() => { summary(); exitWithCode(); }, 500);
