# MoltAgent Session 5: Calendar Production-Ready Fix
## Claude Code Implementation Brief

**Date:** 2026-02-06  
**Author:** Fu + Claude Opus (architecture)  
**Executor:** Claude Code  
**Estimated CCode time:** ~2 hours  
**Dependencies:** Phase 1 Security complete, NCRequestManager exists (or needs creation)  
**Spec source:** `moltagent-email-calendar-spec.md`, `nc-resilience-briefing.md`

---

## Context

The CalDAV client exists and passes protocol-level tests (18/18), but it's not production-ready:

1. **No NCRequestManager integration** — Uses raw `tsdav` HTTP calls, doesn't respect rate limits or backoff
2. **No SecurityInterceptor hooks** — Calendar operations bypass the security layer entirely
3. **No error handling** — Network failures, auth errors, and NC downtime crash the agent
4. **No credential broker** — Hardcoded credentials instead of runtime brokering via NC Passwords
5. **Missing business logic** — CalendarHandler exists in spec but may not be implemented

**Goal:** Make calendar work reliably in production. A concierge client paying €399-799 expects "What's on my calendar today?" to Just Work™.

**AGPL-3.0 license header for every new file:**

```javascript
/*
 * MoltAgent - Sovereign AI Security Layer
 * Copyright (C) 2026 MoltAgent Contributors
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
```

---

## Pre-Session Discovery

**IMPORTANT:** Before building, Claude Code needs to discover the current state:

```bash
# 1. Check what calendar files exist
find /opt/moltagent -name "*caldav*" -o -name "*calendar*" 2>/dev/null

# 2. Check the current caldav-client.js
cat /opt/moltagent/src/lib/integrations/caldav-client.js | head -100

# 3. Check if NCRequestManager exists
ls -la /opt/moltagent/src/lib/nc-request-manager.js 2>/dev/null || echo "NCRequestManager not found"

# 4. Check if calendar-handler.js exists
ls -la /opt/moltagent/src/lib/calendar/calendar-handler.js 2>/dev/null || echo "CalendarHandler not found"

# 5. Check package.json for tsdav version
grep -A2 "tsdav" /opt/moltagent/package.json

# 6. Check current heartbeat integration
grep -n "calendar\|caldav" /opt/moltagent/src/lib/heartbeat-manager.js 2>/dev/null | head -20
```

Based on findings, adjust the implementation plan below.

---

## Deliverables

| # | File | Est. Time | What It Does |
|---|------|-----------|-------------|
| 1 | Refactor `caldav-client.js` | 45 min | Add NCRequestManager integration, credential brokering, error handling |
| 2 | Create/update `calendar-handler.js` | 30 min | Business logic layer with SecurityInterceptor hooks |
| 3 | `test/calendar/caldav-client.test.js` | 20 min | Unit tests with mocked NC |
| 4 | `test/calendar/calendar-handler.test.js` | 15 min | Handler tests |
| 5 | Update heartbeat integration | 15 min | Calendar awareness in heartbeat cycle |
| 6 | Integration test | 10 min | End-to-end calendar flow |

---

## 1. CalDAV Client Refactor

**File:** `src/lib/calendar/caldav-client.js`

### Current Problems

The existing client likely has:
```javascript
// PROBLEM: Direct tsdav usage without rate limiting
this.client = new DAVClient({
  serverUrl: config.ncUrl,
  credentials: { username: config.username, password: config.password },
  authMethod: 'Basic',
  defaultAccountType: 'caldav',
});
```

### Solution: NCRequestManager Integration

The `tsdav` library supports a custom `fetchFn` parameter. We inject our rate-limited fetch:

