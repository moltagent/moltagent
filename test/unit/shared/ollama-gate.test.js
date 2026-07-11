/**
 * SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2026 Moltagent contributors
 *
 * ollama-gate Unit Tests — the shared serving-active admission gate (#285).
 *
 * The gate is ONE serving signal read by two consumers: the heartbeat
 * (isUserActive) and the calibration probes (isServing/idle). These tests cover
 * the admission-gate additions: the isServing() alias and idle(cap), which let a
 * probe loop yield to a live turn and resume after it, or proceed at the cap.
 *
 * Run: node test/unit/shared/ollama-gate.test.js
 */

'use strict';

const assert = require('assert');
const { asyncTest, test, summary, exitWithCode } = require('../../helpers/test-runner');

const gate = require('../../../src/lib/shared/ollama-gate');

console.log('\n=== ollama-gate admission gate (#285) ===\n');

// Each test leaves the gate idle so the next starts clean (module singleton).
// The gate is a process-wide singleton, so these tests MUST run serially — they
// are awaited in the IIFE below, never fired concurrently, or one test's turn
// would leak into another's wait.
function resetGate() { gate.markUserDone(); }

(async () => {
  test('TC-GATE-001: isServing() is an alias of isUserActive()', () => {
    resetGate();
    assert.strictEqual(gate.isServing(), false, 'idle at rest');
    gate.markUserActive();
    assert.strictEqual(gate.isServing(), true, 'serving while a turn is active');
    assert.strictEqual(gate.isServing(), gate.isUserActive(), 'same truth, two names');
    resetGate();
    assert.strictEqual(gate.isServing(), false, 'markUserDone() clears serving');
  });

  await asyncTest('TC-GATE-002: idle() resolves immediately when nothing is serving', async () => {
    resetGate();
    const started = Date.now();
    const r = await gate.idle(5000);
    assert.strictEqual(r.waited, false, 'no wait when idle');
    assert.strictEqual(r.timedOut, false);
    assert.ok(Date.now() - started < 100, 'resolves without polling');
  });

  await asyncTest('TC-GATE-003: idle() waits while serving and resolves once the turn is done', async () => {
    resetGate();
    gate.markUserActive();
    const p = gate.idle(5000);
    // The turn finishes shortly after the probe began waiting.
    setTimeout(() => gate.markUserDone(), 120);
    const r = await p;
    assert.strictEqual(r.waited, true, 'the probe waited for the turn');
    assert.strictEqual(r.timedOut, false, 'it resumed because serving ended, not the cap');
    assert.strictEqual(gate.isServing(), false);
  });

  await asyncTest('TC-GATE-004: idle() proceeds at the cap when serving never ends (no starvation)', async () => {
    resetGate();
    gate.markUserActive(); // never marked done — a chatty deployment
    const started = Date.now();
    const r = await gate.idle(120); // tiny cap for the test
    assert.strictEqual(r.waited, true);
    assert.strictEqual(r.timedOut, true, 'the cap fires so measurement is never starved');
    assert.ok(Date.now() - started >= 120, 'waited at least the cap');
    assert.strictEqual(gate.isServing(), true, 'the turn is still active — the probe proceeds anyway');
    resetGate();
  });

  // A generous window so the real-timer waits above (all < ~300ms) complete.
  setTimeout(() => { summary(); exitWithCode(); }, 2000);
})();
