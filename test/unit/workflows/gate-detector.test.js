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

  summary();
  exitWithCode();
})();
