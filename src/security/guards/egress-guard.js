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
 * EgressGuard - Outbound Network Control Guard
 *
 * Architecture Brief:
 * -------------------
 * Problem: Agent network access must be controlled to prevent data exfiltration
 * to malicious endpoints and SSRF attacks against internal services.
 *
 * Pattern: Allowlist mode by default - only explicitly allowed domains are
 * reachable. Known exfiltration services are always blocked regardless of
 * allowlist. Internal/metadata endpoints are blocked to prevent SSRF.
 *
 * Key Dependencies:
 *   - url (Node.js built-in) for URL parsing
 *
 * Data Flow:
 *   1. Parse URL (fail closed if invalid)
 *   2. Check metadata endpoints (always block)
 *   3. Check private IP patterns (block SSRF)
 *   4. Check always-blocked domains (with subdomain matching)
 *   5. Check allowlist (in allowlist mode)
 *   6. Return decision
 *
 * Security Principles:
 *   - Fail closed on invalid URLs
 *   - No DNS resolution (prevents DNS rebinding)
 *   - Subdomain matching for blocklists
 *   - Protocol restrictions (HTTPS preferred)
 *
 * @module security/guards/egress-guard
 * @version 1.0.0
 */

'use strict';

const { URL } = require('url');

// -----------------------------------------------------------------------------
// Domain Lists
// -----------------------------------------------------------------------------

/**
 * Default allowed domains when no custom allowlist is provided.
 * These are common LLM API endpoints.
 *
 * @type {string[]}
 */
const DEFAULT_ALLOWED_DOMAINS = [
  'api.anthropic.com',
  'api.openai.com',
  'api.mistral.ai',
];

/**
 * Always blocked domains - even if added to allowlist.
 * These are known data exfiltration services.
 *
 * @type {string[]}
 */
const ALWAYS_BLOCKED_DOMAINS = [
  // Request catchers / webhook receivers
  'webhook.site',
  'requestbin.com',
  'pipedream.net',
  'hookbin.com',
  'beeceptor.com',
  'requestcatcher.com',
  'postb.in',

  // Paste services
  'pastebin.com',
  'paste.ee',
  'dpaste.com',
  'hastebin.com',
  'ghostbin.co',
  'rentry.co',

  // File upload/share services (ephemeral)
  'transfer.sh',
  'file.io',
  '0x0.st',
  'temp.sh',
  'tmpfiles.org',
  'catbox.moe',
  'litterbox.catbox.moe',

  // URL shorteners (used to hide exfil destinations)
  'bit.ly',
  'tinyurl.com',
  't.co',
  'is.gd',
  'v.gd',
];

/**
 * Private/internal IP range patterns.
 * Block to prevent SSRF attacks.
 *
 * @type {RegExp[]}
 */
const PRIVATE_IP_PATTERNS = [
  /^127\./,                          // Loopback
  /^10\./,                           // Class A private
  /^172\.(1[6-9]|2\d|3[01])\./,     // Class B private
  /^192\.168\./,                     // Class C private
  /^169\.254\./,                     // Link-local (includes AWS metadata)
  /^0\./,                            // Current network
  /^fc00:/i,                         // IPv6 ULA
  /^fe80:/i,                         // IPv6 link-local
  /^::1$/,                           // IPv6 loopback
];

/**
 * Cloud metadata endpoints - critical SSRF targets.
 *
 * @type {string[]}
 */
const METADATA_DOMAINS = [
  'metadata.google.internal',
  'metadata.hetzner.cloud',
  '169.254.169.254',                 // AWS/GCP/Azure metadata
];

/**
 * Allowed protocols.
 * HTTP is only allowed for localhost/local IPs (for Ollama).
 *
 * @type {string[]}
 */
const ALLOWED_PROTOCOLS = ['https:', 'http:'];

/**
 * Protocols that are always blocked (dangerous).
 *
 * @type {string[]}
 */
const BLOCKED_PROTOCOLS = ['file:', 'ftp:', 'data:', 'javascript:', 'vbscript:'];

// -----------------------------------------------------------------------------
// EgressGuard Class
// -----------------------------------------------------------------------------

/**
 * Outbound network control guard.
 *
 * Controls which network destinations the agent can reach:
 * - Operates in allowlist mode by default
 * - Always blocks known exfiltration services
 * - Blocks SSRF attempts against internal/metadata endpoints
 * - Blocks dangerous protocols (file://, ftp://, etc.)
 */
