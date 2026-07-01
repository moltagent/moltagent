/**
 * SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2026 Moltagent contributors
 *
 * ModelResolver — The single source of truth for "which model serves job X".
 *
 * Problem:
 *   Eight config sources declared the local model (providers.json, the YAML,
 *   OLLAMA_MODEL env, two hardcoded defaults, ModelScout, the Cockpit card, and
 *   the webhook-server bootstrap). No resolver mediated. Different consumers read
 *   different sources: the chat provider ran providers.json's model while
 *   CostTracker logged the env var's model. When they diverged, the audit log
 *   named a model that never ran (Prime ran phi4-mini for weeks while the log
 *   claimed qwen3:8b). Separately, the Cockpit `trust: local-only` setting was
 *   never consulted on the conversational path, so a local-only deployment could
 *   still route to cloud.
 *
 * Pattern:
 *   A biological expression pathway. Information flows one direction and the
 *   later (more authoritative) source wins:
 *     genome (providers.json)
 *       → epigenetic marks (OLLAMA_MODEL env, only when explicitly set)
 *         → sensed environment (ModelScout: what is actually installed)
 *           → hormonal modulation (Cockpit card: trust + explicit local model)
 *             → phenotype: resolve(job) → { model, provider, trust, source, derivation }
 *   ModelScout overrides static config because it reflects reality. The Cockpit
 *   card overrides ModelScout because it is the human's deliberate control.
 *   Every consumer reads the phenotype only; none reads an upstream stage.
 *
 *   This mirrors `resolveOllamaEndpoint` (env > providers.json > localhost),
 *   which already does one-fact-one-resolution for the URL. The model never had
 *   an equivalent until now.
 *
 * Key Dependencies:
 *   - ModelScout (optional) — `generateLocalRoster()` + `hasModel()` for the
 *     environment term; null when Ollama is unreachable.
 *   - CockpitManager (optional) — `cachedConfig.system.modelsConfig` for trust
 *     and any explicit local-model override; null before first heartbeat.
 *
 * Data Flow:
 *   webhook-server (boot, after ModelScout.discover) → new ModelResolver(...)
 *     → refresh() snapshots ModelScout + Cockpit + config into a per-job cache
 *   RouterChatBridge.chat(job) → resolve(job) → { model, trust, ... }
 *     → passes model to the local chat provider, logs model+source to CostTracker,
 *       and forces local routing when trust === 'local-only'
 *   Heartbeat (Cockpit card change) → refresh() so trust/roster changes propagate
 *
 * Dependency Map:
 *   src/lib/llm/model-resolver.js
 *     ← (no internal imports — standalone, testable in isolation)
 *
 * @module llm/model-resolver
 * @license AGPL-3.0
 */

'use strict';

// Mirrors LLMRouter.JOBS.CREDENTIALS. Kept as a local constant so the resolver
// stays standalone (no router import, no dependency graph pulled in for a test).
const CREDENTIALS_JOB = 'credentials';

// Jobs served by the small/fast local model (ollama-fast) rather than the
// capable model (ollama-local). Job names — not natural language — so this set
// does not change when a new human language is added (Rule 1 is unaffected).
const FAST_JOBS = new Set(['quick', 'classification']);

const DEFAULT_TRUST = 'cloud-ok';
const LOCAL_ONLY = 'local-only';

class ModelResolver {
  /**
   * @param {Object} opts
   * @param {Object} [opts.deployerConfig] - The providers.json ollama block
   *   (the genome). Read for `.model`.
   * @param {string|null} [opts.envModel] - The value of OLLAMA_MODEL **only when
   *   explicitly set** (the epigenetic mark). Pass `process.env.OLLAMA_MODEL ||
   *   null` — an env var sitting at its code default is NOT an explicit override
   *   (design rule 2: epigenetics, not mutation), so config.js's collapsed
   *   CONFIG.ollama.model must not be passed here.
   * @param {Object|null} [opts.modelScout] - ModelScout instance, or null if
   *   Ollama is unreachable.
   * @param {Object|null} [opts.cockpitManager] - CockpitManager instance, or
   *   null before the first heartbeat.
   * @param {string|null} [opts.fallbackModel] - Structural last-resort model.
   *   Defaults to null — the resolver never hardcodes a model name (design rule:
   *   model names are deployer decisions). When everything else is absent and
   *   ModelScout found nothing, resolve() returns this (null = unknown).
   * @param {Object} [opts.logger=console]
   */
  constructor({ deployerConfig, envModel, modelScout, cockpitManager, fallbackModel, logger } = {}) {
    this.deployerModel = (deployerConfig && typeof deployerConfig.model === 'string')
      ? deployerConfig.model
      : null;
    this.envModel = (typeof envModel === 'string' && envModel !== '') ? envModel : null;
    this.modelScout = modelScout || null;
    this.cockpitManager = cockpitManager || null;
    this.fallbackModel = (typeof fallbackModel === 'string' && fallbackModel !== '') ? fallbackModel : null;
    this.logger = logger || console;

    // Per-job resolution cache. Populated by refresh() (boot) and on Cockpit
    // card changes (heartbeat). resolve() reads the cache between refreshes, so
    // no LLM call ever pays for re-reading config files or re-running ModelScout.
    this._cache = new Map();

    // Ground-truth overrides (job → model name), set by the golden-set probe
    // once it has MEASURED per-language classification accuracy rather than
    // proxying correctness by model size. Deliberately NOT cleared by
    // refresh() — refresh() re-snapshots ModelScout/Cockpit, which have no
    // opinion on measured accuracy; the probe's finding survives until the
    // probe itself revises or clears it.
    this._groundTruthOverrides = {};

    this.refresh();
  }

