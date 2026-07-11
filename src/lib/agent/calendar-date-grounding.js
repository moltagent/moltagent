/**
 * SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2026 Moltagent contributors
 *
 * calendar-date-grounding — inject the live date INTO the calendar tool
 * schemas at prompt-build time (#168, Calendar Arc PR-4).
 *
 * ## Why this exists
 *
 * qwen3:8b (the local-only tools seat) anchors "tomorrow" to its training
 * prior — ~October 2023 — on every scheduling turn, in all three languages,
 * ignoring the "Today is …" header at the top of the system prompt. The header
 * is structurally FAR from the `start` argument the model is generating: it
 * sits in the system message while the argument is emitted against the tool
 * schema. A schema `description` sits RIGHT NEXT to the argument. Moving the
 * live date into `calendar_*.start.description` grounds the model where it
 * actually looks. Cloud models (Haiku) already ground correctly and read the
 * same improved description, so this is inert for them, not a regression.
 *
 * ## Why it is code, not a prompt-guard anti-pattern
 *
 * This is plumbing (the LLM-is-the-language-layer rule). Code computes the
 * date STRINGS (Intl formatting + one day of date math) and assembles the
 * schema; the MODEL still computes the target datetime from the user's phrase.
 * There is no natural-language parsing here, no code-side relative-date
 * resolution, no post-hoc substitution of a model-computed date by a
 * handler-computed one. The past-date guard in caldav-client.js
 * (`_assertStartNotInPast`, PR-2) remains the substrate backstop; this PR only
 * reduces how often it has to fire.
 *
 * ## Shared, not copied
 *
 * Production (AgentLoop, at the single per-turn tools-build seam), the
 * gap-closer measurement harness, and the unit test all call `injectLiveDate`.
 * One transform, measured and shipped, never a harness-only re-implementation
 * that could drift from what production sends.
 *
 * @module agent/calendar-date-grounding
 * @license AGPL-3.0
 */

'use strict';

// The calendar tools whose `start` the model must ground against today. Read
// tools (list/get) take no start the model invents, and delete/cancel act on
// existing UIDs — neither needs date grounding, and the past-date guard
// deliberately does not touch them either (PR-2). Kept in lock-step with the
// calendar family registered in tool-registry.js.
const GROUNDED_TOOLS = new Set([
  'calendar_create_event',
  'calendar_update_event',
  'calendar_check_availability',
]);

/**
 * Format a Date as an ISO calendar date (YYYY-MM-DD) in a given IANA zone.
 * 'en-CA' renders exactly YYYY-MM-DD, so no manual assembly of parts.
 * @param {Date} date
 * @param {string} timeZone - IANA zone (e.g. 'Europe/Berlin'); 'UTC' default.
 * @returns {string}
 */
function isoDateInZone(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit', timeZone,
  }).format(date);
}

/**
 * The weekday name in a given zone, English (schema text is English; the model
 * maps to the user's language). Lets the model ground "Friday"/"next Monday".
 * @param {Date} date
 * @param {string} timeZone
 * @returns {string}
 */
function weekdayInZone(date, timeZone) {
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone }).format(date);
}

/**
 * Build the grounded `start` description: the tool's own base text plus a
 * declarative date anchor. Mason discipline — positive anchors (today,
 * tomorrow), one worked example, no NEVER-stack.
 *
 * @param {string} baseDescription - The registered description (e.g. "Start datetime as ISO 8601 string").
 * @param {{today: string, tomorrow: string, weekday: string}} anchor
 * @returns {string}
 */
function groundedStartDescription(baseDescription, { today, tomorrow, weekday }) {
  const base = (baseDescription || 'Start datetime as ISO 8601 string.').trim();
  const dot = /[.!?]$/.test(base) ? '' : '.';
  // A concrete ISO example (using tomorrow's real date) shows both the format
  // AND a real value to place — without it, qwen3:8b sometimes copies the word
  // "tomorrow" literally into the field. "tomorrow's date is X" (not
  // '"tomorrow" is X') de-quotes the relative word so it is not mistaken for a
  // value to emit. Positive, imperative — the model converts, then fills.
  return `${base}${dot} Emit a concrete ISO 8601 timestamp, for example ${tomorrow}T14:00:00. ` +
    `Today is ${today} (${weekday}); tomorrow's date is ${tomorrow}. ` +
    `Convert the user's day — tomorrow, Friday, next week — into that concrete calendar date in the current year before filling this field.`;
}

/**
 * Return a copy of the tool array with the live date injected into every
 * grounded calendar tool's `start.description`. Non-calendar tools and tools
 * without a `start` property pass through by reference (untouched).
 *
 * Cloning is targeted: only the spine down to the mutated `start` property is
 * copied, so the shared registration object in ToolRegistry is NEVER mutated
 * (its `parameters` is stored by reference and reused every turn — mutating it
 * would leak a stale date into all later turns). Sibling properties stay shared
 * by reference; they are not modified.
 *
 * @param {Array<{type:string, function:{name:string, description:string, parameters:Object}}>} tools
 * @param {Date} [now] - The instant "today" is derived from. Injectable for tests/probe.
 * @param {string} [timeZone] - IANA zone matching the system-prompt date header. Default 'UTC'.
 * @returns {Array} A new array; grounded entries are fresh objects, the rest are the originals.
 */
function injectLiveDate(tools, now = new Date(), timeZone = 'UTC') {
  if (!Array.isArray(tools)) return tools;

  const today = isoDateInZone(now, timeZone);
  const tomorrow = isoDateInZone(new Date(now.getTime() + 24 * 60 * 60 * 1000), timeZone);
  const weekday = weekdayInZone(now, timeZone);
  const anchor = { today, tomorrow, weekday };

  return tools.map((tool) => {
    const fn = tool && tool.function;
    if (!fn || !GROUNDED_TOOLS.has(fn.name)) return tool;

    const startProp = fn.parameters && fn.parameters.properties && fn.parameters.properties.start;
    if (!startProp) return tool;

    return {
      ...tool,
      function: {
        ...fn,
        parameters: {
          ...fn.parameters,
          properties: {
            ...fn.parameters.properties,
            start: { ...startProp, description: groundedStartDescription(startProp.description, anchor) },
          },
        },
      },
    };
  });
}

module.exports = {
  injectLiveDate,
  groundedStartDescription,
  isoDateInZone,
  GROUNDED_TOOLS,
};
