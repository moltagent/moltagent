/**
 * SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2026 Moltagent contributors
 *
 * NicheAssignment — Compose per-job winners into a memory-feasible
 * assignment under carrying capacity (Layer 3 of adaptive model selection).
 *
 * Problem:
 *   Picking the best model per job independently ignores the box. Models
 *   that do not co-fit in memory displace each other on every job switch,
 *   `load_duration` becomes the dominant latency, and a "better" roster is
 *   slower than monoculture. The three states (design doc §7): fragmentation
 *   (drifting duplicates), monoculture (one model, one bottleneck), and
 *   modularity (specialists composing through the jobs). This module buys
 *   modularity WITHOUT trading it for load thrash.
 *
 * Pattern:
 *   Sense, don't predict. The foundation signal is `load_duration` from
 *   every Ollama response (free, portable, captured at the two adapter
 *   necks): a large value is the box reporting, empirically, that the model
 *   was not resident. Thrash = repeated large organic loads across several
 *   models inside a sliding window — proof those models do not co-fit on
 *   THIS hardware. The assignment then backs off: the lowest-value job's
 *   model leaves the resident plan and its jobs remap onto an already-
 *   resident, capability-eligible model (ModelScout's roster chains carry
 *   eligibility, so no capability logic is duplicated here). Re-admission
 *   follows the #232 hysteresis discipline: a non-co-fit verdict stands for
 *   a cool-off that doubles on each recurrence, so the plan never flaps.
 *
 *   Calibration traffic (the golden-set probe's boot burst, the judge's
 *   idle-cycle probes, any future fixture) is one structural class, marked
 *   by a `calibration` flag at the adapters (the same shape as the
 *   scorecard's `synthetic` flag). Its loads feed the residency ledger —
 *   real loads, real evidence — but never count as thrash: the failure mode
 *   thrash names is felt latency on organic requests only.
 *
 *   The judge is a first-class tenant. ModelScout.selectJudgeModel() pins it
 *   outside the resolver by design (the gradee must not pick its grader);
 *   its idle cycles load it regardless of any job's winner, so the plan must
 *   hold space for it. Jobs MAY be remapped toward the judge's model (a
 *   colocation dividend) — that moves jobs, never the judge pin, so the
 *   self-reference the pin prevents stays prevented. Cockpit-pinned models
 *   are tenants for the same reason: deliberate human intent is not
 *   negotiable by a residency optimization.
 *
 *   Enrichment where present: /api/ps (real residency per loaded model)
 *   confirms the plan proactively. Where absent — and on hosts where the
 *   GPU lives behind an HTTP endpoint, `nvidia-smi` is absent by
 *   construction — the `load_duration` foundation stands alone.
 *
 * Data Flow:
 *   OllamaProvider / OllamaToolsProvider → onTimings → recordTiming()
 *     → (organic load events) thrash oracle → replan()
 *   ModelScorecard.onSeatChange (webhook-server tee) → replanSoon()
 *   HeartbeatManager pulse → reconcile() → /api/ps snapshot → replan()
 *   replan() → resolver.resolveWinner(job) per job
 *     → resolver.setAssignment(map, 'niche-assignment')
 *       → resolve(job) serves the remapped model, winner in derivation
 *
 * Dependency Map:
 *   src/lib/llm/niche-assignment.js
 *     ← src/lib/providers/model-scout.js (PRIOR_STRENGTH: canonical job list)
 *
 * @module llm/niche-assignment
 * @license AGPL-3.0
 */

'use strict';

const { PRIOR_STRENGTH } = require('../providers/model-scout');

// A load event: an Ollama response whose server-side load_duration exceeds
// this. Warm responses report milliseconds; a cold load on the reference box
// exceeds 60s (#124) — three orders of magnitude of separation, so the
// threshold is not delicate.
const DEFAULT_LOAD_EVENT_MS = 1000;

// Thrash: at least MIN_EVENTS organic load events across at least MIN_MODELS
// distinct models within WINDOW_MS. One cold load after a restart or an
// idle-evicted rarity is normal; several models repeatedly displacing each
// other inside a quarter hour is the box reporting they do not co-fit.
const DEFAULT_THRASH_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_THRASH_MIN_EVENTS = 3;
const DEFAULT_THRASH_MIN_MODELS = 2;

