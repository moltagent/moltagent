/*
 * MoltAgent - Sovereign AI Security Layer
 * Copyright (C) 2026 MoltAgent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

'use strict';

/**
 * CoAccessGraph — Mycorrhizal Network for wiki page co-access tracking.
 *
 * Architecture Brief:
 * - Problem: Search returns sparse results (≤2 hits) and misses related pages
 * - Pattern: Track which pages are accessed together; expand search with co-accessed pages
 * - Key Dependencies: NCFilesClient (WebDAV persistence at Memory/co-access-graph.json)
 * - Data Flow: search result pages → record(titles) → increment edge weights →
 *              periodic decay → getRelated(title) → expand sparse results
 * - Dependency Map: memory-searcher.js → co-access-graph.js → nc-files-client.js
 *
 * Graph structure persisted as JSON:
 * {
 *   "edges": { "PageA::PageB": 5.2, "PageA::PageC": 2.1 },
 *   "lastDecay": "2026-03-01T00:00:00Z"
 * }
 *
 * Edge keys are always sorted alphabetically (min::max) to avoid duplicates.
 * Monthly decay multiplies all weights by 0.9 and prunes edges below 1.0.
 *
 * @module memory/co-access-graph
 * @version 1.0.0
 */

const GRAPH_PATH = 'Memory/co-access-graph.json';
const DECAY_MULTIPLIER = 0.9;
const PRUNE_THRESHOLD = 1.0;
const DECAY_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SAVE_DEBOUNCE_MS = 60 * 1000; // 60 seconds

