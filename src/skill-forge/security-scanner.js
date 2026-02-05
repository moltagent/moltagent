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
 * Skill Forge Security Scanner
 *
 * Architecture Brief:
 * -------------------
 * Problem: Generated SKILL.md files must be scanned for security violations
 * before reaching the pending review folder or being activated. A compromised
 * template or malicious parameter injection could produce dangerous output.
 *
 * Pattern: Multi-layer scan pipeline. Each check is an independent private
 * method returning violations/warnings. The public scan() method aggregates
 * all results. No I/O, no side effects -- pure analysis of content strings.
 *
 * Key Dependencies:
 *   - ./constants (all security constant sets)
 *   - url (Node.js built-in) for URL parsing
 *
 * Data Flow:
 *   scan(content, templateConfig)
 *     -> _checkForbiddenPatterns(content, templateConfig)
 *     -> _checkDomains(content, templateConfig.allowed_domains)
 *     -> _checkCredentials(content)
 *     -> _checkBinaries(content, templateConfig)
 *     -> _checkPrivateIPs(content)
 *     -> _checkSize(content)
 *     -> aggregate violations[], warnings[]
 *     -> return { safe, violations, warnings }
 *
 * @module skill-forge/security-scanner
 * @version 1.0.0
 */

'use strict';

const { URL } = require('url');
const {
  GLOBAL_FORBIDDEN_PATTERNS,
  SAFE_BINS,
  BLOCKED_DOMAINS,
  PRIVATE_IP_PATTERNS,
  METADATA_ENDPOINTS,
  CREDENTIAL_PATTERNS,
  MAX_SKILL_SIZE,
} = require('./constants');

// -----------------------------------------------------------------------------
// SecurityScanner Class
// -----------------------------------------------------------------------------

/**
 * Scans generated SKILL.md content for security violations.
 *
 * Checks performed:
 * - Global forbidden patterns (code execution, downloads, exfiltration, etc.)
 * - Template-specific forbidden patterns
 * - Domain allowlist validation (all URLs must be in allowed_domains)
 * - Exfiltration domain blocking (always blocked regardless of allowlist)
 * - Hardcoded credential detection
 * - Binary reference validation (only safe bins allowed)
 * - Private IP / metadata endpoint detection (SSRF prevention)
 * - Content size warnings
 */
