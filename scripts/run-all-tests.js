#!/usr/bin/env node
/**
 * Moltagent Test Runner
 *
 * Runs all test files and reports results.
 *
 * Usage:
 *   node scripts/run-all-tests.js          # Run all tests
 *   node scripts/run-all-tests.js --unit   # Run only unit tests
 *   node scripts/run-all-tests.js --integration  # Run only integration tests
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const runUnit = args.includes('--unit') || args.length === 0;
const runIntegration = args.includes('--integration') || args.length === 0;

const testDir = path.join(__dirname, '..', 'test');

// Collect test files
const unitTests = [];
const integrationTests = [];

function findTestFiles(dir, testArray) {
  if (!fs.existsSync(dir)) return;

  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      findTestFiles(filePath, testArray);
    } else if (file.endsWith('.test.js')) {
      testArray.push(filePath);
    }
  }
}

// Find all test files
findTestFiles(path.join(testDir, 'unit'), unitTests);
findTestFiles(path.join(testDir, 'integration'), integrationTests);

// Select tests to run
const testsToRun = [];
if (runUnit) {
  testsToRun.push(...unitTests);
}
if (runIntegration && !args.includes('--unit')) {
  testsToRun.push(...integrationTests);
}

console.log('\n============================================');
console.log('       Moltagent Test Runner');
console.log('============================================\n');

console.log(`Found ${unitTests.length} unit test files`);
console.log(`Found ${integrationTests.length} integration test files`);
console.log(`Running ${testsToRun.length} test files\n`);

// Results tracking
const results = {
  passed: 0,
  failed: 0,
  errors: [],
  files: []
};

// Run tests sequentially
async function runTest(testFile) {
  const relativePath = path.relative(process.cwd(), testFile);

  return new Promise((resolve) => {
    console.log(`\n--- Running: ${relativePath} ---\n`);

    const child = spawn('node', [testFile], {
      stdio: 'inherit',
      cwd: process.cwd()
    });

    child.on('close', (code) => {
      const fileResult = {
        file: relativePath,
        exitCode: code,
        success: code === 0
      };

      results.files.push(fileResult);

      if (code === 0) {
        results.passed++;
      } else {
        results.failed++;
        results.errors.push(relativePath);
      }

      resolve();
    });

    child.on('error', (err) => {
      console.error(`Error running ${relativePath}:`, err.message);
      results.files.push({
        file: relativePath,
        exitCode: 1,
        success: false,
        error: err.message
      });
      results.failed++;
      results.errors.push(relativePath);
      resolve();
    });
  });
}

async function runAllTests() {
  for (const testFile of testsToRun) {
    await runTest(testFile);
  }

  // Print summary
  console.log('\n============================================');
  console.log('               TEST SUMMARY');
  console.log('============================================\n');

  console.log(`Test files passed: ${results.passed}`);
  console.log(`Test files failed: ${results.failed}`);
  console.log(`Total test files:  ${testsToRun.length}`);

  if (results.errors.length > 0) {
    console.log('\nFailed test files:');
    for (const errorFile of results.errors) {
      console.log(`  - ${errorFile}`);
    }
  }

  console.log('\n============================================\n');

  // Exit with appropriate code
  process.exit(results.failed > 0 ? 1 : 0);
}

if (testsToRun.length === 0) {
  console.log('No test files found to run.');
  process.exit(0);
}

runAllTests();
