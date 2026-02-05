'use strict';

/**
 * MemorySearcher - Keyword-based Memory Search over Wiki Pages
 *
 * Provides searchable memory over the knowledge wiki so the agent can
 * recall past decisions, people, projects, and session transcripts.
 *
 * Uses multi-strategy keyword matching with weighted scoring:
 * - Title matches: 3x weight
 * - Frontmatter matches: 2x weight
 * - Content matches: 1x weight
 *
 * Pages are cached for 5 minutes to avoid repeated API calls.
 * Cache is invalidated after wiki writes.
 *
 * Future: semantic embeddings via Ollama (config toggle, not built yet).
 *
 * @module integrations/memory-searcher
 * @version 1.0.0
 */

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'was', 'are', 'were', 'be', 'been',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'may', 'might', 'can', 'to', 'of', 'in',
  'for', 'on', 'with', 'at', 'by', 'from', 'and', 'or', 'but',
  'not', 'this', 'that', 'it', 'its', 'we', 'our', 'what',
  'about', 'how', 'when', 'where', 'which', 'who',
]);

class MemorySearcher {
  /**
   * @param {Object} options
   * @param {import('./collectives-client')} options.wikiClient - CollectivesClient instance
   * @param {Object} [options.config] - Configuration
   */
  constructor({ wikiClient, config = {} }) {
    this.wiki = wikiClient;
    this.config = config;
    this._pageCache = null;
    this._cacheAge = 0;
    this._cacheTTL = 300000; // 5 minutes
  }

  /**
   * Search memory pages using multi-strategy keyword matching.
   * @param {string} query - Natural language query
   * @param {Object} [options]
   * @param {string} [options.scope='all'] - 'all' | 'people' | 'projects' | 'sessions' | 'policies'
   * @param {number} [options.maxResults=5] - Max results to return
   * @returns {Promise<Array<{page: string, score: number, snippet: string, path: string}>>}
   */
  async search(query, options = {}) {
    const { scope = 'all', maxResults = 5 } = options;

    let pages = await this._getPages();

    // Filter by scope (wiki section prefix)
    if (scope !== 'all') {
      const scopePrefix = scope.charAt(0).toUpperCase() + scope.slice(1);
      pages = pages.filter(p => {
        const pagePath = p.path || p.title || '';
        return pagePath.toLowerCase().startsWith(scopePrefix.toLowerCase());
      });
    }

    const queryTerms = this._tokenize(query);

    if (queryTerms.length === 0) return [];

    const scored = pages.map(page => {
      const titleScore = this._matchScore(queryTerms, this._tokenize(page.title));
      const contentScore = this._matchScore(queryTerms, this._tokenize(page.content));
      const frontmatterScore = this._matchFrontmatter(queryTerms, page.frontmatter);

      // Weighted combination: title matches matter most
      const score = (titleScore * 3) + (contentScore * 1) + (frontmatterScore * 2);
      const snippet = this._extractSnippet(page.content, queryTerms);

      return { page: page.title, score, snippet, path: page.path || page.title };
    });

    return scored
      .filter(s => s.score > 0.1)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);
  }

  /**
   * Tokenize text into searchable terms.
   * Strips punctuation, lowercases, removes stop words.
   * @param {string} text
   * @returns {string[]}
   */
  _tokenize(text) {
    if (!text) return [];
    return text.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2 && !STOP_WORDS.has(t));
  }

  /**
   * Calculate match score between query terms and content terms.
   * Supports partial matching (prefix/substring).
   * @param {string[]} queryTerms
   * @param {string[]} contentTerms
   * @returns {number} Score between 0 and 1
   */
  _matchScore(queryTerms, contentTerms) {
    if (contentTerms.length === 0 || queryTerms.length === 0) return 0;

    let totalScore = 0;

    for (const q of queryTerms) {
      // Exact match = 1.0, prefix match = 0.7, substring = 0.4
      let bestMatch = 0;
      for (const c of contentTerms) {
        if (c === q) {
          bestMatch = Math.max(bestMatch, 1.0);
        } else if (c.startsWith(q) || q.startsWith(c)) {
          bestMatch = Math.max(bestMatch, 0.7);
        } else if (c.includes(q) || q.includes(c)) {
          bestMatch = Math.max(bestMatch, 0.4);
        }
      }
      totalScore += bestMatch;
    }

    return totalScore / queryTerms.length;
  }

  /**
   * Match query terms against frontmatter fields (tags, category, etc.)
   * @param {string[]} queryTerms
   * @param {Object} frontmatter
   * @returns {number}
   */
  _matchFrontmatter(queryTerms, frontmatter) {
    if (!frontmatter || typeof frontmatter !== 'object') return 0;
    const fmText = Object.values(frontmatter)
      .filter(v => typeof v === 'string')
      .join(' ');
    return this._matchScore(queryTerms, this._tokenize(fmText));
  }

  /**
   * Extract the most relevant snippet from content.
   * @param {string} content
   * @param {string[]} queryTerms
   * @param {number} [maxLen=200]
   * @returns {string}
   */
  _extractSnippet(content, queryTerms, maxLen = 200) {
    if (!content) return '';

    const paragraphs = content.split(/\n\n+/);
    let bestPara = paragraphs[0] || '';
    let bestScore = 0;

    for (const para of paragraphs) {
      if (para.startsWith('---')) continue; // Skip frontmatter
      const tokens = this._tokenize(para);
      const score = this._matchScore(queryTerms, tokens);
      if (score > bestScore) {
        bestScore = score;
        bestPara = para;
      }
    }

    return bestPara.substring(0, maxLen).trim();
  }

  /**
   * Get all wiki pages with content (cached for 5 minutes).
   * Uses listPages() + readPageWithFrontmatter() since there is no
   * listAllPagesWithContent() method on CollectivesClient.
   * @private
   * @returns {Promise<Array<{title: string, path: string, content: string, frontmatter: Object}>>}
   */
  async _getPages() {
    if (this._pageCache && Date.now() - this._cacheAge < this._cacheTTL) {
      return this._pageCache;
    }

    try {
      const collectiveId = await this.wiki.resolveCollective();
      const pageList = await this.wiki.listPages(collectiveId);
      const pages = Array.isArray(pageList) ? pageList : [];

      // Fetch content for each page (in parallel, batched)
      const results = [];
      // Process in batches of 5 to avoid overwhelming NC
      const batchSize = 5;
      for (let i = 0; i < pages.length; i += batchSize) {
        const batch = pages.slice(i, i + batchSize);
        const batchResults = await Promise.allSettled(
          batch.map(async (page) => {
            const path = this.wiki._buildPagePath(page);
            try {
              const raw = await this.wiki.readPageContent(path);
              if (raw === null) return null;

              // Parse frontmatter from raw content
              const { parseFrontmatter } = require('../knowledge/frontmatter');
              const { frontmatter, body } = parseFrontmatter(raw);

              return {
                title: page.title || '',
                path: path,
                content: body || '',
                frontmatter: frontmatter || {},
              };
            } catch {
              return null;
            }
          })
        );
        for (const r of batchResults) {
          if (r.status === 'fulfilled' && r.value) {
            results.push(r.value);
          }
        }
      }

      this._pageCache = results;
      this._cacheAge = Date.now();
      return results;
    } catch (err) {
      console.error('[MemorySearcher] Failed to load pages:', err.message);
      return this._pageCache || []; // Return stale cache if available
    }
  }

  /**
   * Invalidate cache (call after wiki writes).
   */
  invalidateCache() {
    this._pageCache = null;
    this._cacheAge = 0;
  }
}

module.exports = MemorySearcher;
