/*
 * MoltAgent - Sovereign AI Security Layer
 * Copyright (C) 2026 MoltAgent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

'use strict';

/**
 * CalendarExecutor — Parameter-extraction executor for calendar domain.
 *
 * Architecture Brief:
 * - Problem: Local models hallucinate tool calls for calendar operations
 * - Pattern: Extract params via LLM → resolve dates in code → guardrail → execute
 * - Key Dependencies: BaseExecutor, CalDAVClient
 * - Data Flow: message → extract → route(create|list|update|delete) → resolveDate → validate → guard → execute → confirm
 *
 * @module agent/executors/calendar-executor
 * @version 2.0.0
 */

const BaseExecutor = require('./base-executor');
const { extractAttendees, mergeAttendees } = require('./attendee-extractor');

const MAX_DISPLAY_EVENTS = 15;

class CalendarExecutor extends BaseExecutor {
  /**
   * @param {Object} config - BaseExecutor config + calendarClient
   * @param {Object} config.calendarClient - CalDAV client instance
   */
  constructor(config = {}) {
    super(config);
    this.calendarClient = config.calendarClient;
    this._lastCreatedEvent = null;
  }

  /**
   * Execute a calendar operation from a natural language message.
   *
   * @param {string} message - User message
   * @param {Object} context - { userName, roomToken }
   * @returns {Promise<string>} Confirmation text
   */
  async execute(message, context) {
    // Step 1: Extract parameters via focused LLM prompt
    const dateContext = this._dateContext();
    const CALENDAR_SCHEMA = {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'update', 'delete'] },
        query_type: { type: 'string', enum: ['today', 'tomorrow', 'this_week', 'specific_date', 'upcoming', 'free_slots'] },
        summary: { type: 'string' },
        date: { type: 'string' },
        time: { type: 'string' },
        duration_minutes: { type: 'number' },
        attendees: { type: 'array', items: { type: 'string' } },
        location: { type: 'string' },
        update_type: { type: 'string', enum: ['add_attendee', 'remove_attendee', 'change_time', 'change_title', 'change_location'] },
        event_title: { type: 'string' },
        event_reference: { type: 'string' },
        attendee: { type: 'string' },
        new_time: { type: 'string' },
        new_title: { type: 'string' },
        new_location: { type: 'string' },
        requires_clarification: { type: 'boolean' },
        missing_fields: { type: 'array', items: { type: 'string' } }
      },
      required: ['action']
    };

    const extractionPrompt = `${dateContext}

Extract calendar parameters from this message.

Action rules:
- "Schedule/create/book/set up a meeting" → action: create
- "What's on my calendar/schedule/agenda?" → action: list
- "Do I have any events/meetings today?" → action: list
- "Am I free at 3pm?" → action: list
- "Any meetings this week?" → action: list
- "When is my next meeting?" → action: list
- "Assign me to/Add me to/Invite X to an event" → action: update
- "Reschedule/move/change time of event" → action: update
- "Rename event X to Y" → action: update
- "Change location of event" → action: update
- "Remove me from event" → action: update
- "Delete/cancel/remove event X" → action: delete

The difference:
- ADD a new event → action: create
- SEE what's already there → action: list
- MODIFY an existing event → action: update
- REMOVE an existing event → action: delete

For action=update, set update_type:
- "assign me to X" / "add me to X" / "invite Bob" → update_type: add_attendee
- "remove me from X" → update_type: remove_attendee
- "reschedule X to 3pm" / "move X to tomorrow" → update_type: change_time
- "rename X to Y" → update_type: change_title
- "change location of X to Room 5" → update_type: change_location
Set event_title or event_reference to identify the target event.
Use "last_created" for references like "the event you just created" or "that event".
Set attendee to "self" when the user refers to themselves ("me", "I").

For action=list, set query_type:
- "what's on my calendar today" → query_type: today
- "any meetings tomorrow" → query_type: tomorrow
- "what's my week look like" → query_type: this_week
- "am I free at 3pm" → query_type: free_slots, time: "15:00"
- "any events on March 5" → query_type: specific_date, date: "2026-03-05" (use YYYY-MM-DD for specific dates)
- "when is my next meeting" → query_type: upcoming

For action=create:
IMPORTANT: Put the event name/title in the "summary" field.
Use literal strings for dates and times (e.g. "tomorrow", "2pm") — do not convert them.
Leave fields as empty strings if not mentioned. Do NOT guess values.
If date or time is unclear, set requires_clarification to true and list missing_fields.

Message: "${message.substring(0, 300)}"`;

    const params = await this._extractJSON(message, extractionPrompt, CALENDAR_SCHEMA);

    if (!params) {
      const err = new Error('Could not extract calendar parameters');
      err.code = 'DOMAIN_ESCALATE';
      throw err;
    }

    // Step 2: Validation gates — reject bad extractions before hitting APIs
    if (params.requires_clarification) {
      const missing = Array.isArray(params.missing_fields) && params.missing_fields.length > 0
        ? params.missing_fields.join(', ')
        : 'some details';
      return `I'd like to help schedule this, but could you clarify: ${missing}?`;
    }

    // Normalize: some models put the title in event_title instead of summary
    if (!params.summary && params.event_title) {
      params.summary = params.event_title;
    }

    if (params.action === 'create') {
      if (!params.summary || params.summary.trim() === '') {
        return {
          response: 'I need a title for the event. What should I call it?',
          pendingClarification: {
            executor: 'calendar', action: 'create',
            missingFields: ['summary'],
            collectedFields: { date: params.date, time: params.time, duration_minutes: params.duration_minutes, attendees: params.attendees, location: params.location },
            originalMessage: message,
          }
        };
      }
      if (params.summary.length > 80) {
        return {
          response: "I couldn't extract a clear event title. Could you tell me just the event name?",
          pendingClarification: {
            executor: 'calendar', action: 'create',
            missingFields: ['summary'],
            collectedFields: { date: params.date, time: params.time, duration_minutes: params.duration_minutes, attendees: params.attendees, location: params.location },
            originalMessage: message,
          }
        };
      }
      if (!params.date && !params.time) {
        return {
          response: 'When should I schedule this? I need at least a date or time.',
          pendingClarification: {
            executor: 'calendar', action: 'create',
            missingFields: ['date'],
            collectedFields: { summary: params.summary, duration_minutes: params.duration_minutes, attendees: params.attendees, location: params.location },
            originalMessage: message,
          }
        };
      }
    }

    // List/query → read calendar events
    if (params.action === 'list') {
      return await this.queryEvents(params, context);
    }

    // Update → modify existing event
    if (params.action === 'update') {
      return await this.updateEvent(params, context);
    }

    // Delete → remove existing event
    if (params.action === 'delete') {
      return await this.deleteEvent(params, context);
    }

    // Create — delegate to reusable _executeCreate
    return await this._executeCreate(params, message, context);
  }

  /**
   * Core create-event logic, shared by execute() and resumeWithClarification().
   *
   * @param {Object} params - Extracted calendar parameters
   * @param {string} message - Original user message (for attendee extraction)
   * @param {Object} context - { userName, roomToken }
   * @returns {Promise<string>} Confirmation text
   */
  async _executeCreate(params, message, context) {
    // Step 3: Resolve date via code (not LLM)
    const resolvedDate = this._resolveDate(params.date);
    if (!resolvedDate) {
      const err = new Error(`Could not resolve date: ${params.date}`);
      err.code = 'DOMAIN_ESCALATE';
      throw err;
    }

    // Step 4: Apply defaults + normalize time
    const time = this._parseTime(params.time) || params.time || '09:00';
    const durationMinutes = params.duration_minutes || 60;

    // Step 5: Code-side attendee supplement — catches what LLM might drop
    const codeAttendees = extractAttendees(message);
    const attendees = mergeAttendees(
      Array.isArray(params.attendees) ? params.attendees : [],
      codeAttendees
    );
    // Add requesting user as attendee
    if (context.userName && !attendees.some(a => a.toLowerCase() === context.userName.toLowerCase())) {
      attendees.push(context.userName);
    }

    // Step 6: Build start/end times
    const [hours, minutes] = time.split(':').map(Number);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
      const err = new Error(`Invalid time format: ${params.time}`);
      err.code = 'DOMAIN_ESCALATE';
      throw err;
    }
    const startDate = new Date(`${resolvedDate}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`);
    const endDate = new Date(startDate.getTime() + durationMinutes * 60000);

    // Step 7: Guardrail check
    const guardResult = await this._checkGuardrails('calendar_create_event', {
      summary: params.summary,
      start: startDate.toISOString(),
      end: endDate.toISOString(),
      attendees,
      location: params.location
    }, context.roomToken || null);

    if (!guardResult.allowed) {
      return `Action blocked: ${guardResult.reason}`;
    }

    // Step 8: Execute
    const eventResult = await this.calendarClient.createEvent({
      summary: params.summary,
      start: startDate,
      end: endDate,
      attendees,
      location: params.location || undefined,
      description: `Created by Moltagent for ${context.userName || 'user'}`
    });

    // Track last created event for "the event you just created" references
    const uid = eventResult.uid || eventResult.id || 'unknown';
    this._lastCreatedEvent = {
      uid,
      calendarId: 'personal',
      summary: params.summary,
      start: startDate,
      end: endDate,
      attendees,
      location: params.location || undefined
    };

    // Step 9: Confirm with real data
    const formattedDate = resolvedDate;
    const formattedTime = time;
    const endTime = endDate.toISOString().slice(11, 16);
    const attendeeList = attendees.length > 0 ? ` with ${attendees.join(', ')}` : '';

    // Layer 1: Log activity
    this._logActivity('calendar_create',
      `Created "${params.summary}" for ${formattedDate} ${formattedTime}–${endTime}`,
      { title: params.summary, date: resolvedDate, attendees },
      context
    );

    return `Created event "${params.summary}" on ${formattedDate} at ${formattedTime} (${durationMinutes} min)${attendeeList}. Event ID: ${uid}`;
  }

  /**
   * Update an existing calendar event.
   *
   * @param {Object} params - Extracted parameters including update_type, event_title/event_reference
   * @param {Object} context - { userName, roomToken }
   * @returns {Promise<string>} Confirmation text
   */
  async updateEvent(params, context) {
    // Validation: need to know which event
    const searchTerm = params.event_title || params.event_reference || '';
    if (!searchTerm) {
      return 'Which event would you like me to update? Please provide the event name.';
    }

    // Validation: update_type-specific missing fields
    if (params.update_type === 'change_time' && !params.new_time && !params.date) {
      return 'What time should I reschedule this event to?';
    }
    if (params.update_type === 'change_title' && !params.new_title) {
      return 'What should I rename this event to?';
    }

    // Find the event
    let found;
    try {
      found = await this._findEventByTitle(searchTerm);
    } catch (err) {
      this.logger.warn(`[CalendarExecutor] Event search failed: ${err.message}`);
      return "I couldn't search your calendar right now. Want me to try again?";
    }

    if (!found) {
      if (searchTerm === 'last_created') {
        return "I don't remember which event was created last. Could you tell me the event name?";
      }
      return `I couldn't find an event matching "${searchTerm}". Could you check the name?`;
    }

    const { event, calendarId } = found;

    // Build updates based on update_type
    const updates = {};
    let description = '';

    switch (params.update_type) {
      case 'add_attendee': {
        const attendee = params.attendee === 'self' ? (context.userName || 'user') : (params.attendee || '');
        if (!attendee) {
          return 'Who should I add to this event?';
        }
        const currentAttendees = Array.isArray(event.attendees) ? [...event.attendees] : [];
        if (!currentAttendees.some(a => a.toLowerCase() === attendee.toLowerCase())) {
          currentAttendees.push(attendee);
        }
        updates.attendees = currentAttendees;
        description = `Added ${attendee} to "${event.summary}"`;
        break;
      }
      case 'remove_attendee': {
        const attendee = params.attendee === 'self' ? (context.userName || 'user') : (params.attendee || '');
        if (!attendee) {
          return 'Who should I remove from this event?';
        }
        const currentAttendees = Array.isArray(event.attendees) ? [...event.attendees] : [];
        updates.attendees = currentAttendees.filter(a => a.toLowerCase() !== attendee.toLowerCase());
        description = `Removed ${attendee} from "${event.summary}"`;
        break;
      }
      case 'change_time': {
        const rawNewTime = params.new_time || params.time || '';
        const newTime = this._parseTime(rawNewTime) || rawNewTime;
        const newDate = params.date ? this._resolveDate(params.date) : null;
        const eventDur = event.end && event.start
          ? new Date(event.end).getTime() - new Date(event.start).getTime()
          : 60 * 60000;
        if (newTime) {
          const [h, m] = newTime.split(':').map(Number);
          if (Number.isFinite(h) && Number.isFinite(m)) {
            const base = newDate ? new Date(`${newDate}T00:00:00`) : new Date(event.start);
            base.setHours(h, m, 0, 0);
            updates.start = base;
            updates.end = new Date(base.getTime() + eventDur);
          }
        } else if (newDate) {
          const oldStart = new Date(event.start);
          const base = new Date(`${newDate}T${String(oldStart.getHours()).padStart(2, '0')}:${String(oldStart.getMinutes()).padStart(2, '0')}:00`);
          updates.start = base;
          updates.end = new Date(base.getTime() + eventDur);
        }
        if (!updates.start) {
          return "I couldn't understand the new time. Could you specify it as HH:MM?";
        }
        description = `Rescheduled "${event.summary}"`;
        break;
      }
      case 'change_title':
        updates.summary = params.new_title;
        description = `Renamed "${event.summary}" to "${params.new_title}"`;
        break;
      case 'change_location':
        updates.location = params.new_location || params.location || '';
        description = `Changed location of "${event.summary}" to "${updates.location}"`;
        break;
      default:
        description = `Updated "${event.summary}"`;
        break;
    }

    // Guardrail check
    const guardResult = await this._checkGuardrails('calendar_update_event', {
      uid: event.uid,
      summary: event.summary,
      updates
    }, context.roomToken || null);

    if (!guardResult.allowed) {
      return `Action blocked: ${guardResult.reason}`;
    }

    // Execute update
    try {
      await this.calendarClient.updateEvent(calendarId, event.uid, updates);
    } catch (err) {
      this.logger.warn(`[CalendarExecutor] Update failed: ${err.message}`);
      return "I couldn't update that event right now. Want me to try again?";
    }

    // Log activity
    this._logActivity('calendar_update', description,
      { uid: event.uid, updateType: params.update_type, updates },
      context
    );

    return description + '.';
  }

  /**
   * Delete an existing calendar event.
   *
   * @param {Object} params - Extracted parameters including event_title/event_reference
   * @param {Object} context - { userName, roomToken }
   * @returns {Promise<string>} Confirmation text
   */
  async deleteEvent(params, context) {
    const searchTerm = params.event_title || params.event_reference || params.summary || '';
    if (!searchTerm) {
      return 'Which event would you like me to delete? Please provide the event name.';
    }

    // Find the event
    let found;
    try {
      found = await this._findEventByTitle(searchTerm);
    } catch (err) {
      this.logger.warn(`[CalendarExecutor] Event search failed: ${err.message}`);
      return "I couldn't search your calendar right now. Want me to try again?";
    }

    if (!found) {
      if (searchTerm === 'last_created') {
        return "I don't remember which event was created last. Could you tell me the event name?";
      }
      return `I couldn't find an event matching "${searchTerm}". Could you check the name?`;
    }

    const { event, calendarId } = found;

    // Always require guardrail approval for deletes
    const guardResult = await this._checkGuardrails('calendar_delete_event', {
      uid: event.uid,
      summary: event.summary
    }, context.roomToken || null);

    if (!guardResult.allowed) {
      return `Action blocked: ${guardResult.reason}`;
    }

    // Execute delete
    try {
      await this.calendarClient.deleteEvent(calendarId, event.uid);
    } catch (err) {
      this.logger.warn(`[CalendarExecutor] Delete failed: ${err.message}`);
      return "I couldn't delete that event right now. Want me to try again?";
    }

    // Clear lastCreatedEvent if it was the deleted one
    if (this._lastCreatedEvent && this._lastCreatedEvent.uid === event.uid) {
      this._lastCreatedEvent = null;
    }

    // Log activity
    this._logActivity('calendar_delete',
      `Deleted "${event.summary}"`,
      { uid: event.uid, summary: event.summary },
      context
    );

    return `Deleted event "${event.summary}".`;
  }

  /**
   * Find a calendar event by title or reference.
   * Searches -7 to +14 days across all event calendars.
   *
   * @param {string} searchTerm - Event title, UID, or "last_created"
   * @returns {Promise<{event: Object, calendarId: string}|null>}
   */
  async _findEventByTitle(searchTerm) {
    if (!searchTerm) return null;

    // Handle "last_created" reference
    if (searchTerm === 'last_created') {
      if (this._lastCreatedEvent) {
        return {
          event: this._lastCreatedEvent,
          calendarId: this._lastCreatedEvent.calendarId || 'personal'
        };
      }
      return null; // Don't search for literal "last_created" as a title
    }

    const now = new Date();
    const searchStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const searchEnd = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

    const calendars = await this.calendarClient.getEventCalendars();
    for (const calendar of calendars) {
      const events = await this.calendarClient.getEvents(calendar.id, searchStart, searchEnd);
      if (!events) continue;
      for (const event of events) {
        const matchByUid = event.uid === searchTerm;
        const matchByTitle = event.summary &&
          event.summary.toLowerCase().includes(searchTerm.toLowerCase());
        if (matchByUid || matchByTitle) {
          return { event, calendarId: calendar.id };
        }
      }
    }
    return null;
  }

  /**
   * Query calendar events based on extracted parameters.
   *
   * @param {Object} params - { query_type, date?, time? }
   * @param {Object} context - { userName, roomToken }
   * @returns {Promise<string>} Formatted event list or "calendar is clear" message
   */
  async queryEvents(params, context) {
    const queryType = params.query_type || 'today';
    const range = this._resolveQueryRange(params);
    const { start, end } = range;

    if (range.dateUnresolved) {
      return `I couldn't understand the date "${range.rawDate || 'unknown'}". Could you try a specific date like "tomorrow" or "March 5"?`;
    }

    let events;
    try {
      if (typeof this.calendarClient.getTodayEvents === 'function' && queryType === 'today') {
        events = await this.calendarClient.getTodayEvents();
      } else if (typeof this.calendarClient.getUpcomingEvents === 'function' && queryType === 'upcoming') {
        events = await this.calendarClient.getUpcomingEvents(168); // 7 days
      } else if (typeof this.calendarClient.getEventCalendars === 'function') {
        const calendars = await this.calendarClient.getEventCalendars();
        events = [];
        for (const cal of calendars) {
          const calEvents = await this.calendarClient.getEvents(cal.id, start, end);
          events.push(...(calEvents || []));
        }
        events.sort((a, b) => new Date(a.start) - new Date(b.start));
      } else {
        events = await this.calendarClient.getEvents(null, start, end);
      }
    } catch (err) {
      this.logger.warn(`[CalendarExecutor] Calendar query failed: ${err.message}`);
      return "I couldn't read your calendar right now. Want me to try again?";
    }

    // Log activity
    this._logActivity('calendar_query',
      `Queried calendar: ${queryType}`,
      { queryType, eventCount: events ? events.length : 0 },
      context
    );

    if (!events || events.length === 0) {
      return this._formatNoEvents(queryType);
    }

    return this._formatEventList(events, queryType);
  }

  /**
   * Resolve query parameters to a start/end date range.
   * @param {Object} params - { query_type, date?, time? }
   * @returns {{ start: Date, end: Date }}
   */
  _resolveQueryRange(params) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    const endOfDay = new Date(today);
    endOfDay.setHours(23, 59, 59, 999);
    const endOfTomorrow = new Date(tomorrow);
    endOfTomorrow.setHours(23, 59, 59, 999);
    const endOfWeek = new Date(today);
    endOfWeek.setDate(today.getDate() + (7 - today.getDay()));
    endOfWeek.setHours(23, 59, 59, 999);

    switch (params.query_type) {
      case 'today':
        return { start: today, end: endOfDay };
      case 'tomorrow':
        return { start: tomorrow, end: endOfTomorrow };
      case 'this_week':
        return { start: today, end: endOfWeek };
      case 'upcoming': {
        const weekOut = new Date(today);
        weekOut.setDate(today.getDate() + 7);
        return { start: now, end: weekOut };
      }
      case 'specific_date': {
        const resolved = this._resolveDate(params.date);
        if (resolved) {
          const dayStart = new Date(`${resolved}T00:00:00`);
          const dayEnd = new Date(`${resolved}T23:59:59`);
          return { start: dayStart, end: dayEnd };
        }
        // _resolveDate failed — flag so queryEvents can report clearly
        return { start: today, end: endOfDay, dateUnresolved: true, rawDate: params.date };
      }
      case 'free_slots':
        return { start: today, end: endOfDay };
      default:
        return { start: today, end: endOfDay };
    }
  }

  /**
   * Format a "no events" response.
   * @param {string} queryType
   * @returns {string}
   */
  _formatNoEvents(queryType) {
    switch (queryType) {
      case 'today': return 'Your calendar is clear today. No events scheduled.';
      case 'tomorrow': return 'Nothing on the calendar for tomorrow.';
      case 'this_week': return 'Your week is open — no events scheduled.';
      case 'upcoming': return 'No upcoming events in the next 7 days.';
      case 'free_slots': return 'Your calendar is clear today — you\'re free.';
      default: return 'No events found for that time period.';
    }
  }

  /**
   * Format an event list for display.
   * Single-day queries (today, tomorrow, specific_date, free_slots): flat list, no date headers.
   * Multi-day queries (this_week, upcoming): grouped by date with headers.
   * Capped at MAX_DISPLAY_EVENTS with truncation notice.
   *
   * @param {Array} events - Calendar events
   * @param {string} queryType
   * @returns {string}
   */
  _formatEventList(events, queryType) {
    const isSingleDay = ['today', 'tomorrow', 'specific_date', 'free_slots'].includes(queryType);
    const label = queryType === 'today' ? 'Today' :
                  queryType === 'tomorrow' ? 'Tomorrow' :
                  queryType === 'this_week' ? 'This week' :
                  queryType === 'upcoming' ? 'Upcoming' : 'Events';

    const totalCount = events.length;
    const capped = events.slice(0, MAX_DISPLAY_EVENTS);

    if (isSingleDay) {
      const lines = capped.map(e => {
        const time = e.start ? new Date(e.start).toLocaleTimeString('en-US', {
          hour: '2-digit', minute: '2-digit', hour12: false
        }) : '??:??';
        const duration = e.duration ? ` (${e.duration} min)` : '';
        return `• ${time} — ${e.summary || 'Untitled'}${duration}`;
      });
      let result = `${label}:\n${lines.join('\n')}`;
      if (totalCount > MAX_DISPLAY_EVENTS) {
        result += `\n\n(Showing ${MAX_DISPLAY_EVENTS} of ${totalCount} events)`;
      }
      return result;
    }

    // Multi-day: group by date
    const groups = new Map();
    for (const e of capped) {
      const dateKey = e.start
        ? new Date(e.start).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
        : 'Unknown date';
      if (!groups.has(dateKey)) groups.set(dateKey, []);
      groups.get(dateKey).push(e);
    }

    const sections = [];
    for (const [dateHeader, dayEvents] of groups) {
      const lines = dayEvents.map(e => {
        const time = e.start ? new Date(e.start).toLocaleTimeString('en-US', {
          hour: '2-digit', minute: '2-digit', hour12: false
        }) : '??:??';
        const duration = e.duration ? ` (${e.duration} min)` : '';
        return `  • ${time} — ${e.summary || 'Untitled'}${duration}`;
      });
      sections.push(`${dateHeader}:\n${lines.join('\n')}`);
    }

    let result = `${label}:\n${sections.join('\n')}`;
    if (totalCount > MAX_DISPLAY_EVENTS) {
      result += `\n\n(Showing ${MAX_DISPLAY_EVENTS} of ${totalCount} events)`;
    }
    return result;
  }

  /**
   * Resume a calendar create after the user answers a clarification question.
   * Merges the user's response into collectedFields and either asks the next
   * question or completes the event creation via _executeCreate().
   *
   * @param {Object} clarification - { collectedFields, userResponse, missingFields, action, executor, originalMessage }
   * @param {Object} context - { userName, roomToken }
   * @returns {Promise<{ response: string, pendingClarification?: Object }>}
   */
  async resumeWithClarification(clarification, context) {
    const { collectedFields, userResponse } = clarification;
    const missingFields = Array.isArray(clarification.missingFields) ? clarification.missingFields : [];
    if (missingFields.length === 0) {
      const params = {
        action: 'create',
        summary: collectedFields.summary || '',
        date: collectedFields.date || '',
        time: collectedFields.time || '',
        duration_minutes: collectedFields.duration_minutes,
        attendees: collectedFields.attendees,
        location: collectedFields.location,
      };
      return { response: await this._executeCreate(params, clarification.originalMessage, context) };
    }
    const firstMissing = missingFields[0];
    const updatedFields = { ...collectedFields, [firstMissing]: userResponse };
    const stillMissing = missingFields.slice(1);

    if (stillMissing.length > 0) {
      return {
        response: this._askForField(stillMissing[0]),
        pendingClarification: {
          executor: 'calendar',
          action: clarification.action,
          missingFields: stillMissing,
          collectedFields: updatedFields,
          originalMessage: clarification.originalMessage,
        }
      };
    }

    // All fields collected — build params and create
    const params = {
      action: 'create',
      summary: updatedFields.summary || '',
      date: updatedFields.date || '',
      time: updatedFields.time || '',
      duration_minutes: updatedFields.duration_minutes,
      attendees: updatedFields.attendees,
      location: updatedFields.location,
    };

    const response = await this._executeCreate(params, clarification.originalMessage, context);
    return { response };
  }

  /**
   * Calendar-specific field questions.
   * @param {string} fieldName
   * @returns {string}
   */
  _askForField(fieldName) {
    switch (fieldName) {
      case 'summary': return 'What should I call this event?';
      case 'date': return 'What date should I schedule this for?';
      case 'time': return 'What time should the event start?';
      default: return `What's the ${fieldName}?`;
    }
  }
}

module.exports = CalendarExecutor;
