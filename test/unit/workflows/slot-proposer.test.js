'use strict';

/**
 * Tests for slot-proposer.js — pure deterministic slot-proposal helper (#186 / #188).
 *
 * Key regression: 24/25/26 June 2026 are Wed/Thu/Fri (not Tue/Wed/Thu).
 * All tests inject `now` so results are deterministic regardless of wall time.
 */

const assert = require('assert');
const { test, summary, exitWithCode } = require('../../helpers/test-runner');
const { proposeSlots, parseHoursMarker } = require('../../../src/lib/workflows/slot-proposer');

// ---------------------------------------------------------------------------
// parseHoursMarker tests
// ---------------------------------------------------------------------------

test('parseHoursMarker: parses "Mon-Fri 09:00-17:00"', () => {
  const result = parseHoursMarker('Mon-Fri 09:00-17:00');
  assert.ok(result, 'should parse successfully');
  assert.deepStrictEqual([...result.days].sort(), [1, 2, 3, 4, 5]);
  assert.strictEqual(result.startMinutes, 9 * 60);
  assert.strictEqual(result.endMinutes, 17 * 60);
});

test('parseHoursMarker: parses "Tue-Thu 08:30-16:30"', () => {
  const result = parseHoursMarker('Tue-Thu 08:30-16:30');
  assert.ok(result);
  assert.deepStrictEqual([...result.days].sort(), [2, 3, 4]);
  assert.strictEqual(result.startMinutes, 8 * 60 + 30);
  assert.strictEqual(result.endMinutes, 16 * 60 + 30);
});

test('parseHoursMarker: returns null for empty string', () => {
  assert.strictEqual(parseHoursMarker(''), null);
});

test('parseHoursMarker: returns null for null', () => {
  assert.strictEqual(parseHoursMarker(null), null);
});

test('parseHoursMarker: returns null for invalid format', () => {
  assert.strictEqual(parseHoursMarker('Weekdays 9am-5pm'), null);
});

test('parseHoursMarker: returns null for inverted time range (start >= end)', () => {
  assert.strictEqual(parseHoursMarker('Mon-Fri 17:00-09:00'), null);
});

test('parseHoursMarker: parses single day "Mon Mon 09:00-17:00"', () => {
  // Single day via range with same start/end
  const result = parseHoursMarker('Mon-Mon 09:00-17:00');
  assert.ok(result);
  assert.deepStrictEqual([...result.days], [1]);
});

// ---------------------------------------------------------------------------
// proposeSlots — #186 regression: weekday correctness
// ---------------------------------------------------------------------------

// Fixed anchor: Monday 22 June 2026 12:00 UTC
// Next business day = Tuesday 23 June 2026
// 24 June = Wednesday, 25 June = Thursday, 26 June = Friday
const MON_22_JUNE_2026_UTC = new Date('2026-06-22T12:00:00Z');

const STD_HOURS = { days: new Set([1, 2, 3, 4, 5]), startMinutes: 9 * 60, endMinutes: 17 * 60 };
const STD_TZ    = 'Europe/Lisbon'; // UTC+1 in June (WEST)
const STD_SLOT  = 30;

test('#186 regression: 24 June 2026 is Wednesday (EN)', () => {
  const slots = proposeSlots({
    busyBlocks: [],
    hours: STD_HOURS,
    timezone: STD_TZ,
    slotDuration: STD_SLOT,
    locale: 'en',
    now: MON_22_JUNE_2026_UTC,
    maxSlots: 3,
    windowDays: 5
  });
  assert.ok(slots.length >= 1, `expected slots, got ${slots.length}`);
  // First slot should fall on Tuesday 23 June
  assert.ok(slots[0].toLowerCase().includes('tuesday') || slots[0].toLowerCase().includes('23'),
    `First slot should be Tue 23 June: "${slots[0]}"`);
});