  /**
   * Set (or clear) the ground-truth override for a job, sourced from a
   * measured probe (e.g. GoldenSetProbe) rather than size or config.
   * Invalidates the job's cache entry so the next resolve() picks it up.
   * @param {string} job
   * @param {string|null} model - Pass null/falsy to clear the override.
   */
  setGroundTruthOverride(job, model) {
    if (!job) return;
    if (model) this._groundTruthOverrides[job] = model;
    else delete this._groundTruthOverrides[job];
    this._cache.delete(job);
  }

  /**
   * Recompute every cached resolution from the current in-memory snapshots
   * (ModelScout's discovered roster, the Cockpit card's parsed config).
   *
   * Call after ModelScout.discover() resolves at boot, and whenever the Cockpit
   * Models card changes at heartbeat. Reads no files and makes no network calls —
   * it only re-snapshots objects already in memory.
   */
  refresh() {
    this._cache.clear();
    this._scoutRoster = this._readScoutRoster();
    const cockpit = this._readCockpit();
    this._cockpitTrust = cockpit.trust;
    this._cockpitModel = cockpit.localModel;
  }

  /**
   * Resolve the model and trust level for a job.
   *
   * @param {string} job - Job name (tools, thinking, quick, ...).
   * @returns {{
   *   model: string|null,
   *   provider: string,
   *   trust: string,
   *   source: string,
   *   derivation: Object,
   *   fellBack: ({from: string, to: string, reason: string}|null)
   * }}
   */
  resolve(job) {
    if (!job) job = 'tools';
    if (this._cache.has(job)) return this._cache.get(job);
    const resolved = this._resolveUncached(job);
    this._cache.set(job, resolved);
    return resolved;
  }

  /**
   * Convenience: just the resolved model name for a job (or null).
   * @param {string} job
   * @returns {string|null}
   */
  resolveModel(job) {
    return this.resolve(job).model;
  }

  /**
   * Convenience: the resolved trust level for a job ('local-only' | 'cloud-ok').
   * CREDENTIALS is always 'local-only' regardless of the Cockpit setting.
   * @param {string} job
   * @returns {string}
   */
  resolveTrust(job) {
    return this.resolve(job).trust;
  }

