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
 * Unit Tests for TemplateEngine — isNewFormat() and generateToolDefinitions()
 *
 * Tests the structured-operations (new-format) API added to TemplateEngine:
 * - isNewFormat(): detection of new vs old template format
 * - generateToolDefinitions(): structured output from operations-array templates,
 *   including placeholder resolution, auth mapping, security mapping,
 *   parameter type/required/enum/default handling, and method normalisation.
 *
 * @module test/unit/skill-forge/template-engine-v2.test.js
 */

'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const { TemplateEngine } = require('../../../src/skill-forge/template-engine');

console.log('\n=== TemplateEngine v2 Tests (isNewFormat + generateToolDefinitions) ===\n');

// -----------------------------------------------------------------------------
// Test Fixtures
// -----------------------------------------------------------------------------

const newFormatTemplate = {
  skill_id: 'test-api',
  display_name: 'Test API',
  api_base: 'https://{{host}}/api/v1',
  auth: { type: 'bearer', header_name: null },
  credentials: [{ nc_password_name: '{{service}}-api-key' }],
  security: { allowed_domains: ['api.example.com'] },
  operations: [
    {
      name: 'get_thing',
      method: 'get',
      path: '/things/{{thing_id}}',
      description: 'Get a thing by ID',
      parameters: [
        { name: 'thing_id', type: 'string', required: true, description: 'Thing ID' },
      ],
      response_hint: 'Returns a thing object',
    },
    {
      name: 'create_thing',
      method: 'POST',
      path: '/things',
      description: 'Create a thing',
      body_type: 'json',
      parameters: [
        { name: 'name', type: 'string', required: true, description: 'Thing name' },
        { name: 'priority', type: 'string', required: false, description: 'Priority', enum: ['low', 'medium', 'high'], default: 'medium' },
      ],
    },
  ],
};

const oldFormatTemplate = {
  skill_id: 'old-skill',
  display_name: 'Old Skill',
  skill_template: '---\nname: old-skill\n---\n# Old',
  security: { allowed_domains: ['example.com'] },
};

// Resolved params used with newFormatTemplate
const resolvedParams = {
  host: 'api.example.com',
  service: 'myservice',
  thing_id: '42',
};

// -----------------------------------------------------------------------------
// isNewFormat() tests
// -----------------------------------------------------------------------------

test('TC-TEV2-001: isNewFormat() returns true for template with operations array', () => {
  const engine = new TemplateEngine();
  assert.strictEqual(engine.isNewFormat(newFormatTemplate), true);
});

test('TC-TEV2-002: isNewFormat() returns false for template with skill_template only', () => {
  const engine = new TemplateEngine();
  assert.strictEqual(engine.isNewFormat(oldFormatTemplate), false);
});

test('TC-TEV2-003: isNewFormat() returns false for null template', () => {
  const engine = new TemplateEngine();
  assert.strictEqual(engine.isNewFormat(null), false);
});

test('TC-TEV2-004: isNewFormat() returns false for undefined template', () => {
  const engine = new TemplateEngine();
  assert.strictEqual(engine.isNewFormat(undefined), false);
});

test('TC-TEV2-005: isNewFormat() returns false for empty operations array', () => {
  const engine = new TemplateEngine();
  const emptyOps = { skill_id: 'x', operations: [] };
  assert.strictEqual(engine.isNewFormat(emptyOps), false);
});

// -----------------------------------------------------------------------------
// generateToolDefinitions() — error handling
// -----------------------------------------------------------------------------

test('TC-TEV2-006: generateToolDefinitions() throws for old-format template', () => {
  const engine = new TemplateEngine();
  assert.throws(
    () => engine.generateToolDefinitions(oldFormatTemplate, {}),
    /assemble/i
  );
});

// -----------------------------------------------------------------------------
// generateToolDefinitions() — top-level fields
// -----------------------------------------------------------------------------

test('TC-TEV2-007: generateToolDefinitions() returns correct skillId', () => {
  const engine = new TemplateEngine();
  const result = engine.generateToolDefinitions(newFormatTemplate, resolvedParams);
  assert.strictEqual(result.skillId, 'test-api');
});

test('TC-TEV2-008: generateToolDefinitions() returns correct displayName', () => {
  const engine = new TemplateEngine();
  const result = engine.generateToolDefinitions(newFormatTemplate, resolvedParams);
  assert.strictEqual(result.displayName, 'Test API');
});

// -----------------------------------------------------------------------------
// generateToolDefinitions() — placeholder resolution
// -----------------------------------------------------------------------------

test('TC-TEV2-009: generateToolDefinitions() resolves {{placeholder}} in api_base', () => {
  const engine = new TemplateEngine();
  const result = engine.generateToolDefinitions(newFormatTemplate, resolvedParams);
  assert.strictEqual(result.apiBase, 'https://api.example.com/api/v1');
});

