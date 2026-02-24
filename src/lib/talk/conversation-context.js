/**
 * Conversation Context Module
 *
 * Architecture Brief:
 * -------------------
 * Problem: Moltagent processes each message in isolation with zero conversation
 * history. The LLM has no context from previous exchanges, causing "amnesia"
 * and inability to resolve references like "the one in inbox" or "close those two".
 *
 * Pattern: Fetch recent messages from NC Talk API, format as conversation history,
 * inject into LLM prompts. Graceful degradation — errors return empty array.
 *
 * Key Dependencies:
 * - NCRequestManager for Talk API calls
 * - Config for conversation context settings
 *
 * Data Flow:
 * - MessageProcessor calls getHistory(token, {excludeMessageId})
 * - ConversationContext fetches from Talk API
 * - Returns formatted array [{role, name, content, timestamp}]
 * - MessageRouter calls formatForPrompt(history)
 * - Result injected into LLM prompt as <conversation_history> block
 *
 * Integration Points:
 * - Called by MessageProcessor before routing
 * - Used by MessageRouter in _handleGeneral()
 * - Talk API: GET /ocs/v2.php/apps/spreed/api/v1/chat/{token}
 *
 * @module talk/conversation-context
 * @version 1.0.0
 */

'use strict';

class ConversationContext {
  /**
   * @param {Object} config - Configuration options
   * @param {boolean} [config.enabled=true] - Enable/disable context fetching
   * @param {number} [config.maxMessages=20] - Max messages to fetch
   * @param {number} [config.maxTokenEstimate=4000] - Token budget
   * @param {boolean} [config.includeSystemMessages=false] - Include system messages
   * @param {number} [config.maxMessageAge=7200000] - Max message age in ms (2 hours)
   * @param {Object} ncRequestManager - NCRequestManager instance
   * @param {Object} [logger] - Logger (defaults to console)
   */
  constructor(config, ncRequestManager, logger) {
    this.config = config || {};
    this.nc = ncRequestManager;
    this.logger = logger || console;
    this.enabled = config?.enabled !== false;
  }

  /**
   * Fetch recent conversation history from a Talk room.
   *
   * @param {string} roomToken - NC Talk room token
   * @param {Object} [options]
   * @param {number} [options.limit] - Max messages to fetch (default: config.maxMessages)
   * @param {number} [options.excludeMessageId] - Skip this message ID (the trigger message)
   * @returns {Promise<Array<{role: string, name: string, content: string, timestamp: number}>>}
   */
  async getHistory(roomToken, options = {}) {
    if (!this.enabled) return [];

    const limit = options.limit || this.config.maxMessages || 20;

    try {
      const response = await this.nc.request(
        `/ocs/v2.php/apps/spreed/api/v1/chat/${roomToken}?lookIntoFuture=0&limit=${limit}&includeLastKnown=0`,
        {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'OCS-APIRequest': 'true'
          },
          endpointGroup: 'talk'
          // Note: No cacheTtlMs override — use talk group default (5s)
        }
      );

      // NCRequestManager returns {status, body, headers} where body is pre-parsed JSON
      // But also handle fetch-style response.json() for compatibility
      let data;
      if (response.body && typeof response.body === 'object') {
        data = response.body;
      } else if (typeof response.json === 'function') {
        data = await response.json();
      } else {
        data = response;
      }

      const messages = data?.ocs?.data || [];
      return this._formatMessages(messages, options.excludeMessageId);
    } catch (err) {
      this.logger.error('[ConversationContext] Failed to fetch history:', err.message);
      return [];  // Graceful degradation — proceed without history
    }
  }

  /**
   * Format raw Talk messages into conversation history.
   * Filters, sorts chronologically, trims to token budget.
   *
   * @param {Array} rawMessages - Raw messages from Talk API
   * @param {number} [excludeId] - Message ID to exclude
   * @returns {Array<{role: string, name: string, content: string, timestamp: number}>}
   * @private
   */
  _formatMessages(rawMessages, excludeId) {
    const now = Date.now();
    const maxAge = this.config.maxMessageAge || 7200000;
    const ncUser = this.nc.ncUser || 'moltagent';

    let messages = rawMessages
      // Filter out system messages (joins, leaves, etc.)
      .filter(m => !m.systemMessage || m.systemMessage === '')
      // Filter out the trigger message if specified
      .filter(m => !excludeId || m.id !== String(excludeId) && m.id !== Number(excludeId))
      // Filter out messages that are too old
      .filter(m => (now - m.timestamp * 1000) < maxAge)
      // Sort chronologically (Talk API returns newest-first, we want oldest-first)
      .reverse()
      // Map to conversation format
      .map(m => ({
        role: m.actorId === ncUser ? 'assistant' : 'user',
        name: m.actorDisplayName || m.actorId,
        content: m.message || '',
        timestamp: m.timestamp
      }));

    // Trim to token budget (rough estimate: 1 token ≈ 4 chars)
    const maxChars = (this.config.maxTokenEstimate || 4000) * 4;
    let totalChars = 0;
    const trimmed = [];

    // Keep most recent messages within budget (iterate from end)
    for (let i = messages.length - 1; i >= 0; i--) {
      const msgChars = messages[i].content.length + messages[i].name.length + 10;
      if (totalChars + msgChars > maxChars) break;
      totalChars += msgChars;
      trimmed.unshift(messages[i]);
    }

    return trimmed;
  }

  /**
   * Format conversation history as a string for LLM prompt injection.
   *
   * @param {Array} history - Output from getHistory()
   * @returns {string} Formatted conversation context
   */
  formatForPrompt(history) {
    if (!history || history.length === 0) return '';

    const lines = history.map(m => {
      const role = m.role === 'assistant' ? 'Moltagent' : m.name;
      return `${role}: ${m.content}`;
    });

    return `<conversation_history>\n${lines.join('\n\n')}\n</conversation_history>`;
  }
}

module.exports = { ConversationContext };
