/*
 * Moltagent - Sovereign AI Security Layer
 * Copyright (C) 2026 MoltAgent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 */

/**
 * Moltagent NC News Client
 *
 * Architecture Brief:
 * -------------------
 * Problem: Content Pipeline workflow needs to read RSS feeds from the
 * Nextcloud News app. Heartbeat scans feeds every 24h, evaluates articles,
 * and creates Deck cards for interesting ones. Scanned items must be marked
 * as read to prevent reprocessing on the next cycle.
 *
 * Pattern: Thin API client over NCRequestManager — same structure as
 * DeckClient. No business logic; just NC News API v1-3 plumbing.
 *
 * Key Dependencies:
 *   - NCRequestManager (injected): .request(path, opts) for all API calls
 *
 * Data Flow:
 *   getFeeds()          → GET /apps/news/api/v1-3/feeds
 *   getItems(options)   → GET /apps/news/api/v1-3/items
 *   markItemRead(id)    → PUT /apps/news/api/v1-3/items/{id}/read
 *
 * Dependency Map:
 *   NewsClient
 *     ← ToolRegistry (news_get_items, news_list_feeds, news_mark_read)
 *     ← HeartbeatManager (future: 24h feed scan)
 *     → NCRequestManager (all HTTP calls)
 *
 * @module integrations/news-client
 * @version 1.0.0
 */

'use strict';

class NewsApiError extends Error {
  constructor(message, statusCode = 0, response = null) {
    super(message);
    this.name = 'NewsApiError';
    this.statusCode = statusCode;
    this.response = response;
  }
}

class NewsClient {
  /**
   * Create a new NC News client.
   * @param {Object} ncRequestManager - NCRequestManager instance with .request() method
   */
  constructor(ncRequestManager) {
    if (!ncRequestManager || typeof ncRequestManager.request !== 'function') {
      throw new Error('NewsClient requires an NCRequestManager instance');
    }
    this.nc = ncRequestManager;
  }

  /**
   * Base request method — same pattern as DeckClient._request().
   * @param {string} method - HTTP method
   * @param {string} path - API path (appended to /apps/news/api/v1-3)
   * @param {Object|null} [body=null] - Request body
   * @returns {Promise<Object>} Parsed response body
   */
  async _request(method, path, body = null) {
    const response = await this.nc.request(`/apps/news/api/v1-3${path}`, {
      method,
      body,
      headers: {
        'OCS-APIRequest': 'true',
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    });

    if (response.status >= 200 && response.status < 300) {
      return response.body || { success: true, statusCode: response.status };
    }

    const message = response.body?.message || response.body?.error || `HTTP ${response.status}`;
    throw new NewsApiError(message, response.status, response.body);
  }

  // ============================================================
  // FEEDS
  // ============================================================

  /**
   * List all subscribed RSS feeds.
   * @returns {Promise<Array>} Array of feed objects: { id, url, title, faviconLink, folderId, unreadCount, link }
   */
  async getFeeds() {
    const result = await this._request('GET', '/feeds');
    return result?.feeds || [];
  }

  // ============================================================
  // ITEMS
  // ============================================================

  /**
   * Get feed items (articles).
   * @param {Object} [options={}]
   * @param {number} [options.batchSize=20] - Number of items to return
   * @param {number} [options.offset=0] - Pagination offset
   * @param {number} [options.type=3] - 0=feed, 1=folder, 2=starred, 3=all
   * @param {boolean} [options.getRead=false] - Include already-read items
   * @param {boolean} [options.oldestFirst=false] - Sort oldest first
   * @returns {Promise<Array>} Array of item objects: { id, feedId, title, author, pubDate, body, url, feedTitle, starred, unread }
   */
  async getItems(options = {}) {
    const params = new URLSearchParams();
    params.set('batchSize', String(options.batchSize || 20));
    params.set('offset', String(options.offset || 0));
    params.set('type', String(options.type ?? 3));
    params.set('getRead', String(options.getRead || false));
    params.set('oldestFirst', String(options.oldestFirst || false));

    const result = await this._request('GET', `/items?${params.toString()}`);
    return result?.items || [];
  }

  /**
   * Mark an item as read.
   * @param {number|string} itemId - Item ID to mark as read
   * @returns {Promise<Object>} Response from NC News
   */
  async markItemRead(itemId) {
    if (itemId == null) throw new NewsApiError('itemId is required');
    return this._request('PUT', `/items/${encodeURIComponent(itemId)}/read`);
  }
}

module.exports = { NewsClient, NewsApiError };
