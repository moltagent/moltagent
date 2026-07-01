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
  assert.strictEqual(fixture.version, 1);
  assert.strictEqual(fixture.threshold, 0.75);
  assert.ok(Array.isArray(fixture.languages.EN));
  assert.ok(Array.isArray(fixture.languages.DE));
  assert.ok(Array.isArray(fixture.languages.PT));
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

asyncTest('TC-PROBE-008: editing a label without bumping version invalidates the cache (content-hash salt)', async () => {
  const cacheDir = uniqueTmpDir();
  try {
    const fixtureA = makeFixture();
    let callCount = 0;
    const classifyFn = async (...args) => { callCount++; return perfectClassifyFn(fixtureA)(...args); };
    const candidates = [{ name: 'm', paramSize: 3, digest: 'd-fixed' }];

    const probeA = new GoldenSetProbe({ classifyFn, fixture: fixtureA, cacheDir, logger: silentLogger });
    await probeA.run(candidates);
    const afterA = callCount;

    // Same version (1), but a label changed. The content-hash salt must differ,
    // so the prior entry does NOT hit and the model is re-probed.
    const fixtureB = makeFixture();
    fixtureB.languages.DE[1].gate = 'knowledge'; // was 'action'
    const classifyFnB = async (...args) => { callCount++; return perfectClassifyFn(fixtureB)(...args); };
    const probeB = new GoldenSetProbe({ classifyFn: classifyFnB, fixture: fixtureB, cacheDir, logger: silentLogger });
    await probeB.run(candidates);

    assert.ok(callCount > afterA, 'a fixture content change must invalidate the cache even without a version bump');
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

// Summary
setTimeout(() => {
  summary();
  exitWithCode();
}, 500);
