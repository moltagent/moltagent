/**
 * Message Router
 *
 * Architecture Brief:
 * -------------------
 * Problem: Incoming messages need to be classified by intent and routed to
 * the appropriate handler (calendar, email, confirmation, or general LLM).
 *
 * Pattern: Intent-based routing with keyword scoring and confirmation state tracking.
 * Handles Human-in-the-Loop (HITL) confirmations for critical actions.
 *
 * **SUPERSEDED**: Primary classification is now handled by IntentRouter
 * (dual-model LLM with conversation context) + MicroPipeline (regex-as-hint
 * with LLM fallback). This MessageRouter remains as a legacy fallback path
 * for direct callers. New code should use IntentRouter + MicroPipeline.
 *
 * Key Dependencies:
 * - src/lib/handlers/calendar-handler.js (CalendarHandler)
 * - src/lib/handlers/email-handler.js (EmailHandler)
 * - src/lib/handlers/skill-forge-handler.js (SkillForgeHandler)
 * - src/lib/handlers/confirmation/index.js (confirmation handlers)
 * - src/lib/pending-action-store.js (pendingEmailReplies)
 * - src/lib/errors/error-handler.js (safe error handling)
 *
 * Data Flow:
 * - Message -> classifyIntent() -> route() -> specific handler
 * - Handler returns requiresConfirmation -> store pending action
 * - Confirmation response -> _handleConfirmation() -> execute action
 *
 * Integration Points:
 * - Called by webhook-server.js message endpoint
 * - Uses LLMRouter for general conversation
 * - Uses CalDAV client for meeting responses
 *
 * @module handlers/message-router
 * @version 1.0.0
 */

'use strict';

const { createErrorHandler } = require('../errors/error-handler');
const { pendingEmailReplies } = require('../pending-action-store');
const config = require('../config');
const { JOBS } = require('../llm/router');
const {
  createConfirmationHandlers,
  isApprovalResponse,
  isRejectionResponse,
  isEditResponse
} = require('./confirmation/index');

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * @typedef {Object} MessageRouterOptions
 * @property {Object} [calendarHandler] - CalendarHandler instance
 * @property {Object} [emailHandler] - EmailHandler instance
 * @property {Object} [contextLoader] - ContextLoader instance for agent memory
 * @property {Object} [deckClient] - DeckClient instance for task board
 * @property {Object} [skillForgeHandler] - SkillForgeHandler instance
 * @property {Object} [llmRouter] - LLM router instance
 * @property {Object} [calendarClient] - Direct CalDAV client for meeting responses
 * @property {Object} [conversationContext] - ConversationContext instance for chat history
 * @property {Function} [auditLog] - Audit logging function
 */

/**
 * @typedef {Object} MessageContext
 * @property {string} user - The user sending the message
 * @property {string} [token] - NC Talk room token
 * @property {string} [messageId] - Original message ID
 * @property {Array} [history] - Conversation history from ConversationContext
 */

/**
 * @typedef {'calendar'|'email'|'skillforge'|'deck'|'memory'|'confirm'|'general'} MessageIntent
 */

/**
 * @typedef {Object} RouteResult
 * @property {string} response - User-facing response message
 * @property {string} [intent] - The classified intent
 * @property {boolean} [requiresConfirmation] - True if action requires HITL approval
 * @property {string} [pendingId] - ID of stored pending confirmation
 * @property {boolean} [error] - True if an error occurred
 * @property {string} [provider] - LLM provider used (for general intent)
 * @property {number} [duration] - Response time in ms (for general intent)
 */

/**
 * @typedef {Object} PendingConfirmation
 * @property {string} handler - Handler type ('calendar' or 'email')
 * @property {Object} data - The action data to execute after confirmation
 * @property {string} user - User who initiated the action
 * @property {number} timestamp - Creation timestamp (ms)
 */

/**
 * @typedef {Object} RouterStats
 * @property {number} pendingConfirmations - Number of pending confirmations
 * @property {Object} handlersConfigured - Configuration status of handlers
 * @property {boolean} handlersConfigured.calendar - Calendar handler available
 * @property {boolean} handlersConfigured.email - Email handler available
 * @property {boolean} handlersConfigured.llm - LLM router available
 * @property {boolean} handlersConfigured.calendarClient - CalDAV client available
 */

// -----------------------------------------------------------------------------
// Message Router Class
// -----------------------------------------------------------------------------

