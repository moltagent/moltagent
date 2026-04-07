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
 * AttendeeExtractor — Code-side attendee extraction from user messages.
 *
 * Architecture Brief:
 * - Problem: LLM extraction sometimes drops attendees ("with Sarah" → empty attendees array)
 * - Pattern: Regex-based extraction to supplement LLM, then merge + deduplicate
 * - Key Dependencies: None (pure functions)
 * - Data Flow: message → extractAttendees → mergeAttendees(llm, code) → final list
 *
 * @module agent/executors/attendee-extractor
 * @version 1.0.0
 */

const FALSE_POSITIVES = new Set([
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday',
  'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
  'lunch', 'dinner', 'breakfast', 'coffee', 'tea',
  'the', 'some', 'all', 'everyone', 'nobody',
]);

/**
 * Trim trailing false-positive words from a captured name.
 * "Alex Friday" → "Alex" (Friday is a day name)
 * @param {string} name
 * @returns {string}
 * @private
 */
function _trimFalsePositives(name) {
  const words = name.split(/\s+/);
  while (words.length > 0 && FALSE_POSITIVES.has(words[words.length - 1].toLowerCase())) {
    words.pop();
  }
  return words.join(' ');
}

/**
 * Extract potential attendees from raw user text.
 * Supplements LLM extraction — catches emails and "with [Name]"
 * patterns the model might drop.
 *
 * @param {string} message - User message
 * @returns {string[]} Extracted attendee names/emails
 */
function extractAttendees(message) {
  if (!message || typeof message !== 'string') return [];
  const attendees = [];

  // 1. Email addresses — highest confidence
  const emails = message.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
  attendees.push(...emails);

  // 2. "with [Name]" pattern (including accented characters)
  const withPattern = /\bwith\s+([A-Z\u00C0-\u024F][a-z\u00C0-\u024F]+(?:\s+[A-Z\u00C0-\u024F][a-z\u00C0-\u024F]+)*)/g;
  let match;
  while ((match = withPattern.exec(message)) !== null) {
    const name = _trimFalsePositives(match[1].trim());
    if (name && !FALSE_POSITIVES.has(name.toLowerCase())) attendees.push(name);
  }

  // 3. "and [Name]" after "with" — "with Sarah and Tom"
  const andAfterWith = /\bwith\s+[A-Z\u00C0-\u024F][a-z\u00C0-\u024F]+\s+and\s+([A-Z\u00C0-\u024F][a-z\u00C0-\u024F]+(?:\s+[A-Z\u00C0-\u024F][a-z\u00C0-\u024F]+)*)/g;
  while ((match = andAfterWith.exec(message)) !== null) {
    const name = match[1].trim();
    if (!attendees.includes(name) && !FALSE_POSITIVES.has(name.toLowerCase())) {
      attendees.push(name);
    }
  }

  // 4. "invite/include/add [Name]"
  const invitePattern = /\b(?:invite|include|add)\s+([A-Z\u00C0-\u024F][a-z\u00C0-\u024F]+(?:\s+[A-Z\u00C0-\u024F][a-z\u00C0-\u024F]+)*)/g;
  while ((match = invitePattern.exec(message)) !== null) {
    const name = match[1].trim();
    if (!attendees.includes(name) && !FALSE_POSITIVES.has(name.toLowerCase())) {
      attendees.push(name);
    }
  }

  return [...new Set(attendees)];
}

/**
 * Merge LLM-extracted and code-extracted attendees.
 * Deduplicates case-insensitive.
 *
 * @param {string[]} llmAttendees - Attendees from LLM extraction
 * @param {string[]} codeAttendees - Attendees from code extraction
 * @returns {string[]} Merged, deduplicated list
 */
function mergeAttendees(llmAttendees, codeAttendees) {
  const merged = [...(llmAttendees || [])];
  const lowerSet = new Set(merged.map(a => a.toLowerCase()));
  for (const a of (codeAttendees || [])) {
    if (!lowerSet.has(a.toLowerCase())) {
      merged.push(a);
      lowerSet.add(a.toLowerCase());
    }
  }
  return merged;
}

module.exports = { extractAttendees, mergeAttendees };
