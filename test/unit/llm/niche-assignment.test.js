/**
 * NicheAssignment Unit Tests
 *
 * Layer 3: winners composed into a memory-feasible assignment. Covers the
 * adapter timing helper (ns→ms, custody of the response's model name), the
 * residency ledger and thrash oracle (organic-only, calibration excluded,
 * window consumption), conflict resolution under a simulated memory ceiling
 * (lowest-value drop, judge/cockpit protection, rosterFor remap targets,
 * never-go-dark), hysteresis re-admission with strike escalation, /api/ps
 * enrichment and its absence (foundation-only degradation), the replanSoon
 * debounce, and the ModelResolver setAssignment slot (applied last, cockpit
 * exempt, winner visible in derivation, resolveWinner unaffected).
 *
 * Run: node test/unit/llm/niche-assignment.test.js
 */

'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

const { NicheAssignment, JOB_WEIGHTS } = require('../../../src/lib/llm/niche-assignment');
const { emitOllamaTimings } = require('../../../src/lib/llm/ollama-timings');
const { ModelResolver } = require('../../../src/lib/llm/model-resolver');

const silentLogger = { warn: () => {}, log: () => {}, info: () => {}, error: () => {} };

// ------------------------------------------------------------
// Fakes
// ------------------------------------------------------------

/** Resolver fake: winners per job + a record of setAssignment calls. */
function makeResolverFake(winners) {
  return {
    assignments: [],
    resolveWinner(job) {
      const w = winners[job];
      if (!w) return { model: null, trust: 'cloud-ok', source: 'fallback' };
      return { model: w.model, trust: 'cloud-ok', source: w.source || 'model-scout' };
    },
    setAssignment(map) {
      this.assignments.push(map ? { ...map } : null);
    },
    lastAssignment() {
      return this.assignments.length ? this.assignments[this.assignments.length - 1] : undefined;
    },
  };
}

/** Scout fake: eligibility chains per job + a judge pin. */
function makeScoutFake({ chains = {}, judge = null } = {}) {
  return {
    rosterFor: (job) => [...(chains[job] || [])],
    selectJudgeModel: () => (judge ? { name: judge, paramSize: null, digest: null } : null),
  };
}

/** A controllable clock. */
function makeClock(start = 1_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}

function makeAssignment({ winners, chains, judge, jobs, clock, ...rest } = {}) {
  const resolver = makeResolverFake(winners || {});
  const na = new NicheAssignment({
    resolver,
    modelScout: makeScoutFake({ chains, judge }),
    jobs: jobs || Object.keys(winners || {}),
    ollamaEndpoint: null,
    now: clock || makeClock(),
    logger: silentLogger,
    ...rest,
  });
  return { na, resolver };
}

/** Push one organic load event (above the 1s threshold). */
function organicLoad(na, model, ms = 5000) {
  na.recordTiming({ model, loadDurationMs: ms, calibration: false });
}

// ============================================================
// emitOllamaTimings (the shared adapter-neck helper)
// ============================================================

test('emitOllamaTimings converts nanoseconds to milliseconds', () => {
  let seen = null;
  emitOllamaTimings((t) => { seen = t; }, {
    model: 'qwen3:8b',
    load_duration: 63_000_000_000, // 63s in ns
    total_duration: 70_000_000_000,
    eval_duration: 5_000_000_000,
  }, 'requested-model', false);
  assert.strictEqual(seen.model, 'qwen3:8b');
  assert.strictEqual(seen.loadDurationMs, 63_000);
  assert.strictEqual(seen.totalDurationMs, 70_000);
  assert.strictEqual(seen.evalDurationMs, 5_000);
  assert.strictEqual(seen.calibration, false);
});

test('emitOllamaTimings: the response body names the model that served; the request name is only a fallback', () => {
  let seen = null;
  const sink = (t) => { seen = t; };
  emitOllamaTimings(sink, { model: 'served-model', load_duration: 1 }, 'requested-model');
  assert.strictEqual(seen.model, 'served-model');
  emitOllamaTimings(sink, { load_duration: 1 }, 'requested-model');
  assert.strictEqual(seen.model, 'requested-model');
});

