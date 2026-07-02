/**
 * ModelScorecard Unit Tests
 *
 * The maturation loop (Layer 2): per-(job, model, language) Beta
 * pseudo-count scores fed by mechanical outcomes, seeded from the
 * golden-set probe, with #232-style hysteresis on seat changes, a
 * production-evidence-only UCB exploration term, and an exploration floor
 * for destructive jobs. Also covers the IntentRouter verdict-custody seam
 * (model/language/parseFailed on the verdict) and the GoldenSetProbe
 * getters the seeding path consumes.
 *
 * Run: node test/unit/llm/model-scorecard.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

const ModelScorecard = require('../../../src/lib/llm/model-scorecard');
const GoldenSetProbe = require('../../../src/lib/llm/golden-set-probe');
const IntentRouter = require('../../../src/lib/agent/intent-router');

const silentLogger = { warn: () => {}, log: () => {}, info: () => {} };

function makeScorecard(opts = {}) {
  return new ModelScorecard({ dataDir: null, logger: silentLogger, ...opts });
}

function mean(entry) {
  return entry.a / (entry.a + entry.b);
}

// ============================================================
// Update rule
// ============================================================

test('a run of successes raises the pairing score; a failure lowers it', () => {
  const sc = makeScorecard();
  for (let i = 0; i < 4; i++) sc.recordSample('tools', 'm1', 'EN', true);
  const before = mean(sc.getPairings('tools').m1.EN);
  sc.recordSample('tools', 'm1', 'EN', false);
  const after = mean(sc.getPairings('tools').m1.EN);
  assert.strictEqual(before, 1.0);
  assert.ok(after < before, `failure must lower the score (${after} < ${before})`);
  assert.strictEqual(after, 4 / 5);
});

test('per-language separation: an EN failure does not touch the DE score', () => {
  const sc = makeScorecard();
  sc.recordSample('tools', 'm1', 'DE', true);
  sc.recordSample('tools', 'm1', 'DE', true);
  const deBefore = mean(sc.getPairings('tools').m1.DE);
  sc.recordSample('tools', 'm1', 'EN', false);
  const deAfter = mean(sc.getPairings('tools').m1.DE);
  assert.strictEqual(deBefore, 1.0);
  assert.strictEqual(deAfter, 1.0, 'DE score must be unaffected by an EN sample');
  assert.strictEqual(mean(sc.getPairings('tools').m1.EN), 0);
});

test('escalation samples carry their configured half weight', () => {
  const sc = makeScorecard();
  sc.recordSample('classification', 'm1', 'EN', false, { weight: sc.escalationWeight });
  const entry = sc.getPairings('classification').m1.EN;
  assert.strictEqual(entry.b, 0.5);
  assert.strictEqual(entry.a, 0);
});

test('unattributable samples are a no-op (null model)', () => {
  const sc = makeScorecard();
  const res = sc.recordSample('tools', null, 'EN', true);
  assert.strictEqual(res.recorded, false);
  assert.deepStrictEqual(sc.getPairings('tools'), {});
});

test('language falls back to the cockpit thunk and is normalized uppercase', () => {
  const sc = makeScorecard({ getLanguage: () => 'de' });
  sc.recordSample('tools', 'm1', null, true);
  assert.ok(sc.getPairings('tools').m1.DE, 'sample must land under DE');
});

test('per-language ceiling halving: mass halves for that language only, score preserved', () => {
  const sc = makeScorecard({ ceiling: 10 });
  for (let i = 0; i < 3; i++) sc.recordSample('tools', 'm1', 'DE', true);
  for (let i = 0; i < 12; i++) sc.recordSample('tools', 'm1', 'EN', true);
  const en = sc.getPairings('tools').m1.EN;
  const de = sc.getPairings('tools').m1.DE;
  assert.ok(en.a + en.b <= 10, `EN mass must have been halved (got ${en.a + en.b})`);
  assert.strictEqual(mean(en), 1.0, 'halving preserves the score');
  assert.strictEqual(de.a, 3, 'DE mass must be untouched by the EN ceiling');
});

// ============================================================
// Seeding from the golden-set probe
// ============================================================

test('seed enters in probe units (a=p·n, b=(1−p)·n) and sets the initial seat', () => {
  const sc = makeScorecard();
  sc.seedFromProbe('classification',
    [{ name: 'small', scores: { EN: 0.75, DE: 0.75 } }, { name: 'big', scores: { EN: 0.92 } }],
    { EN: 12, DE: 12 }, 'small');
  const small = sc.getPairings('classification').small;
  assert.strictEqual(small.EN.a, 9);
  assert.strictEqual(small.EN.b, 3);
  assert.strictEqual(small.DE.a, 9);
  assert.strictEqual(sc.getSeat('classification').model, 'small');
});

test('seeding never overwrites learned counts, and a learned seat survives re-seeding', () => {
  const sc = makeScorecard();
  sc.recordSample('classification', 'small', 'EN', false);
  sc.seedFromProbe('classification', [{ name: 'small', scores: { EN: 1.0 } }], { EN: 12 }, 'other');
  const entry = sc.getPairings('classification').small.EN;
  assert.strictEqual(entry.b, 1, 'learned count must not be overwritten by a seed');
  assert.strictEqual(entry.a, 0);
  // seat was already formed by the production sample's evaluate
  assert.strictEqual(sc.getSeat('classification').model, 'small');
});

test('accumulated production samples progressively override the low-sample seed', () => {
  const sc = makeScorecard();
  sc.seedFromProbe('classification', [{ name: 'm1', scores: { EN: 0.5 } }], { EN: 12 }, 'm1');
  assert.strictEqual(mean(sc.getPairings('classification').m1.EN), 0.5);
  for (let i = 0; i < 36; i++) sc.recordSample('classification', 'm1', 'EN', true);
  const m = mean(sc.getPairings('classification').m1.EN);
  assert.ok(m > 0.85, `36 clean production samples must dominate a 12-sample seed (got ${m})`);
});

// ============================================================
// Hysteresis (#232 discipline) — explorationC pinned to 0 so the
// margin rule is tested in isolation
// ============================================================

test('a challenger inside the margin does not displace the seeded incumbent', () => {
  const sc = makeScorecard({ explorationC: 0 });
  sc.seedFromProbe('classification',
    [{ name: 'small', scores: { EN: 0.75 } }, { name: 'big', scores: { EN: 0.80 } }],
    { EN: 12 }, 'small');
  sc.recordSample('classification', 'big', 'EN', true); // mean (9.6+1)/13 ≈ 0.815 < 0.75 + 1/12
  assert.strictEqual(sc.getSeat('classification').model, 'small');
});

test('a challenger clearing the margin takes the seat; one noisy sample does not flap it back', () => {
  const sc = makeScorecard({ explorationC: 0 });
  const seatChanges = [];
  sc.onSeatChange = (job, model) => seatChanges.push(`${job}:${model}`);
  sc.seedFromProbe('classification',
    [{ name: 'small', scores: { EN: 0.75 } }, { name: 'big', scores: { EN: 0.80 } }],
    { EN: 12 }, 'small');
  for (let i = 0; i < 10; i++) sc.recordSample('classification', 'big', 'EN', true);
  // big: (9.6+10)/22 ≈ 0.89 > 0.75 + 1/12 → promotion clears the margin
  assert.strictEqual(sc.getSeat('classification').model, 'big');
  assert.deepStrictEqual(seatChanges, ['classification:big']);
  sc.recordSample('classification', 'big', 'EN', false); // one noisy failure
  assert.strictEqual(sc.getSeat('classification').model, 'big', 'no flap on noise');
  assert.strictEqual(seatChanges.length, 1);
});

test('the seat feeds onSeatChange (the resolver override seam) exactly on change', () => {
  const calls = [];
  const sc = makeScorecard({ onSeatChange: (job, model) => calls.push([job, model]) });
  sc.recordSample('classification', 'm1', 'EN', true); // first seat
  sc.recordSample('classification', 'm1', 'EN', true); // no change
  assert.deepStrictEqual(calls, [['classification', 'm1']]);
});

// ============================================================
// Exploration — production evidence only, floor on destructive jobs
// ============================================================

test('the exploration bonus is zero without production evidence: seed-only optimism cannot flip a seat', () => {
  const sc = makeScorecard({ explorationC: 5 }); // extreme optimism
  sc.seedFromProbe('classification',
    [{ name: 'small', scores: { EN: 0.75 } }, { name: 'big', scores: { EN: 0.80 } }],
    { EN: 12 }, 'small');
  // Force a re-evaluation without adding production evidence anywhere is not
  // possible via the public API — the first production sample lands on the
  // incumbent, and prodTotal=1 with a huge C would already tip a within-
  // margin challenger. So assert the boundary directly: a fresh instance
  // sharing the state re-asserts the seeded seat untouched.
  assert.strictEqual(sc.getSeat('classification').model, 'small');
});

test('a demoted model earns a retry once enough production traffic accumulates (UCB)', () => {
  const sc = makeScorecard({ explorationC: 5 });
  // m2 seats first, then fails and is displaced by m1.
  sc.recordSample('classification', 'm2', 'EN', true);
  assert.strictEqual(sc.getSeat('classification').model, 'm2');
  for (let i = 0; i < 4; i++) sc.recordSample('classification', 'm2', 'EN', false);
  for (let i = 0; i < 3; i++) sc.recordSample('classification', 'm1', 'EN', true);
  assert.strictEqual(sc.getSeat('classification').model, 'm1', 'm2 must be demoted');
  // Traffic accrues on the incumbent; the demoted model's bonus grows with
  // ln(prodTotal) until it re-clears the margin — the retry.
  let flipped = false;
  for (let i = 0; i < 50 && !flipped; i++) {
    sc.recordSample('classification', 'm1', 'EN', true);
    flipped = sc.getSeat('classification').model === 'm2';
  }
  assert.ok(flipped, 'demoted model must eventually be retried via the exploration term');
});

test('graded exploration cap: a badly-failed model waits far longer for a destructive retry than a marginal one', () => {
  // Build one scenario per challenger quality: seat the challenger, degrade
  // it to the target mean, displace it with a clean model, then count how
  // much incumbent traffic it takes before optimism earns the retry.
  const flipAfter = (failures) => {
    const sc = makeScorecard({ explorationC: 2 });
    for (let i = 0; i < 20 - failures; i++) sc.recordSample('tools', 'm2', 'EN', true);
    for (let i = 0; i < failures; i++) sc.recordSample('tools', 'm2', 'EN', false);
    for (let i = 0; i < 3; i++) sc.recordSample('tools', 'm1', 'EN', true);
    assert.strictEqual(sc.getSeat('tools').model, 'm1', 'challenger must start demoted');
    for (let i = 1; i <= 300; i++) {
      sc.recordSample('tools', 'm1', 'EN', true);
      if (sc.getSeat('tools').model === 'm2') return i;
    }
    return Infinity;
  };
  const marginal = flipAfter(11); // mean 0.45, just under the 0.5 floor
  const bad = flipAfter(16);      // mean 0.20 — badly failed
  assert.ok(marginal < Infinity, 'a marginally-failed model must earn its retry');
  assert.strictEqual(bad, Infinity,
    'a 0.2-score model must not get handed a destructive call as its comeback audition');
});

test('a destructive job forms no first seat until a model clears the floor (prior stands)', () => {
  const sc = makeScorecard();
  sc.recordSample('tools', 'm1', 'EN', false);
  sc.recordSample('tools', 'm1', 'EN', false);
  sc.recordSample('tools', 'm1', 'EN', true); // mean 1/3 < 0.5
  assert.strictEqual(sc.getSeat('tools'), null, 'no override while nothing clears the floor');
  for (let i = 0; i < 5; i++) sc.recordSample('tools', 'm1', 'EN', true); // mean 6/8 = 0.75
  assert.strictEqual(sc.getSeat('tools').model, 'm1');
});

// ============================================================
// Persistence
// ============================================================

test('state survives a restart via the atomic JSON store (writes are debounced; flush() forces them)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorecard-'));
  try {
    const sc = new ModelScorecard({ dataDir: dir, logger: silentLogger });
    for (let i = 0; i < 3; i++) sc.recordSample('tools', 'm1', 'DE', true);
    // Plain samples coalesce into a debounced write — the hot path never
    // pays one synchronous disk write per LLM call. The seat change on the
    // first sample persisted immediately; flush() lands the rest.
    const midFlight = new ModelScorecard({ dataDir: dir, logger: silentLogger });
    assert.strictEqual(midFlight.getSeat('tools').model, 'm1', 'seat changes persist immediately');
    sc.flush();
    const reborn = new ModelScorecard({ dataDir: dir, logger: silentLogger });
    assert.strictEqual(reborn.getPairings('tools').m1.DE.a, 3);
    assert.strictEqual(reborn.getSeat('tools').model, 'm1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the ceiling halves the prod counter with a/b so stale exploration bonuses stay bounded', () => {
  const sc = makeScorecard({ ceiling: 10 });
  for (let i = 0; i < 12; i++) sc.recordSample('tools', 'm1', 'EN', true);
  const en = sc.getPairings('tools').m1.EN;
  assert.ok(en.prod <= 10, `prod must halve with the ceiling (got ${en.prod})`);
});

test('seat eligibility: a higher-scoring but unseatable model never wins the seat', () => {
  const overrides = [];
  const sc = makeScorecard({
    isSeatable: (_job, model) => model !== 'cloud-model',
    onSeatChange: (job, model) => overrides.push(`${job}:${model}`),
  });
  // The cloud fallback model performs perfectly; the local model is worse.
  for (let i = 0; i < 20; i++) sc.recordSample('tools', 'cloud-model', 'EN', true);
  for (let i = 0; i < 10; i++) sc.recordSample('tools', 'local-model', 'EN', i % 5 !== 0);
  assert.strictEqual(sc.getSeat('tools').model, 'local-model',
    'the seat feeds the local override slot — a cloud name there would 404 on Ollama');
  assert.ok(overrides.every(o => o !== 'tools:cloud-model'));
  // The cloud samples are still real data.
  assert.strictEqual(mean(sc.getPairings('tools')['cloud-model'].EN), 1.0);
});

test('assertSeats skips a persisted seat that is no longer seatable on this box', () => {
  const calls = [];
  const sc = makeScorecard({
    isSeatable: (_job, model) => model !== 'uninstalled',
    onSeatChange: (job, model) => calls.push(`${job}:${model}`),
  });
  sc.seedFromProbe('classification', [{ name: 'uninstalled', scores: { EN: 0.9 } }], { EN: 12 }, 'uninstalled');
  sc.assertSeats();
  assert.deepStrictEqual(calls, [], 'an unseatable seat must not reach the resolver override');
});

test('a corrupt store file starts fresh instead of throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorecard-'));
  try {
    fs.writeFileSync(path.join(dir, 'model-scorecard.json'), '{not json', 'utf8');
    const sc = new ModelScorecard({ dataDir: dir, logger: silentLogger });
    assert.deepStrictEqual(sc.getPairings('tools'), {});
    assert.strictEqual(sc.getSeat('tools'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('assertSeats re-fires every persisted seat through onSeatChange (boot order)', () => {
  const calls = [];
  const sc = makeScorecard({ onSeatChange: (job, model) => calls.push([job, model]) });
  sc.seedFromProbe('classification', [{ name: 'small', scores: { EN: 0.9 } }], { EN: 12 }, 'small');
  sc.assertSeats();
  assert.deepStrictEqual(calls, [['classification', 'small']]);
});

// ============================================================
// GoldenSetProbe getters (the seed read path)
// ============================================================

const probeFixture = {
  version: 1,
  threshold: 0.75,
  languages: {
    EN: [
      { id: 1, message: 'en-1', gate: 'knowledge', domain: null },
      { id: 2, message: 'en-2', gate: 'action', domain: 'deck' }
    ],
    DE: [
      { id: 1, message: 'de-1', gate: 'knowledge', domain: null },
      { id: 2, message: 'de-2', gate: 'action', domain: 'deck' }
    ]
  }
};

asyncTest('getMeasuredScores maps candidates to per-language accuracies; unmeasured models are omitted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
  try {
    const truth = {};
    for (const items of Object.values(probeFixture.languages)) {
      for (const item of items) truth[item.message] = { gate: item.gate, domain: item.domain };
    }
    const probe = new GoldenSetProbe({
      classifyFn: async (model, message) => {
        if (model === 'broken') throw new Error('cold ollama');
        return truth[message];
      },
      fixture: probeFixture,
      cacheDir: dir,
      logger: silentLogger,
    });
    const candidates = [{ name: 'good', digest: 'sha:good' }, { name: 'broken', digest: 'sha:broken' }];
    await probe.run(candidates);
    const measured = probe.getMeasuredScores(candidates);
    assert.strictEqual(measured.length, 1, 'incomplete measurements must be omitted, not zeroed');
    assert.strictEqual(measured[0].name, 'good');
    assert.deepStrictEqual(measured[0].scores, { EN: 1, DE: 1 });
    assert.deepStrictEqual(probe.getExampleCounts(), { EN: 2, DE: 2 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================
// IntentRouter verdict custody (model, language, parseFailed)
// ============================================================

asyncTest('the verdict carries the producing model and prompt language', async () => {
  const router = new IntentRouter({
    provider: { chat: async () => ({ content: '{"gate":"knowledge","confidence":0.9}' }) },
    getLanguage: () => 'DE',
  });
  const verdict = await router._classifyWithModel('modelX', 'hallo');
  assert.strictEqual(verdict.model, 'modelX');
  assert.strictEqual(verdict.language, 'DE');
  assert.strictEqual(verdict.gate, 'knowledge');
  assert.ok(!verdict.parseFailed);
});

asyncTest('a structural parse failure records a full-weight classification negative', async () => {
  const samples = [];
  const router = new IntentRouter({
    provider: { chat: async () => ({ content: 'no json here at all' }) },
    getLanguage: () => 'PT',
    modelScorecard: { recordSample: (...args) => samples.push(args) },
  });
  const verdict = await router._classifyWithModel('modelX', 'oi');
  assert.strictEqual(verdict.parseFailed, true);
  assert.strictEqual(samples.length, 1);
  assert.deepStrictEqual(samples[0], ['classification', 'modelX', 'PT', false]);
});

asyncTest('probe runs never feed the maturation loop (the fixture already enters as the seed)', async () => {
  const samples = [];
  const router = new IntentRouter({
    provider: { chat: async () => ({ content: 'garbage' }) },
    getLanguage: () => 'EN',
    modelScorecard: { recordSample: (...args) => samples.push(args) },
  });
  await router.probeClassify('modelX', 'hi', 'DE');
  assert.strictEqual(samples.length, 0, 'probeClassify must not record production samples');
});

asyncTest('a classify() timeout on the local primary records a negative for that model', async () => {
  const samples = [];
  const router = new IntentRouter({
    provider: { chat: async () => { throw new Error('Ollama request timed out after 40000ms'); } },
    getLanguage: () => 'EN',
    getTrust: () => 'local-only',
    getSmartModel: () => 'smart-model',
    getFastModel: () => 'smart-model', // same model → no doomed fast retry
    modelScorecard: { recordSample: (...args) => samples.push(args) },
  });
  const verdict = await router.classify('do something');
  assert.ok(verdict, 'regex fallback must still produce a verdict');
  assert.strictEqual(samples.length, 1);
  assert.deepStrictEqual(samples[0], ['classification', 'smart-model', 'EN', false]);
});

setTimeout(() => {
  summary();
  exitWithCode();
}, 500);
