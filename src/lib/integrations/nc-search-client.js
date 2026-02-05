'use strict';

/**
 * NCSearchClient - Nextcloud Unified Search OCS Client
 *
 * Queries the NC Unified Search API to search across all apps
 * (files, deck, calendar, contacts, talk, etc.)
 *
 * @module integrations/nc-search-client
 * @version 1.0.0
 */

class NCSearchClient {
  /**
   * @param {import('../nc-request-manager')} ncRequestManager
   */
  constructor(ncRequestManager) {
    this.nc = ncRequestManager;
    this._providersCache = null;
    this._providersCacheExpiry = 0;
  }

  /**
   * Get available search providers (cached for 1 hour).
   * @returns {Promise<Array<{id: string, name: string}>>}
   */
  async getProviders() {
    const now = Date.now();
    if (this._providersCache && now < this._providersCacheExpiry) {
      return this._providersCache;
    }

    const response = await this.nc.request(
      '/ocs/v2.php/search/providers',
      {
        method: 'GET',
        headers: { 'OCS-APIRequest': 'true' }
      }
    );

    const data = response.body?.ocs?.data || response.body || [];
    const providers = Array.isArray(data)
      ? data.map(p => ({ id: p.id, name: p.name }))
      : [];

    this._providersCache = providers;
    this._providersCacheExpiry = now + 3600000; // 1 hour

    return providers;
  }

  /**
   * Search a single provider.
   * @param {string} providerId
   * @param {string} term
   * @param {number} [limit=5]
   * @returns {Promise<Array<{title: string, subline: string, resourceUrl: string}>>}
   */
  async searchProvider(providerId, term, limit = 5) {
    const encodedTerm = encodeURIComponent(term);
    const response = await this.nc.request(
      `/ocs/v2.php/search/providers/${encodeURIComponent(providerId)}/search?term=${encodedTerm}&limit=${limit}`,
      {
        method: 'GET',
        headers: { 'OCS-APIRequest': 'true' },
        skipCache: true
      }
    );

    const entries = response.body?.ocs?.data?.entries || [];
    return Array.isArray(entries)
      ? entries.map(e => ({
          title: e.title || '',
          subline: e.subline || '',
          resourceUrl: e.resourceUrl || ''
        }))
      : [];
  }

  /**
   * Search across multiple providers (or all available).
   * @param {string} term - Search query
   * @param {string[]} [providerIds] - Specific provider IDs (default: all)
   * @param {number} [limit=5] - Results per provider
   * @returns {Promise<Array<{provider: string, title: string, subline: string, resourceUrl: string}>>}
   */
  async search(term, providerIds, limit = 5) {
    let providers;

    if (providerIds && providerIds.length > 0) {
      providers = providerIds.map(id => ({ id, name: id }));
    } else {
      providers = await this.getProviders();
    }

    if (providers.length === 0) {
      return [];
    }

    // Search all providers concurrently
    const results = await Promise.allSettled(
      providers.map(async (p) => {
        const entries = await this.searchProvider(p.id, term, limit);
        return entries.map(e => ({
          provider: p.name || p.id,
          ...e
        }));
      })
    );

    // Merge fulfilled results, skip failures
    const merged = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        merged.push(...result.value);
      }
    }

    return merged;
  }
}

module.exports = { NCSearchClient };
