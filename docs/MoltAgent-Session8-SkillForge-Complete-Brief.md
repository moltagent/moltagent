# MoltAgent Session 8+: Skill Forge
## Complete Multi-Session Implementation Brief

**Date:** 2026-02-06  
**Author:** Fu + Claude Opus (architecture)  
**Executor:** Claude Code  
**Position:** POST-LAUNCH FEATURE TRACK  
**Spec source:** `moltagent-skill-forge-spec.md` (1651 lines)  
**Estimated total time:** 5-7 CCode sessions + Fu manual work

---

## Executive Summary

Skill Forge is MoltAgent's answer to ClawHub's security disaster. Instead of letting users install unaudited third-party skills from an open marketplace (where 341+ malicious skills have been found), Skill Forge **generates safe skills from pre-validated templates** using a conversational Talk interface.

**Core insight:** OpenClaw skills are just SKILL.md files — markdown with YAML frontmatter. They contain no compiled code. The LLM reads them and follows the instructions. This means skills can be *assembled from templates* rather than *downloaded from strangers*.

**The result:** A non-technical user can say "Hey MoltAgent, I want you to manage my Trello board" and have a working, secure Trello integration 5 minutes later — without touching a terminal, without visiting ClawHub, without risk.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          SKILL FORGE ARCHITECTURE                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  USER INTERFACES                                                            │
│  ┌──────────────────┐     ┌──────────────────┐                              │
│  │   NC Talk        │     │   NC Forms       │                              │
│  │   (Primary UI)   │     │   (Fallback UI)  │                              │
│  │   Conversational │     │   Structured     │                              │
│  └────────┬─────────┘     └────────┬─────────┘                              │
│           │                        │                                        │
│           └───────────┬────────────┘                                        │
│                       ▼                                                     │
│  TEMPLATE ENGINE                                                            │
│  ┌──────────────────────────────────────────────────────────────────┐      │
│  │  Template Catalog  →  Parameter Resolver  →  SKILL.md Assembler  │      │
│  │  (YAML)               (User input)           (Generated)         │      │
│  └──────────────────────────────────────────────────────────────────┘      │
│                       ▼                                                     │
│  AUDIT GATE                                                                 │
│  ┌──────────────────────────────────────────────────────────────────┐      │
│  │  Security Scanner  →  Pending Review  →  Activation Deployer     │      │
│  │  (automatic)          (human)            (→ OpenClaw skills/)    │      │
│  └──────────────────────────────────────────────────────────────────┘      │
│                                                                             │
│  DISTRIBUTION                                                               │
│  ┌──────────────────────────────────────────────────────────────────┐      │
│  │  MoltAgent Prime NC ──── federated share (read-only) ──→ Client  │      │
│  │  /SkillTemplates/                                                │      │
│  └──────────────────────────────────────────────────────────────────┘      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Session Breakdown

| Session | Focus | Est. Time | Key Deliverables |
|---------|-------|-----------|------------------|
| **8A** | Template Engine Core | 2-2.5h | template-loader, template-engine, security-scanner, activator |
| **8B** | Talk Conversation Engine | 2.5-3h | talk-engine, talk-patterns, conversation-state, credential-verifier |
| **8C** | Federation + Catalog Sync | 1.5-2h | catalog-sync, version checking, first templates |
| **8D** | Generic Skill Builder | 2-2.5h | generic-builder, operation-collector, SSRF protection |
| **8E** | NC Forms Integration | 1.5h | forms-poller, forms-adapter, provisioning script |
| **Fu** | Template Authoring | 15-20h | 15 launch templates (parallel with 8C-8E) |

---

## Session 8A: Template Engine Core

**Goal:** Assemble SKILL.md from template + parameters. Core engine without conversation UI.

**AGPL-3.0 license header for every new file:**

```javascript
/*
 * MoltAgent - Sovereign AI Security Layer
 * Copyright (C) 2026 MoltAgent Contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
```

### Pre-Session Discovery

```bash
# 1. Check existing skill-forge directory
ls -la /opt/moltagent/src/skill-forge/ 2>/dev/null

# 2. Check if yaml parser is available
grep -r "yaml\|js-yaml" /opt/moltagent/package.json

# 3. Check ncFiles WebDAV operations
grep -n "webdav\|WebDAV\|propfind" /opt/moltagent/src/lib/*.js | head -20

# 4. Check OpenClaw skills directory
ls -la /root/.openclaw/skills/ 2>/dev/null

# 5. Check existing security guard patterns (to avoid duplication)
grep -n "FORBIDDEN\|forbidden\|blocked" /opt/moltagent/src/security/guards/*.js | head -30
```

### Deliverables

#### 1. `src/skill-forge/constants.js` (~100 lines)

```javascript
/**
 * Constants for Skill Forge security and validation.
 */

// Forbidden patterns - NEVER allow in generated skills
const GLOBAL_FORBIDDEN_PATTERNS = [
  // Arbitrary code execution
  'eval', 'exec', 'source ', './', 'bash -c',
  
  // Binary downloads
  'wget', 'pip install', 'npm install', 'apt install',
  'brew install', 'cargo install', 'go install',
  'chmod +x', 'chmod 777', 'chmod 755',
  
  // Exfiltration channels
  '> /dev/tcp', 'nc -e', 'nc -l',
  'webhook.site', 'requestbin', 'pipedream',
  'pastebin.com', 'transfer.sh',
  
  // Config file access
  '.clawdbot', '.openclaw/config', '.env',
  '/etc/shadow', '/etc/passwd',
  'CREDENTIALS_DIRECTORY',
  
  // Reverse shells
  'mkfifo', '/bin/sh -i', 'python -c',
  'ruby -rsocket', 'perl -e',
  
  // Encoding tricks
  'base64 -d', 'xxd', 'printf.*\\x',
];

// Safe binaries allowed in skills
const SAFE_BINS = [
  'curl', 'jq', 'grep', 'sed', 'awk', 
  'date', 'echo', 'cat', 'head', 'tail',
  'tr', 'cut', 'sort', 'uniq', 'wc',
];

// Domains blocked for SSRF prevention (Generic Builder)
const BLOCKED_DOMAINS = [
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '169.254.169.254',
  'metadata.google.internal',
  'metadata.hetzner.cloud',
];

// Private IP patterns
const PRIVATE_IP_PATTERNS = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
];

// Credential patterns to detect in output
const CREDENTIAL_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/,           // OpenAI/Anthropic keys
  /ghp_[a-zA-Z0-9]{36}/,           // GitHub tokens
  /xoxb-[0-9]+-[0-9]+-[a-zA-Z0-9]+/, // Slack tokens
  /AKIA[0-9A-Z]{16}/,              // AWS access keys
];

module.exports = {
  GLOBAL_FORBIDDEN_PATTERNS,
  SAFE_BINS,
  BLOCKED_DOMAINS,
  PRIVATE_IP_PATTERNS,
  CREDENTIAL_PATTERNS,
};
```

