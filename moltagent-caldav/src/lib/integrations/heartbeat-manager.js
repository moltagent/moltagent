/**
 * MoltAgent Heartbeat Manager
 * 
 * Periodic operations that run in the background:
 * - Process Deck inbox tasks
 * - Check upcoming calendar events
 * - Monitor for important notifications
 * - Cost-aware: uses local LLM for scanning
 * 
 * @version 1.0.0
 */

const DeckClient = require('./deck-client');
const DeckTaskProcessor = require('./deck-task-processor');
const CalDAVClient = require('./caldav-client');

class HeartbeatManager {
  /**
   * @param {Object} config
   * @param {Object} config.nextcloud - Nextcloud connection config
   * @param {Object} config.deck - Deck configuration
   * @param {Object} config.caldav - CalDAV configuration
   * @param {Object} config.heartbeat - Heartbeat settings
   * @param {Object} config.llmRouter - LLM router instance
   * @param {Function} config.notifyUser - User notification function
   * @param {Function} config.auditLog - Audit logging function
   */
  constructor(config) {
    this.config = config;
    this.llmRouter = config.llmRouter;
    this.notifyUser = config.notifyUser || (async () => {});
    this.auditLog = config.auditLog || (async () => {});
    
    // Initialize clients
    this.deckClient = new DeckClient({
      ncUrl: config.nextcloud.url,
      username: config.nextcloud.username,
      password: config.nextcloud.password,
      boardId: config.deck?.boardId,
      auditLog: this.auditLog
    });

    this.deckProcessor = new DeckTaskProcessor({
      deckClient: this.deckClient,
      llmRouter: this.llmRouter,
      auditLog: this.auditLog
    });

    this.caldavClient = new CalDAVClient({
      ncUrl: config.nextcloud.url,
      username: config.nextcloud.username,
      password: config.nextcloud.password,
      auditLog: this.auditLog
    });

    // Heartbeat state
    this.state = {
      isRunning: false,
      lastRun: null,
      lastDeckProcess: null,
      lastCalendarCheck: null,
      consecutiveFailures: 0,
      tasksProcessedToday: 0,
      notificationsSentToday: 0
    };

    // Heartbeat settings with defaults
    this.settings = {
      intervalMs: config.heartbeat?.intervalMs || 5 * 60 * 1000,  // 5 minutes
      deckEnabled: config.heartbeat?.deckEnabled !== false,
      caldavEnabled: config.heartbeat?.caldavEnabled !== false,
      maxTasksPerCycle: config.heartbeat?.maxTasksPerCycle || 3,
      calendarLookaheadMinutes: config.heartbeat?.calendarLookaheadMinutes || 30,
      notifyUpcomingMeetings: config.heartbeat?.notifyUpcomingMeetings !== false,
      quietHoursStart: config.heartbeat?.quietHoursStart || 22,  // 10 PM
      quietHoursEnd: config.heartbeat?.quietHoursEnd || 7,       // 7 AM
      ...config.heartbeat
    };

    this._intervalHandle = null;
    this._notifiedMeetings = new Set(); // Track notified meeting UIDs
  }

  /**
   * Start the heartbeat loop
   */
  async start() {
    if (this.state.isRunning) {
      console.log('[Heartbeat] Already running');
      return;
    }

    console.log(`[Heartbeat] Starting with ${this.settings.intervalMs}ms interval`);
    this.state.isRunning = true;

    // Run immediately
    await this.pulse();

    // Then schedule
    this._intervalHandle = setInterval(() => {
      this.pulse().catch(err => {
        console.error('[Heartbeat] Pulse error:', err.message);
      });
    }, this.settings.intervalMs);

    await this.auditLog('heartbeat_started', {
      intervalMs: this.settings.intervalMs,
      deckEnabled: this.settings.deckEnabled,
      caldavEnabled: this.settings.caldavEnabled
    });
  }

  /**
   * Stop the heartbeat loop
   */
  async stop() {
    if (!this.state.isRunning) {
      return;
    }

    console.log('[Heartbeat] Stopping');
    this.state.isRunning = false;

    if (this._intervalHandle) {
      clearInterval(this._intervalHandle);
      this._intervalHandle = null;
    }

    await this.auditLog('heartbeat_stopped', {
      tasksProcessedToday: this.state.tasksProcessedToday,
      notificationsSentToday: this.state.notificationsSentToday
    });
  }

