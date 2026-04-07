/**
 * Moltagent CalDAV Client
 *
 * Full calendar integration for Nextcloud:
 * - Calendar discovery (owned + shared)
 * - Event CRUD (create, read, update, delete)
 * - Availability/free-busy checking
 * - Meeting invitations via email
 * - Recurring events support
 * - Time zone handling
 *
 * Now uses NCRequestManager for all API calls.
 *
 * @version 2.0.0
 */

const crypto = require('crypto');

class CalDAVClient {
  /**
   * @param {Object} ncRequestManager - NCRequestManager instance
   * @param {Object} credentialBroker - CredentialBroker instance (for compatibility)
   * @param {Object} config
   * @param {string} config.ncUrl - Nextcloud base URL (optional if ncRequestManager has it)
   * @param {string} config.username - CalDAV username
   * @param {Object} [config.defaultCalendar] - Default calendar to use
   * @param {Function} [config.auditLog] - Audit logging function
   */
  constructor(ncRequestManager, credentialBroker, config = {}) {
    // Support both new (ncRequestManager, credentialBroker, config) and legacy (config) signatures
    if (ncRequestManager && typeof ncRequestManager.request === 'function') {
      // New signature
      this.nc = ncRequestManager;
      this.credentialBroker = credentialBroker;
      this.ncUrl = config.ncUrl || ncRequestManager.ncUrl || '';
      this.username = config.username || ncRequestManager.ncUser || 'moltagent';
      this.defaultCalendar = config.defaultCalendar || 'personal';
      this.auditLog = config.auditLog || (async () => {});
    } else {
      // Legacy signature: (config)
      const legacyConfig = ncRequestManager || {};
      this.nc = null; // Will need to fall back to direct HTTP
      this.ncUrl = legacyConfig.ncUrl?.replace(/\/$/, '') || '';
      this.username = legacyConfig.username || 'moltagent';
      this.credentialBroker = legacyConfig.credentialBroker;
      this._directPassword = legacyConfig.password;
      this.defaultCalendar = legacyConfig.defaultCalendar || 'personal';
      this.auditLog = legacyConfig.auditLog || (async () => {});
    }

    // Timezone for ICS generation (IANA identifier)
    this.timezone = config.timezone || 'UTC';

    // Cache for calendars
    this._calendarsCache = null;
    this._cacheExpiry = 0;
    this._cacheTTL = 60000; // 1 minute
  }

  // ============================================================
  // HTTP Request Helpers
  // ============================================================

  /**
   * Make a CalDAV request via NCRequestManager
   */
  async _request(method, path, { body = null, headers = {}, depth = null } = {}) {
    const requestHeaders = {
      'Content-Type': 'application/xml; charset=utf-8',
      ...headers
    };

    if (depth !== null) {
      requestHeaders['Depth'] = depth.toString();
    }

    // Use NCRequestManager if available
    if (this.nc) {
      const response = await this.nc.request(path, {
        method,
        headers: requestHeaders,
        body
      });

      return {
        status: response.status,
        headers: response.headers,
        body: typeof response.body === 'string' ? response.body : JSON.stringify(response.body)
      };
    }

    // Legacy fallback (should not be used in new architecture)
    throw new Error('CalDAVClient requires NCRequestManager');
  }

