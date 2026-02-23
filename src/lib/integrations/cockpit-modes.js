/**
 * Cockpit Modes — Constants and normalizer
 *
 * The Cockpit "Mode" card lets the user switch between five operational modes
 * that control how aggressively HeartbeatManager and MessageProcessor behave.
 *
 * @module integrations/cockpit-modes
 */

'use strict';

const MODES = {
  FULL_AUTO:        'full-auto',
  FOCUS_MODE:       'focus-mode',
  MEETING_DAY:      'meeting-day',
  CREATIVE_SESSION: 'creative-session',
  OUT_OF_OFFICE:    'out-of-office',
};

// Maps Deck card titles -> slugs
const TITLE_MAP = {
  'Full Auto':        MODES.FULL_AUTO,
  'Focus Mode':       MODES.FOCUS_MODE,
  'Meeting Day':      MODES.MEETING_DAY,
  'Creative Session': MODES.CREATIVE_SESSION,
  'Out of Office':    MODES.OUT_OF_OFFICE,
};

/**
 * Normalize a Cockpit mode card title to a slug.
 * Returns FULL_AUTO for unknown or missing input.
 *
 * @param {string|null|undefined} cardTitle - The mode card's title from CockpitManager
 * @returns {string} One of the MODES values
 */
function normalizeModeName(cardTitle) {
  if (!cardTitle) return MODES.FULL_AUTO;
  return TITLE_MAP[cardTitle] || MODES.FULL_AUTO;
}

module.exports = { MODES, TITLE_MAP, normalizeModeName };