class CoAccessGraph {
  /**
   * @param {Object} deps
   * @param {import('../integrations/nc-files-client').NCFilesClient} deps.ncFilesClient
   * @param {Object} [deps.logger]
   */
  constructor({ ncFilesClient, logger } = {}) {
    if (!ncFilesClient) throw new Error('CoAccessGraph requires ncFilesClient');
    this.ncFilesClient = ncFilesClient;
    this.logger = logger || console;

    /** @type {{ edges: Object.<string, number>, lastDecay: string }} */
    this._graph = { edges: {}, lastDecay: new Date().toISOString() };
    this._loaded = false;
    this._dirty = false;
    this._lastSave = 0;
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Record co-accessed pages. For every pair of page titles in the array,
   * increment the shared edge weight by 1.0.
   *
   * Calls _load() lazily on first invocation.
   *
   * @param {string[]} pageTitles - Array of page titles accessed together
   * @returns {Promise<void>}
   */
  async record(pageTitles) {
    if (!Array.isArray(pageTitles) || pageTitles.length < 2) return;

    // Filter out nulls/undefined/empty strings before pairing
    const titles = pageTitles.filter(t => t && typeof t === 'string');
    if (titles.length < 2) return;

    await this._ensureLoaded();

    // Increment weight for every unique pair (combinatorial)
    for (let i = 0; i < titles.length; i++) {
      for (let j = i + 1; j < titles.length; j++) {
        const key = this._makeKey(titles[i], titles[j]);
        this._graph.edges[key] = (this._graph.edges[key] || 0) + 1.0;
      }
    }

    this._dirty = true;
    await this._save();
  }

  /**
   * Return top co-accessed page titles for a given title, sorted by weight
   * descending.
   *
   * @param {string} title - The page title to find related pages for
   * @param {number} [limit=3] - Maximum results to return
   * @returns {Promise<Array<{ title: string, weight: number }>>}
   */
  async getRelated(title, limit = 3) {
    if (!title || typeof title !== 'string') return [];

    await this._ensureLoaded();

    const results = [];

    for (const [key, weight] of Object.entries(this._graph.edges)) {
      const parts = key.split('::');
      if (parts.length !== 2) continue;

      const [a, b] = parts;
      if (a === title) {
        results.push({ title: b, weight });
      } else if (b === title) {
        results.push({ title: a, weight });
      }
    }

    // Sort by weight descending, take top N
    results.sort((x, y) => y.weight - x.weight);
    return results.slice(0, Math.max(0, limit));
  }

  /**
   * Monthly decay pass: multiply all edge weights by 0.9, prune edges below
   * 1.0, update lastDecay timestamp.
   *
   * @returns {Promise<void>}
   */
  async decay() {
    await this._ensureLoaded();

    const edges = this._graph.edges;
    const keys = Object.keys(edges);
    let pruned = 0;

    for (const key of keys) {
      const newWeight = edges[key] * DECAY_MULTIPLIER;
      if (newWeight < PRUNE_THRESHOLD) {
        delete edges[key];
        pruned++;
      } else {
        edges[key] = newWeight;
      }
    }

    this._graph.lastDecay = new Date().toISOString();
    this._dirty = true;

    this.logger.info(
      `[CoAccessGraph] Decay applied — ${pruned} edges pruned, ` +
      `${Object.keys(edges).length} edges remain`
    );

    // Force save after decay regardless of debounce
    this._lastSave = 0;
    await this._save();
  }

  // ===========================================================================
  // Persistence
  // ===========================================================================

  /**
   * Load graph from NC Files at Memory/co-access-graph.json.
   * Parses JSON and auto-runs decay if >30 days since lastDecay.
   * On error (404 etc.), initializes empty graph.
   *
   * @returns {Promise<void>}
   * @private
   */
  async _load() {
    try {
      const { content } = await this.ncFilesClient.readFile(GRAPH_PATH);
      const parsed = JSON.parse(content);

      // Validate structure before trusting it
      if (parsed && typeof parsed.edges === 'object' && parsed.edges !== null) {
        this._graph.edges = parsed.edges;
      } else {
        this._graph.edges = {};
      }

      this._graph.lastDecay = parsed.lastDecay || new Date().toISOString();

      this.logger.info(
        `[CoAccessGraph] Loaded — ${Object.keys(this._graph.edges).length} edges`
      );
    } catch (err) {
      // 404 on first run, or parse error — start with empty graph
      this._graph = { edges: {}, lastDecay: new Date().toISOString() };
      this.logger.info('[CoAccessGraph] No existing graph found, starting fresh');
    }

    // Auto-run decay if more than 30 days have passed since last decay
    const lastDecayMs = new Date(this._graph.lastDecay).getTime();
    if (Number.isFinite(lastDecayMs) && Date.now() - lastDecayMs > DECAY_INTERVAL_MS) {
      this.logger.info('[CoAccessGraph] >30 days since last decay, running auto-decay');
      // Set _loaded first to avoid infinite recursion via _ensureLoaded inside decay()
      this._loaded = true;
      await this.decay();
    }
  }

  /**
   * Persist graph to NC Files via ncFilesClient.writeFile().
   * Debounced: at most 1 write per 60 seconds unless forced (e.g. after decay).
   *
   * @returns {Promise<void>}
   * @private
   */
  async _save() {
    if (!this._dirty) return;

    const now = Date.now();
    if (now - this._lastSave < SAVE_DEBOUNCE_MS) {
      // Debounce: skip this write, will be flushed on next qualifying call
      return;
    }

    try {
      const payload = JSON.stringify(this._graph, null, 2);
      await this.ncFilesClient.writeFile(GRAPH_PATH, payload);
      this._lastSave = now;
      this._dirty = false;
      this.logger.info(
        `[CoAccessGraph] Saved — ${Object.keys(this._graph.edges).length} edges`
      );
    } catch (err) {
      this.logger.error(`[CoAccessGraph] Save failed: ${err.message}`);
      // _dirty remains true so next call will retry
    }
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  /**
   * Ensure graph is loaded from disk exactly once (lazy initialization).
   * @returns {Promise<void>}
   * @private
   */
  async _ensureLoaded() {
    if (!this._loaded) {
      this._loaded = true; // Set before await to prevent concurrent loads
      await this._load();
    }
  }

  /**
   * Build a canonical edge key from two page titles.
   * Sorts alphabetically so "B::A" and "A::B" map to the same key.
   *
   * @param {string} a
   * @param {string} b
   * @returns {string} e.g. "PageA::PageB"
   * @private
   */
  _makeKey(a, b) {
    return a <= b ? `${a}::${b}` : `${b}::${a}`;
  }
}

module.exports = CoAccessGraph;
