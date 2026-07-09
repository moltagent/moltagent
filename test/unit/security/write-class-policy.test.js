/**
 * SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2026 Moltagent contributors
 *
 * Write-class policy pin — the structural guard against a map that lies.
 *
 * Architecture Brief:
 * - Problem: gating policy lived in three hand-maintained sets. Fourteen of the
 *   twenty-four names in them were tools that no code ever registered, so the
 *   policy read as protection while protecting nothing. The reverse gap is worse:
 *   a destructive tool registered with no policy entry ships ungated, silently.
 * - Pattern: two independent declarations that must agree. Policy says which tools
 *   need approval; each tool's own `writes: true` says whether it mutates the
 *   world. Neither is derived from the other, so the pin has teeth.
 * - Key Dependencies: ToolRegistry (declarations), GuardrailEnforcer +
 *   ToolGuard (policy).
 * - Data Flow: fully-populated registry × getWriteClassTools() → set equality.
 *
 * Related: #217 (policy has three writer homes, one reader; Wave 3 consolidates).
 *
 * Run: node test/unit/security/write-class-policy.test.js
 */

'use strict';

const assert = require('assert');
const { test, summary, exitWithCode } = require('../../helpers/test-runner');

const { ToolRegistry } = require('../../../src/lib/agent/tool-registry');
const {
  getWriteClassTools, HIGH_SEVERITY_TOOLS, SENSITIVE_TOOLS, TOOL_APPROVAL_LABELS
} = require('../../../src/lib/agent/guardrail-enforcer');
const { FORBIDDEN, REQUIRES_APPROVAL } = require('../../../src/security/guards/tool-guard');

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/**
 * Every tool the codebase *can* register. ToolRegistry registers a tool only when
 * its client exists (see `_registerDeckTools`: `if (!deck) return`), so a registry
 * built without clients has zero tools and would make every assertion below pass
 * vacuously. Proxy mocks make each client truthy.
 *
 * "Can register" is the right frame, not "does register on this box". mail_send
 * appears only when emailHandler is wired, so a deployment without email
 * configured registers 59 tools rather than 60 — and policy is still right to name
 * mail_send. Drop a client from this list and the tools it owns silently leave the
 * pin's reach; the populated-registry assertion below is the tripwire for that.
 */
function fullRegistry() {
  const mock = new Proxy({}, { get: () => () => {} });
  return new ToolRegistry({
    deckClient: mock, calDAVClient: mock, systemTagsClient: mock, ncRequestManager: mock,
    ncFilesClient: mock, ncSearchClient: mock, textExtractor: mock, collectivesClient: mock,
    learningLog: mock, searxngClient: mock, webReader: mock, contactsClient: mock,
    memorySearcher: mock, searchAdapters: mock, emailHandler: mock, resilientWriter: mock,
    newsClient: mock, entityExtractor: mock, meetingComposer: mock, rsvpTracker: mock,
    logger: silentLogger
  });
}

const registry = fullRegistry();
const registered = new Set(registry.tools.keys());
const declaredWrites = new Set(
  [...registry.tools.values()].filter(t => t.writes === true).map(t => t.name)
);

console.log('Write-Class Policy Pin\n');

// Guard the guard: if the mocks stop populating the registry, every assertion
// below becomes vacuously true. Fail loudly instead.
test('the registry under test is actually populated', () => {
  assert.ok(registered.size > 50, `expected a full registry, got ${registered.size} tools`);
  assert.ok(declaredWrites.size > 0, 'no tool declares writes: true');
});

// ── Direction 1: policy ⊆ registered — no map that lies ─────────

test('every REQUIRES_APPROVAL name is a registered tool', () => {
  const ghosts = REQUIRES_APPROVAL.filter(t => !registered.has(t));
  assert.deepStrictEqual(ghosts, [],
    `REQUIRES_APPROVAL gates tools that do not exist: ${ghosts.join(', ')}. ` +
    'A name here gates nothing unless a tool registers it. To guard an operation ' +
    'that must never become a tool, put it in FORBIDDEN.');
});

test('every HIGH_SEVERITY_TOOLS name is a registered tool', () => {
  const ghosts = [...HIGH_SEVERITY_TOOLS].filter(t => !registered.has(t));
  assert.deepStrictEqual(ghosts, [], `HIGH_SEVERITY_TOOLS names non-tools: ${ghosts.join(', ')}`);
});

test('every SENSITIVE_TOOLS name is a registered tool', () => {
  const ghosts = [...SENSITIVE_TOOLS].filter(t => !registered.has(t));
  assert.deepStrictEqual(ghosts, [], `SENSITIVE_TOOLS names non-tools: ${ghosts.join(', ')}`);
});

test('every TOOL_APPROVAL_LABELS key is a registered tool', () => {
  const ghosts = Object.keys(TOOL_APPROVAL_LABELS).filter(t => !registered.has(t));
  assert.deepStrictEqual(ghosts, [], `TOOL_APPROVAL_LABELS labels non-tools: ${ghosts.join(', ')}`);
});

// ── Direction 2: registered ∩ destructive ⊆ policy — no ungated tool ──
//
// `writes: true` is the tool's own declaration, made at its registration site and
// owing nothing to the policy sets. That is what lets it catch the dangerous drift.

test('every tool declaring writes: true is in the write class', () => {
  const writeClass = getWriteClassTools();
  const ungated = [...declaredWrites].filter(t => !writeClass.has(t)).sort();
  assert.deepStrictEqual(ungated, [],
    `these tools mutate external state but no policy gates them: ${ungated.join(', ')}. ` +
    'Add each to ToolGuard.REQUIRES_APPROVAL (hardcoded gate) or ' +
    'GuardrailEnforcer.SENSITIVE_TOOLS (Cockpit GATE guardrail).');
});

test('every write-class tool declares writes: true', () => {
  const undeclared = [...getWriteClassTools()].filter(t => !declaredWrites.has(t)).sort();
  assert.deepStrictEqual(undeclared, [],
    `policy gates these tools, but they do not declare writes: true: ${undeclared.join(', ')}`);
});

// ── The union is what the reader returns ────────────────────────

test('getWriteClassTools is exactly the union of the three writer homes', () => {
  const expected = new Set([...REQUIRES_APPROVAL, ...HIGH_SEVERITY_TOOLS, ...SENSITIVE_TOOLS]);
  assert.deepStrictEqual([...getWriteClassTools()].sort(), [...expected].sort());
});

test('the write class covers the tools that leave the box', () => {
  const writeClass = getWriteClassTools();
  // mail_send lives only in SENSITIVE_TOOLS. A two-set union silently drops it,
  // and with it the #81 symptom: the model narrating an email ceremony instead of
  // sending. Naming it here means that regression cannot land quietly.
  for (const tool of ['mail_send', 'wiki_write', 'file_write', 'deck_delete_card', 'wiki_delete']) {
    assert.ok(writeClass.has(tool), `${tool} must be write-class`);
  }
});

// ── FORBIDDEN is the opposite relationship ──────────────────────

test('FORBIDDEN names operations that must never be registered as tools', () => {
  const leaked = FORBIDDEN.filter(op => registered.has(op));
  assert.deepStrictEqual(leaked, [],
    `FORBIDDEN is a denylist; these leaked in as real tools: ${leaked.join(', ')}`);
});

setTimeout(() => {
  summary();
  exitWithCode();
}, 500);
