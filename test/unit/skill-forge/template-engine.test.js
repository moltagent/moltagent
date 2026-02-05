/*
 * MoltAgent - Sovereign AI Security Layer
 * Copyright (C) 2026 MoltAgent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * Unit Tests for TemplateEngine Module
 *
 * Tests SKILL.md assembly from templates and parameters:
 * - Constructor configuration
 * - Parameter validation (required, optional, patterns, types)
 * - Slug generation
 * - Shell value escaping
 * - Placeholder substitution
 * - Full template assembly
 * - Edge cases and error handling
 *
 * @module test/unit/skill-forge/template-engine.test.js
 */

'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const { TemplateEngine } = require('../../../src/skill-forge/template-engine');

console.log('\n=== TemplateEngine Tests ===\n');

// -----------------------------------------------------------------------------
// Test Fixtures
// -----------------------------------------------------------------------------

/**
 * Minimal valid template for testing.
 * Mirrors the structure from real templates (e.g., trello.yaml in spec).
 */
const MINIMAL_TEMPLATE = {
  skill_id: 'test-skill',
  display_name: 'Test Skill',
  description: 'A test skill for unit testing',
  version: '1.0',
  requires: { bins: ['curl'] },
  security: {
    allowed_domains: ['api.example.com'],
    forbidden_patterns: [],
  },
  parameters: [
    {
      id: 'board_name',
      label: 'Board name',
      ask: 'What board?',
      type: 'text',
      required: true,
      example: 'Project Phoenix',
    },
    {
      id: 'board_id',
      label: 'Board ID',
      ask: 'What ID?',
      type: 'text',
      required: true,
      validation_pattern: '^[a-zA-Z0-9]{8}$',
    },
    {
      id: 'enable_notifications',
      label: 'Enable notifications',
      ask: 'Notifications?',
      type: 'boolean',
      required: false,
      default: false,
    },
  ],
  skill_template: [
    '---',
    'name: test-{{board_name_slug}}',
    'description: Manage {{board_name}}',
    'metadata: {"openclaw":{"emoji":"T","requires":{"bins":["curl"]}}}',
    '---',
    '# {{board_name}}',
    '',
    'Board ID: {{board_id}}',
    'Generated: {{date}}',
    'Forge: {{forge_version}}',
    'NC: {{nc_url}}',
  ].join('\n'),
};

/**
 * Template with select parameter.
 */
const SELECT_TEMPLATE = {
  skill_id: 'select-test',
  display_name: 'Select Test',
  description: 'Tests select parameters',
  version: '1.0',
  requires: { bins: ['curl'] },
  security: { allowed_domains: ['api.example.com'] },
  parameters: [
    {
      id: 'auth_method',
      label: 'Auth method',
      ask: 'How to auth?',
      type: 'select',
      required: true,
      options: [
        { value: 'header_key', label: 'API Key in header' },
        { value: 'bearer', label: 'Bearer token' },
        { value: 'none', label: 'No authentication' },
      ],
    },
  ],
  skill_template: 'Auth: {{auth_method}}',
};

// -----------------------------------------------------------------------------
// Constructor Tests
// -----------------------------------------------------------------------------

test('TC-TE-001: Constructor creates instance with default settings', () => {
  const engine = new TemplateEngine();
  assert.ok(engine instanceof TemplateEngine);
  assert.strictEqual(engine.ncUrl, '');
  assert.strictEqual(engine.ncUser, 'moltagent');
});

test('TC-TE-002: Constructor accepts custom ncUrl and ncUser', () => {
  const engine = new TemplateEngine({ ncUrl: 'https://nc.example.com/', ncUser: 'testuser' });
  assert.strictEqual(engine.ncUrl, 'https://nc.example.com');
  assert.strictEqual(engine.ncUser, 'testuser');
});

// -----------------------------------------------------------------------------
// Parameter Validation Tests
// -----------------------------------------------------------------------------

test('TC-TE-010: validateParameters accepts all required params present', () => {
  const engine = new TemplateEngine();
  const result = engine.validateParameters(MINIMAL_TEMPLATE, {
    board_name: 'Project Phoenix',
    board_id: 'a1B2c3D4',
  });
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.errors.length, 0);
});

test('TC-TE-011: validateParameters rejects missing required param', () => {
  const engine = new TemplateEngine();
  const result = engine.validateParameters(MINIMAL_TEMPLATE, {
    board_name: 'Project Phoenix',
  });
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('board_id')));
});

