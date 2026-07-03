'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const { ObservationLog, OBSERVATION_TYPES } = require('../../../src/lib/maintenance/observation-log');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

// ---------------------------------------------------------------------------
// Test 1: notice() with a valid observation adds to log with timestamp
// ---------------------------------------------------------------------------
test('notice() with valid observation adds entry with timestamp', () => {
  const log = new ObservationLog({ logger: silentLogger });
  const before = Date.now();

  log.notice({ type: OBSERVATION_TYPES.CONTRADICTION, cluster: 'People', page: 'Carlos' });

  assert.strictEqual(log.size(), 1);
  const entry = log._observations[0];
  assert.strictEqual(entry.type, OBSERVATION_TYPES.CONTRADICTION);
  assert.strictEqual(entry.cluster, 'People');
  assert.strictEqual(entry.page, 'Carlos');
  assert.ok(entry.timestamp >= before, 'timestamp should be at or after before');
  assert.ok(entry.timestamp <= Date.now(), 'timestamp should be at or before now');
  assert.strictEqual(entry.resolved, false);
});

// ---------------------------------------------------------------------------
// Test 2: notice() with null/undefined is a silent no-op
// ---------------------------------------------------------------------------
test('notice() with null/undefined is silent no-op', () => {
  const log = new ObservationLog({ logger: silentLogger });

  // Neither should throw, neither should add anything
  assert.doesNotThrow(() => log.notice(null));
  assert.doesNotThrow(() => log.notice(undefined));
  assert.strictEqual(log.size(), 0);
});

// ---------------------------------------------------------------------------
// Test 3: notice() with missing type is a silent no-op (logs debug warn)
// ---------------------------------------------------------------------------
test('notice() with missing type is a silent no-op', () => {
  const warnings = [];
  const logger = {
    debug(msg) { warnings.push(msg); },
    info() {}, warn() {}, error() {}
  };

  const log = new ObservationLog({ logger });
  log.notice({ cluster: 'People', page: 'Carlos' }); // no type

  assert.strictEqual(log.size(), 0, 'nothing should be added without a type');
  // The source calls logger.debug for missing type
  assert.ok(warnings.length > 0, 'a debug message should have been emitted');
});

// ---------------------------------------------------------------------------
// Test 4: notice() with unknown type accepts the entry but warns
// ---------------------------------------------------------------------------
test('notice() with unknown type is accepted and warns', () => {
  const warnings = [];
  const logger = {
    debug() {}, info() {},
    warn(msg) { warnings.push(msg); },
    error() {}
  };

  const log = new ObservationLog({ logger });
  log.notice({ type: 'totally_unknown_type', cluster: 'Alpha' });

  // Accepted (size 1) — a bug-hunting signal, not a crash
  assert.strictEqual(log.size(), 1, 'unknown type observation should still be logged');
  assert.ok(warnings.some(w => w.includes('totally_unknown_type')), 'should warn about unknown type');
});

// ---------------------------------------------------------------------------
// Test 5a: getByType() filters by single type
// Test 5b: getByType() filters by array of types
// ---------------------------------------------------------------------------
test('getByType() filters by single type and by type array', () => {
  const log = new ObservationLog({ logger: silentLogger });

  log.notice({ type: OBSERVATION_TYPES.CONTRADICTION, cluster: 'Alpha' });
  log.notice({ type: OBSERVATION_TYPES.GAP, cluster: 'Alpha' });
  log.notice({ type: OBSERVATION_TYPES.GAP, cluster: 'Beta' });
  log.notice({ type: OBSERVATION_TYPES.STALE_CONTENT, cluster: 'Alpha' });

  // Single type
  const contradictions = log.getByType(OBSERVATION_TYPES.CONTRADICTION);
  assert.strictEqual(contradictions.length, 1);
  assert.strictEqual(contradictions[0].type, OBSERVATION_TYPES.CONTRADICTION);

  // Array of types
  const both = log.getByType([OBSERVATION_TYPES.CONTRADICTION, OBSERVATION_TYPES.GAP]);
  assert.strictEqual(both.length, 3);
  assert.ok(both.every(o => [OBSERVATION_TYPES.CONTRADICTION, OBSERVATION_TYPES.GAP].includes(o.type)));
});

