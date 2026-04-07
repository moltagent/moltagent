/**
 * Moltagent RSVP Tracker
 *
 * Architecture Brief:
 * -------------------
 * Problem: After scheduling a meeting with attendees, there is no mechanism
 * to detect when participants respond (accept/decline/tentative) and proactively
 * notify the user.
 *
 * Pattern: In-memory Map of tracked events. On each heartbeat pulse, queries
 * CalDAV for current PARTSTAT values and compares against last-known state.
 * On change, sends a Talk notification. Auto-expires events after they end.
 *
 * Key Dependencies:
 *   - CalDAVClient.getEvent() (reads PARTSTAT from ATTENDEE properties)
 *   - notifyUser function (Talk notifications)
 *   - HeartbeatManager (calls checkUpdates() in pulse())
 *
 * Data Flow:
 *   trackEvent() -> pendingEvents Map
 *   checkUpdates() -> CalDAV getEvent() -> compare PARTSTAT -> notifyUser()
 *   getStatus() -> read from pendingEvents Map
 *
 * Dependency Map:
 *   rsvp-tracker.js depends on: caldav-client
 *   Used by: heartbeat-manager.js (pulse), tool-registry (future meeting_rsvp_status tool)
 *
 * @module integrations/rsvp-tracker
 * @version 1.0.0
 */

'use strict';

/**
 * @typedef {Object} TrackedEvent
 * @property {string} uid - Event UID
 * @property {string} calendarId - Calendar ID where event lives
 * @property {string} summary - Event summary/title
 * @property {string} eventEnd - ISO string of event end time (for expiry)
 * @property {Array<TrackedAttendee>} attendees
 * @property {number} lastChecked - Timestamp of last PARTSTAT check (ms)
 * @property {number} trackedSince - Timestamp when tracking started (ms)
 */

/**
 * @typedef {Object} TrackedAttendee
 * @property {string} email
 * @property {string} name
 * @property {string} lastStatus - Last known PARTSTAT (NEEDS-ACTION, ACCEPTED, DECLINED, TENTATIVE)
 * @property {string|null} respondedAt - ISO timestamp of when status last changed
 */

