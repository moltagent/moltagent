/*
 * MoltAgent - Sovereign AI Security Layer
 * Copyright (C) 2026 MoltAgent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

'use strict';

const assert = require('assert');
const { test, summary, exitWithCode } = require('../../helpers/test-runner');

console.log('\n=== Context Extraction Tests ===\n');

// Minimal stub that has _extractRecentContext — we extract the method logic to test it
// Since _extractRecentContext is a private method on MessageProcessor,
// we replicate its logic here for unit testing.
function extractRecentContext(session, maxExchanges = 3) {
  if (!session || !session.context || session.context.length === 0) {
    return [];
  }
  const maxEntries = maxExchanges * 2;
  return session.context
    .filter(entry => entry.role === 'user' || entry.role === 'assistant')
    .slice(-maxEntries)
    .map(entry => ({ role: entry.role, content: entry.content || '' }));
}

// -- Tests --

test('returns empty array for null session', () => {
  assert.deepStrictEqual(extractRecentContext(null), []);
});

test('returns empty array for session with no context', () => {
  assert.deepStrictEqual(extractRecentContext({ context: [] }), []);
});

test('returns empty array for undefined context', () => {
  assert.deepStrictEqual(extractRecentContext({}), []);
});

test('returns all entries when fewer than max', () => {
  const session = {
    context: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' }
    ]
  };
  const result = extractRecentContext(session);
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].role, 'user');
  assert.strictEqual(result[1].content, 'hi there');
});

test('returns last 6 entries (3 exchanges) from longer context', () => {
  const session = {
    context: [
      { role: 'user', content: 'msg-1' },
      { role: 'assistant', content: 'reply-1' },
      { role: 'user', content: 'msg-2' },
      { role: 'assistant', content: 'reply-2' },
      { role: 'user', content: 'msg-3' },
      { role: 'assistant', content: 'reply-3' },
      { role: 'user', content: 'msg-4' },
      { role: 'assistant', content: 'reply-4' },
    ]
  };
  const result = extractRecentContext(session);
  assert.strictEqual(result.length, 6);
  assert.strictEqual(result[0].content, 'msg-2');
  assert.strictEqual(result[5].content, 'reply-4');
});

test('filters out system messages', () => {
  const session = {
    context: [
      { role: 'user', content: 'hello' },
      { role: 'system', content: '[Earlier conversation was summarized.]' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'what events?' },
      { role: 'assistant', content: 'You have 3 events' },
    ]
  };
  const result = extractRecentContext(session);
  assert.strictEqual(result.length, 4);
  assert.ok(result.every(e => e.role !== 'system'), 'No system messages');
});

test('returns correct role/content structure (no timestamp)', () => {
  const session = {
    context: [
      { role: 'user', content: 'test', timestamp: 123456789 }
    ]
  };
  const result = extractRecentContext(session);
  assert.deepStrictEqual(result[0], { role: 'user', content: 'test' });
  assert.strictEqual(result[0].timestamp, undefined, 'Should not include timestamp');
});

test('handles single message (no crash)', () => {
  const session = {
    context: [
      { role: 'user', content: 'solo message' }
    ]
  };
  const result = extractRecentContext(session);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].content, 'solo message');
});

test('respects custom maxExchanges parameter', () => {
  const session = {
    context: [
      { role: 'user', content: 'msg-1' },
      { role: 'assistant', content: 'reply-1' },
      { role: 'user', content: 'msg-2' },
      { role: 'assistant', content: 'reply-2' },
      { role: 'user', content: 'msg-3' },
      { role: 'assistant', content: 'reply-3' },
    ]
  };
  const result = extractRecentContext(session, 1);
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].content, 'msg-3');
  assert.strictEqual(result[1].content, 'reply-3');
});

test('handles entry with empty content', () => {
  const session = {
    context: [
      { role: 'user', content: '' },
      { role: 'assistant' }
    ]
  };
  const result = extractRecentContext(session);
  assert.strictEqual(result[0].content, '');
  assert.strictEqual(result[1].content, '');
});

setTimeout(() => { summary(); exitWithCode(); }, 100);