test('emitOllamaTimings: absent duration fields emit as 0; a throwing sink never propagates', () => {
  let seen = null;
  emitOllamaTimings((t) => { seen = t; }, { model: 'm' });
  assert.strictEqual(seen.loadDurationMs, 0);
  assert.strictEqual(seen.totalDurationMs, 0);
  assert.doesNotThrow(() => {
    emitOllamaTimings(() => { throw new Error('broken sink'); }, { model: 'm' });
  });
  assert.doesNotThrow(() => emitOllamaTimings(null, { model: 'm' }));
  assert.doesNotThrow(() => emitOllamaTimings(() => {}, null));
});

// ============================================================
// Residency ledger + thrash oracle
// ============================================================

test('a warm response (load_duration under the threshold) is not a load event', () => {
  const { na } = makeAssignment({ winners: { tools: { model: 'big' } } });
  na.recordTiming({ model: 'big', loadDurationMs: 40 });
  assert.strictEqual(na.getStatus().recentLoadEvents.length, 0);
});

test('a cold load above the threshold is recorded as a load event', () => {
  const { na } = makeAssignment({ winners: { tools: { model: 'big' } } });
  organicLoad(na, 'big', 63_000);
  const events = na.getStatus().recentLoadEvents;
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].model, 'big');
  assert.strictEqual(events[0].loadDurationMs, 63_000);
});

test('thrash: 3 organic load events across 2 models inside the window mark the pair non-co-fit', () => {
  const clock = makeClock();
  const { na } = makeAssignment({
    winners: { tools: { model: 'huge' }, thinking: { model: 'big' } },
    chains: { thinking: ['big', 'huge'] },
    clock,
  });
  organicLoad(na, 'big');
  clock.advance(60_000);
  organicLoad(na, 'huge');
  clock.advance(60_000);
  organicLoad(na, 'big');
  const nonCoFit = na.getStatus().nonCoFit;
  assert.strictEqual(nonCoFit.length, 1);
  assert.deepStrictEqual(nonCoFit[0].models, ['big', 'huge']);
});

test('no thrash from repeated loads of a SINGLE model (a restart cold start is not a conflict)', () => {
  const clock = makeClock();
  const { na } = makeAssignment({ winners: { tools: { model: 'big' } }, clock });
  for (let i = 0; i < 4; i++) {
    organicLoad(na, 'big');
    clock.advance(60_000);
  }
  assert.strictEqual(na.getStatus().nonCoFit.length, 0);
});

test('no thrash from events spread wider than the window', () => {
  const clock = makeClock();
  const { na } = makeAssignment({ winners: { tools: { model: 'huge' }, thinking: { model: 'big' } }, clock });
  organicLoad(na, 'big');
  clock.advance(16 * 60 * 1000); // outside the 15-min window
  organicLoad(na, 'huge');
  clock.advance(16 * 60 * 1000);
  organicLoad(na, 'big');
  assert.strictEqual(na.getStatus().nonCoFit.length, 0);
});

test('calibration loads are ledgered but NEVER count toward thrash (probe burst, judge cycles)', () => {
  const clock = makeClock();
  const { na } = makeAssignment({ winners: { tools: { model: 'huge' }, thinking: { model: 'big' } }, clock });
  // A golden-set boot burst: every candidate cold-loads, flagged calibration.
  for (const m of ['small', 'big', 'huge', 'small', 'big', 'huge']) {
    na.recordTiming({ model: m, loadDurationMs: 30_000, calibration: true });
    clock.advance(30_000);
  }
  assert.strictEqual(na.getStatus().nonCoFit.length, 0, 'boot burst must not read as thrash');
  assert.ok(na.getStatus().recentLoadEvents.every(e => e.calibration));
});

test('a thrash episode is consumed: the same window does not re-fire on the next single load', () => {
  const clock = makeClock();
  const { na } = makeAssignment({
    winners: { tools: { model: 'huge' }, thinking: { model: 'big' } },
    chains: { thinking: ['big', 'huge'] },
    clock,
  });
  organicLoad(na, 'big');
  organicLoad(na, 'huge');
  organicLoad(na, 'big'); // fires, strike 1
  assert.strictEqual(na.getStatus().nonCoFit[0].strikes, 1);
  clock.advance(1000);
  organicLoad(na, 'huge'); // one fresh event alone must not re-fire
  assert.strictEqual(na.getStatus().nonCoFit[0].strikes, 1);
});

// ============================================================
// Planning: identity, conflict resolution, remap
// ============================================================

