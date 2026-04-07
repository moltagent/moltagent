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
 * EmbeddingClient — Ollama embedding API wrapper for wiki-page vectorisation.
 *
 * Architecture Brief:
 * - Problem: Semantic search over wiki pages requires dense vector embeddings
 * - Pattern: Thin HTTP client around Ollama /api/embed; returns Float64Array per text
 * - Key Dependencies: Ollama (local inference server), native fetch (Node 18+)
 * - Data Flow: text → truncate → POST /api/embed → embeddings[0] → Float64Array
 * - Dependency Map: memory-searcher.js → embedding-client.js → Ollama HTTP API
 *
 * @module memory/embedding-client
 * @version 1.0.0
 */

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_TEXT_CHARS = 32_000;

class EmbeddingClient {
  /**
   * @param {Object} opts
   * @param {string} opts.ollamaUrl - Base URL of the Ollama server (e.g. 'http://localhost:11434')
   * @param {string} [opts.model='nomic-embed-text'] - Embedding model name
   * @param {Object} [opts.logger] - Logger instance (defaults to console)
   */
  constructor({ ollamaUrl, model = 'nomic-embed-text', logger } = {}) {
    if (!ollamaUrl) throw new Error('EmbeddingClient requires ollamaUrl');
    // Normalise: strip trailing slash so path construction is always consistent
    this.ollamaUrl = ollamaUrl.replace(/\/+$/, '');
    this.model = model;
    this.logger = logger || console;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Generate an embedding vector for a single text string.
   *
   * @param {string} text
   * @returns {Promise<Float64Array>} 768-dimensional embedding vector
   */
  async embed(text) {
    if (!text || typeof text !== 'string' || text.trim() === '') {
      throw new Error('EmbeddingClient.embed() requires a non-empty string');
    }

    const truncated = text.slice(0, MAX_TEXT_CHARS);
    const data = await this._post('/api/embed', {
      model: this.model,
      input: truncated
    });

    return this._toFloat64Array(data.embeddings[0]);
  }

  /**
   * Generate embedding vectors for an array of texts in a single request.
   * Ollama's /api/embed endpoint accepts an array as the `input` field.
   *
   * @param {string[]} texts
   * @returns {Promise<Float64Array[]>}
   */
  async embedBatch(texts) {
    if (!Array.isArray(texts)) {
      throw new Error('EmbeddingClient.embedBatch() requires an array of strings');
    }
    if (texts.length === 0) return [];

    const truncated = texts.map(t =>
      (typeof t === 'string' ? t : String(t || '')).slice(0, MAX_TEXT_CHARS)
    );

    const data = await this._post('/api/embed', {
      model: this.model,
      input: truncated
    });

    return data.embeddings.map(vec => this._toFloat64Array(vec));
  }

  /**
   * Check whether Ollama is reachable and the configured model is available.
   *
   * @returns {Promise<boolean>}
   */
  async healthCheck() {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      let response;
      try {
        response = await fetch(`${this.ollamaUrl}/api/tags`, {
          method: 'GET',
          signal: controller.signal
        });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        this.logger.warn(`[EmbeddingClient] healthCheck: /api/tags returned HTTP ${response.status}`);
        return false;
      }

      const body = await response.json();

      // body.models is an array of objects with a `name` field, e.g.:
      // { models: [{ name: 'nomic-embed-text:latest', ... }] }
      const models = Array.isArray(body.models) ? body.models : [];
      const found = models.some(m => {
        const name = (m && m.name) ? String(m.name) : '';
        // Match on the base name to handle tags like 'nomic-embed-text:latest'
        return name === this.model || name.startsWith(`${this.model}:`);
      });

      if (!found) {
        this.logger.warn(
          `[EmbeddingClient] healthCheck: model '${this.model}' not found in Ollama tags`
        );
      }

      return found;
    } catch (err) {
      this.logger.warn(`[EmbeddingClient] healthCheck failed: ${err.message}`);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * POST JSON to an Ollama endpoint with a 30-second timeout.
   *
   * @param {string} path - URL path, e.g. '/api/embed'
   * @param {Object} body - Request payload (will be JSON-serialised)
   * @returns {Promise<Object>} Parsed response body
   * @throws {Error} On non-2xx status, network error, or timeout
   */
  async _post(path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response;
    try {
      response = await fetch(`${this.ollamaUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `[EmbeddingClient] Ollama ${path} returned HTTP ${response.status}: ${text.slice(0, 200)}`
      );
    }

    const parsed = await response.json();

    if (!parsed || !Array.isArray(parsed.embeddings) || parsed.embeddings.length === 0) {
      throw new Error(
        `[EmbeddingClient] Ollama ${path} returned unexpected shape: ${JSON.stringify(parsed).slice(0, 200)}`
      );
    }

    return parsed;
  }

  /**
   * Convert a plain number array from the Ollama response to a Float64Array.
   *
   * @param {number[]} vec
   * @returns {Float64Array}
   */
  _toFloat64Array(vec) {
    if (!Array.isArray(vec) || vec.length === 0) {
      throw new Error('[EmbeddingClient] Received empty or invalid embedding vector');
    }
    return new Float64Array(vec);
  }
}

module.exports = EmbeddingClient;