class MessageRouter {
  /**
   * Create a new MessageRouter
   * @param {MessageRouterOptions} [options={}] - Router configuration
   */
  constructor(options = {}) {
    this.handlers = {
      calendar: options.calendarHandler,
      email: options.emailHandler,
      skillForge: options.skillForgeHandler
    };
    this.llmRouter = options.llmRouter;
    this.calendarClient = options.calendarClient; // Direct CalDAV client for meeting responses
    this.auditLog = options.auditLog || (() => {});
    this.contextLoader = options.contextLoader || null;
    this.deckClient = options.deckClient || null;
    this.conversationContext = options.conversationContext || null;

    // Error handler for safe error messages
    this.errorHandler = createErrorHandler({
      serviceName: 'MessageRouter',
      auditLog: this.auditLog
    });

    // Pending confirmations: { pendingId: { handler, data, user, timestamp } }
    this.pendingConfirmations = new Map();

    // Confirmation handlers (strategy pattern for different confirmation types)
    this.confirmationHandlers = createConfirmationHandlers({
      auditLog: this.auditLog
    });

    // Clean up old confirmations periodically
    setInterval(() => this._cleanupPendingConfirmations(), config.pendingActions.cleanupIntervalMs);
  }

  /**
   * Classify the intent of a message
   * @deprecated Use IntentRouter.classify() + MicroPipeline._classifyFallback() instead.
   * @param {string} message - The message to classify
   * @param {Array} [history] - Conversation history for context-aware classification
   * @returns {MessageIntent} 'calendar' | 'email' | 'confirm' | 'general'
   */
  classifyIntent(message, history) {
    const lower = message.toLowerCase().trim();

    // Check for confirmation responses first
    if (this._isConfirmationResponse(lower)) {
      return 'confirm';
    }

    // Calendar-related keywords
    const calendarKeywords = [
      'calendar', 'schedule', 'meeting', 'appointment', 'event',
      'free time', 'free slot', 'available', 'availability',
      'today', 'tomorrow', 'upcoming', 'next week',
      'book', 'reschedule', 'cancel event',
      'what do i have', 'what\'s on', 'what is on',
      'am i free', 'am i busy', 'when am i',
      'schedule for', 'agenda', 'my day'
    ];

    // Email-related keywords (must be action-oriented to avoid false positives)
    // Just mentioning "email" in conversation should NOT trigger email handler
    const emailKeywords = [
      'inbox', 'unread emails', 'unread mail',
      'compose email', 'draft an email', 'draft email',
      'check email', 'check mail', 'check my mail', 'check my email',
      'new emails', 'new mail', 'any emails', 'any mail',
      'write an email', 'write email', 'send an email', 'send email',
      'read email', 'read mail', 'read my email', 'read my mail',
      'summarize email', 'summarize mail', 'search email', 'search mail',
      'reply to email', 'forward email', 'email from', 'emails from'
    ];

    // Skill Forge keywords (checked before scoring to ensure exact phrase match)
    const skillForgeKeywords = [
      'skill forge', 'create skill', 'create a skill', 'create a new skill',
      'new skill', 'build a skill', 'make a skill', 'skill template',
      'browse skills', 'activate skill', 'list templates', 'forge skill',
      'skill catalog', 'list skills'
    ];

    for (const keyword of skillForgeKeywords) {
      if (lower.includes(keyword)) {
        return 'skillforge';
      }
    }

    // Flexible pattern: "create/build/make [a] [adjective] skill"
    if (/\b(?:create|build|make|forge)\b.*\bskill\b/.test(lower)) {
      return 'skillforge';
    }

    // Deck ACTION patterns (high priority — check BEFORE keyword-based deck match)
    // These patterns indicate the user wants to PERFORM an action on a Deck card.
    const DECK_ACTION_PATTERNS = [
      // Close/complete/done patterns
      /(?:close|finish|complete|mark\s+as\s+done|put\s+into?\s+done|move\s+to\s+done)\b/i,
      // Move patterns
      /(?:move|put|shift)\s+.+\s+(?:to|into)\s+(?:inbox|queued|working|review|done)\b/i,
      // Start/work patterns
      /(?:start|begin|work\s+on)\s+.+/i,
      // Reconfirm/verify patterns
      /(?:reconfirm|verify|check\s+if|is|are)\s+.+\s+(?:done|closed|completed|in\s+done)\b/i,
      // "due next week" / "due this week" task queries
      /(?:due|overdue)\s+(?:this|next|last)\s+(?:week|month)\b/i,
      // "tasks that are" patterns
      /tasks?\s+(?:that\s+are|which\s+are)\b/i,
    ];

    for (const pattern of DECK_ACTION_PATTERNS) {
      if (pattern.test(lower)) {
        return 'deck';
      }
    }

    // Deck / task board keywords (high priority — check before score-based classification)
    const deckKeywords = [
      'deck board', 'task board', 'kanban',
      'my tasks', 'open tasks', 'pending tasks',
      'backlog', 'add task', 'create task', 'new task',
      'assign task', 'move task', 'complete task',
      'what tasks', 'show tasks', 'list tasks',
      'deck cards', 'task list', 'workload'
    ];

    for (const keyword of deckKeywords) {
      if (lower.includes(keyword)) {
        return 'deck';
      }
    }

    // Memory-related keywords (high priority — check before score-based classification)
    const memoryKeywords = [
      'remember this', 'remember that', 'store this', 'note this',
      'memorize', 'don\'t forget', 'keep in mind',
      'recall', 'what do you remember', 'what do you know about',
      'forget this', 'forget that',
      'i learned', 'you learned', 'we learned'
    ];

    for (const keyword of memoryKeywords) {
      if (lower.includes(keyword)) {
        return 'memory';
      }
    }

    // Score-based classification
    let calendarScore = 0;
    let emailScore = 0;

    for (const keyword of calendarKeywords) {
      if (lower.includes(keyword)) {
        calendarScore++;
      }
    }

    for (const keyword of emailKeywords) {
      if (lower.includes(keyword)) {
        emailScore++;
      }
    }

    // Return the handler with highest score (minimum 1 match)
    if (calendarScore > 0 && calendarScore >= emailScore) {
      return 'calendar';
    }
    if (emailScore > 0 && emailScore > calendarScore) {
      return 'email';
    }

    // Conversation-aware reference resolution
    // If the message references something from recent history, try to resolve intent
    if (history && history.length > 0) {
      const refPatterns = [
        /(?:the\s+one|which\s+one).*(?:inbox|working|done|queued)/i,
        /(?:those|the\s+first|the\s+second|the\s+last|all\s+of\s+them)/i,
        /(?:close|move|finish|complete)\s+(?:it|them|those|that)/i,
      ];

      if (refPatterns.some(p => p.test(lower))) {
        // Check if recent assistant messages contain deck-related content
        const recentAssistant = history
          .filter(m => m.role === 'assistant')
          .slice(-3);
        const hasDeckContext = recentAssistant.some(m =>
          /task board|inbox|working|queued|done|open tasks/i.test(m.content)
        );
        if (hasDeckContext) {
          return 'deck';
        }
      }
    }

    return 'general';
  }

