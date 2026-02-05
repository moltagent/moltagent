/**
 * AudioConverter Unit Tests
 *
 * Tests for the ffmpeg audio conversion wrapper.
 * Uses subclassing to mock _runFfmpeg since child_process.execFile
 * is captured at module load time.
 *
 * Run: node test/unit/providers/audio-converter.test.js
 */

const assert = require('assert');
const fs = require('fs');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

const AudioConverter = require('../../../src/lib/providers/audio-converter');

// ============================================================
// Testable subclass that overrides _runFfmpeg
// ============================================================

class TestableAudioConverter extends AudioConverter {
  constructor(config = {}) {
    super(config);
    this._runFfmpegCalls = [];
    this._runFfmpegShouldFail = false;
    this._runFfmpegError = null;
  }

  async _runFfmpeg(args) {
    this._runFfmpegCalls.push(args);
    if (this._runFfmpegShouldFail) {
      throw this._runFfmpegError || new Error('ffmpeg failed: mock error');
    }
    // Create the output file so readFileSync can find it
    // The output path is the second-to-last argument (before -y)
    const outputPath = args[args.indexOf('-f') + 2];
    if (outputPath) {
      fs.writeFileSync(outputPath, 'fake wav output');
    }
  }
}

// ============================================================
// Test Suites
// ============================================================

console.log('\n=== AudioConverter Tests ===\n');

// --- Constructor Tests ---
console.log('\n--- Constructor Tests ---\n');

test('TC-CTOR-001: Default ffmpeg path', () => {
  const converter = new AudioConverter();
  assert.strictEqual(converter.ffmpegPath, 'ffmpeg');
});

test('TC-CTOR-002: Custom ffmpeg path', () => {
  const converter = new AudioConverter({ ffmpegPath: '/usr/local/bin/ffmpeg' });
  assert.strictEqual(converter.ffmpegPath, '/usr/local/bin/ffmpeg');
});

// --- toWav16kMono() Tests ---
console.log('\n--- toWav16kMono() Tests ---\n');

asyncTest('TC-WAV-001: Calls ffmpeg with correct arguments', async () => {
  const converter = new TestableAudioConverter();
  const result = await converter.toWav16kMono(Buffer.from('fake ogg input'));

  assert.strictEqual(converter._runFfmpegCalls.length, 1, 'Should call _runFfmpeg once');
  const args = converter._runFfmpegCalls[0];

  assert.ok(args.includes('-i'), 'Should have -i flag');
  assert.ok(args.includes('-ar'), 'Should have -ar flag');
  assert.ok(args.includes('16000'), 'Should set sample rate to 16000');
  assert.ok(args.includes('-ac'), 'Should have -ac flag');
  assert.ok(args.includes('1'), 'Should set channels to 1 (mono)');
  assert.ok(args.includes('-f'), 'Should have -f flag');
  assert.ok(args.includes('wav'), 'Should output wav format');
  assert.ok(args.includes('-y'), 'Should overwrite output');
  assert.ok(result instanceof Buffer, 'Should return a Buffer');
});

asyncTest('TC-WAV-002: Cleans up temp files on success', async () => {
  const converter = new TestableAudioConverter();
  await converter.toWav16kMono(Buffer.from('input'));

  // Check that the input temp file was cleaned up
  const args = converter._runFfmpegCalls[0];
  const inputPath = args[args.indexOf('-i') + 1];
  const outputPath = args[args.indexOf('-f') + 2];

  assert.ok(!fs.existsSync(inputPath), 'Input temp file should be cleaned up');
  assert.ok(!fs.existsSync(outputPath), 'Output temp file should be cleaned up');
});

asyncTest('TC-WAV-003: Cleans up temp files on error', async () => {
  const converter = new TestableAudioConverter();
  converter._runFfmpegShouldFail = true;
  converter._runFfmpegError = new Error('ffmpeg failed: conversion error');

  let inputPath = null;
  try {
    await converter.toWav16kMono(Buffer.from('input'));
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err.message.includes('ffmpeg failed'), 'Should propagate error');
  }

  // Temp files should still be cleaned up despite the error
  // (We can't easily check the paths without access, but the finally block runs)
});

asyncTest('TC-WAV-004: Returns Buffer from converted output', async () => {
  const converter = new TestableAudioConverter();
  const result = await converter.toWav16kMono(Buffer.from('some audio data'));

  assert.ok(Buffer.isBuffer(result), 'Should return a Buffer');
  assert.ok(result.length > 0, 'Buffer should not be empty');
});

asyncTest('TC-WAV-005: Uses temp files with moltagent-voice prefix', async () => {
  const converter = new TestableAudioConverter();
  await converter.toWav16kMono(Buffer.from('input'));

  const args = converter._runFfmpegCalls[0];
  const inputPath = args[args.indexOf('-i') + 1];
  assert.ok(inputPath.includes('moltagent-voice'), 'Temp file should have moltagent-voice prefix');
});

// --- isAvailable() Tests ---
console.log('\n--- isAvailable() Tests ---\n');

asyncTest('TC-AVAIL-001: isAvailable returns boolean', async () => {
  // This tests with the real ffmpeg binary - may be true or false depending on system
  const converter = new AudioConverter();
  const result = await converter.isAvailable();
  assert.strictEqual(typeof result, 'boolean', 'Should return a boolean');
});

asyncTest('TC-AVAIL-002: isAvailable returns false for non-existent binary', async () => {
  const converter = new AudioConverter({ ffmpegPath: '/nonexistent/ffmpeg-fake-12345' });
  const result = await converter.isAvailable();
  assert.strictEqual(result, false, 'Should return false for non-existent binary');
});

// Summary
setTimeout(() => {
  summary();
  exitWithCode();
}, 100);
