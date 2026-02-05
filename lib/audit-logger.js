/**
 * MoltAgent Audit Logger
 *
 * Writes audit logs to Nextcloud Files for persistence and tamper-evidence.
 * Uses NCRequestManager for WebDAV API calls.
 *
 * @version 2.0.0
 */

const path = require('path');

class AuditLogger {
  /**
   * @param {Object} ncRequestManagerOrConfig - NCRequestManager instance or legacy config
   * @param {Object} [config] - Configuration object (new signature)
   */
  constructor(ncRequestManagerOrConfig, config = {}) {
    // Support both new (ncRequestManager, config) and legacy (config) signatures
    if (ncRequestManagerOrConfig && typeof ncRequestManagerOrConfig.request === 'function') {
      // New signature
      this.nc = ncRequestManagerOrConfig;
      this.ncUrl = this.nc.ncUrl;
      this.username = this.nc.ncUser || 'moltagent';
    } else {
      // Legacy signature: (config)
      const legacyConfig = ncRequestManagerOrConfig || {};
      this.nc = null;
      this.ncUrl = legacyConfig.ncUrl;
      this.username = legacyConfig.username;
      this.password = legacyConfig.password;
    }

    this.basePath = config.logPath || ncRequestManagerOrConfig?.logPath || '/moltagent/Logs';
    this.webdavUrl = `${this.ncUrl}/remote.php/dav/files/${this.username}`;

    // In-memory buffer for batching writes
    this.buffer = [];
    this.flushInterval = config.flushInterval || ncRequestManagerOrConfig?.flushInterval || 5000; // 5 seconds
    this.maxBufferSize = config.maxBufferSize || ncRequestManagerOrConfig?.maxBufferSize || 50;

    // Start flush timer
    this.flushTimer = setInterval(() => this.flush(), this.flushInterval);

    // Current log file (rotates daily)
    this.currentDate = null;
    this.currentLogFile = null;
  }

  /**
   * Log an event
   */
  async log(event, details = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      event: event,
      ...details
    };

    this.buffer.push(entry);

    // Also log to console
    console.log(`[Audit] ${event}:`, JSON.stringify(details));

    // Flush if buffer is full
    if (this.buffer.length >= this.maxBufferSize) {
      await this.flush();
    }

