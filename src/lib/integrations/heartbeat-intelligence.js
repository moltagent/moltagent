/**
 * Moltagent Heartbeat Intelligence
 *
 * Proactive intelligence classes that run on the heartbeat cycle:
 *
 * - MeetingPreparer: Gathers context from wiki/contacts/email/deck for
 *   upcoming meetings, synthesizes prep notes via LLM, sends to Talk.
 *   Runs at Initiative Level >= 3.
 *
 * Note: DailyDigester was removed in Session 32. Daily briefings are now
 * handled by DailyBriefing (src/lib/agent/daily-briefing.js) which injects
 * into the system prompt on the first message of the day via AgentLoop.
 *
 * Note: FreshnessChecker was removed — wiki freshness is now handled by
 * WikiSteward (src/lib/maintenance/wiki-steward.js).
 *
 * @module integrations/heartbeat-intelligence
 * @version 1.0.0
 */

'use strict';

const { JOBS } = require('../llm/router');
const { filterOwnerEvents } = require('./calendar-scoping');

// ============================================================================
// MeetingPreparer
// ============================================================================

class MeetingPreparer {
  /**
   * @param {Object} opts
   * @param {Object} opts.caldavClient - CalDAV client for upcoming events
   * @param {Object} opts.collectivesClient - Wiki client for people pages
   * @param {Object} opts.contactsClient - CardDAV contacts client
   * @param {Object} [opts.emailMonitor] - Email monitor for recent threads
   * @param {Object} opts.deckClient - Deck client for shared tasks
   * @param {Object} opts.router - LLM router for synthesis
   * @param {Function} opts.notifyUser - Notification function
   * @param {Object} [opts.config] - Config object
   * @param {Object} [opts.ownerIds] - Owner identities for calendar alert scoping
   */
  constructor({ caldavClient, collectivesClient, contactsClient, emailMonitor, deckClient, router, notifyUser, config, ownerIds }) {
    this.caldav = caldavClient;
    this.wiki = collectivesClient;
    this.contacts = contactsClient;
    this.email = emailMonitor || null;
    this.deck = deckClient;
    this.router = router;
    this.notifyUser = notifyUser;
    this.config = config || {};
    this._ownerIds = ownerIds || null;

    this.preparedMeetings = new Set();
    this.PREP_WINDOW_MINUTES = 90;
  }

  /**
   * Check for upcoming meetings and prepare context notes.
   * @returns {Promise<{checked: number, prepped: number}>}
   */
  async checkAndPrep() {
    const allUpcoming = await this.caldav.getUpcomingEvents(this.PREP_WINDOW_MINUTES / 60);
    const upcoming = filterOwnerEvents(allUpcoming, this._ownerIds);

    const prepped = [];
    for (const event of upcoming) {
      const eventKey = `${event.uid || event.summary}-${event.start}`;
      if (this.preparedMeetings.has(eventKey)) continue;

      if (!event.attendees || event.attendees.length === 0) continue;

      const context = await this._gatherContext(event);
      const prepNotes = await this._synthesize(event, context);

      if (prepNotes) {
        await this.notifyUser({
          type: 'meeting_prep',
          message: prepNotes
        });
        this.preparedMeetings.add(eventKey);
        prepped.push(event.summary);
      }
    }

    return { checked: upcoming.length, prepped: prepped.length };
  }

  /**
   * Gather context for a meeting event from wiki, contacts, email, deck.
   * Each source is individually guarded against failure.
   * @param {Object} event - Calendar event
   * @returns {Promise<Object>} Gathered context
   */
  async _gatherContext(event) {
    const context = {
      attendees: [],
      recentEmails: [],
      sharedTasks: [],
      wikiPages: []
    };

    const attendeeNames = (event.attendees || [])
      .map(a => a.name || a.cn || a.email?.split('@')[0])
      .filter(Boolean);

    for (const name of attendeeNames) {
      // Wiki people page
      if (this.wiki) {
        try {
          const found = await this.wiki.findPageByTitle(name);
          if (found) {
            const content = await this.wiki.readPageContent(found.path);
            if (content) {
              context.wikiPages.push({ name, content: content.substring(0, 1500) });
            }
          }
        } catch (err) { /* skip */ }
      }

      // Contacts
      if (this.contacts) {
        try {
          const contacts = await this.contacts.search(name);
          if (contacts.length > 0) {
            context.attendees.push(contacts[0]);
          }
        } catch (err) { /* skip */ }
      }

      // Recent emails
      if (this.email?.checkInbox) {
        // EmailMonitor doesn't have a searchMail method -- skip silently
      }
    }

    // Shared Deck tasks
    if (this.deck) {
      try {
        const workingCards = await this.deck.getCardsInStack('working');
        context.sharedTasks = workingCards.filter(c =>
          attendeeNames.some(name =>
            (c.assignedUsers || []).some(u =>
              (u.participant?.displayname || '').toLowerCase().includes(name.toLowerCase())
            )
          )
        );
      } catch (err) { /* skip */ }
    }

    return context;
  }

  /**
   * Synthesize prep notes via LLM.
   * @param {Object} event - Calendar event
   * @param {Object} context - Gathered context
   * @returns {Promise<string|null>} Prep notes or null on failure
   */
  async _synthesize(event, context) {
    const prompt = `Prepare brief meeting prep notes. Be concise.

Meeting: ${event.summary}
Time: ${event.start}
Attendees: ${(event.attendees || []).map(a => a.name || a.cn || a.email).join(', ')}

${context.wikiPages.length > 0 ? `People context:\n${context.wikiPages.map(p => `- ${p.name}: ${p.content?.substring(0, 500)}`).join('\n')}` : ''}

${context.recentEmails.length > 0 ? `Recent email threads:\n${context.recentEmails.map(e => `- ${e.subject} (${e.from})`).join('\n')}` : ''}

${context.sharedTasks.length > 0 ? `Open shared tasks:\n${context.sharedTasks.map(c => `- ${c.title}`).join('\n')}` : ''}

Write a brief prep summary (max 200 words) for the human. Include: who's attending, relevant context, any open items to discuss, suggested talking points.`;

    try {
      const result = await this.router.route({
        job: JOBS.RESEARCH,
        task: 'meeting_prep',
        content: prompt,
        requirements: { role: 'value' },
        context: { trigger: 'heartbeat_meeting_prep', internal: true }
      });

      const header = `Meeting prep: ${event.summary}\nTime: ${event.start}\n\n`;
      return header + (result.result || result.content || result.text || String(result));
    } catch (err) {
      console.error('[MeetingPrep] Synthesis failed:', err.message);
      return null;
    }
  }

  /**
   * Reset daily state (called at day boundary).
   */
  resetDaily() {
    this.preparedMeetings.clear();
  }
}

module.exports = { MeetingPreparer };
