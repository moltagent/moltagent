/**
 * MoltAgent Heartbeat Intelligence
 *
 * Proactive intelligence classes that run on the heartbeat cycle:
 *
 * - MeetingPreparer: Gathers context from wiki/contacts/email/deck for
 *   upcoming meetings, synthesizes prep notes via LLM, sends to Talk.
 *   Runs at Initiative Level >= 3.
 *
 * - FreshnessChecker: Scans wiki pages once per day, checks frontmatter
 *   dates against decay_days, flags stale pages, creates Deck verification
 *   cards. Runs at Initiative Level >= 2.
 *
 * Note: DailyDigester was removed in Session 32. Daily briefings are now
 * handled by DailyBriefing (src/lib/agent/daily-briefing.js) which injects
 * into the system prompt on the first message of the day via AgentLoop.
 *
 * @module integrations/heartbeat-intelligence
 * @version 1.0.0
 */

'use strict';

const { parseFrontmatter, mergeFrontmatter, serializeFrontmatter } = require('../knowledge/frontmatter');
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
        context: { trigger: 'heartbeat_meeting_prep' }
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

// ============================================================================
// FreshnessChecker (Heartbeat Intelligence variant)
// ============================================================================

class FreshnessChecker {
  /**
   * @param {Object} opts
   * @param {Object} opts.collectivesClient - Wiki client for listing/reading pages
   * @param {Object} opts.deckClient - Deck client for creating verification cards
   * @param {Function} opts.notifyUser - Notification function
   * @param {Object} [opts.config] - Config object
   */
  constructor({ collectivesClient, deckClient, notifyUser, config }) {
    this.wiki = collectivesClient;
    this.deck = deckClient;
    this.notifyUser = notifyUser;
    this.config = config || {};

    this.lastCheckDate = null;
    this.DEFAULT_DECAY_DAYS = 30;
  }

  /**
   * Run check if not already done today.
   * @returns {Promise<{checked: boolean}|{checked: number, strengthened: number, composted: number, flagged: number}>}
   */
  async maybeCheck() {
    const today = new Date().toISOString().split('T')[0];
    if (this.lastCheckDate === today) return { checked: false };

    const results = await this.checkAll();
    this.lastCheckDate = today;
    return results;
  }

  /**
   * Biological triage: scan all wiki pages with three-outcome decay.
   *
   * - COMPOST: Never accessed + past decay + low confidence → compress to archive
   * - STRENGTHEN: Accessed within 30 days but technically past decay → auto-refresh
   * - VERIFY: Past decay with some history but not recent use → Deck card for human
   *
   * Core memories (decay_days: -1) and already-archived pages are skipped.
   *
   * @returns {Promise<{checked: number, strengthened: number, composted: number, flagged: number}>}
   */
  async checkAll() {
    const collectiveId = await this.wiki.resolveCollective();
    const pages = await this.wiki.listPages(collectiveId);
    const pageList = Array.isArray(pages) ? pages : [];
    const strengthened = [];
    const composted = [];
    const flagged = [];

    for (const page of pageList) {
      try {
        const pagePath = page.filePath
          ? `${page.filePath}/${page.fileName}`
          : page.fileName || `${page.title}.md`;

        const content = await this.wiki.readPageContent(pagePath);
        if (!content) continue;

        const { frontmatter, body } = parseFrontmatter(content);
        if (!frontmatter || Object.keys(frontmatter).length === 0) continue;

        // Skip already-archived pages
        if (frontmatter.type === 'archive') continue;

        const decayDays = parseInt(frontmatter.decay_days || this.DEFAULT_DECAY_DAYS, 10);

        // Rule 5: Core memories never decay
        if (decayDays < 0) continue;

        // Rule 2: Content staleness uses verified/updated dates only.
        // Access events are checked separately in the STRENGTHEN branch —
        // they indicate the page is useful but don't validate content accuracy.
        const contentDate = this._mostRecent(
          frontmatter.last_verified,
          frontmatter.last_updated || frontmatter.created
        );
        if (!contentDate) continue;

        const effectiveAge = this._daysSince(contentDate);
        if (effectiveAge <= decayDays) continue; // Content still fresh

        // Past decay threshold — triage
        const accessCount = parseInt(frontmatter.access_count || '0', 10);
        const confidence = frontmatter.confidence || 'medium';

        // Outcome 1: COMPOST — never accessed + past decay + low confidence + single source
        const sourceCount = this._countSources(body);
        if (accessCount === 0 && confidence === 'low' && sourceCount <= 1) {
          await this._compostPage(page, frontmatter, body);
          composted.push(page);
          continue;
        }

        // Outcome 2: STRENGTHEN — accessed within 30 days but technically past decay
        if (frontmatter.last_accessed && this._daysSince(frontmatter.last_accessed) < 30) {
          await this._strengthenPage(page, frontmatter, body);
          strengthened.push(page);
          continue;
        }

        // Outcome 3: VERIFY — past decay, some history but not recent use
        if (!frontmatter.needs_verification) {
          await this._flagForVerification(page, frontmatter, effectiveAge);
          flagged.push(page);
        }
      } catch (err) {
        console.warn(`[FreshnessChecker] Check failed for "${page.title}": ${err.message}`);
      }
    }

    // Notify summary
    if (composted.length > 0 || flagged.length > 0 || strengthened.length > 0) {
      const parts = [];
      if (strengthened.length > 0) parts.push(`${strengthened.length} reinforced (active use)`);
      if (flagged.length > 0) parts.push(`${flagged.length} need verification`);
      if (composted.length > 0) parts.push(`${composted.length} archived (unused)`);
      await this.notifyUser({
        type: 'freshness_check',
        message: `Knowledge review: ${parts.join(', ')}.`
      });
    }

    return {
      checked: pageList.length,
      strengthened: strengthened.length,
      composted: composted.length,
      flagged: flagged.length,
    };
  }

