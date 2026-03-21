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
 * IngestionCache Unit Tests
 *
 * Run: node test/unit/memory/ingestion-cache.test.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs').promises;
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const IngestionCache = require('../../../src/lib/memory/ingestion-cache');

/** Return a unique temp file path for each test that writes to disk. */
function tmpPath() {
  return path.join(os.tmpdir(), `ingestion-cache-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

// TC-IC-01: hashContent returns consistent SHA-256 hex string
test('TC-IC-01: hashContent returns consistent SHA-256 hex for the same input', () => {
  const cache = new IngestionCache({ cachePath: tmpPath() });
  const content = 'hello world document content';

  const h1 = cache.hashContent(content);
  const h2 = cache.hashContent(content);

  assert.strictEqual(typeof h1, 'string', 'Hash should be a string');
  assert.strictEqual(h1.length, 64, 'SHA-256 hex should be 64 chars');
  assert.ok(/^[0-9a-f]+$/.test(h1), 'Hash should be lowercase hex');
  assert.strictEqual(h1, h2, 'Same input must produce same hash');
});

// TC-IC-02: hashContent returns different hash for different content
test('TC-IC-02: hashContent returns different hash for different content', () => {
  const cache = new IngestionCache({ cachePath: tmpPath() });

  const h1 = cache.hashContent('document A content');
  const h2 = cache.hashContent('document B content');

  assert.notStrictEqual(h1, h2, 'Different inputs must produce different hashes');
});

// TC-IC-03: hashContent accepts a Buffer
test('TC-IC-03: hashContent accepts a Buffer', () => {
  const cache = new IngestionCache({ cachePath: tmpPath() });
  const buf = Buffer.from('buffer content for hashing');

  const hash = cache.hashContent(buf);

  assert.strictEqual(typeof hash, 'string', 'Hash from Buffer should be a string');
  assert.strictEqual(hash.length, 64, 'SHA-256 hex from Buffer should be 64 chars');
});

// TC-IC-04: isProcessed returns false for unknown hash
test('TC-IC-04: isProcessed returns false for unknown hash', () => {
  const cache = new IngestionCache({ cachePath: tmpPath() });

  assert.strictEqual(cache.isProcessed('deadbeef'), false, 'Unknown hash should return false');
});

// TC-IC-05: markProcessed then isProcessed returns true
asyncTest('TC-IC-05: markProcessed → isProcessed returns true', async () => {
  const cache = new IngestionCache({ cachePath: tmpPath() });
  const hash = cache.hashContent('test document content');

  await cache.markProcessed(hash, { filename: 'test.pdf', classification: 'REFERENCE', entityCount: 3 });

  assert.strictEqual(cache.isProcessed(hash), true, 'Hash should be recognized after markProcessed');
});

// TC-IC-06: getEntry returns null for unknown hash
test('TC-IC-06: getEntry returns null for unknown hash', () => {
  const cache = new IngestionCache({ cachePath: tmpPath() });

  assert.strictEqual(cache.getEntry('unknown-hash'), null, 'getEntry should return null for unknown hash');
});

// TC-IC-07: getEntry returns metadata after markProcessed
asyncTest('TC-IC-07: getEntry returns correct metadata after markProcessed', async () => {
  const cache = new IngestionCache({ cachePath: tmpPath() });
  const hash = cache.hashContent('another document');
  const meta = { filename: 'report.pdf', classification: 'DOCUMENT', entityCount: 7 };

  await cache.markProcessed(hash, meta);
  const entry = cache.getEntry(hash);

  assert.ok(entry !== null, 'Entry should not be null after markProcessed');
  assert.strictEqual(entry.filename, 'report.pdf', 'Entry filename should match');
  assert.strictEqual(entry.classification, 'DOCUMENT', 'Entry classification should match');
  assert.strictEqual(entry.entityCount, 7, 'Entry entityCount should match');
  assert.ok(typeof entry.processedAt === 'string', 'Entry should have processedAt timestamp');
  assert.ok(entry.processedAt.length > 0, 'processedAt should not be empty');
});

// TC-IC-08: save/load round-trip preserves cache
asyncTest('TC-IC-08: save/load round-trip preserves all entries', async () => {
  const filePath = tmpPath();
  const cache1 = new IngestionCache({ cachePath: filePath });

  const hashA = cache1.hashContent('content of file A');
  const hashB = cache1.hashContent('content of file B');
  await cache1.markProcessed(hashA, { filename: 'a.pdf', classification: 'REFERENCE', entityCount: 2 });
  await cache1.markProcessed(hashB, { filename: 'b.txt', classification: 'NOTE', entityCount: 0 });

  // Create a fresh cache instance pointing at the same file
  const cache2 = new IngestionCache({ cachePath: filePath });
  await cache2.load();

  assert.strictEqual(cache2.isProcessed(hashA), true, 'hashA should survive round-trip');
  assert.strictEqual(cache2.isProcessed(hashB), true, 'hashB should survive round-trip');

  const entryA = cache2.getEntry(hashA);
  assert.strictEqual(entryA.filename, 'a.pdf', 'filename should survive round-trip');
  assert.strictEqual(entryA.entityCount, 2, 'entityCount should survive round-trip');
});

// TC-IC-09: load handles missing file gracefully (starts empty)
asyncTest('TC-IC-09: load handles missing cache file gracefully', async () => {
  const cache = new IngestionCache({ cachePath: '/tmp/does-not-exist-ingestion-cache-xyz.json' });

  await cache.load(); // Must not throw

  assert.strictEqual(cache.stats().totalProcessed, 0, 'Cache should be empty when file is missing');
});

// TC-IC-10: stats returns correct totalProcessed count
asyncTest('TC-IC-10: stats returns correct totalProcessed count', async () => {
  const cache = new IngestionCache({ cachePath: tmpPath() });

  assert.strictEqual(cache.stats().totalProcessed, 0, 'Empty cache should report 0');

  await cache.markProcessed(cache.hashContent('doc1'), { filename: 'doc1.pdf', classification: null, entityCount: 0 });
  await cache.markProcessed(cache.hashContent('doc2'), { filename: 'doc2.pdf', classification: null, entityCount: 1 });

  assert.strictEqual(cache.stats().totalProcessed, 2, 'Should report 2 after two markProcessed calls');
});

// TC-IC-11: stats returns null oldestEntry for empty cache
test('TC-IC-11: stats.oldestEntry is null for empty cache', () => {
  const cache = new IngestionCache({ cachePath: tmpPath() });

  assert.strictEqual(cache.stats().oldestEntry, null, 'oldestEntry should be null for empty cache');
});

// TC-IC-12: stats returns oldest ISO timestamp
asyncTest('TC-IC-12: stats.oldestEntry returns the earliest processedAt', async () => {
  const cache = new IngestionCache({ cachePath: tmpPath() });

  // Insert two entries with forced processedAt values by manipulating _cache directly
  cache._cache['aaa'] = { processedAt: '2026-01-01T00:00:00.000Z', filename: 'old.pdf', classification: null, entityCount: 0 };
  cache._cache['bbb'] = { processedAt: '2026-06-01T00:00:00.000Z', filename: 'new.pdf', classification: null, entityCount: 0 };

  const { oldestEntry } = cache.stats();
  assert.strictEqual(oldestEntry, '2026-01-01T00:00:00.000Z', 'Should return the earliest processedAt');
});

// TC-IC-13: Multiple entries tracked independently
asyncTest('TC-IC-13: multiple entries tracked independently', async () => {
  const cache = new IngestionCache({ cachePath: tmpPath() });

  const hashes = ['content X', 'content Y', 'content Z'].map(c => cache.hashContent(c));
  for (let i = 0; i < hashes.length; i++) {
    await cache.markProcessed(hashes[i], { filename: `file${i}.pdf`, classification: 'REFERENCE', entityCount: i });
  }

  // Each hash independently returns true
  for (const h of hashes) {
    assert.strictEqual(cache.isProcessed(h), true, `Hash ${h.slice(0, 8)}… should be processed`);
  }

  // An unregistered hash is still false
  assert.strictEqual(cache.isProcessed(cache.hashContent('content W')), false, 'Unregistered hash should be false');
  assert.strictEqual(cache.stats().totalProcessed, 3, 'Should have 3 entries');
});

// TC-IC-14: isProcessed returns false for null/undefined input
test('TC-IC-14: isProcessed is safe against null/undefined input', () => {
  const cache = new IngestionCache({ cachePath: tmpPath() });

  assert.strictEqual(cache.isProcessed(null), false, 'null should return false');
  assert.strictEqual(cache.isProcessed(undefined), false, 'undefined should return false');
  assert.strictEqual(cache.isProcessed(''), false, 'empty string should return false');
});

// TC-IC-15: markProcessed ignores null hash (defensive)
asyncTest('TC-IC-15: markProcessed is a no-op for null hash', async () => {
  const cache = new IngestionCache({ cachePath: tmpPath() });

  await cache.markProcessed(null, { filename: 'bad.pdf', classification: null, entityCount: 0 });

  assert.strictEqual(cache.stats().totalProcessed, 0, 'Null hash should not be stored');
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
