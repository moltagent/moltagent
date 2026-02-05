/**
 * MoltAgent Deck Task Processor
 * 
 * Processes tasks from NC Deck cards.
 * Integrates with heartbeat for automatic task pickup.
 * 
 * @module deck-task-processor
 * @version 1.0.0
 */

const DeckClient = require('./deck-client');

/**
 * Task Processor for NC Deck integration
 * Scans inbox, processes cards, updates status
 */
class DeckTaskProcessor {
  /**
   * Create a new task processor
   * @param {Object} config - Configuration object
   * @param {Object} router - LLM router for task execution
   * @param {Function} auditLog - Audit logging function
   */
  constructor(config, router, auditLog) {
    this.deck = new DeckClient(config);
    this.router = router;
    this.auditLog = auditLog || (async () => {});
    this.config = config;
    
    // Processing state
    this._currentTask = null;
    this._processing = false;
    this._lastCleanup = 0;
    
    // Task type handlers
    this._handlers = new Map();
    this._registerDefaultHandlers();
  }

  /**
   * Register default task type handlers
   * @private
   */
  _registerDefaultHandlers() {
    this.registerHandler('research', this._handleResearch.bind(this));
    this.registerHandler('writing', this._handleWriting.bind(this));
    this.registerHandler('admin', this._handleAdmin.bind(this));
    this.registerHandler('generic', this._handleGeneric.bind(this));
  }

  /**
   * Register a custom task handler
   * @param {string} taskType - Task type name
   * @param {Function} handler - Async handler function(card) => {summary, result}
   */
  registerHandler(taskType, handler) {
    this._handlers.set(taskType, handler);
  }

  /**
   * Initialize the processor
   * Ensures board exists with proper structure
   * @returns {Promise<Object>} Board info
   */
  async initialize() {
    const { boardId, stacks, labels } = await this.deck.ensureBoard();
    
    await this.auditLog('deck_initialized', {
      boardId,
      stacks,
      labels: Object.keys(labels),
      boardName: this.deck.boardName
    });

    console.log(`[DeckProcessor] Initialized with board ID: ${boardId}`);
    return { boardId, stacks, labels };
  }

  /**
   * Process inbox cards
   * Called from heartbeat or manually
   * @returns {Promise<Object>} Processing results
   */
  async processInbox() {
    if (this._processing) {
      console.log('[DeckProcessor] Already processing, skipping');
      return { skipped: true, reason: 'already_processing' };
    }

    this._processing = true;
    const results = {
      processed: 0,
      queued: 0,
      blocked: 0,
      errors: [],
      startTime: Date.now()
    };

    try {
      // Scan inbox
      const inboxCards = await this.deck.scanInbox();
      
      if (inboxCards.length === 0) {
        results.endTime = Date.now();
        results.duration = results.endTime - results.startTime;
        return results;
      }

      console.log(`[DeckProcessor] Found ${inboxCards.length} cards in inbox`);

      // Sort by priority: urgent first, then by creation date
      inboxCards.sort((a, b) => {
        if (a.urgent && !b.urgent) return -1;
        if (!a.urgent && b.urgent) return 1;
        return (a.createdAt || 0) - (b.createdAt || 0);
      });

      // Process each card
      for (const card of inboxCards) {
        // Skip cards with 'blocked' label (waiting for human)
        if (card.labels.includes('blocked')) {
          console.log(`[DeckProcessor] Skipping blocked card: ${card.title}`);
          results.blocked++;
          continue;
        }

        try {
          const taskResult = await this._processCard(card);
          results.processed++;
          
          await this.auditLog('deck_task_processed', {
            cardId: card.id,
            title: card.title,
            taskType: taskResult.taskType,
            success: true
          });
          
        } catch (error) {
          console.error(`[DeckProcessor] Error processing card ${card.id}: ${error.message}`);
          results.errors.push({
            cardId: card.id,
            title: card.title,
            error: error.message
          });
          
          await this.auditLog('deck_task_error', {
            cardId: card.id,
            title: card.title,
            error: error.message
          });
        }
      }

    } finally {
      this._processing = false;
      this._currentTask = null;
    }

    results.endTime = Date.now();
    results.duration = results.endTime - results.startTime;
    
    return results;
  }

