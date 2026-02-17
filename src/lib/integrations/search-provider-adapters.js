'use strict';

/**
 * Search Provider Adapters
 *
 * Commercial search API adapters for Brave, Perplexity, and Exa.
 * Each adapter follows the SearchProvider interface:
 *   search(query, options) -> { results: Array<{title, url, snippet, source, score}> }
 *
 * Also exports multi-source search utilities (normalizeUrl, multiSourceSearch).
 *
 * @module integrations/search-provider-adapters
 * @version 1.0.0
 */

// ---------------------------------------------------------------------------
// URL normalization for deduplication
// ---------------------------------------------------------------------------

/**
 * Normalize a URL for deduplication.
 * Strips protocol, www prefix, trailing slashes, query params, and fragments.
 * @param {string} url
 * @returns {string} Normalized URL string
 */
function normalizeUrl(url) {
  if (!url || typeof url !== 'string') return '';
  let normalized = url.trim().toLowerCase();
  // Strip protocol
  normalized = normalized.replace(/^https?:\/\//, '');
  // Strip www.
  normalized = normalized.replace(/^www\./, '');
  // Strip query string and fragment
  normalized = normalized.replace(/[?#].*$/, '');
  // Strip trailing slashes
  normalized = normalized.replace(/\/+$/, '');
  return normalized;
}

// ---------------------------------------------------------------------------
// Brave Search Adapter
// ---------------------------------------------------------------------------

class BraveSearchAdapter {
  /**
   * @param {Object} config
   * @param {string} config.apiKeyLabel - NC Passwords label for the API key
   * @param {Object} credentialBroker - Credential broker with borrow()/release()
   */
  constructor(config, credentialBroker, logger) {
    this.apiKeyLabel = config.apiKeyLabel || 'brave-api-key';
    this.credentialBroker = credentialBroker;
    this.logger = logger;
    this.source = 'brave';
  }

  /**
   * Search using Brave Search API.
   * @param {string} query
   * @param {Object} [options]
   * @param {number} [options.maxResults=5]
   * @param {number} [options.timeout=5000]
   * @returns {Promise<Array<{title, url, snippet, source, score}>>}
   */
  async search(query, { maxResults = 5, timeout = 5000 } = {}) {
    let credential = null;
    try {
      credential = await this.credentialBroker.borrow(this.apiKeyLabel);

      const params = new URLSearchParams({
        q: query,
        count: String(maxResults)
      });

      const response = await fetch(
        `https://api.search.brave.com/res/v1/web/search?${params}`,
        {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'Accept-Encoding': 'gzip',
            'X-Subscription-Token': credential.password
          },
          signal: AbortSignal.timeout(timeout)
        }
      );

      if (!response.ok) return [];

      const data = await response.json();
      const webResults = data.web?.results || [];

      return webResults.slice(0, maxResults).map((r, i) => ({
        title: r.title || '',
        url: r.url || '',
        snippet: r.description || '',
        source: this.source,
        score: 1.0 - (i * 0.05)
      }));
    } catch (err) {
      this.logger?.warn?.(`[BraveSearchAdapter] search failed: ${err.message}`);
      return [];
    } finally {
      if (credential) {
        this.credentialBroker.release(this.apiKeyLabel);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Perplexity Adapter
// ---------------------------------------------------------------------------

class PerplexityAdapter {
  /**
   * @param {Object} config
   * @param {string} config.apiKeyLabel - NC Passwords label for the API key
   * @param {string} [config.model='sonar'] - Model: sonar or sonar-pro
   * @param {Object} credentialBroker
   */
  constructor(config, credentialBroker, logger) {
    this.apiKeyLabel = config.apiKeyLabel || 'perplexity-api-key';
    this.model = config.model || 'sonar';
    this.credentialBroker = credentialBroker;
    this.logger = logger;
    this.source = 'perplexity';
  }

  /**
   * Search using Perplexity Sonar API.
   * @param {string} query
   * @param {Object} [options]
   * @param {number} [options.maxResults=5]
   * @param {number} [options.timeout=5000]
   * @returns {Promise<Array<{title, url, snippet, source, score}>>}
   */
  async search(query, { maxResults = 5, timeout = 5000 } = {}) {
    let credential = null;
    try {
      credential = await this.credentialBroker.borrow(this.apiKeyLabel);

      const response = await fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${credential.password}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: query }]
        }),
        signal: AbortSignal.timeout(timeout)
      });

      if (!response.ok) return [];

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content || '';
      const citations = data.citations || [];

      // Map citations to search results
      return citations.slice(0, maxResults).map((url, i) => ({
        title: `Citation ${i + 1}`,
        url: typeof url === 'string' ? url : (url.url || ''),
        snippet: i === 0 ? content.slice(0, 200) : '',
        source: this.source,
        score: 1.0 - (i * 0.05)
      }));
    } catch (err) {
      this.logger?.warn?.(`[PerplexityAdapter] search failed: ${err.message}`);
      return [];
    } finally {
      if (credential) {
        this.credentialBroker.release(this.apiKeyLabel);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Exa Adapter
// ---------------------------------------------------------------------------

class ExaAdapter {
  /**
   * @param {Object} config
   * @param {string} config.apiKeyLabel - NC Passwords label for the API key
   * @param {string} [config.searchType='auto'] - Search type: auto, neural, keyword
   * @param {Object} credentialBroker
   */
  constructor(config, credentialBroker, logger) {
    this.apiKeyLabel = config.apiKeyLabel || 'exa-api-key';
    this.searchType = config.searchType || 'auto';
    this.credentialBroker = credentialBroker;
    this.logger = logger;
    this.source = 'exa';
  }

  /**
   * Search using Exa API.
   * @param {string} query
   * @param {Object} [options]
   * @param {number} [options.maxResults=5]
   * @param {number} [options.timeout=5000]
   * @returns {Promise<Array<{title, url, snippet, source, score}>>}
   */
  async search(query, { maxResults = 5, timeout = 5000 } = {}) {
    let credential = null;
    try {
      credential = await this.credentialBroker.borrow(this.apiKeyLabel);

      const response = await fetch('https://api.exa.ai/search', {
        method: 'POST',
        headers: {
          'x-api-key': credential.password,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          query,
          numResults: maxResults,
          type: this.searchType,
          contents: { text: { maxCharacters: 500 } }
        }),
        signal: AbortSignal.timeout(timeout)
      });

      if (!response.ok) return [];

      const data = await response.json();
      const results = data.results || [];

      return results.slice(0, maxResults).map(r => ({
        title: r.title || '',
        url: r.url || '',
        snippet: r.text || '',
        source: this.source,
        score: r.score || 0.8
      }));
    } catch (err) {
      this.logger?.warn?.(`[ExaAdapter] search failed: ${err.message}`);
      return [];
    } finally {
      if (credential) {
        this.credentialBroker.release(this.apiKeyLabel);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Multi-source search with deduplication
// ---------------------------------------------------------------------------

/**
 * Query multiple search providers in parallel and deduplicate results.
 * Duplicate URLs (by normalized form) get a score boost of +0.2 per
 * additional source that returned them.
 *
 * @param {Array<{search: Function, source: string}>} providers - Provider instances
 * @param {string} query
 * @param {number} [maxResults=10]
 * @returns {Promise<Array<{title, url, snippet, source, score, sources}>>}
 */
async function multiSourceSearch(providers, query, maxResults = 10) {
  if (!providers || providers.length === 0) return [];

  const settled = await Promise.allSettled(
    providers.map(p => p.search(query, { maxResults }))
  );

  // Flatten all fulfilled results
  const allResults = [];
  for (const result of settled) {
    if (result.status === 'fulfilled' && Array.isArray(result.value)) {
      allResults.push(...result.value);
    }
  }

  // Deduplicate by normalized URL, boosting multi-source hits
  const seen = new Map(); // normalizedUrl -> merged result
  for (const r of allResults) {
    const key = normalizeUrl(r.url);
    if (!key) continue;

    if (seen.has(key)) {
      const existing = seen.get(key);
      existing.score += 0.2; // boost for each additional source
      existing.sources.push(r.source);
      // Keep the longer snippet
      if ((r.snippet || '').length > (existing.snippet || '').length) {
        existing.snippet = r.snippet;
      }
    } else {
      seen.set(key, {
        title: r.title,
        url: r.url,
        snippet: r.snippet || '',
        source: r.source,
        score: r.score || 0.5,
        sources: [r.source]
      });
    }
  }

  // Sort by score descending, return top N
  return Array.from(seen.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}

module.exports = {
  BraveSearchAdapter,
  PerplexityAdapter,
  ExaAdapter,
  normalizeUrl,
  multiSourceSearch
};