```javascript
const { DAVClient } = require('tsdav');
const ICAL = require('ical.js');
const { v4: uuidv4 } = require('uuid');

class CalDAVClient {
  /**
   * @param {Object} options
   * @param {Object} options.ncRequestManager - NCRequestManager instance
   * @param {Object} options.credentialBroker - CredentialBroker instance
   * @param {Object} options.config - Configuration
   * @param {string} options.config.ncUrl - Nextcloud URL
   * @param {Object} [options.auditLog] - Audit logger
   */
  constructor({ ncRequestManager, credentialBroker, config, auditLog }) {
    this.nc = ncRequestManager;
    this.credentials = credentialBroker;
    this.config = config;
    this.auditLog = auditLog;
    this.client = null;
    this.calendars = [];
    this.connected = false;
  }

  /**
   * Connect to CalDAV server using runtime credentials.
   * @returns {Promise<boolean>}
   */
  async connect() {
    if (this.connected && this.client) {
      return true;
    }

    return this.credentials.withCredential('caldav-access', async (cred) => {
      // Create DAVClient with custom fetchFn that routes through NCRequestManager
      this.client = new DAVClient({
        serverUrl: `${this.config.ncUrl}/remote.php/dav`,
        credentials: {
          username: cred.username,
          password: cred.password,
        },
        authMethod: 'Basic',
        defaultAccountType: 'caldav',
        // CRITICAL: Route all HTTP through NCRequestManager for rate limiting
        fetchFn: async (url, init) => {
          return this.nc.request(url, {
            ...init,
            group: 'caldav',  // Use caldav rate limit group
          });
        },
      });

      try {
        await this.client.login();
        this.calendars = await this.client.fetchCalendars();
        this.connected = true;

        if (this.auditLog) {
          await this.auditLog.log('caldav_connected', {
            calendars: this.calendars.length,
          });
        }

        return true;
      } catch (error) {
        this.connected = false;
        throw new CalDAVError('Connection failed', error);
      }
    });
  }

  /**
   * Ensure connected before operations.
   * @private
   */
  async ensureConnected() {
    if (!this.connected) {
      await this.connect();
    }
  }

  /**
   * Get list of available calendars.
   * @returns {Promise<Array<{id, name, color, writable, isDefault}>>}
   */
  async getCalendars() {
    await this.ensureConnected();

    return this.calendars.map(cal => ({
      id: cal.url,
      name: cal.displayName,
      color: cal.calendarColor,
      description: cal.calendarDescription,
      writable: !cal.readOnly,
      isDefault: cal.url.includes('/personal/'),
    }));
  }

  /**
   * Get events within a date range.
   * @param {Object} options
   * @param {string} [options.calendarId] - Specific calendar, or null for all
   * @param {Date} options.start - Range start
   * @param {Date} [options.end] - Range end (default: 7 days from start)
   * @returns {Promise<Array>}
   */
  async getEvents({ calendarId = null, start = new Date(), end = null } = {}) {
    await this.ensureConnected();

    const endDate = end || new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);

    const calendarsToSearch = calendarId
      ? this.calendars.filter(c => c.url === calendarId)
      : this.calendars.filter(c => !c.url.includes('/inbox/') && !c.url.includes('/outbox/'));

    const allEvents = [];

    for (const calendar of calendarsToSearch) {
      try {
        const events = await this.client.fetchCalendarObjects({
          calendar,
          timeRange: {
            start: start.toISOString(),
            end: endDate.toISOString(),
          },
        });

        for (const event of events) {
          const parsed = this.parseEvent(event, calendar);
          if (parsed) {
            allEvents.push(parsed);
          }
        }
      } catch (error) {
        // Log but continue with other calendars
        console.error(`Error fetching from ${calendar.displayName}:`, error.message);
      }
    }

    // Sort by start time
    allEvents.sort((a, b) => new Date(a.start) - new Date(b.start));

    return allEvents;
  }

  /**
   * Get today's events.
   */
  async getTodayEvents() {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date();
    end.setHours(23, 59, 59, 999);
    return this.getEvents({ start, end });
  }

  /**
   * Get tomorrow's events.
   */
  async getTomorrowEvents() {
    const start = new Date();
    start.setDate(start.getDate() + 1);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setHours(23, 59, 59, 999);
    return this.getEvents({ start, end });
  }

  /**
   * Get upcoming events for N days.
   */
  async getUpcomingEvents(days = 7) {
    const start = new Date();
    const end = new Date(start.getTime() + days * 24 * 60 * 60 * 1000);
    return this.getEvents({ start, end });
  }

  /**
   * Create a new event.
   * @param {Object} eventData
   * @param {string} eventData.title - Event title
   * @param {Date} eventData.start - Start time
   * @param {Date} eventData.end - End time
   * @param {string} [eventData.description] - Description
   * @param {string} [eventData.location] - Location
   * @param {string} [eventData.calendarId] - Target calendar (default: personal)
   * @returns {Promise<{success, event, uid}>}
   */
  async createEvent(eventData) {
    await this.ensureConnected();

    const calendar = eventData.calendarId
      ? this.calendars.find(c => c.url === eventData.calendarId)
      : this.calendars.find(c => c.url.includes('/personal/')) || this.calendars[0];

    if (!calendar) {
      throw new CalDAVError('No writable calendar found');
    }

    const uid = `${uuidv4()}@moltagent`;
    const icsData = this.buildICS({ ...eventData, uid });

    try {
      await this.client.createCalendarObject({
        calendar,
        filename: `${uid}.ics`,
        iCalString: icsData,
      });

      if (this.auditLog) {
        await this.auditLog.log('caldav_event_created', {
          uid,
          title: eventData.title,
          start: eventData.start.toISOString(),
        });
      }

      return { success: true, uid, event: eventData };
    } catch (error) {
      throw new CalDAVError('Failed to create event', error);
    }
  }

  /**
   * Update an existing event.
   */
  async updateEvent(uid, updates) {
    await this.ensureConnected();

    const event = await this.findEventByUid(uid);
    if (!event) {
      throw new CalDAVError(`Event not found: ${uid}`);
    }

    // Merge updates
    const updated = { ...event, ...updates, uid };
    const icsData = this.buildICS(updated);

    try {
      await this.client.updateCalendarObject({
        calendarObject: event._raw,
        iCalString: icsData,
      });

      if (this.auditLog) {
        await this.auditLog.log('caldav_event_updated', { uid, updates });
      }

      return { success: true, event: updated };
    } catch (error) {
      throw new CalDAVError('Failed to update event', error);
    }
  }

  /**
   * Delete an event.
   */
  async deleteEvent(uid) {
    await this.ensureConnected();

    const event = await this.findEventByUid(uid);
    if (!event) {
      throw new CalDAVError(`Event not found: ${uid}`);
    }

    try {
      await this.client.deleteCalendarObject({
        calendarObject: event._raw,
      });

      if (this.auditLog) {
        await this.auditLog.log('caldav_event_deleted', { uid });
      }

      return { success: true };
    } catch (error) {
      throw new CalDAVError('Failed to delete event', error);
    }
  }

  /**
   * Check for conflicts at a given time.
   */
  async checkConflicts(start, end) {
    const events = await this.getEvents({ start, end });
    return events.filter(e => {
      const eStart = new Date(e.start);
      const eEnd = new Date(e.end);
      return eStart < end && eEnd > start;
    });
  }

  /**
   * Find free time slots.
   */
  async findFreeSlots({ duration = 60, startDate = new Date(), endDate = null, workingHoursStart = 9, workingHoursEnd = 17 }) {
    const searchEnd = endDate || new Date(startDate.getTime() + 7 * 24 * 60 * 60 * 1000);
    const events = await this.getEvents({ start: startDate, end: searchEnd });

    const slots = [];
    const durationMs = duration * 60 * 1000;

    let current = new Date(startDate);
    current.setHours(workingHoursStart, 0, 0, 0);

    while (current < searchEnd && slots.length < 10) {
      const slotEnd = new Date(current.getTime() + durationMs);

      // Skip non-working hours
      if (current.getHours() < workingHoursStart) {
        current.setHours(workingHoursStart, 0, 0, 0);
        continue;
      }
      if (current.getHours() >= workingHoursEnd) {
        current.setDate(current.getDate() + 1);
        current.setHours(workingHoursStart, 0, 0, 0);
        continue;
      }

      // Skip weekends
      if (current.getDay() === 0 || current.getDay() === 6) {
        current.setDate(current.getDate() + 1);
        current.setHours(workingHoursStart, 0, 0, 0);
        continue;
      }

      // Check for conflicts
      const conflicts = events.filter(e => {
        const eStart = new Date(e.start);
        const eEnd = new Date(e.end);
        return eStart < slotEnd && eEnd > current;
      });

      if (conflicts.length === 0) {
        slots.push({ start: new Date(current), end: new Date(slotEnd) });
      }

      current = new Date(current.getTime() + 30 * 60 * 1000); // 30 min increments
    }

    return slots;
  }

  /**
   * Get a human-readable summary of today's calendar.
   */
  async getTodaySummary() {
    const events = await this.getTodayEvents();

    if (events.length === 0) {
      return '📅 Your calendar is clear today!';
    }

    const lines = [`📅 **Today's calendar** (${events.length} event${events.length !== 1 ? 's' : ''}):\n`];

    for (const event of events) {
      const timeStr = event.allDay
        ? 'All day'
        : `${this.formatTime(event.start)} - ${this.formatTime(event.end)}`;
      lines.push(`• **${event.title}** — ${timeStr}`);
      if (event.location) {
        lines.push(`  📍 ${event.location}`);
      }
    }

    return lines.join('\n');
  }

  // ─────────────────────────────────────────────────────────────────
  // Private Helpers
  // ─────────────────────────────────────────────────────────────────

  /**
   * Parse a CalDAV object into a normalized event.
   * @private
   */
  parseEvent(calObject, calendar) {
    try {
      const jcal = ICAL.parse(calObject.data);
      const comp = new ICAL.Component(jcal);
      const vevent = comp.getFirstSubcomponent('vevent');

      if (!vevent) return null;

      const event = new ICAL.Event(vevent);

      return {
        uid: event.uid,
        title: event.summary || '(No title)',
        description: event.description || '',
        location: event.location || '',
        start: event.startDate?.toJSDate() || null,
        end: event.endDate?.toJSDate() || null,
        allDay: event.startDate?.isDate || false,
        calendar: calendar.displayName,
        calendarId: calendar.url,
        _raw: calObject,  // Keep for updates/deletes
      };
    } catch (error) {
      console.error('Failed to parse event:', error.message);
      return null;
    }
  }

  /**
   * Build ICS data from an event object.
   * NOTE: METHOD property is NOT included — CalDAV stored events must not have METHOD.
   * @private
   */
  buildICS(event) {
    const formatDate = (date) => {
      return date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    };

    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//MoltAgent//CalDAV Client//EN',
      'CALSCALE:GREGORIAN',
      'BEGIN:VEVENT',
      `UID:${event.uid}`,
      `DTSTAMP:${formatDate(new Date())}`,
      `DTSTART:${formatDate(new Date(event.start))}`,
      `DTEND:${formatDate(new Date(event.end))}`,
      `SUMMARY:${this.escapeICS(event.title)}`,
    ];

    if (event.description) {
      lines.push(`DESCRIPTION:${this.escapeICS(event.description)}`);
    }
    if (event.location) {
      lines.push(`LOCATION:${this.escapeICS(event.location)}`);
    }

    lines.push('END:VEVENT', 'END:VCALENDAR');

    return lines.join('\r\n');
  }

  /**
   * Escape text for ICS format.
   * @private
   */
  escapeICS(text) {
    return text
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\n/g, '\\n');
  }

  /**
   * Find an event by UID.
   * @private
   */
  async findEventByUid(uid) {
    const events = await this.getUpcomingEvents(90); // Search 90 days
    return events.find(e => e.uid === uid);
  }

  /**
   * Format time for display.
   * @private
   */
  formatTime(date) {
    const d = new Date(date);
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  /**
   * Disconnect and cleanup.
   */
  async disconnect() {
    this.client = null;
    this.calendars = [];
    this.connected = false;
  }
}

