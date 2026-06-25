'use strict';

/**
 * Tests for WorkflowEngine._isTerminalStack (#196).
 *
 * Root cause this guards against: the engine had no concept of a terminal
 * stack. A card resting in the pipeline's end stack (e.g. "Replied") still
 * cost a wasted LLM beat every pulse — one model call per pulse with no
 * mutation — until the card fell out of the processing window. A stack is now
 * declared terminal by a TERMINAL: true marker on its CONFIG card; the engine
 * skips the beat entirely for cards there.
 *
 * Covers:
 *   - TERMINAL: true on the stack CONFIG card → terminal
 *   - No marker / no CONFIG card → non-terminal (default)
 *   - TERMINAL: false → non-terminal (explicit opt-in only)
 *   - Whitespace/case tolerance on the value
 */

const assert = require('assert');
const { test, summary, exitWithCode } = require('../../helpers/test-runner');
const WorkflowEngine = require('../../../src/lib/workflows/workflow-engine');

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
  return { id: 10, title: 'Replied', cards };
}

const engine = createEngine();

// ── Terminal when explicitly declared ───────────────────────────────────────

test('TERMINAL: true on the stack CONFIG card marks the stack terminal', () => {
  assert.strictEqual(engine._isTerminalStack(makeStack('TERMINAL: true')), true);
});

test('TERMINAL: true alongside other markers still resolves terminal', () => {
  const stack = makeStack('LLM: cloud-writing\nTERMINAL: true');
  assert.strictEqual(engine._isTerminalStack(stack), true);
});

// ── Non-terminal: the default ───────────────────────────────────────────────

test('no CONFIG card means non-terminal', () => {
  assert.strictEqual(engine._isTerminalStack(makeStack()), false);
});

test('CONFIG card without TERMINAL marker means non-terminal', () => {
  assert.strictEqual(engine._isTerminalStack(makeStack('LLM: cloud-writing\nMAX_ITERATIONS: 7')), false);
});

test('TERMINAL: false means non-terminal (explicit opt-in only)', () => {
  assert.strictEqual(engine._isTerminalStack(makeStack('TERMINAL: false')), false);
});

// ── Tolerance on the value ──────────────────────────────────────────────────

test('TERMINAL value is case- and whitespace-insensitive', () => {
  assert.strictEqual(engine._isTerminalStack(makeStack('TERMINAL:  True  ')), true);
});

test('a non-boolean TERMINAL value is treated as non-terminal', () => {
  assert.strictEqual(engine._isTerminalStack(makeStack('TERMINAL: maybe')), false);
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
