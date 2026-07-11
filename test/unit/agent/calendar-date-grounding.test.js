/**
 * SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2026 Moltagent contributors
 *
 * Unit tests for calendar-date-grounding — the per-turn injection of the live
 * date into the calendar tools' `start` schema description (#168, PR-4).
 *
 * Fixed clock throughout: no Date.now(). Every assertion pins a concrete
 * instant so "today"/"tomorrow" are deterministic across runs and zones.
 */

'use strict';

const assert = require('assert');
const { test, summary, exitWithCode } = require('../../helpers/test-runner');
const {
  injectLiveDate,
  groundedStartDescription,
  isoDateInZone,
  GROUNDED_TOOLS,
} = require('../../../src/lib/agent/calendar-date-grounding');

// A minimal stand-in for the registry's calendar_create_event schema shape.
function createTool(name = 'calendar_create_event') {
  return {
    type: 'function',
    function: {
      name,
      description: 'Create a calendar event.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Event title (optional).' },
          start: { type: 'string', description: 'Start datetime as ISO 8601 string' },
          end: { type: 'string', description: 'End datetime as ISO 8601 string' },
        },
        required: ['start'],
      },
    },
  };
}

const FIXED = new Date('2026-07-11T09:00:00Z'); // a Saturday in Europe/Berlin

// ---------------------------------------------------------------------------
// isoDateInZone
// ---------------------------------------------------------------------------

test('isoDateInZone renders YYYY-MM-DD in the given zone', () => {
  assert.strictEqual(isoDateInZone(FIXED, 'UTC'), '2026-07-11');
  assert.strictEqual(isoDateInZone(FIXED, 'Europe/Berlin'), '2026-07-11');
});

test('isoDateInZone respects the zone across the date line', () => {
  // 23:30 UTC is already the next calendar day in Berlin (UTC+2 in July).
  const lateUtc = new Date('2026-07-11T23:30:00Z');
  assert.strictEqual(isoDateInZone(lateUtc, 'UTC'), '2026-07-11');
  assert.strictEqual(isoDateInZone(lateUtc, 'Europe/Berlin'), '2026-07-12');
});

// ---------------------------------------------------------------------------
// groundedStartDescription
// ---------------------------------------------------------------------------

test('groundedStartDescription carries today and tomorrow as positive anchors', () => {
  const out = groundedStartDescription('Start datetime as ISO 8601 string', {
    today: '2026-07-11', tomorrow: '2026-07-12', weekday: 'Saturday',
  });
  assert.ok(out.includes('2026-07-11'), 'names today');
  assert.ok(out.includes('2026-07-12'), 'names tomorrow');
  assert.ok(out.includes('Saturday'), 'names the weekday');
  assert.ok(out.startsWith('Start datetime as ISO 8601 string'), 'keeps the base description');
  // Mason discipline: declarative, no NEVER-stack.
  assert.ok(!/never/i.test(out), 'no NEVER directive');
});

test('groundedStartDescription tolerates an empty base description', () => {
  const out = groundedStartDescription('', { today: '2026-07-11', tomorrow: '2026-07-12', weekday: 'Saturday' });
  assert.ok(out.includes('2026-07-11') && out.includes('2026-07-12'));
});

// ---------------------------------------------------------------------------
// injectLiveDate — the rendered-prompt behavior
// ---------------------------------------------------------------------------

test('injectLiveDate writes the live date into calendar_create_event start at build time', () => {
  const tools = [createTool('calendar_create_event')];
  const [out] = injectLiveDate(tools, FIXED, 'Europe/Berlin');
  const desc = out.function.parameters.properties.start.description;
  assert.ok(desc.includes('2026-07-11'), 'today injected');
  assert.ok(desc.includes('2026-07-12'), 'tomorrow injected');
});

test('injectLiveDate does NOT mutate the shared registration object', () => {
  const tools = [createTool('calendar_create_event')];
  const before = tools[0].function.parameters.properties.start.description;
  injectLiveDate(tools, FIXED, 'Europe/Berlin');
  const after = tools[0].function.parameters.properties.start.description;
  assert.strictEqual(after, before, 'input schema untouched — a later turn cannot inherit a stale date');
  assert.strictEqual(after, 'Start datetime as ISO 8601 string');
});

test('injectLiveDate returns fresh objects for grounded tools (structural clone)', () => {
  const tools = [createTool('calendar_create_event')];
  const [out] = injectLiveDate(tools, FIXED, 'Europe/Berlin');
  assert.notStrictEqual(out, tools[0]);
  assert.notStrictEqual(out.function.parameters.properties.start, tools[0].function.parameters.properties.start);
  // Untouched siblings may stay shared — only start is rewritten.
  assert.strictEqual(out.function.parameters.properties.title, tools[0].function.parameters.properties.title);
});

test('injectLiveDate grounds every calendar tool that has a start', () => {
  for (const name of GROUNDED_TOOLS) {
    const [out] = injectLiveDate([createTool(name)], FIXED, 'UTC');
    const desc = out.function.parameters.properties.start.description;
    assert.ok(desc.includes('2026-07-11'), `${name} grounded`);
  }
});

test('injectLiveDate passes non-calendar tools through by reference', () => {
  const other = { type: 'function', function: { name: 'deck_create_card', description: 'x', parameters: { type: 'object', properties: { start: { type: 'string', description: 'unrelated start' } } } } };
  const [out] = injectLiveDate([other], FIXED, 'UTC');
  assert.strictEqual(out, other, 'not a grounded tool — untouched, even though it has a start property');
});

test('injectLiveDate leaves a grounded tool without a start property untouched', () => {
  const noStart = { type: 'function', function: { name: 'calendar_check_availability', description: 'x', parameters: { type: 'object', properties: {} } } };
  const [out] = injectLiveDate([noStart], FIXED, 'UTC');
  assert.strictEqual(out, noStart);
});

test('injectLiveDate tomorrow rolls month/year boundaries', () => {
  const nye = new Date('2026-12-31T09:00:00Z');
  const [out] = injectLiveDate([createTool('calendar_create_event')], nye, 'UTC');
  const desc = out.function.parameters.properties.start.description;
  assert.ok(desc.includes('2026-12-31'), 'today = NYE');
  assert.ok(desc.includes('2027-01-01'), 'tomorrow rolls into next year');
});

test('injectLiveDate tolerates a non-array input', () => {
  assert.strictEqual(injectLiveDate(null, FIXED, 'UTC'), null);
  assert.strictEqual(injectLiveDate(undefined, FIXED, 'UTC'), undefined);
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
