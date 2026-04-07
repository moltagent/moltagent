/*
 * Moltagent - Sovereign AI Security Layer
 * Copyright (C) 2026 Moltagent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

'use strict';

/**
 * DeckExecutor — Parameter-extraction executor for Deck/Kanban operations.
 *
 * Architecture Brief:
 * - Problem: Executor only knew card-level CRUD; "create a board" was misclassified as card creation
 * - Pattern: Extract params with 3 abstraction levels (board/stack/card) → route by action → validate
 *   → delegate to deck_* tools or DeckClient board/stack API → confirm
 * - Key Dependencies: BaseExecutor, ToolRegistry (card ops), DeckClient (board/stack ops), LLMRouter
 * - Data Flow: message → extract (action + target level + delegation) → action switch → validate
 *   → toolRegistry.execute / deckClient API → log → confirm
 *
 * v2 additions: board/stack CRUD, compound setup_workflow, delegation intelligence,
 * board/stack name resolution, destructive operation confirmation.
 *
 * @module agent/executors/deck-executor
 * @version 2.0.0
 */

const BaseExecutor = require('./base-executor');
const DECK = require('../../../config/deck-names');

// Stack name aliases — bridge user language to canonical stack names
const STACK_ALIASES = {
  done: DECK.stacks.done,
  completed: DECK.stacks.done,
  finished: DECK.stacks.done,
  closed: DECK.stacks.done,
  doing: DECK.stacks.working,
  'in progress': DECK.stacks.working,
  working: DECK.stacks.working,
  active: DECK.stacks.working,
  inbox: DECK.stacks.inbox,
  new: DECK.stacks.inbox,
  backlog: DECK.stacks.inbox,
  todo: DECK.stacks.inbox,
  'to do': DECK.stacks.inbox,
  'to-do': DECK.stacks.inbox,
  queued: DECK.stacks.queued,
  planned: DECK.stacks.queued,
  scheduled: DECK.stacks.queued,
  upcoming: DECK.stacks.queued,
  review: DECK.stacks.review,
  waiting: DECK.stacks.review,
  blocked: DECK.stacks.review,
  'on hold': DECK.stacks.review,
  paused: DECK.stacks.review
};

class DeckExecutor extends BaseExecutor {
  /**
   * @param {Object} config - BaseExecutor config + toolRegistry + deckClient
   * @param {Object} config.toolRegistry - ToolRegistry with deck_* tools
   * @param {Object} [config.deckClient] - DeckClient instance for board/stack CRUD
   */
  constructor(config = {}) {
    super(config);
    this.toolRegistry = config.toolRegistry;
    this.deckClient = config.deckClient || null;
    this.adminUser = config.adminUser || process.env.KNOWLEDGE_ADMIN_USER || null;
  }

  _deckUrl(type, id) {
    const base = this.deckClient?.baseUrl;
    return base ? `${base}/apps/deck/${type}/${id}` : '';
  }

  _deckLink(label, url) {
    return url ? `[${label}](${url})` : `"${label}"`;
  }

