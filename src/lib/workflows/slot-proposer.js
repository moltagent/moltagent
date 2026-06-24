/*
 * Moltagent - Sovereign AI Security Layer
 * Copyright (C) 2026 Moltagent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 */

/**
 * Slot Proposer — Deterministic meeting-slot generator (#186 / #188)
 *
 * Architecture Brief:
 * -------------------
 * Problem: The workflow research beat proposes meeting slots by asking the LLM
 * to compute dates, which causes systematic off-by-one weekday errors (#186).
 * Date arithmetic is plumbing, not intelligence — it belongs in code.
 *
 * Pattern: Pure function that accepts busy blocks (from CalDAV) and scheduling
 * config (from CONFIG markers), and produces formatted slot strings. The LLM
 * receives the finished strings; it never does date math, timezone conversion,
 * or business-hours filtering.
 *
 * Key Design Choices:
 *   - `now` is injected so tests are deterministic (no Date.now() inside).
 *   - Day-of-week and month names come exclusively from Intl.DateTimeFormat —
 *     never hardcoded — so DE/PT/EN all work without code changes (Rule 3).
 *   - Timezone abbreviation (e.g. "WEST") is computed by Intl and may vary
 *     across environments; callers/tests assert presence, not a specific string.
 *   - No LLM call, no I/O — testable in isolation.
 *
 * Dependency Map:
 *   proposeSlots()
 *     ← WorkflowEngine._processCard() (builds grounding block)
 *     ← test/unit/workflows/slot-proposer.test.js
 *
 * @module workflows/slot-proposer
 * @version 1.0.0
 */

'use strict';

/**
 * Days-of-week abbreviations accepted in the HOURS marker.
 * Each value is the JS Date.getDay() equivalent (0=Sun, 1=Mon, ..., 6=Sat).
 * @private
 */
const DAY_NAMES = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tuesday: 2,
  wed: 3, wednesday: 3,
  thu: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6
};

/**
 * Parse a day string ("Mon", "Monday", "mon") to a JS day number (0–6).
 * Returns null if unrecognized.
 * @param {string} str
 * @returns {number|null}
 * @private
 */
function _parseDayName(str) {
  return DAY_NAMES[str.toLowerCase().trim()] ?? null;
}

/**
 * Expand a day range like "Mon-Fri" into the set of JS day numbers.
 * Handles wraparound (e.g. "Sat-Sun") but not multi-segment ranges —
 * those are not used in practice and would require a full parser.
 * @param {string} rangeStr - e.g. "Mon-Fri", "Tue-Thu"
 * @returns {Set<number>} JS getDay() values
 * @private
 */
function _expandDayRange(rangeStr) {
  const parts = rangeStr.split('-').map(s => s.trim());
  if (parts.length === 1) {
    const d = _parseDayName(parts[0]);
    return d !== null ? new Set([d]) : new Set();
  }
  const start = _parseDayName(parts[0]);
  const end   = _parseDayName(parts[1]);
  if (start === null || end === null) return new Set();
  const days = new Set();
  let cur = start;
  // Walk forward (with wraparound) from start to end inclusive
  while (true) {
    days.add(cur);
    if (cur === end) break;
    cur = (cur + 1) % 7;
    // Safety: if we've gone all the way around, stop
    if (cur === start) break;
  }
  return days;
}

/**
 * Parse a time string like "09:00" into minutes-of-day (integer).
 * Returns null if unparseable.
 * @param {string} timeStr - "HH:MM"
 * @returns {number|null}
 * @private
 */
