/**
 * Moltagent Credential Broker
 *
 * Secure credential management via NC Passwords API.
 *
 * Security principles:
 * - Bootstrap credential loaded from systemd LoadCredential (or env fallback)
 * - Credentials fetched via CredentialCache (which uses NCRequestManager)
 * - Short cache (30s) to reduce API calls
 * - Immediate discard after use
 * - All access logged for audit trail
 *
 * @module credential-broker
 * @version 2.0.0
 */

const fs = require('fs');
const path = require('path');

class CredentialBroker {
  /**
   * @param {Object} credentialCache - CredentialCache instance
   * @param {Object} config
   * @param {string} [config.ncUrl] - Nextcloud base URL (for legacy compatibility)
   * @param {string} [config.ncUsername] - Nextcloud username (for legacy compatibility)
   * @param {Function} [config.auditLog] - Audit logging function
   */
  constructor(credentialCache, config = {}) {
    // Support both new (credentialCache, config) and legacy (config) signatures
    if (credentialCache && typeof credentialCache.get === 'function') {
      // New signature: (credentialCache, config)
      this.credentialCache = credentialCache;
      this.ncUrl = config.ncUrl || process.env.NC_URL || '';
      this.ncUsername = config.ncUsername || process.env.NC_USER || 'moltagent';
      this.auditLog = config.auditLog || (async () => {});
    } else {
      // Legacy signature: (config) - credentialCache is actually config
      const legacyConfig = credentialCache || {};
      this.credentialCache = null; // Will operate in legacy mode
      this.ncUrl = (legacyConfig.ncUrl || process.env.NC_URL || '').replace(/\/$/, '');
      this.ncUsername = legacyConfig.ncUsername || process.env.NC_USER || 'moltagent';
      this.auditLog = legacyConfig.auditLog || (async () => {});
    }

    // Bootstrap credential (for accessing NC Passwords API)
    this._bootstrapCredential = null;
    this._bootstrapLoaded = false;

    // Stats for monitoring
    this.stats = {
      totalRequests: 0,
      cacheHits: 0,
      cacheMisses: 0,
      errors: 0
    };
  }

  /**
   * Load bootstrap credential from systemd LoadCredential or fallback
   * @private
   */
  _loadBootstrapCredential() {
    if (this._bootstrapLoaded) {
      return this._bootstrapCredential;
    }

    // Method 1: systemd LoadCredential (most secure)
    // When using LoadCredential=nc-password:/path, systemd sets CREDENTIALS_DIRECTORY
    const credDir = process.env.CREDENTIALS_DIRECTORY;
    if (credDir) {
      const credPath = path.join(credDir, 'nc-password');
      try {
        this._bootstrapCredential = fs.readFileSync(credPath, 'utf8').trim();
        this._bootstrapLoaded = true;
        console.log('[CredentialBroker] Bootstrap credential loaded from systemd');
        return this._bootstrapCredential;
      } catch (err) {
        console.warn('[CredentialBroker] Failed to read systemd credential:', err.message);
      }
    }

    // Method 2: Dedicated credential file (for development)
    const devCredPath = process.env.NC_CREDENTIAL_FILE;
    if (devCredPath) {
      try {
        this._bootstrapCredential = fs.readFileSync(devCredPath, 'utf8').trim();
        this._bootstrapLoaded = true;
        console.log('[CredentialBroker] Bootstrap credential loaded from file');
        return this._bootstrapCredential;
      } catch (err) {
        console.warn('[CredentialBroker] Failed to read credential file:', err.message);
      }
    }

    // Method 3: Environment variable (least secure, for testing only)
    if (process.env.NC_PASSWORD) {
      this._bootstrapCredential = process.env.NC_PASSWORD;
      this._bootstrapLoaded = true;
      console.warn('[CredentialBroker] WARNING: Using NC_PASSWORD env var - not recommended for production');
      return this._bootstrapCredential;
    }

    throw new Error('No bootstrap credential available. Configure systemd LoadCredential, NC_CREDENTIAL_FILE, or NC_PASSWORD');
  }