/**
 * Custom error class for CalDAV operations.
 */
class CalDAVError extends Error {
  constructor(message, cause = null) {
    super(message);
    this.name = 'CalDAVError';
    this.cause = cause;
  }
}

module.exports = { CalDAVClient, CalDAVError };
```

---

## 2. Calendar Handler (Business Logic)

**File:** `src/lib/calendar/calendar-handler.js`

This layer sits between the message router and CalDAVClient. It:
- Integrates with SecurityInterceptor for operation approval
- Handles confirmation flows (create/update/delete require human confirmation)
- Formats responses for NC Talk

```javascript
const { CalDAVClient, CalDAVError } = require('./caldav-client');

class CalendarHandler {
  /**
   * @param {Object} options
   * @param {CalDAVClient} options.caldav - CalDAV client instance
   * @param {SecurityInterceptor} options.security - Security interceptor
   * @param {SessionManager} options.sessionManager - Session manager
   */
  constructor({ caldav, security, sessionManager }) {
    this.caldav = caldav;
    this.security = security;
    this.sessions = sessionManager;
  }

  /**
   * Handle a calendar request.
   * @param {string} action - Action to perform
   * @param {Object} params - Action parameters
   * @param {Object} context - Request context (roomToken, userId)
   * @returns {Promise<{success, message, requiresConfirmation?, pendingAction?}>}
   */
  async handle(action, params, context) {
    // Run through security interceptor
    const preCheck = await this.security.beforeExecute(`calendar_${action}`, params, context);

    if (!preCheck.proceed) {
      if (preCheck.approvalRequired) {
        return {
          success: false,
          requiresConfirmation: true,
          message: preCheck.approvalPrompt,
        };
      }
      return {
        success: false,
        message: `⚠️ Blocked: ${preCheck.reason}`,
      };
    }

    try {
      switch (action) {
        case 'query_today':
          return this.handleQueryToday(context);

        case 'query_tomorrow':
          return this.handleQueryTomorrow(context);

        case 'query_upcoming':
          return this.handleQueryUpcoming(params.days || 7, context);

        case 'create_event':
          return this.handleCreateEvent(params, context);

        case 'update_event':
          return this.handleUpdateEvent(params, context);

        case 'delete_event':
          return this.handleDeleteEvent(params, context);

        case 'find_free_time':
          return this.handleFindFreeTime(params, context);

        case 'check_conflicts':
          return this.handleCheckConflicts(params, context);

        default:
          return {
            success: false,
            message: "I don't recognize that calendar action. Try:\n" +
              "• 'What's on my calendar today?'\n" +
              "• 'Schedule a meeting tomorrow at 2pm'\n" +
              "• 'Find a free slot this week'",
          };
      }
    } catch (error) {
      if (error instanceof CalDAVError) {
        return {
          success: false,
          message: `📅 Calendar error: ${error.message}`,
        };
      }
      throw error;
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Query Handlers
  // ─────────────────────────────────────────────────────────────────

  async handleQueryToday(context) {
    const summary = await this.caldav.getTodaySummary();
    return { success: true, message: summary };
  }

  async handleQueryTomorrow(context) {
    const events = await this.caldav.getTomorrowEvents();

    if (events.length === 0) {
      return { success: true, message: '📅 Your calendar is clear tomorrow!' };
    }

    return {
      success: true,
      message: this.formatEventList(events, 'Tomorrow'),
    };
  }

  async handleQueryUpcoming(days, context) {
    const events = await this.caldav.getUpcomingEvents(days);

    if (events.length === 0) {
      return { success: true, message: `📅 No events in the next ${days} days.` };
    }

    return {
      success: true,
      message: this.formatEventList(events, `Next ${days} days`),
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // Modification Handlers (require confirmation)
  // ─────────────────────────────────────────────────────────────────

  async handleCreateEvent(params, context) {
    // Check for conflicts
    const conflicts = await this.caldav.checkConflicts(
      new Date(params.start),
      new Date(params.end)
    );

    let conflictWarning = '';
    if (conflicts.length > 0) {
      conflictWarning = '\n\n⚠️ **Conflicts:**\n' +
        conflicts.map(c => `• ${this.formatTime(c.start)} - ${c.title}`).join('\n');
    }

    const preview = this.formatEventPreview(params);

    return {
      success: true,
      requiresConfirmation: true,
      confirmationType: 'calendar_create',
      pendingAction: { action: 'create_event', data: params },
      message: `📅 Create this event?${conflictWarning}\n\n${preview}\n\n` +
        `Reply **yes** to confirm or **no** to cancel.`,
    };
  }

  async confirmCreateEvent(params, context) {
    const result = await this.caldav.createEvent(params);

    // Add to session context
    const session = this.sessions.getSession(context.roomToken, context.userId);
    this.sessions.addContext(session, 'assistant', `Created event: ${params.title}`);

    return {
      success: true,
      message: `✅ Event created!\n\n` +
        `**${params.title}**\n` +
        `📆 ${this.formatDate(params.start)}\n` +
        `🕐 ${this.formatTime(params.start)} - ${this.formatTime(params.end)}` +
        (params.location ? `\n📍 ${params.location}` : ''),
    };
  }

  async handleDeleteEvent(params, context) {
    const events = await this.caldav.getUpcomingEvents(30);
    const event = events.find(e =>
      e.title.toLowerCase().includes(params.title?.toLowerCase() || '') ||
      e.uid === params.uid
    );

    if (!event) {
      return {
        success: false,
        message: `❌ Couldn't find an event matching "${params.title}".`,
      };
    }

    return {
      success: true,
      requiresConfirmation: true,
      confirmationType: 'calendar_delete',
      pendingAction: { action: 'delete_event', uid: event.uid },
      message: `🗑️ Delete this event?\n\n` +
        `**${event.title}**\n` +
        `📆 ${this.formatDate(event.start)}\n\n` +
        `Reply **yes** to delete or **no** to keep it.`,
    };
  }

  async confirmDeleteEvent(uid, context) {
    await this.caldav.deleteEvent(uid);
    return { success: true, message: '✅ Event deleted.' };
  }

  // ─────────────────────────────────────────────────────────────────
  // Free Time / Conflicts
  // ─────────────────────────────────────────────────────────────────

  async handleFindFreeTime(params, context) {
    const slots = await this.caldav.findFreeSlots({
      duration: params.duration || 60,
      startDate: params.startDate ? new Date(params.startDate) : new Date(),
    });

    if (slots.length === 0) {
      return {
        success: true,
        message: `😅 Couldn't find any free ${params.duration || 60}-minute slots. ` +
          `Your calendar looks full! Want me to search further out?`,
      };
    }

    const formatted = slots.slice(0, 5).map((slot, i) =>
      `${i + 1}. **${this.formatDate(slot.start)}** at ${this.formatTime(slot.start)}`
    ).join('\n');

    return {
      success: true,
      message: `🔍 Found these free slots:\n\n${formatted}\n\n` +
        `Which one works? Or tell me a different time.`,
    };
  }

  async handleCheckConflicts(params, context) {
    const conflicts = await this.caldav.checkConflicts(
      new Date(params.start),
      new Date(params.end)
    );

    if (conflicts.length === 0) {
      return { success: true, message: '✅ No conflicts! That time is free.' };
    }

    const formatted = conflicts.map(c =>
      `• **${c.title}** (${this.formatTime(c.start)} - ${this.formatTime(c.end)})`
    ).join('\n');

    return {
      success: true,
      message: `⚠️ Found ${conflicts.length} conflict(s):\n\n${formatted}`,
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // Formatting Helpers
  // ─────────────────────────────────────────────────────────────────

  formatEventList(events, label) {
    const lines = [`📅 **${label}** (${events.length} event${events.length !== 1 ? 's' : ''}):\n`];

    for (const event of events) {
      const time = event.allDay
        ? 'All day'
        : `${this.formatTime(event.start)} - ${this.formatTime(event.end)}`;
      lines.push(`• **${event.title}** — ${time}`);
      if (event.location) {
        lines.push(`  📍 ${event.location}`);
      }
    }

    return lines.join('\n');
  }

  formatEventPreview(event) {
    return `**${event.title}**\n` +
      `📆 ${this.formatDate(event.start)}\n` +
      `🕐 ${this.formatTime(event.start)} - ${this.formatTime(event.end)}` +
      (event.location ? `\n📍 ${event.location}` : '') +
      (event.description ? `\n📝 ${event.description}` : '');
  }

  formatDate(date) {
    const d = new Date(date);
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }

  formatTime(date) {
    const d = new Date(date);
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
}

module.exports = { CalendarHandler };
```

---

## 3. Heartbeat Integration

**Update:** `src/lib/heartbeat-manager.js`

Add calendar awareness to the heartbeat cycle:

```javascript
// In HeartbeatManager.processHeartbeat():

async processHeartbeat() {
  // ... existing Deck/Talk processing ...

  // Calendar awareness (check for upcoming meetings)
  if (this.calendarHandler) {
    const upcomingMeetings = await this.checkUpcomingMeetings();
    if (upcomingMeetings.length > 0) {
      await this.notifyUpcomingMeetings(upcomingMeetings);
    }
  }

  // Security cleanup
  if (this.securityHooks) {
    await this.securityHooks.onHeartbeat();
  }
}

/**
 * Check for meetings starting in the next 15 minutes.
 */
async checkUpcomingMeetings() {
  try {
    const now = new Date();
    const soon = new Date(now.getTime() + 15 * 60 * 1000);
    const events = await this.calendarHandler.caldav.getEvents({
      start: now,
      end: soon,
    });

    // Filter to meetings that haven't been notified yet
    return events.filter(e => {
      const key = `meeting_notified:${e.uid}`;
      if (this.notifiedMeetings?.has(key)) return false;
      this.notifiedMeetings = this.notifiedMeetings || new Set();
      this.notifiedMeetings.add(key);
      return true;
    });
  } catch (error) {
    console.error('Failed to check upcoming meetings:', error.message);
    return [];
  }
}

/**
 * Send reminder about upcoming meetings.
 */
async notifyUpcomingMeetings(meetings) {
  for (const meeting of meetings) {
    const minutesUntil = Math.round((new Date(meeting.start) - new Date()) / 60000);
    const message = `⏰ **Reminder:** "${meeting.title}" starts in ${minutesUntil} minutes` +
      (meeting.location ? ` at ${meeting.location}` : '');

    await this.notifier.send(this.config.defaultRoomToken, message);
  }
}
```

---

## 4. Test Cases

**File:** `test/calendar/caldav-client.test.js`

```javascript
describe('CalDAVClient', () => {
  let client;
  let mockNcRequestManager;
  let mockCredentialBroker;

  beforeEach(() => {
    mockNcRequestManager = {
      request: jest.fn().mockResolvedValue({ ok: true, json: () => ({}) }),
    };

    mockCredentialBroker = {
      withCredential: jest.fn((name, fn) => fn({ username: 'test', password: 'test' })),
    };

    client = new CalDAVClient({
      ncRequestManager: mockNcRequestManager,
      credentialBroker: mockCredentialBroker,
      config: { ncUrl: 'https://nc.example.com' },
    });
  });

  describe('connect()', () => {
    test('uses credential broker for authentication', async () => {
      // Mock tsdav responses
      client.client = {
        login: jest.fn().mockResolvedValue(true),
        fetchCalendars: jest.fn().mockResolvedValue([{ url: '/calendars/personal/', displayName: 'Personal' }]),
      };

      await client.connect();

      expect(mockCredentialBroker.withCredential).toHaveBeenCalledWith('caldav-access', expect.any(Function));
    });
  });

  describe('getEvents()', () => {
    test('returns events sorted by start time', async () => {
      client.connected = true;
      client.calendars = [{ url: '/personal/', displayName: 'Personal' }];
      client.client = {
        fetchCalendarObjects: jest.fn().mockResolvedValue([
          { data: mockICS('Meeting 2', '2026-02-06T14:00:00Z', '2026-02-06T15:00:00Z') },
          { data: mockICS('Meeting 1', '2026-02-06T09:00:00Z', '2026-02-06T10:00:00Z') },
        ]),
      };

      const events = await client.getEvents({ start: new Date('2026-02-06') });

      expect(events[0].title).toBe('Meeting 1');
      expect(events[1].title).toBe('Meeting 2');
    });
  });

  describe('createEvent()', () => {
    test('creates event without METHOD property', async () => {
      client.connected = true;
      client.calendars = [{ url: '/personal/', displayName: 'Personal' }];
      client.client = {
        createCalendarObject: jest.fn().mockResolvedValue({}),
      };

      await client.createEvent({
        title: 'Test Event',
        start: new Date('2026-02-06T10:00:00Z'),
        end: new Date('2026-02-06T11:00:00Z'),
      });

      const icsData = client.client.createCalendarObject.mock.calls[0][0].iCalString;
      expect(icsData).not.toContain('METHOD');
      expect(icsData).toContain('SUMMARY:Test Event');
    });
  });

  describe('error handling', () => {
    test('throws CalDAVError on connection failure', async () => {
      client.client = {
        login: jest.fn().mockRejectedValue(new Error('Auth failed')),
      };

      await expect(client.connect()).rejects.toThrow('Connection failed');
    });
  });
});

function mockICS(title, start, end) {
  return `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:${Math.random()}@test
DTSTART:${start.replace(/[-:]/g, '').replace('Z', '')}Z
DTEND:${end.replace(/[-:]/g, '').replace('Z', '')}Z
SUMMARY:${title}
END:VEVENT
END:VCALENDAR`;
}
```

---

## 5. Exit Criteria

Before calling this session done:

**CalDAVClient:**
- [ ] Uses NCRequestManager for all HTTP (not raw tsdav fetch)
- [ ] Uses CredentialBroker for authentication (not hardcoded creds)
- [ ] connect() handles auth errors gracefully
- [ ] getEvents() returns events sorted by start time
- [ ] createEvent() produces valid ICS without METHOD property
- [ ] deleteEvent() works with event UID
- [ ] checkConflicts() correctly identifies overlapping events
- [ ] findFreeSlots() respects working hours (9-5) and weekends
- [ ] getTodaySummary() produces human-readable output

**CalendarHandler:**
- [ ] Integrates with SecurityInterceptor for operation checks
- [ ] Query operations (today, tomorrow, upcoming) work
- [ ] Create/delete operations require confirmation
- [ ] Error messages are user-friendly

**Heartbeat:**
- [ ] Checks for meetings starting in next 15 minutes
- [ ] Sends reminder notifications
- [ ] Doesn't spam (tracks notified meetings)

**Tests:**
- [ ] All calendar tests pass
- [ ] No hardcoded credentials in tests
- [ ] Mocked NC responses (no real API calls in tests)

**Integration:**
- [ ] `npm test` passes
- [ ] ESLint passes
- [ ] AGPL headers on all new files
- [ ] JSDoc on public methods

---

## 6. What Comes Next

**Session 6:** Deck extended brain — Agent context awareness
**Session 7:** Collectives self-docs — "What can my agent do?"
**Session 8+:** Skill Forge — Template-based skill generation

---

*Built for MoltAgent Session 5. A working calendar beats a perfect spec.*
