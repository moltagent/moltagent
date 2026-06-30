'use strict';

/**
 * Tests for WorkflowEngine._resolveSchedulingConfig (Part 1 / #188).
 *
 * Covers:
 *   - HOURS / TIMEZONE / SLOT_DURATION parsed from a CONFIG card description
 *   - Fallback chain: stack CONFIG present/absent, WORKFLOW card fallback,
 *     system tz fallback, code defaults
 *   - Invalid/missing values handled gracefully (no throw)
 */

const assert = require('assert');
const { test, summary, exitWithCode } = require('../../helpers/test-runner');
const WorkflowEngine = require('../../../src/lib/workflows/workflow-engine');

// ---------------------------------------------------------------------------
// Minimal factory helpers (mirrors existing workflow-engine.test.js style)
// ---------------------------------------------------------------------------

function createMockDeck() {
  return {
    getComments: async () => [],
    addComment: async () => {},
    username: 'moltagent'
  };
}

function createMockAgentLoop() {
  return { processWorkflowTask: async () => 'done' };
}

function createMockDetector(boards = []) {
  return {
    getWorkflowBoards: async () => boards,
    invalidateCache: () => {}
  };
}

function createEngine() {
  return new WorkflowEngine({
    workflowDetector: createMockDetector([]),
    deckClient: createMockDeck(),
    agentLoop: createMockAgentLoop(),
    talkSendQueue: { enqueue: async () => {} },
    talkToken: 'tok'
  });
}

/**
 * Build a minimal stack with an optional CONFIG card description.
 * CONFIG cards have a title matching /^CONFIG:/i and are otherwise plain objects.
 */
function makeStack(configDesc) {
  const cards = [];
  if (configDesc !== undefined) {
    cards.push({
      id: 1,
      title: 'CONFIG: test',
      description: configDesc,
      labels: [{ title: 'System' }],
      archived: false
    });
  }
  return { id: 10, title: 'Researching', cards };
}

/**
 * Build a minimal workflow board descriptor (wb) with the given plain description.
 */
function makeWb(plainDescription = '') {
  return { _plainDescription: plainDescription };
}

// ---------------------------------------------------------------------------
// Part 1 tests
// ---------------------------------------------------------------------------

const engine = createEngine();

// ── Happy path: full marker set from stack CONFIG card ──────────────────────

test('parses HOURS from stack CONFIG card', () => {
  const stack = makeStack('LLM: cloud\nHOURS: Mon-Fri 09:00-17:00\nTIMEZONE: Europe/Lisbon\nSLOT_DURATION: 30');
  const cfg = engine._resolveSchedulingConfig(makeWb(), stack);
  assert.ok(cfg.hours, 'hours should be present');
  assert.deepStrictEqual([...cfg.hours.days].sort(), [1, 2, 3, 4, 5]);
  assert.strictEqual(cfg.hours.startMinutes, 9 * 60);
  assert.strictEqual(cfg.hours.endMinutes, 17 * 60);
  assert.strictEqual(cfg.hoursExplicit, true);
});

test('parses TIMEZONE from stack CONFIG card', () => {
  const stack = makeStack('HOURS: Mon-Fri 09:00-17:00\nTIMEZONE: America/New_York');
  const cfg = engine._resolveSchedulingConfig(makeWb(), stack);
  assert.strictEqual(cfg.timezone, 'America/New_York');
});

test('parses SLOT_DURATION from stack CONFIG card', () => {
  const stack = makeStack('HOURS: Mon-Fri 09:00-17:00\nSLOT_DURATION: 45');
  const cfg = engine._resolveSchedulingConfig(makeWb(), stack);
  assert.strictEqual(cfg.slotDuration, 45);
});

// ── Fallback to board WORKFLOW card when stack CONFIG absent ─────────────────

test('falls back HOURS to board WORKFLOW card when no stack CONFIG', () => {
  const stack = makeStack(); // no CONFIG card
  const wb    = makeWb('HOURS: Tue-Thu 10:00-15:00\nSLOT_DURATION: 60');
  const cfg   = engine._resolveSchedulingConfig(wb, stack);
  assert.deepStrictEqual([...cfg.hours.days].sort(), [2, 3, 4]);
  assert.strictEqual(cfg.hours.startMinutes, 10 * 60);
  assert.strictEqual(cfg.hours.endMinutes,   15 * 60);
  assert.strictEqual(cfg.hoursExplicit, true);
});

test('falls back TIMEZONE to board WORKFLOW card when stack CONFIG absent', () => {
  const stack = makeStack();
  const wb    = makeWb('TIMEZONE: Asia/Tokyo');
  const cfg   = engine._resolveSchedulingConfig(wb, stack);
  assert.strictEqual(cfg.timezone, 'Asia/Tokyo');
});

