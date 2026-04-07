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
 * Unit Tests for MythDetector (Bullshit Protection Layer 4)
 *
 * Tests self-referential myth detection including:
 * - Claims repeated 3+ times without grounding → detected
 * - Claims repeated 3+ times WITH grounding → not flagged
 * - Claims repeated < 3 times → below threshold
 * - Deck alert card creation
 * - Claim key generation and grouping
 *
 * @module test/unit/security/myth-detector.test
 */

'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const MythDetector = require('../../../src/lib/security/myth-detector');

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

console.log('\n=== MythDetector Tests ===\n');

// Helper to build context entries with provenance
function assistantEntry(segments) {
  return {
    role: 'assistant',
    content: segments.map(s => s.text).join(' '),
    meta: { provenance: segments }
  };
}

function seg(text, trust = 'ungrounded') {
  return {
    text,
    trust,
    provenance: trust === 'grounded' ? 'wiki' : 'model',
    sourceRefs: trust === 'grounded' ? ['wiki:Test'] : [],
    confidence: trust === 'grounded' ? 0.9 : 0.1
  };
}

// =============================================================================
// Detection Tests
// =============================================================================

test('TC-MD-001: claim repeated 3x without grounding → detected as myth', () => {
  const detector = new MythDetector({ logger: silentLogger });
  const claim = 'Sarah runs the Q3 campaign at AcmeCorp';
  const entries = [
    assistantEntry([seg(claim)]),
    assistantEntry([seg(claim)]),
    assistantEntry([seg(claim)]),
  ];
  const myths = detector.detect(entries);
  assert.strictEqual(myths.length, 1);
  assert.strictEqual(myths[0].occurrences, 3);
  assert.strictEqual(myths[0].grounded, false);
  assert.strictEqual(myths[0].severity, 'medium');
});

test('TC-MD-002: claim repeated 3x WITH grounding → not flagged', () => {
  const detector = new MythDetector({ logger: silentLogger });
  const claim = 'Sarah runs the Q3 campaign at AcmeCorp';
  const entries = [
    assistantEntry([seg(claim, 'grounded')]),
    assistantEntry([seg(claim)]),
    assistantEntry([seg(claim)]),
  ];
  const myths = detector.detect(entries);
  assert.strictEqual(myths.length, 0);
});

test('TC-MD-003: claim repeated only 2x → below threshold', () => {
  const detector = new MythDetector({ logger: silentLogger });
  const claim = 'Sarah runs the Q3 campaign at AcmeCorp';
  const entries = [
    assistantEntry([seg(claim)]),
    assistantEntry([seg(claim)]),
  ];
  const myths = detector.detect(entries);
  assert.strictEqual(myths.length, 0);
});

test('TC-MD-004: claim repeated 5x → high severity', () => {
  const detector = new MythDetector({ logger: silentLogger });
  const claim = 'Sarah runs the Q3 campaign at AcmeCorp';
  const entries = Array.from({ length: 5 }, () => assistantEntry([seg(claim)]));
  const myths = detector.detect(entries);
  assert.strictEqual(myths.length, 1);
  assert.strictEqual(myths[0].severity, 'high');
  assert.strictEqual(myths[0].occurrences, 5);
});

test('TC-MD-005: different claims each repeated → detects each', () => {
  const detector = new MythDetector({ logger: silentLogger });
  const claim1 = 'Sarah runs the Q3 campaign at AcmeCorp';
  const claim2 = 'Project Phoenix headquarters located Berlin office';
  const entries = [
    assistantEntry([seg(claim1)]),
    assistantEntry([seg(claim1)]),
    assistantEntry([seg(claim1)]),
    assistantEntry([seg(claim2)]),
    assistantEntry([seg(claim2)]),
    assistantEntry([seg(claim2)]),
  ];
  const myths = detector.detect(entries);
  assert.strictEqual(myths.length, 2);
});

test('TC-MD-006: entries without provenance are skipped', () => {
  const detector = new MythDetector({ logger: silentLogger });
  const entries = [
    { role: 'assistant', content: 'Legacy response without provenance' },
    { role: 'user', content: 'User question' },
  ];
  const myths = detector.detect(entries);
  assert.strictEqual(myths.length, 0);
});

test('TC-MD-007: null/empty input returns empty array', () => {
  const detector = new MythDetector({ logger: silentLogger });
  assert.deepStrictEqual(detector.detect(null), []);
  assert.deepStrictEqual(detector.detect([]), []);
});

// =============================================================================
// Claim Key Tests
// =============================================================================

test('TC-MD-010: _claimKey produces consistent keys for similar text', () => {
  const detector = new MythDetector({ logger: silentLogger });
  const key1 = detector._claimKey('Sarah runs the Q3 campaign');
  const key2 = detector._claimKey('Sarah runs the Q3 campaign');
  assert.strictEqual(key1, key2);
  assert.ok(key1 !== null);
});

test('TC-MD-011: _claimKey returns null for very short text', () => {
  const detector = new MythDetector({ logger: silentLogger });
  assert.strictEqual(detector._claimKey('Hi'), null);
  assert.strictEqual(detector._claimKey('OK'), null);
});

test('TC-MD-012: _claimKey is case-insensitive', () => {
  const detector = new MythDetector({ logger: silentLogger });
  const key1 = detector._claimKey('Sarah runs the Campaign');
  const key2 = detector._claimKey('sarah RUNS the campaign');
  assert.strictEqual(key1, key2);
});

// =============================================================================
// Alert Tests
// =============================================================================

asyncTest('TC-MD-020: alert creates Deck card for detected myth', async () => {
  const cards = [];
  const mockDeck = {
    createCard: async (stack, data) => { cards.push({ stack, ...data }); }
  };
  const detector = new MythDetector({ logger: silentLogger, deckClient: mockDeck });
  const myths = [{
    claim: 'Sarah runs the Q3 campaign at AcmeCorp',
    claimKey: 'campaign_maneramedia_runs_sarah',
    occurrences: 3,
    grounded: false,
    severity: 'medium'
  }];
  const created = await detector.alert(myths);
  assert.strictEqual(created, 1);
  assert.ok(cards[0].title.includes('Possible myth'));
  assert.ok(cards[0].description.includes('3x'));
});

asyncTest('TC-MD-021: alert returns 0 when no deck client', async () => {
  const detector = new MythDetector({ logger: silentLogger });
  const created = await detector.alert([{ claim: 'test', occurrences: 3, severity: 'medium' }]);
  assert.strictEqual(created, 0);
});

asyncTest('TC-MD-022: alert handles deck client errors gracefully', async () => {
  const mockDeck = {
    createCard: async () => { throw new Error('Deck unavailable'); }
  };
  const detector = new MythDetector({ logger: silentLogger, deckClient: mockDeck });
  const created = await detector.alert([{ claim: 'test', occurrences: 3, severity: 'medium' }]);
  assert.strictEqual(created, 0);
});

// =============================================================================
// Summary
// =============================================================================

setTimeout(() => { summary(); exitWithCode(); }, 300);