  /**
   * Single heartbeat pulse
   */
  async pulse() {
    const pulseStart = Date.now();
    const results = {
      deck: null,
      calendar: null,
      errors: []
    };

    try {
      // Check quiet hours
      if (this._isQuietHours()) {
        console.log('[Heartbeat] Quiet hours - minimal processing');
        this.state.lastRun = new Date();
        return results;
      }

      // Process Deck inbox
      if (this.settings.deckEnabled) {
        try {
          results.deck = await this._processDeck();
          this.state.lastDeckProcess = new Date();
        } catch (err) {
          console.error('[Heartbeat] Deck error:', err.message);
          results.errors.push({ component: 'deck', error: err.message });
        }
      }

      // Check calendar
      if (this.settings.caldavEnabled) {
        try {
          results.calendar = await this._checkCalendar();
          this.state.lastCalendarCheck = new Date();
        } catch (err) {
          console.error('[Heartbeat] Calendar error:', err.message);
          results.errors.push({ component: 'calendar', error: err.message });
        }
      }

      // Update state
      this.state.lastRun = new Date();
      this.state.consecutiveFailures = results.errors.length > 0 
        ? this.state.consecutiveFailures + 1 
        : 0;

      // Log heartbeat
      await this.auditLog('heartbeat_pulse', {
        durationMs: Date.now() - pulseStart,
        deckTasksProcessed: results.deck?.processed || 0,
        upcomingMeetings: results.calendar?.upcoming?.length || 0,
        errors: results.errors.length
      });

    } catch (err) {
      console.error('[Heartbeat] Fatal error:', err.message);
      this.state.consecutiveFailures++;
      results.errors.push({ component: 'heartbeat', error: err.message });
    }

    return results;
  }

  /**
   * Process Deck inbox tasks
   */
  async _processDeck() {
    const result = {
      processed: 0,
      queued: 0,
      errors: []
    };

    try {
      // Get inbox cards
      const inboxCards = await this.deckClient.getInboxCards();
      
      if (inboxCards.length === 0) {
        return result;
      }

      console.log(`[Heartbeat] Found ${inboxCards.length} cards in Deck inbox`);

      // Process up to maxTasksPerCycle
      const toProcess = inboxCards.slice(0, this.settings.maxTasksPerCycle);
      
      for (const card of toProcess) {
        try {
          // Skip cards with 'blocked' label
          if (card.labels?.some(l => l.title.toLowerCase() === 'blocked')) {
            continue;
          }

          // Process the task
          const taskResult = await this.deckProcessor.processTask(card);
          
          if (taskResult.success) {
            result.processed++;
            this.state.tasksProcessedToday++;
          } else if (taskResult.queued) {
            result.queued++;
          } else {
            result.errors.push({
              cardId: card.id,
              error: taskResult.error
            });
          }

        } catch (err) {
          console.error(`[Heartbeat] Error processing card ${card.id}:`, err.message);
          result.errors.push({
            cardId: card.id,
            error: err.message
          });
        }
      }

    } catch (err) {
      console.error('[Heartbeat] Deck processing error:', err.message);
      throw err;
    }

    return result;
  }

  /**
   * Check calendar for upcoming events
   */
  async _checkCalendar() {
    const result = {
      upcoming: [],
      notified: []
    };

    try {
      // Get events in the next N minutes
      const lookahead = this.settings.calendarLookaheadMinutes;
      const events = await this.caldavClient.getUpcomingEvents(lookahead / 60);

      result.upcoming = events;

      // Notify about meetings starting soon
      if (this.settings.notifyUpcomingMeetings) {
        const now = Date.now();
        const notifyWindowMs = 15 * 60 * 1000; // 15 minutes before

        for (const event of events) {
          const eventStart = new Date(event.start).getTime();
          const timeUntil = eventStart - now;

          // Notify if within 15 minutes and not already notified
          if (timeUntil > 0 && timeUntil <= notifyWindowMs) {
            const notifyKey = `${event.uid}-${event.start}`;
            
            if (!this._notifiedMeetings.has(notifyKey)) {
              await this._notifyUpcomingMeeting(event, timeUntil);
              this._notifiedMeetings.add(notifyKey);
              result.notified.push(event);
              this.state.notificationsSentToday++;
            }
          }
        }

        // Clean up old notification keys (older than 1 hour)
        this._cleanupNotifiedMeetings();
      }

    } catch (err) {
      console.error('[Heartbeat] Calendar check error:', err.message);
      throw err;
    }

    return result;
  }

