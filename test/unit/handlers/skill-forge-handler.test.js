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
 * SkillForgeHandler Unit Tests
 *
 * Tests the SkillForgeHandler class with mocked dependencies.
 * Covers state management, intent classification, catalog listing,
 * template selection, parameter collection, assembly, preview,
 * approval, activation, cancel, and status operations.
 *
 * @module test/unit/handlers/skill-forge-handler
 */

'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const { createMockAuditLog } = require('../../helpers/mock-factories');

// Import module under test
const { SkillForgeHandler } = require('../../../src/lib/handlers/skill-forge-handler');

// ============================================================
// Mock Fixtures
// ============================================================

// Mock catalog
const MOCK_CATALOG = {
  templates: [
    { skill_id: 'trello-board', display_name: 'Trello Board Manager', description: 'Manage Trello boards', file: 'productivity/trello.yaml', category: 'productivity' },
    { skill_id: 'uptime-check', display_name: 'Uptime Checker', description: 'Monitor URLs', file: 'monitoring/uptime.yaml', category: 'monitoring' }
  ]
};

// Mock template (matches structure from integration test)
const MOCK_TEMPLATE = {
  skill_id: 'trello-board',
  display_name: 'Trello Board Manager',
  description: 'Manage a Trello board.',
  version: '1.0',
  requires: { bins: ['curl', 'jq'] },
  security: { allowed_domains: ['api.trello.com'], forbidden_patterns: [] },
  parameters: [
    { id: 'board_name', label: 'Board name', ask: 'What is the name of your Trello board?', type: 'text', required: true, example: 'Project Phoenix' },
    { id: 'board_id', label: 'Board ID', ask: 'What is the Trello board ID?', type: 'text', required: true, validation_pattern: '^[a-zA-Z0-9]{8}$' }
  ],
  skill_template: '---\nname: trello-{{board_name_slug}}\ndescription: Manage "{{board_name}}"\n---\n# {{board_name}}\nBoard: {{board_id}}'
};

// Mock template with no parameters
const MOCK_TEMPLATE_NO_PARAMS = {
  skill_id: 'simple-skill',
  display_name: 'Simple Skill',
  description: 'A simple skill with no parameters.',
  version: '1.0',
  requires: { bins: [] },
  security: { allowed_domains: [], forbidden_patterns: [] },
  parameters: [],
  skill_template: '---\nname: simple-skill\ndescription: Simple skill\n---\n# Simple Skill'
};

// ============================================================
// Mock Factories
// ============================================================

/**
 * Create a mock TemplateLoader
 */
function createMockTemplateLoader(catalog, template) {
  return {
    loadCatalog: async () => catalog,
    load: async (path) => template,
    validate: (t) => ({ valid: true, errors: [] })
  };
}

/**
 * Create a mock TemplateEngine
 */
function createMockTemplateEngine() {
  const { TemplateEngine } = require('../../../src/skill-forge/template-engine');
  return new TemplateEngine({ ncUrl: 'https://nc.test', ncUser: 'bot' });
}

/**
 * Create a mock SecurityScanner
 */
function createMockSecurityScanner(safe = true) {
  return {
    scan: () => ({ safe, violations: safe ? [] : ['test violation'], warnings: [] }),
    quickCheck: () => safe
  };
}

/**
 * Create a mock SkillActivator
 */
function createMockSkillActivator() {
  return {
    savePending: async (content, metadata) => ({ filename: 'test-skill.md', metaFilename: 'test-skill.meta.json' }),
    activate: async (filename) => ({ activated: true, skillName: 'test-skill', verified: null }),
    listPending: async () => [],
    extractSkillName: (content) => 'test-skill'
  };
}

/**
 * Create a test handler with mock dependencies
 */
function createTestHandler(options = {}) {
  const templateLoader = options.templateLoader || createMockTemplateLoader(MOCK_CATALOG, MOCK_TEMPLATE);
  const templateEngine = options.templateEngine || createMockTemplateEngine();
  const securityScanner = options.securityScanner || createMockSecurityScanner(true);
  const skillActivator = options.skillActivator || createMockSkillActivator();
  const auditLog = options.auditLog || createMockAuditLog();

  const handler = new SkillForgeHandler(templateLoader, templateEngine, securityScanner, skillActivator, auditLog);

  return { handler, templateLoader, templateEngine, securityScanner, skillActivator, auditLog };
}

