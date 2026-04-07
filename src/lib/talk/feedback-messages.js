/*
 * Moltagent - Sovereign AI Security Layer
 * Copyright (C) 2026 Moltagent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

'use strict';

/**
 * FeedbackMessages — Intent-specific chat messages sent immediately after
 * classification, before the heavy pipeline work begins.
 *
 * Architecture Brief:
 * - Problem: The agent takes 30-70s to respond. The user stares at nothing.
 * - Pattern: After classification (~2-3s), send a short in-chat message
 *   acknowledging the request and indicating what the agent is doing.
 *   Fire-and-forget — never blocks the pipeline.
 * - Key Dependencies: None (pure logic). Called by message-processor.
 * - Data Flow: intent + action + language → feedback string | null
 *
 * @module talk/feedback-messages
 * @version 2.0.0
 */

const MESSAGES = {
  EN: {
    deck: {
      deck_create:     '\u{1F4CB} Setting up that board for you...',
      deck_move:       '\u{1F4CB} Moving that card...',
      deck_query:      '\u{1F4CB} Checking your tasks...',
      default:         '\u{1F4CB} Working on your tasks...'
    },
    wiki: {
      wiki_write:      '\u{1F4BE} Saving that to my knowledge base...',
      wiki_read:       '\u{1F50D} Looking that up...',
      default:         '\u{1F50D} Searching my memory...'
    },
    calendar: {
      calendar_create: '\u{1F4C5} Adding that to your calendar...',
      calendar_query:  '\u{1F4C5} Checking your schedule...',
      calendar_update: '\u{1F4C5} Updating that event...',
      calendar_delete: '\u{1F4C5} Removing that event...',
      default:         '\u{1F4C5} Looking at your calendar...'
    },
    email: {
      email_send:      '\u{2709}\u{FE0F} Drafting that email...',
      email_read:      '\u{2709}\u{FE0F} Checking your inbox...',
      default:         '\u{2709}\u{FE0F} Working on email...'
    },
    search: { default: '\u{1F310} Searching the web for that...' },
    file: {
      file_upload:     '\u{1F4C4} Working on that file...',
      file_query:      '\u{1F4C4} Reading that file...',
      default:         '\u{1F4C4} Handling files...'
    },
    knowledge: { default: '\u{1F50D} Searching my knowledge base...' },
    compound: {
      decomposing:     '\u{1F9E9} Breaking that down into steps...',
      probing:         '\u{1F50D} Gathering information...',
      acting:          '\u{26A1} Taking action...',
      synthesizing:    '\u{1F4DD} Putting it all together...',
      default:         '\u{1F9E9} Breaking that down into steps...'
    },
    complex: { default: '\u{1F914} Let me think about that...' },
    _unknown: '\u{1F4AD} Working on that...'
  },
  DE: {
    deck: {
      deck_create:     '\u{1F4CB} Richte das Board für dich ein...',
      deck_move:       '\u{1F4CB} Verschiebe die Karte...',
      deck_query:      '\u{1F4CB} Prüfe deine Aufgaben...',
      default:         '\u{1F4CB} Arbeite an deinen Aufgaben...'
    },
    wiki: {
      wiki_write:      '\u{1F4BE} Speichere das in meiner Wissensdatenbank...',
      wiki_read:       '\u{1F50D} Schaue das nach...',
      default:         '\u{1F50D} Durchsuche meine Wissensdatenbank...'
    },
    calendar: {
      calendar_create: '\u{1F4C5} Trage das in deinen Kalender ein...',
      calendar_query:  '\u{1F4C5} Prüfe deinen Terminplan...',
      calendar_update: '\u{1F4C5} Aktualisiere den Termin...',
      calendar_delete: '\u{1F4C5} Entferne den Termin...',
      default:         '\u{1F4C5} Schaue in deinen Kalender...'
    },
    email: {
      email_send:      '\u{2709}\u{FE0F} Verfasse die E-Mail...',
      email_read:      '\u{2709}\u{FE0F} Prüfe deinen Posteingang...',
      default:         '\u{2709}\u{FE0F} Arbeite an E-Mails...'
    },
    search: { default: '\u{1F310} Suche im Web...' },
    file: {
      file_upload:     '\u{1F4C4} Bearbeite die Datei...',
      file_query:      '\u{1F4C4} Lese die Datei...',
      default:         '\u{1F4C4} Bearbeite Dateien...'
    },
    knowledge: { default: '\u{1F50D} Durchsuche meine Wissensdatenbank...' },
    compound: {
      default:         '\u{1F9E9} Zerlege das in einzelne Schritte...'
    },
    complex: { default: '\u{1F914} Lass mich darüber nachdenken...' },
    _unknown: '\u{1F4AD} Arbeite daran...'
  },
  PT: {
    deck: {
      deck_create:     '\u{1F4CB} A preparar esse board...',
      deck_move:       '\u{1F4CB} A mover esse cartão...',
      deck_query:      '\u{1F4CB} A verificar as tuas tarefas...',
      default:         '\u{1F4CB} A trabalhar nas tuas tarefas...'
    },
    wiki: {
      wiki_write:      '\u{1F4BE} A guardar na base de conhecimento...',
      wiki_read:       '\u{1F50D} A pesquisar isso...',
      default:         '\u{1F50D} A pesquisar na base de conhecimento...'
    },
    calendar: {
      calendar_create: '\u{1F4C5} A adicionar ao teu calendário...',
      calendar_query:  '\u{1F4C5} A verificar a tua agenda...',
      calendar_update: '\u{1F4C5} A atualizar esse evento...',
      calendar_delete: '\u{1F4C5} A remover esse evento...',
      default:         '\u{1F4C5} A verificar o teu calendário...'
    },
    email: {
      email_send:      '\u{2709}\u{FE0F} A redigir esse email...',
      email_read:      '\u{2709}\u{FE0F} A verificar a tua caixa de entrada...',
      default:         '\u{2709}\u{FE0F} A trabalhar no email...'
    },
    search: { default: '\u{1F310} A pesquisar na web...' },
    file: {
      file_upload:     '\u{1F4C4} A trabalhar nesse ficheiro...',
      file_query:      '\u{1F4C4} A ler esse ficheiro...',
      default:         '\u{1F4C4} A tratar dos ficheiros...'
    },
    knowledge: { default: '\u{1F50D} A pesquisar na base de conhecimento...' },
    compound: {
      default:         '\u{1F9E9} A dividir isso em passos...'
    },
    complex: { default: '\u{1F914} Deixa-me pensar nisso...' },
    _unknown: '\u{1F4AD} A trabalhar nisso...'
  }
};

