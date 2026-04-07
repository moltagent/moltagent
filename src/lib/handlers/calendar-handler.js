/**
 * Moltagent Calendar Handler
 *
 * Architecture Brief:
 * -------------------
 * Problem: Users need to interact with calendars via natural language requests.
 * Calendar operations include queries (today, upcoming), event creation,
 * and availability checking.
 *
 * Pattern: Intent-based handler with LLM parsing for flexible queries.
 * Event creation requires HITL confirmation. Wraps CalDAV client with
 * user-friendly formatting.
 *
 * Key Dependencies:
 * - src/lib/caldav/caldav-client.js (CalDAV operations)
 * - src/lib/llm-router.js (for intent parsing)
 * - src/lib/config.js (configuration)
 *
 * Data Flow:
 * - Message -> parseIntent() -> specific handler -> format response
 * - Create event -> requiresConfirmation -> stored in MessageRouter
 * - Confirmation -> confirmCreateEvent() -> CalDAV createEvent()
 *
 * Integration Points:
 * - Called by MessageRouter._handleCalendar()
 * - confirmCreateEvent() called by confirmation handlers
 *
 * @module handlers/calendar-handler
 * @version 1.0.0
 */

'use strict';

const { JOBS } = require('../llm/router');

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * @typedef {Object} CalendarIntent
 * @property {'query_today'|'query_tomorrow'|'query_date'|'query_upcoming'|'create_event'|'find_free_time'|'check_availability'} action
 * @property {string} [title] - Event title (for create_event)
 * @property {string} [start] - ISO datetime string for event start
 * @property {string} [end] - ISO datetime string for event end
 * @property {number} [duration] - Duration in minutes
 * @property {string} [date] - ISO date string for query_date
 * @property {number} [days] - Number of days for upcoming query
 * @property {string} [location] - Event location
 * @property {string[]} [attendees] - Event attendees
 * @property {string} [description] - Event description
 */

/**
 * @typedef {Object} CalendarEvent
 * @property {string} summary - Event title/summary
 * @property {Date|string} start - Event start time
 * @property {Date|string} end - Event end time
 * @property {boolean} [allDay] - True if all-day event
 * @property {string} [location] - Event location
 * @property {string[]} [attendees] - Event attendees
 * @property {string} [description] - Event description
 * @property {string} [uid] - Unique event identifier
 */

/**
 * @typedef {Object} EventData
 * @property {string} summary - Event title
 * @property {Date} start - Event start time
 * @property {Date} end - Event end time
 * @property {string} [location] - Event location
 * @property {string[]} [attendees] - Event attendees
 * @property {string} [description] - Event description
 */

/**
 * @typedef {Object} FreeSlot
 * @property {Date} start - Slot start time
 * @property {Date} end - Slot end time
 * @property {number} durationMinutes - Duration in minutes
 */

/**
 * @typedef {Object} CalendarHandlerResult
 * @property {boolean} success - True if operation succeeded
 * @property {string} message - User-facing response message
 * @property {boolean} [requiresConfirmation] - True if HITL confirmation needed
 * @property {string} [confirmationType] - Type of confirmation ('create_event')
 * @property {Object} [pendingAction] - Action data to execute after confirmation
 * @property {CalendarEvent[]} [events] - Array of calendar events
 * @property {CalendarEvent} [event] - Single event (after creation)
 * @property {FreeSlot[]} [slots] - Array of free time slots
 * @property {CalendarEvent[]} [conflicts] - Conflicting events
 */

// -----------------------------------------------------------------------------
// Calendar Handler Class
// -----------------------------------------------------------------------------

class CalendarHandler {
  /**
   * Create a new CalendarHandler
   * @param {Object} caldavClient - CalDAV client instance
   * @param {Object} llmRouter - LLM router for intent parsing
   * @param {Function} [auditLog] - Audit logging function
   * @param {Object} [securityInterceptor] - SecurityInterceptor instance for before/after execute hooks
   */
  constructor(caldavClient, llmRouter, auditLog, securityInterceptor) {
    this.caldav = caldavClient;
    this.llm = llmRouter;
    this.auditLog = auditLog || (async () => {});
    this.security = securityInterceptor || null;
  }

