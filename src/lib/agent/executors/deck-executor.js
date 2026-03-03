/*
 * MoltAgent - Sovereign AI Security Layer
 * Copyright (C) 2026 MoltAgent Contributors
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
 * - Problem: No structured executor for Deck; falls to raw Qwen tool-calling with 5-tool subset
 * - Pattern: Extract params → route by action → validate → delegate to deck_* tools → confirm
 * - Key Dependencies: BaseExecutor, ToolRegistry (25 deck_* tools handle card/board resolution)
 * - Data Flow: message → extract → action switch → validate → toolRegistry.execute → log → confirm
 *
 * The deck_* tools already handle card/board/stack resolution internally (partial title match,
 * board name lookup, etc.). This executor's value is structured extraction, parameter validation,
 * stack alias normalization, guardrails on destructive ops, and consistent return format.
 *
 * @module agent/executors/deck-executor
 * @version 1.0.0
 */

const BaseExecutor = require('./base-executor');

// Stack name aliases — bridge user language to canonical stack names
const STACK_ALIASES = {
  done: 'Done',
  completed: 'Done',
  finished: 'Done',
  closed: 'Done',
  doing: 'Working',
  'in progress': 'Working',
  working: 'Working',
  active: 'Working',
  inbox: 'Inbox',
  new: 'Inbox',
  backlog: 'Inbox',
  todo: 'Inbox',
  'to do': 'Inbox',
  'to-do': 'Inbox',
  queued: 'Queued',
  planned: 'Queued',
  scheduled: 'Queued',
  upcoming: 'Queued',
  review: 'Review',
  waiting: 'Review',
  blocked: 'Review',
  'on hold': 'Review',
  paused: 'Review'
};

class DeckExecutor extends BaseExecutor {
  /**
   * @param {Object} config - BaseExecutor config + toolRegistry
   * @param {Object} config.toolRegistry - ToolRegistry with deck_* tools
   */
  constructor(config = {}) {
    super(config);
    this.toolRegistry = config.toolRegistry;
  }

  /**
   * Execute a deck operation from a natural language message.
   *
   * @param {string} message - User message
   * @param {Object} context - { userName, roomToken }
   * @returns {Promise<Object>} { response, actionRecord? }
   */
  async execute(message, context) {
    const dateContext = this._dateContext();
    const DECK_SCHEMA = {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'create', 'move', 'update', 'delete', 'assign', 'label'] },
        board_name: { type: 'string' },
        card_title: { type: 'string' },
        stack_name: { type: 'string' },
        description: { type: 'string' },
        due_date: { type: 'string' },
        new_title: { type: 'string' },
        assignee: { type: 'string' },
        label_name: { type: 'string' },
        requires_clarification: { type: 'boolean' },
        missing_fields: { type: 'array', items: { type: 'string' } }
      },
      required: ['action']
    };

    const extractionPrompt = `${dateContext}

Extract task/card board operation parameters from this message.
Leave fields as empty strings if not mentioned. Do NOT guess values.

Action rules:
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

Message: "${message.substring(0, 300)}"`;

    const params = await this._extractJSON(message, extractionPrompt, DECK_SCHEMA);

    if (!params) {
      const err = new Error('Could not extract deck parameters');
      err.code = 'DOMAIN_ESCALATE';
      throw err;
    }

    if (params.requires_clarification) {
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
   * @private
   */
  async _executeCreate(params, context) {
    if (!params.card_title) {
      return { response: 'What should the card be called?' };
    }

    const guardResult = await this._checkGuardrails('deck_create_card', {
      title: params.card_title
    }, context.roomToken || null);

    if (!guardResult.allowed) {
      return { response: `Action blocked: ${guardResult.reason}` };
    }

    const toolArgs = { title: params.card_title };
    if (params.description) toolArgs.description = params.description;
    if (params.stack_name) toolArgs.stack = this._normalizeStackName(params.stack_name);
    if (params.board_name) toolArgs.board = params.board_name;

    const result = await this.toolRegistry.execute('deck_create_card', toolArgs);

    if (!result.success) {
      return { response: `Could not create card: ${result.error || 'unknown error'}` };
    }

    // Follow-up ops (due date, assignee) are fire-and-forget — card is already created
    const cardIdMatch = (result.result || '').match(/#(\d+)/);
    if (params.due_date && cardIdMatch) {
      try {
        const resolved = this._resolveDate(params.due_date) || params.due_date;
        await this.toolRegistry.execute('deck_set_due_date', {
          card: `#${cardIdMatch[1]}`,
          duedate: resolved
        });
      } catch (err) {
        this.logger.warn(`[DeckExecutor] Due-date follow-up failed: ${err.message}`);
      }
    }

    if (params.assignee && cardIdMatch) {
      try {
        await this.toolRegistry.execute('deck_assign_user', {
          card: `#${cardIdMatch[1]}`,
          user: params.assignee
        });
      } catch (err) {
        this.logger.warn(`[DeckExecutor] Assign follow-up failed: ${err.message}`);
      }
    }

    this._logActivity('deck_create',
      `Created card: ${params.card_title}`,
      { card: params.card_title, stack: params.stack_name, board: params.board_name },
      context
    );

    return {
      response: result.result,
      actionRecord: { type: 'deck_create', refs: { card: params.card_title } }
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
   * Normalize user-friendly stack names to canonical Deck stack names.
   * "completed" → "Done", "in progress" → "Working", etc.
   *
   * @param {string} name - User-provided stack name
   * @returns {string} Canonical stack name
   * @private
   */
  _normalizeStackName(name) {
    if (!name) return 'Inbox';
    const normalized = name.toLowerCase().trim();
    return STACK_ALIASES[normalized] || name;
  }
}

module.exports = DeckExecutor;
