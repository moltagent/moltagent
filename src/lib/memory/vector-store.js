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

/*
 * Architecture Brief
 * ------------------
 * Problem: Semantic search requires comparing query embeddings against stored
 * knowledge embeddings, but there is no persistent vector index available in
 * the Nextcloud environment — only SQLite (via better-sqlite3) is guaranteed.
 *
 * Pattern: Brute-force cosine similarity over a SQLite BLOB store. Vectors are
 * stored as raw Float64Array byte buffers (BLOB). At search time, all vectors
 * are read from disk, decoded in-process, and ranked by cosine similarity.
 * This is intentionally simple: the knowledge corpus is expected to stay small
 * enough (< 10k rows) that a full scan is sub-millisecond.
 *
 * Key Dependencies:
 *   - better-sqlite3: synchronous SQLite driver; all DB calls are sync
 *
 * Data Flow:
 *   upsert(id, vector, meta) -> INSERT OR REPLACE -> vectors table
 *   search(query, limit, threshold) -> SELECT * -> decode each BLOB
 *     -> _cosineSimilarity() -> filter/sort -> return ranked results
 *
 * Dependency Map:
 *   vector-store.js depends on: better-sqlite3 (npm)
 *   Used by: semantic-search pipeline, knowledge indexers
 */

const Database = require('better-sqlite3');

/**
 * SQLite-backed vector store for brute-force cosine similarity search.
 *
 * Vectors are stored as Float64Array blobs. All database operations use
 * prepared statements for performance. The store is safe for concurrent
 * readers under WAL mode, but only one writer should operate at a time
 * (better-sqlite3 is synchronous and single-connection).
 *
 * @module memory/vector-store
 */
