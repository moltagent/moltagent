/**
 * MoltAgent NC Request Manager
 *
 * Central gateway for all Nextcloud API requests with:
 * - Request queue with concurrency limiting
 * - Per-endpoint-group rate tracking
 * - Response caching with configurable TTLs
 * - Automatic backoff on 429 with Retry-After parsing
 * - Stale-while-revalidate for reads, queue-and-retry for writes
 *
 * @module nc-request-manager
 * @version 1.0.0
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const appConfig = require('./config');

/**
 * Endpoint group configuration
 */
const ENDPOINT_GROUPS = {
  passwords: {
    pattern: /\/apps\/passwords\//,
    cacheTTL: appConfig.cacheTTL.passwords,
    priority: 'high',
    maxRetries: appConfig.resilience.maxRetries
  },
  caldav: {
    pattern: /\/remote\.php\/dav\/calendars\//,
    cacheTTL: appConfig.cacheTTL.caldav,
    priority: 'normal',
    maxRetries: appConfig.resilience.maxRetries
  },
  carddav: {
    pattern: /\/remote\.php\/dav\/addressbooks\//,
    cacheTTL: appConfig.cacheTTL.carddav,
    priority: 'normal',
    maxRetries: appConfig.resilience.maxRetries
  },
  collectives: {
    pattern: /\/apps\/collectives\//,
    cacheTTL: appConfig.cacheTTL.collectives,
    priority: 'normal',
    maxRetries: appConfig.resilience.maxRetries
  },
  deck: {
    pattern: /\/apps\/deck\//,
    cacheTTL: appConfig.cacheTTL.deck,
    priority: 'normal',
    maxRetries: appConfig.resilience.maxRetries
  },
  webdav: {
    pattern: /\/remote\.php\/dav\/files\//,
    cacheTTL: appConfig.cacheTTL.webdav,
    priority: 'low',
    maxRetries: appConfig.resilience.maxRetries
  },
  talk: {
    pattern: /\/apps\/spreed\//,
    cacheTTL: appConfig.cacheTTL.talk,
    priority: 'normal',
    maxRetries: 2
  },
  ocs: {
    pattern: /\/ocs\/v2\.php\//,
    cacheTTL: appConfig.cacheTTL.ocs,
    priority: 'normal',
    maxRetries: appConfig.resilience.maxRetries
  }
};

const PRIORITY_ORDER = { high: 0, normal: 1, low: 2 };

class NCRequestManager {
  /**
   * @param {Object} config
   * @param {Object} config.nextcloud - Nextcloud connection config
   * @param {string} config.nextcloud.url - Nextcloud base URL
   * @param {string} config.nextcloud.username - Nextcloud username
   * @param {Object} [config.ncResilience] - Resilience settings
   * @param {number} [config.ncResilience.maxConcurrent=4] - Max parallel requests
   * @param {number} [config.ncResilience.defaultRetryAfter=30000] - Default backoff on 429 (ms)
   * @param {number} [config.ncResilience.maxQueueSize=1000] - Max queue size
   * @param {number} [config.ncResilience.maxRetries=3] - Default max retries
   */
  constructor(config) {
    this.ncUrl = (config.nextcloud?.url || '').replace(/\/$/, '');
    this.ncUser = config.nextcloud?.username || 'moltagent';
    this.ncPassword = null; // Set via setBootstrapCredential()

    // Resilience settings
    const resilience = config.ncResilience || {};
    this.maxConcurrent = resilience.maxConcurrent || appConfig.resilience.maxConcurrent;
    this.defaultRetryAfter = resilience.defaultRetryAfter || appConfig.resilience.defaultRetryAfter;
    this.maxQueueSize = resilience.maxQueueSize || appConfig.resilience.maxQueueSize;
    this.maxRetries = resilience.maxRetries || appConfig.resilience.maxRetries;

    // Request queue
    this.queue = [];
    this.activeRequests = 0;

    // Response cache: Map<cacheKey, { response, expiry, staleUntil }>
    this.cache = new Map();

    // Per-group backoff state: Map<group, { until: timestamp, retryAfter: ms }>
    this.backoff = new Map();

    // Metrics
    this.metrics = {
      totalRequests: 0,
      cacheHits: 0,
      cacheMisses: 0,
      staleServed: 0,
      rateLimited: 0,
      retries: 0,
      failures: 0,
      byGroup: {}
    };

    // Initialize per-group metrics
    for (const group of Object.keys(ENDPOINT_GROUPS)) {
      this.metrics.byGroup[group] = {
        requests: 0,
        cacheHits: 0,
        rateLimited: 0
      };
    }
    this.metrics.byGroup.other = { requests: 0, cacheHits: 0, rateLimited: 0 };

    // Shutdown flag
    this._shuttingDown = false;
  }

