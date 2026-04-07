/*
 * Moltagent - Sovereign AI Security Layer
 * Copyright (C) 2026 Moltagent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 */

/**
 * Moltagent Calendar Alert Scoping
 *
 * Shared filter helpers that restrict calendar alerts to events relevant
 * to the instance owner. Prevents alerting on shared-calendar events
 * the owner isn't attending, and keeps Molti-created multi-user events
 * visible when the owner is an attendee.
 *
 * Used by: HeartbeatManager._checkCalendar, DailyBriefing.checkAndBuild,
 * MeetingPreparer.checkAndPrep.
 *
 * @module integrations/calendar-scoping
 * @version 1.0.0
 */

'use strict';

/**
 * Resolve owner identities (username + emails) for event filtering.
 *
 * Fetches the owner's email from the DAV principal via NCRequestManager.
 * Results should be cached at startup — this is not meant to be called
 * per-event.
 *
 * @param {string} adminUser - Nextcloud username of the owner
 * @param {Object} ncRequestManager - NCRequestManager instance
 * @returns {Promise<{username: string, emails: string[]}>}
 */
async function resolveOwnerIdentities(adminUser, ncRequestManager) {
  if (!adminUser) {
    return { username: '', emails: [] };
  }

  const emails = [];

  if (ncRequestManager && typeof ncRequestManager.getUserEmail === 'function') {
    try {
      const email = await ncRequestManager.getUserEmail(adminUser);
      if (email) {
        emails.push(email.toLowerCase());
      }
    } catch (err) {
      console.warn('[CalendarScoping] Could not resolve owner email:', err.message);
    }
  }

  return { username: adminUser, emails };
}

/**
 * Check whether a calendar event is relevant to the owner.
 *
 * Returns true if:
 * - Owner is listed as ORGANIZER (email match)
 * - Owner is listed as ATTENDEE (email match)
 * - Event has no attendees and no organizer (personal event on any calendar)
 *
 * @param {Object} event - Calendar event (from caldav-client _parseICS)
 * @param {Object} ownerIds - From resolveOwnerIdentities()
 * @param {string} ownerIds.username - NC username
 * @param {string[]} ownerIds.emails - Owner email addresses (lowercase)
 * @returns {boolean}
 */
function isOwnerEvent(event, ownerIds) {
  if (!ownerIds || (!ownerIds.username && ownerIds.emails.length === 0)) {
    return true; // No owner configured — pass everything through
  }

  const hasAttendees = event.attendees && event.attendees.length > 0;
  const hasOrganizer = event.organizer && event.organizer.email;

  // Personal event: no attendees and no organizer → always relevant
  if (!hasAttendees && !hasOrganizer) {
    return true;
  }

  const ownerEmails = ownerIds.emails;
  if (ownerEmails.length === 0) {
    // No email resolved — can't match attendees, fall back to pass-through
    return true;
  }

  // Check if owner is the organizer
  if (hasOrganizer) {
    const orgEmail = event.organizer.email.toLowerCase();
    if (ownerEmails.includes(orgEmail)) {
      return true;
    }
  }

  // Check if owner is an attendee
  if (hasAttendees) {
    for (const attendee of event.attendees) {
      if (attendee.email) {
        const attEmail = attendee.email.toLowerCase();
        if (ownerEmails.includes(attEmail)) {
          return true;
        }
      }
    }
  }

  // Event has attendees/organizer but owner isn't among them
  return false;
}

/**
 * Filter a list of events to only owner-relevant ones.
 *
 * @param {Object[]} events - Array of calendar events
 * @param {Object|null} ownerIds - From resolveOwnerIdentities(), or null to skip filtering
 * @returns {Object[]} Filtered events
 */
function filterOwnerEvents(events, ownerIds) {
  if (!ownerIds) {
    return events || []; // No owner identity — pass everything through
  }
  if (!Array.isArray(events)) {
    return [];
  }
  return events.filter(event => isOwnerEvent(event, ownerIds));
}

module.exports = { resolveOwnerIdentities, isOwnerEvent, filterOwnerEvents };
