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
 * PathGuard - Filesystem Access Control Guard
 *
 * Architecture Brief:
 * -------------------
 * Problem: Agent filesystem access must be restricted to prevent credential
 * theft, config file exfiltration, and SSH key compromise.
 *
 * Pattern: Hardcoded blocklist with wildcard matching. All blocked paths are
 * constants that cannot be modified at runtime. Supports explicit overrides
 * for edge cases.
 *
 * Key Dependencies:
 *   - path (Node.js built-in) for path normalization
 *   - os (Node.js built-in) for home directory resolution
 *
 * Data Flow:
 *   1. Normalize requested path (resolve, expand ~)
 *   2. Check against blocked paths (with wildcard matching)
 *   3. Check against blocked extensions
 *   4. Check against blocked filenames
 *   5. Check against allowedPaths override
 *   6. Return decision
 *
 * Security Principles:
 *   - Path traversal prevention via normalization
 *   - Wildcard matching for user-specific paths
 *   - Explicit override requires logging
 *
 * @module security/guards/path-guard
 * @version 1.0.0
 */

'use strict';

const path = require('path');
const os = require('os');

// -----------------------------------------------------------------------------
// Blocked Paths (hardcoded, never modifiable at runtime)
// -----------------------------------------------------------------------------

/**
 * Paths that are always blocked.
 * Supports wildcards (*) for matching variable path segments.
 * ~ is expanded to home directory at runtime.
 *
 * @type {string[]}
 */
const BLOCKED_PATHS = [
  // System credential files
  '/etc/shadow',
  '/etc/passwd',
  '/etc/sudoers',
  '/etc/sudoers.d',
  '/etc/ssh',

  // SSH keys (all users)
  '~/.ssh',
  '/root/.ssh',
  '/home/*/.ssh',

  // Cloud provider credentials
  '~/.aws',
  '~/.azure',
  '~/.config/gcloud',
  '~/.kube',

  // Browser data (session cookies, passwords)
  '~/.config/google-chrome',
  '~/.config/chromium',
  '~/.mozilla',

  // Package manager credentials
  '~/.npmrc',
  '~/.pypirc',
  '~/.docker/config.json',

  // MoltAgent credential storage
  '/etc/credstore',
  // $CREDENTIALS_DIRECTORY is resolved at runtime and added in constructor
];

/**
 * File extensions that are always blocked.
 * These files typically contain sensitive credentials.
 *
 * @type {string[]}
 */
const BLOCKED_EXTENSIONS = [
  '.env',          // Environment files (.env, .env.local, .env.production)
  '.pem',          // SSL/TLS certificates and keys
  '.key',          // Private keys
  '.pfx',          // PKCS#12 archives
  '.p12',          // PKCS#12 archives
  '.jks',          // Java keystores
];

/**
 * Filenames that are always blocked regardless of path.
 * These files typically contain credentials or keys.
 *
 * @type {string[]}
 */
const BLOCKED_FILENAMES = [
  'credentials.json',
  'secrets.yml',
  'secrets.yaml',
  'secrets.json',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
  '.netrc',
  '.pgpass',
  '.my.cnf',      // MySQL credentials
  '.boto',        // GCS credentials
  'service-account.json',
  'keyfile.json',
];

// -----------------------------------------------------------------------------
// PathGuard Class
// -----------------------------------------------------------------------------

/**
 * Filesystem access control guard.
 *
 * Blocks access to sensitive paths including:
 * - System credential files (/etc/shadow, /etc/passwd, etc.)
 * - SSH keys for all users
 * - Cloud provider credentials (AWS, Azure, GCP, Kubernetes)
 * - Browser data (cookies, passwords)
 * - Package manager credentials
 * - MoltAgent credential storage
 * - Files with sensitive extensions (.env, .pem, .key)
 * - Known credential filenames (id_rsa, secrets.yml, etc.)
 */
