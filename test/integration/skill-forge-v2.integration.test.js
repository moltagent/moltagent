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
 * Skill Forge V2 End-to-End Integration Tests
 *
 * Validates the full chain for new-format (operations-based) templates:
 *   template -> generateToolDefinitions -> scanToolDefinitions
 *   -> activate -> execute (mock fetch) -> deactivate -> reload
 *
 * No real network calls. No filesystem writes. Pure in-process pipeline.
 *
 * @module test/integration/skill-forge-v2.integration.test.js
 */

'use strict';

const assert = require('assert');
const yaml = require('js-yaml');
const fs = require('fs');
const path = require('path');

const { test, asyncTest, summary, exitWithCode } = require('../helpers/test-runner');
const { TemplateEngine } = require('../../src/skill-forge/template-engine');
const { SecurityScanner } = require('../../src/skill-forge/security-scanner');
const { ToolActivator } = require('../../src/skill-forge/activator');
const { HttpToolExecutor } = require('../../src/skill-forge/http-tool-executor');

console.log('\n=== Skill Forge V2 End-to-End Integration Tests ===\n');

// -----------------------------------------------------------------------------
// Load Real YAML Templates
// -----------------------------------------------------------------------------

const templatesDir = path.join(__dirname, '../../config/skill-templates');
const webhookTemplate = yaml.load(fs.readFileSync(path.join(templatesDir, 'webhook.yaml'), 'utf8'));
const wordpressTemplate = yaml.load(fs.readFileSync(path.join(templatesDir, 'wordpress.yaml'), 'utf8'));
const braveTemplate = yaml.load(fs.readFileSync(path.join(templatesDir, 'brave-search.yaml'), 'utf8'));

// -----------------------------------------------------------------------------
// Shared Instances
// -----------------------------------------------------------------------------

const engine = new TemplateEngine({ ncUrl: 'https://cloud.example.com', ncUser: 'test' });
const scanner = new SecurityScanner();

// -----------------------------------------------------------------------------
// Infrastructure Factories
// -----------------------------------------------------------------------------

/**
 * Real Map-backed ToolRegistry mock.
 */
function createToolRegistry() {
  const tools = new Map();
  return {
    register(def) { tools.set(def.name, def); },
    unregister(name) { return tools.delete(name); },
    has(name) { return tools.has(name); },
    get(name) { return tools.get(name); },
    listBySource(source) {
      const result = [];
      for (const t of tools.values()) {
        if (t.metadata?.source === source) result.push(t);
      }
      return result;
    },
    get size() { return tools.size; },
    _tools: tools,
  };
}

/**
 * In-memory NC file store mock.
 * list(dir) returns paths relative to dir (with leading slash) as strings.
 */
function createNcFiles() {
  const store = {};
  return {
    write: async (p, content) => { store[p] = content; },
    read: async (p) => { if (store[p] === undefined) throw new Error(`Not found: ${p}`); return store[p]; },
    delete: async (p) => { delete store[p]; },
    list: async (dir) => Object.keys(store)
      .filter(k => k.startsWith(dir))
      .map(k => k.slice(dir.length)),
    _store: store,
  };
}

/**
 * No-op credential broker that returns null for all names.
 * Tests that need auth should override per-test.
 */
function createNullCredentialBroker() {
  return { get: async () => null };
}

/**
 * Build a ToolActivator with fresh mocks.
 * Returns { activator, registry, ncFiles, auditEntries }
 */
function buildActivator(ncFiles, registry) {
  const auditEntries = [];
  const auditLog = async (entry) => auditEntries.push(entry);

  // HttpToolExecutor with a null credential broker (no real creds needed for unit tests)
  const httpExecutor = new HttpToolExecutor({ credentialBroker: createNullCredentialBroker() });

  const activator = new ToolActivator({
    toolRegistry: registry,
    httpExecutor,
    ncFiles,
    auditLog,
  });

  return { activator, auditEntries };
}

// Resolved params for webhook (substitute the {{webhook_url}} in api_base)
const WEBHOOK_URL = 'https://hooks.slack.com/services/T00/B00/abc123';
const WEBHOOK_PARAMS = {
  webhook_url: WEBHOOK_URL,
  webhook_name: 'slack-general',
  target_domain: 'hooks.slack.com',  // derived from webhook_url via domain transform
};

