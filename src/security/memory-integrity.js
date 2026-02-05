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
 * MemoryIntegrityChecker - Memory File Scanning and Sanitization
 *
 * Architecture Brief:
 * -------------------
 * Problem: Memory files in /moltagent/Memory/ can be poisoned with prompt
 * injection patterns that compromise the agent when loaded into context.
 *
 * Pattern: Proactive scanning with hash-based change detection
 *   - Scan all .md files in memory directory on startup
 *   - Detect prompt injection patterns (reusing PromptGuard patterns)
 *   - Quarantine CRITICAL/HIGH severity files
 *   - Cache file hashes to skip unchanged files
 *   - Provide sanitize() for new content before write
 *
 * Key Dependencies:
 *   - PromptGuard: Reuse HEURISTIC_PATTERNS for detection
 *   - Node.js crypto: SHA-256 hashing
 *   - ncFilesClient: Nextcloud Files API (list, get, put, delete, copy)
 *
 * Data Flow:
 *   1. scanAll() -> list /moltagent/Memory/*.md files
 *   2. For each file -> scanFile() -> compute hash
 *   3. If hash changed or not in cache -> analyze content
 *   4. If CRITICAL/HIGH -> quarantineFile()
 *   5. Cache hash + severity for future scans
 *
 * Severity Levels:
 *   - CRITICAL: weight >= 0.85, or 3+ HIGH patterns, or instruction_override/data_exfiltration/script_injection
 *   - HIGH: weight 0.70-0.84, or 5+ MEDIUM patterns, or role_manipulation/jailbreak/tool_manipulation
 *   - WARNING: weight 0.50-0.69, or social_engineering/encoded_payload
 *   - CLEAN: no matches or all < 0.50
 *
 * @module security/memory-integrity
 * @version 1.0.0
 */

'use strict';

const crypto = require('crypto');
const PromptGuard = require('./guards/prompt-guard');
const { HEURISTIC_PATTERNS } = PromptGuard;

// -----------------------------------------------------------------------------
// Memory-Specific Injection Patterns
// -----------------------------------------------------------------------------

/**
 * Additional patterns specific to memory file poisoning.
 * These target attack vectors unique to persistent memory:
 * - Command execution setup (curl, wget piped to shell)
 * - Base64 encoded payloads (common in memory-based attacks)
 * - Exfiltration link injection in markdown
 * - Script/iframe injection for XSS-style attacks
 *
 * @type {Array<{pattern: RegExp, weight: number, category: string}>}
 */
