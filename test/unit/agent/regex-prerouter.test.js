/*
 * MoltAgent - Sovereign AI Security Layer
 * Copyright (C) 2026 MoltAgent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * Regex Pre-Router Tests
 *
 * Validates needsSmartClassifier() correctly splits messages
 * between phi4-mini (fast, explicit) and qwen3:8b (smart, ambiguous).
 *
 * Run: node test/unit/agent/regex-prerouter.test.js
 */

'use strict';

const assert = require('assert');
const { test, summary, exitWithCode } = require('../../helpers/test-runner');
const IntentRouter = require('../../../src/lib/agent/intent-router');

const needsSmartClassifier = IntentRouter.needsSmartClassifier;

console.log('\n=== Regex Pre-Router Tests ===\n');

// ---- Explicit messages → false (phi4-mini) ----

test('"Delete the Team Sync meeting" → fast model', () => {
  assert.strictEqual(needsSmartClassifier('Delete the Team Sync meeting'), false);
});

test('"Schedule a meeting tomorrow" → fast model', () => {
  assert.strictEqual(needsSmartClassifier('Schedule a meeting tomorrow'), false);
});

test('"Move the review card to Done" → fast model', () => {
  assert.strictEqual(needsSmartClassifier('Move the review card to Done'), false);
});

test('"Good morning!" → fast model', () => {
  assert.strictEqual(needsSmartClassifier('Good morning!'), false);
});

test('"What\'s on my calendar?" → fast model', () => {
  assert.strictEqual(needsSmartClassifier("What's on my calendar?"), false);
});

test('"Create a task called Fix bug" → fast model', () => {
  assert.strictEqual(needsSmartClassifier('Create a task called Fix bug'), false);
});

// ---- Ambiguous messages → true (qwen3:8b) ----

test('"Remember that Sarah prefers video calls" → smart model (memory verb)', () => {
  assert.strictEqual(needsSmartClassifier('Remember that Sarah prefers video calls'), true);
});

test('"Assign me to the event you just created" → smart model (contextual ref)', () => {
  assert.strictEqual(needsSmartClassifier('Assign me to the event you just created'), true);
});

test('"Never mind about that event" → smart model (contextual ref)', () => {
  assert.strictEqual(needsSmartClassifier('Never mind about that event'), true);
});

test('"What did we decide about pricing?" → smart model (memory verb)', () => {
  assert.strictEqual(needsSmartClassifier('What did we decide about pricing?'), true);
});

test('"Don\'t forget the budget is 50k" → smart model (memory verb)', () => {
  assert.strictEqual(needsSmartClassifier("Don't forget the budget is 50k"), true);
});

test('"Put me on the invite list for that one" → smart model (contextual ref)', () => {
  assert.strictEqual(needsSmartClassifier('Put me on the invite list for that one'), true);
});

// ---- Edge cases ----

test('null/empty message → fast model (safe default)', () => {
  assert.strictEqual(needsSmartClassifier(null), false);
  assert.strictEqual(needsSmartClassifier(''), false);
  assert.strictEqual(needsSmartClassifier(undefined), false);
});

test('"I forgot my password" → smart model (forgot is memory verb)', () => {
  assert.strictEqual(needsSmartClassifier('I forgot my password'), true);
});

test('"I told you about the deadline" → smart model', () => {
  assert.strictEqual(needsSmartClassifier('I told you about the deadline'), true);
});

test('"Cancel that meeting" → fast model (no ambiguous pattern)', () => {
  assert.strictEqual(needsSmartClassifier('Cancel that meeting'), true,
    '"that meeting" is a contextual reference');
});

test('"You asked me about the project" → smart model (asked you pattern)', () => {
  // "asked you" → true
  assert.strictEqual(needsSmartClassifier('You asked me about the project'), false,
    '"asked me" doesn\'t match "asked you" — different direction');
});

setTimeout(() => { summary(); exitWithCode(); }, 100);