// ============================================================
// Test Suites
// ============================================================

console.log('\n=== SkillForgeHandler Tests ===\n');

// --- Constructor / State Management Tests ---
console.log('\n--- Constructor / State Management Tests ---\n');

test('TC-SFH-001: Handler initializes with default idle state', () => {
  const { handler } = createTestHandler();

  const state = handler.getState('user1');
  assert.strictEqual(state.state, 'idle');
});

test('TC-SFH-002: getState returns idle for unknown user', () => {
  const { handler } = createTestHandler();

  const state = handler.getState('unknown-user');
  assert.strictEqual(state.state, 'idle');
});

test('TC-SFH-003: resetState clears to idle', () => {
  const { handler } = createTestHandler();

  // Set some state
  const state = handler.getState('user1');
  state.state = 'preview';
  state.template = MOCK_TEMPLATE;

  // Reset
  handler.resetState('user1');

  const newState = handler.getState('user1');
  assert.strictEqual(newState.state, 'idle');
  assert.strictEqual(newState.template, undefined);
});

// --- Intent Classification Tests ---
console.log('\n--- Intent Classification Tests ---\n');

test('TC-SFH-010: List intent from idle state', () => {
  const { handler } = createTestHandler();
  const state = handler.getState('user1');

  const intent = handler._classifyIntent('list templates', state);
  assert.strictEqual(intent, 'list');
});

test('TC-SFH-011: Select intent by number from browsing state', () => {
  const { handler } = createTestHandler();
  const state = handler.getState('user1');
  state.state = 'browsing';
  state.catalog = MOCK_CATALOG;

  const intent = handler._classifyIntent('1', state);
  assert.strictEqual(intent, 'select');
});

test('TC-SFH-012: Param response intent from selected state', () => {
  const { handler } = createTestHandler();
  const state = handler.getState('user1');
  state.state = 'selected';
  state.template = MOCK_TEMPLATE;

  const intent = handler._classifyIntent('My Board Name', state);
  assert.strictEqual(intent, 'param_response');
});

test('TC-SFH-013: Approve intent from preview state', () => {
  const { handler } = createTestHandler();
  const state = handler.getState('user1');
  state.state = 'preview';

  const intent = handler._classifyIntent('yes', state);
  assert.strictEqual(intent, 'approve');
});

test('TC-SFH-014: Activate intent from pending state', () => {
  const { handler } = createTestHandler();
  const state = handler.getState('user1');
  state.state = 'pending';

  const intent = handler._classifyIntent('activate', state);
  assert.strictEqual(intent, 'activate');
});

test('TC-SFH-015: Cancel intent from any state', () => {
  const { handler } = createTestHandler();
  const state = handler.getState('user1');

  // From idle
  let intent = handler._classifyIntent('cancel', state);
  assert.strictEqual(intent, 'cancel');

  // From browsing
  state.state = 'browsing';
  intent = handler._classifyIntent('cancel', state);
  assert.strictEqual(intent, 'cancel');

  // From selected
  state.state = 'selected';
  intent = handler._classifyIntent('cancel', state);
  assert.strictEqual(intent, 'cancel');
});

test('TC-SFH-016: Status intent from any state', () => {
  const { handler } = createTestHandler();
  const state = handler.getState('user1');

  const intent = handler._classifyIntent('status', state);
  assert.strictEqual(intent, 'status');
});

// --- Catalog Listing Tests ---
console.log('\n--- Catalog Listing Tests ---\n');

asyncTest('TC-SFH-020: List templates shows catalog', async () => {
  const { handler } = createTestHandler();

  const result = await handler.handle('list templates', { user: 'user1' });

  assert.strictEqual(result.success, true);
  assert.ok(result.message.includes('Available Skill Templates'));
  assert.ok(result.message.includes('Trello Board Manager'));
  assert.ok(result.message.includes('Uptime Checker'));
});

asyncTest('TC-SFH-021: List transitions state to browsing', async () => {
  const { handler } = createTestHandler();

  await handler.handle('list templates', { user: 'user1' });

  const state = handler.getState('user1');
  assert.strictEqual(state.state, 'browsing');
  assert.ok(state.catalog);
  assert.strictEqual(state.catalog.templates.length, 2);
});

// --- Template Selection Tests ---
console.log('\n--- Template Selection Tests ---\n');