  /**
   * Parse XML response (simple parser for CalDAV responses)
   */
  _parseXML(xml) {
    // Extract href and properties from multistatus response
    const responses = [];
    const responseRegex = /<d:response>([\s\S]*?)<\/d:response>/gi;
    let match;

    while ((match = responseRegex.exec(xml)) !== null) {
      const responseXml = match[1];

      // Extract href
      const hrefMatch = /<d:href>([^<]+)<\/d:href>/i.exec(responseXml);
      const href = hrefMatch ? hrefMatch[1] : null;

      // Extract displayname
      const displayNameMatch = /<d:displayname>([^<]*)<\/d:displayname>/i.exec(responseXml);
      const displayName = displayNameMatch ? displayNameMatch[1] : null;

      // Extract calendar color
      const colorMatch = /calendar-color[^>]*>([^<]*)</i.exec(responseXml);
      const color = colorMatch ? colorMatch[1] : null;

      // Check if it's a calendar
      const isCalendar = /<cal:calendar\s*\/>/i.test(responseXml);

      // Check supported components
      const supportsVEVENT = /<cal:comp\s+name="VEVENT"/i.test(responseXml);
      const supportsVTODO = /<cal:comp\s+name="VTODO"/i.test(responseXml);

      // Extract etag
      const etagMatch = /<d:getetag>([^<]+)<\/d:getetag>/i.exec(responseXml);
      const etag = etagMatch ? etagMatch[1].replace(/"/g, '') : null;

      // Extract calendar-data (for events)
      const calDataMatch = /<cal:calendar-data[^>]*>([\s\S]*?)<\/cal:calendar-data>/i.exec(responseXml);
      const calendarData = calDataMatch ? this._decodeXMLEntities(calDataMatch[1]) : null;

      responses.push({
        href,
        displayName,
        color,
        isCalendar,
        supportsVEVENT,
        supportsVTODO,
        etag,
        calendarData
      });
    }

    return responses;
  }

  /**
   * Decode XML entities
   */
  _decodeXMLEntities(text) {
    return text
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }

  // ============================================================
  // Calendar Discovery
  // ============================================================

  /**
   * Get all calendars for the user
   * @returns {Promise<Array>} List of calendars
   */
  async getCalendars(forceRefresh = false) {
    // Check cache
    if (!forceRefresh && this._calendarsCache && Date.now() < this._cacheExpiry) {
      return this._calendarsCache;
    }

    const body = `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns" xmlns:ical="http://apple.com/ns/ical/">
  <d:prop>
    <d:resourcetype />
    <d:displayname />
    <ical:calendar-color />
    <cal:supported-calendar-component-set />
    <cs:getctag />
    <oc:owner-principal />
  </d:prop>
</d:propfind>`;

    const response = await this._request(
      'PROPFIND',
      `/remote.php/dav/calendars/${this.username}/`,
      { body, depth: 1 }
    );

    if (response.status !== 207) {
      throw new Error(`Failed to get calendars: ${response.status}`);
    }

    const parsed = this._parseXML(response.body);

    // Filter to actual calendars (not inbox/outbox/trashbin)
    const calendars = parsed
      .filter(r => r.isCalendar && r.href && !r.href.includes('/inbox/') && !r.href.includes('/outbox/') && !r.href.includes('/trashbin/'))
      .map(r => {
        // Extract calendar ID from href
        const parts = r.href.split('/').filter(Boolean);
        const calendarId = parts[parts.length - 1];

        return {
          id: calendarId,
          href: r.href,
          displayName: r.displayName || calendarId,
          color: r.color,
          supportsEvents: r.supportsVEVENT,
          supportsTasks: r.supportsVTODO,
          isDeckCalendar: calendarId.startsWith('app-generated--deck--')
        };
      });

    // Update cache
    this._calendarsCache = calendars;
    this._cacheExpiry = Date.now() + this._cacheTTL;

    await this.auditLog('caldav_calendars_listed', { count: calendars.length });

    return calendars;
  }

  /**
   * Get calendars that support events (not just tasks)
   */
  async getEventCalendars() {
    const calendars = await this.getCalendars();
    return calendars.filter(c => c.supportsEvents);
  }

  /**
   * Get a specific calendar by ID
   */
  async getCalendar(calendarId) {
    const calendars = await this.getCalendars();
    return calendars.find(c => c.id === calendarId);
  }

  // ============================================================
  // Event Operations
  // ============================================================

  /**
   * Get events from a calendar within a time range
   * @param {string} calendarId - Calendar ID
   * @param {Date} start - Start of range
   * @param {Date} end - End of range
   * @returns {Promise<Array>} List of events
   */
  async getEvents(calendarId, start, end) {
    const startStr = this._formatDateTime(start);
    const endStr = this._formatDateTime(end);

    const body = `<?xml version="1.0" encoding="utf-8" ?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag />
    <c:calendar-data />
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${startStr}" end="${endStr}" />
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;

    const response = await this._request(
      'REPORT',
      `/remote.php/dav/calendars/${this.username}/${calendarId}/`,
      { body, depth: 1 }
    );

    if (response.status !== 207) {
      throw new Error(`Failed to get events: ${response.status}`);
    }

    const parsed = this._parseXML(response.body);
    const events = parsed
      .filter(r => r.calendarData)
      .map(r => this._parseICS(r.calendarData, r.href, r.etag));

    await this.auditLog('caldav_events_queried', {
      calendar: calendarId,
      start: start.toISOString(),
      end: end.toISOString(),
      count: events.length
    });

    return events;
  }

  /**
   * Get all events for today
   */
  async getTodayEvents(calendarId = null) {
    const calendars = calendarId
      ? [{ id: calendarId }]
      : await this.getEventCalendars();

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const allEvents = [];
    for (const cal of calendars) {
      const events = await this.getEvents(cal.id, today, tomorrow);
      events.forEach(e => e.calendarId = cal.id);
      allEvents.push(...events);
    }

    // Sort by start time
    allEvents.sort((a, b) => new Date(a.start) - new Date(b.start));

    return allEvents;
  }

  /**
   * Get events for the next N hours
   */
  async getUpcomingEvents(hours = 24, calendarId = null) {
    const calendars = calendarId
      ? [{ id: calendarId }]
      : await this.getEventCalendars();

    const now = new Date();
    const end = new Date(now.getTime() + hours * 60 * 60 * 1000);

    const allEvents = [];
    for (const cal of calendars) {
      const events = await this.getEvents(cal.id, now, end);
      events.forEach(e => e.calendarId = cal.id);
      allEvents.push(...events);
    }

    // Sort by start time
    allEvents.sort((a, b) => new Date(a.start) - new Date(b.start));

    return allEvents;
  }

  /**
   * Get a specific event by UID
   */
  async getEvent(calendarId, uid) {
    const response = await this._request(
      'GET',
      `/remote.php/dav/calendars/${this.username}/${calendarId}/${uid}.ics`
    );

    if (response.status === 404) {
      return null;
    }

    if (response.status !== 200) {
      throw new Error(`Failed to get event: ${response.status}`);
    }

    return this._parseICS(response.body, null, response.headers.etag);
  }

  /**
   * Create a new event
   * @param {Object} event - Event details
   * @param {string} event.summary - Event title
   * @param {Date} event.start - Start time
   * @param {Date} event.end - End time
   * @param {string} [event.description] - Description
   * @param {string} [event.location] - Location
   * @param {Array<string>} [event.attendees] - Attendee email addresses
   * @param {boolean} [event.allDay] - All-day event
   * @param {string} [event.calendarId] - Target calendar
   * @returns {Promise<Object>} Created event
   */
  async createEvent(event) {
    const calendarId = event.calendarId || this.defaultCalendar;
    const uid = this._generateUID();
    const ics = this._buildICS({
      ...event,
      uid,
      created: new Date(),
      modified: new Date()
    });

    const response = await this._request(
      'PUT',
      `/remote.php/dav/calendars/${this.username}/${calendarId}/${uid}.ics`,
      {
        body: ics,
        headers: {
          'Content-Type': 'text/calendar; charset=utf-8',
          'If-None-Match': '*'
        }
      }
    );

    if (response.status !== 201) {
      throw new Error(`Failed to create event: ${response.status} - ${response.body}`);
    }

    // Read-back verification: confirm the server actually stored the event
    let verified = null;
    try {
      verified = await this.getEvent(calendarId, uid);
    } catch (readbackErr) {
      // Log but don't fail — the PUT succeeded
      console.warn(`[CalDAV] Read-back verification failed for ${uid}: ${readbackErr.message}`);
    }

    if (!verified) {
      console.warn(`[CalDAV] Event ${uid} not found on server after PUT 201 — possible server-side rejection`);
    }

    const serverUid = verified?.uid || uid;

    await this.auditLog('caldav_event_created', {
      calendar: calendarId,
      uid: serverUid,
      summary: event.summary,
      start: event.start.toISOString(),
      attendees: event.attendees?.length || 0,
      verified: !!verified
    });

    return {
      uid: serverUid,
      calendarId,
      ...event,
      verified: !!verified,
      href: `/remote.php/dav/calendars/${this.username}/${calendarId}/${serverUid}.ics`
    };
  }

  /**
   * Update an existing event
   */
  async updateEvent(calendarId, uid, updates, etag = null) {
    // Always fetch fresh to get current ETag + state (caller's ETag may be stale
    // from a REPORT query — RSVP replies can change the event between fetch and write)
    const current = await this.getEvent(calendarId, uid);
    if (!current) {
      throw new Error(`Event not found: ${uid}`);
    }

    // Merge updates
    const updated = {
      ...current,
      ...updates,
      uid,
      modified: new Date()
    };

    const ics = this._buildICS(updated);
    const freshEtag = current.etag;

    const headers = {
      'Content-Type': 'text/calendar; charset=utf-8'
    };
    if (freshEtag) {
      headers['If-Match'] = this._formatETag(freshEtag);
    }

    let response = await this._request(
      'PUT',
      `/remote.php/dav/calendars/${this.username}/${calendarId}/${uid}.ics`,
      { body: ics, headers }
    );

    // Retry once on 412 Precondition Failed (ETag race from RSVP reply)
    if (response.status === 412) {
      const retry = await this.getEvent(calendarId, uid);
      if (retry) {
        const retryUpdated = { ...retry, ...updates, uid, modified: new Date() };
        const retryIcs = this._buildICS(retryUpdated);
        const retryHeaders = { 'Content-Type': 'text/calendar; charset=utf-8' };
        if (retry.etag) {
          retryHeaders['If-Match'] = this._formatETag(retry.etag);
        }
        response = await this._request(
          'PUT',
          `/remote.php/dav/calendars/${this.username}/${calendarId}/${uid}.ics`,
          { body: retryIcs, headers: retryHeaders }
        );
      }
    }

    if (response.status !== 204 && response.status !== 200) {
      throw new Error(`Failed to update event: ${response.status}`);
    }

    await this.auditLog('caldav_event_updated', {
      calendar: calendarId,
      uid,
      updates: Object.keys(updates)
    });

    return updated;
  }

  /**
   * Delete an event
   */
  async deleteEvent(calendarId, uid, etag = null) {
    // Always fetch fresh ETag before DELETE (caller's ETag may be stale)
    let freshEtag = etag;
    try {
      const current = await this.getEvent(calendarId, uid);
      if (current && current.etag) {
        freshEtag = current.etag;
      }
    } catch {
      // Use caller's ETag as fallback
    }

    const headers = {};
    if (freshEtag) {
      headers['If-Match'] = this._formatETag(freshEtag);
    }

    let response = await this._request(
      'DELETE',
      `/remote.php/dav/calendars/${this.username}/${calendarId}/${uid}.ics`,
      { headers }
    );

    // Retry once on 412 (ETag race from RSVP reply)
    if (response.status === 412) {
      try {
        const retry = await this.getEvent(calendarId, uid);
        const retryHeaders = {};
        if (retry && retry.etag) {
          retryHeaders['If-Match'] = this._formatETag(retry.etag);
        }
        response = await this._request(
          'DELETE',
          `/remote.php/dav/calendars/${this.username}/${calendarId}/${uid}.ics`,
          { headers: retryHeaders }
        );
      } catch {
        // Retry failed, throw original error below
      }
    }

    if (response.status !== 204 && response.status !== 200) {
      throw new Error(`Failed to delete event: ${response.status}`);
    }

    await this.auditLog('caldav_event_deleted', { calendar: calendarId, uid });

    return true;
  }

  // ============================================================
  // Scheduling & Invitations
  // ============================================================

  /**
   * Schedule a meeting with attendees (sends invitations)
   * @param {Object} meeting - Meeting details
   * @param {string} meeting.summary - Meeting title
   * @param {Date} meeting.start - Start time
   * @param {Date} meeting.end - End time
   * @param {Array<string>} meeting.attendees - Attendee email addresses
   * @param {string} [meeting.description] - Description
   * @param {string} [meeting.location] - Location
   * @param {string} [meeting.organizerEmail] - Organizer email (required for invitations)
   */
  async scheduleMeeting(meeting) {
    if (!meeting.attendees || meeting.attendees.length === 0) {
      throw new Error('Meeting must have at least one attendee');
    }

    if (!meeting.organizerEmail) {
      throw new Error('Organizer email is required for sending invitations');
    }

    // Create event with attendees - Nextcloud will send invitations
    const event = await this.createEvent({
      ...meeting,
      sequence: 0,
      status: 'CONFIRMED',
      organizer: {
        email: meeting.organizerEmail,
        name: meeting.organizerName || this.username
      }
    });

    await this.auditLog('caldav_meeting_scheduled', {
      uid: event.uid,
      summary: meeting.summary,
      attendees: meeting.attendees,
      organizer: meeting.organizerEmail
    });

    return event;
  }

  /**
   * Cancel a meeting (sends cancellation notices)
   */
  async cancelMeeting(calendarId, uid, reason = null) {
    const event = await this.getEvent(calendarId, uid);
    if (!event) {
      throw new Error(`Event not found: ${uid}`);
    }

    // Update status to CANCELLED
    await this.updateEvent(calendarId, uid, {
      status: 'CANCELLED',
      sequence: (event.sequence || 0) + 1
    });

    await this.auditLog('caldav_meeting_cancelled', {
      calendar: calendarId,
      uid,
      reason
    });

    return true;
  }

  /**
   * Respond to a meeting invitation by creating/updating calendar event
   *
   * When we receive a meeting invitation via email, we need to:
   * - ACCEPTED: Create the event on our calendar
   * - DECLINED: No calendar change (just email response)
   * - TENTATIVE: Create event marked as tentative
   *
   * @param {Object} meetingInfo - Meeting details from email
   * @param {string} meetingInfo.summary - Meeting title/topic
   * @param {Date|string} meetingInfo.start - Meeting start time
   * @param {Date|string} meetingInfo.end - Meeting end time
   * @param {string} [meetingInfo.location] - Meeting location
   * @param {string} [meetingInfo.description] - Meeting description
   * @param {string} meetingInfo.organizerEmail - Email of meeting organizer
   * @param {string} meetingInfo.organizerName - Name of meeting organizer
   * @param {string} response - Response type: 'ACCEPTED', 'DECLINED', or 'TENTATIVE'
   * @param {string} [calendarId] - Target calendar (defaults to personal)
   * @returns {Promise<Object>} Result with created event or decline confirmation
   */
  async respondToMeeting(meetingInfo, response, calendarId = null) {
    const targetCalendar = calendarId || this.defaultCalendar;
    const normalizedResponse = response.toUpperCase();

    // Validate response type
    if (!['ACCEPTED', 'DECLINED', 'TENTATIVE'].includes(normalizedResponse)) {
      throw new Error(`Invalid response type: ${response}. Must be ACCEPTED, DECLINED, or TENTATIVE`);
    }

    // For DECLINED, we don't create any calendar event
    if (normalizedResponse === 'DECLINED') {
      await this.auditLog('caldav_meeting_declined', {
        summary: meetingInfo.summary,
        organizer: meetingInfo.organizerEmail,
        proposed_time: meetingInfo.start
      });

      return {
        success: true,
        action: 'declined',
        message: 'Meeting declined - no calendar entry created'
      };
    }

    // For ACCEPTED or TENTATIVE, create the event on our calendar
    const start = new Date(meetingInfo.start);
    const end = meetingInfo.end
      ? new Date(meetingInfo.end)
      : new Date(start.getTime() + (meetingInfo.durationMinutes || 60) * 60 * 1000);

    // Build event with organizer info
    const eventData = {
      summary: meetingInfo.summary || 'Meeting',
      start,
      end,
      location: meetingInfo.location || null,
      description: meetingInfo.description || `Meeting with ${meetingInfo.organizerName || meetingInfo.organizerEmail}`,
      status: normalizedResponse === 'TENTATIVE' ? 'TENTATIVE' : 'CONFIRMED',
      calendarId: targetCalendar,
      // Store organizer info in the event
      organizer: {
        email: meetingInfo.organizerEmail,
        name: meetingInfo.organizerName || null
      },
      // Mark ourselves as an attendee with our response status
      attendees: meetingInfo.attendees || []
    };

    try {
      const event = await this.createEvent(eventData);

      await this.auditLog('caldav_meeting_response', {
        response: normalizedResponse,
        calendar: targetCalendar,
        uid: event.uid,
        summary: meetingInfo.summary,
        organizer: meetingInfo.organizerEmail,
        start: start.toISOString()
      });

      return {
        success: true,
        action: normalizedResponse.toLowerCase(),
        event,
        message: normalizedResponse === 'TENTATIVE'
          ? `Meeting added to calendar as tentative: ${meetingInfo.summary}`
          : `Meeting added to calendar: ${meetingInfo.summary}`
      };
    } catch (error) {
      console.error('[CalDAV] Failed to create meeting event:', error.message);
      throw new Error(`Failed to add meeting to calendar: ${error.message}`);
    }
  }

  // ============================================================
  // Free/Busy & Availability
  // ============================================================

  /**
   * Check if a time slot is free
   * @param {Date} start - Start time
   * @param {Date} end - End time
   * @param {string} [calendarId] - Specific calendar (null = all calendars)
   * @returns {Promise<Object>} Availability info
   */
  async checkAvailability(start, end, calendarId = null) {
    const events = calendarId
      ? await this.getEvents(calendarId, start, end)
      : await this.getUpcomingEvents(
          Math.ceil((end - start) / (1000 * 60 * 60)),
          null
        ).then(events => events.filter(e =>
          new Date(e.start) < end && new Date(e.end) > start
        ));

    const conflicts = events.filter(e => {
      const eventStart = new Date(e.start);
      const eventEnd = new Date(e.end);
      return eventStart < end && eventEnd > start;
    });

    return {
      isFree: conflicts.length === 0,
      conflicts: conflicts.map(e => ({
        uid: e.uid,
        summary: e.summary,
        start: e.start,
        end: e.end
      }))
    };
  }

  /**
   * Find free slots in a time range
   * @param {Date} rangeStart - Start of search range
   * @param {Date} rangeEnd - End of search range
   * @param {number} durationMinutes - Required slot duration
   * @param {Object} [options] - Options
   * @param {number} [options.workdayStart=9] - Workday start hour
   * @param {number} [options.workdayEnd=17] - Workday end hour
   * @param {boolean} [options.excludeWeekends=true] - Exclude weekends
   * @returns {Promise<Array>} List of free slots
   */
  async findFreeSlots(rangeStart, rangeEnd, durationMinutes, options = {}) {
    const {
      workdayStart = 9,
      workdayEnd = 17,
      excludeWeekends = true
    } = options;

    // Get all events in range
    const events = await this.getUpcomingEvents(
      Math.ceil((rangeEnd - rangeStart) / (1000 * 60 * 60))
    );

    // Build busy periods
    const busyPeriods = events.map(e => ({
      start: new Date(e.start),
      end: new Date(e.end)
    })).sort((a, b) => a.start - b.start);

    const freeSlots = [];
    const slotDuration = durationMinutes * 60 * 1000;

    // Iterate through the range day by day
    const current = new Date(rangeStart);
    current.setHours(workdayStart, 0, 0, 0);

    while (current < rangeEnd) {
      const dayOfWeek = current.getDay();

      // Skip weekends if requested
      if (excludeWeekends && (dayOfWeek === 0 || dayOfWeek === 6)) {
        current.setDate(current.getDate() + 1);
        current.setHours(workdayStart, 0, 0, 0);
        continue;
      }

      // Set day boundaries
      const dayStart = new Date(current);
      dayStart.setHours(workdayStart, 0, 0, 0);
      const dayEnd = new Date(current);
      dayEnd.setHours(workdayEnd, 0, 0, 0);

      // Find free slots in this day
      let slotStart = new Date(Math.max(dayStart.getTime(), rangeStart.getTime()));

      // Get busy periods for this day
      const dayBusy = busyPeriods.filter(p =>
        p.start < dayEnd && p.end > dayStart
      );

      for (const busy of dayBusy) {
        // Check if there's a free slot before this busy period
        if (busy.start.getTime() - slotStart.getTime() >= slotDuration) {
          freeSlots.push({
            start: new Date(slotStart),
            end: new Date(busy.start),
            durationMinutes: Math.floor((busy.start - slotStart) / 60000)
          });
        }
        // Move slot start to after this busy period
        slotStart = new Date(Math.max(slotStart.getTime(), busy.end.getTime()));
      }

      // Check for free slot at end of day
      const effectiveDayEnd = new Date(Math.min(dayEnd.getTime(), rangeEnd.getTime()));
      if (effectiveDayEnd.getTime() - slotStart.getTime() >= slotDuration) {
        freeSlots.push({
          start: new Date(slotStart),
          end: effectiveDayEnd,
          durationMinutes: Math.floor((effectiveDayEnd - slotStart) / 60000)
        });
      }

      // Move to next day
      current.setDate(current.getDate() + 1);
      current.setHours(workdayStart, 0, 0, 0);
    }

    return freeSlots;
  }

  /**
   * Simple availability check: "Am I free at X time?"
   */
  async amIFreeAt(dateTime) {
    const start = new Date(dateTime);
    const end = new Date(start.getTime() + 60 * 60 * 1000); // 1 hour window
    const availability = await this.checkAvailability(start, end);
    return availability.isFree;
  }

  // ============================================================
  // ICS Parsing & Building
  // ============================================================

  /**
   * Parse ICS data into an event object
   */
  _parseICS(icsData, href = null, etag = null) {
    const event = { href, etag, raw: icsData };

    // Extract UID
    const uidMatch = /UID:([^\r\n]+)/i.exec(icsData);
    event.uid = uidMatch ? uidMatch[1] : null;

    // Extract SUMMARY
    const summaryMatch = /SUMMARY:([^\r\n]+)/i.exec(icsData);
    event.summary = summaryMatch ? this._unescapeICS(summaryMatch[1]) : null;

    // Extract DESCRIPTION
    const descMatch = /DESCRIPTION:([^\r\n]+(?:\r?\n [^\r\n]+)*)/i.exec(icsData);
    event.description = descMatch ? this._unescapeICS(descMatch[1].replace(/\r?\n /g, '')) : null;

    // Extract LOCATION
    const locMatch = /LOCATION:([^\r\n]+)/i.exec(icsData);
    event.location = locMatch ? this._unescapeICS(locMatch[1]) : null;

    // Extract DTSTART
    const startMatch = /DTSTART[^:]*:([^\r\n]+)/i.exec(icsData);
    event.start = startMatch ? this._parseICSDateTime(startMatch[1]) : null;
    event.allDay = startMatch && startMatch[0].includes('VALUE=DATE') && !startMatch[0].includes('VALUE=DATE-TIME');

    // Extract DTEND
    const endMatch = /DTEND[^:]*:([^\r\n]+)/i.exec(icsData);
    event.end = endMatch ? this._parseICSDateTime(endMatch[1]) : null;

    // Extract STATUS
    const statusMatch = /STATUS:([^\r\n]+)/i.exec(icsData);
    event.status = statusMatch ? statusMatch[1] : 'CONFIRMED';

    // Extract SEQUENCE
    const seqMatch = /SEQUENCE:([^\r\n]+)/i.exec(icsData);
    event.sequence = seqMatch ? parseInt(seqMatch[1]) : 0;

    // Extract ORGANIZER
    const orgMatch = /ORGANIZER[^:]*:([^\r\n]+)/i.exec(icsData);
    if (orgMatch) {
      const cnMatch = /CN=([^;:]+)/i.exec(orgMatch[0]);
      event.organizer = {
        email: orgMatch[1].replace('mailto:', ''),
        name: cnMatch ? cnMatch[1] : null
      };
    }

    // Extract ATTENDEE(s)
    const attendees = [];
    const attendeeRegex = /ATTENDEE[^:]*:([^\r\n]+)/gi;
    let attendeeMatch;
    while ((attendeeMatch = attendeeRegex.exec(icsData)) !== null) {
      const cnMatch = /CN=([^;:]+)/i.exec(attendeeMatch[0]);
      const partstatMatch = /PARTSTAT=([^;:]+)/i.exec(attendeeMatch[0]);
      attendees.push({
        email: attendeeMatch[1].replace('mailto:', ''),
        name: cnMatch ? cnMatch[1] : null,
        status: partstatMatch ? partstatMatch[1] : 'NEEDS-ACTION'
      });
    }
    event.attendees = attendees;

    return event;
  }

  /**
   * Build ICS data from an event object
   */
  _buildICS(event) {
    const hasAttendees = event.attendees && event.attendees.length > 0;

    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Moltagent//CalDAV Client//EN',
      'CALSCALE:GREGORIAN',
      'BEGIN:VEVENT'
    ];

    // Note: METHOD:REQUEST is NOT added here — it belongs in iTIP transport
    // messages (scheduling outbox), not in stored calendar objects. Sabre/dav
    // rejects PUT with METHOD in the body (415). NC auto-detects scheduling
    // when ORGANIZER + ATTENDEE properties are present.

    // UID
    lines.push(`UID:${event.uid}`);

    // Timestamps
    lines.push(`DTSTAMP:${this._formatDateTime(new Date())}`);
    if (event.created) {
      lines.push(`CREATED:${this._formatDateTime(event.created)}`);
    }
    if (event.modified) {
      lines.push(`LAST-MODIFIED:${this._formatDateTime(event.modified)}`);
    }

    // Start/End — use TZID parameter for non-UTC timezones
    if (event.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${this._formatDate(event.start)}`);
      lines.push(`DTEND;VALUE=DATE:${this._formatDate(event.end)}`);
    } else if (this.timezone && this.timezone !== 'UTC') {
      lines.push(`DTSTART;TZID=${this.timezone}:${this._formatDateTimeLocal(event.start)}`);
      lines.push(`DTEND;TZID=${this.timezone}:${this._formatDateTimeLocal(event.end)}`);
    } else {
      lines.push(`DTSTART:${this._formatDateTime(event.start)}`);
      lines.push(`DTEND:${this._formatDateTime(event.end)}`);
    }