function _parseTime(timeStr) {
  if (!timeStr) return null;
  const m = timeStr.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Parse an HOURS marker value into a structured object.
 *
 * Accepted formats:
 *   "Mon-Fri 09:00-17:00"   → days=Set{1,2,3,4,5}, startMinutes=540, endMinutes=1020
 *   "Tue-Thu 08:30-16:30"
 *
 * Returns null when the value cannot be parsed (caller falls through to default).
 *
 * @param {string} value - Raw value after "HOURS:"
 * @returns {{ days: Set<number>, startMinutes: number, endMinutes: number }|null}
 */
function parseHoursMarker(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();

  // Expected: "<day-range> <start>-<end>"
  // e.g. "Mon-Fri 09:00-17:00"
  const m = trimmed.match(/^([A-Za-z]+(?:-[A-Za-z]+)?)\s+(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
  if (!m) return null;

  const days = _expandDayRange(m[1]);
  if (days.size === 0) return null;

  const startMinutes = _parseTime(m[2]);
  const endMinutes   = _parseTime(m[3]);
  if (startMinutes === null || endMinutes === null) return null;
  if (startMinutes >= endMinutes) return null;

  return { days, startMinutes, endMinutes };
}

/**
 * Determine whether a candidate slot (start–end Date pair) overlaps any busy
 * block.  Overlap: slot.start < block.end AND slot.end > block.start.
 * @param {Date} slotStart
 * @param {Date} slotEnd
 * @param {Array<{start:Date,end:Date}>} busyBlocks
 * @returns {boolean}
 * @private
 */
function _overlaps(slotStart, slotEnd, busyBlocks) {
  for (const block of busyBlocks) {
    const bs = block.start instanceof Date ? block.start : new Date(block.start);
    const be = block.end   instanceof Date ? block.end   : new Date(block.end);
    if (slotStart < be && slotEnd > bs) return true;
  }
  return false;
}

/**
 * Format a slot into a human-readable string using Intl, fully locale-aware.
 * Example output (EN): "Wednesday, 25 June 2026, 09:00–09:30 (CEST)"
 * Example output (DE): "Mittwoch, 25. Juni 2026, 09:00–09:30 (MESZ)"
 * Example output (PT): "quarta-feira, 25 de junho de 2026, 09:00–09:30 (WEST)"
 *
 * @param {Date} start - Slot start (UTC Date)
 * @param {Date} end   - Slot end   (UTC Date)
 * @param {string} locale   - BCP-47 locale string, e.g. "en", "de", "pt"
 * @param {string} timezone - IANA timezone, e.g. "Europe/Lisbon"
 * @returns {string}
 * @private
 */
function _formatSlot(start, end, locale, timezone) {
  // Date portion: weekday, day, month, year
  const dateFmt = new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: timezone
  });

  // Time start with short timezone name
  const startFmt = new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timezone,
    timeZoneName: 'short'
  });

  // Time end (no timezone — we grab it from the start formatter)
  const endFmt = new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timezone
  });

  const datePart  = dateFmt.format(start);

  // Extract time and timezone abbreviation from the start formatter parts.
  const startParts   = startFmt.formatToParts(start);
  const timeStartStr = endFmt.format(start);
  const timeEndStr   = endFmt.format(end);
  const tzPart = startParts.find(p => p.type === 'timeZoneName');
  const tzStr  = tzPart ? tzPart.value : '';

  const timePart = tzStr
    ? `${timeStartStr}–${timeEndStr} (${tzStr})`
    : `${timeStartStr}–${timeEndStr}`;

  return `${datePart}, ${timePart}`;
}