  /**
   * Load bootstrap credential from systemd LoadCredential or fallback
   */
  setBootstrapCredential() {
    // Method 1: systemd LoadCredential (most secure)
    const credDir = process.env.CREDENTIALS_DIRECTORY;
    if (credDir) {
      const credPath = path.join(credDir, 'nc-password');
      try {
        this.ncPassword = fs.readFileSync(credPath, 'utf8').trim();
        console.log('[NCRequestManager] Bootstrap credential loaded from systemd');
        return;
      } catch (err) {
        console.warn('[NCRequestManager] Failed to read systemd credential:', err.message);
      }
    }

    // Method 2: Dedicated credential file
    const devCredPath = process.env.NC_CREDENTIAL_FILE;
    if (devCredPath) {
      try {
        this.ncPassword = fs.readFileSync(devCredPath, 'utf8').trim();
        console.log('[NCRequestManager] Bootstrap credential loaded from file');
        return;
      } catch (err) {
        console.warn('[NCRequestManager] Failed to read credential file:', err.message);
      }
    }

    // Method 3: Environment variable (least secure)
    if (process.env.NC_PASSWORD) {
      this.ncPassword = process.env.NC_PASSWORD;
      console.warn('[NCRequestManager] WARNING: Using NC_PASSWORD env var - not recommended for production');
      return;
    }

    throw new Error('No bootstrap credential available. Configure systemd LoadCredential, NC_CREDENTIAL_FILE, or NC_PASSWORD');
  }

  /**
   * Resolve the canonical username from the Nextcloud server.
   * OCS APIs and WebDAV paths are case-sensitive; this ensures we use
   * the exact casing the server expects.
   * Call once after credentials are set, before constructing any clients.
   */
  async resolveCanonicalUsername() {
    try {
      const response = await this.request('/ocs/v2.php/cloud/user', {
        method: 'GET',
        headers: { 'OCS-APIRequest': 'true', 'Accept': 'application/json' }
      });
      const userId = response.body?.ocs?.data?.id;
      if (userId && userId !== this.ncUser) {
        console.log(`[NCRequestManager] Canonical username: ${userId} (configured: ${this.ncUser})`);
        this.ncUser = userId;
      }
    } catch (err) {
      console.warn(`[NCRequestManager] Could not resolve canonical username: ${err.message}`);
      // Continue with configured username — Basic auth still works
    }
  }

  /**
   * Get the Nextcloud password (for compatibility with existing code)
   * @returns {string}
   */
  getNCPassword() {
    if (!this.ncPassword) {
      this.setBootstrapCredential();
    }
    return this.ncPassword;
  }

  /**
   * Identify which endpoint group a URL belongs to
   * @param {string} url - The request URL
   * @returns {string} Group name
   */
  _classifyEndpoint(url) {
    const urlPath = url.includes('://') ? new URL(url).pathname : url;

    for (const [group, config] of Object.entries(ENDPOINT_GROUPS)) {
      if (config.pattern.test(urlPath)) {
        return group;
      }
    }
    return 'other';
  }

  /**
   * Get cache configuration for an endpoint group
   * @param {string} group
   * @returns {Object}
   */
  _getGroupConfig(group) {
    return ENDPOINT_GROUPS[group] || {
      cacheTTL: appConfig.cacheTTL.ocs,
      priority: 'normal',
      maxRetries: this.maxRetries
    };
  }

  /**
   * Generate a cache key for a request
   * @param {string} url
   * @param {Object} options
   * @returns {string}
   */
  _getCacheKey(url, options) {
    const method = (options.method || 'GET').toUpperCase();
    // Only cache GET and PROPFIND/REPORT (read operations)
    if (!['GET', 'PROPFIND', 'REPORT'].includes(method)) {
      return null;
    }
    return `${method}:${url}`;
  }

