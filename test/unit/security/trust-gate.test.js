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
 * Unit Tests for TrustGate (Bullshit Protection Layer 2)
 *
 * Tests trust-gated persistence filtering including:
 * - Aggressive mode: only grounded/verified pass
 * - Balanced mode: stated passes, ungrounded filtered unless repeated 3x
 * - Relaxed mode: everything passes
 * - Off mode: no filtering
 * - Edge cases: missing provenance, non-assistant entries
 *
 * @module test/unit/security/trust-gate.test
 */

'use strict';

const assert = require('assert');
const { test, summary, exitWithCode } = require('../../helpers/test-runner');
const TrustGate = require('../../../src/lib/security/trust-gate');

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

console.log('\n=== TrustGate Tests ===\n');

// Helper to build a context entry with provenance
function assistantEntry(segments) {
  return {
    role: 'assistant',
    content: segments.map(s => s.text).join(' '),
    meta: { provenance: segments }
  };
}

function userEntry(content) {
  return { role: 'user', content };
}

// =============================================================================
// Constructor Tests
// =============================================================================

test('TC-TG-001: constructor defaults to balanced trust level', () => {
  const gate = new TrustGate({ logger: silentLogger });
  assert.strictEqual(gate.trustLevel, 'balanced');
});

test('TC-TG-002: constructor accepts valid trust levels', () => {
  for (const level of ['aggressive', 'balanced', 'relaxed', 'off']) {
    const gate = new TrustGate({ trustLevel: level, logger: silentLogger });
    assert.strictEqual(gate.trustLevel, level);
  }
});

test('TC-TG-003: constructor falls back to balanced for invalid level', () => {
  const gate = new TrustGate({ trustLevel: 'invalid', logger: silentLogger });
  assert.strictEqual(gate.trustLevel, 'balanced');
});

// =============================================================================
// Aggressive Mode Tests
// =============================================================================

test('TC-TG-010: aggressive — grounded segment passes', () => {
  const gate = new TrustGate({ trustLevel: 'aggressive', logger: silentLogger });
  const entries = [
    assistantEntry([
      { text: 'Carlos works at TheCatalyne', trust: 'grounded', provenance: 'wiki', sourceRefs: ['wiki:People/Carlos'], confidence: 0.9 }
    ])
  ];
  const { kept, filtered } = gate.filter(entries);
  assert.strictEqual(kept.length, 1);
  assert.strictEqual(filtered.length, 0);
});

test('TC-TG-011: aggressive — verified segment passes', () => {
  const gate = new TrustGate({ trustLevel: 'aggressive', logger: silentLogger });
  const entries = [
    assistantEntry([
      { text: 'Email sent to carlos@thecatalyne.com', trust: 'verified', provenance: 'tool', sourceRefs: ['tool:email'], confidence: 0.95 }
    ])
  ];
  const { kept, filtered } = gate.filter(entries);
  assert.strictEqual(kept.length, 1);
  assert.strictEqual(filtered.length, 0);
});

test('TC-TG-012: aggressive — ungrounded segment filtered', () => {
  const gate = new TrustGate({ trustLevel: 'aggressive', logger: silentLogger });
  const entries = [
    assistantEntry([
      { text: 'Phoenix might relate to Berlin office', trust: 'ungrounded', provenance: 'model', sourceRefs: [], confidence: 0.1 }
    ])
  ];
  const { kept, filtered } = gate.filter(entries);
  assert.strictEqual(kept.length, 0);
  assert.strictEqual(filtered.length, 1);
  assert.strictEqual(filtered[0].trust, 'ungrounded');
});

test('TC-TG-013: aggressive — stated segment filtered', () => {
  const gate = new TrustGate({ trustLevel: 'aggressive', logger: silentLogger });
  const entries = [
    assistantEntry([
      { text: 'You mentioned Carlos is your colleague', trust: 'stated', provenance: 'user', sourceRefs: ['user:current'], confidence: 0.8 }
    ])
  ];
  const { kept, filtered } = gate.filter(entries);
  assert.strictEqual(kept.length, 0);
  assert.strictEqual(filtered.length, 1);
});

test('TC-TG-014: aggressive — mixed segments partially kept', () => {
  const gate = new TrustGate({ trustLevel: 'aggressive', logger: silentLogger });
  const entries = [
    assistantEntry([
      { text: 'Carlos works at TheCatalyne', trust: 'grounded', provenance: 'wiki', sourceRefs: [], confidence: 0.9 },
      { text: 'He might be in Berlin', trust: 'ungrounded', provenance: 'model', sourceRefs: [], confidence: 0.1 }
    ])
  ];
  const { kept, filtered } = gate.filter(entries);
  assert.strictEqual(kept.length, 1);
  assert.ok(kept[0].content.includes('Carlos'));
  assert.ok(!kept[0].content.includes('Berlin'));
  assert.strictEqual(filtered.length, 1);
});

// =============================================================================
// Balanced Mode Tests
// =============================================================================

