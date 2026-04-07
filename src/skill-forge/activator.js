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
 * Skill Forge Activator
 *
 * Architecture Brief:
 * -------------------
 * Problem: Generated SKILL.md files must be deployed from the Nextcloud
 * pending folder to the active skills folder. The deployment must re-scan
 * the content (defense in depth) and move NC files to the active folder.
 * Phase B1 extends this with ToolActivator, which registers forged skills
 * directly as native Moltagent tools in the ToolRegistry.
 *
 * Pattern: Two activators, one file.
 *   - SkillActivator (original): Async deployment pipeline with re-scan gate.
 *     Uses NCRequestManager (for NC WebDAV operations).
 *   - ToolActivator (B1): Registers operations from a resolved skill template
 *     as first-class ToolRegistry entries, backed by HttpToolExecutor. Persists
 *     configs to NC so tools survive restarts. Optionally wires EgressGuard for
 *     domain allowlisting.
 *
 * Key Dependencies:
 *   - NCRequestManager (SkillActivator): WebDAV GET/PUT/MOVE for NC file ops
 *     Response: { status, statusText, headers, body, fromCache }
 *   - SecurityScanner (SkillActivator): Re-scan on activation
 *   - js-yaml (v4.1.1): Parse YAML frontmatter to extract skill name
 *   - ToolRegistry (ToolActivator): .register() / .unregister() for tools
 *   - HttpToolExecutor (ToolActivator): Executes HTTP operations for skills
 *   - ncFiles (ToolActivator): NC file client (.write, .read, .delete, .list)
 *   - EgressGuard (ToolActivator, optional): Dynamic domain management
 *
 * Data Flow (SkillActivator):
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
 * Data Flow (ToolActivator):
 *   activate(template, resolvedParams)
 *     -> Build tool name + JSON schema per operation
 *     -> Register handler closures in ToolRegistry
 *     -> Wire EgressGuard allowed_domains (if guard present)
 *     -> Persist config to NC /Memory/SkillForge/active/{skillId}.json
 *     -> Audit log activation
 *     -> Return { skillId, toolsRegistered, success }
 *
 *   deactivate(skillId)
 *     -> Load config from NC
 *     -> Unregister tools from ToolRegistry
 *     -> Remove EgressGuard domains
 *     -> Delete NC config file
 *     -> Audit log deactivation
 *     -> Return { skillId, toolsRemoved, success }
 *
 *   reloadAll()
 *     -> List /Memory/SkillForge/active/ configs
 *     -> activate() each one from persisted state
 *     -> Return array of results
 *
 * Dependency Map:
 *   ToolActivator -> ToolRegistry (register/unregister)
 *   ToolActivator -> HttpToolExecutor (execute HTTP ops)
 *   ToolActivator -> ncFiles (persist/load/list configs)
 *   ToolActivator -> auditLog (async audit function)
 *   ToolActivator -> EgressGuard (optional, domain management)
 *
 * @module skill-forge/activator
 * @version 2.0.0
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
 * Legacy path — retained for backward compatibility. New skills use ToolActivator.
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

    // Skills are managed entirely within Nextcloud (pending → active folder).

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
// ToolActivator Class
// -----------------------------------------------------------------------------

/**
 * Registers forged skills as native tools in the ToolRegistry.
 *
 * Responsibilities:
 * - Build JSON schema and handler closures per skill operation
 * - Register tools in ToolRegistry (backed by HttpToolExecutor)
 * - Optionally allowlist operation domains in EgressGuard
 * - Persist active configs to NC for restart recovery
 * - Audit-log all activation and deactivation events
 */