test('with no non-co-fit evidence the plan is the identity: winners stand, resolver slot cleared', () => {
  const { na, resolver } = makeAssignment({
    winners: {
      classification: { model: 'small' },
      tools: { model: 'huge' },
      thinking: { model: 'big' },
    },
  });
  const { map, residentPlan } = na.replan();
  assert.deepStrictEqual(map, {});
  assert.deepStrictEqual(residentPlan, ['big', 'huge', 'small']);
  assert.strictEqual(resolver.assignments.length, 0,
    'identity→identity publishes nothing (no per-pulse resolver cache flush)');
  na.replan();
  assert.strictEqual(resolver.assignments.length, 0, 'repeated identity replans stay silent');
});

test('under a proven conflict the lowest-value model is dropped and its jobs remap onto a resident model', () => {
  const clock = makeClock();
  const { na, resolver } = makeAssignment({
    winners: {
      classification: { model: 'small' }, // weight 100
      tools: { model: 'huge' },           // weight 80
      thinking: { model: 'big' },         // weight 40 — lowest, dropped
    },
    chains: { thinking: ['big', 'huge', 'small'] },
    clock,
  });
  organicLoad(na, 'big');
  organicLoad(na, 'huge');
  organicLoad(na, 'big'); // thrash fires and replans
  const map = resolver.lastAssignment();
  assert.deepStrictEqual(map, { thinking: 'huge' }, 'thinking remaps to the surviving co-resident specialist');
  assert.ok(!na.getStatus().residentPlan.includes('big'), 'big left the resident plan');
});

test('the judge is a protected tenant: a conflict drops the unprotected side even at higher job value', () => {
  const clock = makeClock();
  const { na, resolver } = makeAssignment({
    winners: {
      tools: { model: 'huge' },   // weight 80 — but unprotected
      thinking: { model: 'big' }, // weight 40
    },
    chains: { tools: ['huge', 'big'] },
    judge: 'big', // judge pinned to big → big is never dropped
    clock,
  });
  organicLoad(na, 'big');
  organicLoad(na, 'huge');
  organicLoad(na, 'big');
  assert.deepStrictEqual(resolver.lastAssignment(), { tools: 'big' }, 'tools colocates with the judge model');
  assert.ok(na.getStatus().residentPlan.includes('big'), 'judge model stays resident');
  assert.ok(!na.getStatus().residentPlan.includes('huge'));
});

test('the judge model is held in the resident plan even when no job wins it', () => {
  const { na } = makeAssignment({
    winners: { classification: { model: 'small' } },
    judge: 'big',
  });
  const { residentPlan } = na.replan();
  assert.deepStrictEqual(residentPlan, ['big', 'small']);
});

test('cockpit-pinned jobs are exempt: never remapped, their model never dropped', () => {
  const clock = makeClock();
  const { na, resolver } = makeAssignment({
    winners: {
      tools: { model: 'huge' },                              // weight 80
      thinking: { model: 'big', source: 'cockpit-card' },    // pinned by the human
    },
    chains: { tools: ['huge', 'big'] },
    clock,
  });
  organicLoad(na, 'big');
  organicLoad(na, 'huge');
  organicLoad(na, 'big');
  const map = resolver.lastAssignment();
  assert.ok(!map || !('thinking' in (map || {})), 'a cockpit-pinned job is never remapped');
  assert.deepStrictEqual(map, { tools: 'big' }, 'the unpinned job moves instead');
  assert.ok(na.getStatus().residentPlan.includes('big'), 'the pinned model stays resident');
});

test('never-go-dark: with no capability-eligible resident target the winner stands (cold load beats wrong capability)', () => {
  const clock = makeClock();
  const { na, resolver } = makeAssignment({
    winners: {
      classification: { model: 'small' },
      tools: { model: 'toolbox' },   // weight 80
      thinking: { model: 'big' },    // weight 40 — dropped on conflict
    },
    chains: { thinking: [] }, // nothing eligible to remap thinking onto
    clock,
  });
  organicLoad(na, 'big');
  organicLoad(na, 'toolbox');
  organicLoad(na, 'big');
  assert.deepStrictEqual(na.getStatus().assignment, {}, 'no remap — the winner stands');
  assert.strictEqual(resolver.assignments.length, 0, 'an unchanged (identity) plan publishes nothing');
  assert.ok(na.getStatus().residentPlan.includes('big'), 'the winner re-enters the plan');
});

