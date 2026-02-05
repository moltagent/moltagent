/**
 * MoltAgent NC Deck Client
 * 
 * API client for Nextcloud Deck integration.
 * Enables task management via kanban board.
 * 
 * @module deck-client
 * @version 1.0.0
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

class DeckClient {
  /**
   * Create a new Deck client
   * @param {Object} config - Configuration object
   * @param {string} config.nextcloud.url - Nextcloud base URL
   * @param {Object} config.credentialBroker - Credential broker instance
   * @param {Object} [config.deck] - Deck-specific configuration
   */
  constructor(config) {
    this.baseUrl = config.nextcloud.url.replace(/\/$/, ''); // Remove trailing slash
    this.credentialBroker = config.credentialBroker;
    this.username = config.nextcloud.username || 'moltagent';
    
    // Board configuration
    this.boardName = config.deck?.boardName || 'MoltAgent Tasks';
    this.archiveAfterDays = config.deck?.archiveAfterDays || 180;
    
    // Stack names (order matters for creation)
    this.stackNames = config.deck?.stacks || {
      inbox: 'Inbox',
      queued: 'Queued', 
      working: 'Working',
      done: 'Done',
      reference: 'Reference'
    };
    
    // Label definitions
    this.labelDefs = config.deck?.labels || [
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
    
    // Credential cache (short-lived)
    this._credential = null;
    this._credentialExpiry = 0;
  }

  // ============================================================
  // AUTHENTICATION & HTTP
  // ============================================================

  /**
   * Get credentials from broker (cached briefly)
   * @private
   */
  async _getCredential() {
    const now = Date.now();
    
    // Use cached credential if fresh (30 seconds)
    if (this._credential && now < this._credentialExpiry) {
      return this._credential;
    }
    
    // Fetch from credential broker
    if (this.credentialBroker && typeof this.credentialBroker.get === 'function') {
      this._credential = await this.credentialBroker.get('nc-moltagent-password');
    } else if (this.credentialBroker && typeof this.credentialBroker === 'string') {
      // Direct password provided (for testing)
      this._credential = this.credentialBroker;
    } else {
      throw new Error('No credential broker configured');
    }
    
    this._credentialExpiry = now + 30000; // Cache for 30 seconds
    return this._credential;
  }

  /**
   * Make an HTTP request to the Deck API
   * @private
   */
  async _request(method, path, body = null) {
    const credential = await this._getCredential();
    const url = new URL(path, this.baseUrl);
    const isHttps = url.protocol === 'https:';
    
    const options = {
      method,
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
        'OCS-APIRequest': 'true',
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + Buffer.from(`${this.username}:${credential}`).toString('base64')
      }
    };

    return new Promise((resolve, reject) => {
      const client = isHttps ? https : http;
      
      const req = client.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          // Clear credential from memory after use
          // (In production, the credential broker handles this)
          
          try {
            // Handle empty responses
            if (!data || data.trim() === '') {
              if (res.statusCode >= 200 && res.statusCode < 300) {
                resolve({ success: true, statusCode: res.statusCode });
              } else {
                reject(new DeckApiError(`HTTP ${res.statusCode}`, res.statusCode));
              }
              return;
            }
            
            const json = JSON.parse(data);
            
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(json);
            } else {
              const message = json.message || json.error || `HTTP ${res.statusCode}`;
              reject(new DeckApiError(message, res.statusCode, json));
            }
          } catch (parseError) {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(data);
            } else {
              reject(new DeckApiError(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`, res.statusCode));
            }
          }
        });
      });

      req.on('error', (error) => {
        reject(new DeckApiError(`Request failed: ${error.message}`, 0));
      });
      
      req.setTimeout(30000, () => {
        req.destroy();
        reject(new DeckApiError('Request timeout', 0));
      });
      
      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
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
   * Find the MoltAgent Tasks board by name
   * @returns {Promise<Object|null>} Board object or null
   */
  async findBoard() {
    const boards = await this.listBoards();
    return boards.find(b => b.title === this.boardName) || null;
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
   * Create the MoltAgent Tasks board with all required stacks and labels
   * @returns {Promise<Object>} Object with boardId and stacks mapping
   */
  async createBoard() {
    console.log(`[Deck] Creating board: ${this.boardName}`);
    
    // Create board
    const board = await this._request('POST', '/index.php/apps/deck/api/v1.0/boards', {
      title: this.boardName,
      color: '0082c9' // Nextcloud blue
    });

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
      console.log('[Deck] MoltAgent Tasks board not found, creating...');
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
    const board = await this.getBoard(boardId);
    
    const allCards = {};
    for (const stack of board.stacks || []) {
      const key = Object.keys(this.stackNames).find(
        k => this.stackNames[k].toLowerCase() === stack.title.toLowerCase()
      );
      if (key) {
        allCards[key] = stack.cards || [];
      }
    }
    
    return allCards;
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
   * @param {number} cardId - Card ID
   * @param {string} fromStack - Current stack name
   * @param {string} toStack - Destination stack name
   * @param {number} [order=0] - Position in destination stack (0 = top)
   */
  async moveCard(cardId, fromStack, toStack, order = 0) {
    const { boardId, stacks } = await this._getIds();
    const fromStackId = stacks[fromStack];
    const toStackId = stacks[toStack];

    if (!fromStackId) throw new DeckApiError(`Unknown stack: ${fromStack}`);
    if (!toStackId) throw new DeckApiError(`Unknown stack: ${toStack}`);

    await this._request(
      'PUT',
      `/index.php/apps/deck/api/v1.0/boards/${boardId}/stacks/${fromStackId}/cards/${cardId}/reorder`,
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
  async addComment(cardId, message, type = 'STATUS') {
    const prefixedMessage = `[${type}] ${message}`;

    // Comments use the OCS API wrapper, not the direct API
    const response = await this._request(
      'POST',
      `/ocs/v2.php/apps/deck/api/v1.0/cards/${cardId}/comments`,
      { message: prefixedMessage }
    );

    console.log(`[Deck] Comment added to card ${cardId}: [${type}]`);
    return response;
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
      owner: card.owner
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
      await this.addComment(cardId, errorMessage, 'ERROR');
    } catch (e) {
      console.warn(`[Deck] Could not add comment: ${e.message}`);
    }
    if (moveToInbox && currentStack !== 'inbox') {
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

module.exports = DeckClient;
module.exports.DeckApiError = DeckApiError;