// ---------------------------------------------------------------------------
// Test 6: getByType() excludes resolved observations
// ---------------------------------------------------------------------------
test('getByType() excludes resolved observations', () => {
  const log = new ObservationLog({ logger: silentLogger });

  log.notice({ type: OBSERVATION_TYPES.CONTRADICTION, cluster: 'Alpha' });
  log.notice({ type: OBSERVATION_TYPES.CONTRADICTION, cluster: 'Beta' });

  // Resolve one
  log.resolve('Alpha', OBSERVATION_TYPES.CONTRADICTION);

  const results = log.getByType(OBSERVATION_TYPES.CONTRADICTION);
  assert.strictEqual(results.length, 1, 'resolved observation should be excluded');
  assert.strictEqual(results[0].cluster, 'Beta');
});

// ---------------------------------------------------------------------------
// Test 7: getByType() excludes expired observations
// ---------------------------------------------------------------------------
asyncTest('getByType() excludes expired observations after maxAgeMs', async () => {
  const log = new ObservationLog({ maxAgeMs: 20, logger: silentLogger });

  log.notice({ type: OBSERVATION_TYPES.GAP, cluster: 'Alpha' });
  assert.strictEqual(log.getByType(OBSERVATION_TYPES.GAP).length, 1, 'should be visible before expiry');

  await new Promise(resolve => setTimeout(resolve, 30));

  const results = log.getByType(OBSERVATION_TYPES.GAP);
  assert.strictEqual(results.length, 0, 'should be excluded after maxAgeMs');
});

// ---------------------------------------------------------------------------
// Test 8: getNeediest() returns clusters sorted by unresolved count desc
// ---------------------------------------------------------------------------
test('getNeediest() returns clusters sorted descending by count', () => {
  const log = new ObservationLog({ logger: silentLogger });

  // Alpha: 3 observations, Beta: 1, Gamma: 2
  log.notice({ type: OBSERVATION_TYPES.CONTRADICTION, cluster: 'Alpha' });
  log.notice({ type: OBSERVATION_TYPES.GAP,           cluster: 'Alpha' });
  log.notice({ type: OBSERVATION_TYPES.STALE_CONTENT, cluster: 'Alpha' });
  log.notice({ type: OBSERVATION_TYPES.MISSING_LINK,  cluster: 'Beta' });
  log.notice({ type: OBSERVATION_TYPES.ORPHAN_PAGE,   cluster: 'Gamma' });
  log.notice({ type: OBSERVATION_TYPES.UNEMBEDDED,    cluster: 'Gamma' });

  const neediest = log.getNeediest();
  assert.ok(Array.isArray(neediest));
  assert.strictEqual(neediest[0].cluster, 'Alpha');
  assert.strictEqual(neediest[0].count, 3);
  assert.strictEqual(neediest[1].cluster, 'Gamma');
  assert.strictEqual(neediest[1].count, 2);
  assert.strictEqual(neediest[2].cluster, 'Beta');
  assert.strictEqual(neediest[2].count, 1);
});

// ---------------------------------------------------------------------------
// Test 9: resolve() marks matching observations as resolved; idempotent
// ---------------------------------------------------------------------------
test('resolve() marks observations resolved and is idempotent', () => {
  const log = new ObservationLog({ logger: silentLogger });

  log.notice({ type: OBSERVATION_TYPES.CONTRADICTION, cluster: 'Alpha' });
  log.notice({ type: OBSERVATION_TYPES.CONTRADICTION, cluster: 'Alpha' });
  log.notice({ type: OBSERVATION_TYPES.GAP,           cluster: 'Alpha' });
  log.notice({ type: OBSERVATION_TYPES.CONTRADICTION, cluster: 'Beta' });

  const count = log.resolve('Alpha', OBSERVATION_TYPES.CONTRADICTION);
  assert.strictEqual(count, 2, 'should resolve 2 contradiction observations for Alpha');

  // The GAP in Alpha and the CONTRADICTION in Beta should be untouched
  const remaining = log.getByType([OBSERVATION_TYPES.CONTRADICTION, OBSERVATION_TYPES.GAP]);
  assert.strictEqual(remaining.length, 2, 'Beta contradiction + Alpha gap should remain');

  // Idempotent: second call returns 0
  const count2 = log.resolve('Alpha', OBSERVATION_TYPES.CONTRADICTION);
  assert.strictEqual(count2, 0, 'second resolve call should return 0 — already resolved');
});