// Hysteresis (#232 discipline): a non-co-fit verdict stands for a cool-off
// that doubles on each recurrence, capped. Re-admission is slow and earned;
// the resident plan never flaps on one noisy window.
const DEFAULT_BACKOFF_MS = 60 * 60 * 1000;
const DEFAULT_BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;

// Felt-latency weight per job: how much it costs the USER when this job's
// model must cold-load. Request-path jobs that run on every message rank
// highest; long-form jobs amortize a load over a long generation; credentials
// is rare. Job names, not natural language — the set does not change when a
// human language is added (Rule 1 unaffected). Used to pick which model
// leaves the resident plan when two provably do not co-fit.
const JOB_WEIGHTS = Object.freeze({
  classification: 100,
  quick: 90,
  tools: 80,
  coding: 70,
  thinking: 40,
  writing: 40,
  research: 40,
  credentials: 10,
});

// Ring-buffer bound for the load-event ledger.
const MAX_LOAD_EVENTS = 200;

class NicheAssignment {
  /**
   * @param {Object} opts
   * @param {Object} opts.resolver - ModelResolver (resolveWinner, setAssignment).
   * @param {Object} [opts.modelScout] - ModelScout (rosterFor eligibility
   *   chains, selectJudgeModel). Null → plan degrades to identity (no remap
   *   targets can be validated, so winners stand).
   * @param {string[]} [opts.jobs] - Jobs to plan for. Defaults to the
   *   canonical job list (PRIOR_STRENGTH keys — one source of truth).
   * @param {string|null} [opts.ollamaEndpoint] - For /api/ps enrichment.
   *   Null → foundation-only (load_duration) operation.
   * @param {Function} [opts.fetchImpl] - Injectable fetch (tests).
   * @param {Function} [opts.now] - Injectable clock (tests). () => epoch ms.
   * @param {number} [opts.loadEventMs]
   * @param {number} [opts.thrashWindowMs]
   * @param {number} [opts.thrashMinEvents]
   * @param {number} [opts.thrashMinModels]
   * @param {number} [opts.backoffMs]
   * @param {number} [opts.backoffMaxMs]
   * @param {Object} [opts.logger=console]
   */
  constructor({
    resolver,
    modelScout,
    jobs,
    ollamaEndpoint,
    fetchImpl,
    now,
    loadEventMs = DEFAULT_LOAD_EVENT_MS,
    thrashWindowMs = DEFAULT_THRASH_WINDOW_MS,
    thrashMinEvents = DEFAULT_THRASH_MIN_EVENTS,
    thrashMinModels = DEFAULT_THRASH_MIN_MODELS,
    backoffMs = DEFAULT_BACKOFF_MS,
    backoffMaxMs = DEFAULT_BACKOFF_MAX_MS,
    logger,
  } = {}) {
    this.resolver = resolver || null;
    this.modelScout = modelScout || null;
    this.jobs = Array.isArray(jobs) && jobs.length > 0 ? [...jobs] : Object.keys(PRIOR_STRENGTH);
    this.ollamaEndpoint = (typeof ollamaEndpoint === 'string' && ollamaEndpoint)
      ? ollamaEndpoint.replace(/\/+$/, '')
      : null;
    this._fetch = fetchImpl || globalThis.fetch;
    this._now = typeof now === 'function' ? now : Date.now;
    this.loadEventMs = Number.isFinite(loadEventMs) && loadEventMs > 0 ? loadEventMs : DEFAULT_LOAD_EVENT_MS;
    this.thrashWindowMs = Number.isFinite(thrashWindowMs) && thrashWindowMs > 0 ? thrashWindowMs : DEFAULT_THRASH_WINDOW_MS;
    this.thrashMinEvents = Number.isFinite(thrashMinEvents) && thrashMinEvents > 0 ? thrashMinEvents : DEFAULT_THRASH_MIN_EVENTS;
    this.thrashMinModels = Number.isFinite(thrashMinModels) && thrashMinModels > 0 ? thrashMinModels : DEFAULT_THRASH_MIN_MODELS;
    this.backoffMs = Number.isFinite(backoffMs) && backoffMs > 0 ? backoffMs : DEFAULT_BACKOFF_MS;
    this.backoffMaxMs = Number.isFinite(backoffMaxMs) && backoffMaxMs > 0 ? backoffMaxMs : DEFAULT_BACKOFF_MAX_MS;
    this.logger = logger || console;

    // Residency ledger: organic load events (ring buffer) + last-served
    // belief per model. Calibration loads update belief but never enter the
    // thrash window.
    this._loadEvents = [];
    this._lastServed = new Map(); // model → epoch ms

    // Non-co-fit verdicts: pairKey → { strikes, until }.
    this._nonCoFit = new Map();

    // Last /api/ps snapshot (enrichment; null when absent/unreachable).
    this._psSnapshot = null;
    this._psWarned = false;

    // Current plan.
    this._assignmentMap = {}; // job → model, remapped jobs only
    this._residentPlan = []; // model names the plan holds resident
    this._replanTimer = null;
  }

