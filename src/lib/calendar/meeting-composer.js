/**
 * MeetingComposer — Multi-Turn State Machine for Meeting Creation
 *
 * Architecture Brief:
 * -------------------
 * Problem: Creating a calendar meeting from natural language requires multiple
 * conversation turns: parsing intent, resolving contacts, checking availability,
 * human-in-the-loop confirmation, and finally creating the event with invitations.
 * Each step may pause for user input, so state must survive across messages.
 *
 * Pattern: In-memory state machine with per-user sessions. Each session tracks
 * its current state (PARSING through DONE/CANCELLED) and accumulated data.
 * The process() entry point resumes the correct handler based on session state.
 * Sessions auto-expire after 30 minutes of inactivity and are cleaned up
 * 5 minutes after reaching a terminal state.
 *
 * Key Dependencies:
 *   - src/lib/integrations/contacts-client.js (resolve — name to contact)
 *   - src/lib/integrations/caldav-client.js (checkAvailability, scheduleMeeting)
 *   - src/lib/integrations/deck-client.js (listBoards, getStacks, createCardOnBoard)
 *   - src/lib/handlers/email-handler.js (sendWithIcal — external invitations)
 *   - src/lib/integrations/rsvp-tracker.js (trackEvent — monitor responses)
 *   - src/lib/llm/router.js (JOBS, route — natural language parsing)
 *
 * Data Flow:
 *   process(message, userId, conversationToken)
 *     -> _startNew() [LLM: extract title, participants, time, duration]
 *     -> _advanceState()
 *       -> RESOLVING: contacts.resolve() per participant, pause on ambiguity
 *       -> CHECKING: calendar.checkAvailability(), surface conflicts
 *       -> REVIEWING: _formatSummary() -> HITL confirmation
 *       -> CONFIRMED -> CREATING: _createAndInvite()
 *         -> caldav.scheduleMeeting() + email externals + rsvp track + deck card
 *     -> DONE | CANCELLED
 *
 * Dependency Map:
 *   meeting-composer.js depends on: contacts-client, caldav-client, deck-client,
 *     email-handler, rsvp-tracker, llm/router
 *   Used by: message-router.js (meeting creation intents), calendar-handler.js
 *   Implementation order:
 *     1. Constructor + session management (process, cleanup)
 *     2. _startNew (LLM parsing)
 *     3. _advanceState — RESOLVING, CHECKING, REVIEWING
 *     4. _handleDisambiguation, _handleConfirmation
 *     5. _createAndInvite, _createTrackingCard
 *     6. Helpers (_formatSummary, _formatDateTime, _addMinutes)
 *
 * @module calendar/meeting-composer
 * @version 1.0.0
 */

'use strict';

const { JOBS } = require('../llm/router');
const boardRegistry = require('../integrations/deck-board-registry');
const { ROLES } = require('../integrations/deck-board-registry');

const STATES = Object.freeze({
  PARSING:    'PARSING',
  RESOLVING:  'RESOLVING',
  CHECKING:   'CHECKING',
  REVIEWING:  'REVIEWING',
  CONFIRMED:  'CONFIRMED',
  CREATING:   'CREATING',
  DONE:       'DONE',
  CANCELLED:  'CANCELLED'
});

const SESSION_TIMEOUT_MS  = 30 * 60 * 1000;  // 30 minutes
const CLEANUP_DELAY_MS    =  5 * 60 * 1000;  //  5 minutes

const YES_WORDS = ['yes', 'confirm', 'ja', 'sim', 'ok', 'go'];
const NO_WORDS  = ['no', 'cancel', 'nein', 'não', 'nao', 'abort'];

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
];

