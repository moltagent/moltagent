/**
 * Meeting Response Confirmation Handler
 *
 * Architecture Brief:
 * -------------------
 * Problem: Meeting invitation responses (accept, decline, suggest alternatives)
 * require coordination between email sending and calendar updates. This logic
 * was embedded in MessageRouter._handleConfirmation(), making it hard to test.
 *
 * Pattern: Strategy pattern - this handler processes meeting-related confirmations
 * from pending email replies that have is_meeting_request=true.
 *
 * Key Dependencies:
 * - src/lib/pending-action-store.js (pendingEmailReplies singleton)
 * - src/lib/handlers/email-handler.js (for sending responses)
 * - src/lib/integrations/caldav-client.js (for calendar updates)
 * - src/lib/errors/error-handler.js (for safe error messages)
 *
 * Data Flow:
 * - MessageRouter detects pending meeting request + response
 * - Delegates to this handler with (message, context, handlers)
 * - Handler sends email AND updates calendar as appropriate
 * - Returns { response, intent, error? }
 *
 * Integration Points:
 * - Called by MessageRouter._handleConfirmation()
 * - Uses pendingEmailReplies.getRecent(), clearType()
 * - Calls emailHandler.confirmSendEmail()
 * - Calls calendarClient.respondToMeeting()
 *
 * @module handlers/confirmation/meeting-response-handler
 * @version 1.0.0
 */

'use strict';

const { pendingEmailReplies } = require('../../pending-action-store');
const { createErrorHandler } = require('../../errors/error-handler');

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * @typedef {Object} MeetingContext
 * @property {string} user - The user responding to the meeting
 * @property {string} [token] - NC Talk room token
 * @property {string} [messageId] - Original message ID
 */

/**
 * @typedef {Object} MeetingHandlers
 * @property {Object} emailHandler - Email handler with confirmSendEmail()
 * @property {Object} [calendarClient] - CalDAV client with respondToMeeting()
 * @property {Function} auditLog - Audit logging function
 */

/**
 * @typedef {Object} ConfirmationResult
 * @property {string} response - User-facing response message
 * @property {string} intent - Always 'confirm' for confirmation handlers
 * @property {boolean} [error] - True if an error occurred
 */

/**
 * @typedef {'accept'|'decline'|'suggest'|'accept_anyway'} MeetingAction
 */

// -----------------------------------------------------------------------------
// Meeting Response Handler Class
// -----------------------------------------------------------------------------

/**
 * Handles confirmation responses for pending meeting invitations.
 *
 * Supports four actions:
 * - accept: Accept meeting, send confirmation email, add to calendar
 * - decline: Decline meeting, send polite decline email
 * - suggest: Suggest alternative times from calendar_context
 * - accept_anyway: Accept despite calendar conflict (double-booking)
 */
