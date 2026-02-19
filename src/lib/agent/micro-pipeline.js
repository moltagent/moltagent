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

// Confirmations/negations MUST go to cloud AgentLoop — MicroPipeline has no
// conversation history, so it can never know what "yes" or "do it" refers to.
const CONFIRMATION_PATTERN = /^\s*(yes|no|ok|okay|sure|yeah|yep|yup|nah|nope|do it|go ahead|cancel|stop|please|correct|right|exactly|absolutely|definitely|alright|affirmative|negative|confirmed|deny|approve|reject|proceed|continue|skip|fine|got it|understood|ack)\s*[.!?]?\s*$/i;

// Numeric selections ("2.", "#3", "1") are contextual references to a prior
// numbered list — only AgentLoop with conversation history can resolve them.
const SELECTION_PATTERN = /^\s*#?\d{1,3}\.?\s*$/;

const INTENTS = Object.freeze({
  GREETING: 'greeting',
  QUESTION: 'question',
  TASK: 'task',
  COMMAND: 'command',
  COMPLEX: 'complex',
  CHITCHAT: 'chitchat',
  // Domain-specific intents (local tool-calling via focused subsets)
  DECK: 'deck',
  CALENDAR: 'calendar',
  EMAIL: 'email',
  WIKI: 'wiki',
  FILE: 'file',
  SEARCH: 'search'
});

// Domain-specific regex patterns for fast-path classification (no LLM needed)
const DOMAIN_PATTERNS = {
  deck: /\b(card|task|board|stack|kanban|deck|todo|to-do|to do|assign|due date|overdue)\b/i,
  calendar: /\b(calendar|event|meeting|appointment|schedule|book|reschedule|invite|agenda)\b/i,
  email: /\b(email|e-mail|mail|send .{0,20}(message|note|mail)|inbox|draft)\b/i,
  wiki: /\b(wiki|wiki page|knowledge base|write .{0,20}(page|article)|read .{0,20}(page|article))\b/i,
  file: /\b(file|folder|upload|download|directory|move .{0,20}file|copy .{0,20}file|share .{0,20}(file|folder))\b/i,
  search: /\b(search|find|look up|look for|what do (you|we) know about|who is|what is .{0,30}\?)\b/i
};

