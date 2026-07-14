/**
 * PerceptionCustody Unit Tests
 *
 * Covers M1 (ceremony exclusion / state-line replacement, gated), M2
 * (correction-as-replacement, incl. the #292 poisoning repro), the staging
 * handoff, and the structural invariants (id-keyed, never content-read; the
 * pending line shares zero surface with ceremony).
 *
 * Run: node test/unit/agent/perception-custody.test.js
 */

const assert = require('assert');
const { PerceptionCustody, NO_ACTION_PERCEPTION } = require('../../../src/lib/agent/perception-custody');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`✗ ${name}`);
    console.log(`  ${err.message}`);
    failed++;
  }
}

const ROOM = 'room-abc';
function hist(...entries) {
  // entries: [id, role, content]
  return entries.map(([id, role, content]) => ({ id, role, content }));
}

console.log('\n=== PerceptionCustody Tests ===\n');

// ── M1: ceremony exclusion is GATED (default off) ────────────────────────────
test('M1 off by default: ceremony stays in perception untouched', () => {
  const pc = new PerceptionCustody();
  pc.noteCeremony(ROOM, 500, { recordId: 'r1', label: 'Delete Deck card' });
  const h = hist([500, 'assistant', '🔐 Approve? Reply yes/no'], [501, 'user', 'ja']);
  const { history, stats } = pc.redactForModel(h, ROOM, { pendingRecords: [{ id: 'r1' }] });
  assert.strictEqual(stats.excluded, 0);
  assert.strictEqual(stats.replaced, 0);
  assert.strictEqual(history[0].content, '🔐 Approve? Reply yes/no', 'ceremony unchanged while gate off');
});

// ── M1: pending record → machine-register state line ─────────────────────────
test('M1 on + live pending record: ceremony replaced by the state line', () => {
  const pc = new PerceptionCustody();
  pc.setCeremonyExclusion(true);
  pc.noteCeremony(ROOM, 500, { recordId: 'r1', label: 'Delete Deck card' });
  const h = hist([499, 'user', 'lösch die Karte'], [500, 'assistant', '🔐 Approve deletion? yes/no']);
  const { history, stats } = pc.redactForModel(h, ROOM, { pendingRecords: [{ id: 'r1' }] });
  assert.strictEqual(stats.replaced, 1);
  assert.strictEqual(stats.excluded, 0);
  assert.strictEqual(history[1].content, '[approval pending: Delete Deck card — awaiting human decision]');
});

// ── M1: resolved (no live record) → excluded, no replacement ─────────────────
test('M1 on + record no longer pending: ceremony dropped with no replacement', () => {
  const pc = new PerceptionCustody();
  pc.setCeremonyExclusion(true);
  pc.noteCeremony(ROOM, 500, { recordId: 'r1', label: 'Delete Deck card' });
  const h = hist([500, 'assistant', '🔐 Approve deletion? yes/no'], [501, 'user', 'ja'], [502, 'assistant', 'Done.']);
  const { history, stats } = pc.redactForModel(h, ROOM, { pendingRecords: [] }); // record resolved/gone
  assert.strictEqual(stats.excluded, 1);
  assert.strictEqual(stats.replaced, 0);
  assert.strictEqual(history.length, 2, 'ceremony entry removed entirely');
  assert.ok(!history.some(m => m.content.includes('Approve')), 'no ceremony text survives in perception');
});

// ── M1: a notice with no record (recordId null) → always dropped when gated ──
test('M1 on + notice (no recordId): dropped, no replacement', () => {
  const pc = new PerceptionCustody();
  pc.setCeremonyExclusion(true);
  pc.noteCeremony(ROOM, 600, {}); // e.g. non-approver notice
  const h = hist([600, 'assistant', 'This confirmation belongs to whoever asked.']);
  const { history, stats } = pc.redactForModel(h, ROOM, { pendingRecords: [] });
  assert.strictEqual(stats.excluded, 1);
  assert.strictEqual(history.length, 0);
});

// ── M1: batch record collapses to ONE pending line ──────────────────────────
test('M1 batch: several ceremony messages of one record → one state line', () => {
  const pc = new PerceptionCustody();
  pc.setCeremonyExclusion(true);
  pc.noteCeremony(ROOM, 700, { recordId: 'rb', label: '3 actions' });
  pc.noteCeremony(ROOM, 701, { recordId: 'rb', label: '3 actions' });
  pc.noteCeremony(ROOM, 702, { recordId: 'rb', label: '3 actions' });
  const h = hist([700, 'assistant', 'ceremony 1'], [701, 'assistant', 'ceremony 2'], [702, 'assistant', 'ceremony 3']);
  const { history, stats } = pc.redactForModel(h, ROOM, { pendingRecords: [{ id: 'rb' }] });
  assert.strictEqual(stats.replaced, 1, 'exactly one pending line');
  assert.strictEqual(stats.excluded, 2, 'the other two dropped');
  assert.strictEqual(history.length, 1);
});