class MeetingComposer {
  /**
   * @param {Object} deps
   * @param {Object} deps.contactsClient  - ContactsClient instance
   * @param {Object} deps.caldavClient    - CalDAVClient instance
   * @param {Object} deps.deckClient      - DeckClient instance
   * @param {Object} deps.emailHandler    - EmailHandler instance (optional)
   * @param {Object} deps.rsvpTracker     - RsvpTracker instance (optional)
   * @param {Object} deps.llmRouter       - LLM router instance
   * @param {Function} deps.auditLog      - Audit logging function (optional)
   */
  constructor({ contactsClient, caldavClient, deckClient, emailHandler, rsvpTracker, llmRouter, auditLog } = {}) {
    if (!contactsClient) throw new Error('MeetingComposer: contactsClient is required');
    if (!caldavClient)   throw new Error('MeetingComposer: caldavClient is required');
    if (!llmRouter)      throw new Error('MeetingComposer: llmRouter is required');

    this.contacts = contactsClient;
    this.calendar = caldavClient;
    this.deck     = deckClient || null;
    this.email    = emailHandler || null;
    this.rsvpTracker = rsvpTracker || null;
    this.llm      = llmRouter;
    this.auditLog = auditLog || (() => {});

    /** @type {Map<string, Object>} userId:meeting -> session */
    this.sessions = new Map();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Entry point. Creates or resumes a meeting composition session.
   * @param {string} message - User message text
   * @param {string} userId  - Nextcloud user ID
   * @param {string} conversationToken - Talk conversation token
   * @returns {Promise<{reply: string, done: boolean}>}
   */
  async process(message, userId, conversationToken) {
    if (!message || typeof message !== 'string') {
      return { reply: 'No meeting request provided.', done: false };
    }
    if (!userId || typeof userId !== 'string') {
      throw new Error('MeetingComposer.process: userId is required');
    }

    this._cleanupExpired();

    const key = `${userId}:meeting`;
    const existing = this.sessions.get(key);

    if (!existing || existing.state === STATES.DONE || existing.state === STATES.CANCELLED) {
      return this._startNew(message, userId, conversationToken);
    }

    if (this._isExpired(existing)) {
      this.sessions.delete(key);
      return this._startNew(message, userId, conversationToken);
    }

    existing.lastActivity = Date.now();

    if (existing.state === STATES.RESOLVING && existing.pendingDisambiguation) {
      return this._handleDisambiguation(existing, message);
    }
    if (existing.state === STATES.REVIEWING) {
      return this._handleConfirmation(existing, message);
    }

    return this._advanceState(existing);
  }

  /**
   * Check whether a session is active for a given user.
   * @param {string} userId
   * @returns {boolean}
   */
  hasActiveSession(userId) {
    const session = this.sessions.get(`${userId}:meeting`);
    if (!session) return false;
    if (session.state === STATES.DONE || session.state === STATES.CANCELLED) return false;
    return !this._isExpired(session);
  }

  // ---------------------------------------------------------------------------
  // State transitions
  // ---------------------------------------------------------------------------

  /**
   * Parse natural language into meeting details and begin the flow.
   * @private
   */
  async _startNew(message, userId, conversationToken) {
    const today = new Date().toISOString().split('T')[0];

    const result = await this.llm.route({
      job: JOBS.QUICK,
      task: 'meeting_parse',
      content: message,
      system: `Extract meeting details from this request. Return JSON only.
{
  "title": "meeting subject or generate one",
  "participants": ["name1", "name2"],
  "start": "ISO 8601 datetime",
  "duration": minutes (number, default 60),
  "location": "location or null",
  "description": "notes or null"
}
Today is ${today}. Default timezone: Europe/Lisbon.
"Tomorrow" = the day after today. "Next Tuesday" = the next occurring Tuesday.
If time is ambiguous, assume business hours (09:00-18:00).`,
      requirements: { maxTokens: 300, format: 'json' }
    });

    const raw = result && (result.result || result.content);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      // Try to extract JSON from markdown fences
      const match = (raw || '').match(/```(?:json)?\s*([\s\S]*?)```/);
      if (match) {
        parsed = JSON.parse(match[1].trim());
      } else {
        return { reply: 'I could not understand the meeting details. Could you rephrase?', done: false };
      }
    }

    const duration = Number(parsed.duration) || 60;
    const startISO = parsed.start;

    // Guard against unparseable dates from LLM
    if (!startISO || isNaN(new Date(startISO).getTime())) {
      return { reply: 'I could not determine the meeting date and time. Please specify, e.g. "Tuesday at 2pm".', done: false };
    }

    const endISO   = this._addMinutes(startISO, duration);

    const session = {
      id: `meeting-${Date.now()}`,
      state: STATES.RESOLVING,
      userId,
      conversationToken,
      title:       parsed.title || 'Meeting',
      rawParticipants:      parsed.participants || [],
      resolvedParticipants: [],
      unresolvedParticipants: [],
      start:    startISO,
      end:      endISO,
      duration,
      location:    parsed.location || null,
      description: parsed.description || null,
      timezone:    'Europe/Lisbon',
      conflicts:   [],
      pendingDisambiguation: null,
      resolveIndex: 0,
      lastActivity: Date.now(),
      createdAt:    Date.now()
    };

    this.sessions.set(`${userId}:meeting`, session);
    return this._advanceState(session);
  }