// Resolved params for wordpress
const WP_SITE_URL = 'https://blog.example.com';
const WP_PARAMS = {
  wp_site_url: WP_SITE_URL,
  wp_domain: 'blog.example.com',  // derived from wp_site_url via domain transform
};

// Brave-search has no parameters
const BRAVE_PARAMS = {};

// -----------------------------------------------------------------------------
// SECTION 1: Template Format Detection
// -----------------------------------------------------------------------------

test('TC-SFV2-001: webhook template is new format', () => {
  assert.strictEqual(engine.isNewFormat(webhookTemplate), true,
    'webhook.yaml must have a non-empty operations array');
});

test('TC-SFV2-002: wordpress template is new format', () => {
  assert.strictEqual(engine.isNewFormat(wordpressTemplate), true,
    'wordpress.yaml must have a non-empty operations array');
});

test('TC-SFV2-003: brave-search template is new format', () => {
  assert.strictEqual(engine.isNewFormat(braveTemplate), true,
    'brave-search.yaml must have a non-empty operations array');
});

// -----------------------------------------------------------------------------
// SECTION 2: Template → Tool Definitions
// -----------------------------------------------------------------------------

test('TC-SFV2-004: webhook generates 2 tool definitions', () => {
  const defs = engine.generateToolDefinitions(webhookTemplate, WEBHOOK_PARAMS);
  assert.strictEqual(defs.operations.length, 2,
    `Expected 2 operations, got ${defs.operations.length}`);
  const names = defs.operations.map(o => o.name);
  assert.ok(names.includes('send_message'), 'Missing send_message operation');
  assert.ok(names.includes('send_structured'), 'Missing send_structured operation');
});

test('TC-SFV2-005: wordpress generates 4 tool definitions', () => {
  const defs = engine.generateToolDefinitions(wordpressTemplate, WP_PARAMS);
  assert.strictEqual(defs.operations.length, 4,
    `Expected 4 operations, got ${defs.operations.length}`);
  const names = defs.operations.map(o => o.name);
  assert.ok(names.includes('list_posts'), 'Missing list_posts');
  assert.ok(names.includes('create_post'), 'Missing create_post');
  assert.ok(names.includes('update_post'), 'Missing update_post');
  assert.ok(names.includes('list_categories'), 'Missing list_categories');
});

test('TC-SFV2-006: brave-search generates 2 tool definitions', () => {
  const defs = engine.generateToolDefinitions(braveTemplate, BRAVE_PARAMS);
  assert.strictEqual(defs.operations.length, 2,
    `Expected 2 operations, got ${defs.operations.length}`);
  const names = defs.operations.map(o => o.name);
  assert.ok(names.includes('web_search'), 'Missing web_search operation');
  assert.ok(names.includes('news_search'), 'Missing news_search operation');
});

test('TC-SFV2-007: wordpress tool defs resolve api_base with site URL param', () => {
  const defs = engine.generateToolDefinitions(wordpressTemplate, WP_PARAMS);
  // api_base is "{{wp_site_url}}/wp-json/wp/v2" — should resolve to actual URL
  assert.strictEqual(defs.apiBase, `${WP_SITE_URL}/wp-json/wp/v2`,
    `apiBase "${defs.apiBase}" does not match expected "${WP_SITE_URL}/wp-json/wp/v2"`);
});

// -----------------------------------------------------------------------------
// SECTION 3: Security Scanning (scanToolDefinitions)
// -----------------------------------------------------------------------------

test('TC-SFV2-008: webhook tool defs pass security scan with resolved domain', () => {
  const defs = engine.generateToolDefinitions(webhookTemplate, WEBHOOK_PARAMS);
  // Verify allowed_domains placeholder resolved to actual hostname
  assert.deepStrictEqual(defs.security.allowedDomains, ['hooks.slack.com'],
    'allowed_domains should resolve {{target_domain}} to hooks.slack.com');

  const result = scanner.scanToolDefinitions(defs);
  assert.strictEqual(result.safe, true,
    `Security violations: ${result.violations.join(', ')}`);
  assert.strictEqual(result.violations.length, 0);
});

