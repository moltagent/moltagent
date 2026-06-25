'use strict';

const assert = require('assert');
const { test, summary, exitWithCode } = require('../../helpers/test-runner');
const GateDetector = require('../../../src/lib/workflows/gate-detector');

(async () => {
  console.log('\n=== GateDetector Tests ===\n');

  // ── isGate ──────────────────────────────────────────────────────────────────

  test('isGate() returns true for card with GATE label', () => {
    const card = { title: 'Approval needed', description: '', labels: [{ title: 'GATE' }] };
    assert.strictEqual(GateDetector.isGate(card), true);
  });

  test('isGate() is case-insensitive on label title', () => {
    const card = { title: 'Step', description: '', labels: [{ title: 'gate' }] };
    assert.strictEqual(GateDetector.isGate(card), true);
  });

  test('isGate() returns false when no GATE label present', () => {
    const card = { title: 'Fix the bug', description: 'The login page has a CSS issue.', labels: [] };
    assert.strictEqual(GateDetector.isGate(card), false);
  });

  test('isGate() returns false for card with no labels field', () => {
    const card = { title: 'Fix the bug', description: 'Some task' };
    assert.strictEqual(GateDetector.isGate(card), false);
  });

  test('isGate() returns false for null input', () => {
    assert.strictEqual(GateDetector.isGate(null), false);
  });

  // ── isGateStack ─────────────────────────────────────────────────────────────

  test('isGateStack() returns true when CONFIG card mentions GATE', () => {
    const cards = [
      { title: 'CONFIG: GATE review step', description: 'Requires human GATE', labels: [{ title: 'System' }] },
      { title: 'Task A', description: '', labels: [] }
    ];
    assert.strictEqual(GateDetector.isGateStack(cards), true);
  });

  test('isGateStack() returns false when CONFIG card does not mention GATE', () => {
    const cards = [
      { title: 'CONFIG: Normal step', description: 'Process normally', labels: [{ title: 'System' }] },
      { title: 'Task A', description: '', labels: [] }
    ];
    assert.strictEqual(GateDetector.isGateStack(cards), false);
  });

  test('isGateStack() returns false when no CONFIG card exists', () => {
    const cards = [
      { title: 'Task A', description: 'No system label here', labels: [] }
    ];
    assert.strictEqual(GateDetector.isGateStack(cards), false);
  });

  test('isGateStack() returns false for empty array', () => {
    assert.strictEqual(GateDetector.isGateStack([]), false);
  });

  test('isGateStack() returns false for non-array input', () => {
    assert.strictEqual(GateDetector.isGateStack(null), false);
  });

  test('isGateStack() finds CONFIG card by "CONFIG:" title prefix when no System label (#197 dual locator)', () => {
    // A board whose gate CONFIG card uses ONLY the "CONFIG:" title convention,
    // with NO System label. Must still be recognised as a gate stack — otherwise
    // a held GATE card here would be silently read as approved-via-move.
    const cards = [
      { title: 'CONFIG: GATE review step', description: 'Human review required', labels: [] },
      { title: 'Task A', description: '', labels: [] }
    ];
    assert.strictEqual(GateDetector.isGateStack(cards), true);
  });

  test('isGateStack() returns false for CONFIG-title card without GATE token', () => {
    const cards = [
      { title: 'CONFIG: Replied', description: 'TERMINAL: true', labels: [] }
    ];
    assert.strictEqual(GateDetector.isGateStack(cards), false);
  });

  // ── checkGateResolution ──────────────────────────────────────────────────────

  test('checkGateResolution() returns approved when APPROVED label present', () => {
    const card = { labels: [{ title: 'GATE' }, { title: 'APPROVED' }] };
    const result = GateDetector.checkGateResolution(card);
    assert.strictEqual(result.resolved, true);
    assert.strictEqual(result.decision, 'approved');
  });

  test('checkGateResolution() returns rejected when REJECTED label present', () => {
    const card = { labels: [{ title: 'GATE' }, { title: 'REJECTED' }] };
    const result = GateDetector.checkGateResolution(card);
    assert.strictEqual(result.resolved, true);
    assert.strictEqual(result.decision, 'rejected');
  });

  test('checkGateResolution() returns unresolved when only GATE label present', () => {
    const card = { labels: [{ title: 'GATE' }] };
    const result = GateDetector.checkGateResolution(card);
    assert.strictEqual(result.resolved, false);
    assert.strictEqual(result.decision, null);
  });

  test('checkGateResolution() returns pass-through for card with no workflow labels', () => {
    const card = { labels: [] };
    const result = GateDetector.checkGateResolution(card);
    assert.strictEqual(result.resolved, true);
    assert.strictEqual(result.decision, null);
  });

  test('checkGateResolution() handles null card gracefully', () => {
    const result = GateDetector.checkGateResolution(null);
    assert.strictEqual(result.resolved, false);
    assert.strictEqual(result.decision, null);
  });

  test('checkGateResolution() is case-insensitive on label titles', () => {
    const card = { labels: [{ title: 'approved' }] };
    const result = GateDetector.checkGateResolution(card);
    assert.strictEqual(result.resolved, true);
    assert.strictEqual(result.decision, 'approved');
  });

  // ── checkGateResolution (stack-move / #197) ──────────────────────────────────

  // Reusable stacks for move-detection tests
  const gateCurrentStack = { cards: [
    { title: 'CONFIG: GATE review', description: 'Requires human GATE', labels: [{ title: 'System' }] }
  ]};
  const nonGateCurrentStack = { cards: [
    { title: 'CONFIG: Replied', description: 'TERMINAL: true', labels: [{ title: 'System' }] }
  ]};

  test('checkGateResolution() GATE label + still in gate stack → unresolved', () => {
    const card = { labels: [{ title: 'GATE' }] };
    const result = GateDetector.checkGateResolution(card, gateCurrentStack, false);
    assert.strictEqual(result.resolved, false);
    assert.strictEqual(result.decision, null);
    assert.strictEqual(result.via, null);
  });

  // Regression guard for the #197 false-approval BLOCKER: a gate stack whose
  // CONFIG card uses ONLY the "CONFIG:" title convention (no System label) must
  // still hold the gate, not auto-approve it.
  test('checkGateResolution() GATE label + gate stack identified by CONFIG-title only → unresolved (no false approval)', () => {
    const card = { labels: [{ title: 'GATE' }] };
    const titleOnlyGateStack = { cards: [
      { title: 'CONFIG: GATE review', description: 'Human review required', labels: [] }
    ]};
    const result = GateDetector.checkGateResolution(card, titleOnlyGateStack, false);
    assert.strictEqual(result.resolved, false);
    assert.strictEqual(result.decision, null);
    assert.strictEqual(result.via, null);
  });

  test('checkGateResolution() GATE label + moved to non-gate stack → approved via move', () => {
    const card = { labels: [{ title: 'GATE' }] };
    const result = GateDetector.checkGateResolution(card, nonGateCurrentStack, false);
    assert.strictEqual(result.resolved, true);
    assert.strictEqual(result.decision, 'approved');
    assert.strictEqual(result.via, 'move');
  });

  test('checkGateResolution() GATE label + moved to rejection stack → rejected via move', () => {
    const card = { labels: [{ title: 'GATE' }] };
    const result = GateDetector.checkGateResolution(card, nonGateCurrentStack, true);
    assert.strictEqual(result.resolved, true);
    assert.strictEqual(result.decision, 'rejected');
    assert.strictEqual(result.via, 'move');
  });

  test('checkGateResolution() GATE+APPROVED labels in gate stack → approved via label (label-first backward compat)', () => {
    const card = { labels: [{ title: 'GATE' }, { title: 'APPROVED' }] };
    // APPROVED check fires first, regardless of currentStack
    const result = GateDetector.checkGateResolution(card, gateCurrentStack, false);
    assert.strictEqual(result.resolved, true);
    assert.strictEqual(result.decision, 'approved');
    assert.strictEqual(result.via, 'label');
  });

  test('checkGateResolution() REJECTED label → rejected via label', () => {
    const card = { labels: [{ title: 'REJECTED' }] };
    const result = GateDetector.checkGateResolution(card, nonGateCurrentStack, false);
    assert.strictEqual(result.resolved, true);
    assert.strictEqual(result.decision, 'rejected');
    assert.strictEqual(result.via, 'label');
  });

  test('checkGateResolution() no workflow label → pass-through (via null)', () => {
    const card = { labels: [] };
    const result = GateDetector.checkGateResolution(card, nonGateCurrentStack, false);
    assert.strictEqual(result.resolved, true);
    assert.strictEqual(result.decision, null);
    assert.strictEqual(result.via, null);
  });

  test('checkGateResolution() GATE-only, currentStack omitted (legacy 1-arg call) → unresolved', () => {
    const card = { labels: [{ title: 'GATE' }] };
    const result = GateDetector.checkGateResolution(card);
    assert.strictEqual(result.resolved, false);
    assert.strictEqual(result.decision, null);
    assert.strictEqual(result.via, null);
  });

  summary();
  exitWithCode();
})();
