/**
 * Moltagent NC Deck Client
 *
 * API client for Nextcloud Deck integration.
 * Enables task management via kanban board.
 *
 * Now uses NCRequestManager for all API calls.
 *
 * @module deck-client
 * @version 2.0.0
 */

const appConfig = require('../config');
const DECK = require('../../config/deck-names');
const boardRegistry = require('./deck-board-registry');
const { ROLES } = require('./deck-board-registry');

/**
 * Custom error class for Deck API errors
 */
/**
 * Prefixes used by Moltagent bot comments.
 * Used to distinguish bot comments from human comments in scanners.
 * @type {string[]}
 */
const BOT_PREFIXES = ['[STATUS]', '[PROGRESS]', '[DONE]', '[QUESTION]', '[ERROR]', '[BLOCKED]', '[REVIEW]', '[FOLLOWUP]', '[MENTION]', '[GATE]', '[RETRY]'];

/**
 * Check if the bot has already responded to the most recent human comment.
 * Uses comment IDs for ordering (higher ID = newer), so works regardless of
 * array sort order.
 *
 * @param {Array} comments - Comments array (any order)
 * @param {string} botUsername - Bot username (case-insensitive)
 * @returns {boolean} true if the bot posted a response after the latest human comment
 */
function hasNewerBotResponse(comments, botUsername) {
  if (!comments || comments.length === 0) return false;
  const botUser = botUsername.toLowerCase();

  let latestHumanId = -1;
  let latestBotId = -1;

  for (const comment of comments) {
    const msg = comment.message || '';
    const isBot = BOT_PREFIXES.some(p => msg.startsWith(p)) ||
                  (comment.actorId || '').toLowerCase() === botUser;
    const id = comment.id || 0;

    if (isBot) {
      if (id > latestBotId) latestBotId = id;
    } else {
      if (id > latestHumanId) latestHumanId = id;
    }
  }

  // No human comments → nothing to respond to (treated as already responded)
  if (latestHumanId === -1) return true;
  // No bot comments → hasn't responded yet
  if (latestBotId === -1) return false;
  // Bot responded after the latest human comment
  return latestBotId > latestHumanId;
}

/**
 * Patterns in bot comments that indicate the bot is waiting for a human response.
 * If the most recent comment is from the bot AND matches one of these, the card
 * should be skipped on heartbeat to avoid reprocessing loops.
 * @type {RegExp[]}
 */
const AWAITING_PATTERNS = [
  /^\[QUESTION\]/,
  /^\[GATE\]/,
  /^\[BLOCKED\]/,
  /confirm the action/i,
  /please confirm/i,
  /awaiting.*(?:approval|confirmation|response)/i
];

/**
 * Check if the bot is waiting for a human response on a card.
 * Returns true when the most recent comment (by ID) is from the bot and
 * contains a question/gate/confirmation-request pattern.
 *
 * The inverse: if the most recent comment is from a human, returns false
 * (the human has replied — the card should be processed).
 *
 * @param {Array} comments - Comments array (any order)
 * @param {string} botUsername - Bot username (case-insensitive)
 * @returns {boolean} true if the bot posted a question/gate and nobody has replied yet
 */
function isAwaitingHumanResponse(comments, botUsername) {
  if (!comments || comments.length === 0) return false;
  const botUser = botUsername.toLowerCase();

  // Find the most recent comment by ID
  let latest = null;
  for (const comment of comments) {
    if (!latest || (comment.id || 0) > (latest.id || 0)) {
      latest = comment;
    }
  }
  if (!latest) return false;

  // Check if it's a bot comment
  const msg = latest.message || '';
  const isBot = BOT_PREFIXES.some(p => msg.startsWith(p)) ||
                (latest.actorId || '').toLowerCase() === botUser;

  if (!isBot) return false; // Last comment is human → not awaiting

  // Check if the bot comment is a question/gate/confirmation request
  return AWAITING_PATTERNS.some(pat => pat.test(msg));
}

/**
 * Custom error class for Deck API errors
 */
class DeckApiError extends Error {
  constructor(message, statusCode = 0, response = null) {
    super(message);
    this.name = 'DeckApiError';
    this.statusCode = statusCode;
    this.response = response;
  }
}

class DeckClient {
  /**
   * Create a new Deck client
   * @param {Object} ncRequestManagerOrConfig - NCRequestManager instance or legacy config
   * @param {Object} [config] - Configuration object (new signature)
   * @param {string} [config.boardName] - Board name
   * @param {Object} [config.stacks] - Stack configuration
   */
  constructor(ncRequestManagerOrConfig, config = {}) {
    // Support both new (ncRequestManager, config) and legacy (config) signatures
    if (ncRequestManagerOrConfig && typeof ncRequestManagerOrConfig.request === 'function') {
      // New signature
      this.nc = ncRequestManagerOrConfig;
      this.baseUrl = this.nc.ncUrl;
      this.username = this.nc.ncUser || 'moltagent';

      // Board configuration
      this.boardName = config.boardName || config.deck?.boardName || DECK.boards.tasks;
      this.archiveAfterDays = config.archiveAfterDays || config.deck?.archiveAfterDays || appConfig.deck.archiveAfterDays;
      this.role = config.role || null;
    } else {
      // Legacy signature: (config)
      const legacyConfig = ncRequestManagerOrConfig || {};
      this.nc = null;
      this.baseUrl = legacyConfig.nextcloud?.url?.replace(/\/$/, '') || '';
      this.credentialBroker = legacyConfig.credentialBroker;
      this.username = legacyConfig.nextcloud?.username || 'moltagent';

      // Board configuration
      this.boardName = legacyConfig.deck?.boardName || DECK.boards.tasks;
      this.archiveAfterDays = legacyConfig.deck?.archiveAfterDays || appConfig.deck.archiveAfterDays;
      this.role = null; // legacy clients don't use registry
    }

    // Stack names (order matters for creation)
    this.stackNames = config.stacks || config.deck?.stacks || {
      inbox: DECK.stacks.inbox,
      queued: DECK.stacks.queued,
      working: DECK.stacks.working,
      review: DECK.stacks.review,
      done: DECK.stacks.done,
      reference: 'Reference'
    };

    // Label definitions
    this.labelDefs = config.labels || config.deck?.labels || [
      { title: 'urgent', color: 'ED1C24' },
      { title: 'research', color: '0082C9' },
      { title: 'writing', color: '2ECC71' },
      { title: 'admin', color: '7F8C8D' },
      { title: 'blocked', color: 'F39C12' }
    ];

    // Cache for board/stack IDs
    this._cache = {
      boardId: null,
      stacks: {},
      labels: {},
      lastRefresh: 0
    };
    this._cacheMaxAge = 300000; // 5 minutes

    // Board classification cache: boardId → 'moltagent-tasks' | 'cockpit' | 'personal' | 'project'
    this._boardTypes = new Map();
    this._boardTypesLastRefresh = 0;
    this._boardTypesCacheMaxAge = 300000; // 5 minutes

    // PAUSED-stack cache: "boardId/stackId" → { paused: bool, ts: number }
    this._pausedCache = new Map();
    this._pausedCacheTTL = 120000; // 2 minutes
  }