// ============================================================
// Hysteresis re-admission
// ============================================================

test('re-admission: after the cool-off expires the pair is no longer active and the winner is restored', () => {
  const clock = makeClock();
  const { na, resolver } = makeAssignment({
    winners: { tools: { model: 'huge' }, thinking: { model: 'big' } },
    chains: { thinking: ['big', 'huge'] },
    clock,
  });
  organicLoad(na, 'big');
  organicLoad(na, 'huge');
  organicLoad(na, 'big');
  assert.deepStrictEqual(resolver.lastAssignment(), { thinking: 'huge' });
  clock.advance(61 * 60 * 1000); // past the 60-min first-strike cool-off
  na.replan();
  assert.strictEqual(resolver.lastAssignment(), null, 'expired verdict re-admits the winner');
});

test('strike escalation: a recurring verdict doubles the cool-off (#232 discipline — no flapping)', () => {
  const clock = makeClock();
  const { na } = makeAssignment({
    winners: { tools: { model: 'huge' }, thinking: { model: 'big' } },
    chains: { thinking: ['big', 'huge'] },
    clock,
  });
  organicLoad(na, 'big');
  organicLoad(na, 'huge');
  organicLoad(na, 'big'); // strike 1: 60min
  const first = na.getStatus().nonCoFit[0].readmissionInMs;
  clock.advance(61 * 60 * 1000);
  organicLoad(na, 'big');
  organicLoad(na, 'huge');
  organicLoad(na, 'big'); // strike 2: 120min
  const second = na.getStatus().nonCoFit[0].readmissionInMs;
  assert.ok(second > first * 1.5, `cool-off must escalate (${second} vs ${first})`);
});

// ============================================================
// Enrichment (/api/ps) and degradation
// ============================================================

asyncTest('reconcile reads /api/ps where present and reports real residency', async () => {
  const clock = makeClock();
  const fetchImpl = () => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({
      models: [
        { name: 'qwen3:8b', size: 5_900_000_000, size_vram: 0, expires_at: '2318-10-12T00:00:00Z' },
        { name: 'qwen2.5:3b', size: 2_000_000_000, size_vram: 0, expires_at: '2318-10-12T00:00:00Z' },
      ],
    }),
  });
  const resolver = makeResolverFake({ tools: { model: 'qwen3:8b' } });
  const na = new NicheAssignment({
    resolver,
    modelScout: makeScoutFake({}),
    jobs: ['tools'],
    ollamaEndpoint: 'http://ollama.test:11434',
    fetchImpl,
    now: clock,
    logger: silentLogger,
  });
  await na.reconcile();
  const status = na.getStatus();
  assert.deepStrictEqual(status.psResident, ['qwen3:8b', 'qwen2.5:3b']);
  assert.strictEqual(status.psAgeMs, 0);
});

asyncTest('degradation: with /api/ps unreachable the foundation-only path still produces a working plan', async () => {
  const { resolver } = { resolver: null };
  const clock = makeClock();
  const failingFetch = () => Promise.reject(new Error('ECONNREFUSED'));
  const resolverFake = makeResolverFake({ tools: { model: 'big' }, classification: { model: 'small' } });
  const na = new NicheAssignment({
    resolver: resolverFake,
    modelScout: makeScoutFake({}),
    jobs: ['tools', 'classification'],
    ollamaEndpoint: 'http://ollama.test:11434',
    fetchImpl: failingFetch,
    now: clock,
    logger: silentLogger,
  });
  const { residentPlan } = await na.reconcile();
  assert.deepStrictEqual(residentPlan, ['big', 'small'], 'plan works without enrichment');
  assert.strictEqual(na.getStatus().psResident, null);
  void resolver;
});

asyncTest('degradation: no endpoint configured at all — reconcile is foundation-only by construction', async () => {
  const { na } = makeAssignment({ winners: { tools: { model: 'big' } } });
  const { residentPlan } = await na.reconcile();
  assert.deepStrictEqual(residentPlan, ['big']);
  assert.strictEqual(na.getStatus().psResident, null);
});

// ============================================================
// replanSoon debounce
// ============================================================