class EgressGuard {
  /**
   * Create a new EgressGuard instance.
   *
   * @param {Object} [options={}] - Configuration options
   * @param {string[]} [options.allowedDomains] - Domains the agent may reach
   * @param {string[]} [options.additionalBlocked] - Extra blocked domains
   * @param {'allowlist'|'blocklist'} [options.mode='allowlist'] - Operating mode
   * @param {string} [options.nextcloudDomain] - NC domain (auto-added to allowlist)
   * @param {string} [options.ollamaHost] - Ollama IP/domain (auto-added to allowlist)
   */
  constructor(options = {}) {
    this.mode = options.mode || 'allowlist';

    // Build allowed domains list
    this.allowedDomains = new Set(
      (options.allowedDomains || DEFAULT_ALLOWED_DOMAINS)
        .map(d => d.toLowerCase())
    );

    // Add Nextcloud domain if provided
    if (options.nextcloudDomain) {
      this.allowedDomains.add(options.nextcloudDomain.toLowerCase());
    }

    // Add Ollama host if provided
    if (options.ollamaHost) {
      this.allowedDomains.add(options.ollamaHost.toLowerCase());
      this.ollamaHost = options.ollamaHost.toLowerCase();
    } else {
      this.ollamaHost = null;
    }

    // Build blocked domains list
    this.blockedDomains = new Set(
      [...ALWAYS_BLOCKED_DOMAINS, ...(options.additionalBlocked || [])]
        .map(d => d.toLowerCase())
    );

    // Track dynamically added domains by source for clean removal
    this._dynamicDomains = new Map(); // source key → Set of domains
  }

