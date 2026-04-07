/*
 * Moltagent - Sovereign AI Security Layer
 * Copyright (C) 2026 Moltagent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * SecretsGuard - Secrets Detection and Redaction Module
 *
 * Architecture Brief:
 * -------------------
 * Problem: LLM interactions risk leaking credentials, API keys, and other
 * sensitive data if not properly scanned and redacted.
 *
 * Pattern: Pattern-based scanner with 17+ detection rules for common secret
 * formats. Provides both quick-check (fast boolean) and full scan with
 * detailed findings.
 *
 * Key Dependencies:
 * - crypto (Node.js built-in) for hash method
 *
 * Data Flow:
 * - Input content -> Pattern matching -> Findings + Sanitized output
 * - quickCheck: fast path for yes/no detection
 * - scan: full analysis with previews and redaction
 *
 * @module security/guards/secrets-guard
 * @version 1.0.0
 */

'use strict';

const crypto = require('crypto');

// -----------------------------------------------------------------------------
// Detection Patterns
// -----------------------------------------------------------------------------

/**
 * Secret detection patterns with severity levels
 * @type {Array<{name: string, pattern: RegExp, severity: string}>}
 */
const PATTERNS = [
  // Cloud provider keys
  { name: 'aws_access_key', pattern: /AKIA[0-9A-Z]{16}/g, severity: 'CRITICAL' },
  { name: 'aws_secret_key', pattern: /(?:aws_secret|secret_access_key)\s*[:=]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/gi, severity: 'CRITICAL' },

  // API keys with known prefixes
  { name: 'github_token', pattern: /gh[pousr]_[A-Za-z0-9_]{36,255}/g, severity: 'CRITICAL' },
  { name: 'github_fine', pattern: /github_pat_[A-Za-z0-9_]{22,255}/g, severity: 'CRITICAL' },
  { name: 'openai_key', pattern: /sk-[A-Za-z0-9]{20,}T3BlbkFJ[A-Za-z0-9]{20,}/g, severity: 'CRITICAL' },
  { name: 'anthropic_key', pattern: /sk-ant-[A-Za-z0-9\-]{20,}/g, severity: 'CRITICAL' },
  { name: 'stripe_key', pattern: /(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{20,}/g, severity: 'CRITICAL' },
  { name: 'slack_token', pattern: /xox[bpras]-[A-Za-z0-9\-]{10,}/g, severity: 'HIGH' },
  { name: 'slack_webhook', pattern: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/g, severity: 'HIGH' },

  // Private keys
  { name: 'private_key', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, severity: 'CRITICAL' },
  { name: 'certificate', pattern: /-----BEGIN CERTIFICATE-----/g, severity: 'MEDIUM' },

  // Database connection strings
  { name: 'db_connection', pattern: /(?:mongodb|postgres|mysql|redis|amqp):\/\/[^:]+:[^@]+@[^\s]+/gi, severity: 'CRITICAL' },

  // Generic fields
  { name: 'password_field', pattern: /(?:password|passwd|pwd)\s*[:=]\s*['"]?[^\s'"]{8,}['"]?/gi, severity: 'MEDIUM' },
  { name: 'api_key_field', pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*['"]?[^\s'"]{16,}['"]?/gi, severity: 'HIGH' },
  { name: 'secret_field', pattern: /(?:secret|token)\s*[:=]\s*['"]?[^\s'"]{16,}['"]?/gi, severity: 'HIGH' },
  { name: 'bearer_token', pattern: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g, severity: 'HIGH' },
  { name: 'basic_auth', pattern: /Basic\s+[A-Za-z0-9+/]{20,}={0,2}/g, severity: 'HIGH' },

  // URL-embedded credentials
  { name: 'url_credentials', pattern: /https?:\/\/[^:]+:[^@]+@[^\s]+/gi, severity: 'CRITICAL' },

  // Nextcloud app passwords
  { name: 'nc_app_password', pattern: /[A-Za-z0-9]{5}-[A-Za-z0-9]{5}-[A-Za-z0-9]{5}-[A-Za-z0-9]{5}-[A-Za-z0-9]{5}/g, severity: 'CRITICAL' },
];

// -----------------------------------------------------------------------------
// SecretsGuard Class
// -----------------------------------------------------------------------------

/**
 * Secrets detection and redaction guard
 */
class SecretsGuard {
  /**
   * Create a new SecretsGuard instance
   * @param {Object} options - Configuration options
   * @param {Array<{name: string, pattern: RegExp, severity: string}>} [options.customPatterns] - Additional patterns
   * @param {string} [options.redactWith] - Replacement string (default: '[REDACTED]')
   */
  constructor(options = {}) {
    this.patterns = [...PATTERNS];

    if (options.customPatterns && Array.isArray(options.customPatterns)) {
      this.patterns.push(...options.customPatterns);
    }

    this.redactWith = options.redactWith || '[REDACTED]';
  }

  /**
   * Perform full scan with detailed findings and sanitized output
   * @param {string} content - Content to scan
   * @returns {{hasSecrets: boolean, findings: Array, sanitized: string, criticalCount: number}}
   */
  scan(content) {
    if (typeof content !== 'string' || content.length === 0) {
      return {
        hasSecrets: false,
        findings: [],
        sanitized: content || '',
        criticalCount: 0
      };
    }

    const findings = [];
    let sanitized = content;
    let criticalCount = 0;

    for (const { name, pattern, severity } of this.patterns) {
      // Create new RegExp to avoid lastIndex issues
      const regex = new RegExp(pattern.source, pattern.flags);
      let match;

      while ((match = regex.exec(content)) !== null) {
        const secretValue = match[0];
        const preview = this._createPreview(secretValue);

        findings.push({
          type: name,
          severity: severity,
          preview: preview
        });

        if (severity === 'CRITICAL') {
          criticalCount++;
        }

        // Replace in sanitized version with typed redaction marker
        const redactionMarker = `[REDACTED:${name}]`;
        sanitized = sanitized.replace(secretValue, redactionMarker);
      }
    }

    return {
      hasSecrets: findings.length > 0,
      findings: findings,
      sanitized: sanitized,
      criticalCount: criticalCount
    };
  }

  /**
   * Quick check for secrets presence (fast path)
   * @param {string} content - Content to check
   * @returns {boolean} True if secrets detected
   */
  quickCheck(content) {
    if (typeof content !== 'string' || content.length === 0) {
      return false;
    }

    for (const { pattern } of this.patterns) {
      // Reset lastIndex to avoid state issues with global regexes
      pattern.lastIndex = 0;
      if (pattern.test(content)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Generate SHA-256 hash of content
   * @param {string} content - Content to hash
   * @returns {string} Hex-encoded SHA-256 hash
   */
  hash(content) {
    if (typeof content !== 'string') {
      content = String(content);
    }

    return crypto
      .createHash('sha256')
      .update(content, 'utf8')
      .digest('hex');
  }

  /**
   * Evaluate content for pre-write scanning (Phase 2).
   * Called before wiki_write and file_write to prevent credential exfiltration.
   *
   * @param {string} content - Content about to be written
   * @returns {{allowed: boolean, reason: string|null, evidence: Array|null}}
   */
  evaluate(content) {
    const scanResult = this.scan(content);

    if (!scanResult.hasSecrets) {
      return { allowed: true, reason: null, evidence: null };
    }

    const evidence = scanResult.findings.map(f => ({
      type: f.type,
      severity: f.severity,
      preview: f.preview,
    }));

    return {
      allowed: false,
      reason: 'Content contains what appears to be credentials or sensitive data. ' +
              'Refusing to write to prevent accidental exposure.',
      evidence,
    };
  }

  /**
   * Create preview showing first 4 + last 4 characters
   * @private
   * @param {string} secret - Secret value to preview
   * @returns {string} Preview string (e.g., "AKIA...MPLE")
   */
  _createPreview(secret) {
    if (secret.length <= 8) {
      // For very short secrets, show partial
      return secret.substring(0, 4) + '...';
    }

    const firstFour = secret.substring(0, 4);
    const lastFour = secret.substring(secret.length - 4);
    return `${firstFour}...${lastFour}`;
  }
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = SecretsGuard;
module.exports.SecretsGuard = SecretsGuard;