#### 2. `src/skill-forge/template-loader.js` (~150 lines)

```javascript
/**
 * Loads and validates YAML templates from Nextcloud.
 */
class TemplateLoader {
  constructor({ ncRequestManager, templatePath = '/SkillTemplates' }) {
    this.nc = ncRequestManager;
    this.templatePath = templatePath;
    this.cache = new Map();
    this.catalogCache = null;
    this.catalogVersion = null;
  }

  /**
   * Load the template catalog.
   * @returns {Promise<Object>} Catalog JSON
   */
  async loadCatalog() {
    const response = await this.nc.request(
      `/remote.php/dav/files/moltagent${this.templatePath}/_catalog.json`,
      { method: 'GET', group: 'webdav' }
    );

    if (!response.ok) {
      throw new Error(`Failed to load catalog: ${response.status}`);
    }

    const catalog = JSON.parse(await response.text());
    this.catalogCache = catalog;
    return catalog;
  }

  /**
   * Load a template by skill_id.
   * @param {string} skillId
   * @returns {Promise<Object>} Parsed template
   */
  async loadTemplate(skillId) {
    // Check cache first
    if (this.cache.has(skillId)) {
      return this.cache.get(skillId);
    }

    // Find in catalog
    const catalog = this.catalogCache || await this.loadCatalog();
    const entry = catalog.templates.find(t => t.skill_id === skillId);

    if (!entry) {
      throw new Error(`Template not found: ${skillId}`);
    }

    // Load YAML file
    const response = await this.nc.request(
      `/remote.php/dav/files/moltagent${this.templatePath}/${entry.file}`,
      { method: 'GET', group: 'webdav' }
    );

    if (!response.ok) {
      throw new Error(`Failed to load template ${skillId}: ${response.status}`);
    }

    const yamlContent = await response.text();
    const template = this.parseYaml(yamlContent);

    // Validate template structure
    this.validateTemplate(template);

    // Cache it
    this.cache.set(skillId, template);

    return template;
  }

  /**
   * Parse YAML content (simple parser, no external deps).
   * @private
   */
  parseYaml(content) {
    // Use js-yaml if available, otherwise simple frontmatter parsing
    try {
      const yaml = require('yaml');
      return yaml.parse(content);
    } catch (e) {
      // Fallback: parse frontmatter-style YAML
      return this.parseSimpleYaml(content);
    }
  }

  /**
   * Simple YAML parser for templates.
   * @private
   */
  parseSimpleYaml(content) {
    // Implementation for basic YAML parsing
    // ... (handle nested objects, arrays, multiline strings)
  }

  /**
   * Validate template has required fields.
   * @private
   */
  validateTemplate(template) {
    const required = ['skill_id', 'display_name', 'security', 'skill_template'];
    for (const field of required) {
      if (!template[field]) {
        throw new Error(`Template missing required field: ${field}`);
      }
    }

    if (!template.security.allowed_domains || template.security.allowed_domains.length === 0) {
      throw new Error('Template must specify allowed_domains');
    }
  }

  /**
   * Search templates by keyword.
   */
  async searchTemplates(query) {
    const catalog = this.catalogCache || await this.loadCatalog();
    const q = query.toLowerCase();

    return catalog.templates.filter(t =>
      t.display_name.toLowerCase().includes(q) ||
      t.description.toLowerCase().includes(q) ||
      t.skill_id.toLowerCase().includes(q)
    );
  }

  /**
   * Get current catalog version.
   */
  async getVersion() {
    const response = await this.nc.request(
      `/remote.php/dav/files/moltagent${this.templatePath}/_version.txt`,
      { method: 'GET', group: 'webdav' }
    );

    if (!response.ok) return null;
    return (await response.text()).trim();
  }
}

module.exports = { TemplateLoader };
```

#### 3. `src/skill-forge/template-engine.js` (~200 lines)

```javascript
/**
 * Assembles SKILL.md from template + parameters.
 */
class TemplateEngine {
  constructor({ templateLoader, ncUrl }) {
    this.loader = templateLoader;
    this.ncUrl = ncUrl;
  }

  /**
   * Generate a skill from template and parameters.
   * @param {string} skillId - Template skill_id
   * @param {Object} parameters - User-provided parameters
   * @param {Object} credentials - Credential metadata (not values!)
   * @returns {Promise<{ content: string, metadata: Object }>}
   */
  async generate(skillId, parameters, credentials = {}) {
    const template = await this.loader.loadTemplate(skillId);

    // Validate all required parameters are present
    this.validateParameters(template, parameters);

    // Build substitution context
    const context = this.buildContext(template, parameters, credentials);

    // Substitute placeholders in skill_template
    const content = this.substitute(template.skill_template, context);

    // Generate metadata
    const metadata = {
      generated_at: new Date().toISOString(),
      template_id: skillId,
      template_version: template.version,
      forge_version: '1.0.0',
      parameters: this.sanitizeParameters(parameters),
      credentials_referenced: Object.keys(credentials),
      allowed_domains: template.security.allowed_domains,
    };

    return { content, metadata, template };
  }

  /**
   * Build substitution context from parameters.
   * @private
   */
  buildContext(template, parameters, credentials) {
    const context = {
      // System values
      nc_url: this.ncUrl,
      date: new Date().toISOString().split('T')[0],
      forge_version: '1.0.0',
    };

    // Add parameters and their slug versions
    for (const param of template.parameters || []) {
      const value = parameters[param.id];
      if (value !== undefined) {
        context[param.id] = value;
        context[`${param.id}_slug`] = this.slugify(value);
      } else if (param.default !== undefined) {
        context[param.id] = param.default;
        context[`${param.id}_slug`] = this.slugify(param.default);
      }
    }

    // Add credential NC Passwords names
    for (const cred of template.credentials || []) {
      context[`credential_${cred.id}_name`] = cred.nc_password_name;
    }

    return context;
  }

  /**
   * Substitute {{placeholders}} in template.
   * @private
   */
  substitute(templateStr, context) {
    return templateStr.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      if (context.hasOwnProperty(key)) {
        return this.escapeForShell(String(context[key]));
      }
      console.warn(`Unknown placeholder: ${key}`);
      return match; // Leave unsubstituted
    });
  }

  /**
   * Generate URL/filename-safe slug.
   * @private
   */
  slugify(str) {
    return String(str)
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  /**
   * Escape value for safe inclusion in shell commands.
   * @private
   */
  escapeForShell(str) {
    // Escape special characters that could break shell commands
    return str.replace(/['"\\$`!]/g, '\\$&');
  }

  /**
   * Validate required parameters are present.
   * @private
   */
  validateParameters(template, parameters) {
    for (const param of template.parameters || []) {
      if (param.required && parameters[param.id] === undefined) {
        throw new Error(`Missing required parameter: ${param.id}`);
      }

      // Validate pattern if specified
      if (param.validation_pattern && parameters[param.id]) {
        const regex = new RegExp(param.validation_pattern);
        if (!regex.test(parameters[param.id])) {
          throw new Error(`Parameter ${param.id} failed validation: ${param.validation_pattern}`);
        }
      }
    }
  }

  /**
   * Remove sensitive data from parameters for metadata.
   * @private
   */
  sanitizeParameters(parameters) {
    const sanitized = { ...parameters };
    // Don't store anything that looks like a credential
    for (const [key, value] of Object.entries(sanitized)) {
      if (typeof value === 'string' && value.length > 20) {
        // Could be a token - truncate
        sanitized[key] = value.substring(0, 8) + '...';
      }
    }
    return sanitized;
  }
}

