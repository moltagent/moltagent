// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Unit tests for ensure-deployment-config.js
 *
 * Run: node test/unit/ensure-deployment-config.test.js
 *
 * @module test/unit/ensure-deployment-config.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, summary, exitWithCode } = require('../helpers/test-runner');
const { ensureDeploymentConfig, MANAGED_FILES } = require('../../src/lib/shared/ensure-deployment-config');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a fresh temp dir for each test. */
function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-deploy-cfg-test-'));
}

/** Write a file into the dir (creating parent dirs as needed). */
function writeFile(dir, relPath, content) {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
}

/** Build silent spy sinks. */
function makeSpies() {
  const logged = [];
  const errors = [];
  return {
    log: (msg) => logged.push(msg),
    errorLog: (msg) => errors.push(msg),
    logged,
    errors
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log('\n=== ensure-deployment-config Tests ===\n');

// TC-EDC-001: structural — MANAGED_FILES has exactly the two config entries, NO .service
test('TC-EDC-001: MANAGED_FILES contains exactly providers.json and moltagent-providers.yaml', () => {
  assert.strictEqual(MANAGED_FILES.length, 2, 'exactly 2 managed files');
  const reals = MANAGED_FILES.map(e => e.real);
  assert.ok(reals.includes('config/providers.json'), 'providers.json present');
  assert.ok(reals.includes('config/moltagent-providers.yaml'), 'moltagent-providers.yaml present');
  // Service file must NOT be in MANAGED_FILES — node never reads it
  const hasService = reals.some(r => r.includes('.service'));
  assert.strictEqual(hasService, false, '.service must not appear in MANAGED_FILES');
});

// TC-EDC-002: structural — every entry is frozen
test('TC-EDC-002: MANAGED_FILES entries are frozen', () => {
  assert.ok(Object.isFrozen(MANAGED_FILES), 'MANAGED_FILES array is frozen');
  for (const entry of MANAGED_FILES) {
    assert.ok(Object.isFrozen(entry), `entry ${entry.real} is frozen`);
  }
});

// TC-EDC-010: missing real file + present template → seeded, notice logged, bytes match
test('TC-EDC-010: missing real file is seeded from template', () => {
  const tmpDir = makeTempDir();
  const spies = makeSpies();

  // Seed only the two example templates (real files absent)
  const templateContent = '{"test": "template-value"}';
  writeFile(tmpDir, 'config/providers.json.example', templateContent);
  writeFile(tmpDir, 'config/moltagent-providers.yaml.example', 'yaml: template');

  const result = ensureDeploymentConfig({ rootDir: tmpDir, ...spies });

  assert.ok(result.copied.includes('config/providers.json'),
    'providers.json must be in copied');
  assert.ok(result.copied.includes('config/moltagent-providers.yaml'),
    'moltagent-providers.yaml must be in copied');
  assert.strictEqual(result.present.length, 0, 'nothing was pre-existing');
  assert.strictEqual(result.errors.length, 0, 'no errors expected');

  // Seeded bytes must match template bytes
  const seededContent = fs.readFileSync(path.join(tmpDir, 'config/providers.json'), 'utf-8');
  assert.strictEqual(seededContent, templateContent, 'seeded content matches template');

  // At least one notice logged per file
  const noticeCount = spies.logged.filter(m => m.includes('[INIT] Copied')).length;
  assert.ok(noticeCount >= 2, 'copy notices logged for each file');
});

// TC-EDC-011: present real file → no-op, sentinel survives (proves never-overwrite)
test('TC-EDC-011: present real file is never overwritten', () => {
  const tmpDir = makeTempDir();
  const spies = makeSpies();

  const sentinel = '{"original": "sentinel-must-survive"}';
  const templateContent = '{"different": "template-content"}';

  // Write real files with sentinel content
  writeFile(tmpDir, 'config/providers.json', sentinel);
  writeFile(tmpDir, 'config/moltagent-providers.yaml', 'original: sentinel');

  // Write templates with different content
  writeFile(tmpDir, 'config/providers.json.example', templateContent);
  writeFile(tmpDir, 'config/moltagent-providers.yaml.example', 'yaml: template');

  const result = ensureDeploymentConfig({ rootDir: tmpDir, ...spies });

  assert.strictEqual(result.copied.length, 0, 'nothing should be copied');
  assert.ok(result.present.includes('config/providers.json'), 'providers.json marked present');
  assert.ok(result.present.includes('config/moltagent-providers.yaml'), 'yaml marked present');
  assert.strictEqual(result.errors.length, 0, 'no errors');

  // Sentinel survives — file was NOT overwritten
  const afterContent = fs.readFileSync(path.join(tmpDir, 'config/providers.json'), 'utf-8');
  assert.strictEqual(afterContent, sentinel, 'sentinel content unchanged after ensureDeploymentConfig');
});

// TC-EDC-012: idempotency — second call is a pure no-op
test('TC-EDC-012: second call is idempotent (no further copies)', () => {
  const tmpDir = makeTempDir();
  const spies1 = makeSpies();
  const spies2 = makeSpies();

  writeFile(tmpDir, 'config/providers.json.example', '{"x":1}');
  writeFile(tmpDir, 'config/moltagent-providers.yaml.example', 'x: 1');

  // First call seeds the files
  const r1 = ensureDeploymentConfig({ rootDir: tmpDir, ...spies1 });
  assert.ok(r1.copied.length > 0, 'first call seeds at least one file');

  // Second call must find the files present and copy nothing
  const r2 = ensureDeploymentConfig({ rootDir: tmpDir, ...spies2 });
  assert.strictEqual(r2.copied.length, 0, 'second call copies nothing');
  assert.strictEqual(r2.errors.length, 0, 'second call has no errors');
  assert.ok(r2.present.length > 0, 'second call reports files as present');
});

// TC-EDC-020: missing template (real also absent) → recorded in errors, no throw
test('TC-EDC-020: missing template recorded in errors without throwing', () => {
  const tmpDir = makeTempDir();
  const spies = makeSpies();

  // Create the config dir but write NO files at all (both real and examples absent)
  fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true });

  let threw = false;
  let result;
  try {
    result = ensureDeploymentConfig({ rootDir: tmpDir, ...spies });
  } catch (_) {
    threw = true;
  }

  assert.strictEqual(threw, false, 'ensureDeploymentConfig must not throw on missing template');
  assert.ok(result.errors.length > 0, 'at least one error recorded for missing template');
  assert.ok(result.errors[0].error.includes('template missing'), 'error message identifies missing template');
  assert.ok(spies.errors.length > 0, 'errorLog was called');
});

// TC-EDC-021: returns { copied, present, errors } shape in all paths
test('TC-EDC-021: result always has copied/present/errors arrays', () => {
  const tmpDir = makeTempDir();
  const spies = makeSpies();
  fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true });

  const result = ensureDeploymentConfig({ rootDir: tmpDir, ...spies });

  assert.ok(Array.isArray(result.copied), 'result.copied is array');
  assert.ok(Array.isArray(result.present), 'result.present is array');
  assert.ok(Array.isArray(result.errors), 'result.errors is array');
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
