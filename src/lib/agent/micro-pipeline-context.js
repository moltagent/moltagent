/**
 * MicroPipeline Context Builder
 *
 * Compact identity + date/timezone context for MicroPipeline handlers.
 * Keeps local model prompts grounded with correct date and agent identity
 * without the full SOUL.md overhead that overwhelms small models.
 *
 * Architecture Brief:
 * - Problem: Local models hallucinate dates and lack identity without context
 * - Pattern: Lightweight context string (~350 chars, <100 tokens)
 * - Key Dependencies: None (pure function)
 * - Data Flow: timezone → formatted date/time string
 *
 * @module agent/micro-pipeline-context
 * @version 1.0.0
 * @license AGPL-3.0
 *
 * Copyright (C) 2026 MoltAgent Contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

'use strict';

/**
 * Build a compact identity + date context string for MicroPipeline prompts.
 * Reuses the Intl.DateTimeFormat pattern from agent-loop.js.
 *
 * @param {string} [timezone='UTC'] - IANA timezone identifier
 * @returns {string} Context string (~350 chars)
 */
function buildMicroContext(timezone) {
  let tz = timezone || 'UTC';
  const now = new Date();
  let dateStr, timeStr;
  try {
    dateStr = new Intl.DateTimeFormat('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      timeZone: tz
    }).format(now);
    timeStr = new Intl.DateTimeFormat('en-US', {
      hour: '2-digit', minute: '2-digit', hour12: false,
      timeZone: tz
    }).format(now);
  } catch {
    // Invalid timezone string — fall back to UTC
    tz = 'UTC';
    dateStr = new Intl.DateTimeFormat('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      timeZone: 'UTC'
    }).format(now);
    timeStr = new Intl.DateTimeFormat('en-US', {
      hour: '2-digit', minute: '2-digit', hour12: false,
      timeZone: 'UTC'
    }).format(now);
  }

  return `You are Moltagent, an AI employee running inside Nextcloud.
Today is ${dateStr}. Current time: ${timeStr} (${tz}). Current year: ${now.getFullYear()}.

Core rules:
- Use ISO 8601 dates relative to today's date shown above
- Confirm actions with real results (IDs, titles), not generated text
- Be concise and action-oriented
- If <agent_knowledge> is in your context, it is YOUR memory. State only what it contains. Never fabricate details it does not mention. Name what is missing.`;
}

module.exports = { buildMicroContext };
