#!/usr/bin/env node

/**
 * PostToolUse hook: scans edited/written files for anti-patterns
 * that violate Moltagent dev rules.
 *
 * Runs after every Edit or Write tool call.
 * Exits 0 (pass) or 1 (fail with message).
 */

const fs = require('fs');
const path = require('path');

const filePath = process.argv[2];
if (!filePath) process.exit(0);

// Only check JS files
if (!filePath.endsWith('.js')) process.exit(0);

// Don't check test files (they may legitimately contain anti-patterns as test data)
if (filePath.includes('/test/') || filePath.includes('.test.')) process.exit(0);

let content;
try {
  content = fs.readFileSync(filePath, 'utf-8');
} catch {
  process.exit(0); // Can't read = skip
}

const violations = [];

// ── RULE 1: No natural language Sets/Arrays/Maps ──
// Detect: new Set(['word', 'word', ...]) with 3+ short string entries
const setPattern = /new\s+Set\(\[([^\]]{20,})\]\)/g;
let match;
while ((match = setPattern.exec(content)) !== null) {
  const inner = match[1];
  const strings = inner.match(/'[^']{1,20}'/g) || [];
  if (strings.length >= 3) {
    // Check if entries look like natural language words (short, lowercase)
    const nlWords = strings.filter(s => {
      const word = s.replace(/'/g, '');
      return word.length <= 15 && /^[a-züöäéèêàáãñç]+$/i.test(word);
    });
    if (nlWords.length >= 3) {
      violations.push(
        `⛔ ANTI-PATTERN: Set of natural language words detected at "${match[0].substring(0, 60)}...".\n` +
        `   Rule 1: Use the LLM for language tasks, not word lists.\n` +
        `   File: ${filePath}`
      );
    }
  }
}

// ── RULE 1: No regex on user messages ──
// Detect: message.match(/.../) or message.includes('...')
const msgRegex = /(?:message|msg|text|input|content)\.(?:match|includes|startsWith)\(/g;
while ((match = msgRegex.exec(content)) !== null) {
  // Get surrounding context
  const lineStart = content.lastIndexOf('\n', match.index) + 1;
  const lineEnd = content.indexOf('\n', match.index);
  const line = content.substring(lineStart, lineEnd).trim();

  // Skip if it's clearly plumbing (JSON, URL, path checks)
  if (line.includes('application/json') || line.includes('http') || line.includes('/')) continue;

  violations.push(
    `⚠️ WARNING: Possible natural language matching on user input.\n` +
    `   "${line.substring(0, 80)}"\n` +
    `   Rule 1: Use the LLM for language understanding, not string matching.\n` +
    `   File: ${filePath}`
  );
}

// ── RULE 6: No hardcoded sovereignty overrides ──
const sovereignPattern = /role:\s*['"]sovereign['"]/g;
while ((match = sovereignPattern.exec(content)) !== null) {
  violations.push(
    `⛔ ANTI-PATTERN: Hardcoded role: 'sovereign' detected.\n` +
    `   Rule 6: Use the trust boundary (roster chain), not per-component overrides.\n` +
    `   The ONLY exception is JOBS.CREDENTIALS.\n` +
    `   File: ${filePath}`
  );
}

const forceLocalPattern = /forceLocal:\s*true/g;
while ((match = forceLocalPattern.exec(content)) !== null) {
  violations.push(
    `⛔ ANTI-PATTERN: Hardcoded forceLocal: true detected.\n` +
    `   Rule 6: Use the trust boundary, not per-component overrides.\n` +
    `   File: ${filePath}`
  );
}

// ── REPORT ──
if (violations.length > 0) {
  console.error('\n' + '='.repeat(60));
  console.error('🚨 MOLTAGENT DEV RULES VIOLATION');
  console.error('='.repeat(60));
  violations.forEach(v => console.error('\n' + v));
  console.error('\n' + '='.repeat(60));
  console.error('Read .moltagent-dev-rules.md for full details.');
  console.error('='.repeat(60) + '\n');

  // Exit 1 to block the edit (CC will see the error and reconsider)
  process.exit(1);
}

// All clear
process.exit(0);
