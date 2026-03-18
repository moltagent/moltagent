/*
 * Moltagent - Sovereign AI Agent Platform
 * Copyright (C) 2026 Moltagent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * CommitmentDetector Unit Tests (LLM-based v2)
 *
 * Run: node test/unit/integrations/commitment-detector.test.js
 *
 * @module test/unit/integrations/commitment-detector
 */

'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

const { CommitmentDetector } = require('../../../src/lib/integrations/commitment-detector');

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/** Create a mock llmRouter that returns the given JSON array as LLM output */
function mockRouter(responseArray) {
  return {
    route: async () => ({ result: JSON.stringify(responseArray) })
  };
}

/** Create a mock llmRouter that throws on route() */
function failingRouter(errMsg = 'LLM offline') {
  return {
    route: async () => { throw new Error(errMsg); }
  };
}

/** Create a mock llmRouter that returns the given raw text (for testing fence stripping) */
function rawRouter(text) {
  return {
    route: async () => ({ result: text })
  };
}

/** Conversation helper: alternating user/assistant messages */
function makeConv(...pairs) {
  const messages = [];
  for (let i = 0; i < pairs.length; i++) {
    messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: pairs[i] });
  }
  return messages;
}

const silentLogger = { warn: () => {} };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log('CommitmentDetector Unit Tests (LLM-based v2)');
console.log('=============================================\n');

// --- Guard / edge cases ---

test('throws if llmRouter is not provided', () => {
  assert.throws(() => new CommitmentDetector({ logger: silentLogger }), /llmRouter/);
});

asyncTest('returns empty array for null input', async () => {
  const cd = new CommitmentDetector({ llmRouter: mockRouter([]), logger: silentLogger });
  assert.deepStrictEqual(await cd.detect(null), []);
});

asyncTest('returns empty array for empty array input', async () => {
  const cd = new CommitmentDetector({ llmRouter: mockRouter([]), logger: silentLogger });
  assert.deepStrictEqual(await cd.detect([]), []);
});

asyncTest('returns empty array when less than 2 messages', async () => {
  const cd = new CommitmentDetector({ llmRouter: mockRouter([]), logger: silentLogger });
  assert.deepStrictEqual(await cd.detect([{ role: 'user', content: 'hi' }]), []);
});

// --- Core detection via LLM ---

asyncTest('returns commitments from LLM response', async () => {
  const llmOutput = [
    { title: 'Research NC Forms capabilities', type: 'research', context: 'User asked about NC Forms' }
  ];
  const cd = new CommitmentDetector({ llmRouter: mockRouter(llmOutput), logger: silentLogger });
  const result = await cd.detect(makeConv('Can you research NC Forms?', 'I will look into NC Forms for you.'));
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].title, 'Research NC Forms capabilities');
  assert.strictEqual(result[0].type, 'research');
  assert.ok(result[0].context.length > 0);
});

asyncTest('returns empty array when LLM finds no commitments', async () => {
  const cd = new CommitmentDetector({ llmRouter: mockRouter([]), logger: silentLogger });
  const result = await cd.detect(makeConv('What is 2+2?', 'Two plus two equals four.'));
  assert.deepStrictEqual(result, []);
});

asyncTest('caps results at 5 commitments', async () => {
  const llmOutput = Array.from({ length: 8 }, (_, i) => ({
    title: `Task ${i + 1}`, type: 'action', context: `Context ${i + 1}`
  }));
  const cd = new CommitmentDetector({ llmRouter: mockRouter(llmOutput), logger: silentLogger });
  const result = await cd.detect(makeConv('Do everything', 'I will do all eight things.'));
  assert.ok(result.length <= 5, `Expected <= 5 but got ${result.length}`);
});

// --- Type normalisation ---

asyncTest('normalises unknown type to action', async () => {
  const llmOutput = [{ title: 'Do something', type: 'banana', context: 'test' }];
  const cd = new CommitmentDetector({ llmRouter: mockRouter(llmOutput), logger: silentLogger });
  const result = await cd.detect(makeConv('test', 'test'));
  assert.strictEqual(result[0].type, 'action');
});

asyncTest('preserves valid types: follow-up, research, action', async () => {
  const llmOutput = [
    { title: 'Follow up task', type: 'follow-up', context: 'a' },
    { title: 'Research task', type: 'research', context: 'b' },
    { title: 'Action task', type: 'action', context: 'c' },
  ];
  const cd = new CommitmentDetector({ llmRouter: mockRouter(llmOutput), logger: silentLogger });
  const result = await cd.detect(makeConv('test', 'test'));
  assert.strictEqual(result[0].type, 'follow-up');
  assert.strictEqual(result[1].type, 'research');
  assert.strictEqual(result[2].type, 'action');
});

// --- Error handling ---

asyncTest('returns empty array on LLM failure', async () => {
  const cd = new CommitmentDetector({ llmRouter: failingRouter(), logger: silentLogger });
  const result = await cd.detect(makeConv('test', 'I will do it'));
  assert.deepStrictEqual(result, []);
});

asyncTest('returns empty array on invalid JSON from LLM', async () => {
  const cd = new CommitmentDetector({ llmRouter: rawRouter('not json at all'), logger: silentLogger });
  const result = await cd.detect(makeConv('test', 'test'));
  assert.deepStrictEqual(result, []);
});

asyncTest('handles markdown-fenced JSON from LLM', async () => {
  const fenced = '```json\n[{"title":"Follow up on report","type":"follow-up","context":"report request"}]\n```';
  const cd = new CommitmentDetector({ llmRouter: rawRouter(fenced), logger: silentLogger });
  const result = await cd.detect(makeConv('test', 'test'));
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].title, 'Follow up on report');
});

// --- Validation: skips entries with empty title ---

asyncTest('skips entries with missing or empty title', async () => {
  const llmOutput = [
    { title: '', type: 'action', context: 'empty' },
    { title: 'Valid task', type: 'action', context: 'ok' },
    { type: 'action', context: 'no title field' },
  ];
  const cd = new CommitmentDetector({ llmRouter: mockRouter(llmOutput), logger: silentLogger });
  const result = await cd.detect(makeConv('test', 'test'));
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].title, 'Valid task');
});

// --- Context truncation ---

asyncTest('truncates context to 100 chars', async () => {
  const longContext = 'A'.repeat(200);
  const llmOutput = [{ title: 'Task', type: 'action', context: longContext }];
  const cd = new CommitmentDetector({ llmRouter: mockRouter(llmOutput), logger: silentLogger });
  const result = await cd.detect(makeConv('test', 'test'));
  assert.strictEqual(result[0].context.length, 100);
});

// --- Prompt construction (verify LLM receives condensed conversation) ---

asyncTest('sends condensed conversation to LLM', async () => {
  let capturedPrompt = '';
  const capturingRouter = {
    route: async ({ content }) => {
      capturedPrompt = content;
      return { result: '[]' };
    }
  };
  const cd = new CommitmentDetector({ llmRouter: capturingRouter, logger: silentLogger });
  await cd.detect(makeConv('Hello agent', 'Hello user, how can I help?'));
  assert.ok(capturedPrompt.includes('User: Hello agent'));
  assert.ok(capturedPrompt.includes('Agent: Hello user, how can I help?'));
});

// ---------------------------------------------------------------------------

setTimeout(() => { summary(); exitWithCode(); }, 100);