  // ---------------------------------------------------------------------------
  // Foundation signal: the residency ledger
  // ---------------------------------------------------------------------------

  /**
   * Record one Ollama response's server-side timings (from the adapter
   * necks). A load_duration above the threshold is a load event: the model
   * was not resident and someone paid the cold load. Organic load events
   * feed the thrash oracle; calibration events only update residency belief.
   * @param {{ model: string|null, loadDurationMs: number,
   *   totalDurationMs?: number, evalDurationMs?: number,
   *   calibration?: boolean }} t
   */
  recordTiming(t) {
    if (!t || typeof t !== 'object' || typeof t.model !== 'string' || !t.model) return;
    const at = this._now();
    this._lastServed.set(t.model, at);

    const loadMs = Number.isFinite(t.loadDurationMs) ? t.loadDurationMs : 0;
    if (loadMs <= this.loadEventMs) return;

    this._loadEvents.push({ model: t.model, at, loadDurationMs: loadMs, calibration: !!t.calibration });
    if (this._loadEvents.length > MAX_LOAD_EVENTS) {
      this._loadEvents.splice(0, this._loadEvents.length - MAX_LOAD_EVENTS);
    }
    this.logger.info(
      `[NicheAssignment] Load event: ${t.model} load_duration=${Math.round(loadMs)}ms` +
      `${t.calibration ? ' (calibration — excluded from thrash)' : ''}`
    );

    if (!t.calibration) this._checkThrash(at);
  }

  /**
   * @private
   * Thrash oracle over the organic load events in the sliding window. On a
   * verdict, every pair among the involved models is marked non-co-fit
   * (with escalating cool-off), the consumed events are dropped so one
   * episode fires once, and the plan recomputes.
   */
  _checkThrash(at) {
    const cutoff = at - this.thrashWindowMs;
    const organic = this._loadEvents.filter(e => !e.calibration && e.at >= cutoff);
    if (organic.length < this.thrashMinEvents) return;
    const models = [...new Set(organic.map(e => e.model))];
    if (models.length < this.thrashMinModels) return;

    for (let i = 0; i < models.length; i++) {
      for (let j = i + 1; j < models.length; j++) {
        this._markNonCoFit(models[i], models[j], at);
      }
    }
    // Consume the episode: keep only events outside it, so the same window
    // does not re-fire on the next load.
    this._loadEvents = this._loadEvents.filter(e => e.calibration || e.at < cutoff);
    this.logger.warn(
      `[NicheAssignment] Thrash detected: ${organic.length} load events across ` +
      `${models.length} models (${models.join(', ')}) within ${Math.round(this.thrashWindowMs / 60000)}min — backing off`
    );
    this.replan();
  }

  /** @private */
  _markNonCoFit(a, b, at) {
    const key = this._pairKey(a, b);
    const prev = this._nonCoFit.get(key);
    const strikes = (prev ? prev.strikes : 0) + 1;
    const cooloff = Math.min(this.backoffMs * 2 ** (strikes - 1), this.backoffMaxMs);
    this._nonCoFit.set(key, { strikes, until: at + cooloff, models: [a, b].sort() });
    this.logger.warn(
      `[NicheAssignment] Non-co-fit: ${key} (strike ${strikes}, re-admission in ${Math.round(cooloff / 60000)}min)`
    );
  }

  /** @private */
  _pairKey(a, b) {
    return [a, b].sort().join(' | ');
  }