  // ============================================================
  // BOARD CLASSIFICATION
  // ============================================================

  /**
   * Board type constants
   */
  static get BOARD_TYPES() {
    return {
      MOLTAGENT_TASKS: 'moltagent-tasks',
      COCKPIT: 'cockpit',
      PERSONAL: 'personal',
      PROJECT: 'project'
    };
  }

  /**
   * Classify a board by its title using config overrides + title matching.
   * @param {Object} board - Board object with at least { id, title }
   * @returns {string} Board type: 'moltagent-tasks' | 'cockpit' | 'personal' | 'project'
   */
  classifyBoard(board) {
    // Check registry first (survives renames)
    const all = boardRegistry.getAll();
    for (const [role, entry] of Object.entries(all)) {
      if (entry.boardId === board.id) {
        if (role === ROLES.tasks)    return DeckClient.BOARD_TYPES.MOLTAGENT_TASKS;
        if (role === ROLES.cockpit)  return DeckClient.BOARD_TYPES.COCKPIT;
        if (role === ROLES.personal) return DeckClient.BOARD_TYPES.PERSONAL;
      }
    }

    // Fallback: title-based classification
    const title = (board.title || '').toLowerCase().trim();
    const cfg = appConfig.deck;

    if (title === (cfg.taskBoardTitle || DECK.boards.tasks).toLowerCase().trim()) {
      return DeckClient.BOARD_TYPES.MOLTAGENT_TASKS;
    }
    if (title === (cfg.cockpitBoardTitle || DECK.boards.cockpit).toLowerCase().trim()) {
      return DeckClient.BOARD_TYPES.COCKPIT;
    }
    if (title === (cfg.personalBoardTitle || DECK.boards.personal).toLowerCase().trim()) {
      return DeckClient.BOARD_TYPES.PERSONAL;
    }
    return DeckClient.BOARD_TYPES.PROJECT;
  }

  /**
   * Get classified board types for all accessible boards.
   * Caches results for 5 minutes.
   * @returns {Promise<Map<number, {id: number, title: string, type: string}>>} Map of boardId → board info with type
   */
  async getClassifiedBoards() {
    if (this._boardTypes.size > 0 && Date.now() - this._boardTypesLastRefresh < this._boardTypesCacheMaxAge) {
      return this._boardTypes;
    }

    const boards = await this.listBoards();
    this._boardTypes.clear();

    for (const board of boards) {
      this._boardTypes.set(board.id, {
        id: board.id,
        title: board.title,
        type: this.classifyBoard(board)
      });
    }

    this._boardTypesLastRefresh = Date.now();
    return this._boardTypes;
  }

  /**
   * Get the board type for a specific board ID.
   * @param {number} boardId - Board ID
   * @returns {Promise<string>} Board type
   */
  async getBoardType(boardId) {
    const classified = await this.getClassifiedBoards();
    const entry = classified.get(boardId);
    return entry ? entry.type : DeckClient.BOARD_TYPES.PROJECT;
  }

  // ============================================================
  // HTTP REQUEST
  // ============================================================

  /**
   * Make an HTTP request to the Deck API
   * @private
   */
  async _request(method, path, body = null) {
    // Use NCRequestManager if available
    if (this.nc) {
      const response = await this.nc.request(path, {
        method,
        body,
        headers: {
          'OCS-APIRequest': 'true',
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        }
      });

      // Handle responses
      if (response.status >= 200 && response.status < 300) {
        return response.body || { success: true, statusCode: response.status };
      }

      const message = response.body?.message || response.body?.error || `HTTP ${response.status}`;
      throw new DeckApiError(message, response.status, response.body);
    }

    // Legacy fallback (should not be used in new architecture)
    throw new Error('DeckClient requires NCRequestManager');
  }

  // ============================================================
  // BOARD MANAGEMENT
  // ============================================================

  /**
   * List all boards accessible to the user
   * @returns {Promise<Array>} Array of board objects
   */
  async listBoards() {
    return await this._request('GET', '/index.php/apps/deck/api/v1.0/boards');
  }

  /**
   * Find the Moltagent Tasks board by name
   * @returns {Promise<Object|null>} Board object or null
   */
  async findBoard() {
    // Registry-based resolution when role is set
    if (this.role) {
      const boardId = await boardRegistry.resolveBoard(this, this.role, this.boardName);
      if (boardId) {
        try {
          return await this.getBoard(boardId);
        } catch (err) {
          // Board was deleted — invalidate and fall through to name scan
          if (err.statusCode === 404) {
            boardRegistry.invalidateBoard(this.role);
          } else {
            throw err;
          }
        }
      }
    }
    // Fallback: name-based scan
    const boards = await this.listBoards();
    const board = boards.find(b => b.title === this.boardName) || null;
    if (board && this.role) {
      boardRegistry.registerBoard(this.role, board.id);
    }
    return board;
  }

  /**
   * Get full board details including stacks
   * @param {number} boardId - Board ID
   * @returns {Promise<Object>} Full board object with stacks
   */
  async getBoard(boardId) {
    return await this._request('GET', `/index.php/apps/deck/api/v1.0/boards/${boardId}`);
  }

  /**
   * Create the Moltagent Tasks board with all required stacks and labels
   * @returns {Promise<Object>} Object with boardId and stacks mapping
   */
  async createBoard() {
    console.log(`[Deck] Creating board: ${this.boardName}`);

    // Create board
    const board = await this._request('POST', '/index.php/apps/deck/api/v1.0/boards', {
      title: this.boardName,
      color: '0082c9' // Nextcloud blue
    });

    if (this.role) {
      boardRegistry.registerBoard(this.role, board.id);
    }

    const boardId = board.id;
    console.log(`[Deck] Board created with ID: ${boardId}`);

    // Create stacks in order
    const stackOrder = Object.keys(this.stackNames);
    const stacks = {};

    for (let i = 0; i < stackOrder.length; i++) {
      const key = stackOrder[i];
      const title = this.stackNames[key];

      const stack = await this._request(
        'POST',
        `/index.php/apps/deck/api/v1.0/boards/${boardId}/stacks`,
        { title, order: i }
      );

      stacks[key] = stack.id;
      console.log(`[Deck] Stack created: ${title} (ID: ${stack.id})`);
    }

    // Create labels
    const labels = {};
    for (const labelDef of this.labelDefs) {
      const label = await this._request(
        'POST',
        `/index.php/apps/deck/api/v1.0/boards/${boardId}/labels`,
        labelDef
      );
      labels[labelDef.title] = label.id;
      console.log(`[Deck] Label created: ${labelDef.title} (ID: ${label.id})`);
    }

    // Update cache
    this._cache = {
      boardId,
      stacks,
      labels,
      lastRefresh: Date.now()
    };

    return { boardId, stacks, labels, created: true };
  }