  /**
   * Drive the session forward through states sequentially.
   * @private
   */
  async _advanceState(session) {
    // --- RESOLVING ---
    if (session.state === STATES.RESOLVING) {
      while (session.resolveIndex < session.rawParticipants.length) {
        const name = session.rawParticipants[session.resolveIndex];

        // Direct email — skip resolution
        if (name && name.includes('@')) {
          session.resolvedParticipants.push({ name, email: name, type: 'external' });
          session.resolveIndex++;
          continue;
        }

        const result = await this.contacts.resolve(name);

        if (result.resolved) {
          session.resolvedParticipants.push({
            name: result.contact.name || name,
            email: result.contact.email,
            type: 'nextcloud'
          });
          session.resolveIndex++;
          continue;
        }

        if (result.options && result.options.length > 0) {
          session.pendingDisambiguation = {
            originalName: name,
            options: result.options
          };
          const lines = result.options.map((c, i) =>
            `  ${i + 1}. ${c.name}${c.email ? ` (${c.email})` : ''}${c.org ? ` — ${c.org}` : ''}`
          );
          return {
            reply: `Multiple contacts match "${name}":\n${lines.join('\n')}\n\nWhich one? (number, name, or provide an email)`,
            done: false
          };
        }

        // No match
        session.unresolvedParticipants.push(name);
        session.resolveIndex++;
      }

      // Note unresolved participants but don't block — fall through to checking
      if (session.unresolvedParticipants.length > 0) {
        session._unresolvedNote = session.unresolvedParticipants.join(', ');
        session.unresolvedParticipants = [];
      }

      session.state = STATES.CHECKING;
    }

    // --- CHECKING ---
    if (session.state === STATES.CHECKING) {
      const availability = await this.calendar.checkAvailability(
        new Date(session.start),
        new Date(session.end)
      );

      session.conflicts = availability.conflicts || [];
      session.state = STATES.REVIEWING;

      let notes = '';
      if (session._unresolvedNote) {
        notes += `\n\n_Could not find contacts for: ${session._unresolvedNote}. You can add them later._`;
        delete session._unresolvedNote;
      }
      if (!availability.isFree) {
        const conflictLines = session.conflicts.map(c =>
          `  - ${c.summary} (${this._formatTime(c.start)}–${this._formatTime(c.end)})`
        );
        notes += `\n\n**Conflict warning:**\n${conflictLines.join('\n')}`;
      }

      return {
        reply: this._formatSummary(session) + notes + '\n\nConfirm? (yes/no)',
        done: false
      };
    }

    // --- CONFIRMED -> CREATING ---
    if (session.state === STATES.CONFIRMED) {
      session.state = STATES.CREATING;
      try {
        const resultMsg = await this._createAndInvite(session);
        session.state = STATES.DONE;
        return { reply: resultMsg, done: true };
      } catch (err) {
        session.state = STATES.CANCELLED;
        return {
          reply: `Meeting creation failed: ${err.message}`,
          done: true
        };
      }
    }

    return { reply: 'Session in unexpected state. Please start over.', done: true };
  }

  // ---------------------------------------------------------------------------
  // User response handlers
  // ---------------------------------------------------------------------------

