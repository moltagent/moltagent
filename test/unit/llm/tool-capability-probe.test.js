/**
 * SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2026 Moltagent contributors
 *
 * ToolCapabilityProbe Unit Tests (#118)
 *
 * Run: node test/unit/llm/tool-capability-probe.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const { ToolCapabilityProbe, VERDICT } = require('../../../src/lib/llm/tool-capability-probe');

console.log('\n=== ToolCapabilityProbe Tests (#118) ===\n');

function tmpCacheDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'toolprobe-'));
}

function captureLogger() {
  const lines = { warn: [], log: [], info: [] };
  return {
    lines,
    warn: (m) => lines.warn.push(String(m)),
    log: (m) => lines.log.push(String(m)),
    info: (m) => lines.info.push(String(m)),
    error: () => {},
  };
}

// The probe now sends TWO requests per capable candidate (#168): the tool-call
// item (mark_ready) then the date-grounding item (schedule_event). A stub must
// answer both. `dateStart` decides the second answer — omit for a grounded
// tomorrow (fixed probe today is 2026-06-15 → tomorrow 2026-06-16).
function dualStub({ dateStart = '2026-06-16T15:00:00', dateToolCalls } = {}) {
  return async (_model, req) => {
    const toolName = req && req.tools && req.tools[0] && req.tools[0].function && req.tools[0].function.name;
    if (toolName === 'schedule_event') {
      if (dateToolCalls !== undefined) return { content: 'no call', toolCalls: dateToolCalls };
      return { content: null, toolCalls: [{ name: 'schedule_event', arguments: { start: dateStart } }] };
    }
    return { content: null, toolCalls: [{ name: 'mark_ready', arguments: { ready: true } }] };
  };
}

(async () => {
  // TC-TCP-001: a model that answers the tool-call probe AND grounds the date passes.
  await asyncTest('TC-TCP-001: tool-call + grounded date → tool-call verdict', async () => {
    const probe = new ToolCapabilityProbe({
      chatFn: dualStub(),
      cacheDir: tmpCacheDir(), logger: captureLogger(),
    });
    const [v] = await probe.run([{ name: 'qwen3:8b' }]);
    assert.strictEqual(v.status, VERDICT.TOOL_CALL);
    assert.ok(v.detail.includes('date grounded'), 'detail records the date item passed');
  });

  // TC-TCP-002: prose response → flagged.
  await asyncTest('TC-TCP-002: prose response → prose verdict', async () => {
    const probe = new ToolCapabilityProbe({
      chatFn: async () => ({ content: 'I am ready to help!', toolCalls: null }),
      cacheDir: tmpCacheDir(), logger: captureLogger(),
    });
    const [v] = await probe.run([{ name: 'gemma2:2b' }]);
    assert.strictEqual(v.status, VERDICT.PROSE);
    assert.ok(v.detail.includes('prose'), 'detail names the failure shape');
  });

  // TC-TCP-003: a tool call to the WRONG function is not a pass.
  await asyncTest('TC-TCP-003: wrong function name → prose verdict', async () => {
    const probe = new ToolCapabilityProbe({
      chatFn: async () => ({ content: '', toolCalls: [{ id: 'x', name: 'unrelated_fn', arguments: {} }] }),
      cacheDir: tmpCacheDir(), logger: captureLogger(),
    });
    const [v] = await probe.run([{ name: 'm' }]);
    assert.strictEqual(v.status, VERDICT.PROSE);
  });

  // TC-TCP-004: transport error → unmeasured, NOT cached, NOT flagged (#124 cold ≠ prose).
  await asyncTest('TC-TCP-004: transport error → unmeasured and not cached', async () => {
    const dir = tmpCacheDir();
    let calls = 0;
    const probe = new ToolCapabilityProbe({
      chatFn: async () => { calls++; throw new Error('socket hang up (cold start)'); },
      cacheDir: dir, logger: captureLogger(),
    });
    const [v] = await probe.run([{ name: 'qwen3:8b', digest: 'sha256:abc' }]);
    assert.strictEqual(v.status, VERDICT.UNMEASURED);

    // Second run re-probes (no poisoned cache entry).
    const [v2] = await probe.run([{ name: 'qwen3:8b', digest: 'sha256:abc' }]);
    assert.strictEqual(v2.status, VERDICT.UNMEASURED);
    assert.strictEqual(calls, 2, 'errored measurement must not be served from cache');
  });

  // TC-TCP-005: verdicts are cached by digest — warm run makes no chatFn calls.
  await asyncTest('TC-TCP-005: cached verdict served without a new probe call', async () => {
    const dir = tmpCacheDir();
    let calls = 0;
    const inner = dualStub();
    const chatFn = async (m, req) => { calls++; return inner(m, req); };
    const probe1 = new ToolCapabilityProbe({ chatFn, cacheDir: dir, logger: captureLogger() });
    await probe1.run([{ name: 'qwen3:8b', digest: 'sha256:abc' }]);
    assert.strictEqual(calls, 2, 'a capable candidate is measured on both items (tool-call + date)');

    const probe2 = new ToolCapabilityProbe({ chatFn, cacheDir: dir, logger: captureLogger() });
    const [v] = await probe2.run([{ name: 'qwen3:8b', digest: 'sha256:abc' }]);
    assert.strictEqual(calls, 2, 'warm boot serves the cached verdict — no new probe calls');
    assert.strictEqual(v.status, VERDICT.TOOL_CALL);
    assert.ok(v.detail.includes('cached'));
  });

  // TC-TCP-006: no chatFn → skip loudly, empty result.
  await asyncTest('TC-TCP-006: missing chatFn skips with a warning', async () => {
    const logger = captureLogger();
    const probe = new ToolCapabilityProbe({ cacheDir: tmpCacheDir(), logger });
    const out = await probe.run([{ name: 'm' }]);
    assert.deepStrictEqual(out, []);
    assert.ok(logger.lines.warn.some((l) => l.includes('Missing chatFn')));
  });

  // TC-TCP-007: tool-call capable but anchors the date to 2023 → date-ungrounded (#168).
  await asyncTest('TC-TCP-007: 2023-anchored start → date-ungrounded verdict', async () => {
    const probe = new ToolCapabilityProbe({
      chatFn: dualStub({ dateStart: '2023-10-10T15:00:00' }),
      cacheDir: tmpCacheDir(), logger: captureLogger(),
    });
    const [v] = await probe.run([{ name: 'qwen3:8b' }]);
    assert.strictEqual(v.status, VERDICT.DATE_UNGROUNDED);
    assert.ok(v.detail.includes('off-window'), 'detail names the anchor failure');
    assert.ok(v.detail.includes('2023-10-10'), 'detail records the emitted date');
  });

  // TC-TCP-008: date-ungrounded is a real measurement — it caches and demotes like prose.
  await asyncTest('TC-TCP-008: date-ungrounded is cached (demotes like prose)', async () => {
    const dir = tmpCacheDir();
    let calls = 0;
    const inner = dualStub({ dateStart: '2023-10-10T15:00:00' });
    const chatFn = async (m, req) => { calls++; return inner(m, req); };
    const probe1 = new ToolCapabilityProbe({ chatFn, cacheDir: dir, logger: captureLogger() });
    const [v1] = await probe1.run([{ name: 'qwen3:8b', digest: 'sha256:d' }]);
    assert.strictEqual(v1.status, VERDICT.DATE_UNGROUNDED);
    const callsAfterFirst = calls;

    const probe2 = new ToolCapabilityProbe({ chatFn, cacheDir: dir, logger: captureLogger() });
    const [v2] = await probe2.run([{ name: 'qwen3:8b', digest: 'sha256:d' }]);
    assert.strictEqual(v2.status, VERDICT.DATE_UNGROUNDED);
    assert.strictEqual(calls, callsAfterFirst, 'a measured date failure is served from cache, not re-probed');
  });

  // TC-TCP-009: passes the tool-call item but answers the date item in prose → date-ungrounded.
  await asyncTest('TC-TCP-009: prose on the date item → date-ungrounded', async () => {
    const probe = new ToolCapabilityProbe({
      chatFn: dualStub({ dateToolCalls: null }),
      cacheDir: tmpCacheDir(), logger: captureLogger(),
    });
    const [v] = await probe.run([{ name: 'qwen3:8b' }]);
    assert.strictEqual(v.status, VERDICT.DATE_UNGROUNDED);
  });

  // TC-TCP-010: a transport error on the date item → unmeasured, NOT cached (cold ≠ ungrounded).
  await asyncTest('TC-TCP-010: date-item transport error → unmeasured, not cached', async () => {
    const dir = tmpCacheDir();
    let calls = 0;
    const chatFn = async (_m, req) => {
      calls++;
      const toolName = req.tools[0].function.name;
      if (toolName === 'schedule_event') throw new Error('socket hang up (cold on 2nd item)');
      return { content: null, toolCalls: [{ name: 'mark_ready', arguments: { ready: true } }] };
    };
    const probe1 = new ToolCapabilityProbe({ chatFn, cacheDir: dir, logger: captureLogger() });
    const [v1] = await probe1.run([{ name: 'qwen3:8b', digest: 'sha256:e' }]);
    assert.strictEqual(v1.status, VERDICT.UNMEASURED);
    const after = calls;
    // Second run re-probes both items (nothing poisoned the cache).
    const probe2 = new ToolCapabilityProbe({ chatFn, cacheDir: dir, logger: captureLogger() });
    const [v2] = await probe2.run([{ name: 'qwen3:8b', digest: 'sha256:e' }]);
    assert.strictEqual(v2.status, VERDICT.UNMEASURED);
    assert.ok(calls > after, 'errored date measurement is not served from cache');
  });

  setTimeout(() => { summary(); exitWithCode(); }, 500);
})();
