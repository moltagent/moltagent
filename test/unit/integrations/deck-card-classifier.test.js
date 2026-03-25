/**
 * AGPL-3.0 License
 * Copyright (C) 2024 Moltagent Contributors
 *
 * deck-card-classifier.test.js
 *
 * Architecture Brief
 * ------------------
 * Problem:   Verify that isStructuralCard correctly distinguishes structural/config
 *            cards from ordinary work items across all defined marker patterns,
 *            including edge cases such as null input, missing fields, and emoji-prefixed
 *            titles.
 *
 * Pattern:   Pure-function unit tests. No I/O, no mocks required.
 *
 * Key Dependencies:
 * - deck-card-classifier (module under test)
 * - test-runner helpers
 *
 * Data Flow: card object → isStructuralCard() → boolean assertion
 *
 * Run: node test/unit/integrations/deck-card-classifier.test.js
 *
 * @module test/unit/integrations/deck-card-classifier
 */

'use strict';

const assert = require('assert');
const { test, summary, exitWithCode } = require('../../helpers/test-runner');
const { isStructuralCard } = require('../../../src/lib/integrations/deck-card-classifier');

// ---------------------------------------------------------------------------
// TC-CLASS-001: returns false for null/undefined input
// ---------------------------------------------------------------------------
test('TC-CLASS-001: returns false for null input', () => {
  assert.strictEqual(isStructuralCard(null), false);
});

test('TC-CLASS-001: returns false for undefined input', () => {
  assert.strictEqual(isStructuralCard(undefined), false);
});

// ---------------------------------------------------------------------------
// TC-CLASS-002: returns false for regular work item
// ---------------------------------------------------------------------------
test('TC-CLASS-002: returns false for regular work item', () => {
  const card = { title: 'Research market trends', description: 'Find EU competitors' };
  assert.strictEqual(isStructuralCard(card), false);
});

// ---------------------------------------------------------------------------
// TC-CLASS-003: detects CONFIG: prefix in title
// ---------------------------------------------------------------------------
test('TC-CLASS-003: detects CONFIG: prefix in title', () => {
  const card = { title: 'CONFIG: SLA Rules', description: '' };
  assert.strictEqual(isStructuralCard(card), true);
});

// ---------------------------------------------------------------------------
// TC-CLASS-004: detects WORKFLOW: prefix in title
// ---------------------------------------------------------------------------
test('TC-CLASS-004: detects WORKFLOW: prefix in title', () => {
  const card = { title: 'WORKFLOW: Onboarding Steps', description: '' };
  assert.strictEqual(isStructuralCard(card), true);
});

// ---------------------------------------------------------------------------
// TC-CLASS-005: detects prefix after emoji stripping
// Real card from Pending Meetings board: emoji leader + "WORKFLOW RULES — DO NOT DELETE"
// After emoji stripping the title does NOT start with "WORKFLOW:" (no colon), but
// "DO NOT DELETE" is present in the raw title, which triggers the guard.
// ---------------------------------------------------------------------------
test('TC-CLASS-005: detects structural marker after emoji stripping (DO NOT DELETE path)', () => {
  const card = { title: '📋 WORKFLOW RULES — DO NOT DELETE', description: '' };
  assert.strictEqual(isStructuralCard(card), true);
});

// ---------------------------------------------------------------------------
// TC-CLASS-006: detects DO NOT DELETE in title
// ---------------------------------------------------------------------------
test('TC-CLASS-006: detects DO NOT DELETE in title', () => {
  const card = { title: 'Important Rules — DO NOT DELETE', description: '' };
  assert.strictEqual(isStructuralCard(card), true);
});

// ---------------------------------------------------------------------------
// TC-CLASS-007: detects DO NOT EDIT in title (case-insensitive)
// ---------------------------------------------------------------------------
test('TC-CLASS-007: detects DO NOT EDIT in title (mixed case)', () => {
  const card = { title: 'Template — Do Not Edit', description: '' };
  assert.strictEqual(isStructuralCard(card), true);
});

// ---------------------------------------------------------------------------
// TC-CLASS-008: detects WORKFLOW: prefix in description
// ---------------------------------------------------------------------------
test('TC-CLASS-008: detects WORKFLOW: prefix in description', () => {
  const card = { title: 'Board Rules', description: 'WORKFLOW: procedure\nTRIGGER: New card' };
  assert.strictEqual(isStructuralCard(card), true);
});

// ---------------------------------------------------------------------------
// TC-CLASS-009: detects TRIGGER: prefix in description
// ---------------------------------------------------------------------------
test('TC-CLASS-009: detects TRIGGER: prefix in description', () => {
  const card = { title: 'Auto-Archive', description: 'TRIGGER: Card moved to Done' };
  assert.strictEqual(isStructuralCard(card), true);
});

// ---------------------------------------------------------------------------
// TC-CLASS-010: case-insensitive title prefix match
// ---------------------------------------------------------------------------
test('TC-CLASS-010: case-insensitive title prefix (lowercase config:)', () => {
  const card = { title: 'config: daily settings', description: '' };
  assert.strictEqual(isStructuralCard(card), true);
});

// ---------------------------------------------------------------------------
// TC-CLASS-011: returns false for card with no structural markers
// ---------------------------------------------------------------------------
test('TC-CLASS-011: returns false for card with no structural markers', () => {
  const card = { title: 'Fix login bug', description: 'Users report 500 error on /login' };
  assert.strictEqual(isStructuralCard(card), false);
});

// ---------------------------------------------------------------------------
// TC-CLASS-012: handles missing description property gracefully
// ---------------------------------------------------------------------------
test('TC-CLASS-012: handles missing description property gracefully', () => {
  const card = { title: 'Regular card' };
  assert.strictEqual(isStructuralCard(card), false);
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
