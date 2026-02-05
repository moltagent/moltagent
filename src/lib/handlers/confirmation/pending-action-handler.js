/**
 * Pending Action Confirmation Handler
 *
 * Architecture Brief:
 * -------------------
 * Problem: MessageRouter handles both email reply confirmations (from global store)
 * and regular pending confirmations (from internal Map). These have different
 * lifecycles and should be handled separately.
 *
 * Pattern: Strategy pattern - this handler processes confirmations stored in
 * MessageRouter.pendingConfirmations Map (calendar events, composed emails).
 *
 * Key Dependencies:
 * - MessageRouter.pendingConfirmations Map (passed in)
 * - src/lib/handlers/calendar-handler.js (for event creation)
 * - src/lib/handlers/email-handler.js (for email sending)
 * - src/lib/errors/error-handler.js (for safe error messages)
 *
 * Data Flow:
 * - MessageRouter finds pending confirmation for user in its Map
 * - Delegates to this handler with (pending, context, handlers)
 * - Handler executes confirmed action
 * - Returns { response, intent, error? }
 *
 * Integration Points:
 * - Called by MessageRouter._handleConfirmation()
 * - Calls calendarHandler.confirmCreateEvent()
 * - Calls emailHandler.confirmSendEmail()
 *
 * @module handlers/confirmation/pending-action-handler
 * @version 1.0.0
 */

'use strict';

const { createErrorHandler } = require('../../errors/error-handler');

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * @typedef {Object} PendingAction
 * @property {string} handler - Handler type ('calendar' | 'email' | 'skillforge')
 * @property {Object} data - Handler-specific action data
 * @property {string} user - User who initiated the action
 * @property {number} timestamp - When action was stored
 */

/**
 * @typedef {Object} ActionContext
 * @property {string} user - The user confirming the action
 * @property {string} [token] - NC Talk room token
 * @property {string} [messageId] - Original message ID
 */

/**
 * @typedef {Object} ActionHandlers
 * @property {Object} [calendarHandler] - Calendar handler with confirmCreateEvent()
 * @property {Object} [emailHandler] - Email handler with confirmSendEmail()
 * @property {Object} [skillForgeHandler] - SkillForge handler with confirmActivateSkill()
 * @property {Function} auditLog - Audit logging function
 */

/**
 * @typedef {Object} ConfirmationResult
 * @property {string} response - User-facing response message
 * @property {string} intent - Always 'confirm' for confirmation handlers
 * @property {boolean} [error] - True if an error occurred
 */

// -----------------------------------------------------------------------------
// Pending Action Handler Class
// -----------------------------------------------------------------------------

/**
 * Handles confirmation responses for pending actions stored in MessageRouter.
 *
 * Supports two handler types:
 * - calendar: Execute event creation via calendarHandler.confirmCreateEvent()
 * - email: Execute email send via emailHandler.confirmSendEmail()
 */
class PendingActionHandler {
  /**
   * @param {Object} options
   * @param {Function} [options.auditLog] - Audit logging function
   */
  constructor(options = {}) {
    /** @type {Function} */
    this.auditLog = options.auditLog || (async () => {});

    /** @type {import('../../errors/error-handler').ErrorHandler} */
    this.errorHandler = createErrorHandler({
      serviceName: 'PendingActionHandler',
      auditLog: this.auditLog
    });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Find a pending action for the given user
   *
   * @param {Map<string, PendingAction>} pendingMap - The pending confirmations Map
   * @param {string} user - User to find pending action for
   * @returns {{ id: string, pending: PendingAction }|null} Found action or null
   */
  findForUser(pendingMap, user) {
    for (const [id, pending] of pendingMap.entries()) {
      if (pending.user === user) {
        return { id, pending };
      }
    }
    return null;
  }

  /**
   * Handle an approval (execute the pending action)
   *
   * @param {string} pendingId - The pending action ID
   * @param {PendingAction} pending - The pending action data
   * @param {Map<string, PendingAction>} pendingMap - The pending confirmations Map
   * @param {ActionContext} context - Request context
   * @param {ActionHandlers} handlers - Available handlers
   * @returns {Promise<ConfirmationResult>}
   */
  async handleApprove(pendingId, pending, pendingMap, context, handlers) {
    // Remove from pending
    pendingMap.delete(pendingId);

    // Execute the confirmed action
    await this.auditLog('action_confirmed', {
      handler: pending.handler,
      user: context.user
    });

    try {
      let result;

      if (pending.handler === 'calendar' && handlers.calendarHandler) {
        result = await handlers.calendarHandler.confirmCreateEvent(pending.data, context.user);
      } else if (pending.handler === 'email' && handlers.emailHandler) {
        result = await handlers.emailHandler.confirmSendEmail(pending.data, context.user);
      } else if (pending.handler === 'skillforge' && handlers.skillForgeHandler) {
        result = await handlers.skillForgeHandler.confirmActivateSkill(pending.data, context.user);
      } else {
        return {
          response: 'Handler not available to execute the action.',
          error: true
        };
      }

      return {
        response: result.response || result.message || 'Action completed successfully.',
        intent: 'confirm'
      };

    } catch (error) {
      console.error('[PendingActionHandler] Confirmation execution error:', error.message);
      const { message } = await this.errorHandler.handle(error, {
        operation: 'execute_confirmation',
        user: context.user
      });
      return {
        response: message,
        error: true
      };
    }
  }

  /**
   * Handle a rejection (cancel the pending action)
   *
   * @param {string} pendingId - The pending action ID
   * @param {PendingAction} pending - The pending action data
   * @param {Map<string, PendingAction>} pendingMap - The pending confirmations Map
   * @param {ActionContext} context - Request context
   * @param {ActionHandlers} handlers - Available handlers
   * @returns {Promise<ConfirmationResult>}
   */
  async handleReject(pendingId, pending, pendingMap, context, handlers) {
    // Remove from pending
    pendingMap.delete(pendingId);

    await this.auditLog('action_cancelled', {
      handler: pending.handler,
      user: context.user
    });

    return {
      response: 'Action cancelled.',
      intent: 'confirm'
    };
  }

  /**
   * Handle case where no pending action exists
   *
   * @returns {ConfirmationResult}
   */
  handleNoPending() {
    return {
      response: "I don't have any pending actions waiting for your confirmation.",
      intent: 'confirm'
    };
  }
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = PendingActionHandler;
