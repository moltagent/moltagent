/*
 * Moltagent - Sovereign AI Security Layer
 * Copyright (C) 2026 Moltagent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * LearningLog Unit Tests
 *
 * Architecture Brief:
 * -------------------
 * Problem: Verify that LearningLog correctly queues entries, formats markdown,
 * parses existing logs, and handles WebDAV read/write via NCRequestManager.
 *
 * Pattern: Mock-based unit testing with a mock NCRequestManager.
 * NCRequestManager.request() returns { status, headers, body, fromCache }.
 * For text content, body is a raw string. For JSON, body is parsed object.
 *
 * Run: node test/unit/knowledge/learning-log.test.js
 *
 * @module test/unit/knowledge/learning-log
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

// Import module under test
const { LearningLog } = require('../../../src/lib/knowledge/learning-log');

// ============================================================
// Test Helpers
// ============================================================

/**
 * Create a mock NCRequestManager that records calls and returns configured responses.
 * @param {Array<Object>} responses - Array of {status, body, headers} to return in order
 * @returns {Object} Mock NCRequestManager
 */
function createMockNC(responses = []) {
  let callIndex = 0;
  const calls = [];

  return {
    ncUrl: 'https://cloud.example.com',
    ncUser: 'testuser',
    request: async (path, options = {}) => {
      const call = { path, options, index: callIndex };
      calls.push(call);
      const response = responses[callIndex] || { status: 200, body: '', headers: {} };
      callIndex++;
      return typeof response === 'function' ? response(path, options) : response;
    },
    getCalls: () => calls,
    getCall: (i) => calls[i],
    callCount: () => calls.length,
    reset: () => { callIndex = 0; calls.length = 0; }
  };
}

// ============================================================
// Tests: Constructor
// ============================================================

console.log('');
console.log('=== LearningLog Tests ===');
console.log('');

test('constructor sets defaults', () => {
  const mockNC = createMockNC();
  const log = new LearningLog({ ncRequestManager: mockNC });

  assert.strictEqual(log.logPath, '/Memory/LearningLog.md');
  assert.strictEqual(log.username, 'moltagent');
  assert.strictEqual(log.writeDebounceMs, 5000);
  assert.deepStrictEqual(log.pendingWrites, []);
  assert.strictEqual(log.writeTimer, null);
});

test('constructor accepts custom options', () => {
  const mockNC = createMockNC();
  const log = new LearningLog({
    ncRequestManager: mockNC,
    logPath: '/Custom/Log.md',
    username: 'customuser',
    writeDebounceMs: 1000
  });

  assert.strictEqual(log.logPath, '/Custom/Log.md');
  assert.strictEqual(log.username, 'customuser');
  assert.strictEqual(log.writeDebounceMs, 1000);
});

test('_webdavPath constructs correct path', () => {
  const mockNC = createMockNC();
  const log = new LearningLog({ ncRequestManager: mockNC });

  assert.strictEqual(log._webdavPath(), '/remote.php/dav/files/moltagent/Memory/LearningLog.md');
});

test('_webdavPath uses custom username', () => {
  const mockNC = createMockNC();
  const log = new LearningLog({ ncRequestManager: mockNC, username: 'fu' });

  assert.strictEqual(log._webdavPath(), '/remote.php/dav/files/fu/Memory/LearningLog.md');
});

// ============================================================
// Tests: log() and convenience methods
// ============================================================

asyncTest('log() queues entries for batched writing', async () => {
  const mockNC = createMockNC();
  const log = new LearningLog({ ncRequestManager: mockNC, writeDebounceMs: 60000 });

  await log.learned('John leads Q3 Campaign', '@sarah');
  await log.learned('Budget is 50k', '@finance');

  assert.strictEqual(log.pendingWrites.length, 2);
  assert.strictEqual(log.pendingWrites[0].type, 'learned');
  assert.strictEqual(log.pendingWrites[0].content, 'John leads Q3 Campaign');
  assert.strictEqual(log.pendingWrites[1].content, 'Budget is 50k');

  // Clean up timer
  await log.shutdown();
});

asyncTest('log() includes timestamp and metadata', async () => {
  const mockNC = createMockNC([
    { status: 404, body: '', headers: {} },
    { status: 201, body: '', headers: {} }
  ]);
  const log = new LearningLog({ ncRequestManager: mockNC, writeDebounceMs: 60000 });

  const entry = await log.learned('Test fact', '@user', 'high');

  assert.ok(entry.timestamp);
  assert.strictEqual(entry.type, 'learned');
  assert.strictEqual(entry.confidence, 'high');
  assert.strictEqual(entry.source, '@user');
  assert.strictEqual(entry.content, 'Test fact');

  await log.shutdown();
});

