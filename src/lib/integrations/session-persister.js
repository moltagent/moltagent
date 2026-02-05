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
   * @param {Object} [options.config] - Configuration
   */
  constructor({ wikiClient, llmRouter, config = {} }) {
    this.wiki = wikiClient;
    this.router = llmRouter;
    this.config = config;
    this.minContextForPersistence = 6;
    this.minExchanges = 4; // At least 4 user/assistant messages (2 exchanges)
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

    if (!summary) return null;

    // Build page title: Sessions/{date}-{roomToken-prefix}
    const date = new Date(session.createdAt).toISOString().split('T')[0];
    const roomPrefix = (session.roomToken || 'unknown').substring(0, 8);
    const pageTitle = `Sessions/${date}-${roomPrefix}`;

    // Build frontmatter and body separately for writePageWithFrontmatter
    const frontmatter = {
      type: 'session',
      room: session.roomToken,
      user: session.userId,
      created: new Date(session.createdAt).toISOString(),
      expired: new Date().toISOString(),
      messages: session.context.length,
      decay_days: 90,
    };

    const body = `# Session Summary\n\n${summary}`;

    try {
      await this.wiki.writePageWithFrontmatter(pageTitle, frontmatter, body);
      return pageTitle;
    } catch (err) {
      console.error('[SessionPersister] Wiki write failed:', err.message);
      return null;
    }
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
        content: `Summarize this conversation in 3-5 bullet points. Focus on:\n` +
          `- Decisions made\n` +
          `- Action items or commitments\n` +
          `- Key facts discussed\n` +
          `- Any open questions or next steps\n` +
          `Be concise. No preamble.\n\n${transcript}`,
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