  /**
   * Handle disambiguation when multiple contacts match a name.
   * @private
   */
  async _handleDisambiguation(session, message) {
    const pending = session.pendingDisambiguation;
    if (!pending) return this._advanceState(session);

    const trimmed = (message || '').trim();
    const asNum = parseInt(trimmed, 10);

    let selected = null;

    // Number selection
    if (!isNaN(asNum) && asNum >= 1 && asNum <= pending.options.length) {
      selected = pending.options[asNum - 1];
    }

    // Email provided directly
    if (!selected && trimmed.includes('@')) {
      selected = { name: pending.originalName, email: trimmed };
      session.resolvedParticipants.push({ name: selected.name, email: selected.email, type: 'external' });
      session.pendingDisambiguation = null;
      session.resolveIndex++;
      return this._advanceState(session);
    }

    // Name match
    if (!selected) {
      const lower = trimmed.toLowerCase();
      selected = pending.options.find(c =>
        (c.name || '').toLowerCase().includes(lower)
      );
    }

    if (!selected) {
      const lines = pending.options.map((c, i) =>
        `  ${i + 1}. ${c.name}${c.email ? ` (${c.email})` : ''}`
      );
      return {
        reply: `I didn't understand. Please pick a number or provide an email:\n${lines.join('\n')}`,
        done: false
      };
    }

    session.resolvedParticipants.push({
      name: selected.name,
      email: selected.email,
      type: 'nextcloud'
    });
    session.pendingDisambiguation = null;
    session.resolveIndex++;
    return this._advanceState(session);
  }

  /**
   * Handle yes/no confirmation at the REVIEWING state.
   * @private
   */
  async _handleConfirmation(session, message) {
    const word = (message || '').trim().toLowerCase().split(/\s+/)[0];

    if (YES_WORDS.includes(word)) {
      session.state = STATES.CONFIRMED;
      return this._advanceState(session);
    }

    if (NO_WORDS.includes(word)) {
      session.state = STATES.CANCELLED;
      return { reply: 'Meeting cancelled.', done: true };
    }

    return {
      reply: 'Please confirm (yes/ok/sim) or cancel (no/nein/abort).',
      done: false
    };
  }

  // ---------------------------------------------------------------------------
  // Creation
  // ---------------------------------------------------------------------------

  /**
   * Create the calendar event, send invitations, set up tracking.
   * @private
   */
  async _createAndInvite(session) {
    const attendeeEmails = session.resolvedParticipants.map(p => p.email);

    // Organizer email: userId@NC domain or fall back to userId
    let organizerEmail = session.userId;
    if (!organizerEmail.includes('@')) {
      let host = 'localhost';
      try {
        const ncUrl = this.calendar.ncUrl || this.calendar.baseUrl || '';
        if (ncUrl) host = new URL(ncUrl).hostname;
      } catch { /* keep localhost */ }
      organizerEmail = `${session.userId}@${host}`;
    }

    const eventResult = await this.calendar.scheduleMeeting({
      summary:   session.title,
      start:     new Date(session.start),
      end:       new Date(session.end),
      attendees: attendeeEmails,
      organizerEmail,
      location:    session.location,
      description: session.description
    });

    // Send iCal invitations to external participants
    const externals = session.resolvedParticipants.filter(p => p.type === 'external');
    if (externals.length > 0 && this.email) {
      for (const ext of externals) {
        try {
          if (typeof this.email.sendWithIcal === 'function') {
            await this.email.sendWithIcal({
              to: ext.email,
              subject: `Meeting invitation: ${session.title}`,
              body: `You are invited to "${session.title}" on ${this._formatDateTime(session.start)}.`,
              icalData: eventResult.icalString || null,
              method: 'REQUEST'
            });
          } else {
            await this.email.send({
              to: ext.email,
              subject: `Meeting invitation: ${session.title}`,
              body: `You are invited to "${session.title}" on ${this._formatDateTime(session.start)}.\nLocation: ${session.location || 'TBD'}`
            });
          }
        } catch (err) {
          // Email failure should not block meeting creation
          this.auditLog('meeting_email_failed', { to: ext.email, error: err.message });
        }
      }
    }

    // RSVP tracking
    if (this.rsvpTracker && attendeeEmails.length > 0) {
      try {
        const attendeesForTracking = session.resolvedParticipants.map(p => ({
          email: p.email,
          name: p.name
        }));
        this.rsvpTracker.trackEvent(
          eventResult.uid,
          eventResult.calendarId,
          attendeesForTracking,
          session.title,
          session.end
        );
      } catch (err) {
        this.auditLog('meeting_rsvp_track_failed', { error: err.message });
      }
    }

    // Deck tracking card (graceful failure)
    await this._createTrackingCard(session, eventResult).catch(err => {
      this.auditLog('meeting_deck_card_failed', { error: err.message });
    });

    this.auditLog('meeting_created', {
      uid: eventResult.uid,
      title: session.title,
      participants: attendeeEmails.length,
      externals: externals.length
    });

    return `Meeting "${session.title}" created for ${this._formatDateTime(session.start)}–${this._formatTime(session.end)} with ${attendeeEmails.length} participant(s).`;
  }

