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
const { JOBS } = require('../llm/router');

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
  constructor(config, router, auditLog, options = {}) {
    this.deck = new DeckClient(config);
    this.router = router;
    this.auditLog = auditLog || (async () => {});
    this.config = config;
    this.routeContext = options.routeContext || {};
    
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
        // Skip cards assigned to someone else (not Moltagent)
        const assignees = card.assignedUsers || [];
        if (assignees.length > 0) {
          const myUsername = (this.deck.username || 'moltagent').toLowerCase();
          const assignedToMe = assignees.some(u =>
            (u.participant?.uid || u.uid || '').toLowerCase() === myUsername
          );
          if (!assignedToMe) {
            console.log(`[DeckProcessor] Skipping card assigned to others: "${card.title}"`);
            results.skippedAssigned = (results.skippedAssigned || 0) + 1;
            continue;
          }
        }

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

    // Store original description for review
    const originalDescription = card.description || '';

    // Classify task type
    const taskType = this._classifyTask(card);
    console.log(`[DeckProcessor] Task type: ${taskType}`);

    // Get handler
    const handler = this._handlers.get(taskType) || this._handlers.get('generic');

    // Accept task from inbox (moves to queued)
    await this.deck.acceptTask(card.id, `Accepted. Processing as ${taskType} task...`);

    // Ensure MoltAgent and card creator are assigned
    await this.deck.ensureAssignments(card.id, 'queued', card.owner);

    // Move to working
    await this.deck.startTask(card.id, `Working on ${taskType} task...`);

    // Ensure MoltAgent and card creator are assigned on the working stack
    try {
      await this.deck.ensureAssignments(card.id, 'working', card.owner);
    } catch (err) {
      console.warn('[DeckProcessor] Could not assign users on working:', err.message);
    }

    try {
      // Execute handler
      const result = await handler(card);

      // Submit for review with full LLM response in description
      await this.deck.submitForReview(
        card.id,
        'working',
        originalDescription,
        result.full || result.summary,
        result.summary
      );

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
      job: JOBS.RESEARCH,
      task: 'research',
      content: prompt,
      requirements: {
        role: card.urgent ? 'premium' : 'value',
        quality: 'good'
      },
      context: this.routeContext
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
      job: JOBS.WRITING,
      task: 'writing',
      content: prompt,
      requirements: {
        role: 'premium',  // Writing quality matters
        quality: 'excellent'
      },
      context: this.routeContext
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
        job: JOBS.THINKING,
        task: 'admin',
        content: prompt,
        requirements: { role: 'value' },
        context: this.routeContext
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
      job: JOBS.THINKING,
      task: 'generic',
      content: prompt,
      requirements: {
        role: card.urgent ? 'premium' : 'value'
      },
      context: this.routeContext
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
  // COMMENT PROCESSING (ALL STACKS)
  // ============================================================

  /**
   * Scan all stacks for cards with human feedback and process them
   * Called from heartbeat. Monitors inbox, queued, working, and review stacks.
   * @returns {Promise<Object>} Processing results
   */
  async processReviewFeedback() {
    if (this._processing) {
      console.log('[DeckProcessor] Already processing, skipping comment scan');
      return { skipped: true, reason: 'already_processing' };
    }

    this._processing = true;
    const results = {
      scanned: 0,
      processed: 0,
      completed: 0,
      skippedAcknowledgments: 0,
      byStack: { inbox: 0, queued: 0, working: 0, review: 0 },
      errors: [],
      startTime: Date.now()
    };

    try {
      // Scan ALL stacks for cards with human comments assigned to MoltAgent
      const cardsWithFeedback = await this.deck.scanAllStacksForComments();
      results.scanned = cardsWithFeedback.length;

      if (cardsWithFeedback.length === 0) {
        results.endTime = Date.now();
        results.duration = results.endTime - results.startTime;
        return results;
      }

      console.log(`[DeckProcessor] Found ${cardsWithFeedback.length} cards with feedback across all stacks`);

      for (const card of cardsWithFeedback) {
        try {
          const feedbackResult = await this._processFeedbackCard(card);
          results.processed++;
          results.byStack[card.stack] = (results.byStack[card.stack] || 0) + 1;

          if (feedbackResult.completed) {
            results.completed++;
          }
          if (feedbackResult.noResponse) {
            results.skippedAcknowledgments++;
          }

          await this.auditLog('deck_comment_processed', {
            cardId: card.id,
            title: card.title,
            stack: card.stack,
            feedbackCount: card.humanComments.length,
            action: feedbackResult.action,
            completed: feedbackResult.completed
          });

        } catch (error) {
          console.error(`[DeckProcessor] Error processing card ${card.id} in ${card.stack}: ${error.message}`);
          results.errors.push({
            cardId: card.id,
            title: card.title,
            stack: card.stack,
            error: error.message
          });

          await this.auditLog('deck_comment_error', {
            cardId: card.id,
            title: card.title,
            stack: card.stack,
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
   * Process a single card with feedback from any stack
   * @private
   */
  async _processFeedbackCard(card) {
    const stack = card.stack || 'review';
    console.log(`[DeckProcessor] Processing feedback for: "${card.title}" (stack: ${stack})`);
    this._currentTask = card;

    // Get the most recent human comment
    const latestComment = card.humanComments[card.humanComments.length - 1];
    const feedback = latestComment.message;

    // Classify the comment intent using LLM
    const classification = await this._classifyComment(feedback, card);
    console.log(`[DeckProcessor] Comment classified as: ${classification.type} (stack: ${stack})`);

    // Handle based on classification and stack
    switch (classification.type) {
      case 'acknowledgment':
        // Pure acknowledgment - no response needed
        console.log(`[DeckProcessor] Acknowledgment detected, no action needed`);
        return { completed: false, action: 'acknowledged', noResponse: true };

      case 'rejection':
        // Only move to inbox if in review stack
        if (stack === 'review') {
          await this.deck.addComment(card.id, 'Feedback received. Moving back for reprocessing.', 'STATUS');
          await this.deck.moveCard(card.id, 'review', 'inbox');
        } else {
          // For other stacks, just note the rejection
          await this.deck.addComment(card.id, 'Rejection noted. Will address in current processing.', 'STATUS');
        }
        return { completed: false, action: 'rejected' };

      case 'clarification':
        // For clarifications on working cards, just acknowledge - we're already processing
        if (stack === 'working') {
          await this.deck.addComment(card.id, 'Clarification noted. Incorporating into current work.', 'STATUS');
          return { completed: false, action: 'clarification_noted', noResponse: true };
        }
        // For other stacks, respond
        return await this._respondToFeedback(card, feedback, classification);

      case 'question':
      case 'request':
      default:
        // Respond to the feedback
        return await this._respondToFeedback(card, feedback, classification);
    }
  }

  /**
   * Classify comment intent using LLM
   * @private
   * @param {string} comment - The comment text
   * @param {Object} card - The card object for context
   * @returns {Promise<Object>} Classification result with type and confidence
   */
  async _classifyComment(comment, card) {
    // Quick check for very short acknowledgments (< 20 chars, no question marks)
    const trimmed = comment.trim().toLowerCase();
    if (trimmed.length < 20 && !trimmed.includes('?')) {
      const quickAcks = ['ok', 'okay', 'k', 'thx', 'thanks', 'thank you', 'nice', 'cool', 'great',
                         'perfect', 'good', 'got it', 'noted', 'understood', 'alright', 'fine',
                         'awesome', 'excellent', 'wonderful', 'brilliant', 'cheers', 'ty', 'np'];
      if (quickAcks.some(ack => trimmed === ack || trimmed === ack + '!' || trimmed === ack + '.')) {
        return { type: 'acknowledgment', confidence: 'high', method: 'quick_match' };
      }
    }

    // Use LLM for classification
    const stack = card.stack || 'review';
    const classificationPrompt = `Classify this comment on a task card.
Task: "${card.title}"
Current stage: ${stack}

Comment: "${comment}"

Classify as ONE of:
- acknowledgment: Simple thanks, approval, or "got it" with no request (e.g., "nice, thx", "looks good", "perfect", "thanks!")
- clarification: User is providing additional context or correcting a misunderstanding
- question: User is asking something about the task or result
- request: User wants changes, additions, or new work done
- rejection: User explicitly wants to redo/reject the work (e.g., "redo this", "try again", "wrong approach")

Reply with ONLY the classification word, nothing else.`;

    try {
      const result = await this.router.route({
        job: JOBS.QUICK,
        task: 'classify',
        content: classificationPrompt,
        requirements: {
          role: 'free',  // Use free tier for lightweight classification
          quality: 'fast',
          maxTokens: 50
        },
        context: this.routeContext
      });

      const classification = (result.result || '').trim().toLowerCase();
      const validTypes = ['acknowledgment', 'clarification', 'question', 'request', 'rejection'];

      if (validTypes.includes(classification)) {
        return { type: classification, confidence: 'medium', method: 'llm' };
      }

      // Default to request if unclear
      return { type: 'request', confidence: 'low', method: 'llm_fallback' };

    } catch (error) {
      console.warn(`[DeckProcessor] Classification failed: ${error.message}, defaulting to request`);
      return { type: 'request', confidence: 'low', method: 'error_fallback' };
    }
  }

  /**
   * Respond to feedback that needs a response
   * @private
   */
  async _respondToFeedback(card, feedback, classification) {
    const context = this._extractContextFromDescription(card.description);

    const prompt = `
You previously helped with this task:

**Original Task:** ${card.title}
${context.originalTask ? `\n**Task Details:**\n${context.originalTask}` : ''}

**Your Previous Response:**
${context.previousResponse || '(Response not available)'}

**User Feedback (${classification.type}):**
${feedback}

Please address the user's ${classification.type}. Be concise and helpful.
`;

    try {
      const response = await this.router.route({
        job: JOBS.THINKING,
        task: 'followup',
        content: prompt,
        requirements: {
          role: 'value',
          quality: 'good'
        },
        context: this.routeContext
      });

      // Never auto-complete - user must explicitly move card to done
      await this.deck.respondToFeedback(card.id, response.result, false);

      return {
        completed: false,
        action: `followup_${classification.type}`,
        provider: response.provider
      };

    } catch (error) {
      console.error(`[DeckProcessor] Follow-up failed for card ${card.id}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Extract original task and previous response from card description
   * @private
   */
  _extractContextFromDescription(description) {
    const context = {
      originalTask: '',
      previousResponse: ''
    };

    if (!description) return context;

    // Parse the structured description format
    const originalMatch = description.match(/## Original Task\s*\n\n([\s\S]*?)(?=\n---\n|$)/);
    if (originalMatch) {
      context.originalTask = originalMatch[1].trim();
    }

    const responseMatch = description.match(/## MoltAgent Response\s*\n\n([\s\S]*?)$/);
    if (responseMatch) {
      context.previousResponse = responseMatch[1].trim();
    }

    return context;
  }

  // ============================================================
  // ASSIGNMENT DETECTION
  // ============================================================

  /**
   * Scan for cards assigned to MoltAgent and determine if action is needed
   * Called from heartbeat to detect new assignments
   * @returns {Promise<Object>} Processing results
   */
  async processAssignedCards() {
    if (this._processing) {
      console.log('[DeckProcessor] Already processing, skipping assignment scan');
      return { skipped: true, reason: 'already_processing' };
    }

    this._processing = true;
    const results = {
      scanned: 0,
      actionNeeded: 0,
      processed: 0,
      byStack: { inbox: 0, queued: 0, working: 0, review: 0 },
      errors: [],
      startTime: Date.now()
    };

    try {
      // Scan all stacks for cards assigned to MoltAgent
      const assignedCards = await this.deck.scanAssignedCards();
      results.scanned = assignedCards.length;

      if (assignedCards.length === 0) {
        results.endTime = Date.now();
        results.duration = results.endTime - results.startTime;
        return results;
      }

      console.log(`[DeckProcessor] Found ${assignedCards.length} cards assigned to MoltAgent`);

      for (const card of assignedCards) {
        try {
          const needsAction = await this._analyzeIfActionNeeded(card);

          if (needsAction.action) {
            results.actionNeeded++;
            results.byStack[card.stack] = (results.byStack[card.stack] || 0) + 1;

            // Take action based on analysis
            const actionResult = await this._takeAssignedCardAction(card, needsAction);
            if (actionResult.processed) {
              results.processed++;
            }

            await this.auditLog('deck_assigned_card_action', {
              cardId: card.id,
              title: card.title,
              stack: card.stack,
              analysisResult: needsAction.reason,
              actionTaken: actionResult.action
            });
          }

        } catch (error) {
          console.error(`[DeckProcessor] Error analyzing assigned card ${card.id}: ${error.message}`);
          results.errors.push({
            cardId: card.id,
            title: card.title,
            stack: card.stack,
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
   * Analyze if an assigned card needs action from MoltAgent
   * @private
   * @param {Object} card - The card to analyze
   * @returns {Promise<Object>} Analysis result with action flag and reason
   */
  async _analyzeIfActionNeeded(card) {
    const stack = card.stack;

    // Cards in inbox that are assigned to us need processing
    if (stack === 'inbox') {
      // Check if it has 'blocked' label (waiting for human)
      if (card.labels.includes('blocked')) {
        return { action: false, reason: 'blocked_waiting_for_human' };
      }
      return { action: true, reason: 'new_task_in_inbox' };
    }

    // Cards in queued - should be picked up by normal processing
    if (stack === 'queued') {
      return { action: true, reason: 'queued_task_assigned' };
    }

    // Cards in working - check if stuck (no progress comments in last hour)
    if (stack === 'working') {
      // For now, don't take automatic action on working cards
      // They should be actively processing
      return { action: false, reason: 'already_in_progress' };
    }

    // Cards in review - check for unaddressed feedback
    if (stack === 'review') {
      // Review cards are handled by processReviewFeedback
      return { action: false, reason: 'handled_by_review_process' };
    }

    return { action: false, reason: 'unknown_stack' };
  }

  /**
   * Take action on an assigned card that needs attention
   * @private
   */
  async _takeAssignedCardAction(card, analysis) {
    const stack = card.stack;

    if (stack === 'inbox' && analysis.reason === 'new_task_in_inbox') {
      // Process the card through normal inbox flow
      console.log(`[DeckProcessor] Processing assigned inbox card: "${card.title}"`);
      try {
        await this._processCard(card);
        return { processed: true, action: 'processed_from_inbox' };
      } catch (error) {
        console.error(`[DeckProcessor] Failed to process assigned card: ${error.message}`);
        return { processed: false, action: 'process_failed', error: error.message };
      }
    }

    if (stack === 'queued' && analysis.reason === 'queued_task_assigned') {
      // Move to working and process
      console.log(`[DeckProcessor] Processing assigned queued card: "${card.title}"`);
      try {
        // Re-fetch card with full details for processing
        const fullCard = {
          ...card,
          urgent: card.labels.includes('urgent')
        };
        await this._processCard(fullCard);
        return { processed: true, action: 'processed_from_queued' };
      } catch (error) {
        console.error(`[DeckProcessor] Failed to process queued card: ${error.message}`);
        return { processed: false, action: 'process_failed', error: error.message };
      }
    }

    return { processed: false, action: 'no_action_taken' };
  }

  // ============================================================
  // @MENTION HANDLING
  // ============================================================

  /**
   * Process a deck_comment_added event to detect and respond to @mentions.
   * Called from heartbeat when ActivityPoller detects a new comment from another user.
   *
   * Flow: event → fetch comments → check mentions → read card context → respond
   *
   * @param {Object} event - NCFlowEvent with type 'deck_comment_added'
   * @param {string} event.objectId - Card ID (as string)
   * @param {string} event.user - User who posted the comment
   * @param {Object} event.data - Event metadata (activityId, subject, etc.)
   * @returns {Promise<Object>} Result: { handled, reason, cardId? }
   */
  async processMention(event, options = {}) {
    const cardId = parseInt(event.objectId, 10);
    if (!cardId || isNaN(cardId)) {
      console.log(`[DeckProcessor] @mention: invalid card ID from event`);
      return { handled: false, reason: 'invalid_card_id' };
    }

    const myUsername = (this.deck.username || 'moltagent').toLowerCase();

    // Ignore own comments
    if ((event.user || '').toLowerCase() === myUsername) {
      return { handled: false, reason: 'own_comment' };
    }

    console.log(`[DeckProcessor] @mention: checking card #${cardId} (event from ${event.user})`);

    try {
      // Fetch comments for the card
      const comments = await this.deck.getComments(cardId);
      if (!comments || comments.length === 0) {
        console.log(`[DeckProcessor] @mention: no comments on card #${cardId}`);
        return { handled: false, reason: 'no_comments' };
      }

      // Find the latest comment from this user that mentions us
      // Comments are returned newest-first by the API
      const mentionComment = comments.find(c => {
        if ((c.actorId || '').toLowerCase() !== (event.user || '').toLowerCase()) return false;
        const mentions = c.mentions || [];
        return mentions.some(m => (m.mentionId || '').toLowerCase() === myUsername);
      });

      if (!mentionComment) {
        console.log(`[DeckProcessor] @mention: no @${myUsername} mention found in ${comments.length} comments on card #${cardId}`);
        return { handled: false, reason: 'no_mention_found' };
      }

      // Check if we already responded to this mention (avoid re-processing)
      const mentionIdx = comments.indexOf(mentionComment);
      // Look for our response after this comment (earlier in the array = newer)
      const alreadyResponded = comments.slice(0, mentionIdx).some(c =>
        (c.actorId || '').toLowerCase() === myUsername
      );

      if (alreadyResponded) {
        console.log(`[DeckProcessor] @mention: already responded to mention on card #${cardId}`);
        return { handled: false, reason: 'already_responded' };
      }

      // Read full card context
      const cardContext = await this._getMentionCardContext(cardId);
      if (!cardContext) {
        return { handled: false, reason: 'card_not_found' };
      }

      console.log(`[DeckProcessor] @mention detected on card #${cardId} "${cardContext.title}" by ${event.user}`);

      // Build card context for the prompt
      const commentsBlock = cardContext.recentComments.length > 0
        ? cardContext.recentComments.map(c =>
            `  ${c.author}: ${c.message}`
          ).join('\n')
        : '(no previous comments)';

      const contextBlock = [
        `**Card:** "${cardContext.title}" (Board: ${cardContext.boardTitle}, Stack: ${cardContext.stackTitle})`,
        cardContext.description ? `**Description:** ${cardContext.description.substring(0, 500)}` : '',
        cardContext.assignedUsers.length > 0 ? `**Assigned to:** ${cardContext.assignedUsers.join(', ')}` : '',
        cardContext.duedate ? `**Due:** ${cardContext.duedate}` : '',
        `\n**Recent comments:**\n${commentsBlock}`,
      ].filter(Boolean).join('\n');

      const mentionPrompt = `You were @mentioned in a Deck card comment. Respond helpfully and concisely.
You are ASSISTING on this card — you are NOT the owner. Do NOT move, reassign, or close the card.

${contextBlock}

**${event.user} says:** ${mentionComment.message}

Respond directly to ${event.user}'s request. Use your tools to fulfill the request if possible.`;

      // Route through AgentLoop (with tools) if available, else text-only LLM
      let response;
      const agentLoop = options.agentLoop;
      if (agentLoop) {
        console.log(`[DeckProcessor] Routing @mention through AgentLoop (with tools)`);
        response = await agentLoop.process(mentionPrompt, null, {
          user: event.user,
          maxIterations: 5
        });
      } else {
        response = await this._generateMentionResponse(
          cardContext,
          mentionComment.message,
          event.user
        );
      }

      // Post response as [MENTION]-prefixed comment for consistency with bot prefix detection
      await this.deck.addComment(cardId, response, 'MENTION', { prefix: true });

      await this.auditLog('deck_mention_handled', {
        cardId,
        title: cardContext.title,
        mentionedBy: event.user,
        commentId: mentionComment.id
      });

      console.log(`[DeckProcessor] Responded to @mention on card #${cardId}`);
      return { handled: true, reason: 'responded', cardId };

    } catch (error) {
      console.error(`[DeckProcessor] @mention processing failed for card ${cardId}: ${error.message}`);
      return { handled: false, reason: 'error', error: error.message };
    }
  }

  /**
   * Get full card context for @mention response generation.
   * @private
   * @param {number} cardId - Card ID
   * @returns {Promise<Object|null>} Card context or null
   */
  async _getMentionCardContext(cardId) {
    try {
      // We need to find which board/stack this card is in
      // Use the search-across-boards approach from tool-registry
      const boards = await this.deck.listBoards();

      for (const board of boards) {
        try {
          const stacks = await this.deck.getStacks(board.id);
          for (const stack of stacks || []) {
            const card = (stack.cards || []).find(c => c.id === cardId);
            if (card) {
              // Get comments for context
              const comments = await this.deck.getComments(cardId);
              const recentComments = comments.slice(0, 10).map(c => ({
                author: c.actorId || 'unknown',
                message: c.message || '',
                date: c.creationDateTime || ''
              }));

              return {
                id: card.id,
                title: card.title,
                description: card.description || '',
                boardTitle: board.title,
                stackTitle: stack.title,
                assignedUsers: (card.assignedUsers || []).map(u =>
                  u.participant?.uid || u.uid || 'unknown'
                ),
                duedate: card.duedate,
                recentComments
              };
            }
          }
        } catch (e) {
          // Board might not be accessible — skip
          continue;
        }
      }

      return null;
    } catch (error) {
      console.warn(`[DeckProcessor] Failed to get card context for #${cardId}: ${error.message}`);
      return null;
    }
  }

  /**
   * Generate a response to an @mention using LLM.
   * @private
   * @param {Object} cardContext - Full card context
   * @param {string} mentionMessage - The comment that mentioned us
   * @param {string} mentionedBy - Username who mentioned us
   * @returns {Promise<string>} Response text
   */
  async _generateMentionResponse(cardContext, mentionMessage, mentionedBy) {
    const commentsBlock = cardContext.recentComments.length > 0
      ? cardContext.recentComments.map(c =>
          `  ${c.author}: ${c.message}`
        ).join('\n')
      : '(no previous comments)';

    const prompt = `You were @mentioned in a card comment. Respond helpfully and concisely.
You are ASSISTING on this card — you are NOT the owner. Do NOT move, reassign, or close the card.

**Card:** "${cardContext.title}" (Board: ${cardContext.boardTitle}, Stack: ${cardContext.stackTitle})
${cardContext.description ? `**Description:** ${cardContext.description.substring(0, 500)}` : ''}
${cardContext.assignedUsers.length > 0 ? `**Assigned to:** ${cardContext.assignedUsers.join(', ')}` : ''}
${cardContext.duedate ? `**Due:** ${cardContext.duedate}` : ''}

**Recent comments:**
${commentsBlock}

**${mentionedBy} says:** ${mentionMessage}

Respond directly to ${mentionedBy}'s request. Be concise and helpful. If you can answer directly, do so. If you need to do research or take action, explain what you'll do.`;

    try {
      const result = await this.router.route({
        job: JOBS.THINKING,
        task: 'mention_response',
        content: prompt,
        requirements: {
          role: 'value',
          quality: 'good'
        },
        context: this.routeContext
      });

      return result.result || 'I received your mention but had trouble generating a response. Please try again.';
    } catch (error) {
      console.warn(`[DeckProcessor] Mention response generation failed: ${error.message}`);
      return `I received your mention regarding "${cardContext.title}" but encountered an error generating a response. Please try again or reach out in Talk.`;
    }
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
