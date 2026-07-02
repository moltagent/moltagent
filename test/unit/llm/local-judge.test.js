/**
 * LocalJudge Unit Tests
 *
 * The heartbeat-idle grader (Session 4): organic samples graded free with
 * no new generation, gap-weighted verdicts, judge-then-delete, synthetic
 * probes bounded by cell warmth / trust / the proactive spend guard, and
 * per-language scoring. Uses a REAL ModelScorecard (in-memory) so what the
 * verdicts do to the store is asserted, not mocked.
 *
 * Run: node test/unit/llm/local-judge.test.js
 */

'use strict';

const assert = require('assert');
const { asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

const LocalJudge = require('../../../src/lib/llm/local-judge');
const JudgeQueue = require('../../../src/lib/llm/judge-queue');
const ModelScorecard = require('../../../src/lib/llm/model-scorecard');

const silentLogger = { warn: () => {}, log: () => {}, info: () => {} };

const JUDGE = { name: 'judge:8b', paramSize: 8, digest: 'sha256:j1' };

const FIXTURE = {
  jobs: {
    writing: { EN: ['write EN'], DE: ['schreibe DE'], PT: ['escreve PT'] },
    thinking: { EN: ['reason EN'], DE: ['denke DE'], PT: ['raciocina PT'] },
  },
};

function makeScorecard() {
  return new ModelScorecard({ dataDir: null, logger: silentLogger });
}

function makeQueue() {
  return new JudgeQueue({ dataDir: null, logger: silentLogger });
}

/**
 * A localChat mock that tells judge verdict calls (they carry the judge
 * model + format json) apart from probe generations, and counts both.
 */
function makeLocalChat({ verdict = '{"pass": true}', generation = 'generated text' } = {}) {
  const holder = { judge: 0, generate: 0, fn: null };
  holder.fn = async (params) => {
    if (params.model === JUDGE.name) {
      holder.judge++;
      return { content: verdict };
    }
    holder.generate++;
    return { content: generation };
  };
  return holder;
}

function makeJudge(overrides = {}) {
  const scorecard = overrides.scorecard || makeScorecard();
  const judgeQueue = overrides.judgeQueue || makeQueue();
  const chat = overrides.chat || makeLocalChat();
  const judge = new LocalJudge({
    judgeQueue,
    scorecard,
    selectJudgeModel: () => JUDGE,
    getModelInfo: (name) => overrides.modelInfo?.[name] || null,
    localChat: chat.fn,
    localCandidates: () => [],
    cloudCandidates: () => [],
    resolveTrust: () => 'local-only',
    fixture: null,
    logger: silentLogger,
    ...overrides.opts,
  });
  return { judge, scorecard, judgeQueue, chat };
}

function entry(scorecard, job, model, lang) {
  return scorecard.getPairings(job)?.[model]?.[lang] || null;
}

// ============================================================
// Organic grading: free, attributed, judge-then-delete
// ============================================================

asyncTest('an organic sample is graded with NO new generation and leaves the queue', async () => {
  const { judge, scorecard, judgeQueue, chat } = makeJudge();
  judgeQueue.enqueue({
    job: 'writing', model: 'qwen3:8b', isLocal: true, language: 'EN',
    prompt: 'write a note', response: 'a fine note',
  });
  const out = await judge.runIdleCycle();
  assert.strictEqual(out.graded, 1);
  assert.strictEqual(chat.judge, 1, 'exactly one judge verdict call');
  assert.strictEqual(chat.generate, 0, 'organic grading must not generate anything');
  assert.strictEqual(judgeQueue.samples().length, 0, 'judge-then-delete');
  const e = entry(scorecard, 'writing', 'qwen3:8b', 'EN');
  assert.ok(e && e.a > 0, 'pass verdict lands as a success sample');
});

asyncTest('a DE sample is judged into the DE score, not EN', async () => {
  const { judge, scorecard, judgeQueue } = makeJudge();
  judgeQueue.enqueue({
    job: 'writing', model: 'qwen3:8b', isLocal: true, language: 'DE',
    prompt: 'schreibe eine Notiz', response: 'eine feine Notiz',
  });
  await judge.runIdleCycle();
  assert.ok(entry(scorecard, 'writing', 'qwen3:8b', 'DE'), 'DE cell exists');
  assert.strictEqual(entry(scorecard, 'writing', 'qwen3:8b', 'EN'), null, 'EN cell untouched');
});

asyncTest('a fail verdict lands as a failure sample', async () => {
  const chat = makeLocalChat({ verdict: '{"pass": false}' });
  const { judge, scorecard, judgeQueue } = makeJudge({ chat });
  judgeQueue.enqueue({
    job: 'thinking', model: 'qwen3:8b', isLocal: true, language: 'EN',
    prompt: 'reason', response: 'circular nonsense',
  });
  await judge.runIdleCycle();
  const e = entry(scorecard, 'thinking', 'qwen3:8b', 'EN');
  assert.ok(e.b > 0 && e.a === 0, 'fail verdict adds to b only');
});

asyncTest('an unparseable verdict retries, then drops the sample at maxAttempts', async () => {
  const chat = makeLocalChat({ verdict: 'this is not json at all' });
  const { judge, judgeQueue, scorecard } = makeJudge({ chat });
  judgeQueue.enqueue({
    job: 'writing', model: 'qwen3:8b', isLocal: true, language: 'EN',
    prompt: 'p', response: 'r',
  });
  await judge.runIdleCycle();
  assert.strictEqual(judgeQueue.samples().length, 1, 'sample survives first failed attempt');
  await judge.runIdleCycle();
  const out3 = await judge.runIdleCycle();
  assert.strictEqual(out3.dropped, 1, 'dropped at third failed attempt');
  assert.strictEqual(judgeQueue.samples().length, 0);
  assert.strictEqual(entry(scorecard, 'writing', 'qwen3:8b', 'EN'), null, 'no verdict was invented');
});

asyncTest('the per-cycle verdict quota bounds one idle pulse', async () => {
  const { judge, judgeQueue, chat } = makeJudge({ opts: { maxVerdictsPerCycle: 2 } });
  for (let i = 0; i < 5; i++) {
    judgeQueue.enqueue({
      job: 'writing', model: `m${i}`, isLocal: true, language: 'EN',
      prompt: 'p', response: `r${i}`,
    });
  }
  const out = await judge.runIdleCycle();
  assert.strictEqual(out.graded, 2);
  assert.strictEqual(chat.judge, 2);
  assert.strictEqual(judgeQueue.samples().length, 3);
});

asyncTest('no judge model on the box → cycle skips without grading', async () => {
  const { judge, judgeQueue, chat } = makeJudge();
  judge.selectJudgeModel = () => null;
  judgeQueue.enqueue({
    job: 'writing', model: 'qwen3:8b', isLocal: true, language: 'EN',
    prompt: 'p', response: 'r',
  });
  const out = await judge.runIdleCycle();
  assert.strictEqual(out.skipped, 'no-judge-model');
  assert.strictEqual(chat.judge, 0);
  assert.strictEqual(judgeQueue.samples().length, 1, 'sample retained for a later cycle');
});

// ============================================================
// Gap weight: verdict confidence scales with judge-vs-judged gap
// ============================================================

asyncTest('a large judge-vs-judged gap lowers the verdict weight to the floor', async () => {
  const { judge, scorecard, judgeQueue } = makeJudge({
    modelInfo: { 'big:70b': { paramSize: 70 } },
  });
  judgeQueue.enqueue({
    job: 'writing', model: 'big:70b', isLocal: true, language: 'EN',
    prompt: 'p', response: 'r',
  });
  await judge.runIdleCycle();
  const e = entry(scorecard, 'writing', 'big:70b', 'EN');
  // 8/70 ≈ 0.11 clamps to the 0.25 floor.
  assert.ok(Math.abs(e.a - 0.25) < 1e-9, `gap-floored weight (got ${e.a})`);
});

asyncTest('judging a peer or smaller local model carries full weight', async () => {
  const { judge, scorecard, judgeQueue } = makeJudge({
    modelInfo: { 'small:3b': { paramSize: 3 } },
  });
  judgeQueue.enqueue({
    job: 'writing', model: 'small:3b', isLocal: true, language: 'EN',
    prompt: 'p', response: 'r',
  });
  await judge.runIdleCycle();
  const e = entry(scorecard, 'writing', 'small:3b', 'EN');
  assert.strictEqual(e.a, 1, 'judge above judged caps at weight 1');
});

asyncTest('a cloud-judged sample gets the fixed minimum-tier weight', async () => {
  const { judge, scorecard, judgeQueue } = makeJudge();
  judgeQueue.enqueue({
    job: 'writing', model: 'claude-x', isLocal: false, language: 'EN',
    prompt: 'p', response: 'r',
  });
  await judge.runIdleCycle();
  const e = entry(scorecard, 'writing', 'claude-x', 'EN');
  assert.ok(Math.abs(e.a - 0.3) < 1e-9, `cloud judged weight 0.3 (got ${e.a})`);
});

asyncTest('unknown local size sits at the floor (unknown gap is not parity)', async () => {
  const { judge, scorecard, judgeQueue } = makeJudge();
  judgeQueue.enqueue({
    job: 'writing', model: 'mystery:latest', isLocal: true, language: 'EN',
    prompt: 'p', response: 'r',
  });
  await judge.runIdleCycle();
  const e = entry(scorecard, 'writing', 'mystery:latest', 'EN');
  assert.ok(Math.abs(e.a - 0.25) < 1e-9);
});

// ============================================================
// Synthetic local probes: free, cold-cells only, no UCB optimism
// ============================================================

asyncTest('a cold local cell is probed (generate + judge) and scored synthetic', async () => {
  const chat = makeLocalChat();
  const { judge, scorecard } = makeJudge({
    chat,
    opts: {
      fixture: FIXTURE,
      localCandidates: () => ['qwen3:8b'],
      maxLocalProbesPerCycle: 1,
    },
    modelInfo: { 'qwen3:8b': { paramSize: 8, digest: 'sha256:q1' } },
  });
  const out = await judge.runIdleCycle();
  assert.strictEqual(out.localProbes, 1);
  assert.strictEqual(chat.generate, 1, 'one probe generation');
  assert.strictEqual(chat.judge, 1, 'one verdict for it');
  const jobs = ['writing', 'thinking'];
  const probed = jobs.map(j => scorecard.getPairings(j)).find(p => p['qwen3:8b']);
  assert.ok(probed, 'probe verdict landed');
  const langs = Object.values(probed['qwen3:8b']);
  assert.strictEqual(langs.length, 1);
  assert.strictEqual(langs[0].prod, 0, 'synthetic sample carries no production evidence');
  assert.ok(langs[0].a > 0, 'but it does carry evidential mass');
});

asyncTest('warm cells are not probed', async () => {
  const chat = makeLocalChat();
  const scorecard = makeScorecard();
  // Pre-warm every (job, lang) cell past the cold floor.
  for (const job of ['writing', 'thinking']) {
    for (const lang of ['EN', 'DE', 'PT']) {
      for (let i = 0; i < 5; i++) scorecard.recordSample(job, 'qwen3:8b', lang, true);
    }
  }
  const { judge } = makeJudge({
    chat,
    scorecard,
    opts: { fixture: FIXTURE, localCandidates: () => ['qwen3:8b'], maxLocalProbesPerCycle: 10 },
    modelInfo: { 'qwen3:8b': { paramSize: 8, digest: 'sha256:q1' } },
  });
  const out = await judge.runIdleCycle();
  assert.strictEqual(out.localProbes, 0);
  assert.strictEqual(chat.generate, 0, 'nothing cold, nothing generated');
});

asyncTest('a model-digest change triggers a light re-check of a warm cell', async () => {
  const chat = makeLocalChat();
  const scorecard = makeScorecard();
  for (const job of ['writing', 'thinking']) {
    for (const lang of ['EN', 'DE', 'PT']) {
      for (let i = 0; i < 5; i++) scorecard.recordSample(job, 'qwen3:8b', lang, true);
    }
  }
  const judgeQueue = makeQueue();
  judgeQueue.setMeta('digests', { 'qwen3:8b': 'sha256:OLD' });
  const { judge } = makeJudge({
    chat,
    scorecard,
    judgeQueue,
    opts: { fixture: FIXTURE, localCandidates: () => ['qwen3:8b'], maxLocalProbesPerCycle: 1 },
    modelInfo: { 'qwen3:8b': { paramSize: 8, digest: 'sha256:NEW' } },
  });
  const out = await judge.runIdleCycle();
  assert.strictEqual(out.localProbes, 1, 'digest change re-checks despite warmth');
  assert.strictEqual(judgeQueue.getMeta('digests')['qwen3:8b'], 'sha256:NEW', 're-pinned after the re-check ran');
});

// ============================================================
// Synthetic cloud probes: trust-gated, budget-gated, halt at the cap
// ============================================================

function makeCloudCand(model = 'claude-x') {
  const calls = { chat: 0 };
  return {
    calls,
    cand: {
      id: 'anthropic-claude',
      model,
      chat: async () => {
        calls.chat++;
        return { content: 'cloud text', _cost: 0.004, _tokens: 50, _inputTokens: 20, _outputTokens: 30 };
      },
    },
  };
}

asyncTest('cloud probes stop the moment the proactive budget says no', async () => {
  const { cand, calls } = makeCloudCand();
  const gateResults = [{ allowed: true }, { allowed: false, reason: 'proactive_budget_exceeded' }];
  let spendRecorded = 0;
  const budgetEnforcer = {
    canSpendProactive: () => gateResults.shift() || { allowed: false },
    recordProactiveSpend: (cost) => { spendRecorded += cost; },
  };
  const { judge } = makeJudge({
    opts: {
      fixture: FIXTURE,
      cloudCandidates: () => [cand],
      resolveTrust: () => 'cloud-ok',
      budgetEnforcer,
      maxCloudProbesPerCycle: 10,
      maxLocalProbesPerCycle: 0,
    },
  });
  const out = await judge.runIdleCycle();
  assert.strictEqual(calls.chat, 1, 'one generation before the gate closed');
  assert.strictEqual(out.cloudProbes, 1);
  assert.ok(Math.abs(spendRecorded - 0.004) < 1e-9, 'actual cost recorded against the pool');
});

asyncTest('local-only trust generates no cloud probes at all', async () => {
  const { cand, calls } = makeCloudCand();
  const budgetEnforcer = { canSpendProactive: () => ({ allowed: true }), recordProactiveSpend: () => {} };
  const { judge } = makeJudge({
    opts: {
      fixture: FIXTURE,
      cloudCandidates: () => [cand],
      resolveTrust: () => 'local-only',
      budgetEnforcer,
      maxCloudProbesPerCycle: 10,
      maxLocalProbesPerCycle: 0,
    },
  });
  const out = await judge.runIdleCycle();
  assert.strictEqual(calls.chat, 0);
  assert.strictEqual(out.cloudProbes, 0);
});

asyncTest('no budget enforcer wired → cloud probes are fail-closed', async () => {
  const { cand, calls } = makeCloudCand();
  const { judge } = makeJudge({
    opts: {
      fixture: FIXTURE,
      cloudCandidates: () => [cand],
      resolveTrust: () => 'cloud-ok',
      budgetEnforcer: null,
      maxCloudProbesPerCycle: 10,
      maxLocalProbesPerCycle: 0,
    },
  });
  const out = await judge.runIdleCycle();
  assert.strictEqual(calls.chat, 0, 'metered spend without a guard must not happen');
  assert.strictEqual(out.cloudProbes, 0);
});

asyncTest('a warm cloud cell attracts no probe (spend is structurally bounded)', async () => {
  const { cand, calls } = makeCloudCand();
  const scorecard = makeScorecard();
  for (const job of ['writing', 'thinking']) {
    for (const lang of ['EN', 'DE', 'PT']) {
      for (let i = 0; i < 5; i++) {
        scorecard.recordSample(job, 'claude-x', lang, true, { synthetic: true });
      }
    }
  }
  const budgetEnforcer = { canSpendProactive: () => ({ allowed: true }), recordProactiveSpend: () => {} };
  const { judge } = makeJudge({
    scorecard,
    opts: {
      fixture: FIXTURE,
      cloudCandidates: () => [cand],
      resolveTrust: () => 'cloud-ok',
      budgetEnforcer,
      maxCloudProbesPerCycle: 10,
      maxLocalProbesPerCycle: 0,
    },
  });
  const out = await judge.runIdleCycle();
  assert.strictEqual(calls.chat, 0, 'warm cells attract no synthetic spend');
  assert.strictEqual(out.cloudProbes, 0);
});

asyncTest('cloud probe verdicts land with the cloud weight and no production evidence', async () => {
  const { cand } = makeCloudCand();
  const budgetEnforcer = { canSpendProactive: () => ({ allowed: true }), recordProactiveSpend: () => {} };
  const { judge, scorecard } = makeJudge({
    opts: {
      fixture: FIXTURE,
      cloudCandidates: () => [cand],
      resolveTrust: () => 'cloud-ok',
      budgetEnforcer,
      maxCloudProbesPerCycle: 1,
      maxLocalProbesPerCycle: 0,
    },
  });
  await judge.runIdleCycle();
  const probed = ['writing', 'thinking'].map(j => scorecard.getPairings(j)).find(p => p['claude-x']);
  assert.ok(probed, 'cloud verdict landed');
  const cell = Object.values(probed['claude-x'])[0];
  assert.ok(Math.abs(cell.a - 0.3) < 1e-9, 'cloud judged weight');
  assert.strictEqual(cell.prod, 0, 'synthetic — no UCB optimism');
});

// ============================================================
// Organic-first ordering
// ============================================================

asyncTest('organic samples exhaust the cycle before any synthetic probe runs', async () => {
  const chat = makeLocalChat();
  const { judge, judgeQueue } = makeJudge({
    chat,
    opts: {
      fixture: FIXTURE,
      localCandidates: () => ['qwen3:8b'],
      maxVerdictsPerCycle: 2,
      maxLocalProbesPerCycle: 5,
    },
    modelInfo: { 'qwen3:8b': { paramSize: 8, digest: 'sha256:q1' } },
  });
  for (let i = 0; i < 3; i++) {
    judgeQueue.enqueue({
      job: 'writing', model: `m${i}`, isLocal: true, language: 'EN',
      prompt: 'p', response: `r${i}`,
    });
  }
  const out = await judge.runIdleCycle();
  assert.strictEqual(out.graded, 2, 'quota went to organic samples');
  assert.strictEqual(out.localProbes, 0, 'no probes while organic work fills the cycle');
  assert.strictEqual(chat.generate, 0);
});

setTimeout(() => {
  summary();
  exitWithCode();
}, 500);
