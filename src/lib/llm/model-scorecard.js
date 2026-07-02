/**
 * SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2026 Moltagent contributors
 *
 * ModelScorecard — Per-(job, model, language) performance maturation
 * (Layer 2, the living layer of adaptive model selection).
 *
 * Problem:
 *   Layer 1's descriptor prior gets `tools` and `coding` only approximately
 *   right: specialization is invisible in parameter size and in a declared
 *   capability flag. Only production performance reveals that a fine-tuned
 *   mid-size model beats a larger generalist at tool-calling. The golden-set
 *   probe measures classification once at install; nothing measures anything
 *   after that.
 *
 * Pattern:
 *   Each (job, model, language) pairing carries Beta pseudo-counts (a, b):
 *   a success adds to `a`, a failure to `b`, and the pairing's score is the
 *   posterior mean a/(a+b). Classification pairings are SEEDED from the
 *   golden-set probe's fixture result in the same units (accuracy p over n
 *   examples → a=p·n, b=(1−p)·n), so the install-time one-shot measurement
 *   and this loop's continuous measurement are one signal at two cadences,
 *   and accumulated production samples progressively outweigh the low-sample
 *   seed. Selection per job ("the seat") follows the #232 hysteresis
 *   discipline: the incumbent keeps the seat unless a challenger's optimistic
 *   score (mean + UCB exploration bonus) clears the incumbent's mean by a
 *   margin, so noise never flaps the roster. The exploration bonus grows for
 *   under-sampled pairings, which is how a demoted model earns retries; for
 *   destructive jobs (tools) the bonus is gated by a floor so exploration
 *   never hands a job with side effects to a model with a failing record.
 *
 * Data Flow:
 *   AgentLoop / MicroPipeline / RouterChatBridge / IntentRouter /
 *   MessageProcessor → recordSample(job, model, lang, success, {weight})
 *     → evaluate(job) → onSeatChange(job, model)
 *       → ModelResolver.setGroundTruthOverride(job, model, 'maturation-loop')
 *   webhook-server (boot, after GoldenSetProbe.run)
 *     → seedFromProbe('classification', probe.getMeasuredScores(...), ...)
 *     → assertSeats()   // learned seat re-asserted AFTER the probe's override
 *
 * Dependency Map:
 *   src/lib/llm/model-scorecard.js
 *     ← (no internal imports — standalone, testable in isolation; callers
 *        inject onSeatChange and getLanguage)
 *
 * @module llm/model-scorecard
 * @license AGPL-3.0
 */

'use strict';

const fs = require('fs');
const path = require('path');

const STORE_FILENAME = 'model-scorecard.json';

// One golden-set fixture example's worth of accuracy (12-example fixture).
// The same constant family as the #232 probe hysteresis: a selection flip
// must be worth at least one real example of measured difference.
const DEFAULT_MARGIN = 1 / 12;

// UCB exploration coefficient. Small enough that a well-sampled incumbent
// is stable; large enough that a stale pairing's bonus eventually clears
// DEFAULT_MARGIN as the job's total sample count grows.
const DEFAULT_EXPLORATION_C = 0.5;

// Per-language pseudo-count ceiling. When a pairing's mass exceeds this,
// both counts halve — recent performance dominates and the score stays
// plastic after a model or prompt changes (stigmergy: evaporation).
const DEFAULT_CEILING = 200;

// Escalation-correction negatives carry half weight: a downstream
// escalation can mean the executing model failed, not the classifier —
// the signal is real but noisier than a structural parse failure.
const DEFAULT_ESCALATION_WEIGHT = 0.5;

// For destructive jobs the exploration bonus is scaled by
// (mean / floor)² capped at 1: a marginally-failed model (mean just under
// the floor) earns its retry at nearly the normal rate, while a
// badly-failed one (e.g. 0.2 → 0.16× bonus) needs a substantially longer
// run of counter-evidence-free traffic before optimism hands it a job with
// side effects again. First seats on destructive jobs also require the
// mean to clear this floor.
const DEFAULT_EXPLORATION_FLOOR = 0.5;

// Jobs whose tool calls mutate state. Classification is a read-only
// decision; tools creates cards, sends mail, writes files.
const DEFAULT_DESTRUCTIVE_JOBS = ['tools'];

