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
 * Skill Forge Constants
 *
 * Architecture Brief:
 * -------------------
 * Problem: Security-critical constants (forbidden patterns, safe binaries,
 * blocked domains, credential patterns) must be centralized and immutable
 * to ensure consistent enforcement across all Skill Forge modules.
 *
 * Pattern: Frozen constant arrays and objects exported from a single module.
 * No runtime mutation possible. Intentionally duplicates some values from
 * src/security/guards/ to avoid cross-module coupling.
 *
 * Key Dependencies: None (leaf module)
 *
 * Data Flow:
 *   constants.js -> security-scanner.js (scan checks)
 *   constants.js -> template-engine.js (FORGE_VERSION, shell escape)
 *   constants.js -> template-loader.js (TEMPLATE_REQUIRED_FIELDS)
 *   constants.js -> activator.js (MAX_SKILL_SIZE)
 *
 * @module skill-forge/constants
 * @version 1.0.0
 */

'use strict';

// -----------------------------------------------------------------------------
// Forge Metadata
// -----------------------------------------------------------------------------

/**
 * Current Skill Forge engine version.
 * Embedded in generated SKILL.md metadata.
 * @type {string}
 */
const FORGE_VERSION = '1.0.0';

// -----------------------------------------------------------------------------
// Size Limits
// -----------------------------------------------------------------------------

/**
 * Maximum allowed size for a generated SKILL.md file (characters).
 * @type {number}
 */
const MAX_SKILL_SIZE = 50000;

/**
 * Maximum allowed size for a template YAML file (characters).
 * @type {number}
 */
const MAX_TEMPLATE_SIZE = 100000;

// -----------------------------------------------------------------------------
// Template Validation
// -----------------------------------------------------------------------------

/**
 * Required top-level fields in every template YAML file.
 * TemplateLoader.validate() checks for these.
 * @type {string[]}
 */
const TEMPLATE_REQUIRED_FIELDS = Object.freeze([
  'skill_id',
  'display_name',
  'description',
  'version',
  'requires',
  'security',
  'skill_template',
]);

// -----------------------------------------------------------------------------
// Forbidden Patterns
// -----------------------------------------------------------------------------

/**
 * Global forbidden patterns that must NEVER appear in generated SKILL.md output.
 * Checked via literal string matching (case-sensitive).
 *
 * Categories:
 *   - Arbitrary code execution
 *   - Binary/package downloads
 *   - Exfiltration channels
 *   - Config file access
 *   - Reverse shell components
 *   - Encoding tricks
 *
 * @type {string[]}
 */
const GLOBAL_FORBIDDEN_PATTERNS = Object.freeze([
  // Arbitrary code execution
  'eval',
  'exec',
  'source ',
  './',
  'bash -c',

  // Binary / package downloads
  'wget',
  'pip install',
  'npm install',
  'apt install',
  'brew install',
  'cargo install',
  'go install',
  'chmod +x',
  'chmod 777',
  'chmod 755',

  // Exfiltration channels
  '> /dev/tcp',
  'nc -e',
  'nc -l',
  'webhook.site',
  'requestbin',
  'pipedream',
  'pastebin.com',
  'transfer.sh',

  // Config file access
  '.clawdbot',
  '.openclaw/config',
  '.env',
  '/etc/shadow',
  '/etc/passwd',
  'CREDENTIALS_DIRECTORY',

  // Reverse shell components
  'mkfifo',
  '/bin/sh -i',
  'python -c',
  'ruby -rsocket',
  'perl -e',

  // Encoding tricks
  'base64 -d',
  'xxd',
  'printf',
]);

// -----------------------------------------------------------------------------
// Safe Binaries
// -----------------------------------------------------------------------------

/**
 * Binaries that are allowed in skill 'requires.bins' declarations.
 * Any binary referenced in a generated skill that is NOT in this list
 * triggers a security violation.
 *
 * @type {string[]}
 */
const SAFE_BINS = Object.freeze([
  'curl',
  'jq',
  'grep',
  'sed',
  'awk',
  'date',
  'echo',
  'cat',
  'head',
  'tail',
  'sort',
  'uniq',
  'wc',
  'tr',
  'cut',
]);

// -----------------------------------------------------------------------------
// Blocked Domains
// -----------------------------------------------------------------------------