  /**
   * Execute a deck operation from a natural language message.
   *
   * @param {string} message - User message
   * @param {Object} context - { userName, roomToken, warmMemory? }
   * @returns {Promise<Object>} { response, actionRecord? }
   */
  async execute(message, context) {
    const dateContext = this._dateContext();
    const DECK_SCHEMA = {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [
          'list', 'get', 'create', 'move', 'update', 'delete', 'assign', 'label',
          'create_board', 'list_boards', 'rename_board', 'archive_board', 'delete_board',
          'create_stack', 'rename_stack', 'delete_stack',
          'setup_workflow', 'troubleshoot'
        ] },
        board_name: { type: 'string' },
        card_title: { type: 'string' },
        stack_name: { type: 'string' },
        description: { type: 'string' },
        due_date: { type: 'string' },
        new_title: { type: 'string' },
        assignee: { type: 'string' },
        label_name: { type: 'string' },
        color: { type: 'string' },
        purpose: { type: 'string' },
        delegated: { type: 'boolean' },
        requires_clarification: { type: 'boolean' },
        missing_fields: { type: 'array', items: { type: 'string' } }
      },
      required: ['action']
    };

    const extractionPrompt = `${dateContext}

Extract task/board operation parameters from this message.
Leave fields as empty strings if not mentioned. Do NOT guess values.

The user may use either Nextcloud Deck terms or Trello terms:
  Nextcloud Deck    Trello          Meaning
  Board / Deck      Board           A workspace containing columns and cards
  Stack             List / Column   A vertical column within a board
  Card              Card            A single task or item within a column

Target levels:
- BOARD: the user mentions "board", "deck", "workspace", "project board", or wants to set up an entire workflow
- STACK: the user mentions "stack", "list", "column", "stage", "phase", or workflow stages
- CARD: the user mentions "card", "task", "item", "to-do", "ticket", or a specific piece of work

Action rules:
Board level:
- "Create a board/deck called X" → action: create_board, board_name: X
- "List my boards/decks" → action: list_boards
- "Rename board X to Y" → action: rename_board, board_name: X, new_title: Y
- "Archive board X" → action: archive_board, board_name: X
- "Delete board X" → action: delete_board, board_name: X
- "Set up a workflow / pipeline / board for [purpose]" → action: setup_workflow, purpose: [purpose]
IMPORTANT: "board"/"deck" ≠ "card". If the user says "board" or "deck", do NOT classify as card creation.

Stack level:
- "Add a column/list/stack called Y to [board]" → action: create_stack, stack_name: Y, board_name: [board]
- "Rename stack/column Y to Z" → action: rename_stack, stack_name: Y, new_title: Z, board_name: [board]
- "Delete stack/column Y" → action: delete_stack, stack_name: Y, board_name: [board]

Card level:
- "What are my tasks/cards?" → action: list
- "Show me the board" → action: list
- "What's in Doing/Done/Inbox?" → action: list, stack_name: that stack
- "Show me card X / Tell me about card X" → action: get
- "Create a task/card called X" → action: create
- "Add a task X" → action: create
- "Move X to Done" → action: move
- "Mark X as done/complete/finished" → action: move, stack_name: "Done"
- "Start working on X" → action: move, stack_name: "Working"
- "Queue X" → action: move, stack_name: "Queued"
- "Update X description to Y" → action: update, description: Y
- "Set due date of X to Y" → action: update, due_date: Y
- "Rename card X to Y" → action: update, card_title: X, new_title: Y
- "Delete card X / Remove task X" → action: delete
- "Assign X to user Y" → action: assign
- "Label X as urgent" → action: label

If the message describes a high-level goal ("set up a content pipeline") without specifying individual boards/stacks/cards, use action: setup_workflow.

Troubleshooting:
- "I can't see/find/access the board/deck" → action: troubleshoot, board_name: [board if mentioned]
- "The board isn't showing up" → action: troubleshoot
- "Where is my board?" → action: troubleshoot
- "I don't have access to X" → action: troubleshoot, board_name: X
- Any complaint about visibility, permissions, sharing, or access → action: troubleshoot
IMPORTANT: Problem reports ("I can't see X", "X isn't working") are NOT create/list/get actions. They are troubleshoot.

delegated: true if the user is asking you to decide, propose, or use your judgment rather than specifying exact values ("you decide", "whatever makes sense", "propose something", "use your best judgment"). false if they gave explicit names/values.

Message: "${message.substring(0, 400)}"`;

    const params = await this._extractJSON(message, extractionPrompt, DECK_SCHEMA);

    if (!params) {
      const err = new Error('Could not extract deck parameters');
      err.code = 'DOMAIN_ESCALATE';
      throw err;
    }

    // Attach raw message and context for delegation intelligence
    params._rawMessage = message;
    params._agentKnowledge = (context && context.warmMemory) || '';

    // Compound actions are always delegated — the user delegated the entire
    // multi-step flow, so the agent should decide titles, boards, etc.
    if (context?.compoundAction) {
      params.delegated = true;
    }

    if (params.requires_clarification && !context?.compoundAction) {
      const missingFields = Array.isArray(params.missing_fields) && params.missing_fields.length > 0
        ? params.missing_fields
        : ['details'];
      return {
        response: `Could you clarify: ${missingFields.join(', ')}?`,
        pendingClarification: {
          executor: 'deck', action: params.action || 'list',
          missingFields,
          collectedFields: {
            card_title: params.card_title, board_name: params.board_name,
            stack_name: params.stack_name, description: params.description
          },
          originalMessage: message,
        }
      };
    }

    switch (params.action) {
      // Board-level operations
      case 'create_board':    return this._executeCreateBoard(params, context);
      case 'list_boards':     return this._executeListBoards(params, context);
      case 'rename_board':    return this._executeRenameBoard(params, context);
      case 'archive_board':   return this._executeArchiveBoard(params, context);
      case 'delete_board':    return this._executeDeleteBoard(params, context);
      // Stack-level operations
      case 'create_stack':    return this._executeCreateStack(params, context);
      case 'rename_stack':    return this._executeRenameStack(params, context);
      case 'delete_stack':    return this._executeDeleteStack(params, context);
      // Compound operations
      case 'setup_workflow':  return this._executeSetupWorkflow(params, context);
      // Troubleshooting
      case 'troubleshoot':    return this._executeTroubleshoot(params, context);
      // Card-level operations (existing)
      case 'create': return this._executeCreate(params, context);
      case 'move':   return this._executeMove(params, context);
      case 'update': return this._executeUpdate(params, context);
      case 'delete': return this._executeDelete(params, context);
      case 'get':    return this._executeGet(params, context);
      case 'assign': return this._executeAssign(params, context);
      case 'label':  return this._executeLabel(params, context);
      case 'list':
      default:       return this._executeList(params, context);
    }
  }

  // ============================================================
  // Board-level operations (v2)
  // ============================================================

  /**
   * Create a new board.
   * @private
   */
  async _executeCreateBoard(params, context) {
    if (!this.deckClient) {
      return { response: 'Board management is not available.' };
    }

    let name = params.board_name;
    if (!name) {
      if (params.delegated) {
        name = await this._generateDefaultBoardName(params._rawMessage, params._agentKnowledge);
        this.logger.info(`[DeckExec] Generated board name: "${name}"`);
      } else {
        return { response: 'What should the board be called?' };
      }
    }

    const board = await this.deckClient.createNewBoard(name, params.color || '0800fd');
    await this._shareBoardWithAdmin(board.id, board.title);

    this._logActivity('deck_create_board',
      `Created board: ${board.title}`,
      { boardId: board.id, title: board.title },
      context
    );

    return {
      response: `Created board ${this._deckLink(board.title, this._deckUrl('board', board.id))}. It's empty — would you like me to add some stacks (columns) to organize it?`,
      actionRecord: { type: 'deck_create_board', refs: { boardId: board.id, title: board.title } }
    };
  }

  /**
   * List all boards.
   * @private
   */
  async _executeListBoards(params, context) {
    if (!this.deckClient) {
      return { response: 'Board management is not available.' };
    }

    const boards = await this.deckClient.listBoards();
    const active = boards.filter(b => !b.archived);

    if (active.length === 0) {
      return { response: "You don't have any boards yet. Want me to create one?" };
    }

    const list = active.map(b => `- **${b.title}**`).join('\n');

    this._logActivity('deck_list_boards', `Listed ${active.length} boards`, {}, context);

    return {
      response: `Your boards:\n${list}`,
      actionRecord: { type: 'deck_list_boards', refs: { count: active.length } }
    };
  }

  /**
   * Rename a board.
   * @private
   */
  async _executeRenameBoard(params, context) {
    if (!this.deckClient) {
      return { response: 'Board management is not available.' };
    }

    const board = await this._resolveBoard(params.board_name);
    if (!board) {
      return { response: params.board_name
        ? `Could not find a board matching "${params.board_name}".`
        : 'Which board should I rename?' };
    }

    if (!params.new_title) {
      return { response: `What should I rename "${board.title}" to?` };
    }

    const updated = await this.deckClient.updateBoard(board.id, { title: params.new_title });

    this._logActivity('deck_rename_board',
      `Renamed board: "${board.title}" → "${params.new_title}"`,
      { boardId: board.id, oldTitle: board.title, newTitle: params.new_title },
      context
    );

    return {
      response: `Renamed board "${board.title}" to "${updated.title}".`,
      actionRecord: { type: 'deck_rename_board', refs: { boardId: board.id, title: updated.title } }
    };
  }

  /**
   * Archive a board (soft delete).
   * @private
   */
  async _executeArchiveBoard(params, context) {
    if (!this.deckClient) {
      return { response: 'Board management is not available.' };
    }

    const board = await this._resolveBoard(params.board_name);
    if (!board) {
      return { response: params.board_name
        ? `Could not find a board matching "${params.board_name}".`
        : 'Which board should I archive?' };
    }

    await this.deckClient.archiveBoard(board.id);

    this._logActivity('deck_archive_board',
      `Archived board: ${board.title}`,
      { boardId: board.id, title: board.title },
      context
    );

    return {
      response: `Archived board "${board.title}". It can be restored later.`,
      actionRecord: { type: 'deck_archive_board', refs: { boardId: board.id, title: board.title } }
    };
  }

  /**
   * Delete a board (destructive — requires confirmation via response).
   * @private
   */
  async _executeDeleteBoard(params, context) {
    if (!this.deckClient) {
      return { response: 'Board management is not available.' };
    }

    const board = await this._resolveBoard(params.board_name);
    if (!board) {
      return { response: params.board_name
        ? `Could not find a board matching "${params.board_name}".`
        : 'Which board should I delete?' };
    }

    const guardResult = await this._checkGuardrails('deck_delete_board', {
      board: board.title
    }, context.roomToken || null);
    if (!guardResult.allowed) {
      return { response: `Action blocked: ${guardResult.reason}` };
    }

    let cardCount = 0;
    let stackCount = 0;
    try {
      const stacks = await this.deckClient.getStacks(board.id);
      stackCount = stacks.length;
      cardCount = stacks.reduce((sum, s) => sum + (s.cards ? s.cards.length : 0), 0);
    } catch (err) {
      this.logger.warn(`[DeckExec] Could not count board contents: ${err.message}`);
    }

    await this.deckClient.deleteBoard(board.id);

    this._logActivity('deck_delete_board',
      `Deleted board: ${board.title} (${stackCount} stacks, ${cardCount} cards)`,
      { boardId: board.id, title: board.title, stackCount, cardCount },
      context
    );

    return {
      response: `Deleted board "${board.title}" with ${stackCount} stacks and ${cardCount} cards.`,
      actionRecord: { type: 'deck_delete_board', refs: { boardId: board.id, title: board.title } }
    };
  }

  // ============================================================
  // Stack-level operations (v2)
  // ============================================================

  /**
   * Create a stack on a board.
   * @private
   */
  async _executeCreateStack(params, context) {
    if (!this.deckClient) {
      return { response: 'Board management is not available.' };
    }

    const board = await this._resolveBoard(params.board_name);
    if (!board) {
      return { response: params.board_name
        ? `Could not find a board matching "${params.board_name}".`
        : 'Which board should I add this stack to?' };
    }

    if (!params.stack_name) {
      return { response: 'What should the stack (column) be called?' };
    }

    const stack = await this.deckClient.createStack(board.id, params.stack_name);

    this._logActivity('deck_create_stack',
      `Created stack "${params.stack_name}" on "${board.title}"`,
      { boardId: board.id, stackId: stack.id, title: params.stack_name },
      context
    );

    return {
      response: `Added stack "${stack.title}" to board ${this._deckLink(board.title, this._deckUrl('board', board.id))}.`,
      actionRecord: { type: 'deck_create_stack', refs: { boardId: board.id, stackId: stack.id, title: stack.title } }
    };
  }

  /**
   * Rename a stack.
   * @private
   */
  async _executeRenameStack(params, context) {
    if (!this.deckClient) {
      return { response: 'Board management is not available.' };
    }

    const board = await this._resolveBoard(params.board_name);
    if (!board) {
      return { response: params.board_name
        ? `Could not find a board matching "${params.board_name}".`
        : 'Which board is the stack on?' };
    }

    const stack = await this._resolveStack(board.id, params.stack_name);
    if (!stack) {
      return { response: params.stack_name
        ? `Could not find a stack matching "${params.stack_name}" on "${board.title}".`
        : 'Which stack should I rename?' };
    }

    if (!params.new_title) {
      return { response: `What should I rename "${stack.title}" to?` };
    }

    const updated = await this.deckClient.updateStack(board.id, stack.id, { title: params.new_title });

    this._logActivity('deck_rename_stack',
      `Renamed stack: "${stack.title}" → "${params.new_title}" on "${board.title}"`,
      { boardId: board.id, stackId: stack.id, oldTitle: stack.title, newTitle: params.new_title },
      context
    );

    return {
      response: `Renamed stack "${stack.title}" to "${updated.title}" on "${board.title}".`,
      actionRecord: { type: 'deck_rename_stack', refs: { boardId: board.id, stackId: stack.id, title: updated.title } }
    };
  }

  /**
   * Delete a stack (destructive — destroys all cards in it).
   * @private
   */
  async _executeDeleteStack(params, context) {
    if (!this.deckClient) {
      return { response: 'Board management is not available.' };
    }

    const board = await this._resolveBoard(params.board_name);
    if (!board) {
      return { response: params.board_name
        ? `Could not find a board matching "${params.board_name}".`
        : 'Which board is the stack on?' };
    }

    const stack = await this._resolveStack(board.id, params.stack_name);
    if (!stack) {
      return { response: params.stack_name
        ? `Could not find a stack matching "${params.stack_name}" on "${board.title}".`
        : 'Which stack should I delete?' };
    }

    const guardResult = await this._checkGuardrails('deck_delete_stack', {
      board: board.title, stack: stack.title
    }, context.roomToken || null);
    if (!guardResult.allowed) {
      return { response: `Action blocked: ${guardResult.reason}` };
    }

    const cardCount = stack.cards ? stack.cards.length : 0;

    await this.deckClient.deleteStack(board.id, stack.id);

    this._logActivity('deck_delete_stack',
      `Deleted stack "${stack.title}" from "${board.title}" (${cardCount} cards)`,
      { boardId: board.id, stackId: stack.id, title: stack.title, cardCount },
      context
    );

    return {
      response: `Deleted stack "${stack.title}" from "${board.title}" (${cardCount} cards removed).`,
      actionRecord: { type: 'deck_delete_stack', refs: { boardId: board.id, stackId: stack.id, title: stack.title } }
    };
  }

  // ============================================================
  // Compound operations (v2)
  // ============================================================

  /**
   * Set up a complete workflow: board + stacks + optional starter cards.
   * Uses LLM to generate a plan, then executes it sequentially.
   * @private
   */
  async _executeSetupWorkflow(params, context) {
    if (!this.deckClient) {
      return { response: 'Board management is not available.' };
    }

    const purpose = params.purpose || params.board_name || 'New Workflow';
    const agentKnowledge = params._agentKnowledge || '';

    const plan = await this._generateWorkflowPlan(purpose, params._rawMessage, agentKnowledge);
    if (!plan || !plan.board_name || !Array.isArray(plan.stacks)) {
      return { response: 'Could not generate a workflow plan. Could you describe what you need in more detail?' };
    }

    const result = await this._executePlan(plan);

    this._logActivity('deck_setup_workflow',
      `Set up workflow: ${plan.board_name} (${result.stacks.length} stacks, ${result.cards.length} cards)`,
      { boardId: result.board.id, title: result.board.title, stackCount: result.stacks.length, cardCount: result.cards.length },
      context
    );

    return this._formatWorkflowResult(result, plan);
  }

  /**
   * Generate a workflow plan using LLM.
   * @param {string} purpose - What the workflow is for
   * @param {string} message - Original user message
   * @param {string} agentKnowledge - Enricher context
   * @returns {Promise<Object>} { board_name, stacks: [{ title, cards: [{ title, description }] }] }
   * @private
   */
  async _generateWorkflowPlan(purpose, message, agentKnowledge) {
    const prompt = `You are designing a task board workflow.

Purpose: "${purpose}"
User's request: "${message}"

${agentKnowledge ? `Context from your knowledge base:\n${agentKnowledge}\n` : ''}

Generate a workflow as JSON. Be practical — 3-5 stacks, 2-4 starter cards per stack where appropriate.
Not every stack needs starter cards. Later stages (Review, Published) are usually empty at creation.

Respond ONLY with JSON, no markdown, no explanation:
{
  "board_name": "descriptive board name",
  "stacks": [
    {
      "title": "stack name",
      "cards": [
        { "title": "card title", "description": "1-2 sentence description" }
      ]
    }
  ]
}`;

    const result = await this.router.route({
      job: 'tools',
      content: prompt,
      requirements: { maxTokens: 800, temperature: 0 }
    });

    const raw = (result.result || '').trim()
      .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    try {
      return JSON.parse(raw);
    } catch (err) {
      this.logger.warn(`[DeckExec] Workflow plan parse failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Execute a workflow plan: create board → stacks → cards sequentially.
   * @param {Object} plan - { board_name, stacks: [...] }
   * @returns {Promise<Object>} { board, stacks: [], cards: [] }
   * @private
   */
  async _executePlan(plan) {
    const result = { board: null, stacks: [], cards: [] };

    result.board = await this.deckClient.createNewBoard(plan.board_name);
    this.logger.info(`[DeckExec] Created board "${plan.board_name}" (${result.board.id})`);
    await this._shareBoardWithAdmin(result.board.id, plan.board_name);

    for (let i = 0; i < plan.stacks.length; i++) {
      const stackPlan = plan.stacks[i];

      try {
        const stack = await this.deckClient.createStack(result.board.id, stackPlan.title, i);
        result.stacks.push(stack);
        this.logger.info(`[DeckExec] Created stack "${stackPlan.title}" (${stack.id})`);

        for (const cardPlan of (stackPlan.cards || [])) {
          try {
            const card = await this.deckClient.createCardOnBoard(
              result.board.id,
              stack.id,
              cardPlan.title,
              { description: cardPlan.description || '' }
            );
            result.cards.push({ ...card, stackTitle: stackPlan.title });
          } catch (err) {
            this.logger.warn(`[DeckExec] Card creation failed in ${stackPlan.title}: ${err.message}`);
          }
        }
      } catch (err) {
        this.logger.warn(`[DeckExec] Stack creation failed: ${stackPlan.title}: ${err.message}`);
      }
    }

    return result;
  }

  /**
   * Format workflow execution result into user-facing response.
   * @param {Object} result - { board, stacks, cards }
   * @param {Object} plan - Original plan for comparison
   * @returns {Object} { response, actionRecord }
   * @private
   */
  _formatWorkflowResult(result, plan) {
    const stackSummary = result.stacks.map(s => s.title).join(' → ');
    const cardCount = result.cards.length;

    const boardLink = this._deckLink(`**${result.board.title}**`, this._deckUrl('board', result.board.id));
    let response = `Set up board ${boardLink} with ${result.stacks.length} stages:\n\n`;
    response += `${stackSummary}\n\n`;

    if (cardCount > 0) {
      response += `Added ${cardCount} starter cards:\n`;
      for (const card of result.cards) {
        const cardLink = card.id ? this._deckLink(card.title, this._deckUrl('card', card.id)) : `"${card.title}"`;
        response += `- ${cardLink} in ${card.stackTitle}\n`;
      }
      response += '\n';
    }

    if (result.stacks.length < plan.stacks.length) {
      response += `\n${plan.stacks.length - result.stacks.length} stacks couldn't be created. You may need to add them manually.\n`;
    }

    response += 'The board is ready. Want me to add more cards or adjust the workflow?';

    return {
      response,
      actionRecord: {
        type: 'deck_setup_workflow',
        refs: {
          boardId: result.board.id,
          title: result.board.title,
          stackCount: result.stacks.length,
          cardCount: result.cards.length
        }
      }
    };
  }

  // ============================================================
  // Troubleshooting (v2)
  // ============================================================

  /**
   * Handle access/visibility complaints by checking board existence and sharing.
   * "I can't see the board" → check if board exists, try to share with user.
   * @private
   */
  async _executeTroubleshoot(params, context) {
    if (!this.deckClient) {
      return { response: 'Board management is not available.' };
    }

    const boards = await this.deckClient.listBoards();
    const activeBoards = boards.filter(b => !b.archived);

    // If a specific board was mentioned, try to find and share it
    if (params.board_name) {
      const board = await this._resolveBoard(params.board_name);
      if (!board) {
        const suggestions = activeBoards.length > 0
          ? `\n\nBoards I can see:\n${activeBoards.map(b => `- ${b.title}`).join('\n')}`
          : '';
        return {
          response: `I couldn't find a board matching "${params.board_name}".${suggestions}`,
          actionRecord: { type: 'deck_troubleshoot', refs: { query: params.board_name, found: false } }
        };
      }

      // Board exists — try sharing with the user
      const userName = context.userName || this.adminUser;
      if (userName) {
        try {
          await this.deckClient.shareBoardWithUser(board.id, userName);
          this.logger.info(`[DeckExec] Troubleshoot: shared "${board.title}" with ${userName}`);

          this._logActivity('deck_troubleshoot',
            `Shared board "${board.title}" with ${userName} (access fix)`,
            { boardId: board.id, title: board.title, sharedWith: userName },
            context
          );

          return {
            response: `Found board "${board.title}" — I've shared it with you. It should appear in your Deck app now. Try refreshing the page.`,
            actionRecord: { type: 'deck_troubleshoot', refs: { boardId: board.id, title: board.title, shared: true } }
          };
        } catch (err) {
          // 400 = already shared
          if (err.message && err.message.includes('400')) {
            return {
              response: `Board "${board.title}" exists and is already shared with you. Try refreshing your Deck app — if it still doesn't appear, it may be a Nextcloud caching issue.`,
              actionRecord: { type: 'deck_troubleshoot', refs: { boardId: board.id, title: board.title, alreadyShared: true } }
            };
          }
          this.logger.warn(`[DeckExec] Troubleshoot share failed: ${err.message}`);
          return {
            response: `Board "${board.title}" exists (ID ${board.id}) but I couldn't update the sharing settings: ${err.message}. You may need to check permissions in the Deck app.`,
            actionRecord: { type: 'deck_troubleshoot', refs: { boardId: board.id, error: err.message } }
          };
        }
      }

      return {
        response: `Board "${board.title}" exists (ID ${board.id}). If you can't see it, it may not be shared with your account. Let me know your Nextcloud username and I'll fix the sharing.`,
        actionRecord: { type: 'deck_troubleshoot', refs: { boardId: board.id, title: board.title } }
      };
    }

    // No specific board mentioned — list what's available
    if (activeBoards.length === 0) {
      return {
        response: "There aren't any boards yet. Want me to create one?",
        actionRecord: { type: 'deck_troubleshoot', refs: { boardCount: 0 } }
      };
    }

    // Share all boards with user as a fix
    const userName = context.userName || this.adminUser;
    let sharedCount = 0;
    if (userName) {
      for (const board of activeBoards) {
        try {
          await this.deckClient.shareBoardWithUser(board.id, userName);
          sharedCount++;
        } catch (_err) { /* already shared or permission issue — skip */ }
      }
    }

    const list = activeBoards.map(b => `- **${b.title}**`).join('\n');
    const shareMsg = sharedCount > 0
      ? `\n\nI've updated the sharing on ${sharedCount} board(s) — try refreshing your Deck app.`
      : '';

    this._logActivity('deck_troubleshoot',
      `Troubleshoot: listed ${activeBoards.length} boards, shared ${sharedCount}`,
      { boardCount: activeBoards.length, sharedCount },
      context
    );

    return {
      response: `Here are the boards I have:\n${list}${shareMsg}\n\nIf a specific board isn't showing up, let me know which one.`,
      actionRecord: { type: 'deck_troubleshoot', refs: { boardCount: activeBoards.length, sharedCount } }
    };
  }

  // ============================================================
  // Board/Stack resolution (v2)
  // ============================================================

  /**
   * Resolve a board by name (fuzzy match).
   * @param {string} boardName
   * @returns {Promise<Object|null>} Board object or null
   * @private
   */
  async _shareBoardWithAdmin(boardId, boardTitle) {
    if (!this.adminUser || !this.deckClient) return;
    try {
      await this.deckClient.shareBoardWithUser(boardId, this.adminUser);
      this.logger.info(`[DeckExec] Shared board "${boardTitle}" (${boardId}) with ${this.adminUser}`);
    } catch (err) {
      this.logger.warn(`[DeckExec] Board share failed for "${boardTitle}": ${err.message}`);
    }
  }

  async _resolveBoard(boardName) {
    if (!boardName || !this.deckClient) return null;

    const boards = await this.deckClient.listBoards();
    const query = boardName.toLowerCase();

    const exact = boards.find(b => b.title.toLowerCase() === query);
    if (exact) return exact;

    const fuzzy = boards.find(b =>
      b.title.toLowerCase().includes(query) ||
      query.includes(b.title.toLowerCase())
    );
    return fuzzy || null;
  }

  /**
   * Resolve a stack by name on a given board.
   * @param {number} boardId
   * @param {string} stackName
   * @returns {Promise<Object|null>} Stack object or null
   * @private
   */
  async _resolveStack(boardId, stackName) {
    if (!stackName || !this.deckClient) return null;

    const stacks = await this.deckClient.getStacks(boardId);
    const query = stackName.toLowerCase();

    return stacks.find(s => s.title.toLowerCase() === query) ||
           stacks.find(s => s.title.toLowerCase().includes(query)) ||
           null;
  }

  // ============================================================
  // Delegation intelligence (v2)
  // ============================================================

  /**
   * Generate a board name from the user's intent using LLM.
   * @param {string} message - User message
   * @param {string} agentKnowledge - Enricher context
   * @returns {Promise<string>} Generated board name
   * @private
   */
  async _generateDefaultBoardName(message, agentKnowledge) {
    const prompt = `The user wants to create a task board. Their message: "${message}"
${agentKnowledge ? `Context:\n${agentKnowledge}\n` : ''}
Generate a short, clear board name (2-4 words). Examples:
- "content pipeline for my blog" → "Blog Content Pipeline"
- "track the moltagent launch" → "Moltagent Launch"

Respond with ONLY the board name, nothing else.`;

    const result = await this.router.route({
      job: 'tools',
      content: prompt,
      requirements: { maxTokens: 30, temperature: 0 }
    });

    return (result.result || 'New Board').trim().replace(/["']/g, '');
  }

  /**
   * Generate a card title from conversational context.
   * @param {string} message
   * @param {string} stackName
   * @param {string} agentKnowledge
   * @returns {Promise<string>}
   * @private
   */
  async _generateDefaultCardTitle(message, stackName, agentKnowledge) {
    const prompt = `The user wants to create a task card.
Their message: "${message}"
${stackName ? `Target column: "${stackName}"` : ''}
${agentKnowledge ? `Context:\n${agentKnowledge}` : ''}

Generate a clear, actionable card title (3-8 words).
Respond with ONLY the title, nothing else.`;

    const result = await this.router.route({
      job: 'tools',
      content: prompt,
      requirements: { maxTokens: 30, temperature: 0 }
    });

    return (result.result || 'New Task').trim().replace(/["']/g, '');
  }

  /**
   * Override BaseExecutor._generateDefaultValue for Deck-specific fields.
   * @param {string} fieldName
   * @param {Object} collectedFields
   * @param {string} originalMessage
   * @returns {string|null}
   */
  _generateDefaultValue(fieldName, collectedFields, originalMessage) {
    if (fieldName === 'board_name') {
      return `Board-${Date.now()}`;
    }
    if (fieldName === 'card_title') {
      return 'New Task';
    }
    if (fieldName === 'stack_name') {
      return DECK.stacks.inbox;
    }
    return null;
  }

  // ============================================================
  // Card-level operations (v1 — unchanged)
  // ============================================================

  /**
   * List cards on a board (read-only, safe default).
   * @private
   */
  async _executeList(params, context) {
    const toolArgs = {};
    if (params.board_name) toolArgs.board = params.board_name;
    if (params.stack_name) toolArgs.stack = this._normalizeStackName(params.stack_name);

    const result = await this.toolRegistry.execute('deck_list_cards', toolArgs);

    if (!result.success) {
      return { response: result.error || 'Could not list cards.' };
    }

    this._logActivity('deck_list',
      `Listed cards${params.board_name ? ` on "${params.board_name}"` : ''}`,
      { board: params.board_name || 'default', stack: params.stack_name },
      context
    );

    return {
      response: result.result || 'No cards found.',
      actionRecord: { type: 'deck_list', refs: { board: params.board_name || 'default' } }
    };
  }

  /**
   * Get a single card's full details.
   * @private
   */
  async _executeGet(params, context) {
    if (!params.card_title) {
      return { response: 'Which card should I look up?' };
    }

    const result = await this.toolRegistry.execute('deck_get_card', {
      card: params.card_title
    });

    if (!result.success) {
      return { response: result.error || `Could not find card "${params.card_title}".` };
    }

    this._logActivity('deck_get',
      `Viewed card: ${params.card_title}`,
      { card: params.card_title },
      context
    );

    return {
      response: result.result,
      actionRecord: { type: 'deck_get', refs: { card: params.card_title } }
    };
  }

  /**
   * Create a new card with optional description, due date, and assignee.
   * Supports delegation intelligence: if card_title is missing and user delegated,
   * generates a title from context instead of asking for clarification.
   * @private
   */
  async _executeCreate(params, context) {
    // Title intelligence: generate a meaningful title when the extracted title
    // is missing OR is a vague reference ("these results", "that info", "it", etc).
    // The LLM extracts card_title from the user's words, but compound actions often
    // contain pronouns referencing earlier conversation, not actionable titles.
    const isVagueTitle = params.card_title &&
      /^(these|those|the|that|this|it|my|some|your)\b/i.test(params.card_title.trim()) &&
      params.card_title.trim().split(/\s+/).length <= 4;
    if (!params.card_title || isVagueTitle) {
      if (params.delegated || isVagueTitle) {
        params.card_title = await this._generateDefaultCardTitle(
          params._rawMessage,
          params.stack_name,
          params._agentKnowledge
        );
        this.logger.info(`[DeckExec] Generated card title: "${params.card_title}"`);
      } else {
        return { response: 'What should the card be called?' };
      }
    }

    const guardResult = await this._checkGuardrails('deck_create_card', {
      title: params.card_title
    }, context.roomToken || null);

    if (!guardResult.allowed) {
      return { response: `Action blocked: ${guardResult.reason}` };
    }

    const toolArgs = { title: params.card_title };
    // Probe findings replace the LLM's compressed description at creation time.
    // The LLM picks the title. The code writes the content. One API call.
    if (context?.probeFindings && context.probeFindings.length > (params.description?.length || 0)) {
      toolArgs.description = context.probeFindings.substring(0, 8000);
    } else if (params.description) {
      toolArgs.description = params.description;
    }
    if (params.stack_name) toolArgs.stack = this._normalizeStackName(params.stack_name);
    const targetBoard = this._resolveTargetBoard(params, context);
    if (targetBoard) toolArgs.board = targetBoard;

    // Living Context fallback: if description is thin, enrich from conversation
    if ((!toolArgs.description || toolArgs.description.length < 50) && context?.getRecentContext) {
      try {
        const recentMessages = context.getRecentContext();
        if (Array.isArray(recentMessages)) {
          const lastAssistant = [...recentMessages].reverse().find(m => m.role === 'assistant');
          if (lastAssistant?.content && lastAssistant.content.length > 50) {
            const findings = lastAssistant.content.substring(0, 2000);
            toolArgs.description = toolArgs.description
              ? `${toolArgs.description}\n\n---\n\n${findings}`
              : findings;
          }
        }
      } catch (err) {
        this.logger.warn(`[DeckExec] Living Context enrichment failed: ${err.message}`);
      }
    }

    const result = await this.toolRegistry.execute('deck_create_card', toolArgs);

    if (!result.success) {
      return { response: `Could not create card: ${result.error || 'unknown error'}` };
    }

    // Structured card data flows to all downstream consumers — no regex on response text
    const card = result.card || null;
    const cardId = card?.id ? String(card.id) : null;
    const stackName = (toolArgs.stack || 'inbox').toLowerCase();

    if (params.due_date && cardId) {
      try {
        const resolved = this._resolveDate(params.due_date) || params.due_date;
        await this.toolRegistry.execute('deck_set_due_date', {
          card: `#${cardId}`,
          duedate: resolved
        });
      } catch (err) {
        this.logger.warn(`[DeckExecutor] Due-date follow-up failed: ${err.message}`);
      }
    }

    if (params.assignee && cardId) {
      try {
        await this.toolRegistry.execute('deck_assign_user', {
          card: `#${cardId}`,
          user: params.assignee
        });
      } catch (err) {
        this.logger.warn(`[DeckExecutor] Assign follow-up failed: ${err.message}`);
      }
    }

    // Auto-assign requesting user if no explicit assignee was specified
    if (!params.assignee && context?.userName && cardId) {
      const userId = context.userName;
      if (!/^moltagent$/i.test(userId)) {
        try {
          await this.toolRegistry.execute('deck_assign_user', {
            card: `#${cardId}`,
            user: userId
          });
        } catch (err) {
          this.logger.warn(`[DeckExec] Auto-assign ${userId} failed: ${err.message}`);
        }
      }
    }

    // Compound actions with findings: mark the card as done — the content is
    // complete, the DeckTaskProcessor only needs to deliver it (move to Review,
    // assign user, notify). No re-synthesis needed.
    if (context?.compoundAction && context?.probeFindings && cardId && this.deckClient) {
      try {
        await this.deckClient.markCardDone(cardId, stackName);
        this.logger.info(`[DeckExec] Compound card #${cardId} marked done — ready for delivery`);
      } catch (err) {
        this.logger.warn(`[DeckExec] Could not mark card done: ${err.message}`);
      }
    }

    this._logActivity('deck_create',
      `Created card: ${params.card_title}`,
      { card: params.card_title, stack: params.stack_name, board: params.board_name },
      context
    );

    return {
      response: result.result,
      card,
      actionRecord: {
        type: 'deck_create',
        refs: {
          card: params.card_title,
          cardId,
          board: toolArgs.board || null,
          stack: toolArgs.stack || DECK.stacks.inbox
        }
      }
    };
  }

  /**
   * Move a card to a different stack.
   * @private
   */
  async _executeMove(params, context) {
    if (!params.card_title) {
      return { response: 'Which card should I move?' };
    }
    // Resolve card reference from context (handles "that", "it", etc.)
    params.card_title = await this._resolveCardReference(params.card_title, context);
    if (!params.stack_name) {
      return { response: `Where should I move "${params.card_title}"? Name a stack (e.g., Doing, Done, Inbox).` };
    }

    const targetStack = this._normalizeStackName(params.stack_name);

    const result = await this.toolRegistry.execute('deck_move_card', {
      card: params.card_title,
      target_stack: targetStack
    });

    if (!result.success) {
      return { response: result.error || `Could not move card: unknown error` };
    }

    this._logActivity('deck_move',
      `Moved card: ${params.card_title} → ${targetStack}`,
      { card: params.card_title, target: targetStack },
      context
    );

    return {
      response: result.result,
      actionRecord: { type: 'deck_move', refs: { card: params.card_title, target: targetStack } }
    };
  }

  /**
   * Update a card's title, description, or due date.
   * @private
   */
  async _executeUpdate(params, context) {
    if (!params.card_title) {
      return { response: 'Which card should I update?' };
    }
    params.card_title = await this._resolveCardReference(params.card_title, context);

    const toolArgs = { card: params.card_title };
    let hasUpdate = false;

    if (params.new_title) {
      toolArgs.title = params.new_title;
      hasUpdate = true;
    }
    if (params.description !== undefined && params.description !== '') {
      toolArgs.description = params.description;
      hasUpdate = true;
    }
    if (params.due_date) {
      toolArgs.duedate = this._resolveDate(params.due_date) || params.due_date;
      hasUpdate = true;
    }

    if (!hasUpdate) {
      return { response: `What should I update on "${params.card_title}"? I can change the title, description, or due date.` };
    }

    const result = await this.toolRegistry.execute('deck_update_card', toolArgs);

    if (!result.success) {
      return { response: result.error || `Could not update card: unknown error` };
    }

    this._logActivity('deck_update',
      `Updated card: ${params.card_title}`,
      { card: params.card_title },
      context
    );

    return {
      response: result.result,
      actionRecord: { type: 'deck_update', refs: { card: params.card_title } }
    };
  }

  /**
   * Delete a card (destructive — guardrails apply).
   * @private
   */
  async _executeDelete(params, context) {
    if (!params.card_title) {
      return { response: 'Which card should I delete?' };
    }
    params.card_title = await this._resolveCardReference(params.card_title, context);

    const guardResult = await this._checkGuardrails('deck_delete_card', {
      card: params.card_title
    }, context.roomToken || null);

    if (!guardResult.allowed) {
      return { response: `Action blocked: ${guardResult.reason}` };
    }

    const result = await this.toolRegistry.execute('deck_delete_card', {
      card: params.card_title
    });

    if (!result.success) {
      return { response: result.error || `Could not delete card: unknown error` };
    }

    this._logActivity('deck_delete',
      `Deleted card: ${params.card_title}`,
      { card: params.card_title },
      context
    );

    return {
      response: result.result,
      actionRecord: { type: 'deck_delete', refs: { card: params.card_title } }
    };
  }

  /**
   * Assign a user to a card.
   * @private
   */
  async _executeAssign(params, context) {
    if (!params.card_title) {
      return { response: 'Which card should I assign?' };
    }
    params.card_title = await this._resolveCardReference(params.card_title, context);
    if (!params.assignee) {
      return { response: `Who should I assign to "${params.card_title}"?` };
    }

    const result = await this.toolRegistry.execute('deck_assign_user', {
      card: params.card_title,
      user: params.assignee
    });

    if (!result.success) {
      return { response: result.error || `Could not assign user: unknown error` };
    }

    this._logActivity('deck_assign',
      `Assigned ${params.assignee} to: ${params.card_title}`,
      { card: params.card_title, user: params.assignee },
      context
    );

    return {
      response: result.result,
      actionRecord: { type: 'deck_assign', refs: { card: params.card_title, user: params.assignee } }
    };
  }

  /**
   * Add a label to a card.
   * @private
   */
  async _executeLabel(params, context) {
    if (!params.card_title) {
      return { response: 'Which card should I label?' };
    }
    if (!params.label_name) {
      return { response: `What label should I add to "${params.card_title}"?` };
    }

    const result = await this.toolRegistry.execute('deck_add_label', {
      card: params.card_title,
      label: params.label_name
    });

    if (!result.success) {
      return { response: result.error || `Could not add label: unknown error` };
    }

    this._logActivity('deck_label',
      `Labeled "${params.card_title}" as ${params.label_name}`,
      { card: params.card_title, label: params.label_name },
      context
    );

    return {
      response: result.result,
      actionRecord: { type: 'deck_label', refs: { card: params.card_title, label: params.label_name } }
    };
  }

  /**
   * Resolve a card reference that might be a pronoun ("that", "it"),
   * partial reference ("the stale card"), or shorthand.
   *
   * Resolution order:
   *   1. If reference looks like an explicit card identifier (title or #ID), return as-is
   *   2. Check recent actions in context for a single recently-referenced card
   *   3. Check recent conversation context for card titles mentioned by the assistant
   *   4. Fall through to original reference (let toolRegistry attempt fuzzy match)
   *
   * @param {string} reference - Raw card reference from user
   * @param {Object} context - Execution context with getRecentActions, getRecentContext
   * @returns {Promise<string>} Resolved card title or ID
   * @private
   */
  async _resolveCardReference(reference, context) {
    // Short references are likely pronouns or implicit references
    const isShortRef = /^(that|it|this|the card|the task|that one|this one|the first one|the stale card|the one)$/i.test((reference || '').trim());

    if (!isShortRef) return reference; // Looks like an explicit title/ID — use as-is

    // Check ActionLedger for recently referenced cards
    if (context?.getRecentActions) {
      try {
        const recentActions = context.getRecentActions('deck');
        if (Array.isArray(recentActions) && recentActions.length > 0) {
          // Find the most recent deck action with a card reference
          for (let i = recentActions.length - 1; i >= 0; i--) {
            const action = recentActions[i];
            if (action.refs?.cardId) return `#${action.refs.cardId}`;
            if (action.refs?.card) return action.refs.card;
          }
        }
      } catch (err) {
        // ActionLedger not available — continue to next resolver
      }
    }

    // Check recent conversation context for card titles in assistant messages
    if (context?.getRecentContext) {
      try {
        const recentMessages = context.getRecentContext();
        if (Array.isArray(recentMessages)) {
          const assistantMsgs = recentMessages.filter(m => m.role === 'assistant');
          for (let i = assistantMsgs.length - 1; i >= 0; i--) {
            const content = assistantMsgs[i].content || '';
            // Match card titles in notification format: Task "Card Title"
            const titleMatch = content.match(/Task "([^"]+)"/);
            if (titleMatch) return titleMatch[1];
            // Match card creation format: Created [Card Title](url)
            const linkMatch = content.match(/Created \[([^\]]+)\]/);
            if (linkMatch) return linkMatch[1];
          }
        }
      } catch (err) {
        // Context not available — fall through
      }
    }

    // Could not resolve — return original reference for fuzzy matching attempt
    return reference;
  }

  /**
   * Determine the target board for card creation based on context.
   *
   * Priority:
   *   1. Explicit board name from params
   *   2. Default based on source (commitment/proactive → Personal, user request → Moltagent Tasks)
   *
   * @param {Object} params - Tool call parameters
   * @param {Object} context - Execution context
   * @returns {string|undefined} Board name, or undefined for default
   * @private
   */
  _resolveTargetBoard(params, context) {
    // Explicit board name takes priority
    if (params.board_name) return params.board_name;

    // Autonomous agent work → Personal board
    if (context?.source === 'commitment_detector' ||
        context?.source === 'proactive_evaluator' ||
        context?.source === 'freshness_checker') {
      return DECK.boards.personal;
    }

    // User-initiated → default task board (undefined lets toolRegistry use its default)
    return undefined;
  }

  /**
   * Normalize user-friendly stack names to canonical Deck stack names.
   * "completed" → "Done", "in progress" → "Working", etc.
   *
   * @param {string} name - User-provided stack name
   * @returns {string} Canonical stack name
   * @private
   */
  _normalizeStackName(name) {
    if (!name) return DECK.stacks.inbox;
    const normalized = name.toLowerCase().trim();
    return STACK_ALIASES[normalized] || name;
  }
}

module.exports = DeckExecutor;
