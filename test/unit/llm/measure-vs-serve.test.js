/**
 * SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2026 Moltagent contributors
 *
 * Measure-vs-serve admission gate — integration (#285).
 *
 * The per-module tests split the handshake in two (real gate + fake probe in
 * golden-set-probe.test / fake gate + real probe here). This closes the seam:
 * the REAL shared serving gate (shared/ollama-gate) composed with the REAL
 * probes, real timers, the exact objects boot wiring constructs. A fake
 * classify/chat stands in for Ollama — the subject is the ADMISSION handshake,
 * not classification accuracy. It reproduces the beta stampede in miniature: a
 * live turn is in flight when the boot walk starts, and the walk must yield.
 *
 * Run: node test/unit/llm/measure-vs-serve.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

const gate = require('../../../src/lib/shared/ollama-gate');
const GoldenSetProbe = require('../../../src/lib/llm/golden-set-probe');
const { ToolCapabilityProbe, VERDICT } = require('../../../src/lib/llm/tool-capability-probe');

const silent = { log: () => {}, warn: () => {}, info: () => {} };

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'measure-vs-serve-')); }

const FIXTURE = {
  version: 1, threshold: 0.75,
  languages: {
    EN: [{ id: 1, message: 'en1', gate: 'knowledge', domain: null }, { id: 2, message: 'en2', gate: 'action', domain: 'deck' }],
    DE: [{ id: 1, message: 'de1', gate: 'knowledge', domain: null }, { id: 2, message: 'de2', gate: 'action', domain: 'deck' }],
  },
};
const TRUTH = { en1: { gate: 'knowledge', domain: null }, en2: { gate: 'action', domain: 'deck' }, de1: { gate: 'knowledge', domain: null }, de2: { gate: 'action', domain: 'deck' } };

console.log('\n=== Measure-vs-serve integration (#285) ===\n');

(async () => {
  await asyncTest('TC-MVS-001: a boot walk started mid-turn yields on the REAL gate and completes only after the turn', async () => {
    gate.markUserDone(); // clean start
    const dir = tmpDir();
    try {
      let classifyCount = 0;
      const classifyFn = async (_m, message) => { classifyCount++; return TRUTH[message]; };
      const probe = new GoldenSetProbe({ classifyFn, fixture: FIXTURE, cacheDir: dir, servingGate: gate, logger: silent });

      // A live scheduling turn is in flight when the boot walk launches.
      gate.markUserActive();
      const running = probe.run([{ name: 'm', digest: 'd' }]);

      // Give the probe real time to reach its first pre-example yield and park.
      await new Promise(r => setTimeout(r, 150));
      assert.strictEqual(classifyCount, 0, 'the boot walk must NOT classify while a turn is serving — this is the stampede the gate prevents');

      // The turn finishes; the gate releases the parked probe.
      gate.markUserDone();
      const result = await running;
      assert.strictEqual(classifyCount, 4, 'the walk resumed after the turn and measured every example');
      assert.strictEqual(result.model, 'm');
    } finally {
      gate.markUserDone();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await asyncTest('TC-MVS-002: tool probe boot set is scoped and the rest drains through the real idle lane', async () => {
    gate.markUserDone();
    const dir = tmpDir();
    try {
      let chatCount = 0;
      const chatFn = async (_model, req) => {
        chatCount++;
        const name = req.tools[0].function.name;
        if (name === 'schedule_event') return { content: null, toolCalls: [{ name, arguments: { start: '2026-06-16T15:00:00' } }] };
        return { content: null, toolCalls: [{ name: 'mark_ready', arguments: { ready: true } }] };
      };
      const toolProbe = new ToolCapabilityProbe({ chatFn, cacheDir: dir, servingGate: gate, logger: silent });

      const verdicts = await toolProbe.run(
        [{ name: 'seated', digest: 'ta' }, { name: 'bench', digest: 'tb' }],
        { bootSet: ['seated'] }
      );
      assert.strictEqual(verdicts.length, 1, 'only the seated model gets a boot verdict');
      assert.strictEqual(verdicts[0].name, 'seated');
      assert.strictEqual(verdicts[0].status, VERDICT.TOOL_CALL);
      assert.strictEqual(chatCount, 2, 'the non-boot candidate is not measured at boot (2 items × 1 model)');

      assert.deepStrictEqual(toolProbe.getUnmeasuredCandidates().map(c => c.name), ['bench'], 'the bench candidate is the idle lane\'s work');
      const one = await toolProbe.measureOne({ name: 'bench', digest: 'tb' });
      assert.strictEqual(one.measured, true);
      assert.strictEqual(one.status, VERDICT.TOOL_CALL);
      assert.deepStrictEqual(toolProbe.getUnmeasuredCandidates(), [], 'idle lane drained');
    } finally {
      gate.markUserDone();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  setTimeout(() => { summary(); exitWithCode(); }, 1500);
})();