test('TC-TE-012: validateParameters applies default for optional param', () => {
  const engine = new TemplateEngine();
  const result = engine.validateParameters(MINIMAL_TEMPLATE, {
    board_name: 'Project Phoenix',
    board_id: 'a1B2c3D4',
  });
  assert.strictEqual(result.valid, true);
});

test('TC-TE-013: validateParameters rejects value failing validation_pattern', () => {
  const engine = new TemplateEngine();
  const result = engine.validateParameters(MINIMAL_TEMPLATE, {
    board_name: 'Project Phoenix',
    board_id: 'invalid!!',
  });
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('board_id') && e.includes('pattern')));
});

test('TC-TE-014: validateParameters rejects invalid select value', () => {
  const engine = new TemplateEngine();
  const result = engine.validateParameters(SELECT_TEMPLATE, {
    auth_method: 'invalid_choice',
  });
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('auth_method')));
});

test('TC-TE-015: validateParameters coerces string "true"/"false" to boolean', () => {
  const engine = new TemplateEngine();
  const result = engine.validateParameters(MINIMAL_TEMPLATE, {
    board_name: 'Test',
    board_id: 'a1B2c3D4',
    enable_notifications: 'true',
  });
  assert.strictEqual(result.valid, true);
  assert.ok(result.warnings.some(w => w.includes('boolean')));
});

// -----------------------------------------------------------------------------
// Slug Generation Tests
// -----------------------------------------------------------------------------

test('TC-TE-020: generateSlug converts "Project Phoenix" to "project-phoenix"', () => {
  const engine = new TemplateEngine();
  assert.strictEqual(engine.generateSlug('Project Phoenix'), 'project-phoenix');
});

test('TC-TE-021: generateSlug handles special characters', () => {
  const engine = new TemplateEngine();
  assert.strictEqual(engine.generateSlug('My App (v2.0)'), 'my-app-v2-0');
});

test('TC-TE-022: generateSlug collapses multiple hyphens', () => {
  const engine = new TemplateEngine();
  assert.strictEqual(engine.generateSlug('hello   world---test'), 'hello-world-test');
});

test('TC-TE-023: generateSlug trims leading/trailing hyphens', () => {
  const engine = new TemplateEngine();
  assert.strictEqual(engine.generateSlug('---hello---'), 'hello');
});

test('TC-TE-024: generateSlug truncates at 50 characters', () => {
  const engine = new TemplateEngine();
  const longInput = 'a'.repeat(100);
  const slug = engine.generateSlug(longInput);
  assert.ok(slug.length <= 50);
});

test('TC-TE-025: generateSlug handles empty string', () => {
  const engine = new TemplateEngine();
  assert.strictEqual(engine.generateSlug(''), '');
});

// -----------------------------------------------------------------------------
// Shell Escaping Tests
// -----------------------------------------------------------------------------

test('TC-TE-030: escapeShellValue removes backticks', () => {
  const engine = new TemplateEngine();
  assert.ok(!engine.escapeShellValue('hello `whoami` world').includes('`'));
});

test('TC-TE-031: escapeShellValue removes $() command substitution', () => {
  const engine = new TemplateEngine();
  const result = engine.escapeShellValue('hello $(rm -rf /) world');
  assert.ok(!result.includes('$('));
});

test('TC-TE-032: escapeShellValue removes semicolons', () => {
  const engine = new TemplateEngine();
  assert.ok(!engine.escapeShellValue('cmd; evil').includes(';'));
});

test('TC-TE-033: escapeShellValue removes pipe characters', () => {
  const engine = new TemplateEngine();
  assert.ok(!engine.escapeShellValue('cmd | evil').includes('|'));
});

test('TC-TE-034: escapeShellValue removes redirect operators', () => {
  const engine = new TemplateEngine();
  const result = engine.escapeShellValue('data > /etc/passwd');
  assert.ok(!result.includes('>'));
});

test('TC-TE-035: escapeShellValue preserves safe alphanumeric content', () => {
  const engine = new TemplateEngine();
  assert.strictEqual(engine.escapeShellValue('Hello-World_123'), 'Hello-World_123');
});

test('TC-TE-036: escapeShellValue handles null/undefined gracefully', () => {
  const engine = new TemplateEngine();
  assert.strictEqual(engine.escapeShellValue(null), '');
  assert.strictEqual(engine.escapeShellValue(undefined), '');
});

// -----------------------------------------------------------------------------
// Placeholder Substitution Tests
// -----------------------------------------------------------------------------