class ModelScorecard {
  /**
   * @param {Object} [opts]
   * @param {string|null} [opts.dataDir] - Directory for the persistent store.
   *   Pass null for an in-memory store (tests). Defaults to `data/` under cwd.
   * @param {Function} [opts.getLanguage] - () => cockpit language code
   *   ('EN'|'DE'|'PT'|...). Used when recordSample gets no explicit language.
   * @param {Function} [opts.onSeatChange] - (job, model) => void. Fired when a
   *   job's selected model changes (and by assertSeats at boot). Production
   *   wires ModelResolver.setGroundTruthOverride here.
   * @param {Function} [opts.isSeatable] - (job, model) => boolean. Gate on
   *   SEAT eligibility, not on recording: samples accumulate for every model
   *   that runs (cloud fallbacks included — real data), but the ground-truth
   *   override slot feeds LOCAL provider calls, so production wires this to
   *   ModelScout's installed-model check. Without the gate, a cloud model
   *   that served a tools fallback could win the seat and its name would be
   *   handed to Ollama on every subsequent call (guaranteed 404, and the
   *   corrupt seat would persist across reboots). Defaults to allow-all
   *   (tests, deployments without discovery).
   * @param {number} [opts.margin] - Hysteresis margin a challenger must clear.
   * @param {number} [opts.explorationC] - UCB bonus coefficient.
   * @param {number} [opts.ceiling] - Per-language pseudo-count mass ceiling.
   * @param {number} [opts.escalationWeight] - Weight for escalation negatives.
   * @param {number} [opts.explorationFloor] - Minimum mean for the bonus on
   *   destructive jobs.
   * @param {string[]} [opts.destructiveJobs]
   * @param {Object} [opts.logger=console]
   */
  constructor({
    dataDir,
    getLanguage,
    onSeatChange,
    isSeatable,
    margin = DEFAULT_MARGIN,
    explorationC = DEFAULT_EXPLORATION_C,
    ceiling = DEFAULT_CEILING,
    escalationWeight = DEFAULT_ESCALATION_WEIGHT,
    explorationFloor = DEFAULT_EXPLORATION_FLOOR,
    destructiveJobs = DEFAULT_DESTRUCTIVE_JOBS,
    logger,
  } = {}) {
    this.dataDir = dataDir === null ? null : (dataDir || path.resolve(process.cwd(), 'data'));
    this._storeFile = this.dataDir ? path.join(this.dataDir, STORE_FILENAME) : null;
    this.getLanguage = typeof getLanguage === 'function' ? getLanguage : (() => 'EN');
    this.onSeatChange = typeof onSeatChange === 'function' ? onSeatChange : null;
    this.isSeatable = typeof isSeatable === 'function' ? isSeatable : (() => true);
    this.margin = Number.isFinite(margin) ? Math.max(0, margin) : DEFAULT_MARGIN;
    this.explorationC = Number.isFinite(explorationC) ? Math.max(0, explorationC) : DEFAULT_EXPLORATION_C;
    this.ceiling = Number.isFinite(ceiling) && ceiling > 0 ? ceiling : DEFAULT_CEILING;
    this.escalationWeight = Number.isFinite(escalationWeight) && escalationWeight > 0
      ? escalationWeight : DEFAULT_ESCALATION_WEIGHT;
    this.explorationFloor = Number.isFinite(explorationFloor) ? explorationFloor : DEFAULT_EXPLORATION_FLOOR;
    this.destructiveJobs = new Set(Array.isArray(destructiveJobs) ? destructiveJobs : DEFAULT_DESTRUCTIVE_JOBS);
    this.logger = logger || console;

    this._saveTimer = null;
    this._state = this._load();
  }

