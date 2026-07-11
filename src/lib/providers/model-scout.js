/**
 * ModelScout — Sense installed Ollama models and rank them per job.
 *
 * Queries `/api/tags` for the installed models, then `/api/show` per model for
 * its declared `capabilities` (Layer 0). Partitions the pool by capability
 * class and ranks within class by a per-job size prior (Layer 1) to produce a
 * local roster. Capability is read from what each model declares, never guessed
 * from its family name — see docs/briefings adaptive-model-selection §2, §4, §5.
 *
 * @module providers/model-scout
 * @version 2.0.0
 */

'use strict';

const { normalizeCapabilities, isDedicatedTextGenerator } = require('./capability-classes');

/**
 * Per-job prior STRENGTH — a machine-readable declaration of how much the
 * size prior is trusted for each job, so tests and Session 3 can read which
 * priors are placeholders.
 *   'latency'      — smallest-capable wins; size predicts speed, not quality
 *                    (quick: pure-latency, no answer key).
 *   'ground-truth' — NOT a size prior at all. classification defers to the
 *                    golden-set probe's per-language fixture accuracy via
 *                    ModelResolver precedence (cockpit > golden-set-probe >
 *                    model-scout > …). The size ordering ModelScout emits for
 *                    classification is a fallback only when the probe has no
 *                    measurement; the probe's ground-truth pick overrides it.
 *   'strong'       — bigger reasons/writes better on average (thinking/writing/
 *                    research/credentials).
 *   'weak'         — PLACEHOLDER. A fine-tuned mid-size model routinely beats a
 *                    larger generalist; size is a poor proxy. Session 3 replaces
 *                    this with measured performance (tools/coding).
 * @type {Readonly<Record<string,'latency'|'ground-truth'|'strong'|'weak'>>}
 */
const PRIOR_STRENGTH = Object.freeze({
  quick: 'latency',
  classification: 'ground-truth',
  thinking: 'strong',
  writing: 'strong',
  research: 'strong',
  credentials: 'strong',
  tools: 'weak',
  coding: 'weak',
});

/**
 * Minimum sensed context_length (tokens) a model must clear to serve a
 * long-context job. These jobs assemble long prompts — SOUL.md + memory
 * enrichment + living context + a multi-paragraph answer — so a model whose
 * window is below the floor would truncate silently. 8192 is deliberately
 * conservative: it is the smallest window among the reference box's text
 * models (gemma2:2b = 8192) and roughly the floor at which a full SOUL +
 * enrichment prompt still leaves room for an answer. Jobs NOT listed have no
 * floor: quick/classification are short, tools/coding are structured-output
 * (short context), credentials wants the most capable local model regardless.
 * @type {Readonly<Record<string, number>>}
 */
const CONTEXT_FLOOR = Object.freeze({
  thinking: 8192,
  writing: 8192,
  research: 8192,
});

/**
 * Minimum sensed context window for the local judge (Session 4). A judge
 * prompt carries the original task, the full judged response, and a rubric,
 * so it needs the same window the long-context jobs do.
 * @type {number}
 */
const JUDGE_CONTEXT_FLOOR = 8192;

/**
 * Parameter-size ceiling (in billions) for golden-set classification
 * candidates (#260). Classification is a latency job with a 12-example/language
 * fixture; a model larger than this is already far past what the task demands,
 * and loading a 30B+ code-specialist just to measure it evicts the serving
 * model on a single-GPU box and can starve a live request for minutes. A 34B
 * seat is never the right classification pick, so walking to it must be
 * structurally impossible, not merely unlikely. 14 is generous — well above
 * qwen3:8b, the reference box's classification winner. Models above the ceiling
 * stay available for every other job (thinking/writing/tools) through the
 * regular roster; only the probe's candidate walk is bounded. Cloud models
 * never pass through here, so the ceiling does not touch them.
 * @type {number}
 */
const CLASSIFICATION_PARAM_CEILING = 14;