test('falls back SLOT_DURATION to board WORKFLOW card when stack CONFIG absent', () => {
  const stack = makeStack();
  const wb    = makeWb('SLOT_DURATION: 90');
  const cfg   = engine._resolveSchedulingConfig(wb, stack);
  assert.strictEqual(cfg.slotDuration, 90);
});

// ── Stack CONFIG takes precedence over board WORKFLOW ────────────────────────

test('stack CONFIG HOURS overrides board WORKFLOW HOURS', () => {
  const stack = makeStack('HOURS: Mon-Wed 08:00-12:00');
  const wb    = makeWb('HOURS: Mon-Fri 09:00-17:00');
  const cfg   = engine._resolveSchedulingConfig(wb, stack);
  assert.deepStrictEqual([...cfg.hours.days].sort(), [1, 2, 3]);
  assert.strictEqual(cfg.hours.startMinutes, 8 * 60);
});

test('stack CONFIG SLOT_DURATION overrides board WORKFLOW SLOT_DURATION', () => {
  const stack = makeStack('SLOT_DURATION: 15');
  const wb    = makeWb('SLOT_DURATION: 60');
  const cfg   = engine._resolveSchedulingConfig(wb, stack);
  assert.strictEqual(cfg.slotDuration, 15);
});

// ── Code defaults when nothing is declared ──────────────────────────────────

test('uses code default Mon-Fri 09:00-17:00 when no HOURS anywhere', () => {
  const cfg = engine._resolveSchedulingConfig(makeWb(), makeStack());
  assert.deepStrictEqual([...cfg.hours.days].sort(), [1, 2, 3, 4, 5]);
  assert.strictEqual(cfg.hours.startMinutes, 9 * 60);
  assert.strictEqual(cfg.hours.endMinutes,   17 * 60);
  assert.strictEqual(cfg.hoursExplicit, false, 'hoursExplicit must be false when using default');
});

test('uses code default 30 min when no SLOT_DURATION anywhere', () => {
  const cfg = engine._resolveSchedulingConfig(makeWb(), makeStack());
  assert.strictEqual(cfg.slotDuration, 30);
});

test('timezone is a non-empty string when nothing declared (system tz fallback)', () => {
  const cfg = engine._resolveSchedulingConfig(makeWb(), makeStack());
  assert.ok(typeof cfg.timezone === 'string' && cfg.timezone.length > 0);
});

// ── Invalid / missing values ─────────────────────────────────────────────────

test('invalid HOURS value falls through to default without throwing', () => {
  const stack = makeStack('HOURS: weekdays 9am to 5pm');
  let cfg;
  assert.doesNotThrow(() => { cfg = engine._resolveSchedulingConfig(makeWb(), stack); });
  // Should fall through to default
  assert.deepStrictEqual([...cfg.hours.days].sort(), [1, 2, 3, 4, 5]);
  assert.strictEqual(cfg.hoursExplicit, false);
});

test('empty HOURS: line falls through to default without throwing', () => {
  const stack = makeStack('HOURS:  ');
  let cfg;
  assert.doesNotThrow(() => { cfg = engine._resolveSchedulingConfig(makeWb(), stack); });
  assert.strictEqual(cfg.hoursExplicit, false);
});

test('unknown TIMEZONE value falls through to system tz without throwing', () => {
  const stack = makeStack('HOURS: Mon-Fri 09:00-17:00\nTIMEZONE: NotA/RealTimezone');
  let cfg;
  assert.doesNotThrow(() => { cfg = engine._resolveSchedulingConfig(makeWb(), stack); });
  // Should not be the invalid value
  assert.notStrictEqual(cfg.timezone, 'NotA/RealTimezone');
});

test('non-integer SLOT_DURATION falls through to default 30', () => {
  const stack = makeStack('SLOT_DURATION: thirty');
  const cfg = engine._resolveSchedulingConfig(makeWb(), stack);
  assert.strictEqual(cfg.slotDuration, 30);
});

test('zero SLOT_DURATION falls through to default 30', () => {
  const stack = makeStack('SLOT_DURATION: 0');
  const cfg = engine._resolveSchedulingConfig(makeWb(), stack);
  assert.strictEqual(cfg.slotDuration, 30);
});

test('negative SLOT_DURATION falls through to default 30', () => {
  const stack = makeStack('SLOT_DURATION: -10');
  const cfg = engine._resolveSchedulingConfig(makeWb(), stack);
  assert.strictEqual(cfg.slotDuration, 30);
});

// ── hoursExplicit flag ───────────────────────────────────────────────────────

test('hoursExplicit is true only when HOURS marker was found', () => {
  const withHours    = engine._resolveSchedulingConfig(makeWb(), makeStack('HOURS: Mon-Fri 09:00-17:00'));
  const withoutHours = engine._resolveSchedulingConfig(makeWb(), makeStack('TIMEZONE: Europe/Lisbon'));
  assert.strictEqual(withHours.hoursExplicit, true);
  assert.strictEqual(withoutHours.hoursExplicit, false);
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
