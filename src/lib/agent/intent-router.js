/**
 * IntentRouter — Three-gate intent classification with dual-model routing.
 *
 * Messages are classified into three gates: knowledge (default), action
 * (user wants to DO something), or compound (both knowledge and action).
 * Regex pre-router (~0ms) sends ~70% of messages to qwen2.5:3b (~420ms)
 * and ~30% ambiguous messages to qwen3:8b (~20-30s). If the fast model
 * returns an unconfident result, auto-escalates to the smart model.
 * If either model times out, falls back to the other. If both fail,
 * regex fallback keeps most messages local.
 *
 * @module agent/intent-router
 * @version 3.0.0
 */

'use strict';

const VALID_GATES = new Set([
  'knowledge', 'action', 'compound'
]);

// Passthrough intents — not gates, but valid classifier outputs
const PASSTHROUGH_INTENTS = new Set([
  'greeting', 'chitchat', 'confirmation', 'selection', 'complex', 'unknown'
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

const COMPLEX_FALLBACK = Object.freeze({ gate: 'knowledge', intent: 'knowledge', domain: null, needsHistory: false, confidence: 0 });

const INTENT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    gate: { type: 'string' },
    domain: { type: 'string' },
    confidence: { type: 'number' }
  },
  required: ['gate']
});

/**
 * Classification prompt — three-gate system (knowledge/action/compound).
 * Constrained decoding + schema handle output format.
 * Context-aware rules help the LLM use conversation history for disambiguation.
 */
