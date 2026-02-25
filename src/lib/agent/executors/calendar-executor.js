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
    const extractionPrompt = `${dateContext}

Extract calendar event parameters from this message. Return ONLY valid JSON, no other text.

Message: "${message.substring(0, 300)}"

Return JSON with these fields (use null for missing):
{"action": "create|list|delete", "summary": "event title", "date": "relative or absolute date", "time": "HH:MM in 24h format", "duration_minutes": number, "attendees": ["email1"], "location": "place or null"}`;

    const params = await this._extractJSON(message, extractionPrompt);

    if (!params) {
      const err = new Error('Could not extract calendar parameters');
      err.code = 'DOMAIN_ESCALATE';
      throw err;
    }

    // Step 2: Resolve date via code (not LLM)
    const resolvedDate = this._resolveDate(params.date);
    if (!resolvedDate && params.action === 'create') {
      const err = new Error(`Could not resolve date: ${params.date}`);
      err.code = 'DOMAIN_ESCALATE';
      throw err;
    }

    // Step 3: Validate required fields
    if (params.action === 'create' && !params.summary) {
      const err = new Error('Missing required field: summary');
      err.code = 'DOMAIN_ESCALATE';
      throw err;
    }

    // Unsupported actions → escalate to cloud where full tools exist
    if (params.action && params.action !== 'create') {
      const err = new Error(`Calendar ${params.action} not yet supported by executor`);
      err.code = 'DOMAIN_ESCALATE';
      throw err;
    }

    // Step 4: Apply defaults
    const time = params.time || '09:00';
    const durationMinutes = params.duration_minutes || 60;

    // Step 5: Add requesting user as attendee
    const attendees = Array.isArray(params.attendees) ? [...params.attendees] : [];
    if (context.userName && !attendees.includes(context.userName)) {
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
    const attendeeList = attendees.length > 0 ? ` with ${attendees.join(', ')}` : '';

    return `Created event "${params.summary}" on ${formattedDate} at ${formattedTime} (${durationMinutes} min)${attendeeList}. Event ID: ${uid}`;
  }
}

module.exports = CalendarExecutor;
