/**
 * SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2026 Moltagent contributors
 *
 * LocalJudge — Heartbeat-idle grader for the jobs with no mechanical signal
 * (Session 4 of adaptive model selection: the judged half of Layer 2).
 *
 * Problem:
 *   `writing` and `thinking` quality cannot be scored by JSON-shape checks,
 *   so the maturation loop is blind to them. A grader is needed, and the
 *   sovereign shape falls out of the last-local rule: every deployment keeps
 *   a local model in both trust modes, so a zero-cost judge is always
 *   present. What must NOT happen: judging on the request path (a user
 *   waiting on a grade), a cloud judge (grades leave the box), unbounded
 *   cloud probe spend, or a judge selected by the very loop it grades.
 *
 * Pattern:
 *   The judge model is pinned from ModelScout's sensed pool (largest
 *   dedicated text generator clearing the context floor) — a pure
 *   Declared+Described read with no scorecard input, so the gradee can never
 *   pick its grader. Grading runs ONLY inside the heartbeat's
 *   outside-active-hours window. Organic samples (real responses the user
 *   already paid for) are the primary source and are free to grade;
 *   synthetic probe GENERATIONS exist only to warm cold pairings — local
 *   ones are free and may be lavish, cloud ones are metered, gated per
 *   generation by BudgetEnforcer's proactive pool, and stop the moment a
 *   cell is warm. Verdicts enter ModelScorecard as weighted samples: the
 *   weight scales with the judge-versus-judged capability gap (a mid-size
 *   local model grading frontier prose is useful-but-noisy, never ground
 *   truth), and synthetic verdicts carry no UCB optimism (same discipline
 *   as the golden-set seed). Confidence caching falls out of the store
 *   itself: a cell's accumulated mass IS its confidence — low-mass cells
 *   are judged first, warm cells stop attracting probes, and a model-digest
 *   change marks its cells for one light re-check.
 *
 * Data Flow:
 *   HeartbeatManager.pulse() [outside active hours ONLY]
 *     → runIdleCycle()
 *       → judgeQueue.samples() → _judgeSample() → scorecard.recordSample()
 *         → judgeQueue.remove(id)                      (judge-then-delete)
 *       → cold cells → localChat()/cloud chat → _judgeSample()
 *         → scorecard.recordSample({synthetic: true})
 *
 * Dependency Map:
 *   src/lib/llm/local-judge.js
 *     ← (no internal imports — callers inject every capability, so the
 *        module is standalone and testable in isolation)
 *
 * @module llm/local-judge
 * @license AGPL-3.0
 */

'use strict';

const fs = require('fs');

// Verdict weight for cloud-judged samples. The cloud descriptor declares no
// parameter size, and a local judge grading a frontier model is judging
// above its weight by construction — a fixed minimum-tier weight states
// that honestly without guessing sizes from model names.
const DEFAULT_CLOUD_JUDGED_WEIGHT = 0.3;

// Gap-weight clamp floor: even a small judge grading a much larger local
// model contributes a quarter-weight sample (useful-but-noisy), and an
// unknown parameter size is treated at the floor (unknown gap ≠ no gap).
const DEFAULT_GAP_FLOOR = 0.25;

// A (job, model, language) cell with less evidential mass than this is
// "cold" and eligible for synthetic probes. Synthetic verdicts add mass, so
// probing a cell warms it and probing terminates — for cloud pairs this is
// what bounds total probe spend structurally, on top of the budget gate.
const DEFAULT_COLD_MASS_FLOOR = 5;

// Per-idle-pulse quotas. The pulse fires every few minutes all night, so
// small per-pulse numbers still add up to heavy coverage at install while
// keeping any single pulse short.
const DEFAULT_MAX_VERDICTS_PER_CYCLE = 5;
const DEFAULT_MAX_LOCAL_PROBES_PER_CYCLE = 2;
const DEFAULT_MAX_CLOUD_PROBES_PER_CYCLE = 1;