module.exports = { TemplateEngine };
```

#### 4. `src/skill-forge/security-scanner.js` (~180 lines)

```javascript
const {
  GLOBAL_FORBIDDEN_PATTERNS,
  SAFE_BINS,
  CREDENTIAL_PATTERNS,
} = require('./constants');

/**
 * Scans generated SKILL.md for security violations.
 */
class SecurityScanner {
  /**
   * Scan skill content for security issues.
   * @param {string} content - Generated SKILL.md content
   * @param {Object} templateConfig - Template's security configuration
   * @returns {{ safe: boolean, violations: string[], warnings: string[] }}
   */
  scan(content, templateConfig) {
    const violations = [];
    const warnings = [];

    // 1. Check for forbidden patterns
    for (const pattern of GLOBAL_FORBIDDEN_PATTERNS) {
      if (content.toLowerCase().includes(pattern.toLowerCase())) {
        violations.push(`Forbidden pattern found: "${pattern}"`);
      }
    }

    // 2. Check domains against allowlist
    const urls = this.extractURLs(content);
    const allowedDomains = templateConfig?.security?.allowed_domains || [];

    for (const url of urls) {
      try {
        const domain = new URL(url).hostname;
        if (!this.isDomainAllowed(domain, allowedDomains)) {
          violations.push(`Unauthorized domain: ${domain}`);
        }
      } catch (e) {
        warnings.push(`Invalid URL found: ${url}`);
      }
    }

    // 3. Check for hardcoded credentials
    for (const pattern of CREDENTIAL_PATTERNS) {
      if (pattern.test(content)) {
        violations.push('Possible hardcoded credential detected');
        break; // One violation is enough
      }
    }

    // 4. Check binary references
    const binRefs = this.extractBinaryReferences(content);
    for (const bin of binRefs) {
      if (!SAFE_BINS.includes(bin)) {
        violations.push(`Unsafe binary reference: ${bin}`);
      }
    }

    // 5. Warnings (non-blocking)
    if (content.length > 15000) {
      warnings.push(`Skill is unusually large (${content.length} chars)`);
    }

    // Check for credential fetch pattern (should exist)
    if (!content.includes('NC_PASS') && !content.includes('nc_password')) {
      warnings.push('No credential fetch pattern detected - skill may not access NC Passwords');
    }

    return {
      safe: violations.length === 0,
      violations,
      warnings,
      scannedAt: new Date().toISOString(),
    };
  }

  /**
   * Extract URLs from content.
   * @private
   */
  extractURLs(content) {
    const urlPattern = /https?:\/\/[^\s"'<>]+/g;
    return content.match(urlPattern) || [];
  }

  /**
   * Check if domain is in allowlist.
   * @private
   */
  isDomainAllowed(domain, allowedDomains) {
    // Direct match
    if (allowedDomains.includes(domain)) return true;

    // Subdomain match (e.g., api.trello.com matches trello.com)
    for (const allowed of allowedDomains) {
      if (domain.endsWith('.' + allowed) || domain === allowed) {
        return true;
      }
    }

    // Always allow NC URL (system)
    if (domain.includes('your-storageshare.de')) return true;

    return false;
  }

  /**
   * Extract binary references from bash code blocks.
   * @private
   */
  extractBinaryReferences(content) {
    const bins = new Set();

    // Find bash code blocks
    const codeBlocks = content.match(/```bash[\s\S]*?```/g) || [];

    for (const block of codeBlocks) {
      // Extract first word of each command
      const lines = block.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('```')) {
          // Handle pipes and redirects
          const commands = trimmed.split(/[|;&]/);
          for (const cmd of commands) {
            const firstWord = cmd.trim().split(/\s+/)[0];
            if (firstWord && !firstWord.startsWith('$') && !firstWord.startsWith('-')) {
              bins.add(firstWord);
            }
          }
        }
      }
    }

    return Array.from(bins);
  }
}

module.exports = { SecurityScanner };
```

#### 5. `src/skill-forge/activator.js` (~150 lines)

```javascript
const fs = require('fs').promises;
const path = require('path');

/**
 * Deploys skills to OpenClaw's skill directory.
 */
class SkillActivator {
  constructor({ 
    ncRequestManager, 
    securityScanner,
    openclawSkillsDir = '/root/.openclaw/skills',
    pendingPath = '/Outbox/pending-skills',
    activeSkillsPath = '/Memory/ActiveSkills',
  }) {
    this.nc = ncRequestManager;
    this.scanner = securityScanner;
    this.skillsDir = openclawSkillsDir;
    this.pendingPath = pendingPath;
    this.activeSkillsPath = activeSkillsPath;
  }

  /**
   * Save generated skill to pending folder.
   * @param {string} skillName - Skill name (used as filename)
   * @param {string} content - SKILL.md content
   * @param {Object} metadata - Generation metadata
   */
  async savePending(skillName, content, metadata) {
    const filename = `${skillName}.md`;
    const metaFilename = `${skillName}.meta.json`;

    // Add scan result to metadata
    metadata.security_scan = this.scanner.scan(content, { 
      security: { allowed_domains: metadata.allowed_domains }
    });
    metadata.status = 'pending_review';

    // Save skill file
    await this.nc.request(
      `/remote.php/dav/files/moltagent${this.pendingPath}/${filename}`,
      {
        method: 'PUT',
        body: content,
        headers: { 'Content-Type': 'text/markdown' },
        group: 'webdav',
      }
    );

    // Save metadata
    await this.nc.request(
      `/remote.php/dav/files/moltagent${this.pendingPath}/${metaFilename}`,
      {
        method: 'PUT',
        body: JSON.stringify(metadata, null, 2),
        headers: { 'Content-Type': 'application/json' },
        group: 'webdav',
      }
    );

    return { filename, metaFilename, scanResult: metadata.security_scan };
  }