asyncTest('TC-SFH-030: Select by number loads template and prompts for first parameter', async () => {
  const { handler } = createTestHandler();

  // First list to enter browsing state
  await handler.handle('list templates', { user: 'user1' });

  // Then select template #1
  const result = await handler.handle('1', { user: 'user1' });

  assert.strictEqual(result.success, true);
  assert.ok(result.message.includes('Trello Board Manager'));
  assert.ok(result.message.includes('Parameter 1 of 2'));
  assert.ok(result.message.includes('Board name'));
  assert.ok(result.message.includes('What is the name of your Trello board?'));

  const state = handler.getState('user1');
  assert.strictEqual(state.state, 'selected');
  assert.strictEqual(state.template.skill_id, 'trello-board');
  assert.strictEqual(state.currentParamIndex, 0);
});

asyncTest('TC-SFH-031: Select by skill_id loads template', async () => {
  const { handler } = createTestHandler();

  // First list to enter browsing state
  await handler.handle('list templates', { user: 'user1' });

  // Then select by skill_id
  const result = await handler.handle('trello-board', { user: 'user1' });

  assert.strictEqual(result.success, true);
  assert.ok(result.message.includes('Trello Board Manager'));

  const state = handler.getState('user1');
  assert.strictEqual(state.state, 'selected');
  assert.strictEqual(state.template.skill_id, 'trello-board');
});

asyncTest('TC-SFH-032: Select invalid number returns error', async () => {
  const { handler } = createTestHandler();

  // First list to enter browsing state
  await handler.handle('list templates', { user: 'user1' });

  // Then select invalid number
  const result = await handler.handle('99', { user: 'user1' });

  assert.strictEqual(result.success, false);
  assert.ok(result.message.includes('Invalid selection'));
});

// --- Parameter Collection Tests ---
console.log('\n--- Parameter Collection Tests ---\n');

asyncTest('TC-SFH-040: First param response stores value and prompts next', async () => {
  const { handler } = createTestHandler();

  // Setup: select a template
  await handler.handle('list templates', { user: 'user1' });
  await handler.handle('1', { user: 'user1' });

  // Provide first parameter value
  const result = await handler.handle('My Project Board', { user: 'user1' });

  assert.strictEqual(result.success, true);
  assert.ok(result.message.includes('Parameter 2 of 2'));
  assert.ok(result.message.includes('Board ID'));

  const state = handler.getState('user1');
  assert.strictEqual(state.parameters.board_name, 'My Project Board');
  assert.strictEqual(state.currentParamIndex, 1);
});

asyncTest('TC-SFH-041: Last param response triggers assembly and preview', async () => {
  const { handler } = createTestHandler();

  // Setup: select template and provide first param
  await handler.handle('list templates', { user: 'user1' });
  await handler.handle('1', { user: 'user1' });
  await handler.handle('My Project Board', { user: 'user1' });

  // Provide second (last) parameter value
  const result = await handler.handle('abc12345', { user: 'user1' });

  assert.strictEqual(result.success, true);
  assert.ok(result.message.includes('Skill Preview'));
  assert.ok(result.message.includes('yes') || result.message.includes('no'));

  const state = handler.getState('user1');
  assert.strictEqual(state.state, 'preview');
  assert.ok(state.generatedContent);
  assert.ok(state.metadata);
});

// --- Assembly & Preview Tests ---
console.log('\n--- Assembly & Preview Tests ---\n');

asyncTest('TC-SFH-050: Successful assembly shows preview', async () => {
  const { handler } = createTestHandler();

  // Setup: select template and provide all params
  await handler.handle('list templates', { user: 'user1' });
  await handler.handle('1', { user: 'user1' });
  await handler.handle('My Board', { user: 'user1' });
  const result = await handler.handle('abc12345', { user: 'user1' });

  assert.strictEqual(result.success, true);
  assert.ok(result.message.includes('Skill Preview'));
  assert.ok(result.message.includes('Skill Name:'));
});

asyncTest('TC-SFH-051: Security violation in assembly shows error and stays in selected', async () => {
  // Create handler with scanner that fails
  const { handler } = createTestHandler({
    securityScanner: createMockSecurityScanner(false)
  });

  // Setup: select template and provide all params
  await handler.handle('list templates', { user: 'user1' });
  await handler.handle('1', { user: 'user1' });
  await handler.handle('My Board', { user: 'user1' });
  const result = await handler.handle('abc12345', { user: 'user1' });

  assert.strictEqual(result.success, false);
  assert.ok(result.message.includes('Security scan failed'));
  assert.ok(result.message.includes('test violation'));

  // State should remain 'selected' not move to 'preview'
  const state = handler.getState('user1');
  assert.strictEqual(state.state, 'selected');
});

