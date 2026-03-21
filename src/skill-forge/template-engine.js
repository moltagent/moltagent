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
 * Skill Forge Template Engine
 *
 * Architecture Brief:
 * -------------------
 * Problem: YAML templates contain {{placeholders}} that must be replaced
 * with user-provided parameters to produce a safe SKILL.md file. Parameter
 * values originate from untrusted user input and must be validated, escaped,
 * and sanitized before injection into the template.
 *
 * Pattern: Pure-function assembly. No I/O, no side effects. Takes a parsed
 * template object and a parameter map, returns a generated SKILL.md string.
 * All string operations are deterministic and testable in isolation.
 *
 * Key Dependencies:
 *   - ./constants (FORGE_VERSION)
 *
 * Data Flow:
 *   1. validateParameters(template, params) -> validation result
 *   2. _buildSubstitutionMap(template, params) -> { key: escapedValue, ... }
 *   3. _substitute(template.skill_template, map) -> raw SKILL.md string
 *   4. assemble() wraps 1-3 and returns { content, metadata }
 *
 * @module skill-forge/template-engine
 * @version 1.0.0
 */

'use strict';

const { FORGE_VERSION } = require('./constants');

// -----------------------------------------------------------------------------
// TemplateEngine Class
// -----------------------------------------------------------------------------

/**
 * Assembles SKILL.md files from parsed templates and user parameters.
 *
 * Responsibilities:
 * - Validate parameter values against template-defined schema
 * - Generate URL/filesystem-safe slugs from parameter values
 * - Escape parameter values for safe inclusion in shell commands
 * - Substitute {{placeholders}} in template content
 * - Produce metadata for the generation event
 */