  /** @private Active (not yet cooled-off) non-co-fit pairs. */
  _activeNonCoFit(at) {
    const active = [];
    for (const rec of this._nonCoFit.values()) {
      if (rec.until > at) active.push(rec);
    }
    return active;
  }

  // ---------------------------------------------------------------------------
  // Planning
  // ---------------------------------------------------------------------------

  /**
   * Debounced replan: collapses a burst of triggers (assertSeats fires
   * onSeatChange once per persisted seat at boot) into one plan on the next
   * tick.
   */
  replanSoon() {
    if (this._replanTimer) return;
    this._replanTimer = setTimeout(() => {
      this._replanTimer = null;
      try {
        this.replan();
      } catch (err) {
        this.logger.warn(`[NicheAssignment] replan failed: ${err.message}`);
      }
    }, 0);
    // Never hold the process open for a pending replan.
    if (typeof this._replanTimer.unref === 'function') this._replanTimer.unref();
  }

  /**
   * Recompute the assignment from the current winners, tenants, and
   * non-co-fit evidence, and push it into the resolver. Pure in-memory
   * arithmetic — no I/O, no LLM call — so it is safe to call on every seat
   * change, heartbeat, and thrash verdict.
   *
   * With no non-co-fit evidence the assignment is the identity: winners
   * stand, and the plan simply names the resident set they imply. That is
   * the correct day-one behaviour ("on a box that can hold all winners,
   * keep them resident") — remaps exist only where the box has proven a
   * conflict.
   *
   * @returns {{ map: Object, residentPlan: string[] }}
   */
  replan() {
    if (!this.resolver || typeof this.resolver.resolveWinner !== 'function') {
      return { map: {}, residentPlan: [] };
    }
    const at = this._now();

    // 1. Winners per job, with cockpit pins exempt and their models pinned.
    const winners = Object.create(null); // job → model (remappable jobs)
    const pinnedModels = new Set(); // cockpit models: forced-resident, never dropped
    for (const job of this.jobs) {
      let w;
      try {
        w = this.resolver.resolveWinner(job);
      } catch (_err) {
        continue;
      }
      if (!w || !w.model) continue;
      if (w.source === 'cockpit-card') {
        pinnedModels.add(w.model);
        continue; // exempt from remapping
      }
      winners[job] = w.model;
    }

    // 2. Tenants: the judge pin (loop-exempt by design — see module brief)
    // and cockpit pins occupy space regardless of job winners.
    let judgeModel = null;
    try {
      judgeModel = this.modelScout?.selectJudgeModel?.()?.name || null;
    } catch (_err) {
      judgeModel = null;
    }

    // 3. Desired resident set and per-model value (felt-latency weight of
    // the jobs each serves; tenants are beyond value — never dropped).
    const value = new Map();
    for (const [job, model] of Object.entries(winners)) {
      value.set(model, (value.get(model) || 0) + (JOB_WEIGHTS[job] || 1));
    }
    const protectedModels = new Set(pinnedModels);
    if (judgeModel) protectedModels.add(judgeModel);
    const resident = new Set([...value.keys(), ...protectedModels]);

    // 4. Resolve proven conflicts: while an active non-co-fit pair is fully
    // inside the plan, evict the lower-value unprotected model. Two
    // protected models in conflict cannot be resolved by remapping jobs —
    // physical reality outranks the plan; surface it and move on.
    const active = this._activeNonCoFit(at);
    let guard = resident.size + 1;
    let conflictResolved = true;
    while (conflictResolved && guard-- > 0) {
      conflictResolved = false;
      for (const pair of active) {
        const [a, b] = pair.models;
        if (!resident.has(a) || !resident.has(b)) continue;
        const aProt = protectedModels.has(a);
        const bProt = protectedModels.has(b);
        if (aProt && bProt) {
          this.logger.warn(
            `[NicheAssignment] Non-co-fit pair ${this._pairKey(a, b)} is judge/cockpit-protected on both sides — cannot remap around it`
          );
          continue;
        }
        let drop;
        if (aProt) drop = b;
        else if (bProt) drop = a;
        else drop = (value.get(a) || 0) <= (value.get(b) || 0) ? a : b;
        resident.delete(drop);
        conflictResolved = true;
        this.logger.info(`[NicheAssignment] Dropping ${drop} from the resident plan (non-co-fit with ${drop === a ? b : a})`);
        break;
      }
    }

    // 5. Remap each job whose winner left the plan onto the first
    // capability-eligible resident model (ModelScout's chain carries
    // eligibility — first entry in rosterFor(job) that is resident). No
    // eligible resident target → the winner stands (never-go-dark: a cold
    // load beats a wrong-capability model).
    const map = Object.create(null);
    for (const [job, model] of Object.entries(winners)) {
      if (resident.has(model)) continue;
      let chain = [];
      try {
        chain = this.modelScout?.rosterFor?.(job) || [];
      } catch (_err) {
        chain = [];
      }
      const target = chain.find(m => resident.has(m));
      if (target && target !== model) {
        map[job] = target;
      } else {
        resident.add(model); // winner stands; it will be loaded when called
      }
    }

    // 6. Publish — only when the map actually changed. setAssignment clears
    // the resolver's per-job cache, and replan runs on every heartbeat
    // pulse; an identity→identity pulse must not flush a warm cache.
    const changed = JSON.stringify({ ...map }) !== JSON.stringify({ ...this._assignmentMap });
    this._assignmentMap = map;
    this._residentPlan = [...resident].sort();
    if (changed) {
      try {
        this.resolver.setAssignment(Object.keys(map).length > 0 ? { ...map } : null);
      } catch (err) {
        this.logger.warn(`[NicheAssignment] setAssignment failed: ${err.message}`);
      }
    }
    if (changed) {
      const remaps = Object.entries(map).map(([j, m]) => `${j}→${m}`).join(', ');
      this.logger.info(
        `[NicheAssignment] Plan: resident [${this._residentPlan.join(', ')}]` +
        (remaps ? ` — remapped: ${remaps}` : ' — winners stand (no remap)')
      );
    }
    return { map: { ...map }, residentPlan: [...this._residentPlan] };
  }

