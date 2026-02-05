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
  const invalid = ['image.png', 'photo.jpg', 'app.exe', 'archive.zip', 'video.mp4', 'file.pptx'];
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
  try {
    await ext.extract(buf, 'image.png');
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err.message.includes('Unsupported'));
    assert.ok(err.message.includes('.png'));
  }
});

// ============================================================
// Summary
// ============================================================

setTimeout(() => {
  summary();
  exitWithCode();
}, 500);
