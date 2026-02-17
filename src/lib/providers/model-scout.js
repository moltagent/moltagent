/**
 * ModelScout — Auto-discover installed Ollama models and map capabilities.
 *
 * Queries the Ollama `/api/tags` endpoint, parses model metadata,
 * and generates a local roster mapping jobs to model names.
 *
 * @module providers/model-scout
 * @version 1.0.0
 */

'use strict';

/**
 * Job affinity map: which model families/sizes are suited to which jobs.
 * Each entry lists families in preference order with optional min param size.
 * Fallback: the largest discovered model fills any unmapped job.
 */
const JOB_AFFINITY_MAP = Object.freeze({
  quick: {
    description: 'Fast, low-latency responses',
    preferred: [
      { family: 'qwen3', maxParams: 14 },
      { family: 'qwen2.5', maxParams: 14 },
      { family: 'phi', maxParams: 14 },
      { family: 'gemma', maxParams: 9 },
      { family: 'llama', maxParams: 8 }
    ]
  },
  tools: {
    description: 'Tool calling and structured output',
    preferred: [
      { family: 'qwen3' },
      { family: 'qwen2.5' },
      { family: 'mistral' },
      { family: 'llama', minParams: 8 }
    ]
  },
  thinking: {
    description: 'Multi-step reasoning',
    preferred: [
      { family: 'qwen3', minParams: 14 },
      { family: 'deepseek', minParams: 14 },
      { family: 'llama', minParams: 14 },
      { family: 'qwen3' },
      { family: 'mistral' }
    ]
  },
  writing: {
    description: 'Long-form text generation',
    preferred: [
      { family: 'qwen3', minParams: 14 },
      { family: 'llama', minParams: 14 },
      { family: 'mistral', minParams: 7 },
      { family: 'qwen3' }
    ]
  },
  research: {
    description: 'Information synthesis and analysis',
    preferred: [
      { family: 'qwen3', minParams: 14 },
      { family: 'deepseek' },
      { family: 'llama', minParams: 14 },
      { family: 'qwen3' }
    ]
  },
  coding: {
    description: 'Code generation and analysis',
    preferred: [
      { family: 'deepseek-coder' },
      { family: 'codellama' },
      { family: 'qwen2.5-coder' },
      { family: 'qwen3' },
      { family: 'deepseek' }
    ]
  }
});

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
   * Discover installed Ollama models via /api/tags.
   * Caches the result in _discovered.
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

      this._discovered = models.map(m => ({
        name: m.name || m.model,
        family: this._extractFamily(m),
        paramSize: this._extractParamSize(m),
        sizeBytes: m.size || 0,
        modifiedAt: m.modified_at || null
      }));

      this.logger.log(`[ModelScout] Discovered ${this._discovered.length} model(s): ${this._discovered.map(m => m.name).join(', ')}`);
      return this._discovered;
    } catch (err) {
      this.logger.warn(`[ModelScout] Discovery failed: ${err.message}`);
      this._discovered = [];
      return this._discovered;
    }
  }

  /**
   * Generate a local roster mapping job names to model name arrays.
   * Compatible with LLMRouter.setLocalRoster().
   * @returns {Object|null} { quick: ['model1'], thinking: ['model2'], ... } or null if no models
   */
  generateLocalRoster() {
    if (!this._discovered || this._discovered.length === 0) {
      this._roster = null;
      return null;
    }

    const roster = {};
    const largest = this._getLargestModel();

    for (const [job, affinity] of Object.entries(JOB_AFFINITY_MAP)) {
      const matched = this._getModelAffinity(job, affinity);
      if (matched.length > 0) {
        roster[job] = matched.map(m => m.name);
      } else if (largest) {
        // Fallback: use the largest model for unmapped jobs
        roster[job] = [largest.name];
      }
    }

    // credentials job always gets the largest model (most capable for sensitive ops)
    if (largest) {
      roster.credentials = [largest.name];
    }

    this._roster = roster;
    return roster;
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
      return `${m.name} (${m.family}, ${size})`;
    });

    const rosterInfo = this._roster
      ? Object.entries(this._roster).map(([job, models]) => `${job}→${models[0]}`).join(', ')
      : 'no roster';

    return `${this._discovered.length} model(s): ${lines.join(', ')} | Roster: ${rosterInfo}`;
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
    // Remove trailing numbers that represent size (e.g. 'llama3.1' → 'llama')
    // But keep version numbers like 'qwen2.5' or 'qwen3'
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

  /**
   * Check if a model matches a preferred entry from JOB_AFFINITY_MAP.
   * @param {Object} model - Parsed model descriptor
   * @param {Object} pref - { family, minParams?, maxParams? }
   * @returns {boolean}
   */
  _modelMatches(model, pref) {
    if (model.family !== pref.family && !model.family.startsWith(pref.family)) {
      return false;
    }
    if (pref.minParams && model.paramSize && model.paramSize < pref.minParams) {
      return false;
    }
    if (pref.maxParams && model.paramSize && model.paramSize > pref.maxParams) {
      return false;
    }
    return true;
  }

  /**
   * Get the largest discovered model (by param size, then file size).
   * @returns {Object|null}
   */
  _getLargestModel() {
    if (!this._discovered || this._discovered.length === 0) return null;
    return this._discovered.reduce((best, m) => {
      const bestSize = best.paramSize || 0;
      const mSize = m.paramSize || 0;
      if (mSize > bestSize) return m;
      if (mSize === bestSize && m.sizeBytes > best.sizeBytes) return m;
      return best;
    }, this._discovered[0]);
  }

  /**
   * Find models matching an affinity spec, ordered by preference.
   * @param {string} job - Job name
   * @param {Object} affinity - Affinity entry from JOB_AFFINITY_MAP
   * @returns {Array} Matching model descriptors (may be empty)
   */
  _getModelAffinity(job, affinity) {
    const matched = [];
    const seen = new Set();

    for (const pref of affinity.preferred) {
      for (const model of this._discovered) {
        if (!seen.has(model.name) && this._modelMatches(model, pref)) {
          matched.push(model);
          seen.add(model.name);
        }
      }
    }

    return matched;
  }
}

module.exports = { ModelScout, JOB_AFFINITY_MAP };
