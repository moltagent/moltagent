'use strict';

/**
 * ToolRegistry - Agent Tool Definition & Execution Layer
 *
 * Generates tool definitions (JSON schemas) from existing Moltagent clients
 * and dispatches tool calls to real client methods.
 *
 * @module agent/tool-registry
 * @version 1.0.0
 */

class ToolRegistry {
  /**
   * @param {Object} options
   * @param {import('../integrations/deck-client')} [options.deckClient]
   * @param {import('../integrations/caldav-client')} [options.calDAVClient]
   * @param {import('../nc-flow/system-tags').SystemTagsClient} [options.systemTagsClient]
   * @param {import('../nc-request-manager')} [options.ncRequestManager]
   * @param {import('../integrations/nc-files-client').NCFilesClient} [options.ncFilesClient]
   * @param {import('../integrations/nc-search-client').NCSearchClient} [options.ncSearchClient]
   * @param {import('../extraction/text-extractor').TextExtractor} [options.textExtractor]
   * @param {import('../integrations/collectives-client')} [options.collectivesClient]
   * @param {import('../knowledge/learning-log').LearningLog} [options.learningLog]
   * @param {import('../integrations/searxng-client').SearXNGClient} [options.searxngClient]
   * @param {import('../integrations/web-reader').WebReader} [options.webReader]
   * @param {import('../integrations/contacts-client')} [options.contactsClient]
   * @param {import('../integrations/memory-searcher')} [options.memorySearcher]
   * @param {Object} [options.searchAdapters] - Map of commercial search adapters { brave, perplexity, exa }
   * @param {Object} [options.logger]
   */
  constructor({ deckClient, calDAVClient, systemTagsClient, ncRequestManager, ncFilesClient, ncSearchClient, textExtractor, collectivesClient, learningLog, searxngClient, webReader, contactsClient, memorySearcher, searchAdapters, logger }) {
    this.clients = { deckClient, calDAVClient, systemTagsClient, ncRequestManager, ncFilesClient, ncSearchClient, textExtractor, collectivesClient, learningLog, searxngClient, webReader, contactsClient, memorySearcher, searchAdapters };
    this.logger = logger || console;

    /** @type {Map<string, {name: string, description: string, parameters: Object, handler: Function}>} */
    this.tools = new Map();

    this._registerDefaultTools();
  }

