/*
 * MoltAgent - Sovereign AI Security Layer
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
 * Skill Forge OAuth 2.0 Broker
 *
 * Architecture Brief:
 * -------------------
 * Problem: SkillForge tools need OAuth 2.0 tokens for APIs like Google,
 * Microsoft, GitHub — but the HttpToolExecutor only knows static credentials.
 * Generating/refreshing tokens requires a lifecycle: consent → exchange →
 * store → refresh → rotate.
 *
 * Pattern: Credential lifecycle manager. NC Passwords is the single source
 * of truth for both client credentials and token state. Pending authorization
 * state is persisted to NC Passwords (not memory) so callbacks survive
 * process restarts. Token refresh uses a per-credential mutex to prevent
 * concurrent refresh races within one process.
 *
 * Key Dependencies:
 *   - CredentialBroker (injected): .get(name) → credential object
 *   - NCRequestManager (injected): NC Passwords create/update/delete API
 *   - crypto (Node.js built-in): PKCE + state nonce generation
 *
 * Data Flow:
 *   Consent: beginAuthorization → persist pending to NC → return auth URL
 *   Callback: handleCallback → validate state from NC → exchange code → store tokens
 *   Token:   getAccessToken → read from NC → refresh if expired → return bearer string
 *
 * Dependency Map:
 *   ← HttpToolExecutor (calls getAccessToken for oauth2 auth type)
 *   ← webhook-server.js (calls handleCallback on /oauth/callback)
 *   ← SkillForgeHandler (calls beginAuthorization during skill setup)
 *   ← HeartbeatManager (calls cleanExpiredPending on each pulse)
 *   → CredentialBroker (reads credentials)
 *   → NCRequestManager (writes tokens, creates/deletes pending entries)
 */

const crypto = require('crypto');

const PENDING_PREFIX = 'oauth-pending-';
const PENDING_TTL_MS = 10 * 60 * 1000; // 10 minutes
const TOKEN_EXPIRY_BUFFER_MS = 60 * 1000; // Refresh 60s before expiry

class OAuthBroker {
  /**
   * @param {Object} config
   * @param {Object} config.credentialBroker - { get(name), listAvailable(), clearCache(name) }
   * @param {Object} config.ncRequestManager - NCRequestManager for NC Passwords writes
   * @param {string} config.redirectUri - OAuth callback URL (e.g. https://agent.example.com/oauth/callback)
   * @param {Function} [config.auditLog] - async (event, metadata) => void
   */
  constructor(config) {
    this.credentialBroker = config.credentialBroker;
    this.nc = config.ncRequestManager;
    this.redirectUri = config.redirectUri;
    this.auditLog = config.auditLog || (async () => {});

    // Per-credential mutex to prevent concurrent refresh races
    this._refreshLocks = new Map();
  }

  // ─── Consent Flow ───────────────────────────────────────────────────