asyncTest('uncertain() creates entry with low confidence', async () => {
  const mockNC = createMockNC([
    { status: 404, body: '', headers: {} },
    { status: 201, body: '', headers: {} }
  ]);
  const log = new LearningLog({ ncRequestManager: mockNC, writeDebounceMs: 60000 });

  const entry = await log.uncertain('Q3 timeline unclear', '@pm');

  assert.strictEqual(entry.type, 'uncertainty');
  assert.strictEqual(entry.confidence, 'low');
  assert.strictEqual(entry.content, 'Q3 timeline unclear');

  await log.shutdown();
});

asyncTest('contradiction() creates entry with disputed confidence', async () => {
  const mockNC = createMockNC([
    { status: 404, body: '', headers: {} },
    { status: 201, body: '', headers: {} }
  ]);
  const log = new LearningLog({ ncRequestManager: mockNC, writeDebounceMs: 60000 });

  const entry = await log.contradiction('Budget is 50k or 60k?', '@finance', { taskId: 42 });

  assert.strictEqual(entry.type, 'contradiction');
  assert.strictEqual(entry.confidence, 'disputed');
  assert.deepStrictEqual(entry.context, { taskId: 42 });

  await log.shutdown();
});

asyncTest('log() schedules a write timer', async () => {
  const mockNC = createMockNC();
  const log = new LearningLog({ ncRequestManager: mockNC, writeDebounceMs: 60000 });

  await log.log({ type: 'learned', content: 'test', source: 'test' });

  assert.notStrictEqual(log.writeTimer, null);

  await log.shutdown();
});

// ============================================================
// Tests: parseLog()
// ============================================================

test('parseLog parses markdown format correctly', () => {
  const mockNC = createMockNC();
  const log = new LearningLog({ ncRequestManager: mockNC });

  const markdown = `# Moltagent Learning Log

## 2026-02-06

### 15:42 - Learned: John leads Q3 Campaign
- **Source:** @sarah
- **Confidence:** High

### 14:20 - Updated: Budget changed to 60k
- **Source:** @finance
- **Confidence:** Medium

`;

  const entries = log.parseLog(markdown, 10);

  assert.strictEqual(entries.length, 2);
  // Most recent first
  assert.strictEqual(entries[0].content, 'Budget changed to 60k');
  assert.strictEqual(entries[0].type, 'updated');
  assert.strictEqual(entries[0].source, '@finance');
  assert.strictEqual(entries[0].confidence, 'Medium');
  assert.strictEqual(entries[1].content, 'John leads Q3 Campaign');
  assert.strictEqual(entries[1].type, 'learned');
});

test('parseLog respects limit parameter', () => {
  const mockNC = createMockNC();
  const log = new LearningLog({ ncRequestManager: mockNC });

  const markdown = `# Moltagent Learning Log

## 2026-02-06

### 15:42 - Learned: Fact A
- **Source:** src1
- **Confidence:** High

### 14:20 - Learned: Fact B
- **Source:** src2
- **Confidence:** High

### 13:00 - Learned: Fact C
- **Source:** src3
- **Confidence:** High

`;

  const entries = log.parseLog(markdown, 2);

  assert.strictEqual(entries.length, 2);
  // Most recent first, so Fact C (reversed order of appearance, limited to 2)
  assert.strictEqual(entries[0].content, 'Fact C');
  assert.strictEqual(entries[1].content, 'Fact B');
});

test('parseLog handles empty content', () => {
  const mockNC = createMockNC();
  const log = new LearningLog({ ncRequestManager: mockNC });

  const entries = log.parseLog('', 10);
  assert.deepStrictEqual(entries, []);
});

test('parseLog handles multiple dates', () => {
  const mockNC = createMockNC();
  const log = new LearningLog({ ncRequestManager: mockNC });

  const markdown = `# Moltagent Learning Log

## 2026-02-06

### 10:00 - Learned: Today fact
- **Source:** today
- **Confidence:** High

## 2026-02-05

### 09:00 - Learned: Yesterday fact
- **Source:** yesterday
- **Confidence:** Medium

`;

  const entries = log.parseLog(markdown, 10);

  assert.strictEqual(entries.length, 2);
  // Most recent first - the last entry in the file reverses to first
  assert.strictEqual(entries[0].content, 'Yesterday fact');
  assert.strictEqual(entries[0].timestamp, '2026-02-05T09:00:00Z');
  assert.strictEqual(entries[1].content, 'Today fact');
  assert.strictEqual(entries[1].timestamp, '2026-02-06T10:00:00Z');
});

