/*
 * Moltagent - Sovereign AI Security Layer
 * Copyright (C) 2026 Moltagent Contributors
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
 * Skill Forge HTTP Tool Executor
 *
 * Architecture Brief:
 * -------------------
 * Problem: Every forged skill that calls a REST API needs an execution engine.
 * Generating per-skill code is a security and maintenance liability — each
 * generated module would be a new attack surface. A single declarative
 * executor eliminates generated code entirely.
 *
 * Pattern: Stateless interpreter. operationConfig is the program; params are
 * the inputs. One instance is shared across all forged skills. Credentials
 * are fetched at call time and are function-scoped — they never sit in memory
 * between calls.
 *
 * Session auth is the exception: tokens are cached in-process (this._sessionCache)
 * with a TTL supplied by the skill config. The underlying credential (username +
 * password) is still fetched from CredentialBroker and is not retained. The
 * cached value is a derived session token only.
 *
 * Key Dependencies:
 *   - fetch (Node.js 18+ native): HTTP execution
 *   - CredentialBroker (injected): .get(name) → credential string
 *   - OAuthBroker (injected, optional): .getAccessToken(name, opts)
 *   - EgressGuard (injected, optional): .evaluate(url) → { allowed, reason }
 *
 * Data Flow:
 *   execute(operationConfig, params)
 *     -> _resolveUrl(urlTemplate, params)      — interpolate {{placeholders}}
 *     -> EgressGuard.evaluate(url)             — domain policy check
 *     -> _isPrivateOrMetadata(hostname)        — SSRF hard block
 *     -> CredentialBroker.get(credentialName)  — fetch secret at call time
 *     -> _buildAuthHeaders(auth, credential)   — credential → header map
 *     -> _appendQueryParams(url, params, list) — non-auth query string
 *     -> _resolveTemplate(bodyTemplate, ctx)   — deep template substitution
 *     -> fetch() with AbortController timeout  — actual HTTP call
 *     -> size check + JSON-or-text parse       — response normalisation
 *     -> return { success, status, data, error? }
 *
 * Session auth path:
 *   execute() → _ensureSession(auth)
 *     -> cache hit?  return { token, extras }
 *     -> cache miss: CredentialBroker.get() → POST session_endpoint
 *       -> _getNestedValue(response, token_path) → token
 *       -> store in _sessionCache with TTL
 *     -> inject token as Bearer + extras into template context
 *     -> 401 response: clear cache, retry once
 *
 * Dependency Map:
 *   HttpToolExecutor
 *     <- CredentialBroker  (required)
 *     <- OAuthBroker       (optional – for oauth2 auth type)
 *     <- EgressGuard       (optional)
 *     <- Node fetch        (runtime)
 *
 * @module skill-forge/http-tool-executor
 * @version 1.1.0
 */

'use strict';

const { URL } = require('url');

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576; // 1 MB
const DEFAULT_SESSION_TTL_SECONDS = 3600;

// Hostnames and literal IP strings that are always blocked (SSRF hard list).
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '169.254.169.254',
  'metadata.google.internal',
  'metadata.hetzner.cloud',
]);

// Private IP range prefixes matched as strings for speed.
// Covers: 10.x, 172.16-31.x, 192.168.x, 127.x, 169.254.x
const PRIVATE_PREFIXES = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^127\./,
  /^169\.254\./,
];

// Placeholder pattern: {{namespace.key}} or {{bare_name}}
// Captures: group 1 = full "namespace.key" or "bare_name"
const TEMPLATE_PLACEHOLDER_RE = /\{\{([^}]+)\}\}/g;

// -----------------------------------------------------------------------------
// HttpToolExecutor Class
// -----------------------------------------------------------------------------

/**
 * Executes REST API calls described by a declarative operationConfig.
 *
 * One instance is shared across all forged skills. Per-call state lives in
 * execute() stack frames. The only persistent instance state is the session
 * token cache (_sessionCache), which stores derived tokens with TTLs.
 */