  /**
   * Handle a natural language calendar request
   * @param {string} message - Natural language calendar request
   * @param {string} [user] - User making the request
   * @param {Object} [context={}] - Request context
   * @returns {Promise<CalendarHandlerResult>} Result with response message
   */
  async handle(message, user, context = {}) {
    // Parse the intent using LLM
    const intent = await this.parseIntent(message);

    console.log(`[Calendar] Intent: ${intent.action}`, JSON.stringify(intent).substring(0, 200));

    // Security: beforeExecute check
    if (this.security) {
      const securityContext = {
        roomToken: context.roomToken || context.token || 'unknown',
        userId: user || 'unknown',
        messageId: context.messageId || null
      };

      const securityResult = await this.security.beforeExecute(
        'calendar_' + intent.action,
        { content: message, ...intent },
        securityContext
      );

      if (!securityResult.proceed) {
        if (securityResult.decision === 'APPROVAL_REQUIRED') {
          return {
            success: true,
            requiresConfirmation: true,
            confirmationType: 'security_approval',
            message: securityResult.approvalPrompt || 'This calendar operation requires approval.',
            pendingAction: { action: intent.action, intent }
          };
        }
        return {
          success: false,
          message: `Calendar operation blocked: ${securityResult.reason || 'security policy'}`
        };
      }
    }

    try {
      let result;

      switch (intent.action) {
        case 'query_today':
          result = await this.handleQueryToday(intent, user);
          break;

        case 'query_tomorrow':
          result = await this.handleQueryTomorrow(intent, user);
          break;

        case 'query_date':
          result = await this.handleQueryDate(intent, user);
          break;

        case 'query_upcoming':
          result = await this.handleQueryUpcoming(intent, user);
          break;

        case 'create_event':
          result = await this.handleCreateEvent(intent, user, context);
          break;

        case 'find_free_time':
          result = await this.handleFindFreeTime(intent, user);
          break;

        case 'check_availability':
          result = await this.handleCheckAvailability(intent, user);
          break;

        default:
          return {
            success: false,
            message: "I didn't understand that calendar request. Try:\n" +
                     "• 'What's on my calendar today?'\n" +
                     "• 'Schedule a meeting tomorrow at 2pm'\n" +
                     "• 'Find a free slot this week'\n" +
                     "• 'Am I free Friday at 3pm?'"
          };
      }

      // Security: afterExecute on the response message
      if (this.security && result.message) {
        const securityContext = {
          roomToken: context.roomToken || context.token || 'unknown',
          userId: user || 'unknown',
          messageId: context.messageId || null
        };

        const afterResult = await this.security.afterExecute(
          'calendar_' + intent.action,
          result.message,
          securityContext
        );

        if (afterResult.blocked) {
          return {
            success: false,
            message: 'Calendar response blocked for security review.'
          };
        }

        result.message = afterResult.response;
      }

      return result;
    } catch (error) {
      console.error('[Calendar] Error:', error);
      await this.auditLog('calendar_error', { action: intent.action, error: error.message });
      return {
        success: false,
        message: `Calendar error: ${error.message}`
      };
    }
  }

