/**
 * JudgeQueue Unit Tests
 *
 * The capture side of the local judge (Session 4): a bounded,
 * judge-then-delete ring of judged-job samples. The retention boundary is
 * the point — nothing judged persists past its verdict, unjudged samples
 * expire, caps hold, and content is truncated at capture.
 *
 * Run: node test/unit/llm/judge-queue.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, summary, exitWithCode } = require('../../helpers/test-runner');

const JudgeQueue = require('../../../src/lib/llm/judge-queue');

const silentLogger = { warn: () => {}, log: () => {}, info: () => {} };

function makeQueue(opts = {}) {
  return new JudgeQueue({ dataDir: null, logger: silentLogger, ...opts });
}

function sample(overrides = {}) {
  return {
    job: 'writing',
    model: 'qwen3:8b',
    provider: 'ollama-local',
    isLocal: true,
    language: 'EN',
    prompt: 'write a note',
    response: 'a fine note',
    ...overrides,
  };
}

// ============================================================
// Capture gate
// ============================================================

test('only judged jobs are retained; mechanical jobs are a no-op', () => {
  const q = makeQueue();
  assert.strictEqual(q.enqueue(sample({ job: 'writing' })).queued, true);
  assert.strictEqual(q.enqueue(sample({ job: 'thinking' })).queued, true);
  assert.strictEqual(q.enqueue(sample({ job: 'tools' })).queued, false);
  assert.strictEqual(q.enqueue(sample({ job: 'classification' })).queued, false);
  assert.strictEqual(q.samples().length, 2);
});

test('unattributable or empty samples are dropped, never invented', () => {
  const q = makeQueue();
  assert.strictEqual(q.enqueue(sample({ model: null })).queued, false);
  assert.strictEqual(q.enqueue(sample({ model: '' })).queued, false);
  assert.strictEqual(q.enqueue(sample({ response: '' })).queued, false);
  assert.strictEqual(q.enqueue(sample({ response: null })).queued, false);
  assert.strictEqual(q.enqueue(null).queued, false);
  assert.strictEqual(q.samples().length, 0);
});

test('content is truncated at capture (prompt and response bounds)', () => {
  const q = makeQueue({ promptChars: 10, responseChars: 20 });
  q.enqueue(sample({ prompt: 'x'.repeat(100), response: 'y'.repeat(100) }));
  const [s] = q.samples();
  assert.strictEqual(s.prompt.length, 10);
  assert.strictEqual(s.response.length, 20);
});

test('language is normalized uppercase and defaults to EN', () => {
  const q = makeQueue();
  q.enqueue(sample({ language: 'de' }));
  q.enqueue(sample({ language: undefined }));
  const all = q.samples();
  assert.strictEqual(all[0].language, 'DE');
  assert.strictEqual(all[1].language, 'EN');
});

// ============================================================
// Caps (retention boundary)
// ============================================================

test('per-cell cap: a hot (job, model, language) cell evicts its own oldest, not other cells', () => {
  const q = makeQueue({ maxPerCell: 3 });
  q.enqueue(sample({ language: 'DE', response: 'de-1' }));
  for (let i = 1; i <= 4; i++) q.enqueue(sample({ response: `en-${i}` }));
  const all = q.samples();
  // EN cell holds its newest 3; the DE sample is untouched.
  const en = all.filter(s => s.language === 'EN').map(s => s.response);
  assert.deepStrictEqual(en, ['en-2', 'en-3', 'en-4']);
  assert.strictEqual(all.filter(s => s.language === 'DE').length, 1);
});

test('ring cap: total capacity drops the oldest overall', () => {
  const q = makeQueue({ maxSamples: 3, maxPerCell: 10 });
  for (let i = 1; i <= 5; i++) q.enqueue(sample({ response: `r-${i}` }));
  assert.deepStrictEqual(q.samples().map(s => s.response), ['r-3', 'r-4', 'r-5']);
});

test('unjudged samples expire after maxAgeDays', () => {
  let clock = 1_000_000;
  const q = makeQueue({ maxAgeDays: 7, now: () => clock });
  q.enqueue(sample({ response: 'old' }));
  clock += 8 * 24 * 60 * 60 * 1000; // 8 days
  q.enqueue(sample({ response: 'fresh' }));
  const all = q.samples();
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].response, 'fresh');
});

// ============================================================
// Judge-then-delete
// ============================================================

test('remove() deletes a judged sample the moment its verdict lands', () => {
  const q = makeQueue();
  q.enqueue(sample());
  const [s] = q.samples();
  assert.strictEqual(q.remove(s.id), true);
  assert.strictEqual(q.samples().length, 0);
  assert.strictEqual(q.remove(s.id), false, 'second remove is a no-op');
});

test('markAttempt() drops a sample after maxAttempts unparseable verdicts', () => {
  const q = makeQueue({ maxAttempts: 3 });
  q.enqueue(sample());
  const [s] = q.samples();
  assert.deepStrictEqual(q.markAttempt(s.id), { dropped: false });
  assert.deepStrictEqual(q.markAttempt(s.id), { dropped: false });
  assert.deepStrictEqual(q.markAttempt(s.id), { dropped: true });
  assert.strictEqual(q.samples().length, 0);
});

// ============================================================
// Meta side-channel
// ============================================================

test('getMeta/setMeta round-trips (digest map home)', () => {
  const q = makeQueue();
  assert.strictEqual(q.getMeta('digests'), undefined);
  q.setMeta('digests', { 'qwen3:8b': 'sha256:abc' });
  assert.deepStrictEqual(q.getMeta('digests'), { 'qwen3:8b': 'sha256:abc' });
});

// ============================================================
// Persistence
// ============================================================

test('persists across restart; removed samples stay gone (nothing judged survives)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-queue-test-'));
  try {
    const q1 = new JudgeQueue({ dataDir: dir, logger: silentLogger });
    q1.enqueue(sample({ response: 'keep' }));
    q1.enqueue(sample({ response: 'judged', language: 'DE' }));
    q1.setMeta('digests', { m: 'd1' });
    const judged = q1.samples().find(s => s.response === 'judged');
    q1.remove(judged.id);
    q1.flush();

    const q2 = new JudgeQueue({ dataDir: dir, logger: silentLogger });
    const all = q2.samples();
    assert.strictEqual(all.length, 1);
    assert.strictEqual(all[0].response, 'keep');
    assert.deepStrictEqual(q2.getMeta('digests'), { m: 'd1' });

    const onDisk = fs.readFileSync(path.join(dir, 'judge-queue.json'), 'utf8');
    assert.ok(!onDisk.includes('judged'), 'a judged sample must not persist on disk');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('corrupt store file starts fresh instead of throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-queue-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'judge-queue.json'), '{nope', 'utf8');
    const q = new JudgeQueue({ dataDir: dir, logger: silentLogger });
    assert.strictEqual(q.samples().length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

setTimeout(() => {
  summary();
  exitWithCode();
}, 500);
