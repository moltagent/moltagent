/*
 * MoltAgent - Sovereign AI Security Layer
 * Copyright (C) 2026 MoltAgent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

'use strict';

/**
 * EmbeddingRefresher — periodic wiki-page re-vectorisation for semantic search.
 *
 * Architecture Brief:
 * - Problem: Vector store grows stale as wiki pages are edited; cold-start has no vectors at all
 * - Pattern: Tick-driven incremental refresh — process at most 2 pages per heartbeat to stay cheap;
 *   bootstrap from scratch on first tick if the store is empty
 * - Key Dependencies: EmbeddingClient (Ollama), VectorStore (upsert/count/metadata), CollectivesClient
 * - Data Flow: tick() → resolveCollective() → listPages() → check updated_at vs 24h threshold
 *              → readPageContent(path) → embed → upsert
 * - Dependency Map: heartbeat-manager.js → embedding-refresher.js → embedding-client.js
 *                                                                   → vector-store (injected)
 *                                                                   → collectives-client.js
 *
 * @module memory/embedding-refresher
 * @version 1.1.0
 */

/** Pages that have not been re-embedded within this window are considered stale. */
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Maximum pages processed per tick() invocation. */
const MAX_PER_TICK = 2;

class EmbeddingRefresher {
  /**
   * @param {Object} deps
   * @param {Object} deps.embeddingClient  - EmbeddingClient instance (embed(text) → Float64Array)
   * @param {Object} deps.vectorStore      - VectorStore instance (upsert / count / getMetadata)
   * @param {Object} deps.collectivesClient - CollectivesClient (resolveCollective / listPages / readPageContent)
   * @param {Object} [deps.ncFilesClient]  - NCFilesClient (unused directly but kept for symmetry)
   * @param {Object} [deps.logger]         - Logger (defaults to console)
   */
  constructor({ embeddingClient, vectorStore, collectivesClient, ncFilesClient, logger } = {}) {
    if (!embeddingClient) throw new Error('EmbeddingRefresher requires embeddingClient');
    if (!vectorStore) throw new Error('EmbeddingRefresher requires vectorStore');
    if (!collectivesClient) throw new Error('EmbeddingRefresher requires collectivesClient');

    this.embedder = embeddingClient;
    this.store = vectorStore;
    this.collectives = collectivesClient;
    // ncFilesClient is accepted for forward-compatibility but not used yet
    this.ncFiles = ncFilesClient || null;
    this.logger = logger || console;

    /** Set to true after the first tick so we never bootstrap again. */
    this._bootstrapped = false;
    /** Pages with no content — skip in stale queue to avoid blocking real candidates. */
    this._emptyPages = new Set();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Full re-embed of every wiki page regardless of staleness.
   * Intended for manual invocation or initial bootstrap when the store is empty.
   *
   * @returns {Promise<{ processed: number, errors: number }>}
   */
  async refreshAll() {
    if (!this._dependenciesReady()) {
      this.logger.warn('[EmbeddingRefresher] refreshAll() called with missing dependencies — skipping');
      return { processed: 0, errors: 0 };
    }

    let processed = 0;
    let errors = 0;

    let pages;
    try {
      pages = await this._getPages();
    } catch (err) {
      this.logger.warn(`[EmbeddingRefresher] refreshAll: getPages failed — ${err.message}`);
      return { processed: 0, errors: 1 };
    }

    if (!Array.isArray(pages) || pages.length === 0) {
      this.logger.info('[EmbeddingRefresher] refreshAll: no pages found, nothing to embed');
      return { processed: 0, errors: 0 };
    }

    this.logger.info(`[EmbeddingRefresher] refreshAll: processing ${pages.length} pages`);

    for (const page of pages) {
      const title = page && page.title;
      if (!title) continue;

      try {
        const embedded = await this._embedAndUpsert(page);
        if (embedded) processed++;
      } catch (err) {
        errors++;
        this.logger.warn(`[EmbeddingRefresher] refreshAll: failed to embed "${title}" — ${err.message}`);
      }
    }

    this.logger.info(
      `[EmbeddingRefresher] refreshAll complete: processed=${processed}, errors=${errors}`
    );
    return { processed, errors };
  }

  /**
   * Manual trigger alias for refreshAll(). Intended for admin commands and testing.
   * Identical to refreshAll() but exists as a distinct method for clarity in the API.
   *
   * @returns {Promise<{ processed: number, errors: number }>}
   */
  async backfillAll() {
    return this.refreshAll();
  }

  /**
   * Re-embed only pages modified since their last embedding (> 24 h ago).
   * Cheaper than refreshAll — suitable for periodic scheduled runs.
   *
   * @returns {Promise<{ processed: number, errors: number }>}
   */
  async refreshStale() {
    if (!this._dependenciesReady()) {
      this.logger.warn('[EmbeddingRefresher] refreshStale() called with missing dependencies — skipping');
      return { processed: 0, errors: 0 };
    }

    let processed = 0;
    let errors = 0;

    let pages;
    try {
      pages = await this._getPages();
    } catch (err) {
      this.logger.warn(`[EmbeddingRefresher] refreshStale: getPages failed — ${err.message}`);
      return { processed: 0, errors: 1 };
    }

    if (!Array.isArray(pages) || pages.length === 0) {
      return { processed: 0, errors: 0 };
    }

    for (const page of pages) {
      const title = page && page.title;
      if (!title) continue;

      if (!this._isStale(title)) continue;

      try {
        const embedded = await this._embedAndUpsert(page);
        if (embedded) processed++;
      } catch (err) {
        errors++;
        this.logger.warn(`[EmbeddingRefresher] refreshStale: failed to embed "${title}" — ${err.message}`);
      }
    }

    if (processed > 0) {
      this.logger.info(
        `[EmbeddingRefresher] refreshStale: processed=${processed}, errors=${errors}`
      );
    }

    return { processed, errors };
  }

  /**
   * Lightweight heartbeat tick — called by HeartbeatManager.pulse().
   *
   * On the very first call, if the vector store is empty this bootstraps by
   * running a full refreshAll(). Otherwise it processes up to MAX_PER_TICK
   * (2) of the oldest (most stale) pages.
   *
   * Never throws — all errors are logged as warnings.
   *
   * @returns {Promise<{ refreshed: number, errors: number }>}
   */
  async tick() {
    if (!this._dependenciesReady()) {
      // Don't spam the log — just return silently if wiring isn't done yet
      return { refreshed: 0, errors: 0 };
    }

    let refreshed = 0;
    let errors = 0;

    try {
      // Bootstrap check — retry until the store is populated
      if (!this._bootstrapped) {
        let storeCount = 0;
        try {
          storeCount = await this.store.count();
        } catch (err) {
          this.logger.warn(`[EmbeddingRefresher] tick: store.count() failed — ${err.message}`);
        }

        if (storeCount === 0) {
          this.logger.info('[EmbeddingRefresher] tick: vector store is empty — running full bootstrap');
          const result = await this.refreshAll();
          // Only mark bootstrapped if at least one page was embedded successfully
          if (result.processed > 0) {
            this._bootstrapped = true;
          }
          return { refreshed: result.processed, errors: result.errors };
        }

        // Store already has data (e.g. survived restart) — no bootstrap needed
        this._bootstrapped = true;
      }

      // Normal incremental tick — pick the MAX_PER_TICK stalest pages
      const candidates = await this._stalestPages(MAX_PER_TICK);
      if (candidates.length > 0) {
        this.logger.info(`[EmbeddingRefresher] tick: ${candidates.length} stale page(s): ${candidates.map(p => p.title).join(', ')}`);
      }

      for (const page of candidates) {
        try {
          const embedded = await this._embedAndUpsert(page);
          if (embedded) refreshed++;
        } catch (err) {
          errors++;
          this.logger.warn(`[EmbeddingRefresher] tick: failed to embed "${page.title}" — ${err.message}`);
        }
      }
    } catch (err) {
      // Outer catch so tick() never propagates to the heartbeat loop
      errors++;
      this.logger.warn(`[EmbeddingRefresher] tick: unexpected error — ${err.message}`);
    }

    return { refreshed, errors };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Fetch all wiki pages via the CollectivesClient OCS API.
   * Handles resolveCollective() + listPages() in one call.
   *
   * @returns {Promise<Array>} Array of page objects with title, filePath, fileName, etc.
   * @private
   */
  async _getPages() {
    const collectiveId = await this.collectives.resolveCollective();
    return await this.collectives.listPages(collectiveId);
  }

  /**
   * Build the WebDAV content path for a page from its OCS metadata.
   *
   * @param {Object} page - Page object from listPages()
   * @returns {string} Path suitable for readPageContent()
   * @private
   */
  _pagePath(page) {
    if (page.filePath && page.fileName) {
      return `${page.filePath}/${page.fileName}`;
    }
    if (page.fileName) {
      return page.fileName;
    }
    // Fallback: title-based path (less reliable but better than nothing)
    return `${page.title}/Readme.md`;
  }

  /**
   * Read, embed, and upsert a single wiki page.
   *
   * @param {Object} page - Page object from listPages() (must have title, filePath, fileName)
   * @returns {Promise<boolean>} true if embedded, false if skipped (empty/null content)
   * @throws {Error} If embedding or upsert fails
   * @private
   */
  async _embedAndUpsert(page) {
    const path = this._pagePath(page);
    const content = await this.collectives.readPageContent(path);

    // readPageContent returns null for 404; skip rather than embed empty string.
    // Track empty pages so they don't permanently block the stale queue.
    if (!content || typeof content !== 'string' || content.trim() === '') {
      this._emptyPages.add(page.title);
      return false;
    }

    const vector = await this.embedder.embed(content);

    await this.store.upsert(page.title, vector, {
      title: page.title,
      source: 'wiki',
      updated_at: new Date().toISOString()
    });

    this.logger.info(`[EmbeddingRefresher] Embedded: ${page.title}`);
    return true;
  }

  /**
   * Determine whether a page is stale (> 24 h since last embedding).
   * Reads metadata from the vector store; pages not yet in the store are
   * always considered stale.
   *
   * @param {string} title - Page title
   * @returns {boolean}
   * @private
   */
  _isStale(title) {
    try {
      // getMetadata is a synchronous lookup — throws or returns null if absent
      const meta = this.store.getMetadata(title);
      if (!meta || !meta.updated_at) return true;

      const lastEmbed = new Date(meta.updated_at).getTime();
      if (!Number.isFinite(lastEmbed)) return true;

      return (Date.now() - lastEmbed) > STALE_THRESHOLD_MS;
    } catch {
      // If we can't determine staleness, treat as stale to be safe
      return true;
    }
  }

  /**
   * Return page objects of up to `limit` pages sorted by oldest embedding first.
   * Pages not in the vector store rank as oldest (epoch 0).
   *
   * @param {number} limit
   * @returns {Promise<Object[]>} Page objects ready for _embedAndUpsert()
   * @private
   */
  async _stalestPages(limit) {
    let pages;
    try {
      pages = await this._getPages();
    } catch (err) {
      this.logger.warn(`[EmbeddingRefresher] _stalestPages: getPages failed — ${err.message}`);
      return [];
    }

    if (!Array.isArray(pages) || pages.length === 0) return [];

    // Score each page by its last embedded timestamp (0 = never embedded)
    const scored = pages
      .filter(p => p && p.title && !this._emptyPages.has(p.title))
      .map(p => {
        let ts = 0;
        try {
          const meta = this.store.getMetadata(p.title);
          if (meta && meta.updated_at) {
            const parsed = new Date(meta.updated_at).getTime();
            if (Number.isFinite(parsed)) ts = parsed;
          }
        } catch {
          // Absent metadata → ts stays 0 (oldest)
        }
        return { page: p, ts };
      });

    // Sort ascending by timestamp so oldest come first
    scored.sort((a, b) => a.ts - b.ts);

    // Only return pages that are actually stale — no point re-embedding fresh ones
    const stale = scored.filter(s => (Date.now() - s.ts) > STALE_THRESHOLD_MS);

    return stale.slice(0, limit).map(s => s.page);
  }

  /**
   * Guard: verify the minimum required dependencies are present before doing work.
   *
   * @returns {boolean}
   * @private
   */
  _dependenciesReady() {
    return (
      this.embedder !== null &&
      this.store !== null &&
      this.collectives !== null &&
      typeof this.embedder.embed === 'function' &&
      typeof this.store.upsert === 'function' &&
      typeof this.store.count === 'function' &&
      typeof this.collectives.resolveCollective === 'function' &&
      typeof this.collectives.listPages === 'function' &&
      typeof this.collectives.readPageContent === 'function'
    );
  }
}

module.exports = EmbeddingRefresher;
