/**
 * Cloud Chain Ordering from Judged Evidence (#237)
 *
 * The quality veto on the cost anchor: a cloud model with PROVEN quality
 * problems for a job (one fixture-quantum of mass in a failing language
 * cell, mean below the band) sinks below all healthy peers in that job's
 * cloud chain and re-enters as tail fallback. Covers the ModelScorecard
 * demotion state (band, mass floor, strikes, recheck cadence,
 * persistence), the router's healthy/all partition upstream of the depth
 * policy (tail re-entry, never-go-dark, custom-roster exemption), the
 * scorecard↔router bridge, and LocalJudge's re-audition through the
 * cold-cell chokepoint (budget gate untouched).
 *
 * Run: node test/unit/llm/cloud-demotion.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

const ModelScorecard = require('../../../src/lib/llm/model-scorecard');
const LLMRouter = require('../../../src/lib/llm/router');
const LocalJudge = require('../../../src/lib/llm/local-judge');
const JudgeQueue = require('../../../src/lib/llm/judge-queue');

const silentLogger = { warn: () => {}, log: () => {}, info: () => {} };

const DAY_MS = 24 * 60 * 60 * 1000;

function makeScorecard(opts = {}) {
  return new ModelScorecard({ dataDir: null, logger: silentLogger, ...opts });
}

function fails(sc, job, model, lang, n) {
  for (let i = 0; i < n; i++) sc.recordSample(job, model, lang, false);
}

function passes(sc, job, model, lang, n) {
  for (let i = 0; i < n; i++) sc.recordSample(job, model, lang, true);
}

// Three cloud tiers + local, same setup shape as the cost-optimization
// tests. The anthropic adapter profile declares completion+tools, so all
// three are eligible for every job and ordering is pure cost rank.
function makeRouter() {
  return new LLMRouter({
    providers: {
      'ollama-local': { adapter: 'ollama', type: 'local', model: 'qwen3:8b', endpoint: 'http://localhost:11434' },
      'cloud-heavy': { adapter: 'anthropic', type: 'api', model: 'model-heavy', costModel: { type: 'per_token', inputPer1M: 15, outputPer1M: 75 } },
      'cloud-mid': { adapter: 'anthropic', type: 'api', model: 'model-mid', costModel: { type: 'per_token', inputPer1M: 3, outputPer1M: 15 } },
      'cloud-cheap': { adapter: 'anthropic', type: 'api', model: 'model-cheap', costModel: { type: 'per_token', inputPer1M: 0.8, outputPer1M: 4 } },
    },
  });
}

// ============================================================
// Scorecard: demote on threshold, mass floor, dead band
// ============================================================

test('demotion fires only when a failing cell carries one fixture-quantum of mass', () => {
  const sc = makeScorecard();
  fails(sc, 'writing', 'cloudy', 'DE', 11);
  assert.strictEqual(sc.isDemoted('writing', 'cloudy'), false, '11 < mass floor — no demotion yet');
  fails(sc, 'writing', 'cloudy', 'DE', 1);
  assert.strictEqual(sc.isDemoted('writing', 'cloudy'), true, '12 failures = mass 12, mean 0 — demoted');
  const rec = sc.getCloudDemotions().writing.cloudy;
  assert.strictEqual(rec.strikes, 1);
  assert.strictEqual(rec.trigger.lang, 'DE');
  assert.strictEqual(rec.trigger.mean, 0);
  assert.ok(rec.recheckAt > rec.at, 'recheck scheduled after the demotion');
});

test('demotion is per-(job, model): the same model stays healthy for other jobs', () => {
  const sc = makeScorecard();
  fails(sc, 'writing', 'cloudy', 'DE', 12);
  assert.strictEqual(sc.isDemoted('writing', 'cloudy'), true);
  assert.strictEqual(sc.isDemoted('thinking', 'cloudy'), false);
  assert.strictEqual(sc.isDemoted('writing', 'other'), false);
});

test('dead band: a mean inside [floor−margin, floor+margin) moves nothing in either direction', () => {
  const sc = makeScorecard();
  // Healthy model at mean 0.5 over full mass: inside the band, no demotion.
  passes(sc, 'writing', 'okayish', 'EN', 6);
  fails(sc, 'writing', 'okayish', 'EN', 6);
  assert.strictEqual(sc.isDemoted('writing', 'okayish'), false, 'band means status quo — healthy stays healthy');

  // Demoted model recovering to mean 0.5: inside the band, stays demoted.
  const sc2 = makeScorecard();
  fails(sc2, 'writing', 'cloudy', 'EN', 12);
  assert.strictEqual(sc2.isDemoted('writing', 'cloudy'), true);
  passes(sc2, 'writing', 'cloudy', 'EN', 12);
  assert.strictEqual(sc2.isDemoted('writing', 'cloudy'), true, 'band means status quo — demoted stays demoted');
});

test('an unmeasured (thin) language cell can neither trigger nor block', () => {
  const sc = makeScorecard();
  // Thin failing PT cell alone: no demotion.
  fails(sc, 'writing', 'cloudy', 'PT', 2);
  assert.strictEqual(sc.isDemoted('writing', 'cloudy'), false);
  // DE carries the quantum: demotion.
  fails(sc, 'writing', 'cloudy', 'DE', 12);
  assert.strictEqual(sc.isDemoted('writing', 'cloudy'), true);
  // DE recovers past the upper edge; the thin PT cell must not block.
  passes(sc, 'writing', 'cloudy', 'DE', 17); // 17/29 ≈ 0.586 ≥ 0.5833
  assert.strictEqual(sc.isDemoted('writing', 'cloudy'), false, 'thin PT cell cannot block reinstatement');
});

test('no qualifying cell at all means no reinstatement (no evidence is not recovery)', () => {
  const sc = makeScorecard();
  fails(sc, 'writing', 'cloudy', 'DE', 12);
  assert.strictEqual(sc.isDemoted('writing', 'cloudy'), true);
  // Halve the cell below the mass floor (the ceiling does this in life);
  // a sample elsewhere re-evaluates with no qualifying DE cell.
  const de = sc.getPairings('writing').cloudy.DE;
  de.a /= 2; de.b /= 2; // mass 6 < 12
  sc.recordSample('writing', 'other', 'EN', true);
  assert.strictEqual(sc.isDemoted('writing', 'cloudy'), true, 'status quo holds without qualifying evidence');
});

// ============================================================
// Scorecard: reinstatement, callback, strikes escalation
// ============================================================

test('reinstate when every qualifying cell clears floor+margin; callback fires both ways', () => {
  const events = [];
  const sc = makeScorecard();
  sc.onCloudDemotionChange = (job, model) => events.push(`${job}/${model}/${sc.isDemoted(job, model) ? 'demoted' : 'reinstated'}`);
  fails(sc, 'writing', 'cloudy', 'EN', 12);
  passes(sc, 'writing', 'cloudy', 'EN', 17); // 17/29 ≈ 0.586
  assert.strictEqual(sc.isDemoted('writing', 'cloudy'), false);
  assert.deepStrictEqual(events, ['writing/cloudy/demoted', 'writing/cloudy/reinstated']);
  const memory = sc.getCloudDemotions().writing.cloudy;
  assert.ok(memory.reinstatedAt, 'reinstatement leaves strike memory');
  assert.strictEqual(memory.strikes, 1);
});

test('a throwing onCloudDemotionChange never breaks recordSample', () => {
  const sc = makeScorecard();
  sc.onCloudDemotionChange = () => { throw new Error('bridge exploded'); };
  fails(sc, 'writing', 'cloudy', 'EN', 12);
  assert.strictEqual(sc.isDemoted('writing', 'cloudy'), true, 'demotion recorded despite callback failure');
});

test('strikes escalate on re-demotion within the memory window, and reset after it', () => {
  const sc = makeScorecard();
  fails(sc, 'writing', 'cloudy', 'EN', 12);
  const first = sc.getCloudDemotions().writing.cloudy;
  assert.strictEqual(first.strikes, 1);
  assert.ok(Math.abs((Date.parse(first.recheckAt) - Date.parse(first.at)) - 7 * DAY_MS) < 60000, 'first cool-off ≈ 7d');

  passes(sc, 'writing', 'cloudy', 'EN', 17); // reinstated (17/29)
  fails(sc, 'writing', 'cloudy', 'EN', 12); // 17/41 ≈ 0.415 — re-demoted immediately
  const second = sc.getCloudDemotions().writing.cloudy;
  assert.strictEqual(second.strikes, 2, 'consecutive failure escalates');
  assert.ok(Math.abs((Date.parse(second.recheckAt) - Date.parse(second.at)) - 14 * DAY_MS) < 60000, 'second cool-off ≈ 14d');

  passes(sc, 'writing', 'cloudy', 'EN', 17); // 34/58 ≈ 0.586 — reinstated again
  // Age the reinstatement past the strike-memory window.
  sc._state.cloudDemotions.writing.cloudy.reinstatedAt = new Date(Date.now() - 15 * DAY_MS).toISOString();
  fails(sc, 'writing', 'cloudy', 'EN', 24); // 34/82 ≈ 0.415 — demoted anew
  assert.strictEqual(sc.getCloudDemotions().writing.cloudy.strikes, 1, 'distant re-demotion starts over');
});

// ============================================================
// Scorecard: recheck cadence and persistence
// ============================================================

test('isRecheckDue: false inside the cool-off, per-language once the cool-off elapses', () => {
  const sc = makeScorecard();
  fails(sc, 'writing', 'cloudy', 'EN', 12);
  fails(sc, 'writing', 'cloudy', 'DE', 12);
  assert.strictEqual(sc.isRecheckDue('writing', 'cloudy', 'EN'), false, 'cool-off has not elapsed');
  assert.strictEqual(sc.isRecheckDue('writing', 'cloudy'), false);

  sc._state.cloudDemotions.writing.cloudy.recheckAt = new Date(Date.now() - 1000).toISOString();
  assert.strictEqual(sc.isRecheckDue('writing', 'cloudy'), true);
  assert.strictEqual(sc.isRecheckDue('writing', 'cloudy', 'EN'), true);
  assert.strictEqual(sc.isRecheckDue('writing', 'cloudy', 'DE'), true);

  // A landing sample (probe or organic) is EN's re-audition this period;
  // DE remains due, and a healthy model is never due.
  sc.recordSample('writing', 'cloudy', 'EN', false);
  assert.strictEqual(sc.isRecheckDue('writing', 'cloudy', 'EN'), false, 'EN consumed its recheck slot');
  assert.strictEqual(sc.isRecheckDue('writing', 'cloudy', 'DE'), true, 'DE still due');
  assert.strictEqual(sc.isRecheckDue('writing', 'healthy', 'EN'), false);
});

test('demotions and strike memory survive a persistence round-trip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorecard-demotion-'));
  try {
    const sc = new ModelScorecard({ dataDir: dir, logger: silentLogger });
    fails(sc, 'writing', 'cloudy', 'DE', 12);
    fails(sc, 'quick', 'flaky', 'EN', 12);
    passes(sc, 'quick', 'flaky', 'EN', 17); // reinstated — memory persists too
    sc.flush();

    const reloaded = new ModelScorecard({ dataDir: dir, logger: silentLogger });
    assert.strictEqual(reloaded.isDemoted('writing', 'cloudy'), true);
    assert.strictEqual(reloaded.isDemoted('quick', 'flaky'), false);
    const rec = reloaded.getCloudDemotions();
    assert.strictEqual(rec.writing.cloudy.recheckAt, sc.getCloudDemotions().writing.cloudy.recheckAt);
    assert.ok(rec.quick.flaky.reinstatedAt, 'strike memory round-trips');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================
// Router: the veto in the ONE generating function
// ============================================================

test('no quality check wired → chains are byte-identical to pure cost order', () => {
  const router = makeRouter();
  const roster = router._resolvePreset('smart-mix');
  assert.deepStrictEqual(roster.writing, ['cloud-heavy', 'cloud-mid', 'cloud-cheap', 'ollama-local']);
  assert.deepStrictEqual(roster.quick, ['cloud-cheap', 'ollama-local']);
});

test('cheapest-depth job: demoting the leader changes what "cheapest" means; demoted tails', () => {
  const router = makeRouter();
  const demoted = new Set(['quick:model-cheap']);
  router.setCloudQualityCheck((job, model) => demoted.has(`${job}:${model}`));
  const roster = router._resolvePreset('smart-mix');
  assert.deepStrictEqual(roster.quick, ['cloud-mid', 'cloud-cheap', 'ollama-local'],
    'cheapest HEALTHY leads; demoted re-enters as tail before local');
  assert.deepStrictEqual(roster.synthesis, ['cloud-cheap', 'ollama-local'],
    'other jobs untouched — demotion is per-(job, model)');
});

test('synthesis sole-cheapest case: next-cheapest healthy leads, demoted tails, local still last', () => {
  const router = makeRouter();
  router.setCloudQualityCheck((job, model) => job === 'synthesis' && model === 'model-cheap');
  const roster = router._resolvePreset('smart-mix');
  assert.deepStrictEqual(roster.synthesis, ['cloud-mid', 'cloud-cheap', 'ollama-local']);
});

test('depth job: demoted mid-tier re-enters at the tail; healthy models keep cost order', () => {
  const router = makeRouter();
  router.setCloudQualityCheck((job, model) => job === 'writing' && model === 'model-mid');
  const roster = router._resolvePreset('smart-mix');
  assert.deepStrictEqual(roster.writing, ['cloud-heavy', 'cloud-cheap', 'cloud-mid', 'ollama-local']);
});

test('never-go-dark: with every eligible model demoted the chain is exactly the un-vetoed one', () => {
  const router = makeRouter();
  router.setCloudQualityCheck((job) => job === 'writing');
  const roster = router._resolvePreset('smart-mix');
  assert.deepStrictEqual(roster.writing, ['cloud-heavy', 'cloud-mid', 'cloud-cheap', 'ollama-local']);
});

test('a demotion the depth policy never selected anyway is a no-op (no score-sorting)', () => {
  const router = makeRouter();
  router.setCloudQualityCheck((job, model) => job === 'synthesis' && model === 'model-heavy');
  const roster = router._resolvePreset('smart-mix');
  assert.deepStrictEqual(roster.synthesis, ['cloud-cheap', 'ollama-local'],
    'heavy was not in the cheapest chain; vetoing it changes nothing');
});

test('a throwing quality check fails open: chains keep pure cost order', () => {
  const router = makeRouter();
  router.setCloudQualityCheck(() => { throw new Error('scorecard fault'); });
  const roster = router._resolvePreset('smart-mix');
  assert.deepStrictEqual(roster.quick, ['cloud-cheap', 'ollama-local']);
});

test('cloud-fast (excludeHeavy) chains inherit the veto through the same generating function', () => {
  const router = makeRouter();
  router.setCloudQualityCheck((job, model) => model === 'model-cheap');
  const roster = router._buildCloudFastRoster();
  // Un-vetoed flat chain is [cheap, mid]; with cheap demoted, mid leads and
  // cheap tails.
  assert.deepStrictEqual(roster.quick, ['cloud-mid', 'cloud-cheap', 'ollama-local']);
});

// ============================================================
// Router: refreshCloudOrdering, custom-roster exemption, stats
// ============================================================

test('refreshCloudOrdering rebuilds an active preset roster in place', () => {
  const router = makeRouter();
  const demoted = new Set();
  router.setCloudQualityCheck((job, model) => demoted.has(`${job}:${model}`));
  router.setPreset('smart-mix');
  assert.strictEqual(router.getRoster().quick[0], 'cloud-cheap');

  demoted.add('quick:model-cheap');
  assert.strictEqual(router.refreshCloudOrdering(), true);
  assert.deepStrictEqual(router.getRoster().quick, ['cloud-mid', 'cloud-cheap', 'ollama-local']);
  assert.strictEqual(router.getPreset(), 'smart-mix', 'refresh does not change the active preset');
});

test('refreshCloudOrdering skips the rebuild when no cloud provider serves the model', () => {
  const router = makeRouter();
  router.setCloudQualityCheck(() => false);
  router.setPreset('smart-mix');
  assert.strictEqual(router.refreshCloudOrdering('quick', 'qwen3:8b'), false,
    'a local-only model name cannot move any cloud chain');
  assert.strictEqual(router.refreshCloudOrdering('quick', 'model-nobody-serves'), false);
  assert.strictEqual(router.refreshCloudOrdering('quick', 'model-cheap'), true, 'cloud-served model rebuilds');
  assert.strictEqual(router.refreshCloudOrdering(), true, 'no model given (boot refresh) always rebuilds');
});

test('custom roster (setRoster) is exempt: deployer-explicit chains outrank the mechanism', () => {
  const router = makeRouter();
  const demoted = new Set();
  router.setCloudQualityCheck((job, model) => demoted.has(`${job}:${model}`));
  router.setRoster({ writing: ['cloud-cheap', 'cloud-heavy'] });

  demoted.add('writing:model-cheap');
  assert.strictEqual(router.refreshCloudOrdering(), false, 'no preset active — nothing rebuilt');
  assert.deepStrictEqual(router.getRoster().writing, ['cloud-cheap', 'cloud-heavy'],
    'deployer-explicit chain untouched by a demotion');
});

test('getStats surfaces which providers the veto is currently sinking, per job', () => {
  const router = makeRouter();
  router.setCloudQualityCheck((job, model) => job === 'writing' && model === 'model-mid');
  const stats = router.getStats();
  assert.deepStrictEqual(stats.cloudDemotions.writing, [{ id: 'cloud-mid', model: 'model-mid' }]);
  assert.strictEqual(stats.cloudDemotions.quick, undefined, 'healthy jobs are absent, not empty');
});

// ============================================================
// The bridge: scorecard evidence moves live chains, both directions
// ============================================================

test('end-to-end: judged evidence demotes, the roster rebuilds; recovery reinstates it', () => {
  const router = makeRouter();
  const sc = makeScorecard();
  // The webhook-server wiring, verbatim.
  router.setCloudQualityCheck((job, model) => sc.isDemoted(job, model));
  sc.onCloudDemotionChange = (job, model) => router.refreshCloudOrdering(job, model);
  router.setPreset('smart-mix');
  assert.strictEqual(router.getRoster().quick[0], 'cloud-cheap');

  fails(sc, 'quick', 'model-cheap', 'DE', 12);
  assert.deepStrictEqual(router.getRoster().quick, ['cloud-mid', 'cloud-cheap', 'ollama-local'],
    'the demotion rebuilt the live roster without any manual refresh');

  passes(sc, 'quick', 'model-cheap', 'DE', 17); // 17/29 ≈ 0.586 — reinstated
  assert.deepStrictEqual(router.getRoster().quick, ['cloud-cheap', 'ollama-local'],
    'reinstatement restored pure cost order');
});

// ============================================================
// LocalJudge: re-audition through the cold-cell chokepoint
// ============================================================

const JUDGE = { name: 'judge:8b', paramSize: 8, digest: 'sha256:j1' };
const WRITING_FIXTURE = { jobs: { writing: { EN: ['write EN'], DE: ['schreibe DE'], PT: ['escreve PT'] } } };

function makeCloudJudge({ scorecard, budgetEnforcer, cloudCand }) {
  return new LocalJudge({
    judgeQueue: new JudgeQueue({ dataDir: null, logger: silentLogger }),
    scorecard,
    selectJudgeModel: () => JUDGE,
    localChat: async () => ({ content: '{"pass": true}' }),
    localCandidates: () => [],
    cloudCandidates: () => [cloudCand.cand],
    resolveTrust: () => 'cloud-ok',
    budgetEnforcer,
    fixture: WRITING_FIXTURE,
    maxCloudProbesPerCycle: 10,
    maxLocalProbesPerCycle: 0,
    logger: silentLogger,
  });
}

function makeCloudCand(model) {
  const calls = { chat: 0 };
  return {
    calls,
    cand: {
      id: 'cloud-x',
      model,
      chat: async () => {
        calls.chat++;
        return { content: 'cloud text', _cost: 0.004, _tokens: 50 };
      },
    },
  };
}

asyncTest('a recheck-due demoted pairing is probe-eligible despite warmth — once per language per period', async () => {
  const scorecard = makeScorecard();
  // Warm AND demoted in every fixture language (mass 12 ≥ coldMassFloor 5).
  for (const lang of ['EN', 'DE', 'PT']) fails(scorecard, 'writing', 'claude-x', lang, 12);
  scorecard._state.cloudDemotions.writing['claude-x'].recheckAt = new Date(Date.now() - 1000).toISOString();

  const cloudCand = makeCloudCand('claude-x');
  let gateChecks = 0;
  const budgetEnforcer = {
    canSpendProactive: () => { gateChecks++; return { allowed: true }; },
    recordProactiveSpend: () => {},
  };
  const judge = makeCloudJudge({ scorecard, budgetEnforcer, cloudCand });

  const out = await judge.runIdleCycle();
  assert.strictEqual(cloudCand.calls.chat, 3, 'one re-audition generation per fixture language');
  assert.strictEqual(out.cloudProbes, 3);
  assert.strictEqual(gateChecks, 3, 'every re-audition generation passed the proactive gate first');

  // The verdicts consumed each language's recheck slot; the next cycle is
  // back to warm-cell silence until the cool-off elapses again.
  const again = await judge.runIdleCycle();
  assert.strictEqual(cloudCand.calls.chat, 3, 'no further probes this period');
  assert.strictEqual(again.cloudProbes, 0);
  assert.strictEqual(scorecard.isDemoted('writing', 'claude-x'), true, 'three failing-history cells stay demoted');
});

asyncTest('recheck probes stay inside the proactive budget gate (gate closed → no generation)', async () => {
  const scorecard = makeScorecard();
  fails(scorecard, 'writing', 'claude-x', 'EN', 12);
  scorecard._state.cloudDemotions.writing['claude-x'].recheckAt = new Date(Date.now() - 1000).toISOString();

  const cloudCand = makeCloudCand('claude-x');
  const budgetEnforcer = {
    canSpendProactive: () => ({ allowed: false, reason: 'proactive_budget_exceeded' }),
    recordProactiveSpend: () => {},
  };
  const judge = makeCloudJudge({ scorecard, budgetEnforcer, cloudCand });
  const out = await judge.runIdleCycle();
  assert.strictEqual(cloudCand.calls.chat, 0, 'the budget gate outranks the recheck');
  assert.strictEqual(out.cloudProbes, 0);
});

asyncTest('a scorecard without (or with a throwing) isRecheckDue keeps today\'s warm-skip, no crash', async () => {
  const scorecard = makeScorecard();
  for (const lang of ['EN', 'DE', 'PT']) {
    for (let i = 0; i < 5; i++) scorecard.recordSample('writing', 'claude-x', lang, true, { synthetic: true });
  }
  scorecard.isRecheckDue = () => { throw new Error('older scorecard'); };

  const cloudCand = makeCloudCand('claude-x');
  const budgetEnforcer = { canSpendProactive: () => ({ allowed: true }), recordProactiveSpend: () => {} };
  const judge = makeCloudJudge({ scorecard, budgetEnforcer, cloudCand });
  const out = await judge.runIdleCycle();
  assert.strictEqual(cloudCand.calls.chat, 0, 'warm cells attract no probe when recheck cannot be established');
  assert.strictEqual(out.cloudProbes, 0);
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