  // ---------------------------------------------------------------------------
  // Enrichment: /api/ps
  // ---------------------------------------------------------------------------

  /**
   * Refresh the /api/ps residency snapshot (enrichment — the plan works
   * without it) and replan. Called from the heartbeat pulse. Absence or
   * failure degrades silently to foundation-only operation.
   */
  async reconcile() {
    if (this.ollamaEndpoint && typeof this._fetch === 'function') {
      try {
        const res = await this._fetch(`${this.ollamaEndpoint}/api/ps`, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(5000),
        });
        if (res && res.ok) {
          const data = await res.json();
          const models = Array.isArray(data?.models) ? data.models : [];
          this._psSnapshot = {
            at: this._now(),
            models: models.map(m => ({
              name: m.name || m.model,
              sizeBytes: m.size || 0,
              sizeVram: m.size_vram || 0,
              expiresAt: m.expires_at || null,
            })),
          };
        }
      } catch (err) {
        if (!this._psWarned) {
          this._psWarned = true;
          this.logger.warn(`[NicheAssignment] /api/ps unavailable (${err.message}) — foundation signal (load_duration) only`);
        }
      }
    }
    return this.replan();
  }

  // ---------------------------------------------------------------------------
  // Observability
  // ---------------------------------------------------------------------------

  /**
   * One structured status object for logs and the cockpit.
   * @returns {Object}
   */
  getStatus() {
    const at = this._now();
    return {
      residentPlan: [...this._residentPlan],
      assignment: { ...this._assignmentMap },
      nonCoFit: this._activeNonCoFit(at).map(r => ({
        models: [...r.models], strikes: r.strikes, readmissionInMs: Math.max(0, r.until - at),
      })),
      recentLoadEvents: this._loadEvents.slice(-10).map(e => ({
        model: e.model, loadDurationMs: Math.round(e.loadDurationMs), calibration: e.calibration, at: e.at,
      })),
      psResident: this._psSnapshot ? this._psSnapshot.models.map(m => m.name) : null,
      psAgeMs: this._psSnapshot ? at - this._psSnapshot.at : null,
    };
  }

  /** Cancel any pending debounced replan (shutdown/tests). */
  stop() {
    if (this._replanTimer) {
      clearTimeout(this._replanTimer);
      this._replanTimer = null;
    }
  }
}

module.exports = { NicheAssignment, JOB_WEIGHTS };
