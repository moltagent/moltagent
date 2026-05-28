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
 * @param {Object} [options.ollamaProvider] - Ollama provider for LLM classification
 * @returns {ConfirmationHandlers}
 */
function createConfirmationHandlers(options = {}) {
  const { auditLog, ollamaProvider } = options;

  return {
    emailReply: new EmailReplyHandler({ auditLog, ollamaProvider }),
    meetingResponse: new MeetingResponseHandler({ auditLog, ollamaProvider }),
    pendingAction: new PendingActionHandler({ auditLog, ollamaProvider })
  };
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = {
  EmailReplyHandler,
  MeetingResponseHandler,
  PendingActionHandler,
  createConfirmationHandlers
};
