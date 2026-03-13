/*
 * Moltagent - Sovereign AI Security Layer
 * Copyright (C) 2026 Moltagent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * DateCoordinator — Three-Tier Meeting Scheduling Workflow
 *
 * Architecture Brief:
 * -------------------
 * Problem: Multi-participant meeting scheduling requires coordination across
 * three visibility tiers (internal NC users with full calendar access,
 * freelancers with subscribed calendars, external contacts via email only).
 * By the time an external participant receives a proposal, every slot must
 * be pre-validated against all internal and freelancer calendars.
 *
 * Pattern: Workflow orchestrator (not an executor). Maintains in-memory state
 * across conversation turns and heartbeat cycles. Delegates to CalDAVClient,
 * EmailHandler, DeckClient, ContactsClient, and LLM router as tools.
 * Uses HITL confirmation before sending proposal emails. Tier 3 creates
 * tentative calendar blocks and a Deck tracking card while awaiting replies.
 *
 * Key Dependencies:
 *   - src/lib/integrations/caldav-client.js (getEvents, createEvent, deleteEvent, scheduleMeeting, getCalendars)
 *   - src/lib/integrations/contacts-client.js (search, resolve)
 *   - src/lib/handlers/email-handler.js (handleDraftEmail, confirmSendEmail)
 *   - src/lib/integrations/deck-client.js (createCard, moveCard, addComment)
 *   - src/lib/llm/router.js (JOBS, route)
 *   - src/lib/nc-request-manager.js (getUserEmail)
 *   - src/lib/talk/talk-send-queue.js (enqueue)
 *   - src/lib/integrations/rsvp-tracker.js (trackEvent)
 *   - src/lib/config.js (timezone, quietHours)
 *
 * Data Flow:
 *   initiateMeeting(request, session)
 *     -> _parseRequest() [LLM: extract participants, title, duration, timeframe]
 *     -> _resolveParticipants() [contacts + NC user lookup -> tier classification]
 *     -> _runTierFlow()
 *       -> TIER 1: _findFreeSlots() across internal NC calendars
 *       -> TIER 2: _narrowSlots() against freelancer subscribed calendars
 *       -> Block tentative slots on organizer calendar
 *       -> TIER 3: _draftProposalEmail() [LLM synthesis] -> HITL confirmation
 *     -> handleReply(email, meetingId) [LLM: parse chosen slot]
 *     -> _finalizeMeeting() -> CalDAV scheduleMeeting + release tentatives
 *
 * Dependency Map:
 *   date-coordinator.js depends on: caldav-client, contacts-client, email-handler,
 *     deck-client, llm/router, nc-request-manager, talk-send-queue, rsvp-tracker, config
 *   Used by: message-router.js (meeting scheduling intents), heartbeat-manager.js (reply monitoring)
 *   Implementation order:
 *     1. _parseRequest (LLM extraction)
 *     2. _findNCUser, _findSubscribedCalendar, _findEmail (resolution helpers)
 *     3. _resolveParticipants (tier classification)
 *     4. _findFreeSlots, _narrowSlots (calendar intersection)
 *     5. _formatSlotOptions, _draftProposalEmail (proposal generation)
 *     6. _runTierFlow (orchestration)
 *     7. handleReply, _finalizeMeeting, _finalizeDirectly (completion)
 *     8. _createTrackingCard, _getOrganizerCalendar (support methods)
 *
 * @module workflows/date-coordinator
 * @version 1.0.0
 */

'use strict';

const appConfig = require('../config');
const { JOBS } = require('../llm/router');

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/** Meeting state machine states */
const MEETING_STATES = Object.freeze({
  TIER1_CHECKING: 'TIER1_CHECKING',
  TIER2_CHECKING: 'TIER2_CHECKING',
  TIER3_PROPOSING: 'TIER3_PROPOSING',
  TIER3_HITL: 'TIER3_HITL',
  TIER3_WAITING: 'TIER3_WAITING',
  FINALIZING: 'FINALIZING',
  DONE: 'DONE',
  FAILED: 'FAILED',
});

/** Participant tier classification */
const TIERS = Object.freeze({
  INTERNAL: 1,    // NC user with full calendar access
  FREELANCER: 2,  // Subscribed calendar (read-only visibility)
  EXTERNAL: 3,    // Email only, no calendar visibility
});

/** Default business hours */
const DEFAULT_BUSINESS_START = 9;
const DEFAULT_BUSINESS_END = 17;

/** Default meeting duration in minutes */
const DEFAULT_DURATION_MINUTES = 60;

/** Maximum candidate slots to propose to externals */
const MAX_PROPOSAL_SLOTS = 3;

/** Slot-finding cursor increment in minutes */
const SLOT_INCREMENT_MINUTES = 30;

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * @typedef {Object} MeetingRequest
 * @property {string} message - Raw user message requesting the meeting
 * @property {string} [language] - Detected language (de, en, pt)
 */

/**
 * @typedef {Object} MeetingSession
 * @property {string} userId - NC user ID of the organizer
 * @property {string} token - Talk room token for notifications
 * @property {number} [messageId] - Talk message ID for reply threading
 */

/**
 * @typedef {Object} ParsedMeetingRequest
 * @property {string} title - Meeting title
 * @property {string[]} participants - Participant names as mentioned by user
 * @property {number} duration - Duration in minutes
 * @property {{start: Date, end: Date}} timeframe - Date range to search for slots
 * @property {string} [location] - Meeting location if specified
 * @property {string} [description] - Meeting description if specified
 * @property {string} language - Detected language of the request
 */