  /**
   * Share a board with a user or group
   * @param {number} boardId - Board ID
   * @param {string} participant - NC username or group name
   * @param {number} [type=0] - 0 = user, 1 = group
   * @param {boolean} [permissionEdit=true] - Edit permission
   * @param {boolean} [permissionShare=false] - Share permission
   * @param {boolean} [permissionManage=false] - Manage permission
   * @returns {Promise<Object>} ACL entry object
   */
  async shareBoard(boardId, participant, type = 0, permissionEdit = true, permissionShare = false, permissionManage = false) {
    return await this._request('POST', `/index.php/apps/deck/api/v1.0/boards/${boardId}/acl`, {
      type,
      participant,
      permissionEdit,
      permissionShare,
      permissionManage
    });
  }

  /**
   * Share a board with a user granting full permissions (edit, share, manage).
   * Convenience wrapper over shareBoard() for admin-level sharing.
   * @param {number} boardId
   * @param {string} username - NC username to share with
   * @returns {Promise<Object>} ACL entry object
   */
  async shareBoardWithUser(boardId, username) {
    if (!boardId || !username) throw new DeckApiError('boardId and username are required');
    return await this.shareBoard(boardId, username, 0, true, true, true);
  }

  // ============================================================
  // GENERIC BOARD CRUD (v2 — any board, not just Moltagent Tasks)
  // ============================================================

  /**
   * Create a new board with a given title and color.
   * Unlike createBoard(), this does NOT auto-create stacks or labels.
   * @param {string} title - Board name
   * @param {string} [color='0800fd'] - Hex color (no #)
   * @returns {Promise<Object>} Created board with id, title, color
   */
  async createNewBoard(title, color = '0800fd') {
    if (!title || typeof title !== 'string') {
      throw new DeckApiError('Board title is required');
    }
    return await this._request('POST', '/index.php/apps/deck/api/v1.0/boards', { title, color });
  }

  /**
   * Update board properties (title, color, archived).
   * @param {number} boardId
   * @param {Object} updates - { title?, color?, archived? }
   * @returns {Promise<Object>} Updated board
   */
  async updateBoard(boardId, updates) {
    if (!boardId) throw new DeckApiError('boardId is required');
    return await this._request('PUT', `/index.php/apps/deck/api/v1.0/boards/${boardId}`, updates);
  }

  /**
   * Delete a board permanently.
   * @param {number} boardId
   * @returns {Promise<void>}
   */
  async deleteBoard(boardId) {
    if (!boardId) throw new DeckApiError('boardId is required');
    return await this._request('DELETE', `/index.php/apps/deck/api/v1.0/boards/${boardId}`);
  }

  /**
   * Archive a board (soft delete — recoverable).
   * @param {number} boardId
   * @returns {Promise<Object>} Updated board with archived: true
   */
  async archiveBoard(boardId) {
    return await this.updateBoard(boardId, { archived: true });
  }

  // ============================================================
  // GENERIC STACK CRUD (v2 — any board)
  // ============================================================

  /**
   * Update a stack (rename, reorder).
   * @param {number} boardId
   * @param {number} stackId
   * @param {Object} updates - { title?, order? }
   * @returns {Promise<Object>} Updated stack
   */
  async updateStack(boardId, stackId, updates) {
    if (!boardId || !stackId) throw new DeckApiError('boardId and stackId are required');
    return await this._request('PUT',
      `/index.php/apps/deck/api/v1.0/boards/${boardId}/stacks/${stackId}`, updates);
  }

  /**
   * Delete a stack and all its cards.
   * @param {number} boardId
   * @param {number} stackId
   * @returns {Promise<void>}
   */
  async deleteStack(boardId, stackId) {
    if (!boardId || !stackId) throw new DeckApiError('boardId and stackId are required');
    return await this._request('DELETE',
      `/index.php/apps/deck/api/v1.0/boards/${boardId}/stacks/${stackId}`);
  }

  /**
   * Check if a stack's CONFIG card has the PAUSED label.
   * Cached for 2 minutes per board/stack pair.
   * @param {number} boardId
   * @param {number} stackId
   * @returns {Promise<boolean>}
   */
  async _isStackPaused(boardId, stackId) {
    const key = `${boardId}/${stackId}`;
    const cached = this._pausedCache.get(key);
    if (cached && Date.now() - cached.ts < this._pausedCacheTTL) return cached.paused;

    try {
      const stack = await this._request('GET',
        `/index.php/apps/deck/api/v1.0/boards/${boardId}/stacks/${stackId}`);
      const configCard = (stack.cards || []).find(c =>
        typeof c.title === 'string' && c.title.toUpperCase().startsWith('CONFIG:'));
      const paused = configCard
        ? (configCard.labels || []).some(l =>
          typeof l.title === 'string' && l.title.toUpperCase() === 'PAUSED')
        : false;
      this._pausedCache.set(key, { paused, ts: Date.now() });
      return paused;
    } catch {
      return false; // API failure → don't block creation
    }
  }

  /**
   * Create a card on any board/stack by IDs (not just default Moltagent board).
   * Unlike createCard(stackName, card), this uses raw IDs for board-agnostic creation.
   * Refuses to create if the stack's CONFIG card has the PAUSED label.
   * @param {number} boardId - Board ID
   * @param {number} stackId - Stack ID
   * @param {string} title - Card title
   * @param {Object} [opts] - { description? }
   * @returns {Promise<Object|null>} Created card, or null if stack is PAUSED
   */
  async createCardOnBoard(boardId, stackId, title, opts = {}) {
    if (!boardId || !stackId) throw new DeckApiError('boardId and stackId are required');
    if (!title || typeof title !== 'string') throw new DeckApiError('Card title is required');

    if (await this._isStackPaused(boardId, stackId)) {
      console.warn(`[Deck] Refusing card creation in PAUSED stack (board=${boardId}, stack=${stackId}): "${title}"`);
      return null;
    }

    return await this._request('POST',
      `/index.php/apps/deck/api/v1.0/boards/${boardId}/stacks/${stackId}/cards`,
      { title, description: opts.description || '', type: 'plain', order: 0 });
  }