  /**
   * Activate a pending skill.
   * @param {string} skillFilename - Filename in pending folder
   * @param {string} activatedBy - User ID
   */
  async activate(skillFilename, activatedBy = 'system') {
    const metaFilename = skillFilename.replace('.md', '.meta.json');

    // 1. Read skill content
    const contentResponse = await this.nc.request(
      `/remote.php/dav/files/moltagent${this.pendingPath}/${skillFilename}`,
      { method: 'GET', group: 'webdav' }
    );
    if (!contentResponse.ok) {
      throw new Error(`Skill not found: ${skillFilename}`);
    }
    const content = await contentResponse.text();

    // 2. Read metadata
    const metaResponse = await this.nc.request(
      `/remote.php/dav/files/moltagent${this.pendingPath}/${metaFilename}`,
      { method: 'GET', group: 'webdav' }
    );
    const metadata = metaResponse.ok 
      ? JSON.parse(await metaResponse.text())
      : {};

    // 3. Re-scan (defense in depth)
    const scanResult = this.scanner.scan(content, {
      security: { allowed_domains: metadata.allowed_domains || [] }
    });

    if (!scanResult.safe) {
      throw new Error(`Security scan failed: ${scanResult.violations.join(', ')}`);
    }

    // 4. Extract skill name from frontmatter
    const skillName = this.extractSkillName(content);

    // 5. Deploy to OpenClaw skills directory
    const skillDir = path.join(this.skillsDir, skillName);
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), content);

    // 6. Update metadata
    metadata.status = 'active';
    metadata.activated_at = new Date().toISOString();
    metadata.activated_by = activatedBy;

    // 7. Move to active skills in NC
    await this.nc.request(
      `/remote.php/dav/files/moltagent${this.activeSkillsPath}/${skillFilename}`,
      { method: 'PUT', body: content, group: 'webdav' }
    );
    await this.nc.request(
      `/remote.php/dav/files/moltagent${this.activeSkillsPath}/${metaFilename}`,
      { method: 'PUT', body: JSON.stringify(metadata, null, 2), group: 'webdav' }
    );

    // 8. Delete from pending
    await this.nc.request(
      `/remote.php/dav/files/moltagent${this.pendingPath}/${skillFilename}`,
      { method: 'DELETE', group: 'webdav' }
    );
    await this.nc.request(
      `/remote.php/dav/files/moltagent${this.pendingPath}/${metaFilename}`,
      { method: 'DELETE', group: 'webdav' }
    );

    return { skillName, activated: true, metadata };
  }

  /**
   * Extract skill name from YAML frontmatter.
   * @private
   */
  extractSkillName(content) {
    const match = content.match(/^---\s*\nname:\s*(.+)\n/m);
    if (match) return match[1].trim();

    // Fallback: use first heading
    const headingMatch = content.match(/^#\s+(.+)/m);
    if (headingMatch) return this.slugify(headingMatch[1]);

    return 'unnamed-skill';
  }

  slugify(str) {
    return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }
}

module.exports = { SkillActivator };
```

#### 6. `src/skill-forge/index.js` (~50 lines)

```javascript
/*
 * MoltAgent - Sovereign AI Security Layer
 * Copyright (C) 2026 MoltAgent Contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

const { TemplateLoader } = require('./template-loader');
const { TemplateEngine } = require('./template-engine');
const { SecurityScanner } = require('./security-scanner');
const { SkillActivator } = require('./activator');
const constants = require('./constants');

module.exports = {
  TemplateLoader,
  TemplateEngine,
  SecurityScanner,
  SkillActivator,
  constants,
};
```

### Session 8A Exit Criteria

- [ ] `TemplateLoader` reads templates from NC WebDAV
- [ ] `TemplateLoader` caches templates and validates structure
- [ ] `TemplateEngine` substitutes `{{placeholders}}` correctly
- [ ] `TemplateEngine` generates slug versions of parameters
- [ ] `SecurityScanner` detects all forbidden patterns
- [ ] `SecurityScanner` validates domains against allowlist
- [ ] `SecurityScanner` detects hardcoded credentials
- [ ] `SkillActivator` saves to pending folder with metadata
- [ ] `SkillActivator` deploys to OpenClaw skills directory
- [ ] `SkillActivator` re-scans on activation (defense in depth)
- [ ] Manual test: template → generated SKILL.md → security scan → activation
- [ ] All tests pass, ESLint clean

---

## Session 8B: Talk Conversation Engine

**Goal:** Conversational skill setup via NC Talk. The user-facing magic.

### Deliverables

#### 1. `src/skill-forge/talk-patterns.js` (~80 lines)

```javascript
/**
 * Pattern matching for Skill Forge triggers in Talk messages.
 */

