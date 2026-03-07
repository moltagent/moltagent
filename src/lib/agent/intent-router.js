/**
 * IntentRouter — Dual-model intent classification with regex pre-router.
 *
 * Regex pre-router (~0ms) sends ~70% of messages to qwen2.5:3b (~420ms)
 * and ~30% ambiguous messages to qwen3:8b (~20-30s). If qwen2.5:3b
 * returns 'unknown', auto-escalates to qwen3:8b before cloud. If
 * either model times out, falls back to the other. If both fail,
 * regex fallback keeps most messages local.
 *
 * @module agent/intent-router
 * @version 2.0.0
 */

'use strict';

const VALID_INTENTS = new Set([
  'greeting', 'chitchat', 'confirmation', 'selection',
  'deck', 'calendar', 'email', 'wiki', 'file', 'search',
  'knowledge',
  'complex',
  // Fine-grained intents from Path C prompt (mapped to broad domains)
  'calendar_create', 'calendar_query', 'calendar_update', 'calendar_delete',
  'deck_create', 'deck_move', 'deck_query',
  'wiki_write', 'wiki_read',
  'email_send', 'email_read',
  'file_upload', 'file_query',
  'unknown'
]);

// Map fine-grained intents to domain routing
const INTENT_TO_DOMAIN = {
  calendar_create: 'calendar', calendar_query: 'calendar',
  calendar_update: 'calendar', calendar_delete: 'calendar',
  deck_create: 'deck', deck_move: 'deck', deck_query: 'deck',
  wiki_write: 'wiki', wiki_read: 'wiki',
  email_send: 'email', email_read: 'email',
  file_upload: 'file', file_query: 'file',
};

const DOMAIN_INTENTS = new Set(['deck', 'calendar', 'email', 'wiki', 'file', 'search', 'knowledge']);

const COMPLEX_FALLBACK = Object.freeze({ intent: 'complex', domain: null, needsHistory: true, confidence: 0 });

const INTENT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    intent: { type: 'string' }
  },
  required: ['intent']
});

/**
 * Classification prompt — description + context-aware rules.
 * Constrained decoding + schema handle output format.
 * Context-aware rules help the LLM use conversation history for disambiguation.
 */
const CLASSIFICATION_SYSTEM_PROMPT = `Classify the LAST user message into exactly one intent.

Available intents:

TOOL INTENTS (the user wants you to DO something):
- calendar_create: Create a new calendar event or meeting
- calendar_query: List or check existing events
- calendar_update: Modify, reschedule, or add people to an existing event
- calendar_delete: Cancel or remove an event
- deck_create: Create a new task card
- deck_move: Move a task card to a different column or mark complete
- deck_query: List or check existing tasks
- wiki_write: Store or remember information for later
- email_send: Compose or send an email
- email_read: Check or search emails
- file_upload: Upload or save a file
- file_query: Find or list files
- search: Research a topic on the web

KNOWLEDGE INTENT (the user wants to KNOW something):
- knowledge: Any question about people, projects, status, or information
  "Who is Carlos?" → knowledge (NOT email)
  "What's Carlos's email?" → knowledge (NOT email)
  "What's the status of onboarding?" → knowledge (NOT calendar or deck)
  "Tell me about the Paradiesgarten client" → knowledge
  "Summarize what you know about X" → knowledge
  "What do you know about Y?" → knowledge
  "What meetings do I have?" → knowledge (asking for information)

OTHER INTENTS:
- wiki_read: ONLY when user asks to read a specific wiki page by name
- chitchat: Greetings, small talk, casual conversation
- unknown: Unclear or doesn't match any intent

CRITICAL DISTINCTION — action vs question:
- "Send an email to Carlos" → email_send (ACTION: send)
- "What's Carlos's email?" → knowledge (QUESTION: asking for info)
- "Book a meeting tomorrow" → calendar_create (ACTION: create)
- "What meetings do I have?" → knowledge (QUESTION: asking for info)
- "Create a board" → deck_create (ACTION: create)
- "What boards do I have?" → deck_query (ACTION: list is a tool action)
- "Move the onboarding card to done" → deck_move (ACTION: move)
- "What's the status of onboarding?" → knowledge (QUESTION: asking for info)
- When in doubt → knowledge (safer to search than call the wrong API)

Rules:
- CRITICAL: Read the <conversation> block FIRST. The user's message usually continues the current topic.
- If the assistant just showed calendar results, the user is probably still talking about calendar.
- If the assistant just listed Deck cards, the user is probably still talking about Deck.
- If the assistant just showed emails, the user is probably still talking about email.
- If the assistant just listed files, the user is probably still talking about files.
- If the message references something from the conversation ("that one", "delete it", "the first", "move it to done"), classify based on what the conversation was about, NOT the literal words.
- "Delete the dentist" after a calendar listing = calendar_delete (not chitchat)
- "Move the first one to done" after a Deck listing = deck_move (not unknown)
- "Send it" after an email draft = email_send (not unknown)
- "Read the most recent one" after a file listing = file_query (not wiki_read)
- Only classify as unknown if the task genuinely doesn't match any intent AND is not a continuation of the current topic.
- When uncertain, prefer the domain of the most recent assistant action for continuations.
- When uncertain and NOT continuing a conversation, prefer knowledge over a domain executor.

Respond with JSON only.`;

