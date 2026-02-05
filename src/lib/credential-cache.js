/**
 * MoltAgent Credential Cache
 *
 * Thin wrapper around NCRequestManager adding credential-specific semantics:
 * - Single credential fetch with caching
 * - Batch prefetch via password/list (1 API call for multiple credentials)
 * - Secure eviction (overwrites values before deletion)
 *
 * @module credential-cache
 * @version 1.0.0
 */

const appConfig = require('./config');

class CredentialCache {
  /**
   * @param {Object} ncRequestManager - NCRequestManager instance
   * @param {Object} [config={}] - Configuration options
   * @param {number} [config.cacheTTL] - Cache TTL in milliseconds
   * @param {Function} [config.auditLog] - Audit logging function
   */
  constructor(ncRequestManager, config = {}) {
    this.nc = ncRequestManager;
    this.cacheTTL = config.cacheTTL || appConfig.cacheTTL.credentials;
    this.auditLog = config.auditLog || (async () => {});

    // Credential cache: Map<name, { value, expiry }>
    this._cache = new Map();

    // All credentials list cache (for prefetch)
    this._allCredentials = null;
    this._allCredentialsExpiry = 0;
  }

  /**
   * Fetch a single credential by name
   * @param {string} name - Credential name/label
   * @returns {Promise<string|Object>} Credential value
   */
  async get(name) {
    // Check local cache first
    const cached = this._cache.get(name);
    if (cached && Date.now() < cached.expiry) {
      await this.auditLog('credential_cache_hit', { name });
      return cached.value;
    }

    // Need to fetch - use the all-credentials list
    const credentials = await this._fetchAllCredentials();

    // Find the credential
    const found = credentials.find(p =>
      p.label === name ||
      p.username === name ||
      p.label?.toLowerCase() === name.toLowerCase()
    );

    if (!found) {
      throw new Error(`Credential '${name}' not found in NC Passwords`);
    }

    // Process credential (simple vs complex)
    const value = this._processCredential(name, found);

    // Cache it
    this._cache.set(name, {
      value,
      expiry: Date.now() + this.cacheTTL
    });

    await this.auditLog('credential_fetched', { name });
    return value;
  }

  /**
   * Prefetch multiple credentials in a single API call
   * @param {string[]} names - List of credential names to prefetch
   * @returns {Promise<Object>} Map of name -> value
   */
  async prefetchAll(names) {
    if (!names || names.length === 0) {
      return {};
    }

    // Check which ones need fetching
    const now = Date.now();
    const toFetch = names.filter(name => {
      const cached = this._cache.get(name);
      return !cached || now >= cached.expiry;
    });

    if (toFetch.length === 0) {
      // All cached - return cached values
      const result = {};
      for (const name of names) {
        const cached = this._cache.get(name);
        if (cached) {
          result[name] = cached.value;
        }
      }
      await this.auditLog('credentials_all_cached', { names });
      return result;
    }

    // Fetch all credentials (single API call)
    const credentials = await this._fetchAllCredentials(true); // Force refresh

    // Process and cache requested credentials
    const result = {};
    for (const name of names) {
      const found = credentials.find(p =>
        p.label === name ||
        p.username === name ||
        p.label?.toLowerCase() === name.toLowerCase()
      );

      if (found) {
        const value = this._processCredential(name, found);
        this._cache.set(name, {
          value,
          expiry: now + this.cacheTTL
        });
        result[name] = value;
      }
    }

    await this.auditLog('credentials_prefetched', {
      requested: names.length,
      fetched: Object.keys(result).length
    });

    return result;
  }