// --- Approval Tests ---
console.log('\n--- Approval Tests ---\n');

asyncTest('TC-SFH-060: Approve saves to pending via activator', async () => {
  let savePendingCalled = false;
  let capturedContent = null;
  let capturedMetadata = null;

  const customActivator = createMockSkillActivator();
  const originalSavePending = customActivator.savePending;
  customActivator.savePending = async (content, metadata) => {
    savePendingCalled = true;
    capturedContent = content;
    capturedMetadata = metadata;
    return originalSavePending(content, metadata);
  };

  const { handler } = createTestHandler({ skillActivator: customActivator });

  // Setup: go through full flow to preview
  await handler.handle('list templates', { user: 'user1' });
  await handler.handle('1', { user: 'user1' });
  await handler.handle('My Board', { user: 'user1' });
  await handler.handle('abc12345', { user: 'user1' });

  // Approve
  const result = await handler.handle('yes', { user: 'user1' });

  assert.strictEqual(savePendingCalled, true);
  assert.ok(capturedContent);
  assert.ok(capturedMetadata);
  assert.strictEqual(result.success, true);
  assert.ok(result.message.includes('Skill saved for review'));
});

asyncTest('TC-SFH-061: Approve transitions state to pending', async () => {
  const { handler } = createTestHandler();

  // Setup: go through full flow to preview
  await handler.handle('list templates', { user: 'user1' });
  await handler.handle('1', { user: 'user1' });
  await handler.handle('My Board', { user: 'user1' });
  await handler.handle('abc12345', { user: 'user1' });

  // Approve
  await handler.handle('yes', { user: 'user1' });

  const state = handler.getState('user1');
  assert.strictEqual(state.state, 'pending');
  assert.ok(state.pendingFilename);
});

// --- Activation Tests ---
console.log('\n--- Activation Tests ---\n');

asyncTest('TC-SFH-070: Activate returns requiresConfirmation', async () => {
  const { handler } = createTestHandler();

  // Setup: go through full flow to pending
  await handler.handle('list templates', { user: 'user1' });
  await handler.handle('1', { user: 'user1' });
  await handler.handle('My Board', { user: 'user1' });
  await handler.handle('abc12345', { user: 'user1' });
  await handler.handle('yes', { user: 'user1' });

  // Activate
  const result = await handler.handle('activate', { user: 'user1' });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.requiresConfirmation, true);
  assert.strictEqual(result.confirmationType, 'activate_skill');
  assert.ok(result.pendingAction);
  assert.strictEqual(result.pendingAction.action, 'activate_skill');
  assert.ok(result.pendingAction.data.filename);
});

asyncTest('TC-SFH-071: confirmActivateSkill calls activator.activate', async () => {
  let activateCalled = false;
  let capturedFilename = null;

  const customActivator = createMockSkillActivator();
  const originalActivate = customActivator.activate;
  customActivator.activate = async (filename) => {
    activateCalled = true;
    capturedFilename = filename;
    return originalActivate(filename);
  };

  const { handler } = createTestHandler({ skillActivator: customActivator });

  // Call confirmActivateSkill directly
  const result = await handler.confirmActivateSkill({ filename: 'test-skill.md' }, 'user1');

  assert.strictEqual(activateCalled, true);
  assert.strictEqual(capturedFilename, 'test-skill.md');
  assert.strictEqual(result.success, true);
  assert.ok(result.message.includes('Skill activated'));
});

asyncTest('TC-SFH-072: confirmActivateSkill resets state on success', async () => {
  const { handler } = createTestHandler();

  // Set some state
  const state = handler.getState('user1');
  state.state = 'pending';
  state.pendingFilename = 'test-skill.md';

  // Confirm activation
  await handler.confirmActivateSkill({ filename: 'test-skill.md' }, 'user1');

  // State should be reset
  const newState = handler.getState('user1');
  assert.strictEqual(newState.state, 'idle');
  assert.strictEqual(newState.pendingFilename, undefined);
});

