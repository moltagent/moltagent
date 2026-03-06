/**
 * FeedbackMessages Unit Tests
 *
 * Run: node test/unit/talk/feedback-messages.test.js
 */

const assert = require('assert');
const { test, summary, exitWithCode } = require('../../helpers/test-runner');
const { getFeedbackMessage, FEEDBACK_MESSAGES } = require('../../../src/lib/talk/feedback-messages');

// -- Intent-specific feedback --

test('deck intent returns deck feedback', () => {
  const msg = getFeedbackMessage('deck');
  assert.ok(msg);
  assert.ok(msg.includes('tasks'), `Expected tasks-related message, got: ${msg}`);
});

test('deck with deck_create action returns specific message', () => {
  const msg = getFeedbackMessage('deck', 'deck_create');
  assert.ok(msg);
  assert.ok(msg.includes('board'), `Expected board-related message, got: ${msg}`);
});

test('deck with deck_query action returns specific message', () => {
  const msg = getFeedbackMessage('deck', 'deck_query');
  assert.ok(msg);
  assert.ok(msg.includes('tasks') || msg.includes('Checking'), `Expected tasks message, got: ${msg}`);
});

test('deck with unknown action falls back to default', () => {
  const msg = getFeedbackMessage('deck', 'some_unknown_action');
  assert.strictEqual(msg, FEEDBACK_MESSAGES.deck.default);
});

test('wiki intent returns wiki feedback', () => {
  const msg = getFeedbackMessage('wiki');
  assert.ok(msg);
  assert.ok(msg.includes('memory') || msg.includes('Search'), `Expected memory message, got: ${msg}`);
});

test('wiki with wiki_write returns save message', () => {
  const msg = getFeedbackMessage('wiki', 'wiki_write');
  assert.ok(msg);
  assert.ok(msg.includes('Saving') || msg.includes('knowledge'), `Expected save message, got: ${msg}`);
});

test('wiki with wiki_read returns lookup message', () => {
  const msg = getFeedbackMessage('wiki', 'wiki_read');
  assert.ok(msg);
  assert.ok(msg.includes('Looking'), `Expected lookup message, got: ${msg}`);
});

test('calendar intent returns calendar feedback', () => {
  const msg = getFeedbackMessage('calendar');
  assert.ok(msg);
  assert.ok(msg.includes('calendar'), `Expected calendar message, got: ${msg}`);
});

test('calendar with calendar_create returns add message', () => {
  const msg = getFeedbackMessage('calendar', 'calendar_create');
  assert.ok(msg);
  assert.ok(msg.includes('Adding'), `Expected add message, got: ${msg}`);
});

test('email intent returns email feedback', () => {
  const msg = getFeedbackMessage('email');
  assert.ok(msg);
  assert.ok(msg.includes('email'), `Expected email message, got: ${msg}`);
});

test('search intent returns web search feedback', () => {
  const msg = getFeedbackMessage('search');
  assert.ok(msg);
  assert.ok(msg.includes('web') || msg.includes('Search'), `Expected search message, got: ${msg}`);
});

test('file intent returns file feedback', () => {
  const msg = getFeedbackMessage('file');
  assert.ok(msg);
  assert.ok(msg.includes('file') || msg.includes('Handling'), `Expected file message, got: ${msg}`);
});

test('complex intent returns thinking feedback', () => {
  const msg = getFeedbackMessage('complex');
  assert.ok(msg);
  assert.ok(msg.includes('think'), `Expected thinking message, got: ${msg}`);
});

// -- Intents that should NOT produce feedback --

test('chitchat returns null (no feedback)', () => {
  assert.strictEqual(getFeedbackMessage('chitchat'), null);
});

test('greeting returns null (no feedback)', () => {
  assert.strictEqual(getFeedbackMessage('greeting'), null);
});

test('confirmation returns null (no feedback)', () => {
  assert.strictEqual(getFeedbackMessage('confirmation'), null);
});

test('selection returns null (no feedback)', () => {
  assert.strictEqual(getFeedbackMessage('selection'), null);
});

// -- Edge cases --

test('unknown intent returns generic fallback', () => {
  const msg = getFeedbackMessage('totally_unknown_intent');
  assert.ok(msg);
  assert.ok(msg.includes('Working'), `Expected working message, got: ${msg}`);
});

test('null intent returns null', () => {
  assert.strictEqual(getFeedbackMessage(null), null);
});

test('undefined intent returns null', () => {
  assert.strictEqual(getFeedbackMessage(undefined), null);
});

test('empty string intent returns null', () => {
  assert.strictEqual(getFeedbackMessage(''), null);
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
