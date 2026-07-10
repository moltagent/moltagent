'use strict';

/**
 * Moltagent Surface Text — one home for code-owned user-facing text
 *
 * Copyright (C) 2026 Moltagent
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Architecture Brief:
 * -------------------
 * Problem: every string a user reads that the model did not write was hardcoded
 * English, scattered across the module that happened to emit it (#276). The 🔐
 * approval prompt was the sharpest case: a German speaker asking to delete a
 * card was shown an English safety prompt and asked to type an English word
 * before an irreversible action. The one surface where comprehension is a
 * safety property was the one surface that ignored the user's language.
 *
 * Pattern: a flat table keyed by surface, then language, read through a single
 * accessor. Flat and not nested-by-feature because the coverage pin asserts
 * against shape, and nesting defeats it.
 *
 * This is OUTPUT TEMPLATING on a code-owned surface, not language handling
 * (CLAUDE.md Rule 1). Nothing here reads prose, detects a language, or
 * translates at runtime. The language arrives as a fact — the classification
 * verdict's reading of the message, resolved once by
 * `MessageProcessor._resolveMessageLanguage()` (#273) — and this module renders
 * a sentence in it. Adding a language edits the table, never a code path.
 *
 * The distinction that decides membership: a string belongs here when it
 * reaches Talk VERBATIM. A string fed to a model that re-narrates it is a
 * tier-2 prompt and stays English — the model is the language layer for those.
 * So `ACTION_REPROMPT_DIRECTIVE` and `checkApproval`'s `reason` are absent by
 * design, while `narrateOutcome`'s fallback (which reaches Talk when the
 * narration call fails) is present.
 *
 * Key Dependencies: none, and deliberately so. Importing the HITL marker from
 * guardrail-enforcer would cycle, since the enforcer reads this table. The
 * marker is prefixed by its owner; the table holds only the words.
 *
 * @module agent/surface-text
 */

/** The languages this system carries code-owned text in. */
const SURFACE_LANGUAGES = ['EN', 'DE', 'PT'];

/**
 * The table. Every key exists in every language in SURFACE_LANGUAGES, with an
 * identical placeholder set across the three — the coverage pin enforces both,
 * and `test/unit/agent/surface-text.test.js` mutation-tests the pin itself.
 *
 * Portuguese is European Portuguese ("eliminar", not "deletar"), matching the
 * register the honesty trailer established.
 */