// Conservative per-generation estimate for the proactive-pool gate; the
// recorded spend uses the provider's actual cost when present.
const DEFAULT_CLOUD_PROBE_COST_ESTIMATE = 0.01;

// Idle-window calls tolerate a cold Ollama load (#124: >60s), so the
// timeout is generous; a load that still times out skips the pulse, it
// never fails a sample.
const DEFAULT_JUDGE_TIMEOUT_MS = 180000;

// Per-job rubric the judge grades against. Prompt text, not language
// parsing: the judged sample may be in any language and the rubric holds
// unchanged (MULTILINGUAL BY DEFAULT applies to the measurement).
const JOB_RUBRICS = {
  writing: 'Judge WRITING quality: the response fulfils the task in clear, well-structured, natural prose. '
    + 'FAIL it if it is off-task, cut off mid-thought, incoherent, ignores the requested form or length, '
    + 'or leaks machine artifacts (raw JSON, tool-call envelopes, template placeholders) into the prose.',
  thinking: 'Judge REASONING quality: the response reasons soundly toward an answer that follows from its own argument. '
    + 'FAIL it if it contradicts itself, makes unsupported leaps, answers a different question than asked, '
    + 'dodges the question, or its conclusion does not follow from the reasoning it gives.',
};

class LocalJudge {
  /**
   * Every capability is injected so the judge stays standalone; each one is
   * expected to be a lazy thunk over live components (boot order safe).
   *
   * @param {Object} opts
   * @param {Object} opts.judgeQueue - JudgeQueue (organic samples + digest meta).
   * @param {Object} opts.scorecard - ModelScorecard (verdicts land here).
   * @param {Function} opts.selectJudgeModel - () => {name, paramSize, digest}|null.
   *   ModelScout's pin — Declared+Described only, never the resolver, never
   *   the scorecard (the gradee must not pick its grader).
   * @param {Function} [opts.getModelInfo] - (name) => {paramSize, digest}|null
   *   for local gap weights and digest re-checks.
   * @param {Function} [opts.localChat] - async ({model, system, messages,
   *   timeout, format, options}) => {content}. Judge verdicts and free local
   *   probe generations. Local calls only (trust-tightening by construction).
   * @param {Function} [opts.localCandidates] - (job) => string[] of local
   *   model names eligible for the job (ModelScout roster chain).
   * @param {Function} [opts.cloudCandidates] - (job) => Array<{id, model,
   *   chat}> of cloud players in the job's chain, for synthetic probes.
   * @param {Object} [opts.budgetEnforcer] - canSpendProactive/
   *   recordProactiveSpend. Absent ⇒ NO cloud probes (a metered spend
   *   without a guard is fail-closed, not fail-open).
   * @param {Object} [opts.costTracker] - Cloud probe generations are
   *   recorded here so probe spend keeps cost custody.
   * @param {Function} [opts.resolveTrust] - (job) => 'local-only'|'cloud-ok'.
   *   Absent ⇒ treated as local-only (never widens trust).
   * @param {Object} [opts.fixture] - Probe prompts: {jobs: {writing: {EN:
   *   [...], DE: [...], PT: [...]}, thinking: {...}}}. Prompts only — the
   *   judge supplies the score, so no labels exist.
   * @param {string[]} [opts.judgedJobs]
   * @param {number} [opts.cloudJudgedWeight]
   * @param {number} [opts.gapFloor]
   * @param {number} [opts.coldMassFloor]
   * @param {number} [opts.maxVerdictsPerCycle]
   * @param {number} [opts.maxLocalProbesPerCycle]
   * @param {number} [opts.maxCloudProbesPerCycle]
   * @param {number} [opts.cloudProbeCostEstimate]
   * @param {number} [opts.judgeTimeoutMs]
   * @param {Object} [opts.logger=console]
   */
  constructor({
    judgeQueue,
    scorecard,
    selectJudgeModel,
    getModelInfo,
    localChat,
    localCandidates,
    cloudCandidates,
    budgetEnforcer,
    costTracker,
    resolveTrust,
    fixture,
    judgedJobs = Object.keys(JOB_RUBRICS),
    cloudJudgedWeight = DEFAULT_CLOUD_JUDGED_WEIGHT,
    gapFloor = DEFAULT_GAP_FLOOR,
    coldMassFloor = DEFAULT_COLD_MASS_FLOOR,
    maxVerdictsPerCycle = DEFAULT_MAX_VERDICTS_PER_CYCLE,
    maxLocalProbesPerCycle = DEFAULT_MAX_LOCAL_PROBES_PER_CYCLE,
    maxCloudProbesPerCycle = DEFAULT_MAX_CLOUD_PROBES_PER_CYCLE,
    cloudProbeCostEstimate = DEFAULT_CLOUD_PROBE_COST_ESTIMATE,
    judgeTimeoutMs = DEFAULT_JUDGE_TIMEOUT_MS,
    logger,
  } = {}) {
    this.judgeQueue = judgeQueue || null;
    this.scorecard = scorecard || null;
    this.selectJudgeModel = typeof selectJudgeModel === 'function' ? selectJudgeModel : (() => null);
    this.getModelInfo = typeof getModelInfo === 'function' ? getModelInfo : (() => null);
    this.localChat = typeof localChat === 'function' ? localChat : null;
    this.localCandidates = typeof localCandidates === 'function' ? localCandidates : (() => []);
    this.cloudCandidates = typeof cloudCandidates === 'function' ? cloudCandidates : (() => []);
    this.budgetEnforcer = budgetEnforcer || null;
    this.costTracker = costTracker || null;
    this.resolveTrust = typeof resolveTrust === 'function' ? resolveTrust : (() => 'local-only');
    this.fixture = fixture || null;
    this.judgedJobs = Array.isArray(judgedJobs) ? judgedJobs.filter(j => JOB_RUBRICS[j]) : Object.keys(JOB_RUBRICS);
    this.cloudJudgedWeight = Number.isFinite(cloudJudgedWeight) && cloudJudgedWeight > 0
      ? Math.min(1, cloudJudgedWeight) : DEFAULT_CLOUD_JUDGED_WEIGHT;
    this.gapFloor = Number.isFinite(gapFloor) && gapFloor > 0 ? Math.min(1, gapFloor) : DEFAULT_GAP_FLOOR;
    this.coldMassFloor = Number.isFinite(coldMassFloor) && coldMassFloor > 0 ? coldMassFloor : DEFAULT_COLD_MASS_FLOOR;
    this.maxVerdictsPerCycle = Number.isFinite(maxVerdictsPerCycle) && maxVerdictsPerCycle > 0
      ? maxVerdictsPerCycle : DEFAULT_MAX_VERDICTS_PER_CYCLE;
    this.maxLocalProbesPerCycle = Number.isFinite(maxLocalProbesPerCycle) && maxLocalProbesPerCycle >= 0
      ? maxLocalProbesPerCycle : DEFAULT_MAX_LOCAL_PROBES_PER_CYCLE;
    this.maxCloudProbesPerCycle = Number.isFinite(maxCloudProbesPerCycle) && maxCloudProbesPerCycle >= 0
      ? maxCloudProbesPerCycle : DEFAULT_MAX_CLOUD_PROBES_PER_CYCLE;
    this.cloudProbeCostEstimate = Number.isFinite(cloudProbeCostEstimate) && cloudProbeCostEstimate > 0
      ? cloudProbeCostEstimate : DEFAULT_CLOUD_PROBE_COST_ESTIMATE;
    this.judgeTimeoutMs = Number.isFinite(judgeTimeoutMs) && judgeTimeoutMs > 0
      ? judgeTimeoutMs : DEFAULT_JUDGE_TIMEOUT_MS;
    this.logger = logger || console;
  }

