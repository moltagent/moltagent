'use strict';

/**
 * MemorySearcher - NC Unified Search wrapper for agent memory recall
 *
 * Delegates to NCSearchClient to search across Collectives (wiki),
 * Talk messages, Files, Deck, and Calendar via the NC Unified Search
 * OCS API. No local caching — NC manages its own search index.
 *
 * Biological memory: search hits reinforce wiki pages (LTP).
 * Each wiki result returned to a user query triggers a fire-and-forget
 * access_count increment + last_accessed update on the page frontmatter.
 *
 * @module integrations/memory-searcher
 * @version 3.0.0
 */

const { mergeFrontmatter } = require('../knowledge/frontmatter');

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
   * @param {Object} [options.collectivesClient] - CollectivesClient for access tracking (LTP)
   * @param {Object} [options.logger]
   */
  constructor({ ncSearchClient, collectivesClient, logger = console }) {
    if (!ncSearchClient) throw new Error('ncSearchClient is required');
    this.nc = ncSearchClient;
    this.wiki = collectivesClient || null;
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

    // Archive fallback: if few wiki results, also check archive
    const wikiCount = results.filter(r => r.source === 'Wiki').length;
    if (wikiCount < maxResults && this.wiki) {
      try {
        const archiveResults = await this._searchArchive(query, maxResults - wikiCount);
        const existingTitles = new Set(results.map(r => r.title.toLowerCase()));
        results.push(...archiveResults.filter(a => !existingTitles.has(a.title.toLowerCase())));
      } catch (_err) { /* non-critical */ }
    }

    // Sort by source priority, then truncate
    results.sort((a, b) =>
      (SOURCE_PRIORITY[a._providerId] || 99) - (SOURCE_PRIORITY[b._providerId] || 99)
    );

    const final = results.slice(0, maxResults).map(({ _providerId, ...rest }) => rest);

    // LTP: retrieval strengthens wiki pages (fire-and-forget, deduplicated by title)
    if (this.wiki) {
      const accessedTitles = new Set();
      for (const result of final) {
        if (result.source === 'Wiki' && !result.archived && !accessedTitles.has(result.title)) {
          accessedTitles.add(result.title);
          this._recordAccess(result.title).catch(err => {
            this.logger.warn('[MemorySearcher] Access tracking failed:', err.message);
          });
        }
      }
    }

    return final;
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

  /**
   * LTP: Record an access event on a wiki page's frontmatter.
   * Increments access_count, sets last_accessed, and may auto-promote
   * confidence or extend decay_days for heavily-used pages.
   * @param {string} title - Page title
   * @returns {Promise<void>}
   */
  async _recordAccess(title) {
    const page = await this.wiki.readPageWithFrontmatter(title);
    if (!page) return;

    const now = new Date().toISOString();
    const count = (parseInt(page.frontmatter.access_count, 10) || 0) + 1;

    const updates = {
      last_accessed: now,
      access_count: count,
    };

    // Rule 3: Auto-promote confidence after sustained use
    if (count >= 10 && (page.frontmatter.confidence || 'medium') === 'medium') {
      updates.confidence = 'high';
    }

    // Rule 5: Auto-extend decay for heavily-used & verified pages
    if (count >= 20 && (parseInt(page.frontmatter.times_verified, 10) || 0) >= 2) {
      const decay = parseInt(page.frontmatter.decay_days, 10) || 90;
      if (decay > 0 && decay < 365) {
        updates.decay_days = Math.min(decay * 2, 365);
      }
    }

    const merged = mergeFrontmatter(page.frontmatter, updates);
    await this.wiki.writePageWithFrontmatter(title, merged, page.body);
  }

  /**
   * Search for archived wiki pages via NC Unified Search.
   * Filters results to those under Archive paths.
   * @param {string} query - Search query
   * @param {number} limit - Max results
   * @returns {Promise<Array>}
   */
  async _searchArchive(query, limit) {
    const entries = await this.nc.searchProvider(
      'collectives_pages_content', query, limit + 5
    );
    return entries
      .filter(e => {
        const url = (e.resourceUrl || '').toLowerCase();
        const sub = (e.subline || '').toLowerCase();
        // Match pages in archive paths OR composted pages (body contains "Archived by FreshnessChecker")
        return url.includes('/archive/') || url.includes('/archive') ||
               sub.includes('archived by freshnesschecker');
      })
      .slice(0, limit)
      .map(e => ({
        _providerId: 'collectives_pages_content',
        source: 'Wiki',
        title: e.title || '',
        excerpt: `[Archived] ${e.subline || ''}`,
        link: e.resourceUrl || '',
        archived: true,
      }));
  }
}

module.exports = MemorySearcher;