  /**
   * Check if a request method is a read operation
   * @param {string} method
   * @returns {boolean}
   */
  _isReadOperation(method) {
    return ['GET', 'HEAD', 'PROPFIND', 'REPORT'].includes((method || 'GET').toUpperCase());
  }

  /**
   * Check if we're in backoff for a group
   * @param {string} group
   * @returns {boolean}
   */
  _isInBackoff(group) {
    const backoffState = this.backoff.get(group);
    if (!backoffState) return false;
    return Date.now() < backoffState.until;
  }

  /**
   * Set backoff for a group
   * @param {string} group
   * @param {number} retryAfterMs
   */
  _setBackoff(group, retryAfterMs) {
    this.backoff.set(group, {
      until: Date.now() + retryAfterMs,
      retryAfter: retryAfterMs
    });
    console.log(`[NCRequestManager] Backoff set for ${group}: ${retryAfterMs}ms`);
  }

  /**
   * Clear backoff for a group
   * @param {string} group
   */
  _clearBackoff(group) {
    this.backoff.delete(group);
  }

  /**
   * Parse Retry-After header
   * @param {string|number} retryAfter
   * @returns {number} Milliseconds to wait
   */
  _parseRetryAfter(retryAfter) {
    if (!retryAfter) {
      return this.defaultRetryAfter;
    }

    // Could be seconds or HTTP date
    const seconds = parseInt(retryAfter, 10);
    if (!isNaN(seconds)) {
      return seconds * 1000;
    }

    // Try parsing as HTTP date
    const date = new Date(retryAfter);
    if (!isNaN(date.getTime())) {
      const ms = date.getTime() - Date.now();
      return Math.max(ms, 1000);
    }

    return this.defaultRetryAfter;
  }

  /**
   * Main request method - ALL NC API calls should use this
   *
   * @param {string} url - Full URL or path (will be prefixed with ncUrl if relative)
   * @param {Object} [options={}] - Request options
   * @param {string} [options.method='GET'] - HTTP method
   * @param {Object} [options.headers={}] - Additional headers
   * @param {string|Object} [options.body] - Request body
   * @param {boolean} [options.skipCache=false] - Skip cache for this request
   * @param {boolean} [options.invalidateCache=false] - Invalidate related cache entries
   * @returns {Promise<Object>} Response object with { status, headers, body, fromCache }
   */
  async request(url, options = {}) {
    if (this._shuttingDown) {
      throw new Error('NCRequestManager is shutting down');
    }

    this.metrics.totalRequests++;

    // Build full URL
    const fullUrl = url.startsWith('http') ? url : `${this.ncUrl}${url}`;
    const group = this._classifyEndpoint(fullUrl);
    const groupConfig = this._getGroupConfig(group);
    const method = (options.method || 'GET').toUpperCase();
    const isRead = this._isReadOperation(method);

    this.metrics.byGroup[group] = this.metrics.byGroup[group] || { requests: 0, cacheHits: 0, rateLimited: 0 };
    this.metrics.byGroup[group].requests++;

    // Check cache for read operations
    const cacheKey = this._getCacheKey(fullUrl, options);
    if (isRead && cacheKey && !options.skipCache) {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        const now = Date.now();

        // Fresh cache hit
        if (now < cached.expiry) {
          this.metrics.cacheHits++;
          this.metrics.byGroup[group].cacheHits++;
          return { ...cached.response, fromCache: true };
        }

        // Stale but within grace period - serve stale if in backoff
        if (now < cached.staleUntil && this._isInBackoff(group)) {
          this.metrics.staleServed++;
          return { ...cached.response, fromCache: true, stale: true };
        }
      }
    }

    this.metrics.cacheMisses++;

    // Invalidate cache for write operations
    if (!isRead && cacheKey === null && options.invalidateCache !== false) {
      // Invalidate related GET cache entries for this URL base
      const urlBase = fullUrl.split('?')[0];
      for (const [key, _] of this.cache) {
        if (key.includes(urlBase)) {
          this.cache.delete(key);
        }
      }
    }

