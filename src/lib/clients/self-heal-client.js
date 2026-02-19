/**
 * SelfHealClient — HTTP client for the heald daemon on the Ollama VM.
 *
 * Talks to the self-heal daemon to check health and restart allowlisted services.
 * Token is fetched from credentialBroker on first use, then cached.
 *
 * @module clients/self-heal-client
 */

'use strict';

class SelfHealClient {
  /**
   * @param {Object} config
   * @param {string} config.url            - heald base URL (e.g. http://138.201.246.236:7867)
   * @param {string} config.tokenCredential - NC Passwords label for the bearer token
   * @param {number} [config.timeoutMs=15000]
   * @param {Object} config.credentialBroker - CredentialBroker instance
   */
  constructor({ url, tokenCredential, timeoutMs, credentialBroker }) {
    this.url = url.replace(/\/+$/, '');
    this.tokenCredential = tokenCredential;
    this.timeoutMs = timeoutMs || 15000;
    this.credentialBroker = credentialBroker;
    this._token = null;
  }

  /**
   * Fetch bearer token from credential broker (cached after first call).
   * @returns {Promise<string>}
   * @private
   */
  async _getToken() {
    if (this._token) return this._token;
    const token = await this.credentialBroker.get(this.tokenCredential);
    if (!token) throw new Error(`Credential "${this.tokenCredential}" not found in broker`);
    this._token = token;
    return this._token;
  }

  /**
   * GET /health — no auth required.
   * @returns {Promise<{status: string, services: string[]}>}
   */
  async health() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.url}/health`, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * POST /restart/<service> — auth required.
   * @param {string} service - systemd service name (e.g. 'ollama', 'whisper-server')
   * @returns {Promise<{ok: boolean, service: string, message: string}>}
   */
  async restart(service) {
    const token = await this._getToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.url}/restart/${encodeURIComponent(service)}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        signal: controller.signal
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      return body;
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = SelfHealClient;
