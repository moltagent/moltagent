/*
 * MoltAgent - Sovereign AI Security Layer
 * Copyright (C) 2026 MoltAgent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

'use strict';

const SecretsGuard = require('./guards/secrets-guard.js');

const SUSPICIOUS_PATTERNS = [
  // Shell commands in responses
  { name: 'shell_in_response', pattern: /```(?:bash|sh|shell|zsh)\s*\n(?:.*\n)*?```/gi, severity: 'MEDIUM', action: 'warn' },

  // Base64 blobs > 100 chars (potential exfiltration)
  { name: 'base64_blob', pattern: /[A-Za-z0-9+/]{100,}={0,2}/g, severity: 'HIGH', action: 'warn' },

  // URLs with embedded credentials
  { name: 'auth_url', pattern: /https?:\/\/[^:]+:[^@]+@/gi, severity: 'CRITICAL', action: 'redact' },

  // Internal/private IP addresses
  { name: 'internal_ip', pattern: /(?:^|\s)(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})(?:\s|$|:)/g, severity: 'MEDIUM', action: 'warn' },

  // Cloud metadata endpoints
  { name: 'metadata_endpoint', pattern: /169\.254\.169\.254|metadata\.google\.internal|metadata\.hetzner\.cloud/g, severity: 'HIGH', action: 'redact' },

  // NC internal paths
  { name: 'nc_internal_path', pattern: /\/(?:etc\/credstore|var\/lib\/nextcloud|data\/moltagent)/g, severity: 'MEDIUM', action: 'warn' },
];

/**
 * ResponseWrapper - Sanitizes AI responses before delivery
 *
 * Scans outbound responses for:
 * - Leaked credentials (via SecretsGuard)
 * - Suspicious patterns (shell commands, internal IPs, metadata endpoints)
 * - Over-length content
 */
class ResponseWrapper {
  /**
   * @param {Object} options
   * @param {SecretsGuard} options.secretsGuard - Instance of SecretsGuard (REQUIRED)
   * @param {Object} [options.auditLog] - Optional audit logger with log() method
   * @param {number} [options.maxResponseLength=50000] - Maximum response length before truncation
   */
  constructor(options) {
    if (!options || !options.secretsGuard) {
      throw new Error('ResponseWrapper requires options.secretsGuard');
    }
    if (!(options.secretsGuard instanceof SecretsGuard)) {
      throw new Error('options.secretsGuard must be an instance of SecretsGuard');
    }

    this.secretsGuard = options.secretsGuard;
    this.auditLog = options.auditLog || null;
    this.maxResponseLength = options.maxResponseLength || 50000;
  }

  /**
   * Process an AI response for security issues
   *
   * @param {string} response - The AI response to sanitize
   * @param {Object} [context={}] - Additional context for audit logging
   * @returns {Promise<Object>} Result object with safe, response, warnings, etc.
   */
  async process(response, context = {}) {
    // Handle null/undefined input gracefully
    if (response == null) {
      response = '';
    }

    const result = {
      safe: true,
      response: response,
      warnings: [],
      originalHadSecrets: false,
      truncated: false,
    };

    // Step 1: Length check - truncate if over maxResponseLength
    if (result.response.length > this.maxResponseLength) {
      result.response = result.response.substring(0, this.maxResponseLength);
      result.truncated = true;
      result.warnings.push({
        type: 'response_truncated',
        severity: 'LOW',
        action: 'truncate',
      });
    }

    // Step 2: SecretsGuard scan - redact any credentials
    const secretsScanResult = this.secretsGuard.scan(result.response);
    if (secretsScanResult.hasSecrets) {
      result.originalHadSecrets = true;
      result.response = secretsScanResult.sanitized;

      // Mark as unsafe if CRITICAL secrets were found
      if (secretsScanResult.criticalCount > 0) {
        result.safe = false;
      }

      // Add warnings for each secret type found
      secretsScanResult.findings.forEach(finding => {
        result.warnings.push({
          type: finding.type,
          severity: finding.severity,
          action: 'redact',
        });
      });
    }

    // Step 3: Suspicious pattern scan - warn or redact per pattern config
    for (const pattern of SUSPICIOUS_PATTERNS) {
      const regex = new RegExp(pattern.pattern.source, pattern.pattern.flags);
      const matches = result.response.match(regex);

      if (matches && matches.length > 0) {
        result.warnings.push({
          type: pattern.name,
          severity: pattern.severity,
          action: pattern.action,
        });

        if (pattern.action === 'redact') {
          result.response = result.response.replace(
            regex,
            `[REDACTED:${pattern.name}]`
          );
        }
      }
    }

    // Step 4: Audit logging if findings exist
    if (this.auditLog && result.warnings.length > 0) {
      this.auditLog.log('response_sanitized', {
        findings: result.warnings,
        context,
      });
    }

    return result;
  }
}

module.exports = ResponseWrapper;