  /**
   * Process a single card
   * @private
   */
  async _processCard(card) {
    console.log(`[DeckProcessor] Processing: "${card.title}"`);
    this._currentTask = card;

    // Classify task type
    const taskType = this._classifyTask(card);
    console.log(`[DeckProcessor] Task type: ${taskType}`);

    // Get handler
    const handler = this._handlers.get(taskType) || this._handlers.get('generic');
    
    // Move to working and add status
    await this.deck.startTask(card.id, `Processing as ${taskType} task...`);

    try {
      // Execute handler
      const result = await handler(card);
      
      // Complete the task
      await this.deck.completeTask(card.id, result.summary);
      
      return { taskType, result };
      
    } catch (error) {
      // Check if task needs human input
      if (error.needsHumanInput) {
        await this.deck.blockTask(card.id, error.message);
        return { taskType, blocked: true, reason: error.message };
      }
      
      // Real error - fail the task
      await this.deck.failTask(card.id, 'working', `Error: ${error.message}`, true);
      throw error;
    }
  }

  /**
   * Classify task type from card labels and content
   * @private
   */
  _classifyTask(card) {
    // Check labels first (explicit classification)
    if (card.labels.includes('research')) return 'research';
    if (card.labels.includes('writing')) return 'writing';
    if (card.labels.includes('admin')) return 'admin';

    // Content-based classification
    const content = `${card.title} ${card.description}`.toLowerCase();
    
    const patterns = {
      research: /\b(research|find|search|look up|investigate|discover|analyze|compare)\b/,
      writing: /\b(write|draft|compose|create|email|letter|document|blog|article|post)\b/,
      admin: /\b(organize|clean|sort|rename|move|delete|archive|backup|files?|folders?)\b/
    };

    for (const [type, pattern] of Object.entries(patterns)) {
      if (pattern.test(content)) {
        return type;
      }
    }

    return 'generic';
  }

  // ============================================================
  // DEFAULT TASK HANDLERS
  // ============================================================

  /**
   * Handle research tasks
   * @private
   */
  async _handleResearch(card) {
    const prompt = this._buildPrompt('research', card, `
You are helping with a research task.

Research Request:
Title: ${card.title}
Details: ${card.description || 'No additional details provided.'}
${card.duedate ? `Due: ${card.duedate}` : ''}

Please provide:
1. A concise summary of your findings (2-3 paragraphs)
2. Key points as a bullet list (5-7 items max)
3. Any important sources or references

Be thorough but concise. Focus on actionable insights.
    `);

    const response = await this.router.route({
      task: 'research',
      content: prompt,
      requirements: { 
        role: card.urgent ? 'premium' : 'value',
        quality: 'good'
      }
    });

    return {
      summary: `Research completed. ${this._extractFirstSentence(response.result)}`,
      full: response.result,
      provider: response.provider
    };
  }

  /**
   * Handle writing tasks
   * @private
   */
  async _handleWriting(card) {
    const prompt = this._buildPrompt('writing', card, `
You are helping with a writing task.

Writing Request:
Title: ${card.title}
Details: ${card.description || 'No additional details provided.'}
${card.duedate ? `Due: ${card.duedate}` : ''}

Please create the requested content:
- Match the appropriate tone and style for the context
- Be clear and well-structured
- If it's an email, include a subject line

If critical details are missing (like recipient name, specific topic, etc.), 
note what you assumed or what the user should fill in.
    `);

    const response = await this.router.route({
      task: 'writing',
      content: prompt,
      requirements: { 
        role: 'premium',  // Writing quality matters
        quality: 'excellent'
      }
    });

    return {
      summary: 'Writing completed. Draft ready for review.',
      full: response.result,
      provider: response.provider
    };
  }