class HttpToolExecutor {
  /**
   * Create a new HttpToolExecutor instance.
   *
   * @param {Object} options
   * @param {Object} options.credentialBroker - CredentialBroker with .get(name) method
   * @param {Object} [options.oauthBroker]    - OAuthBroker with .getAccessToken(name, opts) method (optional)
   * @param {Object} [options.egressGuard]    - EgressGuard with .evaluate(url) method (optional)
   * @param {number} [options.timeoutMs=30000]            - Fetch timeout in milliseconds
   * @param {number} [options.maxResponseBytes=1048576]   - Maximum accepted response size in bytes
   */
  constructor({ credentialBroker, oauthBroker = null, egressGuard = null, timeoutMs = DEFAULT_TIMEOUT_MS, maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES }) {
    if (!credentialBroker || typeof credentialBroker.get !== 'function') {
      throw new Error('HttpToolExecutor: credentialBroker must have a .get(name) method');
    }
    this.credentialBroker = credentialBroker;
    this.oauthBroker = oauthBroker;
    this.egressGuard = egressGuard;
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = Number.isFinite(maxResponseBytes) && maxResponseBytes > 0
      ? maxResponseBytes
      : DEFAULT_MAX_RESPONSE_BYTES;

    // In-process cache for session tokens: credential_name → { token, extras, expiresAt }
    this._sessionCache = new Map();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Execute a REST API call described by operationConfig using the given params.
   *
   * @param {Object} operationConfig - Declarative description of the API call
   * @param {string} operationConfig.method           - HTTP method
   * @param {string} operationConfig.url              - URL template with optional {{param}} placeholders
   * @param {Object} [operationConfig.auth]           - Authentication configuration
   * @param {string[]} [operationConfig.queryParams]  - Param names to send as query string
   * @param {string|null} [operationConfig.bodyType]  - 'json' or null
   * @param {string[]} [operationConfig.bodyFields]   - Param names to include in JSON body
   * @param {Object} [operationConfig.bodyTemplate]   - Object template with {{namespace.key}} placeholders
   * @param {Object} params - Key-value pairs provided by the LLM via function calling
   * @returns {Promise<{ success: boolean, status: number, data: any, error?: string }>}
   */
  async execute(operationConfig, params = {}) {
    if (!operationConfig || typeof operationConfig !== 'object') {
      return { success: false, status: 0, data: null, error: 'operationConfig must be an object' };
    }

    const {
      method = 'GET',
      url: urlTemplate,
      auth = { type: 'none' },
      queryParams: queryParamNames = [],
      bodyType = null,
      bodyFields = [],
      bodyTemplate = null,
    } = operationConfig;

    if (!urlTemplate || typeof urlTemplate !== 'string') {
      return { success: false, status: 0, data: null, error: 'operationConfig.url is required' };
    }

    // Step 1: Resolve {{param}} placeholders in URL
    let resolvedUrl;
    try {
      resolvedUrl = this._resolveUrl(urlTemplate, params);
    } catch (err) {
      return { success: false, status: 0, data: null, error: `URL resolution failed: ${err.message}` };
    }

    // Parse hostname once for all security checks
    let parsedUrl;
    try {
      parsedUrl = new URL(resolvedUrl);
    } catch (err) {
      return { success: false, status: 0, data: null, error: `Invalid URL after resolution: ${resolvedUrl}` };
    }

    // Strip IPv6 brackets — URL.hostname returns [::1] but SSRF checks need ::1
    let hostname = parsedUrl.hostname.toLowerCase();
    if (hostname.startsWith('[') && hostname.endsWith(']')) {
      hostname = hostname.slice(1, -1);
    }

    // Step 2: EgressGuard domain policy check (if available)
    if (this.egressGuard) {
      let guardResult;
      try {
        guardResult = await this.egressGuard.evaluate(resolvedUrl);
      } catch (err) {
        return { success: false, status: 0, data: null, error: `EgressGuard error: ${err.message}` };
      }
      if (guardResult && !guardResult.allowed) {
        return {
          success: false,
          status: 0,
          data: null,
          error: `Domain blocked by egress policy: ${guardResult.reason || hostname}`,
        };
      }
    }

    // Step 3: SSRF hard block — private IPs and metadata endpoints
    if (this._isPrivateOrMetadata(hostname)) {
      return {
        success: false,
        status: 0,
        data: null,
        error: `SSRF protection: request to private/metadata host "${hostname}" is blocked`,
      };
    }

    // Step 4: Fetch credentials
    // Session auth is handled separately — _ensureSession manages its own credential fetch.
    let credential = null;
    let sessionExtras = {};

    if (auth && auth.type === 'session') {
      // Session token lifecycle managed by _ensureSession; no credential needed here.
      // Token injection into headers happens after body building (step 5b below).
    } else if (auth && auth.type === 'oauth2' && auth.credentialName) {
      if (!this.oauthBroker) {
        return { success: false, status: 0, data: null, error: 'OAuth2 auth requires an OAuthBroker but none is configured' };
      }
      try {
        credential = await this.oauthBroker.getAccessToken(auth.credentialName);
      } catch (err) {
        return { success: false, status: 0, data: null, error: `OAuth token error for "${auth.credentialName}": ${err.message}` };
      }
    } else if (auth && auth.type !== 'none' && auth.credentialName) {
      try {
        credential = await this.credentialBroker.get(auth.credentialName);
      } catch (err) {
        return { success: false, status: 0, data: null, error: `Failed to retrieve credential "${auth.credentialName}": ${err.message}` };
      }
      if (credential == null) {
        return { success: false, status: 0, data: null, error: `Credential "${auth.credentialName}" not found` };
      }
    }

    // Step 5: Build request headers from auth config
    let headers = { 'User-Agent': 'Moltagent/1.0' };

    if (auth && auth.type === 'session') {
      // Session token fetched here so extras are available for body template substitution.
      let sessionResult;
      try {
        sessionResult = await this._ensureSession(auth);
      } catch (err) {
        return { success: false, status: 0, data: null, error: `Session auth failed: ${err.message}` };
      }
      headers['Authorization'] = `Bearer ${sessionResult.token}`;
      sessionExtras = sessionResult.extras || {};
    } else {
      try {
        const authHeaders = this._buildAuthHeaders(auth, credential);
        Object.assign(headers, authHeaders);
      } catch (err) {
        return { success: false, status: 0, data: null, error: `Auth header build failed: ${err.message}` };
      }
    }

    // Handle query_param auth (appends to URL rather than headers)
    let finalUrl = resolvedUrl;
    if (auth && auth.type === 'query_param' && credential) {
      const colonIdx = credential.indexOf(':');
      const key = colonIdx >= 0 ? credential.slice(0, colonIdx) : credential;
      const token = colonIdx >= 0 ? credential.slice(colonIdx + 1) : '';
      const keyParam = auth.keyParam || 'key';
      const tokenParam = auth.tokenParam || 'token';
      const sep = finalUrl.includes('?') ? '&' : '?';
      finalUrl = `${finalUrl}${sep}${encodeURIComponent(keyParam)}=${encodeURIComponent(key)}&${encodeURIComponent(tokenParam)}=${encodeURIComponent(token)}`;
    }

    // Step 6: Append non-auth query string params
    finalUrl = this._appendQueryParams(finalUrl, params, queryParamNames);

    // Step 7: Build request body
    // bodyTemplate (object with placeholders) takes priority over flat bodyFields.
    let body = undefined;
    if (bodyType === 'json' && bodyTemplate && typeof bodyTemplate === 'object') {
      const templateContext = {
        params: params || {},
        session: sessionExtras,
        credential: {},
      };
      const resolved = this._resolveTemplate(bodyTemplate, templateContext);
      body = JSON.stringify(resolved);
      headers['Content-Type'] = 'application/json';
    } else if (bodyType === 'json' && bodyFields && bodyFields.length > 0) {
      const bodyObj = {};
      for (const field of bodyFields) {
        if (Object.prototype.hasOwnProperty.call(params, field)) {
          bodyObj[field] = params[field];
        }
      }
      body = JSON.stringify(bodyObj);
      headers['Content-Type'] = 'application/json';
    }

    // Step 8: Execute fetch with AbortController timeout
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);

    let response;
    try {
      response = await fetch(finalUrl, {
        method: method.toUpperCase(),
        headers,
        body,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeoutHandle);
      if (err.name === 'AbortError') {
        return { success: false, status: 0, data: null, error: `Request timed out after ${this.timeoutMs}ms` };
      }
      return { success: false, status: 0, data: null, error: `Fetch failed: ${err.message}` };
    } finally {
      clearTimeout(timeoutHandle);
    }

    // Step 9: Check Content-Length before reading body
    const contentLength = response.headers.get('content-length');
    if (contentLength !== null) {
      const declaredBytes = parseInt(contentLength, 10);
      if (Number.isFinite(declaredBytes) && declaredBytes > this.maxResponseBytes) {
        return {
          success: false,
          status: response.status,
          data: null,
          error: `Response too large: Content-Length ${declaredBytes} exceeds limit of ${this.maxResponseBytes} bytes`,
        };
      }
    }

    // Step 10: Read and parse response body
    let rawText;
    try {
      rawText = await response.text();
    } catch (err) {
      return { success: false, status: response.status, data: null, error: `Failed to read response body: ${err.message}` };
    }

    // Enforce byte limit on actual body (Content-Length may be absent or wrong)
    if (rawText.length > this.maxResponseBytes) {
      rawText = rawText.slice(0, this.maxResponseBytes);
    }

    // Try JSON parse, fall back to plain text
    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      data = rawText;
    }

    // Step 11: Session auth 401 retry — clear cached token, re-authenticate once
    if (response.status === 401 && auth && auth.type === 'session') {
      this.clearSessionCache(auth.credential_name);
      let retrySessionResult;
      try {
        retrySessionResult = await this._ensureSession(auth);
      } catch (reAuthErr) {
        return {
          success: false,
          status: 401,
          data,
          error: `Session 401 retry failed — re-auth error: ${reAuthErr.message}`,
        };
      }

      const retryHeaders = { ...headers, Authorization: `Bearer ${retrySessionResult.token}` };

      // Rebuild body with fresh session extras if a template is in use
      let retryBody = body;
      if (bodyType === 'json' && bodyTemplate && typeof bodyTemplate === 'object') {
        const retryContext = {
          params: params || {},
          session: retrySessionResult.extras || {},
          credential: {},
        };
        retryBody = JSON.stringify(this._resolveTemplate(bodyTemplate, retryContext));
      }

      const retryController = new AbortController();
      const retryTimeout = setTimeout(() => retryController.abort(), this.timeoutMs);
      try {
        const retryResponse = await fetch(finalUrl, {
          method: method.toUpperCase(),
          headers: retryHeaders,
          body: retryBody,
          signal: retryController.signal,
        });
        clearTimeout(retryTimeout);

        let retryText;
        try { retryText = await retryResponse.text(); } catch { retryText = ''; }
        if (retryText.length > this.maxResponseBytes) retryText = retryText.slice(0, this.maxResponseBytes);
        let retryData;
        try { retryData = JSON.parse(retryText); } catch { retryData = retryText; }

        if (retryResponse.status === 401) {
          return {
            success: false,
            status: 401,
            data: retryData,
            error: `Session token rejected after re-authentication for "${auth.credential_name}". Manual reauthorization required.`,
          };
        }
        const retrySuccess = retryResponse.status >= 200 && retryResponse.status < 300;
        return retrySuccess
          ? { success: true, status: retryResponse.status, data: retryData }
          : { success: false, status: retryResponse.status, data: retryData, error: `HTTP ${retryResponse.status}` };
      } catch (retryErr) {
        clearTimeout(retryTimeout);
        return { success: false, status: 0, data: null, error: `Session retry fetch failed: ${retryErr.message}` };
      }
    }

    // Step 12: OAuth2 401 retry — stale token, force refresh and retry once
    if (response.status === 401 && auth && auth.type === 'oauth2' && this.oauthBroker) {
      try {
        this.credentialBroker.clearCache && this.credentialBroker.clearCache(auth.credentialName);
        const freshToken = await this.oauthBroker.getAccessToken(auth.credentialName, { forceRefresh: true });
        const retryHeaders = { ...headers, Authorization: `Bearer ${freshToken}` };
        const retryController = new AbortController();
        const retryTimeout = setTimeout(() => retryController.abort(), this.timeoutMs);
        try {
          const retryResponse = await fetch(finalUrl, {
            method: method.toUpperCase(),
            headers: retryHeaders,
            body,
            signal: retryController.signal,
          });
          clearTimeout(retryTimeout);

          let retryText;
          try { retryText = await retryResponse.text(); } catch { retryText = ''; }
          if (retryText.length > this.maxResponseBytes) retryText = retryText.slice(0, this.maxResponseBytes);
          let retryData;
          try { retryData = JSON.parse(retryText); } catch { retryData = retryText; }

          if (retryResponse.status === 401) {
            return {
              success: false,
              status: 401,
              data: retryData,
              error: `OAuth token rejected after refresh for "${auth.credentialName}". Reauthorization likely required.`,
            };
          }
          const retrySuccess = retryResponse.status >= 200 && retryResponse.status < 300;
          return retrySuccess
            ? { success: true, status: retryResponse.status, data: retryData }
            : { success: false, status: retryResponse.status, data: retryData, error: `HTTP ${retryResponse.status}` };
        } catch (retryErr) {
          clearTimeout(retryTimeout);
          return { success: false, status: 0, data: null, error: `OAuth retry fetch failed: ${retryErr.message}` };
        }
      } catch (refreshErr) {
        return {
          success: false,
          status: 401,
          data,
          error: `OAuth 401 retry failed — refresh error: ${refreshErr.message}`,
        };
      }
    }

    const success = response.status >= 200 && response.status < 300;
    return success
      ? { success: true, status: response.status, data }
      : { success: false, status: response.status, data, error: `HTTP ${response.status}` };
  }

