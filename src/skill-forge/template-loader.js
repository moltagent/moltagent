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
 * Skill Forge Template Loader
 *
 * Architecture Brief:
 * -------------------
 * Problem: YAML skill templates are stored in Nextcloud via WebDAV and must
 * be loaded, parsed, validated, and cached efficiently. Templates may come
 * from a federated share (read-only) or the local NC instance.
 *
 * Pattern: Async loader with in-memory cache (Map with TTL). Each load()
 * call checks cache first, then fetches via NCRequestManager. YAML parsing
 * uses js-yaml (v4.1.1, already installed). Validation ensures all required
 * fields are present before returning.
 *
 * Key Dependencies:
 *   - NCRequestManager (injected): WebDAV GET for template files
 *     Response: { status, statusText, headers, body, fromCache }
 *     body is raw string for text/yaml content
 *   - js-yaml (v4.1.1): yaml.load() for YAML parsing
 *   - ./constants (TEMPLATE_REQUIRED_FIELDS, MAX_TEMPLATE_SIZE)
 *
 * Data Flow:
 *   load(templatePath)
 *     -> check cache (Map<path, {template, expiry}>)
 *     -> cache miss: GET /remote.php/dav/files/{user}/{basePath}/{templatePath}
 *     -> strip BOM, yaml.load()
 *     -> validate(template)
 *     -> store in cache with TTL
 *     -> return parsed template object
 *
 * @module skill-forge/template-loader
 * @version 1.0.0
 */

'use strict';

const yaml = require('js-yaml');
const { TEMPLATE_REQUIRED_FIELDS, MAX_TEMPLATE_SIZE } = require('./constants');

// -----------------------------------------------------------------------------
// TemplateLoader Class
// -----------------------------------------------------------------------------

/**
 * Loads and validates YAML skill templates from Nextcloud WebDAV.
 *
 * Templates are cached in memory with a configurable TTL to reduce
 * WebDAV requests. Cache entries are automatically invalidated after
 * the TTL expires.
 */
class TemplateLoader {
  /**
   * Create a new TemplateLoader instance.
   *
   * @param {Object} options
   * @param {import('../lib/nc-request-manager')} options.ncRequestManager - NCRequestManager instance
   * @param {string} [options.templateBasePath='/Moltagent/SkillTemplates'] - NC folder containing templates
   * @param {string} [options.username='moltagent'] - Nextcloud username for WebDAV path construction
   * @param {number} [options.cacheTTLMs=300000] - Template cache TTL in milliseconds (default: 5 min)
   */
  constructor({ ncRequestManager, templateBasePath = '/Moltagent/SkillTemplates', username = 'moltagent', cacheTTLMs = 300000 }) {
    this.nc = ncRequestManager;
    this.templateBasePath = templateBasePath.replace(/\/$/, '');
    this.username = username;
    this.cacheTTLMs = cacheTTLMs;

    /** @private @type {Map<string, {template: Object, expiry: number}>} */
    this.cache = new Map();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Load a template by its path relative to the template base folder.
   *
   * Returns a cached version if available and not expired. Otherwise
   * fetches from Nextcloud WebDAV, parses YAML, validates, caches, and returns.
   *
   * @param {string} templatePath - Relative path, e.g. 'productivity/trello.yaml'
   * @returns {Promise<Object>} Parsed and validated template object
   * @throws {Error} If template not found (404), invalid YAML, or missing required fields
   */
  async load(templatePath) {
    // Check cache first
    const cacheEntry = this.cache.get(templatePath);
    if (cacheEntry && !this._isExpired(cacheEntry)) {
      return cacheEntry.template;
    }

    // Build WebDAV URL and fetch template
    const url = this._webdavPath(templatePath);
    const response = await this.nc.request(url, {
      method: 'GET',
      headers: { 'Accept': 'text/yaml, text/plain, */*' },
    });

    // Check for errors
    if (response.status === 404) {
      throw new Error(`Template not found: ${templatePath}`);
    }
    if (response.status >= 400) {
      throw new Error(`Failed to load template: HTTP ${response.status} ${response.statusText}`);
    }

    // Strip BOM and check size
    let body = response.body;
    if (typeof body !== 'string') {
      throw new Error(`Expected string response body for template ${templatePath}`);
    }
    body = body.replace(/^\uFEFF/, '');

    if (body.length > MAX_TEMPLATE_SIZE) {
      throw new Error(`Template ${templatePath} exceeds maximum size of ${MAX_TEMPLATE_SIZE} characters`);
    }

    // Parse YAML
    let parsed;
    try {
      parsed = yaml.load(body);
    } catch (err) {
      throw new Error(`Failed to parse YAML in ${templatePath}: ${err.message}`);
    }

    // Validate template structure
    const result = this.validate(parsed);
    if (!result.valid) {
      throw new Error(`Template validation failed for ${templatePath}: ${result.errors.join(', ')}`);
    }

    // Cache and return
    this.cache.set(templatePath, { template: parsed, expiry: Date.now() + this.cacheTTLMs });
    return parsed;
  }

  /**
   * Load the template catalog index (_catalog.json).
   *
   * The catalog is a JSON file listing all available templates with
   * their metadata (skill_id, display_name, category, file path, etc.).
   *
   * @returns {Promise<Object>} Catalog object with .templates array
   * @throws {Error} If catalog not found or invalid JSON
   */
  async loadCatalog() {
    // GET _catalog.json via WebDAV
    const url = this._webdavPath('_catalog.json');
    const response = await this.nc.request(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });

    if (response.status === 404) {
      throw new Error('Template catalog (_catalog.json) not found');
    }
    if (response.status >= 400) {
      throw new Error(`Failed to load catalog: HTTP ${response.status} ${response.statusText}`);
    }

    // Parse JSON if needed
    let catalog = response.body;
    if (typeof catalog === 'string') {
      try {
        catalog = JSON.parse(catalog);
      } catch (err) {
        throw new Error(`Failed to parse catalog JSON: ${err.message}`);
      }
    }

    // Validate catalog structure
    if (!catalog || typeof catalog !== 'object') {
      throw new Error('Catalog is not a valid object');
    }
    if (!Array.isArray(catalog.templates)) {
      throw new Error('Catalog must have a "templates" array');
    }

    return catalog;
  }