const SURFACE_TEXT = {
  // ── The honesty floor (#81 commit 2) — this table's first entries, ───────
  // relocated from action-guard.js. It states a fact about what the turn did
  // and claims nothing about why, so it sits beneath the model's narration
  // rather than replacing it.
  no_action_trailer: {
    EN: '⚠️ No action was executed — nothing was created, changed, or deleted.',
    DE: '⚠️ Es wurde keine Aktion ausgeführt — nichts wurde erstellt, geändert oder gelöscht.',
    PT: '⚠️ Nenhuma ação foi executada — nada foi criado, alterado ou eliminado.',
  },

  // ── The 🔐 approval ceremony (ToolGuard APPROVAL_REQUIRED path) ──────────
  // The marker codepoint is prefixed by GuardrailEnforcer, which owns it.
  tool_approval_header: {
    EN: '**{label}** — requires approval',
    DE: '**{label}** — Freigabe erforderlich',
    PT: '**{label}** — requer aprovação',
  },
  tool_approval_irreversible: {
    EN: '⚠️ This cannot be undone.',
    DE: '⚠️ Das kann nicht rückgängig gemacht werden.',
    PT: '⚠️ Isto não pode ser anulado.',
  },
  tool_approval_cancellation_notice: {
    EN: '⚠️ Cancellation notices will be sent to attendees.',
    DE: '⚠️ Absagen werden an alle Teilnehmenden gesendet.',
    PT: '⚠️ Serão enviadas notificações de cancelamento aos participantes.',
  },
  // The user answers in their own language; `classifyPendingReply` is an LLM
  // (#263 removed the English-only regexes), so "ja" and "sim" resolve.
  tool_approval_reply: {
    EN: 'Reply **yes** to approve or **no** to deny.',
    DE: 'Antworte **ja** zum Freigeben oder **nein** zum Ablehnen.',
    PT: 'Responde **sim** para aprovar ou **não** para recusar.',
  },

  // ── Tool labels: the name of the act, as the user reads it ───────────────
  tool_label_deck_delete_card: {
    EN: 'Delete Deck card', DE: 'Deck-Karte löschen', PT: 'Eliminar cartão do Deck',
  },
  tool_label_deck_delete_board: {
    EN: 'Delete Deck board', DE: 'Deck-Board löschen', PT: 'Eliminar quadro do Deck',
  },
  tool_label_deck_delete_stack: {
    EN: 'Delete Deck stack', DE: 'Deck-Stapel löschen', PT: 'Eliminar pilha do Deck',
  },
  tool_label_deck_setup_workflow: {
    EN: 'Set up Deck workflow', DE: 'Deck-Workflow einrichten', PT: 'Configurar fluxo de trabalho do Deck',
  },
  tool_label_deck_share_board: {
    EN: 'Share board', DE: 'Board teilen', PT: 'Partilhar quadro',
  },
  tool_label_file_delete: {
    EN: 'Delete file', DE: 'Datei löschen', PT: 'Eliminar ficheiro',
  },
  tool_label_file_move: {
    EN: 'Move file', DE: 'Datei verschieben', PT: 'Mover ficheiro',
  },
  tool_label_file_write: {
    EN: 'Write file', DE: 'Datei schreiben', PT: 'Escrever ficheiro',
  },
  tool_label_file_share: {
    EN: 'Share file', DE: 'Datei teilen', PT: 'Partilhar ficheiro',
  },
  tool_label_calendar_create_event: {
    EN: 'Create calendar event', DE: 'Kalendereintrag erstellen', PT: 'Criar evento no calendário',
  },
  tool_label_calendar_update_event: {
    EN: 'Update calendar event', DE: 'Kalendereintrag aktualisieren', PT: 'Atualizar evento no calendário',
  },
  tool_label_calendar_delete_event: {
    EN: 'Delete calendar event', DE: 'Kalendereintrag löschen', PT: 'Eliminar evento do calendário',
  },
  tool_label_calendar_cancel_meeting: {
    EN: 'Cancel meeting', DE: 'Termin absagen', PT: 'Cancelar reunião',
  },
  tool_label_wiki_write: {
    EN: 'Write wiki page', DE: 'Wiki-Seite schreiben', PT: 'Escrever página wiki',
  },
  tool_label_wiki_delete: {
    EN: 'Delete wiki page', DE: 'Wiki-Seite löschen', PT: 'Eliminar página wiki',
  },
  tool_label_mail_send: {
    EN: 'Send email', DE: 'E-Mail senden', PT: 'Enviar email',
  },

  // ── Field labels, shared by the 🔐 prompt and the confirmation templates ──
  field_card:        { EN: 'Card',       DE: 'Karte',        PT: 'Cartão' },
  field_board:       { EN: 'Board',      DE: 'Board',        PT: 'Quadro' },
  field_path:        { EN: 'Path',       DE: 'Pfad',         PT: 'Caminho' },
  field_page:        { EN: 'Page',       DE: 'Seite',        PT: 'Página' },
  field_with:        { EN: 'With',       DE: 'Mit',          PT: 'Com' },
  field_permission:  { EN: 'Permission', DE: 'Berechtigung', PT: 'Permissão' },
  field_event:       { EN: 'Event',      DE: 'Termin',       PT: 'Evento' },
  field_calendar:    { EN: 'Calendar',   DE: 'Kalender',     PT: 'Calendário' },
  field_reason:      { EN: 'Reason',     DE: 'Grund',        PT: 'Motivo' },
  field_to:          { EN: 'To',         DE: 'An',           PT: 'Para' },
  field_from:        { EN: 'From',       DE: 'Von',          PT: 'De' },
  field_cc:          { EN: 'CC',         DE: 'CC',           PT: 'CC' },
  field_subject:     { EN: 'Subject',    DE: 'Betreff',      PT: 'Assunto' },
  field_file:        { EN: 'File',       DE: 'Datei',        PT: 'Ficheiro' },
  field_action:      { EN: 'Action',     DE: 'Aktion',       PT: 'Ação' },
  field_title:       { EN: 'Title',      DE: 'Titel',        PT: 'Título' },
  field_date:        { EN: 'Date',       DE: 'Datum',        PT: 'Data' },
  field_location:    { EN: 'Location',   DE: 'Ort',          PT: 'Local' },
  field_attendees:   { EN: 'Attendees',  DE: 'Teilnehmende', PT: 'Participantes' },
  field_preview:     { EN: 'Preview',    DE: 'Vorschau',     PT: 'Pré-visualização' },

  // ── Placeholders for absent arguments ────────────────────────────────────
  placeholder_no_body:      { EN: '(no body)',       DE: '(kein Text)',     PT: '(sem corpo)' },
  placeholder_no_recipient: { EN: '(no recipient)',  DE: '(kein Empfänger)', PT: '(sem destinatário)' },
  placeholder_no_subject:   { EN: '(no subject)',    DE: '(kein Betreff)',  PT: '(sem assunto)' },
  placeholder_no_title:     { EN: '(no title)',      DE: '(kein Titel)',    PT: '(sem título)' },
  placeholder_unknown_file: { EN: '(unknown file)',  DE: '(unbekannte Datei)', PT: '(ficheiro desconhecido)' },
  placeholder_unknown_event:{ EN: '(unknown event)', DE: '(unbekannter Termin)', PT: '(evento desconhecido)' },
  placeholder_unknown_page: { EN: '(unknown page)',  DE: '(unbekannte Seite)', PT: '(página desconhecida)' },
  placeholder_unknown:      { EN: '(unknown)',       DE: '(unbekannt)',     PT: '(desconhecido)' },

  // ── Dynamic Cockpit-guardrail confirmation templates ─────────────────────
  guardrail_attribution: {
    EN: '*Guardrail: "{title}"*',
    DE: '*Guardrail: "{title}"*',
    PT: '*Guardrail: "{title}"*',
  },
  confirm_email_header: {
    EN: '📧 **Email ready to send**',
    DE: '📧 **E-Mail bereit zum Senden**',
    PT: '📧 **Email pronto a enviar**',
  },
  confirm_email_reply: {
    EN: 'Reply **yes** to send · **no** to cancel · **edit** to revise',
    DE: 'Antworte **ja** zum Senden · **nein** zum Abbrechen · **edit** zum Überarbeiten',
    PT: 'Responde **sim** para enviar · **não** para cancelar · **edit** para rever',
  },
  confirm_file_delete_header: {
    EN: '🗑️ **File deletion requires your approval**',
    DE: '🗑️ **Das Löschen der Datei erfordert deine Freigabe**',
    PT: '🗑️ **A eliminação do ficheiro requer a tua aprovação**',
  },
  confirm_file_delete_warning: {
    EN: '⚠️ This action cannot be undone.',
    DE: '⚠️ Diese Aktion kann nicht rückgängig gemacht werden.',
    PT: '⚠️ Esta ação não pode ser anulada.',
  },
  // Shared by file deletion and calendar deletion — both offer delete/cancel.
  confirm_delete_reply: {
    EN: 'Reply **yes** to delete · **no** to cancel',
    DE: 'Antworte **ja** zum Löschen · **nein** zum Abbrechen',
    PT: 'Responde **sim** para eliminar · **não** para cancelar',
  },
  confirm_file_move_header: {
    EN: '📁 **File move requires your approval**',
    DE: '📁 **Das Verschieben der Datei erfordert deine Freigabe**',
    PT: '📁 **A mudança do ficheiro requer a tua aprovação**',
  },
  confirm_proceed_reply: {
    EN: 'Reply **yes** to proceed · **no** to cancel',
    DE: 'Antworte **ja** zum Fortfahren · **nein** zum Abbrechen',
    PT: 'Responde **sim** para continuar · **não** para cancelar',
  },
  confirm_calendar_header: {
    EN: '📅 **Calendar change requires your approval**',
    DE: '📅 **Die Kalenderänderung erfordert deine Freigabe**',
    PT: '📅 **A alteração do calendário requer a tua aprovação**',
  },
  confirm_calendar_reply: {
    EN: 'Reply **yes** to confirm · **no** to cancel · **edit** to revise',
    DE: 'Antworte **ja** zum Bestätigen · **nein** zum Abbrechen · **edit** zum Überarbeiten',
    PT: 'Responde **sim** para confirmar · **não** para cancelar · **edit** para rever',
  },
  confirm_calendar_delete_header: {
    EN: '📅 **Calendar deletion requires your approval**',
    DE: '📅 **Das Löschen des Kalendereintrags erfordert deine Freigabe**',
    PT: '📅 **A eliminação do evento requer a tua aprovação**',
  },
  confirm_calendar_delete_warning: {
    EN: '⚠️ This will remove the event from all attendees.',
    DE: '⚠️ Der Termin wird bei allen Teilnehmenden entfernt.',
    PT: '⚠️ Isto remove o evento de todos os participantes.',
  },
  confirm_wiki_write_header: {
    EN: '📖 **Wiki write requires your approval**',
    DE: '📖 **Das Schreiben der Wiki-Seite erfordert deine Freigabe**',
    PT: '📖 **A escrita da página wiki requer a tua aprovação**',
  },
  confirm_wiki_write_reply: {
    EN: 'Reply **yes** to save · **no** to cancel · **edit** to revise',
    DE: 'Antworte **ja** zum Speichern · **nein** zum Abbrechen · **edit** zum Überarbeiten',
    PT: 'Responde **sim** para guardar · **não** para cancelar · **edit** para rever',
  },
  confirm_generic_header: {
    EN: '⚠️ **Action requires your approval**',
    DE: '⚠️ **Die Aktion erfordert deine Freigabe**',
    PT: '⚠️ **A ação requer a tua aprovação**',
  },
  confirm_generic_intent: {
    EN: "I'm about to: **{action}**",
    DE: 'Ich bin dabei: **{action}**',
    PT: 'Estou prestes a: **{action}**',
  },
  calendar_action_create: { EN: 'Create event', DE: 'Termin erstellen', PT: 'Criar evento' },
  calendar_action_update: { EN: 'Update event', DE: 'Termin aktualisieren', PT: 'Atualizar evento' },
  calendar_action_other:  { EN: 'Calendar action', DE: 'Kalenderaktion', PT: 'Ação de calendário' },

  // ── The generic confirmation's verb phrases ──────────────────────────────
  generic_action_mail_send: {
    EN: 'send an email', DE: 'eine E-Mail senden', PT: 'enviar um email',
  },
  generic_action_file_delete: {
    EN: 'delete a file', DE: 'eine Datei löschen', PT: 'eliminar um ficheiro',
  },
  generic_action_file_move: {
    EN: 'move a file', DE: 'eine Datei verschieben', PT: 'mover um ficheiro',
  },
  generic_action_file_share: {
    EN: 'share a file', DE: 'eine Datei teilen', PT: 'partilhar um ficheiro',
  },
  generic_action_calendar_create_event: {
    EN: 'create a calendar event', DE: 'einen Kalendereintrag erstellen', PT: 'criar um evento no calendário',
  },
  generic_action_calendar_update_event: {
    EN: 'update a calendar event', DE: 'einen Kalendereintrag aktualisieren', PT: 'atualizar um evento no calendário',
  },
  generic_action_calendar_delete_event: {
    EN: 'delete a calendar event', DE: 'einen Kalendereintrag löschen', PT: 'eliminar um evento do calendário',
  },
  generic_action_calendar_cancel_meeting: {
    EN: 'cancel a meeting', DE: 'einen Termin absagen', PT: 'cancelar uma reunião',
  },
  generic_action_wiki_delete: {
    EN: 'delete a wiki page', DE: 'eine Wiki-Seite löschen', PT: 'eliminar uma página wiki',
  },
  generic_action_deck_delete_card: {
    EN: 'delete a Deck card', DE: 'eine Deck-Karte löschen', PT: 'eliminar um cartão do Deck',
  },
  generic_action_deck_share_board: {
    EN: 'share a Deck board', DE: 'ein Deck-Board teilen', PT: 'partilhar um quadro do Deck',
  },
  generic_action_fallback: {
    EN: 'perform an action ({tool})',
    DE: 'eine Aktion ausführen ({tool})',
    PT: 'executar uma ação ({tool})',
  },

  // ── Resolution of a PendingAction, in the language the offer was born in ──
  // These reach `narrateOutcome` as its `outcome`, and reach Talk verbatim on
  // its fallback path when the narration call fails.
  outcome_done: {
    EN: 'Done.', DE: 'Erledigt.', PT: 'Feito.',
  },
  outcome_failed: {
    EN: 'The action failed: {error}',
    DE: 'Die Aktion ist fehlgeschlagen: {error}',
    PT: 'A ação falhou: {error}',
  },
  outcome_cancelled: {
    EN: 'Cancelled at your request. Nothing was changed.',
    DE: 'Auf deinen Wunsch abgebrochen. Es wurde nichts geändert.',
    PT: 'Cancelado a teu pedido. Nada foi alterado.',
  },

  // ── Terminal fallbacks that reach Talk verbatim ──────────────────────────
  fallback_max_iterations: {
    EN: 'I ran into a loop trying to process your request. Please try rephrasing.',
    DE: 'Ich bin bei deiner Anfrage in eine Schleife geraten. Bitte formuliere sie anders.',
    PT: 'Entrei num ciclo ao processar o teu pedido. Tenta reformulá-lo, por favor.',
  },
  // The outermost catch, where classification itself may be what threw. Its
  // language comes from the persona, because no verdict survived to read.
  fallback_unexpected_error: {
    EN: 'I ran into an unexpected error processing your message. Could you try rephrasing?',
    DE: 'Bei der Verarbeitung deiner Nachricht ist ein unerwarteter Fehler aufgetreten. Kannst du sie anders formulieren?',
    PT: 'Ocorreu um erro inesperado ao processar a tua mensagem. Podes reformulá-la?',
  },
  fallback_processing_trouble: {
    EN: 'I had trouble processing that. Could you rephrase or simplify your request?',
    DE: 'Ich hatte Schwierigkeiten damit. Kannst du deine Anfrage anders oder einfacher formulieren?',
    PT: 'Tive dificuldade em processar isso. Podes reformular ou simplificar o teu pedido?',
  },
};

