/**
 * Shared test runner utilities
 *
 * Provides consistent test() and asyncTest() helpers used across all test files.
 */

let testsPassed = 0;
let testsFailed = 0;
const testResults = [];

function test(name, fn) {
  try {
    fn();
    console.log(`[PASS] ${name}`);
    testsPassed++;
    testResults.push({ name, passed: true });
  } catch (error) {
    console.log(`[FAIL] ${name}`);
    console.log(`  Error: ${error.message}`);
    testsFailed++;
    testResults.push({ name, passed: false, error: error.message });
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`[PASS] ${name}`);
    testsPassed++;
    testResults.push({ name, passed: true });
  } catch (error) {
    console.log(`[FAIL] ${name}`);
    console.log(`  Error: ${error.message}`);
    testsFailed++;
    testResults.push({ name, passed: false, error: error.message });
  }
}

function summary() {
  console.log('\n=================================');
  console.log(`Tests passed: ${testsPassed}`);
  console.log(`Tests failed: ${testsFailed}`);
  console.log('=================================\n');
  return { passed: testsPassed, failed: testsFailed, results: testResults };
}

function reset() {
  testsPassed = 0;
  testsFailed = 0;
  testResults.length = 0;
}

function exitWithCode() {
  process.exit(testsFailed > 0 ? 1 : 0);
}

module.exports = { test, asyncTest, summary, reset, exitWithCode };
