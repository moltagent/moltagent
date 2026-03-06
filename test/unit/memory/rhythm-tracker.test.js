'use strict';
// Mock type: LEGACY — TODO: migrate to realistic mocks

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const RhythmTracker = require('../../../src/lib/memory/rhythm-tracker');

const silentLogger = { log() {}, info() {}, warn() {}, error() {} };

function createMockFilesClient(initialData = null) {
  let stored = initialData;
  return {
    readFile: async (path) => {
      if (!stored) throw new Error('404');
      return { content: stored, truncated: false, totalSize: stored.length };
    },
    writeFile: async (path, content) => {
      stored = content;
      return { success: true };
    },
    getStored: () => stored
  };
}

/**
 * Build a complete session meta object with sensible defaults.
 */
function makeSession(overrides = {}) {
  return Object.assign({
    startTime:      new Date().toISOString(),
    endTime:        new Date().toISOString(),
    duration:       120,
    messageCount:   10,
    directiveRatio: 0.5,
    topicDiversity: 0.3,
    roomName:       'general'
  }, overrides);
}

// TC-RT-01: recordSession() appends session entry
asyncTest('TC-RT-01: recordSession() appends session entry', async () => {
  const tracker = new RhythmTracker({
    ncFilesClient: createMockFilesClient(),
    logger: silentLogger
  });
  tracker._loaded = true;

  await tracker.recordSession(makeSession());

  assert.strictEqual(tracker._sessions.length, 1, 'Should have 1 session after record');
});

// TC-RT-02: recordSession() normalizes fields from sessionMeta correctly
asyncTest('TC-RT-02: recordSession() normalizes fields correctly', async () => {
  const tracker = new RhythmTracker({
    ncFilesClient: createMockFilesClient(),
    logger: silentLogger
  });
  tracker._loaded = true;

  const meta = makeSession({
    startTime:      '2026-03-01T09:00:00Z',
    endTime:        '2026-03-01T09:15:00Z',
    duration:       900,
    messageCount:   25,
    directiveRatio: 0.6,
    topicDiversity: 0.4,
    roomName:       'engineering'
  });

  await tracker.recordSession(meta);

  const entry = tracker._sessions[0];
  assert.strictEqual(entry.startTime,      '2026-03-01T09:00:00Z', 'startTime should be preserved');
  assert.strictEqual(entry.endTime,        '2026-03-01T09:15:00Z', 'endTime should be preserved');
  assert.strictEqual(entry.duration,       900,                     'duration should be preserved');
  assert.strictEqual(entry.messageCount,   25,                      'messageCount should be preserved');
  assert.strictEqual(entry.directiveRatio, 0.6,                     'directiveRatio should be preserved');
  assert.strictEqual(entry.topicDiversity, 0.4,                     'topicDiversity should be preserved');
  assert.strictEqual(entry.roomName,       'engineering',           'roomName should be preserved');
  assert.ok(entry.recordedAt, 'recordedAt should be set automatically');
});

// TC-RT-03: getPatterns() returns peak hour averages
asyncTest('TC-RT-03: getPatterns() returns peak hours sorted by frequency', async () => {
  const tracker = new RhythmTracker({
    ncFilesClient: createMockFilesClient(),
    logger: silentLogger
  });
  tracker._loaded = true;

  // 2 sessions at hour 9, 1 session at hour 14, 1 session at hour 20
  const makeAtHour = (h) => {
    const d = new Date();
    d.setHours(h, 0, 0, 0);
    return makeSession({ startTime: d.toISOString(), recordedAt: new Date().toISOString() });
  };

  await tracker.recordSession(makeAtHour(9));
  await tracker.recordSession(makeAtHour(9));
  await tracker.recordSession(makeAtHour(14));
  await tracker.recordSession(makeAtHour(20));

  const patterns = await tracker.getPatterns(30);

  assert.ok(Array.isArray(patterns.peakHours), 'peakHours should be an array');
  assert.ok(patterns.peakHours.length >= 1, 'Should have at least one peak hour');
  // Hour 9 appears twice — should rank first
  assert.strictEqual(patterns.peakHours[0], 9, 'Peak hour should be 9 (most frequent)');
  assert.strictEqual(patterns.sessionCount, 4, 'Session count should be 4');
});

// TC-RT-04: getPatterns() returns directive tendency ratio
asyncTest('TC-RT-04: getPatterns() returns correct directiveTendency ratio', async () => {
  const tracker = new RhythmTracker({
    ncFilesClient: createMockFilesClient(),
    logger: silentLogger
  });
  tracker._loaded = true;

  await tracker.recordSession(makeSession({ directiveRatio: 0.8 }));
  await tracker.recordSession(makeSession({ directiveRatio: 0.2 }));

  const patterns = await tracker.getPatterns(30);

  // Average: (0.8 + 0.2) / 2 = 0.5
  assert.ok(
    Math.abs(patterns.directiveTendency - 0.5) < 0.0001,
    `directiveTendency should be ~0.5, got ${patterns.directiveTendency}`
  );
});

