/*
 * MoltAgent - Sovereign AI Security Layer
 * Copyright (C) 2026 MoltAgent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 */

'use strict';

/**
 * TextExtractor — Image OCR Unit Tests
 *
 * Run: node test/unit/extraction/text-extractor-image-ocr.test.js
 *
 * Covers image OCR additions: SUPPORTED extensions, IMAGE_EXTENSIONS set,
 * extract() routing, _extractImage() method signature and error handling,
 * _checkTesseractAvailable() caching, and graceful degradation when
 * tesseract is absent.
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

const { TextExtractor } = require('../../../src/lib/extraction/text-extractor');

console.log('\n=== TextExtractor — Image OCR Tests ===\n');

// ============================================================
// SUPPORTED set — image extensions present
// ============================================================

test('SUPPORTED set includes jpg, jpeg, png, tiff, tif, bmp, webp', () => {
  const imageExts = ['jpg', 'jpeg', 'png', 'tiff', 'tif', 'bmp', 'webp'];
  for (const ext of imageExts) {
    assert.ok(
      TextExtractor.SUPPORTED.has(ext),
      `SUPPORTED should contain '${ext}'`
    );
  }
});

// ============================================================
// isSupported() — image extensions
// ============================================================

test('isSupported() returns true for image extensions', () => {
  const imagePaths = [
    'photo.jpg',
    'scan.jpeg',
    'diagram.png',
    'document.tiff',
    'document.tif',
    'bitmap.bmp',
    'modern.webp'
  ];
  for (const f of imagePaths) {
    assert.ok(TextExtractor.isSupported(f), `${f} should be supported`);
  }
});

test('isSupported() returns false for gif and svg (unsupported image types)', () => {
  const unsupported = ['animation.gif', 'icon.svg', 'photo.heic', 'raw.cr2'];
  for (const f of unsupported) {
    assert.strictEqual(
      TextExtractor.isSupported(f),
      false,
      `${f} should NOT be supported`
    );
  }
});

// ============================================================
// IMAGE_EXTENSIONS static set
// ============================================================

test('IMAGE_EXTENSIONS static set contains all routed image types', () => {
  const expected = ['jpg', 'jpeg', 'png', 'tiff', 'tif', 'bmp', 'webp'];
  for (const ext of expected) {
    assert.ok(
      TextExtractor.IMAGE_EXTENSIONS.has(ext),
      `IMAGE_EXTENSIONS should contain '${ext}'`
    );
  }
  // gif must NOT be in IMAGE_EXTENSIONS
  assert.strictEqual(TextExtractor.IMAGE_EXTENSIONS.has('gif'), false);
});

// ============================================================
// _extractImage method exists and has correct signature
// ============================================================

test('_extractImage method exists on TextExtractor prototype', () => {
  const ext = new TextExtractor();
  assert.strictEqual(typeof ext._extractImage, 'function');
});

test('_checkTesseractAvailable method exists on TextExtractor prototype', () => {
  const ext = new TextExtractor();
  assert.strictEqual(typeof ext._checkTesseractAvailable, 'function');
});

test('constructor initialises _tesseractAvailable as null', () => {
  const ext = new TextExtractor();
  assert.strictEqual(ext._tesseractAvailable, null);
});

// ============================================================
// _checkTesseractAvailable — caching
// ============================================================

asyncTest('_checkTesseractAvailable caches result after first check', async () => {
  const ext = new TextExtractor();

  // First call — result depends on whether tesseract is installed on the host
  const first = await ext._checkTesseractAvailable();
  assert.strictEqual(typeof first, 'boolean');
  assert.strictEqual(ext._tesseractAvailable, first);

  // Force a known value and confirm subsequent calls return the cached value
  ext._tesseractAvailable = true;
  const second = await ext._checkTesseractAvailable();
  assert.strictEqual(second, true);

  ext._tesseractAvailable = false;
  const third = await ext._checkTesseractAvailable();
  assert.strictEqual(third, false);
});

// ============================================================
// _extractImage — graceful degradation when tesseract unavailable
// ============================================================

asyncTest('_extractImage returns warning when tesseract not available', async () => {
  const ext = new TextExtractor();

  // Force tesseract to be unavailable without actually invoking the binary
  ext._tesseractAvailable = false;

  const result = await ext._extractImage(Buffer.from('fake-image'), 'photo.jpg');

  assert.strictEqual(result.ocr, true, 'ocr flag should be true even on failure');
  assert.strictEqual(result.text, '', 'text should be empty when tesseract unavailable');
  assert.strictEqual(result.truncated, false);
  assert.strictEqual(result.totalLength, 0);
  assert.ok(result.warning, 'warning should be present');
  assert.ok(
    result.warning.includes('tesseract'),
    `warning should mention tesseract, got: ${result.warning}`
  );
});

// ============================================================
// extract() — routes image extensions to _extractImage
// ============================================================

asyncTest('extract() routes .png to _extractImage and propagates ocr + warning', async () => {
  const ext = new TextExtractor();

  // Stub _extractImage to avoid real tesseract dependency
  ext._extractImage = async (buffer, filePath) => {
    assert.ok(Buffer.isBuffer(buffer), 'buffer should be a Buffer');
    assert.strictEqual(filePath, 'receipt.png');
    return {
      text: 'Total: 42.00',
      truncated: false,
      totalLength: 12,
      ocr: true
    };
  };

  const result = await ext.extract(Buffer.from('fake-png'), 'receipt.png');
  assert.strictEqual(result.text, 'Total: 42.00');
  assert.strictEqual(result.ocr, true);
  assert.strictEqual(result.truncated, false);
  assert.strictEqual(result.totalLength, 12);
  assert.strictEqual(result.warning, undefined);
});

asyncTest('extract() propagates warning from _extractImage on OCR failure', async () => {
  const ext = new TextExtractor();

  ext._extractImage = async () => ({
    text: '',
    truncated: false,
    totalLength: 0,
    ocr: true,
    warning: 'Image OCR failed: tesseract is not available on this system'
  });

  const result = await ext.extract(Buffer.from('fake-jpg'), 'scan.jpg');
  assert.strictEqual(result.ocr, true);
  assert.strictEqual(result.text, '');
  assert.ok(result.warning);
  assert.ok(result.warning.includes('tesseract'));
});

asyncTest('extract() applies truncation to image OCR output', async () => {
  const ext = new TextExtractor({ maxOutputSize: 20 });

  ext._extractImage = async () => ({
    text: 'A'.repeat(100),
    truncated: false,
    totalLength: 100,
    ocr: true
  });

  const result = await ext.extract(Buffer.from('fake-png'), 'big.png');
  assert.strictEqual(result.truncated, true);
  assert.strictEqual(result.totalLength, 100);
  assert.ok(result.text.includes('truncated'));
  assert.strictEqual(result.ocr, true);
});

asyncTest('extract() still throws for unsupported extensions after image support added', async () => {
  const ext = new TextExtractor();
  try {
    await ext.extract(Buffer.from('fake'), 'icon.gif');
    assert.fail('Should have thrown for .gif');
  } catch (err) {
    assert.ok(err.message.includes('Unsupported'));
    assert.ok(err.message.includes('.gif'));
  }
});

// ============================================================
// Summary
// ============================================================

setTimeout(() => {
  summary();
  exitWithCode();
}, 500);
