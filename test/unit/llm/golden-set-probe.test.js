/**
 * GoldenSetProbe Unit Tests
 *
 * Measures classification accuracy per language against a labeled fixture
 * and selects the smallest local model that clears the bar in every
 * language — ground truth beats a size prior. Also covers the ModelResolver
 * probe tier the probe's winner feeds into.
 *
 * Run: node test/unit/llm/golden-set-probe.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

const GoldenSetProbe = require('../../../src/lib/llm/golden-set-probe');
const { ModelResolver } = require('../../../src/lib/llm/model-resolver');

// ============================================================
// Fixtures / helpers
// ============================================================

// Small parallel EN/DE/PT fixture, 4 items per language, mirroring the real
// fixture's shape (gate/domain ground truth). Message text is unique per
// item so a fake classifyFn can look up the correct answer without needing
// the fixture item's id.
function makeFixture() {
  return {
    version: 1,
    threshold: 0.75,
    languages: {
      EN: [
        { id: 1, message: 'en-msg-1', gate: 'knowledge', domain: null },
        { id: 2, message: 'en-msg-2', gate: 'action', domain: 'deck' },
        { id: 3, message: 'en-msg-3', gate: 'action', domain: 'email' },
        { id: 4, message: 'en-msg-4', gate: 'thinking', domain: null }
      ],
      DE: [
        { id: 1, message: 'de-msg-1', gate: 'knowledge', domain: null },
        { id: 2, message: 'de-msg-2', gate: 'action', domain: 'deck' },
        { id: 3, message: 'de-msg-3', gate: 'action', domain: 'email' },
        { id: 4, message: 'de-msg-4', gate: 'thinking', domain: null }
      ],
      PT: [
        { id: 1, message: 'pt-msg-1', gate: 'knowledge', domain: null },
        { id: 2, message: 'pt-msg-2', gate: 'action', domain: 'deck' },
        { id: 3, message: 'pt-msg-3', gate: 'action', domain: 'email' },
        { id: 4, message: 'pt-msg-4', gate: 'thinking', domain: null }
      ]
    }
  };
}

// message -> ground-truth { gate, domain }, flattened across languages.
function truthMap(fixture) {
  const map = {};
  for (const items of Object.values(fixture.languages)) {
    for (const item of items) {
      map[item.message] = { gate: item.gate, domain: item.domain };
    }
  }
  return map;
}

function perfectClassifyFn(fixture) {
  const truth = truthMap(fixture);
  return async (_model, message) => truth[message] || { gate: 'knowledge', domain: null };
}

const silentLogger = { warn: () => {}, log: () => {}, info: () => {} };

function capturingLogger() {
  const warnings = [];
  return { warnings, warn: (msg) => warnings.push(msg), log: () => {}, info: () => {} };
}

function uniqueTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'golden-set-probe-test-'));
}

// ============================================================
// Tests
// ============================================================

console.log('\n=== GoldenSetProbe Tests ===\n');

asyncTest('TC-PROBE-001: perfect model passes every language and is selected', async () => {
  const fixture = makeFixture();
  const cacheDir = uniqueTmpDir();
  try {
    const probe = new GoldenSetProbe({
      classifyFn: perfectClassifyFn(fixture),
      fixture,
      cacheDir,
      logger: silentLogger
    });
    const result = await probe.run([{ name: 'perfect-model', paramSize: 3, digest: 'd1' }]);
    assert.strictEqual(result.model, 'perfect-model');
    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.reason, 'smallest passer');
    assert.strictEqual(result.scores.EN, 1);
    assert.strictEqual(result.scores.DE, 1);
    assert.strictEqual(result.scores.PT, 1);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

asyncTest('TC-PROBE-002: smallest-first candidates both pass -> smallest wins', async () => {
  const fixture = makeFixture();
  const cacheDir = uniqueTmpDir();
  try {
    const probe = new GoldenSetProbe({
      classifyFn: perfectClassifyFn(fixture),
      fixture,
      cacheDir,
      logger: silentLogger
    });
    const candidates = [
      { name: 'small', paramSize: 2, digest: 'd-small' },
      { name: 'big', paramSize: 8, digest: 'd-big' }
    ];
    await probe.run(candidates);
    const result = probe.select(candidates);
    assert.strictEqual(result.model, 'small');
    assert.strictEqual(result.passed, true);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

asyncTest('TC-PROBE-003: no candidate clears DE -> least-bad picked, loud warning logged', async () => {
  const fixture = makeFixture();
  const truth = truthMap(fixture);
  const cacheDir = uniqueTmpDir();
  try {
    // modelA: DE always wrong (0/4). modelB: DE half wrong (2/4 = 0.5). Both
    // fail the 0.75 DE threshold, but modelB has the higher minimum-language
    // score (0.5 vs 0) and must be the least-bad pick.
    const classifyFn = async (model, message, lang) => {
      if (lang === 'DE') {
        const id = parseInt(message.split('-').pop(), 10);
        if (model === 'modelA') return { gate: 'greeting', domain: null };
        if (model === 'modelB' && id > 2) return { gate: 'greeting', domain: null };
      }
      return truth[message];
    };

    const logger = capturingLogger();
    const probe = new GoldenSetProbe({ classifyFn, fixture, cacheDir, logger });
    const candidates = [
      { name: 'modelA', paramSize: 2, digest: 'd-a' },
      { name: 'modelB', paramSize: 4, digest: 'd-b' }
    ];
    const result = await probe.run(candidates);

    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.model, 'modelB');
    assert.ok(result.scores.DE < 0.75, 'DE score must be below threshold');
    assert.ok(logger.warnings.length > 0, 'a loud warning must be logged when nothing passes');
    assert.ok(
      logger.warnings.some(w => w.includes('GoldenSetProbe') && w.includes('modelB')),
      'warning should name the selected least-bad model'
    );
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

asyncTest('TC-PROBE-004: second run with same candidates+digests reuses the cache (no re-probe)', async () => {
  const fixture = makeFixture();
  const cacheDir = uniqueTmpDir();
  try {
    let callCount = 0;
    const classifyFn = async (...args) => {
      callCount++;
      return perfectClassifyFn(fixture)(...args);
    };
    const candidates = [{ name: 'cache-model', paramSize: 3, digest: 'digest-cache-1' }];

    const probe1 = new GoldenSetProbe({ classifyFn, fixture, cacheDir, logger: silentLogger });
    await probe1.run(candidates);
    const firstCallCount = callCount;
    assert.ok(firstCallCount > 0, 'first run must call classifyFn');

    // Simulate a restart: a brand-new probe instance pointed at the same
    // on-disk cache directory must not re-probe an already-scored digest.
    const probe2 = new GoldenSetProbe({ classifyFn, fixture, cacheDir, logger: silentLogger });
    const result2 = await probe2.run(candidates);

    assert.strictEqual(callCount, firstCallCount, 'classifyFn must not be called again on cache hit');
    assert.strictEqual(result2.model, 'cache-model');
    assert.strictEqual(result2.passed, true);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

asyncTest('TC-PROBE-005: empty candidates returns null model without throwing', async () => {
  const fixture = makeFixture();
  const cacheDir = uniqueTmpDir();
  try {
    const probe = new GoldenSetProbe({
      classifyFn: perfectClassifyFn(fixture),
      fixture,
      cacheDir,
      logger: silentLogger
    });
    const result = await probe.run([]);
    assert.strictEqual(result.model, null);
    assert.strictEqual(result.passed, false);

    // Also guard select() and run() directly against null/undefined input.
    assert.strictEqual(probe.select(null).model, null);
    const resultUndefined = await probe.run(undefined);
    assert.strictEqual(resultUndefined.model, null);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('TC-PROBE-006: loadFixture parses the real golden-set fixture', () => {
  const fixturePath = path.join(__dirname, '../../fixtures/golden-set/classification-golden-set.json');
  const fixture = GoldenSetProbe.loadFixture(fixturePath);
  assert.strictEqual(fixture.version, 2);
  assert.strictEqual(fixture.threshold, 0.75);
  assert.ok(Array.isArray(fixture.languages.EN));
  assert.ok(Array.isArray(fixture.languages.DE));
  assert.ok(Array.isArray(fixture.languages.PT));
});

test('TC-PROBE-006b: every fixture example labels its language and mutation expectation (#272/#273)', () => {
  const fixturePath = path.join(__dirname, '../../fixtures/golden-set/classification-golden-set.json');
  const fixture = GoldenSetProbe.loadFixture(fixturePath);

  for (const [lang, items] of Object.entries(fixture.languages)) {
    assert.ok(items.length > 0, `${lang} has examples`);
    for (const ex of items) {
      assert.strictEqual(ex.language, lang,
        `${lang}#${ex.id}: an example's language label must match its section`);
      assert.strictEqual(typeof ex.expectsMutation, 'boolean',
        `${lang}#${ex.id}: expectsMutation must be labelled`);
    }
  }
});

test('TC-PROBE-006c: the fixture is parallel across languages, including the read-only action trap', () => {
  const fixturePath = path.join(__dirname, '../../fixtures/golden-set/classification-golden-set.json');
  const fixture = GoldenSetProbe.loadFixture(fixturePath);
  const langs = Object.keys(fixture.languages);

  // Parallel: same ids, same labels, translated text. A per-language accuracy
  // gap must reflect the model's language handling, not different difficulty.
  const signature = (items) => items
    .map(e => `${e.id}:${e.gate}:${e.domain}:${e.expectsMutation}`)
    .sort().join('|');
  const reference = signature(fixture.languages[langs[0]]);
  for (const lang of langs.slice(1)) {
    assert.strictEqual(signature(fixture.languages[lang]), reference,
      `${lang} must carry the same labelled intents as ${langs[0]}`);
  }

  // The trap #272 is about: gate=action (needs the tool pipeline, #134) AND
  // expectsMutation=false (changes nothing). Without these the fixture cannot
  // catch a model that collapses the two meanings.
  for (const lang of langs) {
    const readOnlyActions = fixture.languages[lang]
      .filter(e => e.gate === 'action' && e.expectsMutation === false);
    assert.ok(readOnlyActions.length >= 3,
      `${lang} needs read-only action examples; found ${readOnlyActions.length}`);
  }
});

asyncTest('TC-PROBE-007: a transient all-error measurement is NOT cached and yields no pick (cold-Ollama poisoning guard)', async () => {
  const fixture = makeFixture();
  const cacheDir = uniqueTmpDir();
  try {
    // Simulate Ollama cold/down at boot: every classify throws.
    let throwing = true;
    let callCount = 0;
    const classifyFn = async (...args) => {
      callCount++;
      if (throwing) throw new Error('ECONNREFUSED');
      return perfectClassifyFn(fixture)(...args);
    };
    const candidates = [{ name: 'cold-model', paramSize: 3, digest: 'd-cold' }];
    const logger = capturingLogger();
    const probe = new GoldenSetProbe({ classifyFn, fixture, cacheDir, logger });

    const r1 = await probe.run(candidates);
    // No usable measurement → no pick to apply (scout's size prior stands), and
    // no false "classifies poorly" alarm.
    assert.strictEqual(r1.model, null, 'a fully-failed probe must not select a model');
    assert.strictEqual(r1.reason, 'no measurements');
    // Nothing poisoned to disk: the cache file must not hold the zero-scores.
    const cacheFile = path.join(cacheDir, 'golden-set-probe.json');
    assert.ok(!fs.existsSync(cacheFile), 'a failed measurement must not be persisted');

    // Ollama warms up; the next boot must RE-PROBE (not serve poisoned zeros).
    throwing = false;
    const callsBeforeRetry = callCount;
    const probe2 = new GoldenSetProbe({ classifyFn, fixture, cacheDir, logger });
    const r2 = await probe2.run(candidates);
    assert.ok(callCount > callsBeforeRetry, 'a previously-failed model must be re-probed, not cached');
    assert.strictEqual(r2.model, 'cold-model');
    assert.strictEqual(r2.passed, true);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

asyncTest('TC-PROBE-008: a fixture-content change seats the prior score provisionally and defers re-measurement to idle (#285)', async () => {
  const cacheDir = uniqueTmpDir();
  try {
    const fixtureA = makeFixture();
    let callCount = 0;
    const classifyFn = async (...args) => { callCount++; return perfectClassifyFn(fixtureA)(...args); };
    const candidates = [{ name: 'm', paramSize: 3, digest: 'd-fixed' }];

    const probeA = new GoldenSetProbe({ classifyFn, fixture: fixtureA, cacheDir, logger: silentLogger });
    await probeA.run(candidates);
    const afterA = callCount;
    assert.ok(afterA > 0, 'first boot measures the model');

    // Same version (1), but a label changed → the content-hash salt differs, so
    // the current-rev key misses (the invalidation still happens). Under #285
    // that miss does NOT re-measure at BOOT: the prior-rev score seats the model
    // provisionally, and re-measurement is deferred to the idle lane so the boot
    // walk never stampedes serving.
    const fixtureB = makeFixture();
    fixtureB.languages.DE[1].gate = 'knowledge'; // was 'action'
    const classifyFnB = async (...args) => { callCount++; return perfectClassifyFn(fixtureB)(...args); };
    const probeB = new GoldenSetProbe({ classifyFn: classifyFnB, fixture: fixtureB, cacheDir, logger: silentLogger });
    const rB = await probeB.run(candidates);

    assert.strictEqual(callCount, afterA, 'a fixture change must NOT re-measure at boot — the prior score seats provisionally');
    assert.strictEqual(rB.model, 'm', 'the provisional prior score still seats select()');

    // The provisional seat is queued for idle re-measurement…
    assert.deepStrictEqual(probeB.getUnmeasuredCandidates(candidates).map(c => c.name), ['m'],
      'a provisionally-seated model must appear in the idle lane for re-measurement');

    // …and measureOne() (the idle-lane unit) re-measures it against the NEW
    // fixture and clears the provisional flag.
    const before = callCount;
    const one = await probeB.measureOne(candidates[0]);
    assert.ok(callCount > before, 'idle re-measurement runs the classifier against the current fixture');
    assert.strictEqual(one.measured, true);
    assert.deepStrictEqual(probeB.getUnmeasuredCandidates(candidates), [],
      'after idle re-measurement the model is no longer provisional');
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

asyncTest('TC-PROBE-009: a candidate with digest null keys the cache by name (still caches)', async () => {
  const fixture = makeFixture();
  const cacheDir = uniqueTmpDir();
  try {
    let callCount = 0;
    const classifyFn = async (...args) => { callCount++; return perfectClassifyFn(fixture)(...args); };
    const candidates = [{ name: 'no-digest-model', paramSize: 3, digest: null }];

    const probe1 = new GoldenSetProbe({ classifyFn, fixture, cacheDir, logger: silentLogger });
    const r1 = await probe1.run(candidates);
    assert.strictEqual(r1.model, 'no-digest-model');
    const afterFirst = callCount;

    // Restart: keyed by name (digest null) → cache still hits, no re-probe.
    const probe2 = new GoldenSetProbe({ classifyFn, fixture, cacheDir, logger: silentLogger });
    await probe2.run(candidates);
    assert.strictEqual(callCount, afterFirst, 'digest-null candidate must still be cache-keyed by name');
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

// ============================================================
// ModelResolver probe tier
// ============================================================

console.log('\n--- ModelResolver golden-set-probe tier ---\n');

function createMockScout(roster, installed) {
  const installedSet = new Set(installed || Object.values(roster || {}).flat());
  return {
    generateLocalRoster: () => roster,
    hasModel: (name) => installedSet.has(name)
  };
}

function createMockCockpit(modelsConfig) {
  return { cachedConfig: { system: { modelsConfig } } };
}

test('TC-PROBE-010: setGroundTruthOverride wins over model-scout, below cockpit', () => {
  const resolver = new ModelResolver({
    modelScout: createMockScout({ classification: ['small'] }, ['small', 'operator-choice']),
    logger: silentLogger
  });

  // Before the probe runs, ModelScout's size-prior pick serves the job.
  assert.strictEqual(resolver.resolve('classification').model, 'small');
  assert.strictEqual(resolver.resolve('classification').source, 'model-scout');

  resolver.setGroundTruthOverride('classification', 'measured');
  const r = resolver.resolve('classification');
  assert.strictEqual(r.model, 'measured');
  assert.strictEqual(r.source, 'golden-set-probe');

  // An explicit Cockpit card override is deliberate human intent and still
  // wins over a measurement.
  resolver.cockpitManager = createMockCockpit({ trust: 'local-only', localDefault: 'operator-choice' });
  resolver.refresh(); // refresh must NOT clear the ground-truth override map
  const r2 = resolver.resolve('classification');
  assert.strictEqual(r2.model, 'operator-choice');
  assert.strictEqual(r2.source, 'cockpit-card');
});

test('TC-PROBE-011: clearing the override (null model) falls back to model-scout', () => {
  const resolver = new ModelResolver({
    modelScout: createMockScout({ classification: ['small'] }),
    logger: silentLogger
  });
  resolver.setGroundTruthOverride('classification', 'measured');
  assert.strictEqual(resolver.resolve('classification').model, 'measured');

  resolver.setGroundTruthOverride('classification', null);
  const r = resolver.resolve('classification');
  assert.strictEqual(r.model, 'small');
  assert.strictEqual(r.source, 'model-scout');
});

test('TC-PROBE-012: setGroundTruthOverride guards against a falsy job', () => {
  const resolver = new ModelResolver({ logger: silentLogger });
  assert.doesNotThrow(() => resolver.setGroundTruthOverride(null, 'x'));
  assert.doesNotThrow(() => resolver.setGroundTruthOverride('', 'x'));
});

// ============================================================
// Hysteresis (#232): a passing incumbent holds the seat unless a smaller
// challenger clears bar + one-fixture-example margin, or the incumbent
// itself drops below the bar. Test fixture: 4 examples/language, bar 0.75,
// margin 1/4 = 0.25 → displace bar = 1.00.
// ============================================================

console.log('\n--- Hysteresis (#232) ---\n');

// classifyFn answering the first `correctPerLang[model]` examples of every
// language correctly and the rest wrong — controlled per-model accuracy.
function accuracyClassifyFn(fixture, correctPerModel) {
  const truth = truthMap(fixture);
  const position = {};
  for (const items of Object.values(fixture.languages)) {
    items.forEach((item, i) => { position[item.message] = i; });
  }
  return async (model, message) => {
    const k = correctPerModel[model] ?? 0;
    if (position[message] < k) return truth[message];
    return { gate: 'greeting', domain: null };
  };
}

asyncTest('TC-HYST-001: challenger at exactly the bar does not displace a passing incumbent', async () => {
  const fixture = makeFixture();
  const cacheDir = uniqueTmpDir();
  try {
    const probe = new GoldenSetProbe({
      classifyFn: accuracyClassifyFn(fixture, { small: 3, big: 4 }), // small: 0.75, big: 1.0
      fixture,
      cacheDir,
      logger: silentLogger
    });
    probe._incumbent = 'big';
    const result = await probe.run([
      { name: 'small', paramSize: 2, digest: 's1' },
      { name: 'big', paramSize: 8, digest: 'b1' }
    ]);
    assert.strictEqual(result.model, 'big');
    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.reason, 'incumbent holds seat');
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

asyncTest('TC-HYST-002: challenger clearing bar+margin takes the seat', async () => {
  const fixture = makeFixture();
  const cacheDir = uniqueTmpDir();
  try {
    const probe = new GoldenSetProbe({
      classifyFn: accuracyClassifyFn(fixture, { small: 4, big: 4 }), // small: 1.0 >= 0.75+0.25
      fixture,
      cacheDir,
      logger: silentLogger
    });
    probe._incumbent = 'big';
    const result = await probe.run([
      { name: 'small', paramSize: 2, digest: 's1' },
      { name: 'big', paramSize: 8, digest: 'b1' }
    ]);
    assert.strictEqual(result.model, 'small');
    assert.strictEqual(result.passed, true);
    assert.ok(result.reason.startsWith('challenger cleared bar+margin'), `unexpected reason: ${result.reason}`);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

asyncTest('TC-HYST-003: incumbent below the bar loses the seat to the smallest passer', async () => {
  const fixture = makeFixture();
  const cacheDir = uniqueTmpDir();
  try {
    const probe = new GoldenSetProbe({
      classifyFn: accuracyClassifyFn(fixture, { small: 3, big: 2 }), // big: 0.5 < bar; small: 0.75 passes
      fixture,
      cacheDir,
      logger: silentLogger
    });
    probe._incumbent = 'big';
    const result = await probe.run([
      { name: 'small', paramSize: 2, digest: 's1' },
      { name: 'big', paramSize: 8, digest: 'b1' }
    ]);
    assert.strictEqual(result.model, 'small');
    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.reason, 'smallest passer');
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

asyncTest('TC-HYST-004: the seat persists in the cache file and survives a restart', async () => {
  const fixture = makeFixture();
  const cacheDir = uniqueTmpDir();
  try {
    const candidates = [
      { name: 'small', paramSize: 2, digest: 's1' },
      { name: 'big', paramSize: 8, digest: 'b1' }
    ];
    const probe1 = new GoldenSetProbe({
      classifyFn: accuracyClassifyFn(fixture, { small: 3, big: 4 }),
      fixture,
      cacheDir,
      logger: silentLogger
    });
    const r1 = await probe1.run(candidates);
    assert.strictEqual(r1.model, 'small', 'no incumbent yet: smallest passer wins');

    const persisted = JSON.parse(fs.readFileSync(path.join(cacheDir, 'golden-set-probe.json'), 'utf8'));
    assert.strictEqual(persisted.__selection__?.model, 'small', 'seat must be persisted');

    // Restart: fresh probe, same cacheDir. Scores come from cache; the seat
    // must be restored from disk and hold (big never displaces downward,
    // and nothing smaller than small exists).
    const probe2 = new GoldenSetProbe({
      classifyFn: accuracyClassifyFn(fixture, { small: 3, big: 4 }),
      fixture,
      cacheDir,
      logger: silentLogger
    });
    const r2 = await probe2.run(candidates);
    assert.strictEqual(r2.model, 'small');
    assert.strictEqual(r2.reason, 'incumbent holds seat');
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

asyncTest('TC-HYST-005: a least-bad (non-passing) pick is not seated as incumbent', async () => {
  const fixture = makeFixture();
  const cacheDir = uniqueTmpDir();
  try {
    const probe = new GoldenSetProbe({
      classifyFn: accuracyClassifyFn(fixture, { small: 1, big: 2 }), // nobody passes
      fixture,
      cacheDir,
      logger: silentLogger
    });
    const result = await probe.run([
      { name: 'small', paramSize: 2, digest: 's1' },
      { name: 'big', paramSize: 8, digest: 'b1' }
    ]);
    assert.strictEqual(result.passed, false);
    const persisted = JSON.parse(fs.readFileSync(path.join(cacheDir, 'golden-set-probe.json'), 'utf8'));
    assert.strictEqual(persisted.__selection__, undefined, 'least-bad must not hold a seat');
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

// ============================================================
// Early exit + idle-lane migration (#260): run() stops at the first passer
// (plus a larger incumbent, for the hysteresis defense) and defers the rest
// to getUnmeasuredCandidates()/measureOne().
// ============================================================

console.log('\n--- Early exit + idle lane (#260) ---\n');

// Wraps a classifyFn and records every model name it is asked to classify —
// lets a test assert which candidates run() actually loaded.
function trackingClassifyFn(inner, seen) {
  return async (model, message, lang) => {
    seen.add(model);
    return inner(model, message, lang);
  };
}

asyncTest('TC-EXIT-001: run() stops at the smallest passer — larger candidates are never measured', async () => {
  const fixture = makeFixture();
  const cacheDir = uniqueTmpDir();
  try {
    const seen = new Set();
    const probe = new GoldenSetProbe({
      classifyFn: trackingClassifyFn(perfectClassifyFn(fixture), seen),
      fixture,
      cacheDir,
      logger: silentLogger
    });
    const result = await probe.run([
      { name: 'small', paramSize: 2, digest: 's1' },
      { name: 'mid', paramSize: 8, digest: 'm1' },
      { name: 'big', paramSize: 30, digest: 'b1' }
    ]);
    assert.strictEqual(result.model, 'small');
    assert.strictEqual(result.passed, true);
    assert.deepStrictEqual([...seen], ['small'], 'only the smallest passer is measured; mid/big are deferred');
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

asyncTest('TC-EXIT-002: run() still measures a LARGER incumbent so hysteresis can defend the seat', async () => {
  const fixture = makeFixture();
  const cacheDir = uniqueTmpDir();
  try {
    const seen = new Set();
    // small passes at the bar (0.75) but not by margin; big (incumbent) is perfect.
    const probe = new GoldenSetProbe({
      classifyFn: trackingClassifyFn(accuracyClassifyFn(fixture, { small: 3, big: 4, huge: 4 }), seen),
      fixture,
      cacheDir,
      logger: silentLogger
    });
    probe._incumbent = 'big';
    const result = await probe.run([
      { name: 'small', paramSize: 2, digest: 's1' },
      { name: 'big', paramSize: 8, digest: 'b1' },
      { name: 'huge', paramSize: 30, digest: 'h1' }
    ]);
    // Seat defense needs the incumbent's scores, so 'big' IS measured even
    // though a smaller passer preceded it; 'huge' (larger than both) is not.
    assert.ok(seen.has('small') && seen.has('big'), 'small and the larger incumbent big are both measured');
    assert.ok(!seen.has('huge'), 'nothing larger than the incumbent is measured');
    assert.strictEqual(result.model, 'big', 'incumbent holds — small did not clear bar+margin');
    assert.strictEqual(result.reason, 'incumbent holds seat');
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

asyncTest('TC-EXIT-003: getUnmeasuredCandidates() lists the skipped candidates; measureOne() drains one', async () => {
  const fixture = makeFixture();
  const cacheDir = uniqueTmpDir();
  try {
    const seen = new Set();
    const candidates = [
      { name: 'small', paramSize: 2, digest: 's1' },
      { name: 'mid', paramSize: 8, digest: 'm1' },
      { name: 'big', paramSize: 30, digest: 'b1' }
    ];
    const probe = new GoldenSetProbe({
      classifyFn: trackingClassifyFn(perfectClassifyFn(fixture), seen),
      fixture,
      cacheDir,
      logger: silentLogger
    });
    await probe.run(candidates);

    // The two the early exit skipped are unmeasured (defaults to run()'s list).
    assert.deepStrictEqual(probe.getUnmeasuredCandidates().map(c => c.name), ['mid', 'big']);

    const r = await probe.measureOne({ name: 'mid', paramSize: 8, digest: 'm1' });
    assert.strictEqual(r.measured, true);
    assert.strictEqual(r.complete, true);
    assert.strictEqual(r.scores.EN, 1);
    // measureOne is seat-neutral — it must not touch the selection state.
    const persisted = JSON.parse(fs.readFileSync(path.join(cacheDir, 'golden-set-probe.json'), 'utf8'));
    assert.strictEqual(persisted.__selection__.model, 'small', 'measureOne must not reseat');

    // mid is now measured; only big remains unmeasured.
    assert.deepStrictEqual(probe.getUnmeasuredCandidates().map(c => c.name), ['big']);

    // A fresh probe over the same cacheDir sees the persisted measurements on disk.
    const probe2 = new GoldenSetProbe({ classifyFn: perfectClassifyFn(fixture), fixture, cacheDir, logger: silentLogger });
    assert.deepStrictEqual(probe2.getUnmeasuredCandidates(candidates).map(c => c.name), ['big'], 'disk cache, not just in-memory, gates re-measurement');
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

asyncTest('TC-EXIT-004: measureOne() does not cache an incomplete (cold-Ollama) measurement', async () => {
  const fixture = makeFixture();
  const cacheDir = uniqueTmpDir();
  try {
    const probe = new GoldenSetProbe({
      classifyFn: async () => { throw new Error('Ollama request timed out'); },
      fixture,
      cacheDir,
      logger: silentLogger
    });
    const r = await probe.measureOne({ name: 'cold', paramSize: 8, digest: 'c1' });
    assert.strictEqual(r.measured, false);
    assert.strictEqual(r.complete, false);
    assert.strictEqual(r.reason, 'incomplete');
    // Not persisted → still unmeasured, so the next idle pulse retries it.
    assert.deepStrictEqual(
      probe.getUnmeasuredCandidates([{ name: 'cold', paramSize: 8, digest: 'c1' }]).map(c => c.name),
      ['cold']
    );
    assert.strictEqual(fs.existsSync(path.join(cacheDir, 'golden-set-probe.json')), false, 'no cache file written for an incomplete measurement');
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

asyncTest('TC-EXIT-005: idle lane is fenced out while a boot run() is in flight', async () => {
  const fixture = makeFixture();
  const cacheDir = uniqueTmpDir();
  try {
    const candidates = [
      { name: 'small', paramSize: 2, digest: 's1' },
      { name: 'big', paramSize: 30, digest: 'b1' }
    ];
    // Gate the classify call on a promise we control, so run() is provably
    // mid-measurement when we probe the idle-lane accessor.
    let release;
    const gate = new Promise(res => { release = res; });
    let gateUsed = false;
    const probe = new GoldenSetProbe({
      classifyFn: async (model, message, lang) => {
        if (!gateUsed) { gateUsed = true; await gate; }
        return perfectClassifyFn(fixture)(model, message, lang);
      },
      fixture,
      cacheDir,
      logger: silentLogger
    });
    const running = probe.run(candidates);
    // Yield so run() reaches its first (gated) classify call.
    await Promise.resolve();
    assert.deepStrictEqual(probe.getUnmeasuredCandidates(candidates), [], 'idle lane must no-op while run() is measuring');
    release();
    await running;
    // After run() completes the fence lifts and the skipped candidate surfaces.
    assert.deepStrictEqual(probe.getUnmeasuredCandidates().map(c => c.name), ['big']);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

// ============================================================
// Admission gate (#285): the measurement loop yields to a live turn between
// fixture examples so a boot re-measurement walk never stampedes serving.
// ============================================================

console.log('\n--- Admission gate: probe yields to serving (#285) ---\n');

// A deterministic fake of shared/ollama-gate: serving state and idle()
// resolution are driven by the test, no real timers.
function controllableGate() {
  let serving = false;
  let resolver = null;
  return {
    setServing(v) { serving = v; },
    isServing: () => serving,
    idle() { return new Promise(res => { resolver = res; }); },
    release(result) {
      const r = resolver; resolver = null;
      if (r) r(result || { waited: true, timedOut: false });
    },
    get waiting() { return resolver !== null; },
  };
}

asyncTest('TC-GATE-PROBE-001: run() pauses while serving and resumes after the turn — the turn is never queued behind probe calls', async () => {
  const fixture = makeFixture();
  const cacheDir = uniqueTmpDir();
  try {
    const seen = [];
    const classifyFn = async (_model, message) => {
      seen.push(message);
      return truthMap(fixture)[message] || { gate: 'knowledge', domain: null };
    };
    const gate = controllableGate();
    gate.setServing(true); // a live turn is in flight when the boot walk starts
    const probe = new GoldenSetProbe({
      classifyFn, fixture, cacheDir, servingGate: gate, logger: silentLogger,
    });

    const running = probe.run([{ name: 'm', paramSize: 3, digest: 'd' }]);
    // Let run() reach its first pre-example yield.
    await Promise.resolve(); await Promise.resolve();
    assert.strictEqual(seen.length, 0, 'no classify runs while a turn is serving — the probe is parked at the gate');
    assert.ok(gate.waiting, 'the probe is waiting on idle()');

    // The turn ends; the gate releases the probe.
    gate.setServing(false);
    gate.release();
    const result = await running;
    assert.ok(seen.length > 0, 'the probe resumed and measured after serving went idle');
    assert.strictEqual(result.model, 'm');
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

asyncTest('TC-GATE-PROBE-002: the wait cap lets the probe proceed on a chatty deployment (no starvation), and logs it', async () => {
  const fixture = makeFixture();
  const cacheDir = uniqueTmpDir();
  try {
    // Serving never ends; idle() always resolves at the cap (timedOut).
    const gate = {
      isServing: () => true,
      idle: () => Promise.resolve({ waited: true, timedOut: true }),
    };
    const logger = capturingLogger();
    const probe = new GoldenSetProbe({
      classifyFn: perfectClassifyFn(fixture), fixture, cacheDir,
      servingGate: gate, servingWaitMs: 1000, logger,
    });
    const result = await probe.run([{ name: 'm', paramSize: 3, digest: 'd' }]);
    assert.strictEqual(result.model, 'm', 'measurement still completes after the cap fires');
    assert.ok(
      logger.warnings.some(w => w.includes('cap') && w.includes('measuring anyway')),
      'the cap firing is logged loudly'
    );
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

// Summary
setTimeout(() => {
  summary();
  exitWithCode();
}, 500);
