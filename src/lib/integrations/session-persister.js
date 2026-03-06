/*
 * MoltAgent - Sovereign AI Security Layer
 * Copyright (C) 2026 MoltAgent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 */

'use strict';

const { JOBS } = require('../llm/router');
const TrustGate = require('../security/trust-gate');
const MythDetector = require('../security/myth-detector');

/**
 * SessionPersister - Session Transcript Persistence
 *
 * Problem:
 *   When a session expires, its conversation history evaporates. Cross-session
 *   memory requires summarising and persisting it to a searchable wiki store.
 *
 * Pattern:
 *   On 'sessionExpired' from SessionManager, generate a sovereign (local LLM)
 *   summary and write it as a Collectives subpage under "Sessions/".
 *   The page is created via the Collectives OCS API (not raw WebDAV PUT) so
 *   that the parent directory is guaranteed to exist before the write.
 *
 * Key Dependencies:
 *   - CollectivesClient  (OCS createPage + WebDAV writePageContent)
 *   - LLM Router         (JOBS.QUICK / sovereign role for zero cloud cost)
 *   - RhythmTracker      (optional, for behavioral pattern recording)
 *
 * Data Flow:
 *   sessionExpired → persistSession()
 *     → _generateSummary()   (LLM)
 *     → _ensureSessionsParent()  (OCS: find/create Sessions top-level page)
 *     → _writeSessionPage()      (OCS: createPage + WebDAV: writePageContent)
 *
 * Dependency Map:
 *   session-persister → collectives-client → nc-request-manager
 *   session-persister → llm/router
 *   session-persister ← session-manager (event emitter)
 *
 * Skips trivial sessions (< 6 context entries or < 4 user/assistant exchanges)
 * to avoid polluting the wiki with "hi/bye" interactions.
 *
 * @module integrations/session-persister
 * @version 1.1.0
 */

class SessionPersister {
  /**
   * @param {Object} options
   * @param {import('./collectives-client')} options.wikiClient - CollectivesClient instance
   * @param {import('../llm-router')} options.llmRouter - LLM Router instance
   * @param {Object} [options.rhythmTracker] - RhythmTracker for behavioral pattern recording
   * @param {Object} [options.config] - Configuration
   */
  constructor({ wikiClient, llmRouter, rhythmTracker, deckClient, trustLevel, resilientWriter, config = {} }) {
    this.wiki = wikiClient;
    this.resilientWriter = resilientWriter || null;
    this.router = llmRouter;
    this.rhythmTracker = rhythmTracker || null;
    this.config = config;
    this.minContextForPersistence = 6;
    this.minExchanges = 4; // At least 4 user/assistant messages (2 exchanges)
    this.lastSummary = null; // Stored for warm memory consolidation after persistence

    // Layer 2: Trust-gated persistence — filter ungrounded claims before summary
    this.trustGate = new TrustGate({ trustLevel: trustLevel || 'balanced', logger: console });

    // Layer 4: Myth detector — catch self-referential fiction before persistence
    this.mythDetector = new MythDetector({ logger: console, deckClient: deckClient || null });

    // Cache the Sessions parent page ID to avoid repeated OCS lookups per heartbeat cycle
    this._sessionsParentId = null;
    this._sessionsParentIdExpiry = 0;
    this._sessionsParentIdTTL = 60 * 60 * 1000; // 1 hour
  }

