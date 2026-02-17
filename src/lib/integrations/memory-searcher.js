'use strict';

/**
 * MemorySearcher - NC Unified Search wrapper for agent memory recall
 *
 * Delegates to NCSearchClient to search across Collectives (wiki),
 * Talk messages, Files, Deck, and Calendar via the NC Unified Search
 * OCS API. No local caching — NC manages its own search index.
 *
 * @module integrations/memory-searcher
 * @version 2.0.0
 */

/** Map scope names to NC Unified Search provider IDs */
const SCOPE_PROVIDERS = {
  all:           ['collectives_pages_content', 'talk-message', 'files'],
  wiki:          ['collectives_pages', 'collectives_pages_content'],
  people:        ['collectives_pages_content'],
  projects:      ['collectives_pages_content'],
  sessions:      ['collectives_pages_content'],
  policies:      ['collectives_pages_content'],
  conversations: ['talk-message'],
  files:         ['files'],
  tasks:         ['deck'],
  calendar:      ['calendar'],
};

/** Scopes that require client-side path filtering on Collectives results */
const FILTERED_SCOPES = new Set(['people', 'projects', 'sessions', 'policies']);

/** Source display labels */
const SOURCE_LABELS = {
  collectives_pages_content: 'Wiki',
  collectives_pages:         'Wiki',
  'talk-message':            'Conversation',
  files:                     'File',
  deck:                      'Task',
  calendar:                  'Event',
};

/** Lower number = higher priority */
const SOURCE_PRIORITY = {
  collectives_pages_content: 1,
  collectives_pages:         2,
  'talk-message':            3,
  files:                     4,
  deck:                      5,
  calendar:                  6,
};

class MemorySearcher {
  /**
   * @param {Object} options
   * @param {import('./nc-search-client').NCSearchClient} options.ncSearchClient
   * @param {Object} [options.logger]
   */
  constructor({ ncSearchClient, logger = console }) {
    if (!ncSearchClient) throw new Error('ncSearchClient is required');
    this.nc = ncSearchClient;
    this.logger = logger;
    this._providers = null;
  }

  /**
   * Discover available search providers from NC (non-blocking startup call).
   * @returns {Promise<Array<{id: string, name: string}>>}
   */
  async discoverProviders() {
    try {
      this._providers = await this.nc.getProviders();
      return this._providers;
    } catch (err) {
      this.logger.error('[MemorySearcher] discoverProviders failed:', err.message);
      return [];
    }
  }

  /**
   * Search across NC sources.
   * @param {string} query
   * @param {Object} [options]
   * @param {string} [options.scope='all']
   * @param {number} [options.maxResults=5]
   * @param {string} [options.since] - ISO date or relative (e.g. "2026-01-01")
   * @param {string} [options.until] - ISO date or relative
   * @returns {Promise<Array<{source: string, title: string, excerpt: string, link: string}>>}
   */
  async search(query, options = {}) {
    const { scope = 'all', maxResults = 5, since, until } = options;

    const providerIds = this._scopeToProviders(scope);
    if (providerIds.length === 0) return [];

    // Search all providers in parallel
    const settled = await Promise.allSettled(
      providerIds.map(pid => this._searchProvider(pid, query, { limit: maxResults, since, until }))
    );

    // Merge results, skip failures
    let results = [];
    for (const outcome of settled) {
      if (outcome.status === 'fulfilled') {
        results.push(...outcome.value);
      }
    }

    // Client-side path filter for sub-wiki scopes
    if (FILTERED_SCOPES.has(scope)) {
      results = this._filterByScope(results, scope);
    }

    // Sort by source priority, then truncate
    results.sort((a, b) =>
      (SOURCE_PRIORITY[a._providerId] || 99) - (SOURCE_PRIORITY[b._providerId] || 99)
    );

    // Strip internal field and limit
    return results.slice(0, maxResults).map(({ _providerId, ...rest }) => rest);
  }

  /**
   * Map a scope name to provider IDs.
   * @param {string} scope
   * @returns {string[]}
   */
  _scopeToProviders(scope) {
    return SCOPE_PROVIDERS[scope] || SCOPE_PROVIDERS.all;
  }

  /**
   * Search a single provider via NCSearchClient.
   * @param {string} providerId
   * @param {string} query
   * @param {Object} opts
   * @returns {Promise<Array>}
   */
  async _searchProvider(providerId, query, { limit = 5, since, until } = {}) {
    const entries = await this.nc.searchProvider(providerId, query, limit, { since, until });
    return entries.map(e => ({
      _providerId: providerId,
      source: SOURCE_LABELS[providerId] || providerId,
      title: e.title || '',
      excerpt: e.subline || '',
      link: e.resourceUrl || '',
    }));
  }

  /**
   * Filter Collectives results by scope category path.
   * @param {Array} results
   * @param {string} scope
   * @returns {Array}
   */
  _filterByScope(results, scope) {
    const category = scope.charAt(0).toUpperCase() + scope.slice(1);
    return results.filter(r => {
      // Match links containing the category name (e.g. /People/, /Projects/)
      if (!r.link) return false;
      return r.link.toLowerCase().includes(`/${category.toLowerCase()}/`) ||
             r.link.toLowerCase().includes(`/${category.toLowerCase()}`);
    });
  }
}

module.exports = MemorySearcher;