test('parseLog extracts optional Room and User fields', () => {
  const mockNC = createMockNC();
  const log = new LearningLog({ ncRequestManager: mockNC });

  const markdown = `# Moltagent Learning Log

## 2026-02-06

### 10:00 - Uncertainty: Timeline unclear
- **Source:** @pm
- **Confidence:** Low
- **Room:** abc123
- **User:** fu

`;

  const entries = log.parseLog(markdown, 10);

  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].room, 'abc123');
  assert.strictEqual(entries[0].user, 'fu');
});

// ============================================================
// Tests: flushWrites()
// ============================================================

asyncTest('flushWrites appends to existing log via WebDAV', async () => {
  const mockNC = createMockNC([
    // GET existing log
    { status: 200, body: '# Moltagent Learning Log\n\n', headers: {} },
    // PUT updated log
    { status: 201, body: '', headers: {} }
  ]);
  const log = new LearningLog({ ncRequestManager: mockNC, writeDebounceMs: 60000 });

  await log.learned('Test entry', '@user');
  await log.flushWrites();

  const calls = mockNC.getCalls();
  assert.strictEqual(calls.length, 2);

  // First call is GET
  assert.strictEqual(calls[0].options.method, 'GET');
  assert.ok(calls[0].path.includes('/Memory/LearningLog.md'));

  // Second call is PUT
  assert.strictEqual(calls[1].options.method, 'PUT');
  assert.ok(calls[1].path.includes('/Memory/LearningLog.md'));
  assert.ok(typeof calls[1].options.body === 'string');
  assert.ok(calls[1].options.body.includes('Test entry'));
  assert.ok(calls[1].options.body.includes('# Moltagent Learning Log'));
});

asyncTest('flushWrites creates new log if none exists (404)', async () => {
  const mockNC = createMockNC([
    // GET returns 404
    { status: 404, body: '', headers: {} },
    // PUT creates file
    { status: 201, body: '', headers: {} }
  ]);
  const log = new LearningLog({ ncRequestManager: mockNC, writeDebounceMs: 60000 });

  await log.learned('First entry', '@user');
  await log.flushWrites();

  const calls = mockNC.getCalls();
  assert.strictEqual(calls.length, 2);

  // PUT body should contain the header
  const putBody = calls[1].options.body;
  assert.ok(putBody.includes('# Moltagent Learning Log'));
  assert.ok(putBody.includes('First entry'));
});

asyncTest('flushWrites does nothing when no pending writes', async () => {
  const mockNC = createMockNC();
  const log = new LearningLog({ ncRequestManager: mockNC, writeDebounceMs: 60000 });

  await log.flushWrites();

  assert.strictEqual(mockNC.callCount(), 0);
});

asyncTest('flushWrites re-queues entries on write failure', async () => {
  const mockNC = createMockNC([
    // GET succeeds
    { status: 200, body: '# Moltagent Learning Log\n\n', headers: {} },
    // PUT fails
    { status: 500, body: 'Server Error', headers: {} }
  ]);
  const log = new LearningLog({ ncRequestManager: mockNC, writeDebounceMs: 60000 });

  await log.learned('Important fact', '@user');
  assert.strictEqual(log.pendingWrites.length, 1);

  await log.flushWrites();

  // Entry should be re-queued
  assert.strictEqual(log.pendingWrites.length, 1);
  assert.strictEqual(log.pendingWrites[0].content, 'Important fact');
});

asyncTest('flushWrites batches multiple entries into one write', async () => {
  const mockNC = createMockNC([
    { status: 200, body: '# Moltagent Learning Log\n\n', headers: {} },
    { status: 201, body: '', headers: {} }
  ]);
  const log = new LearningLog({ ncRequestManager: mockNC, writeDebounceMs: 60000 });

  await log.learned('Fact A', '@user1');
  await log.learned('Fact B', '@user2');
  await log.uncertain('Fact C', '@user3');

  assert.strictEqual(log.pendingWrites.length, 3);

  await log.flushWrites();

  // Only 2 API calls: 1 GET + 1 PUT
  assert.strictEqual(mockNC.callCount(), 2);

  // PUT body should contain all entries
  const putBody = mockNC.getCall(1).options.body;
  assert.ok(putBody.includes('Fact A'));
  assert.ok(putBody.includes('Fact B'));
  assert.ok(putBody.includes('Fact C'));

  assert.strictEqual(log.pendingWrites.length, 0);
});

// ============================================================
// Tests: _formatEntries() and _appendToLog()
// ============================================================

test('_formatEntries produces valid markdown', () => {
  const mockNC = createMockNC();
  const log = new LearningLog({ ncRequestManager: mockNC });

  const entries = [
    {
      timestamp: '2026-02-06T15:42:00.000Z',
      type: 'learned',
      content: 'John leads Q3',
      source: '@sarah',
      confidence: 'high',
      context: {}
    }
  ];

  const md = log._formatEntries(entries);

  assert.ok(md.includes('## 2026-02-06'));
  assert.ok(md.includes('### 15:42 - Learned: John leads Q3'));
  assert.ok(md.includes('- **Source:** @sarah'));
  assert.ok(md.includes('- **Confidence:** High'));
});