test('TC-TEV2-010: generateToolDefinitions() resolves {{placeholder}} in operation paths', () => {
  const engine = new TemplateEngine();
  const result = engine.generateToolDefinitions(newFormatTemplate, resolvedParams);
  const getOp = result.operations.find(o => o.name === 'get_thing');
  assert.ok(getOp, 'get_thing operation must exist');
  assert.strictEqual(getOp.path, '/things/42');
});

// -----------------------------------------------------------------------------
// generateToolDefinitions() — auth mapping
// -----------------------------------------------------------------------------

test('TC-TEV2-011: generateToolDefinitions() maps auth config correctly', () => {
  const engine = new TemplateEngine();
  const result = engine.generateToolDefinitions(newFormatTemplate, resolvedParams);
  assert.strictEqual(result.auth.type, 'bearer');
  assert.strictEqual(result.auth.headerName, null);
  // credentialName has {{service}} resolved to 'myservice'
  assert.strictEqual(result.auth.credentialName, 'myservice-api-key');
});

// -----------------------------------------------------------------------------
// generateToolDefinitions() — security mapping
// -----------------------------------------------------------------------------

test('TC-TEV2-012: generateToolDefinitions() maps security.allowedDomains correctly', () => {
  const engine = new TemplateEngine();
  const result = engine.generateToolDefinitions(newFormatTemplate, resolvedParams);
  assert.deepStrictEqual(result.security.allowedDomains, ['api.example.com']);
});

// -----------------------------------------------------------------------------
// generateToolDefinitions() — parameter mapping
// -----------------------------------------------------------------------------

test('TC-TEV2-013: generateToolDefinitions() maps operation parameters with types and required flags', () => {
  const engine = new TemplateEngine();
  const result = engine.generateToolDefinitions(newFormatTemplate, resolvedParams);
  const createOp = result.operations.find(o => o.name === 'create_thing');
  assert.ok(createOp, 'create_thing operation must exist');

  const nameParam = createOp.parameters.find(p => p.name === 'name');
  assert.ok(nameParam, 'name parameter must exist');
  assert.strictEqual(nameParam.type, 'string');
  assert.strictEqual(nameParam.required, true);

  const priorityParam = createOp.parameters.find(p => p.name === 'priority');
  assert.ok(priorityParam, 'priority parameter must exist');
  assert.strictEqual(priorityParam.required, false);
});

test('TC-TEV2-014: generateToolDefinitions() includes enum in parameters when present', () => {
  const engine = new TemplateEngine();
  const result = engine.generateToolDefinitions(newFormatTemplate, resolvedParams);
  const createOp = result.operations.find(o => o.name === 'create_thing');
  const priorityParam = createOp.parameters.find(p => p.name === 'priority');
  assert.deepStrictEqual(priorityParam.enum, ['low', 'medium', 'high']);
});

test('TC-TEV2-015: generateToolDefinitions() includes default in parameters when present', () => {
  const engine = new TemplateEngine();
  const result = engine.generateToolDefinitions(newFormatTemplate, resolvedParams);
  const createOp = result.operations.find(o => o.name === 'create_thing');
  const priorityParam = createOp.parameters.find(p => p.name === 'priority');
  assert.strictEqual(priorityParam.default, 'medium');
});

test('TC-TEV2-016: generateToolDefinitions() normalizes method to uppercase', () => {
  const engine = new TemplateEngine();
  const result = engine.generateToolDefinitions(newFormatTemplate, resolvedParams);
  // get_thing has method 'get' (lowercase in fixture) — must be uppercased
  const getOp = result.operations.find(o => o.name === 'get_thing');
  assert.strictEqual(getOp.method, 'GET');
  // create_thing already has 'POST' — must stay uppercase
  const createOp = result.operations.find(o => o.name === 'create_thing');
  assert.strictEqual(createOp.method, 'POST');
});

// -----------------------------------------------------------------------------
// Additional edge-case coverage
// -----------------------------------------------------------------------------

test('TC-TEV2-017: generateToolDefinitions() does not include enum key when param has no enum', () => {
  const engine = new TemplateEngine();
  const result = engine.generateToolDefinitions(newFormatTemplate, resolvedParams);
  const getOp = result.operations.find(o => o.name === 'get_thing');
  const thingIdParam = getOp.parameters.find(p => p.name === 'thing_id');
  assert.strictEqual('enum' in thingIdParam, false);
});

test('TC-TEV2-018: generateToolDefinitions() does not include default key when param has no default', () => {
  const engine = new TemplateEngine();
  const result = engine.generateToolDefinitions(newFormatTemplate, resolvedParams);
  const getOp = result.operations.find(o => o.name === 'get_thing');
  const thingIdParam = getOp.parameters.find(p => p.name === 'thing_id');
  assert.strictEqual('default' in thingIdParam, false);
});

// -----------------------------------------------------------------------------
// Summary
// -----------------------------------------------------------------------------

console.log('\n=== TemplateEngine v2 Tests Complete ===\n');

setTimeout(() => { summary(); exitWithCode(); }, 500);
