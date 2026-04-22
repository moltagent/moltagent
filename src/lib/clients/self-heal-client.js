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
   * @param {string} config.url            - heald base URL (e.g. http://YOUR_OLLAMA_IP:7867)
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
    /** @type {Error|null} Permanent failure (e.g. credential never existed) — once set, further work is refused. See #26. */
    this._permanentFailure = null;
  }

  /**
   * False once a permanent failure has been latched (e.g. credential not
   * found in NC Passwords). InfraMonitor and other callers should check
   * this before attempting restart() so they do not log a failed-restart
   * warning on every probe cycle.
   * @returns {boolean}
   */
  get isAvailable() {
    return !this._permanentFailure;
  }

  /**
   * Fetch bearer token from credential broker (cached after first call).
   * If the credential is missing, the failure is latched on this.
   * @returns {Promise<string>}
   * @private
   */
  async _getToken() {
    if (this._permanentFailure) throw this._permanentFailure;
    if (this._token) return this._token;
    const token = await this.credentialBroker.get(this.tokenCredential);
    if (!token) {
      const err = new Error(`Credential "${this.tokenCredential}" not found in broker`);
      this._permanentFailure = err;
      console.warn(`[SelfHealClient] Disabled: ${err.message}. Remote self-heal will not be attempted this session.`);
      throw err;
    }
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