class TemplateEngine {
  /**
   * Create a new TemplateEngine instance.
   *
   * @param {Object} [options={}] - Configuration options
   * @param {string} [options.ncUrl=''] - Nextcloud base URL (for {{nc_url}} substitution)
   * @param {string} [options.ncUser='moltagent'] - NC username (for {{nc_user}} substitution)
   */
  constructor(options = {}) {
    this.ncUrl = (options.ncUrl || '').replace(/\/$/, '');
    this.ncUser = options.ncUser || 'moltagent';
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Assemble a SKILL.md from a parsed template and user parameters.
   *
   * Steps:
   *   1. Validate parameters against template schema
   *   2. Build substitution map (params + slugs + system vars)
   *   3. Substitute all {{placeholders}} in template.skill_template
   *   4. Return generated content with metadata
   *
   * @param {Object} template - Parsed template object (from TemplateLoader)
   * @param {Object} parameters - Map of parameter id -> user-provided value
   * @returns {{ content: string, metadata: Object }}
   * @throws {Error} If required parameters are missing or validation fails
   */
  assemble(template, parameters) {
    // 1. Validate parameters
    const validation = this.validateParameters(template, parameters);
    if (!validation.valid) {
      throw new Error(`Parameter validation failed: ${validation.errors.join(', ')}`);
    }

    // 2. Apply defaults for missing optional parameters
    const finalParameters = { ...parameters };
    for (const paramDef of (template.parameters || [])) {
      if (!paramDef.required && finalParameters[paramDef.id] === undefined) {
        finalParameters[paramDef.id] = paramDef.default_value || '';
      }
    }

    // 3. Build substitution map
    const substitutions = this._buildSubstitutionMap(template, finalParameters);

    // 4. Substitute placeholders in template
    const content = this._substitute(template.skill_template, substitutions);

    // 5. Build metadata
    const metadata = {
      generated_at: new Date().toISOString(),
      forge_version: FORGE_VERSION,
      template_id: template.skill_id,
      template_version: template.version,
      parameters: finalParameters,
      validation_warnings: validation.warnings,
    };

    // 6. Return result
    return { content, metadata };
  }

  /**
   * Validate user-provided parameters against the template's parameter schema.
   *
   * Checks:
   *   - Required parameters are present and non-empty
   *   - Values match validation_pattern (if defined)
   *   - Select-type parameters have a value from the options list
   *   - Boolean parameters are coerced from string if needed
   *
   * @param {Object} template - Parsed template with .parameters array
   * @param {Object} parameters - Map of parameter id -> value
   * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
   */
  validateParameters(template, parameters) {
    const errors = [];
    const warnings = [];
    for (const paramDef of (template.parameters || [])) {
      const value = parameters[paramDef.id];
      if (paramDef.required && (value === undefined || value === null || value === '')) {
        errors.push(`Missing required parameter: ${paramDef.id}`);
        continue;
      }
      if (value !== undefined && value !== null && value !== '') {
        if (paramDef.validation_pattern) {
          try {
            // Safety: reject patterns with nested quantifiers (ReDoS risk)
            if (/(\+|\*|\{)\??\)(\+|\*|\{)/.test(paramDef.validation_pattern)) {
              errors.push(`Parameter '${paramDef.id}' has unsafe validation_pattern (nested quantifiers)`);
            } else {
              const regex = new RegExp(paramDef.validation_pattern);
              if (!regex.test(String(value))) {
                errors.push(`Parameter '${paramDef.id}' does not match pattern: ${paramDef.validation_pattern}`);
              }
            }
          } catch (regexErr) {
            errors.push(`Parameter '${paramDef.id}' has invalid validation_pattern: ${regexErr.message}`);
          }
        }
        if (paramDef.type === 'select' && paramDef.options) {
          const validValues = paramDef.options.map(o => o.value || o);
          if (!validValues.includes(value)) {
            errors.push(`Parameter '${paramDef.id}' must be one of: ${validValues.join(', ')}`);
          }
        }
        if (paramDef.type === 'boolean' && typeof value === 'string') {
          warnings.push(`Parameter '${paramDef.id}': coercing string to boolean`);
        }
      }
    }
    return { valid: errors.length === 0, errors, warnings };
  }

  /**
   * Generate a URL/filesystem-safe slug from a string.
   *
   * Rules:
   *   - Convert to lowercase
   *   - Replace spaces and special characters with hyphens
   *   - Collapse multiple consecutive hyphens to one
   *   - Trim leading and trailing hyphens
   *   - Truncate to 50 characters maximum
   *
   * @param {string} value - Input string to slugify
   * @returns {string} URL/filesystem-safe slug
   *
   * @example
   *   generateSlug('Project Phoenix')   // 'project-phoenix'
   *   generateSlug('My App (v2.0)')     // 'my-app-v2-0'
   *   generateSlug('')                  // ''
   */
  generateSlug(value) {
    if (!value || typeof value !== 'string') return '';
    return value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50);
  }

  /**
   * Escape a string for safe inclusion in shell commands within SKILL.md.
   *
   * Uses an allowlist approach: only alphanumeric characters, hyphens,
   * underscores, dots, forward slashes, colons, and spaces are preserved.
   * All other characters are removed.
   *
   * Specifically removes:
   *   - Backticks (command substitution)
   *   - $() and ${} (variable expansion)
   *   - Semicolons (command chaining)
   *   - Pipe | (piping)
   *   - Redirect operators > < >> (file redirection)
   *   - Newlines and null bytes
   *   - Single and double quotes
   *
   * @param {string} value - Raw parameter value
   * @returns {string} Shell-safe escaped value
   */
  escapeShellValue(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[^a-zA-Z0-9\-_. /:@]/g, '');
  }

  // ---------------------------------------------------------------------------
  // Private Methods
  // ---------------------------------------------------------------------------

  /**
   * Perform {{placeholder}} substitution on a template string.
   *
   * Replaces occurrences of {{name}} with the corresponding value
   * from the substitutions map. Placeholders not found in the map
   * are left as-is (no error thrown).
   *
   * Placeholder format: {{identifier}} where identifier matches
   * [a-zA-Z_][a-zA-Z0-9_]* (standard variable name).
   *
   * @private
   * @param {string} templateStr - Template string with {{placeholders}}
   * @param {Object} substitutions - Map of placeholder name -> replacement value
   * @returns {string} String with placeholders replaced
   */
  _substitute(templateStr, substitutions) {
    return templateStr.replace(
      /\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g,
      (match, key) => {
        if (key in substitutions) {
          return substitutions[key];
        }
        return match; // Leave unknown placeholders intact
      }
    );
  }