  /**
   * Load the probe-prompt fixture. Prompts only, per job per language.
   * @param {string} filePath
   * @returns {Object}
   */
  static loadFixture(filePath) {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !parsed.jobs || typeof parsed.jobs !== 'object') {
      throw new Error('judge fixture: missing jobs map');
    }
    return parsed;
  }

  /**
   * One idle-window grading cycle. Called ONLY from the heartbeat's
   * outside-active-hours branch — never while a user message is being
   * served. Organic samples first (free, real traffic), then synthetic
   * probes for cold cells with whatever quota remains. Never throws.
   *
   * @returns {Promise<{graded: number, dropped: number, localProbes: number,
   *   cloudProbes: number, skipped: string|null}>}
   */
  async runIdleCycle() {
    const out = { graded: 0, dropped: 0, localProbes: 0, cloudProbes: 0, skipped: null };
    try {
      if (!this.localChat || !this.scorecard) {
        out.skipped = 'not-wired';
        return out;
      }
      const judge = this.selectJudgeModel();
      if (!judge || !judge.name) {
        out.skipped = 'no-judge-model';
        return out;
      }

      const verdictsUsed = await this._gradeOrganic(judge, out);

      // Organic traffic is the primary source; synthetic probes only run
      // when the cycle still has grading capacity left over.
      if (verdictsUsed < this.maxVerdictsPerCycle) {
        await this._runLocalProbes(judge, out);
        await this._runCloudProbes(judge, out);
      }
    } catch (err) {
      this.logger.warn(`[LocalJudge] Idle cycle error: ${err.message}`);
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /**
   * @private Grade queued organic samples, lowest-confidence (least
   * evidential mass) cells first. Judge-then-delete: the sample leaves the
   * queue the moment its verdict lands in the scorecard.
   * @returns {Promise<number>} verdict calls used
   */
  async _gradeOrganic(judge, out) {
    if (!this.judgeQueue) return 0;
    const ranked = this.judgeQueue.samples()
      .map(s => ({ s, mass: this._cellMass(s.job, s.model, s.language) }))
      .sort((x, y) => x.mass - y.mass);

    let used = 0;
    for (const { s } of ranked) {
      if (used >= this.maxVerdictsPerCycle) break;
      used++;
      const verdict = await this._judgeSample(judge, s.job, s.prompt, s.response);
      if (verdict === null) {
        const { dropped } = this.judgeQueue.markAttempt(s.id);
        if (dropped) {
          out.dropped++;
          this.logger.warn(`[LocalJudge] Dropped sample ${s.id} (${s.job}/${s.model}/${s.language}): verdict unparseable after retries`);
        }
        continue;
      }
      const weight = this._gapWeight(judge, s.model, s.isLocal);
      this.scorecard.recordSample(s.job, s.model, s.language, verdict, { weight });
      this.judgeQueue.remove(s.id);
      out.graded++;
      this.logger.info(
        `[LocalJudge] Graded organic ${s.job}/${s.model}/${s.language}: ` +
        `${verdict ? 'pass' : 'fail'} (weight ${weight.toFixed(2)}, judge ${judge.name})`
      );
    }
    return used;
  }

  /**
   * @private Free synthetic probes for cold LOCAL cells, plus a light
   * re-check when an installed model's digest changed. Lavish is fine —
   * these cost idle GPU time only.
   */
  async _runLocalProbes(judge, out) {
    let budget = this.maxLocalProbesPerCycle;
    if (budget <= 0 || !this.fixture) return;
    const digests = { ...(this.judgeQueue?.getMeta('digests') || {}) };

    for (const job of this.judgedJobs) {
      for (const model of this.localCandidates(job) || []) {
        const info = this.getModelInfo(model);
        const digest = info?.digest || null;
        const digestChanged = !!(digest && digests[model] && digests[model] !== digest);
        let probed = false;

        for (const lang of this._fixtureLanguages(job)) {
          if (budget <= 0) break;
          if (!digestChanged && this._cellMass(job, model, lang) >= this.coldMassFloor) continue;
          const prompt = this._fixturePrompt(job, lang);
          if (!prompt) continue;
          budget--;
          try {
            const gen = await this.localChat({
              model,
              messages: [{ role: 'user', content: prompt }],
              timeout: this.judgeTimeoutMs,
            });
            if (!gen || typeof gen.content !== 'string' || !gen.content) continue;
            const verdict = await this._judgeSample(judge, job, prompt, gen.content);
            if (verdict === null) continue;
            const weight = this._gapWeight(judge, model, true);
            this.scorecard.recordSample(job, model, lang, verdict, { weight, synthetic: true });
            probed = true;
            out.localProbes++;
            this.logger.info(`[LocalJudge] Local probe ${job}/${model}/${lang}: ${verdict ? 'pass' : 'fail'} (weight ${weight.toFixed(2)})`);
          } catch (err) {
            this.logger.warn(`[LocalJudge] Local probe failed for ${job}/${model}/${lang}: ${err.message}`);
          }
        }

        // First sight pins the digest; a changed digest is re-pinned only
        // after its light re-check actually ran, so the re-check survives a
        // quota-exhausted cycle.
        if (digest && (!digests[model] || (digestChanged && probed))) {
          digests[model] = digest;
        }
      }
    }
    if (this.judgeQueue) this.judgeQueue.setMeta('digests', digests);
  }

  /**
   * @private Metered synthetic probes for cold CLOUD cells. Cloud-ok trust
   * only (a local-only box generates no cloud traffic, ever), each
   * generation gated by the proactive budget pool BEFORE it is made, spend
   * recorded to the pool and to CostTracker (cost custody). The guard halts
   * the whole cloud pass the moment the pool says no.
   */
  async _runCloudProbes(judge, out) {
    let budget = this.maxCloudProbesPerCycle;
    if (budget <= 0 || !this.fixture) return;
    if (!this.budgetEnforcer || typeof this.budgetEnforcer.canSpendProactive !== 'function') {
      // Metered spend without a guard is fail-closed.
      return;
    }

    for (const job of this.judgedJobs) {
      if (this.resolveTrust(job) !== 'cloud-ok') continue;
      for (const cand of this.cloudCandidates(job) || []) {
        if (!cand || !cand.model || typeof cand.chat !== 'function') continue;
        for (const lang of this._fixtureLanguages(job)) {
          if (budget <= 0) return;
          if (this._cellMass(job, cand.model, lang) >= this.coldMassFloor) continue;
          const gate = this.budgetEnforcer.canSpendProactive(this.cloudProbeCostEstimate);
          if (!gate || !gate.allowed) {
            this.logger.info('[LocalJudge] Proactive budget exhausted — synthetic cloud probes halted');
            return;
          }
          const prompt = this._fixturePrompt(job, lang);
          if (!prompt) continue;
          budget--;
          try {
            const gen = await cand.chat({
              messages: [{ role: 'user', content: prompt }],
              timeout: this.judgeTimeoutMs,
            });
            const cost = Number.isFinite(gen?._cost) ? gen._cost : this.cloudProbeCostEstimate;
            if (typeof this.budgetEnforcer.recordProactiveSpend === 'function') {
              this.budgetEnforcer.recordProactiveSpend(cost, gen?._tokens || 0);
            }
            if (this.costTracker && typeof this.costTracker.record === 'function') {
              this.costTracker.record({
                model: cand.model,
                provider: cand.id || null,
                job,
                trigger: 'heartbeat_judge',
                inputTokens: gen?._inputTokens || 0,
                outputTokens: gen?._outputTokens || 0,
                isLocal: false,
              });
            }
            if (!gen || typeof gen.content !== 'string' || !gen.content) continue;
            const verdict = await this._judgeSample(judge, job, prompt, gen.content);
            if (verdict === null) continue;
            this.scorecard.recordSample(job, cand.model, lang, verdict, {
              weight: this.cloudJudgedWeight,
              synthetic: true,
            });
            out.cloudProbes++;
            this.logger.info(`[LocalJudge] Cloud probe ${job}/${cand.model}/${lang}: ${verdict ? 'pass' : 'fail'} (weight ${this.cloudJudgedWeight})`);
          } catch (err) {
            this.logger.warn(`[LocalJudge] Cloud probe failed for ${job}/${cand.model}/${lang}: ${err.message}`);
          }
        }
      }
    }
  }

  /**
   * @private One judge verdict. The judge model grades the (task, response)
   * pair against the job's rubric and answers strict JSON. Parsing is
   * structural only (JSON shape, boolean field); everything semantic lives
   * in the prompt — a wrong verdict is a prompt/model problem, never a
   * code-guard problem.
   * @returns {Promise<boolean|null>} null = verdict unparseable/call failed
   */
  async _judgeSample(judge, job, prompt, response) {
    const rubric = JOB_RUBRICS[job];
    if (!rubric || typeof response !== 'string' || !response) return null;
    const system =
      'You are a strict quality judge for an AI assistant\'s outputs. ' +
      rubric + ' ' +
      'The task and response may be in any language (English, German, Portuguese, or others); ' +
      'judge the response in its own language — the criteria are identical in every language. ' +
      'A response in a different language than its task FAILS unless the task asked for translation. ' +
      'Answer with ONLY this JSON object and nothing else: {"pass": true} or {"pass": false}';
    const user = `${prompt ? `TASK:\n${prompt}` : 'TASK: (not captured — judge the response on its own terms)'}\n\nRESPONSE:\n${response}`;
    try {
      const res = await this.localChat({
        model: judge.name,
        system,
        messages: [{ role: 'user', content: user }],
        timeout: this.judgeTimeoutMs,
        format: 'json',
        options: { temperature: 0 },
      });
      return this._parseVerdict(res?.content);
    } catch (err) {
      this.logger.warn(`[LocalJudge] Judge call failed (${judge.name}): ${err.message}`);
      return null;
    }
  }

  /** @private Structural verdict parse: a JSON object with a boolean `pass`. */
  _parseVerdict(content) {
    if (typeof content !== 'string' || !content) return null;
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      const obj = JSON.parse(match[0]);
      return typeof obj.pass === 'boolean' ? obj.pass : null;
    } catch (_err) {
      return null;
    }
  }

  /**
   * @private Verdict weight from the judge-versus-judged capability gap.
   * Local judged models compare sensed parameter sizes; cloud judged models
   * have no declared size, so they get the fixed minimum tier. An unknown
   * local size sits at the floor: an unestablishable gap is treated as a
   * large one, never as parity.
   */
  _gapWeight(judge, judgedModel, judgedIsLocal) {
    if (!judgedIsLocal) return this.cloudJudgedWeight;
    const judged = this.getModelInfo(judgedModel);
    const judgeSize = judge?.paramSize;
    const judgedSize = judged?.paramSize;
    if (!Number.isFinite(judgeSize) || !Number.isFinite(judgedSize) || judgedSize <= 0) {
      return this.gapFloor;
    }
    return Math.min(1, Math.max(this.gapFloor, judgeSize / judgedSize));
  }

  /** @private Evidential mass of a (job, model, language) cell — its confidence. */
  _cellMass(job, model, lang) {
    if (!this.scorecard || typeof this.scorecard.getPairings !== 'function') return 0;
    const entry = this.scorecard.getPairings(job)?.[model]?.[String(lang || 'EN').toUpperCase()];
    if (!entry) return 0;
    const mass = (entry.a || 0) + (entry.b || 0);
    return Number.isFinite(mass) ? mass : 0;
  }

  /** @private Languages the fixture declares for a job (measurement is multilingual). */
  _fixtureLanguages(job) {
    const langs = this.fixture?.jobs?.[job];
    return langs && typeof langs === 'object' ? Object.keys(langs) : [];
  }

  /** @private A probe prompt for (job, language), rotating with cell warmth. */
  _fixturePrompt(job, lang) {
    const prompts = this.fixture?.jobs?.[job]?.[lang];
    if (!Array.isArray(prompts) || prompts.length === 0) return null;
    // Rotate deterministically as a cell accumulates mass so repeated
    // probes of one cell do not replay one prompt verbatim.
    this._promptCursor = ((this._promptCursor || 0) + 1) % prompts.length;
    return prompts[this._promptCursor];
  }
}

module.exports = LocalJudge;