  /**
   * Called when a session expires. Generates a summary and saves to wiki.
   * @param {Object} session - The expired session from SessionManager
   * @returns {Promise<string|null>} Page title if persisted, null if skipped
   */
  async persistSession(session) {
    if (!session || !session.context || session.context.length < this.minContextForPersistence) {
      return null;
    }

    // Filter to user/assistant messages for summary quality check
    const userAssistantMessages = session.context.filter(
      c => c.role === 'user' || c.role === 'assistant'
    );

    if (userAssistantMessages.length < this.minExchanges) {
      console.log(`[SessionPersister] Skipped: only ${userAssistantMessages.length} user/assistant messages (need ≥${this.minExchanges})`);
      return null;
    }

    // Layer 4: Detect self-referential myths before any filtering
    const myths = this.mythDetector.detect(session.context);
    if (myths.length > 0) {
      this.mythDetector.alert(myths).catch(err =>
        console.warn('[SessionPersister] Myth alert failed:', err.message)
      );
    }

    // Layer 2: Trust gate — filter ungrounded claims before summary generation
    const { kept, filtered: filteredSegments } = this.trustGate.filter(session.context);
    const keptMessages = kept.filter(c => c.role === 'user' || c.role === 'assistant');

    // Generate summary from trust-gated context (sovereign role — zero cloud cost)
    console.log(`[SessionPersister] Generating summary from ${keptMessages.length} trust-gated messages (${filteredSegments.length} filtered)`);
    const summary = await this._generateSummary(session, keptMessages);

    if (!summary) {
      console.warn('[SessionPersister] Summary generation returned empty — session not persisted');
      this.lastSummary = null;
      return null;
    }

    // Build filtered claims section for transparency
    let filteredSection = '';
    if (filteredSegments.length > 0) {
      const items = filteredSegments
        .map(s => `- "${s.text}" [${s.trust}]`)
        .join('\n');
      filteredSection = `\n\n## Filtered (did not meet trust threshold)\n${items}`;
    }

    // Build myth alerts section
    let mythSection = '';
    if (myths.length > 0) {
      const items = myths
        .map(m => `- "${m.claim.substring(0, 200)}" — repeated ${m.occurrences}x without source [myth detected, severity: ${m.severity}]`)
        .join('\n');
      mythSection = `\n\n## Myth Alerts\n${items}`;
    }

    // Build page title: Sessions/{date}-{roomToken-prefix}
    const date = new Date(session.createdAt).toISOString().split('T')[0];
    const roomPrefix = (session.roomToken || 'unknown').substring(0, 8);
    const pageTitle = `Sessions/${date}-${roomPrefix}`;
    const leafTitle = `${date}-${roomPrefix}`;

    const frontmatter = {
      type: 'session_transcript',
      room: session.roomToken,
      room_name: session.roomName || null,
      user: session.userId,
      created: new Date(session.createdAt).toISOString(),
      expired: new Date().toISOString(),
      messages: session.context.length,
      trust_level: this.trustGate.trustLevel,
      filtered_claims: filteredSegments.length,
      myths_detected: myths.length,
      decay_days: 90,
    };

    try {
      const fullBody = summary + mythSection + filteredSection;
      await this._writeSessionPage(leafTitle, frontmatter, fullBody);
      this.lastSummary = summary; // Set only after successful wiki write

      // Rhythm tracking: compute and record session behavioral metadata
      if (this.rhythmTracker) {
        try {
          const sessionMeta = this._computeSessionMeta(session, userAssistantMessages);
          await this.rhythmTracker.recordSession(sessionMeta);
        } catch (err) {
          console.warn('[SessionPersister] Rhythm tracking failed:', err.message);
        }
      }

      return pageTitle;
    } catch (err) {
      console.error('[SessionPersister] Wiki write failed:', err.message);
      this.lastSummary = null;
      return null;
    }
  }

  /**
   * Public alias for persistSession — enables manual testing and admin commands.
   * @param {Object} session - Session object
   * @returns {Promise<string|null>} Page title if persisted, null if skipped or failed
   */
  async persistNow(session) {
    return await this.persistSession(session);
  }