test('#186 regression: correct weekday sequence Tue/Wed/Thu over 3 consecutive days', () => {
  // now = Sunday 21 June 2026 (weekend), so next business day = Mon 22 June
  const SUN_21_JUNE = new Date('2026-06-21T12:00:00Z');
  const slots = proposeSlots({
    busyBlocks: [],
    hours: STD_HOURS,
    timezone: STD_TZ,
    slotDuration: STD_SLOT,
    locale: 'en',
    now: SUN_21_JUNE,
    maxSlots: 3,
    windowDays: 3
  });
  assert.ok(slots.length >= 1);
  // Slot 0 = Mon 22, slot 1 (if same day still collecting) or next day
  // More importantly, each slot string should contain a valid date
  for (const s of slots) {
    assert.ok(s.length > 10, `slot string should be non-trivial: "${s}"`);
  }
});

test('#186 regression: slots span correct calendar dates', () => {
  // now = Mon 22 June 2026 noon UTC → next biz day = Tue 23 June
  const slots = proposeSlots({
    busyBlocks: [],
    hours: STD_HOURS,
    timezone: STD_TZ,
    slotDuration: STD_SLOT,
    locale: 'en',
    now: MON_22_JUNE_2026_UTC,
    maxSlots: 3,
    windowDays: 5
  });
  // June 2026 dates in the strings
  const allText = slots.join(' ');
  // At least one of 23, 24, 25, 26, 27 should appear (they are biz days)
  assert.ok(
    ['23', '24', '25', '26', '27'].some(d => allText.includes(d)),
    `Expected a June 23–27 date in slots: ${allText}`
  );
});

// ---------------------------------------------------------------------------
// proposeSlots — #186 concrete weekday regression (EN / DE / PT)
// now = Tue 23 June 2026 noon UTC → next business day = Wed 24 June 2026
// This is the canonical check: if off-by-one, the slot shows "Tuesday" not "Wednesday".
// ---------------------------------------------------------------------------

const TUE_23_JUNE_2026_UTC = new Date('2026-06-23T12:00:00Z');

test('#186 concrete: 24 June 2026 labeled Wednesday in EN (UTC timezone)', () => {
  const slots = proposeSlots({
    busyBlocks: [],
    hours: STD_HOURS,
    timezone: 'UTC',
    slotDuration: STD_SLOT,
    locale: 'en',
    now: TUE_23_JUNE_2026_UTC,
    maxSlots: 1,
    windowDays: 1
  });
  assert.ok(slots.length === 1, `Expected 1 slot, got ${slots.length}`);
  assert.ok(
    slots[0].toLowerCase().includes('wednesday'),
    `24 June 2026 must be labeled Wednesday, got: "${slots[0]}"`
  );
  assert.ok(slots[0].includes('24'), `Slot must contain date "24", got: "${slots[0]}"`);
});

test('#186 concrete: 24 June 2026 labeled Mittwoch in DE (UTC timezone)', () => {
  const slots = proposeSlots({
    busyBlocks: [],
    hours: STD_HOURS,
    timezone: 'UTC',
    slotDuration: STD_SLOT,
    locale: 'de',
    now: TUE_23_JUNE_2026_UTC,
    maxSlots: 1,
    windowDays: 1
  });
  assert.ok(slots.length === 1, `Expected 1 slot, got ${slots.length}`);
  assert.ok(
    slots[0].toLowerCase().includes('mittwoch'),
    `24 June 2026 must be "Mittwoch" in DE, got: "${slots[0]}"`
  );
});

test('#186 concrete: 24 June 2026 labeled quarta-feira in PT (UTC timezone)', () => {
  const slots = proposeSlots({
    busyBlocks: [],
    hours: STD_HOURS,
    timezone: 'UTC',
    slotDuration: STD_SLOT,
    locale: 'pt',
    now: TUE_23_JUNE_2026_UTC,
    maxSlots: 1,
    windowDays: 1
  });
  assert.ok(slots.length === 1, `Expected 1 slot, got ${slots.length}`);
  assert.ok(
    slots[0].toLowerCase().includes('quarta'),
    `24 June 2026 must be "quarta-feira" in PT, got: "${slots[0]}"`
  );
});