    return entry;
  }

  /**
   * Log credential access
   */
  async logCredentialAccess(label, success, reason = null) {
    return this.log('credential_access', {
      credential: label,
      success: success,
      reason: reason
    });
  }

  /**
   * Log LLM request
   */
  async logLLMRequest(provider, task, tokens, cost, success, error = null) {
    return this.log('llm_request', {
      provider: provider,
      task: task,
      tokens: tokens,
      cost: cost,
      success: success,
      error: error
    });
  }

  /**
   * Log security event
   */
  async logSecurityEvent(type, details) {
    return this.log('security', {
      type: type,
      ...details
    });
  }

  /**
   * Log chat message
   */
  async logChatMessage(user, message, response, provider) {
    return this.log('chat', {
      user: user,
      messagePreview: message.substring(0, 100) + (message.length > 100 ? '...' : ''),
      responsePreview: response.substring(0, 100) + (response.length > 100 ? '...' : ''),
      provider: provider
    });
  }

  /**
   * Log budget event
   */
  async logBudgetEvent(provider, spent, limit, action) {
    return this.log('budget', {
      provider: provider,
      spent: spent,
      limit: limit,
      action: action
    });
  }

  /**
   * Flush buffer to NC Files
   */
  async flush() {
    if (this.buffer.length === 0) return;

    const entries = [...this.buffer];
    this.buffer = [];

    try {
      // Get current log file path
      const logFile = this.getLogFilePath();

      // Format entries as JSONL (one JSON object per line)
      const content = entries.map(e => JSON.stringify(e)).join('\n') + '\n';

      // Append to file
      await this.appendToFile(logFile, content);

    } catch (error) {
      console.error('[Audit] Failed to flush logs:', error.message);

      // On rate limit (429), keep fewer entries to prevent overflow
      if (error.message.includes('429') || error.message.includes('Rate limited')) {
        console.log('[Audit] Rate limited, dropping old entries');
        // Only keep recent entries
        this.buffer = entries.slice(-10);
      } else {
        // For other errors, put entries back for retry
        this.buffer = [...entries, ...this.buffer];
      }
    }
  }

  /**
   * Get log file path (rotates daily)
   */
  getLogFilePath() {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    if (today !== this.currentDate) {
      this.currentDate = today;
      this.currentLogFile = `${this.basePath}/audit-${today}.jsonl`;
    }

    return this.currentLogFile;
  }

  /**
   * Append content to a file via WebDAV
   */
  async appendToFile(filePath, content) {
    const url = `/remote.php/dav/files/${this.username}${filePath}`;

    // First, try to get existing content
    let existingContent = '';
    try {
      if (this.nc) {
        const getResponse = await this.nc.request(url, { method: 'GET' });
        if (getResponse.status === 200) {
          existingContent = typeof getResponse.body === 'string'
            ? getResponse.body
            : JSON.stringify(getResponse.body);
        }
      } else {
        // Legacy mode
        const auth = Buffer.from(`${this.username}:${this.password}`).toString('base64');
        const response = await fetch(`${this.ncUrl}${url}`, {
          method: 'GET',
          headers: { 'Authorization': `Basic ${auth}` }
        });
        if (response.ok) {
          existingContent = await response.text();
        }
      }
    } catch (e) {
      // File might not exist yet, that's OK
    }

    // Write combined content
    if (this.nc) {
      const putResponse = await this.nc.request(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain' },
        body: existingContent + content
      });

      if (putResponse.status >= 400 && putResponse.status !== 404) {
        throw new Error(`WebDAV PUT failed: ${putResponse.status}`);
      }
    } else {
      // Legacy mode
      const auth = Buffer.from(`${this.username}:${this.password}`).toString('base64');
      const response = await fetch(`${this.ncUrl}${url}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'text/plain'
        },
        body: existingContent + content
      });

      if (!response.ok && response.status !== 201 && response.status !== 204) {
        throw new Error(`WebDAV PUT failed: ${response.status}`);
      }
    }
  }

  /**
   * Ensure log directory exists
   */
  async ensureLogDirectory() {
    const url = `/remote.php/dav/files/${this.username}${this.basePath}`;

    // Try to create directory (MKCOL)
    if (this.nc) {
      const response = await this.nc.request(url, { method: 'MKCOL' });
      // 201 = created, 405 = already exists (both OK)
      if (response.status !== 201 && response.status !== 405 && response.status < 400) {
        return true;
      }

      // 409 = parent doesn't exist, try to create parent first
      if (response.status === 409) {
        const parentPath = path.dirname(this.basePath);
        if (parentPath !== '/') {
          await this.createDirectory(parentPath);
          return this.ensureLogDirectory();
        }
      }

      if (response.status >= 400 && response.status !== 405) {
        throw new Error(`Failed to create log directory: ${response.status}`);
      }
      return true;
    } else {
      // Legacy mode
      const auth = Buffer.from(`${this.username}:${this.password}`).toString('base64');
      const response = await fetch(`${this.ncUrl}${url}`, {
        method: 'MKCOL',
        headers: { 'Authorization': `Basic ${auth}` }
      });

      // 201 = created, 405 = already exists (both OK)
      if (response.ok || response.status === 405) {
        return true;
      }

      // 409 = parent doesn't exist, try to create parent first
      if (response.status === 409) {
        const parentPath = path.dirname(this.basePath);
        if (parentPath !== '/') {
          await this.createDirectory(parentPath);
          return this.ensureLogDirectory();
        }
      }

      throw new Error(`Failed to create log directory: ${response.status}`);
    }
  }

  /**
   * Create a directory
   */
  async createDirectory(dirPath) {
    const url = `/remote.php/dav/files/${this.username}${dirPath}`;

    if (this.nc) {
      const response = await this.nc.request(url, { method: 'MKCOL' });
      return response.status === 201 || response.status === 405;
    } else {
      // Legacy mode
      const auth = Buffer.from(`${this.username}:${this.password}`).toString('base64');
      const response = await fetch(`${this.ncUrl}${url}`, {
        method: 'MKCOL',
        headers: { 'Authorization': `Basic ${auth}` }
      });
      return response.ok || response.status === 405;
    }
  }

  /**
   * Get recent log entries
   */
  async getRecentLogs(days = 1) {
    const logs = [];

    for (let i = 0; i < days; i++) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      const filePath = `${this.basePath}/audit-${dateStr}.jsonl`;
      const url = `/remote.php/dav/files/${this.username}${filePath}`;

      try {
        let content;
        if (this.nc) {
          const response = await this.nc.request(url, { method: 'GET' });
          if (response.status === 200) {
            content = typeof response.body === 'string'
              ? response.body
              : JSON.stringify(response.body);
          }
        } else {
          // Legacy mode
          const auth = Buffer.from(`${this.username}:${this.password}`).toString('base64');
          const response = await fetch(`${this.ncUrl}${url}`, {
            method: 'GET',
            headers: { 'Authorization': `Basic ${auth}` }
          });
          if (response.ok) {
            content = await response.text();
          }
        }

        if (content) {
          const entries = content.trim().split('\n')
            .filter(line => line.trim())
            .map(line => {
              try {
                return JSON.parse(line);
              } catch {
                return null;
              }
            })
            .filter(e => e !== null);

          logs.push(...entries);
        }
      } catch (e) {
        // File might not exist, skip
      }
    }

    return logs;
  }

  /**
   * Get summary statistics
   */
  async getSummary(days = 1) {
    const logs = await this.getRecentLogs(days);

    const summary = {
      totalEvents: logs.length,
      byType: {},
      llmCalls: 0,
      totalCost: 0,
      credentialAccesses: 0,
      securityEvents: 0,
      errors: 0
    };

    for (const entry of logs) {
      // Count by type
      summary.byType[entry.event] = (summary.byType[entry.event] || 0) + 1;

      // Specific counts
      if (entry.event === 'llm_request') {
        summary.llmCalls++;
        summary.totalCost += entry.cost || 0;
        if (!entry.success) summary.errors++;
      }

      if (entry.event === 'credential_access') {
        summary.credentialAccesses++;
      }

      if (entry.event === 'security') {
        summary.securityEvents++;
      }
    }

    return summary;
  }

  /**
   * Shutdown - flush remaining logs
   */
  async shutdown() {
    clearInterval(this.flushTimer);
    await this.flush();
  }
}

module.exports = AuditLogger;