// TC-RT-05: getPatterns() respects days parameter — 40-day-old session excluded
asyncTest('TC-RT-05: getPatterns() respects days parameter', async () => {
  const tracker = new RhythmTracker({
    ncFilesClient: createMockFilesClient(),
    logger: silentLogger
  });
  tracker._loaded = true;

  // Session recorded 40 days ago — should be excluded by 30-day window
  const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
  tracker._sessions.push({
    startTime:      oldDate,
    endTime:        oldDate,
    duration:       300,
    messageCount:   5,
    directiveRatio: 0.9,
    topicDiversity: 0.9,
    roomName:       'general',
    recordedAt:     oldDate
  });

  // Session recorded today — should be included
  await tracker.recordSession(makeSession({ directiveRatio: 0.2 }));

  const patterns = await tracker.getPatterns(30);

  assert.strictEqual(patterns.sessionCount, 1, 'Only 1 session should be in 30-day window');
  assert.ok(
    Math.abs(patterns.directiveTendency - 0.2) < 0.0001,
    `directiveTendency should reflect only recent session (0.2), got ${patterns.directiveTendency}`
  );
});

// TC-RT-06: rolling 90-day window prunes old entries on _save()
asyncTest('TC-RT-06: rolling 90-day window prunes old entries on _save()', async () => {
  const client = createMockFilesClient();
  const tracker = new RhythmTracker({ ncFilesClient: client, logger: silentLogger });
  tracker._loaded = true;

  // Inject a session recorded 95 days ago
  const veryOldDate = new Date(Date.now() - 95 * 24 * 60 * 60 * 1000).toISOString();
  tracker._sessions.push({
    startTime:      veryOldDate,
    endTime:        veryOldDate,
    duration:       60,
    messageCount:   2,
    directiveRatio: 0.1,
    topicDiversity: 0.1,
    roomName:       'general',
    recordedAt:     veryOldDate
  });

  // Also add a current session
  tracker._sessions.push({
    startTime:      new Date().toISOString(),
    endTime:        new Date().toISOString(),
    duration:       60,
    messageCount:   2,
    directiveRatio: 0.5,
    topicDiversity: 0.5,
    roomName:       'general',
    recordedAt:     new Date().toISOString()
  });

  tracker._dirty = true;
  await tracker._save();

  // _sessions should have been pruned in-place
  assert.strictEqual(tracker._sessions.length, 1, 'Old session should be pruned after _save()');
  assert.ok(
    tracker._sessions[0].recordedAt !== veryOldDate,
    'Remaining session should be the recent one'
  );

  // Verify the persisted JSON also excludes the old entry
  const saved = JSON.parse(client.getStored());
  assert.strictEqual(saved.length, 1, 'Persisted JSON should also have only 1 session');
});

// TC-RT-07: tick() persists buffer when dirty
asyncTest('TC-RT-07: tick() persists buffer when dirty', async () => {
  const client = createMockFilesClient();
  const tracker = new RhythmTracker({ ncFilesClient: client, logger: silentLogger });
  tracker._loaded = true;

  await tracker.recordSession(makeSession());

  // _dirty should be true after recordSession
  assert.strictEqual(tracker._dirty, true, '_dirty should be true after recordSession');
  assert.strictEqual(client.getStored(), null, 'Nothing written yet before tick()');

  await tracker.tick();

  assert.strictEqual(tracker._dirty, false, '_dirty should be false after tick()');
  assert.ok(client.getStored() !== null, 'tick() should have persisted the session data');
  const saved = JSON.parse(client.getStored());
  assert.ok(Array.isArray(saved), 'Saved data should be a JSON array');
  assert.strictEqual(saved.length, 1, 'Saved array should contain 1 session');
});

// TC-RT-08: _load()/_save() round-trips through mock ncFilesClient
asyncTest('TC-RT-08: _load()/_save() round-trips through mock ncFilesClient', async () => {
  const client = createMockFilesClient();

  // First tracker: record and save
  const tracker1 = new RhythmTracker({ ncFilesClient: client, logger: silentLogger });
  tracker1._loaded = true;

  await tracker1.recordSession(makeSession({
    duration:     600,
    messageCount: 42,
    roomName:     'test-room'
  }));

  tracker1._dirty = true;
  await tracker1._save();

  assert.ok(client.getStored() !== null, 'Should have persisted data');

  // Second tracker: load from the same client
  const tracker2 = new RhythmTracker({ ncFilesClient: client, logger: silentLogger });
  await tracker2._load();

  assert.strictEqual(tracker2._sessions.length, 1, 'Should load 1 session');
  assert.strictEqual(tracker2._sessions[0].messageCount, 42, 'messageCount should be preserved');
  assert.strictEqual(tracker2._sessions[0].roomName, 'test-room', 'roomName should be preserved');
  assert.strictEqual(tracker2._sessions[0].duration, 600, 'duration should be preserved');
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