class ModelScout {
  /**
   * @param {Object} config
   * @param {string} config.ollamaEndpoint - Ollama API base URL
   * @param {Object} [config.logger] - Logger instance (default: console)
   */
  constructor({ ollamaEndpoint, logger } = {}) {
    this.ollamaEndpoint = (ollamaEndpoint || 'http://localhost:11434').replace(/\/+$/, '');
    this.logger = logger || console;
    this._discovered = null;
    this._roster = null;
  }

  /**
   * Discover installed Ollama models via /api/tags, then sense each model's
   * declared capabilities via /api/show. Caches the result in _discovered.
   * @returns {Promise<Array>} Array of parsed model descriptors
   */
  async discover() {
    try {
      const url = `${this.ollamaEndpoint}/api/tags`;
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10000)
      });

      if (!response.ok) {
        throw new Error(`Ollama API returned ${response.status}`);
      }

      const data = await response.json();
      const models = data.models || [];

      const base = models.map(m => ({
        name: m.name || m.model,
        family: this._extractFamily(m),
        paramSize: this._extractParamSize(m),
        sizeBytes: m.size || 0,
        modifiedAt: m.modified_at || null,
        digest: m.digest || null
      }));

      // Layer 0 (Declared): ask each model what it can do rather than inferring
      // from its name. One /api/show per model, at boot, in parallel.
      this._discovered = await Promise.all(base.map(async (m) => {
        const { capabilities, contextLength } = await this._probeCapabilities(m.name);
        return { ...m, capabilities, contextLength };
      }));

      this.logger.log(`[ModelScout] Discovered ${this._discovered.length} model(s): ${this._discovered.map(m => `${m.name}[${m.capabilities.join('/')}]`).join(', ')}`);
      return this._discovered;
    } catch (err) {
      this.logger.warn(`[ModelScout] Discovery failed: ${err.message}`);
      this._discovered = [];
      return this._discovered;
    }
  }

  /**
   * Generate a local roster mapping job names to model-name arrays, ranked
   * best-first. Compatible with LLMRouter.setLocalRoster() and
   * ModelResolver._readScoutRoster() (which takes the first element per job).
   * @returns {Object|null} { quick: ['model1', ...], ... } or null if no models
   */
  generateLocalRoster() {
    if (!this._discovered || this._discovered.length === 0) {
      this._roster = null;
      return null;
    }

    // Layer 0 — capability gate (Declared): each job draws only from models that
    // declare the capability it needs. Embedding and vision models are excluded
    // from text-generation jobs, which they have no business serving.
    const textGen = this._discovered.filter(m => this._isTextGen(m));
    const toolCapable = textGen.filter(m => this._capsOf(m).includes('tools'));

    // Layer 1 — capacity prior (Described): rank by size. Strength varies per job.
    const smallestFirst = [...textGen].sort((a, b) => this._compareSize(a, b));
    const largestFirst = [...textGen].sort((a, b) => this._compareSize(b, a));
    const toolsLargestFirst = [...toolCapable].sort((a, b) => this._compareSize(b, a));
    const names = list => list.map(m => m.name);

    const roster = {};

    // quick / classification: latency wins and classification needs no depth,
    // so the smallest capable model leads. (context_length is carried per model
    // for future long-context gating; no current job declares a minimum.)
    if (smallestFirst.length > 0) {
      roster.quick = names(smallestFirst);
      roster.classification = names(smallestFirst);
    }

    // thinking / writing / research: size is a STRONG prior — bigger models
    // reason and write better on average — so the largest capable model leads,
    // subject to the context-length floor (a large model with a short window
    // would truncate these long prompts). Never-go-dark: if the floor empties
    // the list, fall back to the ungated largest-first list. credentials stays
    // local (enforced in ModelResolver) and wants the most capable model on the
    // box regardless of window (short, sensitive prompts) so it is UNGATED.
    if (largestFirst.length > 0) {
      roster.thinking = names(this._contextGated(largestFirst, CONTEXT_FLOOR.thinking));
      roster.writing = names(this._contextGated(largestFirst, CONTEXT_FLOOR.writing));
      roster.research = names(this._contextGated(largestFirst, CONTEXT_FLOOR.research));
      roster.credentials = names(largestFirst);
    }

    // tools / coding: size is a WEAK prior — a fine-tuned mid-size model
    // routinely beats a larger generalist, and that specialization is invisible
    // in size or a capability flag. Largest tool-capable is a placeholder only;
    // Session 3 replaces it with measured performance. If no model declares
    // `tools`, fall back to the general text roster so the box never goes dark.
    const toolRoster = toolsLargestFirst.length > 0 ? names(toolsLargestFirst) : names(largestFirst);
    if (toolRoster.length > 0) {
      roster.tools = toolRoster;
      roster.coding = toolRoster;
    }

    // A box with only embedding/vision models can serve no job here: keep the
    // return contract single-valued (null, never an empty object).
    if (Object.keys(roster).length === 0) {
      this._roster = null;
      return null;
    }

    // Flag the placeholder priors so their weakness is observable in production
    // and Session 3 knows exactly which pairings it must correct with measurement.
    this.logger.log('[ModelScout] Prior strength — tools/coding: WEAK (largest tool-capable placeholder, Session 3 replaces with measured performance); classification: GROUND-TRUTH (defers to golden-set probe).');

    this._roster = roster;
    return roster;
  }

  /**
   * Capability-eligible text-generation models, sorted smallest-first, for
   * the golden-set probe (which measures classification accuracy per
   * language rather than assuming smallest-is-best from a size prior).
   * @returns {Array<{name: string, paramSize: number|null, digest: string|null}>}
   */
  getClassificationCandidates() {
    if (!this._discovered || this._discovered.length === 0) return [];
    const textGen = this._discovered
      .filter(m => this._isTextGen(m))
      .sort((a, b) => this._compareSize(a, b));
    return this._paramCeilinged(textGen, CLASSIFICATION_PARAM_CEILING)
      .map(m => ({ name: m.name, paramSize: m.paramSize, digest: m.digest || null }));
  }

  /**
   * Every tool-capable (Declared `tools`) text-generation model, smallest-first,
   * for the tool-capability probe's idle lane (#285). The probe measures ONLY
   * the seated boot set at boot; this is the full pool the idle lane drains one
   * candidate per pulse so a model the maturation loop might later seat already
   * has a capability verdict. Same {name, paramSize, digest} shape as
   * getClassificationCandidates(); no param ceiling — tool models can be large
   * and calibration runs in downtime.
   * @returns {Array<{name: string, paramSize: number|null, digest: string|null}>}
   */
  getToolCandidates() {
    if (!this._discovered || this._discovered.length === 0) return [];
    return this._discovered
      .filter(m => this._isTextGen(m) && this._capsOf(m).includes('tools'))
      .sort((a, b) => this._compareSize(a, b))
      .map(m => ({ name: m.name, paramSize: m.paramSize, digest: m.digest || null }));
  }

  /**
   * Get a compact text summary of discovered models for status display.
   * @returns {string}
   */
  getSummary() {
    if (!this._discovered || this._discovered.length === 0) {
      return 'No local models discovered';
    }

    const lines = this._discovered.map(m => {
      const size = m.paramSize ? `${m.paramSize}B` : '?B';
      const caps = this._capsOf(m).join('/');
      return `${m.name} (${m.family}, ${size}, ${caps})`;
    });

    const rosterInfo = this._roster
      ? Object.entries(this._roster).map(([job, models]) => `${job}→${models[0]}`).join(', ')
      : 'no roster';

    return `${this._discovered.length} model(s): ${lines.join(', ')} | Roster: ${rosterInfo}`;
  }

  /**
   * Pin the local judge model (Session 4): the largest dedicated text
   * generator whose sensed context window clears the judge floor.
   *
   * Deliberately a pure Layer 0/1 read (Declared capability + Described
   * size) with no Demonstrated input: the judge grades the maturation
   * loop's judged jobs, so selecting it through ModelResolver or the
   * scorecard would make the gradee pick its own grader — the
   * self-referential loop this pin exists to prevent. Deterministic for a
   * given installed pool (size, then file size, then name), re-pinned only
   * when discovery re-runs.
   *
   * @returns {{name: string, paramSize: number|null, digest: string|null}|null}
   */
  selectJudgeModel() {
    if (!this._discovered || this._discovered.length === 0) return null;
    const eligible = this._discovered
      .filter(m => this._isTextGen(m))
      .filter(m => m.contextLength === null || m.contextLength >= JUDGE_CONTEXT_FLOOR);
    if (eligible.length === 0) return null;
    eligible.sort((a, b) => this._compareSize(b, a) || a.name.localeCompare(b.name));
    const judge = eligible[0];
    return { name: judge.name, paramSize: judge.paramSize, digest: judge.digest || null };
  }

  /**
   * The sensed descriptor for one installed model (exact-name match), for
   * consumers that need size or digest — the judge's gap weight and its
   * digest-change re-check.
   * @param {string} name
   * @returns {{name: string, paramSize: number|null, digest: string|null,
   *   capabilities: string[], contextLength: number|null}|null}
   */
  getModelInfo(name) {
    if (!this._discovered || typeof name !== 'string' || !name) return null;
    const lower = name.toLowerCase();
    return this._discovered.find(m => m.name.toLowerCase() === lower) || null;
  }

  /**
   * The generated roster chain for one job (best-first model names), from
   * the last generateLocalRoster() run. Empty when discovery hasn't run or
   * found nothing — callers treat that as "no local candidates".
   * @param {string} job
   * @returns {string[]}
   */
  rosterFor(job) {
    const chain = this._roster?.[job];
    return Array.isArray(chain) ? [...chain] : [];
  }

  /**
   * Check if a model matching the given name or family is available.
   * @param {string} nameOrFamily - Model name (e.g. 'qwen3:8b') or family (e.g. 'qwen3')
   * @returns {boolean}
   */
  hasModel(nameOrFamily) {
    if (!this._discovered) return false;
    const lower = nameOrFamily.toLowerCase();
    return this._discovered.some(m =>
      m.name.toLowerCase() === lower ||
      m.name.toLowerCase().startsWith(lower + ':') ||
      m.family.toLowerCase() === lower
    );
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Sense a model's declared capabilities via /api/show. On any failure, treat
   * the model as text-generation-capable so the box never goes dark, and log
   * the gap rather than inferring capability from the model's name.
   * @param {string} name - Model name (e.g. 'qwen3:8b')
   * @returns {Promise<{capabilities: string[], contextLength: number|null}>}
   */
  async _probeCapabilities(name) {
    try {
      const response = await fetch(`${this.ollamaEndpoint}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ model: name }),
        signal: AbortSignal.timeout(10000)
      });
      if (!response.ok) {
        throw new Error(`/api/show returned ${response.status}`);
      }
      const data = await response.json();
      const capabilities = (Array.isArray(data.capabilities) && data.capabilities.length > 0)
        ? data.capabilities.map(c => String(c).toLowerCase())
        : ['completion'];
      return { capabilities, contextLength: this._extractContextLength(data) };
    } catch (err) {
      this.logger.warn(`[ModelScout] /api/show unavailable for ${name} (${err.message}); treating as text-generation-capable`);
      return { capabilities: ['completion'], contextLength: null };
    }
  }

  /**
   * Extract the context window length from an /api/show response. Ollama nests
   * it under model_info as `<family>.context_length`.
   * @param {Object} showData - Parsed /api/show response
   * @returns {number|null}
   */
  _extractContextLength(showData) {
    const info = showData.model_info || {};
    for (const [key, value] of Object.entries(info)) {
      if (key.endsWith('context_length') && Number.isFinite(value)) return value;
    }
    if (Number.isFinite(showData.context_length)) return showData.context_length;
    return null;
  }

  /** Declared capabilities of a model, defaulting to text-generation. */
  _capsOf(model) {
    return normalizeCapabilities(model.capabilities);
  }

  /**
   * Whether a model may serve local text jobs. Delegates to the shared
   * capability-class policy (a dedicated text generator — embedding-only and
   * vision specialists excluded), so local and cloud speak one vocabulary.
   */
  _isTextGen(model) {
    return isDedicatedTextGenerator(model.capabilities);
  }

  /** Compare by capacity ascending (param size, then file size). (b,a) => largest-first. */
  _compareSize(a, b) {
    const sa = a.paramSize || 0;
    const sb = b.paramSize || 0;
    if (sa !== sb) return sa - sb;
    return (a.sizeBytes || 0) - (b.sizeBytes || 0);
  }

  /**
   * Apply a context-length floor to an already-sorted model list. A model whose
   * sensed contextLength is below the floor is excluded — UNLESS excluding would
   * empty the list, in which case the ungated list is returned (never-go-dark).
   * A null contextLength PASSES the gate: unknown is not evidence of smallness
   * (sense-don't-predict). No floor (falsy) is an identity pass-through.
   * @param {Array} sorted - models pre-sorted by the caller's prior
   * @param {number} [floor]
   * @returns {Array}
   */
  _contextGated(sorted, floor) {
    if (!floor) return sorted;
    const gated = sorted.filter(m => m.contextLength === null || m.contextLength >= floor);
    return gated.length > 0 ? gated : sorted;
  }

  /**
   * Apply a parameter-size ceiling (in billions) to an already-sorted model
   * list (#260). A model whose sensed paramSize exceeds the ceiling is excluded
   * — UNLESS excluding would empty the list, in which case the ungated list is
   * returned (never-go-dark: a box of only large models still needs a
   * classification candidate). A null paramSize PASSES the gate: unknown size
   * is not evidence of largeness (sense-don't-predict), mirroring _contextGated.
   * No ceiling (falsy) is an identity pass-through.
   * @param {Array} sorted - models pre-sorted by the caller's prior
   * @param {number} [ceiling] - billions of parameters
   * @returns {Array}
   */
  _paramCeilinged(sorted, ceiling) {
    if (!ceiling) return sorted;
    const gated = sorted.filter(m => m.paramSize === null || m.paramSize <= ceiling);
    return gated.length > 0 ? gated : sorted;
  }

  /**
   * Extract model family from Ollama model metadata.
   * @param {Object} model - Raw Ollama model object
   * @returns {string}
   */
  _extractFamily(model) {
    // Prefer details.family if available
    if (model.details?.family) {
      return model.details.family.toLowerCase();
    }
    // Fallback: parse from model name (e.g. 'qwen3:8b' → 'qwen3')
    const name = model.name || model.model || '';
    const base = name.split(':')[0];
    return base.toLowerCase();
  }

  /**
   * Extract parameter size in billions from model metadata.
   * @param {Object} model - Raw Ollama model object
   * @returns {number|null} Size in billions (e.g. 8 for 8B) or null
   */
  _extractParamSize(model) {
    // Prefer details.parameter_size (e.g. "8B", "70B")
    if (model.details?.parameter_size) {
      const match = model.details.parameter_size.match(/^([\d.]+)/);
      if (match) return parseFloat(match[1]);
    }
    // Fallback: parse from model name (e.g. 'qwen3:8b' → 8)
    const name = model.name || model.model || '';
    const tagMatch = name.match(/:(\d+\.?\d*)b/i);
    if (tagMatch) return parseFloat(tagMatch[1]);

    // Try the base name (e.g. 'llama3.1-70b')
    const baseMatch = name.match(/(\d+\.?\d*)b/i);
    if (baseMatch) return parseFloat(baseMatch[1]);

    return null;
  }
}

module.exports = { ModelScout, PRIOR_STRENGTH, CONTEXT_FLOOR, JUDGE_CONTEXT_FLOOR, CLASSIFICATION_PARAM_CEILING };