  /**
   * Evaluate whether a URL is safe to reach.
   *
   * Evaluation order:
   *   1. Parse URL (if invalid, BLOCK)
   *   2. Check protocol (block dangerous protocols)
   *   3. Check metadata endpoints (always block)
   *   4. Check private IP patterns (block SSRF)
   *   5. Check always-blocked domains (with subdomain matching)
   *   6. In allowlist mode: check if hostname is allowed
   *   7. Default: ALLOW (in blocklist mode) or BLOCK (in allowlist mode)
   *
   * @param {string} url - Full URL the agent wants to access
   * @param {Object} [context={}] - Operation context
   * @returns {{
   *   allowed: boolean,
   *   reason: string|null,
   *   level: 'BLOCKED'|'ALLOWED',
   *   category: 'exfiltration'|'ssrf'|'metadata'|'not_in_allowlist'|'invalid_url'|'blocked_protocol'|'allowed'|null
   * }}
   */
  evaluate(url, context = {}) {
    // web_read with SSRF protection bypasses domain allowlist
    // (it needs to fetch arbitrary URLs, SSRF checks done in WebReader)
    // Defense-in-depth: still enforce protocol, private IP, metadata, and exfil checks
    if (context.tool === 'web_read' && context.ssrfChecked) {
      try {
        const parsedUrl = new URL(url);
        const protocol = parsedUrl.protocol;
        let hostname = parsedUrl.hostname.toLowerCase();
        if (hostname.startsWith('[') && hostname.endsWith(']')) {
          hostname = hostname.slice(1, -1);
        }

        // Block dangerous protocols (file://, ftp://, javascript://, etc.)
        if (BLOCKED_PROTOCOLS.includes(protocol)) {
          return {
            allowed: false,
            reason: `Blocked protocol: ${protocol}`,
            level: 'BLOCKED',
            category: 'blocked_protocol',
          };
        }

        // Block non-HTTP(S) protocols
        if (!ALLOWED_PROTOCOLS.includes(protocol)) {
          return {
            allowed: false,
            reason: `Protocol not allowed: ${protocol}`,
            level: 'BLOCKED',
            category: 'blocked_protocol',
          };
        }

        // Block metadata endpoints
        if (this._isMetadataEndpoint(hostname)) {
          return {
            allowed: false,
            reason: `Blocked metadata endpoint: ${hostname}`,
            level: 'BLOCKED',
            category: 'metadata',
          };
        }

        // Block private IPs (defense in depth against SSRF)
        if (this._isPrivateIP(hostname)) {
          return {
            allowed: false,
            reason: `Blocked private IP: ${hostname}`,
            level: 'BLOCKED',
            category: 'ssrf',
          };
        }

        // Block exfiltration domains
        const blockedMatch = this._matchesBlockedDomain(hostname);
        if (blockedMatch.matched) {
          return {
            allowed: false,
            reason: `Blocked exfiltration domain: ${blockedMatch.domain}`,
            level: 'BLOCKED',
            category: 'exfiltration',
          };
        }

        return {
          allowed: true,
          reason: 'web_read with SSRF protection',
          level: 'ALLOWED',
          category: 'allowed',
        };
      } catch (e) {
        return {
          allowed: false,
          reason: `Invalid URL: ${e.message}`,
          level: 'BLOCKED',
          category: 'invalid_url',
        };
      }
    }

    // Validate URL is a non-empty string
    if (typeof url !== 'string' || url.length === 0) {
      return {
        allowed: false,
        reason: 'Invalid URL: URL must be a non-empty string',
        level: 'BLOCKED',
        category: 'invalid_url',
      };
    }

    // Parse URL (fail closed on error)
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch (e) {
      return {
        allowed: false,
        reason: `Invalid URL: ${e.message}`,
        level: 'BLOCKED',
        category: 'invalid_url',
      };
    }

    let hostname = parsedUrl.hostname.toLowerCase();
    const protocol = parsedUrl.protocol;

    // Strip square brackets from IPv6 addresses (e.g., [::1] -> ::1)
    if (hostname.startsWith('[') && hostname.endsWith(']')) {
      hostname = hostname.slice(1, -1);
    }

    // Check blocked protocols (file://, ftp://, data://, javascript://)
    if (BLOCKED_PROTOCOLS.includes(protocol)) {
      return {
        allowed: false,
        reason: `Blocked protocol: ${protocol}`,
        level: 'BLOCKED',
        category: 'blocked_protocol',
      };
    }

    // Check metadata endpoints (highest priority for security)
    if (this._isMetadataEndpoint(hostname)) {
      return {
        allowed: false,
        reason: `Blocked metadata endpoint: ${hostname}`,
        level: 'BLOCKED',
        category: 'metadata',
      };
    }

    // Check private IP patterns (SSRF prevention)
    // Exempt the configured Ollama host — it's expected to be on a private IP
    if (this._isPrivateIP(hostname) && !(this.ollamaHost && hostname.toLowerCase() === this.ollamaHost)) {
      return {
        allowed: false,
        reason: `Blocked private IP: ${hostname}`,
        level: 'BLOCKED',
        category: 'ssrf',
      };
    }

    // Check always-blocked domains (with subdomain matching)
    const blockedMatch = this._matchesBlockedDomain(hostname);
    if (blockedMatch.matched) {
      return {
        allowed: false,
        reason: `Blocked exfiltration domain: ${blockedMatch.domain}`,
        level: 'BLOCKED',
        category: 'exfiltration',
      };
    }

    // Check protocol restrictions (HTTP only allowed for localhost/Ollama)
    if (!ALLOWED_PROTOCOLS.includes(protocol)) {
      return {
        allowed: false,
        reason: `Protocol not allowed: ${protocol}`,
        level: 'BLOCKED',
        category: 'blocked_protocol',
      };
    }

    if (protocol === 'http:' && !this._isHttpAllowed(hostname)) {
      return {
        allowed: false,
        reason: 'HTTP is only allowed for localhost and configured Ollama host',
        level: 'BLOCKED',
        category: 'blocked_protocol',
      };
    }

    // In allowlist mode: check if hostname is allowed
    if (this.mode === 'allowlist') {
      if (!this._isAllowed(hostname)) {
        return {
          allowed: false,
          reason: `Domain not in allowlist: ${hostname}`,
          level: 'BLOCKED',
          category: 'not_in_allowlist',
        };
      }
    }

    // Allow
    return {
      allowed: true,
      reason: null,
      level: 'ALLOWED',
      category: 'allowed',
    };
  }

  /**
   * Check if a URL points to an internal/private address.
   *
   * @param {string} url - URL to check
   * @returns {boolean} true if internal/private
   */
  isInternal(url) {
    try {
      const parsedUrl = new URL(url);
      let hostname = parsedUrl.hostname;

      // Strip square brackets from IPv6 addresses
      if (hostname.startsWith('[') && hostname.endsWith(']')) {
        hostname = hostname.slice(1, -1);
      }

      return this._isPrivateIP(hostname);
    } catch (e) {
      return false;
    }
  }