  /**
   * Ensure the board exists with all required stacks
   * Creates if missing, verifies structure if exists
   * @returns {Promise<Object>} Object with boardId and stacks mapping
   */
  async ensureBoard() {
    // Check cache first
    if (this._cache.boardId && Date.now() - this._cache.lastRefresh < this._cacheMaxAge) {
      return {
        boardId: this._cache.boardId,
        stacks: this._cache.stacks,
        labels: this._cache.labels
      };
    }

    let board = await this.findBoard();

    if (!board) {
      console.log('[Deck] Moltagent Tasks board not found, creating...');
      return await this.createBoard();
    }

    // Board exists, get full details
    const fullBoard = await this.getBoard(board.id);

    // Map stack names to IDs
    const stacks = {};
    for (const stack of fullBoard.stacks || []) {
      const key = Object.keys(this.stackNames).find(
        k => this.stackNames[k].toLowerCase() === stack.title.toLowerCase()
      );
      if (key) {
        stacks[key] = stack.id;
      }
    }

    // Check for missing stacks and create them
    const existingOrder = (fullBoard.stacks || []).length;
    const stackKeys = Object.keys(this.stackNames);

    for (let i = 0; i < stackKeys.length; i++) {
      const key = stackKeys[i];
      if (!stacks[key]) {
        console.log(`[Deck] Creating missing stack: ${this.stackNames[key]}`);
        const stack = await this._request(
          'POST',
          `/index.php/apps/deck/api/v1.0/boards/${board.id}/stacks`,
          { title: this.stackNames[key], order: existingOrder + i }
        );
        stacks[key] = stack.id;
      }
    }

    // Map labels
    const labels = {};
    for (const label of fullBoard.labels || []) {
      labels[label.title.toLowerCase()] = label.id;
    }

    // Check for missing labels and create them
    for (const labelDef of this.labelDefs) {
      if (!labels[labelDef.title]) {
        console.log(`[Deck] Creating missing label: ${labelDef.title}`);
        const label = await this._request(
          'POST',
          `/index.php/apps/deck/api/v1.0/boards/${board.id}/labels`,
          labelDef
        );
        labels[labelDef.title] = label.id;
      }
    }

    // Update cache
    this._cache = {
      boardId: board.id,
      stacks,
      labels,
      lastRefresh: Date.now()
    };

    return { boardId: board.id, stacks, labels };
  }

  // ============================================================
  // INTERNAL HELPERS
  // ============================================================

  /**
   * Get cached IDs, refreshing if stale
   * @private
   */
  async _getIds() {
    if (!this._cache.boardId || Date.now() - this._cache.lastRefresh > this._cacheMaxAge) {
      await this.ensureBoard();
    }
    return {
      boardId: this._cache.boardId,
      stacks: this._cache.stacks,
      labels: this._cache.labels
    };
  }

  /**
   * Resolve stack name to ID
   * @private
   */
  async _resolveStackId(stackName) {
    const { stacks } = await this._getIds();
    const stackId = stacks[stackName];
    if (!stackId) {
      throw new DeckApiError(`Unknown stack: ${stackName}. Valid stacks: ${Object.keys(stacks).join(', ')}`);
    }
    return stackId;
  }

  // ============================================================
  // STACK OPERATIONS
  // ============================================================

  /**
   * Get all cards in a specific stack
   * @param {string} stackName - Stack name (inbox, queued, working, done, reference)
   * @returns {Promise<Array>} Array of card objects
   */
  async getCardsInStack(stackName) {
    const { boardId, stacks } = await this._getIds();
    const stackId = stacks[stackName];

    if (!stackId) {
      throw new DeckApiError(`Unknown stack: ${stackName}`);
    }

    const stack = await this._request(
      'GET',
      `/index.php/apps/deck/api/v1.0/boards/${boardId}/stacks/${stackId}`
    );

    return stack.cards || [];
  }

  /**
   * Get all cards across all stacks
   * @returns {Promise<Object>} Object mapping stack names to card arrays
   */
  async getAllCards() {
    const { boardId } = await this._getIds();
    // Must use the stacks list endpoint, not getBoard().
    // GET /boards/{id} returns stacks WITHOUT cards.
    // GET /boards/{id}/stacks returns stacks WITH cards.
    const stackList = await this._request('GET', `/index.php/apps/deck/api/v1.0/boards/${boardId}/stacks`);

    const allCards = {};
    for (const stack of stackList || []) {
      const key = Object.keys(this.stackNames).find(
        k => this.stackNames[k].toLowerCase() === stack.title.toLowerCase()
      );
      if (key) {
        allCards[key] = stack.cards || [];
      }
    }

    return allCards;
  }

  /**
   * Get all stacks for a board (with cards)
   * @param {number} boardId - Board ID
   * @returns {Promise<Array>} Array of stack objects
   */
  async getStacks(boardId) {
    return await this._request('GET', `/index.php/apps/deck/api/v1.0/boards/${boardId}/stacks`);
  }

  /**
   * Create a new stack in a board
   * @param {number} boardId - Board ID
   * @param {string} title - Stack title
   * @param {number} [order=999] - Stack order
   * @returns {Promise<Object>} Created stack object
   */
  async createStack(boardId, title, order = 999) {
    return await this._request('POST', `/index.php/apps/deck/api/v1.0/boards/${boardId}/stacks`, { title, order });
  }

  // ============================================================
  // CARD OPERATIONS
  // ============================================================

  /**
   * Create a new card in a stack
   * @param {string} stackName - Target stack name
   * @param {Object} card - Card data
   * @param {string} card.title - Card title
   * @param {string} [card.description] - Card description
   * @param {string} [card.duedate] - Due date (ISO format)
   * @param {Array<string>} [card.labels] - Label names to apply
   * @returns {Promise<Object>} Created card object
   */
  async createCard(stackName, card) {
    const { boardId, stacks, labels } = await this._getIds();
    const stackId = stacks[stackName];

    if (!stackId) {
      throw new DeckApiError(`Unknown stack: ${stackName}`);
    }

    if (await this._isStackPaused(boardId, stackId)) {
      console.warn(`[Deck] Refusing card creation in PAUSED stack "${stackName}" (board=${boardId}): "${card.title}"`);
      return null;
    }

    // TRACE-5: What's being sent to Deck API?
    console.log(`[TRACE-5] Creating card: title="${(card.title || '').substring(0, 60)}", description length: ${(card.description || '').length}`);

    // Create the card
    const newCard = await this._request(
      'POST',
      `/index.php/apps/deck/api/v1.0/boards/${boardId}/stacks/${stackId}/cards`,
      {
        title: card.title,
        description: card.description || '',
        type: 'plain',
        order: 0,
        duedate: card.duedate || null
      }
    );

    // Apply labels if specified
    if (card.labels && card.labels.length > 0) {
      for (const labelName of card.labels) {
        const labelId = labels[labelName.toLowerCase()];
        if (labelId) {
          try {
            await this._request(
              'PUT',
              `/index.php/apps/deck/api/v1.0/boards/${boardId}/stacks/${stackId}/cards/${newCard.id}/assignLabel`,
              { labelId }
            );
          } catch (e) {
            console.warn(`[Deck] Failed to assign label ${labelName}: ${e.message}`);
          }
        }
      }
    }

    console.log(`[Deck] Card created: "${card.title}" in ${stackName} (ID: ${newCard.id})`);
    return newCard;
  }

