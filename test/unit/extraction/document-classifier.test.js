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
 * DocumentClassifier Unit Tests
 *
 * Run: node test/unit/extraction/document-classifier.test.js
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const { DocumentClassifier, TYPES } = require('../../../src/lib/extraction/document-classifier');

// ── Mock router ──────────────────────────────────────────────────────────────

const mockRouter = {
  route: async ({ content }) => {
    if (content.includes('Invoice'))          return { result: '{"type":"TRANSACTIONAL","confidence":0.9}' };
    if (content.includes('Minutes of meeting')) return { result: '{"type":"MEETING_RECORD","confidence":0.9}' };
    if (content.includes('Service Agreement')) return { result: '{"type":"AGREEMENT","confidence":0.9}' };
    if (content.includes('Architecture Brief')) return { result: '{"type":"TECHNICAL","confidence":0.9}' };
    if (content.includes('Team Directory'))    return { result: '{"type":"PEOPLE_HR","confidence":0.9}' };
    if (content.includes('Project Roadmap'))   return { result: '{"type":"PLANNING","confidence":0.9}' };
    if (content.includes('Dear Mr'))           return { result: '{"type":"CORRESPONDENCE","confidence":0.9}' };
    if (content.includes('template'))          return { result: '{"type":"TEMPLATE","confidence":0.9}' };
    return { result: '{"type":"REFERENCE","confidence":0.5}' };
  }
};

// Null logger to suppress output during tests
const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeClassifier(routerOverride) {
  return new DocumentClassifier({
    llmRouter: routerOverride || mockRouter,
    logger: silentLogger,
  });
}

// ── Pre-filter tests (synchronous — no LLM needed) ───────────────────────────

asyncTest('.mp4 file -> MEDIA (pre-filter)', async () => {
  const c = makeClassifier();
  const result = await c.classify('some video bytes', 'recording.mp4');
  assert.strictEqual(result.type, TYPES.MEDIA);
  assert.strictEqual(result.confidence, 1.0);
});

asyncTest('.env file -> SYSTEM (pre-filter)', async () => {
  const c = makeClassifier();
  const result = await c.classify('DB_PASSWORD=secret', '.env');
  assert.strictEqual(result.type, TYPES.SYSTEM);
  assert.strictEqual(result.confidence, 1.0);
});

asyncTest('.csv file -> DATA (pre-filter)', async () => {
  const c = makeClassifier();
  const result = await c.classify('id,name,value\n1,foo,bar', 'export.csv');
  assert.strictEqual(result.type, TYPES.DATA);
  assert.strictEqual(result.confidence, 1.0);
});

asyncTest('.pdf file -> null pre-filter (needs LLM)', async () => {
  // The pre-filter should NOT match .pdf; it falls through to the LLM path.
  // We verify by checking that the returned type comes from the mock router,
  // not a hard-coded MEDIA/SYSTEM/DATA constant.
  const c = makeClassifier();
  const text = 'Invoice from Acme Corp dated 2026-01-15 for services rendered.';
  const result = await c.classify(text, 'acme-invoice.pdf');
  // Invoice content -> TRANSACTIONAL from mock router
  assert.strictEqual(result.type, TYPES.TRANSACTIONAL);
});

asyncTest('.gitignore file -> SYSTEM (pre-filter, dotfile handling)', async () => {
  const c = makeClassifier();
  const result = await c.classify('node_modules/\ndist/', '.gitignore');
  assert.strictEqual(result.type, TYPES.SYSTEM);
  assert.strictEqual(result.confidence, 1.0);
});

// ── Classification tests (mock router) ───────────────────────────────────────

asyncTest('Invoice text -> TRANSACTIONAL', async () => {
  const c = makeClassifier();
  const text = 'Invoice #1042\nBilled to: Widget Co.\nInvoice from Acme for consulting services, Q1 2026.';
  const result = await c.classify(text, 'invoice-1042.pdf');
  assert.strictEqual(result.type, TYPES.TRANSACTIONAL);
  assert.ok(result.confidence >= 0.8);
});

asyncTest('Meeting minutes text -> MEETING_RECORD', async () => {
  const c = makeClassifier();
  const text = 'Minutes of meeting held on 2026-03-10\nAttendees: Alice, Bob\nDecisions: launch delayed by two weeks.';
  const result = await c.classify(text, 'meeting-2026-03-10.pdf');
  assert.strictEqual(result.type, TYPES.MEETING_RECORD);
  assert.ok(result.confidence >= 0.8);
});

asyncTest('Service agreement text -> AGREEMENT', async () => {
  const c = makeClassifier();
  const text = 'Service Agreement between Acme Corp and Widget Ltd, effective 2026-01-01. Both parties agree to the following terms and conditions.';
  const result = await c.classify(text, 'service-agreement.pdf');
  assert.strictEqual(result.type, TYPES.AGREEMENT);
  assert.ok(result.confidence >= 0.8);
});