/**
 * The module's single language normalizer, relocated from `action-guard.js`'s
 * `_trailerKey` and now serving every surface rather than one.
 *
 * Accepts the shapes the resolved language actually arrives in: 'DE', 'de',
 * 'DE+EN' (the bilingual persona setting), null. Anything this table does not
 * carry falls back to EN rather than guessing.
 *
 * The `split('+')` is string manipulation on a Cockpit setting's known format,
 * not parsing of natural language.
 *
 * @param {string|null|undefined} language
 * @returns {'EN'|'DE'|'PT'}
 */
function normalizeLanguage(language) {
  const key = String(language || 'EN').toUpperCase().split('+')[0].trim();
  return SURFACE_LANGUAGES.includes(key) ? key : 'EN';
}

/** Matches this table's own `{placeholder}` tokens — never user prose. */
const PLACEHOLDER_TOKEN = /\{(\w+)\}/g;

/**
 * The placeholder names a template declares, as a Set. The coverage pin uses
 * this to assert that a key's three languages agree on their parameters.
 *
 * @param {string} template
 * @returns {Set<string>}
 */
function placeholdersOf(template) {
  return new Set(Array.from(template.matchAll(PLACEHOLDER_TOKEN), m => m[1]));
}

/**
 * Whether the table carries this key. Callers with an open-ended key space
 * (any tool name, any argument name) ask before rendering, and fall back to the
 * raw identifier rather than crashing on a tool nobody wrote a label for.
 *
 * @param {string} key
 * @returns {boolean}
 */