class PathGuard {
  /**
   * Create a new PathGuard instance.
   *
   * @param {Object} [options={}] - Configuration options
   * @param {string[]} [options.additionalBlocked] - Extra paths to block
   * @param {string[]} [options.allowedPaths] - Explicit overrides (use with extreme caution)
   * @param {string} [options.homeDir] - Override home directory (for testing)
   */
  constructor(options = {}) {
    // Home directory for ~ expansion
    this.homeDir = options.homeDir || os.homedir();

    // Build blocked paths list
    this.blockedPaths = [...BLOCKED_PATHS];
    if (options.additionalBlocked && Array.isArray(options.additionalBlocked)) {
      this.blockedPaths.push(...options.additionalBlocked);
    }

    // Add $CREDENTIALS_DIRECTORY if set
    if (process.env.CREDENTIALS_DIRECTORY) {
      this.blockedPaths.push(process.env.CREDENTIALS_DIRECTORY);
    }

    // Build expanded blocked paths (with ~ resolved)
    this.expandedBlockedPaths = this.blockedPaths.map(p => this._expandTilde(p));

    // Compile wildcard patterns to regex
    this.blockedPatterns = this.expandedBlockedPaths.map(p => this._pathToRegex(p));

    // Allowed paths override (explicit exceptions)
    this.allowedPaths = new Set(
      (options.allowedPaths || []).map(p => this._normalizePath(p))
    );
  }

  /**
   * Evaluate whether a filesystem path is safe to access.
   *
   * Evaluation order:
   *   1. Normalize path (resolve /../, expand ~)
   *   2. Check allowedPaths override (if match, ALLOW with warning)
   *   3. Check blocked paths (with wildcard matching)
   *   4. Check blocked extensions
   *   5. Check blocked filenames
   *   6. Default: ALLOW
   *
   * @param {string} requestedPath - Path the agent wants to access
   * @param {Object} [_context={}] - Operation context (reserved for future use)
   * @returns {{
   *   allowed: boolean,
   *   reason: string|null,
   *   level: 'BLOCKED'|'ALLOWED',
   *   matchedRule: string|null
   * }}
   */
  evaluate(requestedPath, _context = {}) {
    // Validate requestedPath is string
    if (typeof requestedPath !== 'string' || requestedPath.length === 0) {
      return {
        allowed: false,
        reason: 'Invalid path: path must be a non-empty string',
        level: 'BLOCKED',
        matchedRule: null,
      };
    }

    // Normalize the path (catches /../ traversal attacks)
    const normalizedPath = this._normalizePath(requestedPath);

    // Check allowedPaths override first (explicit override - allowed wins)
    if (this.allowedPaths.has(normalizedPath)) {
      // Log warning about explicit override
      console.warn(`[PathGuard] Path explicitly allowed via override: ${normalizedPath}`);
      return {
        allowed: true,
        reason: 'Path explicitly allowed via override',
        level: 'ALLOWED',
        matchedRule: null,
      };
    }

    // Check blocked paths (with wildcard matching)
    const blockedPathMatch = this._matchesBlockedPath(normalizedPath);
    if (blockedPathMatch.matched) {
      return {
        allowed: false,
        reason: `Path matches blocked pattern: ${blockedPathMatch.rule}`,
        level: 'BLOCKED',
        matchedRule: blockedPathMatch.rule,
      };
    }

    // Check blocked extensions
    const blockedExtMatch = this._hasBlockedExtension(normalizedPath);
    if (blockedExtMatch.matched) {
      return {
        allowed: false,
        reason: `File has blocked extension: ${blockedExtMatch.extension}`,
        level: 'BLOCKED',
        matchedRule: `extension:${blockedExtMatch.extension}`,
      };
    }

    // Check blocked filenames
    const blockedFilenameMatch = this._hasBlockedFilename(normalizedPath);
    if (blockedFilenameMatch.matched) {
      return {
        allowed: false,
        reason: `File has blocked filename: ${blockedFilenameMatch.filename}`,
        level: 'BLOCKED',
        matchedRule: `filename:${blockedFilenameMatch.filename}`,
      };
    }

    // Default: ALLOW
    return {
      allowed: true,
      reason: null,
      level: 'ALLOWED',
      matchedRule: null,
    };
  }

