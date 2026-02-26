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
 * - Data Flow: message → extract → route(create|list) → resolveDate → validate → guard → execute → confirm
 *
 * @module agent/executors/calendar-executor
 * @version 1.0.0
 */

const BaseExecutor = require('./base-executor');
const { extractAttendees, mergeAttendees } = require('./attendee-extractor');

class CalendarExecutor extends BaseExecutor {
  /**
   * @param {Object} config - BaseExecutor config + calendarClient
   * @param {Object} config.calendarClient - CalDAV client instance
   */
  constructor(config = {}) {
    super(config);
    this.calendarClient = config.calendarClient;
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
        action: { type: 'string', enum: ['create', 'list', 'delete'] },
        query_type: { type: 'string', enum: ['today', 'tomorrow', 'this_week', 'specific_date', 'upcoming', 'free_slots'] },
        summary: { type: 'string' },
        date: { type: 'string' },
        time: { type: 'string' },
        duration_minutes: { type: 'number' },
        attendees: { type: 'array', items: { type: 'string' } },
        location: { type: 'string' },
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
The difference: if the user wants to ADD something → action: create.
If the user wants to SEE what's already there → action: list.

For action=list, set query_type:
- "what's on my calendar today" → query_type: today
- "any meetings tomorrow" → query_type: tomorrow
- "what's my week look like" → query_type: this_week
- "am I free at 3pm" → query_type: free_slots, time: "15:00"
- "any events on March 5" → query_type: specific_date, date: "2026-03-05" (use YYYY-MM-DD for specific dates)
- "when is my next meeting" → query_type: upcoming

For action=create:
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

    if (params.action === 'create') {
      if (!params.summary || params.summary.trim() === '') {
        return 'I need a title for the event. What should I call it?';
      }
      if (params.summary.length > 80) {
        return "I couldn't extract a clear event title. Could you tell me just the event name?";
      }
      if (!params.date && !params.time) {
        return 'When should I schedule this? I need at least a date or time.';
      }
    }

    // List/query → read calendar events
    if (params.action === 'list') {
      return await this.queryEvents(params, context);
    }

    // Unsupported actions → escalate to cloud where full tools exist
    if (params.action && params.action !== 'create') {
      const err = new Error(`Calendar ${params.action} not yet supported by executor`);
      err.code = 'DOMAIN_ESCALATE';
      throw err;
    }

    // Step 3: Resolve date via code (not LLM)
    const resolvedDate = this._resolveDate(params.date);
    if (!resolvedDate && params.action === 'create') {
      const err = new Error(`Could not resolve date: ${params.date}`);
      err.code = 'DOMAIN_ESCALATE';
      throw err;
    }

    // Step 4: Apply defaults
    const time = params.time || '09:00';
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

    // Step 9: Confirm with real data
    const uid = eventResult.uid || eventResult.id || 'unknown';
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
   * @param {Array} events - Calendar events
   * @param {string} queryType
   * @returns {string}
   */
  _formatEventList(events, queryType) {
    const label = queryType === 'today' ? 'Today' :
                  queryType === 'tomorrow' ? 'Tomorrow' :
                  queryType === 'this_week' ? 'This week' :
                  queryType === 'upcoming' ? 'Upcoming' : 'Events';

    const lines = events.map(e => {
      const time = e.start ? new Date(e.start).toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit', hour12: false
      }) : '??:??';
      const duration = e.duration ? ` (${e.duration} min)` : '';
      return `• ${time} — ${e.summary || 'Untitled'}${duration}`;
    });

    return `${label}:\n${lines.join('\n')}`;
  }
}

module.exports = CalendarExecutor;
