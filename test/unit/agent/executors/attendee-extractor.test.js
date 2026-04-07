/**
 * AttendeeExtractor Unit Tests
 *
 * Validates code-side attendee extraction and merge logic.
 *
 * Run: node test/unit/agent/executors/attendee-extractor.test.js
 */

const assert = require('assert');
const { test, summary, exitWithCode } = require('../../../helpers/test-runner');

const { extractAttendees, mergeAttendees } = require('../../../../src/lib/agent/executors/attendee-extractor');

console.log('\n=== AttendeeExtractor Tests ===\n');

// --- extractAttendees ---

test('finds email address in message', () => {
  const result = extractAttendees('Meeting with sarah@company.com tomorrow 10am');
  assert.ok(result.includes('sarah@company.com'), `expected sarah@company.com, got: ${result}`);
});

test('finds "with [Name]" pattern', () => {
  const result = extractAttendees('Lunch with Alex Friday noon');
  assert.ok(result.includes('Alex'), `expected Alex, got: ${result}`);
});

test('finds "with [First Last]" including accented characters', () => {
  const result = extractAttendees('Meeting with João Silva tomorrow');
  assert.ok(result.includes('João Silva'), `expected João Silva, got: ${result}`);
});

test('finds "with X and Y" pattern', () => {
  const result = extractAttendees('Meeting with Sarah and Tom at 3pm');
  assert.ok(result.includes('Sarah'), `expected Sarah, got: ${result}`);
  assert.ok(result.includes('Tom'), `expected Tom, got: ${result}`);
});

test('skips day names after "with"', () => {
  // "Monday" starts with uppercase but is a false positive
  const result = extractAttendees('Meeting with Monday agenda');
  assert.ok(!result.includes('Monday'), `should not include Monday, got: ${result}`);
});

test('skips month names after "with"', () => {
  const result = extractAttendees('Review with January figures');
  assert.ok(!result.includes('January'), `should not include January, got: ${result}`);
});

test('finds "invite [Name]" pattern', () => {
  const result = extractAttendees('Schedule standup and invite Marcus');
  assert.ok(result.includes('Marcus'), `expected Marcus, got: ${result}`);
});

test('deduplicates results', () => {
  const result = extractAttendees('Invite Sarah, meeting with Sarah at 2pm');
  const sarahCount = result.filter(a => a === 'Sarah').length;
  assert.strictEqual(sarahCount, 1, `expected 1 Sarah, got: ${sarahCount}`);
});

test('returns empty array for null/undefined input', () => {
  assert.deepStrictEqual(extractAttendees(null), []);
  assert.deepStrictEqual(extractAttendees(undefined), []);
  assert.deepStrictEqual(extractAttendees(''), []);
});

test('returns empty array when no attendees found', () => {
  const result = extractAttendees('Create a standup meeting tomorrow 9am');
  assert.deepStrictEqual(result, []);
});

// --- mergeAttendees ---

test('mergeAttendees combines LLM + code attendees', () => {
  const result = mergeAttendees(['Alice'], ['Bob']);
  assert.deepStrictEqual(result, ['Alice', 'Bob']);
});

test('mergeAttendees deduplicates case-insensitive', () => {
  const result = mergeAttendees(['sarah@co.com'], ['Sarah@co.com']);
  assert.strictEqual(result.length, 1, `expected 1 entry, got: ${result}`);
});

test('mergeAttendees handles null inputs', () => {
  assert.deepStrictEqual(mergeAttendees(null, ['Bob']), ['Bob']);
  assert.deepStrictEqual(mergeAttendees(['Alice'], null), ['Alice']);
  assert.deepStrictEqual(mergeAttendees(null, null), []);
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
