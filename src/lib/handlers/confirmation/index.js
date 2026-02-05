/**
 * Confirmation Handlers - Barrel Export
 *
 * Architecture Brief:
 * -------------------
 * Problem: Confirmation handling in MessageRouter is a monolithic switch
 * statement mixing email replies, meeting responses, and general confirmations.
 *
 * Pattern: Strategy pattern with factory function. Each handler type has its
 * own module with focused responsibility. This index exports all handlers
 * and provides a factory for creating configured handler instances.
 *
 * Key Dependencies:
 * - ./email-reply-handler.js
 * - ./meeting-response-handler.js
 * - ./pending-action-handler.js
 *
 * Data Flow:
 * - MessageRouter imports createConfirmationHandlers()
 * - Factory creates all three handlers with shared auditLog
 * - MessageRouter._handleConfirmation() delegates to appropriate handler
 *
 * @module handlers/confirmation
 * @version 1.0.0
 */

'use strict';

const EmailReplyHandler = require('./email-reply-handler');
const MeetingResponseHandler = require('./meeting-response-handler');
const PendingActionHandler = require('./pending-action-handler');

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * @typedef {Object} ConfirmationHandlers
 * @property {EmailReplyHandler} emailReply - Handles email reply confirmations
 * @property {MeetingResponseHandler} meetingResponse - Handles meeting confirmations
 * @property {PendingActionHandler} pendingAction - Handles general pending actions
 */

// -----------------------------------------------------------------------------
// Factory Function
// -----------------------------------------------------------------------------

/**
 * Create all confirmation handlers with shared configuration
 *
 * @param {Object} options
 * @param {Function} [options.auditLog] - Audit logging function (shared)
 * @returns {ConfirmationHandlers}
 */
function createConfirmationHandlers(options = {}) {
  const { auditLog } = options;

  return {
    emailReply: new EmailReplyHandler({ auditLog }),
    meetingResponse: new MeetingResponseHandler({ auditLog }),
    pendingAction: new PendingActionHandler({ auditLog })
  };
}

// -----------------------------------------------------------------------------
// Response Pattern Matchers (shared utilities)
// -----------------------------------------------------------------------------

/**
 * Check if message is an approval response
 *
 * @param {string} message - Lowercase, trimmed message
 * @returns {boolean}
 */
function isApprovalResponse(message) {
  return /^(yes|yep|yeah|sure|ok|okay|confirm|send it|do it|go ahead|proceed|approved?|send|accept)$/.test(message);
}

/**
 * Check if message is a rejection/ignore response
 *
 * @param {string} message - Lowercase, trimmed message
 * @returns {boolean}
 */
function isRejectionResponse(message) {
  return /^(no|nope|nah|cancel|don't|abort|stop|never mind|ignore)$/.test(message);
}

/**
 * Check if message is an edit request
 *
 * @param {string} message - Lowercase, trimmed message
 * @returns {boolean}
 */
function isEditResponse(message) {
  return /^edit$/.test(message);
}

/**
 * Check if message is a meeting decline
 *
 * @param {string} message - Lowercase, trimmed message
 * @returns {boolean}
 */
function isDeclineResponse(message) {
  return /^decline$/.test(message);
}

/**
 * Check if message is a suggest alternatives request
 *
 * @param {string} message - Lowercase, trimmed message
 * @returns {boolean}
 */
function isSuggestResponse(message) {
  return /^(suggest|suggest alternatives?)$/.test(message);
}

/**
 * Check if message is an "accept anyway" (with conflict)
 *
 * @param {string} message - Lowercase, trimmed message
 * @returns {boolean}
 */
function isAcceptAnywayResponse(message) {
  return /^accept anyway$/.test(message);
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = {
  // Classes
  EmailReplyHandler,
  MeetingResponseHandler,
  PendingActionHandler,

  // Factory
  createConfirmationHandlers,

  // Matchers
  isApprovalResponse,
  isRejectionResponse,
  isEditResponse,
  isDeclineResponse,
  isSuggestResponse,
  isAcceptAnywayResponse
};
