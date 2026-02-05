/**
 * MoltAgent Credential Broker
 * 
 * Fetches credentials from NC Passwords API at runtime.
 * Credentials are NEVER stored — used once, then discarded.
 */

class CredentialBroker {
  constructor(config) {
    this.ncUrl = config.ncUrl;
    this.username = config.username;
    this.password = config.password;  // NC user password, not the credentials we're fetching
    this.baseUrl = `${this.ncUrl}/index.php/apps/passwords/api/1.0`;
    
    // Cache of credential labels → IDs (not the actual secrets)
    this.labelIndex = new Map();
    this.lastIndexRefresh = 0;
    this.indexTTL = 300000;  // Refresh label index every 5 minutes
    
    // Audit log
    this.accessLog = [];
  }

  /**
   * Get a credential by label
   * Returns the password/secret value, then discards it from memory
   */
  async get(label) {
    const startTime = Date.now();
    
    try {
      // Refresh index if stale
      if (Date.now() - this.lastIndexRefresh > this.indexTTL) {
        await this.refreshIndex();
      }
      
      // Find credential ID by label
      const credentialId = this.labelIndex.get(label);
      if (!credentialId) {
        this.logAccess(label, null, false, 'not_found');
        throw new Error(`Credential not found: ${label}`);
      }
      
      // Fetch the credential
      const credential = await this.fetchCredential(credentialId);
      
      // Log access (without the actual secret)
      this.logAccess(label, credentialId, true, 'success');
      
      // Return only the password/secret value
      // The caller should use it immediately and discard
      return credential.password;
      
    } catch (error) {
      this.logAccess(label, null, false, error.message);
      throw error;
    }
  }

  /**
   * Refresh the label → ID index
   */
  async refreshIndex() {
    const response = await fetch(`${this.baseUrl}/password/list`, {
      method: 'GET',
      headers: this.getHeaders()
    });

    if (!response.ok) {
      throw new Error(`Failed to list credentials: ${response.status}`);
    }

    const credentials = await response.json();
    
    this.labelIndex.clear();
    for (const cred of credentials) {
      if (!cred.trashed && !cred.hidden) {
        this.labelIndex.set(cred.label, cred.id);
      }
    }
    
    this.lastIndexRefresh = Date.now();
    console.log(`[CredentialBroker] Index refreshed: ${this.labelIndex.size} credentials`);
  }

  /**
   * Fetch a single credential by ID
   */
  async fetchCredential(id) {
    const response = await fetch(`${this.baseUrl}/password/show`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ id: id })
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch credential: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Check if a credential exists (without fetching the secret)
   */
  async exists(label) {
    if (Date.now() - this.lastIndexRefresh > this.indexTTL) {
      await this.refreshIndex();
    }
    return this.labelIndex.has(label);
  }

  /**
   * List available credential labels (not the secrets)
   */
  async listLabels() {
    if (Date.now() - this.lastIndexRefresh > this.indexTTL) {
      await this.refreshIndex();
    }
    return Array.from(this.labelIndex.keys());
  }

  /**
   * Get HTTP headers for NC API
   */
  getHeaders() {
    const auth = Buffer.from(`${this.username}:${this.password}`).toString('base64');
    return {
      'Authorization': `Basic ${auth}`,
      'OCS-APIRequest': 'true',
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    };
  }

  /**
   * Log credential access for audit
   */
  logAccess(label, id, success, reason) {
    const entry = {
      timestamp: new Date().toISOString(),
      label: label,
      credentialId: id,
      success: success,
      reason: reason
    };
    
    this.accessLog.push(entry);
    
    // Keep only last 1000 entries in memory
    if (this.accessLog.length > 1000) {
      this.accessLog = this.accessLog.slice(-1000);
    }
    
    // Log to console for now (will integrate with NC file logging later)
    console.log(`[CredentialBroker] ${success ? '✓' : '✗'} ${label} - ${reason}`);
  }

  /**
   * Get recent access log
   */
  getAccessLog(limit = 100) {
    return this.accessLog.slice(-limit);
  }

  /**
   * Get broker status
   */
  getStatus() {
    return {
      ncUrl: this.ncUrl,
      username: this.username,
      credentialsIndexed: this.labelIndex.size,
      lastIndexRefresh: this.lastIndexRefresh ? new Date(this.lastIndexRefresh).toISOString() : null,
      recentAccesses: this.accessLog.length
    };
  }
}

module.exports = CredentialBroker;
