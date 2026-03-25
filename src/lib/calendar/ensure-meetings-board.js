/**
 * AGPL-3.0 License - MoltAgent
 *
 * MoltAgent Pending Meetings Board Setup
 *
 * Architecture Brief:
 * -------------------
 * Problem: Meeting lifecycle tracking needs a Deck workflow board.
 * Pattern: Idempotent setup function called on startup. Creates board,
 * stacks, and workflow rules card if missing.
 * Key Dependencies: DeckClient (createNewBoard, createStack, createCardOnBoard, listBoards, getBoard)
 * Data Flow: startup → listBoards → exists? → skip : create board + stacks + rules card
 * Dependency Map: Used by webhook-server.js startup sequence
 *
 * @module calendar/ensure-meetings-board
 * @version 1.0.0
 */

'use strict';

const boardRegistry = require('../integrations/deck-board-registry');
const { ROLES } = require('../integrations/deck-board-registry');

const BOARD_TITLE = 'Pending Meetings';
const BOARD_COLOR = '0087d7';
const STACK_NAMES = ['Planning', 'Invited', 'Needs Attention', 'Confirmed', 'Done'];

const WORKFLOW_CARD_TITLE = '📋 WORKFLOW RULES — DO NOT DELETE';
const WORKFLOW_CARD_DESCRIPTION = `WORKFLOW: procedure
TRIGGER: New card in Planning
RULES:
  Each card is a scheduled meeting.
  Checklist items track participant RSVPs.

  Planning → Invited: When invitations are sent.
  Invited: Check RSVPs on each heartbeat. Update checklist.
  Invited → Confirmed: When all required participants accept.
  Invited → Needs Attention: When any decline, or 48h before meeting with pending RSVPs.
  Needs Attention: Notify organizer in Talk. Wait for instructions.
  Confirmed → Done: After meeting date passes.

  48h before due date with pending RSVPs: comment "[RSVP] {name} hasn't responded."
  On due date: comment "Meeting is today at {time}. Status: {confirmed/pending count}."`

/**
 * Ensure the "Pending Meetings" workflow board exists.
 * Idempotent — safe to call on every startup.
 * @param {Object} deckClient - DeckClient instance
 * @returns {Promise<{boardId: number, existed: boolean}>}
 */
async function ensureMeetingsBoard(deckClient) {
  try {
    // Registry-based resolution (survives renames)
    const registeredId = await boardRegistry.resolveBoard(deckClient, ROLES.meetings, BOARD_TITLE);
    if (registeredId) {
      return { boardId: registeredId, existed: true };
    }

    const board = await deckClient.createNewBoard(BOARD_TITLE, BOARD_COLOR);

    const stacks = [];
    for (let i = 0; i < STACK_NAMES.length; i++) {
      const stack = await deckClient.createStack(board.id, STACK_NAMES[i], i);
      stacks.push(stack);
    }

    await deckClient.createCardOnBoard(board.id, stacks[0].id, WORKFLOW_CARD_TITLE, {
      description: WORKFLOW_CARD_DESCRIPTION
    });

    boardRegistry.registerBoard(ROLES.meetings, board.id);

    return { boardId: board.id, existed: false };
  } catch (err) {
    console.warn('[ensureMeetingsBoard] Failed to ensure Pending Meetings board:', err.message);
    throw err;
  }
}

module.exports = ensureMeetingsBoard;