/**
 * Propose up to `maxSlots` meeting slots within the next `windowDays` business
 * days, avoiding any overlap with the provided `busyBlocks`.
 *
 * This is a PURE function: no I/O, no LLM, no CalDAV calls.  Date arithmetic
 * and weekday labeling are computed in code so the LLM never has to do it.
 *
 * @param {Object} opts
 * @param {Array<{start:Date|string, end:Date|string}>} opts.busyBlocks
 *   Known busy intervals (UTC Dates or ISO strings).
 * @param {{ days: Set<number>, startMinutes: number, endMinutes: number }} opts.hours
 *   Business-hours config from `_resolveSchedulingConfig`.
 * @param {string} opts.timezone
 *   IANA timezone, e.g. "Europe/Lisbon".
 * @param {number} opts.slotDuration
 *   Duration in minutes for each proposed slot.
 * @param {string} [opts.locale='en']
 *   BCP-47 locale for date/time formatting (DE/EN/PT all work).
 * @param {Date} opts.now
 *   The current instant. Injected so tests are deterministic.
 * @param {number} [opts.maxSlots=3]
 *   Maximum number of slot strings to return.
 * @param {number} [opts.windowDays=5]
 *   How many business days forward to search.
 * @returns {string[]}
 *   Array of formatted slot strings. Empty when no free slots found.
 */
function proposeSlots({
  busyBlocks = [],
  hours,
  timezone,
  slotDuration,
  locale = 'en',
  now,
  maxSlots = 3,
  windowDays = 5
}) {
  if (!hours || !timezone || !slotDuration || !now) return [];
  if (hours.days.size === 0) return [];
  if (slotDuration <= 0 || !Number.isFinite(slotDuration)) return [];

  const results = [];

  // Normalise busy blocks to Date pairs
  const normalised = busyBlocks
    .map(b => ({
      start: b.start instanceof Date ? b.start : new Date(b.start),
      end:   b.end   instanceof Date ? b.end   : new Date(b.end)
    }))
    .filter(b => !isNaN(b.start) && !isNaN(b.end));

  // Start from the calendar day AFTER `now` in the target timezone.
  // We use Intl to find the local date so DST offsets are respected.
  //
  // Strategy: find the midnight boundary of (now + 1 day) in the timezone,
  // represented as a UTC Date.  We do this by walking forward day by day
  // using UTC midnight + offset compensation, but because JS doesn't expose
  // a clean "UTC-of-local-midnight" helper, we iterate using getFullYear/
  // Month/Date in local time then pinning via explicit UTC construction.
  //
  // We keep things simple: increment day-of-month in the target timezone by
  // constructing each candidate in the UTC reference and using Intl to check
  // the wall-clock day.

  // Build the UTC Date that corresponds to local midnight of the day after `now`.
  const startDay = new Date(now);
  startDay.setUTCDate(startDay.getUTCDate() + 1);
  startDay.setUTCHours(0, 0, 0, 0);

  // We will step day-by-day.  Use a counter capped at windowDays * 3 to avoid
  // infinite loops on holiday configs, etc.
  let businessDaysVisited = 0;
  let currentDay = new Date(startDay);
  const maxDaysToScan = windowDays * 3 + 7; // generous upper bound

  for (let scan = 0; scan < maxDaysToScan && businessDaysVisited < windowDays && results.length < maxSlots; scan++) {
    // Determine the local weekday in the target timezone.
    // Intl.DateTimeFormat with weekday:'short' gives us the display name, but
    // we need the numeric weekday.  Use 'en-US' to get an ASCII-safe name,
    // then look it up in DAY_NAMES (which has 3-letter and full names).
    const localWeekdayNum = _getLocalWeekday(currentDay, timezone);

    if (!hours.days.has(localWeekdayNum)) {
      // Not a business day — advance one day and continue
      currentDay = _advanceDay(currentDay);
      continue;
    }

    // It is a business day — iterate over SLOT_DURATION-aligned slots
    businessDaysVisited++;

    let slotStart = _setLocalTime(currentDay, hours.startMinutes, timezone);
    const dayEnd  = _setLocalTime(currentDay, hours.endMinutes,   timezone);

    while (slotStart < dayEnd && results.length < maxSlots) {
      const slotEnd = new Date(slotStart.getTime() + slotDuration * 60 * 1000);

      if (slotEnd > dayEnd) break; // slot would overrun business hours

      if (!_overlaps(slotStart, slotEnd, normalised)) {
        results.push(_formatSlot(slotStart, slotEnd, locale, timezone));
      }

      slotStart = slotEnd;
    }

    currentDay = _advanceDay(currentDay);
  }

  return results;
}