/**
 * Domains that are always blocked in generated skills, regardless of
 * template allowed_domains configuration.
 *
 * Mirrors EgressGuard ALWAYS_BLOCKED_DOMAINS (intentionally duplicated
 * to avoid cross-module coupling).
 *
 * @type {string[]}
 */
const BLOCKED_DOMAINS = Object.freeze([
  // Loopback / internal
  'localhost',

  // Request catchers / webhook receivers
  'webhook.site',
  'requestbin.com',
  'pipedream.net',
  'hookbin.com',
  'beeceptor.com',
  'requestcatcher.com',
  'postb.in',

  // Paste services
  'pastebin.com',
  'paste.ee',
  'dpaste.com',
  'hastebin.com',
  'ghostbin.co',
  'rentry.co',

  // File upload/share services (ephemeral)
  'transfer.sh',
  'file.io',
  '0x0.st',
  'temp.sh',
  'tmpfiles.org',
  'catbox.moe',
  'litterbox.catbox.moe',

  // URL shorteners
  'bit.ly',
  'tinyurl.com',
  't.co',
  'is.gd',
  'v.gd',
]);

// -----------------------------------------------------------------------------
// Private IP Patterns (SSRF Prevention)
// -----------------------------------------------------------------------------

/**
 * Regular expressions matching private/internal IP address ranges.
 * Used to prevent SSRF via generated skill URLs.
 *
 * @type {RegExp[]}
 */
const PRIVATE_IP_PATTERNS = Object.freeze([
  /^127\./,                          // Loopback
  /^10\./,                           // Class A private
  /^172\.(1[6-9]|2\d|3[01])\./,     // Class B private
  /^192\.168\./,                     // Class C private
  /^169\.254\./,                     // Link-local (includes AWS metadata)
  /^0\./,                            // Current network
  /^fc00:/i,                         // IPv6 ULA
  /^fe80:/i,                         // IPv6 link-local
  /^::1$/,                           // IPv6 loopback
]);

// -----------------------------------------------------------------------------
// Cloud Metadata Endpoints
// -----------------------------------------------------------------------------

/**
 * Cloud provider metadata service hostnames/IPs.
 * Always blocked to prevent credential theft via SSRF.
 *
 * @type {string[]}
 */
const METADATA_ENDPOINTS = Object.freeze([
  'metadata.google.internal',
  'metadata.hetzner.cloud',
  '169.254.169.254',
]);

// -----------------------------------------------------------------------------
// Credential Detection Patterns
// -----------------------------------------------------------------------------

/**
 * Patterns that indicate hardcoded credentials in generated skill content.
 * Each pattern has a name (for reporting) and a regex.
 *
 * @type {Array<{name: string, pattern: RegExp}>}
 */
const CREDENTIAL_PATTERNS = Object.freeze([
  { name: 'api_key_generic', pattern: /sk-[a-zA-Z0-9]{20,}/ },
  { name: 'github_token', pattern: /gh[pousr]_[A-Za-z0-9_]{36,255}/ },
  { name: 'github_fine_grained', pattern: /github_pat_[A-Za-z0-9_]{22,255}/ },
  { name: 'slack_token', pattern: /xox[bpras]-[A-Za-z0-9\-]{10,}/ },
  { name: 'aws_access_key', pattern: /AKIA[0-9A-Z]{16}/ },
  { name: 'private_key_header', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'nc_app_password', pattern: /[A-Za-z0-9]{5}-[A-Za-z0-9]{5}-[A-Za-z0-9]{5}-[A-Za-z0-9]{5}-[A-Za-z0-9]{5}/ },
  { name: 'stripe_key', pattern: /(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{20,}/ },
  { name: 'anthropic_key', pattern: /sk-ant-[A-Za-z0-9\-]{20,}/ },
]);

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = {
  FORGE_VERSION,
  MAX_SKILL_SIZE,
  MAX_TEMPLATE_SIZE,
  TEMPLATE_REQUIRED_FIELDS,
  GLOBAL_FORBIDDEN_PATTERNS,
  SAFE_BINS,
  BLOCKED_DOMAINS,
  PRIVATE_IP_PATTERNS,
  METADATA_ENDPOINTS,
  CREDENTIAL_PATTERNS,
};