  /**
   * Add a domain to the allowlist at runtime (e.g. for Skill Forge skills).
   * @param {string} domain - Domain to allow
   * @param {Object} [metadata] - Tracking metadata
   * @param {string} [metadata.source] - Source identifier (e.g. 'skill-forge')
   * @param {string} [metadata.skillId] - Skill identifier
   */
  addAllowedDomain(domain, metadata = {}) {
    const normalized = domain.toLowerCase();
    this.allowedDomains.add(normalized);
    if (metadata.source) {
      const key = metadata.skillId ? `${metadata.source}:${metadata.skillId}` : metadata.source;
      if (!this._dynamicDomains.has(key)) {
        this._dynamicDomains.set(key, new Set());
      }
      this._dynamicDomains.get(key).add(normalized);
    }
  }

  /**
   * Remove all dynamically added domains for a given source.
   * @param {string} source - Source identifier (e.g. 'skill-forge')
   * @param {string} [id] - Optional sub-identifier (e.g. skillId)
   */
  removeBySource(source, id) {
    const key = id ? `${source}:${id}` : source;
    const domains = this._dynamicDomains.get(key);
    if (domains) {
      for (const domain of domains) {
        // Reference-count check: only remove from allowedDomains if no other
        // dynamic source still needs this domain
        let stillNeeded = false;
        for (const [otherKey, otherDomains] of this._dynamicDomains) {
          if (otherKey !== key && otherDomains.has(domain)) {
            stillNeeded = true;
            break;
          }
        }
        if (!stillNeeded) {
          this.allowedDomains.delete(domain);
        }
      }
      this._dynamicDomains.delete(key);
    }
  }

  /**
   * Get the current allowlist (for documentation/auditing).
   *
   * @returns {string[]} Array of allowed domains
   */
  getAllowedDomains() {
    return Array.from(this.allowedDomains);
  }

  /**
   * Get the current blocklist (for documentation/auditing).
   *
   * @returns {string[]} Array of blocked domains
   */
  getBlockedDomains() {
    return Array.from(this.blockedDomains);
  }

  // ---------------------------------------------------------------------------
  // Private Helper Methods
  // ---------------------------------------------------------------------------

  /**
   * Check if a hostname is a private/internal IP.
   *
   * @private
   * @param {string} hostname - Hostname or IP to check
   * @returns {boolean} true if private/internal
   */
  _isPrivateIP(hostname) {
    for (const pattern of PRIVATE_IP_PATTERNS) {
      if (pattern.test(hostname)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if a hostname matches a metadata endpoint.
   *
   * @private
   * @param {string} hostname - Hostname to check
   * @returns {boolean} true if metadata endpoint
   */
  _isMetadataEndpoint(hostname) {
    return METADATA_DOMAINS.includes(hostname.toLowerCase());
  }

  /**
   * Check if a hostname matches any blocked domain (with subdomain matching).
   *
   * Subdomain matching: evil.webhook.site matches webhook.site
   *
   * @private
   * @param {string} hostname - Hostname to check
   * @returns {{matched: boolean, domain: string|null}}
   */
  _matchesBlockedDomain(hostname) {
    const lowerHostname = hostname.toLowerCase();

    for (const blockedDomain of this.blockedDomains) {
      // Exact match
      if (lowerHostname === blockedDomain) {
        return { matched: true, domain: blockedDomain };
      }
      // Subdomain match (hostname ends with .blockedDomain)
      if (lowerHostname.endsWith('.' + blockedDomain)) {
        return { matched: true, domain: blockedDomain };
      }
    }

    return { matched: false, domain: null };
  }

  /**
   * Check if a hostname is in the allowlist.
   *
   * @private
   * @param {string} hostname - Hostname to check
   * @returns {boolean} true if allowed
   */
  _isAllowed(hostname) {
    return this.allowedDomains.has(hostname.toLowerCase());
  }

  /**
   * Check if HTTP is allowed for this hostname.
   * HTTP is only allowed for localhost and configured Ollama host.
   *
   * @private
   * @param {string} hostname - Hostname to check
   * @returns {boolean} true if HTTP allowed
   */
  _isHttpAllowed(hostname) {
    const lowerHostname = hostname.toLowerCase();

    // Localhost
    if (lowerHostname === 'localhost' || lowerHostname === '127.0.0.1' || lowerHostname === '::1') {
      return true;
    }

    // Configured Ollama host
    if (this.ollamaHost && lowerHostname === this.ollamaHost) {
      return true;
    }

    return false;
  }
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = EgressGuard;