/**
 * Return the numeric weekday (0=Sun … 6=Sat) of a UTC Date as seen in the
 * given IANA timezone.  Uses Intl with 'en-US' to get a stable English name
 * then maps it back via DAY_NAMES.
 * @param {Date} date
 * @param {string} timezone
 * @returns {number} 0–6
 * @private
 */
function _getLocalWeekday(date, timezone) {
  const fmt = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: timezone });
  const name = fmt.format(date).toLowerCase(); // "monday", "tuesday", etc.
  return DAY_NAMES[name] ?? date.getUTCDay();
}

/**
 * Return a UTC Date pointing to the local wall-clock time `minutesOfDay` on
 * the same calendar day as `utcDate` in `timezone`.
 *
 * We approximate by:
 * 1. Formatting utcDate in the target timezone to learn the local Y/M/D.
 * 2. Constructing a date string at the desired local time.
 * 3. Interpreting it as UTC (because we don't have a reliable "local→UTC"
 *    path in Node without a library), then compensating with the offset.
 *
 * A simpler approach: compute local midnight via Intl, then add minutesOfDay.
 *
 * @param {Date} utcDate - Any Date on the target calendar day (UTC)
 * @param {number} minutesOfDay - Minutes since midnight (e.g. 540 = 09:00)
 * @param {string} timezone - IANA timezone
 * @returns {Date} UTC Date corresponding to the local time
 * @private
 */
function _setLocalTime(utcDate, minutesOfDay, timezone) {
  // Get the local date parts for utcDate in the timezone
  const fmt = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    timeZone: timezone
  });
  const localDateStr = fmt.format(utcDate); // "YYYY-MM-DD"

  // Build an ISO timestamp for the local time, then figure out the UTC offset.
  // We use the trick: parse as UTC, then adjust by the real offset.
  const hour   = Math.floor(minutesOfDay / 60);
  const minute = minutesOfDay % 60;
  const paddedHour   = String(hour).padStart(2, '0');
  const paddedMinute = String(minute).padStart(2, '0');

  // Construct a local datetime string (no TZ specifier — parse it as UTC first)
  const localIso = `${localDateStr}T${paddedHour}:${paddedMinute}:00Z`;
  const utcGuess = new Date(localIso);

  // Find the actual UTC offset by formatting that UTC guess in the timezone
  // and comparing to the assumed local time.  We use 'en-US' for stability.
  const checkFmt = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit', minute: '2-digit', hour12: false,
    timeZone: timezone
  });
  const rendered = checkFmt.format(utcGuess); // e.g. "09:00" or "08:00"
  const [rHour, rMin] = rendered.split(':').map(Number);
  const renderedMinutes = rHour * 60 + rMin;
  // rendered shows the local time that corresponds to utcGuess.
  // We want local time = minutesOfDay, but rendered shows renderedMinutes.
  // Correction: subtract (renderedMinutes - minutesOfDay) from the UTC guess.
  // Example: timezone is UTC+1 (WEST). utcGuess=09:00 UTC, rendered=10:00 local.
  //   We want 09:00 local → 08:00 UTC.
  //   delta = renderedMinutes - minutesOfDay = 600 - 540 = 60 min.
  //   result = 09:00 UTC - 60 min = 08:00 UTC. Correct.
  const deltaMinutes = renderedMinutes - minutesOfDay;
  return new Date(utcGuess.getTime() - deltaMinutes * 60 * 1000);
}

/**
 * Advance a UTC Date by exactly one calendar day.
 * @param {Date} d
 * @returns {Date}
 * @private
 */
function _advanceDay(d) {
  return new Date(d.getTime() + 24 * 60 * 60 * 1000);
}

module.exports = { proposeSlots, parseHoursMarker };