/**
 * @typedef {Object} ResolvedParticipant
 * @property {string} name - Display name
 * @property {number} tier - 1 (internal), 2 (freelancer), 3 (external)
 * @property {'internal'|'freelancer'|'external'} type - Participant type
 * @property {string|null} userId - NC user ID (tier 1 only)
 * @property {string|null} email - Email address (all tiers, may be null for external)
 * @property {string|null} calendarId - Calendar ID for CalDAV queries (tier 1, 2)
 */

/**
 * @typedef {Object} CandidateSlot
 * @property {Date} start - Slot start time
 * @property {Date} end - Slot end time
 * @property {string} day - Localized day name (e.g. "Dienstag")
 * @property {string} time - Formatted time (e.g. "14:00")
 * @property {number} durationMinutes - Duration in minutes
 */

/**
 * @typedef {Object} MeetingState
 * @property {string} id - Unique meeting ID (meeting-{timestamp})
 * @property {string} state - Current state from MEETING_STATES
 * @property {string} title - Meeting title
 * @property {number} duration - Duration in minutes
 * @property {{start: Date, end: Date}} timeframe - Search range
 * @property {string} organizerUserId - NC user ID of organizer
 * @property {ResolvedParticipant[]} participants - All resolved participants
 * @property {CandidateSlot[]} candidateSlots - Top candidate slots (max 3)
 * @property {CandidateSlot|null} confirmedSlot - The final confirmed slot
 * @property {Array<{uid: string, calendarId: string}>} tentativeEvents - Tentative block event refs
 * @property {string|null} deckCardId - Deck card ID for tracking
 * @property {Date|null} proposalSentAt - When the proposal email was sent
 * @property {string} [language] - Language for communications
 */

/**
 * @typedef {Object} DateCoordinatorResult
 * @property {string} response - User-facing response message
 * @property {MeetingState} [meeting] - Current meeting state
 * @property {boolean} [requiresConfirmation] - Whether HITL approval is needed
 * @property {string} [confirmationType] - Type of confirmation ('send_proposal')
 * @property {Object} [pendingAction] - Pending action data for confirmation handler
 * @property {string} [needsInfo] - Type of missing info ('emails')
 * @property {boolean} [needsDecision] - Whether user decision is needed (counter-proposal)
 */

// -----------------------------------------------------------------------------
// DateCoordinator
// -----------------------------------------------------------------------------