class ToolActivator {
  /**
   * Create a new ToolActivator instance.
   *
   * @param {Object} options
   * @param {Object} options.toolRegistry - ToolRegistry with .register() and .unregister()
   * @param {Object} options.httpExecutor - HttpToolExecutor with .execute(opConfig, params)
   * @param {Object} options.ncFiles - NC file client: async .write(path, content), .read(path), .delete(path), .list(dir)
   * @param {Function} options.auditLog - async (entry) => Promise audit log function
   * @param {Object} [options.egressGuard] - EgressGuard with .addAllowedDomain() and .removeBySource()
   */
  constructor({ toolRegistry, httpExecutor, ncFiles, auditLog, egressGuard = null }) {
    if (!toolRegistry) throw new Error('ToolActivator: toolRegistry is required');
    if (!httpExecutor) throw new Error('ToolActivator: httpExecutor is required');
    if (!ncFiles) throw new Error('ToolActivator: ncFiles is required');
    if (typeof auditLog !== 'function') throw new Error('ToolActivator: auditLog must be a function');

    this.toolRegistry = toolRegistry;
    this.httpExecutor = httpExecutor;
    this.ncFiles = ncFiles;
    this.auditLog = auditLog;
    this.egressGuard = egressGuard;

    this._configBase = '/Memory/SkillForge/active';
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Activate a resolved skill template: register each operation as a native tool.
   *
   * @param {Object} template - Resolved skill template with skill_id, operations, security, etc.
   * @param {Object} resolvedParams - Parameter values that fill {{placeholders}} in the template
   * @returns {Promise<{ skillId: string, toolsRegistered: string[], success: boolean }>}
   */
  async activate(template, resolvedParams) {
    if (!template || !(template.skill_id || template.name)) {
      throw new Error('ToolActivator.activate: template must have a skill_id or name');
    }
    // Support both 'operations' (legacy) and 'tools' (new) arrays
    const operations = template.operations || template.tools || [];
    if (!Array.isArray(operations) || operations.length === 0) {
      throw new Error(`ToolActivator.activate: template "${template.skill_id || template.name}" has no operations`);
    }

    const skillId = template.skill_id || template.name;
    const templateVersion = template.version || '1.0.0';
    const toolsRegistered = [];

    for (const operation of operations) {
      const toolName = `${skillId}_${this._slugify(operation.name)}`;
      const schema = this._buildSchema(operation);
      const opConfig = this._buildOperationConfig(template, operation, resolvedParams);

      // Capture opConfig in closure — each operation gets its own config snapshot
      const executeFn = async (params) => this.httpExecutor.execute(opConfig, params);

      this.toolRegistry.register({
        name: toolName,
        description: operation.description || `${operation.name} operation from skill ${skillId}`,
        parameters: schema,
        handler: executeFn,
        metadata: {
          source: 'skill-forge',
          skillId,
          templateVersion,
          activatedAt: new Date().toISOString(),
        },
      });

      toolsRegistered.push(toolName);
    }

    // Wire EgressGuard allowed domains if guard is present
    if (this.egressGuard && template.security && Array.isArray(template.security.allowed_domains)) {
      for (const domain of template.security.allowed_domains) {
        if (domain) {
          this.egressGuard.addAllowedDomain(domain, { source: 'skill-forge', skillId });
        }
      }
    }

    // Persist config to NC for restart recovery
    await this._persistConfig(skillId, template, resolvedParams);

    // Audit log the activation
    await this.auditLog({
      event: 'skill_activated',
      skillId,
      templateVersion,
      toolsRegistered,
      timestamp: new Date().toISOString(),
    });

    return { skillId, toolsRegistered, success: true };
  }

  /**
   * Deactivate a skill: unregister all its tools from ToolRegistry, remove NC config,
   * and clean up EgressGuard domain entries.
   *
   * @param {string} skillId - The skill ID to deactivate
   * @returns {Promise<{ skillId: string, toolsRemoved: string[], success: boolean }>}
   */
  async deactivate(skillId) {
    if (!skillId || typeof skillId !== 'string') {
      throw new Error('ToolActivator.deactivate: skillId must be a non-empty string');
    }

    const config = await this._loadConfig(skillId);
    if (!config) {
      throw new Error(`ToolActivator.deactivate: no active config found for skill "${skillId}"`);
    }

    const toolsRemoved = [];
    const template = config.template || {};

    if (Array.isArray(template.operations)) {
      for (const operation of template.operations) {
        const toolName = `${skillId}_${this._slugify(operation.name)}`;
        this.toolRegistry.unregister(toolName);
        toolsRemoved.push(toolName);
      }
    }

    // Remove EgressGuard domains registered by this skill
    if (this.egressGuard) {
      this.egressGuard.removeBySource('skill-forge', skillId);
    }

    // Remove NC config file
    await this._removeConfig(skillId);

    // Audit log the deactivation
    await this.auditLog({
      event: 'skill_deactivated',
      skillId,
      toolsRemoved,
      timestamp: new Date().toISOString(),
    });

    return { skillId, toolsRemoved, success: true };
  }

  /**
   * Reload all persisted skill configs from NC — used on agent restart.
   *
   * Reads every JSON file in /Memory/SkillForge/active/ and re-activates
   * each skill. Individual failures are captured per-result rather than
   * aborting the whole reload.
   *
   * @returns {Promise<Array<{ skillId: string, toolsRegistered: string[], success: boolean }|{ skillId: string, success: boolean, error: string }>>}
   */
  async reloadAll() {
    const configs = await this._listConfigs();
    const results = [];

    for (const { skillId, template, resolvedParams } of configs) {
      try {
        const result = await this.activate(template, resolvedParams);
        results.push(result);
      } catch (err) {
        results.push({ skillId, success: false, error: err.message });
      }
    }

    return results;
  }

  /**
   * Auto-discover YAML templates from a directory and register them.
   *
   * - Parameterless templates: activated immediately as native tools.
   * - Parameterized templates: registered as `forge_setup_{skillId}` meta-tools
   *   that guide the LLM to initiate the Talk-based setup conversation.
   *
   * Skips templates already activated (via reloadAll or prior conversation).
   *
   * @param {string} templatesDir - Absolute path to directory containing YAML templates
   * @param {Object} [templateEngine] - TemplateEngine instance (for generateToolDefinitions)
   * @returns {Promise<{ activated: string[], metaTools: string[], skipped: string[], errors: string[] }>}
   */
  async autoDiscover(templatesDir, templateEngine) {
    const fs = require('fs');
    const path = require('path');
    let yaml;
    try { yaml = require('js-yaml'); } catch { return { activated: [], metaTools: [], skipped: [], errors: ['js-yaml not available'] }; }

    const results = { activated: [], metaTools: [], skipped: [], errors: [] };

    let files;
    try {
      files = fs.readdirSync(templatesDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
    } catch (err) {
      results.errors.push(`Cannot read templates dir: ${err.message}`);
      return results;
    }

    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(templatesDir, file), 'utf8');
        const template = yaml.load(raw);
        if (!template?.skill_id || !Array.isArray(template.operations) || template.operations.length === 0) {
          continue; // Not a new-format template
        }

        const skillId = template.skill_id;

        // Skip if already activated (tools already in registry from reloadAll)
        const firstToolName = `${skillId}_${this._slugify(template.operations[0].name)}`;
        if (this.toolRegistry.has(firstToolName)) {
          results.skipped.push(skillId);
          continue;
        }

        // Check if template has required user parameters
        const requiredParams = (template.parameters || []).filter(p => p.required && !p.derived_from);

        if (requiredParams.length === 0) {
          // Parameterless: activate immediately with empty params
          // Compute derived params if any (e.g. domain transforms)
          const resolvedParams = {};
          for (const paramDef of (template.parameters || [])) {
            if (paramDef.derived_from && resolvedParams[paramDef.derived_from] !== undefined) {
              resolvedParams[paramDef.id] = resolvedParams[paramDef.derived_from]; // passthrough for empty
            }
          }

          const result = await this.activate(template, resolvedParams);
          results.activated.push(skillId);
        } else {
          // Parameterized: register a setup meta-tool
          const metaToolName = `forge_setup_${skillId.replace(/-/g, '_')}`;
          const paramList = requiredParams.map(p => `• ${p.label || p.id}: ${p.ask || p.description || ''}`).join('\n');
          const credentialList = (template.credentials || []).map(c =>
            `• NC Passwords entry "${c.nc_password_name}": ${c.help || c.label || ''}`
          ).join('\n');

          this.toolRegistry.register({
            name: metaToolName,
            description: `Set up ${template.display_name || skillId} integration. Call this when you need ${template.description || skillId} but the connection is not configured yet.`,
            parameters: { type: 'object', properties: {}, required: [] },
            handler: async () => ({
              success: true,
              result: [
                `The ${template.display_name || skillId} skill needs to be configured first.`,
                '',
                'Required setup:',
                paramList,
                credentialList ? `\nCredentials needed:\n${credentialList}` : '',
                '',
                `Ask the user: "I need to connect to ${template.display_name || skillId} first. Can you tell me:"`,
                paramList,
                '',
                `Once they provide the information, tell them to say "connect to ${skillId}" in our conversation to complete the setup.`,
              ].filter(Boolean).join('\n'),
            }),
            metadata: {
              source: 'skill-forge',
              skillId,
              type: 'setup-meta',
              templateFile: file,
              activatedAt: new Date().toISOString(),
            },
          });

          results.metaTools.push(metaToolName);
        }
      } catch (err) {
        results.errors.push(`${file}: ${err.message}`);
      }
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // Schema and Config Builders
  // ---------------------------------------------------------------------------

  /**
   * Convert an operation's parameters array to a JSON Schema object.
   *
   * @param {Object} operation - Single operation from template.operations
   * @returns {Object} JSON Schema object with type:'object', properties, required
   */
  _buildSchema(operation) {
    const properties = {};
    const required = [];

    // Support both array format (legacy) and object map format (new YAML templates)
    if (operation.params && typeof operation.params === 'object' && !Array.isArray(operation.params)) {
      for (const [name, def] of Object.entries(operation.params)) {
        const propDef = {
          type: (def && def.type) || 'string',
          description: (def && def.description) || '',
        };
        if (def && def.enum != null) propDef.enum = def.enum;
        if (def && def.default != null) propDef.default = def.default;
        properties[name] = propDef;
        if (def && def.required === true) required.push(name);
      }
    } else {
      const params = Array.isArray(operation.parameters) ? operation.parameters : [];
      for (const param of params) {
        if (!param || !param.name) continue;

        const propDef = {
          type: param.type || 'string',
          description: param.description || '',
        };

        if (param.enum !== undefined && param.enum !== null) {
          propDef.enum = param.enum;
        }
        if (param.default !== undefined && param.default !== null) {
          propDef.default = param.default;
        }

        properties[param.name] = propDef;

        if (param.required === true) {
          required.push(param.name);
        }
      }
    }

    return {
      type: 'object',
      properties,
      required,
    };
  }

  /**
   * Build a static operation config used by HttpToolExecutor to execute a request.
   *
   * Template-level {{placeholders}} in api_base and path are resolved using resolvedParams.
   *
   * @param {Object} template - The full skill template
   * @param {Object} operation - Single operation from template.operations
   * @param {Object} resolvedParams - Resolved parameter map for placeholder substitution
   * @returns {Object} opConfig for HttpToolExecutor.execute()
   */
  _buildOperationConfig(template, operation, resolvedParams) {
    // URL: prefer operation.url (full URL) over api_base + path
    let resolvedUrl;
    if (operation.url) {
      resolvedUrl = this._resolveString(operation.url, resolvedParams);
    } else {
      const apiBase = this._resolveString(template.api_base || '', resolvedParams);
      const path = this._resolveString(operation.path || '', resolvedParams);
      resolvedUrl = `${apiBase}${path}`;
    }

    // Auth: pass through all fields (session auth adds extra fields)
    const auth = template.auth || {};
    const authConfig = {
      type: auth.type || null,
      credential_name: auth.credential_name || auth.credentialName || null,
      // Legacy camelCase aliases
      credentialName: auth.credential_name || auth.credentialName || null,
      headerName: auth.header_name || auth.headerName || null,
      keyParam: auth.key_param || auth.keyParam || null,
      tokenParam: auth.token_param || auth.tokenParam || null,
    };

    // Session auth: pass through session-specific fields
    if (auth.type === 'session') {
      authConfig.session_endpoint = auth.session_endpoint;
      authConfig.session_method = auth.session_method;
      authConfig.session_body = auth.session_body;
      authConfig.token_path = auth.token_path;
      authConfig.extra_from_session = auth.extra_from_session;
      authConfig.token_ttl = auth.token_ttl;
    }

    const params = Array.isArray(operation.parameters) ? operation.parameters : [];
    const defaultBodyFields = operation.body_type === 'json'
      ? params.map(p => p.name).filter(Boolean)
      : [];

    const config = {
      method: operation.method || 'GET',
      url: resolvedUrl,
      auth: authConfig,
      queryParams: operation.query_params || [],
      bodyType: operation.body_type || (operation.body ? 'json' : null),
      bodyFields: operation.body_fields || defaultBodyFields,
    };

    // Body template: operation.body is an object template with {{placeholders}}
    if (operation.body && typeof operation.body === 'object') {
      config.bodyTemplate = operation.body;
      config.bodyType = 'json';
    }

    return config;
  }

  /**
   * Replace {{key}} placeholders in a string with values from params.
   *
   * @param {string} template - String containing {{key}} placeholders
   * @param {Object} params - Key/value map of replacements
   * @returns {string} String with all placeholders resolved
   */
  _resolveString(template, params) {
    if (!template || typeof template !== 'string') return template || '';
    if (!params || typeof params !== 'object') return template;
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
      const val = params[key];
      return val !== undefined && val !== null ? String(val) : '';
    });
  }

  /**
   * Convert a string to a safe tool-name slug: lowercase, non-alphanumeric to
   * underscores, leading/trailing underscores trimmed.
   *
   * @param {string} str - Input string (e.g. operation name)
   * @returns {string} Slugified string safe for use as a tool name segment
   */
  _slugify(str) {
    if (!str || typeof str !== 'string') return 'op';
    return str
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  /**
   * Persist skill config to NC for restart recovery.
   *
   * @private
   * @param {string} skillId
   * @param {Object} template
   * @param {Object} resolvedParams
   */
  async _persistConfig(skillId, template, resolvedParams) {
    const configPath = `${this._configBase}/${skillId}.json`;
    const payload = JSON.stringify({ skillId, template, resolvedParams, persistedAt: new Date().toISOString() }, null, 2);
    try {
      await this.ncFiles.write(configPath, payload);
    } catch (err) {
      // Best-effort: auto-discovered skills will re-discover on next restart
      console.warn(`[SkillForge] Persistence failed for ${skillId}: ${err.message}`);
    }
  }

  /**
   * Load and parse a persisted skill config from NC.
   *
   * @private
   * @param {string} skillId
   * @returns {Promise<Object|null>} Parsed config or null if not found/invalid
   */
  async _loadConfig(skillId) {
    const path = `${this._configBase}/${skillId}.json`;
    try {
      const content = await this.ncFiles.read(path);
      if (!content) return null;
      return typeof content === 'string' ? JSON.parse(content) : content;
    } catch {
      return null;
    }
  }

  /**
   * Delete a persisted skill config from NC.
   *
   * @private
   * @param {string} skillId
   */
  async _removeConfig(skillId) {
    const path = `${this._configBase}/${skillId}.json`;
    try {
      await this.ncFiles.delete(path);
    } catch {
      // Best-effort: if the file is already gone, don't throw
    }
  }

  /**
   * List all persisted skill configs from NC.
   *
   * @private
   * @returns {Promise<Array<{ skillId: string, template: Object, resolvedParams: Object }>>}
   */
  async _listConfigs() {
    let files;
    try {
      files = await this.ncFiles.list(this._configBase);
    } catch {
      // Directory doesn't exist yet or unreadable — return empty
      return [];
    }

    if (!Array.isArray(files)) return [];

    const results = [];
    for (const file of files) {
      // Accept string filenames or objects with a name/filename property
      const filename = typeof file === 'string' ? file : (file.name || file.filename || '');
      if (!filename.endsWith('.json')) continue;

      // Derive skillId from filename: strip path prefix and .json suffix
      const basename = filename.split('/').pop();
      const skillId = basename.replace(/\.json$/, '');
      if (!skillId) continue;

      const config = await this._loadConfig(skillId);
      if (config && config.template) {
        results.push({
          skillId: config.skillId || skillId,
          template: config.template,
          resolvedParams: config.resolvedParams || {},
        });
      }
    }

    return results;
  }
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = { SkillActivator, ToolActivator };