// ---------------------------------------------------------------------------
// Test 10: prune() drops expired observations and returns { dropped: N }
// ---------------------------------------------------------------------------
asyncTest('prune() drops expired observations and returns dropped count', async () => {
  const log = new ObservationLog({ maxAgeMs: 20, logger: silentLogger });

  log.notice({ type: OBSERVATION_TYPES.GAP, cluster: 'Alpha' });
  log.notice({ type: OBSERVATION_TYPES.GAP, cluster: 'Beta' });
  assert.strictEqual(log.size(), 2);

  await new Promise(resolve => setTimeout(resolve, 30));

  // Add one fresh observation so we can verify it's NOT dropped
  log.notice({ type: OBSERVATION_TYPES.ORPHAN_PAGE, cluster: 'Gamma' });
  assert.strictEqual(log.size(), 3);

  const { dropped } = log.prune();
  assert.strictEqual(dropped, 2, 'should drop the two expired observations');
  assert.strictEqual(log.size(), 1, 'only the fresh observation should remain');
  assert.strictEqual(log._observations[0].cluster, 'Gamma');
});

// ---------------------------------------------------------------------------
// Test 11: size() reports current observation count including resolved
// ---------------------------------------------------------------------------
test('size() reports total current count including resolved observations', () => {
  const log = new ObservationLog({ logger: silentLogger });

  assert.strictEqual(log.size(), 0);
  log.notice({ type: OBSERVATION_TYPES.CONTRADICTION, cluster: 'Alpha' });
  log.notice({ type: OBSERVATION_TYPES.GAP, cluster: 'Beta' });
  assert.strictEqual(log.size(), 2);

  log.resolve('Alpha', OBSERVATION_TYPES.CONTRADICTION);
  // Resolved observations remain in the log until prune() — size should still be 2
  assert.strictEqual(log.size(), 2, 'resolved observations should still count toward size() until pruned');
});

// ---------------------------------------------------------------------------
// Test 12: resolve() optional pages filter (Phase 2 — page-granular resolution)
// ---------------------------------------------------------------------------
test('resolve() with pages filter transitions only matching pages; omitting keeps wholesale behavior', () => {
  const log = new ObservationLog({ logger: silentLogger });
  log.notice({ type: OBSERVATION_TYPES.MISSING_LINK, cluster: 'Alpha', page: 'Page A' });
  log.notice({ type: OBSERVATION_TYPES.MISSING_LINK, cluster: 'Alpha', page: 'Page A' });
  log.notice({ type: OBSERVATION_TYPES.MISSING_LINK, cluster: 'Alpha', page: 'Page B' });
  log.notice({ type: OBSERVATION_TYPES.GAP,          cluster: 'Alpha', page: 'Page B' });

  const count = log.resolve('Alpha', OBSERVATION_TYPES.MISSING_LINK, ['Page A']);
  assert.strictEqual(count, 2, 'only Page A missing_link observations transition');
  assert.strictEqual(log.getByType(OBSERVATION_TYPES.MISSING_LINK).length, 1, 'Page B remains pending');
  assert.strictEqual(log.getByType(OBSERVATION_TYPES.GAP).length, 1, 'other types untouched');

  // Backward compatible: omitting pages resolves the rest of the type wholesale.
  const rest = log.resolve('Alpha', OBSERVATION_TYPES.MISSING_LINK);
  assert.strictEqual(rest, 1, 'wholesale call resolves the remaining Page B observation');
});

test('resolve() pages filter accepts a single page string', () => {
  const log = new ObservationLog({ logger: silentLogger });
  log.notice({ type: OBSERVATION_TYPES.UNEMBEDDED, cluster: 'Alpha', page: 'Solo' });
  log.notice({ type: OBSERVATION_TYPES.UNEMBEDDED, cluster: 'Alpha', page: 'Other' });
  assert.strictEqual(log.resolve('Alpha', OBSERVATION_TYPES.UNEMBEDDED, 'Solo'), 1);
  assert.strictEqual(log.getByType(OBSERVATION_TYPES.UNEMBEDDED).length, 1);
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