// Intents that should never send feedback
const SILENT_INTENTS = new Set(['confirmation', 'confirmation_declined', 'selection', 'chitchat', 'greeting']);

/**
 * Get the appropriate feedback message for an intent + fine-grained action.
 *
 * @param {string} intent - Classified intent domain (deck, wiki, calendar, etc.)
 * @param {string} [action] - Fine-grained action (deck_create, wiki_read, etc.)
 * @param {string} [language='EN'] - ISO language code from cockpit persona
 * @returns {string|null} Feedback message, or null if no feedback should be sent
 */
function getFeedbackMessage(intent, action, language) {
  if (!intent || SILENT_INTENTS.has(intent)) return null;

  const lang = ((language || 'EN').toUpperCase().split('+')[0].trim());
  const msgs = MESSAGES[lang] || MESSAGES.EN;
  const domain = msgs[intent];

  // Unknown intent — generic feedback
  if (domain === undefined) return msgs._unknown || MESSAGES.EN._unknown;

  // Try action-specific, then default for the domain
  if (action && domain[action]) return domain[action];
  return domain.default || msgs._unknown || MESSAGES.EN._unknown;
}

// Backward-compat alias: existing callers that destructure FEEDBACK_MESSAGES still work.
// Points to the English message table (the only table that existed pre-v2).
const FEEDBACK_MESSAGES = MESSAGES.EN;

module.exports = { getFeedbackMessage, MESSAGES, FEEDBACK_MESSAGES };
