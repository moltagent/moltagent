/*
 * Moltagent - Sovereign AI Agent Platform
 * Copyright (C) 2026 Moltagent Contributors
 * AGPL-3.0
 *
 * Centralized Deck board and stack name configuration.
 * All board and stack names are defined HERE, not scattered across code.
 * For concierge clients, change names in this one file.
 */
'use strict';

const config = require('../lib/config');

module.exports = {
  boards: {
    tasks:    config.deck?.taskBoardTitle    || 'Moltagent Tasks',
    cockpit:  config.deck?.cockpitBoardTitle || config.cockpit?.boardTitle || 'Moltagent Cockpit',
    personal: config.deck?.personalBoardTitle || 'Personal',
  },
  stacks: {
    inbox:   'Inbox',
    queued:  'Queued',
    working: 'Working',
    review:  'Review',
    done:    'Done',
    doing:   'Doing',
  },
};