asyncTest('TC-SFH-073: confirmActivateSkill returns failure when activator throws', async () => {
  const failActivator = createMockSkillActivator();
  failActivator.activate = async () => { throw new Error('Security scan failed on activation'); };

  const { handler } = createTestHandler({ skillActivator: failActivator });

  const result = await handler.confirmActivateSkill({ filename: 'test-skill.md' }, 'user1');

  assert.strictEqual(result.success, false);
  assert.ok(result.message.includes('Activation failed'));
  assert.ok(result.message.includes('Security scan failed'));
});

asyncTest('TC-SFH-074: Unknown input in preview state shows help', async () => {
  const { handler } = createTestHandler();

  // Navigate to preview state
  const state = handler.getState('user1');
  state.state = 'preview';
  state.generatedContent = '---\nname: test\n---\n# Test';
  state.metadata = { template_id: 'test' };

  const result = await handler.handle('what does this do?', { user: 'user1' });

  // Should show help, not auto-approve
  assert.ok(result.message.includes("didn't understand"));
});

// --- Cancel Tests ---
console.log('\n--- Cancel Tests ---\n');

asyncTest('TC-SFH-080: Cancel resets state and returns confirmation', async () => {
  const { handler } = createTestHandler();

  // Set some state
  const state = handler.getState('user1');
  state.state = 'selected';
  state.template = MOCK_TEMPLATE;

  // Cancel
  const result = await handler.handle('cancel', { user: 'user1' });

  assert.strictEqual(result.success, true);
  assert.ok(result.message.includes('cancelled'));

  const newState = handler.getState('user1');
  assert.strictEqual(newState.state, 'idle');
});

// --- Status Tests ---
console.log('\n--- Status Tests ---\n');

asyncTest('TC-SFH-090: Status with no pending shows empty message', async () => {
  const customActivator = createMockSkillActivator();
  customActivator.listPending = async () => [];

  const { handler } = createTestHandler({ skillActivator: customActivator });

  const result = await handler.handle('status', { user: 'user1' });

  assert.strictEqual(result.success, true);
  assert.ok(result.message.includes('No pending skills'));
});

asyncTest('TC-SFH-091: Status with pending shows list', async () => {
  const customActivator = createMockSkillActivator();
  customActivator.listPending = async () => [
    { filename: 'trello-my-board.md', template_id: 'trello-board', created: '2026-02-06T00:00:00.000Z' },
    { filename: 'uptime-example.md', template_id: 'uptime-check', created: '2026-02-05T00:00:00.000Z' }
  ];

  const { handler } = createTestHandler({ skillActivator: customActivator });

  const result = await handler.handle('status', { user: 'user1' });

  assert.strictEqual(result.success, true);
  assert.ok(result.message.includes('Pending Skills (2)'));
  assert.ok(result.message.includes('trello-my-board.md'));
  assert.ok(result.message.includes('uptime-example.md'));
});

// --- Derived Parameter Tests ---
console.log('\n--- Derived Parameter Tests ---\n');

// Mock template with a derived parameter
const MOCK_TEMPLATE_DERIVED = {
  skill_id: 'uptime-check',
  display_name: 'Uptime Checker',
  description: 'Monitor a URL for availability.',
  version: '1.0',
  requires: { bins: ['curl'] },
  security: { allowed_domains: ['{{target_domain}}'], forbidden_patterns: [] },
  parameters: [
    { id: 'target_url', label: 'Target URL', ask: 'What URL should be monitored?', type: 'string', required: true, example: 'https://example.com/health' },
    { id: 'target_domain', label: 'Target Domain', type: 'string', derived_from: 'target_url', transform: 'domain', required: true },
    { id: 'check_interval', label: 'Check Interval', ask: 'How often?', type: 'select', options: [{ label: 'Every 5 min', value: '*/5 * * * *' }], required: true }
  ],
  skill_template: '---\nname: uptime-{{target_domain_slug}}\n---\nURL: {{target_url}}\nDomain: {{target_domain}}\nInterval: {{check_interval}}'
};