  /**
   * Mark a card as done without moving it between stacks.
   * Sets the done timestamp — DeckTaskProcessor uses this to fast-track
   * delivery (move to Review, assign, notify) without re-processing.
   * @param {number} cardId
   * @param {string} stackName - Current stack
   */
  async markCardDone(cardId, stackName) {
    const { boardId } = await this._getIds();
    const stackId = await this._resolveStackId(stackName);
    const card = await this.getCard(cardId, stackName);

    await this._request(
      'PUT',
      `/index.php/apps/deck/api/v1.0/boards/${boardId}/stacks/${stackId}/cards/${cardId}`,
      {
        title: card.title,
        type: card.type || 'plain',
        owner: card.owner?.uid || card.owner || this.username,
        description: card.description || '',
        done: new Date().toISOString()
      }
    );
    console.log(`[Deck] Card ${cardId} marked done`);
  }

  /**
   * Get card details
   * @param {number} cardId - Card ID
   * @param {string} stackName - Stack the card is in
   * @returns {Promise<Object>} Card object
   */
  async getCard(cardId, stackName) {
    const { boardId } = await this._getIds();
    const stackId = await this._resolveStackId(stackName);

    return await this._request(
      'GET',
      `/index.php/apps/deck/api/v1.0/boards/${boardId}/stacks/${stackId}/cards/${cardId}`
    );
  }

  /**
   * Update card details
   * @param {number} cardId - Card ID
   * @param {string} stackName - Stack the card is in
   * @param {Object} updates - Fields to update
   * @returns {Promise<Object>} Updated card object
   */
  async updateCard(cardId, stackName, updates) {
    const { boardId } = await this._getIds();
    const stackId = await this._resolveStackId(stackName);

    return await this._request(
      'PUT',
      `/index.php/apps/deck/api/v1.0/boards/${boardId}/stacks/${stackId}/cards/${cardId}`,
      updates
    );
  }

  /**
   * Move a card to a different stack
   * Uses internal endpoint due to API bug (github.com/nextcloud/deck/issues/6960)
   * @param {number} cardId - Card ID
   * @param {string} fromStack - Current stack name
   * @param {string} toStack - Destination stack name
   * @param {number} [order=0] - Position in destination stack (0 = top)
   */
  async moveCard(cardId, fromStack, toStack, order = 0) {
    const { stacks } = await this._getIds();
    const fromStackId = stacks[fromStack];
    const toStackId = stacks[toStack];

    if (!fromStackId) throw new DeckApiError(`Unknown stack: ${fromStack}`);
    if (!toStackId) throw new DeckApiError(`Unknown stack: ${toStack}`);

    // Use internal endpoint (workaround for REST API type casting bug)
    // The /api/v1.0/.../reorder endpoint passes stackId as string, which fails
    // The internal /deck/cards endpoint works correctly
    await this._request(
      'PUT',
      `/index.php/apps/deck/cards/${cardId}/reorder`,
      { stackId: toStackId, order }
    );

    console.log(`[Deck] Card ${cardId} moved: ${fromStack} → ${toStack}`);
  }

  /**
   * Delete (archive) a card
   * @param {number} cardId - Card ID
   * @param {string} stackName - Stack the card is in
   */
  async deleteCard(cardId, stackName) {
    const { boardId } = await this._getIds();
    const stackId = await this._resolveStackId(stackName);

    await this._request(
      'DELETE',
      `/index.php/apps/deck/api/v1.0/boards/${boardId}/stacks/${stackId}/cards/${cardId}`
    );

    console.log(`[Deck] Card ${cardId} deleted`);
  }

  // ============================================================
  // COMMENT OPERATIONS
  // ============================================================

  /**
   * Add a comment to a card
   * Uses the OCS API endpoint for comments
   * @param {number} cardId - Card ID
   * @param {string} message - Comment text
   * @param {string} [type='STATUS'] - Comment type prefix (STATUS, PROGRESS, QUESTION, DONE, ERROR, BLOCKED)
   */
  async addComment(cardId, message, type = 'STATUS', { prefix = true } = {}) {
    const prefixedMessage = prefix ? `[${type}] ${message}` : message;

    try {
      // Comments use the OCS API wrapper, not the direct API
      const response = await this._request(
        'POST',
        `/ocs/v2.php/apps/deck/api/v1.0/cards/${cardId}/comments`,
        { message: prefixedMessage }
      );

      console.log(`[Deck] Comment added to card ${cardId}: [${type}]`);
      return response;
    } catch (err) {
      console.error(`[Deck] addComment failed card=${cardId} status=${err.statusCode || '?'} msgLen=${prefixedMessage.length} body=${JSON.stringify(err.responseBody || err.message).slice(0, 300)}`);
      throw err;
    }
  }

  /**
   * Get all comments on a card
   * Uses the OCS API endpoint for comments
   * @param {number} cardId - Card ID
   * @returns {Promise<Array>} Array of comment objects
   */
  async getComments(cardId) {
    const response = await this._request(
      'GET',
      `/ocs/v2.php/apps/deck/api/v1.0/cards/${cardId}/comments`
    );

    // OCS API returns object with ocs wrapper
    if (response.ocs && response.ocs.data) {
      return Array.isArray(response.ocs.data) ? response.ocs.data : [response.ocs.data];
    }
    return Array.isArray(response) ? response : [];
  }

  // ============================================================
  // LABEL OPERATIONS
  // ============================================================

  /**
   * Add a label to a card
   * @param {number} cardId - Card ID
   * @param {string} stackName - Stack the card is in
   * @param {string} labelName - Label name
   */
  async addLabel(cardId, stackName, labelName) {
    const { boardId, labels } = await this._getIds();
    const stackId = await this._resolveStackId(stackName);
    const labelId = labels[labelName.toLowerCase()];

    if (!labelId) {
      throw new DeckApiError(`Unknown label: ${labelName}`);
    }

    await this._request(
      'PUT',
      `/index.php/apps/deck/api/v1.0/boards/${boardId}/stacks/${stackId}/cards/${cardId}/assignLabel`,
      { labelId }
    );
  }