  /**
   * Parse natural language into structured intent
   * @param {string} message - Natural language request
   * @returns {Promise<CalendarIntent>} Structured intent object
   */
  async parseIntent(message) {
    const now = new Date();
    const prompt = `Parse this calendar request into a structured action.

User request: "${message}"

Current date/time: ${now.toISOString()} (${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })})

Return JSON only (no markdown, no explanation):
{
  "action": "query_today|query_tomorrow|query_date|query_upcoming|create_event|find_free_time|check_availability",
  "title": "event title if creating",
  "start": "ISO datetime string if specified",
  "end": "ISO datetime string if specified",
  "duration": "duration in minutes if mentioned",
  "date": "ISO date if querying specific date",
  "days": "number of days for upcoming query",
  "location": "location if mentioned",
  "attendees": ["list", "of", "attendees"]
}

Only include relevant fields.

Examples:
- "what's on my calendar today" → {"action": "query_today"}
- "what do I have tomorrow" → {"action": "query_tomorrow"}
- "schedule a meeting tomorrow at 2pm" → {"action": "create_event", "title": "Meeting", "start": "${this.getTomorrow()}T14:00:00"}
- "find time for a 30 minute call this week" → {"action": "find_free_time", "duration": 30, "days": 7}
- "am I free Friday at 3pm" → {"action": "check_availability", "start": "...T15:00:00"}
- "what's this week look like" → {"action": "query_upcoming", "days": 7}`;

    try {
      const response = await this.llm.route({
        job: JOBS.TOOLS,
        task: 'calendar_parse',
        content: prompt,
        requirements: { role: 'free' }
      });

      // Clean up response — router returns { result: "...", provider, tokens, ... }
      let cleaned = response.result || response.response || response;
      if (typeof cleaned === 'object') {
        cleaned = cleaned.result || cleaned.response || JSON.stringify(cleaned);
      }

      // Remove markdown code blocks if present
      cleaned = String(cleaned)
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .replace(/<think>[\s\S]*?<\/think>/g, '')
        .trim();

      return JSON.parse(cleaned);
    } catch (e) {
      console.error('[Calendar] Intent parse failed:', e.message);
      // Fallback: try simple pattern matching
      return this.fallbackIntentParse(message);
    }
  }

  /**
   * Simple fallback intent parsing without LLM
   * @param {string} message - Natural language request
   * @returns {CalendarIntent} Structured intent object
   */
  fallbackIntentParse(message) {
    const lower = message.toLowerCase();

    if (lower.includes('today')) {
      return { action: 'query_today' };
    }
    if (lower.includes('tomorrow')) {
      if (lower.includes('schedule') || lower.includes('create') || lower.includes('add')) {
        return { action: 'create_event', title: 'Meeting' };
      }
      return { action: 'query_tomorrow' };
    }
    if (lower.includes('this week') || lower.includes('upcoming') || lower.includes('next')) {
      return { action: 'query_upcoming', days: 7 };
    }
    if (lower.includes('free') || lower.includes('available') || lower.includes('busy')) {
      return { action: 'find_free_time', duration: 60 };
    }
    if (lower.includes('schedule') || lower.includes('create') || lower.includes('add')) {
      return { action: 'create_event' };
    }

    return { action: 'query_today' };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Query Handlers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Handle today's calendar query
   * @param {CalendarIntent} intent - Parsed intent
   * @param {string} user - User making the request
   * @returns {Promise<CalendarHandlerResult>} Response with today's events
   */
  async handleQueryToday(intent, user) {
    const summary = await this.caldav.getTodaySummary();

    await this.auditLog('calendar_query', { type: 'today', user, count: summary.events.length });

    return {
      success: true,
      message: summary.text,
      events: summary.events
    };
  }

  /**
   * Handle tomorrow's calendar query
   * @param {CalendarIntent} intent - Parsed intent
   * @param {string} user - User making the request
   * @returns {Promise<CalendarHandlerResult>} Response with tomorrow's events
   */
  async handleQueryTomorrow(intent, user) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);

    const dayAfter = new Date(tomorrow);
    dayAfter.setDate(dayAfter.getDate() + 1);

    const calendars = await this.caldav.getEventCalendars();
    const allEvents = [];

    for (const cal of calendars) {
      const events = await this.caldav.getEvents(cal.id, tomorrow, dayAfter);
      allEvents.push(...events);
    }

    allEvents.sort((a, b) => new Date(a.start) - new Date(b.start));