  /**
   * Record one mechanical outcome for a (job, model, language) pairing and
   * re-evaluate the job's seat. Safe to call from any execution path — every
   * argument is guarded, and a null/unknown model is a silent no-op (a
   * sample that cannot be attributed must not be invented).
   *
   * @param {string} job - 'tools' | 'classification' (any job accepted).
   * @param {string} model - The model that actually produced the output.
   * @param {string|null} language - Language code; falls back to the cockpit
   *   language when absent (language is a deployment-global setting, not a
   *   per-message detection — see the classification prompt's example sets).
   * @param {boolean} success
   * @param {Object} [opts]
   * @param {number} [opts.weight=1] - Sample weight. Escalation-correction
   *   callers pass the configured escalationWeight; the judge passes its
   *   gap weight.
   * @param {boolean} [opts.synthetic=false] - A probe-generated sample
   *   (Session 4 synthetic judge probes): it carries evidential mass (a/b)
   *   but does not count as production evidence, so it adds no UCB
   *   optimism — the same discipline as the golden-set seed, whose fixture
   *   numbers must never supply exploration bonus against real traffic.
   * @returns {{recorded: boolean, seatChanged: boolean}}
   */
  recordSample(job, model, language, success, { weight = 1, synthetic = false } = {}) {
    if (typeof job !== 'string' || !job || typeof model !== 'string' || !model) {
      return { recorded: false, seatChanged: false };
    }
    const w = Number.isFinite(weight) && weight > 0 ? weight : 1;
    const lang = (typeof language === 'string' && language ? language : this.getLanguage() || 'EN')
      .toUpperCase();

    const entry = this._entry(job, model, lang);
    if (success) entry.a += w; else entry.b += w;
    if (!synthetic) entry.prod = (entry.prod || 0) + w;
    entry.at = new Date().toISOString();

    // Per-language plasticity ceiling: halve all three counters so the
    // ratio (the score) is preserved while future samples regain leverage.
    // `prod` halves too — it feeds the UCB numerator, and left unbounded it
    // would grow the exploration bonus of every stale pairing forever,
    // re-auditioning known-bad models with increasing frequency.
    if (entry.a + entry.b > this.ceiling) {
      entry.a /= 2;
      entry.b /= 2;
      entry.prod /= 2;
    }

    const seatChanged = this._evaluate(job);
    // A seat change repoints live routing — persist immediately. Plain
    // samples are statistics; they coalesce into a debounced write so the
    // hot path never pays a synchronous disk write per LLM call.
    if (seatChanged) this._persistNow();
    else this._scheduleSave();
    return { recorded: true, seatChanged };
  }

  /**
   * Seed pairings from the golden-set probe's fixture-measured result, in the
   * probe's own units: accuracy p over n examples enters as pseudo-counts
   * a=p·n, b=(1−p)·n — exactly the evidential weight the fixture carries, so
   * production samples progressively override it. Existing pairings are
   * never overwritten (a learned score outranks a re-run of the same probe).
   * The probe's selected model becomes the job's initial seat only when no
   * seat exists yet — a learned seat survives reboots.
   *
   * @param {string} job
   * @param {Array<{name: string, scores: Object<string, number>}>} measured -
   *   Per-model per-language accuracies (GoldenSetProbe.getMeasuredScores()).
   * @param {Object<string, number>} exampleCounts - Per-language fixture
   *   example counts (GoldenSetProbe.getExampleCounts()).
   * @param {string|null} [selectedModel] - The probe's selected model.
   */
  seedFromProbe(job, measured, exampleCounts, selectedModel = null) {
    if (typeof job !== 'string' || !job || !Array.isArray(measured)) return;
    const counts = exampleCounts && typeof exampleCounts === 'object' ? exampleCounts : {};

    let seededPairings = 0;
    for (const m of measured) {
      if (!m || typeof m.name !== 'string' || !m.name || !m.scores) continue;
      for (const [langRaw, p] of Object.entries(m.scores)) {
        if (!Number.isFinite(p)) continue;
        const lang = langRaw.toUpperCase();
        const jobs = this._state.jobs;
        if (jobs[job]?.[m.name]?.[lang]) continue; // never overwrite learned counts
        const n = Number.isFinite(counts[langRaw]) && counts[langRaw] > 0 ? counts[langRaw] : 1;
        const entry = this._entry(job, m.name, lang);
        entry.a = p * n;
        entry.b = (1 - p) * n;
        entry.prod = 0;
        entry.seeded = true;
        entry.at = new Date().toISOString();
        seededPairings++;
      }
    }

    if (selectedModel && !this._state.seats[job]) {
      this._state.seats[job] = { model: selectedModel, at: new Date().toISOString(), seeded: true };
    }
    if (seededPairings > 0 || (selectedModel && this._state.seats[job]?.seeded)) {
      this._persistNow();
      this.logger.info(`[ModelScorecard] Seeded ${seededPairings} ${job} pairing(s) from golden-set probe`);
    }
  }

