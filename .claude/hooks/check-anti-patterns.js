#!/usr/bin/env node

/**
 * PostToolUse hook: scans edited/written .js files for anti-patterns that can be
 * detected mechanically and unambiguously.
 *
 * Wiring (.claude/settings.json): PostToolUse, matcher "Edit|Write".
 * Claude Code passes the tool call as JSON on stdin; the edited file's path is
 * at tool_input.file_path. For manual testing the path may be passed as argv[2].
 *
 * Exit codes (per the Claude Code hook contract):
 *   0 — clean, or nothing to check.
 *   2 — violation. PostToolUse cannot retroactively block an edit that already
 *       ran, but exit 2 is the only code that feeds this hook's stderr back to
 *       Claude as a correction signal. Any other non-zero code only surfaces the
 *       first stderr line as a passive transcript notice. We want Claude to read
 *       the full violation and reconsider, so violations exit 2.
 *
 * Scope — why this hook checks exactly one fixed string:
 *   A mechanical hook can only enforce a rule whose violation has a STRUCTURAL
 *   signature distinct from correct code. `role: 'sovereign'` qualifies: it
 *   loosens trust toward the cloud from outside the roster, which is never
 *   legitimate (JOBS.CREDENTIALS is key material, not a role override).
 *
 *   `forceLocal: true` does NOT qualify, despite looking like a fixed string.
 *   It is a trust-*tightening* primitive (pin a call to local for sensitive
 *   data) used pervasively and correctly — the roster mapper derives it from
 *   MODEL directives, and components set it to keep client data off the cloud.
 *   It can only narrow the boundary, never widen it, so it is not a Rule 6
 *   violation; flagging it false-positives on correct code. See issue #32 and
 *   the trust-boundary section of the dev-rules skill (tightening vs loosening).
 *
 *   A "natural-language word list" (Rule 1) does NOT qualify either. Its structural
 *   signature — three or more short bare-token strings in a collection — is
 *   shared by config enums (`new Set(['aggressive','balanced','relaxed'])`),
 *   intent-gate enums (`new Set(['greeting','chitchat','selection'])`, the
 *   CORRECT Rule 1 pattern), sentinels (`['null','none','undefined']`), unit
 *   symbols, and object-property values. Telling a word list apart from an enum
 *   requires knowing whether the tokens are matched against user language — a
 *   SEMANTIC judgment, the same interpretive call that keeps message-content
 *   matching out of this hook. Encoding it would require a list of allowed words
 *   inside the Rule 1 enforcer, i.e. the very anti-pattern it exists to catch.
 *   So the Rule 1 / Rule 8 word-list check lives in the human pre-commit
 *   checklist (the Anti-Pattern Checklist in the dev-rules skill), not here.
 *   Do not re-add a content-based word-list detector: it false-positives on
 *   correct code and trains its reader to ignore it. See issue #32.
 */

const fs = require('fs');

// ── Resolve the target file path: argv[2] (manual) or stdin JSON (real hook) ──
function resolveFilePath() {
  if (process.argv[2]) return process.argv[2];
  let raw;
  try {
    raw = fs.readFileSync(0, 'utf-8');
  } catch {
    return null; // no stdin available
  }
  try {
    const payload = JSON.parse(raw);
    return payload?.tool_input?.file_path || null;
  } catch {
    return null; // not JSON we understand
  }
}

const filePath = resolveFilePath();
if (!filePath) process.exit(0);

// Only check JS files.
if (!filePath.endsWith('.js')) process.exit(0);

// Don't check test files (they legitimately contain anti-patterns as test data).
if (filePath.includes('/test/') || filePath.includes('.test.')) process.exit(0);

// Don't check the CC tooling itself. Hook scripts carry the marker strings as
// detection logic and documentation, not as live trust decisions; the enforcer
// must not enforce against the enforcement tooling.
if (/(?:^|\/)\.claude\//.test(filePath)) process.exit(0);

let content;
try {
  content = fs.readFileSync(filePath, 'utf-8');
} catch {
  process.exit(0); // Can't read = skip
}

const violations = [];

// ── Trust boundary: no per-component override that loosens trust toward cloud ──
// `role: 'sovereign'` routes to cloud from outside the roster. It is never
// legitimate (JOBS.CREDENTIALS is key material, not a role). Fixed string, no
// interpretation. Trust-tightening (`forceLocal: true`) is deliberately NOT
// checked here — see the header note.
const sovereignPattern = /role:\s*['"]sovereign['"]/g;
while (sovereignPattern.exec(content) !== null) {
  violations.push(
    `⛔ ANTI-PATTERN: Hardcoded role: 'sovereign' detected.\n` +
    `   Trust boundary is the single control: a per-component override that loosens trust toward cloud\n` +
    `   bypasses the roster chain. The ONLY exception is JOBS.CREDENTIALS.\n` +
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
  console.error('Read .claude/skills/moltagent-dev-rules/SKILL.md for full details.');
  console.error('='.repeat(60) + '\n');

  // Exit 2: surface the violation to Claude as a correction signal (see header).
  process.exit(2);
}

// All clear
process.exit(0);
