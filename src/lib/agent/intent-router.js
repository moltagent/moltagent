/**
 * IntentRouter — LLM-powered intent classification with conversation context.
 *
 * Replaces regex-based classification in MicroPipeline's _classify() with a
 * single LLM call that receives the last 2 exchanges of conversation context.
 * All intents (including greetings) go through the LLM for accurate
 * classification. On any error/timeout the router falls back to a safe
 * "complex" classification that routes to cloud AgentLoop.
 *
 * @module agent/intent-router
 * @version 1.1.0
 */

'use strict';

const VALID_INTENTS = new Set([
  'greeting', 'chitchat', 'confirmation', 'selection',
  'deck', 'calendar', 'email', 'wiki', 'file', 'search',
  'complex'
]);

const DOMAIN_INTENTS = new Set(['deck', 'calendar', 'email', 'wiki', 'file', 'search']);

const COMPLEX_FALLBACK = Object.freeze({ intent: 'complex', domain: null, needsHistory: true, confidence: 0 });

class IntentRouter {
  /**
   * @param {Object} opts
   * @param {Object} opts.provider - OllamaToolsProvider (uses .chat() without tools)
   * @param {Object} [opts.config]
   * @param {number} [opts.config.classifyTimeout=10000]
   */
  constructor({ provider, config = {} } = {}) {
    this.provider = provider;
    this.timeout = config.classifyTimeout || 10000;
  }

  /**
   * Classify a user message into an intent.
   *
   * @param {string} message - User message text
   * @param {Array} [recentContext=[]] - Last 4 context entries (2 exchanges)
   * @returns {Promise<{intent: string, domain: string|null, needsHistory: boolean, confidence: number}>}
   */
  async classify(message, recentContext = []) {
    try {
      const prompt = this._buildPrompt(message, recentContext);

      const result = await this.provider.chat({
        messages: [{ role: 'user', content: prompt }],
        timeout: this.timeout
      });

      return this._parseClassification(result.content || '');
    } catch (err) {
      // Any error (timeout, network, parse) → safe cloud fallback
      return { ...COMPLEX_FALLBACK };
    }
  }

  /**
   * Build the classification prompt with conversation context.
   * @param {string} message
   * @param {Array} recentContext
   * @returns {string}
   * @private
   */
  _buildPrompt(message, recentContext) {
    const contextBlock = recentContext.length > 0
      ? '\nRecent conversation:\n' + recentContext.slice(-4).map(c =>
          `${c.role}: ${(c.content || '').substring(0, 150)}`
        ).join('\n') + '\n'
      : '';

    return `/no_think
Classify this message into exactly ONE intent. Reply with JSON only.

Intents:
- greeting: hello, hi, good morning
- chitchat: casual talk, opinions, jokes, how are you
- confirmation: yes, no, ok, sure, do it, go ahead, cancel (references prior message)
- selection: numeric choice like "2", "1.", "#3" (references prior list)
- deck: task/card/board management
- calendar: events, meetings, scheduling
- email: send/read email
- wiki: wiki pages, knowledge base
- file: file/folder operations
- search: find information, look up, what do you know about
- complex: multi-part request, unclear, or spans multiple domains

Rules:
- If message references prior conversation → confirmation or selection, NOT a domain
- Single clear domain → that domain
- Multiple domains or unclear → complex
- If unsure → complex
${contextBlock}
Message: "${message.substring(0, 300)}"

Reply ONLY with: {"intent":"<intent>"}`;
  }

  /**
   * Parse LLM classification response into structured result.
   * @param {string} content - Raw LLM response
   * @returns {{intent: string, domain: string|null, needsHistory: boolean, confidence: number}}
   * @private
   */
  _parseClassification(content) {
    // Strip think tags and markdown fences
    let cleaned = content
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/```(?:json)?\s*/g, '')
      .replace(/```/g, '')
      .trim();

    // Extract JSON object
    const match = cleaned.match(/\{[^}]+\}/);
    if (!match) return { ...COMPLEX_FALLBACK };

    try {
      const parsed = JSON.parse(match[0]);
      const intent = (parsed.intent || '').toLowerCase().trim();

      if (!intent || !VALID_INTENTS.has(intent)) {
        return { ...COMPLEX_FALLBACK };
      }

      // Domain intents get mapped
      if (DOMAIN_INTENTS.has(intent)) {
        return { intent: 'domain', domain: intent, needsHistory: false, confidence: 0.8 };
      }

      // Confirmation/selection need history
      if (intent === 'confirmation' || intent === 'selection') {
        return { intent, domain: null, needsHistory: true, confidence: 0.8 };
      }

      // Complex needs history
      if (intent === 'complex') {
        return { intent: 'complex', domain: null, needsHistory: true, confidence: 0.7 };
      }

      // Greeting, chitchat
      return { intent, domain: null, needsHistory: false, confidence: 0.9 };
    } catch {
      return { ...COMPLEX_FALLBACK };
    }
  }

}

module.exports = IntentRouter;