const MEMORY_SPECIFIC_PATTERNS = [
  // Command exfiltration setup
  { pattern: /(?:curl|wget|nc|netcat)\s+.*(?:>|>>|\|)/gi, weight: 0.90, category: 'exfiltration_setup' },

  // Base64 encoded payloads (100+ chars, typical for encoded commands)
  { pattern: /[A-Za-z0-9+/]{100,}={0,2}/g, weight: 0.60, category: 'encoded_payload' },

  // Exfiltration links embedded in markdown
  { pattern: /\[.*?\]\((?:https?:\/\/)?(?:webhook\.site|requestbin|pipedream)/gi, weight: 0.85, category: 'exfil_link' },

  // Script injection
  { pattern: /<script[\s>]/gi, weight: 0.95, category: 'script_injection' },

  // Iframe injection
  { pattern: /<iframe[\s>]/gi, weight: 0.85, category: 'iframe_injection' },

  // JavaScript protocol
  { pattern: /javascript:/gi, weight: 0.80, category: 'js_protocol' },
];

// -----------------------------------------------------------------------------
// Critical Attack Categories (Auto-Quarantine)
// -----------------------------------------------------------------------------

/**
 * Attack categories that trigger immediate quarantine regardless of weight.
 * These represent the most dangerous attack vectors for memory poisoning.
 */
const CRITICAL_CATEGORIES = new Set([
  'instruction_override',
  'data_exfiltration',
  'script_injection',
  'exfiltration_setup',
  'exfil_link',
]);

/**
 * Attack categories that indicate high-severity threats.
 */
const HIGH_CATEGORIES = new Set([
  'role_manipulation',
  'jailbreak',
  'tool_manipulation',
  'system_extraction',
  'iframe_injection',
  'js_protocol',
]);

// -----------------------------------------------------------------------------
// MemoryIntegrityChecker Class
// -----------------------------------------------------------------------------

/**
 * Memory integrity checker for scanning and sanitizing persistent memory files.
 *
 * Proactively scans /moltagent/Memory/ for prompt injection patterns,
 * quarantines poisoned files, and provides content sanitization.
 */
class MemoryIntegrityChecker {
  /**
   * Create a new MemoryIntegrityChecker instance.
   *
   * @param {Object} [options={}] - Configuration options
   * @param {Object} [options.ncFilesClient] - Nextcloud Files API client
   * @param {Object} [options.auditLog] - Audit logger for security events
   * @param {Object} [options.notifier] - Notification service for alerts
   * @param {string} [options.memoryPath='/moltagent/Memory'] - Memory directory path
   * @param {string} [options.quarantinePath='/moltagent/Quarantine'] - Quarantine directory path
   * @param {Map} [options.hashCache] - External hash cache (for persistence)
   */
  constructor(options = {}) {
    this.ncFilesClient = options.ncFilesClient || null;
    this.auditLog = options.auditLog || null;
    this.notifier = options.notifier || null;
    this.memoryPath = options.memoryPath || '/moltagent/Memory';
    this.quarantinePath = options.quarantinePath || '/moltagent/Quarantine';

    // Hash cache: filePath -> { hash, severity, scannedAt }
    this.hashCache = options.hashCache || new Map();

    // Initialize PromptGuard with memory-specific patterns
    this.promptGuard = new PromptGuard({
      additionalPatterns: MEMORY_SPECIFIC_PATTERNS,
    });

    // Combined patterns for direct access
    this.allPatterns = [...HEURISTIC_PATTERNS, ...MEMORY_SPECIFIC_PATTERNS];
  }

  // ---------------------------------------------------------------------------
  // Scan Operations
  // ---------------------------------------------------------------------------

  /**
   * Scan all memory files for prompt injection patterns.
   *
   * Iterates through all .md files in memory directory, scans each file,
   * quarantines CRITICAL/HIGH findings, and returns summary.
   *
   * @returns {Promise<{
   *   scanned: number,
   *   quarantined: number,
   *   warnings: number,
   *   clean: number,
   *   findings: Array<{file: string, severity: string, categories: string[]}>
   * }>}
   */
  async scanAll() {
    if (!this.ncFilesClient) {
      throw new Error('ncFilesClient is required for scanAll()');
    }

    const summary = {
      scanned: 0,
      quarantined: 0,
      warnings: 0,
      clean: 0,
      findings: [],
    };

    try {
      // List all .md files in memory directory
      const files = await this.ncFilesClient.list(this.memoryPath);
      const mdFiles = files.filter(f => f.endsWith('.md'));

      for (const file of mdFiles) {
        summary.scanned++;
        const filePath = `${this.memoryPath}/${file}`;

        try {
          const scanResult = await this.scanFile(filePath);

          if (scanResult.severity === 'CRITICAL' || scanResult.severity === 'HIGH') {
            await this.quarantineFile(filePath, scanResult);
            summary.quarantined++;
            summary.findings.push({
              file: filePath,
              severity: scanResult.severity,
              categories: scanResult.categories,
            });
          } else if (scanResult.severity === 'WARNING') {
            summary.warnings++;
            summary.findings.push({
              file: filePath,
              severity: scanResult.severity,
              categories: scanResult.categories,
            });

            // Log warning but don't quarantine
            if (this.auditLog) {
              await this.auditLog.log('memory_scan_warning', {
                file: filePath,
                severity: 'WARNING',
                categories: scanResult.categories,
                patterns: scanResult.findings.length,
              });
            }
          } else {
            summary.clean++;
          }
        } catch (error) {
          // Log scan error but continue with other files
          if (this.auditLog) {
            await this.auditLog.log('memory_scan_error', {
              file: filePath,
              error: error.message,
            });
          }
        }
      }

      // Send notification if any files quarantined
      if (summary.quarantined > 0 && this.notifier) {
        await this.notifier.notify(
          `Memory Integrity Alert: ${summary.quarantined} file(s) quarantined`,
          {
            level: 'critical',
            details: summary.findings.filter(f => f.severity === 'CRITICAL' || f.severity === 'HIGH'),
          }
        );
      }

      return summary;
    } catch (error) {
      if (this.auditLog) {
        await this.auditLog.log('memory_scan_failed', {
          error: error.message,
          path: this.memoryPath,
        });
      }
      throw error;
    }
  }

  /**
   * Scan a single memory file for prompt injection patterns.
   *
   * Uses hash-based change detection to skip unchanged files.
   * Returns severity assessment and detailed findings.
   *
   * @param {string} filePath - Full path to memory file
   * @returns {Promise<{
   *   severity: 'CRITICAL'|'HIGH'|'WARNING'|'CLEAN',
   *   hash: string,
   *   changed: boolean,
   *   findings: Array<{pattern: string, weight: number, category: string, match: string}>,
   *   categories: string[]
   * }>}
   */
  async scanFile(filePath) {
    if (!this.ncFilesClient) {
      throw new Error('ncFilesClient is required for scanFile()');
    }

    // Read file content
    const content = await this.ncFilesClient.get(filePath);
    const currentHash = this.computeHash(content);

    // Check cache for unchanged files
    const cached = this.hashCache.get(filePath);
    if (cached && cached.hash === currentHash) {
      // Skip re-scan if previously CLEAN or WARNING
      if (cached.severity === 'CLEAN' || cached.severity === 'WARNING') {
        return {
          severity: cached.severity,
          hash: currentHash,
          changed: false,
          findings: [],
          categories: [],
        };
      }
    }

    // Scan content using PromptGuard patterns
    const findings = [];
    const categories = new Set();

    for (const { pattern, weight, category } of this.allPatterns) {
      const regex = new RegExp(pattern.source, pattern.flags);
      const matches = content.match(regex);

      if (matches && matches.length > 0) {
        findings.push({
          pattern: pattern.source,
          weight,
          category,
          match: matches[0],
        });
        categories.add(category);
      }
    }

    // Determine severity
    const severity = this._determineSeverity(findings, Array.from(categories));

    // Update cache
    this.hashCache.set(filePath, {
      hash: currentHash,
      severity,
      scannedAt: Date.now(),
    });

    return {
      severity,
      hash: currentHash,
      changed: !cached || cached.hash !== currentHash,
      findings,
      categories: Array.from(categories),
    };
  }

  /**
   * Quarantine a poisoned memory file.
   *
   * Moves file to quarantine directory and creates metadata JSON
   * with scan results, timestamp, and original path.
   *
   * @param {string} filePath - Original file path
   * @param {Object} scanResult - Scan result from scanFile()
   * @returns {Promise<void>}
   */
  async quarantineFile(filePath, scanResult) {
    if (!this.ncFilesClient) {
      throw new Error('ncFilesClient is required for quarantineFile()');
    }

    const fileName = filePath.split('/').pop();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const quarantinedName = `${timestamp}_${fileName}`;
    const quarantinedPath = `${this.quarantinePath}/${quarantinedName}`;
    const metadataPath = `${this.quarantinePath}/${quarantinedName}.meta.json`;

    try {
      // Ensure quarantine directory exists
      const exists = await this.ncFilesClient.exists(this.quarantinePath);
      if (!exists) {
        // Create quarantine directory (implementation depends on ncFilesClient API)
        // For now, assume it exists or will be created automatically
      }

      // Copy file to quarantine
      await this.ncFilesClient.copy(filePath, quarantinedPath);

      // Create metadata file
      const metadata = {
        originalPath: filePath,
        quarantinedAt: new Date().toISOString(),
        severity: scanResult.severity,
        hash: scanResult.hash,
        categories: scanResult.categories,
        findings: scanResult.findings.map(f => ({
          category: f.category,
          weight: f.weight,
          match: f.match.substring(0, 100), // Truncate long matches
        })),
      };

      await this.ncFilesClient.put(metadataPath, JSON.stringify(metadata, null, 2));

      // Delete original file
      await this.ncFilesClient.delete(filePath);

      // Log quarantine action
      if (this.auditLog) {
        await this.auditLog.log('memory_file_quarantined', {
          originalPath: filePath,
          quarantinedPath,
          severity: scanResult.severity,
          categories: scanResult.categories,
          findingsCount: scanResult.findings.length,
        });
      }
    } catch (error) {
      // Log error but don't throw - file may still be in place
      if (this.auditLog) {
        await this.auditLog.log('quarantine_failed', {
          file: filePath,
          error: error.message,
        });
      }
      throw new Error(`Failed to quarantine ${filePath}: ${error.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Content Sanitization
  // ---------------------------------------------------------------------------

  /**
   * Sanitize content by removing detected injection patterns.
   *
   * Strips all matched patterns and returns sanitized content.
   * Returns safe=false if CRITICAL patterns detected (content should be rejected).
   *
   * @param {string} content - Content to sanitize
   * @returns {{
   *   sanitized: string,
   *   stripped: Array<{category: string, match: string}>,
   *   safe: boolean,
   *   severity: 'CRITICAL'|'HIGH'|'WARNING'|'CLEAN'
   * }}
   */
  sanitize(content) {
    if (typeof content !== 'string' || content.length === 0) {
      return {
        sanitized: content || '',
        stripped: [],
        safe: true,
        severity: 'CLEAN',
      };
    }

    let sanitized = content;
    const stripped = [];
    const categories = new Set();

    // Run through all patterns and strip matches
    for (const { pattern, weight, category } of this.allPatterns) {
      const regex = new RegExp(pattern.source, pattern.flags);
      const matches = content.match(regex);

      if (matches && matches.length > 0) {
        // Record what was stripped
        for (const match of matches) {
          stripped.push({ category, match: match.substring(0, 100) });
          categories.add(category);
        }

        // Strip the pattern (replace with placeholder)
        sanitized = sanitized.replace(regex, '[REDACTED]');
      }
    }

    // Determine severity of stripped content
    const findings = stripped.map(s => ({ category: s.category, weight: 0.5 })); // Approximate for severity calc
    const severity = this._determineSeverity(findings, Array.from(categories));

    // Content is unsafe if CRITICAL patterns detected
    const safe = severity !== 'CRITICAL';

    return {
      sanitized,
      stripped,
      safe,
      severity,
    };
  }

  // ---------------------------------------------------------------------------
  // Hash and Change Detection
  // ---------------------------------------------------------------------------

  /**
   * Check if file has changed since last scan.
   *
   * Compares current hash against cached hash.
   *
   * @param {string} filePath - File path to check
   * @param {string} currentHash - Current content hash
   * @returns {boolean} True if file changed or not in cache
   */
  hasChanged(filePath, currentHash) {
    const cached = this.hashCache.get(filePath);
    if (!cached) return true;
    return cached.hash !== currentHash;
  }

  /**
   * Compute SHA-256 hash of content.
   *
   * @param {string} content - Content to hash
   * @returns {string} Hex-encoded SHA-256 hash
   */
  computeHash(content) {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  }

  // ---------------------------------------------------------------------------
  // Private Helpers
  // ---------------------------------------------------------------------------

  /**
   * Determine severity level from findings and categories.
   *
   * @private
   * @param {Array} findings - Pattern findings
   * @param {Array<string>} categories - Triggered categories
   * @returns {'CRITICAL'|'HIGH'|'WARNING'|'CLEAN'}
   */
  _determineSeverity(findings, categories) {
    if (findings.length === 0) {
      return 'CLEAN';
    }

    // Check for critical categories
    const hasCriticalCategory = categories.some(c => CRITICAL_CATEGORIES.has(c));
    if (hasCriticalCategory) {
      return 'CRITICAL';
    }

    // Check for high weight patterns (>= 0.85)
    const hasHighWeight = findings.some(f => f.weight >= 0.85);
    if (hasHighWeight) {
      return 'CRITICAL';
    }

    // Count HIGH severity findings (weight >= 0.70)
    const highFindings = findings.filter(f => f.weight >= 0.70);
    if (highFindings.length >= 3) {
      return 'CRITICAL';
    }

    // Check for high categories
    const hasHighCategory = categories.some(c => HIGH_CATEGORIES.has(c));
    if (hasHighCategory) {
      return 'HIGH';
    }

    // Check for medium weight patterns (>= 0.70)
    if (highFindings.length > 0) {
      return 'HIGH';
    }

    // Count MEDIUM severity findings (weight >= 0.50)
    const mediumFindings = findings.filter(f => f.weight >= 0.50);
    if (mediumFindings.length >= 5) {
      return 'HIGH';
    }

    // Everything else is WARNING (has findings but not severe)
    if (findings.length > 0) {
      return 'WARNING';
    }

    return 'CLEAN';
  }
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = MemoryIntegrityChecker;
module.exports.MEMORY_SPECIFIC_PATTERNS = MEMORY_SPECIFIC_PATTERNS;
