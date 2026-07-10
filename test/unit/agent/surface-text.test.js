'use strict';

/**
 * Surface-text pin (#276)
 *
 * Copyright (C) 2026 Moltagent
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Bidirectional, because each half misses what the other catches:
 *
 *   Coverage — every key exists in EN/DE/PT with identical placeholder sets.
 *              Catches a missing translation, and a `{card}` that silently
 *              became `{karte}` in the DE row.
 *   Strays   — a targeted denylist over the migrated call sites. Catches a new
 *              English literal appearing at a surface already migrated.
 *
 * The pin is MUTATION-TESTED here before it is trusted. Both halves are pure
 * functions over their input, so the suite feeds them deliberately broken
 * tables and a synthetic stray and asserts they complain. A green pin that
 * cannot fail is worse than no pin: it licenses the assumption it was written
 * to check.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, summary, exitWithCode } = require('../../helpers/test-runner');

const {
  SURFACE_TEXT,
  SURFACE_LANGUAGES,
  surfaceText,
  normalizeLanguage,
  placeholdersOf,
  toolLabel,
  fieldLabel,
} = require('../../../src/lib/agent/surface-text');

// ── The pin, as pure functions ──────────────────────────────────────────────

/**
 * @param {Object} table
 * @returns {string[]} violations, empty when the table is whole
 */
function coverageViolations(table) {
  const violations = [];

  for (const [key, entry] of Object.entries(table)) {
    const reference = entry[SURFACE_LANGUAGES[0]];

    if (typeof reference !== 'string') {
      violations.push(`${key}: missing ${SURFACE_LANGUAGES[0]}`);
      continue;
    }
    const referencePlaceholders = placeholdersOf(reference);

    for (const language of SURFACE_LANGUAGES) {
      const template = entry[language];

      if (typeof template !== 'string' || template.trim() === '') {
        violations.push(`${key}: missing ${language}`);
        continue;
      }

      const placeholders = placeholdersOf(template);
      const missing = [...referencePlaceholders].filter(p => !placeholders.has(p));
      const extra = [...placeholders].filter(p => !referencePlaceholders.has(p));

      if (missing.length || extra.length) {
        violations.push(
          `${key}[${language}]: placeholder drift — missing [${missing}] extra [${extra}]`
        );
      }
    }
  }

  return violations;
}

// Phrases that lived at the migrated sites before #276. Each must now exist
// only inside surface-text.js. Fragments, not whole sentences, so a reworded
// stray is still caught.
const STRAY_PHRASES = [
  // The rendered header, em-dash included. Deliberately not the bare
  // "requires approval": `checkApproval`'s no-room-token reason contains that
  // fragment, and it is LLM-facing — a tier-2 prompt, out of scope.
  '— requires approval',
  'requires your approval',
  'Reply **yes**',
  'cannot be undone',
  'No action was executed',
  'Cancelled at your request',
  'The action failed',
  'ready to send',
  'Guardrail: "',
  "I'm about to",
  'try rephrasing',
  'trouble processing',
];

const MIGRATED_SITES = [
  'src/lib/agent/guardrail-enforcer.js',
  'src/lib/agent/action-guard.js',
  'src/lib/agent/agent-loop.js',
  'src/lib/agent/micro-pipeline.js',
  'src/lib/server/message-processor.js',
];

/**
 * @param {string} source - file contents
 * @param {string} label - file name, for the message
 * @returns {string[]} violations
 */
function strayViolations(source, label) {
  return STRAY_PHRASES
    .filter(phrase => source.includes(phrase))
    .map(phrase => `${label}: stray surface text "${phrase}"`);
}

const repoRoot = path.join(__dirname, '..', '..', '..');
const readSite = site => fs.readFileSync(path.join(repoRoot, site), 'utf8');

// ── Coverage ────────────────────────────────────────────────────────────────

test('every key carries every language, with identical placeholder sets', () => {
  assert.deepStrictEqual(coverageViolations(SURFACE_TEXT), []);
});

test('the table is flat — no nested groups to hide a key from the pin', () => {
  for (const [key, entry] of Object.entries(SURFACE_TEXT)) {
    for (const language of Object.keys(entry)) {
      assert.ok(
        SURFACE_LANGUAGES.includes(language),
        `${key} has non-language child "${language}" — the table must be key → language → string`
      );
    }
  }
});

// ── Coverage: mutation-tested ───────────────────────────────────────────────

test('MUTATION — a deleted DE row fails the coverage pin', () => {
  const mutated = JSON.parse(JSON.stringify(SURFACE_TEXT));
  delete mutated.no_action_trailer.DE;

  const violations = coverageViolations(mutated);
  assert.ok(violations.length > 0, 'pin must catch a missing translation');
  assert.ok(violations.some(v => v.includes('no_action_trailer: missing DE')), violations.join('; '));
});

test('MUTATION — an empty PT row fails the coverage pin', () => {
  const mutated = JSON.parse(JSON.stringify(SURFACE_TEXT));
  mutated.outcome_done.PT = '   ';

  assert.ok(
    coverageViolations(mutated).some(v => v.includes('outcome_done: missing PT')),
    'pin must treat a whitespace-only translation as absent'
  );
});

test('MUTATION — a renamed placeholder in one language fails the coverage pin', () => {
  const mutated = JSON.parse(JSON.stringify(SURFACE_TEXT));
  mutated.tool_approval_header.DE = '**{bezeichnung}** — Freigabe erforderlich';

  const violations = coverageViolations(mutated);
  assert.ok(
    violations.some(v => v.includes('tool_approval_header[DE]') && v.includes('placeholder drift')),
    `pin must catch {label} → {bezeichnung}: ${violations.join('; ')}`
  );
});

