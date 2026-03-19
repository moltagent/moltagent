'use strict';

const { filterOwnerEvents } = require('../integrations/calendar-scoping');

/**
 * DailyBriefing — First-Message-of-Day Briefing
 *
 * Gathers calendar events, task counts, and cost summary, then returns
 * a system-prompt instruction block so the LLM weaves a natural daily
 * greeting into its first response of the day.
 *
 * Triggered by AgentLoop.process() — NOT by the heartbeat loop.
 *
 * @module agent/daily-briefing
 */

class DailyBriefing {
  /**
   * @param {Object} opts
   * @param {Object} [opts.deckClient] - Deck client for task counts
   * @param {Object} [opts.caldavClient] - CalDAV client for today's events
   * @param {Object} [opts.budgetEnforcer] - Budget enforcer for cost report
   * @param {Object} [opts.costTracker] - CostTracker for per-call cost data (preferred over budgetEnforcer)
   * @param {Object} [opts.collectivesClient] - Wiki client (unused for now, reserved)
   * @param {string} [opts.timezone='UTC'] - IANA timezone for date calculation
   * @param {Object} [opts.ownerIds] - Owner identities for calendar alert scoping
   */
  constructor({ deckClient, caldavClient, budgetEnforcer, costTracker, collectivesClient, timezone, ownerIds } = {}) {
    this.deck = deckClient || null;
    this.caldav = caldavClient || null;
    this.budget = budgetEnforcer || null;
    this.costTracker = costTracker || null;
    this.wiki = collectivesClient || null;
    this._timezone = timezone || 'UTC';
    this._ownerIds = ownerIds || null;

    this.lastBriefingDate = null;
  }

  /**
   * Check whether today's briefing has already been sent.
   * If not, gather data and return a system-prompt instruction block.
   *
   * @returns {Promise<string>} Briefing block or empty string
   */
  async checkAndBuild() {
    const today = this._todayDate();

    if (this.lastBriefingDate === today) {
      return '';
    }

    // Lock before gathering to prevent double-send
    this.lastBriefingDate = today;

    const parts = [];

    // Calendar events
    try {
      if (this.caldav) {
        const allEvents = await this.caldav.getUpcomingEvents(16);
        const events = filterOwnerEvents(allEvents, this._ownerIds);
        if (events.length > 0) {
          const lines = events.slice(0, 6).map(e => {
            const time = new Date(e.start).toLocaleTimeString('en-US', {
              hour: '2-digit', minute: '2-digit', hour12: false
            });
            return `  ${time} -- ${e.summary}`;
          });
          parts.push(`- Calendar:\n${lines.join('\n')}`);
        } else {
          parts.push('- Calendar: No events today');
        }
      }
    } catch {
      parts.push('- Calendar: Could not check');
    }

    // Task counts
    try {
      if (this.deck) {
        const inbox = await this.deck.getCardsInStack('inbox');
        const working = await this.deck.getCardsInStack('working');
        const review = await this.deck.getCardsInStack('review');
        const taskLines = [];
        if (inbox.length > 0) taskLines.push(`${inbox.length} in inbox`);
        if (working.length > 0) taskLines.push(`${working.length} in progress`);
        if (review.length > 0) taskLines.push(`${review.length} awaiting review`);
        parts.push(`- Tasks: ${taskLines.length > 0 ? taskLines.join(', ') : 'all clear'}`);
      }
    } catch {
      parts.push('- Tasks: Could not check');
    }

    // Cost summary — read from CostTracker (single source of truth)
    try {
      if (this.costTracker) {
        const totals = this.costTracker.getTotals();
        const monthlyEur = totals.monthly.costEur.toFixed(2);
        const dailyEur = totals.daily.costEur.toFixed(2);
        parts.push(`- Costs: €${monthlyEur} this month (€${dailyEur} today)`);
      }
    } catch { /* skip */ }

    if (parts.length === 0) {
      return '';
    }

    return [
      '<daily_briefing>',
      "This is the user's first message today. Before responding to their message,",
      'include a brief daily greeting with these updates:',
      ...parts,
      'Then address their actual message naturally.',
      '</daily_briefing>'
    ].join('\n');
  }

  /**
   * Get today's date string in the configured timezone (YYYY-MM-DD).
   * @returns {string}
   * @private
   */
  _todayDate() {
    const now = new Date();
    try {
      return now.toLocaleDateString('sv-SE', { timeZone: this._timezone });
    } catch {
      return now.toISOString().split('T')[0];
    }
  }
}

module.exports = { DailyBriefing };