  /**
   * Build the complete substitution map from parameters and system variables.
   *
   * For each parameter:
   *   - Adds the shell-escaped raw value as {{parameter_id}}
   *   - Adds the slugified value as {{parameter_id_slug}}
   *
   * System variables added:
   *   - {{nc_url}} -- Nextcloud base URL
   *   - {{nc_user}} -- Nextcloud username
   *   - {{date}} -- Current date (ISO 8601 date portion)
   *   - {{forge_version}} -- Skill Forge engine version
   *
   * @private
   * @param {Object} template - Parsed template
   * @param {Object} parameters - User-provided parameter values (after validation)
   * @returns {Object} Complete substitution map { placeholderName: value }
   */
  _buildSubstitutionMap(template, parameters) {
    const map = {};
    // Add user parameters (escaped) and slug variants
    for (const paramDef of (template.parameters || [])) {
      const rawValue = parameters[paramDef.id];
      if (rawValue !== undefined && rawValue !== null) {
        const strValue = String(rawValue);
        map[paramDef.id] = this.escapeShellValue(strValue);
        map[`${paramDef.id}_slug`] = this.generateSlug(strValue);
      }
    }
    // Add system variables
    map.nc_url = this.ncUrl;
    map.nc_user = this.ncUser;
    map.date = new Date().toISOString().split('T')[0];
    map.forge_version = FORGE_VERSION;
    return map;
  }

  /**
   * Determine which format a template uses.
   * New format has structured `operations` array; old format has `skill_template` string.
   *
   * @param {Object} template - Parsed YAML template
   * @returns {boolean} True if template uses new structured operations format
   */
  isNewFormat(template) {
    return Array.isArray(template?.operations) && template.operations.length > 0;
  }

  /**
   * Generate tool definitions from structured operations (new format).
   * Replaces SKILL.md assembly for new-format templates.
   *
   * @param {Object} template - Parsed YAML template (new format with operations)
   * @param {Object} resolvedParams - User-provided parameter values
   * @returns {Object} { skillId, displayName, apiBase, auth, security, operations }
   */
  generateToolDefinitions(template, resolvedParams) {
    if (!this.isNewFormat(template)) {
      throw new Error('Template does not use new operations format — use assemble() instead');
    }

    const resolve = (str) => {
      if (!str) return '';
      return String(str).replace(/\{\{(\w+)\}\}/g, (_, key) => {
        const val = resolvedParams[key];
        return val !== undefined && val !== null ? String(val) : '';
      });
    };

    return {
      skillId: template.skill_id,
      displayName: template.display_name || template.skill_id,
      apiBase: resolve(template.api_base),
      auth: {
        type: template.auth?.type || 'none',
        credentialName: resolve(template.credentials?.[0]?.nc_password_name || ''),
        headerName: template.auth?.header_name || null,
        keyParam: template.auth?.key_param || null,
        tokenParam: template.auth?.token_param || null,
      },
      security: {
        allowedDomains: template.security?.allowed_domains || [],
      },
      operations: (template.operations || []).map(op => ({
        name: op.name,
        method: (op.method || 'GET').toUpperCase(),
        path: resolve(op.path),
        description: op.description || op.name,
        bodyType: op.body_type || null,
        bodyFields: op.body_fields || [],
        parameters: (op.parameters || []).map(p => ({
          name: p.name,
          type: p.type || 'string',
          required: !!p.required,
          description: p.description || p.name,
          ...(p.enum ? { enum: p.enum } : {}),
          ...(p.default !== undefined ? { default: p.default } : {}),
        })),
        responseHint: op.response_hint || '',
      })),
    };
  }
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = { TemplateEngine };