    // Summary
    if (event.summary) {
      lines.push(`SUMMARY:${this._escapeICS(event.summary)}`);
    }

    // Description
    if (event.description) {
      lines.push(`DESCRIPTION:${this._escapeICS(event.description)}`);
    }

    // Location
    if (event.location) {
      lines.push(`LOCATION:${this._escapeICS(event.location)}`);
    }

    // Status
    lines.push(`STATUS:${event.status || 'CONFIRMED'}`);

    // Sequence
    lines.push(`SEQUENCE:${event.sequence || 0}`);

    // Organizer — auto-set when attendees present (required for iTIP)
    if (event.organizer) {
      const cn = event.organizer.name ? `;CN=${this._sanitizeICSParam(event.organizer.name)}` : '';
      lines.push(`ORGANIZER${cn}:mailto:${this._sanitizeICSEmail(event.organizer.email)}`);
    } else if (hasAttendees) {
      // Auto-set organizer to Moltagent's identity so NC can send invitations
      const orgEmail = this._organizerEmail || `${this.username}@moltagent`;
      const orgName = this._organizerName || this.username;
      lines.push(`ORGANIZER;CN=${this._sanitizeICSParam(orgName)}:mailto:${this._sanitizeICSEmail(orgEmail)}`);
    }

    // Attendees
    if (event.attendees && event.attendees.length > 0) {
      for (const attendee of event.attendees) {
        const email = this._sanitizeICSEmail(typeof attendee === 'string' ? attendee : attendee.email);
        const name = typeof attendee === 'object' ? attendee.name : null;
        const status = (typeof attendee === 'object' ? attendee.status : null) || 'NEEDS-ACTION';

        let line = 'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT';
        line += `;PARTSTAT=${this._sanitizeICSParam(status)}`;
        line += ';RSVP=TRUE';
        if (name) {
          line += `;CN=${this._sanitizeICSParam(name)}`;
        }
        line += `:mailto:${email}`;
        lines.push(line);
      }
    }