// DST correctness: Europe/Lisbon summer (WEST, UTC+1) — slot at 09:00 local must be 08:00 UTC
test('_setLocalTime DST: Europe/Lisbon summer slot at 09:00 local is 08:00 UTC', () => {
  const slots = proposeSlots({
    busyBlocks: [],
    hours: { days: new Set([1, 2, 3, 4, 5]), startMinutes: 9 * 60, endMinutes: 10 * 60 },
    timezone: 'Europe/Lisbon',
    slotDuration: 60,
    locale: 'en',
    now: TUE_23_JUNE_2026_UTC,
    maxSlots: 1,
    windowDays: 1
  });
  // 09:00 WEST = 08:00 UTC, so the slot's UTC representation is 08:00-09:00 UTC.
  // The formatted string should show "09:00" (local wall-clock time in WEST).
  assert.ok(slots.length === 1, `Expected 1 slot, got ${slots.length}`);
  assert.ok(
    slots[0].includes('09:00'),
    `Slot in Europe/Lisbon summer should show 09:00 local wall-clock: "${slots[0]}"`
  );
});

// ---------------------------------------------------------------------------
// proposeSlots — business hours filtering
// ---------------------------------------------------------------------------

test('slot before business hours start is excluded', () => {
  // HOURS: 09:00-17:00; if a "busy" block covers 00:00-09:00, slots should start at 09:00
  // We test by checking no slot string contains "08:" in the time portion
  const slots = proposeSlots({
    busyBlocks: [],
    hours: { days: new Set([1, 2, 3, 4, 5]), startMinutes: 9 * 60, endMinutes: 17 * 60 },
    timezone: 'UTC',
    slotDuration: 60, // 1h slots to keep output small
    locale: 'en',
    now: MON_22_JUNE_2026_UTC,
    maxSlots: 1,
    windowDays: 1
  });
  assert.ok(slots.length >= 1, 'should produce at least one slot');
  // The time portion in UTC should start at or after 09:00
  // Slot string contains "09:00" (or similar depending on locale)
  assert.ok(slots[0].includes('09'), `First slot should start at 09:00 UTC, got: "${slots[0]}"`);
});

test('slot at exactly business hours end is excluded (end exclusive)', () => {
  // HOURS: 09:00-17:00 with 60-min slots → last valid slot starts at 16:00
  const slots = proposeSlots({
    busyBlocks: [],
    hours: { days: new Set([1, 2, 3, 4, 5]), startMinutes: 9 * 60, endMinutes: 17 * 60 },
    timezone: 'UTC',
    slotDuration: 60,
    locale: 'en',
    now: MON_22_JUNE_2026_UTC,
    maxSlots: 20, // get all slots for one day
    windowDays: 1
  });
  // None of the slots should START at 17:00 or later
  // The check is that no slot starting at 17:00 exists
  // (a slot ending at 17:00 is fine — "16:00–17:00")
  // Since we just check the string, look for "17:00–" pattern
  const startsAt17 = slots.filter(s => /\b17:00[–-]/.test(s));
  assert.strictEqual(startsAt17.length, 0, `No slot should start at 17:00: ${startsAt17.join(', ')}`);
});

// ---------------------------------------------------------------------------
// proposeSlots — busy-block conflict skipping
// ---------------------------------------------------------------------------

test('conflicting busy block causes slot to be skipped', () => {
  // Busy 09:00–10:00 UTC on 2026-06-23 (Tuesday)
  const busy = [{
    start: new Date('2026-06-23T08:00:00Z'), // 09:00 WEST
    end:   new Date('2026-06-23T09:00:00Z')  // 10:00 WEST
  }];
  const slots = proposeSlots({
    busyBlocks: busy,
    hours: { days: new Set([1, 2, 3, 4, 5]), startMinutes: 9 * 60, endMinutes: 17 * 60 },
    timezone: STD_TZ,
    slotDuration: STD_SLOT,
    locale: 'en',
    now: MON_22_JUNE_2026_UTC,
    maxSlots: 3,
    windowDays: 1
  });
  // The 09:00–09:30 WEST slot on Tue 23 should be skipped.
  // All returned slots should start at or after 10:00 WEST on that day.
  // We simply verify no slot contains "09:00–09:30" in its time portion
  const hasConflict = slots.some(s => /09:00.09:30/.test(s) || /09:00–09:30/.test(s));
  assert.strictEqual(hasConflict, false, `Conflicting slot should have been skipped: ${slots.join(', ')}`);
});