class SecurityScanner {
  /**
   * Create a new SecurityScanner instance.
   *
   * @param {Object} [options={}] - Configuration options
   * @param {string[]} [options.additionalForbiddenPatterns=[]] - Extra patterns to block
   * @param {string[]} [options.additionalSafeBins=[]] - Extra allowed binaries
   */
  constructor(options = {}) {
    this.additionalForbiddenPatterns = options.additionalForbiddenPatterns || [];
    this.additionalSafeBins = options.additionalSafeBins || [];
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Perform a full security scan on generated skill content.
   *
   * @param {string} skillContent - The full SKILL.md text to scan
   * @param {Object} templateConfig - The template's security configuration
   * @param {string[]} templateConfig.allowed_domains - Domains the skill may reference
   * @param {string[]} [templateConfig.forbidden_patterns=[]] - Template-specific forbidden patterns
   * @returns {{ safe: boolean, violations: string[], warnings: string[] }}
   */
  scan(skillContent, templateConfig) {
    if (typeof skillContent !== 'string') {
      return { safe: false, violations: ['Content must be a string'], warnings: [] };
    }
    if (!skillContent.length) {
      return { safe: false, violations: ['Content is empty'], warnings: [] };
    }

    const violations = [];
    const warnings = [];

    // Extract URLs once for reuse across checks
    const urls = this._extractURLs(skillContent);

    // 1. Forbidden patterns (global + template-specific)
    violations.push(...this._checkForbiddenPatterns(skillContent, templateConfig));

    // 2. Domain validation
    const domainResult = this._checkDomains(urls, templateConfig.allowed_domains || []);
    violations.push(...domainResult.violations);
    warnings.push(...domainResult.warnings);

    // 3. Credential patterns
    violations.push(...this._checkCredentials(skillContent));

    // 4. Binary validation
    violations.push(...this._checkBinaries(skillContent));

    // 5. Private IP / SSRF
    violations.push(...this._checkPrivateIPs(urls));

    // 6. Size warnings
    warnings.push(...this._checkSize(skillContent));

    return {
      safe: violations.length === 0,
      violations,
      warnings,
    };
  }

  /**
   * Quick boolean check -- is this content safe?
   *
   * @param {string} skillContent - The SKILL.md text to check
   * @param {Object} templateConfig - Template security configuration
   * @returns {boolean} true if content passes all checks (no violations)
   */
  quickCheck(skillContent, templateConfig) {
    return this.scan(skillContent, templateConfig).safe;
  }

  // ---------------------------------------------------------------------------
  // Private Check Methods
  // ---------------------------------------------------------------------------

  /**
   * Check content against global and template-specific forbidden patterns.
   *
   * Uses case-sensitive literal string matching for global patterns.
   * Template-specific patterns are also checked as literal strings.
   *
   * @private
   * @param {string} content - Skill content to check
   * @param {Object} templateConfig - Template configuration
   * @returns {string[]} Array of violation description strings
   */
  _checkForbiddenPatterns(content, templateConfig) {
    const violations = [];
    const contentLower = content.toLowerCase();
    const allPatterns = [
      ...GLOBAL_FORBIDDEN_PATTERNS,
      ...this.additionalForbiddenPatterns,
      ...(templateConfig.forbidden_patterns || []),
    ];
    for (const pattern of allPatterns) {
      if (contentLower.includes(pattern.toLowerCase())) {
        violations.push(`Forbidden pattern found: "${pattern}"`);
      }
    }
    return violations;
  }

  /**
   * Validate extracted URLs against allowed domains.
   *
   * Rules:
   * - Every URL hostname must be in the template's allowed_domains list
   * - URLs pointing to BLOCKED_DOMAINS always produce a violation
   * - Subdomains of blocked domains are also blocked
   *
   * @private
   * @param {string[]} urls - Pre-extracted URLs from content
   * @param {string[]} allowedDomains - Domains the template permits
   * @returns {{ violations: string[], warnings: string[] }}
   */
  _checkDomains(urls, allowedDomains) {
    const violations = [];
    const warnings = [];
    const allowedSet = new Set((allowedDomains || []).map(d => d.toLowerCase()));

    for (const urlStr of urls) {
      let hostname;
      try {
        hostname = new URL(urlStr).hostname.toLowerCase();
      } catch {
        warnings.push(`Could not parse URL: ${urlStr.slice(0, 80)}`);
        continue;
      }

      // Check against always-blocked domains (with subdomain matching)
      if (this._isBlockedDomain(hostname)) {
        violations.push(`Blocked exfiltration domain: ${hostname}`);
        continue;
      }

      // Check against allowed domains
      if (!allowedSet.has(hostname)) {
        violations.push(`Unauthorized domain: ${hostname} (allowed: ${allowedDomains.join(', ')})`);
      }
    }

    return { violations, warnings };
  }

  /**
   * Check for hardcoded credential patterns in content.
   *
   * @private
   * @param {string} content - Skill content to check
   * @returns {string[]} Array of violation description strings
   */
  _checkCredentials(content) {
    const violations = [];
    for (const { name, pattern } of CREDENTIAL_PATTERNS) {
      // Create new RegExp to reset lastIndex
      const regex = new RegExp(pattern.source, pattern.flags);
      if (regex.test(content)) {
        violations.push(`Possible hardcoded credential detected (${name})`);
      }
    }
    return violations;
  }

  /**
   * Check that only safe binaries are referenced in code blocks.
   *
   * Extracts binary names from lines that start with a binary invocation
   * within fenced code blocks (```...```).
   *
   * @private
   * @param {string} content - Skill content to check
   * @returns {string[]} Array of violation description strings
   */
  _checkBinaries(content) {
    const violations = [];
    const allSafeBins = new Set([
      ...SAFE_BINS,
      ...this.additionalSafeBins,
    ]);

    // Extract code blocks
    const codeBlockRegex = /```(?:\w*)\n([\s\S]*?)```/g;
    let match;
    while ((match = codeBlockRegex.exec(content)) !== null) {
      const block = match[1];
      // Check each line for binary invocations
      for (const line of block.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        // Extract first word (potential binary name)
        const firstWord = trimmed.split(/[\s|;&]/)[0];
        if (firstWord && !allSafeBins.has(firstWord) && !firstWord.startsWith('$') && !firstWord.startsWith('"') && !firstWord.startsWith('-')) {
          violations.push(`Unsafe binary referenced: "${firstWord}"`);
        }
      }
    }
    return violations;
  }

  /**
   * Check for private IP addresses and metadata endpoints in URLs.
   *
   * @private
   * @param {string[]} urls - Pre-extracted URLs from content
   * @returns {string[]} Array of violation description strings
   */
  _checkPrivateIPs(urls) {
    const violations = [];

    for (const urlStr of urls) {
      let hostname;
      try {
        hostname = new URL(urlStr).hostname.toLowerCase();
      } catch {
        continue;
      }

      // Check metadata endpoints
      if (METADATA_ENDPOINTS.includes(hostname)) {
        violations.push(`Blocked metadata endpoint: ${hostname}`);
        continue;
      }

      // Check private IP patterns
      for (const pattern of PRIVATE_IP_PATTERNS) {
        if (pattern.test(hostname)) {
          violations.push(`Blocked private/internal IP: ${hostname}`);
          break;
        }
      }
    }
    return violations;
  }

  /**
   * Check content size against limits.
   *
   * @private
   * @param {string} content - Skill content to check
   * @returns {string[]} Array of warning description strings
   */
  _checkSize(content) {
    const warnings = [];
    if (content.length > MAX_SKILL_SIZE) {
      warnings.push(`Skill is unusually large (${content.length} chars, max ${MAX_SKILL_SIZE})`);
    }
    return warnings;
  }

  // ---------------------------------------------------------------------------
  // Utility Methods
  // ---------------------------------------------------------------------------

  /**
   * Extract all HTTP(S) URLs from content.
   *
   * @private
   * @param {string} content - Content to extract URLs from
   * @returns {string[]} Array of URL strings found in content
   */
  _extractURLs(content) {
    const urlRegex = /https?:\/\/[^\s"'`<>)\]]+/g;
    const matches = content.match(urlRegex);
    return matches ? [...new Set(matches)] : [];
  }

  /**
   * Check if a hostname matches any blocked domain (with subdomain matching).
   *
   * @private
   * @param {string} hostname - Lowercase hostname to check
   * @returns {boolean} true if hostname is blocked
   */
  _isBlockedDomain(hostname) {
    for (const blocked of BLOCKED_DOMAINS) {
      if (hostname === blocked || hostname.endsWith('.' + blocked)) {
        return true;
      }
    }
    return false;
  }
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = { SecurityScanner };