    lines.push('END:VEVENT');
    lines.push('END:VCALENDAR');

    return lines.join('\r\n');
  }

  /**
   * Format a Date as ICS datetime (UTC)
   */
  _formatDateTime(date) {
    const d = new Date(date);
    return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  }

  /**
   * Format a Date as ICS local datetime (no Z suffix) for TZID-qualified fields.
   * Converts UTC date to the configured timezone before formatting.
   */
  _formatDateTimeLocal(date) {
    const d = new Date(date);
    // Use Intl to get local date parts in the configured timezone
    const parts = new Intl.DateTimeFormat('en-GB', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false, timeZone: this.timezone
    }).formatToParts(d);

    const get = (type) => (parts.find(p => p.type === type) || {}).value || '00';
    return `${get('year')}${get('month')}${get('day')}T${get('hour')}${get('minute')}${get('second')}`;
  }

  /**
   * Format a Date as ICS date only
   */
  _formatDate(date) {
    const d = new Date(date);
    return d.toISOString().split('T')[0].replace(/-/g, '');
  }

  /**
   * Parse ICS datetime string
   */
  _parseICSDateTime(str) {
    // Handle date-only format (YYYYMMDD)
    if (str.length === 8) {
      const year = str.substring(0, 4);
      const month = str.substring(4, 6);
      const day = str.substring(6, 8);
      return `${year}-${month}-${day}`;
    }

    // Handle datetime format (YYYYMMDDTHHMMSSZ or YYYYMMDDTHHMMSS)
    const match = /(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?/.exec(str);
    if (match) {
      const [, year, month, day, hour, min, sec] = match;
      return new Date(Date.UTC(
        parseInt(year),
        parseInt(month) - 1,
        parseInt(day),
        parseInt(hour),
        parseInt(min),
        parseInt(sec)
      )).toISOString();
    }

    return str;
  }

  /**
   * Escape special characters for ICS
   */
  _escapeICS(str) {
    return str
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\n/g, '\\n');
  }

  /**
   * Format an ETag value for use in If-Match headers.
   * Ensures proper quoting regardless of whether input has quotes or not.
   */
  _formatETag(etag) {
    if (!etag) return null;
    const stripped = etag.replace(/^"+|"+$/g, '');
    return `"${stripped}"`;
  }

  /**
   * Sanitize a value for use in ICS parameter positions (CN, PARTSTAT, etc.).
   * Strips characters that could inject new properties or lines.
   */
  _sanitizeICSParam(str) {
    if (!str) return '';
    return str.replace(/[\r\n;:]/g, '');
  }

  /**
   * Sanitize an email address for ICS mailto: fields.
   * Strips characters that could inject new lines or properties.
   */
  _sanitizeICSEmail(str) {
    if (!str) return '';
    return str.replace(/[\r\n\s;]/g, '');
  }

  /**
   * Unescape ICS special characters
   */
  _unescapeICS(str) {
    return str
      .replace(/\\n/g, '\n')
      .replace(/\\,/g, ',')
      .replace(/\\;/g, ';')
      .replace(/\\\\/g, '\\');
  }

  /**
   * Generate a unique event UID
   */
  _generateUID() {
    const random = crypto.randomBytes(16).toString('hex');
    const timestamp = Date.now().toString(36);
    return `${timestamp}-${random}@moltagent`;
  }

  // ============================================================
  // Convenience Methods for Moltagent
  // ============================================================

  /**
   * Get a human-readable summary of today's calendar
   */
  async getTodaySummary() {
    const events = await this.getTodayEvents();

    if (events.length === 0) {
      return {
        text: "No events scheduled for today.",
        events: []
      };
    }

    const lines = [`Today's calendar (${events.length} event${events.length > 1 ? 's' : ''}):`];

    for (const event of events) {
      const start = new Date(event.start);
      const timeStr = event.allDay
        ? 'All day'
        : start.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

      lines.push(`• ${timeStr}: ${event.summary}`);
      if (event.location) {
        lines.push(`  📍 ${event.location}`);
      }
    }

    return {
      text: lines.join('\n'),
      events
    };
  }

  /**
   * Quick schedule: "Schedule a meeting with X tomorrow at 2pm"
   */
  async quickSchedule(summary, dateTime, durationMinutes = 60, attendees = []) {
    const start = new Date(dateTime);
    const end = new Date(start.getTime() + durationMinutes * 60 * 1000);

    // Check availability first
    const availability = await this.checkAvailability(start, end);

    if (!availability.isFree) {
      return {
        success: false,
        reason: 'conflict',
        conflicts: availability.conflicts
      };
    }

    const event = await this.createEvent({
      summary,
      start,
      end,
      attendees
    });

    return {
      success: true,
      event
    };
  }
}

module.exports = CalDAVClient;
