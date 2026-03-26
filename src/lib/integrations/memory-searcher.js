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
 * Three-channel search fusion: keyword (NC Unified Search), vector
 * (local embeddings), and graph (knowledge graph traversal) results
 * are scored and merged with configurable channel weights.
 *
 * @module integrations/memory-searcher
 * @version 4.0.0
 */

const { mergeFrontmatter } = require('../knowledge/frontmatter');

/** Channel weights for three-channel fusion scoring */
const CHANNEL_WEIGHTS = { keyword: 0.4, vector: 0.35, graph: 0.25 };

/** Map scope names to NC Unified Search provider IDs */
const SCOPE_PROVIDERS = {
  all:           ['collectives-pages', 'collectives-page-content', 'files'],
  wiki:          ['collectives-pages', 'collectives-page-content'],
  people:        ['collectives-page-content'],
  projects:      ['collectives-page-content'],
  sessions:      ['collectives-page-content'],
  policies:      ['collectives-page-content'],
  conversations: ['talk-message'],
  files:         ['files'],
  tasks:         ['deck'],
  calendar:      ['calendar'],
};

/** Scopes that require client-side path filtering on Collectives results */
const FILTERED_SCOPES = new Set(['people', 'projects', 'sessions', 'policies']);

/** Source display labels */
const SOURCE_LABELS = {
  'collectives-page-content': 'Wiki',
  'collectives-pages':         'Wiki',
  'talk-message':              'Conversation',
  files:                       'File',
  deck:                        'Task',
  calendar:                    'Event',
};

/** Lower number = higher priority */
const SOURCE_PRIORITY = {
  'collectives-page-content': 1,
  'collectives-pages':         2,
  'talk-message':              3,
  files:                       4,
  deck:                        5,
  calendar:                    6,
};

// Score multipliers by frontmatter type. Entity pages with structured
// knowledge rank highest; infrastructure and reference stubs rank lowest.
// The type comes from page frontmatter (populated by page-templates.js
// and document-ingestor.js), cached via _typeCache in MemorySearcher.
const TYPE_SCORE = Object.freeze({
  person:               2.0,
  project:              2.0,
  organization:         2.0,
  procedure:            2.0,
  decision:             2.0,
  research:             1.5,
  meta:                 0.3,
  'document-ref':       0.5,
  session_transcript:   0.7,
});

/**
 * Score multiplier based on page type from frontmatter.
 * Falls back to 1.0 for unknown types — no path regex needed.
 * @param {Object} result - Search result
 * @param {Map} typeCache - title → frontmatter type cache
 * @returns {number} Multiplier
 */
function _pageScoreMultiplier(result, typeCache) {
  const title = result.title || '';
  const type = typeCache?.get(title);
  if (type && TYPE_SCORE[type] !== undefined) return TYPE_SCORE[type];

  // Fallback: infer type from URL path when typeCache has no entry.
  // Catches pages not yet accessed (no frontmatter read) but in known sections.
  const link = (result.link || '').toLowerCase();
  if (link.includes('/people/'))        return TYPE_SCORE.person;
  if (link.includes('/organizations/')) return TYPE_SCORE.organization;
  if (link.includes('/projects/'))      return TYPE_SCORE.project;
  if (link.includes('/procedures/'))    return TYPE_SCORE.procedure;
  if (link.includes('/decisions/'))     return TYPE_SCORE.decision;
  if (link.includes('/research/'))      return TYPE_SCORE.research;
  if (link.includes('/meta/'))          return TYPE_SCORE.meta;

  // Ungrounded session content — demote heavily
  const snippet = (result.subline || result.snippet || '');
  if (snippet.includes('[ungrounded]')) return 0.2;

  return 1.0;
}

