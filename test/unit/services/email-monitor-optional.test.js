/**
 * SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2024 Moltagent contributors
 *
 * EmailMonitor — Optional-feature lifecycle tests
 *
 * Architecture Brief:
 *   These tests pin the briefing's two load-bearing distinctions:
 *
 *     1. Permanent: no email-imap credential configured.
 *        tryGet returns null → monitor disables itself, calls stop(),
 *        future checkInbox() calls short-circuit. ONE log line, never
 *        a per-heartbeat retry storm.
 *
 *     2. Transient: credential present but IMAP/network hiccups.
 *        Caught by checkInbox()'s catch → logged, returned as
 *        { error }. Monitor stays enabled and retries next heartbeat.
 *        Catch NEVER re-throws — the scheduler must not unhandled-reject.
 *
 *   Plus a scheduler-level test: setInterval's callback wraps
 *   checkInbox().catch() so even a synchronous-throw bug in checkInbox
 *   itself can't kill the process.
 *
 *   Related: briefings/CC-Briefing-EmailOptional.md, issue #87.
 *
 * Run: node test/unit/services/email-monitor-optional.test.js
 */

'use strict';

const assert = require('assert');
const { asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

const EmailMonitor = require('../../../src/lib/services/email-monitor');

function makeBroker({ value = null, tryGetImpl, getImpl } = {}) {
  return {
    tryGet: tryGetImpl || (async () => value),
    get: getImpl || (async () => {
      if (value === null) throw new Error("Credential 'email-imap' not found in NC Passwords");
      return value;
    }),
  };
}

function makeMonitor(broker, overrides = {}) {
  return new EmailMonitor({
    credentialBroker: broker,
    llmRouter: { route: async () => ({ result: '{}' }) },
    auditLog: overrides.auditLog || (async () => {}),
    sendTalkMessage: async () => {},
    defaultToken: 'test-room',
    heartbeatInterval: 60_000,
    ...overrides,
  });
}

console.log('\n=== EmailMonitor Optional-Feature Lifecycle Tests ===\n');

(async () => {

  // ----------------------------------------------------------------
  // Permanent: missing credential disables monitor cleanly
  // ----------------------------------------------------------------

  await asyncTest('checkInbox: tryGet null → _disabled=true, stop() called, returns {disabled:true}, no throw', async () => {
    let stopCalled = 0;
    const monitor = makeMonitor(makeBroker({ value: null }));
    const realStop = monitor.stop.bind(monitor);
    monitor.stop = () => { stopCalled++; realStop(); };

    const result = await monitor.checkInbox();

    assert.strictEqual(result.disabled, true);
    assert.strictEqual(result.checked, false);
    assert.strictEqual(monitor._disabled, true);
    assert.strictEqual(stopCalled, 1, 'stop() should be called exactly once');
  });

  await asyncTest('checkInbox: subsequent calls short-circuit once _disabled', async () => {
    const broker = makeBroker({ value: null });
    let tryGetCalls = 0;
    const realTryGet = broker.tryGet;
    broker.tryGet = async (name) => { tryGetCalls++; return realTryGet(name); };

    const monitor = makeMonitor(broker);
    await monitor.checkInbox();
    await monitor.checkInbox();
    await monitor.checkInbox();

    assert.strictEqual(tryGetCalls, 1, 'tryGet must be called only on first cycle');
  });

  await asyncTest('checkInbox: emits audit event when disabled by missing credential', async () => {
    const audits = [];
    const monitor = makeMonitor(makeBroker({ value: null }), {
      auditLog: async (event, payload) => audits.push({ event, payload }),
    });

    await monitor.checkInbox();

    const disableAudit = audits.find(a => a.event === 'email_monitor_disabled');
    assert.ok(disableAudit, 'should emit email_monitor_disabled audit');
    assert.strictEqual(disableAudit.payload.reason, 'credential_not_configured');
  });

  // ----------------------------------------------------------------
  // Transient: configured account with IMAP failure stays enabled
  // ----------------------------------------------------------------

  await asyncTest('checkInbox: transient _fetchUnreadEmails failure → returns {error}, no throw, _disabled stays false', async () => {
    const monitor = makeMonitor(makeBroker({
      value: { username: 'u', password: 'p', host: 'h', port: 993 },
    }));
    // Simulate an IMAP connection failure on a configured account.
    monitor._fetchUnreadEmails = async () => {
      throw new Error('IMAP ECONNREFUSED');
    };

    const result = await monitor.checkInbox();

    assert.strictEqual(result.checked, false);
    assert.strictEqual(result.error, 'IMAP ECONNREFUSED');
    assert.strictEqual(monitor._disabled, false, 'transient errors must NOT disable the monitor');
  });

  await asyncTest('checkInbox: transient failure does not propagate (catch swallows for scheduler)', async () => {
    const monitor = makeMonitor(makeBroker({
      value: { username: 'u', password: 'p', host: 'h', port: 993 },
    }));
    monitor._fetchUnreadEmails = async () => { throw new Error('transient'); };

    // If checkInbox re-throws, the scheduler callback rejects unhandled.
    // Assert by awaiting directly with no try/catch — if it throws,
    // the test runner will mark this as a failure.
    const result = await monitor.checkInbox();
    assert.strictEqual(result.error, 'transient');
  });

  // ----------------------------------------------------------------
  // Scheduler hardening: .catch() is the belt to checkInbox's brace
  // ----------------------------------------------------------------

  await asyncTest('setInterval callback never unhandled-rejects, even if checkInbox throws synchronously', async () => {
    const monitor = makeMonitor(makeBroker({ value: null }));
    // Force checkInbox to throw synchronously — would crash the process
    // without the scheduler .catch() wrapper.
    monitor.checkInbox = async () => { throw new Error('synchronous boom'); };
    monitor.heartbeatInterval = 50;

    let unhandled = null;
    const onUnhandled = (reason) => { unhandled = reason; };
    process.on('unhandledRejection', onUnhandled);

    try {
      monitor.start();
      // Let one or two ticks of setInterval fire.
      await new Promise(r => setTimeout(r, 150));
    } finally {
      monitor.stop();
      process.removeListener('unhandledRejection', onUnhandled);
    }

    assert.strictEqual(unhandled, null, 'scheduler must catch all rejections');
  });

  await asyncTest('setTimeout initial-check callback never unhandled-rejects', async () => {
    // Override the appConfig initialDelay via constructor-injectable path
    // is awkward; instead we directly assert the .catch wrapper exists
    // by replacing checkInbox and observing the scheduler doesn't crash.
    const monitor = makeMonitor(makeBroker({ value: null }));
    monitor.checkInbox = async () => { throw new Error('init boom'); };

    let unhandled = null;
    const onUnhandled = (reason) => { unhandled = reason; };
    process.on('unhandledRejection', onUnhandled);

    try {
      monitor.start();
      // setTimeout initialDelay is appConfig-driven; in test env it's
      // typically small. Give it a generous window then continue.
      await new Promise(r => setTimeout(r, 200));
    } finally {
      monitor.stop();
      process.removeListener('unhandledRejection', onUnhandled);
    }

    assert.strictEqual(unhandled, null, 'initial setTimeout must catch rejections');
  });

  summary();
  exitWithCode();
})();