  /**
   * Handle admin tasks
   * @private
   */
  async _handleAdmin(card) {
    // Admin tasks typically need human confirmation for safety
    // Parse the request and ask for specifics
    
    const content = `${card.title}\n${card.description}`.toLowerCase();
    
    // Check if this is a safe inquiry task
    if (content.match(/\b(list|show|find|locate|status|check)\b/) && 
        !content.match(/\b(delete|remove|move|rename)\b/)) {
      // Safe to execute - just information gathering
      const prompt = this._buildPrompt('admin', card, `
Administrative task request:
Title: ${card.title}
Details: ${card.description || 'No additional details provided.'}

This appears to be an information-gathering task. Please provide:
1. What information or files you would look for
2. Where you would search
3. Any preliminary findings or recommendations

Note: I cannot actually access the file system directly in this context.
I can provide guidance on how to accomplish this task.
      `);

      const response = await this.router.route({
        task: 'admin',
        content: prompt,
        requirements: { role: 'value' }
      });

      return {
        summary: 'Analysis completed. See recommendations.',
        full: response.result,
        provider: response.provider
      };
    }
    
    // For modification tasks, request human confirmation
    const error = new Error(
      `This admin task may modify files: "${card.title}". ` +
      `Please provide specific file paths and confirm the action in a comment. ` +
      `Example: "Confirmed. Path: /documents/old/*.pdf Action: move to /archive/"`
    );
    error.needsHumanInput = true;
    throw error;
  }

  /**
   * Handle generic tasks
   * @private
   */
  async _handleGeneric(card) {
    const prompt = this._buildPrompt('generic', card, `
Task Request:
Title: ${card.title}
Details: ${card.description || 'No additional details provided.'}
${card.duedate ? `Due: ${card.duedate}` : ''}

Please help with this task. Provide a clear, actionable response.
If you need more information to complete the task properly, say so clearly.
    `);

    const response = await this.router.route({
      task: 'generic',
      content: prompt,
      requirements: { 
        role: card.urgent ? 'premium' : 'value'
      }
    });

    return {
      summary: `Task completed. ${this._extractFirstSentence(response.result)}`,
      full: response.result,
      provider: response.provider
    };
  }

  /**
   * Build a prompt with consistent structure
   * @private
   */
  _buildPrompt(taskType, card, customPrompt) {
    return customPrompt.trim();
  }

  /**
   * Extract first sentence from text
   * @private
   */
  _extractFirstSentence(text) {
    if (!text) return '';
    const match = text.match(/^[^.!?]+[.!?]/);
    if (match) {
      const sentence = match[0].trim();
      return sentence.length > 100 ? sentence.substring(0, 97) + '...' : sentence;
    }
    return text.substring(0, 100) + (text.length > 100 ? '...' : '');
  }

  // ============================================================
  // STATUS & MAINTENANCE
  // ============================================================

  /**
   * Get current processing status
   * @returns {Promise<Object>} Status object
   */
  async getStatus() {
    try {
      const summary = await this.deck.getWorkloadSummary();
      
      return {
        ...summary,
        currentTask: this._currentTask ? {
          id: this._currentTask.id,
          title: this._currentTask.title
        } : null,
        processing: this._processing,
        healthy: true
      };
    } catch (error) {
      return {
        healthy: false,
        error: error.message,
        processing: this._processing
      };
    }
  }

  /**
   * Run cleanup of old completed cards
   * @returns {Promise<number>} Number of cards archived
   */
  async runCleanup() {
    const now = Date.now();
    
    // Only run once per day
    if (now - this._lastCleanup < 86400000) {
      return 0;
    }
    
    this._lastCleanup = now;
    const archived = await this.deck.cleanupOldCards();
    
    if (archived > 0) {
      await this.auditLog('deck_cleanup', { archived });
    }
    
    return archived;
  }

  /**
   * Create a task card programmatically
   * @param {Object} task - Task definition
   * @param {string} task.title - Task title
   * @param {string} [task.description] - Task description
   * @param {string} [task.duedate] - Due date (ISO format)
   * @param {Array<string>} [task.labels] - Labels to apply
   * @param {string} [task.stack='inbox'] - Target stack
   * @returns {Promise<Object>} Created card
   */
  async createTask(task) {
    const stack = task.stack || 'inbox';
    return await this.deck.createCard(stack, {
      title: task.title,
      description: task.description,
      duedate: task.duedate,
      labels: task.labels
    });
  }

  /**
   * Get the deck client for direct API access
   * @returns {DeckClient}
   */
  getDeckClient() {
    return this.deck;
  }
}

/**
 * Error class for tasks needing human input
 */
class HumanInputRequired extends Error {
  constructor(message) {
    super(message);
    this.name = 'HumanInputRequired';
    this.needsHumanInput = true;
  }
}

module.exports = DeckTaskProcessor;
module.exports.HumanInputRequired = HumanInputRequired;