    await this.auditLog('calendar_query', { type: 'tomorrow', user, count: allEvents.length });

    if (allEvents.length === 0) {
      return {
        success: true,
        message: "📅 No events scheduled for tomorrow. Your day is clear!",
        events: []
      };
    }

    const lines = [`📅 Tomorrow (${allEvents.length} event${allEvents.length > 1 ? 's' : ''}):\n`];

    for (const event of allEvents) {
      const start = new Date(event.start);
      const timeStr = event.allDay
        ? '📌 All day'
        : `🕐 ${this.formatTime(start)}`;

      lines.push(`**${event.summary}**`);
      lines.push(timeStr);
      if (event.location) lines.push(`📍 ${event.location}`);
      lines.push('');
    }

    return {
      success: true,
      message: lines.join('\n').trim(),
      events: allEvents
    };
  }

  /**
   * Handle specific date calendar query
   * @param {CalendarIntent} intent - Parsed intent with date
   * @param {string} user - User making the request
   * @returns {Promise<CalendarHandlerResult>} Response with date's events
   */
  async handleQueryDate(intent, user) {
    const date = new Date(intent.date);
    date.setHours(0, 0, 0, 0);

    const nextDay = new Date(date);
    nextDay.setDate(nextDay.getDate() + 1);

    const calendars = await this.caldav.getEventCalendars();
    const allEvents = [];

    for (const cal of calendars) {
      const events = await this.caldav.getEvents(cal.id, date, nextDay);
      allEvents.push(...events);
    }

    allEvents.sort((a, b) => new Date(a.start) - new Date(b.start));

    const dateStr = date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

    await this.auditLog('calendar_query', { type: 'date', date: intent.date, user, count: allEvents.length });

    if (allEvents.length === 0) {
      return {
        success: true,
        message: `📅 No events on ${dateStr}.`,
        events: []
      };
    }

    const lines = [`📅 ${dateStr} (${allEvents.length} event${allEvents.length > 1 ? 's' : ''}):\n`];

    for (const event of allEvents) {
      const start = new Date(event.start);
      const timeStr = event.allDay
        ? '📌 All day'
        : `🕐 ${this.formatTime(start)}`;

      lines.push(`**${event.summary}**`);
      lines.push(timeStr);
      if (event.location) lines.push(`📍 ${event.location}`);
      lines.push('');
    }

    return {
      success: true,
      message: lines.join('\n').trim(),
      events: allEvents
    };
  }

  /**
   * Handle upcoming events query
   * @param {CalendarIntent} intent - Parsed intent with days range
   * @param {string} user - User making the request
   * @returns {Promise<CalendarHandlerResult>} Response with upcoming events
   */
  async handleQueryUpcoming(intent, user) {
    const days = intent.days || 7;
    const hours = days * 24;
    const events = await this.caldav.getUpcomingEvents(hours);

    await this.auditLog('calendar_query', { type: 'upcoming', days, user, count: events.length });

    if (events.length === 0) {
      return {
        success: true,
        message: `📅 No events in the next ${days} days. Your schedule is clear!`,
        events: []
      };
    }

    // Group by day
    const byDay = {};
    for (const event of events) {
      const dateKey = new Date(event.start).toDateString();
      if (!byDay[dateKey]) byDay[dateKey] = [];
      byDay[dateKey].push(event);
    }

    const lines = [`📅 Next ${days} days (${events.length} event${events.length > 1 ? 's' : ''}):\n`];

    for (const [dateKey, dayEvents] of Object.entries(byDay)) {
      const date = new Date(dateKey);
      const dayName = this.isToday(date) ? 'Today' :
                      this.isTomorrow(date) ? 'Tomorrow' :
                      date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

      lines.push(`**${dayName}**`);

      for (const event of dayEvents) {
        const start = new Date(event.start);
        const timeStr = event.allDay ? 'All day' : this.formatTime(start);
        lines.push(`  • ${timeStr}: ${event.summary}`);
      }
      lines.push('');
    }

    return {
      success: true,
      message: lines.join('\n').trim(),
      events
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Create/Modify Handlers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Handle create event request (requires HITL confirmation)
   * @param {CalendarIntent} intent - Parsed intent with event details
   * @param {string} user - User making the request
   * @param {Object} context - Request context
   * @returns {Promise<CalendarHandlerResult>} Response with event preview and requiresConfirmation=true
   */
  async handleCreateEvent(intent, user, context) {
    // Validate required fields
    if (!intent.start) {
      return {
        success: false,
        message: "When should I schedule this? Please specify a date and time."
      };
    }

    const start = new Date(intent.start);
    const duration = intent.duration || 60;
    const end = intent.end ? new Date(intent.end) : new Date(start.getTime() + duration * 60 * 1000);
    const title = intent.title || 'New Event';

    // Check for conflicts
    const availability = await this.caldav.checkAvailability(start, end);

    let conflictWarning = '';
    if (!availability.isFree) {
      conflictWarning = '\n\n⚠️ **Conflicts detected:**\n' +
        availability.conflicts.map(c => `• ${this.formatTime(new Date(c.start))} - ${c.summary}`).join('\n');
    }

    const preview = this.formatEventPreview({ title, start, end, location: intent.location, attendees: intent.attendees });

    // Return confirmation request
    return {
      success: true,
      requiresConfirmation: true,
      confirmationType: 'create_event',
      pendingAction: {
        action: 'create_event',
        data: {
          summary: title,
          start,
          end,
          location: intent.location,
          attendees: intent.attendees,
          description: intent.description
        }
      },
      message: `📅 I'll create this event:${conflictWarning}\n\n${preview}\n\nReply **yes** to confirm, **no** to cancel, or tell me what to change.`
    };
  }

  /**
   * Execute confirmed event creation
   * @param {EventData} eventData - Event data to create
   * @param {string} user - User who approved the creation
   * @returns {Promise<CalendarHandlerResult>} Response with created event
   */
  async confirmCreateEvent(eventData, user, context = {}) {
    // Security: beforeExecute for the confirmed creation
    if (this.security) {
      const securityContext = {
        roomToken: context.roomToken || context.token || 'unknown',
        userId: user || 'unknown',
        messageId: context.messageId || null
      };

      const securityResult = await this.security.beforeExecute(
        'calendar_create_event_confirmed',
        { content: eventData.summary, ...eventData },
        securityContext
      );

      if (!securityResult.proceed) {
        return {
          success: false,
          message: `Event creation blocked: ${securityResult.reason || 'security policy'}`
        };
      }
    }

    const result = await this.caldav.createEvent(eventData);

    await this.auditLog('calendar_event_created', {
      user,
      uid: result.uid,
      summary: eventData.summary,
      start: eventData.start
    });

    return {
      success: true,
      message: `✅ Event created!\n\n` +
               `**${eventData.summary}**\n` +
               `📆 ${this.formatDate(eventData.start)}\n` +
               `🕐 ${this.formatTime(eventData.start)} - ${this.formatTime(eventData.end)}` +
               (eventData.location ? `\n📍 ${eventData.location}` : ''),
      event: result
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Free Time Handlers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Handle find free time request
   * @param {CalendarIntent} intent - Parsed intent with duration and days
   * @param {string} user - User making the request
   * @returns {Promise<CalendarHandlerResult>} Response with free time slots
   */
  async handleFindFreeTime(intent, user) {
    const duration = intent.duration || 60;
    const days = intent.days || 7;

    const rangeStart = new Date();
    const rangeEnd = new Date(rangeStart.getTime() + days * 24 * 60 * 60 * 1000);

    const slots = await this.caldav.findFreeSlots(rangeStart, rangeEnd, duration);

    await this.auditLog('calendar_free_time_search', { user, duration, days, found: slots.length });

    if (slots.length === 0) {
      return {
        success: true,
        message: `😅 Couldn't find any free ${duration}-minute slots in the next ${days} days. Your calendar is packed!`,
        slots: []
      };
    }

    // Show first 5 slots
    const lines = [`🔍 Found ${slots.length} free ${duration}+ minute slot(s). Here are the first 5:\n`];

    for (let i = 0; i < Math.min(5, slots.length); i++) {
      const slot = slots[i];
      const date = new Date(slot.start);
      const dayStr = this.isToday(date) ? 'Today' :
                     this.isTomorrow(date) ? 'Tomorrow' :
                     date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

      lines.push(`${i + 1}. **${dayStr}** ${this.formatTime(slot.start)} - ${this.formatTime(slot.end)} (${slot.durationMinutes} min)`);
    }

    lines.push('\nWant me to schedule something in one of these slots?');

    return {
      success: true,
      message: lines.join('\n'),
      slots: slots.slice(0, 5)
    };
  }

  /**
   * Handle availability check request
   * @param {CalendarIntent} intent - Parsed intent with start time
   * @param {string} user - User making the request
   * @returns {Promise<CalendarHandlerResult>} Response with availability status
   */
  async handleCheckAvailability(intent, user) {
    if (!intent.start) {
      return {
        success: false,
        message: "What time should I check? Please specify a date and time."
      };
    }

    const start = new Date(intent.start);
    const duration = intent.duration || 60;
    const end = new Date(start.getTime() + duration * 60 * 1000);

    const availability = await this.caldav.checkAvailability(start, end);

    await this.auditLog('calendar_availability_check', { user, start: intent.start, isFree: availability.isFree });

    if (availability.isFree) {
      const dateStr = this.formatDate(start);
      const timeStr = this.formatTime(start);
      return {
        success: true,
        message: `✅ You're free on **${dateStr}** at **${timeStr}**! Want me to schedule something?`
      };
    }

    const conflictList = availability.conflicts.map(c =>
      `• **${c.summary}** (${this.formatTime(new Date(c.start))} - ${this.formatTime(new Date(c.end))})`
    ).join('\n');

    return {
      success: true,
      message: `❌ You have conflicts at that time:\n\n${conflictList}\n\nWant me to find an alternative time?`,
      conflicts: availability.conflicts
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Formatting Helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Format time for display
   * @param {Date} date - Date to format
   * @returns {string} Formatted time string (12-hour format)
   */
  formatTime(date) {
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  }

  /**
   * Format date for display
   * @param {Date} date - Date to format
   * @returns {string} Formatted date string (e.g., "Mon, Jan 15")
   */
  formatDate(date) {
    return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }

  /**
   * Format event preview for confirmation prompts
   * @param {Object} event - Event object with title, start, end, location, attendees
   * @returns {string} Formatted event preview
   */
  formatEventPreview(event) {
    const lines = [
      `**${event.title}**`,
      `📆 ${this.formatDate(event.start)}`,
      `🕐 ${this.formatTime(event.start)} - ${this.formatTime(event.end)}`
    ];

    if (event.location) lines.push(`📍 ${event.location}`);
    if (event.attendees?.length) {
      lines.push(`👥 ${event.attendees.join(', ')}`);
    }

    return lines.join('\n');
  }

  /**
   * Check if date is today
   * @param {Date} date - Date to check
   * @returns {boolean} True if date is today
   */
  isToday(date) {
    const today = new Date();
    return date.toDateString() === today.toDateString();
  }

  /**
   * Check if date is tomorrow
   * @param {Date} date - Date to check
   * @returns {boolean} True if date is tomorrow
   */
  isTomorrow(date) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    return date.toDateString() === tomorrow.toDateString();
  }

  /**
   * Get tomorrow's date as ISO string
   * @returns {string} ISO date string for tomorrow (YYYY-MM-DD)
   */
  getTomorrow() {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    return tomorrow.toISOString().split('T')[0];
  }
}

module.exports = CalendarHandler;