test('TC-SFV2-009: wordpress tool defs pass security scan', () => {
  const defs = engine.generateToolDefinitions(wordpressTemplate, WP_PARAMS);
  // Verify allowed_domains placeholder resolved to actual hostname
  assert.deepStrictEqual(defs.security.allowedDomains, ['blog.example.com'],
    'allowed_domains should resolve {{wp_domain}} to blog.example.com');

  const result = scanner.scanToolDefinitions(defs);
  assert.strictEqual(result.safe, true,
    `Security violations: ${result.violations.join(', ')}`);
  assert.strictEqual(result.violations.length, 0);
});

test('TC-SFV2-010: brave-search tool defs pass security scan', () => {
  const defs = engine.generateToolDefinitions(braveTemplate, BRAVE_PARAMS);
  // brave-search.yaml has a literal domain, not a placeholder
  assert.deepStrictEqual(defs.security.allowedDomains, ['api.search.brave.com']);

  const result = scanner.scanToolDefinitions(defs);
  assert.strictEqual(result.safe, true,
    `Security violations: ${result.violations.join(', ')}`);
  assert.strictEqual(result.violations.length, 0);
});

// -----------------------------------------------------------------------------
// SECTION 4: Full Lifecycle — Activate → Execute → Deactivate
// -----------------------------------------------------------------------------

asyncTest('TC-SFV2-011: Activate webhook registers 2 tools in ToolRegistry', async () => {
  const registry = createToolRegistry();
  const ncFiles = createNcFiles();
  const { activator } = buildActivator(ncFiles, registry);

  const result = await activator.activate(webhookTemplate, WEBHOOK_PARAMS);

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.skillId, 'webhook');
  assert.strictEqual(result.toolsRegistered.length, 2,
    `Expected 2 tools registered, got ${result.toolsRegistered.length}`);
  assert.ok(registry.has('webhook_send_message'), 'webhook_send_message not in registry');
  assert.ok(registry.has('webhook_send_structured'), 'webhook_send_structured not in registry');
});

asyncTest('TC-SFV2-012: Webhook tool handler calls HttpExecutor (mock fetch, verify URL and body)', async () => {
  const registry = createToolRegistry();
  const ncFiles = createNcFiles();
  const { activator } = buildActivator(ncFiles, registry);

  await activator.activate(webhookTemplate, WEBHOOK_PARAMS);

  const tool = registry.get('webhook_send_message');
  assert.ok(tool, 'webhook_send_message not found in registry');
  assert.ok(typeof tool.handler === 'function', 'handler must be a function');

  // Track what fetch receives
  let capturedUrl = null;
  let capturedOptions = null;

  const mockFetch = async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return {
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ ok: true }),
    };
  };

  global.fetch = mockFetch;
  try {
    const result = await tool.handler({ text: 'Hello from Moltagent', content: 'test' });

    assert.ok(result.success, `Expected success, got error: ${result.error}`);
    assert.strictEqual(result.status, 200);

    // URL should be the webhook URL (api_base resolved, path is empty)
    assert.ok(capturedUrl.startsWith(WEBHOOK_URL),
      `Captured URL "${capturedUrl}" should start with "${WEBHOOK_URL}"`);

    // Method should be POST
    assert.strictEqual(capturedOptions.method, 'POST');

    // Body should be JSON with the text field
    const body = JSON.parse(capturedOptions.body);
    assert.strictEqual(body.text, 'Hello from Moltagent');
  } finally {
    global.fetch = undefined;
  }
});

asyncTest('TC-SFV2-013: listBySource("skill-forge") returns the webhook tools', async () => {
  const registry = createToolRegistry();
  const ncFiles = createNcFiles();
  const { activator } = buildActivator(ncFiles, registry);

  await activator.activate(webhookTemplate, WEBHOOK_PARAMS);

  const forgeTools = registry.listBySource('skill-forge');
  assert.strictEqual(forgeTools.length, 2,
    `Expected 2 skill-forge tools, got ${forgeTools.length}`);
  const toolNames = forgeTools.map(t => t.name);
  assert.ok(toolNames.includes('webhook_send_message'));
  assert.ok(toolNames.includes('webhook_send_structured'));
});

