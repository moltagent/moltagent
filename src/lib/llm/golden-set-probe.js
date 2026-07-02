/**
 * SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2026 Moltagent contributors
 *
 * GoldenSetProbe — Measure classification accuracy per language instead of
 * proxying correctness by model size.
 *
 * Problem:
 *   ModelScout's classification roster picks the smallest text-generation
 *   model on the box (latency wins, classification "needs no depth" — a size
 *   prior). But classification is the one job with ground truth: a message
 *   either gets the right gate/domain or it does not. A size prior is a
 *   proxy; measured accuracy is the real signal, and it is cheap to measure
 *   once at boot against a small labeled fixture.
 *
 * Pattern:
 *   For each roster candidate (smallest first), replay the fixture's labeled
 *   messages through the SAME classification path production uses
 *   (`classifyFn`, injected — the probe never builds its own prompt) and
 *   score per language. The smallest candidate that clears the accuracy bar
 *   in every language wins; if none does, the least-bad candidate is chosen
 *   and the gap is logged loudly rather than silently degrading. Results are
 *   cached on disk keyed by model digest + fixture version, so a restart
 *   does not re-run the (expensive) LLM calls unless the model or the
 *   fixture changed.
 *
 * Data Flow:
 *   webhook-server (boot, after ModelScout.discover + ModelResolver.refresh)
 *     → new GoldenSetProbe({ classifyFn: intentRouter.probeClassify, ... })
 *     → probe.run(modelScout.getClassificationCandidates())
 *       → modelResolver.setGroundTruthOverride('classification', winner)
 *
 * Dependency Map:
 *   src/lib/llm/golden-set-probe.js
 *     ← (no internal imports — standalone, testable in isolation; callers
 *        inject classifyFn and the parsed fixture)
 *
 * @module llm/golden-set-probe
 * @license AGPL-3.0
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_THRESHOLD = 0.75;
const CACHE_FILENAME = 'golden-set-probe.json';

// Bump when the MEANING of a cached score changes even though model digest and
// fixture are identical — e.g. the decoding options probeClassify pins (m2:
// temperature 0 + fixed seed, #232). Old-revision entries then miss the cache
// and the candidate is re-measured under the new semantics instead of a stale
// score masquerading as comparable.
const MEASUREMENT_REV = 2;

// Reserved cache-file key holding the seated selection (hysteresis state, #232).
// Never collides with measurement keys, which always contain the fixture salt.
const SELECTION_KEY = '__selection__';

class GoldenSetProbe {
  /**
   * @param {Object} opts
   * @param {Function} [opts.classifyFn] - async (model, message, langCode) =>
   *   ({ gate, domain }). Production injects the real classification path
   *   (IntentRouter.probeClassify); tests inject a fake. The probe never
   *   builds its own prompt — it scores exactly what production consumes.
   * @param {Object} [opts.fixture] - Parsed golden-set fixture:
   *   { version, threshold, languages: { EN:[...], DE:[...], PT:[...] } }.
   * @param {string} [opts.cacheDir] - Directory for the results cache.
   *   Defaults to `data/` under the process cwd.
   * @param {Object} [opts.logger=console]
   */
  constructor({ classifyFn, fixture, cacheDir, logger } = {}) {
    this.classifyFn = typeof classifyFn === 'function' ? classifyFn : null;
    this.fixture = fixture || null;
    this.cacheDir = cacheDir || path.resolve(process.cwd(), 'data');
    this._cacheFile = path.join(this.cacheDir, CACHE_FILENAME);
    this.logger = logger || console;

    // In-memory scores for the candidates most recently run(), keyed the
    // same way as the on-disk cache. select() reads only this — it makes
    // no classifyFn calls, so it is safe to call repeatedly/synchronously
    // after run() without re-probing.
    this._scores = {};

    // The seated model from a previous cycle (hysteresis, #232). Loaded from
    // the cache file by run(); tests may set it directly. select() consults it:
    // a passing incumbent keeps the seat unless a SMALLER challenger clears the
    // bar by at least one fixture example's worth of accuracy, or the incumbent
    // itself drops below the bar.
    this._incumbent = null;
  }

  /**
   * Read and parse a golden-set fixture file. A static helper so callers
   * (webhook-server) can load the default fixture without instantiating a
   * probe first. Throws on a missing/corrupt file — the caller decides how
   * to handle probe setup failure (boot must not be delayed by this).
   * @param {string} filePath
   * @returns {Object} parsed fixture
   */
  static loadFixture(filePath) {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  }

  /**
   * Run the probe over `candidates` (smallest-first) and select a winner.
   * For each candidate, reuses cached per-language scores when the on-disk
   * cache already has an entry for its digest+fixture-version; otherwise
   * replays every fixture example through classifyFn and persists the
   * result. Only the classifyFn calls are cache-gated — selection itself
   * always re-runs against the (possibly cached) scores.
   * @param {Array<{name: string, paramSize?: number, digest?: string}>} candidates
   * @returns {Promise<{model: string|null, scores: Object|null, passed: boolean, reason: string}>}
   */
  async run(candidates) {
    const list = Array.isArray(candidates) ? candidates.filter(c => c && typeof c.name === 'string') : [];
    if (list.length === 0) {
      return this.select(list);
    }
    if (!this.classifyFn || !this.fixture || !this.fixture.languages) {
      this.logger.warn('[GoldenSetProbe] Missing classifyFn or fixture; skipping probe.');
      return this.select(list);
    }

    const diskCache = this._loadCache();
    let cacheChanged = false;

    // Restore the seated model from a previous cycle so hysteresis survives
    // restarts. Only the identity is restored — its scores still have to come
    // from a current-revision measurement below to count.
    if (typeof diskCache[SELECTION_KEY]?.model === 'string') {
      this._incumbent = diskCache[SELECTION_KEY].model;
    }

    for (const candidate of list) {
      const key = this._cacheKey(candidate);
      const cached = diskCache[key];
      if (cached && cached.scores) {
        this._scores[key] = cached.scores;
        continue;
      }

      const scores = {};
      let complete = true;
      for (const [lang, items] of Object.entries(this.fixture.languages)) {
        const examples = Array.isArray(items) ? items : [];
        let correct = 0;
        let errored = 0;
        for (const item of examples) {
          try {
            // Sequential by design: one Ollama model can't usefully serve
            // concurrent classify calls at boot.
            const predicted = await this.classifyFn(candidate.name, item.message, lang);
            if (predicted && predicted.gate === item.gate &&
                (item.domain === null || predicted.domain === item.domain)) {
              correct++;
            }
          } catch (err) {
            errored++;
            this.logger.warn(`[GoldenSetProbe] classifyFn failed for ${candidate.name}/${lang}#${item.id}: ${err.message}`);
          }
        }
        // Any classify error means this language was not fully measured — a
        // distorted (deflated) accuracy, typically because Ollama is cold or
        // down at boot (MEMORY #124: qwen3:8b cold-start can exceed 60s). A
        // deflated score must NOT be cached as authoritative, or the digest+
        // version key would hit forever and the probe would serve poisoned
        // zeros until someone deletes the cache file by hand.
        if (errored > 0) complete = false;
        scores[lang] = examples.length > 0 ? correct / examples.length : 0;
      }

      if (complete) {
        diskCache[key] = { scores, at: new Date().toISOString() };
        this._scores[key] = scores;
        cacheChanged = true;
      } else {
        // Incomplete measurement: neither persist nor trust it. Leaving it out
        // of _scores means select() treats this model as unmeasured (not a
        // passer, not a poisoned failer), and the next boot retries it.
        this.logger.warn(`[GoldenSetProbe] ${candidate.name}: measurement incomplete (Ollama cold/unavailable?); not caching, will retry next boot.`);
      }
    }

    const result = this.select(list);

    // Persist the seat only for a passing winner: a least-bad pick is not a
    // seated incumbent (it holds nothing against future passers). Clearing on
    // a no-passer cycle means hysteresis never protects a below-bar model.
    const seated = result.passed ? result.model : null;
    if (seated !== (diskCache[SELECTION_KEY]?.model ?? null)) {
      if (seated) diskCache[SELECTION_KEY] = { model: seated, at: new Date().toISOString() };
      else delete diskCache[SELECTION_KEY];
      cacheChanged = true;
    }
    this._incumbent = seated;

    if (cacheChanged) this._saveCache(diskCache);

    if (!result.passed && result.model) {
      const threshold = this._threshold();
      const weak = Object.entries(result.scores || {})
        .filter(([, v]) => (Number.isFinite(v) ? v : 0) < threshold)
        .map(([lang]) => lang);
      this.logger.warn(
        `[GoldenSetProbe] No local model clears the classification bar in all languages ` +
        `(${result.reason}). Selecting ${result.model} as least-bad — the deployer's ` +
        `models classify ${weak.join('/') || 'one or more languages'} poorly.`
      );
    }
    return result;
  }

  /**
   * Select a winner from already-collected/cached per-language scores
   * (never calls classifyFn — pure w.r.t. this probe's in-memory state).
   * Among candidates that pass every language's threshold, the first
   * (smallest, since candidates are smallest-first) wins. If none pass,
   * the candidate with the highest minimum-language score is chosen and
   * marked `passed: false`.
   *
   * Hysteresis (#232): a hard threshold on a noisy measurement has no stable
   * fixed point at the boundary, so a seated incumbent (`this._incumbent`)
   * that still passes keeps the seat unless a smaller challenger clears the
   * bar by at least one fixture example's worth of accuracy (with a
   * 12-example fixture, +1/12 ≈ 0.084). The incumbent loses the seat only by
   * dropping below the bar itself. Larger challengers never displace a
   * passing incumbent — smallest-passer preference already excludes them.
   * @param {Array<{name: string, digest?: string}>} candidates
   * @returns {{model: string|null, scores: Object|null, passed: boolean, reason: string}}
   */
  select(candidates) {
    const list = Array.isArray(candidates) ? candidates.filter(c => c && typeof c.name === 'string') : [];
    if (list.length === 0) {
      return { model: null, scores: null, passed: false, reason: 'no candidates' };
    }

    const languages = Object.keys((this.fixture && this.fixture.languages) || {});
    const threshold = this._threshold();

    const evaluated = list.map(candidate => {
      const key = this._cacheKey(candidate);
      const scores = this._scores[key] || {};
      const langScores = languages.map(lang => (Number.isFinite(scores[lang]) ? scores[lang] : 0));
      const passesAll = languages.length > 0 && langScores.every(s => s >= threshold);
      const minScore = langScores.length > 0 ? Math.min(...langScores) : 0;
      return { candidate, scores, passesAll, minScore };
    });

    // No candidate produced a usable measurement this cycle (e.g. Ollama was
    // cold at boot and every classify errored). Return no pick so the caller
    // leaves ModelScout's size-prior selection standing and retries next boot,
    // rather than overriding with — or firing a false alarm about — nothing.
    if (!evaluated.some(e => Object.keys(e.scores).length > 0)) {
      return { model: null, scores: null, passed: false, reason: 'no measurements' };
    }

    const incumbent = this._incumbent
      ? evaluated.find(e => e.candidate.name === this._incumbent && Object.keys(e.scores).length > 0)
      : null;

    if (incumbent && incumbent.passesAll) {
      // Seat defense: only a smaller, measured challenger clearing
      // bar + margin takes the seat.
      const displaceBar = threshold + this._margin();
      const incumbentIdx = evaluated.indexOf(incumbent);
      const challenger = evaluated.find((e, idx) =>
        idx < incumbentIdx && e.passesAll && e.minScore >= displaceBar
      );
      if (challenger) {
        return {
          model: challenger.candidate.name,
          scores: challenger.scores,
          passed: true,
          reason: `challenger cleared bar+margin (${challenger.minScore.toFixed(2)} >= ${displaceBar.toFixed(2)}) over incumbent ${incumbent.candidate.name}`
        };
      }
      return { model: incumbent.candidate.name, scores: incumbent.scores, passed: true, reason: 'incumbent holds seat' };
    }

    const passer = evaluated.find(e => e.passesAll);
    if (passer) {
      return { model: passer.candidate.name, scores: passer.scores, passed: true, reason: 'smallest passer' };
    }

    // No passer: pick the highest minimum-language score (least-bad).
    let best = evaluated[0];
    for (const e of evaluated) {
      if (e.minScore > best.minScore) best = e;
    }
    const reason = `best min-lang score ${best.minScore.toFixed(2)} from ${best.candidate.name}`;
    return { model: best.candidate.name, scores: best.scores, passed: false, reason };
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /** @private */
  _threshold() {
    return Number.isFinite(this.fixture?.threshold) ? this.fixture.threshold : DEFAULT_THRESHOLD;
  }

  /**
   * @private
   * One fixture example's worth of accuracy — the coarsest per-example step
   * across languages (smallest language set dominates), i.e. the smallest
   * score difference the fixture can actually resolve. Anything under it is
   * indistinguishable from measurement granularity, so a challenger must
   * clear the bar by at least this much to displace an incumbent.
   */
  _margin() {
    const counts = Object.values((this.fixture && this.fixture.languages) || {})
      .map(items => (Array.isArray(items) ? items.length : 0))
      .filter(n => n > 0);
    if (counts.length === 0) return 0;
    return 1 / Math.min(...counts);
  }

  /**
   * @private
   * Fixture salt for the cache key: the declared version PLUS a short content
   * hash of the labeled examples and threshold. Deriving from content (not the
   * hand-bumped integer alone) means editing a message or a DE/PT label
   * invalidates stale scores even when the author forgets to bump `version`.
   */
  _fixtureSalt() {
    if (this._salt) return this._salt;
    const version = Number.isFinite(this.fixture?.version) ? this.fixture.version : 0;
    const content = JSON.stringify({
      languages: (this.fixture && this.fixture.languages) || null,
      threshold: this._threshold(),
    });
    const hash = crypto.createHash('sha1').update(content).digest('hex').slice(0, 8);
    this._salt = `v${version}_m${MEASUREMENT_REV}_${hash}`;
    return this._salt;
  }

  /**
   * @private
   * Cache key: digest when present (from /api/tags), else name; salted with the
   * fixture version + content hash so any fixture change invalidates stale scores.
   */
  _cacheKey(candidate) {
    const id = (candidate && (candidate.digest || candidate.name)) || 'unknown';
    return `${id}__${this._fixtureSalt()}`;
  }

  /** @private */
  _loadCache() {
    try {
      const raw = fs.readFileSync(this._cacheFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch (_err) {
      // Missing file or corrupt JSON — start fresh.
    }
    return {};
  }

  /** @private */
  _saveCache(cache) {
    try {
      if (!fs.existsSync(this.cacheDir)) {
        fs.mkdirSync(this.cacheDir, { recursive: true });
      }
      const tmp = this._cacheFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
      fs.renameSync(tmp, this._cacheFile);
    } catch (err) {
      this.logger.warn(`[GoldenSetProbe] Failed to persist probe cache: ${err.message}`);
    }
  }
}

module.exports = GoldenSetProbe;
