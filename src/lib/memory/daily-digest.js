/*
 * Moltagent - Sovereign AI Security Layer
 * Copyright (C) 2026 Moltagent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

'use strict';

const { serializeFrontmatter } = require('../knowledge/frontmatter');
const ollamaGate = require('../shared/ollama-gate');

/**
 * DailyDigest — Hippocampal replay: daily episode wiki pages.
 *
 * Architecture Brief:
 * - Problem: No unified record of daily activity exists across rooms
 * - Pattern: Gather sessions + wiki changes + deck activity → LLM narrative → wiki page
 * - Key Dependencies: CollectivesClient (source + sink), LLMRouter (narrative), DeckClient (optional)
 * - Data Flow: gather activity → generate narrative → write Memory/Episodes/{date}
 * - Dependency Map: heartbeat-manager.js → daily-digest.js → collectives-client.js
 *
 * @module memory/daily-digest
 * @version 1.0.0
 */

const EPISODE_PATH_PREFIX = 'Memory/Episodes';
const ACTIVITY_LOG_PREFIX = 'Meta/Activity Log';
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

class DailyDigest {
  /**
   * @param {Object} deps
   * @param {Object} deps.wikiClient - CollectivesClient (source + sink)
   * @param {Object} [deps.llmRouter] - LLMRouter for narrative generation
   * @param {Object} [deps.deckClient] - DeckClient for deck activity (optional)
   * @param {Object} [deps.logger]
   */
  constructor({ wikiClient, llmRouter, deckClient, logger }) {
    if (!wikiClient) throw new Error('DailyDigest requires wikiClient');
    this.wiki = wikiClient;
    this.router = llmRouter || null;
    this.deck = deckClient || null;
    this.logger = logger || console;
    this._lastDigestDate = null; // Idempotency guard
  }

  /**
   * Generate (or skip) the daily episode page for the given date.
   *
   * @param {string} [dateStr] - ISO date string YYYY-MM-DD; defaults to today
   * @returns {Promise<{ written?: boolean, skipped?: boolean, date: string, path?: string, reason?: string }>}
   */
  async generate(dateStr) {
    const date = dateStr || new Date().toISOString().slice(0, 10);

    // Idempotency: never attempt the same day twice in one process lifetime.
    //
    // The guard is claimed BEFORE any LLM call so a failing write cannot
    // cause the expensive narrative generation to repeat every heartbeat.
    // On failure we log and move on; a restart clears `_lastDigestDate`
    // and the next process lifetime gets a fresh attempt. Without this
    // ordering a single 404 on PUT caused ~288 wasted synthesis calls per
    // day (one per heartbeat pulse). See issue #19.
    if (this._lastDigestDate === date) {
      return { skipped: true, date };
    }

    // Gather activity sources in parallel; tolerate individual failures
    const [sessions, wikiChanges, deckActivity] = await Promise.allSettled([
      this._gatherSessions(date),
      this._gatherWikiChanges(date),
      this._gatherDeckActivity(date)
    ]);

    const sessionList   = sessions.status     === 'fulfilled' ? sessions.value     : [];
    const changeList    = wikiChanges.status  === 'fulfilled' ? wikiChanges.value  : [];
    const deckList      = deckActivity.status === 'fulfilled' ? deckActivity.value : [];

    // Nothing to write — skip, but DO claim the date so we don't keep
    // scanning activity sources every 5 minutes on quiet days.
    if (sessionList.length === 0 && changeList.length === 0 && deckList.length === 0) {
      this._lastDigestDate = date;
      return { skipped: true, date, reason: 'no activity' };
    }

    // Claim the date up-front so a downstream failure (LLM timeout, WebDAV
    // 404, network glitch) cannot re-trigger the whole path on the next pulse.
    this._lastDigestDate = date;

    const activity = { sessions: sessionList, wikiChanges: changeList, deckActions: deckList };

    try {
      const narrative = await this._generateNarrative(date, activity);
      const page      = this._buildPage(date, narrative, activity);
      const pagePath  = `${EPISODE_PATH_PREFIX}/${date}`;

      // Ensure the parent collection exists — Nextcloud WebDAV returns 404
      // on PUT when the parent folder is missing, not 409.
      if (typeof this.wiki.ensureDirectory === 'function') {
        await this.wiki.ensureDirectory(EPISODE_PATH_PREFIX);
      }
      await this.wiki.writePageContent(pagePath, page);

      this.logger.info(`[DailyDigest] Episode written: ${pagePath}`);
      return { written: true, date, path: pagePath };
    } catch (err) {
      this.logger.warn(`[DailyDigest] Episode write failed for ${date}: ${err.message}`);
      return { skipped: true, date, reason: `write failed: ${err.message}` };
    }
  }