  /**
   * Find the most recent date from multiple optional date strings.
   * @param {...string} dateStrings - Optional ISO date strings
   * @returns {Date|null} Most recent valid date, or null
   */
  _mostRecent(...dateStrings) {
    let latest = null;
    for (const ds of dateStrings) {
      if (!ds) continue;
      const d = new Date(ds);
      if (isNaN(d.getTime())) continue;
      if (!latest || d > latest) latest = d;
    }
    return latest;
  }

  /**
   * Compost a dead knowledge page: overwrite with compressed archive content.
   * The form dies, the information persists as substrate.
   * @param {Object} page - Page metadata
   * @param {Object} frontmatter - Parsed frontmatter
   * @param {string} body - Page body (without frontmatter)
   */
  async _compostPage(page, frontmatter, body) {
    const trimmed = (body || '').replace(/^#[^\n]*\n+/, '').trim();
    const firstSentence = trimmed.match(/^[^.!?\n]+[.!?]/)?.[0] || trimmed.slice(0, 200);

    const archiveFm = {
      type: 'archive',
      original_type: frontmatter.type || 'unknown',
      created: frontmatter.created || 'unknown',
      archived: new Date().toISOString(),
      original_confidence: frontmatter.confidence || 'unknown',
      access_count: frontmatter.access_count || 0,
      reason: 'unused_past_decay',
    };

    const archiveBody = `# ${page.title} (Archived)\n\n${firstSentence}\n\n---\n*Archived by FreshnessChecker. Original had ${frontmatter.access_count || 0} accesses, confidence: ${frontmatter.confidence || 'unknown'}. Composted: never retrieved, past decay period.*\n`;

    // Move to Meta/Archive via ensureSection chokepoint
    try {
      const collectiveId = await this.wiki.resolveCollective();
      const metaSection = await this.wiki.ensureSection(collectiveId, 'Meta');
      const archiveSection = await this.wiki.ensureSection(collectiveId, 'Archive', metaSection.id);

      const archivePage = await this.wiki.createPage(collectiveId, archiveSection.id, page.title);
      const archivePath = archivePage.filePath
        ? `${archivePage.filePath}/${archivePage.fileName}`
        : archivePage.fileName || `${page.title}.md`;
      await this.wiki.writePageContent(archivePath, serializeFrontmatter(archiveFm, archiveBody));

      // Trash original
      if (page.id) {
        await this.wiki.trashPage(collectiveId, page.id);
      }

      console.log(`[Freshness] Composted → Meta/Archive: ${page.title} (0 accesses, ${frontmatter.confidence} confidence)`);
    } catch (err) {
      // Fallback: overwrite in place
      console.warn(`[Freshness] Archive-move failed for ${page.title}, falling back to in-place:`, err.message);
      try {
        await this.wiki.writePageWithFrontmatter(page.title, archiveFm, archiveBody);
        console.log(`[Freshness] Composted in-place (fallback): ${page.title}`);
      } catch (fallbackErr) {
        console.warn(`[Freshness] Fallback compost also failed for ${page.title}:`, fallbackErr.message);
      }
    }
  }

  /**
   * Strengthen a page that's technically past decay but clearly still alive.
   * Resets the decay clock and may boost confidence.
   * @param {Object} page - Page metadata
   * @param {Object} frontmatter - Parsed frontmatter
   * @param {string} body - Page body (without frontmatter)
   */
  async _strengthenPage(page, frontmatter, body) {
    try {
      const accessCount = parseInt(frontmatter.access_count || '0', 10);
      const updates = {
        last_verified: new Date().toISOString(),
        verified_by: 'system:usage_pattern',
      };

      // Boost confidence for actively used pages
      if (accessCount >= 5 && frontmatter.confidence !== 'high') {
        updates.confidence = 'high';
      } else if (frontmatter.confidence === 'low') {
        // Page is clearly still useful if accessed within 30 days — restore to medium
        updates.confidence = 'medium';
      }

      const merged = mergeFrontmatter(frontmatter, updates);
      await this.wiki.writePageWithFrontmatter(page.title, merged, body);

      console.log(`[Freshness] Strengthened: ${page.title} (${accessCount} accesses, recently used)`);
    } catch (err) {
      console.warn(`[Freshness] Failed to strengthen ${page.title}:`, err.message);
    }
  }

  /**
   * Flag a page for human verification: create Deck card + set needs_verification.
   * @param {Object} page - Page metadata
   * @param {Object} frontmatter - Parsed frontmatter
   * @param {number} effectiveAge - Effective age in days
   */
  async _flagForVerification(page, frontmatter, effectiveAge) {
    // Set needs_verification in frontmatter
    try {
      const pageData = await this.wiki.readPageWithFrontmatter(page.title);
      if (pageData) {
        const updates = {
          needs_verification: true,
          confidence: frontmatter.confidence === 'high' ? 'medium' : 'low',
        };
        const merged = mergeFrontmatter(pageData.frontmatter, updates);
        await this.wiki.writePageWithFrontmatter(page.title, merged, pageData.body);
      }
    } catch (err) {
      console.warn(`[Freshness] Could not set needs_verification for ${page.title}:`, err.message);
    }

    // Create Deck verification card (skip duplicates)
    await this._createVerificationCard(page, frontmatter, effectiveAge);
  }

  /**
   * Create a verification Deck card for a stale page, skipping duplicates.
   * @param {Object} page - Page metadata
   * @param {Object} frontmatter - Parsed frontmatter
   * @param {number} age - Effective age in days
   */
  async _createVerificationCard(page, frontmatter, age) {
    const cardTitle = `Verify: ${page.title}`;

    // Check for existing card to avoid duplicates
    try {
      const inboxCards = await this.deck.getCardsInStack('inbox');
      const exists = inboxCards.some(c => c.title === cardTitle);
      if (exists) return;
    } catch (err) { /* proceed to create */ }

    try {
      await this.deck.createCard('inbox', {
        title: cardTitle,
        description: `This knowledge page is ${age} days past its effective freshness limit (decay: ${frontmatter.decay_days || this.DEFAULT_DECAY_DAYS} days).\n\nAccess count: ${frontmatter.access_count || 0}\nLast accessed: ${frontmatter.last_accessed || 'never'}\nLast verified: ${frontmatter.last_verified || 'never'}\nConfidence: ${frontmatter.confidence || 'unknown'}\n\nPlease review and confirm this information is still accurate.`
      });
    } catch (err) {
      console.warn(`[Freshness] Could not create verification card for ${page.title}:`, err.message);
    }
  }

  /**
   * Compute days since a date string or Date object.
   * @param {string|Date} dateInput - ISO date string or Date
   * @returns {number} Days since the date
   */
  _daysSince(dateInput) {
    const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
    const now = new Date();
    return Math.max(0, Math.floor((now - date) / (1000 * 60 * 60 * 24)));
  }

  /**
   * Count distinct source references in page body.
   * Multi-source pages carry more evidentiary weight and resist composting.
   * @param {string} body - Page body (without frontmatter)
   * @returns {number}
   */
  _countSources(body) {
    if (!body) return 0;
    const sources = new Set();
    const patterns = [
      /\*Extracted from:\s*(.+?)\*/g,
      /\*Also referenced in:\s*(.+?)\*/g,
      /\*\*Source:\*\*\s*`?(.+?)`?\s*$/gm,
    ];
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(body)) !== null) {
        const src = match[1].trim();
        if (src && src !== 'unknown') sources.add(src.toLowerCase());
      }
    }
    return sources.size;
  }
}

module.exports = { MeetingPreparer, FreshnessChecker };