  /**
   * Validate a parsed template object against the required schema.
   *
   * Checks:
   * - All TEMPLATE_REQUIRED_FIELDS are present
   * - security.allowed_domains exists and is a non-empty array
   * - skill_template is a non-empty string
   * - skill_id matches /^[a-z0-9-]+$/ (lowercase, hyphens, digits only)
   *
   * @param {Object} template - Parsed YAML template object
   * @returns {{ valid: boolean, errors: string[] }}
   */
  validate(template) {
    const errors = [];
    if (!template || typeof template !== 'object') {
      return { valid: false, errors: ['Template is not a valid object'] };
    }
    for (const field of TEMPLATE_REQUIRED_FIELDS) {
      if (template[field] === undefined || template[field] === null) {
        errors.push(`Missing required field: ${field}`);
      }
    }
    if (!template.security?.allowed_domains || !Array.isArray(template.security.allowed_domains) || template.security.allowed_domains.length === 0) {
      errors.push('security.allowed_domains must be a non-empty array');
    }
    if (typeof template.skill_template !== 'string' || template.skill_template.trim().length === 0) {
      errors.push('skill_template must be a non-empty string');
    }
    if (template.skill_id && !/^[a-z0-9-]+$/.test(template.skill_id)) {
      errors.push('skill_id must contain only lowercase letters, digits, and hyphens');
    }
    return { valid: errors.length === 0, errors };
  }

  /**
   * Invalidate cached templates.
   *
   * @param {string} [templatePath] - Specific template path to invalidate.
   *   If omitted, the entire cache is cleared.
   */
  invalidateCache(templatePath) {
    if (templatePath) {
      this.cache.delete(templatePath);
    } else {
      this.cache.clear();
    }
  }

  // ---------------------------------------------------------------------------
  // Private Methods
  // ---------------------------------------------------------------------------

  /**
   * Build the full WebDAV URL path for a template file.
   *
   * @private
   * @param {string} relativePath - Path relative to template base folder
   * @returns {string} Full WebDAV path, e.g. '/remote.php/dav/files/moltagent/Moltagent/SkillTemplates/monitoring/uptime-check.yaml'
   */
  _webdavPath(relativePath) {
    return `/remote.php/dav/files/${this.username}${this.templateBasePath}/${relativePath}`;
  }

  /**
   * Check if a cache entry has expired.
   *
   * @private
   * @param {{ template: Object, expiry: number }} cacheEntry
   * @returns {boolean} true if expired (should refetch)
   */
  _isExpired(cacheEntry) {
    return Date.now() > cacheEntry.expiry;
  }
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = { TemplateLoader };
