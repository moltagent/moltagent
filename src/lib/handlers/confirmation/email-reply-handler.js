/**
 * Email Reply Confirmation Handler
 *
 * Architecture Brief:
 * -------------------
 * Problem: The MessageRouter._handleConfirmation() method handles multiple
 * distinct confirmation types (email replies, meetings, general actions),
 * making it difficult to test and maintain.
 *
 * Pattern: Strategy pattern - this handler processes email reply confirmations
 * from the pendingEmailReplies store. Handles approve, ignore, and edit actions.
 *
 * Key Dependencies:
 * - src/lib/pending-action-store.js (pendingEmailReplies singleton)
 * - src/lib/handlers/email-handler.js (for sending replies)
 * - src/lib/errors/error-handler.js (for safe error messages)
 *
 * Data Flow:
 * - MessageRouter detects pending email reply + confirmation response
 * - Delegates to this handler with (message, context, handlers)
 * - Handler executes action and returns { response, intent, error? }
 *
 * Integration Points:
 * - Called by MessageRouter._handleConfirmation()
 * - Uses pendingEmailReplies.getRecent(), clearType()
 * - Calls emailHandler.confirmSendEmail()
 *
 * @module handlers/confirmation/email-reply-handler
 * @version 1.0.0
 */

'use strict';

const { pendingEmailReplies } = require('../../pending-action-store');
const { createErrorHandler } = require('../../errors/error-handler');

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * @typedef {Object} EmailReplyContext
 * @property {string} user - The user responding to the confirmation
 * @property {string} [token] - NC Talk room token
 * @property {string} [messageId] - Original message ID
 */

/**
 * @typedef {Object} EmailReplyHandlers
 * @property {Object} emailHandler - Email handler instance with confirmSendEmail()
 * @property {Function} auditLog - Audit logging function
 */

/**
 * @typedef {Object} ConfirmationResult
 * @property {string} response - User-facing response message
 * @property {string} intent - Always 'confirm' for confirmation handlers
 * @property {boolean} [error] - True if an error occurred
 */

// -----------------------------------------------------------------------------
// Email Reply Handler Class
// -----------------------------------------------------------------------------

/**
 * Handles confirmation responses for pending email replies.
 *
 * Supports three actions:
 * - approve: Send the drafted reply
 * - ignore: Clear pending replies without sending
 * - edit: Prompt user for edited response (does not clear pending)
 */
class EmailReplyHandler {
  /**
   * @param {Object} options
   * @param {Function} [options.auditLog] - Audit logging function
   */
  constructor(options = {}) {
    /** @type {Function} */
    this.auditLog = options.auditLog || (async () => {});

    /** @type {import('../../errors/error-handler').ErrorHandler} */
    this.errorHandler = createErrorHandler({
      serviceName: 'EmailReplyHandler',
      auditLog: this.auditLog
    });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Check if this handler can process the given pending reply
   *
   * @param {Object} pendingReply - The pending reply data from store
   * @returns {boolean} True if this handler should process it
   */
  canHandle(pendingReply) {
    if (!pendingReply || !pendingReply.data) {
      return false;
    }
    // This handler processes non-meeting email replies
    return !pendingReply.data.is_meeting_request;
  }

  /**
   * Handle an approval action (send the drafted reply)
   *
   * @param {Object} pendingReply - The pending reply { id, data }
   * @param {EmailReplyContext} context - Request context
   * @param {EmailReplyHandlers} handlers - Available handlers
   * @returns {Promise<ConfirmationResult>}
   */
  async handleApprove(pendingReply, context, handlers) {
    const pending = pendingReply.data;

    // Clear ALL pending replies since user responded to one
    pendingEmailReplies.clearType('email_reply');

    try {
      // Build the draft email
      const draft = this._buildDraft(pending);

      // Send the email reply
      const result = await handlers.emailHandler.confirmSendEmail(draft, context.user);

      await this.auditLog('email_reply_sent', {
        to: draft.to,
        subject: draft.subject,
        originalMessageId: pending.email.messageId
      });

      return {
        response: result.message || `✅ Reply sent to ${draft.to}!`,
        intent: 'confirm'
      };
    } catch (error) {
      console.error('[EmailReplyHandler] Email reply error:', error.message);
      const { message } = await this.errorHandler.handle(error, {
        operation: 'send_reply',
        user: context.user
      });
      return {
        response: message,
        error: true
      };
    }
  }

  /**
   * Handle an ignore action (clear pending replies without sending)
   *
   * @param {Object} pendingReply - The pending reply { id, data }
   * @param {EmailReplyContext} context - Request context
   * @param {EmailReplyHandlers} handlers - Available handlers
   * @returns {Promise<ConfirmationResult>}
   */
  async handleIgnore(pendingReply, context, handlers) {
    const pending = pendingReply.data;
    const pendingCount = pendingEmailReplies.size('email_reply');

    // Clear ALL pending replies since user is done with this batch
    const clearedCount = pendingEmailReplies.clearType('email_reply');

    await this.auditLog('email_reply_ignored', {
      messageId: pending.email.messageId,
      clearedCount: pendingCount
    });

    return {
      response: `👍 Email ignored. ${pendingCount > 1 ? `Cleared ${pendingCount} pending notifications.` : 'No reply will be sent.'}`,
      intent: 'confirm'
    };
  }

  /**
   * Handle an edit action (prompt for new response text)
   *
   * @param {Object} pendingReply - The pending reply { id, data }
   * @param {EmailReplyContext} context - Request context
   * @param {EmailReplyHandlers} handlers - Available handlers
   * @returns {Promise<ConfirmationResult>}
   */
  async handleEdit(pendingReply, context, handlers) {
    const pending = pendingReply.data;

    return {
      response: `✏️ Please type your edited response for "${pending.email.subject}". I'll use that instead of my draft.`,
      intent: 'confirm'
    };
  }

  // ---------------------------------------------------------------------------
  // Private Helpers
  // ---------------------------------------------------------------------------

  /**
   * Build email draft object from pending reply data
   *
   * @param {Object} pending - Pending reply data
   * @returns {Object} Draft object for confirmSendEmail
   * @private
   */
  _buildDraft(pending) {
    return {
      to: pending.email.fromAddress,
      subject: `Re: ${pending.email.subject.replace(/^Re:\s*/i, '')}`,
      body: pending.draft,
      inReplyTo: pending.email.inReplyTo,
      references: pending.email.references
    };
  }
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = EmailReplyHandler;