// ── M2: correction-as-replacement (always on, not gated) ─────────────────────
test('M2: a corrected message id shows the corrected form in perception', () => {
  const pc = new PerceptionCustody();
  // M2 is NOT gated by ceremonyExclusion — off here on purpose.
  pc.noteCorrection(ROOM, 800, NO_ACTION_PERCEPTION);
  const h = hist([800, 'assistant', 'Ich habe die Karte gelöscht.'], [801, 'user', 'wirklich?']);
  const { history, stats } = pc.redactForModel(h, ROOM, {});
  assert.strictEqual(stats.corrected, 1);
  assert.strictEqual(history[0].content, NO_ACTION_PERCEPTION);
  assert.ok(!history[0].content.includes('gelöscht'), 'the false claim is not perceivable');
});

// ── M2: the #292 poisoning repro — the model cannot re-read its own fiction ──
test('M2 poisoning repro: false "foi deletado" is replaced on the next turn', () => {
  const pc = new PerceptionCustody();
  // Leg 1: the false completion was emitted as message 900 and trailer-corrected.
  pc.noteCorrection(ROOM, 900, NO_ACTION_PERCEPTION);
  // Leg 2: assemble the next turn's context. Talk still holds the claim (id 900),
  // but the model must perceive the correction, so it cannot echo "já deletado".
  const h = hist(
    [899, 'user', 'apaga o cartão X'],
    [900, 'assistant', 'Pronto, o cartão foi deletado.\n\n[Keine Aktion ausgeführt.]'],
    [901, 'user', 'e agora?']
  );
  const { history } = pc.redactForModel(h, ROOM, {});
  assert.strictEqual(history[1].content, NO_ACTION_PERCEPTION);
  assert.ok(!/deletado/i.test(history[1].content), 'no "deletado" fiction survives into perception');
});

// ── M2 staging handoff (id unknown at trailer time) ─────────────────────────
test('staging: stageCorrection then takeStagedCorrection returns & clears', () => {
  const pc = new PerceptionCustody();
  pc.stageCorrection(ROOM, NO_ACTION_PERCEPTION);
  assert.strictEqual(pc.takeStagedCorrection(ROOM), NO_ACTION_PERCEPTION);
  assert.strictEqual(pc.takeStagedCorrection(ROOM), null, 'second take is empty (consumed)');
});

test('staging: committed with the sent id, it becomes a live correction', () => {
  const pc = new PerceptionCustody();
  pc.stageCorrection(ROOM, NO_ACTION_PERCEPTION);
  const staged = pc.takeStagedCorrection(ROOM);
  pc.noteCorrection(ROOM, 950, staged); // send site binds the real id
  const h = hist([950, 'assistant', 'false completion text']);
  const { history, stats } = pc.redactForModel(h, ROOM, {});
  assert.strictEqual(stats.corrected, 1);
  assert.strictEqual(history[0].content, NO_ACTION_PERCEPTION);
});

// ── Structural invariants ────────────────────────────────────────────────────
test('the pending line shares zero surface with any approval ceremony', () => {
  const pc = new PerceptionCustody();
  const line = pc._pendingLine('Delete Deck card');
  assert.ok(!/🔐/.test(line), 'no lock emoji');
  assert.ok(!/\b(approve|reply|yes\/no|ja\/nein|sim\/n[aã]o|confirm)\b/i.test(line), 'no ceremony verbs');
  assert.ok(line.startsWith('[') && line.endsWith(']'), 'square-bracketed machine register');
});

test('identification is by id only: an unrecorded message is never touched', () => {
  const pc = new PerceptionCustody();
  pc.setCeremonyExclusion(true);
  pc.noteCeremony(ROOM, 500, { recordId: 'r1', label: 'x' });
  const h = hist([501, 'assistant', 'Approve? yes/no — but NOT enforcer-sent']);
  const { history, stats } = pc.redactForModel(h, ROOM, { pendingRecords: [{ id: 'r1' }] });
  assert.strictEqual(stats.excluded, 0);
  assert.strictEqual(stats.replaced, 0);
  assert.strictEqual(history[0].content, 'Approve? yes/no — but NOT enforcer-sent', 'content never read; only ids match');
});

test('redactForModel does not mutate the input history array', () => {
  const pc = new PerceptionCustody();
  pc.noteCorrection(ROOM, 800, NO_ACTION_PERCEPTION);
  const h = hist([800, 'assistant', 'original claim']);
  pc.redactForModel(h, ROOM, {});
  assert.strictEqual(h[0].content, 'original claim', 'the Talk-facing copy is untouched');
});

test('empty / unknown room: returns history unchanged with zero stats', () => {
  const pc = new PerceptionCustody();
  const h = hist([1, 'user', 'hi']);
  const { history, stats } = pc.redactForModel(h, 'other-room', {});
  assert.strictEqual(history, h);
  assert.deepStrictEqual(stats, { excluded: 0, replaced: 0, corrected: 0 });
});

test('garbage message id never enters a registry (no NaN keys)', () => {
  const pc = new PerceptionCustody();
  pc.noteCeremony(ROOM, undefined, { recordId: 'r' });
  pc.noteCorrection(ROOM, 'not-a-number', 'x');
  const h = hist([1, 'assistant', 'a']);
  const { stats } = pc.redactForModel(h, ROOM, { pendingRecords: [{ id: 'r' }] });
  assert.deepStrictEqual(stats, { excluded: 0, replaced: 0, corrected: 0 });
});

console.log('\n=================================');
console.log(`Tests passed: ${passed}`);
console.log(`Tests failed: ${failed}`);
console.log('=================================\n');
process.exit(failed > 0 ? 1 : 0);
