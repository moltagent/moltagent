'use strict';

/**
 * Tests for WorkflowEngine._resolveMaxIterations (#186/#188 live-gate follow-up).
 *
 * Root cause this guards against: the research/grounding stage's workload
 * (web research + dual-surface profile write + drafted reply + GATE move)
 * outgrew the hardcoded pipeline iteration cap of 3, so the beat hit the cap
 * having committed nothing and the card stranded. The cap is now CONFIG-declared.
 *
 * Covers:
 *   - MAX_ITERATIONS parsed from stack CONFIG / board WORKFLOW card
 *   - Resolution chain: stack CONFIG → board WORKFLOW → code default
 *   - Code default depends on workflowType (procedure 5, pipeline 3)
 *   - Invalid values fall through to the code default (no throw)
 *   - Clamp to MAX_ITERATION_CEILING so a typo cannot run cloud cost away
 *   - Trailing whitespace in the marker value is trimmed (board 165 CONFIG had it)
 */

const assert = require('assert');
const { test, summary, exitWithCode } = require('../../helpers/test-runner');
const WorkflowEngine = require('../../../src/lib/workflows/workflow-engine');

// ---------------------------------------------------------------------------
// Minimal factory helpers (mirrors scheduling-config.test.js style)
// ---------------------------------------------------------------------------

function createEngine() {
  return new WorkflowEngine({
    workflowDetector: { getWorkflowBoards: async () => [], invalidateCache: () => {} },
    deckClient: { getComments: async () => [], addComment: async () => {}, username: 'moltagent' },
    agentLoop: { processWorkflowTask: async () => 'done' },
    talkSendQueue: { enqueue: async () => {} },
    talkToken: 'tok'
  });
}

/** Build a minimal stack with an optional CONFIG card description. */
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

/** Build a minimal workflow board descriptor. workflowType defaults to 'pipeline'. */
function makeWb(plainDescription = '', workflowType = 'pipeline') {
  return { _plainDescription: plainDescription, workflowType };
}

const engine = createEngine();

// ── Happy path: MAX_ITERATIONS from stack CONFIG card ───────────────────────

test('parses MAX_ITERATIONS from stack CONFIG card', () => {
  const stack = makeStack('LLM: cloud-writing\nMAX_ITERATIONS: 7');
  assert.strictEqual(engine._resolveMaxIterations(makeWb(), stack), 7);
});

test('the live-gate specimen MAX_ITERATIONS: 7 resolves to 7 (regression)', () => {
  // board 165 Researching CONFIG, the value that fixes the stranded research beat
  const stack = makeStack('LLM: cloud-writing\nHOURS: Mon-Fri 09:00-17:00\nTIMEZONE: Europe/Berlin\nSLOT_DURATION: 30\nMAX_ITERATIONS: 7');
  assert.strictEqual(engine._resolveMaxIterations(makeWb('', 'pipeline'), stack), 7);
});

// ── Fallback to board WORKFLOW card ─────────────────────────────────────────

test('falls back MAX_ITERATIONS to board WORKFLOW card when no stack CONFIG', () => {
  const stack = makeStack(); // no CONFIG card
  const wb    = makeWb('WORKFLOW: pipeline\nMAX_ITERATIONS: 9');
  assert.strictEqual(engine._resolveMaxIterations(wb, stack), 9);
});

test('stack CONFIG MAX_ITERATIONS overrides board WORKFLOW', () => {
  const stack = makeStack('MAX_ITERATIONS: 6');
  const wb    = makeWb('MAX_ITERATIONS: 12');
  assert.strictEqual(engine._resolveMaxIterations(wb, stack), 6);
});

// ── Code defaults when nothing declared ─────────────────────────────────────

test('pipeline code default is 3 when no MAX_ITERATIONS anywhere', () => {
  assert.strictEqual(engine._resolveMaxIterations(makeWb('', 'pipeline'), makeStack()), 3);
});

test('procedure code default is 5 when no MAX_ITERATIONS anywhere', () => {
  assert.strictEqual(engine._resolveMaxIterations(makeWb('', 'procedure'), makeStack()), 5);
});

// ── Invalid / missing values fall through to code default ────────────────────

test('non-integer MAX_ITERATIONS falls through to code default', () => {
  const stack = makeStack('MAX_ITERATIONS: seven');
  assert.strictEqual(engine._resolveMaxIterations(makeWb('', 'pipeline'), stack), 3);
});

test('zero MAX_ITERATIONS falls through to code default', () => {
  const stack = makeStack('MAX_ITERATIONS: 0');
  assert.strictEqual(engine._resolveMaxIterations(makeWb('', 'pipeline'), stack), 3);
});

test('negative MAX_ITERATIONS falls through to code default', () => {
  const stack = makeStack('MAX_ITERATIONS: -4');
  assert.strictEqual(engine._resolveMaxIterations(makeWb('', 'procedure'), stack), 5);
});

test('empty MAX_ITERATIONS line falls through to code default without throwing', () => {
  const stack = makeStack('MAX_ITERATIONS:  ');
  let val;
  assert.doesNotThrow(() => { val = engine._resolveMaxIterations(makeWb('', 'pipeline'), stack); });
  assert.strictEqual(val, 3);
});

// ── Clamp to ceiling ────────────────────────────────────────────────────────

test('MAX_ITERATIONS above the ceiling is clamped to 15', () => {
  const stack = makeStack('MAX_ITERATIONS: 70'); // typo for 7
  assert.strictEqual(engine._resolveMaxIterations(makeWb('', 'pipeline'), stack), 15);
});

test('MAX_ITERATIONS exactly at the ceiling is allowed', () => {
  const stack = makeStack('MAX_ITERATIONS: 15');
  assert.strictEqual(engine._resolveMaxIterations(makeWb('', 'pipeline'), stack), 15);
});

// ── Trailing whitespace (the board 165 CONFIG had trailing spaces) ──────────

test('trailing whitespace in MAX_ITERATIONS value is trimmed and parsed', () => {
  const stack = makeStack('LLM: cloud-writing  \nMAX_ITERATIONS: 8   ');
  assert.strictEqual(engine._resolveMaxIterations(makeWb('', 'pipeline'), stack), 8);
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
