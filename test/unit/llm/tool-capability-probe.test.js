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

(async () => {
  // TC-TCP-001: a model that answers with the probe tool call passes.
  await asyncTest('TC-TCP-001: tool-call response → tool-call verdict', async () => {
    const probe = new ToolCapabilityProbe({
      chatFn: async () => ({ content: null, toolCalls: [{ id: 'x', name: 'mark_ready', arguments: { ready: true } }] }),
      cacheDir: tmpCacheDir(), logger: captureLogger(),
    });
    const [v] = await probe.run([{ name: 'qwen3:8b' }]);
    assert.strictEqual(v.status, VERDICT.TOOL_CALL);
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
    const chatFn = async () => { calls++; return { content: null, toolCalls: [{ name: 'mark_ready' }] }; };
    const probe1 = new ToolCapabilityProbe({ chatFn, cacheDir: dir, logger: captureLogger() });
    await probe1.run([{ name: 'qwen3:8b', digest: 'sha256:abc' }]);
    assert.strictEqual(calls, 1);

    const probe2 = new ToolCapabilityProbe({ chatFn, cacheDir: dir, logger: captureLogger() });
    const [v] = await probe2.run([{ name: 'qwen3:8b', digest: 'sha256:abc' }]);
    assert.strictEqual(calls, 1, 'warm boot serves the cached verdict');
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

  setTimeout(() => { summary(); exitWithCode(); }, 500);
})();