    // Skip cache for rawBuffer requests (binary data too large to cache)
    if (options.rawBuffer) {
      return new Promise((resolve, reject) => {
        const requestItem = {
          url: fullUrl,
          options: { ...options, method },
          group,
          groupConfig,
          cacheKey: null,
          isRead,
          priority: PRIORITY_ORDER[groupConfig.priority] ?? 1,
          retryCount: 0,
          maxRetries: groupConfig.maxRetries,
          resolve,
          reject,
          enqueuedAt: Date.now()
        };

        if (this.queue.length >= this.maxQueueSize) {
          const lowPriorityIndex = this.queue.findIndex(r => r.priority === PRIORITY_ORDER.low);
          if (lowPriorityIndex >= 0) {
            const dropped = this.queue.splice(lowPriorityIndex, 1)[0];
            dropped.reject(new Error('Request dropped due to queue overflow'));
          } else {
            reject(new Error('Request queue is full'));
            return;
          }
        }

        this.queue.push(requestItem);
        this._sortQueue();
        this._processQueue();
      });
    }

    // Queue the request
    return new Promise((resolve, reject) => {
      const requestItem = {
        url: fullUrl,
        options: { ...options, method },
        group,
        groupConfig,
        cacheKey,
        isRead,
        priority: PRIORITY_ORDER[groupConfig.priority] ?? 1,
        retryCount: 0,
        maxRetries: groupConfig.maxRetries,
        resolve,
        reject,
        enqueuedAt: Date.now()
      };

      // Check queue size
      if (this.queue.length >= this.maxQueueSize) {
        // Drop oldest low-priority requests
        const lowPriorityIndex = this.queue.findIndex(r => r.priority === PRIORITY_ORDER.low);
        if (lowPriorityIndex >= 0) {
          const dropped = this.queue.splice(lowPriorityIndex, 1)[0];
          dropped.reject(new Error('Request dropped due to queue overflow'));
        } else {
          reject(new Error('Request queue is full'));
          return;
        }
      }

      this.queue.push(requestItem);
      this._sortQueue();
      this._processQueue();
    });
  }

  /**
   * Sort queue by priority
   */
  _sortQueue() {
    this.queue.sort((a, b) => {
      // First by priority (high = 0, low = 2)
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }
      // Then by enqueue time (FIFO within priority)
      return a.enqueuedAt - b.enqueuedAt;
    });
  }

  /**
   * Process queued requests
   */
  _processQueue() {
    while (this.activeRequests < this.maxConcurrent && this.queue.length > 0) {
      // Find first request not in backoff
      const index = this.queue.findIndex(r => !this._isInBackoff(r.group));
      if (index === -1) {
        // All queued requests are in backoff - schedule retry
        const minBackoff = Math.min(
          ...Array.from(this.backoff.values()).map(b => b.until - Date.now())
        );
        if (minBackoff > 0) {
          setTimeout(() => this._processQueue(), Math.min(minBackoff, 5000));
        }
        break;
      }

      const requestItem = this.queue.splice(index, 1)[0];
      this.activeRequests++;

      this._executeRequest(requestItem)
        .finally(() => {
          this.activeRequests--;
          this._processQueue();
        });
    }
  }

  /**
   * Execute a single request
   * @param {Object} requestItem
   */
  async _executeRequest(requestItem) {
    const { url, options, group, cacheKey, isRead, resolve, reject } = requestItem;

    try {
      const response = await this._httpRequest(url, options);

      // Handle rate limiting (429)
      if (response.status === 429) {
        this.metrics.rateLimited++;
        this.metrics.byGroup[group].rateLimited++;

        const retryAfter = this._parseRetryAfter(response.headers['retry-after']);
        this._setBackoff(group, retryAfter);

        // For reads: serve stale if available
        if (isRead && cacheKey) {
          const cached = this.cache.get(cacheKey);
          if (cached && Date.now() < cached.staleUntil) {
            this.metrics.staleServed++;
            resolve({ ...cached.response, fromCache: true, stale: true, rateLimited: true });
            return;
          }
        }

        // Retry
        if (requestItem.retryCount < requestItem.maxRetries) {
          requestItem.retryCount++;
          this.metrics.retries++;
          this.queue.push(requestItem);
          this._sortQueue();
          return;
        }

        // Max retries exceeded
        this.metrics.failures++;
        reject(new Error(`Rate limited after ${requestItem.retryCount} retries`));
        return;
      }

      // Handle auth errors - NEVER retry 401/403
      if (response.status === 401 || response.status === 403) {
        this.metrics.failures++;
        reject(new Error(`Authentication error: ${response.status}`));
        return;
      }

      // Handle other errors
      if (response.status >= 400) {
        // 404 is a valid "not found" response — resolve normally so callers
        // can inspect response.status and handle it (e.g. TemplateLoader,
        // SkillActivator.listPending returning empty arrays).
        if (response.status === 404) {
          resolve({
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
            body: response.body,
            fromCache: false
          });
          return;
        }

        // Retry on 5xx errors
        if (response.status >= 500 && requestItem.retryCount < requestItem.maxRetries) {
          requestItem.retryCount++;
          this.metrics.retries++;
          this.queue.push(requestItem);
          this._sortQueue();
          return;
        }

        this.metrics.failures++;
        const bodySnippet = typeof response.body === 'string'
          ? response.body.slice(0, 500)
          : JSON.stringify(response.body || '').slice(0, 500);
        console.error(`[NCRequestManager] HTTP ${response.status} on ${requestItem.options?.method || '?'} ${requestItem.url}: ${bodySnippet}`);
        const err = new Error(`HTTP ${response.status}: ${response.statusText || ''}`);
        err.statusCode = response.status;
        err.responseBody = response.body;
        reject(err);
        return;
      }

      // Success - clear any backoff for this group
      this._clearBackoff(group);

      // Cache successful read responses
      if (isRead && cacheKey) {
        const groupConfig = this._getGroupConfig(group);
        const now = Date.now();
        this.cache.set(cacheKey, {
          response: {
            status: response.status,
            headers: response.headers,
            body: response.body
          },
          expiry: now + groupConfig.cacheTTL,
          staleUntil: now + groupConfig.cacheTTL * 3 // Stale grace period
        });
      }

      resolve({
        status: response.status,
        headers: response.headers,
        body: response.body,
        fromCache: false
      });

    } catch (error) {
      // Network/connection errors - retry
      if (requestItem.retryCount < requestItem.maxRetries) {
        requestItem.retryCount++;
        this.metrics.retries++;
        this.queue.push(requestItem);
        this._sortQueue();
        return;
      }

      this.metrics.failures++;
      reject(error);
    }
  }

  /**
   * Execute HTTP request
   * @param {string} urlStr
   * @param {Object} options
   * @returns {Promise<Object>}
   */
  async _httpRequest(urlStr, options) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlStr);
      const isHttps = url.protocol === 'https:';

      if (!this.ncPassword) {
        reject(new Error('No credential set - call setBootstrapCredential() first'));
        return;
      }

      // Prepare body
      let bodyStr = null;
      if (options.body) {
        bodyStr = typeof options.body === 'string'
          ? options.body
          : JSON.stringify(options.body);
      }

      // Build headers
      const headers = {
        'Authorization': 'Basic ' + Buffer.from(`${this.ncUser}:${this.ncPassword}`).toString('base64'),
        'OCS-APIRequest': 'true',
        'Accept': 'application/json',
        ...options.headers
      };

      // Set content type if body present
      if (bodyStr && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
      }
      if (bodyStr) {
        headers['Content-Length'] = Buffer.byteLength(bodyStr);
      }

      const reqOptions = {
        method: options.method || 'GET',
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        headers,
        timeout: options.timeout || appConfig.timeouts.httpRequest
      };

      const transport = isHttps ? https : http;
      const req = transport.request(reqOptions, (res) => {
        if (options.rawBuffer) {
          // Binary mode: collect as Buffer chunks
          const chunks = [];
          res.on('data', chunk => chunks.push(chunk));
          res.on('end', () => {
            headers.Authorization = null;
            resolve({
              status: res.statusCode,
              statusText: res.statusMessage,
              headers: res.headers,
              body: Buffer.concat(chunks)
            });
          });
        } else {
          // Text mode: accumulate as string
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            // Clear auth from memory
            headers.Authorization = null;

            // Parse JSON if possible
            let body = data;
            const contentType = res.headers['content-type'] || '';
            if (contentType.includes('application/json') && data) {
              try {
                body = JSON.parse(data);
              } catch {
                // Keep as string
              }
            }

            resolve({
              status: res.statusCode,
              statusText: res.statusMessage,
              headers: res.headers,
              body
            });
          });
        }
      });

      req.on('error', (err) => {
        headers.Authorization = null;
        reject(new Error(`Network error: ${err.message}`));
      });

      req.on('timeout', () => {
        headers.Authorization = null;
        req.destroy();
        reject(new Error('Request timeout'));
      });

      if (bodyStr) {
        req.write(bodyStr);
      }
      req.end();
    });
  }

  /**
   * Get a Nextcloud user's email address via CalDAV principal PROPFIND.
   * Uses calendar-user-address-set — works without admin rights.
   * Results are cached with a 10-minute TTL.
   *
   * @param {string} userId - Nextcloud user ID
   * @returns {Promise<string|null>} The user's email address, or null if not found
   */
  async getUserEmail(userId) {
    if (!userId) return null;

    // Check cache
    if (!this._userEmailCache) this._userEmailCache = new Map();
    const cached = this._userEmailCache.get(userId);
    if (cached && Date.now() < cached.expiry) {
      return cached.email;
    }

    try {
      const body = '<?xml version="1.0"?>' +
        '<d:propfind xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">' +
        '<d:prop><cal:calendar-user-address-set/></d:prop>' +
        '</d:propfind>';

      const response = await this.request(
        `/remote.php/dav/principals/users/${encodeURIComponent(userId)}/`,
        {
          method: 'PROPFIND',
          headers: {
            'Content-Type': 'application/xml; charset=utf-8',
            'Depth': '0'
          },
          body
        }
      );

      // Parse mailto: href from calendar-user-address-set
      const responseBody = typeof response.body === 'string' ? response.body : JSON.stringify(response.body);
      const mailtoMatch = /mailto:([^<\s]+)/i.exec(responseBody);
      const email = mailtoMatch ? mailtoMatch[1] : null;

      // Cache for 10 minutes
      this._userEmailCache.set(userId, { email, expiry: Date.now() + 600000 });

      return email;
    } catch (err) {
      console.warn(`[NCRequestManager] getUserEmail(${userId}) failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Invalidate cache for a specific URL or pattern
   * @param {string} pattern - URL or pattern to match
   */
  invalidateCache(pattern) {
    if (!pattern) {
      this.cache.clear();
      return;
    }

    for (const [key, _] of this.cache) {
      if (key.includes(pattern)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Get current metrics
   * @returns {Object}
   */
  getMetrics() {
    return {
      ...this.metrics,
      cacheSize: this.cache.size,
      queueLength: this.queue.length,
      activeRequests: this.activeRequests,
      hitRate: this.metrics.totalRequests > 0
        ? ((this.metrics.cacheHits / this.metrics.totalRequests) * 100).toFixed(1) + '%'
        : 'N/A',
      backoffGroups: Array.from(this.backoff.entries()).map(([group, state]) => ({
        group,
        until: new Date(state.until).toISOString(),
        remaining: Math.max(0, state.until - Date.now())
      }))
    };
  }

  /**
   * Graceful shutdown - drain queue and clear cache
   * @returns {Promise<void>}
   */
  async shutdown() {
    console.log('[NCRequestManager] Shutting down...');
    this._shuttingDown = true;

    // Wait for active requests to complete (with timeout)
    const timeout = appConfig.timeouts.gracefulShutdown;
    const start = Date.now();

    while (this.activeRequests > 0 && Date.now() - start < timeout) {
      await new Promise(r => setTimeout(r, 100));
    }

    // Reject remaining queued requests
    while (this.queue.length > 0) {
      const item = this.queue.shift();
      item.reject(new Error('Shutdown - request cancelled'));
    }

    // Clear cache
    this.cache.clear();
    this.backoff.clear();

    // Securely clear credential
    if (this.ncPassword) {
      this.ncPassword = ''.padStart(this.ncPassword.length, '*');
      this.ncPassword = null;
    }

    console.log('[NCRequestManager] Shutdown complete');
  }
}

module.exports = NCRequestManager;