  /**
   * Get all tool definitions in OpenAI/Ollama function-calling format.
   * @returns {Array<{type: 'function', function: {name: string, description: string, parameters: Object}}>}
   */
  getToolDefinitions() {
    return Array.from(this.tools.values()).map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters
      }
    }));
  }

  /**
   * Get only workflow-relevant tool definitions (for local/sovereign LLMs).
   * Keeps the prompt small enough for 8B models on CPU.
   */
  getWorkflowToolDefinitions() {
    const allowed = new Set([
      'workflow_deck_move_card',
      'workflow_deck_add_comment',
      'workflow_deck_create_card',
      'workflow_deck_update_card',
      'deck_add_label'
    ]);
    return Array.from(this.tools.values())
      .filter(t => allowed.has(t.name))
      .map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters
        }
      }));
  }

  /**
   * Get workflow tool definitions for cloud providers.
   * Returns a board-appropriate tool subset based on the board context.
   * Keeps tool count low (5-10 instead of 54) to reduce token cost.
   *
   * @param {string} [boardContext=''] - The workflow system addition (board rules, card info)
   * @returns {Array<{type: 'function', function: {name: string, description: string, parameters: Object}}>}
   */
  getCloudWorkflowToolDefinitions(boardContext = '') {
    // Base tools every workflow needs
    const allowed = new Set([
      'workflow_deck_move_card',
      'workflow_deck_add_comment',
      'workflow_deck_create_card',
      'workflow_deck_update_card',
      'deck_add_label',
    ]);

    // Scan context for capabilities the board actually needs
    const ctx = boardContext.toLowerCase();
    if (ctx.includes('wiki') || ctx.includes('[['))
      ['wiki_write', 'wiki_read', 'wiki_search'].forEach(t => allowed.add(t));
    if (ctx.includes('calendar') || ctx.includes('schedule') || ctx.includes('meeting') || ctx.includes('kickoff'))
      ['calendar_create_event', 'calendar_list_events'].forEach(t => allowed.add(t));
    if (ctx.includes('folder') || ctx.includes('/clients/') || ctx.includes('file'))
      ['file_mkdir', 'file_write'].forEach(t => allowed.add(t));
    if (ctx.includes('email') || ctx.includes('mail'))
      allowed.add('mail_draft');
    if (ctx.includes('talk') || ctx.includes('notify') || ctx.includes('notification'))
      allowed.add('talk_send');

    return Array.from(this.tools.values())
      .filter(t => allowed.has(t.name))
      .map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters }
      }));
  }

  /**
   * Execute a tool call by name.
   * @param {string} name
   * @param {Object} args
   * @returns {Promise<{success: boolean, result: string, error?: string}>}
   */
  async execute(name, args) {
    const tool = this.tools.get(name);
    if (!tool) {
      return { success: false, result: '', error: `Unknown tool: ${name}` };
    }

    try {
      const result = await tool.handler(args || {});
      return {
        success: true,
        result: typeof result === 'string' ? result : JSON.stringify(result)
      };
    } catch (err) {
      // 403: graceful message for shared boards without write permission
      if (err.statusCode === 403 || err.status === 403) {
        return {
          success: false,
          result: '',
          error: `I don't have write permission for this operation. The board may be shared as read-only. I can create the item on my own board and assign you instead.`
        };
      }
      this.logger.error(`[ToolRegistry] Tool ${name} failed:`, err.message);
      return { success: false, result: '', error: err.message };
    }
  }

  /**
   * Register a custom tool dynamically.
   * @param {Object} toolDef
   */
  register(toolDef) {
    if (!toolDef.name || !toolDef.handler) {
      throw new Error('Tool definition requires name and handler');
    }
    this.tools.set(toolDef.name, toolDef);
  }

  /**
   * @param {string} name
   * @returns {boolean}
   */
  has(name) {
    return this.tools.has(name);
  }

  /** @returns {number} */
  get size() {
    return this.tools.size;
  }

  // ===========================================================================
  // Private: Default Tool Registration
  // ===========================================================================

  /** @private */
  _registerDefaultTools() {
    this._registerDeckTools();
    this._registerCalendarTools();
    this._registerFileTools();
    this._registerSearchTools();
    this._registerTagTools();
    this._registerMemoryTools();
    this._registerWikiTools();
    this._registerWebTools();
    this._registerContactsTools();
    this._registerMemorySearchTools();
    this._registerWorkflowDeckTools();
  }

  /**
   * Map display stack name (e.g. 'Working') to lowercase key ('working').
   * @private
   */
  _stackKey(displayName) {
    return (displayName || 'inbox').toLowerCase();
  }

  /**
   * Map lowercase key to display name using deck stackNames.
   * @private
   */
  _stackDisplayName(key, deck) {
    if (deck && deck.stackNames) {
      return deck.stackNames[key] || key;
    }
    return key.charAt(0).toUpperCase() + key.slice(1);
  }

  /**
   * Search for a calendar event by title (partial match) or UID.
   * Looks 7 days back and 30 days forward across all event calendars.
   * @private
   */
  async _findCalendarEvent(cal, searchTerm) {
    const now = new Date();
    const searchStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const searchEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const calendars = await cal.getEventCalendars();
    for (const calendar of calendars) {
      const events = await cal.getEvents(calendar.id, searchStart, searchEnd);
      for (const event of events) {
        const matchByUid = event.uid === searchTerm;
        const matchByTitle = event.summary &&
          event.summary.toLowerCase().includes(searchTerm.toLowerCase());
        if (matchByUid || matchByTitle) {
          return { event, calendarId: calendar.id };
        }
      }
    }
    return null;
  }

  // ---- DECK HELPERS --------------------------------------------------------

  /**
   * Resolve a board identifier (name or numeric ID) to a board object.
   * @private
   */
  async _resolveBoard(deck, identifier) {
    const boards = await deck.listBoards();
    if (!boards || boards.length === 0) return null;

    // Match by numeric ID or #ID
    const idStr = String(identifier).replace(/^#/, '');
    const asNum = parseInt(idStr, 10);
    if (!isNaN(asNum) && String(asNum) === idStr) {
      const byId = boards.find(b => b.id === asNum);
      if (byId) return byId;
    }

    // Case-insensitive partial title match
    const lower = String(identifier).toLowerCase();
    return boards.find(b => b.title.toLowerCase().includes(lower)) || null;
  }

  /**
   * Resolve a card identifier (title or #ID) on the default board.
   * Returns { card, stackKey } or null.
   * @private
   */
  async _resolveCard(deck, identifier) {
    const allCards = await deck.getAllCards();

    for (const [key, cards] of Object.entries(allCards)) {
      for (const card of cards) {
        const matchById = String(identifier).startsWith('#') &&
          card.id === parseInt(String(identifier).slice(1));
        const matchByTitle = !String(identifier).startsWith('#') &&
          card.title.toLowerCase().includes(String(identifier).toLowerCase());

        if (matchById || matchByTitle) {
          return { card, stackKey: key };
        }
      }
    }
    return null;
  }

  /**
   * Resolve cards across all accessible boards.
   * Returns flat array of { card, stackTitle, boardTitle, boardId }.
   * @private
   */
  async _resolveCardAcrossBoards(deck) {
    const boards = await deck.listBoards();
    const results = [];

    for (const board of (boards || []).slice(0, 10)) {
      try {
        const stacks = await deck.getStacks(board.id);
        for (const stack of stacks || []) {
          for (const card of stack.cards || []) {
            results.push({
              card,
              stackTitle: stack.title,
              boardTitle: board.title,
              boardId: board.id
            });
          }
        }
      } catch (e) {
        // Skip boards we can't access
      }
    }
    return results;
  }

  // ---- DECK TOOLS ----------------------------------------------------------

  /** @private */
  _registerDeckTools() {
    const deck = this.clients.deckClient;
    if (!deck) return;

    // -- Original 3 tools (deck_list_cards, deck_move_card, deck_create_card) --

    this.register({
      name: 'deck_list_cards',
      description: 'List all cards on the task board, optionally filtered by stack name (Inbox, Queued, Working, Done, Review, Reference). Returns card titles, IDs, and which stack they are in.',
      parameters: {
        type: 'object',
        properties: {
          stack: {
            type: 'string',
            description: 'Filter by stack name. If omitted, lists all cards from all stacks.',
            enum: ['Inbox', 'Queued', 'Working', 'Done', 'Review', 'Reference']
          }
        },
        required: []
      },
      handler: async (args) => {
        if (args.stack) {
          const key = this._stackKey(args.stack);
          const cards = await deck.getCardsInStack(key);

          if (cards.length === 0) {
            return `No cards in ${args.stack}.`;
          }

          return cards.map(c =>
            `- [#${c.id}] "${c.title}" in ${args.stack}${c.duedate ? ` (due: ${c.duedate})` : ''}`
          ).join('\n');
        }

        // All stacks
        const allCards = await deck.getAllCards();
        const lines = [];

        for (const [key, cards] of Object.entries(allCards)) {
          const displayName = this._stackDisplayName(key, deck);
          for (const c of cards) {
            lines.push(`- [#${c.id}] "${c.title}" in ${displayName}${c.duedate ? ` (due: ${c.duedate})` : ''}`);
          }
        }

        if (lines.length === 0) {
          return 'The board is empty.';
        }

        return lines.join('\n');
      }
    });

    this.register({
      name: 'deck_move_card',
      description: 'Move a card to a different stack. Use this when asked to close, finish, start, or queue a task. The card can be identified by title (partial match) or ID.',
      parameters: {
        type: 'object',
        properties: {
          card: {
            type: 'string',
            description: 'Card title (partial match OK) or card ID prefixed with #'
          },
          target_stack: {
            type: 'string',
            description: 'Destination stack',
            enum: ['Inbox', 'Queued', 'Working', 'Done', 'Review']
          }
        },
        required: ['card', 'target_stack']
      },
      handler: async (args) => {
        const resolved = await this._resolveCard(deck, args.card);

        if (!resolved) {
          const allCards = await deck.getAllCards();
          const available = Object.entries(allCards)
            .flatMap(([k, cards]) => cards.map(c => `  - "${c.title}" in ${this._stackDisplayName(k, deck)}`))
            .join('\n');
          return `No card found matching "${args.card}".${available ? ` Available cards:\n${available}` : ''}`;
        }

        const { card: foundCard, stackKey: fromStackKey } = resolved;
        const toStackKey = this._stackKey(args.target_stack);

        if (fromStackKey === toStackKey) {
          return `Card "${foundCard.title}" is already in ${args.target_stack}.`;
        }

        await deck.moveCard(foundCard.id, fromStackKey, toStackKey);
        return `Moved "${foundCard.title}" (card #${foundCard.id}) from ${this._stackDisplayName(fromStackKey, deck)} to ${args.target_stack}.`;
      }
    });

    this.register({
      name: 'deck_create_card',
      description: 'Create a new card (task) on the board. Cards are created in the Inbox stack by default.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Card title' },
          description: { type: 'string', description: 'Card description (optional)' },
          stack: {
            type: 'string',
            description: 'Stack to create in (default: Inbox)',
            enum: ['Inbox', 'Queued', 'Working', 'Done']
          }
        },
        required: ['title']
      },
      handler: async (args) => {
        const stackKey = this._stackKey(args.stack || 'Inbox');
        const card = await deck.createCard(stackKey, {
          title: args.title,
          description: args.description || ''
        });

        return `Created "${args.title}" (card #${card.id}) in ${args.stack || 'Inbox'}.`;
      }
    });

    // -- Phase A: Board ops --

    this.register({
      name: 'deck_list_boards',
      description: 'List all Deck boards accessible to you (owned and shared). Returns board names, IDs, and ownership info.',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: async () => {
        const boards = await deck.listBoards();
        if (!boards || boards.length === 0) return 'No boards found.';

        return boards.map(b => {
          const owned = b.owner?.uid === deck.username || b.owner === deck.username;
          return `- "${b.title}" (ID: ${b.id}, ${owned ? 'yours' : 'shared'})`;
        }).join('\n');
      }
    });

    this.register({
      name: 'deck_get_board',
      description: 'Get details of a specific Deck board including its stacks, labels, and sharing settings. Accepts board name (partial match) or ID.',
      parameters: {
        type: 'object',
        properties: {
          board: { type: 'string', description: 'Board name (partial match) or board ID' }
        },
        required: ['board']
      },
      handler: async (args) => {
        const board = await this._resolveBoard(deck, args.board);
        if (!board) return `No board found matching "${args.board}".`;

        const full = await deck.getBoard(board.id);
        const stacks = (full.stacks || []).map(s => `  - ${s.title} (${(s.cards || []).length} cards)`).join('\n');
        const labels = (full.labels || []).map(l => l.title).join(', ');
        const owned = full.owner?.uid === deck.username || full.owner === deck.username;

        let result = `Board: "${full.title}" (ID: ${full.id}, ${owned ? 'yours' : 'shared'})\n`;
        result += `Stacks:\n${stacks || '  (none)'}\n`;
        result += `Labels: ${labels || '(none)'}`;
        return result;
      }
    });

    this.register({
      name: 'deck_create_board',
      description: 'Create a new Deck board. You will own this board.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Board title' },
          color: { type: 'string', description: 'Hex color without # (default: 0082c9)' }
        },
        required: ['title']
      },
      handler: async (args) => {
        const board = await deck._request('POST', '/index.php/apps/deck/api/v1.0/boards', {
          title: args.title,
          color: args.color || '0082c9'
        });
        return `Created board "${args.title}" (ID: ${board.id}).`;
      }
    });

    // -- Phase A: Stack ops --

    this.register({
      name: 'deck_list_stacks',
      description: 'List all stacks (columns) in a Deck board with card counts. Accepts board name (partial match) or ID.',
      parameters: {
        type: 'object',
        properties: {
          board: { type: 'string', description: 'Board name (partial match) or board ID' }
        },
        required: ['board']
      },
      handler: async (args) => {
        const board = await this._resolveBoard(deck, args.board);
        if (!board) return `No board found matching "${args.board}".`;

        const stacks = await deck.getStacks(board.id);
        if (!stacks || stacks.length === 0) return `Board "${board.title}" has no stacks.`;

        return stacks.map(s =>
          `- "${s.title}" (${(s.cards || []).length} cards)`
        ).join('\n');
      }
    });

    this.register({
      name: 'deck_create_stack',
      description: 'Create a new stack (column) in a Deck board.',
      parameters: {
        type: 'object',
        properties: {
          board: { type: 'string', description: 'Board name (partial match) or board ID' },
          title: { type: 'string', description: 'Stack title' },
          order: { type: 'number', description: 'Stack order (default: 999)' }
        },
        required: ['board', 'title']
      },
      handler: async (args) => {
        const board = await this._resolveBoard(deck, args.board);
        if (!board) return `No board found matching "${args.board}".`;

        const stack = await deck.createStack(board.id, args.title, args.order || 999);
        return `Created stack "${args.title}" in board "${board.title}" (stack ID: ${stack.id}).`;
      }
    });

    // -- Phase A: Card CRUD --

    this.register({
      name: 'deck_get_card',
      description: 'Get full details of a card including description, due date, assigned users, labels, and comments. Card identified by title (partial match) or #ID.',
      parameters: {
        type: 'object',
        properties: {
          card: { type: 'string', description: 'Card title (partial match) or card ID prefixed with #' }
        },
        required: ['card']
      },
      handler: async (args) => {
        const resolved = await this._resolveCard(deck, args.card);
        if (!resolved) return `No card found matching "${args.card}".`;

        const { card: found, stackKey } = resolved;
        const full = await deck.getCard(found.id, stackKey);
        const comments = await deck.getComments(found.id);

        let result = `Card #${full.id}: "${full.title}" in ${this._stackDisplayName(stackKey, deck)}\n`;
        if (full.description) result += `Description: ${full.description}\n`;
        if (full.duedate) result += `Due: ${full.duedate}\n`;

        const assigned = (full.assignedUsers || []).map(u =>
          u.participant?.uid || u.uid || 'unknown'
        ).join(', ');
        if (assigned) result += `Assigned: ${assigned}\n`;

        const labels = (full.labels || []).map(l => l.title).join(', ');
        if (labels) result += `Labels: ${labels}\n`;

        if (comments.length > 0) {
          result += `\nComments (${comments.length}):\n`;
          for (const c of comments.slice(0, 10)) {
            const author = c.actorId || 'unknown';
            const date = c.creationDateTime || '';
            result += `  - [${author}] ${c.message}${date ? ` (${date})` : ''}\n`;
          }
        }
        return result.trim();
      }
    });

    this.register({
      name: 'deck_update_card',
      description: 'Update a card\'s title, description, or due date. Card identified by title (partial match) or #ID.',
      parameters: {
        type: 'object',
        properties: {
          card: { type: 'string', description: 'Card title (partial match) or card ID prefixed with #' },
          title: { type: 'string', description: 'New title' },
          description: { type: 'string', description: 'New description' },
          duedate: { type: 'string', description: 'New due date (ISO format) or "none" to clear' }
        },
        required: ['card']
      },
      handler: async (args) => {
        const resolved = await this._resolveCard(deck, args.card);
        if (!resolved) return `No card found matching "${args.card}".`;

        const { card: found, stackKey } = resolved;
        const current = await deck.getCard(found.id, stackKey);

        const updates = {
          title: args.title || current.title,
          type: current.type || 'plain',
          owner: current.owner?.uid || current.owner || deck.username,
          description: args.description !== undefined ? args.description : (current.description || ''),
          duedate: args.duedate === 'none' ? null : (args.duedate || current.duedate || null)
        };

        await deck.updateCard(found.id, stackKey, updates);

        const changes = [];
        if (args.title) changes.push(`title: "${args.title}"`);
        if (args.description !== undefined) changes.push('description updated');
        if (args.duedate) changes.push(`due: ${args.duedate}`);

        return `Updated card #${found.id} "${updates.title}".${changes.length ? ' Changes: ' + changes.join(', ') + '.' : ''}`;
      }
    });

    this.register({
      name: 'deck_delete_card',
      description: 'Delete a card from the board. This is destructive and requires confirmation. Card identified by title (partial match) or #ID.',
      parameters: {
        type: 'object',
        properties: {
          card: { type: 'string', description: 'Card title (partial match) or card ID prefixed with #' }
        },
        required: ['card']
      },
      handler: async (args) => {
        const resolved = await this._resolveCard(deck, args.card);
        if (!resolved) return `No card found matching "${args.card}".`;

        const { card: found, stackKey } = resolved;
        await deck.deleteCard(found.id, stackKey);
        return `Deleted card #${found.id} "${found.title}" from ${this._stackDisplayName(stackKey, deck)}.`;
      }
    });

    this.register({
      name: 'deck_assign_user',
      description: 'Assign a user to a card. Card identified by title (partial match) or #ID.',
      parameters: {
        type: 'object',
        properties: {
          card: { type: 'string', description: 'Card title (partial match) or card ID prefixed with #' },
          user: { type: 'string', description: 'NC username to assign' }
        },
        required: ['card', 'user']
      },
      handler: async (args) => {
        const resolved = await this._resolveCard(deck, args.card);
        if (!resolved) return `No card found matching "${args.card}".`;

        const { card: found, stackKey } = resolved;
        await deck.assignUser(found.id, stackKey, args.user);
        return `Assigned "${args.user}" to card #${found.id} "${found.title}".`;
      }
    });

    this.register({
      name: 'deck_unassign_user',
      description: 'Remove a user assignment from a card. Card identified by title (partial match) or #ID.',
      parameters: {
        type: 'object',
        properties: {
          card: { type: 'string', description: 'Card title (partial match) or card ID prefixed with #' },
          user: { type: 'string', description: 'NC username to unassign' }
        },
        required: ['card', 'user']
      },
      handler: async (args) => {
        const resolved = await this._resolveCard(deck, args.card);
        if (!resolved) return `No card found matching "${args.card}".`;

        const { card: found, stackKey } = resolved;
        await deck.unassignUser(found.id, stackKey, args.user);
        return `Unassigned "${args.user}" from card #${found.id} "${found.title}".`;
      }
    });

    this.register({
      name: 'deck_set_due_date',
      description: 'Set or clear the due date on a card. Card identified by title (partial match) or #ID.',
      parameters: {
        type: 'object',
        properties: {
          card: { type: 'string', description: 'Card title (partial match) or card ID prefixed with #' },
          duedate: { type: 'string', description: 'Due date in ISO format (e.g. 2026-02-15) or "none" to clear' }
        },
        required: ['card', 'duedate']
      },
      handler: async (args) => {
        const resolved = await this._resolveCard(deck, args.card);
        if (!resolved) return `No card found matching "${args.card}".`;

        const { card: found, stackKey } = resolved;
        const current = await deck.getCard(found.id, stackKey);

        const duedate = args.duedate.toLowerCase() === 'none' ? null : args.duedate;
        await deck.updateCard(found.id, stackKey, {
          title: current.title,
          type: current.type || 'plain',
          owner: current.owner?.uid || current.owner || deck.username,
          duedate
        });

        return duedate
          ? `Set due date on card #${found.id} "${found.title}" to ${duedate}.`
          : `Cleared due date on card #${found.id} "${found.title}".`;
      }
    });

    // -- Phase A: Labels --

    this.register({
      name: 'deck_add_label',
      description: 'Add a label to a card. Card identified by title (partial match) or #ID.',
      parameters: {
        type: 'object',
        properties: {
          card: { type: 'string', description: 'Card title (partial match) or card ID prefixed with #' },
          label: { type: 'string', description: 'Label name (e.g. urgent, research, writing, admin, blocked)' }
        },
        required: ['card', 'label']
      },
      handler: async (args) => {
        const resolved = await this._resolveCard(deck, args.card);
        if (!resolved) return `No card found matching "${args.card}".`;

        const { card: found, stackKey } = resolved;
        await deck.addLabel(found.id, stackKey, args.label);
        return `Added label "${args.label}" to card #${found.id} "${found.title}".`;
      }
    });

    this.register({
      name: 'deck_remove_label',
      description: 'Remove a label from a card. Card identified by title (partial match) or #ID.',
      parameters: {
        type: 'object',
        properties: {
          card: { type: 'string', description: 'Card title (partial match) or card ID prefixed with #' },
          label: { type: 'string', description: 'Label name to remove' }
        },
        required: ['card', 'label']
      },
      handler: async (args) => {
        const resolved = await this._resolveCard(deck, args.card);
        if (!resolved) return `No card found matching "${args.card}".`;

        const { card: found, stackKey } = resolved;
        await deck.removeLabel(found.id, stackKey, args.label);
        return `Removed label "${args.label}" from card #${found.id} "${found.title}".`;
      }
    });

    // -- Phase A: Comments --

    this.register({
      name: 'deck_add_comment',
      description: 'Add a comment to a card. Use this to leave notes, updates, or communicate about a task. Card identified by title (partial match) or #ID.',
      parameters: {
        type: 'object',
        properties: {
          card: { type: 'string', description: 'Card title (partial match) or card ID prefixed with #' },
          message: { type: 'string', description: 'Comment text' }
        },
        required: ['card', 'message']
      },
      handler: async (args) => {
        const resolved = await this._resolveCard(deck, args.card);
        if (!resolved) return `No card found matching "${args.card}".`;

        const { card: found } = resolved;
        await deck.addComment(found.id, args.message, 'STATUS', { prefix: false });
        return `Added comment to card #${found.id} "${found.title}".`;
      }
    });

    this.register({
      name: 'deck_list_comments',
      description: 'List all comments on a card. Card identified by title (partial match) or #ID.',
      parameters: {
        type: 'object',
        properties: {
          card: { type: 'string', description: 'Card title (partial match) or card ID prefixed with #' }
        },
        required: ['card']
      },
      handler: async (args) => {
        const resolved = await this._resolveCard(deck, args.card);
        if (!resolved) return `No card found matching "${args.card}".`;

        const { card: found } = resolved;
        const comments = await deck.getComments(found.id);

        if (comments.length === 0) return `No comments on card #${found.id} "${found.title}".`;

        const lines = [`Comments on card #${found.id} "${found.title}":`];
        for (const c of comments) {
          const author = c.actorId || 'unknown';
          const date = c.creationDateTime || '';
          lines.push(`- [${author}] ${c.message}${date ? ` (${date})` : ''}`);
        }
        return lines.join('\n');
      }
    });

    // -- Phase A: Sharing --

    this.register({
      name: 'deck_share_board',
      description: 'Share a board you own with another user or group. Requires confirmation.',
      parameters: {
        type: 'object',
        properties: {
          board: { type: 'string', description: 'Board name (partial match) or board ID' },
          participant: { type: 'string', description: 'NC username or group name to share with' },
          type: { type: 'string', description: '"user" or "group" (default: user)', enum: ['user', 'group'] },
          permission: { type: 'string', description: 'Permission level (default: edit)', enum: ['read', 'edit', 'manage'] }
        },
        required: ['board', 'participant']
      },
      handler: async (args) => {
        const board = await this._resolveBoard(deck, args.board);
        if (!board) return `No board found matching "${args.board}".`;

        const owned = board.owner?.uid === deck.username || board.owner === deck.username;
        if (!owned) return `You don't own "${board.title}" — only board owners can share.`;

        const shareType = args.type === 'group' ? 1 : 0;
        const perm = args.permission || 'edit';
        const permissionEdit = perm === 'edit' || perm === 'manage';
        const permissionShare = perm === 'manage';
        const permissionManage = perm === 'manage';

        await deck.shareBoard(board.id, args.participant, shareType, permissionEdit, permissionShare, permissionManage);
        return `Shared board "${board.title}" with ${args.type || 'user'} "${args.participant}" (${perm} access).`;
      }
    });

    // -- Phase B: Smart ops --

    this.register({
      name: 'deck_overview',
      description: 'Get a summary of all accessible boards: board names, card counts per stack, and overdue items. Use when asked for a board overview or status summary.',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: async () => {
        const boards = await deck.listBoards();
        if (!boards || boards.length === 0) return 'No boards found.';

        const lines = [];
        const now = new Date();

        for (const board of boards.slice(0, 10)) {
          try {
            const stacks = await deck.getStacks(board.id);
            const owned = board.owner?.uid === deck.username || board.owner === deck.username;
            const stackInfo = (stacks || []).map(s => `${s.title} (${(s.cards || []).length})`).join(', ');

            let overdue = 0;
            for (const stack of stacks || []) {
              for (const card of stack.cards || []) {
                if (card.duedate && new Date(card.duedate) < now) overdue++;
              }
            }

            let line = `- "${board.title}" (${owned ? 'yours' : 'shared'}, ID: ${board.id}): ${stackInfo || 'no stacks'}`;
            if (overdue > 0) line += ` — ${overdue} overdue`;
            lines.push(line);
          } catch (e) {
            lines.push(`- "${board.title}" (ID: ${board.id}): could not load`);
          }
        }

        return lines.join('\n');
      }
    });

    this.register({
      name: 'deck_my_assigned_cards',
      description: 'List all cards assigned to a user across all accessible boards. Defaults to you if no user specified.',
      parameters: {
        type: 'object',
        properties: {
          user: { type: 'string', description: 'NC username (default: yourself)' }
        },
        required: []
      },
      handler: async (args) => {
        const targetUser = (args.user || deck.username).toLowerCase();
        const allEntries = await this._resolveCardAcrossBoards(deck);

        const assigned = allEntries.filter(e => {
          const users = e.card.assignedUsers || [];
          return users.some(u =>
            (u.participant?.uid || u.uid || '').toLowerCase() === targetUser
          );
        });

        if (assigned.length === 0) return `No cards assigned to "${args.user || deck.username}".`;

        return assigned.map(e =>
          `- [#${e.card.id}] "${e.card.title}" in ${e.stackTitle} (board: ${e.boardTitle})${e.card.duedate ? ` — due: ${e.card.duedate}` : ''}`
        ).join('\n');
      }
    });

    this.register({
      name: 'deck_overdue_cards',
      description: 'List all cards with past due dates across all accessible boards.',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: async () => {
        const allEntries = await this._resolveCardAcrossBoards(deck);
        const now = new Date();

        const overdue = allEntries.filter(e =>
          e.card.duedate && new Date(e.card.duedate) < now
        );

        if (overdue.length === 0) return 'No overdue cards found.';

        return overdue.map(e =>
          `- [#${e.card.id}] "${e.card.title}" — due: ${e.card.duedate} (board: ${e.boardTitle}, stack: ${e.stackTitle})`
        ).join('\n');
      }
    });

    this.register({
      name: 'deck_mark_done',
      description: 'Mark a card as done by moving it to the Done stack. Card identified by title (partial match) or #ID.',
      parameters: {
        type: 'object',
        properties: {
          card: { type: 'string', description: 'Card title (partial match) or card ID prefixed with #' }
        },
        required: ['card']
      },
      handler: async (args) => {
        const resolved = await this._resolveCard(deck, args.card);
        if (!resolved) return `No card found matching "${args.card}".`;

        const { card: found, stackKey } = resolved;
        if (stackKey === 'done') return `Card #${found.id} "${found.title}" is already in Done.`;

        await deck.moveCard(found.id, stackKey, 'done');
        return `Marked card #${found.id} "${found.title}" as done (moved from ${this._stackDisplayName(stackKey, deck)} to Done).`;
      }
    });
  }

  // ---- CALENDAR TOOLS ------------------------------------------------------

  /** @private */
  _registerCalendarTools() {
    const cal = this.clients.calDAVClient;
    if (!cal) return;

    this.register({
      name: 'calendar_list_events',
      description: 'List upcoming calendar events. Returns event titles, times, and descriptions.',
      parameters: {
        type: 'object',
        properties: {
          hours: {
            type: 'number',
            description: 'Number of hours ahead to check (default: 168, i.e. 7 days)'
          }
        },
        required: []
      },
      handler: async (args) => {
        const hours = args.hours || 168;
        const events = await cal.getUpcomingEvents(hours);

        if (!events || events.length === 0) {
          return `No events in the next ${hours} hours.`;
        }

        return events.map(e => {
          const start = e.start ? new Date(e.start).toLocaleString() : '?';
          const end = e.end ? new Date(e.end).toLocaleString() : '?';
          let line = `- ${e.summary || 'Untitled'} (${start} to ${end})`;
          if (e.location) line += ` at ${e.location}`;
          return line;
        }).join('\n');
      }
    });

    this.register({
      name: 'calendar_create_event',
      description: 'Create a new calendar event.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Event title' },
          start: { type: 'string', description: 'Start datetime as ISO 8601 string' },
          end: { type: 'string', description: 'End datetime as ISO 8601 string (default: 1 hour after start)' },
          description: { type: 'string', description: 'Event description (optional)' },
          location: { type: 'string', description: 'Location (optional)' }
        },
        required: ['title', 'start']
      },
      handler: async (args) => {
        const startDate = new Date(args.start);
        const endDate = args.end
          ? new Date(args.end)
          : new Date(startDate.getTime() + 60 * 60 * 1000);

        const event = await cal.createEvent({
          summary: args.title,
          start: startDate,
          end: endDate,
          description: args.description || '',
          location: args.location || ''
        });

        return `Created "${args.title}" on ${startDate.toLocaleDateString()} at ${startDate.toLocaleTimeString()}.${event?.uid ? ` Event ID: ${event.uid}` : ''}`;
      }
    });

    this.register({
      name: 'calendar_check_conflicts',
      description: 'Check if a time slot has conflicts with existing events.',
      parameters: {
        type: 'object',
        properties: {
          start: { type: 'string', description: 'Start datetime as ISO 8601 string' },
          end: { type: 'string', description: 'End datetime as ISO 8601 string (default: 1 hour after start)' }
        },
        required: ['start']
      },
      handler: async (args) => {
        const startDate = new Date(args.start);
        const endDate = args.end
          ? new Date(args.end)
          : new Date(startDate.getTime() + 60 * 60 * 1000);

        const result = await cal.checkAvailability(startDate, endDate);

        if (result.isFree) {
          return `No conflicts on ${startDate.toLocaleDateString()} at ${startDate.toLocaleTimeString()}.`;
        }

        return `Conflicts found:\n` +
          result.conflicts.map(c => `  - ${c.summary} (${c.start} - ${c.end})`).join('\n');
      }
    });

    this.register({
      name: 'calendar_update_event',
      description: 'Update an existing calendar event. Use to reschedule, rename, change duration, or modify any event property.',
      parameters: {
        type: 'object',
        properties: {
          event: { type: 'string', description: 'Event title (partial match) or UID to find the event' },
          title: { type: 'string', description: 'New title' },
          start: { type: 'string', description: 'New start datetime as ISO 8601 string' },
          end: { type: 'string', description: 'New end datetime as ISO 8601 string' },
          description: { type: 'string', description: 'New description' },
          location: { type: 'string', description: 'New location' },
          all_day: { type: 'boolean', description: 'Set as all-day event' }
        },
        required: ['event']
      },
      handler: async (args) => {
        const match = await this._findCalendarEvent(cal, args.event);
        if (!match) {
          return `No event found matching "${args.event}" in the next 30 days or past 7 days.`;
        }
        const { event: foundEvent, calendarId: foundCalendar } = match;

        const updates = {};
        if (args.title !== undefined) updates.summary = args.title;
        if (args.start !== undefined) updates.start = new Date(args.start);
        if (args.end !== undefined) updates.end = new Date(args.end);
        if (args.description !== undefined) updates.description = args.description;
        if (args.location !== undefined) updates.location = args.location;
        if (args.all_day !== undefined) {
          updates.allDay = args.all_day;
          if (args.all_day && args.start && !args.end) {
            const dayStart = new Date(args.start);
            updates.end = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
          }
        }

        await cal.updateEvent(foundCalendar, foundEvent.uid, updates, foundEvent.etag);

        const originalTitle = foundEvent.summary || 'Untitled';
        const changedFields = [];
        if (args.title) changedFields.push(`title: "${args.title}"`);
        if (args.start) changedFields.push(`start: ${new Date(args.start).toLocaleString()}`);
        if (args.end) changedFields.push(`end: ${new Date(args.end).toLocaleString()}`);
        if (args.location !== undefined) changedFields.push(`location: ${args.location || '(removed)'}`);
        if (args.description !== undefined) changedFields.push('description updated');
        if (args.all_day !== undefined) changedFields.push(`all-day: ${args.all_day}`);

        return `Updated "${originalTitle}"${changedFields.length ? '. Changes: ' + changedFields.join(', ') : ''}.`;
      }
    });

    this.register({
      name: 'calendar_delete_event',
      description: 'Delete a calendar event.',
      parameters: {
        type: 'object',
        properties: {
          event: { type: 'string', description: 'Event title (partial match) or UID to find the event' }
        },
        required: ['event']
      },
      handler: async (args) => {
        const match = await this._findCalendarEvent(cal, args.event);
        if (!match) {
          return `No event found matching "${args.event}" in the next 30 days or past 7 days.`;
        }
        const { event: foundEvent, calendarId: foundCalendar } = match;

        await cal.deleteEvent(foundCalendar, foundEvent.uid, foundEvent.etag);

        const eventTitle = foundEvent.summary || 'Untitled';
        const eventStart = foundEvent.start ? new Date(foundEvent.start).toLocaleString() : '';
        return `Deleted "${eventTitle}"${eventStart ? ` (was scheduled for ${eventStart})` : ''}.`;
      }
    });
  }

  // ---- FILE TOOLS -----------------------------------------------------------

  /**
   * Format byte size to human-readable string.
   * @private
   */
  _formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
  }

  /** @private */
  _registerFileTools() {
    const files = this.clients.ncFilesClient;
    if (!files) return;

    this.register({
      name: 'file_read',
      description: 'Read the contents of a text file from Nextcloud. Works with .txt, .md, .json, .csv, .yaml, .html, .xml, and similar text files. For PDF or Word documents, use file_extract instead.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: "File path like 'Outbox/report.md' or 'shared-folder/notes.txt'" }
        },
        required: ['path']
      },
      handler: async (args) => {
        // Fuzzy path resolution
        const resolved = await files.resolvePath(args.path);
        if (resolved === null) {
          const names = await files.getRootFolderNames();
          return `File not found: "${args.path}". Available folders: ${names.join(', ')}`;
        }
        if (resolved !== args.path) {
          this.logger.info(`[ToolRegistry] file_read: resolved "${args.path}" → "${resolved}"`);
        }

        try {
          const result = await files.readFile(resolved);
          let output = result.content;
          if (result.truncated) {
            output += `\n\n(Showing first ${this._formatSize(files.maxContentSize)} of ${this._formatSize(result.totalSize)})`;
          }
          return output;
        } catch (err) {
          if (err.statusCode === 404) {
            return `File not found: "${args.path}". Use file_list to see available files.`;
          }
          throw err;
        }
      }
    });

    this.register({
      name: 'file_list',
      description: 'List files and folders in a Nextcloud directory. Shows name, size, modified date, and type.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path to list. Defaults to root.' }
        },
        required: []
      },
      handler: async (args) => {
        let targetPath = args.path || '/';

        // Fuzzy path resolution (skip for root)
        if (targetPath !== '/') {
          const resolved = await files.resolvePath(targetPath);
          if (resolved === null) {
            const names = await files.getRootFolderNames();
            return `Path "${targetPath}" not found. Available: ${names.join(', ')}`;
          }
          if (resolved !== targetPath) {
            this.logger.info(`[ToolRegistry] file_list: resolved "${targetPath}" → "${resolved}"`);
          }
          targetPath = resolved;
        }

        const items = await files.listDirectory(targetPath);

        if (items.length === 0) {
          return `No files in "${targetPath}"`;
        }

        // Sort: directories first, then alphabetically by name
        items.sort((a, b) => {
          const aIsDir = a.type === 'directory' ? 0 : 1;
          const bIsDir = b.type === 'directory' ? 0 : 1;
          if (aIsDir !== bIsDir) return aIsDir - bIsDir;
          return a.name.localeCompare(b.name);
        });

        // Cap output to prevent token explosion
        const MAX_ENTRIES = 30;
        const total = items.length;
        const shown = items.slice(0, MAX_ENTRIES);

        let result = shown.map(item => {
          const prefix = item.type === 'directory' ? '[dir] ' : '      ';
          const sizeStr = item.type === 'file' ? ` (${this._formatSize(item.size)})` : '';
          return `${prefix}${item.name}${sizeStr}`;
        }).join('\n');

        if (total > MAX_ENTRIES) {
          result += `\n\n... and ${total - MAX_ENTRIES} more items. Use a more specific path to narrow results.`;
        }

        return result;
      }
    });

    this.register({
      name: 'file_write',
      description: 'Write content to a file in your Nextcloud workspace. Creates the file if it doesn\'t exist, overwrites if it does.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: "File path within your workspace, e.g. 'Outbox/report.md'" },
          content: { type: 'string', description: 'The text content to write' }
        },
        required: ['path', 'content']
      },
      handler: async (args) => {
        try {
          await files.writeFile(args.path, args.content);
          return `Wrote ${this._formatSize(Buffer.byteLength(args.content, 'utf-8'))} to "${args.path}".`;
        } catch (err) {
          if (err.statusCode === 403) {
            return `I don't have write permission for "${args.path}". It may be shared as read-only. I can save to my Outbox instead.`;
          }
          throw err;
        }
      }
    });

    this.register({
      name: 'file_info',
      description: 'Get metadata about a file: size, last modified, type, permissions, and whether it\'s shared.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' }
        },
        required: ['path']
      },
      handler: async (args) => {
        // Fuzzy path resolution
        const resolved = await files.resolvePath(args.path);
        if (resolved === null) {
          const names = await files.getRootFolderNames();
          return `File not found: "${args.path}". Available folders: ${names.join(', ')}`;
        }
        if (resolved !== args.path) {
          this.logger.info(`[ToolRegistry] file_info: resolved "${args.path}" → "${resolved}"`);
        }

        try {
          const info = await files.getFileInfo(resolved);
          const lines = [
            `Name: ${info.name}`,
            `Size: ${this._formatSize(info.size)}`,
            `Modified: ${info.modified}`,
            `Type: ${info.contentType || 'directory'}`,
            `Shared: ${info.shared ? 'yes' : 'no'}`,
            `Writable: ${info.canWrite ? 'yes' : 'no'}`
          ];
          return lines.join('\n');
        } catch (err) {
          if (err.statusCode === 404) {
            return `File not found: "${args.path}". Use file_list to see available files.`;
          }
          throw err;
        }
      }
    });

    this.register({
      name: 'file_move',
      description: 'Move or rename a file within Nextcloud.',
      parameters: {
        type: 'object',
        properties: {
          from_path: { type: 'string', description: 'Current file path' },
          to_path: { type: 'string', description: 'New file path' }
        },
        required: ['from_path', 'to_path']
      },
      handler: async (args) => {
        await files.moveFile(args.from_path, args.to_path);
        return `Moved "${args.from_path}" to "${args.to_path}".`;
      }
    });

    this.register({
      name: 'file_copy',
      description: 'Copy a file to a new location.',
      parameters: {
        type: 'object',
        properties: {
          from_path: { type: 'string', description: 'Source file path' },
          to_path: { type: 'string', description: 'Destination file path' }
        },
        required: ['from_path', 'to_path']
      },
      handler: async (args) => {
        await files.copyFile(args.from_path, args.to_path);
        return `Copied "${args.from_path}" to "${args.to_path}".`;
      }
    });

    this.register({
      name: 'file_delete',
      description: 'Delete a file or folder. Requires confirmation.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File or folder path to delete' }
        },
        required: ['path']
      },
      handler: async (args) => {
        await files.deleteFile(args.path);
        return `Deleted "${args.path}".`;
      }
    });

    this.register({
      name: 'file_mkdir',
      description: 'Create a new folder in your workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Folder path to create' }
        },
        required: ['path']
      },
      handler: async (args) => {
        await files.mkdir(args.path);
        return `Created folder "${args.path}".`;
      }
    });

    this.register({
      name: 'file_share',
      description: 'Share a file or folder with a user. Uses NC\'s native sharing. Requires confirmation.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to share' },
          share_with: { type: 'string', description: 'NC username to share with' },
          permission: { type: 'string', description: 'Permission level: "read" or "edit" (default: read)', enum: ['read', 'edit'] }
        },
        required: ['path', 'share_with']
      },
      handler: async (args) => {
        const result = await files.shareFile(args.path, args.share_with, args.permission || 'read');
        return `Shared "${args.path}" with "${args.share_with}" (${args.permission || 'read'} access).${result.shareId ? ' Share ID: ' + result.shareId : ''}`;
      }
    });

    // file_extract: requires both ncFilesClient and textExtractor
    const extractor = this.clients.textExtractor;
    if (extractor) {
      this.register({
        name: 'file_extract',
        description: 'Extract text content from PDF, Word (.docx), or Excel (.xlsx) files. Downloads the file and extracts readable text.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path to PDF, .docx, or .xlsx file' }
          },
          required: ['path']
        },
        handler: async (args) => {
          const { TextExtractor } = require('../extraction/text-extractor');
          if (!TextExtractor.isSupported(args.path)) {
            return `Can't extract text from "${args.path}". Supported: PDF, docx, xlsx, and text formats.`;
          }

          // Fuzzy path resolution
          const resolved = await files.resolvePath(args.path);
          if (resolved === null) {
            const names = await files.getRootFolderNames();
            return `File not found: "${args.path}". Available folders: ${names.join(', ')}`;
          }
          if (resolved !== args.path) {
            this.logger.info(`[ToolRegistry] file_extract: resolved "${args.path}" → "${resolved}"`);
          }

          try {
            const buffer = await files.readFileBuffer(resolved);
            const result = await extractor.extract(buffer, resolved);
            let output = result.text;
            if (result.pages) {
              output = `(${result.pages} pages)\n\n${output}`;
            }
            return output;
          } catch (err) {
            if (err.statusCode === 404) {
              return `File not found: "${args.path}". Use file_list to see available files.`;
            }
            throw err;
          }
        }
      });
    }
  }

  // ---- SEARCH TOOLS ---------------------------------------------------------

  /** @private */
  _registerSearchTools() {
    const search = this.clients.ncSearchClient;
    if (!search) return;

    this.register({
      name: 'unified_search',
      description: 'Search across everything in Nextcloud — files, tasks, calendar events, contacts, chat messages. Use when you don\'t know which app contains what you\'re looking for.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search term' },
          providers: {
            type: 'string',
            description: 'Comma-separated provider IDs to search (e.g. "files,deck,calendar"). Defaults to all.'
          },
          limit: { type: 'number', description: 'Results per provider (default: 5)' }
        },
        required: ['query']
      },
      handler: async (args) => {
        const providerIds = args.providers
          ? args.providers.split(',').map(s => s.trim()).filter(Boolean)
          : undefined;
        const limit = args.limit || 5;

        const results = await search.search(args.query, providerIds, limit);

        if (results.length === 0) {
          return `No results found for "${args.query}".`;
        }

        return results.map(r =>
          `[${r.provider}] ${r.title}${r.subline ? ' — ' + r.subline : ''}`
        ).join('\n');
      }
    });
  }

  // ---- SYSTEM TAG TOOLS ----------------------------------------------------

  /** @private */
  _registerTagTools() {
    const tags = this.clients.systemTagsClient;
    if (!tags) return;

    this.register({
      name: 'tag_file',
      description: 'Assign a system tag to a file. Tags: pending, processed, needs-review, ai-flagged.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path in Nextcloud (relative to user root)' },
          tag: {
            type: 'string',
            description: 'Tag to assign',
            enum: ['pending', 'processed', 'needs-review', 'ai-flagged']
          }
        },
        required: ['path', 'tag']
      },
      handler: async (args) => {
        const success = await tags.tagFileByPath(args.path, args.tag);
        return success
          ? `Tagged "${args.path}" as ${args.tag}.`
          : `Failed to tag "${args.path}" as ${args.tag}.`;
      }
    });
  }

  // ---- MEMORY TOOLS --------------------------------------------------------

  /** @private */
  _registerMemoryTools() {
    const nc = this.clients.ncRequestManager;
    if (!nc) return;

    this.register({
      name: 'memory_recall',
      description: 'Search the learning log for information about a topic. Use this when you need to recall something previously learned.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to search for' }
        },
        required: ['query']
      },
      handler: async (args) => {
        try {
          const user = nc.ncUser || 'moltagent';
          const response = await nc.request(
            `/remote.php/dav/files/${user}/Memory/LearningLog.md`,
            { method: 'GET' }
          );

          const body = typeof response.body === 'string'
            ? response.body
            : (response.body ? JSON.stringify(response.body) : '');

          const lines = body.split('\n').filter(l =>
            l.toLowerCase().includes(args.query.toLowerCase())
          );

          if (lines.length === 0) {
            return `No memories found matching "${args.query}".`;
          }

          return `Found ${lines.length} relevant entries:\n${lines.slice(0, 10).join('\n')}`;
        } catch (e) {
          return `Could not access memory: ${e.message}`;
        }
      }
    });
  }
  // ---- WIKI TOOLS -----------------------------------------------------------

  /** @private */
  _registerWikiTools() {
    const wiki = this.clients.collectivesClient;
    if (!wiki) return;

    this.register({
      name: 'wiki_read',
      description: 'Read a page from the Moltagent Knowledge wiki. Returns page content with frontmatter metadata summary.',
      parameters: {
        type: 'object',
        properties: {
          page_title: { type: 'string', description: 'Page title to read (e.g. "People/John Smith" or "Projects/Q3 Campaign")' }
        },
        required: ['page_title']
      },
      handler: async (args) => {
        const result = await wiki.readPageWithFrontmatter(args.page_title);
        if (!result) {
          return `No wiki page found matching "${args.page_title}". Use wiki_search to find pages or wiki_list to browse sections.`;
        }

        let output = '';
        if (result.frontmatter && Object.keys(result.frontmatter).length > 0) {
          const fm = result.frontmatter;
          const meta = [];
          if (fm.type) meta.push(`Type: ${fm.type}`);
          if (fm.confidence) meta.push(`Confidence: ${fm.confidence}`);
          if (fm.last_verified) meta.push(`Last verified: ${fm.last_verified}`);
          if (fm.tags) meta.push(`Tags: ${Array.isArray(fm.tags) ? fm.tags.join(', ') : fm.tags}`);
          if (meta.length > 0) {
            output += `[${meta.join(' | ')}]\n\n`;
          }
        }
        output += result.body;
        return output;
      }
    });

    this.register({
      name: 'wiki_write',
      description: 'Create or update a page in the Moltagent Knowledge wiki. Content can include YAML frontmatter between --- delimiters.',
      parameters: {
        type: 'object',
        properties: {
          page_title: { type: 'string', description: 'Page title (e.g. "People/John Smith")' },
          content: { type: 'string', description: 'Page content (markdown, may include frontmatter)' },
          parent: { type: 'string', description: 'Parent section (People, Projects, Procedures, Research, Meta). Used when creating new pages.' },
          type: { type: 'string', description: 'Page type for template (research, person, project, procedure). Auto-generates frontmatter.' }
        },
        required: ['page_title', 'content']
      },
      handler: async (args) => {
        // Parse slash-separated title: "People/John Smith" → parent "People", leaf "John Smith"
        const titleParts = args.page_title.split('/');
        const leafTitle = titleParts[titleParts.length - 1];
        const impliedParent = titleParts.length > 1 ? titleParts[titleParts.length - 2] : null;
        const parentHint = args.parent || impliedParent;

        // Check if page exists
        const existing = await wiki.findPageByTitle(args.page_title);
        let writeContent = args.content;

        // Apply template for new pages with a type specified
        if (!existing && args.type) {
          try {
            const { applyTemplate } = require('../knowledge/page-templates');
            const templated = applyTemplate(args.type, { title: leafTitle });
            if (templated) {
              if (args.content.length < 100) {
                writeContent = templated + '\n' + args.content;
              }
            }
          } catch (err) {
            // Template module not available, use raw content
          }
        }

        if (existing) {
          // Update existing page
          await wiki.writePageContent(existing.path, writeContent);

          // Log to learning log
          if (this.clients.learningLog) {
            try {
              const { parseFrontmatter } = require('../knowledge/frontmatter');
              const { frontmatter: fm } = parseFrontmatter(writeContent);
              this.clients.learningLog.logKnowledgeChange('updated', args.page_title, { confidence: fm.confidence });
            } catch { /* best effort */ }
          }

          return `Updated wiki page "${args.page_title}" at ${existing.path}.`;
        }

        // Create new page: need collective ID and parent
        const collectiveId = await wiki.resolveCollective();
        if (!collectiveId) return 'Could not find the knowledge wiki collective.';
        const pages = await wiki.listPages(collectiveId);
        const allPages = Array.isArray(pages) ? pages : [];

        // Resolve parent page ID (landing page is the root for top-level pages)
        const landingPage = allPages.find(p => p.parentId === 0);
        let parentId = landingPage ? landingPage.id : 0;

        if (parentHint) {
          const parentPage = allPages.find(p =>
            (p.title || '').toLowerCase() === parentHint.toLowerCase()
          );
          if (parentPage) {
            parentId = parentPage.id;
          }
        }

        // Final dedup check: listPages may reveal a page that findPageByTitle missed
        const existingByList = allPages.find(p =>
          (p.title || '').toLowerCase() === leafTitle.toLowerCase()
        );
        if (existingByList) {
          const fallbackPath = existingByList.filePath
            ? `${existingByList.filePath}/${existingByList.fileName}`
            : existingByList.fileName || `${leafTitle}.md`;
          await wiki.writePageContent(fallbackPath, writeContent);
          return `Updated wiki page "${leafTitle}" (dedup: found via list scan).`;
        }

        // Create the page with just the leaf title
        const created = await wiki.createPage(collectiveId, parentId, leafTitle);

        // Use API-returned path for WebDAV write
        const pagePath = created.filePath
          ? `${created.filePath}/${created.fileName}`
          : created.fileName || `${leafTitle}.md`;

        // Write content
        await wiki.writePageContent(pagePath, writeContent);

        // Log to learning log
        if (this.clients.learningLog) {
          try {
            const { parseFrontmatter } = require('../knowledge/frontmatter');
            const { frontmatter: fm } = parseFrontmatter(writeContent);
            this.clients.learningLog.logKnowledgeChange('created', args.page_title, { confidence: fm.confidence });
          } catch { /* best effort */ }
        }

        return `Created wiki page "${leafTitle}" (page #${created.id})${parentHint ? ` under ${parentHint}` : ''}.`;
      }
    });

    this.register({
      name: 'wiki_search',
      description: 'Search the Moltagent Knowledge wiki for pages matching a query.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search term' }
        },
        required: ['query']
      },
      handler: async (args) => {
        const collectiveId = await wiki.resolveCollective();
        if (!collectiveId) return 'Could not find the knowledge wiki collective.';
        const results = await wiki.searchPages(collectiveId, args.query);

        if (!Array.isArray(results) || results.length === 0) {
          return `No wiki pages found matching "${args.query}".`;
        }

        return results.map(p => {
          let line = `- "${p.title}"`;
          if (p.emoji) line += ` ${p.emoji}`;
          if (p.excerpt || p.snippet) line += ` — ${(p.excerpt || p.snippet).substring(0, 100)}`;
          return line;
        }).join('\n');
      }
    });

    this.register({
      name: 'wiki_list',
      description: 'List pages in a section of the Moltagent Knowledge wiki. Sections: People, Projects, Procedures, Research, Meta.',
      parameters: {
        type: 'object',
        properties: {
          section: { type: 'string', description: 'Section name to list (e.g. "People", "Projects"). Omit for root-level pages.' }
        },
        required: []
      },
      handler: async (args) => {
        const collectiveId = await wiki.resolveCollective();
        if (!collectiveId) return 'Could not find the knowledge wiki collective.';
        const pages = await wiki.listPages(collectiveId);

        if (!Array.isArray(pages) || pages.length === 0) {
          return 'The knowledge wiki is empty.';
        }

        // Landing page (parentId 0) is the root; sections are its children
        const landingPage = pages.find(p => p.parentId === 0);
        const landingId = landingPage ? landingPage.id : 0;

        let filtered = pages;
        if (args.section) {
          // Find section page
          const sectionPage = pages.find(p =>
            (p.title || '').toLowerCase() === args.section.toLowerCase()
          );
          if (sectionPage) {
            filtered = pages.filter(p => p.parentId === sectionPage.id);
            if (filtered.length === 0) {
              return `No pages in the "${args.section}" section.`;
            }
          } else {
            const sections = pages.filter(p => p.parentId === landingId).map(p => p.title);
            return `Section "${args.section}" not found. Available sections: ${sections.join(', ')}`;
          }
        } else {
          // Root-level pages = children of landing page
          filtered = pages.filter(p => p.parentId === landingId);
        }

        return filtered.map(p => {
          let line = `- "${p.title}"`;
          if (p.emoji) line += ` ${p.emoji}`;
          // Count children
          const childCount = pages.filter(c => c.parentId === p.id).length;
          if (childCount > 0) line += ` (${childCount} subpages)`;
          return line;
        }).join('\n');
      }
    });
  }

  // ---- WEB TOOLS ------------------------------------------------------------

  /** @private */
  _registerWebTools() {
    const searxng = this.clients.searxngClient;
    const webReader = this.clients.webReader;
    const searchAdapters = this.clients.searchAdapters; // { brave, perplexity, exa } — may be undefined

    if (searxng) {
      this.register({
        name: 'web_search',
        description: 'Search the web via SearXNG (default) or commercial providers. Use provider="multi" to query all available sources in parallel with deduplication.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            limit: { type: 'number', description: 'Max results (default: 5)' },
            engines: { type: 'string', description: 'Comma-separated engines (e.g. "duckduckgo,stract")' },
            categories: { type: 'string', description: 'Category filter (general, news, science, it, etc.)' },
            time_range: { type: 'string', description: 'Time filter (day, week, month, year)' },
            provider: {
              type: 'string',
              description: 'Search provider: "searxng" (default sovereign), "brave", "perplexity", "exa", "multi" (all available in parallel)',
              enum: ['searxng', 'brave', 'perplexity', 'exa', 'multi']
            }
          },
          required: ['query']
        },
        handler: async (args) => {
          const provider = args.provider || 'searxng';

          // --- Commercial provider shortcut ---
          if (provider !== 'searxng' && provider !== 'multi' && searchAdapters?.[provider]) {
            const adapter = searchAdapters[provider];
            const results = await adapter.search(args.query, { maxResults: args.limit || 5 });
            if (results.length === 0) {
              return `No results found for "${args.query}" via ${provider}.`;
            }
            const lines = [`Found ${results.length} result(s) for "${args.query}" via ${provider}:\n`];
            for (const r of results) {
              lines.push(`**${r.title}**\n${r.url}\n${r.snippet || ''}\n`);
            }
            return lines.join('\n');
          }

          // --- Unconfigured provider ---
          if (provider !== 'searxng' && provider !== 'multi') {
            const available = ['searxng'];
            if (searchAdapters) available.push(...Object.keys(searchAdapters));
            available.push('multi');
            return `Provider "${provider}" is not configured. Available: ${available.join(', ')}.`;
          }

          // --- Multi-source search ---
          if (provider === 'multi') {
            const { multiSourceSearch } = require('../integrations/search-provider-adapters');

            // Build SearXNG as a provider-compatible wrapper
            const searxngWrapper = {
              source: 'searxng',
              search: async (q, opts) => {
                const res = await searxng.search(q, { limit: opts?.maxResults });
                return res.results.map(r => ({
                  title: r.title,
                  url: r.url,
                  snippet: r.content,
                  source: 'searxng',
                  score: r.score || 0.5
                }));
              }
            };

            const providers = [searxngWrapper];
            if (searchAdapters) {
              for (const adapter of Object.values(searchAdapters)) {
                providers.push(adapter);
              }
            }

            const merged = await multiSourceSearch(providers, args.query, args.limit || 10);
            if (merged.length === 0) {
              return `No results found for "${args.query}" across all providers.`;
            }
            const lines = [`Found ${merged.length} result(s) for "${args.query}" (multi-source):\n`];
            for (const r of merged) {
              const srcTag = r.sources?.length > 1 ? ` [${r.sources.join(', ')}]` : ` [${r.source}]`;
              lines.push(`**${r.title}**${srcTag}\n${r.url}\n${r.snippet || ''}\n`);
            }
            return lines.join('\n');
          }

          // --- Default: SearXNG only ---
          const results = await searxng.search(args.query, {
            limit: args.limit,
            engines: args.engines,
            categories: args.categories,
            time_range: args.time_range
          });

          if (results.results.length === 0) {
            return `No results found for "${args.query}".`;
          }

          const lines = [`Found ${results.results.length} result(s) for "${args.query}":\n`];
          for (const r of results.results) {
            lines.push(`**${r.title}**\n${r.url}\n${r.content}\n`);
          }
          return lines.join('\n');
        }
      });
    }

    if (webReader) {
      this.register({
        name: 'web_read',
        description: 'Fetch and extract readable content from a URL. Returns article text, title, and metadata.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'URL to read' }
          },
          required: ['url']
        },
        handler: async (args) => {
          const result = await webReader.read(args.url);
          let output = `**${result.title}**\nSource: ${result.url}\n\n${result.content}`;
          if (result.truncated) {
            output += '\n\n(Content was truncated due to length)';
          }
          return output;
        }
      });
    }
  }
  // ---- CONTACTS TOOLS -------------------------------------------------------

  /** @private */
  _registerContactsTools() {
    const contacts = this.clients.contactsClient;
    if (!contacts) return;

    this.register({
      name: 'contacts_search',
      description: 'Search Nextcloud Contacts (address book) by name. Returns matching contacts with name, email, phone, and organization. Use when you need to find someone\'s email or contact details.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Name or partial name to search for (e.g. "Joao", "Silva", "Joao Silva")'
          }
        },
        required: ['query']
      },
      handler: async (args) => {
        try {
          const results = await contacts.search(args.query);

          if (results.length === 0) {
            return `No contacts found matching "${args.query}".`;
          }

          if (results.length === 1) {
            const c = results[0];
            const email = c.email || '(no email)';
            const phone = c.phone ? `\n   Phone: ${c.phone}` : '';
            const org = c.org || '';
            const href = c.href ? `\n   href: ${c.href}` : '';
            return `Found 1 contact:\n\n1. ${c.name} <${email}>${org ? ' — ' + org : ''}${phone}${href}`;
          }

          // Multiple results
          const lines = [`Found ${results.length} contacts:\n`];
          for (let i = 0; i < results.length; i++) {
            const c = results[i];
            const email = c.email || '(no email)';
            const phone = c.phone ? `\n   Phone: ${c.phone}` : '';
            const org = c.org || '';
            const href = c.href ? `\n   href: ${c.href}` : '';
            lines.push(`${i + 1}. ${c.name} <${email}>${org ? ' — ' + org : ''}${phone}${href}`);
          }
          return lines.join('\n');
        } catch (err) {
          return `Failed to search contacts: ${err.message}`;
        }
      }
    });

    this.register({
      name: 'contacts_get',
      description: 'Get full details for a specific contact by their CardDAV href. Use after contacts_search to get complete contact information.',
      parameters: {
        type: 'object',
        properties: {
          href: {
            type: 'string',
            description: 'CardDAV href path returned from contacts_search'
          }
        },
        required: ['href']
      },
      handler: async (args) => {
        try {
          const contact = await contacts.get(args.href);

          if (!contact) {
            return `Contact not found at: ${args.href}`;
          }

          const lines = [`Contact: ${contact.name}`];
          if (contact.uid) lines.push(`UID: ${contact.uid}`);
          if (contact.org) lines.push(`Organization: ${contact.org}`);
          if (contact.title) lines.push(`Title: ${contact.title}`);

          // All email addresses
          if (contact.emails && contact.emails.length > 0) {
            lines.push(`\nEmail addresses:`);
            for (const email of contact.emails) {
              lines.push(`  - ${email.value} (${email.type})`);
            }
          } else if (contact.email) {
            lines.push(`\nEmail: ${contact.email}`);
          }

          // All phone numbers
          if (contact.phones && contact.phones.length > 0) {
            lines.push(`\nPhone numbers:`);
            for (const phone of contact.phones) {
              lines.push(`  - ${phone.value} (${phone.type})`);
            }
          } else if (contact.phone) {
            lines.push(`\nPhone: ${contact.phone}`);
          }

          return lines.join('\n');
        } catch (err) {
          return `Failed to retrieve contact: ${err.message}`;
        }
      }
    });
  }
  // ---- MEMORY SEARCH TOOLS -------------------------------------------------

  /** @private */
  _registerMemorySearchTools() {
    const searcher = this.clients.memorySearcher;
    if (!searcher) return;

    this.register({
      name: 'memory_search',
      description: 'Search across your knowledge wiki, Talk conversations, files, tasks, and calendar. Use to recall past decisions, people, project details, conversations, or events. Supports time filtering with since/until.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Natural language search query (e.g., "budget decision", "meeting with Carlos")'
          },
          scope: {
            type: 'string',
            description: 'Limit search to a specific source',
            enum: ['all', 'wiki', 'people', 'projects', 'sessions', 'policies', 'conversations', 'files', 'tasks', 'calendar']
          },
          since: {
            type: 'string',
            description: 'Only return results from after this date (ISO format, e.g., "2026-01-01")'
          },
          until: {
            type: 'string',
            description: 'Only return results from before this date (ISO format, e.g., "2026-02-01")'
          }
        },
        required: ['query']
      },
      handler: async (args) => {
        const results = await searcher.search(
          args.query,
          {
            scope: args.scope || 'all',
            maxResults: 5,
            since: args.since,
            until: args.until
          }
        );

        if (results.length === 0) {
          return 'No matching memories found.';
        }

        // Format results for the LLM with source labels
        const formatted = results.map(r => {
          const parts = [`**${r.title}** [${r.source}]`];
          if (r.excerpt) parts.push(r.excerpt);
          if (r.link) parts.push(`Link: ${r.link}`);
          return parts.join('\n');
        }).join('\n\n');

        return formatted;
      }
    });
  }
  // ---- WORKFLOW DECK TOOLS --------------------------------------------------

  /**
   * Register workflow-aware Deck tools that accept raw numeric IDs.
   * These bypass the default board resolution and work on any board,
   * which is required for workflow processing across arbitrary boards.
   * @private
   */
  _registerWorkflowDeckTools() {
    const nc = this.clients.ncRequestManager;
    if (!nc) return;

    this.register({
      name: 'workflow_deck_move_card',
      description: 'Move a card to a different stack using raw numeric IDs. Use this in workflow processing to move cards between stacks on any board.',
      parameters: {
        type: 'object',
        properties: {
          card_id: { type: 'number', description: 'Numeric card ID' },
          target_stack_id: { type: 'number', description: 'Numeric target stack ID' },
          order: { type: 'number', description: 'Position in target stack (default: 0 = top)' }
        },
        required: ['card_id', 'target_stack_id']
      },
      handler: async (args) => {
        await nc.request(`/index.php/apps/deck/cards/${args.card_id}/reorder`, {
          method: 'PUT',
          body: { stackId: args.target_stack_id, order: args.order || 0 }
        });
        return `Moved card ${args.card_id} to stack ${args.target_stack_id}.`;
      }
    });

    this.register({
      name: 'workflow_deck_add_comment',
      description: 'Add a comment to a card using its numeric ID. Use this in workflow processing to log actions on cards in any board.',
      parameters: {
        type: 'object',
        properties: {
          card_id: { type: 'number', description: 'Numeric card ID' },
          message: { type: 'string', description: 'Comment text' }
        },
        required: ['card_id', 'message']
      },
      handler: async (args) => {
        await nc.request(`/ocs/v2.php/apps/deck/api/v1.0/cards/${args.card_id}/comments`, {
          method: 'POST',
          body: { message: args.message }
        });
        return `Added comment to card ${args.card_id}.`;
      }
    });

    this.register({
      name: 'workflow_deck_create_card',
      description: 'Create a card on any board using raw numeric board and stack IDs. Use this in workflow processing to spawn cards across boards.',
      parameters: {
        type: 'object',
        properties: {
          board_id: { type: 'number', description: 'Numeric board ID' },
          stack_id: { type: 'number', description: 'Numeric stack ID' },
          title: { type: 'string', description: 'Card title' },
          description: { type: 'string', description: 'Card description (optional)' }
        },
        required: ['board_id', 'stack_id', 'title']
      },
      handler: async (args) => {
        const response = await nc.request(
          `/index.php/apps/deck/api/v1.0/boards/${args.board_id}/stacks/${args.stack_id}/cards`,
          {
            method: 'POST',
            body: {
              title: args.title,
              type: 'plain',
              order: 0,
              description: args.description || ''
            }
          }
        );
        const card = response.body || response;
        return `Created card "${args.title}" (ID: ${card.id || 'unknown'}) in board ${args.board_id}, stack ${args.stack_id}.`;
      }
    });

    this.register({
      name: 'workflow_deck_update_card',
      description: 'Update a card on any board using raw numeric IDs. Use this in workflow processing to modify card title, description, or due date.',
      parameters: {
        type: 'object',
        properties: {
          card_id: { type: 'number', description: 'Numeric card ID' },
          board_id: { type: 'number', description: 'Numeric board ID' },
          stack_id: { type: 'number', description: 'Numeric stack ID' },
          title: { type: 'string', description: 'New title (optional)' },
          description: { type: 'string', description: 'New description (optional)' },
          duedate: { type: 'string', description: 'New due date ISO format, or null to clear (optional)' }
        },
        required: ['card_id', 'board_id', 'stack_id']
      },
      handler: async (args) => {
        // Fetch current card to preserve unchanged fields
        const current = await nc.request(
          `/index.php/apps/deck/api/v1.0/boards/${args.board_id}/stacks/${args.stack_id}/cards/${args.card_id}`,
          { method: 'GET' }
        );
        const cardData = current.body || current;

        const updates = {
          title: args.title || cardData.title,
          type: cardData.type || 'plain',
          owner: cardData.owner?.uid || cardData.owner || '',
          description: args.description !== undefined ? args.description : (cardData.description || ''),
          duedate: args.duedate !== undefined ? args.duedate : (cardData.duedate || null)
        };

        await nc.request(
          `/index.php/apps/deck/api/v1.0/boards/${args.board_id}/stacks/${args.stack_id}/cards/${args.card_id}`,
          { method: 'PUT', body: updates }
        );

        const changes = [];
        if (args.title) changes.push(`title: "${args.title}"`);
        if (args.description !== undefined) changes.push('description updated');
        if (args.duedate !== undefined) changes.push(`due: ${args.duedate}`);

        return `Updated card ${args.card_id}.${changes.length ? ' Changes: ' + changes.join(', ') + '.' : ''}`;
      }
    });
  }
}

module.exports = { ToolRegistry };