asyncTest('replanSoon collapses a burst (assertSeats boot burst) into one plan on the next tick', async () => {
  const { na } = makeAssignment({ winners: { tools: { model: 'big' } } });
  let replans = 0;
  const realReplan = na.replan.bind(na);
  na.replan = () => { replans++; return realReplan(); };
  na.replanSoon();
  na.replanSoon();
  na.replanSoon();
  assert.strictEqual(replans, 0, 'nothing runs synchronously');
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(replans, 1, 'one plan for the whole burst');
  na.stop();
});

// ============================================================
// ModelResolver.setAssignment (the resolver slot)
// ============================================================

function makeRealResolver({ roster = { tools: ['m-scout'] }, cockpitModel = null } = {}) {
  const scout = {
    generateLocalRoster: () => roster,
    hasModel: () => true,
  };
  const cockpitManager = cockpitModel
    ? { cachedConfig: { system: { modelsConfig: { trust: 'cloud-ok', localDefault: cockpitModel } } } }
    : null;
  return new ModelResolver({
    deployerConfig: { model: 'm-deployer' },
    envModel: null,
    modelScout: scout,
    cockpitManager,
    logger: silentLogger,
  });
}

test('setAssignment remaps the resolved model, keeps trust/provider, and shows the winner in derivation', () => {
  const resolver = makeRealResolver();
  const before = resolver.resolve('tools');
  assert.strictEqual(before.model, 'm-scout');
  resolver.setAssignment({ tools: 'm-shared' });
  const after = resolver.resolve('tools');
  assert.strictEqual(after.model, 'm-shared');
  assert.strictEqual(after.source, 'niche-assignment');
  assert.strictEqual(after.derivation.assignmentWinner, 'm-scout', 'the displaced winner stays visible');
  assert.strictEqual(after.trust, before.trust, 'trust untouched');
  assert.strictEqual(after.provider, before.provider, 'provider untouched');
});

test('resolveWinner reads the pre-assignment winner (the plan never feeds on its own output)', () => {
  const resolver = makeRealResolver();
  resolver.setAssignment({ tools: 'm-shared' });
  assert.strictEqual(resolver.resolveWinner('tools').model, 'm-scout');
  assert.strictEqual(resolver.resolve('tools').model, 'm-shared');
});

test('a cockpit-card win is never remapped by the assignment', () => {
  const resolver = makeRealResolver({ cockpitModel: 'm-pinned' });
  resolver.setAssignment({ tools: 'm-shared' });
  const r = resolver.resolve('tools');
  assert.strictEqual(r.model, 'm-pinned');
  assert.strictEqual(r.source, 'cockpit-card');
});

test('setAssignment(null) clears the remap; an empty map is treated as clear', () => {
  const resolver = makeRealResolver();
  resolver.setAssignment({ tools: 'm-shared' });
  assert.strictEqual(resolver.resolve('tools').model, 'm-shared');
  resolver.setAssignment(null);
  assert.strictEqual(resolver.resolve('tools').model, 'm-scout');
  resolver.setAssignment({});
  assert.strictEqual(resolver.resolve('tools').model, 'm-scout');
});

test('refresh() does not clear the assignment (a Cockpit re-read has no opinion on load behaviour)', () => {
  const resolver = makeRealResolver();
  resolver.setAssignment({ tools: 'm-shared' });
  resolver.refresh();
  assert.strictEqual(resolver.resolve('tools').model, 'm-shared');
});

test('an assignment naming an unrelated job leaves other jobs alone; prototype keys read as absent', () => {
  const resolver = makeRealResolver({ roster: { tools: ['m-scout'], quick: ['m-small'] } });
  resolver.setAssignment({ quick: 'm-scout' });
  assert.strictEqual(resolver.resolve('tools').model, 'm-scout');
  assert.strictEqual(resolver.resolve('quick').model, 'm-scout');
  resolver.setAssignment({ quick: 'm-small' });
  const r = resolver.resolve('constructor');
  assert.notStrictEqual(typeof r.model, 'function', 'prototype pollution guard');
});

// ============================================================
// JOB_WEIGHTS sanity (structural, job names only)
// ============================================================

test('JOB_WEIGHTS ranks request-path jobs above long-form jobs', () => {
  assert.ok(JOB_WEIGHTS.classification > JOB_WEIGHTS.thinking);
  assert.ok(JOB_WEIGHTS.quick > JOB_WEIGHTS.writing);
  assert.ok(JOB_WEIGHTS.tools > JOB_WEIGHTS.credentials);
});

// ============================================================

setTimeout(() => {
  summary();
  exitWithCode();
}, 500);