function hasSurfaceText(key) {
  return Object.prototype.hasOwnProperty.call(SURFACE_TEXT, key);
}

/**
 * Render one surface in one language.
 *
 * Unknown keys and missing parameters THROW rather than degrade. Both are
 * structural errors the coverage pin makes unshippable, and the failure
 * direction is the safe one: an approval prompt that cannot render is an
 * approval that does not happen. A silent fallback would put a raw key, or the
 * literal text `{card}`, in front of a user deciding whether to delete
 * something.
 *
 * @param {string} key - A key of SURFACE_TEXT
 * @param {string|null|undefined} language - Resolved message language (#273)
 * @param {Object} [params] - Values for the template's `{placeholders}`
 * @returns {string}
 * @throws {Error} on an unknown key or an unsupplied placeholder
 */
function surfaceText(key, language, params = {}) {
  if (!hasSurfaceText(key)) {
    throw new Error(`[surfaceText] Unknown key: ${key}`);
  }
  const template = SURFACE_TEXT[key][normalizeLanguage(language)];

  return template.replace(PLACEHOLDER_TOKEN, (_match, name) => {
    if (!Object.prototype.hasOwnProperty.call(params, name)) {
      throw new Error(`[surfaceText] Missing parameter "${name}" for key: ${key}`);
    }
    return String(params[name]);
  });
}

