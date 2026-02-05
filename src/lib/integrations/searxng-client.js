'use strict';

/**
 * SearXNG JSON API Client
 *
 * Lightweight client for querying a self-hosted SearXNG instance.
 * Uses native fetch() (Node 22) with AbortSignal timeout.
 *
 * @module integrations/searxng-client
 * @version 1.0.0
 */

class SearXNGError extends Error {
  constructor(message, statusCode = 0, response = null) {
    super(message);
    this.name = 'SearXNGError';
    this.statusCode = statusCode;
    this.response = response;
  }
}

class SearXNGClient {
  /**
   * @param {Object} options
   * @param {string} options.baseUrl - SearXNG instance URL (e.g. 'http://searxng:8080')
   * @param {Object} [options.config={}]
   * @param {number} [options.config.defaultLimit=5] - Max results per query
   * @param {number} [options.config.timeoutMs=10000] - Fetch timeout in ms
   * @param {string} [options.config.defaultEngines=''] - Comma-separated engines
   * @param {string} [options.config.defaultLanguage='en'] - Language code
   */
  constructor({ baseUrl, config = {} }) {
    if (!baseUrl) {
      throw new SearXNGError('baseUrl is required');
    }
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.defaultLimit = config.defaultLimit || 5;
    this.timeoutMs = config.timeoutMs || 10000;
    this.defaultEngines = config.defaultEngines || '';
    this.defaultLanguage = config.defaultLanguage || 'en';
  }

  /**
   * Search the web via SearXNG.
   * @param {string} query - Search query
   * @param {Object} [options={}]
   * @param {number} [options.limit] - Max results (overrides defaultLimit)
   * @param {string} [options.engines] - Comma-separated engine names
   * @param {string} [options.categories] - Category filter
   * @param {string} [options.time_range] - Time filter (day, week, month, year)
   * @returns {Promise<{results: Array, query: string, total: number}>}
   */
  async search(query, options = {}) {
    if (!query || typeof query !== 'string') {
      throw new SearXNGError('query is required and must be a string');
    }

    const limit = options.limit || this.defaultLimit;
    const lang = options.language || this.defaultLanguage;

    // Build search URL
    const params = new URLSearchParams({
      q: query,
      format: 'json',
      language: lang
    });

    const engines = options.engines || this.defaultEngines;
    if (engines) params.set('engines', engines);
    if (options.categories) params.set('categories', options.categories);
    if (options.time_range) params.set('time_range', options.time_range);

    const url = `${this.baseUrl}/search?${params.toString()}`;

    let response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw new SearXNGError(`Search timed out after ${this.timeoutMs}ms`, 0);
      }
      throw new SearXNGError(`Search request failed: ${err.message}`, 0);
    }

    if (!response.ok) {
      throw new SearXNGError(`SearXNG returned HTTP ${response.status}`, response.status);
    }

    let data;
    try {
      data = await response.json();
    } catch (err) {
      throw new SearXNGError('Failed to parse SearXNG response as JSON', response.status);
    }

    const rawResults = Array.isArray(data.results) ? data.results : [];
    const results = rawResults.slice(0, limit).map(r => ({
      title: r.title || '',
      url: r.url || '',
      content: r.content || '',
      engine: r.engine || (Array.isArray(r.engines) ? r.engines[0] : ''),
      score: r.score || 0
    }));

    return {
      results,
      query,
      total: rawResults.length
    };
  }

  /**
   * Health check - verifies SearXNG is reachable.
   * @returns {Promise<{ok: boolean, latencyMs: number}>}
   */
  async healthCheck() {
    const start = Date.now();
    try {
      const response = await fetch(`${this.baseUrl}/healthz`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      });

      if (!response.ok) {
        // Try root as fallback
        const fallback = await fetch(this.baseUrl, {
          method: 'GET',
          signal: AbortSignal.timeout(5000)
        });
        return {
          ok: fallback.ok,
          latencyMs: Date.now() - start
        };
      }

      return {
        ok: true,
        latencyMs: Date.now() - start
      };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - start
      };
    }
  }
}

module.exports = { SearXNGClient, SearXNGError };