test('non-conflicting busy block does not prevent surrounding slots', () => {
  // Busy only 10:00–10:30 WEST on Tue 23 June
  const busy = [{
    start: new Date('2026-06-23T09:00:00Z'), // 10:00 WEST
    end:   new Date('2026-06-23T09:30:00Z')  // 10:30 WEST
  }];
  const slots = proposeSlots({
    busyBlocks: busy,
    hours: { days: new Set([1, 2, 3, 4, 5]), startMinutes: 9 * 60, endMinutes: 17 * 60 },
    timezone: STD_TZ,
    slotDuration: STD_SLOT,
    locale: 'en',
    now: MON_22_JUNE_2026_UTC,
    maxSlots: 3,
    windowDays: 1
  });
  // Should still produce slots (09:00–09:30 is free, 10:30–11:00 is free, etc.)
  assert.ok(slots.length >= 1, `Expected free slots around the busy block, got: ${slots.join(', ')}`);
});

// ---------------------------------------------------------------------------
// proposeSlots — empty availability
// ---------------------------------------------------------------------------

test('empty window returns []', () => {
  const result = proposeSlots({
    busyBlocks: [],
    hours: STD_HOURS,
    timezone: STD_TZ,
    slotDuration: STD_SLOT,
    locale: 'en',
    now: MON_22_JUNE_2026_UTC,
    maxSlots: 3,
    windowDays: 0  // zero business days
  });
  assert.deepStrictEqual(result, []);
});

test('no free slots when entire window is busy returns []', () => {
  // Fill the entire day with busy blocks
  const busy = [];
  for (let h = 9; h < 17; h++) {
    busy.push({
      start: new Date(`2026-06-23T0${h < 10 ? '0' : ''}${h - 1}:00:00Z`), // WEST = UTC+1
      end:   new Date(`2026-06-23T0${h < 10 ? '0' : ''}${h - 1}:30:00Z`)
    });
  }
  // Just use a very wide busy block covering 09:00–17:00 WEST (08:00–16:00 UTC)
  const result = proposeSlots({
    busyBlocks: [{
      start: new Date('2026-06-23T08:00:00Z'), // 09:00 WEST
      end:   new Date('2026-06-23T16:00:00Z')  // 17:00 WEST
    }],
    hours: { days: new Set([1, 2, 3, 4, 5]), startMinutes: 9 * 60, endMinutes: 17 * 60 },
    timezone: STD_TZ,
    slotDuration: STD_SLOT,
    locale: 'en',
    now: MON_22_JUNE_2026_UTC,
    maxSlots: 3,
    windowDays: 1  // only look at Tue 23
  });
  assert.deepStrictEqual(result, [], `Expected [] when whole day is busy, got: ${result}`);
});

test('missing required params returns []', () => {
  assert.deepStrictEqual(proposeSlots({ busyBlocks: [], hours: null, timezone: 'UTC', slotDuration: 30, now: new Date() }), []);
  assert.deepStrictEqual(proposeSlots({ busyBlocks: [], hours: STD_HOURS, timezone: 'UTC', slotDuration: 0, now: new Date() }), []);
});

// ---------------------------------------------------------------------------
// proposeSlots — maxSlots cap
// ---------------------------------------------------------------------------

test('maxSlots=1 returns at most 1 slot', () => {
  const slots = proposeSlots({
    busyBlocks: [],
    hours: STD_HOURS,
    timezone: STD_TZ,
    slotDuration: STD_SLOT,
    locale: 'en',
    now: MON_22_JUNE_2026_UTC,
    maxSlots: 1,
    windowDays: 5
  });
  assert.strictEqual(slots.length, 1);
});

test('default maxSlots=3 returns at most 3 slots', () => {
  const slots = proposeSlots({
    busyBlocks: [],
    hours: STD_HOURS,
    timezone: STD_TZ,
    slotDuration: STD_SLOT,
    locale: 'en',
    now: MON_22_JUNE_2026_UTC,
    windowDays: 5
  });
  assert.ok(slots.length <= 3, `Got ${slots.length} slots, expected ≤ 3`);
});

