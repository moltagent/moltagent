/**
 * IntentRouter — LLM-powered intent classification with conversation context.
 *
 * Replaces regex-based classification in MicroPipeline's _classify() with a
 * single LLM call that receives the last 2 exchanges of conversation context.
 * All intents (including greetings) go through the LLM for accurate
 * classification. On timeout the router retries once (cold-start grace),
 * then falls back to a lightweight regex classifier that keeps most messages
 * local instead of routing to cloud.
 *
 * @module agent/intent-router
 * @version 1.2.0
 */

'use strict';

const VALID_INTENTS = new Set([
  'greeting', 'chitchat', 'confirmation', 'selection',
  'deck', 'calendar', 'email', 'wiki', 'file', 'search',
  'complex'
]);

const DOMAIN_INTENTS = new Set(['deck', 'calendar', 'email', 'wiki', 'file', 'search']);

const COMPLEX_FALLBACK = Object.freeze({ intent: 'complex', domain: null, needsHistory: true, confidence: 0 });

const INTENT_FORMAT = Object.freeze({
  type: 'object',
  properties: {
    intent: { type: 'string' }
  },
  required: ['intent']
});

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
   * Retries once on timeout (cold-start grace), then falls back to regex.
   *
   * @param {string} message - User message text
   * @param {Array} [recentContext=[]] - Last 4 context entries (2 exchanges)
   * @returns {Promise<{intent: string, domain: string|null, needsHistory: boolean, confidence: number}>}
   */
  async classify(message, recentContext = []) {
    message = message || '';
    try {
      return await this._classifyOnce(message, recentContext, this.timeout);
    } catch (err) {
      // First attempt failed — retry with 2× timeout (cold-start grace)
      if (this._isTimeoutError(err)) {
        try {
          return await this._classifyOnce(message, recentContext, this.timeout * 2);
        } catch (_retryErr) {
          // Both attempts failed — use regex fallback (routes local, not cloud)
          return this._regexFallback(message);
        }
      }
      // Non-timeout error — use regex fallback
      return this._regexFallback(message);
    }
  }

  /**
   * Single classification attempt with the given timeout.
   * @param {string} message
   * @param {Array} recentContext
   * @param {number} timeout
   * @returns {Promise<{intent: string, domain: string|null, needsHistory: boolean, confidence: number}>}
   * @private
   */
  async _classifyOnce(message, recentContext, timeout) {
    const prompt = this._buildPrompt(message, recentContext);

    const result = await this.provider.chat({
      messages: [{ role: 'user', content: prompt }],
      timeout,
      format: INTENT_FORMAT
    });

    return this._parseClassification(result.content || '');
  }

  /**
   * Check whether an error is a timeout/abort error.
   * @param {Error} err
   * @returns {boolean}
   * @private
   */
  _isTimeoutError(err) {
    const msg = (err && err.message || '').toLowerCase();
    return msg.includes('timed out') || msg.includes('timeout') || msg.includes('aborted');
  }

  /**
   * Lightweight regex-based fallback when LLM is unavailable.
   * Keeps most messages local instead of routing everything to cloud.
   * @param {string} message
   * @returns {{intent: string, domain: string|null, needsHistory: boolean, confidence: number}}
   * @private
   */
  _regexFallback(message) {
    const lower = message.toLowerCase().trim();

    // Domain keywords
    if (/\b(schedule\w*|calendar|events?|meetings?|appointments?|agenda)\b/.test(lower)) {
      return { intent: 'domain', domain: 'calendar', needsHistory: false, confidence: 0.5 };
    }
    if (/\b(emails?|mail|send.*to|inbox)\b/.test(lower)) {
      return { intent: 'domain', domain: 'email', needsHistory: false, confidence: 0.5 };
    }
    if (/\b(tasks?|cards?|boards?|deck|todos?)\b/.test(lower)) {
      return { intent: 'domain', domain: 'deck', needsHistory: false, confidence: 0.5 };
    }
    if (/\b(wiki|page|knowledge|note)\b/.test(lower)) {
      return { intent: 'domain', domain: 'wiki', needsHistory: false, confidence: 0.5 };
    }
    if (/\b(file|folder|document|upload|download)\b/.test(lower)) {
      return { intent: 'domain', domain: 'file', needsHistory: false, confidence: 0.5 };
    }
    if (/\b(search|find|look up|what do you know)\b/.test(lower)) {
      return { intent: 'domain', domain: 'search', needsHistory: false, confidence: 0.5 };
    }

    // Short messages → greeting/chitchat
    if (lower.split(/\s+/).length <= 8) {
      return { intent: 'chitchat', domain: null, needsHistory: false, confidence: 0.4 };
    }

    // Long unmatched → complex (cloud) — only case that still goes to cloud
    return { ...COMPLEX_FALLBACK, confidence: 0.3 };
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

    return `Classify this message into exactly ONE intent.

Intents:
- greeting: hello, hi, good morning
- chitchat: casual talk, opinions, jokes, how are you
- confirmation: yes, no, ok, sure, do it, go ahead, cancel (references prior message)
- selection: numeric choice like "2", "1.", "#3" (references prior list)
- deck: task/card/board management
- calendar: events, meetings, scheduling, "what's on my schedule", "what do I have today/this week", agenda
- email: send/read email
- wiki: wiki pages, knowledge base
- file: file/folder operations
- search: find information, look up, what do you know about
- complex: multi-part request, unclear, or spans multiple domains

Rules:
- If message references prior conversation → confirmation or selection, NOT a domain
- If message asks about schedule, agenda, or what's happening today → calendar
- Single clear domain → that domain
- Multiple domains or unclear → complex
- If unsure → complex
${contextBlock}
Message: "${message.substring(0, 300)}"

Set intent to the matching category.`;
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