  /**
   * Clear one or all entries from the in-process session token cache.
   *
   * Call this to force re-authentication on the next execute() for a given
   * credential, or pass no argument to wipe the entire cache.
   *
   * @param {string} [credentialName] - Cache key to clear. Omit to clear all.
   */
  clearSessionCache(credentialName) {
    if (credentialName != null) {
      this._sessionCache.delete(credentialName);
    } else {
      this._sessionCache.clear();
    }
  }

  // ---------------------------------------------------------------------------
  // Private Methods
  // ---------------------------------------------------------------------------

  /**
   * Replace {{param}} placeholders in a URL template with encoded param values.
   *
   * Placeholders that have no corresponding param are left as-is so callers
   * can detect the missing value from the resulting URL if needed.
   *
   * @private
   * @param {string} urlTemplate - URL with optional {{param}} tokens
   * @param {Object} params      - Key-value pairs to substitute
   * @returns {string} Resolved URL
   */
  _resolveUrl(urlTemplate, params) {
    return urlTemplate.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      if (Object.prototype.hasOwnProperty.call(params, key) && params[key] != null) {
        return encodeURIComponent(String(params[key]));
      }
      // Leave the placeholder in place so missing params are visible
      return match;
    });
  }

  /**
   * Recursively resolve {{namespace.key}} placeholders in a template value.
   *
   * Supported namespaces:
   *   - params.key      → context.params[key]
   *   - session.key     → context.session[key]
   *   - credential.key  → context.credential[key]
   *   - now_iso         → current ISO 8601 timestamp (bare name, no namespace)
   *
   * Unknown placeholders are left as-is. Never mutates the input.
   *
   * @private
   * @param {*} template  - String, plain object, or array to resolve
   * @param {Object} context
   * @param {Object} context.params     - Caller-supplied params
   * @param {Object} context.session    - Session extras from _ensureSession
   * @param {Object} context.credential - Credential fields (empty by default)
   * @returns {*} Resolved copy of template (same shape as input)
   */
  _resolveTemplate(template, context) {
    if (template === null || template === undefined) {
      return template;
    }

    if (Array.isArray(template)) {
      return template.map(item => this._resolveTemplate(item, context));
    }

    if (typeof template === 'object') {
      const resolved = {};
      for (const [k, v] of Object.entries(template)) {
        resolved[k] = this._resolveTemplate(v, context);
      }
      return resolved;
    }

    if (typeof template !== 'string') {
      return template;
    }

    // String: replace all {{...}} placeholders
    return template.replace(TEMPLATE_PLACEHOLDER_RE, (match, path) => {
      const trimmed = path.trim();

      // Bare names with no dot separator
      if (!trimmed.includes('.')) {
        if (trimmed === 'now_iso') {
          return new Date().toISOString();
        }
        // Check params namespace for bare names as a convenience
        const { params = {} } = context;
        if (Object.prototype.hasOwnProperty.call(params, trimmed) && params[trimmed] != null) {
          return String(params[trimmed]);
        }
        return match; // unknown bare placeholder — leave as-is
      }

      // namespace.key form
      const dotIdx = trimmed.indexOf('.');
      const namespace = trimmed.slice(0, dotIdx);
      const key = trimmed.slice(dotIdx + 1);

      let source;
      switch (namespace) {
        case 'params':
          source = context.params || {};
          break;
        case 'session':
          source = context.session || {};
          break;
        case 'credential':
          source = context.credential || {};
          break;
        default:
          return match; // unknown namespace — leave as-is
      }

      const value = this._getNestedValue(source, key);
      return value != null ? String(value) : match;
    });
  }

  /**
   * Extract a value from a nested object using dot-notation path.
   *
   * Examples:
   *   _getNestedValue(obj, 'accessJwt')         → obj.accessJwt
   *   _getNestedValue(obj, 'data.user.handle')  → obj.data.user.handle
   *
   * Returns undefined if any segment along the path is missing.
   *
   * @private
   * @param {Object} obj  - Source object
   * @param {string} path - Dot-separated property path
   * @returns {*} Value at path, or undefined if not found
   */
  _getNestedValue(obj, path) {
    if (obj == null || !path) return undefined;
    const segments = path.split('.');
    let current = obj;
    for (const segment of segments) {
      if (current == null || typeof current !== 'object') return undefined;
      if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
      current = current[segment];
    }
    return current;
  }

  /**
   * Ensure a valid session token exists for the given session auth config.
   *
   * Checks the in-process cache first. On a miss (or expiry), fetches the
   * underlying credential, POSTs to session_endpoint with a resolved body,
   * extracts the token using token_path, and caches the result with TTL.
   *
   * @private
   * @param {Object} auth - Auth config with type === 'session'
   * @param {string} auth.credential_name     - CredentialBroker key for username/password
   * @param {string} auth.session_endpoint    - URL to POST for a session token
   * @param {string} [auth.session_method]    - HTTP method (default: 'POST')
   * @param {Object} [auth.session_body]      - Body template with {{credential.field}} placeholders
   * @param {string} auth.token_path          - Dot-notation path into response JSON for the token
   * @param {Object} [auth.extra_from_session] - Map of { localName: 'dot.path' } to extract extras
   * @param {number} [auth.token_ttl]         - Seconds until token expires (default 3600)
   * @returns {Promise<{ token: string, extras: Object }>}
   * @throws {Error} If session endpoint is unreachable, returns invalid JSON, or token not found
   */
  async _ensureSession(auth) {
    if (!auth || !auth.credential_name) {
      throw new Error('session auth requires credential_name');
    }
    if (!auth.session_endpoint || typeof auth.session_endpoint !== 'string') {
      throw new Error('session auth requires session_endpoint');
    }
    if (!auth.token_path || typeof auth.token_path !== 'string') {
      throw new Error('session auth requires token_path');
    }

    const cacheKey = auth.credential_name;
    const now = Date.now();

    // Cache hit: return if token has not expired
    const cached = this._sessionCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return { token: cached.token, extras: cached.extras };
    }

    // SSRF check on session_endpoint
    let parsedEndpoint;
    try {
      parsedEndpoint = new URL(auth.session_endpoint);
    } catch {
      throw new Error(`session_endpoint is not a valid URL: ${auth.session_endpoint}`);
    }
    let endpointHostname = parsedEndpoint.hostname.toLowerCase();
    if (endpointHostname.startsWith('[') && endpointHostname.endsWith(']')) {
      endpointHostname = endpointHostname.slice(1, -1);
    }
    if (this._isPrivateOrMetadata(endpointHostname)) {
      throw new Error(`SSRF protection: session_endpoint "${auth.session_endpoint}" targets a private/metadata host`);
    }

    // Fetch underlying credential from broker
    let rawCredential;
    try {
      rawCredential = await this.credentialBroker.get(auth.credential_name);
    } catch (err) {
      throw new Error(`Failed to retrieve credential "${auth.credential_name}": ${err.message}`);
    }
    if (rawCredential == null) {
      throw new Error(`Credential "${auth.credential_name}" not found`);
    }

    // Build credential fields map for template substitution.
    // CredentialBroker.get() may return a string or an object:
    //   - Object: { username, password, url, notes, ...customFields }
    //   - String: raw credential value; split on ':' for username:password convention
    const credentialFields = {};
    if (rawCredential && typeof rawCredential === 'object') {
      Object.assign(credentialFields, rawCredential);
    } else if (typeof rawCredential === 'string') {
      credentialFields.value = rawCredential;
      const colonIdx = rawCredential.indexOf(':');
      if (colonIdx > 0) {
        credentialFields.username = rawCredential.slice(0, colonIdx);
        credentialFields.password = rawCredential.slice(colonIdx + 1);
      }
      // Try JSON parse for structured credential strings
      try {
        const parsed = JSON.parse(rawCredential);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          Object.assign(credentialFields, parsed);
        }
      } catch {
        // Not JSON — username:password split above is sufficient
      }
    }

    // Resolve session request body template
    const sessionBodyTemplate = auth.session_body || {};
    const templateContext = {
      params: {},
      session: {},
      credential: credentialFields,
    };
    const resolvedBody = this._resolveTemplate(sessionBodyTemplate, templateContext);

    // Execute session endpoint request
    const sessionMethod = (auth.session_method || 'POST').toUpperCase();
    const sessionHeaders = {
      'Content-Type': 'application/json',
      'User-Agent': 'Moltagent/1.0',
    };

    const sessionController = new AbortController();
    const sessionTimeout = setTimeout(() => sessionController.abort(), this.timeoutMs);

    let sessionResponse;
    try {
      sessionResponse = await fetch(auth.session_endpoint, {
        method: sessionMethod,
        headers: sessionHeaders,
        body: sessionMethod !== 'GET' ? JSON.stringify(resolvedBody) : undefined,
        signal: sessionController.signal,
      });
    } catch (err) {
      clearTimeout(sessionTimeout);
      if (err.name === 'AbortError') {
        throw new Error(`session_endpoint timed out after ${this.timeoutMs}ms`);
      }
      throw new Error(`session_endpoint fetch failed: ${err.message}`);
    } finally {
      clearTimeout(sessionTimeout);
    }

    if (!sessionResponse.ok) {
      throw new Error(`session_endpoint returned HTTP ${sessionResponse.status}`);
    }

    // Parse session response JSON
    let sessionResponseText;
    try {
      sessionResponseText = await sessionResponse.text();
    } catch (err) {
      throw new Error(`Failed to read session_endpoint response: ${err.message}`);
    }

    let sessionData;
    try {
      sessionData = JSON.parse(sessionResponseText);
    } catch {
      throw new Error(`session_endpoint returned non-JSON response: ${sessionResponseText.slice(0, 200)}`);
    }

    // Extract token at token_path
    const token = this._getNestedValue(sessionData, auth.token_path);
    if (token == null) {
      throw new Error(`token_path "${auth.token_path}" not found in session response`);
    }

    // Extract optional extras
    const extras = {};
    if (auth.extra_from_session && typeof auth.extra_from_session === 'object') {
      for (const [localName, dotPath] of Object.entries(auth.extra_from_session)) {
        const val = this._getNestedValue(sessionData, dotPath);
        if (val != null) {
          extras[localName] = val;
        }
      }
    }

    // Cache with TTL
    const ttlMs = (Number.isFinite(auth.token_ttl) && auth.token_ttl > 0
      ? auth.token_ttl
      : DEFAULT_SESSION_TTL_SECONDS) * 1000;

    this._sessionCache.set(cacheKey, {
      token: String(token),
      extras,
      expiresAt: now + ttlMs,
    });

    return { token: String(token), extras };
  }

  /**
   * Determine whether a hostname targets a private network or cloud metadata endpoint.
   *
   * Blocks: localhost aliases, loopback, link-local (169.254.x), private RFC-1918
   * ranges, and well-known cloud metadata hostnames.
   *
   * @private
   * @param {string} hostname - Lowercase hostname to test
   * @returns {boolean} true if the host should be blocked
   */
  _isPrivateOrMetadata(hostname) {
    if (!hostname) return true;

    // Exact-match blocklist (literals and metadata FQDNs)
    if (BLOCKED_HOSTNAMES.has(hostname)) return true;

    // Private IP prefix ranges
    for (const pattern of PRIVATE_PREFIXES) {
      if (pattern.test(hostname)) return true;
    }

    return false;
  }

  /**
   * Build the HTTP headers object required by the specified auth type.
   *
   * For query_param and session auth, the URL/token is handled in execute();
   * this method returns an empty object in those cases.
   *
   * @private
   * @param {Object} auth          - Auth config from operationConfig
   * @param {string|null} credential - Raw credential string from CredentialBroker
   * @returns {Object} Header key-value pairs to merge into the request headers
   */
  _buildAuthHeaders(auth, credential) {
    if (!auth || auth.type === 'none' || auth.type === 'query_param' || auth.type === 'session') {
      return {};
    }

    if (!credential) {
      throw new Error(`Auth type "${auth.type}" requires a credential but none was provided`);
    }

    switch (auth.type) {
      case 'oauth2':
      case 'bearer':
        return { Authorization: `Bearer ${credential}` };

      case 'header_key': {
        const headerName = auth.headerName || 'X-API-Key';
        return { [headerName]: credential };
      }

      case 'basic': {
        // credential is expected to be "username:password"
        const encoded = Buffer.from(credential, 'utf8').toString('base64');
        return { Authorization: `Basic ${encoded}` };
      }

      default:
        throw new Error(`Unknown auth type: "${auth.type}"`);
    }
  }

  /**
   * Append named params from the params object to the URL as a query string.
   *
   * Skips params that are null or undefined. Handles existing query strings
   * by using '&' when a '?' is already present.
   *
   * @private
   * @param {string}   url             - Current URL (may already have a query string)
   * @param {Object}   params          - All params provided by the caller
   * @param {string[]} queryParamNames - Names of params that belong in the query string
   * @returns {string} URL with query string appended
   */
  _appendQueryParams(url, params, queryParamNames) {
    if (!queryParamNames || queryParamNames.length === 0) return url;

    const pairs = [];
    for (const name of queryParamNames) {
      if (Object.prototype.hasOwnProperty.call(params, name) && params[name] != null) {
        pairs.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(params[name]))}`);
      }
    }

    if (pairs.length === 0) return url;

    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}${pairs.join('&')}`;
  }
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = { HttpToolExecutor };