const FORGE_TRIGGERS = [
  // Request new skill
  { pattern: /connect(?:ing)? to (\w+)/i, action: 'request_skill', extract: 1 },
  { pattern: /add (\w+) (?:integration|skill)/i, action: 'request_skill', extract: 1 },
  { pattern: /integrate (?:with )?(\w+)/i, action: 'request_skill', extract: 1 },
  { pattern: /i want (?:you to )?(?:manage|use|connect) (?:my )?(\w+)/i, action: 'request_skill', extract: 1 },
  { pattern: /set up (\w+)/i, action: 'request_skill', extract: 1 },

  // List available
  { pattern: /what (?:can you|skills? can you) connect/i, action: 'list_catalog' },
  { pattern: /what(?:'s| is) available/i, action: 'list_catalog' },
  { pattern: /show (?:me )?(?:available )?skills/i, action: 'list_catalog' },
  { pattern: /list (?:available )?skills/i, action: 'list_catalog' },

  // Custom API
  { pattern: /connect (?:to )?(?:my|our|a) (?:own |custom )?api/i, action: 'generic_builder' },
  { pattern: /custom api/i, action: 'generic_builder' },

  // Active skills
  { pattern: /what are you connected to/i, action: 'list_active' },
  { pattern: /(?:show|list) (?:my )?active skills/i, action: 'list_active' },
  { pattern: /what skills (?:do you have|are active)/i, action: 'list_active' },

  // Deactivation
  { pattern: /remove (\w+)/i, action: 'remove_skill', extract: 1 },
  { pattern: /disconnect (\w+)/i, action: 'remove_skill', extract: 1 },
  { pattern: /disable (\w+)/i, action: 'remove_skill', extract: 1 },

  // Status
  { pattern: /forge status/i, action: 'forge_status' },
  { pattern: /skill status/i, action: 'forge_status' },
];

// In-conversation patterns (during active forge session)
const CONVERSATION_PATTERNS = {
  affirmative: /^(yes|yeah|yep|done|ok|okay|ready|sure|confirmed?|got it|i did|i have)$/i,
  negative: /^(no|nope|cancel|stop|nevermind|abort|quit)$/i,
  activate: /^(activate|deploy|yes,? activate|do it)$/i,
  review: /^(review|let me see|show me|i want to review)$/i,
};

/**
 * Match a message against forge triggers.
 * @param {string} message
 * @returns {{ action: string, extracted?: string } | null}
 */
function matchForgeTrigger(message) {
  for (const trigger of FORGE_TRIGGERS) {
    const match = message.match(trigger.pattern);
    if (match) {
      return {
        action: trigger.action,
        extracted: trigger.extract ? match[trigger.extract] : null,
      };
    }
  }
  return null;
}

/**
 * Match conversation response patterns.
 * @param {string} message
 * @returns {string | null} Pattern type matched
 */
function matchConversationPattern(message) {
  const trimmed = message.trim();
  for (const [type, pattern] of Object.entries(CONVERSATION_PATTERNS)) {
    if (pattern.test(trimmed)) {
      return type;
    }
  }
  return null;
}

module.exports = {
  FORGE_TRIGGERS,
  CONVERSATION_PATTERNS,
  matchForgeTrigger,
  matchConversationPattern,
};
```

#### 2. `src/skill-forge/conversation-state.js` (~120 lines)

```javascript
/**
 * Manages conversation state for Skill Forge sessions.
 * Persists to /Memory/SkillForge/ in Nextcloud.
 */
class ConversationState {
  constructor({ ncRequestManager, statePath = '/Memory/SkillForge' }) {
    this.nc = ncRequestManager;
    this.statePath = statePath;
  }

  /**
   * Generate a new session ID.
   */
  generateSessionId() {
    const date = new Date().toISOString().split('T')[0];
    const rand = Math.random().toString(36).substring(2, 8);
    return `forge-${date}-${rand}`;
  }

  /**
   * Create a new conversation session.
   */
  async create(userId, templateId = null) {
    const session = {
      session_id: this.generateSessionId(),
      state: 'DISCOVERY',
      template_id: templateId,
      started: new Date().toISOString(),
      updated: new Date().toISOString(),
      user: userId,
      credentials_collected: {},
      parameters_collected: {},
      current_step: null,
      messages: [],
    };

    await this.save(session);
    return session;
  }

  /**
   * Load an active session for a user.
   */
  async loadActive(userId) {
    try {
      // List session files
      const listResponse = await this.nc.request(
        `/remote.php/dav/files/moltagent${this.statePath}/`,
        { method: 'PROPFIND', headers: { Depth: '1' }, group: 'webdav' }
      );

      if (!listResponse.ok) return null;

      // Find most recent session for this user
      // (Implementation: parse PROPFIND response, filter by user, sort by updated)
      // For simplicity, try direct file access
      const response = await this.nc.request(
        `/remote.php/dav/files/moltagent${this.statePath}/active-${userId}.json`,
        { method: 'GET', group: 'webdav' }
      );

      if (!response.ok) return null;

      const session = JSON.parse(await response.text());

      // Check if expired (24 hours)
      const age = Date.now() - new Date(session.updated).getTime();
      if (age > 24 * 60 * 60 * 1000) {
        await this.expire(session);
        return null;
      }

      return session;
    } catch (e) {
      return null;
    }
  }

  /**
   * Save session state.
   */
  async save(session) {
    session.updated = new Date().toISOString();

    await this.nc.request(
      `/remote.php/dav/files/moltagent${this.statePath}/active-${session.user}.json`,
      {
        method: 'PUT',
        body: JSON.stringify(session, null, 2),
        headers: { 'Content-Type': 'application/json' },
        group: 'webdav',
      }
    );
  }

  /**
   * Update session state and current step.
   */
  async transition(session, newState, step = null) {
    session.state = newState;
    session.current_step = step;
    await this.save(session);
  }

  /**
   * Record collected credential.
   */
  async recordCredential(session, credentialId, ncPasswordName) {
    session.credentials_collected[credentialId] = {
      stored: true,
      nc_password_name: ncPasswordName,
      verified_at: new Date().toISOString(),
    };
    await this.save(session);
  }

  /**
   * Record collected parameter.
   */
  async recordParameter(session, parameterId, value) {
    session.parameters_collected[parameterId] = value;
    await this.save(session);
  }

  /**
   * Complete/close a session.
   */
  async complete(session, status = 'completed') {
    session.state = status;
    session.completed_at = new Date().toISOString();

    // Move to history
    await this.nc.request(
      `/remote.php/dav/files/moltagent${this.statePath}/history/${session.session_id}.json`,
      {
        method: 'PUT',
        body: JSON.stringify(session, null, 2),
        group: 'webdav',
      }
    );

    // Delete active file
    await this.nc.request(
      `/remote.php/dav/files/moltagent${this.statePath}/active-${session.user}.json`,
      { method: 'DELETE', group: 'webdav' }
    );
  }

  /**
   * Expire an old session.
   */
  async expire(session) {
    await this.complete(session, 'expired');
  }
}

module.exports = { ConversationState };
```

#### 3. `src/skill-forge/credential-verifier.js` (~80 lines)

```javascript
/**
 * Verifies credentials exist in NC Passwords (without reading values).
 */
class CredentialVerifier {
  constructor({ ncRequestManager }) {
    this.nc = ncRequestManager;
  }

  /**
   * Check if a credential exists in NC Passwords by label.
   * @param {string} label - The NC Passwords entry label
   * @returns {Promise<boolean>}
   */
  async exists(label) {
    try {
      const response = await this.nc.request(
        '/index.php/apps/passwords/api/1.0/password/list',
        {
          method: 'POST',
          headers: {
            'OCS-APIRequest': 'true',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({}),
          group: 'passwords',
        }
      );

      if (!response.ok) {
        console.error('Failed to list passwords:', response.status);
        return false;
      }

      const passwords = await response.json();
      return passwords.some(p => p.label === label);
    } catch (error) {
      console.error('Credential verification error:', error.message);
      return false;
    }
  }

  /**
   * Check multiple credentials at once.
   * @param {string[]} labels
   * @returns {Promise<Object>} Map of label → exists
   */
  async checkMultiple(labels) {
    try {
      const response = await this.nc.request(
        '/index.php/apps/passwords/api/1.0/password/list',
        {
          method: 'POST',
          headers: {
            'OCS-APIRequest': 'true',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({}),
          group: 'passwords',
        }
      );

      if (!response.ok) return Object.fromEntries(labels.map(l => [l, false]));

      const passwords = await response.json();
      const existingLabels = new Set(passwords.map(p => p.label));

      return Object.fromEntries(
        labels.map(label => [label, existingLabels.has(label)])
      );
    } catch (error) {
      return Object.fromEntries(labels.map(l => [l, false]));
    }
  }

  /**
   * Get next missing credential from a list.
   * @param {Array} requiredCredentials - Template credential definitions
   * @returns {Promise<Object|null>} First missing credential or null
   */
  async getNextMissing(requiredCredentials) {
    const labels = requiredCredentials.map(c => c.nc_password_name);
    const status = await this.checkMultiple(labels);

    for (const cred of requiredCredentials) {
      if (!status[cred.nc_password_name]) {
        return cred;
      }
    }

    return null; // All present
  }
}

module.exports = { CredentialVerifier };
```

#### 4. `src/skill-forge/talk-engine.js` (~350 lines)

The state machine that orchestrates the entire conversation flow.

```javascript
const { matchForgeTrigger, matchConversationPattern } = require('./talk-patterns');

/**
 * State machine for Skill Forge conversations.
 */
class TalkEngine {
  constructor({
    templateLoader,
    templateEngine,
    conversationState,
    credentialVerifier,
    activator,
    talkClient,
  }) {
    this.loader = templateLoader;
    this.engine = templateEngine;
    this.state = conversationState;
    this.verifier = credentialVerifier;
    this.activator = activator;
    this.talk = talkClient;
  }

  /**
   * Process an incoming Talk message.
   * @param {string} message
   * @param {Object} context - { userId, roomToken }
   * @returns {Promise<{ handled: boolean, response?: string }>}
   */
  async processMessage(message, context) {
    const { userId, roomToken } = context;

    // Check for active session
    let session = await this.state.loadActive(userId);

    if (session) {
      // Continue existing conversation
      return this.continueSession(session, message, context);
    }

    // Check for forge trigger
    const trigger = matchForgeTrigger(message);
    if (!trigger) {
      return { handled: false };
    }

    // Handle trigger
    return this.handleTrigger(trigger, message, context);
  }

  /**
   * Handle a forge trigger (new conversation).
   */
  async handleTrigger(trigger, message, context) {
    switch (trigger.action) {
      case 'request_skill':
        return this.startSkillRequest(trigger.extracted, context);

      case 'list_catalog':
        return this.listCatalog(context);

      case 'generic_builder':
        return this.startGenericBuilder(context);

      case 'list_active':
        return this.listActiveSkills(context);

      case 'remove_skill':
        return this.removeSkill(trigger.extracted, context);

      case 'forge_status':
        return this.showForgeStatus(context);

      default:
        return { handled: false };
    }
  }

  /**
   * Start a skill request conversation.
   */
  async startSkillRequest(serviceName, context) {
    // Search catalog for matching template
    const matches = await this.loader.searchTemplates(serviceName);

    if (matches.length === 0) {
      return {
        handled: true,
        response: `I don't have a template for "${serviceName}" yet. ` +
          `Would you like to set up a custom API connection instead? ` +
          `Just say "connect to my API".`,
      };
    }

    if (matches.length === 1) {
      // Exact match - start flow
      return this.startTemplateFlow(matches[0], context);
    }

    // Multiple matches - ask user to choose
    const options = matches.slice(0, 5).map(t => `• ${t.emoji} ${t.display_name}`).join('\n');
    return {
      handled: true,
      response: `I found several options:\n\n${options}\n\nWhich one would you like?`,
    };
  }

  /**
   * Start the template-based flow.
   */
  async startTemplateFlow(templateEntry, context) {
    const template = await this.loader.loadTemplate(templateEntry.skill_id);
    const session = await this.state.create(context.userId, template.skill_id);

    session.template = template;
    await this.state.transition(session, 'COLLECTING_CREDENTIALS', 'credentials.0');

    // Get first missing credential
    const nextCred = await this.verifier.getNextMissing(template.credentials || []);

    if (!nextCred) {
      // No credentials needed - go to parameters
      return this.collectNextParameter(session, context);
    }

    return {
      handled: true,
      response: this.formatCredentialPrompt(template, nextCred),
    };
  }

  /**
   * Format the credential setup prompt.
   */
  formatCredentialPrompt(template, credential) {
    let response = `I can connect to ${template.display_name}! ${template.emoji}\n\n`;
    response += `Let's start with credentials.\n\n`;
    response += `**STEP: ${credential.label}**\n`;
    response += `→ Go to: ${credential.help_url}\n`;
    response += `→ ${credential.help_text}\n`;
    response += `→ In Nextcloud, open **Passwords** app\n`;
    response += `→ Create entry named exactly: \`${credential.nc_password_name}\`\n`;
    response += `→ Paste the credential as the password\n\n`;
    response += `Let me know when done!`;

    return response;
  }

  /**
   * Continue an existing session.
   */
  async continueSession(session, message, context) {
    // Check for cancel
    const pattern = matchConversationPattern(message);
    if (pattern === 'negative') {
      await this.state.complete(session, 'cancelled');
      return {
        handled: true,
        response: `Okay, I've cancelled the skill setup. Let me know if you want to try again!`,
      };
    }

    // Route based on state
    switch (session.state) {
      case 'COLLECTING_CREDENTIALS':
        return this.handleCredentialCollection(session, message, pattern, context);

      case 'COLLECTING_PARAMETERS':
        return this.handleParameterCollection(session, message, context);

      case 'REVIEW':
        return this.handleReview(session, message, pattern, context);

      default:
        return { handled: false };
    }
  }

  /**
   * Handle credential collection state.
   */
  async handleCredentialCollection(session, message, pattern, context) {
    if (pattern !== 'affirmative') {
      return {
        handled: true,
        response: `Just let me know when you've saved the credential!`,
      };
    }

    const template = session.template || await this.loader.loadTemplate(session.template_id);
    const credentials = template.credentials || [];

    // Verify all credentials
    const nextMissing = await this.verifier.getNextMissing(credentials);

    if (nextMissing) {
      // Still missing some
      const existingCheck = await this.verifier.exists(
        credentials[session.credentials_collected.length]?.nc_password_name
      );

      if (existingCheck) {
        // Current one is saved, move to next
        await this.state.recordCredential(
          session,
          credentials[Object.keys(session.credentials_collected).length].id,
          credentials[Object.keys(session.credentials_collected).length].nc_password_name
        );
      }

      const stillMissing = await this.verifier.getNextMissing(credentials);
      if (stillMissing) {
        return {
          handled: true,
          response: `✅ Got it!\n\nNext credential:\n\n` +
            `**${stillMissing.label}**\n` +
            `→ ${stillMissing.help_url}\n` +
            `→ ${stillMissing.help_text}\n` +
            `→ Save as: \`${stillMissing.nc_password_name}\``,
        };
      }
    }

    // All credentials collected - move to parameters
    await this.state.transition(session, 'COLLECTING_PARAMETERS', 'parameters.0');
    return this.collectNextParameter(session, context);
  }

  /**
   * Collect next parameter.
   */
  async collectNextParameter(session, context) {
    const template = session.template || await this.loader.loadTemplate(session.template_id);
    const parameters = template.parameters || [];

    // Find next uncollected required parameter
    for (const param of parameters) {
      if (session.parameters_collected[param.id] === undefined && param.required) {
        await this.state.save(session);
        return {
          handled: true,
          response: param.ask + (param.help_text ? `\n\n_${param.help_text}_` : ''),
        };
      }
    }

    // All parameters collected - assemble and review
    return this.assembleAndReview(session, context);
  }

  /**
   * Handle parameter collection.
   */
  async handleParameterCollection(session, message, context) {
    const template = session.template || await this.loader.loadTemplate(session.template_id);
    const parameters = template.parameters || [];

    // Find current parameter
    for (const param of parameters) {
      if (session.parameters_collected[param.id] === undefined && param.required) {
        // Validate if pattern specified
        if (param.validation_pattern) {
          const regex = new RegExp(param.validation_pattern);
          if (!regex.test(message)) {
            return {
              handled: true,
              response: `That doesn't look right. ${param.help_text || 'Please try again.'}`,
            };
          }
        }

        // Save parameter
        await this.state.recordParameter(session, param.id, message.trim());

        // Get next
        return this.collectNextParameter(session, context);
      }
    }

    // Shouldn't reach here
    return this.assembleAndReview(session, context);
  }

  /**
   * Assemble skill and present for review.
   */
  async assembleAndReview(session, context) {
    const template = await this.loader.loadTemplate(session.template_id);

    // Generate skill
    const { content, metadata } = await this.engine.generate(
      session.template_id,
      session.parameters_collected,
      session.credentials_collected
    );

    // Save to pending
    const skillName = this.engine.slugify(
      `${template.skill_id}-${session.parameters_collected.board_name || session.parameters_collected.service_name || 'custom'}`
    );

    const { scanResult } = await this.activator.savePending(skillName, content, metadata);

    session.generated_skill = skillName;
    await this.state.transition(session, 'REVIEW');

    // Format review message
    let response = `Here's what I've prepared:\n\n`;
    response += `${template.emoji} **Skill:** ${skillName}\n`;

    for (const [key, value] of Object.entries(session.parameters_collected)) {
      response += `📝 **${key}:** ${value}\n`;
    }

    response += `🔒 **Credentials:** ${Object.keys(session.credentials_collected).length} via NC Passwords\n`;
    response += `🌐 **Allowed domains:** ${template.security.allowed_domains.join(', ')}\n\n`;

    if (scanResult.warnings.length > 0) {
      response += `⚠️ Warnings: ${scanResult.warnings.join(', ')}\n\n`;
    }

    response += `I've placed it in \`/Outbox/pending-skills/\` for review.\n\n`;
    response += `**Activate now**, or say "review" to look at it first?`;

    return { handled: true, response };
  }

  /**
   * Handle review state.
   */
  async handleReview(session, message, pattern, context) {
    if (pattern === 'activate') {
      return this.activateSkill(session, context);
    }

    if (pattern === 'review' || message.toLowerCase().includes('review')) {
      return {
        handled: true,
        response: `You can review the skill at:\n` +
          `\`/Outbox/pending-skills/${session.generated_skill}.md\`\n\n` +
          `When ready, say "activate" to deploy it!`,
      };
    }

    return {
      handled: true,
      response: `Say "activate" to deploy the skill, or "review" to look at it first.`,
    };
  }

  /**
   * Activate the generated skill.
   */
  async activateSkill(session, context) {
    try {
      const result = await this.activator.activate(
        `${session.generated_skill}.md`,
        context.userId
      );

      await this.state.complete(session, 'completed');

      let response = `Activating... ✅ Skill deployed!\n\n`;

      // Add usage examples if available
      const template = await this.loader.loadTemplate(session.template_id);
      if (template.examples) {
        response += `You can now ask me things like:\n`;
        for (const ex of template.examples.slice(0, 3)) {
          response += `• "${ex}"\n`;
        }
      }

      response += `\nAnything else you'd like to connect?`;

      return { handled: true, response };
    } catch (error) {
      return {
        handled: true,
        response: `❌ Activation failed: ${error.message}\n\nThe skill is still in pending - you can try again or review it.`,
      };
    }
  }

  /**
   * List available templates in catalog.
   */
  async listCatalog(context) {
    const catalog = await this.loader.loadCatalog();

    let response = `# Available Integrations\n\n`;

    const byCategory = {};
    for (const t of catalog.templates) {
      if (!byCategory[t.category]) byCategory[t.category] = [];
      byCategory[t.category].push(t);
    }

    for (const [category, templates] of Object.entries(byCategory)) {
      response += `**${category.charAt(0).toUpperCase() + category.slice(1)}**\n`;
      for (const t of templates) {
        response += `• ${t.emoji} ${t.display_name}\n`;
      }
      response += `\n`;
    }

    response += `Say "connect to [service]" to get started!`;

    return { handled: true, response };
  }

  // ... Additional methods for generic builder, active skills, etc.
}

module.exports = { TalkEngine };
```

### Session 8B Exit Criteria

- [ ] `TalkEngine` processes incoming messages and routes to handlers
- [ ] Forge triggers correctly matched (connect to X, list skills, etc.)
- [ ] Conversation state persisted to NC `/Memory/SkillForge/`
- [ ] Credential verification checks NC Passwords labels
- [ ] Full conversation flow: trigger → credentials → parameters → review → activate
- [ ] Session timeout (24h) handled
- [ ] Cancel flow works at any point
- [ ] Integration with HeartbeatManager message pipeline
- [ ] Tests for state transitions, trigger matching, credential verification

---

## Session 8C: Federation + Catalog Sync

**Goal:** Template catalog shared from MoltAgent Prime to all clients.

### Deliverables

#### 1. `src/skill-forge/catalog-sync.js` (~100 lines)

```javascript
/**
 * Syncs template catalog from federated share.
 */
class CatalogSync {
  constructor({ templateLoader, talkClient, memoryStore }) {
    this.loader = templateLoader;
    this.talk = talkClient;
    this.memory = memoryStore;
  }

  /**
   * Check for catalog updates (call from heartbeat).
   */
  async checkForUpdates() {
    try {
      const remoteVersion = await this.loader.getVersion();
      const localVersion = await this.memory.get('forge.catalog_version');

      if (remoteVersion && remoteVersion !== localVersion) {
        // Reload catalog
        const catalog = await this.loader.loadCatalog();

        // Update local version
        await this.memory.set('forge.catalog_version', remoteVersion);
        await this.memory.set('forge.catalog', catalog);

        // Notify user (optional)
        const newCount = catalog.templates.length;
        console.log(`[CatalogSync] Updated to v${remoteVersion} (${newCount} templates)`);

        return {
          updated: true,
          version: remoteVersion,
          templateCount: newCount,
        };
      }

      return { updated: false };
    } catch (error) {
      console.error('[CatalogSync] Check failed:', error.message);
      return { updated: false, error: error.message };
    }
  }

  /**
   * Get what's new since last check.
   */
  async getChangelog(fromVersion) {
    // Implementation: compare catalog versions
    // Return list of new/updated templates
  }
}

module.exports = { CatalogSync };
```

#### 2. First Templates (Fu's work, parallel)

Create these in `/SkillTemplates/` on MoltAgent Prime:

| Priority | Template | Complexity |
|----------|----------|------------|
| 1 | `monitoring/uptime-check.yaml` | No auth - simplest |
| 2 | `monitoring/rss-feed.yaml` | No auth |
| 3 | `productivity/trello.yaml` | API key + token |
| 4 | `development/github-issues.yaml` | PAT |
| 5 | `communication/slack-webhook.yaml` | Webhook URL |

### Session 8C Exit Criteria

- [ ] `CatalogSync` detects version changes
- [ ] Catalog reloaded on version bump
- [ ] Federated share setup documented
- [ ] 5 launch templates created and validated
- [ ] Manual test: add template on Prime → client sees it

---

## Session 8D: Generic Skill Builder

**Goal:** Custom API skill generation for any REST API.

### Deliverables

#### 1. `src/skill-forge/generic-builder.js` (~250 lines)

Extended conversation flow for custom APIs:

- Collect base URL (HTTPS only)
- Collect auth method (header key, bearer, basic, none)
- Collect operations one by one
- Generate constrained SKILL.md
- Apply strict SSRF protection

#### 2. `src/skill-forge/operation-collector.js` (~100 lines)

Structured collection of REST operations:
- Method (GET/POST/PUT/DELETE)
- Path
- Query parameters
- Body schema (if POST/PUT)

#### 3. SSRF Protection

```javascript
const { BLOCKED_DOMAINS, PRIVATE_IP_PATTERNS } = require('./constants');

function isURLSafe(url) {
  try {
    const parsed = new URL(url);

    // Must be HTTPS
    if (parsed.protocol !== 'https:') return false;

    // Check blocked domains
    for (const blocked of BLOCKED_DOMAINS) {
      if (parsed.hostname === blocked || parsed.hostname.includes(blocked)) {
        return false;
      }
    }

    // Check private IP patterns
    for (const pattern of PRIVATE_IP_PATTERNS) {
      if (pattern.test(parsed.hostname)) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}
```

### Session 8D Exit Criteria

- [ ] Generic builder conversation flow works
- [ ] Operations collected one by one
- [ ] SSRF protection blocks private IPs, metadata endpoints
- [ ] HTTPS-only enforced
- [ ] Generated skill passes security scan
- [ ] Manual test: "connect to my API" → working skill

---

## Session 8E: NC Forms Integration

**Goal:** Forms as alternative input for skill requests.

### Deliverables

#### 1. `src/skill-forge/forms-poller.js` (~80 lines)

Poll NC Forms API for new submissions during heartbeat.

#### 2. `src/skill-forge/forms-adapter.js` (~60 lines)

Convert form submissions to template parameters.

#### 3. `scripts/provision-forge-forms.sh`

Create forms during deployment:
- "Request a Skill" form
- "Custom API Connection" form

### Session 8E Exit Criteria

- [ ] Forms created during deployment
- [ ] Submissions polled in heartbeat
- [ ] Form data converted to template parameters
- [ ] Skill generation triggered from form submission

---

## Fu's Parallel Track: Template Authoring

**Timeline:** 15-20 hours over 2-3 weeks, parallel with sessions 8C-8E

### Template Priority List

| # | Template | Est. Time | Notes |
|---|----------|-----------|-------|
| 1 | `uptime-check.yaml` | 30 min | No auth, simplest |
| 2 | `rss-feed.yaml` | 30 min | No auth |
| 3 | `website-change.yaml` | 30 min | No auth |
| 4 | `trello.yaml` | 60 min | First auth template |
| 5 | `todoist.yaml` | 45 min | Bearer token |
| 6 | `github-issues.yaml` | 45 min | PAT |
| 7 | `email-imap.yaml` | 90 min | IMAP credentials |
| 8 | `slack-webhook.yaml` | 30 min | Send-only |
| 9 | `google-calendar.yaml` | 90 min | OAuth complexity |
| 10 | `telegram-bot.yaml` | 45 min | Bot token |
| 11 | `notion.yaml` | 60 min | Integration token |
| 12 | `github-repo.yaml` | 45 min | File operations |
| 13 | `google-sheets.yaml` | 75 min | OAuth |
| 14 | `linear-issues.yaml` | 45 min | GraphQL |
| 15 | `rest-api.yaml` | 90 min | The meta-template |

### Template Testing Checklist

For each template:

```
[ ] All curl commands tested against real API
[ ] Credential fetch pattern works with NC Passwords
[ ] Security scanner passes with zero violations
[ ] Generated SKILL.md renders correctly in OpenClaw
[ ] Verification command succeeds with valid credentials
[ ] All placeholder values substituted correctly
[ ] Slug generation produces valid filesystem names
[ ] No domain references outside allowed_domains
```

---

## Complete File Tree

```
src/skill-forge/
├── index.js                        # Module export
├── constants.js                    # Forbidden patterns, safe bins
├── template-loader.js              # Load templates from NC
├── template-engine.js              # Parameter substitution
├── security-scanner.js             # Pre-activation validation
├── activator.js                    # Deploy to OpenClaw
├── talk-engine.js                  # Conversation state machine
├── talk-patterns.js                # Trigger phrase matching
├── conversation-state.js           # State persistence
├── credential-verifier.js          # NC Passwords verification
├── catalog-sync.js                 # Federated catalog updates
├── generic-builder.js              # Custom API flow
├── operation-collector.js          # REST operation collection
├── forms-poller.js                 # NC Forms polling
└── forms-adapter.js                # Form → parameters

scripts/
├── provision-forge-forms.sh        # Create NC Forms
└── setup-federation-share.sh       # Federation docs

config/
└── forge.json                      # Forge configuration

tests/
├── template-engine.test.js
├── security-scanner.test.js
├── talk-engine.test.js
└── generic-builder.test.js
```

---

## Security Properties

| Property | Mechanism |
|----------|-----------|
| No arbitrary code execution | Templates only allow `curl` and `jq`; forbidden patterns block `eval`, `exec`, shells |
| No credential exposure | All credentials via NC Passwords; forbidden patterns block `.env`, config files |
| No exfiltration | `allowed_domains` whitelist per skill; forbidden patterns block known exfil services |
| No malware delivery | No binary downloads; forbidden patterns block `wget`, `pip`, `npm`, `chmod +x` |
| No SSRF | Generic builder blocks localhost, private IPs, cloud metadata endpoints |
| Audit trail | Every generation, scan, and activation logged with metadata |
| Human review | Generated skills land in pending folder; activation requires explicit approval |
| Defense in depth | Re-scan on activation (file could have been modified) |

---

## Business Model Integration

| Tier | Template Access |
|------|----------------|
| **Open Source (free)** | Template engine + generic builder + 3 basic templates |
| **Concierge (€399-799)** | Full catalog (15+ templates) via federated share |
| **Subscription (€49/month)** | Full catalog + monthly updates + priority requests |
| **Custom Dev (€85/hr)** | Custom templates for client-specific APIs |

---

## What Comes After Skill Forge

**Phase 6:** NC Forms deep integration  
**Phase 7:** Advanced security (signed receipts)  
**Phase 8:** Email & Calendar deep integration  
**Phase 9:** Full Knowledge System  

---

*Skill Forge: Because your AI agent's capabilities should be assembled from trusted blueprints, not downloaded from strangers.*