  /**
   * Remove a label from a card
   * @param {number} cardId - Card ID
   * @param {string} stackName - Stack the card is in
   * @param {string} labelName - Label name
   */
  async removeLabel(cardId, stackName, labelName) {
    const { boardId, labels } = await this._getIds();
    const stackId = await this._resolveStackId(stackName);
    const labelId = labels[labelName.toLowerCase()];

    if (!labelId) {
      throw new DeckApiError(`Unknown label: ${labelName}`);
    }

    await this._request(
      'PUT',
      `/index.php/apps/deck/api/v1.0/boards/${boardId}/stacks/${stackId}/cards/${cardId}/removeLabel`,
      { labelId }
    );
  }

  /**
   * Create a new label on a board.
   * @param {number} boardId - Board ID
   * @param {string} title - Label title
   * @param {string} [color='0800fd'] - Hex color without # (e.g. 'ff0000')
   * @returns {Promise<Object>} Created label object with id, title, color
   */
  async createLabel(boardId, title, color = '0800fd') {
    if (!boardId) throw new DeckApiError('boardId is required');
    if (!title || typeof title !== 'string') throw new DeckApiError('Label title is required');
    return await this._request(
      'POST',
      `/index.php/apps/deck/api/v1.0/boards/${boardId}/labels`,
      { title, color }
    );
  }

  // ============================================================
  // TASK MANAGEMENT HELPERS
  // ============================================================

  /**
   * Scan inbox for new tasks
   * @returns {Promise<Array>} Array of task objects ready for processing
   */
  async scanInbox() {
    const cards = await this.getCardsInStack('inbox');

    return cards.map(card => ({
      id: card.id,
      title: card.title,
      description: card.description || '',
      duedate: card.duedate,
      labels: (card.labels || []).map(l => l.title.toLowerCase()),
      createdAt: card.createdAt,
      lastModified: card.lastModified,
      urgent: (card.labels || []).some(l => l.title.toLowerCase() === 'urgent'),
      owner: card.owner,
      assignedUsers: card.assignedUsers || []
    }));
  }

  /**
   * Get workload summary across all stacks
   * @returns {Promise<Object>} Count of cards per stack
   */
  async getWorkloadSummary() {
    const allCards = await this.getAllCards();

    const summary = {
      inbox: 0,
      queued: 0,
      working: 0,
      review: 0,
      done: 0,
      reference: 0,
      total: 0
    };

    for (const [stack, cards] of Object.entries(allCards)) {
      summary[stack] = cards.length;
      summary.total += cards.length;
    }

    return summary;
  }

  /**
   * Accept a task from inbox
   * Moves to queued, adds acceptance comment
   * @param {number} cardId - Card ID
   * @param {string} [message] - Optional acceptance message
   */
  async acceptTask(cardId, message = 'Task accepted, queued for processing.') {
    try {
      await this.addComment(cardId, message, 'STATUS');
    } catch (e) {
      console.warn(`[Deck] Could not add comment: ${e.message}`);
      // Continue without comment - moving the card is more important
    }
    await this.moveCard(cardId, 'inbox', 'queued');
  }

  /**
   * Start working on a task
   * Moves from queued to working, adds progress comment
   * @param {number} cardId - Card ID
   * @param {string} [message] - Optional status message
   */
  async startTask(cardId, message = 'Starting work on this task...') {
    try {
      await this.addComment(cardId, message, 'PROGRESS');
    } catch (e) {
      console.warn(`[Deck] Could not add comment: ${e.message}`);
    }
    await this.moveCard(cardId, 'queued', 'working');
  }

  /**
   * Complete a task
   * Moves to done, adds completion comment
   * @param {number} cardId - Card ID
   * @param {string} message - Completion summary
   */
  async completeTask(cardId, message) {
    try {
      await this.addComment(cardId, message, 'DONE');
    } catch (e) {
      console.warn(`[Deck] Could not add comment: ${e.message}`);
    }
    await this.moveCard(cardId, 'working', 'done');
  }

  /**
   * Submit a task for human review
   * Moves to review stack, updates description with full LLM response
   * @param {number} cardId - Card ID
   * @param {string} stackName - Current stack name
   * @param {string} originalDescription - Original task description
   * @param {string} llmResponse - Full LLM response
   * @param {string} [summary] - Brief summary for comment
   */
  async submitForReview(cardId, stackName, originalDescription, llmResponse, summary = 'Task completed, awaiting review.') {
    const { boardId } = await this._getIds();
    const stackId = await this._resolveStackId(stackName);

    // Get current card to preserve required fields (Deck API requires title and owner on update)
    const currentCard = await this.getCard(cardId, stackName);

    // Build new description with original task + response
    const newDescription = `## Original Task\n\n${originalDescription || '(No description provided)'}\n\n---\n\n## Moltagent Response\n\n${llmResponse}`;

    // Update card description (must include title and owner)
    await this._request(
      'PUT',
      `/index.php/apps/deck/api/v1.0/boards/${boardId}/stacks/${stackId}/cards/${cardId}`,
      {
        title: currentCard.title,
        type: currentCard.type || 'plain',
        owner: currentCard.owner?.uid || currentCard.owner || this.username,
        description: newDescription
      }
    );

    // Add review comment
    try {
      await this.addComment(cardId, summary, 'REVIEW');
    } catch (e) {
      console.warn(`[Deck] Could not add comment: ${e.message}`);
    }

    // Move to review stack
    await this.moveCard(cardId, stackName, 'review');
    console.log(`[Deck] Card ${cardId} submitted for review`);
  }

  /**
   * Scan review stack for cards with human feedback
   * Returns cards that have new comments from users (not the bot)
   * @returns {Promise<Array>} Cards with human feedback
   */
  async scanReviewCards() {
    const cards = await this.getCardsInStack('review');
    const cardsWithFeedback = [];

    for (const card of cards) {
      try {
        const comments = await this.getComments(card.id);

        // Skip if bot already responded to the latest human comment
        if (hasNewerBotResponse(comments, this.username)) {
          continue;
        }

        const humanComments = comments.filter(comment => {
          const message = comment.message || '';
          return !BOT_PREFIXES.some(prefix => message.startsWith(prefix));
        });

        if (humanComments.length > 0) {
          cardsWithFeedback.push({
            id: card.id,
            title: card.title,
            description: card.description || '',
            labels: (card.labels || []).map(l => l.title.toLowerCase()),
            createdAt: card.createdAt,
            lastModified: card.lastModified,
            humanComments: humanComments.map(c => ({
              id: c.id,
              message: c.message,
              actorId: c.actorId,
              creationDateTime: c.creationDateTime
            }))
          });
        }
      } catch (e) {
        console.warn(`[Deck] Could not get comments for card ${card.id}: ${e.message}`);
      }
    }

    return cardsWithFeedback;
  }