  /**
   * Search wiki for session-like pages that reference the given date.
   *
   * @param {string} dateStr
   * @returns {Promise<Array<{ title: string, id: * }>>}
   * @private
   */
  async _gatherSessions(dateStr) {
    try {
      // Search for session pages matching date
      const collectiveId = await this.wiki.resolveCollective();
      const results = await this.wiki.searchPages(collectiveId, dateStr);
      if (!Array.isArray(results)) return [];

      // Filter to session-like pages (contain date in title)
      return results.filter(p => {
        const title = (p.title || '').toLowerCase();
        return title.includes('session') || title.includes(dateStr);
      }).map(p => ({ title: p.title, id: p.id }));
    } catch (err) {
      this.logger.warn(`[DailyDigest] Session gather failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Read the daily activity log page and extract bullet-point entries.
   *
   * @param {string} dateStr
   * @returns {Promise<Array<{ entry: string }>>}
   * @private
   */
  async _gatherWikiChanges(dateStr) {
    try {
      const content = await this.wiki.readPageContent(`${ACTIVITY_LOG_PREFIX} ${dateStr}`);
      if (!content) return [];

      // Parse bullet points from activity log
      const lines = content.split('\n').filter(l => l.trim().startsWith('-'));
      return lines.map(l => ({ entry: l.trim().replace(/^-\s*/, '') }));
    } catch (_err) {
      // Activity log page may not exist — this is expected on quiet days
      return [];
    }
  }

  /**
   * Stub: DeckClient has no activity-by-date API yet.
   *
   * @returns {Promise<Array>}
   * @private
   */
  async _gatherDeckActivity(_dateStr) {
    // Stub: DeckClient has no activity-by-date API yet
    return [];
  }

  /**
   * Generate a narrative summary of the day's activity.
   * Falls back to a plain text summary when no LLM router is available.
   *
   * @param {string} dateStr
   * @param {{ sessions: Array, wikiChanges: Array, deckActions: Array }} activity
   * @returns {Promise<string>}
   * @private
   */
  async _generateNarrative(dateStr, activity) {
    if (!this.router) {
      // Fallback: basic summary without LLM
      const parts = [];
      if (activity.sessions.length > 0)    parts.push(`${activity.sessions.length} session(s) recorded`);
      if (activity.wikiChanges.length > 0) parts.push(`${activity.wikiChanges.length} wiki change(s)`);
      if (activity.deckActions.length > 0) parts.push(`${activity.deckActions.length} deck action(s)`);
      return parts.join('. ') + '.';
    }

    const prompt = `Summarize this day's activity for ${dateStr} in 3-5 sentences. Write as a brief daily journal entry.

Sessions: ${JSON.stringify(activity.sessions.map(s => s.title))}
Wiki changes: ${JSON.stringify(activity.wikiChanges.map(c => c.entry).slice(0, 10))}
Deck actions: ${JSON.stringify(activity.deckActions.slice(0, 10))}

Rules:
- Write in third person ("The agent..." or "Activity included...")
- Focus on what was accomplished, not routine operations
- If limited information, keep it brief
- Plain text, no markdown formatting`;

    try {
      // Yield to user messages — don't block Ollama when user is waiting
      if (ollamaGate.isUserActive()) {
        return 'Activity recorded.';
      }
      const rawResponse = await this.router.route({
        job: 'synthesis',
        content: prompt,
        requirements: { maxTokens: 300 },
        context: { trigger: 'heartbeat_digest', internal: true }
      });
      return (rawResponse.result || rawResponse || '').toString().trim() || 'Activity recorded.';
    } catch (err) {
      this.logger.warn(`[DailyDigest] Narrative generation failed: ${err.message}`);
      return 'Activity recorded but narrative generation failed.';
    }
  }

  /**
   * Build the full wiki page content (frontmatter + markdown body).
   *
   * @param {string} dateStr
   * @param {string} narrative
   * @param {{ sessions: Array, wikiChanges: Array, deckActions: Array }} activity
   * @returns {string}
   * @private
   */
  _buildPage(dateStr, narrative, activity) {
    // Use midday UTC to avoid UTC-vs-local date ambiguity
    const dateObj  = new Date(dateStr + 'T12:00:00Z');
    const dayName  = DAY_NAMES[dateObj.getUTCDay()];

    const fm = {
      type: 'episode',
      date: dateStr,
      day: dayName,
      sessions: activity.sessions.length,
      wiki_changes: activity.wikiChanges.length,
      deck_actions: activity.deckActions.length,
      confidence: 'high',
      decay_days: 30,
      access_count: 0,
      created: new Date().toISOString()
    };

    let body = `# Episode: ${dateStr} (${dayName})\n\n`;
    body += `${narrative}\n\n`;

    if (activity.sessions.length > 0) {
      body += '## Sessions\n\n';
      for (const s of activity.sessions) {
        body += `- [[${s.title}]]\n`;
      }
      body += '\n';
    }

    if (activity.wikiChanges.length > 0) {
      body += '## Wiki Changes\n\n';
      for (const c of activity.wikiChanges) {
        body += `- ${c.entry}\n`;
      }
      body += '\n';
    }

    return serializeFrontmatter(fm, body);
  }
}

module.exports = DailyDigest;