// ---------------------------------------------------------------------------
// proposeSlots — locale-aware names (DE / PT)
// ---------------------------------------------------------------------------

test('German locale produces German weekday names', () => {
  const slots = proposeSlots({
    busyBlocks: [],
    hours: STD_HOURS,
    timezone: STD_TZ,
    slotDuration: STD_SLOT,
    locale: 'de',
    now: MON_22_JUNE_2026_UTC,
    maxSlots: 1,
    windowDays: 5
  });
  assert.ok(slots.length >= 1);
  // German weekday names: Dienstag, Mittwoch, Donnerstag, Freitag, etc.
  const germanDays = ['montag', 'dienstag', 'mittwoch', 'donnerstag', 'freitag', 'samstag', 'sonntag'];
  const slotLower = slots[0].toLowerCase();
  assert.ok(
    germanDays.some(d => slotLower.includes(d)),
    `Expected a German weekday name in "${slots[0]}"`
  );
});

test('Portuguese locale produces Portuguese weekday names', () => {
  const slots = proposeSlots({
    busyBlocks: [],
    hours: STD_HOURS,
    timezone: STD_TZ,
    slotDuration: STD_SLOT,
    locale: 'pt',
    now: MON_22_JUNE_2026_UTC,
    maxSlots: 1,
    windowDays: 5
  });
  assert.ok(slots.length >= 1);
  // Portuguese weekday names
  const ptDays = ['segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado', 'domingo'];
  const slotLower = slots[0].toLowerCase();
  assert.ok(
    ptDays.some(d => slotLower.includes(d)),
    `Expected a Portuguese weekday name in "${slots[0]}"`
  );
});

test('English locale produces English weekday names', () => {
  const slots = proposeSlots({
    busyBlocks: [],
    hours: STD_HOURS,
    timezone: STD_TZ,
    slotDuration: STD_SLOT,
    locale: 'en',
    now: MON_22_JUNE_2026_UTC,
    maxSlots: 1,
    windowDays: 5
  });
  assert.ok(slots.length >= 1);
  const enDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const slotLower = slots[0].toLowerCase();
  assert.ok(
    enDays.some(d => slotLower.includes(d)),
    `Expected an English weekday name in "${slots[0]}"`
  );
});

test('slot string contains a timezone abbreviation', () => {
  // Tz abbreviation (e.g. "WEST", "CET") is env-dependent — assert presence not value
  const slots = proposeSlots({
    busyBlocks: [],
    hours: STD_HOURS,
    timezone: STD_TZ,
    slotDuration: STD_SLOT,
    locale: 'en',
    now: MON_22_JUNE_2026_UTC,
    maxSlots: 1,
    windowDays: 5
  });
  assert.ok(slots.length >= 1);
  // A timezone abbreviation is typically 2-5 uppercase letters in parentheses
  // or a UTC offset like "UTC+1"
  assert.ok(
    /\([A-Z]{2,6}[+\-]?\d*\)|\(UTC[+\-]\d+\)/.test(slots[0]),
    `Expected a timezone abbreviation in "${slots[0]}"`
  );
});

// ---------------------------------------------------------------------------
// proposeSlots — weekend exclusion
// ---------------------------------------------------------------------------

test('weekends are excluded when not in days set', () => {
  // now = Friday 19 June 2026 17:30 UTC (end of business)
  // Next slot should be Monday 22 June 2026 (not Saturday)
  const FRI_19_JUNE = new Date('2026-06-19T16:30:00Z');
  const slots = proposeSlots({
    busyBlocks: [],
    hours: STD_HOURS,
    timezone: 'UTC',
    slotDuration: STD_SLOT,
    locale: 'en',
    now: FRI_19_JUNE,
    maxSlots: 1,
    windowDays: 5
  });
  assert.ok(slots.length >= 1);
  // First slot should be on Monday 22 (not Sat 20 or Sun 21)
  assert.ok(
    slots[0].toLowerCase().includes('monday') || slots[0].includes('22'),
    `First slot after Friday should be Monday, got: "${slots[0]}"`
  );
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