test('_formatEntries includes room and user context', () => {
  const mockNC = createMockNC();
  const log = new LearningLog({ ncRequestManager: mockNC });

  const entries = [
    {
      timestamp: '2026-02-06T10:00:00.000Z',
      type: 'uncertainty',
      content: 'Timeline unclear',
      source: '@pm',
      confidence: 'low',
      context: { roomToken: 'abc123', userId: 'fu' }
    }
  ];

  const md = log._formatEntries(entries);

  assert.ok(md.includes('- **Room:** abc123'));
  assert.ok(md.includes('- **User:** fu'));
});

test('_appendToLog creates new log when empty', () => {
  const mockNC = createMockNC();
  const log = new LearningLog({ ncRequestManager: mockNC });

  const result = log._appendToLog('', '## 2026-02-06\n\n### 10:00 - Learned: Test\n');

  assert.ok(result.startsWith('# Moltagent Learning Log'));
  assert.ok(result.includes('## 2026-02-06'));
});

test('_appendToLog inserts after header', () => {
  const mockNC = createMockNC();
  const log = new LearningLog({ ncRequestManager: mockNC });

  const existing = '# Moltagent Learning Log\n\n## 2026-02-05\n\n### 09:00 - Learned: Old fact\n';
  const newEntries = '## 2026-02-06\n\n### 10:00 - Learned: New fact\n';

  const result = log._appendToLog(existing, newEntries);

  // New entries should come before old date
  const newIndex = result.indexOf('2026-02-06');
  const oldIndex = result.indexOf('2026-02-05');
  assert.ok(newIndex < oldIndex, 'New entries should be inserted before existing ones');
});

// ============================================================
// Tests: getRecent()
// ============================================================

asyncTest('getRecent returns parsed entries from WebDAV', async () => {
  const logContent = `# Moltagent Learning Log

## 2026-02-06

### 15:42 - Learned: John leads Q3
- **Source:** @sarah
- **Confidence:** High

`;

  const mockNC = createMockNC([
    { status: 200, body: logContent, headers: {} }
  ]);
  const log = new LearningLog({ ncRequestManager: mockNC });

  const entries = await log.getRecent(10);

  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].content, 'John leads Q3');
  assert.strictEqual(entries[0].source, '@sarah');
});

asyncTest('getRecent returns empty array for 404', async () => {
  const mockNC = createMockNC([
    { status: 404, body: '', headers: {} }
  ]);
  const log = new LearningLog({ ncRequestManager: mockNC });

  const entries = await log.getRecent(10);

  assert.deepStrictEqual(entries, []);
});

asyncTest('getRecent returns empty array on error', async () => {
  const mockNC = {
    ncUrl: 'https://cloud.example.com',
    ncUser: 'testuser',
    request: async () => { throw new Error('Network timeout'); }
  };
  const log = new LearningLog({ ncRequestManager: mockNC });

  const entries = await log.getRecent(10);

  assert.deepStrictEqual(entries, []);
});

// ============================================================
// Tests: shutdown()
// ============================================================

asyncTest('shutdown flushes pending writes and clears timer', async () => {
  const mockNC = createMockNC([
    { status: 404, body: '', headers: {} },
    { status: 201, body: '', headers: {} }
  ]);
  const log = new LearningLog({ ncRequestManager: mockNC, writeDebounceMs: 60000 });

  await log.learned('Shutdown test', '@user');
  assert.notStrictEqual(log.writeTimer, null);

  await log.shutdown();

  assert.strictEqual(log.writeTimer, null);
  assert.strictEqual(log.pendingWrites.length, 0);
  assert.strictEqual(mockNC.callCount(), 2); // GET + PUT
});

asyncTest('shutdown is safe to call with no pending writes', async () => {
  const mockNC = createMockNC();
  const log = new LearningLog({ ncRequestManager: mockNC, writeDebounceMs: 60000 });

  await log.shutdown();

  assert.strictEqual(log.writeTimer, null);
  assert.strictEqual(mockNC.callCount(), 0);
});

// ============================================================
// Tests: _capitalize()
// ============================================================

test('_capitalize capitalizes first letter', () => {
  const mockNC = createMockNC();
  const log = new LearningLog({ ncRequestManager: mockNC });

  assert.strictEqual(log._capitalize('learned'), 'Learned');
  assert.strictEqual(log._capitalize('high'), 'High');
  assert.strictEqual(log._capitalize(''), '');
});

// ============================================================
// Summary
// ============================================================

setTimeout(() => {
  summary();
  exitWithCode();
}, 500);