  /**
   * Write a session summary page using the Collectives OCS API.
   *
   * Uses createPage() so Collectives registers the page in its page tree and
   * the parent directory exists before the WebDAV content write. This avoids
   * the 409 Conflict that occurs when writePageWithFrontmatter() falls back to
   * a raw WebDAV PUT under a not-yet-existing Sessions/ subdirectory.
   *
   * Falls back to writePageWithFrontmatter() when the wiki client does not
   * expose the OCS-level API (e.g. in tests that only mock writePageWithFrontmatter).
   *
   * @private
   * @param {string} leafTitle - Page title (leaf only, e.g. "2026-03-04-abc12345")
   * @param {Object} frontmatter - Frontmatter metadata object
   * @param {string} body - Page body (the LLM summary)
   * @returns {Promise<void>}
   */
  async _writeSessionPage(leafTitle, frontmatter, body) {
    const { serializeFrontmatter } = require('../knowledge/frontmatter');
    const content = serializeFrontmatter(frontmatter, body);

    // Resilient path: dual OCS/WebDAV writer handles failover automatically
    if (this.resilientWriter) {
      const result = await this.resilientWriter.createPage('Sessions', leafTitle, content);
      if (!result || !result.success) {
        throw new Error(`ResilientWikiWriter failed to create session page: ${result?.error || 'unknown'}`);
      }
      return;
    }

    // Legacy path: direct OCS calls (backward compat for tests without resilientWriter)
    const hasOcsApi = typeof this.wiki.resolveCollective === 'function' &&
                      typeof this.wiki.listPages === 'function' &&
                      typeof this.wiki.createPage === 'function' &&
                      typeof this.wiki.writePageContent === 'function';

    if (!hasOcsApi) {
      await this.wiki.writePageWithFrontmatter(`Sessions/${leafTitle}`, frontmatter, body);
      return;
    }

    const sessionsParentId = await this._ensureSessionsParent();
    const collectiveId = await this.wiki.resolveCollective();
    const allPages = await this.wiki.listPages(collectiveId);
    const pageList = Array.isArray(allPages) ? allPages : [];

    const existing = pageList.find(p =>
      p.parentId === sessionsParentId &&
      (p.title || '').toLowerCase() === leafTitle.toLowerCase()
    );

    let pagePath;
    if (existing) {
      pagePath = existing.filePath
        ? `${existing.filePath}/${existing.fileName}`
        : existing.fileName || `Sessions/${leafTitle}.md`;
    } else {
      const created = await this.wiki.createPage(collectiveId, sessionsParentId, leafTitle);
      pagePath = created && created.filePath
        ? `${created.filePath}/${created.fileName}`
        : created && created.fileName
          ? created.fileName
          : `Sessions/${leafTitle}.md`;
    }

    await this.wiki.writePageContent(pagePath, content);
  }

  /**
   * Find or create the "Sessions" top-level page in the Collectives wiki.
   * Caches the page ID for one hour to minimise API calls.
   *
   * @private
   * @returns {Promise<number>} OCS page ID of the Sessions parent page
   */
  async _ensureSessionsParent() {
    const now = Date.now();

    // Return cached ID if still valid
    if (this._sessionsParentId !== null && now < this._sessionsParentIdExpiry) {
      return this._sessionsParentId;
    }

    const collectiveId = await this.wiki.resolveCollective();
    const allPages = await this.wiki.listPages(collectiveId);
    const pageList = Array.isArray(allPages) ? allPages : [];

    // Find root-level Sessions page (parentId 0 or the landing page's id)
    const landingPage = pageList.find(p => p.parentId === 0);
    const rootParentId = landingPage ? landingPage.id : 0;

    const sessionsPage = pageList.find(p =>
      (p.title || '').toLowerCase() === 'sessions' &&
      (p.parentId === rootParentId || p.parentId === 0)
    );

    let sessionsParentId;
    if (sessionsPage) {
      sessionsParentId = sessionsPage.id;
    } else {
      // Create the Sessions top-level section page
      const created = await this.wiki.createPage(collectiveId, rootParentId, 'Sessions');
      sessionsParentId = created.id;

      // Write a stub header so the page isn't empty in the UI
      const stubPath = created.filePath
        ? `${created.filePath}/${created.fileName}`
        : created.fileName || 'Sessions.md';
      try {
        await this.wiki.writePageContent(stubPath, '# Sessions\n\nSession summaries are written here automatically when conversations end.\n');
      } catch (err) {
        // Non-fatal — page exists, stub content is cosmetic only
        console.warn('[SessionPersister] Could not write Sessions stub:', err.message);
      }
    }

    // Cache for one hour
    this._sessionsParentId = sessionsParentId;
    this._sessionsParentIdExpiry = now + this._sessionsParentIdTTL;
    return sessionsParentId;
  }