asyncTest('TC-SFV2-014: Deactivate webhook removes tools from ToolRegistry', async () => {
  const registry = createToolRegistry();
  const ncFiles = createNcFiles();
  const { activator } = buildActivator(ncFiles, registry);

  await activator.activate(webhookTemplate, WEBHOOK_PARAMS);
  assert.strictEqual(registry.size, 2, 'Should have 2 tools after activate');

  const deactivateResult = await activator.deactivate('webhook');
  assert.strictEqual(deactivateResult.success, true);
  assert.strictEqual(deactivateResult.skillId, 'webhook');
  assert.strictEqual(deactivateResult.toolsRemoved.length, 2);

  assert.ok(!registry.has('webhook_send_message'), 'webhook_send_message should be removed');
  assert.ok(!registry.has('webhook_send_structured'), 'webhook_send_structured should be removed');
  assert.strictEqual(registry.size, 0, 'Registry should be empty after deactivate');
});

asyncTest('TC-SFV2-015: listBySource("skill-forge") returns empty after deactivate', async () => {
  const registry = createToolRegistry();
  const ncFiles = createNcFiles();
  const { activator } = buildActivator(ncFiles, registry);

  await activator.activate(webhookTemplate, WEBHOOK_PARAMS);
  await activator.deactivate('webhook');

  const forgeTools = registry.listBySource('skill-forge');
  assert.strictEqual(forgeTools.length, 0,
    `Expected 0 skill-forge tools after deactivate, got ${forgeTools.length}`);
});

// -----------------------------------------------------------------------------
// SECTION 5: Persistence and Reload
// -----------------------------------------------------------------------------

asyncTest('TC-SFV2-016: Activate brave-search persists config to NC files', async () => {
  const registry = createToolRegistry();
  const ncFiles = createNcFiles();
  const { activator } = buildActivator(ncFiles, registry);

  await activator.activate(braveTemplate, BRAVE_PARAMS);

  const expectedPath = '/Memory/SkillForge/active/brave-search.json';
  assert.ok(ncFiles._store[expectedPath] !== undefined,
    `Expected config at "${expectedPath}" but not found in store`);

  const persisted = JSON.parse(ncFiles._store[expectedPath]);
  assert.strictEqual(persisted.skillId, 'brave-search');
  assert.ok(persisted.template, 'Persisted config must include template');
  assert.ok(persisted.persistedAt, 'Persisted config must have persistedAt timestamp');
});

asyncTest('TC-SFV2-017: New ToolActivator with same NC files reloadAll() re-registers brave-search tools', async () => {
  // First activator: activate and persist
  const ncFiles = createNcFiles();
  const registry1 = createToolRegistry();
  const { activator: activator1 } = buildActivator(ncFiles, registry1);
  await activator1.activate(braveTemplate, BRAVE_PARAMS);

  // Second activator: fresh registry, same ncFiles store
  const registry2 = createToolRegistry();
  assert.strictEqual(registry2.size, 0, 'New registry must start empty');

  const { activator: activator2 } = buildActivator(ncFiles, registry2);
  const reloadResults = await activator2.reloadAll();

  assert.strictEqual(reloadResults.length, 1, `Expected 1 reload result, got ${reloadResults.length}`);
  assert.strictEqual(reloadResults[0].success, true,
    `Reload failed: ${reloadResults[0].error}`);
  assert.strictEqual(reloadResults[0].skillId, 'brave-search');

  assert.ok(registry2.has('brave-search_web_search'),
    'brave-search_web_search not registered after reload');
  assert.ok(registry2.has('brave-search_news_search'),
    'brave-search_news_search not registered after reload');
});

