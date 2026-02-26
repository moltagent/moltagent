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
 * - Data Flow: message → extract → resolveDate → validate → guard → createEvent → confirm
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

Extract calendar event parameters from this message.
Use literal strings for dates and times (e.g. "tomorrow", "2pm") — do not convert them.
Leave fields as empty strings if not mentioned. Do NOT guess values.
If the message is NOT about creating/scheduling an event, set requires_clarification to true.
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
}

module.exports = CalendarExecutor;