  /**
   * Quick check - is this path blocked?
   *
   * @param {string} requestedPath - Path to check
   * @returns {boolean} true if BLOCKED
   */
  isBlocked(requestedPath) {
    const result = this.evaluate(requestedPath);
    return !result.allowed;
  }

  // ---------------------------------------------------------------------------
  // Private Helper Methods
  // ---------------------------------------------------------------------------

  /**
   * Expand ~ to home directory.
   *
   * @private
   * @param {string} inputPath - Path potentially containing ~
   * @returns {string} Path with ~ expanded
   */
  _expandTilde(inputPath) {
    // Handle both "~" and "~/" cases
    if (inputPath.startsWith('~/')) {
      return path.join(this.homeDir, inputPath.slice(2));
    }
    if (inputPath === '~') {
      return this.homeDir;
    }
    return inputPath;
  }

  /**
   * Normalize a path for comparison.
   * Resolves . and .. components, expands ~.
   *
   * @private
   * @param {string} inputPath - Path to normalize
   * @returns {string} Normalized absolute path
   */
  _normalizePath(inputPath) {
    // Expand tilde first, then use path.resolve to normalize
    const expanded = this._expandTilde(inputPath);
    return path.resolve(expanded);
  }

  /**
   * Convert a path pattern (possibly with wildcards) to a RegExp.
   *
   * Wildcard matching:
   * - * matches any single path segment (not /)
   * - Pattern must match from path start
   * - Pattern can match path prefix (for directories)
   *
   * @private
   * @param {string} pattern - Path pattern, may contain * wildcards
   * @returns {RegExp} Regex for matching
   */
  _pathToRegex(pattern) {
    // Example: /home/*/.ssh -> /^\/home\/[^/]+\/\.ssh(\/|$)/

    // Escape special regex characters (except *)
    let escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

    // Replace * with segment matcher (matches non-slash chars)
    escaped = escaped.replace(/\*/g, '[^/]+');

    // Create regex that matches path or path prefix (for directories)
    return new RegExp(`^${escaped}(\\/|$)`);
  }

  /**
   * Check if a path matches any blocked path pattern.
   *
   * @private
   * @param {string} normalizedPath - Normalized path to check
   * @returns {{matched: boolean, rule: string|null}}
   */
  _matchesBlockedPath(normalizedPath) {
    // Iterate through blockedPatterns and test each regex
    for (let i = 0; i < this.blockedPatterns.length; i++) {
      if (this.blockedPatterns[i].test(normalizedPath)) {
        return { matched: true, rule: this.expandedBlockedPaths[i] };
      }
    }
    return { matched: false, rule: null };
  }

  /**
   * Check if a path has a blocked extension.
   * Handles compound extensions like .env.local, .env.production.
   *
   * @private
   * @param {string} normalizedPath - Normalized path to check
   * @returns {{matched: boolean, extension: string|null}}
   */
  _hasBlockedExtension(normalizedPath) {
    const basename = path.basename(normalizedPath);

    for (const ext of BLOCKED_EXTENSIONS) {
      // Special handling for .env - matches .env, .env.local, .env.production, etc.
      if (ext === '.env') {
        if (basename.startsWith('.env')) {
          return { matched: true, extension: '.env*' };
        }
      } else if (basename.endsWith(ext)) {
        return { matched: true, extension: ext };
      }
    }

    return { matched: false, extension: null };
  }

  /**
   * Check if the filename matches any blocked filename.
   *
   * @private
   * @param {string} normalizedPath - Normalized path to check
   * @returns {{matched: boolean, filename: string|null}}
   */
  _hasBlockedFilename(normalizedPath) {
    const basename = path.basename(normalizedPath);

    if (BLOCKED_FILENAMES.includes(basename)) {
      return { matched: true, filename: basename };
    }

    return { matched: false, filename: null };
  }
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = PathGuard;
