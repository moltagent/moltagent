/**
 * MicroPipeline — Decompose complex user requests into small, focused
 * LLM calls that local models handle reliably.
 *
 * When the system is in all-local mode, the full AgentLoop (20+ tools,
 * full SOUL.md, multi-step reasoning) overwhelms small models. The
 * MicroPipeline classifies intent, then routes to lightweight handlers
 * that each make a single, focused LLM call with minimal context.
 *
 * @module agent/micro-pipeline
 * @version 1.0.0
 */

'use strict';

const GREETING_PATTERNS = /^(hi|hello|hey|good\s*(morning|afternoon|evening)|howdy|yo|sup|what'?s\s*up)\b/i;

const INTENTS = Object.freeze({
  GREETING: 'greeting',
  QUESTION: 'question',
  TASK: 'task',
  COMMAND: 'command',
  COMPLEX: 'complex',
  CHITCHAT: 'chitchat'
});

const GREETING_TEMPLATES = [
  'Hello! How can I help you today?',
  'Hi there! What can I do for you?',
  'Hey! Ready to help. What do you need?'
];

class MicroPipeline {
  /**
   * @param {Object} config
   * @param {Object} config.llmRouter - LLMRouter instance (the real router, not legacy wrapper)
   * @param {Object} [config.memorySearcher] - MemorySearcher instance for search
   * @param {Object} [config.deckClient] - DeckClient instance for task creation
   * @param {Object} [config.calendarClient] - CalDAV client instance
   * @param {Object} [config.talkSendQueue] - TalkSendQueue for notifications
   * @param {Object} [config.deferralQueue] - DeferralQueue for complex tasks
   * @param {Object} [config.logger] - Logger (default: console)
   */
  constructor(config = {}) {
    this.router = config.llmRouter;
    this.memorySearcher = config.memorySearcher || null;
    this.deckClient = config.deckClient || null;
    this.calendarClient = config.calendarClient || null;
    this.talkSendQueue = config.talkSendQueue || null;
    this.deferralQueue = config.deferralQueue || null;
    this.logger = config.logger || console;

    this.stats = {
      processed: 0,
      byIntent: {},
      deferred: 0,
      errors: 0
    };
  }

  /**
   * Process a user message through the micro-pipeline.
   * @param {string} message - User message text
   * @param {Object} [context={}] - { userName, roomToken, warmMemory }
   * @returns {Promise<string>} Response text
   */
  async process(message, context = {}) {
    this.stats.processed++;

    try {
      // Stage 1: Classify intent
      const classification = await this._classify(message);
      const intent = classification.intent || INTENTS.CHITCHAT;

      this.stats.byIntent[intent] = (this.stats.byIntent[intent] || 0) + 1;

      // Stage 2: Route to handler
      switch (intent) {
        case INTENTS.GREETING:
          return this._handleGreeting(context);
        case INTENTS.QUESTION:
          return await this._handleQuestion(message, classification, context);
        case INTENTS.TASK:
          return await this._handleTask(message, classification, context);
        case INTENTS.COMPLEX:
          return await this._handleComplex(message, classification, context);
        case INTENTS.COMMAND:
        case INTENTS.CHITCHAT:
        default:
          return await this._handleChat(message, context);
      }
    } catch (err) {
      this.stats.errors++;
      this.logger.error(`[MicroPipeline] Error: ${err.message}`);
      return 'I had trouble processing that. Could you rephrase or simplify your request?';
    }
  }

  /**
   * Get pipeline statistics.
   * @returns {Object}
   */
  getStats() {
    return { ...this.stats };
  }

  // ---------------------------------------------------------------------------
  // Stage 1: Classification
  // ---------------------------------------------------------------------------

  /**
   * Classify user intent with a tiny, focused LLM call.
   * Falls back to regex heuristics if the LLM call fails.
   * @param {string} message
   * @returns {Promise<Object>} { intent, topics?, names? }
   */
  async _classify(message) {
    // Fast-path: greeting detection via regex (no LLM needed)
    if (GREETING_PATTERNS.test(message.trim())) {
      return { intent: INTENTS.GREETING };
    }

    // Fast-path: short messages (< 5 words) are likely chitchat
    const wordCount = message.trim().split(/\s+/).length;
    if (wordCount <= 2) {
      return { intent: INTENTS.CHITCHAT };
    }

    try {
      const classifyPrompt = `Classify this user message into exactly ONE category. Reply with ONLY the category name, nothing else.

Categories:
- question (asking for information, "what is", "how do", "when", "where", "who")
- task (requesting an action: "create", "add", "send", "schedule", "set up", "move")
- complex (multi-part request, analysis, research, comparison, planning)
- chitchat (casual conversation, opinions, small talk)

Message: "${message.substring(0, 200)}"

Category:`;

      const result = await this.router.route({
        job: 'quick',
        content: classifyPrompt,
        requirements: { maxTokens: 10, temperature: 0 }
      });

      const raw = (result.result || '').trim().toLowerCase().replace(/[^a-z]/g, '');

      if (raw.includes('question')) return { intent: INTENTS.QUESTION };
      if (raw.includes('task')) return { intent: INTENTS.TASK };
      if (raw.includes('complex')) return { intent: INTENTS.COMPLEX };
      if (raw.includes('chitchat')) return { intent: INTENTS.CHITCHAT };

      // Fallback heuristic
      return { intent: this._heuristicClassify(message) };
    } catch (err) {
      this.logger.warn(`[MicroPipeline] Classification LLM failed: ${err.message}`);
      return { intent: this._heuristicClassify(message) };
    }
  }

  /**
   * Regex-based fallback classification.
   * @param {string} message
   * @returns {string} Intent name
   */
  _heuristicClassify(message) {
    const lower = message.toLowerCase();
    if (/^(what|how|when|where|who|why|is |are |do |does |can |could |should |would )/i.test(lower)) {
      return INTENTS.QUESTION;
    }
    if (/\b(create|add|send|schedule|set up|move|delete|remove|update|edit|make)\b/i.test(lower)) {
      return INTENTS.TASK;
    }
    if (lower.includes(' and ') && lower.length > 100) {
      return INTENTS.COMPLEX;
    }
    return INTENTS.CHITCHAT;
  }

  // ---------------------------------------------------------------------------
  // Stage 2: Intent Handlers
  // ---------------------------------------------------------------------------

  /**
   * Handle greetings — no LLM call needed.
   * @param {Object} context
   * @returns {string}
   */
  _handleGreeting(context) {
    const name = context.userName ? `, ${context.userName}` : '';
    const idx = Math.floor(Math.random() * GREETING_TEMPLATES.length);
    return GREETING_TEMPLATES[idx].replace('!', `${name}!`);
  }

  /**
   * Handle questions — search memory, then synthesize.
   * @param {string} message
   * @param {Object} classification
   * @param {Object} context
   * @returns {Promise<string>}
   */
  async _handleQuestion(message, classification, context) {
    // Step 1: Search memory for relevant context
    let searchResults = [];
    if (this.memorySearcher) {
      try {
        searchResults = await this.memorySearcher.search(message, { limit: 5 });
      } catch (err) {
        this.logger.warn(`[MicroPipeline] Memory search failed: ${err.message}`);
      }
    }

    // Step 2: If we have search results, synthesize an answer
    if (searchResults.length > 0) {
      const snippets = searchResults.map((r, i) =>
        `[${i + 1}] ${r.title || 'Untitled'}: ${r.subline || ''}`
      ).join('\n');

      const synthesizePrompt = `Based on these notes, answer the user's question concisely.

Notes:
${snippets}

Question: ${message.substring(0, 300)}

Answer:`;

      try {
        const result = await this.router.route({
          job: 'quick',
          content: synthesizePrompt,
          requirements: { maxTokens: 300 }
        });
        return result.result || 'I found some related information but couldn\'t form a clear answer.';
      } catch (err) {
        this.logger.warn(`[MicroPipeline] Synthesis failed: ${err.message}`);
        // Fall through to simple chat
      }
    }

    // Fallback: simple direct chat
    return this._handleChat(message, context);
  }

  /**
   * Handle task requests — extract parameters and execute.
   * @param {string} message
   * @param {Object} classification
   * @param {Object} context
   * @returns {Promise<string>}
   */
  async _handleTask(message, classification, context) {
    // For now, create a Deck card for the task if DeckClient is available
    if (this.deckClient) {
      try {
        const title = message.length > 80 ? message.substring(0, 77) + '...' : message;
        await this.deckClient.createCard('inbox', {
          title,
          description: `Requested by ${context.userName || 'user'} via MicroPipeline`
        });
        return `I've added that to the task board: "${title}"`;
      } catch (err) {
        this.logger.warn(`[MicroPipeline] Deck card creation failed: ${err.message}`);
      }
    }

    // Fallback: use LLM to acknowledge the task
    return this._handleChat(message, context);
  }

  /**
   * Handle complex requests — defer to cloud or decompose.
   * @param {string} message
   * @param {Object} classification
   * @param {Object} context
   * @returns {Promise<string>}
   */
  async _handleComplex(message, classification, context) {
    // Option 1: If cloud is available, defer
    if (this.deferralQueue && this.router.hasCloudPlayers()) {
      try {
        const isAvailable = await this.router.isCloudAvailable();
        if (!isAvailable) {
          // Cloud exists but is down — queue for later
          await this.deferralQueue.enqueue({
            message,
            userName: context.userName,
            roomToken: context.roomToken,
            createdAt: new Date().toISOString()
          });
          this.stats.deferred++;
          return 'That\'s a complex request that needs more powerful processing. I\'ve queued it and will handle it when cloud resources are available.';
        }
        // Cloud is up — still defer to let AgentLoop handle it with full tools
        await this.deferralQueue.enqueue({
          message,
          userName: context.userName,
          roomToken: context.roomToken,
          createdAt: new Date().toISOString()
        });
        this.stats.deferred++;
        return 'That\'s a complex request. I\'ve queued it for thorough processing with full capabilities.';
      } catch (err) {
        this.logger.warn(`[MicroPipeline] Deferral failed: ${err.message}`);
      }
    }

    // Option 2: No cloud — decompose locally
    return this._decomposeAndProcess(message, context);
  }

  /**
   * Decompose a complex request into sub-questions and process each.
   * @param {string} message
   * @param {Object} context
   * @returns {Promise<string>}
   */
  async _decomposeAndProcess(message, context) {
    try {
      // Step 1: Break into sub-questions
      const decomposePrompt = `Break this complex request into 2-3 simple, independent sub-questions. List each on a new line starting with "- ".

Request: "${message.substring(0, 300)}"

Sub-questions:`;

      const decomposeResult = await this.router.route({
        job: 'quick',
        content: decomposePrompt,
        requirements: { maxTokens: 150 }
      });

      const subQuestions = (decomposeResult.result || '')
        .split('\n')
        .map(l => l.replace(/^[-*•]\s*/, '').trim())
        .filter(l => l.length > 5)
        .slice(0, 3);

      if (subQuestions.length === 0) {
        return this._handleChat(message, context);
      }

      // Step 2: Process each sub-question
      const answers = [];
      for (const sq of subQuestions) {
        try {
          const result = await this.router.route({
            job: 'quick',
            content: sq,
            requirements: { maxTokens: 200 }
          });
          answers.push({ question: sq, answer: result.result || '' });
        } catch {
          answers.push({ question: sq, answer: '(could not process)' });
        }
      }

      // Step 3: Stitch answers together
      return this._stitchAnswers(message, answers);
    } catch (err) {
      this.logger.warn(`[MicroPipeline] Decomposition failed: ${err.message}`);
      return this._handleChat(message, context);
    }
  }

  /**
   * Stitch decomposed answers into a coherent response.
   * @param {string} originalMessage
   * @param {Array} answers - [{ question, answer }]
   * @returns {string}
   */
  _stitchAnswers(originalMessage, answers) {
    if (answers.length === 0) return 'I wasn\'t able to fully process that request.';

    const parts = answers
      .filter(a => a.answer && a.answer !== '(could not process)')
      .map(a => `**${a.question}**\n${a.answer}`);

    if (parts.length === 0) return 'I had difficulty processing the parts of your request. Could you try simplifying it?';

    return parts.join('\n\n');
  }

  /**
   * Simple chat handler — single LLM call with minimal context.
   * @param {string} message
   * @param {Object} context
   * @returns {Promise<string>}
   */
  async _handleChat(message, context) {
    try {
      const prompt = context.warmMemory
        ? `Context: ${context.warmMemory.substring(0, 500)}\n\nUser: ${message.substring(0, 500)}\n\nRespond concisely:`
        : `User: ${message.substring(0, 500)}\n\nRespond concisely:`;

      const result = await this.router.route({
        job: 'quick',
        content: prompt,
        requirements: { maxTokens: 300 }
      });

      return result.result || 'I\'m not sure how to respond to that.';
    } catch (err) {
      this.logger.warn(`[MicroPipeline] Chat failed: ${err.message}`);
      return 'I\'m having trouble responding right now. Please try again.';
    }
  }
}

MicroPipeline.INTENTS = INTENTS;

module.exports = MicroPipeline;
