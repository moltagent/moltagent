'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const GateDetector = require('../../../src/lib/workflows/gate-detector');

(async () => {
  console.log('\n=== GateDetector Tests ===\n');

  // Test 1: isGate detects "GATE" in card title
  test('isGate() detects GATE in card title', () => {
    const card = { title: 'GATE: Approval needed', description: '' };
    assert.strictEqual(GateDetector.isGate(card), true);
  });

  // Test 2: isGate detects "wait for approval" in description
  test('isGate() detects "wait for approval" in description', () => {
    const card = { title: 'Review step', description: 'Wait for approval before proceeding.' };
    assert.strictEqual(GateDetector.isGate(card), true);
  });

  // Test 3: isGate returns false for normal cards
  test('isGate() returns false for normal cards', () => {
    const card = { title: 'Fix the bug', description: 'The login page has a CSS issue.' };
    assert.strictEqual(GateDetector.isGate(card), false);
  });

  // Test 4: isGate detects "approval required" pattern
  test('isGate() detects "approval required" pattern', () => {
    const card = { title: 'Final check', description: 'Approval required from manager.' };
    assert.strictEqual(GateDetector.isGate(card), true);
  });

  // Test 5: checkGateResolution finds approval comment
  await asyncTest('checkGateResolution() finds approval comment', async () => {
    const mockDeck = {
      getComments: async () => [
        { actorId: 'moltagent', message: '\u23F8\uFE0F GATE - Waiting for review' },
        { actorId: 'funana', message: 'Looks good! \u2705 approved' }
      ]
    };

    const result = await GateDetector.checkGateResolution(mockDeck, 123, 'moltagent');
    assert.strictEqual(result.resolved, true);
    assert.strictEqual(result.decision, 'approved');
    assert.strictEqual(result.comment.actorId, 'funana');
  });

  // Test 6: checkGateResolution finds rejection comment
  await asyncTest('checkGateResolution() finds rejection comment', async () => {
    const mockDeck = {
      getComments: async () => [
        { actorId: 'moltagent', message: '\u23F8\uFE0F GATE - Waiting for review' },
        { actorId: 'funana', message: '\u274C rejected - needs more work' }
      ]
    };

    const result = await GateDetector.checkGateResolution(mockDeck, 123, 'moltagent');
    assert.strictEqual(result.resolved, true);
    assert.strictEqual(result.decision, 'rejected');
  });

  // Test 7: checkGateResolution skips bot's own comments
  await asyncTest('checkGateResolution() skips bot own comments', async () => {
    const mockDeck = {
      getComments: async () => [
        { actorId: 'moltagent', message: '\u23F8\uFE0F GATE - Waiting for review' },
        { actorId: 'moltagent', message: '\u2705 Auto-approved by bot' }
      ]
    };

    const result = await GateDetector.checkGateResolution(mockDeck, 123, 'moltagent');
    assert.strictEqual(result.resolved, false, 'Bot comments should be skipped');
    assert.strictEqual(result.decision, null);
  });

  summary();
  exitWithCode();
})();