  /**
   * Compute behavioral metadata for rhythm tracking.
   * @private
   * @param {Object} session - Session object
   * @param {Array} messages - User/assistant messages
   * @returns {Object} sessionMeta
   */
  _computeSessionMeta(session, messages) {
    const startTime = session.createdAt ? new Date(session.createdAt).toISOString() : new Date().toISOString();
    const endTime = new Date().toISOString();
    const durationMs = new Date(endTime).getTime() - new Date(startTime).getTime();
    const duration = Math.max(0, Math.round(durationMs / 1000));

    const userMessages = messages.filter(m => m.role === 'user');
    const messageCount = messages.length;

    // Directive ratio: fraction of user messages that are commands/directives
    const directivePatterns = /^(do|create|move|delete|update|set|send|add|remove|find|search|check|fix|run|make|write|list|show|get|close|open|mark|assign|schedule)/i;
    const directiveCount = userMessages.filter(m => directivePatterns.test((m.content || '').trim())).length;
    const directiveRatio = userMessages.length > 0 ? directiveCount / userMessages.length : 0;

    // Topic diversity: count unique 4+ char words from user messages (simple heuristic)
    const words = new Set();
    for (const m of userMessages) {
      const content = (m.content || '').toLowerCase();
      for (const word of content.split(/\s+/)) {
        const clean = word.replace(/[^a-z0-9]/g, '');
        if (clean.length >= 4) words.add(clean);
      }
    }
    // Normalize to 0-1 range: 50+ unique words = maximum diversity
    const topicDiversity = Math.min(1.0, words.size / 50);

    return {
      startTime,
      endTime,
      duration,
      messageCount,
      directiveRatio: Math.round(directiveRatio * 100) / 100,
      topicDiversity,
      roomName: session.roomName || session.roomToken || 'unknown'
    };
  }

  /**
   * Generate a concise summary of the conversation.
   * Uses sovereign/local role — zero cloud cost.
   * @private
   * @param {Object} session - Session object
   * @param {Array} messages - Filtered user/assistant messages
   * @returns {Promise<string|null>}
   */
  async _generateSummary(session, messages) {
    // Build a condensed transcript (cap per message to stay within local model limits)
    const transcript = messages
      .map(c => `${c.role}: ${(typeof c.content === 'string' ? c.content : String(c.content || '')).substring(0, 300)}`)
      .join('\n');

    try {
      const result = await this.router.route({
        job: JOBS.QUICK,
        task: 'session_summary',
        content: `Summarize this conversation with these exact sections:\n\n` +
          `## Summary\n` +
          `3-5 bullet points covering decisions, facts, and actions.\n\n` +
          `## Continuation\n` +
          `One sentence: what should we pick up next time?\n\n` +
          `## Open Items\n` +
          `Bullet list of unresolved questions or pending tasks. Write "None" if all resolved.\n\n` +
          `Be concise. No preamble. No <think> tags. Start directly with ## Summary.\n\n${transcript}`,
        requirements: { role: 'sovereign' },
        context: { trigger: 'session_summary' },
      });

      let content = result?.result || result?.content || null;
      // Strip think tags (qwen3 may wrap entire output in <think>...</think>)
      if (content) {
        content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim() || null;
      }
      if (!content) {
        console.warn(`[SessionPersister] LLM returned empty summary (result keys: ${result ? Object.keys(result).join(',') : 'null'})`);
      }
      return content;
    } catch (err) {
      console.error('[SessionPersister] Summary generation failed:', err.message);
      return null;
    }
  }
}

module.exports = SessionPersister;