class VectorStore {
  /**
   * @param {Object} options
   * @param {string} options.dbPath - Absolute path to the SQLite database file
   * @param {number} [options.dimensions=768] - Expected vector dimensionality (informational; not enforced at DB level)
   * @param {Object} [options.logger] - Logger instance (defaults to console)
   */
  constructor({ dbPath, dimensions = 768, logger }) {
    if (!dbPath) {
      throw new Error('VectorStore requires a dbPath');
    }

    this.dbPath = dbPath;
    this.dimensions = dimensions;
    this.logger = logger || console;
    this._closed = false;

    this.db = new Database(dbPath);

    // WAL mode improves read concurrency — readers don't block writers
    this.db.pragma('journal_mode = WAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vectors (
        id         TEXT PRIMARY KEY,
        vector     BLOB NOT NULL,
        title      TEXT,
        source     TEXT,
        updated_at TEXT
      )
    `);

    // Prepare statements once; reuse for every call
    this._stmtUpsert = this.db.prepare(`
      INSERT OR REPLACE INTO vectors (id, vector, title, source, updated_at)
      VALUES (@id, @vector, @title, @source, @updated_at)
    `);

    this._stmtSelectAll = this.db.prepare(`
      SELECT id, vector, title, source FROM vectors
    `);

    this._stmtDelete = this.db.prepare(`
      DELETE FROM vectors WHERE id = ?
    `);

    this._stmtCount = this.db.prepare(`
      SELECT COUNT(*) AS cnt FROM vectors
    `);
  }

  /**
   * Insert or replace a vector and its metadata.
   *
   * @param {string} id - Unique identifier for this vector (e.g., wiki page path)
   * @param {Float64Array} vector - Embedding vector; must have `this.dimensions` elements
   * @param {Object} [metadata={}] - Optional metadata
   * @param {string} [metadata.title] - Human-readable label for the document
   * @param {string} [metadata.source] - Origin of the document (URL, path, etc.)
   * @returns {void}
   */
  upsert(id, vector, metadata = {}) {
    if (!id || id == null) {
      throw new Error('VectorStore.upsert: id is required');
    }
    if (!(vector instanceof Float64Array)) {
      throw new Error('VectorStore.upsert: vector must be a Float64Array');
    }
    this._assertOpen();

    const blob = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);

    this._stmtUpsert.run({
      id: String(id),
      vector: blob,
      title: metadata.title != null ? String(metadata.title) : null,
      source: metadata.source != null ? String(metadata.source) : null,
      updated_at: new Date().toISOString()
    });
  }

  /**
   * Brute-force cosine similarity search across all stored vectors.
   *
   * Reads every row from SQLite, decodes each BLOB, computes cosine
   * similarity against the query vector, filters by threshold, sorts
   * descending, and returns the top `limit` results.
   *
   * @param {Float64Array} queryVector - The query embedding
   * @param {number} [limit=5] - Maximum number of results to return
   * @param {number} [threshold=0.3] - Minimum cosine similarity score (0–1)
   * @returns {Array<{id: string, title: string|null, source: string|null, score: number}>}
   */
  search(queryVector, limit = 5, threshold = 0.3) {
    if (!(queryVector instanceof Float64Array)) {
      throw new Error('VectorStore.search: queryVector must be a Float64Array');
    }
    this._assertOpen();

    // Clamp limit to a positive integer
    const maxResults = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 5;
    // Clamp threshold to [0, 1]
    const minScore = Number.isFinite(threshold) ? Math.min(1, Math.max(0, threshold)) : 0.3;

    const rows = this._stmtSelectAll.all();

    if (rows.length === 0) {
      return [];
    }

    const scored = [];

    for (const row of rows) {
      let storedVector;
      try {
        storedVector = this._bufferToVector(row.vector);
      } catch (err) {
        // Corrupt blob — skip this row rather than crashing the search
        this.logger.warn(`[VectorStore] Skipping corrupt vector for id="${row.id}": ${err.message}`);
        continue;
      }

      const score = this._cosineSimilarity(queryVector, storedVector);

      if (score >= minScore) {
        scored.push({
          id: row.id,
          title: row.title,
          source: row.source,
          score
        });
      }
    }

    // Sort descending by similarity score
    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, maxResults);
  }

  /**
   * Delete a vector by its id.
   *
   * @param {string} id - The id to delete
   * @returns {boolean} True if a row was deleted, false if the id was not found
   */
  delete(id) {
    if (!id || id == null) {
      throw new Error('VectorStore.delete: id is required');
    }
    this._assertOpen();

    const result = this._stmtDelete.run(String(id));
    return result.changes > 0;
  }

  /**
   * Return the total number of vectors stored.
   *
   * @returns {number}
   */
  count() {
    this._assertOpen();
    const row = this._stmtCount.get();
    return row.cnt;
  }

  /**
   * Retrieve metadata for a vector by id (synchronous).
   * Returns null if not found.
   *
   * @param {string} id - The vector id to look up
   * @returns {{ title: string|null, source: string|null, updated_at: string|null }|null}
   */
  getMetadata(id) {
    if (!id) return null;
    this._assertOpen();

    if (!this._stmtGetMeta) {
      this._stmtGetMeta = this.db.prepare(
        'SELECT title, source, updated_at FROM vectors WHERE id = ?'
      );
    }

    const row = this._stmtGetMeta.get(String(id));
    return row || null;
  }

  /**
   * Close the SQLite connection.
   * Subsequent calls to any public method will throw.
   * Calling close() more than once is a no-op.
   */
  close() {
    if (this._closed) {
      return;
    }
    this._closed = true;
    this.db.close();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Compute cosine similarity between two Float64Arrays.
   *
   * Returns 0 for zero-magnitude vectors to avoid division by zero.
   *
   * @private
   * @param {Float64Array} a
   * @param {Float64Array} b
   * @returns {number} Cosine similarity in [−1, 1]; practically [0, 1] for embeddings
   */
  _cosineSimilarity(a, b) {
    const len = Math.min(a.length, b.length);
    if (len === 0) return 0;

    let dot = 0;
    let magA = 0;
    let magB = 0;

    for (let i = 0; i < len; i++) {
      dot += a[i] * b[i];
      magA += a[i] * a[i];
      magB += b[i] * b[i];
    }

    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    if (denom === 0) return 0;

    return dot / denom;
  }

  /**
   * Convert a Buffer (from SQLite BLOB) back to a Float64Array.
   *
   * @private
   * @param {Buffer} buf
   * @returns {Float64Array}
   */
  _bufferToVector(buf) {
    // Buffer may be a Node Buffer or a Uint8Array — ensure we have an ArrayBuffer
    // with the correct byte range before wrapping in Float64Array.
    const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    return new Float64Array(arrayBuffer);
  }

  /**
   * Throw if the store has been closed, preventing use of an invalid DB handle.
   * @private
   */
  _assertOpen() {
    if (this._closed) {
      throw new Error('VectorStore has been closed');
    }
  }
}

module.exports = VectorStore;