asyncTest('TC-SFH-100: Derived params are skipped during user collection', async () => {
  const templateLoader = createMockTemplateLoader(MOCK_CATALOG, MOCK_TEMPLATE_DERIVED);
  const { handler } = createTestHandler({ templateLoader });

  // List templates
  await handler.handle('list templates', { user: 'user1' });

  // Select template
  const selectResult = await handler.handle('1', { user: 'user1' });

  // Should prompt for "Parameter 1 of 2" (not 1 of 3)
  assert.ok(selectResult.message.includes('Parameter 1 of 2'), `Expected "Parameter 1 of 2" in: ${selectResult.message}`);
  assert.ok(selectResult.message.includes('Target URL'), 'Should prompt for Target URL first');
});

asyncTest('TC-SFH-101: Derived param auto-computed from source value', async () => {
  const templateLoader = createMockTemplateLoader(MOCK_CATALOG, MOCK_TEMPLATE_DERIVED);
  const { handler } = createTestHandler({ templateLoader });

  // Navigate to parameter collection
  await handler.handle('list templates', { user: 'user1' });
  await handler.handle('1', { user: 'user1' });

  // Provide target_url
  const param1Result = await handler.handle('https://api.example.com/health', { user: 'user1' });

  // Should prompt for param 2 of 2 (check_interval), not target_domain
  assert.ok(param1Result.message.includes('Parameter 2 of 2'), `Expected "Parameter 2 of 2" in: ${param1Result.message}`);
  assert.ok(param1Result.message.includes('Check Interval'), 'Should prompt for Check Interval, not Target Domain');
});

asyncTest('TC-SFH-102: Derived domain appears in assembled skill', async () => {
  const templateLoader = createMockTemplateLoader(MOCK_CATALOG, MOCK_TEMPLATE_DERIVED);
  const { handler } = createTestHandler({ templateLoader });

  // Navigate through full flow
  await handler.handle('list templates', { user: 'user1' });
  await handler.handle('1', { user: 'user1' });
  await handler.handle('https://api.example.com/health', { user: 'user1' });
  const previewResult = await handler.handle('*/5 * * * *', { user: 'user1' });

  // Preview should contain the derived domain
  assert.ok(previewResult.message.includes('api.example.com'), `Expected derived domain in preview: ${previewResult.message}`);
  assert.ok(previewResult.message.includes('https://api.example.com/health'), 'URL should appear in preview');
});

asyncTest('TC-SFH-103: _applyTransform domain extracts hostname', async () => {
  const { handler } = createTestHandler();

  assert.strictEqual(handler._applyTransform('https://example.com/path', 'domain'), 'example.com');
  assert.strictEqual(handler._applyTransform('https://api.sub.example.com:8080/test', 'domain'), 'api.sub.example.com');
  assert.strictEqual(handler._applyTransform('http://localhost:3000', 'domain'), 'localhost');
});

asyncTest('TC-SFH-104: _applyTransform domain handles malformed URLs gracefully', async () => {
  const { handler } = createTestHandler();

  // Fallback regex extraction for non-URL strings
  const result = handler._applyTransform('example.com/path', 'domain');
  assert.strictEqual(result, 'example.com');
});

asyncTest('TC-SFH-105: _applyTransform unknown transform returns source value', async () => {
  const { handler } = createTestHandler();

  assert.strictEqual(handler._applyTransform('hello', 'unknown_transform'), 'hello');
  assert.strictEqual(handler._applyTransform('hello', undefined), 'hello');
});

// --- Select Resolution Tests ---
console.log('\n--- Select Resolution Tests ---\n');

asyncTest('TC-SFH-110: _resolveSelectValue matches by exact value', async () => {
  const { handler } = createTestHandler();
  const options = [
    { label: 'Every 5 minutes', value: '*/5 * * * *' },
    { label: 'Every hour', value: '0 * * * *' }
  ];

  assert.strictEqual(handler._resolveSelectValue('*/5 * * * *', options), '*/5 * * * *');
  assert.strictEqual(handler._resolveSelectValue('0 * * * *', options), '0 * * * *');
});

asyncTest('TC-SFH-111: _resolveSelectValue matches by label (case-insensitive)', async () => {
  const { handler } = createTestHandler();
  const options = [
    { label: 'Every 5 minutes', value: '*/5 * * * *' },
    { label: 'Every hour', value: '0 * * * *' }
  ];

  assert.strictEqual(handler._resolveSelectValue('Every 5 minutes', options), '*/5 * * * *');
  assert.strictEqual(handler._resolveSelectValue('every hour', options), '0 * * * *');
});

