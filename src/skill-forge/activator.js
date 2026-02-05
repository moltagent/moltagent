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
 * Skill Forge Activator
 *
 * Architecture Brief:
 * -------------------
 * Problem: Generated SKILL.md files must be deployed from the Nextcloud
 * pending folder to the active skills folder. The deployment must re-scan
 * the content (defense in depth) and move NC files to the active folder.
 *
 * Pattern: Async deployment pipeline with re-scan gate. Uses
 * NCRequestManager (for NC WebDAV operations). The SecurityScanner is
 * injected as a dependency for testability.
 *
 * Key Dependencies:
 *   - NCRequestManager (injected): WebDAV GET/PUT/MOVE for NC file operations
 *     Response: { status, statusText, headers, body, fromCache }
 *   - SecurityScanner (injected): Re-scan on activation
 *   - js-yaml (v4.1.1): Parse YAML frontmatter to extract skill name
 *
 * Data Flow:
 *   savePending(content, metadata)
 *     -> PUT SKILL.md to /Outbox/pending-skills/{name}.md via WebDAV
 *     -> PUT metadata to /Outbox/pending-skills/{name}.meta.json
 *
 *   activate(skillFilename)
 *     -> GET content from pending path
 *     -> GET metadata from pending path
 *     -> SecurityScanner.scan() (re-scan, defense in depth)
 *     -> Extract skill name from frontmatter
 *     -> Update metadata (status, activated_at)
 *     -> MOVE files to /Memory/ActiveSkills/ in NC
 *     -> Return { activated, skillName, verified }
 *
 * // TODO: B1 redesign — ToolActivator replaces this
 *
 * @module skill-forge/activator
 * @version 1.0.0
 */

'use strict';

const yaml = require('js-yaml');

// -----------------------------------------------------------------------------
// SkillActivator Class
// -----------------------------------------------------------------------------

/**
 * Deploys generated skills from NC pending folder to active folder.
 *
 * Responsibilities:
 * - Save generated skills to NC pending folder for review
 * - Re-scan skills on activation (defense in depth)
 * - Move NC files from pending to active folder
 * - Update metadata with activation timestamps
 *
 * // TODO: B1 redesign — ToolActivator replaces this
 */
class SkillActivator {
  /**
   * Create a new SkillActivator instance.
   *
   * @param {Object} options
   * @param {import('../lib/nc-request-manager')} options.ncRequestManager - NCRequestManager instance
   * @param {import('./security-scanner').SecurityScanner} options.securityScanner - SecurityScanner instance
   * @param {string} [options.username='moltagent'] - Nextcloud username for WebDAV paths
   * @param {string} [options.pendingPath='/Outbox/pending-skills'] - NC folder for pending skills
   * @param {string} [options.activePath='/Memory/ActiveSkills'] - NC folder for activated skills
   */
  constructor({
    ncRequestManager,
    securityScanner,
    username = 'moltagent',
    pendingPath = '/Outbox/pending-skills',
    activePath = '/Memory/ActiveSkills',
    ncUrl = '',
  }) {
    this.nc = ncRequestManager;
    this.scanner = securityScanner;
    this.username = username;
    this.pendingPath = pendingPath.replace(/\/$/, '');
    this.activePath = activePath.replace(/\/$/, '');
    this.ncUrl = ncUrl || (ncRequestManager && ncRequestManager.ncUrl) || '';
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Save a generated skill and its metadata to the NC pending folder.
   *
   * The skill file is saved as {skillName}.md and the metadata as
   * {skillName}.meta.json, both in the pendingPath folder.
   *
   * @param {string} skillContent - Generated SKILL.md content
   * @param {Object} metadata - Generation metadata (template_id, parameters, scan result, etc.)
   * @returns {Promise<{ filename: string, metaFilename: string }>}
   * @throws {Error} If skill name cannot be extracted or WebDAV PUT fails
   */
  async savePending(skillContent, metadata) {
    // Extract skill name from frontmatter
    const skillName = this.extractSkillName(skillContent);

    // Build filenames
    const filename = `${skillName}.md`;
    const metaFilename = `${skillName}.meta.json`;

    // Build metadata with status and timestamp
    const fullMetadata = {
      ...metadata,
      status: 'pending_review',
      generated_at: new Date().toISOString(),
    };

    // PUT skill content to pending path via WebDAV
    const contentResponse = await this.nc.request(this._webdavPath(`${this.pendingPath}/${filename}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'text/markdown' },
      body: skillContent,
    });

    // Verify content PUT succeeded
    if (contentResponse.status !== 201 && contentResponse.status !== 204) {
      throw new Error(`Failed to save skill to pending folder: HTTP ${contentResponse.status} ${contentResponse.statusText}`);
    }

    // PUT metadata JSON to pending path
    const metaResponse = await this.nc.request(this._webdavPath(`${this.pendingPath}/${metaFilename}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fullMetadata, null, 2),
    });

    // Verify metadata PUT succeeded
    if (metaResponse.status !== 201 && metaResponse.status !== 204) {
      throw new Error(`Failed to save metadata to pending folder: HTTP ${metaResponse.status} ${metaResponse.statusText}`);
    }

    return { filename, metaFilename };
  }