  /**
   * Scan all active stacks for cards with human comments assigned to Moltagent
   * Useful for detecting clarifications or questions on in-progress work
   * @param {Array<string>} [stackNames=['inbox', 'queued', 'working', 'review']] - Stacks to scan
   * @returns {Promise<Array>} Cards with human comments, including stack info
   */
  async scanAllStacksForComments(stackNames = ['inbox', 'queued', 'working', 'review']) {
    const cardsWithComments = [];

    for (const stackName of stackNames) {
      try {
        const cards = await this.getCardsInStack(stackName);

        for (const card of cards) {
          // Check if Moltagent is assigned to this card
          const assignedUsers = card.assignedUsers || [];
          const isAssignedToMe = assignedUsers.some(u =>
            u.participant?.uid?.toLowerCase() === this.username.toLowerCase() ||
            u.uid?.toLowerCase() === this.username.toLowerCase()
          );

          if (!isAssignedToMe) {
            continue; // Skip cards not assigned to Moltagent
          }

          try {
            const comments = await this.getComments(card.id);

            // Skip if bot already responded to the latest human comment
            if (hasNewerBotResponse(comments, this.username)) {
              continue;
            }

            // Filter for human comments (not bot-prefixed)
            const humanComments = comments.filter(comment => {
              const message = comment.message || '';
              return !BOT_PREFIXES.some(prefix => message.startsWith(prefix));
            });

            if (humanComments.length > 0) {
              cardsWithComments.push({
                id: card.id,
                title: card.title,
                description: card.description || '',
                labels: (card.labels || []).map(l => l.title.toLowerCase()),
                stack: stackName,
                createdAt: card.createdAt,
                lastModified: card.lastModified,
                assignedUsers,
                humanComments: humanComments.map(c => ({
                  id: c.id,
                  message: c.message,
                  actorId: c.actorId,
                  creationDateTime: c.creationDateTime
                }))
              });
            }
          } catch (e) {
            console.warn(`[Deck] Could not get comments for card ${card.id}: ${e.message}`);
          }
        }
      } catch (e) {
        console.warn(`[Deck] Could not scan stack ${stackName}: ${e.message}`);
      }
    }

    return cardsWithComments;
  }

  /**
   * Scan all stacks for cards assigned to Moltagent
   * @param {Array<string>} [stackNames=['inbox', 'queued', 'working', 'review']] - Stacks to scan
   * @returns {Promise<Array>} Cards assigned to Moltagent
   */
  async scanAssignedCards(stackNames = ['inbox', 'queued', 'working', 'review']) {
    const assignedCards = [];

    for (const stackName of stackNames) {
      try {
        const cards = await this.getCardsInStack(stackName);

        for (const card of cards) {
          const assignedUsers = card.assignedUsers || [];
          const isAssignedToMe = assignedUsers.some(u =>
            u.participant?.uid?.toLowerCase() === this.username.toLowerCase() ||
            u.uid?.toLowerCase() === this.username.toLowerCase()
          );

          if (isAssignedToMe) {
            assignedCards.push({
              id: card.id,
              title: card.title,
              description: card.description || '',
              labels: (card.labels || []).map(l => l.title.toLowerCase()),
              stack: stackName,
              createdAt: card.createdAt,
              lastModified: card.lastModified,
              owner: card.owner,
              assignedUsers
            });
          }
        }
      } catch (e) {
        console.warn(`[Deck] Could not scan stack ${stackName}: ${e.message}`);
      }
    }

    return assignedCards;
  }

  /**
   * Complete review and move to done
   * @param {number} cardId - Card ID
   * @param {string} [finalMessage] - Final completion message
   */
  async completeReview(cardId, finalMessage = 'Review completed.') {
    try {
      await this.addComment(cardId, finalMessage, 'DONE');
    } catch (e) {
      console.warn(`[Deck] Could not add comment: ${e.message}`);
    }
    await this.moveCard(cardId, 'review', 'done');
    console.log(`[Deck] Card ${cardId} review completed, moved to done`);
  }

  /**
   * Process follow-up feedback on a review card
   * Adds response and optionally moves to done
   * @param {number} cardId - Card ID
   * @param {string} response - Response to the feedback
   * @param {boolean} [markComplete=false] - Whether to move to done
   */
  async respondToFeedback(cardId, response, markComplete = false) {
    try {
      await this.addComment(cardId, response, 'FOLLOWUP');
    } catch (e) {
      console.warn(`[Deck] Could not add comment: ${e.message}`);
    }

    if (markComplete) {
      await this.moveCard(cardId, 'review', 'done');
      console.log(`[Deck] Card ${cardId} follow-up completed, moved to done`);
    } else {
      console.log(`[Deck] Card ${cardId} follow-up response added`);
    }
  }

  /**
   * Block a task (needs human input)
   * Moves back to inbox with question, adds blocked label
   * @param {number} cardId - Card ID
   * @param {string} question - Question for the human
   */
  async blockTask(cardId, question) {
    try {
      await this.addComment(cardId, question, 'QUESTION');
    } catch (e) {
      console.warn(`[Deck] Could not add comment: ${e.message}`);
    }
    try {
      await this.addLabel(cardId, 'working', 'blocked');
    } catch (e) {
      // Label might already be applied or not exist
    }
    await this.moveCard(cardId, 'working', 'inbox');
  }

  /**
   * Fail a task with error
   * Adds error comment, optionally moves back to inbox
   * @param {number} cardId - Card ID
   * @param {string} currentStack - Current stack name
   * @param {string} errorMessage - Error description
   * @param {boolean} [moveToInbox=true] - Whether to move back to inbox
   */
  async failTask(cardId, currentStack, errorMessage, moveToInbox = true) {
    try {
      await this.addComment(cardId, `Could not complete task: ${errorMessage}`, 'ERROR');
    } catch (e) {
      console.warn(`[Deck] Could not add comment: ${e.message}`);
    }
    if (moveToInbox && currentStack !== 'inbox') {
      await this.moveCard(cardId, currentStack, 'inbox');
    }
  }

