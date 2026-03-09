/**
 * CommitmentDetector Unit Tests
 *
 * Run: node test/unit/integrations/commitment-detector.test.js
 *
 * @module test/unit/integrations/commitment-detector
 */

'use strict';

const assert = require('assert');
const { test, summary, exitWithCode } = require('../../helpers/test-runner');

const { detectCommitments } = require('../../../src/lib/integrations/commitment-detector');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCtx(...pairs) {
  // pairs: alternating user / assistant strings
  const messages = [];
  for (let i = 0; i < pairs.length; i++) {
    messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: pairs[i] });
  }
  return messages;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log('CommitmentDetector Unit Tests');
console.log('==============================\n');

// --- Guard / edge cases ---

test('returns empty array for null input', () => {
  assert.deepStrictEqual(detectCommitments(null), []);
});

test('returns empty array for empty array input', () => {
  assert.deepStrictEqual(detectCommitments([]), []);
});

test('returns empty array when no assistant messages present', () => {
  const ctx = [
    { role: 'user', content: 'Can you help me?' },
    { role: 'user', content: 'Please respond.' },
  ];
  assert.deepStrictEqual(detectCommitments(ctx), []);
});

test('returns empty array when assistant messages contain no commitments', () => {
  const ctx = makeCtx('What is 2 + 2?', 'Two plus two equals four.');
  assert.deepStrictEqual(detectCommitments(ctx), []);
});

// --- Type: promise ---

test('detects "I will" as promise type', () => {
  const ctx = makeCtx('Can you handle that?', 'I will take care of it by end of day.');
  const results = detectCommitments(ctx);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].type, 'promise');
  assert.ok(results[0].text.includes('I will take care of it'));
});

test('detects contraction I\'ll as promise type', () => {
  const ctx = makeCtx('Will you do it?', "I'll handle that task for you.");
  const results = detectCommitments(ctx);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].type, 'promise');
});

// --- Type: research ---

test('detects "let me look into" as research type', () => {
  const ctx = makeCtx('Any news on that?', 'Let me look into that and report back.');
  const results = detectCommitments(ctx);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].type, 'research');
});

test('detects "let me research" as research type', () => {
  const ctx = makeCtx('Can you find out?', 'Let me research the topic for you.');
  const results = detectCommitments(ctx);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].type, 'research');
});

// --- Type: offer ---

test('detects "I can look into" as offer type', () => {
  const ctx = makeCtx('Is that possible?', 'I can look into the options available.');
  const results = detectCommitments(ctx);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].type, 'offer');
});

// --- Type: follow-up ---

test('detects "I\'ll follow up" as follow-up type (not plain promise)', () => {
  const ctx = makeCtx('Okay thanks.', "I'll follow up with you tomorrow.");
  const results = detectCommitments(ctx);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].type, 'follow-up');
});

test('detects "I will get back to you" as follow-up type', () => {
  const ctx = makeCtx('When will you respond?', 'I will get back to you once I have more information.');
  const results = detectCommitments(ctx);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].type, 'follow-up');
});

// --- Type: action ---

test('detects "I\'ll send" as action type', () => {
  const ctx = makeCtx('Can you forward that?', "I'll send you the document shortly.");
  const results = detectCommitments(ctx);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].type, 'action');
});

// --- Exclusions ---

test('excludes "I will not" negation sentences', () => {
  const ctx = makeCtx('Will you share secrets?', 'I will not share any private data with third parties.');
  assert.deepStrictEqual(detectCommitments(ctx), []);
});

test('excludes hypothetical phrasing', () => {
  const ctx = makeCtx('What would you do?', 'If I were to handle this, I would suggest a different approach.');
  assert.deepStrictEqual(detectCommitments(ctx), []);
});

test('excludes sentences shorter than 10 characters', () => {
  // Force a short match by injecting a tiny assistant message
  const ctx = [{ role: 'assistant', content: 'I will.' }];
  assert.deepStrictEqual(detectCommitments(ctx), []);
});

// --- Context attachment ---

test('attaches preceding user message as context', () => {
  const ctx = makeCtx('Please draft the report.', "I'll draft the report and send it over.");
  const results = detectCommitments(ctx);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].context, 'Please draft the report.');
});

test('context is empty string when no preceding user message exists', () => {
  const ctx = [{ role: 'assistant', content: "I'll prepare the summary for you." }];
  const results = detectCommitments(ctx);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].context, '');
});

// --- Deduplication ---

test('deduplicates identical commitment sentences across messages', () => {
  const ctx = [
    { role: 'user',      content: 'First ask.' },
    { role: 'assistant', content: "I'll take care of it right away." },
    { role: 'user',      content: 'Second ask.' },
    { role: 'assistant', content: "I'll take care of it right away." },
  ];
  const results = detectCommitments(ctx);
  assert.strictEqual(results.length, 1);
});

// --- Max 5 cap ---

test('returns at most 5 commitments', () => {
  const lines = [
    "I will send you the report.",
    "I'll draft the proposal today.",
    "I will schedule the meeting.",
    "I'll follow up tomorrow morning.",
    "I will prepare the summary.",
    "I'll set up the demo for you.",
  ].join('  ');
  const ctx = [{ role: 'user', content: 'Do everything.' }, { role: 'assistant', content: lines }];
  const results = detectCommitments(ctx);
  assert.ok(results.length <= 5, `Expected <= 5 but got ${results.length}`);
});

// ---------------------------------------------------------------------------

setTimeout(() => { summary(); exitWithCode(); }, 100);