class MemorySearcher {
  /**
   * @param {Object} options
   * @param {import('./nc-search-client').NCSearchClient} options.ncSearchClient
   * @param {Object} [options.collectivesClient] - CollectivesClient for access tracking (LTP)
   * @param {Object} [options.coAccessGraph] - CoAccessGraph for co-access tracking and expansion
   * @param {Object} [options.vectorStore] - VectorStore for semantic similarity search
   * @param {Object} [options.embeddingClient] - EmbeddingClient for query embedding
   * @param {Object} [options.gapDetector] - GapDetector for knowledge gap tracking
   * @param {Object} [options.knowledgeGraph] - KnowledgeGraph for graph-based search
   * @param {Object} [options.logger]
   */
  constructor({ ncSearchClient, collectivesClient, coAccessGraph, vectorStore, embeddingClient, gapDetector, knowledgeGraph, logger = console }) {
    if (!ncSearchClient) throw new Error('ncSearchClient is required');
    this.nc = ncSearchClient;
    this.wiki = collectivesClient || null;
    this.coAccessGraph = coAccessGraph || null;
    this.vectorStore = vectorStore || null;
    this.embeddingClient = embeddingClient || null;
    this.gapDetector = gapDetector || null;
    this.knowledgeGraph = knowledgeGraph || null;
    this.logger = logger;
    this._providers = null;
    // Frontmatter type cache: title → type string. Populated by _recordAccess
    // which already reads frontmatter on every search hit. Zero extra API calls.
    this._typeCache = new Map();
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

    // Three-channel search: keyword, vector, graph — all in parallel
    const channels = await Promise.allSettled([
      this._searchKeyword(query, { scope, maxResults, since, until, providerIds }),
      this._searchVector(query, maxResults),
      this._searchGraph(query, maxResults)
    ]);

    const kwResults = channels[0].status === 'fulfilled' ? channels[0].value : [];
    const vecResults = channels[1].status === 'fulfilled' ? channels[1].value : [];
    const graphResults = channels[2].status === 'fulfilled' ? channels[2].value : [];

    // Fuse results across channels
    const final = this._fuseResults(kwResults, vecResults, graphResults, maxResults);

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

    // Co-access tracking: record which pages appear together in search results
    if (this.coAccessGraph) {
      const wikiTitles = final.filter(r => r.source === 'Wiki').map(r => r.title);
      if (wikiTitles.length >= 2) {
        this.coAccessGraph.record(wikiTitles).catch(err => {
          this.logger.warn('[MemorySearcher] Co-access recording failed:', err.message);
        });
      }
    }

    // Co-access expansion: if sparse results, expand with co-accessed pages
    if (final.length <= 2 && this.coAccessGraph) {
      try {
        const expanded = [];
        const existingTitles = new Set(final.map(r => r.title.toLowerCase()));
        for (const result of final) {
          if (result.source === 'Wiki') {
            const related = await this.coAccessGraph.getRelated(result.title);
            for (const rel of related) {
              if (!existingTitles.has(rel.title.toLowerCase())) {
                expanded.push({
                  source: 'Wiki',
                  title: rel.title,
                  excerpt: '',
                  link: '',
                  coAccess: true
                });
                existingTitles.add(rel.title.toLowerCase());
              }
            }
          }
        }
        final.push(...expanded.slice(0, maxResults - final.length));
      } catch (err) {
        this.logger.warn('[MemorySearcher] Co-access expansion failed:', err.message);
      }
    }

    // Gap detection: record query for knowledge gap analysis
    if (this.gapDetector) {
      try {
        this.gapDetector.recordMention(query);
      } catch (err) {
        // Non-critical — never block search for gap tracking
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

    // Cache the frontmatter type for scoring — piggybacks on access tracking
    if (page.frontmatter?.type) {
      this._typeCache.set(title, page.frontmatter.type);
    }

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
    this.logger.info(`[MemorySearcher] LTP access: "${title}" → count=${count}${updates.confidence ? ', confidence→' + updates.confidence : ''}${updates.decay_days ? ', decay→' + updates.decay_days : ''}`);
  }

  /**
   * Keyword channel: existing NC Unified Search with position-based scoring.
   * Rank 0 = 1.0, rank 1 = 0.8, rank 2 = 0.6, ..., floor 0.2.
   * @param {string} query
   * @param {Object} opts
   * @returns {Promise<Array>}
   */
  async _searchKeyword(query, { scope = 'all', maxResults = 5, since, until, providerIds } = {}) {
    const pids = providerIds || this._scopeToProviders(scope);

    const settled = await Promise.allSettled(
      pids.map(pid => this._searchProvider(pid, query, { limit: maxResults, since, until }))
    );

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

    // Sort by source priority
    results.sort((a, b) =>
      (SOURCE_PRIORITY[a._providerId] || 99) - (SOURCE_PRIORITY[b._providerId] || 99)
    );

    // Assign position-based keyword scores
    return results.slice(0, maxResults).map(({ _providerId, ...rest }, idx) => ({
      ...rest,
      _kwScore: Math.max(0.2, 1.0 - idx * 0.2)
    }));
  }

  /**
   * Vector channel: semantic similarity search via local embeddings.
   * @param {string} query - Search query
   * @param {number} limit - Max results
   * @returns {Promise<Array>}
   */
  async _searchVector(query, limit = 5) {
    if (!this.vectorStore || !this.embeddingClient) return [];
    const queryVector = await this.embeddingClient.embed(query);
    const results = this.vectorStore.search(queryVector, limit);
    return results.map(r => ({
      source: 'Wiki',
      title: r.title || r.id,
      excerpt: '',
      link: '',
      semantic: true,
      _vecScore: r.score
    }));
  }

  /**
   * Graph channel: traverse knowledge graph for entities mentioned in query.
   * Direct match = 1.0, 1 hop = 0.6, 2 hops = 0.3.
   * @param {string} query - Search query
   * @param {number} limit - Max results
   * @returns {Promise<Array>}
   */
  async _searchGraph(query, limit = 5) {
    if (!this.knowledgeGraph) return [];
    const graph = this.knowledgeGraph;
    if (!graph._entities || graph._entities.size === 0) return [];

    // Scan query for known entity names
    const queryLower = query.toLowerCase();
    const matchedIds = [];
    for (const entity of graph._entities.values()) {
      if (queryLower.includes(entity.name.toLowerCase())) {
        matchedIds.push(entity.id);
      }
    }
    if (matchedIds.length === 0) return [];

    // Traverse graph from matched entities
    const seen = new Set();
    const results = [];
    for (const id of matchedIds) {
      const related = graph.relatedTo(id, 2);
      for (const rel of related) {
        if (seen.has(rel.entity.id)) continue;
        seen.add(rel.entity.id);
        const distScore = rel.distance === 1 ? 0.6 : 0.3;
        results.push({
          source: 'Wiki',
          title: rel.entity.name,
          excerpt: '',
          link: '',
          graph: true,
          _graphScore: distScore
        });
      }
    }

    // Also add direct entity matches with score 1.0
    for (const id of matchedIds) {
      const entity = graph.getEntity(id);
      if (entity && !seen.has(entity.id)) {
        seen.add(entity.id);
        results.push({
          source: 'Wiki',
          title: entity.name,
          excerpt: '',
          link: '',
          graph: true,
          _graphScore: 1.0
        });
      }
    }

    results.sort((a, b) => b._graphScore - a._graphScore);
    return results.slice(0, limit);
  }

  /**
   * Fuse results from three channels using weighted scoring.
   * Merges by title (case-insensitive), computes weighted score, sorts descending.
   * @param {Array} kw - Keyword results with _kwScore
   * @param {Array} vec - Vector results with _vecScore
   * @param {Array} graph - Graph results with _graphScore
   * @param {number} max - Max results to return
   * @returns {Array} Fused results with channelScores
   */
  _fuseResults(kw, vec, graph, max) {
    const merged = new Map(); // title.toLowerCase() → result

    // Process keyword results
    for (const r of kw) {
      const key = r.title.toLowerCase();
      if (!merged.has(key)) {
        merged.set(key, { ...r, channelScores: { keyword: 0, vector: 0, graph: 0 } });
      }
      merged.get(key).channelScores.keyword = r._kwScore || 0;
    }

    // Process vector results
    for (const r of vec) {
      const key = r.title.toLowerCase();
      if (!merged.has(key)) {
        merged.set(key, { ...r, channelScores: { keyword: 0, vector: 0, graph: 0 } });
      }
      merged.get(key).channelScores.vector = r._vecScore || 0;
    }

    // Process graph results
    for (const r of graph) {
      const key = r.title.toLowerCase();
      if (!merged.has(key)) {
        merged.set(key, { ...r, channelScores: { keyword: 0, vector: 0, graph: 0 } });
      }
      merged.get(key).channelScores.graph = r._graphScore || 0;
    }

    // Compute weighted fusion score and sort
    const results = Array.from(merged.values()).map(r => {
      const cs = r.channelScores;
      r._fusionScore =
        cs.keyword * CHANNEL_WEIGHTS.keyword +
        cs.vector * CHANNEL_WEIGHTS.vector +
        cs.graph * CHANNEL_WEIGHTS.graph;

      // Frontmatter-aware score adjustment via cached page types.
      // Entity pages (person, project, organization) get 2x; reference stubs get 0.5x.
      r._fusionScore *= _pageScoreMultiplier(r, this._typeCache);

      // Clean up internal score fields
      delete r._kwScore;
      delete r._vecScore;
      delete r._graphScore;
      return r;
    });

    results.sort((a, b) => b._fusionScore - a._fusionScore);

    // Competitive suppression: winners suppress closely related losers
    const filtered = this._suppressRelatedResults(results, max);
    return filtered.map(({ _fusionScore, ...rest }) => rest);
  }

  /**
   * Competitive suppression: when a result wins, it suppresses closely
   * related results (same normalized title or high co-access weight).
   * Prevents 3-of-5 results being about the same entity.
   *
   * @param {Array} rankedResults - Results sorted by fusion score
   * @param {number} maxResults - Maximum results to return
   * @returns {Array} Filtered results with suppressed duplicates removed
   * @private
   */
  _suppressRelatedResults(rankedResults, maxResults = 5) {
    if (!rankedResults || rankedResults.length <= 1) return rankedResults;

    const selected = [];
    const suppressed = new Set();

    for (const result of rankedResults) {
      const id = result.title?.toLowerCase() || '';
      if (suppressed.has(id)) continue;

      selected.push(result);
      if (selected.length >= maxResults) break;

      // Suppress closely related results
      for (const other of rankedResults) {
        if (other === result) continue;
        const otherId = other.title?.toLowerCase() || '';
        if (suppressed.has(otherId)) continue;

        // Same normalized title = definitely suppress
        const normResult = this._normalizeForSuppress(result.title);
        const normOther = this._normalizeForSuppress(other.title);
        if (normResult && normOther && normResult === normOther) {
          suppressed.add(otherId);
          continue;
        }

        // High co-access + much lower score = suppress
        if (this.coAccessGraph) {
          try {
            const related = this.coAccessGraph._graph?.edges || {};
            const key1 = `${result.title}::${other.title}`;
            const key2 = `${other.title}::${result.title}`;
            const weight = related[key1] || related[key2] || 0;
            if (weight > 3 && (other._fusionScore || 0) < (result._fusionScore || 0) * 0.7) {
              suppressed.add(otherId);
            }
          } catch { /* co-access not available */ }
        }
      }
    }

    return selected;
  }

  /**
   * Normalize a title for suppression comparison.
   * Strips case, articles, prepositions, collision suffixes, diacritics.
   * @param {string} title
   * @returns {string}
   * @private
   */
  _normalizeForSuppress(title) {
    if (!title) return '';
    let n = title.toLowerCase().trim()
      .replace(/\s+/g, ' ')
      .replace(/\s*\(\d+\)$/, '')
      .replace(/^(?:the|an?|from|about)\s+/i, '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[.,;:!?]+$/, '');
    return n;
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
      'collectives-page-content', query, limit + 5
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
        _providerId: 'collectives-page-content',
        source: 'Wiki',
        title: e.title || '',
        excerpt: `[Archived] ${e.subline || ''}`,
        link: e.resourceUrl || '',
        archived: true,
      }));
  }
}

module.exports = MemorySearcher;
