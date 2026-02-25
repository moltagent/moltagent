'use strict';

const assert = require('assert');
const { test, summary, exitWithCode } = require('../../helpers/test-runner');
const { buildMicroContext } = require('../../../src/lib/agent/micro-pipeline-context');

// -- Test 1: Returns string containing current year --
test('buildMicroContext() includes current year', () => {
  const result = buildMicroContext();
  const year = new Date().getFullYear().toString();
  assert.ok(result.includes(year), `Expected context to include "${year}", got: ${result.substring(0, 100)}`);
});

// -- Test 2: Returns string containing "Moltagent" --
test('buildMicroContext() includes "Moltagent" identity', () => {
  const result = buildMicroContext();
  assert.ok(result.includes('Moltagent'), 'Expected context to include "Moltagent"');
});

// -- Test 3: Accepts timezone parameter --
test('buildMicroContext("Europe/Berlin") formats in Berlin timezone', () => {
  const result = buildMicroContext('Europe/Berlin');
  assert.ok(result.includes('Europe/Berlin'), 'Expected timezone name in output');
});

// -- Test 4: Defaults to UTC --
test('buildMicroContext() defaults to UTC', () => {
  const result = buildMicroContext();
  assert.ok(result.includes('UTC'), 'Expected "UTC" in default output');
});

// -- Test 5: Handles undefined timezone gracefully --
test('buildMicroContext(undefined) defaults to UTC', () => {
  const result = buildMicroContext(undefined);
  assert.ok(result.includes('UTC'), 'Expected "UTC" when undefined passed');
});

// -- Test 6: Contains ISO 8601 instruction --
test('buildMicroContext() includes ISO 8601 date instruction', () => {
  const result = buildMicroContext();
  assert.ok(result.includes('ISO 8601'), 'Expected ISO 8601 date instruction');
});

// -- Test 7: Invalid timezone falls back to UTC --
test('buildMicroContext("Not/A/Timezone") falls back to UTC', () => {
  const result = buildMicroContext('Not/A/Timezone');
  assert.ok(result.includes('UTC'), 'Expected fallback to UTC for invalid timezone');
  assert.ok(result.includes('Moltagent'), 'Should still include identity');
});

// -- Test 8: Returns a string --
test('buildMicroContext() returns a string', () => {
  const result = buildMicroContext();
  assert.strictEqual(typeof result, 'string');
  assert.ok(result.length > 100, `Expected context > 100 chars, got ${result.length}`);
});

setTimeout(() => { summary(); exitWithCode(); }, 100);