  /**
   * Get the Nextcloud password (bootstrap credential)
   * This is the credential used to authenticate with NC APIs
   * @returns {string}
   */
  getNCPassword() {
    return this._loadBootstrapCredential();
  }

  /**
   * Get a credential by name from NC Passwords
   * @param {string} name - Credential name (e.g., 'claude-api-key')
   * @returns {Promise<string|Object>} - The credential value
   */
  async get(name) {
    this.stats.totalRequests++;

    try {
      // Use CredentialCache if available
      if (this.credentialCache) {
        const value = await this.credentialCache.get(name);
        await this.auditLog('credential_fetched', { name });
        return value;
      }

      // Legacy mode - should not happen in new setup
      throw new Error('CredentialBroker requires CredentialCache in new architecture');

    } catch (error) {
      this.stats.errors++;
      await this.auditLog('credential_error', { name, error: error.message });
      throw error;
    }
  }

  /**
   * Prefetch multiple credentials in a single API call
   * @param {string[]} names - List of credential names
   * @returns {Promise<Object>} - Map of name -> value
   */
  async prefetchAll(names) {
    if (!this.credentialCache) {
      throw new Error('prefetchAll requires CredentialCache');
    }
    return this.credentialCache.prefetchAll(names);
  }

  /**
   * List all available credential names (for debugging)
   * @returns {Promise<string[]>}
   */
  async listAvailable() {
    if (this.credentialCache) {
      // Fetch via cache's internal method
      const credentials = await this.credentialCache._fetchAllCredentials(true);
      return credentials.map(p => p.label || p.username || 'unnamed');
    }

    throw new Error('listAvailable requires CredentialCache');
  }

  /**
   * Clear a credential from cache (force refresh)
   * @param {string} name
   */
  clearCache(name) {
    if (this.credentialCache) {
      if (name) {
        this.credentialCache.invalidate(name);
      } else {
        this.credentialCache.invalidateAll();
      }
    }
  }

  /**
   * Discard all cached credentials (security measure)
   */
  discardAll() {
    // Clear credential cache
    if (this.credentialCache) {
      this.credentialCache.shutdown();
    }

    // Also clear bootstrap credential
    if (this._bootstrapCredential) {
      this._bootstrapCredential = ''.padStart(this._bootstrapCredential.length, '*');
      this._bootstrapCredential = null;
      this._bootstrapLoaded = false;
    }
  }

  /**
   * Test connection to NC Passwords
   * @returns {Promise<Object>}
   */
  async testConnection() {
    try {
      const available = await this.listAvailable();
      return {
        connected: true,
        credentialCount: available.length,
        credentials: available
      };
    } catch (error) {
      return {
        connected: false,
        error: error.message
      };
    }
  }

  /**
   * Get broker statistics
   * @returns {Object}
   */
  getStats() {
    const cacheStats = this.credentialCache ? this.credentialCache.getStats() : {};
    return {
      ...this.stats,
      ...cacheStats,
      hitRate: this.stats.totalRequests > 0
        ? (this.stats.cacheHits / this.stats.totalRequests * 100).toFixed(1) + '%'
        : 'N/A'
    };
  }

  /**
   * Create a credential getter function for use with LLM Router
   * @returns {Function}
   */
  createGetter() {
    return async (name) => {
      return await this.get(name);
    };
  }
}

/**
 * Wrapper for one-time credential use
 * @param {CredentialBroker} broker
 * @param {string} credentialName
 * @param {Function} operation - Async function that receives the credential
 * @returns {Promise<any>}
 */
async function withCredential(broker, credentialName, operation) {
  let credential = null;

  try {
    // Fetch credential
    credential = await broker.get(credentialName);

    // Execute operation
    const result = await operation(credential);

    return result;
  } finally {
    // Discard credential from local scope
    if (credential) {
      credential = ''.padStart(credential.length, '*');
      credential = null;
    }
  }
}

module.exports = CredentialBroker;
module.exports.withCredential = withCredential;