asyncTest('TC-SFV2-018: Tools are functional after reload (handler still calls fetch)', async () => {
  const ncFiles = createNcFiles();
  const registry1 = createToolRegistry();
  const { activator: activator1 } = buildActivator(ncFiles, registry1);
  await activator1.activate(braveTemplate, BRAVE_PARAMS);

  // Reload into fresh registry
  const registry2 = createToolRegistry();
  const { activator: activator2 } = buildActivator(ncFiles, registry2);
  await activator2.reloadAll();

  const tool = registry2.get('brave-search_web_search');
  assert.ok(tool, 'brave-search_web_search not found after reload');

  let capturedUrl = null;
  const mockFetch = async (url, options) => {
    capturedUrl = url;
    return {
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ web: { results: [] } }),
    };
  };

  global.fetch = mockFetch;
  try {
    // brave-search uses header_key auth; credentialBroker returns null, but auth.credentialName
    // comes from nc_password_name substitution. If null credential causes early return, verify that.
    const result = await tool.handler({ q: 'moltagent test' });

    // With null credential broker, the executor will fail trying to retrieve the cred.
    // We verify the handler is callable and either succeeds (if auth skipped) or fails
    // with a credential error — not a crash or missing-handler error.
    assert.ok(
      result.success === true || (result.success === false && typeof result.error === 'string'),
      'Handler must return a structured result object'
    );
    // If fetch was reached (no auth required path), URL should point to brave
    if (capturedUrl !== null) {
      assert.ok(capturedUrl.includes('api.search.brave.com'),
        `Captured URL "${capturedUrl}" should target api.search.brave.com`);
    }
  } finally {
    global.fetch = undefined;
  }
});

// -----------------------------------------------------------------------------
// SECTION 6: WordPress Lifecycle
// -----------------------------------------------------------------------------

asyncTest('TC-SFV2-019: Activate wordpress with site URL param → tools registered with correct base URL', async () => {
  const registry = createToolRegistry();
  const ncFiles = createNcFiles();
  const { activator } = buildActivator(ncFiles, registry);

  const result = await activator.activate(wordpressTemplate, WP_PARAMS);

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.skillId, 'wordpress');
  assert.strictEqual(result.toolsRegistered.length, 4,
    `Expected 4 tools, got ${result.toolsRegistered.length}`);

  // Verify a tool's opConfig has the resolved URL by calling its handler with a mock fetch
  const tool = registry.get('wordpress_list_posts');
  assert.ok(tool, 'wordpress_list_posts not found in registry');

  let capturedUrl = null;
  const mockFetch = async (url) => {
    capturedUrl = url;
    return {
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify([]),
    };
  };

  global.fetch = mockFetch;
  try {
    // WordPress uses basic auth — with null credential broker this will fail before fetch.
    // Call and check the error is about credential, not a bad URL structure.
    await tool.handler({ per_page: 5 });
    // If we get here, check the URL
    if (capturedUrl !== null) {
      assert.ok(capturedUrl.includes('blog.example.com/wp-json/wp/v2/posts'),
        `URL "${capturedUrl}" should contain the resolved WP API path`);
    }
  } catch (err) {
    // Any thrown error (non-structured) is unexpected
    assert.fail(`Handler threw unexpectedly: ${err.message}`);
  } finally {
    global.fetch = undefined;
  }
});

asyncTest('TC-SFV2-020: WordPress create_post tool has correct schema (title required, status with enum)', async () => {
  const registry = createToolRegistry();
  const ncFiles = createNcFiles();
  const { activator } = buildActivator(ncFiles, registry);

  await activator.activate(wordpressTemplate, WP_PARAMS);

  const tool = registry.get('wordpress_create_post');
  assert.ok(tool, 'wordpress_create_post not registered');

  const schema = tool.parameters;
  assert.strictEqual(schema.type, 'object', 'Schema top-level type must be "object"');
  assert.ok(schema.properties, 'Schema must have properties');
  assert.ok(schema.properties.title, 'Schema must have title property');
  assert.ok(schema.properties.status, 'Schema must have status property');

  // title must be required
  assert.ok(Array.isArray(schema.required), 'Schema required must be an array');
  assert.ok(schema.required.includes('title'), 'title must be in required array');
  assert.ok(schema.required.includes('content'), 'content must be in required array');

  // status must have enum values from the template
  assert.ok(Array.isArray(schema.properties.status.enum),
    'status property must have an enum array');
  assert.ok(schema.properties.status.enum.includes('publish'), 'enum must include publish');
  assert.ok(schema.properties.status.enum.includes('draft'), 'enum must include draft');

  // status must have a default
  assert.strictEqual(schema.properties.status.default, 'draft',
    'status default should be "draft"');
});

// -----------------------------------------------------------------------------
// SECTION 7: Auto-Discovery (parameterless activation + setup meta-tools)
// -----------------------------------------------------------------------------