  /**
   * Check if message is a confirmation response
   * @param {string} message - The message to check (lowercased)
   * @returns {boolean} True if message is a confirmation response and there are pending actions
   * @private
   */
  _isConfirmationResponse(message) {
    const confirmPatterns = [
      /^(yes|yep|yeah|sure|ok|okay|confirm|send it|do it|go ahead|proceed|approved?)/i,
      /^(no|nope|nah|cancel|don't|abort|stop|never mind)/i,
      /^(send|ignore|edit)$/i,
      /^confirm$/i,
      /^cancel$/i,
      // Meeting-specific patterns
      /^(accept|decline|suggest|accept anyway)$/i,
      /^suggest alternatives?$/i
    ];

    // Check for pending confirmations or pending email replies
    const hasPendingConfirmations = this.pendingConfirmations.size > 0;
    const hasPendingEmailReplies = pendingEmailReplies.has('email_reply');

    return confirmPatterns.some(p => p.test(message)) && (hasPendingConfirmations || hasPendingEmailReplies);
  }

  /**
   * Route a message to the appropriate handler
   * @deprecated Use MessageProcessor smart-mix routing instead.
   * @param {string} message - The message to route
   * @param {MessageContext} [context={}] - Request context
   * @returns {Promise<RouteResult>} Response with message and metadata
   */
  async route(message, context = {}) {
    const { user, token, messageId, history } = context;

    console.log(`[MessageRouter] LEGACY keyword route: "${message.substring(0, 60)}" user=${user || 'unknown'}`);

    // Check for active Skill Forge session before general classification.
    // If the user is mid-conversation (not idle), route to skillforge
    // unless it's a confirmation response for a pending HITL action.
    let intent = this.classifyIntent(message, history);
    if (intent !== 'confirm' && this.handlers.skillForge && user) {
      const forgeState = this.handlers.skillForge.getState(user);
      if (forgeState.state !== 'idle') {
        intent = 'skillforge';
      }
    }

    await this.auditLog('message_classified', {
      user,
      intent,
      messagePreview: message.substring(0, 50)
    });

    try {
      switch (intent) {
        case 'calendar':
          return await this._handleCalendar(message, context);

        case 'email':
          return await this._handleEmail(message, context);

        case 'skillforge':
          return await this._handleSkillForge(message, context);

        case 'deck':
          return await this._handleDeck(message, context);

        case 'memory':
          return await this._handleMemory(message, context);

        case 'confirm':
          return await this._handleConfirmation(message, context);

        case 'general':
        default:
          return await this._handleGeneral(message, context);
      }
    } catch (error) {
      console.error(`[Router] Error handling ${intent}:`, error.message);
      await this.auditLog('handler_error', {
        intent,
        error: error.message,
        user
      });

      const { message } = await this.errorHandler.handle(error, {
        operation: `handle_${intent}`,
        user
      });
      return {
        response: message,
        error: true
      };
    }
  }

  /**
   * Handle calendar-related requests
   * @param {string} message - The message to handle
   * @param {MessageContext} context - Request context
   * @returns {Promise<RouteResult>} Response with calendar data
   * @private
   */
  async _handleCalendar(message, context) {
    if (!this.handlers.calendar) {
      return {
        response: 'Calendar functionality is not configured yet. Please ask the admin to set up CalDAV credentials.',
        error: true
      };
    }

    const result = await this.handlers.calendar.handle(message);

    // If action requires confirmation (HITL), store it
    if (result.requiresConfirmation) {
      // Extract the actual data to store (pendingAction.data or the result itself)
      const dataToStore = result.pendingAction?.data || result.pendingAction || result;
      const pendingId = this._storePendingConfirmation('calendar', dataToStore, context.user);

      return {
        response: result.message || result.confirmationPrompt || `Please confirm this action:\n\n${result.preview}\n\nReply "yes" to confirm or "no" to cancel.`,
        requiresConfirmation: true,
        pendingId
      };
    }

    return {
      response: result.response || result.message,
      intent: 'calendar'
    };
  }

  /**
   * Handle email-related requests
   * @param {string} message - The message to handle
   * @param {MessageContext} context - Request context
   * @returns {Promise<RouteResult>} Response with email data
   * @private
   */
  async _handleEmail(message, context) {
    if (!this.handlers.email) {
      return {
        response: 'Email functionality is not configured yet. Please ask the admin to set up IMAP/SMTP credentials.',
        error: true
      };
    }

    const result = await this.handlers.email.handle(message);

    // If action requires confirmation (HITL), store it
    if (result.requiresConfirmation) {
      // Extract the actual data to store (pendingAction.data or the result itself)
      const dataToStore = result.pendingAction?.data || result.pendingAction || result;
      const pendingId = this._storePendingConfirmation('email', dataToStore, context.user);

      return {
        response: result.message || result.confirmationPrompt || `Please confirm this email:\n\n${result.preview}\n\nReply "yes" to send or "no" to cancel.`,
        requiresConfirmation: true,
        pendingId
      };
    }

    return {
      response: result.response || result.message,
      intent: 'email'
    };
  }

  /**
   * Handle skill forge requests
   * @param {string} message - The message to handle
   * @param {MessageContext} context - Request context
   * @returns {Promise<RouteResult>} Response with skill forge data
   * @private
   */
  async _handleSkillForge(message, context) {
    if (!this.handlers.skillForge) {
      return {
        response: 'Skill Forge is not configured yet. Please ask the admin to set up skill templates.',
        error: true
      };
    }

    const result = await this.handlers.skillForge.handle(message, context);

    // If action requires confirmation (HITL for activation), store it
    if (result.requiresConfirmation) {
      const dataToStore = result.pendingAction?.data || result.pendingAction || result;
      const pendingId = this._storePendingConfirmation('skillforge', dataToStore, context.user);

      return {
        response: result.message,
        requiresConfirmation: true,
        pendingId
      };
    }

    return {
      response: result.message,
      intent: 'skillforge'
    };
  }

  /**
   * Handle deck/task board requests
   * @param {string} message - The message to handle
   * @param {MessageContext} context - Request context
   * @returns {Promise<RouteResult>} Response with deck data
   * @private
   */
  async _handleDeck(message, context) {
    if (!this.deckClient) {
      return {
        response: 'Task board is not configured yet. Please ask the admin to set up Deck integration.',
        intent: 'deck',
        error: true
      };
    }

    const lower = message.toLowerCase();

    try {
      await this.deckClient.ensureBoard();

      // 1. Close/complete/done patterns
      if (/(?:close|finish|complete|mark\s+as\s+done|put\s+into?\s+done|move\s+to\s+done)\b/i.test(lower)) {
        const titles = this._parseMultipleCards(message);
        if (titles.length === 0) {
          return { response: 'Which card(s) should I close? Please specify the title.', intent: 'deck' };
        }
        return await this._handleDeckClose(titles, context);
      }

      // 2. Move-to-stack patterns
      const moveMatch = message.match(/(?:move|put|shift)\s+["']?(.+?)["']?\s+(?:to|into)\s+(inbox|queued|working|review|done)\b/i);
      if (moveMatch) {
        const title = moveMatch[1].trim();
        const targetStack = moveMatch[2].toLowerCase();
        return await this._handleDeckMove([title], targetStack, context);
      }

      // 3. Reconfirm/verify patterns
      if (/(?:reconfirm|verify|check\s+if|(?:is|are)\s+.+\s+(?:done|closed|completed))/i.test(lower)) {
        return await this._handleDeckVerify(message, context);
      }

      // 4. Add/create task
      const addMatch = message.match(/(?:add|create|new)\s+task[:\s]+(.+)/i);
      if (addMatch) {
        const title = addMatch[1].trim();
        const card = await this.deckClient.createCard('inbox', { title });
        await this.auditLog('deck_task_created', { user: context.user, title, cardId: card.id });
        return { response: `Created task in Inbox: "${title}" (card #${card.id})`, intent: 'deck' };
      }

      // 5. Start/work on patterns
      if (/(?:start|begin|work\s+on)\b/i.test(lower)) {
        const titlePart = message.replace(/(?:start|begin|work\s+on)\s*/i, '').trim();
        return await this._handleDeckMove([titlePart], 'working', context);
      }

      // 6. Default: list/show tasks (existing functionality, preserved)
      return await this._handleDeckList(message, lower, context);
    } catch (e) {
      console.error('[MessageRouter] Deck handler failed:', e.message);
      return {
        response: `Task board error: ${e.message}`,
        intent: 'deck',
        error: true
      };
    }
  }

  /**
   * Parse a message for multiple card references.
   * Handles: "close X and Y", "put X, Y into done", "mark X and Y as done"
   *
   * @param {string} message - User message
   * @returns {string[]} Array of card title fragments
   * @private
   */
  _parseMultipleCards(message) {
    // Remove the action prefix
    const cleaned = message
      .replace(/(?:close|finish|complete|done|mark\s+as\s+done|put\s+into?\s+done|move\s+to\s+done)\s*[:\-]?\s*/i, '')
      .replace(/^["']|["']$/g, '');

    // Split on " and ", ", ", " & "
    return cleaned
      .split(/\s+(?:and|&)\s+|,\s+/)
      .map(s => s.replace(/^["']+|["']+$/g, '').trim())
      .filter(s => s.length > 0);
  }

  /**
   * Find a card by title fragment across all stacks.
   *
   * @param {Object} allCards - Output of deckClient.getAllCards()
   * @param {string} titleFragment - Card title to search for
   * @returns {{card: Object, stack: string}|null}
   * @private
   */
  _findCardByTitle(allCards, titleFragment) {
    if (!titleFragment || titleFragment.trim().length === 0) return null;
    const lowerTitle = titleFragment.toLowerCase();
    for (const [stack, cards] of Object.entries(allCards)) {
      for (const card of cards) {
        if (card.title.toLowerCase().includes(lowerTitle)) {
          return { card, stack };
        }
      }
    }
    return null;
  }

  /**
   * Close/complete one or more cards (move to Done).
   * @private
   */
  async _handleDeckClose(titles, context) {
    const allCards = await this.deckClient.getAllCards();
    const results = [];

    for (const title of titles) {
      const found = this._findCardByTitle(allCards, title);
      if (!found) {
        results.push(`Could not find card matching "${title}"`);
        continue;
      }
      if (found.stack === 'done') {
        results.push(`"${found.card.title}" (card #${found.card.id}) is already in Done`);
        continue;
      }
      try {
        await this.deckClient.moveCard(found.card.id, found.stack, 'done');
        results.push(`Moved "${found.card.title}" (card #${found.card.id}) to Done`);
        await this.auditLog('deck_card_closed', {
          user: context.user, cardId: found.card.id, title: found.card.title, fromStack: found.stack
        });
      } catch (err) {
        results.push(`Failed to move "${found.card.title}": ${err.message}`);
      }
    }

    return { response: results.join('\n'), intent: 'deck' };
  }

  /**
   * Move one or more cards to a target stack.
   * @private
   */
  async _handleDeckMove(titles, targetStack, context) {
    const allCards = await this.deckClient.getAllCards();
    const results = [];

    for (const title of titles) {
      const found = this._findCardByTitle(allCards, title);
      if (!found) {
        results.push(`Could not find card matching "${title}"`);
        continue;
      }
      if (found.stack === targetStack) {
        results.push(`"${found.card.title}" is already in ${targetStack}`);
        continue;
      }
      try {
        await this.deckClient.moveCard(found.card.id, found.stack, targetStack);
        results.push(`Moved "${found.card.title}" (card #${found.card.id}) from ${found.stack} to ${targetStack}`);
        await this.auditLog('deck_card_moved', {
          user: context.user, cardId: found.card.id, title: found.card.title,
          fromStack: found.stack, toStack: targetStack
        });
      } catch (err) {
        results.push(`Failed to move "${found.card.title}": ${err.message}`);
      }
    }

    return { response: results.join('\n'), intent: 'deck' };
  }

  /**
   * Verify/reconfirm card status.
   * @private
   */
  async _handleDeckVerify(message, context) {
    const allCards = await this.deckClient.getAllCards();
    // Extract card title from message
    const cleaned = message.replace(/(?:reconfirm|verify|check\s+if|is|are)\s*/i, '')
      .replace(/\s+(?:done|closed|completed|in\s+done|marked\s+as\s+done)\s*/i, '')
      .replace(/^["']|["']$/g, '').trim();

    const titles = cleaned.split(/\s+(?:and|&)\s+|,\s+/)
      .map(s => s.replace(/^["']+|["']+$/g, '').trim())
      .filter(s => s.length > 0);

    const results = [];
    for (const title of titles) {
      const found = this._findCardByTitle(allCards, title);
      if (!found) {
        results.push(`Could not find card matching "${title}"`);
      } else {
        const stackLabel = found.stack.charAt(0).toUpperCase() + found.stack.slice(1);
        results.push(`"${found.card.title}" (card #${found.card.id}) is in ${stackLabel}`);
      }
    }

    return { response: results.join('\n'), intent: 'deck' };
  }

  /**
   * List/show task board summary (existing functionality, extracted).
   * @private
   */
  async _handleDeckList(message, lower, context) {
    const summary = await this.deckClient.getWorkloadSummary();

    const lines = ['**Task Board Summary:**\n'];
    const stacks = [
      ['Inbox', summary.inbox],
      ['Queued', summary.queued],
      ['Working', summary.working],
      ['Review', summary.review],
      ['Done', summary.done]
    ];
    for (const [name, count] of stacks) {
      if (count > 0) lines.push(`- **${name}:** ${count}`);
    }
    if (summary.total === 0) {
      lines.push('No tasks on the board.');
    } else {
      lines.push(`\n**Total:** ${summary.total}`);
    }

    // If asking specifically about open/pending, show card titles
    if (lower.includes('what tasks') || lower.includes('open tasks') ||
        lower.includes('show tasks') || lower.includes('list tasks') ||
        lower.includes('due')) {
      const active = await this.deckClient.getAllCards();
      const openCards = [
        ...(active.inbox || []),
        ...(active.queued || []),
        ...(active.working || [])
      ];
      if (openCards.length > 0) {
        lines.push('\n**Open tasks:**');
        for (const card of openCards.slice(0, 10)) {
          const stackLabel = Object.entries(active)
            .find(([, cards]) => cards.some(c => c.id === card.id))?.[0] || '';
          lines.push(`- ${card.title}${stackLabel ? ` (${stackLabel})` : ''}`);
        }
        if (openCards.length > 10) {
          lines.push(`_...and ${openCards.length - 10} more_`);
        }
      }
    }

    await this.auditLog('deck_query', { user: context.user, total: summary.total });
    return { response: lines.join('\n'), intent: 'deck' };
  }

  /**
   * Handle memory-related requests (remember, recall, forget)
   * @param {string} message - The message to handle
   * @param {MessageContext} context - Request context
   * @returns {Promise<RouteResult>} Response with memory operation result
   * @private
   */
  async _handleMemory(message, context) {
    const learningLog = this.contextLoader && this.contextLoader.log;
    if (!learningLog) {
      return {
        response: 'Memory is not configured yet. The Learning Log is unavailable.',
        intent: 'memory',
        error: true
      };
    }

    const lower = message.toLowerCase();

    // Handle recall requests
    if (lower.includes('recall') || lower.includes('what do you remember') || lower.includes('what do you know')) {
      try {
        const entries = await learningLog.getRecent(10);
        if (entries.length === 0) {
          return {
            response: "I don't have any memories stored yet.",
            intent: 'memory'
          };
        }
        const lines = ['Here is what I remember:\n'];
        for (const entry of entries) {
          const date = entry.timestamp.split('T')[0];
          lines.push(`- **${entry.content}** (${date}, ${entry.source || 'unknown source'})`);
        }
        return { response: lines.join('\n'), intent: 'memory' };
      } catch (e) {
        console.error('[MessageRouter] Recall failed:', e.message);
        return { response: 'Failed to retrieve memories.', intent: 'memory', error: true };
      }
    }

    // Handle store requests — extract content after trigger phrase
    const storePatterns = [
      /remember\s+this:\s*(.+)/is,
      /remember\s+that:\s*(.+)/is,
      /remember:\s*(.+)/is,
      /store\s+this:\s*(.+)/is,
      /note\s+this:\s*(.+)/is,
      /memorize:\s*(.+)/is,
      /keep\s+in\s+mind:\s*(.+)/is,
      /don't\s+forget:\s*(.+)/is,
      /remember\s+that\s+(.+)/is,
      /remember\s+this\s*[—–-]\s*(.+)/is,
      /remember\s+(.+)/is
    ];

    let content = null;
    for (const pattern of storePatterns) {
      const match = message.match(pattern);
      if (match) {
        content = match[1].trim();
        break;
      }
    }

    if (!content) {
      return {
        response: "What should I remember? Try: \"Remember this: our deploy target is production-eu-west\"",
        intent: 'memory'
      };
    }

    // Truncate excessively long entries
    if (content.length > 500) {
      content = content.substring(0, 500);
    }

    try {
      await learningLog.learned(
        content,
        `user:${context.user || 'unknown'}`,
        'high'
      );

      const summary = content.length > 100 ? content.substring(0, 100) + '...' : content;
      await this.auditLog('memory_stored', { user: context.user, contentPreview: summary });

      return {
        response: `Stored in Learning Log: "${summary}"`,
        intent: 'memory'
      };
    } catch (e) {
      console.error('[MessageRouter] Memory store failed:', e.message);
      return {
        response: 'Failed to store memory. The Learning Log may be unavailable.',
        intent: 'memory',
        error: true
      };
    }
  }

  /**
   * Handle confirmation responses
   * @param {string} message - The confirmation response
   * @param {MessageContext} context - Request context
   * @returns {Promise<RouteResult>} Response with confirmation result
   * @private
   */
  async _handleConfirmation(message, context) {
    const lower = message.toLowerCase().trim();

    // First check for pending email replies from email monitor
    const pendingReply = pendingEmailReplies.getRecent('email_reply');
    if (pendingReply) {
      const pendingCount = pendingEmailReplies.size('email_reply');
      console.log(`[Router] Found ${pendingCount} pending email replies, selecting most recent: ${pendingReply.data.email.subject} (meeting: ${pendingReply.data.is_meeting_request})`);

      // Determine which handler to use based on pending reply type
      const isMeetingRequest = pendingReply.data.is_meeting_request;
      const handler = isMeetingRequest
        ? this.confirmationHandlers.meetingResponse
        : this.confirmationHandlers.emailReply;

      // Check if handler can process this
      if (!handler.canHandle(pendingReply)) {
        console.error('[Router] Handler mismatch for pending reply');
        return {
          response: 'Error: Unable to process this confirmation.',
          intent: 'confirm',
          error: true
        };
      }

      // Prepare handler dependencies
      const handlerDeps = {
        emailHandler: this.handlers.email,
        calendarClient: this.calendarClient,
        auditLog: this.auditLog
      };

      // Route to appropriate action based on message
      if (isRejectionResponse(lower)) {
        // For email replies, use ignore handler; for meetings, use decline if "decline" specifically
        if (isMeetingRequest && /^decline$/.test(lower)) {
          return await handler.handleDecline(pendingReply, context, handlerDeps);
        }
        return await handler.handleIgnore(pendingReply, context, handlerDeps);
      }

      if (isEditResponse(lower)) {
        return await handler.handleEdit(pendingReply, context, handlerDeps);
      }

      // Meeting-specific actions
      if (isMeetingRequest) {
        const action = handler.classifyAction(lower);

        if (action === 'decline') {
          return await handler.handleDecline(pendingReply, context, handlerDeps);
        }
        if (action === 'suggest') {
          return await handler.handleSuggestAlternatives(pendingReply, context, handlerDeps);
        }
        if (action === 'accept_anyway') {
          return await handler.handleAcceptAnyway(pendingReply, context, handlerDeps);
        }
        if (action === 'accept') {
          return await handler.handleAccept(pendingReply, context, handlerDeps);
        }
      }

      // Standard approval for non-meeting emails
      if (isApprovalResponse(lower)) {
        return await handler.handleApprove(pendingReply, context, handlerDeps);
      }
    }

    // Then check for regular pending confirmations (calendar events, composed emails)
    const pendingActionHandler = this.confirmationHandlers.pendingAction;
    const found = pendingActionHandler.findForUser(this.pendingConfirmations, context.user);

    if (!found) {
      return pendingActionHandler.handleNoPending();
    }

    const { id: pendingId, pending: userPending } = found;

    // Prepare handler dependencies
    const handlerDeps = {
      calendarHandler: this.handlers.calendar,
      emailHandler: this.handlers.email,
      skillForgeHandler: this.handlers.skillForge,
      auditLog: this.auditLog
    };

    // Route to approval or rejection
    if (isApprovalResponse(lower)) {
      return await pendingActionHandler.handleApprove(
        pendingId,
        userPending,
        this.pendingConfirmations,
        context,
        handlerDeps
      );
    } else {
      return await pendingActionHandler.handleReject(
        pendingId,
        userPending,
        this.pendingConfirmations,
        context,
        handlerDeps
      );
    }
  }

  /**
   * Handle general conversation through LLM
   * @param {string} message - The message to handle
   * @param {MessageContext} context - Request context
   * @returns {Promise<RouteResult>} Response with LLM metadata
   * @private
   */
  async _handleGeneral(message, context) {
    if (!this.llmRouter) {
      return {
        response: `I received your message: "${message.substring(0, 100)}..." but the LLM is not available.`,
        intent: 'general'
      };
    }

    // Load agent memory context
    let contextBlock = '';
    if (this.contextLoader) {
      try {
        const ctx = await this.contextLoader.loadContext();
        if (ctx) contextBlock = ctx + '\n\n';
      } catch (e) {
        console.error('[MessageRouter] Context load failed:', e.message);
      }
    }

    // Add conversation history if available
    let conversationBlock = '';
    if (context.history && context.history.length > 0 && this.conversationContext) {
      conversationBlock = this.conversationContext.formatForPrompt(context.history);
      if (conversationBlock) conversationBlock += '\n\n';
    }

    const startTime = Date.now();
    const result = await this.llmRouter.route({
      job: JOBS.QUICK,
      task: 'chat',
      content: contextBlock + conversationBlock + message,
      requirements: { role: 'free' }
    });
    const duration = Date.now() - startTime;

    let response = result.result || 'Sorry, I encountered an error processing your message.';

    // Add debug info if enabled
    if (process.env.DEBUG_MODE === 'true') {
      response += `\n\n_[${result.provider || 'ollama'} | ${result.tokens || '?'} tokens | ${duration}ms]_`;
    }

    await this.auditLog('llm_response', {
      user: context.user,
      provider: result.provider,
      duration,
      responsePreview: response.substring(0, 100)
    });

    return {
      response,
      intent: 'general',
      provider: result.provider,
      duration
    };
  }

  /**
   * Store a pending confirmation
   * @param {string} handler - Handler type ('calendar' or 'email')
   * @param {Object} data - Action data to execute after confirmation
   * @param {string} user - User who initiated the action
   * @returns {string} Unique pending ID
   * @private
   */
  _storePendingConfirmation(handler, data, user) {
    const pendingId = `${handler}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    this.pendingConfirmations.set(pendingId, {
      handler,
      data,
      user,
      timestamp: Date.now()
    });

    return pendingId;
  }

  /**
   * Clean up old pending confirmations (older than TTL)
   * @private
   */
  _cleanupPendingConfirmations() {
    const cutoff = Date.now() - config.pendingActions.confirmationTTLMs;

    for (const [id, pending] of this.pendingConfirmations.entries()) {
      if (pending.timestamp < cutoff) {
        console.log(`[Router] Cleaning up expired confirmation: ${id}`);
        this.pendingConfirmations.delete(id);
      }
    }
  }

  /**
   * Get router statistics
   * @returns {RouterStats} Current router state
   */
  getStats() {
    return {
      pendingConfirmations: this.pendingConfirmations.size,
      handlersConfigured: {
        calendar: !!this.handlers.calendar,
        email: !!this.handlers.email,
        skillForge: !!this.handlers.skillForge,
        llm: !!this.llmRouter,
        calendarClient: !!this.calendarClient
      }
    };
  }
}

module.exports = MessageRouter;