  /**
   * Build a one-line-per-job interoception report for the startup log.
   * @param {string[]} jobs - Jobs to report (e.g. ['tools','thinking','quick']).
   * @returns {{ summary: string, divergences: string[] }}
   */
  describe(jobs) {
    const parts = [];
    const divergences = [];
    for (const job of jobs) {
      const r = this.resolve(job);
      parts.push(`${job}→${r.model || '(none)'} (${r.source})`);
      const d = r.derivation;
      // Divergence: two distinct, present sources disagree on the model.
      const present = [d.deployerConfig, d.envOverride, d.modelScout, d.cockpitCard].filter(Boolean);
      const distinct = new Set(present);
      if (distinct.size > 1) {
        divergences.push(
          `Model divergence for job '${job}': ` +
          `deployer-config=${d.deployerConfig || '∅'}, env=${d.envOverride || '∅'}, ` +
          `model-scout=${d.modelScout || '∅'}, cockpit=${d.cockpitCard || '∅'} ` +
          `→ resolved: ${r.model} (${r.source} wins)`
        );
      }
      if (r.fellBack) {
        divergences.push(
          `Configured model '${r.fellBack.from}' not found on Ollama for job '${job}'; ` +
          `using ${r.fellBack.to} (${r.fellBack.reason}).`
        );
      }
    }
    return { summary: parts.join(', '), divergences };
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /** @private */
  _resolveUncached(job) {
    const scout = this._scoutRoster ? (this._scoutRoster[job] || null) : null;
    const cockpit = this._cockpitModel || null; // explicit local model from the card, if any
    // Measured per-language classification accuracy (GoldenSetProbe), when the
    // probe has run for this job. Ground truth beats a size prior, but the
    // human's deliberate Cockpit override still wins over a measurement.
    const probePick = this._groundTruthOverrides[job] || null;

    const derivation = {
      deployerConfig: this.deployerModel,
      envOverride: this.envModel,
      modelScout: scout,
      cockpitCard: cockpit,
      probePick,
      resolved: null,
    };

    // Trust: default cloud-ok, Cockpit card wins when present, CREDENTIALS is
    // always local-only (key material never leaves the box).
    const trust = (job === CREDENTIALS_JOB)
      ? LOCAL_ONLY
      : (this._cockpitTrust || DEFAULT_TRUST);

    // Model precedence (later wins): cockpit > golden-set-probe > model-scout
    // > env > deployer > fallback. The probe sits above model-scout because it
    // measured accuracy for the exact roster scout produced; it sits below
    // cockpit because an explicit human override is always deliberate intent.
    let model = null;
    let source = 'fallback';
    if (cockpit) { model = cockpit; source = 'cockpit-card'; }
    else if (probePick) { model = probePick; source = 'golden-set-probe'; }
    else if (scout) { model = scout; source = 'model-scout'; }
    else if (this.envModel) { model = this.envModel; source = 'env-override'; }
    else if (this.deployerModel) { model = this.deployerModel; source = 'deployer-config'; }
    else { model = this.fallbackModel; source = 'fallback'; }

    // Inflammation rule: surface when the operator's configured model is not
    // actually installed. `configured` is the highest-precedence human/static
    // intent (Cockpit explicit model > env mark > deployer genome). If it is not
    // on Ollama, we run ModelScout's installed pick instead and signal loudly via
    // fellBack. We can only check this when ModelScout has discovered something;
    // if it is down we trust the configured value and stay silent.
    let fellBack = null;
    const configured = cockpit || this.envModel || this.deployerModel || null;
    if (configured && this._scoutHasModels() && !this.modelScout.hasModel(configured)) {
      const alt = (scout && this.modelScout.hasModel(scout)) ? scout : null;
      if (alt) {
        // Repoint only if the (uninstalled) configured model actually won.
        if (model === configured) { model = alt; source = 'model-scout'; }
        if (model !== configured) {
          fellBack = { from: configured, to: model, reason: 'configured model not installed' };
        }
      }
      // else: ModelScout has no usable pick for this job either — keep the
      // configured value; describe() still flags the divergence and Ollama will
      // error loudly if the model is truly absent.
    }

    derivation.resolved = model;
    const provider = FAST_JOBS.has(job) ? 'ollama-fast' : 'ollama-local';
    return { model, provider, trust, source, derivation, fellBack };
  }

  /** @private @returns {Object|null} job → model-name map from ModelScout */
  _readScoutRoster() {
    if (!this.modelScout || typeof this.modelScout.generateLocalRoster !== 'function') return null;
    let roster;
    try {
      roster = this.modelScout.generateLocalRoster();
    } catch {
      return null;
    }
    if (!roster) return null;
    // Collapse each job's chain to its top pick (a model name).
    const out = {};
    for (const [job, models] of Object.entries(roster)) {
      if (Array.isArray(models) && models.length > 0) out[job] = models[0];
    }
    return out;
  }

  /** @private @returns {boolean} whether ModelScout has discovered any models */
  _scoutHasModels() {
    return !!(this.modelScout
      && typeof this.modelScout.hasModel === 'function'
      && this._scoutRoster
      && Object.keys(this._scoutRoster).length > 0);
  }

  /**
   * @private
   * Read trust + any explicit local-model override from the Cockpit card.
   * The router already applies the card's provider-ID `customRoster` chains via
   * setRoster(); the resolver additionally honours `localDefault` when the card
   * names an explicit local model (power-user format). Provider-ID chains are
   * NOT treated as model names here — an entry like 'ollama-local' would fail the
   * installed-check and harmlessly fall back to ModelScout's pick.
   * @returns {{ trust: string|null, localModel: string|null }}
   */
  _readCockpit() {
    const mc = this.cockpitManager?.cachedConfig?.system?.modelsConfig;
    if (!mc || typeof mc !== 'object') return { trust: null, localModel: null };
    const trust = (mc.trust === LOCAL_ONLY || mc.trust === DEFAULT_TRUST) ? mc.trust : null;
    const localModel = (typeof mc.localDefault === 'string' && mc.localDefault !== '')
      ? mc.localDefault
      : null;
    return { trust, localModel };
  }
}

module.exports = { ModelResolver };