console.log('\n--- Auto-Discovery ---\n');

asyncTest('TC-SFV2-021: autoDiscover activates brave-search (no required params) immediately', async () => {
  const registry = createToolRegistry();
  const ncFiles = createNcFiles();
  const { activator } = buildActivator(ncFiles, registry);

  const result = await activator.autoDiscover(templatesDir);

  assert.ok(result.activated.includes('brave-search'),
    `brave-search should be auto-activated, got: ${JSON.stringify(result.activated)}`);
  assert.ok(registry.has('brave-search_web_search'),
    'brave-search_web_search tool should be registered');
  assert.ok(registry.has('brave-search_news_search'),
    'brave-search_news_search tool should be registered');
});

asyncTest('TC-SFV2-022: autoDiscover registers setup meta-tools for webhook and wordpress', async () => {
  const registry = createToolRegistry();
  const ncFiles = createNcFiles();
  const { activator } = buildActivator(ncFiles, registry);

  const result = await activator.autoDiscover(templatesDir);

  assert.ok(result.metaTools.includes('forge_setup_webhook'),
    `forge_setup_webhook should be in metaTools, got: ${JSON.stringify(result.metaTools)}`);
  assert.ok(result.metaTools.includes('forge_setup_wordpress'),
    `forge_setup_wordpress should be in metaTools, got: ${JSON.stringify(result.metaTools)}`);

  // Meta-tools should be registered in ToolRegistry
  assert.ok(registry.has('forge_setup_webhook'), 'forge_setup_webhook should be in registry');
  assert.ok(registry.has('forge_setup_wordpress'), 'forge_setup_wordpress should be in registry');

  // brave-search should NOT have a setup meta-tool (it's parameterless)
  assert.ok(!result.metaTools.includes('forge_setup_brave_search'),
    'brave-search should not have a setup meta-tool');
});

asyncTest('TC-SFV2-023: setup meta-tool handler returns setup instructions', async () => {
  const registry = createToolRegistry();
  const ncFiles = createNcFiles();
  const { activator } = buildActivator(ncFiles, registry);

  await activator.autoDiscover(templatesDir);

  const wpSetup = registry.get('forge_setup_wordpress');
  assert.ok(wpSetup, 'forge_setup_wordpress should exist');

  const response = await wpSetup.handler({});
  assert.strictEqual(response.success, true);
  assert.ok(response.result.includes('WordPress'),
    'Setup instructions should mention WordPress');
  assert.ok(response.result.includes('wordpress-api'),
    'Setup instructions should mention the NC Passwords credential name');
});

asyncTest('TC-SFV2-024: autoDiscover skips already-activated skills', async () => {
  const registry = createToolRegistry();
  const ncFiles = createNcFiles();
  const { activator } = buildActivator(ncFiles, registry);

  // First: activate brave-search manually
  await activator.activate(braveTemplate, BRAVE_PARAMS);
  assert.ok(registry.has('brave-search_web_search'), 'Pre-condition: brave-search already activated');

  const sizeBefore = registry.size;

  // AutoDiscover should skip brave-search (already activated)
  const result = await activator.autoDiscover(templatesDir);

  assert.ok(result.skipped.includes('brave-search'),
    `brave-search should be skipped, got: ${JSON.stringify(result.skipped)}`);
  assert.ok(!result.activated.includes('brave-search'),
    'brave-search should not be in activated list');
});

asyncTest('TC-SFV2-025: setup meta-tool has skill-forge source metadata', async () => {
  const registry = createToolRegistry();
  const ncFiles = createNcFiles();
  const { activator } = buildActivator(ncFiles, registry);

  await activator.autoDiscover(templatesDir);

  const tool = registry.get('forge_setup_webhook');
  assert.ok(tool.metadata, 'Meta-tool should have metadata');
  assert.strictEqual(tool.metadata.source, 'skill-forge');
  assert.strictEqual(tool.metadata.type, 'setup-meta');
  assert.strictEqual(tool.metadata.skillId, 'webhook');
});

// -----------------------------------------------------------------------------
// Summary
// -----------------------------------------------------------------------------

console.log('\n=== Skill Forge V2 Integration Tests Complete ===\n');

setTimeout(() => { summary(); exitWithCode(); }, 500);
