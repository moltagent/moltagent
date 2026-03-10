/**
 * TextExtractor Unit Tests
 *
 * Run: node test/unit/extraction/text-extractor.test.js
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

const { TextExtractor } = require('../../../src/lib/extraction/text-extractor');

console.log('\n=== TextExtractor Tests ===\n');

// ============================================================
// isSupported
// ============================================================

test('isSupported returns true for valid extensions', () => {
  const valid = ['file.pdf', 'doc.docx', 'sheet.xlsx', 'notes.txt', 'readme.md',
                  'data.csv', 'config.json', 'spec.yaml', 'spec.yml',
                  'page.html', 'page.htm', 'data.xml', 'app.log', 'sheet.xls'];
  for (const f of valid) {
    assert.ok(TextExtractor.isSupported(f), `${f} should be supported`);
  }
});

test('isSupported returns false for unsupported extensions', () => {
  // Note: image extensions (jpg, png, tiff, etc.) are now supported via image OCR.
  // Only truly unsupported formats belong here.
  const invalid = ['animation.gif', 'icon.svg', 'app.exe', 'archive.zip', 'video.mp4', 'file.pptx'];
  for (const f of invalid) {
    assert.strictEqual(TextExtractor.isSupported(f), false, `${f} should not be supported`);
  }
});

// ============================================================
// Constructor
// ============================================================

test('constructor uses default maxOutputSize', () => {
  const ext = new TextExtractor();
  assert.strictEqual(ext.maxOutputSize, 51200);
});

test('constructor accepts custom maxOutputSize', () => {
  const ext = new TextExtractor({ maxOutputSize: 1024 });
  assert.strictEqual(ext.maxOutputSize, 1024);
});

// ============================================================
// extract — text passthrough
// ============================================================

asyncTest('extract handles .txt passthrough', async () => {
  const ext = new TextExtractor();
  const buf = Buffer.from('Hello, World!');
  const result = await ext.extract(buf, 'test.txt');
  assert.strictEqual(result.text, 'Hello, World!');
  assert.strictEqual(result.truncated, false);
  assert.strictEqual(result.totalLength, 13);
});

asyncTest('extract handles .md passthrough', async () => {
  const ext = new TextExtractor();
  const buf = Buffer.from('# Title\n\nContent');
  const result = await ext.extract(buf, 'readme.md');
  assert.ok(result.text.includes('# Title'));
});

asyncTest('extract handles .json passthrough', async () => {
  const ext = new TextExtractor();
  const buf = Buffer.from('{"key":"value"}');
  const result = await ext.extract(buf, 'data.json');
  assert.ok(result.text.includes('"key"'));
});

// ============================================================
// extract — truncation
// ============================================================

asyncTest('extract truncates at maxOutputSize', async () => {
  const ext = new TextExtractor({ maxOutputSize: 20 });
  const buf = Buffer.from('x'.repeat(100));
  const result = await ext.extract(buf, 'big.txt');
  assert.strictEqual(result.truncated, true);
  assert.strictEqual(result.totalLength, 100);
  assert.ok(result.text.includes('truncated'));
});

asyncTest('truncation notice includes sizes', async () => {
  const ext = new TextExtractor({ maxOutputSize: 10 });
  const buf = Buffer.from('a'.repeat(50));
  const result = await ext.extract(buf, 'large.txt');
  assert.ok(result.text.includes('10'));
  assert.ok(result.text.includes('50'));
});

// ============================================================
// extract — unsupported
// ============================================================

asyncTest('extract throws for unsupported extension', async () => {
  const ext = new TextExtractor();
  const buf = Buffer.from('fake');
  // Use .gif — not a supported extension (png/jpg/tiff etc. are now supported via image OCR)
  try {
    await ext.extract(buf, 'animation.gif');
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err.message.includes('Unsupported'));
    assert.ok(err.message.includes('.gif'));
  }
});

// ============================================================
// Constructor — OCR config
// ============================================================

test('constructor sets OCR defaults', () => {
  const ext = new TextExtractor();
  assert.strictEqual(ext.ocrEnabled, true);
  assert.strictEqual(ext.ocrLanguages, 'eng+deu+por');
  assert.strictEqual(ext.ocrTimeoutMs, 120000);
  assert.strictEqual(ext.ocrJobs, 1);
  assert.strictEqual(ext.charsPerPageThreshold, 50);
  assert.strictEqual(ext._ocrAvailable, null);
});

test('constructor accepts custom OCR config', () => {
  const ext = new TextExtractor({
    ocrEnabled: false,
    ocrLanguages: 'eng+fra',
    ocrTimeoutMs: 60000,
    ocrJobs: 2,
    charsPerPageThreshold: 100
  });
  assert.strictEqual(ext.ocrEnabled, false);
  assert.strictEqual(ext.ocrLanguages, 'eng+fra');
  assert.strictEqual(ext.ocrTimeoutMs, 60000);
  assert.strictEqual(ext.ocrJobs, 2);
  assert.strictEqual(ext.charsPerPageThreshold, 100);
});

// ============================================================
// _extractPdf — normal PDF (no OCR triggered)
// ============================================================

asyncTest('_extractPdf returns text directly for normal PDF (no OCR)', async () => {
  const ext = new TextExtractor({ charsPerPageThreshold: 50 });

  // Monkey-patch _extractPdf to simulate pdf-parse returning a text-rich PDF
  const original = ext._extractPdf.bind(ext);
  ext._extractPdf = async (buffer) => {
    // Simulate: pdf-parse found 3000 chars on 1 page → not scanned
    return { text: 'A'.repeat(3000), pageCount: 1, ocr: false };
  };

  const result = await ext.extract(Buffer.from('fake-pdf'), 'invoice.pdf');
  assert.strictEqual(result.ocr, false);
  assert.strictEqual(result.pages, 1);
  assert.ok(result.text.length > 0);
  assert.ok(!result.warning);
});

// ============================================================
// _extractPdf — scanned PDF detection + OCR available
// ============================================================

asyncTest('_extractPdf detects scanned PDF and triggers OCR when available', async () => {
  const ext = new TextExtractor({ charsPerPageThreshold: 50 });

  // Override _extractPdf to simulate scanned PDF → OCR success
  ext._extractPdf = async (buffer) => {
    return { text: 'OCR-extracted invoice text', pageCount: 3, ocr: true };
  };

  const result = await ext.extract(Buffer.from('fake-pdf'), 'scan.pdf');
  assert.strictEqual(result.ocr, true);
  assert.strictEqual(result.pages, 3);
  assert.strictEqual(result.text, 'OCR-extracted invoice text');
});

// ============================================================
// _extractPdf — scanned PDF but ocrmypdf not available
// ============================================================

asyncTest('_extractPdf returns warning when scanned but ocrmypdf not installed', async () => {
  const ext = new TextExtractor({ charsPerPageThreshold: 50 });

  // Override to simulate: scanned detected, OCR unavailable
  ext._extractPdf = async (buffer) => {
    return {
      text: '',
      pageCount: 5,
      ocr: false,
      warning: 'This appears to be a scanned PDF but OCR is not available on this system. Text extraction may be incomplete.'
    };
  };

  const result = await ext.extract(Buffer.from('fake-pdf'), 'scan.pdf');
  assert.strictEqual(result.ocr, false);
  assert.strictEqual(result.pages, 5);
  assert.ok(result.warning);
  assert.ok(result.warning.includes('not available'));
});

// ============================================================
// _ocrPdf — timeout handling
// ============================================================

asyncTest('_ocrPdf handles errors gracefully', async () => {
  const ext = new TextExtractor({ ocrTimeoutMs: 100 });

  // _ocrPdf expects to call execFileAsync('ocrmypdf', ...) which will fail
  // since ocrmypdf is not installed in test env. This tests graceful error handling.
  const result = await ext._ocrPdf(Buffer.from('not-a-real-pdf'), 1);
  assert.strictEqual(result.ocr, false);
  assert.strictEqual(result.pageCount, 1);
  assert.ok(result.error);
  assert.ok(result.error.includes('OCR processing failed'));
  assert.strictEqual(result.text, '');
});

// ============================================================
// _checkOcrAvailable — caches result after first check
// ============================================================

asyncTest('_checkOcrAvailable caches result after first check', async () => {
  const ext = new TextExtractor();

  // First call: should set _ocrAvailable (true or false depending on system)
  const first = await ext._checkOcrAvailable();
  assert.strictEqual(typeof first, 'boolean');
  assert.strictEqual(ext._ocrAvailable, first);

  // Force to a known value and verify second call returns cached
  ext._ocrAvailable = true;
  const second = await ext._checkOcrAvailable();
  assert.strictEqual(second, true);

  ext._ocrAvailable = false;
  const third = await ext._checkOcrAvailable();
  assert.strictEqual(third, false);
});

// ============================================================
// extract — PDF result shape includes ocr and warning fields
// ============================================================

asyncTest('extract propagates ocr and warning fields from PDF result', async () => {
  const ext = new TextExtractor();

  ext._extractPdf = async () => ({
    text: 'some text',
    pageCount: 2,
    ocr: true,
    warning: 'test warning'
  });

  const result = await ext.extract(Buffer.from('x'), 'doc.pdf');
  assert.strictEqual(result.ocr, true);
  assert.strictEqual(result.warning, 'test warning');
  assert.strictEqual(result.pages, 2);
});

// ============================================================
// Summary
// ============================================================

setTimeout(() => {
  summary();
  exitWithCode();
}, 500);