class MeetingResponseHandler {
  /**
   * @param {Object} options
   * @param {Function} [options.auditLog] - Audit logging function
   */
  constructor(options = {}) {
    /** @type {Function} */
    this.auditLog = options.auditLog || (async () => {});

    /** @type {import('../../errors/error-handler').ErrorHandler} */
    this.errorHandler = createErrorHandler({
      serviceName: 'MeetingResponseHandler',
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
   * @returns {boolean} True if this is a meeting request
   */
  canHandle(pendingReply) {
    if (!pendingReply || !pendingReply.data) {
      return false;
    }
    return pendingReply.data.is_meeting_request === true;
  }

  /**
   * Determine which meeting action the message represents
   *
   * @param {string} message - The user's response message (lowercase, trimmed)
   * @returns {MeetingAction|null} The action type or null if not a meeting action
   */
  classifyAction(message) {
    if (/^accept anyway$/.test(message)) {
      return 'accept_anyway';
    }
    if (/^(yes|yep|yeah|sure|ok|okay|confirm|send it|do it|go ahead|proceed|approved?|send|accept)$/.test(message)) {
      return 'accept';
    }
    if (/^decline$/.test(message)) {
      return 'decline';
    }
    if (/^(suggest|suggest alternatives?)$/.test(message)) {
      return 'suggest';
    }
    return null;
  }

  /**
   * Handle a meeting acceptance
   *
   * @param {Object} pendingReply - The pending reply { id, data }
   * @param {MeetingContext} context - Request context
   * @param {MeetingHandlers} handlers - Available handlers
   * @returns {Promise<ConfirmationResult>}
   */
  async handleAccept(pendingReply, context, handlers) {
    const pending = pendingReply.data;
    const calendarCtx = pending.calendar_context;

    // Clear pending replies
    pendingEmailReplies.clearType('email_reply');

    const acceptBody = pending.draft || `Thank you for the meeting invitation. I confirm my attendance. Looking forward to it!`;

    try {
      // Build and send acceptance email
      const draft = this._buildDraft(pending, acceptBody);
      await handlers.emailHandler.confirmSendEmail(draft, context.user);

      // Add meeting to calendar if available
      let calendarResult = null;
      if (handlers.calendarClient && calendarCtx?.proposed_time) {
        try {
          const eventDetails = this._buildEventDetails(pending);
          calendarResult = await handlers.calendarClient.respondToMeeting(eventDetails, 'ACCEPTED');
          console.log(`[MeetingResponseHandler] Meeting added to calendar: ${calendarResult.event?.uid}`);
        } catch (calErr) {
          console.error('[MeetingResponseHandler] Failed to add meeting to calendar:', calErr.message);
          // Don't fail the whole operation - email was sent successfully
        }
      }

      await this.auditLog('meeting_accepted', {
        to: draft.to,
        proposed_time: calendarCtx?.proposed_time,
        had_conflict: !calendarCtx?.is_available,
        calendar_event_uid: calendarResult?.event?.uid
      });

      const calendarNote = calendarResult?.success ? ' 📅 Added to your calendar.' : '';
      return {
        response: `✅ Meeting confirmation sent to ${pending.email.fromAddress}!${calendarNote}`,
        intent: 'confirm'
      };
    } catch (error) {
      const { message } = await this.errorHandler.handle(error, {
        operation: 'send_acceptance',
        user: context.user
      });
      return { response: message, error: true };
    }
  }

  /**
   * Handle a meeting acceptance with known conflict
   *
   * @param {Object} pendingReply - The pending reply { id, data }
   * @param {MeetingContext} context - Request context
   * @param {MeetingHandlers} handlers - Available handlers
   * @returns {Promise<ConfirmationResult>}
   */
  async handleAcceptAnyway(pendingReply, context, handlers) {
    const pending = pendingReply.data;
    const calendarCtx = pending.calendar_context;

    // Clear pending replies
    pendingEmailReplies.clearType('email_reply');

    const acceptBody = pending.draft || `Thank you for the meeting invitation. I confirm my attendance. Looking forward to it!`;

    try {
      // Build and send acceptance email
      const draft = this._buildDraft(pending, acceptBody);
      await handlers.emailHandler.confirmSendEmail(draft, context.user);

      // Add meeting to calendar if available
      let calendarResult = null;
      if (handlers.calendarClient && calendarCtx?.proposed_time) {
        try {
          const eventDetails = this._buildEventDetails(pending);
          calendarResult = await handlers.calendarClient.respondToMeeting(eventDetails, 'ACCEPTED');
          console.log(`[MeetingResponseHandler] Meeting added to calendar: ${calendarResult.event?.uid}`);
        } catch (calErr) {
          console.error('[MeetingResponseHandler] Failed to add meeting to calendar:', calErr.message);
          // Don't fail the whole operation - email was sent successfully
        }
      }

      await this.auditLog('meeting_accepted_with_conflict', {
        to: draft.to,
        proposed_time: calendarCtx?.proposed_time,
        had_conflict: !calendarCtx?.is_available,
        calendar_event_uid: calendarResult?.event?.uid
      });

      const conflictWarning = ' ⚠️ Note: This creates a double-booking in your calendar.';
      const calendarNote = calendarResult?.success ? ' 📅 Added to your calendar.' : '';
      return {
        response: `✅ Meeting confirmation sent to ${pending.email.fromAddress}!${calendarNote}${conflictWarning}`,
        intent: 'confirm'
      };
    } catch (error) {
      const { message } = await this.errorHandler.handle(error, {
        operation: 'send_acceptance',
        user: context.user
      });
      return { response: message, error: true };
    }
  }

  /**
   * Handle a meeting decline
   *
   * @param {Object} pendingReply - The pending reply { id, data }
   * @param {MeetingContext} context - Request context
   * @param {MeetingHandlers} handlers - Available handlers
   * @returns {Promise<ConfirmationResult>}
   */
  async handleDecline(pendingReply, context, handlers) {
    const pending = pendingReply.data;
    const meetingDetails = pending.meeting_details;
    const calendarCtx = pending.calendar_context;

    // Clear pending replies
    pendingEmailReplies.clearType('email_reply');

    const declineBody = `Thank you for the meeting invitation. Unfortunately, I won't be able to attend at the proposed time. Please let me know if there are other times that might work.`;

    try {
      // Build and send decline email
      const draft = this._buildDraft(pending, declineBody);
      await handlers.emailHandler.confirmSendEmail(draft, context.user);

      // Update calendar (log the decline, no event created)
      if (handlers.calendarClient && calendarCtx?.proposed_time) {
        try {
          const eventDetails = this._buildEventDetails(pending);
          await handlers.calendarClient.respondToMeeting(eventDetails, 'DECLINED');
        } catch (calErr) {
          console.error('[MeetingResponseHandler] Calendar decline logging failed:', calErr.message);
        }
      }

      await this.auditLog('meeting_declined', {
        to: draft.to,
        proposed_time: calendarCtx?.proposed_time
      });

      return {
        response: `✅ Decline sent to ${pending.email.fromAddress}. The meeting has been politely declined.`,
        intent: 'confirm'
      };
    } catch (error) {
      const { message } = await this.errorHandler.handle(error, {
        operation: 'send_decline',
        user: context.user
      });
      return { response: message, error: true };
    }
  }

  /**
   * Handle suggesting alternative meeting times
   *
   * @param {Object} pendingReply - The pending reply { id, data }
   * @param {MeetingContext} context - Request context
   * @param {MeetingHandlers} handlers - Available handlers
   * @returns {Promise<ConfirmationResult>}
   */
  async handleSuggestAlternatives(pendingReply, context, handlers) {
    const pending = pendingReply.data;
    const calendarCtx = pending.calendar_context;

    // Check that alternatives exist
    if (!calendarCtx?.suggested_alternatives?.length) {
      return {
        response: 'No alternative times are available to suggest.',
        intent: 'confirm',
        error: true
      };
    }

    // Clear pending replies
    pendingEmailReplies.clearType('email_reply');

    // Format alternatives as bullet list
    const alternatives = this._formatAlternatives(calendarCtx.suggested_alternatives);

    const suggestBody = `Thank you for the meeting invitation. Unfortunately, I have a conflict at the proposed time. Would any of these alternatives work for you?\n\n${alternatives}\n\nPlease let me know what works best for you.`;

    try {
      // Build and send suggestion email
      const draft = this._buildDraft(pending, suggestBody);
      await handlers.emailHandler.confirmSendEmail(draft, context.user);

      await this.auditLog('meeting_alternatives_suggested', {
        to: draft.to,
        alternatives: calendarCtx.suggested_alternatives.length
      });

      return {
        response: `✅ Alternative times sent to ${pending.email.fromAddress}!`,
        intent: 'confirm'
      };
    } catch (error) {
      const { message } = await this.errorHandler.handle(error, {
        operation: 'send_alternatives',
        user: context.user
      });
      return { response: message, error: true };
    }
  }

  // ---------------------------------------------------------------------------
  // Private Helpers
  // ---------------------------------------------------------------------------

  /**
   * Build email draft for meeting response
   *
   * @param {Object} pending - Pending reply data
   * @param {string} body - Email body content
   * @returns {Object} Draft object for confirmSendEmail
   * @private
   */
  _buildDraft(pending, body) {
    return {
      to: pending.email.fromAddress,
      subject: `Re: ${pending.email.subject.replace(/^Re:\s*/i, '')}`,
      body: body,
      inReplyTo: pending.email.inReplyTo,
      references: pending.email.references
    };
  }

  /**
   * Build meeting event details for calendar
   *
   * @param {Object} pending - Pending reply data
   * @returns {Object} Event details for respondToMeeting
   * @private
   */
  _buildEventDetails(pending) {
    const meetingDetails = pending.meeting_details;
    const calendarCtx = pending.calendar_context;

    return {
      summary: meetingDetails?.topic || pending.email.subject.replace(/^Re:\s*/i, ''),
      start: calendarCtx.proposed_time,
      end: calendarCtx.proposed_end,
      durationMinutes: calendarCtx.duration_minutes,
      location: meetingDetails?.location,
      organizerEmail: pending.email.fromAddress,
      organizerName: pending.email.fromName
    };
  }

  /**
   * Format alternative times as bullet list
   *
   * @param {Array<{display: string}>} alternatives - Alternative time slots
   * @returns {string} Formatted bullet list
   * @private
   */
  _formatAlternatives(alternatives) {
    return alternatives
      .map((alt, i) => `• ${alt.display}`)
      .join('\n');
  }
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = MeetingResponseHandler;