asyncTest('Architecture spec text -> TECHNICAL', async () => {
  const c = makeClassifier();
  const text = 'Architecture Brief\nThis document describes the message routing layer used by the Moltagent security pipeline.';
  const result = await c.classify(text, 'arch-brief.pdf');
  assert.strictEqual(result.type, TYPES.TECHNICAL);
  assert.ok(result.confidence >= 0.8);
});

asyncTest('Team directory text -> PEOPLE_HR', async () => {
  const c = makeClassifier();
  const text = 'Team Directory\nAlice Smith - Engineering Lead\nBob Jones - Product Manager\nCarol Wu - QA Engineer';
  const result = await c.classify(text, 'team-directory.pdf');
  assert.strictEqual(result.type, TYPES.PEOPLE_HR);
  assert.ok(result.confidence >= 0.8);
});

asyncTest('Template file -> TEMPLATE', async () => {
  const c = makeClassifier();
  const text = 'This is a template for writing status reports. Fill in the template fields below.';
  const result = await c.classify(text, 'status-report-template.docx');
  assert.strictEqual(result.type, TYPES.TEMPLATE);
  assert.ok(result.confidence >= 0.8);
});

// ── Extraction prompt tests ───────────────────────────────────────────────────

test('getExtractionPrompt(TECHNICAL) returns non-null prompt', () => {
  const c = makeClassifier();
  const prompt = c.getExtractionPrompt(TYPES.TECHNICAL, 'Sample technical content about APIs.', 'spec.md');
  assert.ok(prompt !== null);
  assert.ok(typeof prompt === 'string' && prompt.length > 0);
});

test('getExtractionPrompt(TEMPLATE) returns null', () => {
  const c = makeClassifier();
  const prompt = c.getExtractionPrompt(TYPES.TEMPLATE, 'Fill in the blanks.', 'template.docx');
  assert.strictEqual(prompt, null);
});

test('getExtractionPrompt(SYSTEM) returns null', () => {
  const c = makeClassifier();
  const prompt = c.getExtractionPrompt(TYPES.SYSTEM, 'NODE_ENV=production', '.env');
  assert.strictEqual(prompt, null);
});

test('getExtractionPrompt(MEETING_RECORD) returns non-null prompt', () => {
  const c = makeClassifier();
  const prompt = c.getExtractionPrompt(TYPES.MEETING_RECORD, 'Minutes of meeting attended by Alice and Bob.', 'minutes.pdf');
  assert.ok(prompt !== null);
  assert.ok(typeof prompt === 'string' && prompt.length > 0);
});

// ── Parse fallback tests ──────────────────────────────────────────────────────

asyncTest('Invalid JSON response -> falls back to REFERENCE', async () => {
  const badJsonRouter = {
    route: async () => ({ result: 'this is not json at all' })
  };
  const c = makeClassifier(badJsonRouter);
  // Use text that won't match any TYPES keyword in the raw response
  const text = 'A document with content that is long enough to pass the 20 char gate.';
  const result = await c.classify(text, 'mystery.pdf');
  assert.strictEqual(result.type, TYPES.REFERENCE);
});

asyncTest('Unknown type from LLM -> falls back to REFERENCE', async () => {
  const unknownTypeRouter = {
    route: async () => ({ result: '{"type":"BOGUS_TYPE","confidence":0.9}' })
  };
  const c = makeClassifier(unknownTypeRouter);
  const text = 'A document with sufficient content to pass the minimum character gate.';
  const result = await c.classify(text, 'unknown.pdf');
  assert.strictEqual(result.type, TYPES.REFERENCE);
  assert.strictEqual(result.confidence, 0.5);
});

asyncTest('Type keyword in non-JSON text -> extracted with low confidence', async () => {
  // Raw response is not valid JSON but contains a known type keyword.
  // _parseClassification falls into the catch block and scans for keyword.
  const keywordRouter = {
    route: async () => ({ result: 'I think this is PLANNING document type.' })
  };
  const c = makeClassifier(keywordRouter);
  const text = 'A document with sufficient content to pass the minimum character gate.';
  const result = await c.classify(text, 'roadmap.pdf');
  assert.strictEqual(result.type, TYPES.PLANNING);
  assert.ok(result.confidence <= 0.5, `Expected low confidence, got ${result.confidence}`);
});

// ── Stats tests ───────────────────────────────────────────────────────────────

asyncTest('Pre-filter increments preFiltered counter', async () => {
  const c = makeClassifier();
  const before = c.getStats().preFiltered;
  await c.classify('data', 'video.mp4');
  await c.classify('data', 'audio.mp3');
  const after = c.getStats().preFiltered;
  assert.strictEqual(after, before + 2);
});

asyncTest('LLM classification increments llmClassified counter', async () => {
  const c = makeClassifier();
  const before = c.getStats().llmClassified;
  const text = 'Project Roadmap for Q2 2026: key milestones and deliverables are listed below.';
  await c.classify(text, 'roadmap.pdf');
  const after = c.getStats().llmClassified;
  assert.strictEqual(after, before + 1);
});

// ── Runner ────────────────────────────────────────────────────────────────────

setTimeout(() => { summary(); exitWithCode(); }, 500);