test('TC-TG-020: balanced — grounded passes', () => {
  const gate = new TrustGate({ trustLevel: 'balanced', logger: silentLogger });
  const entries = [
    assistantEntry([
      { text: 'Carlos works at TheCatalyne', trust: 'grounded', provenance: 'wiki', sourceRefs: [], confidence: 0.9 }
    ])
  ];
  const { kept } = gate.filter(entries);
  assert.strictEqual(kept.length, 1);
});

test('TC-TG-021: balanced — stated passes', () => {
  const gate = new TrustGate({ trustLevel: 'balanced', logger: silentLogger });
  const entries = [
    assistantEntry([
      { text: 'You said Carlos is your colleague', trust: 'stated', provenance: 'user', sourceRefs: [], confidence: 0.8 }
    ])
  ];
  const { kept, filtered } = gate.filter(entries);
  assert.strictEqual(kept.length, 1);
  assert.strictEqual(filtered.length, 0);
});

test('TC-TG-022: balanced — ungrounded not repeated → filtered', () => {
  const gate = new TrustGate({ trustLevel: 'balanced', logger: silentLogger });
  const entries = [
    assistantEntry([
      { text: 'Phoenix might relate to Berlin office', trust: 'ungrounded', provenance: 'model', sourceRefs: [], confidence: 0.1 }
    ])
  ];
  const { kept, filtered } = gate.filter(entries);
  assert.strictEqual(kept.length, 0);
  assert.strictEqual(filtered.length, 1);
});

test('TC-TG-023: balanced — ungrounded repeated 3x → passes', () => {
  const gate = new TrustGate({ trustLevel: 'balanced', logger: silentLogger });
  const repeatedText = 'Sarah runs the campaign at ManeraMedia';
  const seg = { text: repeatedText, trust: 'ungrounded', provenance: 'model', sourceRefs: [], confidence: 0.2 };
  const entries = [
    assistantEntry([seg]),
    assistantEntry([{ ...seg }]),
    assistantEntry([{ ...seg }]),
  ];
  const { kept, filtered } = gate.filter(entries);
  // All 3 entries should pass since the claim is repeated 3x
  assert.strictEqual(kept.length, 3);
  assert.strictEqual(filtered.length, 0);
});

// =============================================================================
// Relaxed Mode Tests
// =============================================================================

test('TC-TG-030: relaxed — everything passes, tags preserved', () => {
  const gate = new TrustGate({ trustLevel: 'relaxed', logger: silentLogger });
  const entries = [
    assistantEntry([
      { text: 'Grounded fact', trust: 'grounded', provenance: 'wiki', sourceRefs: [], confidence: 0.9 },
      { text: 'Ungrounded speculation', trust: 'ungrounded', provenance: 'model', sourceRefs: [], confidence: 0.1 }
    ])
  ];
  const { kept, filtered } = gate.filter(entries);
  assert.strictEqual(kept.length, 1);
  assert.strictEqual(filtered.length, 0);
  assert.strictEqual(kept[0].meta.provenance.length, 2);
});

// =============================================================================
// Off Mode Tests
// =============================================================================

test('TC-TG-040: off — no filtering at all', () => {
  const gate = new TrustGate({ trustLevel: 'off', logger: silentLogger });
  const entries = [
    assistantEntry([
      { text: 'Total fabrication', trust: 'ungrounded', provenance: 'model', sourceRefs: [], confidence: 0.05 }
    ])
  ];
  const { kept, filtered } = gate.filter(entries);
  assert.strictEqual(kept.length, 1);
  assert.strictEqual(filtered.length, 0);
});

// =============================================================================
// Edge Case Tests
// =============================================================================

test('TC-TG-050: user messages always pass regardless of mode', () => {
  const gate = new TrustGate({ trustLevel: 'aggressive', logger: silentLogger });
  const entries = [userEntry('Hello world')];
  const { kept } = gate.filter(entries);
  assert.strictEqual(kept.length, 1);
});

test('TC-TG-051: assistant without provenance metadata passes', () => {
  const gate = new TrustGate({ trustLevel: 'aggressive', logger: silentLogger });
  const entries = [{ role: 'assistant', content: 'Legacy response' }];
  const { kept } = gate.filter(entries);
  assert.strictEqual(kept.length, 1);
});

test('TC-TG-052: null/empty input returns empty results', () => {
  const gate = new TrustGate({ trustLevel: 'balanced', logger: silentLogger });
  assert.deepStrictEqual(gate.filter(null), { kept: [], filtered: [] });
  assert.deepStrictEqual(gate.filter([]), { kept: [], filtered: [] });
});

test('TC-TG-053: filtered entries include trust and reason', () => {
  const gate = new TrustGate({ trustLevel: 'aggressive', logger: silentLogger });
  const entries = [
    assistantEntry([
      { text: 'Speculative claim', trust: 'ungrounded', provenance: 'model', sourceRefs: [], confidence: 0.1 }
    ])
  ];
  const { filtered } = gate.filter(entries);
  assert.strictEqual(filtered[0].trust, 'ungrounded');
  assert.strictEqual(filtered[0].reason, 'aggressive');
});

// =============================================================================
// Summary
// =============================================================================

setTimeout(() => { summary(); exitWithCode(); }, 300);