const TOOL_LABEL_PREFIX = 'tool_label_';

/**
 * The user-facing name of a tool, falling back to the raw tool name. Tools
 * arrive from the registry, so the key space is open: a tool with no label
 * renders its identifier rather than throwing inside an approval prompt.
 *
 * @param {string} toolName
 * @param {string|null|undefined} language
 * @returns {string}
 */
function toolLabel(toolName, language) {
  const key = `${TOOL_LABEL_PREFIX}${toolName}`;
  return hasSurfaceText(key) ? surfaceText(key, language) : toolName;
}

/**
 * Every tool this table names, derived from the keys rather than kept as a
 * second list. The pins that used to read `TOOL_APPROVAL_LABELS` read this:
 * a label must name a registered tool, and a retired tool must lose its label.
 *
 * @returns {string[]} tool names
 */
function labelledTools() {
  return Object.keys(SURFACE_TEXT)
    .filter(key => key.startsWith(TOOL_LABEL_PREFIX))
    .map(key => key.slice(TOOL_LABEL_PREFIX.length));
}

/**
 * The user-facing name of a field label key, falling back to the key's own
 * suffix. Same open-key-space reasoning as `toolLabel`: an unmapped tool
 * renders its raw argument names.
 *
 * @param {string} labelKey - e.g. 'field_card'
 * @param {string|null|undefined} language
 * @returns {string}
 */
function fieldLabel(labelKey, language) {
  return hasSurfaceText(labelKey) ? surfaceText(labelKey, language) : labelKey;
}

module.exports = {
  SURFACE_TEXT,
  SURFACE_LANGUAGES,
  surfaceText,
  hasSurfaceText,
  normalizeLanguage,
  placeholdersOf,
  toolLabel,
  labelledTools,
  fieldLabel,
};