  /**
   * Fetch all credentials from NC Passwords
   * @param {boolean} [forceRefresh=false] - Force refresh even if cached
   * @returns {Promise<Array>}
   */
  async _fetchAllCredentials(forceRefresh = false) {
    const now = Date.now();

    // Return cached list if fresh
    if (!forceRefresh && this._allCredentials && now < this._allCredentialsExpiry) {
      return this._allCredentials;
    }

    // Fetch from NC Passwords API
    const response = await this.nc.request(
      '/index.php/apps/passwords/api/1.0/password/list',
      {
        method: 'POST',
        body: {},
        skipCache: true // Always fetch fresh list
      }
    );

    const credentials = Array.isArray(response.body) ? response.body : [];

    // Cache the full list
    this._allCredentials = credentials;
    this._allCredentialsExpiry = now + this.cacheTTL;

    return credentials;
  }

  /**
   * Process a credential entry into the appropriate format
   * @param {string} name - Credential name
   * @param {Object} entry - NC Passwords entry
   * @returns {string|Object}
   */
  _processCredential(name, entry) {
    // Complex credentials need full object
    const complexCredentials = ['email-imap', 'email-smtp', 'caldav'];

    if (complexCredentials.some(c => name.toLowerCase().includes(c.toLowerCase()))) {
      return {
        password: entry.password,
        username: entry.username,
        user: entry.username, // alias
        host: this._extractHost(entry.url),
        url: entry.url,
        notes: entry.notes,
        ...this._parseExtras(entry)
      };
    }

    // Simple credentials just return the password
    return entry.password;
  }

  /**
   * Extract hostname from URL
   * @param {string} url
   * @returns {string|null}
   */
  _extractHost(url) {
    if (!url) return null;
    try {
      const urlStr = url.includes('://') ? url : `https://${url}`;
      return new URL(urlStr).hostname;
    } catch (error) {
      // URL parsing failed, return original
      console.debug('[CredentialCache] Could not parse URL:', url);
      return url;
    }
  }

  /**
   * Parse extra configuration from notes or customFields
   * @param {Object} entry
   * @returns {Object}
   */
  _parseExtras(entry) {
    const extras = {};

    // Try to parse notes as JSON
    if (entry.notes) {
      try {
        const parsed = JSON.parse(entry.notes);
        Object.assign(extras, parsed);
      } catch (error) {
        // Notes field is not JSON, which is normal for plain text notes
        // Only log if it looks like it might be malformed JSON
        if (entry.notes.trim().startsWith('{')) {
          console.debug('[CredentialCache] Notes field looks like JSON but failed to parse');
        }
      }
    }

    // NC Passwords custom fields
    if (entry.customFields && Array.isArray(entry.customFields)) {
      for (const field of entry.customFields) {
        if (field.label && field.value) {
          extras[field.label.toLowerCase()] = field.value;
        }
      }
    }

    return extras;
  }

  /**
   * Invalidate a specific credential from cache
   * @param {string} name - Credential name
   */
  invalidate(name) {
    const cached = this._cache.get(name);
    if (cached) {
      // Secure eviction - overwrite value before deleting
      if (typeof cached.value === 'string') {
        cached.value = ''.padStart(cached.value.length, '*');
      } else if (cached.value && typeof cached.value === 'object') {
        if (cached.value.password) {
          cached.value.password = ''.padStart(cached.value.password.length, '*');
        }
      }
      this._cache.delete(name);
    }
  }

  /**
   * Invalidate all cached credentials
   */
  invalidateAll() {
    // Secure eviction for all cached credentials
    for (const [_, cached] of this._cache) {
      if (typeof cached.value === 'string') {
        cached.value = ''.padStart(cached.value.length, '*');
      } else if (cached.value && typeof cached.value === 'object') {
        if (cached.value.password) {
          cached.value.password = ''.padStart(cached.value.password.length, '*');
        }
      }
    }
    this._cache.clear();

    // Clear the all-credentials cache
    this._allCredentials = null;
    this._allCredentialsExpiry = 0;
  }

  /**
   * Shutdown - clear all caches securely
   */
  shutdown() {
    this.invalidateAll();
  }

  /**
   * Get cache statistics
   * @returns {Object}
   */
  getStats() {
    return {
      cacheSize: this._cache.size,
      allCredentialsCached: this._allCredentials !== null && Date.now() < this._allCredentialsExpiry
    };
  }
}

module.exports = CredentialCache;
