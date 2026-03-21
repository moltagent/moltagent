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
 * Key Dependencies:
 *   - fetch (Node.js 18+ native): HTTP execution
 *   - CredentialBroker (injected): .get(name) → credential string
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
 *     -> fetch() with AbortController timeout  — actual HTTP call
 *     -> size check + JSON-or-text parse       — response normalisation
 *     -> return { success, status, data, error? }
 *
 * Dependency Map:
 *   HttpToolExecutor
 *     <- CredentialBroker  (required)
 *     <- EgressGuard       (optional)
 *     <- Node fetch        (runtime)
 *
 * @module skill-forge/http-tool-executor
 * @version 1.0.0
 */

'use strict';

const { URL } = require('url');

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576; // 1 MB

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

// -----------------------------------------------------------------------------
// HttpToolExecutor Class
// -----------------------------------------------------------------------------

/**
 * Executes REST API calls described by a declarative operationConfig.
 *
 * One instance is shared across all forged skills. The class carries no
 * per-call state — all transient values live in execute() stack frames.
 */
class HttpToolExecutor {
  /**
   * Create a new HttpToolExecutor instance.
   *
   * @param {Object} options
   * @param {Object} options.credentialBroker - CredentialBroker with .get(name) method
   * @param {Object} [options.egressGuard]    - EgressGuard with .evaluate(url) method (optional)
   * @param {number} [options.timeoutMs=30000]            - Fetch timeout in milliseconds
   * @param {number} [options.maxResponseBytes=1048576]   - Maximum accepted response size in bytes
   */
  constructor({ credentialBroker, egressGuard = null, timeoutMs = DEFAULT_TIMEOUT_MS, maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES }) {
    if (!credentialBroker || typeof credentialBroker.get !== 'function') {
      throw new Error('HttpToolExecutor: credentialBroker must have a .get(name) method');
    }
    this.credentialBroker = credentialBroker;
    this.egressGuard = egressGuard;
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = Number.isFinite(maxResponseBytes) && maxResponseBytes > 0
      ? maxResponseBytes
      : DEFAULT_MAX_RESPONSE_BYTES;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Execute a REST API call described by operationConfig using the given params.
   *
   * @param {Object} operationConfig - Declarative description of the API call
   * @param {string} operationConfig.method         - HTTP method
   * @param {string} operationConfig.url            - URL template with optional {{param}} placeholders
   * @param {Object} [operationConfig.auth]         - Authentication configuration
   * @param {string[]} [operationConfig.queryParams]  - Param names to send as query string
   * @param {string|null} [operationConfig.bodyType]  - 'json' or null
   * @param {string[]} [operationConfig.bodyFields]   - Param names to include in JSON body
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
    let credential = null;
    if (auth && auth.type !== 'none' && auth.credentialName) {
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
    let headers = { 'User-Agent': 'MoltAgent/1.0' };
    try {
      const authHeaders = this._buildAuthHeaders(auth, credential);
      Object.assign(headers, authHeaders);
    } catch (err) {
      return { success: false, status: 0, data: null, error: `Auth header build failed: ${err.message}` };
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
    let body = undefined;
    if (bodyType === 'json' && bodyFields && bodyFields.length > 0) {
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

    const success = response.status >= 200 && response.status < 300;
    return success
      ? { success: true, status: response.status, data }
      : { success: false, status: response.status, data, error: `HTTP ${response.status}` };
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
   * For query_param auth the URL is mutated in execute(); this method
   * returns an empty object in that case.
   *
   * @private
   * @param {Object} auth          - Auth config from operationConfig
   * @param {string|null} credential - Raw credential string from CredentialBroker
   * @returns {Object} Header key-value pairs to merge into the request headers
   */
  _buildAuthHeaders(auth, credential) {
    if (!auth || auth.type === 'none' || auth.type === 'query_param') {
      return {};
    }

    if (!credential) {
      throw new Error(`Auth type "${auth.type}" requires a credential but none was provided`);
    }

    switch (auth.type) {
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