class DateCoordinator {
  /**
   * @param {Object} deps
   * @param {import('../integrations/caldav-client')} deps.caldavClient
   * @param {import('../integrations/contacts-client')} deps.contactsClient
   * @param {import('../handlers/email-handler')} deps.emailHandler
   * @param {import('../integrations/deck-client')} deps.deckClient
   * @param {import('../llm/router')} deps.llmRouter
   * @param {import('../nc-request-manager')} deps.ncRequestManager
   * @param {import('../talk/talk-send-queue')} [deps.talkSendQueue]
   * @param {import('../talk/talk-send-queue')} [deps.talkClient]
   * @param {import('../integrations/rsvp-tracker')} [deps.rsvpTracker]
   * @param {Object} [deps.logger=console]
   */
  constructor({
    caldavClient,
    contactsClient,
    emailHandler,
    deckClient,
    llmRouter,
    ncRequestManager,
    talkSendQueue,
    talkClient,
    rsvpTracker,
    logger,
  }) {
    if (!caldavClient) throw new Error('DateCoordinator requires caldavClient');
    if (!contactsClient) throw new Error('DateCoordinator requires contactsClient');
    if (!emailHandler) throw new Error('DateCoordinator requires emailHandler');
    if (!deckClient) throw new Error('DateCoordinator requires deckClient');
    if (!llmRouter) throw new Error('DateCoordinator requires llmRouter');
    if (!ncRequestManager) throw new Error('DateCoordinator requires ncRequestManager');

    const resolvedTalkClient = talkSendQueue || talkClient;
    if (!resolvedTalkClient) throw new Error('DateCoordinator requires talkSendQueue or talkClient');

    this.caldavClient = caldavClient;
    this.contactsClient = contactsClient;
    this.emailHandler = emailHandler;
    this.deckClient = deckClient;
    this.llmRouter = llmRouter;
    this.nc = ncRequestManager;
    this.talkQueue = resolvedTalkClient;
    this.rsvpTracker = rsvpTracker || null;
    this.logger = logger || console;

    /** @type {Map<string, MeetingState>} */
    this.activeMeetings = new Map();
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Entry point: user requests a meeting.
   *
   * @param {MeetingRequest} request
   * @param {MeetingSession} session
   * @returns {Promise<DateCoordinatorResult>}
   */
  async initiateMeeting(request, session) {
    let meeting = null;
    try {
      const parsed = await this._parseRequest(request);
      const participants = await this._resolveParticipants(parsed.participants || []);

      const meetingId = `meeting-${Date.now()}`;
      meeting = {
        id: meetingId,
        state: MEETING_STATES.TIER1_CHECKING,
        title: parsed.title || 'Besprechung',
        duration: parsed.duration || DEFAULT_DURATION_MINUTES,
        timeframe: parsed.timeframe,
        organizerUserId: session && session.userId ? session.userId : 'organizer',
        participants,
        candidateSlots: [],
        confirmedSlot: null,
        tentativeEvents: [],
        deckCardId: null,
        proposalSentAt: null,
        language: parsed.language || 'de',
        session: session || {},
      };
      this.activeMeetings.set(meetingId, meeting);

      return await this._runTierFlow(meeting);
    } catch (err) {
      this.logger.error('DateCoordinator.initiateMeeting failed:', err);
      if (meeting) meeting.state = MEETING_STATES.FAILED;
      return {
        response: `Fehler beim Planen des Termins: ${err.message}`,
        meeting,
      };
    }
  }

  /**
   * Called when an external participant replies to a proposal email.
   *
   * @param {Object} email
   * @param {string|MeetingState} meetingId - meeting ID string or meeting object
   * @returns {Promise<DateCoordinatorResult>}
   */
  async handleReply(email, meetingId) {
    if (!email) {
      return { response: 'Keine E-Mail zum Verarbeiten erhalten.' };
    }

    // Accept a meeting object directly (test convenience)
    let meeting;
    if (meetingId && typeof meetingId === 'object' && meetingId.id) {
      meeting = meetingId;
      if (!this.activeMeetings.has(meeting.id)) {
        this.activeMeetings.set(meeting.id, meeting);
      }
      meetingId = meeting.id;
    } else {
      meeting = this.activeMeetings.get(meetingId);
    }

    if (!meeting) {
      return { response: `Kein aktives Meeting mit ID ${meetingId} gefunden.` };
    }
    if (meeting.state !== MEETING_STATES.TIER3_WAITING) {
      return {
        response: `Meeting ${meetingId} erwartet keine Antwort (Status: ${meeting.state}).`,
      };
    }

    const slotSummary = (meeting.candidateSlots || [])
      .map((s, i) => `${i}: ${s.day || ''} ${s.time || ''}`)
      .join(', ');

    const prompt = `Analysiere diese E-Mail-Antwort auf einen Terminvorschlag.

Vorgeschlagene Slots (Index: Beschreibung):
${slotSummary}

E-Mail:
"""
${email.body || ''}
"""

Antworte ausschliesslich mit JSON:
{ "slotIndex": <Zahl oder null>, "confirmed": <true/false>, "counterProposal": <String oder null> }`;

    let choice;
    try {
      const result = await this.llmRouter.route({
        job: JOBS.QUICK,
        task: 'parse_reply',
        content: prompt,
        maxTokens: 200,
      });
      const raw = result && (result.result || result.content);
      choice = JSON.parse(raw);
    } catch (err) {
      this.logger.warn('handleReply: LLM parse failed:', err.message);
      return {
        response: `Antwort von ${email.from || 'Teilnehmer'} konnte nicht interpretiert werden: "${(email.body || '').slice(0, 100)}"`,
        meeting,
      };
    }

    if (choice.counterProposal) {
      return {
        response: `${email.from || 'Der Teilnehmer'} schlägt einen anderen Termin vor: "${choice.counterProposal}". Bitte entscheide, wie weiter vorgegangen werden soll.`,
        meeting,
        needsDecision: true,
        counterProposal: choice.counterProposal,
      };
    }

    if (choice.confirmed && Number.isFinite(choice.slotIndex)) {
      const confirmedSlot = (meeting.candidateSlots || [])[choice.slotIndex];
      if (!confirmedSlot) {
        return {
          response: `Ungültiger Slot-Index ${choice.slotIndex} in Antwort von ${email.from}.`,
          meeting,
        };
      }
      return await this._finalizeMeeting(meeting, confirmedSlot);
    }

    return {
      response: `Antwort von ${email.from || 'Teilnehmer'} ist unklar: "${(email.body || '').slice(0, 100)}"`,
      meeting,
    };
  }

  /**
   * Retrieve a meeting state by ID.
   * @param {string} meetingId
   * @returns {MeetingState|undefined}
   */
  getMeeting(meetingId) {
    return this.activeMeetings.get(meetingId);
  }

  /**
   * Get all meetings currently in TIER3_WAITING state.
   * @returns {Array<MeetingState>}
   */
  getWaitingMeetings() {
    const waiting = [];
    for (const meeting of this.activeMeetings.values()) {
      if (meeting.state === MEETING_STATES.TIER3_WAITING) {
        waiting.push(meeting);
      }
    }
    return waiting;
  }

  /**
   * Heartbeat hook: scan inboxes for replies to waiting meetings.
   * For meetings waiting > 24h without reply, returns reminder suggestions.
   *
   * @returns {Promise<Array<{meetingId: string, action: string, result: *}>>}
   */
  async checkMeetingReplies() {
    const waiting = this.getWaitingMeetings();
    const outcomes = [];

    for (const meeting of waiting) {
      try {
        const externals = (meeting.participants || []).filter(p => p.tier === TIERS.EXTERNAL);
        const repliesFound = [];

        for (const participant of externals) {
          if (!participant.email) continue;
          const emails = await this.emailHandler.searchInbox({
            from: participant.email,
            since: meeting.proposalSentAt || new Date(0),
            subject: meeting.title,
          });
          for (const replyEmail of (emails || [])) {
            repliesFound.push({ replyEmail, participant });
          }
        }

        if (repliesFound.length > 0) {
          const { replyEmail, participant } = repliesFound[0];
          const result = await this.handleReply(
            {
              from: participant.name,
              fromAddress: participant.email,
              body: replyEmail.body,
              subject: replyEmail.subject,
            },
            meeting.id
          );
          outcomes.push({ meetingId: meeting.id, action: 'reply_handled', result });
        } else {
          const sentAt = meeting.proposalSentAt ? new Date(meeting.proposalSentAt).getTime() : 0;
          const hoursSince = (Date.now() - sentAt) / (60 * 60 * 1000);
          if (hoursSince > 24) {
            const externalNames = externals.map(p => p.name).join(', ');
            outcomes.push({
              meetingId: meeting.id,
              action: 'reminder_suggested',
              result: {
                response: `Keine Antwort von ${externalNames} seit mehr als 24 Stunden. Soll eine Erinnerung gesendet werden?`,
                meeting,
                reminderSuggested: true,
              },
            });
          } else {
            outcomes.push({ meetingId: meeting.id, action: 'no_reply_yet', result: null });
          }
        }
      } catch (err) {
        this.logger.error(`checkMeetingReplies: error for ${meeting.id}:`, err);
        outcomes.push({ meetingId: meeting.id, action: 'error', result: { error: err.message } });
      }
    }

    return outcomes;
  }

  // ===========================================================================
  // Core Flow
  // ===========================================================================

  /**
   * Parse a natural language meeting request via LLM.
   *
   * @param {MeetingRequest} request
   * @returns {Promise<ParsedMeetingRequest>}
   * @private
   */
  async _parseRequest(request) {
    const timezone = (appConfig && appConfig.timezone) || 'UTC';
    const today = new Date().toISOString().slice(0, 10);

    const prompt = `Heute ist ${today} (Zeitzone: ${timezone}).
Extrahiere aus der folgenden Besprechungsanfrage strukturierte Daten als JSON.

Anfrage: "${request.message || ''}"

Antworte NUR mit gültigem JSON (kein Markdown):
{
  "title": "<Besprechungstitel>",
  "participants": ["<Name1>"],
  "duration": <Minuten als Zahl>,
  "timeframeDescription": "<z.B. 'nächste Woche'>",
  "location": "<Ort oder null>",
  "description": "<Beschreibung oder null>",
  "language": "<de|en|pt>"
}`;

    let parsed;
    try {
      const result = await this.llmRouter.route({
        job: JOBS.QUICK,
        task: 'parse_meeting_request',
        content: prompt,
        maxTokens: 500,
      });
      const raw = result && (result.result || result.content);
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Konnte Besprechungsanfrage nicht parsen: ${err.message}`);
    }

    const timeframe = await this._resolveTimeframe(
      parsed.timeframeDescription || 'next week',
      parsed.language || 'de'
    );

    return {
      title: parsed.title || 'Besprechung',
      participants: Array.isArray(parsed.participants) ? parsed.participants : [],
      duration: Number.isFinite(parsed.duration) && parsed.duration > 0
        ? parsed.duration
        : DEFAULT_DURATION_MINUTES,
      timeframe,
      location: parsed.location || null,
      description: parsed.description || null,
      language: parsed.language || 'de',
    };
  }

  /**
   * Resolve a timeframe description to a {start, end} Date pair.
   *
   * @param {string} description
   * @param {string} language
   * @returns {Promise<{start: Date, end: Date}>}
   * @private
   */
  async _resolveTimeframe(description, language) {
    const now = new Date();
    const desc = (description || '').toLowerCase();

    if (desc.includes('tomorrow') || desc.includes('morgen')) {
      const d = new Date(now);
      d.setDate(d.getDate() + 1);
      d.setHours(DEFAULT_BUSINESS_START, 0, 0, 0);
      const end = new Date(d);
      end.setHours(DEFAULT_BUSINESS_END, 0, 0, 0);
      return { start: d, end };
    }

    if (
      desc.includes('next week') ||
      desc.includes('nächste woche') ||
      desc.includes('proxima semana')
    ) {
      const monday = new Date(now);
      const dow = monday.getDay();
      const daysUntilMonday = dow === 0 ? 1 : (8 - dow) % 7 || 7;
      monday.setDate(monday.getDate() + daysUntilMonday);
      monday.setHours(DEFAULT_BUSINESS_START, 0, 0, 0);
      const friday = new Date(monday);
      friday.setDate(friday.getDate() + 4);
      friday.setHours(DEFAULT_BUSINESS_END, 0, 0, 0);
      return { start: monday, end: friday };
    }

    if (desc.includes('this week') || desc.includes('diese woche')) {
      const start = new Date(now);
      start.setHours(DEFAULT_BUSINESS_START, 0, 0, 0);
      const end = new Date(now);
      const daysToFri = (5 - end.getDay() + 7) % 7;
      end.setDate(end.getDate() + daysToFri);
      end.setHours(DEFAULT_BUSINESS_END, 0, 0, 0);
      return { start, end };
    }

    const isoMatch = description.match(/\d{4}-\d{2}-\d{2}/);
    if (isoMatch) {
      const d = new Date(isoMatch[0]);
      if (!isNaN(d.getTime())) {
        d.setHours(DEFAULT_BUSINESS_START, 0, 0, 0);
        const end = new Date(d);
        end.setHours(DEFAULT_BUSINESS_END, 0, 0, 0);
        return { start: d, end };
      }
    }

    // LLM fallback for complex expressions
    try {
      const result = await this.llmRouter.route({
        job: JOBS.QUICK,
        task: 'resolve_timeframe',
        content: `Convert "${description}" to JSON date range. Today: ${now.toISOString().slice(0, 10)}. Reply: {"start": "ISO8601", "end": "ISO8601"}`,
        maxTokens: 100,
      });
      const raw = result && (result.result || result.content);
      const tf = JSON.parse(raw);
      return { start: new Date(tf.start), end: new Date(tf.end) };
    } catch (err) {
      this.logger.warn(`[DateCoord] Timeframe LLM fallback failed: ${err.message}, defaulting to next week`);
      const monday = new Date(now);
      const dow = monday.getDay();
      const days = dow === 0 ? 1 : (8 - dow) % 7 || 7;
      monday.setDate(monday.getDate() + days);
      monday.setHours(DEFAULT_BUSINESS_START, 0, 0, 0);
      const friday = new Date(monday);
      friday.setDate(friday.getDate() + 4);
      friday.setHours(DEFAULT_BUSINESS_END, 0, 0, 0);
      return { start: monday, end: friday };
    }
  }

  /**
   * Resolve participant names to tier-classified entries.
   *
   * @param {string[]} names
   * @returns {Promise<ResolvedParticipant[]>}
   * @private
   */
  async _resolveParticipants(names) {
    const participants = [];
    for (const name of names) {
      const ncUser = await this._findNCUser(name);
      if (ncUser) {
        participants.push({
          name: ncUser.displayName || name,
          tier: TIERS.INTERNAL,
          type: 'internal',
          userId: ncUser.id,
          email: ncUser.email || null,
          calendarId: `${ncUser.id}-personal`,
        });
        continue;
      }

      const subscribedCal = await this._findSubscribedCalendar(name);
      if (subscribedCal) {
        const email = await this._findEmail(name);
        participants.push({
          name,
          tier: TIERS.FREELANCER,
          type: 'freelancer',
          userId: null,
          email,
          calendarId: subscribedCal.id,
        });
        continue;
      }

      const email = await this._findEmail(name);
      participants.push({
        name,
        tier: TIERS.EXTERNAL,
        type: 'external',
        userId: null,
        email,
        calendarId: null,
      });
    }
    return participants;
  }

  /**
   * Execute the three-tier flow.
   *
   * @param {MeetingState} meeting
   * @returns {Promise<DateCoordinatorResult>}
   * @private
   */
  async _runTierFlow(meeting) {
    // ── TIER 1 ──
    meeting.state = MEETING_STATES.TIER1_CHECKING;

    const organizerCalendar = await this._getOrganizerCalendar(meeting.organizerUserId);
    const tier1 = (meeting.participants || []).filter(p => p.tier === TIERS.INTERNAL);
    const tier1CalIds = [
      organizerCalendar,
      ...tier1.map(p => p.calendarId).filter(Boolean),
    ];

    let candidates = await this._findFreeSlots(tier1CalIds, meeting.timeframe, meeting.duration);

    if (candidates.length === 0) {
      return {
        response: `Keine freien Slots für "${meeting.title}" gefunden. Soll der Zeitraum erweitert oder ein Teilnehmer optional gemacht werden?`,
        meeting,
        noSlots: true,
      };
    }

    // ── TIER 2 ──
    meeting.state = MEETING_STATES.TIER2_CHECKING;

    const tier2 = (meeting.participants || []).filter(p => p.tier === TIERS.FREELANCER);
    if (tier2.length > 0) {
      const freelancerCalIds = tier2.map(p => p.calendarId).filter(Boolean);
      candidates = await this._narrowSlots(candidates, freelancerCalIds, meeting.duration);

      if (candidates.length === 0) {
        const names = tier2.map(p => p.name).join(', ');
        return {
          response: `${names} hat/haben in diesem Zeitraum keine Verfügbarkeit. Soll das Meeting ohne ${names} geplant werden?`,
          meeting,
          noSlots: true,
        };
      }
    }

    // ── Block tentative slots ──
    const topSlots = candidates.slice(0, MAX_PROPOSAL_SLOTS);
    meeting.candidateSlots = topSlots;

    for (const slot of topSlots) {
      try {
        const event = await this.caldavClient.createEvent({
          summary: `[TENTATIV] ${meeting.title}`,
          start: slot.start,
          end: slot.end,
          status: 'TENTATIVE',
          calendarId: organizerCalendar,
        });
        if (event && event.uid) {
          meeting.tentativeEvents.push({
            uid: event.uid,
            calendarId: event.calendarId || organizerCalendar,
          });
        }
      } catch (err) {
        this.logger.warn('_runTierFlow: failed to create tentative event:', err.message);
      }
    }

    // ── TIER 3 ──
    meeting.state = MEETING_STATES.TIER3_PROPOSING;

    const tier3 = (meeting.participants || []).filter(p => p.tier === TIERS.EXTERNAL);

    if (tier3.length === 0) {
      return await this._finalizeDirectly(meeting, topSlots[0]);
    }

    const missingEmail = tier3.find(p => !p.email);
    if (missingEmail) {
      return {
        response: `Ich benötige die E-Mail-Adresse von ${missingEmail.name}, um den Terminvorschlag zu versenden. Kannst du sie mir geben?`,
        meeting,
        needsInfo: 'emails',
        missingFor: missingEmail.name,
      };
    }

    const slotOptions = this._formatSlotOptions(topSlots);
    const emailDraft = await this._draftProposalEmail(meeting, tier3, slotOptions);

    await this._createTrackingCard(meeting);

    meeting.state = MEETING_STATES.TIER3_HITL;

    return {
      response: emailDraft,
      meeting,
      requiresConfirmation: true,
      confirmationType: 'send_proposal',
      pendingAction: {
        meetingId: meeting.id,
        action: 'send_proposal',
        draft: emailDraft,
        recipients: tier3.map(p => p.email),
      },
    };
  }

  // ===========================================================================
  // Calendar Slot Operations
  // ===========================================================================

  /**
   * Find free time slots across multiple calendars.
   *
   * @param {string[]} calendarIds
   * @param {{start: Date, end: Date}} timeframe
   * @param {number} durationMinutes
   * @returns {Promise<CandidateSlot[]>}
   * @private
   */
  async _findFreeSlots(calendarIds, timeframe, durationMinutes) {
    if (!calendarIds || calendarIds.length === 0) return [];
    if (!timeframe || !timeframe.start || !timeframe.end) return [];

    const duration = Number.isFinite(durationMinutes) && durationMinutes > 0
      ? durationMinutes
      : DEFAULT_DURATION_MINUTES;

    const busyPeriods = [];
    for (const calId of calendarIds) {
      try {
        const events = await this.caldavClient.getEvents(calId, timeframe.start, timeframe.end);
        for (const ev of (events || [])) {
          busyPeriods.push({ start: new Date(ev.start), end: new Date(ev.end) });
        }
      } catch (err) {
        this.logger.warn(`_findFreeSlots: error fetching ${calId}:`, err.message);
      }
    }

    busyPeriods.sort((a, b) => a.start - b.start);

    const businessStart = DEFAULT_BUSINESS_START;
    const businessEnd = DEFAULT_BUSINESS_END;
    const incrementMs = SLOT_INCREMENT_MINUTES * 60 * 1000;
    const durationMs = duration * 60 * 1000;

    const candidates = [];
    let cursor = new Date(timeframe.start);

    // Snap cursor to business hours start on the first day
    if (cursor.getUTCHours() < businessStart) {
      cursor.setUTCHours(businessStart, 0, 0, 0);
    }

    const tfEnd = new Date(timeframe.end);

    while (cursor < tfEnd) {
      const day = cursor.getUTCDay(); // 0=Sun, 6=Sat

      // Skip weekends
      if (day === 0 || day === 6) {
        cursor = new Date(cursor);
        cursor.setUTCDate(cursor.getUTCDate() + 1);
        cursor.setUTCHours(businessStart, 0, 0, 0);
        continue;
      }

      const cursorHourFrac = cursor.getUTCHours() + cursor.getUTCMinutes() / 60;

      if (cursorHourFrac < businessStart) {
        cursor.setUTCHours(businessStart, 0, 0, 0);
        continue;
      }

      if (cursorHourFrac >= businessEnd) {
        cursor = new Date(cursor);
        cursor.setUTCDate(cursor.getUTCDate() + 1);
        cursor.setUTCHours(businessStart, 0, 0, 0);
        continue;
      }

      const slotEnd = new Date(cursor.getTime() + durationMs);
      const slotEndHour = slotEnd.getUTCHours() + slotEnd.getUTCMinutes() / 60;

      if (slotEndHour > businessEnd) {
        cursor = new Date(cursor);
        cursor.setUTCDate(cursor.getUTCDate() + 1);
        cursor.setUTCHours(businessStart, 0, 0, 0);
        continue;
      }

      const hasConflict = busyPeriods.some(
        busy => cursor < busy.end && slotEnd > busy.start
      );

      if (!hasConflict) {
        candidates.push({
          start: new Date(cursor),
          end: new Date(slotEnd),
          day: _localDayName(cursor),
          time: _formatTime(cursor),
          durationMinutes: duration,
        });
      }

      cursor = new Date(cursor.getTime() + incrementMs);
    }

    return candidates;
  }

  /**
   * Narrow existing candidate slots against additional calendars.
   *
   * @param {CandidateSlot[]} candidates
   * @param {string[]} calendarIds
   * @param {number} durationMinutes
   * @returns {Promise<CandidateSlot[]>}
   * @private
   */
  async _narrowSlots(candidates, calendarIds, durationMinutes) {
    if (!candidates || candidates.length === 0) return [];
    if (!calendarIds || calendarIds.length === 0) return candidates;

    const minStart = candidates.reduce(
      (min, s) => (s.start < min ? s.start : min),
      candidates[0].start
    );
    const maxEnd = candidates.reduce(
      (max, s) => (s.end > max ? s.end : max),
      candidates[0].end
    );

    const busyPeriods = [];
    for (const calId of calendarIds) {
      try {
        const events = await this.caldavClient.getEvents(calId, minStart, maxEnd);
        for (const ev of (events || [])) {
          busyPeriods.push({ start: new Date(ev.start), end: new Date(ev.end) });
        }
      } catch (err) {
        this.logger.warn(`_narrowSlots: error fetching ${calId}:`, err.message);
      }
    }

    return candidates.filter(
      slot => !busyPeriods.some(busy => slot.start < busy.end && slot.end > busy.start)
    );
  }

  // ===========================================================================
  // Email Proposal
  // ===========================================================================

  /**
   * Draft a proposal email for external participants using LLM synthesis.
   *
   * @param {MeetingState} meeting
   * @param {ResolvedParticipant[]} externals
   * @param {string} slotOptions
   * @returns {Promise<string>}
   * @private
   */
  async _draftProposalEmail(meeting, externals, slotOptions) {
    const recipientNames = (externals || []).map(p => p.name).join(', ');
    const language = meeting.language || 'de';

    const prompt = `Schreibe eine kurze, professionelle E-Mail für einen Terminvorschlag.
Meeting: ${meeting.title}
Empfänger: ${recipientNames}
Verfügbare Zeiten:
${slotOptions}
Sprache: ${language}
Bitte den Empfänger, seinen bevorzugten Termin per Antwort mitzuteilen. Kurz und freundlich.`;

    try {
      const result = await this.llmRouter.route({
        job: JOBS.SYNTHESIS,
        task: 'email_draft',
        content: prompt,
        maxTokens: 500,
      });
      const text = result && (result.result || result.content);
      return text || this._fallbackEmailDraft(meeting, slotOptions);
    } catch (_) {
      return this._fallbackEmailDraft(meeting, slotOptions);
    }
  }

  /** @private */
  _fallbackEmailDraft(meeting, slotOptions) {
    return `Betreff: ${meeting.title}\n\nHallo,\n\nbitte wählen Sie einen der folgenden Termine:\n\n${slotOptions}\n\nMit freundlichen Grüßen`;
  }

  // ===========================================================================
  // Reply Handling and Finalization
  // ===========================================================================

  /**
   * Finalize a meeting after external participant confirms a slot.
   *
   * @param {MeetingState} meeting
   * @param {CandidateSlot} confirmedSlot
   * @returns {Promise<DateCoordinatorResult>}
   * @private
   */
  async _finalizeMeeting(meeting, confirmedSlot) {
    meeting.state = MEETING_STATES.FINALIZING;

    // Build attendees from participants
    const attendees = (meeting.participants || []).map(p => ({
      email: p.email || '',
      name: p.name,
      rsvp: p.tier === TIERS.EXTERNAL,
      partstat: p.tier <= TIERS.FREELANCER ? 'ACCEPTED' : 'NEEDS-ACTION',
    }));

    // Organizer info
    let organizerEmail = '';
    const organizerName = meeting.organizer ? meeting.organizer.name : '';
    try {
      organizerEmail = meeting.organizer && meeting.organizer.email
        ? meeting.organizer.email
        : await this.nc.getUserEmail(meeting.organizerUserId || '');
    } catch (_) {
      organizerEmail = `${meeting.organizerUserId || 'organizer'}@example.com`;
    }

    // Create final calendar event
    let finalEvent;
    try {
      finalEvent = await this.caldavClient.scheduleMeeting({
        summary: meeting.title,
        start: confirmedSlot.start,
        end: confirmedSlot.end,
        attendees,
        organizerEmail,
        organizerName,
        description: meeting.description || '',
        calendarId: meeting.organizerCalendar || 'personal',
      });
    } catch (err) {
      this.logger.error('_finalizeMeeting: scheduleMeeting failed:', err);
      meeting.state = MEETING_STATES.FAILED;
      return { response: `Fehler beim Erstellen des Kalendereintrags: ${err.message}`, meeting };
    }

    // Release tentative blocks — keep the one that corresponds to confirmedSlot
    const confirmedIndex = (meeting.candidateSlots || []).findIndex(
      s => s.start && confirmedSlot.start && s.start.getTime() === confirmedSlot.start.getTime()
    );
    for (let i = 0; i < (meeting.tentativeEvents || []).length; i++) {
      if (i === confirmedIndex) continue;
      const tent = meeting.tentativeEvents[i];
      try {
        await this.caldavClient.deleteEvent(tent.calendarId, tent.uid);
      } catch (err) {
        this.logger.warn('_finalizeMeeting: failed to delete tentative:', err.message);
      }
    }

    // Send confirmation email to tier 3 participants
    const tier3 = (meeting.participants || []).filter(p => p.tier === TIERS.EXTERNAL && p.email);
    for (const participant of tier3) {
      try {
        await this.emailHandler.confirmSendEmail({
          to: participant.email,
          subject: `Termin bestätigt: ${meeting.title}`,
          body: `Der Termin "${meeting.title}" wurde bestätigt für ${confirmedSlot.day || ''}, ${confirmedSlot.time || ''}.`,
          meetingId: meeting.id,
        }, meeting.organizerUserId);
      } catch (err) {
        this.logger.warn('_finalizeMeeting: failed to send confirmation email:', err.message);
      }
    }

    // RSVP tracking (optional)
    if (this.rsvpTracker && finalEvent && finalEvent.uid) {
      try {
        this.rsvpTracker.trackEvent(
          finalEvent.uid,
          finalEvent.calendarId || 'personal',
          attendees,
          meeting.title,
          confirmedSlot.end
        );
      } catch (_) { /* non-critical */ }
    }

    // Move Deck tracking card to Done
    if (meeting.deckCardId) {
      try {
        await this.deckClient.moveCard(meeting.deckCardId, 'Done');
      } catch (err) {
        this.logger.warn('_finalizeMeeting: failed to move deck card:', err.message);
      }
    }

    meeting.confirmedSlot = confirmedSlot;
    meeting.state = MEETING_STATES.DONE;

    // Talk notification
    const participantNames = (meeting.participants || []).map(p => p.name).join(', ');
    const talkMessage = `Termin bestätigt: "${meeting.title}" am ${confirmedSlot.day || ''}, ${confirmedSlot.time || ''}. Teilnehmer: ${participantNames}.`;

    try {
      const token = (meeting.session && meeting.session.token) || meeting.talkToken;
      if (token) {
        await this.talkQueue.sendMessage(token, talkMessage);
      }
    } catch (err) {
      this.logger.warn('_finalizeMeeting: failed to send Talk notification:', err.message);
    }

    return {
      response: talkMessage,
      meeting,
      title: meeting.title,
      time: `${confirmedSlot.day || ''}, ${confirmedSlot.time || ''}`,
      participants: participantNames,
    };
  }

  /**
   * Finalize a meeting directly when there are no external participants.
   *
   * @param {MeetingState} meeting
   * @param {CandidateSlot} slot
   * @returns {Promise<DateCoordinatorResult>}
   * @private
   */
  async _finalizeDirectly(meeting, slot) {
    const slotDesc = slot ? `${slot.day || ''}, ${slot.time || ''}` : 'unbekannt';
    return {
      response: `Soll ich die Besprechung "${meeting.title}" für ${slotDesc} im Kalender anlegen?`,
      meeting,
      requiresConfirmation: true,
      confirmationType: 'create_meeting',
      pendingAction: {
        meetingId: meeting.id,
        action: 'create_meeting',
        slot,
      },
    };
  }

  /**
   * Create a Deck card to track the waiting-for-reply state.
   *
   * @param {MeetingState} meeting
   * @returns {Promise<void>}
   * @private
   */
  async _createTrackingCard(meeting) {
    try {
      const tier3Names = (meeting.participants || [])
        .filter(p => p.tier === TIERS.EXTERNAL)
        .map(p => p.name)
        .join(', ');

      const slotList = (meeting.candidateSlots || [])
        .map((s, i) => `${i + 1}. ${s.day || ''}, ${s.time || ''}`)
        .join('\n');

      const description = [
        `Meeting: ${meeting.title}`,
        '',
        `Vorgeschlagene Zeiten:\n${slotList}`,
        '',
        `Warte auf Antwort von: ${tier3Names}`,
        `Vorschlag gesendet: ${new Date().toLocaleDateString('de-DE')}`,
      ].join('\n');

      const cardId = await this.deckClient.createCard('Waiting', {
        title: `Warte auf Antwort: ${meeting.title}`,
        description,
      });

      meeting.deckCardId = cardId;
    } catch (err) {
      this.logger.warn('_createTrackingCard: failed:', err.message);
    }
  }

  // ===========================================================================
  // Formatting
  // ===========================================================================

  /**
   * Format candidate slots as a numbered list.
   *
   * @param {CandidateSlot[]} slots
   * @returns {string}
   * @private
   */
  _formatSlotOptions(slots) {
    if (!slots || slots.length === 0) return '(keine Slots verfügbar)';
    return slots.map((slot, i) => {
      const endTime = slot.end ? _formatTime(slot.end) : '?';
      return `${i + 1}. ${slot.day || ''}, ${slot.time || ''} - ${endTime}`;
    }).join('\n');
  }

  // ===========================================================================
  // Participant Resolution Helpers
  // ===========================================================================

  /**
   * Attempt to find a Nextcloud user by display name or user ID.
   *
   * @param {string} name
   * @returns {Promise<{id: string, email: string|null, displayName: string}|null>}
   * @private
   */
  async _findNCUser(name) {
    if (!name) return null;
    try {
      const response = await this.nc.request(
        `/ocs/v1.php/cloud/users?search=${encodeURIComponent(name)}`,
        { method: 'GET' }
      );
      const users =
        response &&
        response.body &&
        response.body.ocs &&
        response.body.ocs.data &&
        Array.isArray(response.body.ocs.data.users)
          ? response.body.ocs.data.users
          : [];

      if (users.length === 0) return null;

      const userId =
        users.length === 1
          ? users[0]
          : users.find(u =>
              (typeof u === 'string' ? u : u.displayname || u.id || '')
                .toLowerCase() === name.toLowerCase()
            ) || users[0];

      const id = typeof userId === 'string' ? userId : userId.id || userId.userid;
      if (!id) return null;

      const email = await this.nc.getUserEmail(id).catch(() => null);
      return { id, email, displayName: name };
    } catch (_) {
      return null;
    }
  }

  /**
   * Search for a subscribed calendar matching a participant name.
   *
   * @param {string} name
   * @returns {Promise<{id: string, displayName: string}|null>}
   * @private
   */
  async _findSubscribedCalendar(name) {
    if (!name) return null;
    try {
      const calendars = await this.caldavClient.getCalendars();
      const nameLower = name.toLowerCase();
      const match = (calendars || []).find(cal => {
        if (cal.supportsEvents === false) return false;
        return (cal.displayName || '').toLowerCase().includes(nameLower);
      });
      if (!match) return null;
      return { id: match.id, displayName: match.displayName };
    } catch (_) {
      return null;
    }
  }

  /**
   * Look up an email address for a participant via contacts.
   *
   * @param {string} name
   * @returns {Promise<string|null>}
   * @private
   */
  async _findEmail(name) {
    if (!name) return null;
    try {
      const result = await this.contactsClient.resolve(name);
      if (!result) return null;
      if (result.resolved && result.email) return result.email;
      if (result.resolved && result.contact && result.contact.email) return result.contact.email;
      if (Array.isArray(result.options)) {
        const first = result.options.find(o => o.email);
        return first ? first.email : null;
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Determine which calendar to use for the organizer.
   *
   * @param {string} organizerUserId
   * @returns {Promise<string>}
   * @private
   */
  async _getOrganizerCalendar(organizerUserId) {
    try {
      const calendars = await this.caldavClient.getCalendars();
      if (!calendars || calendars.length === 0) {
        return organizerUserId ? `${organizerUserId}-personal` : 'personal';
      }

      const preferred = calendars.find(cal => {
        const name = (cal.displayName || '').toLowerCase();
        return name === 'meetings' || (organizerUserId && name.includes(organizerUserId));
      });
      if (preferred) return preferred.id;

      const evtCal = calendars.find(cal => cal.supportsEvents !== false);
      if (evtCal) return evtCal.id;

      return organizerUserId ? `${organizerUserId}-personal` : 'personal';
    } catch (_) {
      return organizerUserId ? `${organizerUserId}-personal` : 'personal';
    }
  }
}

// -----------------------------------------------------------------------------
// Internal Utilities
// -----------------------------------------------------------------------------

/**
 * Format a UTC Date as HH:MM string.
 * @param {Date} date
 * @returns {string}
 */
function _formatTime(date) {
  const h = String(date.getUTCHours()).padStart(2, '0');
  const m = String(date.getUTCMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * Return a German day name for a UTC Date.
 * @param {Date} date
 * @returns {string}
 */
function _localDayName(date) {
  const DAYS_DE = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
  return DAYS_DE[date.getUTCDay()];
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = DateCoordinator;
module.exports.MEETING_STATES = MEETING_STATES;
module.exports.TIERS = TIERS;
module.exports.DEFAULT_BUSINESS_START = DEFAULT_BUSINESS_START;
module.exports.DEFAULT_BUSINESS_END = DEFAULT_BUSINESS_END;
module.exports.DEFAULT_DURATION_MINUTES = DEFAULT_DURATION_MINUTES;
module.exports.MAX_PROPOSAL_SLOTS = MAX_PROPOSAL_SLOTS;
module.exports.SLOT_INCREMENT_MINUTES = SLOT_INCREMENT_MINUTES;
