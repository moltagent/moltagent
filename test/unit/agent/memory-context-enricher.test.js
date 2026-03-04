/*
 * MoltAgent - Sovereign AI Security Layer
 * Copyright (C) 2026 MoltAgent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const MemoryContextEnricher = require('../../../src/lib/agent/memory-context-enricher');

const silentLogger = { log() {}, info() {}, warn() {}, error() {}, debug() {} };

// -- Test 1: _extractSearchTerms finds capitalized names --
test('_extractSearchTerms finds capitalized entity names', () => {
  const enricher = new MemoryContextEnricher({ memorySearcher: {}, logger: silentLogger });

  const terms = enricher._extractSearchTerms('Who is Sarah from ManeraMedia?');
  assert.ok(terms.includes('Sarah'), `Should find "Sarah", got: ${terms}`);
  assert.ok(terms.includes('ManeraMedia'), `Should find "ManeraMedia", got: ${terms}`);
});

// -- Test 2: _extractSearchTerms finds "know about X" patterns --
test('_extractSearchTerms finds knowledge query patterns', () => {
  const enricher = new MemoryContextEnricher({ memorySearcher: {}, logger: silentLogger });

  const terms = enricher._extractSearchTerms('What do you know about reading documents?');
  assert.ok(terms.some(t => t.includes('reading documents')), `Should find "reading documents", got: ${terms}`);
});

// -- Test 3: _extractSearchTerms returns empty for simple messages --
test('_extractSearchTerms returns empty for greetings', () => {
  const enricher = new MemoryContextEnricher({ memorySearcher: {}, logger: silentLogger });

  assert.deepStrictEqual(enricher._extractSearchTerms('hi'), []);
  assert.deepStrictEqual(enricher._extractSearchTerms('thanks'), []);
  assert.deepStrictEqual(enricher._extractSearchTerms('ok'), []);
});

// -- Test 4: enrich returns null for greeting/chitchat intents --
asyncTest('enrich returns null for greeting intent (skipped)', async () => {
  const enricher = new MemoryContextEnricher({
    memorySearcher: { search: async () => [{ title: 'Should not reach' }] },
    logger: silentLogger
  });

  const result = await enricher.enrich('Hello there', 'greeting');
  assert.strictEqual(result, null, 'Should skip greeting intent');
});

// -- Test 5: enrich returns null for confirmation intent --
asyncTest('enrich returns null for confirmation intent', async () => {
  const enricher = new MemoryContextEnricher({
    memorySearcher: { search: async () => [{ title: 'Should not reach' }] },
    logger: silentLogger
  });

  const result = await enricher.enrich('Yes, do it', 'confirmation');
  assert.strictEqual(result, null, 'Should skip confirmation intent');
});

// -- Test 6: enrich returns null for wiki intent (executor handles it) --
asyncTest('enrich returns null for wiki intent (WikiExecutor handles its own lookups)', async () => {
  const enricher = new MemoryContextEnricher({
    memorySearcher: { search: async () => [{ title: 'Should not reach' }] },
    logger: silentLogger
  });

  const result = await enricher.enrich('What does the wiki say about Sarah?', 'wiki');
  assert.strictEqual(result, null, 'Should skip wiki intent');
});

// -- Test 7: enrich returns formatted context when wiki has matches --
asyncTest('enrich returns formatted context when wiki has matches', async () => {
  const enricher = new MemoryContextEnricher({
    memorySearcher: {
      search: async () => [
        { source: 'Wiki', title: 'Sarah', excerpt: 'Sarah is the marketing lead at ManeraMedia' },
        { source: 'Wiki', title: 'ManeraMedia', excerpt: 'ManeraMedia is a podcast production company' }
      ]
    },
    logger: silentLogger
  });

  const result = await enricher.enrich('Tell me about Sarah from ManeraMedia', 'search');
  assert.ok(result !== null, 'Should return enrichment');
  assert.ok(result.includes('Sarah'), 'Should include Sarah page');
  assert.ok(result.includes('ManeraMedia'), 'Should include ManeraMedia page');
  assert.ok(result.includes('<agent_knowledge>'), 'Should wrap in agent_knowledge tags');
  assert.ok(result.includes('source:'), 'Should include source tag');
  assert.ok(result.includes('confidence:'), 'Should include confidence tag');
});

// -- Test 8: enrich returns null when no search results --
asyncTest('enrich returns null when search finds nothing', async () => {
  const enricher = new MemoryContextEnricher({
    memorySearcher: { search: async () => [] },
    logger: silentLogger
  });

  const result = await enricher.enrich('Tell me about Carlos', 'search');
  assert.strictEqual(result, null, 'Should return null when no results');
});

// -- Test 9: enrich returns null on timeout --
asyncTest('enrich returns null on timeout without blocking', async () => {
  const enricher = new MemoryContextEnricher({
    memorySearcher: {
      search: async () => {
        // Simulate slow search
        await new Promise(resolve => setTimeout(resolve, 5000));
        return [{ title: 'Should not reach' }];
      }
    },
    logger: silentLogger,
    timeout: 50 // 50ms timeout for test speed
  });

  const start = Date.now();
  const result = await enricher.enrich('Tell me about Carlos', 'search');
  const elapsed = Date.now() - start;

  assert.strictEqual(result, null, 'Should return null on timeout');
  assert.ok(elapsed < 1000, `Should complete quickly (timeout), took ${elapsed}ms`);
});

// -- Test 10: _extractSearchTerms filters common starters --
test('_extractSearchTerms filters common sentence starters', () => {
  const enricher = new MemoryContextEnricher({ memorySearcher: {}, logger: silentLogger });

  const terms = enricher._extractSearchTerms('The project FileOps is ready');
  assert.ok(!terms.includes('The'), 'Should filter "The"');
  assert.ok(terms.includes('FileOps'), `Should keep "FileOps", got: ${terms}`);
});

// -- Test 11: _extractSearchTerms finds quoted terms --
test('_extractSearchTerms finds quoted terms', () => {
  const enricher = new MemoryContextEnricher({ memorySearcher: {}, logger: silentLogger });

  const terms = enricher._extractSearchTerms('Search for "onboarding process" in the wiki');
  assert.ok(terms.some(t => t.includes('onboarding process')), `Should find quoted term, got: ${terms}`);
});

// -- Test 12: enrich handles search error gracefully --
asyncTest('enrich handles search error gracefully', async () => {
  const enricher = new MemoryContextEnricher({
    memorySearcher: {
      search: async () => { throw new Error('Connection refused'); }
    },
    logger: silentLogger
  });

  const result = await enricher.enrich('Tell me about Carlos', 'search');
  assert.strictEqual(result, null, 'Should return null on search error');
});

// -- Test 13: _computeConfidence returns high for strong keyword match --
test('_computeConfidence returns high for strong keyword match', () => {
  const enricher = new MemoryContextEnricher({ memorySearcher: {}, logger: silentLogger });

  assert.strictEqual(enricher._computeConfidence({ channelScores: { keyword: 1.0, vector: 0, graph: 0 } }), 'high');
  assert.strictEqual(enricher._computeConfidence({ channelScores: { keyword: 0.8, vector: 0, graph: 0 } }), 'high');
  assert.strictEqual(enricher._computeConfidence({ channelScores: { keyword: 0.5, vector: 0, graph: 0 } }), 'medium');
  assert.strictEqual(enricher._computeConfidence({ channelScores: { keyword: 0.1, vector: 0.2, graph: 0 } }), 'low');
  assert.strictEqual(enricher._computeConfidence({}), 'medium', 'No channelScores defaults to medium');
});

// -- Test 14: enricher output wraps in agent_knowledge tags with source metadata --
asyncTest('enricher output includes source and confidence per result', async () => {
  const enricher = new MemoryContextEnricher({
    memorySearcher: {
      search: async () => [
        { source: 'Wiki', title: 'Carlos', excerpt: 'Contact at TheCatalyne', channelScores: { keyword: 1.0, vector: 0, graph: 0 } }
      ]
    },
    logger: silentLogger
  });

  const result = await enricher.enrich('Tell me about Carlos', 'search');
  assert.ok(result.includes('<agent_knowledge>'), 'Should open agent_knowledge tag');
  assert.ok(result.includes('</agent_knowledge>'), 'Should close agent_knowledge tag');
  assert.ok(result.includes('source: wiki'), 'Should include source tag');
  assert.ok(result.includes('confidence: high'), 'Should compute high confidence for keyword 1.0');
  assert.ok(result.includes('Carlos'), 'Should include title');
});

setTimeout(() => { summary(); exitWithCode(); }, 1000);
