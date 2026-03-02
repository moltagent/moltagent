'use strict';

const { JOBS } = require('../llm/router');

/**
 * SessionPersister - Session Transcript Persistence
 *
 * When a session expires, generates a summary via local LLM and saves it
 * to the wiki under Sessions/ section. Summaries are searchable by the
 * memory search tool, enabling cross-session recall.
 *
 * Skips trivial sessions (< 6 context entries or < 4 user/assistant exchanges)
 * to avoid polluting the wiki with "hi/bye" interactions.
 *
 * Uses sovereign/local role for summary generation — zero cloud cost.
 *
 * @module integrations/session-persister
 * @version 1.0.0
 */

class SessionPersister {
  /**
   * @param {Object} options
   * @param {import('./collectives-client')} options.wikiClient - CollectivesClient instance
   * @param {import('../llm-router')} options.llmRouter - LLM Router instance
   * @param {Object} [options.rhythmTracker] - RhythmTracker for behavioral pattern recording
   * @param {Object} [options.config] - Configuration
   */
  constructor({ wikiClient, llmRouter, rhythmTracker, config = {} }) {
    this.wiki = wikiClient;
    this.router = llmRouter;
    this.rhythmTracker = rhythmTracker || null;
    this.config = config;
    this.minContextForPersistence = 6;
    this.minExchanges = 4; // At least 4 user/assistant messages (2 exchanges)
    this.lastSummary = null; // Stored for warm memory consolidation after persistence
  }

  /**
   * Called when a session expires. Generates a summary and saves to wiki.
   * @param {Object} session - The expired session from SessionManager
   * @returns {Promise<string|null>} Page title if persisted, null if skipped
   */
  async persistSession(session) {
    // Skip trivial sessions
    if (!session.context || session.context.length < this.minContextForPersistence) {
      return null;
    }

    // Filter to user/assistant messages for summary quality check
    const userAssistantMessages = session.context.filter(
      c => c.role === 'user' || c.role === 'assistant'
    );

    if (userAssistantMessages.length < this.minExchanges) {
      return null;
    }

    // Generate summary using local model (sovereign role — zero cloud cost)
    const summary = await this._generateSummary(session, userAssistantMessages);

    if (!summary) {
      this.lastSummary = null;
      return null;
    }

    // Build page title: Sessions/{date}-{roomToken-prefix}
    const date = new Date(session.createdAt).toISOString().split('T')[0];
    const roomPrefix = (session.roomToken || 'unknown').substring(0, 8);
    const pageTitle = `Sessions/${date}-${roomPrefix}`;

    // Build frontmatter and body separately for writePageWithFrontmatter
    const frontmatter = {
      type: 'session_transcript',
      room: session.roomToken,
      room_name: session.roomName || null,
      user: session.userId,
      created: new Date(session.createdAt).toISOString(),
      expired: new Date().toISOString(),
      messages: session.context.length,
      decay_days: 90,
    };

    const body = summary;

    try {
      await this.wiki.writePageWithFrontmatter(pageTitle, frontmatter, body);
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
      .map(c => `${c.role}: ${(c.content || '').substring(0, 300)}`)
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
          `Be concise. No preamble. Start directly with ## Summary.\n\n${transcript}`,
        requirements: { role: 'sovereign' },
        context: { trigger: 'session_summary' },
      });

      return result?.content || null;
    } catch (err) {
      console.error('[SessionPersister] Summary generation failed:', err.message);
      return null;
    }
  }
}

module.exports = SessionPersister;
