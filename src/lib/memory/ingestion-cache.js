/*
 * Moltagent - Sovereign AI Security Layer
 * Copyright (C) 2026 Moltagent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

'use strict';

/**
 * IngestionCache — Content-hash-based deduplication for the document ingestion pipeline.
 *
 * Architecture Brief:
 * -------------------
 * Problem: DocumentIngestor re-processes files on every poll cycle even when
 * content has not changed. This wastes LLM calls, produces duplicate wiki pages,
 * and inflates entity extraction costs proportionally to corpus size.
 *
 * Pattern: SHA-256 content hash as stable identity. After a file is fully
 * processed, its content hash is persisted to a JSON cache file on disk.
 * On the next poll cycle the ingestor computes the hash of the downloaded
 * buffer and checks the cache before any LLM call is made — O(1) lookup,
 * no network traffic for unchanged files. Hash changes when content changes,
 * so updated files are always re-processed automatically.
 *
 * Key Dependencies:
 * - Node.js crypto  — SHA-256 digests
 * - Node.js fs/promises — async cache file read/write
 *
 * Data Flow:
 * DocumentIngestor.processFile()
 *   → ingestionCache.hashContent(buffer/text)
 *   → ingestionCache.isProcessed(hash)          — skip if true
 *   → [full pipeline runs]
 *   → ingestionCache.markProcessed(hash, meta)  — persist on success
 *
 * Dependency Map:
 * ingestion-cache.js
 *   ← document-ingestor.js (consumer)
 *   ← webhook-server.js    (instantiation + load())
 *
 * @module memory/ingestion-cache
 * @version 1.0.0
 */

const crypto = require('crypto');
const fs = require('fs').promises;

class IngestionCache {
  /**
   * @param {Object} [options]
   * @param {string} [options.cachePath] - Absolute path to the JSON cache file.
   *   Defaults to /opt/moltagent/data/ingestion-cache.json.
   */
  constructor({ cachePath } = {}) {
    this.cachePath = cachePath || '/opt/moltagent/data/ingestion-cache.json';
    /** @type {Object<string, {processedAt: string, filename: string, classification: string|null, entityCount: number}>} */
    this._cache = {};
  }

  /**
   * Load the persisted cache from disk. Safe to call when the file does not
   * yet exist — the cache starts empty and will be written on the first
   * markProcessed() call.
   *
   * @returns {Promise<void>}
   */
  async load() {
    try {
      const data = await fs.readFile(this.cachePath, 'utf8');
      this._cache = JSON.parse(data);
      console.log(`[IngestionCache] Loaded ${Object.keys(this._cache).length} entries`);
    } catch {
      // File missing or malformed — start fresh. This is the expected state on
      // first run; warn only if the file exists but can't be parsed.
      this._cache = {};
    }
  }

  /**
   * Flush the in-memory cache to disk. Called automatically by markProcessed().
   * Failures are logged but never thrown — a save error must never abort
   * the ingestion pipeline.
   *
   * @returns {Promise<void>}
   */
  async save() {
    try {
      await fs.writeFile(this.cachePath, JSON.stringify(this._cache, null, 2));
    } catch (err) {
      console.warn(`[IngestionCache] Save failed: ${err.message}`);
    }
  }

  /**
   * Compute a SHA-256 hex digest for the given content.
   * Accepts a Buffer or a string — both produce stable, reproducible hashes.
   *
   * @param {Buffer|string} content
   * @returns {string} 64-character lowercase hex string
   */
  hashContent(content) {
    if (!content) return crypto.createHash('sha256').update('').digest('hex');
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  /**
   * Return true when the given content hash has a persisted cache entry,
   * indicating the file was already fully processed.
   *
   * @param {string} contentHash
   * @returns {boolean}
   */
  isProcessed(contentHash) {
    if (!contentHash) return false;
    return !!this._cache[contentHash];
  }

  /**
   * Return the metadata stored for a given content hash, or null if not found.
   *
   * @param {string} contentHash
   * @returns {{processedAt: string, filename: string, classification: string|null, entityCount: number}|null}
   */
  getEntry(contentHash) {
    if (!contentHash) return null;
    return this._cache[contentHash] || null;
  }

  /**
   * Record a content hash as processed with associated metadata, then persist
   * to disk. Should only be called after the full ingestion pipeline succeeds.
   *
   * @param {string} contentHash
   * @param {Object} metadata
   * @param {string} metadata.filename
   * @param {string|null} [metadata.classification]
   * @param {number} [metadata.entityCount]
   * @returns {Promise<void>}
   */
  async markProcessed(contentHash, metadata) {
    if (!contentHash) return;
    this._cache[contentHash] = {
      processedAt: new Date().toISOString(),
      ...metadata,
    };
    await this.save();
  }

  /**
   * Return summary statistics about the cache contents.
   *
   * @returns {{totalProcessed: number, oldestEntry: string|null}}
   */
  stats() {
    const entries = Object.values(this._cache);
    if (entries.length === 0) {
      return { totalProcessed: 0, oldestEntry: null };
    }
    const oldestEntry = entries.reduce(
      (oldest, e) => (e.processedAt < oldest ? e.processedAt : oldest),
      entries[0].processedAt
    );
    return {
      totalProcessed: entries.length,
      oldestEntry,
    };
  }
}

module.exports = IngestionCache;