  /**
   * Re-assert every persisted seat through onSeatChange. Called at boot AFTER
   * the golden-set probe has set its own override, so the learned seat — not
   * the probe's install-time pick — is the final authority once evidence
   * exists. With no production samples the seed reproduces the probe's
   * result and the two assertions agree.
   */
  assertSeats() {
    if (!this.onSeatChange) return;
    for (const [job, seat] of Object.entries(this._state.seats)) {
      if (!seat || !seat.model) continue;
      // A persisted seat whose model is no longer seatable (uninstalled, or
      // a pre-gate cloud contamination) is skipped, not deleted — the model
      // may return, and skipping leaves the probe/prior pick standing.
      if (!this._seatable(job, seat.model)) {
        this.logger.warn(`[ModelScorecard] Skipping seat ${job} -> ${seat.model}: not seatable on this box`);
        continue;
      }
      this.logger.info(`[ModelScorecard] Asserting seat: ${job} -> ${seat.model}`);
      try {
        this.onSeatChange(job, seat.model);
      } catch (err) {
        this.logger.warn(`[ModelScorecard] onSeatChange failed for ${job}: ${err.message}`);
      }
    }
  }

  /**
   * Flush any pending debounced write to disk now. Call before shutdown or
   * whenever the on-disk state must be current (tests).
   */
  flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this._persistNow();
  }

  /**
   * @param {string} job
   * @returns {{model: string, at: string}|null}
   */
  getSeat(job) {
    return this._state.seats[job] || null;
  }

  /**
   * Observability: the raw pairing table for a job.
   * @param {string} job
   * @returns {Object<string, Object<string, {a: number, b: number}>>}
   */
  getPairings(job) {
    return this._state.jobs[job] || {};
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /**
   * @private Get-or-create the (job, model, lang) entry. Own-property
   * checks, not truthiness: model names come from rosters, not users, but a
   * name like '__proto__' must create a real entry rather than silently
   * returning (and mutating) the prototype.
   */
  _entry(job, model, lang) {
    const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
    const jobs = this._state.jobs;
    if (!own(jobs, job)) jobs[job] = Object.create(null);
    if (!own(jobs[job], model)) jobs[job][model] = Object.create(null);
    if (!own(jobs[job][model], lang)) jobs[job][model][lang] = { a: 0, b: 0, prod: 0 };
    return jobs[job][model][lang];
  }

  /**
   * @private
   * Re-evaluate the seat for a job.
   *
   * Ranking: each model's base score is its WORST measured language's
   * posterior mean (min-across-languages, the probe's passesAll semantics —
   * a strong-EN weak-DE model must not win DE traffic). Challengers add a
   * UCB exploration bonus, incumbents do not: promotion needs optimism to
   * beat demonstrated performance by the margin, retention needs only the
   * demonstrated performance itself. The bonus numerator grows with the
   * job's PRODUCTION sample total, not its seed mass — the probe's own
   * fixture numbers must not supply optimism against the probe's own pick
   * at boot; only unseen production evidence earns a demoted model its
   * retry. For destructive jobs the bonus is scaled by (mean/floor)² —
   * graded, so a badly-failed model waits far longer for its comeback than
   * a marginally-failed one, and a 0.2-score model effectively never gets
   * handed a destructive call as its audition.
   *
   * @returns {boolean} whether the seat changed
   */
  _evaluate(job) {
    const models = this._state.jobs[job];
    if (!models) return false;

    let prodTotal = 0;
    const stats = [];
    for (const [name, langs] of Object.entries(models)) {
      let n = 0;
      let minMean = Infinity;
      for (const entry of Object.values(langs)) {
        const mass = entry.a + entry.b;
        if (mass <= 0) continue;
        n += mass;
        prodTotal += entry.prod || 0;
        const mean = entry.a / mass;
        if (mean < minMean) minMean = mean;
      }
      if (n <= 0 || !Number.isFinite(minMean)) continue;
      stats.push({ name, n, minMean });
    }
    if (stats.length === 0) return false;

    const destructive = this.destructiveJobs.has(job);
    for (const s of stats) {
      let bonus = this.explorationC * Math.sqrt(Math.log(1 + prodTotal) / s.n);
      if (destructive && this.explorationFloor > 0) {
        bonus *= Math.min(1, s.minMean / this.explorationFloor) ** 2;
      }
      s.optimistic = s.minMean + bonus;
    }

    // Seat eligibility: only models this deployment can actually serve
    // through the override slot compete for the seat. Ineligible models
    // keep their scores (data), they just cannot win routing.
    const seatable = stats.filter(s => this._seatable(job, s.name));
    if (seatable.length === 0) return false;

    const seat = this._state.seats[job] || null;
    const incumbent = seat ? seatable.find(s => s.name === seat.model) : null;

    let winner = null;
    if (incumbent) {
      // Hysteresis (#232 discipline): the incumbent keeps the seat unless a
      // challenger's optimistic score clears the incumbent's demonstrated
      // mean by the margin.
      let best = null;
      for (const s of seatable) {
        if (s.name === incumbent.name) continue;
        if (!best || s.optimistic > best.optimistic) best = s;
      }
      winner = (best && best.optimistic > incumbent.minMean + this.margin) ? best : incumbent;
    } else {
      // No seated model with data (first evidence, or the seated model was
      // removed/ineligible): highest optimistic score wins. A destructive
      // job forms a first seat only on a model whose demonstrated record
      // clears the floor — otherwise the Layer 1 prior stands and no
      // override fires.
      let best = null;
      for (const s of seatable) {
        if (!best || s.optimistic > best.optimistic) best = s;
      }
      if (best && (!destructive || best.minMean >= this.explorationFloor)) winner = best;
      // A persisted seat whose model vanished from the table is kept in
      // state (its entries may return), but a qualified winner replaces it.
      if (!winner) return false;
    }

    if (seat && seat.model === winner.name) return false;

    this._state.seats[job] = { model: winner.name, at: new Date().toISOString() };
    this.logger.info(
      `[ModelScorecard] Seat change: ${job} -> ${winner.name} ` +
      `(min-lang mean ${winner.minMean.toFixed(3)}, n=${Math.round(winner.n)}` +
      `${seat ? `, displacing ${seat.model}` : ', first seat'})`
    );
    if (this.onSeatChange) {
      try {
        this.onSeatChange(job, winner.name);
      } catch (err) {
        this.logger.warn(`[ModelScorecard] onSeatChange failed for ${job}: ${err.message}`);
      }
    }
    return true;
  }

  /** @private */
  _load() {
    const fresh = { version: 1, jobs: {}, seats: {} };
    if (!this._storeFile) return fresh;
    try {
      const raw = fs.readFileSync(this._storeFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return {
          version: 1,
          jobs: (parsed.jobs && typeof parsed.jobs === 'object') ? parsed.jobs : {},
          seats: (parsed.seats && typeof parsed.seats === 'object') ? parsed.seats : {},
        };
      }
    } catch (_err) {
      // Missing file or corrupt JSON — start fresh.
    }
    return fresh;
  }

  /** @private Seat-eligibility check, never throwing. */
  _seatable(job, model) {
    try {
      return !!this.isSeatable(job, model);
    } catch (_err) {
      return false;
    }
  }

  /**
   * @private
   * Coalesce sample writes: the hot path marks the state dirty and a short
   * unref'd timer flushes it, so N samples in one agent turn cost one disk
   * write and a crash loses at most a second of statistics.
   */
  _scheduleSave() {
    if (!this._storeFile || this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._persistNow();
    }, 1000);
    if (typeof this._saveTimer.unref === 'function') this._saveTimer.unref();
  }

  /** @private */
  _persistNow() {
    if (!this._storeFile) return;
    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }
      const tmp = this._storeFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this._state, null, 2), 'utf8');
      fs.renameSync(tmp, this._storeFile);
    } catch (err) {
      this.logger.warn(`[ModelScorecard] Failed to persist scorecard: ${err.message}`);
    }
  }
}

module.exports = ModelScorecard;