  /**
   * Activate a pending skill: re-scan, move to active folder in NC.
   *
   * Defense in depth: the skill is re-scanned even though it was scanned
   * at generation time, because the file could have been modified in NC
   * between generation and activation.
   *
   * @param {string} skillFilename - Filename in pending folder, e.g. 'trello-project-phoenix.md'
   * @returns {Promise<{ activated: boolean, skillName: string, verified: boolean|null }>}
   * @throws {Error} If re-scan fails, file not found, or NC MOVE fails
   */
  async activate(skillFilename) {
    // Build paths for skill file and metadata
    const metaFilename = skillFilename.replace(/\.md$/, '.meta.json');

    // GET skill content from pending path via WebDAV
    const contentResponse = await this.nc.request(this._webdavPath(`${this.pendingPath}/${skillFilename}`), {
      method: 'GET',
    });
    if (contentResponse.status === 404) {
      throw new Error(`Pending skill not found: ${skillFilename}`);
    }
    if (contentResponse.status >= 400) {
      throw new Error(`Failed to read pending skill: HTTP ${contentResponse.status} ${contentResponse.statusText}`);
    }

    // GET metadata from pending path
    const metaResponse = await this.nc.request(this._webdavPath(`${this.pendingPath}/${metaFilename}`), {
      method: 'GET',
    });
    let metadata = {};
    if (metaResponse.status >= 200 && metaResponse.status < 300 && metaResponse.body) {
      metadata = typeof metaResponse.body === 'string'
        ? JSON.parse(metaResponse.body)
        : metaResponse.body;
    }

    // Gate: only allow activation of pending_review skills
    if (metadata.status && metadata.status !== 'pending_review') {
      throw new Error(`Cannot activate skill with status "${metadata.status}" (expected "pending_review")`);
    }

    // Re-scan content with SecurityScanner (defense in depth)
    const templateConfig = {
      allowed_domains: metadata.allowed_domains || [],
      forbidden_patterns: metadata.forbidden_patterns || [],
    };
    const scanResult = this.scanner.scan(contentResponse.body, templateConfig);
    if (!scanResult.safe) {
      throw new Error(`Security scan failed on activation: ${scanResult.violations.join(', ')}`);
    }

    // Extract skill name from frontmatter
    const skillName = this.extractSkillName(contentResponse.body);

    // TODO: B1 redesign — ToolActivator replaces this
    // OpenClaw local filesystem deployment removed. Skills are now
    // managed entirely within Nextcloud (pending → active folder).
    // The B1 ToolActivator will register skills as native MoltAgent tools.

    // Update metadata
    metadata.status = 'active';
    metadata.activated_at = new Date().toISOString();
    metadata.security_scan_on_activation = { passed: true, scanned_at: new Date().toISOString() };

    // MOVE skill file to active path in NC
    const moveResponse = await this.nc.request(this._webdavPath(`${this.pendingPath}/${skillFilename}`), {
      method: 'MOVE',
      headers: {
        'Destination': this._fullWebdavUrl(`${this.activePath}/${skillFilename}`),
        'Overwrite': 'T',
      },
    });

    // Check MOVE succeeded (201 or 204)
    if (moveResponse.status !== 201 && moveResponse.status !== 204) {
      throw new Error(`Failed to move skill to active folder: HTTP ${moveResponse.status} ${moveResponse.statusText}`);
    }

    // PUT updated metadata to active path
    const metaPutResponse = await this.nc.request(this._webdavPath(`${this.activePath}/${metaFilename}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(metadata, null, 2),
    });

    // Check metadata PUT succeeded
    if (metaPutResponse.status !== 201 && metaPutResponse.status !== 204) {
      throw new Error(`Failed to save metadata to active folder: HTTP ${metaPutResponse.status} ${metaPutResponse.statusText}`);
    }

    // Delete metadata from pending folder (MOVE only moved the .md file)
    await this.nc.request(this._webdavPath(`${this.pendingPath}/${metaFilename}`), {
      method: 'DELETE',
    });

    return { activated: true, skillName, verified: null };
  }

  /**
   * List all pending skills in the pending folder.
   *
   * Uses WebDAV PROPFIND to list the pending folder contents,
   * then filters for .md files and extracts basic info.
   *
   * @returns {Promise<Array<{ filename: string, template_id: string|null, created: string|null }>>}
   */
  async listPending() {
    // PROPFIND on pending path with Depth: 1
    const response = await this.nc.request(this._webdavPath(this.pendingPath + '/'), {
      method: 'PROPFIND',
      headers: { 'Depth': '1' },
    });

    if (response.status === 404) {
      // Pending folder doesn't exist yet, return empty array
      return [];
    }
    if (response.status >= 400) {
      throw new Error(`Failed to list pending skills: HTTP ${response.status} ${response.statusText}`);
    }

    // Parse WebDAV XML response to extract href entries
    const body = typeof response.body === 'string' ? response.body : '';
    const hrefMatches = body.matchAll(/<d:href>([^<]+)<\/d:href>/g);
    const hrefs = Array.from(hrefMatches).map(m => decodeURIComponent(m[1]));

    // Filter for .md files (not .meta.json)
    const mdFiles = hrefs.filter(href => href.endsWith('.md') && !href.endsWith('/'));

    // For each .md file, try to load its .meta.json for template_id and created
    const results = [];
    for (const href of mdFiles) {
      const filename = href.split('/').pop();
      const metaFilename = filename.replace(/\.md$/, '.meta.json');

      let template_id = null;
      let created = null;

      try {
        const metaResponse = await this.nc.request(this._webdavPath(`${this.pendingPath}/${metaFilename}`), {
          method: 'GET',
        });
        if (metaResponse.status === 200) {
          let metadata = metaResponse.body;
          if (typeof metadata === 'string') {
            metadata = JSON.parse(metadata);
          }
          template_id = metadata.template_id || null;
          created = metadata.generated_at || metadata.created_at || null;
        }
      } catch (err) {
        // Metadata file missing or invalid, continue with nulls
      }

      results.push({ filename, template_id, created });
    }

    return results;
  }

  /**
   * Extract the skill name from SKILL.md YAML frontmatter.
   *
   * Expects content to begin with:
   *   ---
   *   name: skill-name-here
   *   ...
   *   ---
   *
   * @param {string} content - Full SKILL.md content
   * @returns {string} The skill name from frontmatter
   * @throws {Error} If no valid frontmatter found or 'name' field missing
   */
  extractSkillName(content) {
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) {
      throw new Error('No YAML frontmatter found in SKILL.md');
    }
    const frontmatter = yaml.load(frontmatterMatch[1]);
    if (!frontmatter || !frontmatter.name) {
      throw new Error('No "name" field in SKILL.md frontmatter');
    }
    const name = String(frontmatter.name);
    // Security: validate name is safe for filesystem use (no path traversal)
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      throw new Error(`Invalid skill name "${name}": must contain only lowercase letters, digits, and hyphens, and start with a letter or digit`);
    }
    if (name.length > 64) {
      throw new Error(`Skill name too long: ${name.length} chars (max 64)`);
    }
    return name;
  }

  // ---------------------------------------------------------------------------
  // Private Methods
  // ---------------------------------------------------------------------------

  /**
   * Build the full WebDAV URL path for a file.
   *
   * @private
   * @param {string} ncPath - Path within the user's NC files, e.g. '/Outbox/pending-skills/foo.md'
   * @returns {string} Full WebDAV path, e.g. '/remote.php/dav/files/moltagent/Outbox/pending-skills/foo.md'
   */
  _webdavPath(ncPath) {
    return `/remote.php/dav/files/${this.username}${ncPath}`;
  }

  /**
   * Build the full WebDAV URL (including NC base URL) for MOVE Destination header.
   *
   * @private
   * @param {string} ncPath - Path within the user's NC files
   * @returns {string} Full URL for Destination header
   */
  _fullWebdavUrl(ncPath) {
    return `${this.ncUrl}/remote.php/dav/files/${this.username}${ncPath}`;
  }

}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = { SkillActivator };
