/*
 * Moltagent - Sovereign AI Security Layer
 * Copyright (C) 2026 Moltagent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * ToolRegistry Boot Composition Contract Tests (#227)
 *
 * The registry asserts its own composition at construction: a missing
 * required client produces a loud [BOOT][WARN] naming the family and the
 * client, and the family is skipped visibly. A dropped constructor client
 * (the #226 class) is caught structurally by parsing the live construction
 * site in webhook-server.js and asserting every passed key survives into
 * this.clients.
 *
 * Run: node test/unit/agent/tool-registry-boot-contract.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, summary, exitWithCode } = require('../../helpers/test-runner');
const { ToolRegistry } = require('../../../src/lib/agent/tool-registry');

console.log('\n=== ToolRegistry Boot Contract Tests (#227) ===\n');

/** Truthy mock client: any property access yields a callable no-op. */
function mockClient() {
  return new Proxy({}, { get: () => () => {} });
}

/** Logger that captures lines per level. */
function captureLogger() {
  const lines = { info: [], warn: [], error: [], log: [] };
  return {
    lines,
    info: (m) => lines.info.push(String(m)),
    warn: (m) => lines.warn.push(String(m)),
    error: (m) => lines.error.push(String(m)),
    log: (m) => lines.log.push(String(m)),
  };
}

/** Client keys the live construction site passes (parsed from webhook-server.js). */
function constructionSiteKeys() {
  const serverSrc = fs.readFileSync(path.join(__dirname, '../../../webhook-server.js'), 'utf8');
  const callMatch = serverSrc.match(/new ToolRegistry\(\{([\s\S]*?)\}\);/);
  assert.ok(callMatch, 'construction site found in webhook-server.js');
  return [...callMatch[1].matchAll(/^\s*(\w+)\s*:/gm)].map((m) => m[1]);
}

/** The full client set: manifest names ∪ construction-site keys. */
function fullClientSet() {
  const names = new Set(constructionSiteKeys());
  for (const fam of ToolRegistry.TOOL_FAMILIES) {
    for (const n of fam.required || []) names.add(n);
    for (const n of fam.optional || []) names.add(n);
  }
  const clients = {};
  for (const n of names) clients[n] = mockClient();
  return clients;
}

// TC-BOOT-001: missing required client → loud warning, family absent.
test('TC-BOOT-001: missing meetingComposer → [BOOT][WARN] fired and meeting tools absent', () => {
  const logger = captureLogger();
  const clients = fullClientSet();
  delete clients.meetingComposer;

  const registry = new ToolRegistry({ ...clients, logger });

  const warnLine = logger.lines.warn.find((l) => l.includes('meeting tools SKIPPED'));
  assert.ok(warnLine, 'a [BOOT][WARN] line must name the skipped family');
  assert.ok(warnLine.includes('[BOOT][WARN]'), 'warning carries the [BOOT][WARN] prefix');
  assert.ok(warnLine.includes("'meetingComposer'"), 'warning names the missing client');
  assert.ok(!registry.tools.has('meeting_compose'), 'meeting_compose must not register');
  assert.ok(!registry.tools.has('meeting_check_rsvp'), 'meeting_check_rsvp must not register');
});

// TC-BOOT-002: full client set → all families register, meeting tools present, 74+ tools.
test('TC-BOOT-002: full client set registers all families (74+ tools incl. meeting)', () => {
  const logger = captureLogger();
  const registry = new ToolRegistry({ ...fullClientSet(), logger });

  assert.ok(registry.tools.size >= 74, `expected >= 74 tools, got ${registry.tools.size}`);
  assert.ok(registry.tools.has('meeting_compose'), 'meeting_compose registers (#226)');
  assert.ok(registry.tools.has('meeting_check_rsvp'), 'meeting_check_rsvp registers (#226)');
  assert.strictEqual(logger.lines.warn.filter((l) => l.includes('[BOOT][WARN]')).length, 0,
    'no [BOOT][WARN] lines with a full client set');
  const bootLines = logger.lines.info.filter((l) => l.startsWith('[BOOT] ToolRegistry:'));
  assert.strictEqual(bootLines.length, ToolRegistry.TOOL_FAMILIES.length,
    'one positive [BOOT] line per family');
});

// TC-BOOT-003: manifest ↔ registrar alignment — every method exists.
test('TC-BOOT-003: every TOOL_FAMILIES method exists on the prototype', () => {
  for (const fam of ToolRegistry.TOOL_FAMILIES) {
    assert.strictEqual(typeof ToolRegistry.prototype[fam.method], 'function',
      `${fam.method} (family '${fam.family}') must exist`);
  }
});

// TC-BOOT-004: the #226 class, killed structurally — every key the LIVE
// construction site passes must survive into this.clients. Parses the real
// `new ToolRegistry({...})` call in webhook-server.js, so a future client
// added at the call site but dropped by the destructure fails HERE, not in
// production weeks later.
test('TC-BOOT-004: every construction-site client key survives into this.clients', () => {
  const passedKeys = constructionSiteKeys();
  assert.ok(passedKeys.length >= 15, `sanity: found ${passedKeys.length} construction-site keys`);

  const clients = {};
  const sentinels = {};
  for (const key of passedKeys) {
    sentinels[key] = mockClient();
    clients[key] = sentinels[key];
  }
  const registry = new ToolRegistry({ ...clients, logger: captureLogger() });

  const dropped = passedKeys.filter((key) => registry.clients[key] !== sentinels[key]);
  assert.deepStrictEqual(dropped, [],
    `constructor drops construction-site client(s): ${dropped.join(', ')} — align the destructure (#226)`);
});

// TC-BOOT-005: optional-client degrade is visible, not silent.
test('TC-BOOT-005: absent optional client logs a visible degrade note', () => {
  const logger = captureLogger();
  const clients = fullClientSet();
  delete clients.rsvpTracker;

  const registry = new ToolRegistry({ ...clients, logger });

  assert.ok(registry.tools.has('meeting_compose'), 'family still registers without optional client');
  const meetingLine = logger.lines.info.find((l) => l.includes('meeting tools registered'));
  assert.ok(meetingLine, 'positive [BOOT] line still emitted');
  assert.ok(meetingLine.includes("optional 'rsvpTracker' absent"), 'degrade note names the absent optional client');
});

summary();
exitWithCode();