test('TC-TE-040: _substitute replaces single placeholder', () => {
  const engine = new TemplateEngine();
  const result = engine._substitute('Hello {{name}}!', { name: 'World' });
  assert.strictEqual(result, 'Hello World!');
});

test('TC-TE-041: _substitute replaces multiple different placeholders', () => {
  const engine = new TemplateEngine();
  const result = engine._substitute('{{first}} and {{second}}', { first: 'A', second: 'B' });
  assert.strictEqual(result, 'A and B');
});

test('TC-TE-042: _substitute replaces same placeholder multiple times', () => {
  const engine = new TemplateEngine();
  const result = engine._substitute('{{x}} + {{x}} = 2{{x}}', { x: '5' });
  assert.strictEqual(result, '5 + 5 = 25');
});

test('TC-TE-043: _substitute leaves unknown placeholders intact', () => {
  const engine = new TemplateEngine();
  const result = engine._substitute('{{known}} and {{unknown}}', { known: 'yes' });
  assert.strictEqual(result, 'yes and {{unknown}}');
});

// -----------------------------------------------------------------------------
// Full Assembly Tests
// -----------------------------------------------------------------------------

test('TC-TE-050: assemble produces valid SKILL.md from template + params', () => {
  const engine = new TemplateEngine({ ncUrl: 'https://nc.example.com' });
  const result = engine.assemble(MINIMAL_TEMPLATE, {
    board_name: 'Project Phoenix',
    board_id: 'a1B2c3D4',
  });
  assert.ok(result.content.includes('Project Phoenix'));
  assert.ok(result.content.includes('a1B2c3D4'));
  assert.ok(result.content.includes('name: test-project-phoenix'));
});

test('TC-TE-051: assemble includes system variables (nc_url, date, forge_version)', () => {
  const engine = new TemplateEngine({ ncUrl: 'https://nc.test.com', ncUser: 'testbot' });
  const result = engine.assemble(MINIMAL_TEMPLATE, {
    board_name: 'Test',
    board_id: 'abcdefgh',
  });
  assert.ok(result.content.includes('https://nc.test.com'));
  assert.ok(result.content.includes('1.0.0'));
  const today = new Date().toISOString().split('T')[0];
  assert.ok(result.content.includes(today));
});

test('TC-TE-052: assemble generates _slug variants for all params', () => {
  const engine = new TemplateEngine();
  const result = engine.assemble(MINIMAL_TEMPLATE, {
    board_name: 'My Great Board',
    board_id: 'abcdefgh',
  });
  assert.ok(result.content.includes('test-my-great-board'));
});

test('TC-TE-053: assemble throws on missing required parameter', () => {
  const engine = new TemplateEngine();
  assert.throws(() => {
    engine.assemble(MINIMAL_TEMPLATE, { board_name: 'Test' });
  }, /missing|required/i);
});

test('TC-TE-054: assemble returns metadata with generation timestamp', () => {
  const engine = new TemplateEngine();
  const result = engine.assemble(MINIMAL_TEMPLATE, {
    board_name: 'Test',
    board_id: 'abcdefgh',
  });
  assert.ok(result.metadata);
  assert.ok(result.metadata.generated_at);
  assert.strictEqual(result.metadata.template_id, 'test-skill');
});

// -----------------------------------------------------------------------------
// Edge Cases
// -----------------------------------------------------------------------------

test('TC-TE-060: assemble handles template with no parameters', () => {
  const engine = new TemplateEngine();
  const noParamTemplate = {
    ...MINIMAL_TEMPLATE,
    parameters: [],
    skill_template: '---\nname: static-skill\n---\n# Static',
  };
  const result = engine.assemble(noParamTemplate, {});
  assert.ok(result.content.includes('static-skill'));
});

test('TC-TE-061: assemble handles template with boolean parameter', () => {
  const engine = new TemplateEngine();
  const result = engine.assemble(MINIMAL_TEMPLATE, {
    board_name: 'Test',
    board_id: 'abcdefgh',
    enable_notifications: true,
  });
  assert.ok(result.content);
});

test('TC-TE-062: assemble shell-escapes parameter values in output', () => {
  const engine = new TemplateEngine();
  const result = engine.assemble(MINIMAL_TEMPLATE, {
    board_name: 'Test; rm -rf /',
    board_id: 'abcdefgh',
  });
  assert.ok(!result.content.includes('; rm'));
  assert.ok(result.content.includes('Test rm -rf '));
});

// -----------------------------------------------------------------------------
// Summary
// -----------------------------------------------------------------------------

console.log('\n=== TemplateEngine Tests Complete ===\n');
summary();
exitWithCode();