class RSVPTracker {
  /**
   * @param {Object} config
   * @param {Object} config.caldavClient - CalDAVClient instance
   * @param {Function} config.notifyUser - Notification function (async, receives {type, message, ...})
   * @param {Function} [config.auditLog] - Audit logging function
   * @param {number} [config.checkIntervalMs] - Min ms between checks for the same event (default: 300000 = 5min)
   * @param {number} [config.expiryBufferMs] - Time after event end to keep tracking (default: 3600000 = 1hr)
   */
  constructor(config = {}) {
    if (!config.caldavClient) {
      throw new Error('RSVPTracker requires a CalDAVClient instance');
    }

    this.caldavClient = config.caldavClient;
    this.notifyUser = config.notifyUser || (async () => {});
    this.auditLog = config.auditLog || (async () => {});
    this.checkIntervalMs = config.checkIntervalMs || 300000;
    this.expiryBufferMs = config.expiryBufferMs || 3600000;

    /** @type {Map<string, TrackedEvent>} */
    this.pendingEvents = new Map();
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Register an event for RSVP tracking.
   * Called after successful meeting creation via scheduleMeeting().
   * @param {string} uid - Event UID
   * @param {string} calendarId - Calendar ID
   * @param {Array<{email: string, name: string}>} attendees - Attendee list
   * @param {string} summary - Event title
   * @param {string} eventEnd - ISO datetime of event end
   */
  trackEvent(uid, calendarId, attendees, summary, eventEnd) {
    const trackedEvent = {
      uid,
      calendarId,
      summary,
      eventEnd,
      attendees: attendees.map(a => ({
        email: a.email,
        name: a.name || a.email,
        lastStatus: 'NEEDS-ACTION',
        respondedAt: null
      })),
      lastChecked: 0,
      trackedSince: Date.now()
    };
    this.pendingEvents.set(uid, trackedEvent);
  }

  /**
   * Stop tracking an event (e.g. event was cancelled/deleted).
   * @param {string} uid
   * @returns {boolean} True if event was being tracked
   */
  untrackEvent(uid) {
    return this.pendingEvents.delete(uid);
  }

  /**
   * Check all tracked events for RSVP status changes.
   * Called from HeartbeatManager.pulse().
   * Respects checkIntervalMs to avoid hammering CalDAV.
   * @returns {Promise<{checked: number, changes: number, expired: number, errors: string[]}>}
   */
  async checkUpdates() {
    const expired = this._cleanupExpired();
    let checked = 0;
    let changes = 0;
    const errors = [];

    for (const [uid, tracked] of this.pendingEvents) {
      // Skip if checked recently
      if (Date.now() - tracked.lastChecked < this.checkIntervalMs) {
        continue;
      }

      try {
        const event = await this.caldavClient.getEvent(tracked.calendarId, uid);

        // Event was deleted
        if (event === null) {
          this.untrackEvent(uid);
          continue;
        }

        // Check each attendee for status changes
        for (const attendee of tracked.attendees) {
          const currentStatus = this._extractPartstat(event, attendee.email);

          if (currentStatus !== attendee.lastStatus && currentStatus !== 'UNKNOWN') {
            await this._notifyStatusChange(tracked, attendee, attendee.lastStatus, currentStatus);
            attendee.lastStatus = currentStatus;
            attendee.respondedAt = new Date().toISOString();
            changes++;
          }
        }

        tracked.lastChecked = Date.now();
        checked++;

        // If all attendees have responded, untrack the event
        if (tracked.attendees.every(a => a.lastStatus !== 'NEEDS-ACTION')) {
          this.untrackEvent(uid);
        }
      } catch (err) {
        errors.push(err.message);
      }
    }

    return { checked, changes, expired, errors };
  }

  /**
   * Get current RSVP status for a tracked event.
   * @param {string} uid - Event UID
   * @returns {{found: boolean, summary?: string, attendees?: Array<TrackedAttendee>, allResponded?: boolean}}
   */
  getStatus(uid) {
    const tracked = this.pendingEvents.get(uid);

    if (!tracked) {
      return { found: false };
    }

    return {
      found: true,
      summary: tracked.summary,
      attendees: tracked.attendees,
      allResponded: tracked.attendees.every(a => a.lastStatus !== 'NEEDS-ACTION')
    };
  }

  /**
   * Get summary of all pending events with RSVP tracking.
   * @returns {Array<{uid: string, summary: string, pending: number, accepted: number, declined: number, tentative: number}>}
   */
  getPendingSummary() {
    const summary = [];

    for (const [uid, tracked] of this.pendingEvents) {
      const counts = {
        uid,
        summary: tracked.summary,
        pending: 0,
        accepted: 0,
        declined: 0,
        tentative: 0
      };

      for (const attendee of tracked.attendees) {
        if (attendee.lastStatus === 'NEEDS-ACTION') {
          counts.pending++;
        } else if (attendee.lastStatus === 'ACCEPTED') {
          counts.accepted++;
        } else if (attendee.lastStatus === 'DECLINED') {
          counts.declined++;
        } else if (attendee.lastStatus === 'TENTATIVE') {
          counts.tentative++;
        }
      }

      summary.push(counts);
    }

    return summary;
  }

  /**
   * Number of events currently being tracked.
   * @returns {number}
   */
  get trackedCount() {
    return this.pendingEvents.size;
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  /**
   * Extract PARTSTAT for a specific attendee email from a parsed CalDAV event.
   * @private
   * @param {Object} event - Parsed CalDAV event (from _parseICS). Has event.attendees array.
   * @param {string} email - Attendee email to find
   * @returns {string} PARTSTAT value or 'UNKNOWN'
   */
  _extractPartstat(event, email) {
    if (!event || !event.attendees || !Array.isArray(event.attendees)) {
      return 'UNKNOWN';
    }

    // Normalize search email: lowercase, strip mailto:
    const normalizedEmail = email.toLowerCase().replace(/^mailto:/i, '');

    // Search for matching attendee
    const attendee = event.attendees.find(a => {
      const attendeeEmail = (a.email || '').toLowerCase().replace(/^mailto:/i, '');
      return attendeeEmail === normalizedEmail;
    });

    return attendee ? attendee.status : 'UNKNOWN';
  }

  /**
   * Send proactive notification about an RSVP status change.
   * @private
   * @param {TrackedEvent} tracked - Tracked event
   * @param {TrackedAttendee} attendee - Attendee whose status changed
   * @param {string} oldStatus - Previous PARTSTAT
   * @param {string} newStatus - New PARTSTAT
   * @returns {Promise<void>}
   */
  async _notifyStatusChange(tracked, attendee, oldStatus, newStatus) {
    // Choose status text based on newStatus
    let statusText;
    if (newStatus === 'ACCEPTED') {
      statusText = 'accepted';
    } else if (newStatus === 'DECLINED') {
      statusText = 'declined';
    } else if (newStatus === 'TENTATIVE') {
      statusText = 'tentatively accepted';
    } else {
      statusText = `updated their status to ${newStatus}`;
    }

    // Build message
    let message = `${attendee.name} has ${statusText} the meeting "${tracked.summary}".`;

    // Add suggestion for declined attendees
    if (newStatus === 'DECLINED') {
      message += ' You may want to find a new time or proceed without them.';
    }

    // Send notification
    await this.notifyUser({
      type: 'rsvp_update',
      urgency: newStatus === 'DECLINED' ? 'high' : 'normal',
      message,
      event: tracked
    });

    // Audit log
    await this.auditLog('rsvp_status_change', {
      uid: tracked.uid,
      email: attendee.email,
      oldStatus,
      newStatus,
      summary: tracked.summary
    });
  }

  /**
   * Remove events past their end time + buffer.
   * @private
   * @returns {number} Number of events removed
   */
  _cleanupExpired() {
    const now = Date.now();
    let removed = 0;

    for (const [uid, tracked] of this.pendingEvents) {
      const endMs = new Date(tracked.eventEnd).getTime();
      if (!isNaN(endMs) && (endMs + this.expiryBufferMs) < now) {
        this.pendingEvents.delete(uid);
        removed++;
      }
    }

    return removed;
  }
}

module.exports = RSVPTracker;