asyncTest('TC-SFH-112: _resolveSelectValue matches by 1-based index', async () => {
  const { handler } = createTestHandler();
  const options = [
    { label: '1 failure', value: '1' },
    { label: '3 failures', value: '3' },
    { label: '5 failures', value: '5' }
  ];

  // Note: "1" matches exact value "1" first, which is correct
  assert.strictEqual(handler._resolveSelectValue('1', options), '1');
  // "2" doesn't match any value, so falls through to index: option[1] = "3"
  assert.strictEqual(handler._resolveSelectValue('2', options), '3');
});

asyncTest('TC-SFH-113: _resolveSelectValue returns input for no match', async () => {
  const { handler } = createTestHandler();
  const options = [
    { label: 'Option A', value: 'a' },
    { label: 'Option B', value: 'b' }
  ];

  assert.strictEqual(handler._resolveSelectValue('nonexistent', options), 'nonexistent');
});

asyncTest('TC-SFH-115: _resolveSelectValue partial match on label substring', async () => {
  const { handler } = createTestHandler();
  const options = [
    { label: 'Every 5 minutes', value: '*/5 * * * *' },
    { label: 'Every 15 minutes', value: '*/15 * * * *' },
    { label: 'Every hour', value: '0 * * * *' }
  ];

  // "hour" is a substring of "Every hour" — unique partial match
  assert.strictEqual(handler._resolveSelectValue('hour', options), '0 * * * *');
  // "15" is a substring of "Every 15 minutes" — unique partial match
  assert.strictEqual(handler._resolveSelectValue('15', options), '*/15 * * * *');
});

asyncTest('TC-SFH-116: _resolveSelectValue ambiguous partial match falls through', async () => {
  const { handler } = createTestHandler();
  const options = [
    { label: 'Every 5 minutes', value: '*/5 * * * *' },
    { label: 'Every 15 minutes', value: '*/15 * * * *' },
    { label: 'Every hour', value: '0 * * * *' }
  ];

  // "every" matches all three labels — ambiguous, no partial resolution
  assert.strictEqual(handler._resolveSelectValue('every', options), 'every');
  // "minutes" matches two labels — ambiguous
  assert.strictEqual(handler._resolveSelectValue('minutes', options), 'minutes');
});

// --- Numbered Options Format Tests ---
console.log('\n--- Numbered Options Format Tests ---\n');

asyncTest('TC-SFH-120: Catalog listing uses [N] numbered format', async () => {
  const { handler } = createTestHandler();

  const result = await handler.handle('list templates', { user: 'user1' });

  assert.ok(result.message.includes('[1] Trello Board Manager'), `Expected [1] format in: ${result.message}`);
  assert.ok(result.message.includes('[2] Uptime Checker'), `Expected [2] format in: ${result.message}`);
  assert.ok(result.message.includes('Reply with the number of your choice'));
});

asyncTest('TC-SFH-121: Select param prompt uses [N] numbered format', async () => {
  const templateLoader = createMockTemplateLoader(MOCK_CATALOG, MOCK_TEMPLATE_DERIVED);
  const { handler } = createTestHandler({ templateLoader });

  await handler.handle('list templates', { user: 'user1' });
  await handler.handle('1', { user: 'user1' });

  // Provide target_url to advance to check_interval (select type)
  const result = await handler.handle('https://example.com', { user: 'user1' });

  assert.ok(result.message.includes('[1] Every 5 min'), `Expected [1] format in select prompt: ${result.message}`);
  assert.ok(result.message.includes('Reply with the number of your choice'));
});

asyncTest('TC-SFH-114: Select resolution works end-to-end in param collection', async () => {
  const templateLoader = createMockTemplateLoader(MOCK_CATALOG, MOCK_TEMPLATE_DERIVED);
  const { handler } = createTestHandler({ templateLoader });

  // Navigate to param collection
  await handler.handle('list templates', { user: 'user1' });
  await handler.handle('1', { user: 'user1' });
  await handler.handle('https://example.com/health', { user: 'user1' });

  // User types label "Every 5 min" for check_interval select (matches mock label)
  const result = await handler.handle('Every 5 min', { user: 'user1' });

  // Should succeed with preview (not validation error)
  assert.ok(result.message.includes('Skill Preview'), `Expected preview, got: ${result.message}`);
});

// --- Summary ---
console.log('\n=== SkillForgeHandler Tests Complete ===\n');
setTimeout(() => {
  summary();
  exitWithCode();
}, 100);