  /**
   * Create a Deck card to track the meeting status.
   * @private
   */
  async _createTrackingCard(session, eventResult) {
    if (!this.deck) return null;

    const boardId = await boardRegistry.resolveBoard(this.deck, ROLES.meetings, 'Pending Meetings');
    if (!boardId) return null;

    // Fetch full board to get stacks — note: we already have the ID from registry
    const board = { id: boardId };

    const fullBoard = await this.deck.getBoard(board.id);
    const stacks = fullBoard.stacks || [];
    let targetStack = stacks.find(s => s.title === 'Invited');
    if (!targetStack) {
      targetStack = stacks[0];
    }
    if (!targetStack) return null;

    const participantList = session.resolvedParticipants
      .map(p => `- ${p.name} (${p.email})`)
      .join('\n');

    const description = [
      `**Date:** ${this._formatDateTime(session.start)}–${this._formatTime(session.end)}`,
      session.location ? `**Location:** ${session.location}` : null,
      `**Participants:**\n${participantList}`,
      `**Calendar UID:** ${eventResult.uid}`,
      `**RSVP Status:** Awaiting responses`
    ].filter(Boolean).join('\n');

    return this.deck.createCardOnBoard(board.id, targetStack.id, session.title, { description });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Format a meeting summary for HITL review.
   * @private
   */
  _formatSummary(session) {
    const parts = session.resolvedParticipants.map(p => {
      const icon = p.type === 'external' ? '\uD83D\uDCE7' : '\uD83D\uDFE2';
      const label = p.type === 'external' ? 'Email' : 'NC';
      return `  ${icon} ${label} ${p.name} (${p.email})`;
    });

    const lines = [
      `\uD83D\uDCC5 **${session.title}**`,
      `\uD83D\uDD50 ${this._formatDateTime(session.start)}\u2013${this._formatTime(session.end)}`
    ];
    if (session.location) {
      lines.push(`\uD83D\uDCCD ${session.location}`);
    }
    lines.push('', '**Participants:**');
    lines.push(...parts);

    return lines.join('\n');
  }

  /**
   * Format ISO string to HH:MM.
   * @private
   */
  _formatTime(isoString) {
    const d = new Date(isoString);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  /**
   * Format ISO string to "Tue, Mar 25 14:00".
   * @private
   */
  _formatDateTime(isoString) {
    const d = new Date(isoString);
    const day = DAY_NAMES[d.getDay()];
    const month = MONTH_NAMES[d.getMonth()];
    const date = d.getDate();
    const time = this._formatTime(isoString);
    return `${day}, ${month} ${date} ${time}`;
  }

  /**
   * Add minutes to an ISO datetime string.
   * @private
   */
  _addMinutes(isoString, minutes) {
    const d = new Date(isoString);
    d.setMinutes(d.getMinutes() + (Number(minutes) || 0));
    return d.toISOString();
  }

  /**
   * Check whether a session has expired.
   * @private
   */
  _isExpired(session) {
    return (Date.now() - (session.lastActivity || session.createdAt)) > SESSION_TIMEOUT_MS;
  }

  /**
   * Remove terminal and expired sessions.
   * @private
   */
  _cleanupExpired() {
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      const terminal = session.state === STATES.DONE || session.state === STATES.CANCELLED;
      if (terminal && (now - (session.lastActivity || session.createdAt)) > CLEANUP_DELAY_MS) {
        this.sessions.delete(key);
        continue;
      }
      if (this._isExpired(session)) {
        this.sessions.delete(key);
      }
    }
  }
}

MeetingComposer.STATES = STATES;

module.exports = MeetingComposer;