test('MUTATION — a dropped placeholder fails the coverage pin', () => {
  const mutated = JSON.parse(JSON.stringify(SURFACE_TEXT));
  mutated.outcome_failed.PT = 'A ação falhou.';

  assert.ok(
    coverageViolations(mutated).some(v => v.includes('outcome_failed[PT]')),
    'pin must catch a translation that silently drops {error}'
  );
});

// ── Strays ──────────────────────────────────────────────────────────────────

test('no migrated site still holds its English literals', () => {
  const violations = MIGRATED_SITES.flatMap(site => strayViolations(readSite(site), site));
  assert.deepStrictEqual(violations, []);
});

test('MUTATION — a reintroduced English literal fails the stray pin', () => {
  const resurrected = `lines.push('\\nReply **yes** to approve or **no** to deny.');`;

  assert.ok(
    strayViolations(resurrected, 'fake.js').length > 0,
    'pin must catch an English literal returning to a migrated site'
  );
});

test('MUTATION — the stray pin is not vacuous: clean source passes', () => {
  const clean = `lines.push(surfaceText('tool_approval_reply', language));`;
  assert.deepStrictEqual(strayViolations(clean, 'fake.js'), []);
});

// ── The accessor ────────────────────────────────────────────────────────────

test('normalizeLanguage takes the shapes the resolved language arrives in', () => {
  assert.strictEqual(normalizeLanguage('DE'), 'DE');
  assert.strictEqual(normalizeLanguage('de'), 'DE');
  assert.strictEqual(normalizeLanguage('DE+EN'), 'DE', 'the bilingual persona setting');
  assert.strictEqual(normalizeLanguage('pt'), 'PT');
  assert.strictEqual(normalizeLanguage(null), 'EN');
  assert.strictEqual(normalizeLanguage(undefined), 'EN');
  assert.strictEqual(normalizeLanguage('OTHER'), 'EN', 'a language the table does not carry');
  assert.strictEqual(normalizeLanguage('ja'), 'EN', 'Japanese falls back, never guesses');
});

test('surfaceText renders the requested language', () => {
  assert.ok(surfaceText('no_action_trailer', 'DE').includes('keine Aktion ausgeführt'));
  assert.ok(surfaceText('no_action_trailer', 'PT').includes('Nenhuma ação'));
  assert.ok(surfaceText('no_action_trailer', 'EN').includes('No action was executed'));
});

test('surfaceText interpolates every occurrence of a placeholder', () => {
  assert.strictEqual(
    surfaceText('tool_approval_header', 'EN', { label: 'Delete Deck card' }),
    '**Delete Deck card** — requires approval'
  );
  assert.strictEqual(
    surfaceText('tool_approval_header', 'DE', { label: 'Deck-Karte löschen' }),
    '**Deck-Karte löschen** — Freigabe erforderlich'
  );
});

test('surfaceText throws on an unknown key rather than leaking it to Talk', () => {
  assert.throws(() => surfaceText('no_such_key', 'EN'), /Unknown key: no_such_key/);
});

test('surfaceText throws on a missing parameter rather than rendering {label}', () => {
  assert.throws(
    () => surfaceText('tool_approval_header', 'EN'),
    /Missing parameter "label"/,
    'an approval prompt that cannot render must not render half of itself'
  );
});

test('toolLabel translates a known tool and falls back to the raw name', () => {
  assert.strictEqual(toolLabel('deck_delete_card', 'DE'), 'Deck-Karte löschen');
  assert.strictEqual(toolLabel('deck_delete_card', 'PT'), 'Eliminar cartão do Deck');
  assert.strictEqual(toolLabel('some_unregistered_tool', 'DE'), 'some_unregistered_tool');
});

test('fieldLabel translates a known field and falls back to the key', () => {
  assert.strictEqual(fieldLabel('field_card', 'DE'), 'Karte');
  assert.strictEqual(fieldLabel('field_card', 'PT'), 'Cartão');
  assert.strictEqual(fieldLabel('board_id', 'DE'), 'board_id', 'unmapped args render their own key');
});

// ── The safety property this module exists for ──────────────────────────────

test('every approval-ceremony surface differs across EN/DE/PT', () => {
  // A translation that was copy-pasted from EN is a silent failure the
  // coverage pin cannot see: the key exists, the placeholders match.
  const ceremonyKeys = [
    'tool_approval_header',
    'tool_approval_irreversible',
    'tool_approval_reply',
    'confirm_file_delete_header',
    'confirm_delete_reply',
    'confirm_generic_header',
    'outcome_cancelled',
  ];

  for (const key of ceremonyKeys) {
    const { EN, DE, PT } = SURFACE_TEXT[key];
    assert.notStrictEqual(DE, EN, `${key}: DE is untranslated`);
    assert.notStrictEqual(PT, EN, `${key}: PT is untranslated`);
    assert.notStrictEqual(DE, PT, `${key}: DE and PT are identical`);
  }
});

test('every tool label is translated in DE and PT', () => {
  const toolKeys = Object.keys(SURFACE_TEXT).filter(k => k.startsWith('tool_label_'));
  assert.ok(toolKeys.length >= 16, `expected the full APPROVAL label set, got ${toolKeys.length}`);

  for (const key of toolKeys) {
    const { EN, DE, PT } = SURFACE_TEXT[key];
    assert.notStrictEqual(DE, EN, `${key}: DE is untranslated`);
    assert.notStrictEqual(PT, EN, `${key}: PT is untranslated`);
  }
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