// Domain-specific system prompts — minimal context for focused tool-calling.
// Each prompt gives the model just enough context for its domain.
// Minimal domain prompts — shorter = faster inference on 8B models.
const DOMAIN_PROMPTS = Object.freeze({
  deck: `Task board assistant. Use tools to manage cards. Be concise. Confirm actions.`,
  calendar: `Calendar assistant. Use tools to list or create events. Be concise. Confirm actions.`,
  email: `Email assistant. Use tools to send email. Be concise. Confirm actions.`,
  wiki: `Wiki assistant. Use tools to read, write, or search pages. Be concise. Confirm actions.`,
  file: `File assistant. Use tools for file operations. Be concise. Confirm actions.`,
  search: `Search assistant. Use tools to find information. Summarize results concisely.`
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
   * @param {Object} [config.toolRegistry] - ToolRegistry for focused tool subsets
   * @param {Object} [config.ollamaToolsProvider] - OllamaToolsProvider for local tool-calling
   * @param {Object} [config.logger] - Logger (default: console)
   */
  constructor(config = {}) {
    this.router = config.llmRouter;
    this.memorySearcher = config.memorySearcher || null;
    this.deckClient = config.deckClient || null;
    this.calendarClient = config.calendarClient || null;
    this.talkSendQueue = config.talkSendQueue || null;
    this.deferralQueue = config.deferralQueue || null;
    this.toolRegistry = config.toolRegistry || null;
    this.ollamaToolsProvider = config.ollamaToolsProvider || null;
    this.domainToolTimeout = config.domainToolTimeout || 90000;
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
        // Domain-specific intents → local tool-calling with focused subsets
        case INTENTS.DECK:
        case INTENTS.CALENDAR:
        case INTENTS.EMAIL:
        case INTENTS.WIKI:
        case INTENTS.FILE:
        case INTENTS.SEARCH:
          return await this._handleDomainTask(message, intent, context);
        case INTENTS.COMMAND:
        case INTENTS.CHITCHAT:
        default:
          return await this._handleChat(message, context);
      }
    } catch (err) {
      // Domain escalation errors must propagate to MessageProcessor for cloud fallback
      if (err.code === 'DOMAIN_ESCALATE') throw err;
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
   *
   * Three-tier classification:
   * 1. Regex fast-path (greeting, chitchat, domain-specific)
   * 2. LLM classification with domain awareness
   * 3. Heuristic fallback
   *
   * @param {string} message
   * @returns {Promise<Object>} { intent, topics?, names? }
   */
  async _classify(message) {
    // Fast-path: greeting detection via regex (no LLM needed)
    if (GREETING_PATTERNS.test(message.trim())) {
      return { intent: INTENTS.GREETING };
    }

    // Fast-path: confirmations/negations → complex (forces cloud AgentLoop).
    // MicroPipeline has no conversation history — only AgentLoop knows
    // what "yes" or "do it" refers to.
    if (CONFIRMATION_PATTERN.test(message) || SELECTION_PATTERN.test(message)) {
      return { intent: INTENTS.COMPLEX };
    }

    // Fast-path: short messages (< 5 words) are likely chitchat
    const wordCount = message.trim().split(/\s+/).length;
    if (wordCount <= 2) {
      return { intent: INTENTS.CHITCHAT };
    }

    // Fast-path: domain-specific detection via regex
    // Check for multi-domain (mentions 2+ domains) → complex
    const domainHits = this._detectDomains(message);
    if (domainHits.length === 1) {
      return { intent: INTENTS[domainHits[0].toUpperCase()] || INTENTS.TASK };
    }
    if (domainHits.length > 1) {
      return { intent: INTENTS.COMPLEX };
    }

    try {
      const classifyPrompt = `Classify this user message into exactly ONE category. Reply with ONLY the category name, nothing else.

Categories:
- deck (task/card/board management: create card, list tasks, move card, assign, due date)
- calendar (events/meetings: schedule, book, check calendar, reschedule)
- email (sending/reading email: send mail, check inbox, draft)
- wiki (wiki/knowledge pages: write page, search wiki, read article)
- file (file operations: list files, create folder, upload, share file)
- search (information lookup: search for, find, what do you know about)
- chitchat (casual conversation, opinions, small talk, greetings)
- complex (multi-part request, analysis, research, comparison, writing, planning)

Message: "${message.substring(0, 200)}"

Category:`;

      const result = await this.router.route({
        job: 'quick',
        content: classifyPrompt,
        requirements: { maxTokens: 10, temperature: 0 }
      });

      const raw = (result.result || '').trim().toLowerCase().replace(/[^a-z]/g, '');

      // Check domain intents first (most specific)
      if (raw.includes('deck')) return { intent: INTENTS.DECK };
      if (raw.includes('calendar')) return { intent: INTENTS.CALENDAR };
      if (raw.includes('email')) return { intent: INTENTS.EMAIL };
      if (raw.includes('wiki')) return { intent: INTENTS.WIKI };
      if (raw.includes('file')) return { intent: INTENTS.FILE };
      if (raw.includes('search')) return { intent: INTENTS.SEARCH };
      if (raw.includes('complex')) return { intent: INTENTS.COMPLEX };
      if (raw.includes('chitchat')) return { intent: INTENTS.CHITCHAT };
      // Legacy intents as fallback
      if (raw.includes('question')) return { intent: INTENTS.QUESTION };
      if (raw.includes('task')) return { intent: INTENTS.TASK };

      // Fallback heuristic
      return { intent: this._heuristicClassify(message) };
    } catch (err) {
      this.logger.warn(`[MicroPipeline] Classification LLM failed: ${err.message}`);
      return { intent: this._heuristicClassify(message) };
    }
  }

  /**
   * Detect which domains a message touches via regex.
   * Returns array of domain names (e.g. ['deck'], ['calendar', 'email']).
   * If 'search' co-occurs with a specific domain (e.g. "search the wiki"),
   * the specific domain wins — 'search' is only standalone intent.
   * @param {string} message
   * @returns {string[]}
   */
  _detectDomains(message) {
    const hits = [];
    for (const [domain, pattern] of Object.entries(DOMAIN_PATTERNS)) {
      if (pattern.test(message)) {
        hits.push(domain);
      }
    }
    // "search the wiki" / "find the file" → specific domain, not search
    if (hits.length > 1 && hits.includes('search')) {
      const specific = hits.filter(d => d !== 'search');
      if (specific.length === 1) return specific;
    }
    return hits;
  }

  /**
   * Regex-based fallback classification.
   * @param {string} message
   * @returns {string} Intent name
   */
  _heuristicClassify(message) {
    const lower = message.toLowerCase();

    // Check domain patterns first
    const domainHits = this._detectDomains(message);
    if (domainHits.length === 1) {
      return INTENTS[domainHits[0].toUpperCase()] || INTENTS.TASK;
    }
    if (domainHits.length > 1) {
      return INTENTS.COMPLEX;
    }

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

  // ---------------------------------------------------------------------------
  // Domain-Specific Tool-Calling (Local Intelligence v2)
  // ---------------------------------------------------------------------------

  /**
   * Handle domain-specific tasks with focused local tool-calling.
   *
   * Uses OllamaToolsProvider.chat() with a small tool subset (3-8 tools)
   * and a minimal system prompt. Falls back to cloud AgentLoop on failure.
   *
   * @param {string} message - User message
   * @param {string} intent - Domain intent (deck, calendar, email, wiki, file, search)
   * @param {Object} context - { userName, roomToken, warmMemory }
   * @returns {Promise<string>} Response text
   */
  async _handleDomainTask(message, intent, context) {
    // Guard: need both toolRegistry and ollamaToolsProvider for tool-calling
    if (!this.toolRegistry || !this.ollamaToolsProvider) {
      this.logger.warn(`[MicroPipeline] Domain task "${intent}" but no toolRegistry/ollamaToolsProvider — falling back`);
      return this._handleChat(message, context);
    }

    const tools = this.toolRegistry.getToolSubset(intent);
    if (!tools || tools.length === 0) {
      this.logger.warn(`[MicroPipeline] No tools for intent "${intent}" — falling back`);
      return this._handleChat(message, context);
    }

    const systemPrompt = DOMAIN_PROMPTS[intent] || DOMAIN_PROMPTS.search;
    const userPrompt = context.warmMemory
      ? `Context: ${context.warmMemory.substring(0, 300)}\n\nUser (${context.userName || 'unknown'}): ${message}`
      : `User (${context.userName || 'unknown'}): ${message}`;

    this.logger.info(`[MicroPipeline] Domain task: ${intent} (${tools.length} tools, ${this.domainToolTimeout}ms timeout) → local tool-calling`);

    try {
      // Set request context on tool registry so tools know who's calling
      if (this.toolRegistry.setRequestContext) {
        this.toolRegistry.setRequestContext({ user: context.userName || 'moltagent' });
      }

      // Bounded tool-calling loop (max 3 iterations):
      // 1. LLM decides which tool(s) to call
      // 2. Execute tool calls (validated against subset)
      // 3. Feed results back for final response or next iteration
      const MAX_ITERATIONS = 3;
      const allowedNames = new Set(tools.map(t => t.function.name));
      const messages = [{ role: 'user', content: userPrompt }];

      for (let i = 0; i < MAX_ITERATIONS; i++) {
        const llmResult = await this.ollamaToolsProvider.chat({
          system: systemPrompt,
          messages,
          tools,
          timeout: this.domainToolTimeout
        });

        // If no tool calls, we have the final response
        if (!llmResult.toolCalls || llmResult.toolCalls.length === 0) {
          return llmResult.content || 'Done.';
        }

        // Execute tool calls and collect results
        const assistantMsg = {
          role: 'assistant',
          content: llmResult.content || '',
          tool_calls: llmResult.toolCalls.map(tc => ({
            function: {
              name: tc.name,
              arguments: tc.arguments
            }
          }))
        };
        messages.push(assistantMsg);

        for (const toolCall of llmResult.toolCalls) {
          // Validate tool name against focused subset (prevent hallucinated tool calls)
          if (!allowedNames.has(toolCall.name)) {
            messages.push({ role: 'tool', content: `Error: Unknown tool "${toolCall.name}"` });
            continue;
          }
          const toolResult = await this.toolRegistry.execute(toolCall.name, toolCall.arguments);
          messages.push({
            role: 'tool',
            content: toolResult.success
              ? (toolResult.result || 'OK')
              : `Error: ${toolResult.error}`
          });
        }
        // Loop continues — LLM gets tool results and either calls more tools or responds
      }

      // If we exhaust iterations, synthesize from last messages
      const lastToolResult = messages.filter(m => m.role === 'tool').pop();
      return lastToolResult?.content || 'I completed the operation.';

    } catch (err) {
      this.logger.warn(`[MicroPipeline] Domain tool-calling failed (${intent}): ${err.message}`);
      this.stats.errors++;

      // Escalation signal — let MessageProcessor know this should go to cloud
      const escalationErr = new Error(`Domain escalation: ${err.message}`);
      escalationErr.code = 'DOMAIN_ESCALATE';
      escalationErr.intent = intent;
      throw escalationErr;
    }
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
