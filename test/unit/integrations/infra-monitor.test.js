/**
 * InfraMonitor Unit Tests
 *
 * Tests the infrastructure health probing, transition detection, self-heal,
 * and notification logic.
 *
 * Run: node test/unit/integrations/infra-monitor.test.js
 *
 * @module test/unit/integrations/infra-monitor
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

const InfraMonitor = require('../../../src/lib/integrations/infra-monitor');

// ============================================================
// Test Helpers
// ============================================================

const originalFetch = global.fetch;

function mockFetch(handler) {
  global.fetch = async (url, opts) => handler(url, opts);
}

function restoreFetch() {
  global.fetch = originalFetch;
}

function createAllUpHandler() {
  return async (url) => {
    if (url.includes('/api/tags')) {
      return { ok: true, json: async () => ({ models: [{ name: 'qwen3:8b' }] }) };
    }
    if (url.includes('/health')) {
      return { ok: true, json: async () => ({ status: 'ok' }) };
    }
    if (url.includes('/healthz')) {
      return { ok: true, json: async () => ({}) };
    }
    if (url.includes('/status.php')) {
      return { ok: true, json: async () => ({ installed: true, maintenance: false, versionstring: '28.0.0' }) };
    }
    if (url.includes('/api/ps')) {
      return { ok: true, json: async () => ({ models: [] }) };
    }
    if (url.includes('/api/generate')) {
      return { ok: true, json: async () => ({ response: '' }) };
    }
    return { ok: true, json: async () => ({}) };
  };
}

function createDefaultConfig(overrides = {}) {
  return {
    services: {
      ollama: { url: 'http://localhost:11434', selfHeal: 'ollama_reload' },
      whisper: { url: 'http://localhost:8178' },
      searxng: { url: 'http://localhost:8888' },
      nextcloud: { url: 'http://localhost:8080' }
    },
    checkInterval: 3,
    probeTimeoutMs: 5000,
    selfHealEnabled: true,
    notifyOnFailure: true,
    ollamaModel: 'qwen3:8b',
    notifyUser: null,
    auditLog: async () => {},
    ...overrides
  };
}

// ============================================================
// Tests
// ============================================================

console.log('InfraMonitor Unit Tests');
console.log('========================\n');

// --- Constructor ---

test('Constructor registers default probes from config', () => {
  const monitor = new InfraMonitor(createDefaultConfig());
  assert.strictEqual(monitor.probes.length, 4);
  const ids = monitor.probes.map(p => p.id);
  assert.ok(ids.includes('ollama'));
  assert.ok(ids.includes('whisper'));
  assert.ok(ids.includes('searxng'));
  assert.ok(ids.includes('nextcloud'));
});

test('Constructor registers only provided services', () => {
  const monitor = new InfraMonitor(createDefaultConfig({
    services: {
      ollama: { url: 'http://localhost:11434' },
      nextcloud: { url: 'http://localhost:8080' }
    }
  }));
  assert.strictEqual(monitor.probes.length, 2);
});

test('Constructor initializes state for each probe', () => {
  const monitor = new InfraMonitor(createDefaultConfig());
  assert.strictEqual(monitor.state.size, 4);
  for (const [, state] of monitor.state) {
    assert.strictEqual(state.status, 'unknown');
    assert.strictEqual(state.consecutiveFailures, 0);
  }
});

test('Constructor skips null service entries', () => {
  const monitor = new InfraMonitor(createDefaultConfig({
    services: {
      ollama: { url: 'http://localhost:11434' },
      whisper: null,
      searxng: null,
      nextcloud: { url: 'http://localhost:8080' }
    }
  }));
  assert.strictEqual(monitor.probes.length, 2);
});

// --- shouldCheck ---

test('shouldCheck() returns true on correct modulo', () => {
  const monitor = new InfraMonitor(createDefaultConfig({ checkInterval: 3 }));
  assert.strictEqual(monitor.shouldCheck(0), true);
  assert.strictEqual(monitor.shouldCheck(3), true);
  assert.strictEqual(monitor.shouldCheck(6), true);
  assert.strictEqual(monitor.shouldCheck(9), true);
});

test('shouldCheck() returns false on wrong modulo', () => {
  const monitor = new InfraMonitor(createDefaultConfig({ checkInterval: 3 }));
  assert.strictEqual(monitor.shouldCheck(1), false);
  assert.strictEqual(monitor.shouldCheck(2), false);
  assert.strictEqual(monitor.shouldCheck(4), false);
  assert.strictEqual(monitor.shouldCheck(5), false);
});

// --- checkAll ---

asyncTest('checkAll() all up — returns ok status', async () => {
  mockFetch(createAllUpHandler());
  try {
    const monitor = new InfraMonitor(createDefaultConfig());
    const result = await monitor.checkAll();
    assert.strictEqual(result.overall, 'ok');
    assert.ok(result.timestamp);
    assert.ok(result.services.ollama.ok);
    assert.ok(result.services.whisper.ok);
    assert.ok(result.services.searxng.ok);
    assert.ok(result.services.nextcloud.ok);
    assert.strictEqual(result.transitions.length, 4); // unknown -> up for each
  } finally {
    restoreFetch();
  }
});

asyncTest('checkAll() one down — returns degraded', async () => {
  mockFetch(async (url) => {
    if (url.includes('/healthz')) {
      throw new Error('Connection refused');
    }
    return createAllUpHandler()(url);
  });
  try {
    const monitor = new InfraMonitor(createDefaultConfig());
    const result = await monitor.checkAll();
    assert.strictEqual(result.overall, 'degraded');
    assert.strictEqual(result.services.searxng.ok, false);
    assert.ok(result.services.ollama.ok);
  } finally {
    restoreFetch();
  }
});

asyncTest('checkAll() all down — returns down', async () => {
  mockFetch(async () => { throw new Error('Connection refused'); });
  try {
    const monitor = new InfraMonitor(createDefaultConfig());
    const result = await monitor.checkAll();
    assert.strictEqual(result.overall, 'down');
    for (const [, svc] of Object.entries(result.services)) {
      assert.strictEqual(svc.ok, false);
    }
  } finally {
    restoreFetch();
  }
});

// --- Transition detection ---

asyncTest('Transition detection: up to down', async () => {
  mockFetch(createAllUpHandler());
  const monitor = new InfraMonitor(createDefaultConfig());

  // First run: all up
  try {
    await monitor.checkAll();
  } finally {
    restoreFetch();
  }

  // Second run: searxng down
  mockFetch(async (url) => {
    if (url.includes('/healthz')) throw new Error('Connection refused');
    return createAllUpHandler()(url);
  });
  try {
    const result = await monitor.checkAll();
    const downTransition = result.transitions.find(t => t.service === 'searxng' && t.to === 'down');
    assert.ok(downTransition, 'Should detect searxng going down');
    assert.strictEqual(downTransition.from, 'up');
  } finally {
    restoreFetch();
  }
});

asyncTest('Transition detection: down to up recovery', async () => {
  // First run: all down
  mockFetch(async () => { throw new Error('Connection refused'); });
  const monitor = new InfraMonitor(createDefaultConfig());
  try {
    await monitor.checkAll();
  } finally {
    restoreFetch();
  }

  // Second run: all up
  mockFetch(createAllUpHandler());
  try {
    const result = await monitor.checkAll();
    const recoveryTransitions = result.transitions.filter(t => t.to === 'up');
    assert.strictEqual(recoveryTransitions.length, 4, 'All 4 services should recover');
    for (const t of recoveryTransitions) {
      assert.strictEqual(t.from, 'down');
    }
  } finally {
    restoreFetch();
  }
});

// --- Notification tests ---

asyncTest('No notification on first run (unknown to up)', async () => {
  mockFetch(createAllUpHandler());
  const notifications = [];
  const notifyUser = async (n) => notifications.push(n);
  const monitor = new InfraMonitor(createDefaultConfig({ notifyUser }));

  try {
    await monitor.checkAll();
    assert.strictEqual(notifications.length, 0, 'Should not notify on unknown->up');
  } finally {
    restoreFetch();
  }
});

asyncTest('Notification sent on unknown to down (service already broken)', async () => {
  mockFetch(async () => { throw new Error('Connection refused'); });
  const notifications = [];
  const notifyUser = async (n) => notifications.push(n);
  const monitor = new InfraMonitor(createDefaultConfig({ notifyUser }));

  try {
    await monitor.checkAll();
    assert.ok(notifications.length > 0, 'Should notify on unknown->down');
  } finally {
    restoreFetch();
  }
});

asyncTest('Notification sent on up to down', async () => {
  mockFetch(createAllUpHandler());
  const notifications = [];
  const notifyUser = async (n) => notifications.push(n);
  const monitor = new InfraMonitor(createDefaultConfig({ notifyUser }));

  // First: all up
  try {
    await monitor.checkAll();
  } finally {
    restoreFetch();
  }

  // Second: ollama down
  mockFetch(async (url) => {
    if (url.includes('/api/tags')) throw new Error('Connection refused');
    if (url.includes('/api/generate')) throw new Error('Connection refused');
    return createAllUpHandler()(url);
  });
  try {
    notifications.length = 0;
    await monitor.checkAll();
    const downNotify = notifications.find(n => n.message.includes('Local AI'));
    assert.ok(downNotify, 'Should send down notification for ollama');
  } finally {
    restoreFetch();
  }
});

asyncTest('Notification sent on down to up (recovery)', async () => {
  // First: all down
  mockFetch(async () => { throw new Error('Connection refused'); });
  const notifications = [];
  const notifyUser = async (n) => notifications.push(n);
  const monitor = new InfraMonitor(createDefaultConfig({ notifyUser }));
  try {
    await monitor.checkAll();
  } finally {
    restoreFetch();
  }

  // Second: all up
  mockFetch(createAllUpHandler());
  try {
    notifications.length = 0;
    await monitor.checkAll();
    const recoveryNotify = notifications.find(n => n.message.includes('back online'));
    assert.ok(recoveryNotify, 'Should send recovery notification');
  } finally {
    restoreFetch();
  }
});

asyncTest('1-hour notification cooldown', async () => {
  mockFetch(createAllUpHandler());
  const notifications = [];
  const notifyUser = async (n) => notifications.push(n);
  const monitor = new InfraMonitor(createDefaultConfig({ notifyUser }));

  // First: all up
  try { await monitor.checkAll(); } finally { restoreFetch(); }

  // Second: searxng down
  mockFetch(async (url) => {
    if (url.includes('/healthz')) throw new Error('Connection refused');
    return createAllUpHandler()(url);
  });
  try {
    notifications.length = 0;
    await monitor.checkAll();
    const firstNotifyCount = notifications.length;
    assert.ok(firstNotifyCount > 0, 'First down should notify');

    // Third: still down (within cooldown)
    notifications.length = 0;
    // Manually set state back to up so transition fires again
    monitor.state.set('searxng', { status: 'up', lastCheck: null, consecutiveFailures: 0 });
    await monitor.checkAll();

    // Should be suppressed by cooldown
    const searxngNotifies = notifications.filter(n => n.message.includes('search'));
    assert.strictEqual(searxngNotifies.length, 0, 'Should not re-notify within cooldown');
  } finally {
    restoreFetch();
  }
});

// --- Self-heal tests ---

asyncTest('Self-heal triggered for ollama', async () => {
  let selfHealCalled = false;
  mockFetch(async (url) => {
    if (url.includes('/api/tags')) throw new Error('Connection refused');
    return createAllUpHandler()(url);
  });
  const monitor = new InfraMonitor(createDefaultConfig());

  // Spy on _selfHealOllama instead of relying on fetch mock (avoids async test interference)
  const originalHeal = monitor._selfHealOllama.bind(monitor);
  monitor._selfHealOllama = async (model) => {
    selfHealCalled = true;
    return true;
  };

  // Set ollama to up state so transition up→down is detected
  monitor.state.set('ollama', { status: 'up', lastCheck: null, consecutiveFailures: 0 });
  monitor._hasRunBefore = true;

  try {
    const result = await monitor.checkAll();
    assert.ok(selfHealCalled, 'Should attempt self-heal for ollama');
    assert.ok(result.selfHealAttempts.length > 0, 'Should record self-heal attempt');
    assert.strictEqual(result.selfHealAttempts[0].service, 'ollama');
    assert.strictEqual(result.selfHealAttempts[0].success, true);
  } finally {
    restoreFetch();
  }
});

asyncTest('Self-heal NOT triggered for whisper', async () => {
  let selfHealCalled = false;
  mockFetch(async (url) => {
    if (url.includes('/health')) throw new Error('Connection refused');
    return createAllUpHandler()(url);
  });
  const monitor = new InfraMonitor(createDefaultConfig());

  // Spy on _selfHealOllama to track if it's called for wrong service
  monitor._selfHealOllama = async () => { selfHealCalled = true; return true; };

  // Set whisper to up first
  monitor.state.set('whisper', { status: 'up', lastCheck: null, consecutiveFailures: 0 });
  monitor._hasRunBefore = true;

  try {
    const result = await monitor.checkAll();
    // selfHeal should NOT trigger for whisper (no selfHeal config on whisper probe)
    const whisperHeal = result.selfHealAttempts.find(a => a.service === 'whisper');
    assert.ok(!whisperHeal, 'Should NOT self-heal whisper');
  } finally {
    restoreFetch();
  }
});

asyncTest('_selfHealOllama() success', async () => {
  mockFetch(async () => ({ ok: true, json: async () => ({ response: '' }) }));
  const monitor = new InfraMonitor(createDefaultConfig());
  try {
    const result = await monitor._selfHealOllama('qwen3:8b');
    assert.strictEqual(result, true);
  } finally {
    restoreFetch();
  }
});

asyncTest('_selfHealOllama() failure', async () => {
  mockFetch(async () => { throw new Error('Connection refused'); });
  const monitor = new InfraMonitor(createDefaultConfig());
  try {
    await monitor._selfHealOllama('qwen3:8b');
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err.message.includes('Connection refused'));
  } finally {
    restoreFetch();
  }
});

// --- System stats ---

test('getSystemStats() returns correct shape', async () => {
  const monitor = new InfraMonitor(createDefaultConfig());
  // This test runs on Linux CI so /proc should exist
  const stats = await monitor.getSystemStats();
  assert.ok(typeof stats === 'object');
  assert.ok('ramUsedPct' in stats);
  assert.ok('diskUsedPct' in stats);
  assert.ok('uptimeDays' in stats);
});

asyncTest('getOllamaStats() returns models on success', async () => {
  mockFetch(async () => ({ ok: true, json: async () => ({ models: [{ name: 'qwen3:8b' }] }) }));
  const monitor = new InfraMonitor(createDefaultConfig());
  try {
    const stats = await monitor.getOllamaStats();
    assert.ok(stats);
    assert.ok(Array.isArray(stats.models));
    assert.strictEqual(stats.models.length, 1);
  } finally {
    restoreFetch();
  }
});

asyncTest('getOllamaStats() returns null on failure', async () => {
  mockFetch(async () => { throw new Error('Connection refused'); });
  const monitor = new InfraMonitor(createDefaultConfig());
  try {
    const stats = await monitor.getOllamaStats();
    assert.strictEqual(stats, null);
  } finally {
    restoreFetch();
  }
});

// --- getSummary ---

test('getSummary() builds correct shape', () => {
  const monitor = new InfraMonitor(createDefaultConfig());
  const summary = monitor.getSummary();
  assert.ok(summary.services);
  assert.ok('overall' in summary);
  assert.strictEqual(summary.overall, 'unknown'); // No checks run yet
  assert.ok(summary.services.ollama);
  assert.strictEqual(summary.services.ollama.status, 'unknown');
});

// --- Nextcloud maintenance ---

asyncTest('Nextcloud maintenance mode detected', async () => {
  mockFetch(async (url) => {
    if (url.includes('/status.php')) {
      return { ok: true, json: async () => ({ installed: true, maintenance: true, versionstring: '28.0.0' }) };
    }
    return createAllUpHandler()(url);
  });
  const monitor = new InfraMonitor(createDefaultConfig());
  try {
    const result = await monitor.checkAll();
    assert.strictEqual(result.services.nextcloud.ok, false);
    assert.ok(result.services.nextcloud.error.includes('Maintenance'));
  } finally {
    restoreFetch();
  }
});

// --- Probe timeout ---

asyncTest('Probe timeout handling', async () => {
  mockFetch(async (url, opts) => {
    // Simulate the AbortController aborting
    if (opts?.signal) {
      // Check if already aborted
      if (opts.signal.aborted) throw new DOMException('The operation was aborted', 'AbortError');
    }
    // For a real timeout test, we create a monitor with very short timeout
    // and simulate by throwing AbortError
    const err = new DOMException('The operation was aborted', 'AbortError');
    err.name = 'AbortError';
    throw err;
  });
  const monitor = new InfraMonitor(createDefaultConfig({ probeTimeoutMs: 1 }));
  try {
    const result = await monitor.checkAll();
    // All probes should be down with 'Timeout' error
    for (const [, svc] of Object.entries(result.services)) {
      assert.strictEqual(svc.ok, false);
      assert.strictEqual(svc.error, 'Timeout');
    }
  } finally {
    restoreFetch();
  }
});

// ============================================================
// Summary
// ============================================================

setTimeout(() => {
  summary();
  exitWithCode();
}, 3000);