const CLASSIFICATION_SYSTEM_PROMPT = `Classify the LAST user message into exactly ONE category.

ACTION — The user wants you to DO something.
  The message contains a clear action verb:
  create, make, set up, build, send, draft, compose, reply,
  book, schedule, move, assign, update, delete, remove, remind, add,
  upload, download, save, store, forward, write, remember, forget.

  Examples:
  "Create a board for content planning" → action, domain: deck
  "Send an email to Carlos" → action, domain: email
  "Book a meeting for Tuesday at 3pm" → action, domain: calendar
  "Move the onboarding card to Done" → action, domain: deck
  "Save this to the wiki: Project X uses React" → action, domain: wiki
  "Remind me to call Sarah next Monday" → action, domain: deck
  "Remember this: our budget is 50k" → action, domain: wiki
  "Upload the report" → action, domain: file

COMPOUND — The user wants BOTH knowledge AND action in one message.
  Contains a question AND an action request. Often uses "and", "then",
  "if...then", "before", "after" to connect them.

  Examples:
  "Check if Carlos is available Tuesday and book a meeting" → compound, domain: calendar
  "What's the status of onboarding and create a follow-up task" → compound, domain: deck
  "Find the Q3 report and send it to Maria" → compound, domain: email

KNOWLEDGE — Everything else. THIS IS THE DEFAULT.
  The user wants to know something. Any question. Any lookup.
  Any request for information. Anything ambiguous. Anything
  you're not sure about.

  Examples:
  "Who is Carlos?" → knowledge
  "What's Carlos's email?" → knowledge (NOT email — no action verb)
  "What's the status of onboarding?" → knowledge (NOT deck — no action verb)
  "What boards do I have?" → knowledge
  "Tell me about Paradiesgarten" → knowledge
  "What's the weather in Lisbon?" → knowledge
  "How does our onboarding process work?" → knowledge
  "What meetings do I have?" → knowledge (asking for information)
  "What tasks are in review?" → knowledge

THE CRITICAL TEST:
  Does the message contain an ACTION VERB (create, send, move, book, delete, remind...)?
    YES + no question → action
    YES + also a question → compound
    NO → knowledge

  "What's Carlos's email?" → No action verb → knowledge
  "Send Carlos an email" → "Send" is action verb → action
  "Check Carlos's email and send him a meeting invite" → question + action → compound

When in doubt → knowledge. Always safe. Never wrong to search and synthesize.

CONTEXT-AWARE RULES:
- Read the <conversation> block FIRST. The user's message usually continues the current topic.
- If the assistant just showed calendar results, the user is probably still talking about calendar.
- If the assistant just listed Deck cards, the user is probably still talking about Deck.
- If the assistant just showed emails, the user is probably still talking about email.
- If the assistant just listed files, the user is probably still talking about files.
- If the message references something from the conversation ("that one", "delete it", "the first", "move it to done"), classify based on what the conversation was about.
- "Delete the dentist" after a calendar listing = action, domain: calendar
- "Move the first one to done" after a Deck listing = action, domain: deck
- "Send it" after an email draft = action, domain: email
- "Read the most recent one" after a file listing = action, domain: file
- When uncertain, prefer the domain of the most recent assistant action for continuations.
- When uncertain and NOT continuing a conversation, prefer knowledge.

Return JSON:
{
  "gate": "knowledge" | "action" | "compound",
  "domain": "deck" | "calendar" | "email" | "wiki" | "file" | null,
  "confidence": 0.0-1.0
}

domain is only set when gate is "action" or "compound".
For "knowledge", domain is always null.
For greetings/chitchat, return: {"gate": "greeting", "confidence": 0.9} or {"gate": "chitchat", "confidence": 0.9}
For confirmations (yes/no after a question), return: {"gate": "confirmation", "confidence": 0.8}

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
      if (!useSmartModel && ((result.gate === 'knowledge' && result.confidence === 0) || result.gate === 'unknown')) {
        try {
          return this._postClassifyGuard(await this._classifyWithModel(this.smartModel, message, recentContext), message);
        } catch (_retryErr) {
          return this._postClassifyGuard(this._regexFallback(message), message);
        }
      }

      return this._postClassifyGuard(result, message);
    } catch (err) {
      // Primary model failed — try the other one
      const fallbackModel = model === this.fastModel ? this.smartModel : this.fastModel;
      try {
        return this._postClassifyGuard(await this._classifyWithModel(fallbackModel, message, recentContext), message);
      } catch (_fallbackErr) {
        // Both models failed — regex fallback
        return this._postClassifyGuard(this._regexFallback(message), message);
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
   * @returns {{gate: string, intent: string, domain: string|null, needsHistory: boolean, confidence: number, compound: boolean}}
   * @private
   */
  _regexFallback(message) {
    const lower = message.toLowerCase().trim();

    // Action verb detection
    // Note: "schedule" as verb ("schedule a meeting") vs noun ("my schedule") is ambiguous.
    // We include it here and rely on the knowledge patterns below to catch "what's on my schedule".
    const hasActionVerb = /\b(create|make|set\s+up|build|send|draft|compose|reply|book|schedule\s+(a|an|the|my)|move|assign|update|delete|remove|remind|add|upload|download|save|store|forward|write|remember|forget)\b/.test(lower);

    // Compound detection: action verb + connector + another operation
    const compound = hasActionVerb && (
      /\b(and\s+(then\s+)?(check|create|find|send|book|search|move|list|remind|look|tell|show))\b/.test(lower) ||
      /\b(if\s+(not|no|none|empty|nothing)|then\s+(create|send|book|remind|add|move))\b/.test(lower) ||
      /,\s*(and\s+)?(check|create|find|send|book|search|move|list|remind|look|tell|show)\b/.test(lower)
    );

    // Domain detection
    let domain = null;
    if (/\b(schedule\w*|calendar|events?|meetings?|appointments?|agenda)\b/.test(lower)) domain = 'calendar';
    else if (/\b(emails?|mail|inbox)\b/.test(lower)) domain = 'email';
    else if (/\b(tasks?|cards?|boards?|deck|todos?|move\b.+\b(to done|to doing|to inbox|to working|to queued))\b/.test(lower)) domain = 'deck';
    else if (/\b(wiki|page|knowledge|note)\b/.test(lower)) domain = 'wiki';
    else if (/\b(file|folder|document|upload|download)\b/.test(lower)) domain = 'file';

    // Route based on action verb presence
    if (hasActionVerb && domain) {
      const gate = compound ? 'compound' : 'action';
      return {
        gate, intent: domain,
        domain, needsHistory: false, confidence: 0.5, compound
      };
    }

    // Knowledge queries — questions about people, projects, status
    if (/\b(who is|what is|what'?s|what do you know|tell me about|what about|do i have|show me|any .{0,20}(today|tomorrow|this week|next week)|summarize|how does|how do)\b/.test(lower)) {
      return { gate: 'knowledge', intent: 'knowledge', domain: null, needsHistory: false, confidence: 0.5, compound: false };
    }

    // Memory language → action:wiki (remember/forget are action verbs)
    if (/\b(remember|forget|forgot|told you|decision|stored)\b/.test(lower)) {
      return { gate: 'action', intent: 'wiki', domain: 'wiki', needsHistory: false, confidence: 0.5, compound: false };
    }

    // Short messages → greeting/chitchat
    if (lower.split(/\s+/).length <= 8) {
      return { gate: 'chitchat', intent: 'chitchat', domain: null, needsHistory: false, confidence: 0.4, compound: false };
    }

    // Default: knowledge (NOT complex — knowledge is always the safe default)
    return { gate: 'knowledge', intent: 'knowledge', domain: null, needsHistory: false, confidence: 0.3, compound: false };
  }

  /**
   * Parse LLM classification response into structured result.
   * Handles both three-gate format (gate/domain) and legacy intent format.
   * @param {string} content - Raw LLM response
   * @returns {{gate: string, intent: string, domain: string|null, needsHistory: boolean, confidence: number, compound: boolean}}
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
      let gate = (parsed.gate || '').toLowerCase().trim();
      let domain = (parsed.domain || '').toLowerCase().trim() || null;
      const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.8;

      // Legacy format: LLM returned {"intent":"..."} instead of {"gate":"..."}
      if (!gate && parsed.intent) {
        const intent = parsed.intent.toLowerCase().trim();
        if (intent === 'knowledge') {
          gate = 'knowledge';
        } else if (INTENT_TO_DOMAIN[intent]) {
          gate = 'action';
          domain = INTENT_TO_DOMAIN[intent];
        } else if (DOMAIN_INTENTS.has(intent)) {
          gate = 'action';
          domain = intent;
        } else if (PASSTHROUGH_INTENTS.has(intent)) {
          gate = intent;
        } else {
          return { ...COMPLEX_FALLBACK, compound: parsed.compound === true };
        }
      }

      // Validate gate
      if (!gate || (!VALID_GATES.has(gate) && !PASSTHROUGH_INTENTS.has(gate))) {
        return { ...COMPLEX_FALLBACK, compound: parsed.compound === true };
      }

      const compound = gate === 'compound' || parsed.compound === true;

      // Unknown → knowledge (knowledge is the safe default)
      if (gate === 'unknown') {
        gate = 'knowledge';
        domain = null;
      }

      // Build result based on gate
      let result;
      if (gate === 'action') {
        result = { gate: 'action', domain: domain || null, needsHistory: false, confidence, compound };
      } else if (gate === 'compound') {
        result = { gate: 'compound', domain: domain || null, needsHistory: false, confidence, compound: true };
      } else if (gate === 'knowledge') {
        result = { gate: 'knowledge', domain: null, needsHistory: false, confidence, compound };
      } else if (gate === 'confirmation' || gate === 'selection') {
        result = { gate, domain: null, needsHistory: true, confidence, compound };
      } else if (gate === 'complex') {
        result = { gate: 'complex', domain: null, needsHistory: true, confidence: Math.min(confidence, 0.7), compound };
      } else {
        // greeting, chitchat
        result = { gate, domain: null, needsHistory: false, confidence, compound };
      }

      // Backward-compat shim: code reading result.intent still works
      // action → domain name, compound → domain name, others → gate name
      result.intent = (result.gate === 'action' || result.gate === 'compound')
        ? (result.domain || 'complex')
        : result.gate;

      return result;
    } catch {
      return { ...COMPLEX_FALLBACK };
    }
  }

  /**
   * Post-classification guard: catches action-gate false positives.
   *
   * The fast model may classify a question as "action" because it contains
   * a domain keyword. This guard overrides to knowledge when there is no
   * action verb present — the single reliable signal for an action gate.
   *
   * @param {Object} result - Classification result
   * @param {string} message - Original user message
   * @returns {Object} Possibly corrected classification result
   * @private
   */
  _postClassifyGuard(result, message) {
    if (!result || !message) return result;

    // Guard: if classifier said "action" or "compound" but there's no action verb — override to knowledge
    if (result.gate === 'action' || result.gate === 'compound') {
      const actionVerbs = /\b(create|make|set\s+up|build|send|draft|compose|reply|book|schedule|move|assign|update|delete|remove|remind|add|upload|download|save|store|forward|write|remember|forget)\b/i;
      if (!actionVerbs.test(message)) {
        result.gate = 'knowledge';
        result.domain = null;
        result.intent = 'knowledge';
        result.compound = false;
      }
    }

    // Guard: action with question + connector → compound
    if (result.gate === 'action') {
      const hasQuestion = /\b(what|who|how|where|when|tell me|show me|check|find|know)\b/i.test(message);
      const hasConnector = /\b(and|then|also|plus|before|after)\b/i.test(message);
      if (hasQuestion && hasConnector) {
        result.gate = 'compound';
        result.compound = true;
        // Keep domain from the action classification
        result.intent = result.domain || 'complex';
      }
    }

    return result;
  }

}

// Export class and pre-router function
IntentRouter.needsSmartClassifier = needsSmartClassifier;
IntentRouter.CLASSIFICATION_SYSTEM_PROMPT = CLASSIFICATION_SYSTEM_PROMPT;
IntentRouter.VALID_GATES = VALID_GATES;

module.exports = IntentRouter;