  /**
   * Begin OAuth authorization — generates auth URL and persists pending state to NC Passwords.
   * @param {Object} templateAuth - auth block from skill template YAML
   * @param {string} credentialName - NC Passwords label for the OAuth credential
   * @returns {Promise<string>} Authorization URL for the user to click
   */
  async beginAuthorization(templateAuth, credentialName) {
    // Read client_id from NC Passwords (username field)
    const cred = await this.credentialBroker.get(credentialName);
    const clientId = cred?.username || cred?.user;
    if (!clientId) {
      throw new Error(`OAuth credential "${credentialName}" missing client_id (username field in NC Passwords)`);
    }

    // Generate PKCE
    const codeVerifier = this._generateCodeVerifier();
    const codeChallenge = this._generateCodeChallenge(codeVerifier);

    // Generate state nonce
    const state = crypto.randomBytes(16).toString('hex');

    // Persist pending state to NC Passwords (survives process restarts)
    const pendingLabel = `${PENDING_PREFIX}${state}`;
    const pendingNotes = JSON.stringify({
      type: 'oauth_pending',
      credential_name: credentialName,
      skill_id: templateAuth.skill_id || '',
      expires_at: Date.now() + PENDING_TTL_MS,
      created_at: Date.now()
    });

    await this._createNCPasswordEntry(pendingLabel, codeVerifier, '', '', pendingNotes);

    await this.auditLog('oauth_consent_initiated', {
      credentialName,
      skillId: templateAuth.skill_id || '',
      scope: templateAuth.scope || '',
      provider: templateAuth.authorize_endpoint || ''
    });
    await this.auditLog('oauth_pending_persisted', {
      state: state.substring(0, 8),
      credentialName
    });

    // Secure eviction of credential object
    if (cred.password) cred.password = '*'.repeat(cred.password.length);
    if (cred.access_token) cred.access_token = '*'.repeat(cred.access_token.length);

    // Build authorization URL
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: templateAuth.scope || '',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256'
    });

    return `${templateAuth.authorize_endpoint}?${params.toString()}`;
  }

  /**
   * Handle OAuth callback — exchange authorization code for tokens.
   * @param {string} code - Authorization code from provider
   * @param {string} state - State nonce for validation
   * @returns {Promise<Object>} { success, skillId, credentialName }
   */
  async handleCallback(code, state) {
    // Read pending state from NC Passwords
    const pendingLabel = `${PENDING_PREFIX}${state}`;
    let pending;
    try {
      pending = await this.credentialBroker.get(pendingLabel);
    } catch (err) {
      await this.auditLog('oauth_callback_failed', {
        state: state.substring(0, 8),
        reason: 'pending_not_found'
      });
      throw new Error('Invalid or expired OAuth state. Please start authorization again from the chat.');
    }

    // Validate pending state
    const notes = this._parseNotes(pending);
    if (!notes || notes.type !== 'oauth_pending') {
      await this.auditLog('oauth_callback_failed', {
        state: state.substring(0, 8),
        reason: 'invalid_pending_type'
      });
      throw new Error('Invalid OAuth pending state.');
    }

    if (notes.expires_at && Date.now() > notes.expires_at) {
      await this._deleteNCPasswordEntry(pendingLabel);
      await this.auditLog('oauth_callback_failed', {
        state: state.substring(0, 8),
        reason: 'expired'
      });
      throw new Error('OAuth authorization session expired. Please start again from the chat.');
    }

    const credentialName = notes.credential_name;
    const skillId = notes.skill_id || '';
    const codeVerifier = pending.password; // PKCE verifier stored in password field

    // Delete pending entry immediately (one-time use)
    await this._deleteNCPasswordEntry(pendingLabel);
    this.credentialBroker.clearCache(pendingLabel);

    // Read main credential for client_id, client_secret, token_endpoint
    let mainCred;
    try {
      mainCred = await this.credentialBroker.get(credentialName);
    } catch (err) {
      throw new Error(`OAuth credential "${credentialName}" not found in NC Passwords.`);
    }

    const clientId = mainCred.username || mainCred.user;
    const clientSecret = mainCred.password;
    const tokenEndpoint = mainCred.url;

    if (!clientId || !clientSecret || !tokenEndpoint) {
      throw new Error(`OAuth credential "${credentialName}" incomplete. Need username (client_id), password (client_secret), and url (token_endpoint).`);
    }

    // Exchange code for tokens
    let tokenResponse;
    try {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: codeVerifier
      });

      const response = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(30000)
      });

      tokenResponse = await response.json();

      if (!response.ok || !tokenResponse.access_token) {
        const errMsg = tokenResponse.error_description || tokenResponse.error || 'Unknown error';
        throw new Error(`Token exchange failed: ${errMsg}`);
      }
    } finally {
      // Secure eviction of main credential
      if (mainCred.password) mainCred.password = '*'.repeat(mainCred.password.length);
      if (mainCred.access_token) mainCred.access_token = '*'.repeat(mainCred.access_token.length);
      if (mainCred.refresh_token) mainCred.refresh_token = '*'.repeat(mainCred.refresh_token.length);
    }

    // Store tokens in NC Passwords notes (read-modify-write)
    const existingNotes = this._parseNotes(mainCred) || {};
    const updatedNotes = {
      ...existingNotes,
      grant_type: 'authorization_code',
      access_token: tokenResponse.access_token,
      refresh_token: tokenResponse.refresh_token || existingNotes.refresh_token || null,
      expires_at: tokenResponse.expires_in
        ? Date.now() + tokenResponse.expires_in * 1000
        : null,
      scope: tokenResponse.scope || existingNotes.scope,
      pkce: true
    };

    await this._updateNCPasswordNotes(credentialName, updatedNotes);
    this.credentialBroker.clearCache(credentialName);

    await this.auditLog('oauth_token_acquired', {
      credentialName,
      skillId,
      hasRefreshToken: !!updatedNotes.refresh_token
    });

    await this.auditLog('oauth_callback_received', {
      state: state.substring(0, 8),
      success: true
    });

    return { success: true, skillId, credentialName };
  }

  // ─── Token Lifecycle ────────────────────────────────────────────────

  /**
   * Get a valid access token — refreshes if expired.
   * @param {string} credentialName - NC Passwords label
   * @param {Object} [opts={}]
   * @param {boolean} [opts.forceRefresh=false] - Skip expiry check, always refresh (for 401 retry)
   * @returns {Promise<string>} Access token string
   */
  async getAccessToken(credentialName, opts = {}) {
    return this._withRefreshLock(credentialName, async () => {
      let cred = await this.credentialBroker.get(credentialName);
      try {
        const notes = this._parseNotes(cred);
        if (!notes) {
          throw new Error(`OAuth credential "${credentialName}" has no token data in notes.`);
        }

        const grantType = notes.grant_type;

        if (grantType === 'client_credentials') {
          return await this._getClientCredentialsToken(credentialName, cred, notes, opts);
        }

        // Authorization code flow
        if (!opts.forceRefresh && notes.access_token && notes.expires_at
            && notes.expires_at > Date.now() + TOKEN_EXPIRY_BUFFER_MS) {
          return notes.access_token;
        }

        // Need refresh
        if (grantType === 'authorization_code') {
          if (!notes.refresh_token) {
            throw new Error(`No refresh token for "${credentialName}". Reauthorization required.`);
          }
          return await this._refreshAuthCodeToken(credentialName, cred, notes);
        }

        // Unknown grant type — try returning existing token
        if (notes.access_token) return notes.access_token;
        throw new Error(`OAuth credential "${credentialName}" has unknown grant_type "${grantType}" and no access_token.`);
      } finally {
        // Secure eviction
        if (cred && typeof cred === 'object') {
          if (cred.access_token) cred.access_token = '*'.repeat(cred.access_token.length);
          if (cred.refresh_token) cred.refresh_token = '*'.repeat(cred.refresh_token.length);
          if (cred.password) cred.password = '*'.repeat(cred.password.length);
        }
        cred = null;
      }
    });
  }

  /**
   * Revoke tokens and clear stored token data.
   * @param {string} credentialName
   */
  async revokeTokens(credentialName) {
    // Clear token fields from NC Passwords notes
    const cred = await this.credentialBroker.get(credentialName);
    const notes = this._parseNotes(cred) || {};

    const clearedNotes = { ...notes };
    delete clearedNotes.access_token;
    delete clearedNotes.refresh_token;
    delete clearedNotes.expires_at;

    await this._updateNCPasswordNotes(credentialName, clearedNotes);
    this.credentialBroker.clearCache(credentialName);

    // Secure eviction
    if (cred.password) cred.password = '*'.repeat(cred.password.length);

    await this.auditLog('oauth_revoked', { credentialName });
  }

  // ─── Maintenance ────────────────────────────────────────────────────

  /**
   * Clean expired pending authorization entries from NC Passwords.
   * Called by HeartbeatManager on each pulse.
   * @returns {Promise<Object>} { deleted: number }
   */
  async cleanExpiredPending() {
    let deleted = 0;
    try {
      const labels = await this.credentialBroker.listAvailable();
      const pendingLabels = labels.filter(l => l.startsWith(PENDING_PREFIX));

      for (const label of pendingLabels) {
        try {
          const entry = await this.credentialBroker.get(label);
          const notes = this._parseNotes(entry);
          if (notes && notes.expires_at && Date.now() > notes.expires_at) {
            await this._deleteNCPasswordEntry(label);
            this.credentialBroker.clearCache(label);
            deleted++;
          }
        } catch (err) {
          // Entry may have been deleted between list and get — ignore
        }
      }
    } catch (err) {
      console.warn('[OAuthBroker] cleanExpiredPending error:', err.message);
    }

    if (deleted > 0) {
      await this.auditLog('oauth_pending_cleanup', { deleted });
    }

    return { deleted };
  }

  // ─── Internal: Token Refresh ────────────────────────────────────────

  async _refreshAuthCodeToken(credentialName, cred, notes) {
    const clientId = cred.username || cred.user;
    const clientSecret = cred.password;
    const tokenEndpoint = cred.url;

    if (!clientId || !clientSecret || !tokenEndpoint) {
      throw new Error(`OAuth credential "${credentialName}" missing client_id, client_secret, or token_endpoint.`);
    }

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: notes.refresh_token,
      client_id: clientId,
      client_secret: clientSecret
    });

    const response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(30000)
    });

    const tokenResponse = await response.json();

    if (!response.ok || !tokenResponse.access_token) {
      const errMsg = tokenResponse.error_description || tokenResponse.error || `HTTP ${response.status}`;
      await this.auditLog('oauth_token_refresh_failed', {
        credentialName,
        reason: errMsg
      });
      throw new Error(`Token refresh failed for "${credentialName}": ${errMsg}. Reauthorization may be required.`);
    }

    // Token rotation: use new refresh_token if provided
    const rotated = !!tokenResponse.refresh_token && tokenResponse.refresh_token !== notes.refresh_token;

    // Scope narrowing detection
    const scopeNarrowed = tokenResponse.scope && notes.scope && tokenResponse.scope !== notes.scope;
    if (scopeNarrowed) {
      console.warn(`[OAuthBroker] Scope narrowed for "${credentialName}": expected "${notes.scope}", got "${tokenResponse.scope}"`);
    }

    // Read-modify-write: re-read from NC to get latest notes before writing
    const freshCred = await this._readNCPasswordEntry(credentialName);
    const freshNotes = this._parseNotesRaw(freshCred?.notes) || {};

    const updatedNotes = {
      ...freshNotes,
      access_token: tokenResponse.access_token,
      expires_at: tokenResponse.expires_in
        ? Date.now() + tokenResponse.expires_in * 1000
        : null,
      ...(tokenResponse.refresh_token ? { refresh_token: tokenResponse.refresh_token } : {}),
      ...(tokenResponse.scope ? { scope: tokenResponse.scope } : {})
    };

    await this._updateNCPasswordNotes(credentialName, updatedNotes);
    this.credentialBroker.clearCache(credentialName);

    await this.auditLog('oauth_token_refreshed', {
      credentialName,
      rotated,
      scopeNarrowed: !!scopeNarrowed
    });

    return tokenResponse.access_token;
  }

  async _getClientCredentialsToken(credentialName, cred, notes, opts) {
    // Return cached token if valid
    if (!opts.forceRefresh && notes.access_token && notes.expires_at
        && notes.expires_at > Date.now() + TOKEN_EXPIRY_BUFFER_MS) {
      return notes.access_token;
    }

    // Acquire new token
    const clientId = cred.username || cred.user;
    const clientSecret = cred.password;
    const tokenEndpoint = cred.url;

    if (!clientId || !clientSecret || !tokenEndpoint) {
      throw new Error(`OAuth credential "${credentialName}" missing client_id, client_secret, or token_endpoint.`);
    }

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret
    });
    if (notes.scope) body.set('scope', notes.scope);

    const response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(30000)
    });

    const tokenResponse = await response.json();

    if (!response.ok || !tokenResponse.access_token) {
      const errMsg = tokenResponse.error_description || tokenResponse.error || `HTTP ${response.status}`;
      await this.auditLog('oauth_token_refresh_failed', {
        credentialName,
        reason: errMsg
      });
      throw new Error(`Client credentials token acquisition failed for "${credentialName}": ${errMsg}`);
    }

    // Read-modify-write
    const freshCred = await this._readNCPasswordEntry(credentialName);
    const freshNotes = this._parseNotesRaw(freshCred?.notes) || {};

    const updatedNotes = {
      ...freshNotes,
      access_token: tokenResponse.access_token,
      expires_at: tokenResponse.expires_in
        ? Date.now() + tokenResponse.expires_in * 1000
        : null,
      ...(tokenResponse.scope ? { scope: tokenResponse.scope } : {})
    };

    await this._updateNCPasswordNotes(credentialName, updatedNotes);
    this.credentialBroker.clearCache(credentialName);

    await this.auditLog('oauth_client_credentials_acquired', { credentialName });

    return tokenResponse.access_token;
  }

  // ─── Internal: Per-credential Mutex ─────────────────────────────────

  async _withRefreshLock(credentialName, fn) {
    const prev = this._refreshLocks.get(credentialName) || Promise.resolve();
    const next = prev.then(fn, fn);
    this._refreshLocks.set(credentialName, next);
    try {
      return await next;
    } finally {
      if (this._refreshLocks.get(credentialName) === next) {
        this._refreshLocks.delete(credentialName);
      }
    }
  }

  // ─── Internal: PKCE ─────────────────────────────────────────────────

  _generateCodeVerifier() {
    // 32 random bytes → 43-char base64url string
    return crypto.randomBytes(32)
      .toString('base64url');
  }

  _generateCodeChallenge(verifier) {
    return crypto.createHash('sha256')
      .update(verifier)
      .digest('base64url');
  }

  // ─── Internal: Notes Parsing ────────────────────────────────────────

  /**
   * Parse notes from a processed credential object (may have notes as
   * top-level fields from _parseExtras, or as a notes string).
   */
  _parseNotes(cred) {
    if (!cred || typeof cred !== 'object') return null;

    // If _parseExtras already expanded notes JSON into top-level fields,
    // the credential object IS the parsed notes (plus password, username, etc.)
    if (cred.grant_type) return cred;

    // Try parsing the notes string
    if (cred.notes && typeof cred.notes === 'string') {
      return this._parseNotesRaw(cred.notes);
    }

    return null;
  }

  /**
   * Parse raw notes string as JSON.
   */
  _parseNotesRaw(notesStr) {
    if (!notesStr) return null;
    try {
      return JSON.parse(notesStr);
    } catch (err) {
      return null;
    }
  }

  // ─── Internal: NC Passwords CRUD ────────────────────────────────────

  async _createNCPasswordEntry(label, password, username, url, notes) {
    return this.nc.request(
      '/index.php/apps/passwords/api/1.0/password/create',
      {
        method: 'POST',
        body: { label, password, username: username || '', url: url || '', notes: notes || '' }
      }
    );
  }

  async _readNCPasswordEntry(label) {
    // Read fresh from NC Passwords (bypasses credential cache)
    const response = await this.nc.request(
      '/index.php/apps/passwords/api/1.0/password/list',
      {
        method: 'POST',
        body: {},
        skipCache: true
      }
    );
    const all = Array.isArray(response.body) ? response.body : [];
    return all.find(e => e.label === label) || null;
  }

  async _updateNCPasswordNotes(credentialName, notesObj) {
    // Find entry ID, then update notes
    const entry = await this._readNCPasswordEntry(credentialName);
    if (!entry || !entry.id) {
      throw new Error(`Cannot update OAuth tokens: NC Passwords entry "${credentialName}" not found.`);
    }

    return this.nc.request(
      `/index.php/apps/passwords/api/1.0/password/update`,
      {
        method: 'PATCH',
        body: {
          id: entry.id,
          notes: JSON.stringify(notesObj)
        }
      }
    );
  }

  async _deleteNCPasswordEntry(label) {
    const entry = await this._readNCPasswordEntry(label);
    if (!entry || !entry.id) return; // Already gone

    return this.nc.request(
      `/index.php/apps/passwords/api/1.0/password/delete`,
      {
        method: 'DELETE',
        body: { id: entry.id }
      }
    );
  }
}

module.exports = { OAuthBroker };