/**
 * Detect messages that require deeper comprehension (qwen3:8b)
 * vs messages with explicit verbs that the fast model handles fine.
 *
 * Two failure clusters identified in benchmarking:
 * 1. Wiki/memory language — conversational verbs phi misclassifies
 * 2. Contextual references — pronouns/references to prior actions
 *
 * @param {string} message - User message text
 * @returns {boolean} true → route to smart model, false → route to fast model
 */
function needsSmartClassifier(message) {
  if (!message) return false;
  const lower = message.toLowerCase();

  // Wiki/memory language — phi confuses these with chitchat or swaps read/write
  if (/\b(remember|forget|forgot|don't forget|told you|asked you|stored|decide[d]?|decision)\b/.test(lower)) return true;

  // Contextual references — phi can't resolve "that one", "you just created"
  if (/\b(you just|that one|that event|that meeting|that task|the last one|the most recent|the latest|the newest|never mind)\b/.test(lower)) return true;

  return false;
}

class IntentRouter {
  /**
   * @param {Object} opts
   * @param {Object} opts.provider - OllamaToolsProvider (uses .chat() with model override)
   * @param {Object} [opts.config]
   * @param {number} [opts.config.classifyTimeout=10000]
   * @param {string} [opts.config.fastModel='qwen2.5:3b'] - Fast model for explicit intents
   * @param {string} [opts.config.smartModel='qwen3:8b'] - Smart model for ambiguous intents
   */
  constructor({ provider, config = {} } = {}) {
    this.provider = provider;
    this.timeout = config.classifyTimeout || 10000;
    this.fastModel = config.fastModel || 'qwen2.5:3b';
    this.smartModel = config.smartModel || 'qwen3:8b';
  }

  /**
   * Classify a user message into an intent using dual-model routing.
   *
   * 1. Regex pre-router picks fast or smart model (~0ms)
   * 2. Fast model returns unknown → auto-escalate to smart model
   * 3. Model timeout → fallback to the other model
   * 4. Both fail → regex fallback
   *
   * @param {string} message - User message text
   * @param {Array} [recentContext=[]] - Last 6 context entries (3 exchanges)
   * @param {Object} [context={}] - { replyFn } for thinking indicator
   * @returns {Promise<{intent: string, domain: string|null, needsHistory: boolean, confidence: number}>}
   */
  async classify(message, recentContext = [], context = {}) {
    message = message || '';
    const useSmartModel = needsSmartClassifier(message);
    const model = useSmartModel ? this.smartModel : this.fastModel;

    // Send thinking indicator for slow model
    if (useSmartModel && context.replyFn) {
      context.replyFn('\u{1F914} Let me think deeper about that...').catch(() => {});
    }

    try {
      const result = await this._classifyWithModel(model, message, recentContext);

      // If fast model returns unknown, retry with smart model
      if (!useSmartModel && ((result.intent === 'complex' && result.confidence === 0) || result.intent === 'unknown')) {
        try {
          return await this._classifyWithModel(this.smartModel, message, recentContext);
        } catch (_retryErr) {
          return this._regexFallback(message);
        }
      }

      return result;
    } catch (err) {
      // Primary model failed — try the other one
      const fallbackModel = model === this.fastModel ? this.smartModel : this.fastModel;
      try {
        return await this._classifyWithModel(fallbackModel, message, recentContext);
      } catch (_fallbackErr) {
        // Both models failed — regex fallback
        return this._regexFallback(message);
      }
    }
  }

  /**
   * Classify with a specific model.
   *
   * @param {string} model - Ollama model name
   * @param {string} message - User message
   * @param {Array} recentContext - Recent conversation context
   * @returns {Promise<{intent: string, domain: string|null, needsHistory: boolean, confidence: number}>}
   * @private
   */
  async _classifyWithModel(model, message, recentContext = []) {
    const userContent = this._buildUserContent(message, recentContext);
    const timeout = model === this.smartModel ? this.timeout * 4 : this.timeout;

    const result = await this.provider.chat({
      model,
      system: CLASSIFICATION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
      timeout,
      format: INTENT_SCHEMA,
      options: {
        num_ctx: 2048,
        temperature: 0.1
      }
    });

    return this._parseClassification(result.content || '');
  }

  /**
   * Build the user content string with optional conversation context.
   * @param {string} message
   * @param {Array} recentContext
   * @returns {string}
   * @private
   */
  _buildUserContent(message, recentContext) {
    let contextBlock = '';
    if (recentContext.length > 0) {
      const formatted = recentContext.slice(-6).map(c => {
        const safe = (typeof c.content === 'string' ? c.content : String(c.content || '')).substring(0, 200).replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return `${c.role}: ${safe}`;
      }).join('\n');
      contextBlock = `\n<conversation>\n${formatted}\n</conversation>\n\n`;
    }

    return `${contextBlock}${message.substring(0, 300)}`;
  }

  /**
   * Lightweight regex-based fallback when both LLM models are unavailable.
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
    if (/\b(tasks?|cards?|boards?|deck|todos?|move\b.+\b(to done|to doing|to inbox|to working|to queued))\b/.test(lower)) {
      return { intent: 'domain', domain: 'deck', needsHistory: false, confidence: 0.5 };
    }
    if (/\b(wiki|page|knowledge|note)\b/.test(lower)) {
      return { intent: 'domain', domain: 'wiki', needsHistory: false, confidence: 0.5 };
    }
    if (/\b(file|folder|document|upload|download)\b/.test(lower)) {
      return { intent: 'domain', domain: 'file', needsHistory: false, confidence: 0.5 };
    }
    if (/\b(search|find|look up|look for)\b/.test(lower)) {
      // Knowledge questions take priority over generic search
      if (/\b(who is|what is|what do you know|tell me about|what'?s the status|what about)\b/.test(lower)) {
        return { intent: 'domain', domain: 'knowledge', needsHistory: false, confidence: 0.5 };
      }
      return { intent: 'domain', domain: 'search', needsHistory: false, confidence: 0.5 };
    }

    // Knowledge queries — questions about people, projects, status
    if (/\b(who is|what is|what do you know|tell me about|what'?s the status|what about|what'?s .{0,20} email|summarize)\b/.test(lower)) {
      return { intent: 'domain', domain: 'knowledge', needsHistory: false, confidence: 0.5 };
    }

    // Memory language → wiki write (catches what regex pre-router would send to smart model)
    if (/\b(remember|forget|forgot|told you|decision|stored)\b/.test(lower)) {
      return { intent: 'domain', domain: 'wiki', needsHistory: false, confidence: 0.5 };
    }

    // Short messages → greeting/chitchat
    if (lower.split(/\s+/).length <= 8) {
      return { intent: 'chitchat', domain: null, needsHistory: false, confidence: 0.4 };
    }

    // Long unmatched → complex (cloud) — only case that still goes to cloud
    return { ...COMPLEX_FALLBACK, confidence: 0.3 };
  }

  /**
   * Parse LLM classification response into structured result.
   * Handles both fine-grained (calendar_create) and broad (calendar) intents.
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

      // Unknown → complex (cloud escalation)
      if (intent === 'unknown') {
        return { ...COMPLEX_FALLBACK };
      }

      // Fine-grained intents → map to domain
      if (INTENT_TO_DOMAIN[intent]) {
        return { intent: 'domain', domain: INTENT_TO_DOMAIN[intent], needsHistory: false, confidence: 0.8 };
      }

      // Broad domain intents (legacy / fallback)
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

// Export class and pre-router function
IntentRouter.needsSmartClassifier = needsSmartClassifier;
IntentRouter.CLASSIFICATION_SYSTEM_PROMPT = CLASSIFICATION_SYSTEM_PROMPT;

module.exports = IntentRouter;