  /**
   * Notify user about upcoming meeting
   */
  async _notifyUpcomingMeeting(event, timeUntilMs) {
    const minutesUntil = Math.round(timeUntilMs / 60000);
    const startTime = new Date(event.start).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit'
    });

    let message = `📅 Upcoming in ${minutesUntil} minutes:\n`;
    message += `**${event.summary}**\n`;
    message += `⏰ ${startTime}`;
    
    if (event.location) {
      message += `\n📍 ${event.location}`;
    }

    if (event.attendees && event.attendees.length > 0) {
      message += `\n👥 ${event.attendees.length} attendee(s)`;
    }

    await this.notifyUser({
      type: 'calendar_reminder',
      urgency: minutesUntil <= 5 ? 'high' : 'normal',
      message,
      event
    });

    await this.auditLog('calendar_reminder_sent', {
      eventUid: event.uid,
      summary: event.summary,
      minutesUntil
    });
  }

  /**
   * Check if we're in quiet hours
   */
  _isQuietHours() {
    const hour = new Date().getHours();
    const start = this.settings.quietHoursStart;
    const end = this.settings.quietHoursEnd;

    if (start > end) {
      // Quiet hours span midnight (e.g., 22:00 - 07:00)
      return hour >= start || hour < end;
    } else {
      // Quiet hours within same day
      return hour >= start && hour < end;
    }
  }

  /**
   * Clean up old notification tracking
   */
  _cleanupNotifiedMeetings() {
    // Keep only the last 100 entries to prevent memory growth
    if (this._notifiedMeetings.size > 100) {
      const entries = Array.from(this._notifiedMeetings);
      this._notifiedMeetings = new Set(entries.slice(-50));
    }
  }

  /**
   * Get heartbeat status
   */
  getStatus() {
    return {
      isRunning: this.state.isRunning,
      lastRun: this.state.lastRun,
      lastDeckProcess: this.state.lastDeckProcess,
      lastCalendarCheck: this.state.lastCalendarCheck,
      consecutiveFailures: this.state.consecutiveFailures,
      tasksProcessedToday: this.state.tasksProcessedToday,
      notificationsSentToday: this.state.notificationsSentToday,
      settings: this.settings
    };
  }

  /**
   * Reset daily counters (call at midnight)
   */
  resetDailyCounters() {
    this.state.tasksProcessedToday = 0;
    this.state.notificationsSentToday = 0;
    this._notifiedMeetings.clear();
  }

  /**
   * Force a single pulse (for testing or manual trigger)
   */
  async forcePulse() {
    return this.pulse();
  }

  /**
   * Get a summary of current system state for heartbeat context
   * (Used by the LLM for awareness)
   */
  async getHeartbeatContext() {
    const context = {
      timestamp: new Date().toISOString(),
      heartbeat: this.getStatus()
    };

    try {
      // Get today's calendar summary
      const calendarSummary = await this.caldavClient.getTodaySummary();
      context.calendar = {
        summary: calendarSummary.text,
        eventCount: calendarSummary.events.length
      };
    } catch (err) {
      context.calendar = { error: err.message };
    }

    try {
      // Get Deck inbox summary
      const inboxCards = await this.deckClient.getInboxCards();
      context.deck = {
        inboxCount: inboxCards.length,
        urgentCount: inboxCards.filter(c => 
          c.labels?.some(l => l.title.toLowerCase() === 'urgent')
        ).length
      };
    } catch (err) {
      context.deck = { error: err.message };
    }

    return context;
  }
}

module.exports = HeartbeatManager;