  /**
   * Mark a task for retry — transient failure (budget, provider exhaustion).
   * Uses [RETRY] prefix which is NOT in AWAITING_PATTERNS, so the card
   * will be picked up again on the next heartbeat cycle.
   * @param {number} cardId - Card ID
   * @param {string} currentStack - Current stack name
   * @param {string} reason - Why the retry is needed
   */
  async retryTask(cardId, currentStack, reason) {
    try {
      await this.addComment(cardId, `Processing failed: ${reason}. Will retry next heartbeat.`, 'RETRY');
    } catch (e) {
      console.warn(`[Deck] Could not add retry comment: ${e.message}`);
    }
    if (currentStack !== 'inbox') {
      await this.moveCard(cardId, currentStack, 'inbox');
    }
  }

  /**
   * Clean up old completed cards
   * Archives cards in 'done' stack older than archiveAfterDays
   * @returns {Promise<number>} Number of cards archived
   */
  async cleanupOldCards() {
    const cards = await this.getCardsInStack('done');
    const cutoffTimestamp = Math.floor(Date.now() / 1000) - (this.archiveAfterDays * 24 * 60 * 60);

    let archived = 0;
    for (const card of cards) {
      if (card.lastModified && card.lastModified < cutoffTimestamp) {
        try {
          await this.deleteCard(card.id, 'done');
          archived++;
        } catch (e) {
          console.warn(`[Deck] Failed to archive card ${card.id}: ${e.message}`);
        }
      }
    }

    if (archived > 0) {
      console.log(`[Deck] Archived ${archived} cards older than ${this.archiveAfterDays} days`);
    }

    return archived;
  }

  /**
   * Clear cache (force refresh on next operation)
   */
  clearCache() {
    this._cache = {
      boardId: null,
      stacks: {},
      labels: {},
      lastRefresh: 0
    };
  }

  // ============================================================
  // USER ASSIGNMENT
  // ============================================================

  /**
   * Assign a user to a card
   * @param {number} cardId - Card ID
   * @param {string} stackName - Stack the card is in
   * @param {string} userId - Username to assign
   */
  async assignUser(cardId, stackName, userId) {
    const { boardId } = await this._getIds();
    const stackId = await this._resolveStackId(stackName);

    // Get board users to find correct case
    const board = await this._request('GET', `/index.php/apps/deck/api/v1.0/boards/${boardId}`);
    const boardUsers = board.users || [];

    // Find user with case-insensitive match
    const matchedUser = boardUsers.find(u =>
      u.uid.toLowerCase() === userId.toLowerCase() ||
      u.primaryKey.toLowerCase() === userId.toLowerCase()
    );

    if (!matchedUser) {
      console.warn(`[Deck] User ${userId} is not a member of this board`);
      return;
    }

    const correctUserId = matchedUser.uid;

    try {
      await this._request(
        'PUT',
        `/index.php/apps/deck/api/v1.0/boards/${boardId}/stacks/${stackId}/cards/${cardId}/assignUser`,
        { userId: correctUserId }
      );
      console.log(`[Deck] Assigned ${correctUserId} to card ${cardId}`);
    } catch (e) {
      // Ignore if already assigned
      if (!e.message?.includes('already assigned')) {
        console.warn(`[Deck] Could not assign ${correctUserId}: ${e.message}`);
      }
    }
  }

  /**
   * Unassign a user from a card
   * @param {number} cardId - Card ID
   * @param {string} stackName - Stack the card is in
   * @param {string} userId - Username to unassign
   */
  async unassignUser(cardId, stackName, userId) {
    const { boardId } = await this._getIds();
    const stackId = await this._resolveStackId(stackName);

    // Get board users to find correct case
    const board = await this._request('GET', `/index.php/apps/deck/api/v1.0/boards/${boardId}`);
    const boardUsers = board.users || [];

    // Find user with case-insensitive match
    const matchedUser = boardUsers.find(u =>
      u.uid.toLowerCase() === userId.toLowerCase() ||
      u.primaryKey.toLowerCase() === userId.toLowerCase()
    );

    if (!matchedUser) {
      console.warn(`[Deck] User ${userId} is not a member of this board`);
      return;
    }

    const correctUserId = matchedUser.uid;

    try {
      await this._request(
        'PUT',
        `/index.php/apps/deck/api/v1.0/boards/${boardId}/stacks/${stackId}/cards/${cardId}/unassignUser`,
        { userId: correctUserId }
      );
      console.log(`[Deck] Unassigned ${correctUserId} from card ${cardId}`);
    } catch (e) {
      if (!e.message?.includes('not assigned')) {
        console.warn(`[Deck] Could not unassign ${correctUserId}: ${e.message}`);
      }
    }
  }

  /**
   * Get users assigned to a card
   * @param {number} cardId - Card ID
   * @param {string} stackName - Stack the card is in
   * @returns {Promise<Array>} Array of assigned user objects
   */
  async getAssignedUsers(cardId, stackName) {
    const card = await this.getCard(cardId, stackName);
    return card.assignedUsers || [];
  }

  /**
   * Get all cards assigned to a specific user across all stacks.
   *
   * Iterates every stack on the configured board and filters cards
   * by assignedUsers.  Returns an array of card objects enriched
   * with a `stackName` field so the caller knows where each card lives.
   *
   * @param {string} userId - Username to filter by (case-insensitive)
   * @returns {Promise<Array>} Cards assigned to the user
   */
  async getCardsAssignedTo(userId) {
    const { stacks } = await this._getIds();
    const uid = (userId || '').toLowerCase();
    const results = [];

    for (const [stackName, stackId] of Object.entries(stacks)) {
      if (!stackId) continue;
      try {
        const cards = await this.getCardsInStack(stackName);
        for (const card of cards) {
          const assigned = card.assignedUsers || [];
          const match = assigned.some(u =>
            (u.participant?.uid || u.uid || '').toLowerCase() === uid
          );
          if (match) results.push({ ...card, stackName });
        }
      } catch {
        // Stack read failed — skip silently
      }
    }
    return results;
  }

  /**
   * Ensure Moltagent and card creator are assigned.
   * Called when picking up a task.
   * @param {number} cardId - Card ID
   * @param {string} stackName - Stack the card is in
   * @param {string} creatorId - Original card creator username
   */
  async ensureAssignments(cardId, stackName, creator) {
    // Always assign Moltagent
    await this.assignUser(cardId, stackName, this.username);

    // Extract creator ID from object or string
    let creatorId = creator;
    if (creator && typeof creator === 'object') {
      creatorId = creator.uid || creator.primaryKey || creator.id;
    }

    // Assign original creator if provided and different from bot
    if (creatorId && creatorId.toLowerCase() !== this.username.toLowerCase()) {
      await this.assignUser(cardId, stackName, creatorId);
    }
  }
}

module.exports = DeckClient;
module.exports.BOT_PREFIXES = BOT_PREFIXES;
module.exports.hasNewerBotResponse = hasNewerBotResponse;
module.exports.isAwaitingHumanResponse = isAwaitingHumanResponse;
