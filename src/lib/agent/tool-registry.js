'use strict';

const DECK = require('../../config/deck-names');
const { isStructuralCard, hasLabel } = require('../integrations/deck-card-classifier');

/**
 * Migration seam for the success/error contract (#70).
 *
 * The target architecture (Option A) is that handlers THROW on failure and
 * `execute()` is the single error chokepoint — its catch turns the throw into
 * `{ success: false, error }`. But most handlers still swallow their own
 * exceptions and RETURN a failure string (`catch (err) { return 'Failed to
 * X: ${err.message}' }`). Such a string looks like a normal return, so
 * `execute()` frames it as `{ success: true }` and the failure reaches the
 * model wearing a success mask — the wound #70 documents (a 403 reported as a
 * support lecture).
 *
 * Until every handler is converted to throw, this seam recognises the
 * handlers' OWN failure-return convention at the chokepoint and re-frames it
 * as a structured failure. These markers match code the registry itself
 * emits — fixed English literals from `catch` blocks, invariant across the
 * user's language — not user or model text. This is plumbing translating
 * plumbing's legacy output, not the language layer (CLAUDE.md Rule 1): adding
 * a language never edits this list.
 *
 * Scope is deliberately tight: the exception-swallow convention only.
 *   - `Failed to …` — the 60+ `catch (err) { return 'Failed to …' }` sites.
 *   - `… not found or inaccessible …` — the documented board-stack swallow
 *     (tool-registry.js workflow_deck_create_card; see #70).
 * Happy-path informational negatives ("No card found", "Could not assign —
 * not a member") are NOT swept: they are business outcomes, not swallowed
 * exceptions, and the model already reports them correctly. As handlers
 * migrate to throwing, their markers retire from this list.
 * @type {ReadonlyArray<RegExp>}
 */
const HANDLER_FAILURE_MARKERS = Object.freeze([
  /^Failed to\b/,
  /\bnot found or inaccessible\b/
]);

/**
 * Detect a failure-shaped string returned by an unconverted handler.
 * Inspects a raw string return, or the `.text` of a `{ text, ... }` return.
 * @param {*} raw - the handler's return value
 * @returns {string|null} the failure string if matched, else null
 */
function detectHandlerFailureString(raw) {
  const text = typeof raw === 'string'
    ? raw
    : (raw && typeof raw === 'object' && typeof raw.text === 'string' ? raw.text : null);
  if (!text) return null;
  return HANDLER_FAILURE_MARKERS.some((re) => re.test(text)) ? text : null;
}

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
   * @param {import('../integrations/news-client').NewsClient} [options.newsClient]
   * @param {import('../integrations/meeting-composer')} [options.meetingComposer]
   * @param {import('../integrations/rsvp-tracker')} [options.rsvpTracker]
   * @param {Object} [options.logger]
   */
  // NOTE(#227): every client the construction site passes MUST appear here AND in
  // this.clients — a name missing from either is silently undefined at runtime and
  // its tool family never registers (that was #226: meetingComposer/rsvpTracker
  // dropped → meeting tools dead in production). The TOOL_FAMILIES manifest below
  // turns that silence into a loud [BOOT][WARN] line.
  constructor({ deckClient, calDAVClient, systemTagsClient, ncRequestManager, ncFilesClient, ncSearchClient, textExtractor, collectivesClient, learningLog, searxngClient, webReader, contactsClient, memorySearcher, searchAdapters, emailHandler, resilientWriter, newsClient, entityExtractor, meetingComposer, rsvpTracker, logger }) {
    this.clients = { deckClient, calDAVClient, systemTagsClient, ncRequestManager, ncFilesClient, ncSearchClient, textExtractor, collectivesClient, learningLog, searxngClient, webReader, contactsClient, memorySearcher, searchAdapters, emailHandler, resilientWriter, newsClient, entityExtractor, meetingComposer, rsvpTracker };
    this.logger = logger || console;

    /** @type {Map<string, {name: string, description: string, parameters: Object, handler: Function, domains?: string[], universal?: boolean}>} */
    this.tools = new Map();

    /** Per-request context (user identity, etc.) — set by AgentLoop at start of each request */
    this._requestContext = {};

    this._registerDefaultTools();
  }

  /**
   * Set per-request context (e.g. requesting user identity).
   * Called by AgentLoop at the start of each process() call.
   * @param {Object} ctx
   * @param {string} [ctx.user] - Nextcloud username of the requesting user
   */
  setRequestContext(ctx) {
    this._requestContext = ctx || {};
  }

  /**
   * Get per-request context.
   * @returns {Object} Current request context
   */
  getRequestContext() {
    return this._requestContext;
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
  getWorkflowToolDefinitions({ includeUpdateCard = false } = {}) {
    const allowed = new Set([
      'workflow_deck_move_card',
      'workflow_deck_add_comment',
      'workflow_deck_create_card',
      'deck_add_label',
      'workflow_deck_assign_label'
    ]);
    if (includeUpdateCard) {
      allowed.add('workflow_deck_update_card');
    }
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
   * @param {Object} [options]
   * @param {boolean} [options.includeUpdateCard=false] - Include workflow_deck_update_card
   * @param {string} [options.searchPolicy] - System search policy: 'research'|'internal-first'|'sovereign'.
   *   When 'research' or 'internal-first' (default when undefined), web_search and web_read are
   *   added to the palette. When 'sovereign', they remain excluded.
   *   Gate is advertising-only (execution is uncaged, matching the #133 subset guardrail).
   * @returns {Array<{type: 'function', function: {name: string, description: string, parameters: Object}}>}
   */
  getCloudWorkflowToolDefinitions(boardContext = '', { includeUpdateCard = false, searchPolicy } = {}) {
    // Base tools every workflow needs
    const allowed = new Set([
      'workflow_deck_move_card',
      'workflow_deck_add_comment',
      'workflow_deck_create_card',
      'deck_add_label',
      'workflow_deck_assign_label',
    ]);

    // Per-card processing can update card descriptions (e.g. writing drafts).
    // Schedules only create cards, never update existing ones.
    if (includeUpdateCard) {
      allowed.add('workflow_deck_update_card');
    }

    // Web tools: included when searchPolicy is not 'sovereign'.
    // Default (undefined) is treated as 'research' — web is on.
    // Both 'research' and 'internal-first' mean web is available in a research
    // stage (the stage's purpose is the signal, not the policy mode).
    if (searchPolicy !== 'sovereign') {
      allowed.add('web_search');
      allowed.add('web_read');
    }

    // Scan context for capabilities the board actually needs
    const ctx = boardContext.toLowerCase();
    if (ctx.includes('wiki') || ctx.includes('[['))
      ['wiki_write', 'wiki_read', 'wiki_search', 'wiki_delete'].forEach(t => allowed.add(t));
    if (ctx.includes('calendar') || ctx.includes('schedule') || ctx.includes('meeting') || ctx.includes('kickoff'))
      ['calendar_create_event', 'calendar_list_events', 'calendar_check_availability', 'calendar_cancel_meeting'].forEach(t => allowed.add(t));
    if (ctx.includes('folder') || ctx.includes('/clients/') || ctx.includes('file'))
      ['file_mkdir', 'file_write'].forEach(t => allowed.add(t));
    if (ctx.includes('email') || ctx.includes('mail'))
      allowed.add('mail_send');
    if (ctx.includes('news') || ctx.includes('feed') || ctx.includes('rss'))
      ['news_get_items', 'news_list_feeds', 'news_mark_read'].forEach(t => allowed.add(t));
    // talk_send: not yet implemented — add here when wired

    return Array.from(this.tools.values())
      .filter(t => allowed.has(t.name))
      .map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters }
      }));
  }

  /**
   * Get a focused tool subset for a domain-specific intent.
   * Returns 3-8 tools optimized for local models (Qwen 8B).
   *
   * Membership is derived from each tool's own registration metadata — the
   * `domains` array a tool declares at its `register()` site — so there is a
   * single home for "which tools a domain sees" (#221). A tool is in the
   * subset when it declares `intent` in `domains`, or when it is a `universal`
   * helper (e.g. web_search, present in every subset). Universal helpers are
   * appended only for a known domain: an intent no tool claims yields `[]`,
   * matching the prior "no such subset" behavior so hasDomainTools stays honest.
   *
   * @param {string} intent - Domain intent: deck, calendar, email, wiki, file, search, news
   * @returns {Array<{type: 'function', function: {name: string, description: string, parameters: Object}}>}
   */
  getToolSubset(intent) {
    if (!intent) return [];
    const all = Array.from(this.tools.values());
    // Unknown domain (no tool claims it) → no subset, so universal helpers are
    // not surfaced on their own and hasDomainTools reports false.
    const isKnownDomain = all.some(t => (t.domains || []).includes(intent));
    if (!isKnownDomain) return [];

    return all
      .filter(t => (t.domains || []).includes(intent) || t.universal)
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
   * Check if a domain intent has a valid tool subset.
   * @param {string} intent
   * @returns {boolean}
   */
  hasDomainTools(intent) {
    return this.getToolSubset(intent).length > 0;
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
      const raw = await tool.handler(args || {});

      // Migration seam (#70): an unconverted handler reports failure by
      // RETURNING a failure string instead of throwing, so the catch below
      // never fires and the failure would be framed as success. Re-frame it
      // as a structured failure here, at the chokepoint, so the agent loop
      // presents it as `Error: …` rather than a successful result.
      const failureText = detectHandlerFailureString(raw);
      if (failureText !== null) {
        this.logger.warn(`[ToolRegistry] Tool ${name} returned a failure string (migration seam #70): ${failureText}`);
        return { success: false, result: '', error: failureText };
      }

      // Handlers may return {text, card} for structured data alongside the response.
      // The text goes to result (for display), the card object passes through directly.
      if (typeof raw === 'object' && raw !== null && raw.text) {
        const { text, ...structured } = raw;
        return { success: true, result: text, ...structured };
      }
      return {
        success: true,
        result: typeof raw === 'string' ? raw : JSON.stringify(raw)
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
   *
   * `domains` and `universal` are the declarative source for getToolSubset:
   * declaring a tool's visibility IS registering it, so registration and
   * per-domain visibility cannot drift (#221). A tool with no `domains` and no
   * `universal` flag is registered on the full surface (getToolDefinitions) but
   * appears in no domain subset.
   *
   * @param {Object} toolDef
   * @param {string} toolDef.name
   * @param {Function} toolDef.handler
   * @param {string} [toolDef.description]
   * @param {Object} [toolDef.parameters]
   * @param {string[]} [toolDef.domains] - Domain subsets this tool belongs to
   *   (multi-valued for cross-domain tools, e.g. ['deck', 'news']).
   * @param {boolean} [toolDef.universal] - Include in every domain subset
   *   (a cross-cutting helper such as web_search), not a domain of its own.
   * @param {Object} [toolDef.metadata]
   */
  /**
   * Every tool declares exactly one of `readOnly: true` or `mutates: true`, and
   * the write-class pin asserts that partition is total. Two questions get asked
   * about a tool, and conflating them was a real bug (#81 commit 2):
   *
   * - **`mutates`** — *does calling this change the world?* Creating a card
   *   mutates. Listing cards does not. This is what the action-hallucination
   *   guard reads: a gate=action turn that invoked no mutating tool did not act,
   *   whatever its prose says.
   * - **`writes`** — *does calling this need approval?* A strictly smaller set
   *   (#266's write class: deletes, shares, sends, overwrites). `deck_create_card`
   *   mutates and needs no approval; the two sets are not the same, and keying
   *   the guard on `writes` made it deny successful card creations.
   *
   * Both are the tool's own statement about itself, independent of any policy
   * table, and that independence is what gives the pin teeth: it cross-checks
   * `writes` against `GuardrailEnforcer.getWriteClassTools()` and requires
   * `write-class ⊆ mutates`, so neither an ungated destructive tool nor a
   * gated-but-undeclared one can ship.
   *
   * @param {Object} toolDef
   * @param {boolean} [toolDef.mutates] - true when calling the tool changes external state
   * @param {boolean} [toolDef.readOnly] - true when calling the tool changes nothing
   * @param {boolean} [toolDef.writes] - true when the tool additionally requires approval
   */
  register(toolDef) {
    if (!toolDef.name || !toolDef.handler) {
      throw new Error('Tool definition requires name and handler');
    }
    this.tools.set(toolDef.name, toolDef);
  }

  /**
   * Does invoking this tool change state outside the process?
   *
   * Undeclared and unknown tools answer **true**. The caller (the action guard)
   * uses this to decide whether a turn may have acted, and the only unsafe answer
   * is a false "nothing happened" printed under a real mutation. So the default
   * fails toward silence: a dynamically registered tool (SkillForge) that never
   * declared itself is assumed to have acted, and the guard stays quiet.
   *
   * @param {string} name - Tool name (resolved)
   * @returns {boolean}
   */
  isMutating(name) {
    const tool = this.tools.get(name);
    if (!tool) return true;              // unknown: assume it acted
    if (tool.mutates === true) return true;
    if (tool.readOnly === true) return false;
    return true;                         // undeclared: assume it acted
  }

  /**
   * @param {string} name
   * @returns {boolean}
   */
  has(name) {
    return this.tools.has(name);
  }

  /**
   * Remove a tool from the registry.
   * @param {string} name - Tool name to remove
   * @returns {boolean} True if the tool was removed, false if it didn't exist
   */
  unregister(name) {
    return this.tools.delete(name);
  }

  /**
   * List tools registered by a specific source.
   * @param {string} source - Source identifier (e.g. 'skill-forge')
   * @returns {Array} Tools whose metadata.source matches
   */
  listBySource(source) {
    const result = [];
    for (const tool of this.tools.values()) {
      if (tool.metadata?.source === source) result.push(tool);
    }
    return result;
  }

  /** @returns {number} */
  get size() {
    return this.tools.size;
  }

  // ===========================================================================
  // Private: Default Tool Registration
  // ===========================================================================

  /**
   * The boot composition contract (#227): which clients each tool family needs.
   *
   * `required` mirrors the registrar's own early-return gate — when one is
   * missing the family is skipped LOUDLY ([BOOT][WARN]) instead of silently.
   * `optional` names clients the family registers without but degrades
   * visibly when absent (logged once at boot).
   *
   * This list and the registrar gates must stay aligned; the gates remain as
   * the assertion's fallback so a direct registrar call is still safe.
   * @private
   */
  static get TOOL_FAMILIES() {
    return [
      { family: 'deck', method: '_registerDeckTools', required: ['deckClient'] },
      { family: 'calendar', method: '_registerCalendarTools', required: ['calDAVClient'] },
      { family: 'meeting', method: '_registerMeetingTools', required: ['meetingComposer'], optional: ['rsvpTracker'] },
      { family: 'file', method: '_registerFileTools', required: ['ncFilesClient'] },
      { family: 'search', method: '_registerSearchTools', required: ['ncSearchClient'] },
      { family: 'tag', method: '_registerTagTools', required: ['systemTagsClient'] },
      { family: 'memory', method: '_registerMemoryTools', required: ['ncRequestManager'] },
      { family: 'wiki', method: '_registerWikiTools', required: ['collectivesClient'], optional: ['resilientWriter'] },
      { family: 'web', method: '_registerWebTools', required: [], optional: ['searxngClient', 'webReader', 'searchAdapters'] },
      { family: 'contacts', method: '_registerContactsTools', required: ['contactsClient'] },
      { family: 'memorySearch', method: '_registerMemorySearchTools', required: ['memorySearcher'] },
      { family: 'workflowDeck', method: '_registerWorkflowDeckTools', required: ['ncRequestManager'], optional: ['deckClient'] },
    ];
  }

  /** @private */
  _registerDefaultTools() {
    for (const { family, method, required = [], optional = [] } of ToolRegistry.TOOL_FAMILIES) {
      const missing = required.filter((name) => !this.clients[name]);
      if (missing.length) {
        this.logger.warn(
          `[BOOT][WARN] ToolRegistry: ${family} tools SKIPPED — required client${missing.length > 1 ? 's' : ''} ` +
          `'${missing.join("', '")}' missing at construction`
        );
        continue;
      }
      const before = this.tools.size;
      this[method]();
      const absentOptional = optional.filter((name) => !this.clients[name]);
      const degradeNote = absentOptional.length
        ? `; optional '${absentOptional.join("', '")}' absent — degraded`
        : '';
      this.logger.info(
        `[BOOT] ToolRegistry: ${family} tools registered (${this.tools.size - before} tools` +
        `${required.length ? `; ${required.join(', ')} present` : ''})${degradeNote}`
      );
    }
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
   * Resolve a card on either the default board (legacy behaviour, preserved
   * for backward compatibility) or a named/ID-identified board. Returns one
   * of four shapes so the caller can render an appropriate user-facing
   * message without a second resolution pass.
   *
   * @private
   * @param {Object} deck - DeckClient instance
   * @param {string} cardIdentifier - Card title (partial match) or "#ID"
   * @param {string} [boardParam] - Board name (partial match) or ID. If
   *   omitted, walks the bot's default task board.
   * @returns {Promise<
   *     { found: true, card, boardId, stackId, stackTitle, isDefaultBoard, stackKey? }
   *   | { found: false, reason: 'no_board', boardQuery }
   *   | { found: false, reason: 'no_card', boardTitle, cardQuery }
   *   | { found: false, reason: 'ambiguous', boardTitle, cardQuery, candidates }
   * >}
   */
  async _resolveCardOnBoard(deck, cardIdentifier, boardParam) {
    if (!boardParam) {
      const resolved = await this._resolveCard(deck, cardIdentifier);
      if (!resolved) return { found: false, reason: 'no_card', boardTitle: null, cardQuery: cardIdentifier };

      const stackTitle = (deck.stackNames && deck.stackNames[resolved.stackKey]) || resolved.stackKey;
      return {
        found: true,
        card: resolved.card,
        boardId: null,
        stackId: null,
        stackTitle,
        isDefaultBoard: true,
        stackKey: resolved.stackKey
      };
    }

    const board = await this._resolveBoard(deck, boardParam);
    if (!board) return { found: false, reason: 'no_board', boardQuery: boardParam };

    const stacks = await deck.getStacks(board.id);
    const idStr = String(cardIdentifier).startsWith('#')
      ? String(cardIdentifier).slice(1)
      : null;
    const titleLower = idStr ? null : String(cardIdentifier).toLowerCase();

    const matches = [];
    for (const stack of stacks || []) {
      for (const card of stack.cards || []) {
        const matchById = idStr && String(card.id) === idStr;
        const matchByTitle = !idStr && card.title && card.title.toLowerCase().includes(titleLower);
        if (matchById || matchByTitle) {
          matches.push({ card, stackId: stack.id, stackTitle: stack.title });
        }
      }
    }

    if (matches.length === 0) {
      return { found: false, reason: 'no_card', boardTitle: board.title, cardQuery: cardIdentifier };
    }
    if (matches.length > 1) {
      return {
        found: false,
        reason: 'ambiguous',
        boardTitle: board.title,
        cardQuery: cardIdentifier,
        candidates: matches.map(m => ({
          id: m.card.id,
          title: m.card.title,
          stackTitle: m.stackTitle
        }))
      };
    }

    const m = matches[0];
    return {
      found: true,
      card: m.card,
      boardId: board.id,
      stackId: m.stackId,
      stackTitle: m.stackTitle,
      isDefaultBoard: false
    };
  }

  /**
   * Render a non-found resolution as a user-facing string. Returns null
   * if the resolution is `found: true` (caller should not invoke this).
   * @private
   */
  _renderResolutionError(resolution, action = 'operate on') {
    if (resolution.found) return null;
    if (resolution.reason === 'no_board') {
      return `No board found matching "${resolution.boardQuery}".`;
    }
    if (resolution.reason === 'no_card') {
      return resolution.boardTitle
        ? `No card found matching "${resolution.cardQuery}" on board "${resolution.boardTitle}".`
        : `No card found matching "${resolution.cardQuery}".`;
    }
    if (resolution.reason === 'ambiguous') {
      const list = resolution.candidates
        .map(c => `  - #${c.id} "${c.title}" in ${c.stackTitle}`)
        .join('\n');
      return `Multiple cards on board "${resolution.boardTitle}" match "${resolution.cardQuery}". ` +
        `Please specify which card to ${action} by passing the card ID (e.g. "#${resolution.candidates[0].id}"):\n${list}`;
    }
    return `Could not resolve card "${resolution.cardQuery}".`;
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
    const deckCardUrl = (id) => deck.baseUrl ? `${deck.baseUrl}/apps/deck/card/${id}` : '';
    const deckBoardUrl = (id) => deck.baseUrl ? `${deck.baseUrl}/apps/deck/board/${id}` : '';
    const deckLink = (label, url) => url ? `[${label}](${url})` : `"${label}"`;

    // -- Original 3 tools (deck_list_cards, deck_move_card, deck_create_card) --

    this.register({
      name: 'deck_list_cards',
      readOnly: true,
      domains: ['deck'],
      description: 'List all cards on a board, grouped by stack. Defaults to the task board. Use the board parameter to query other boards (e.g. "Cockpit", "Moltagent Cockpit"). Omit the stack parameter to search all stacks (preferred default).',
      parameters: {
        type: 'object',
        properties: {
          stack: {
            type: 'string',
            description: 'Filter by stack name. If omitted, lists all cards from all stacks.'
          },
          board: {
            type: 'string',
            description: 'Board name (partial match) or board ID. If omitted, uses the task board.'
          }
        },
        required: []
      },
      handler: async (args) => {
        try {
          // Non-default board: resolve board, fetch stacks, list cards
          if (args.board) {
            const board = await this._resolveBoard(deck, args.board);
            if (!board) return `No board found matching "${args.board}".`;

            const stacks = await deck.getStacks(board.id);
            if (!stacks || stacks.length === 0) return `Board "${board.title}" has no stacks.`;

            const lines = [];
            let totalCards = 0;

            for (const s of stacks) {
              const cards = s.cards || [];
              // Filter by stack name if specified
              if (args.stack && s.title.toLowerCase() !== args.stack.toLowerCase()) continue;
              if (cards.length === 0) continue;
              totalCards += cards.length;
              lines.push(`**${s.title}** (${cards.length}):`);
              for (const c of cards) {
                const labels = (c.labels || []).map(l => l.title).join(', ');
                lines.push(`- ${deckLink(`#${c.id} ${c.title}`, deckCardUrl(c.id))}${labels ? ` [${labels}]` : ''}${c.duedate ? ` (due: ${c.duedate})` : ''}`);
              }
            }

            if (totalCards === 0) {
              return args.stack
                ? `No cards in stack "${args.stack}" on board "${board.title}".`
                : `Board "${board.title}" is empty.`;
            }

            return lines.join('\n');
          }

          // Default task board path (existing behavior)
          if (args.stack) {
            const key = this._stackKey(args.stack);
            const cards = await deck.getCardsInStack(key);

            if (cards.length === 0) {
              return `No cards in ${args.stack}.`;
            }

            return cards.map(c =>
              `- ${deckLink(`#${c.id} ${c.title}`, deckCardUrl(c.id))} in ${args.stack}${c.duedate ? ` (due: ${c.duedate})` : ''}`
            ).join('\n');
          }

          // All stacks — grouped by stack for readability
          const allCards = await deck.getAllCards();
          const lines = [];
          let totalCards = 0;

          for (const [key, cards] of Object.entries(allCards)) {
            if (cards.length === 0) continue;
            totalCards += cards.length;
            const displayName = this._stackDisplayName(key, deck);
            lines.push(`**${displayName}** (${cards.length}):`);
            for (const c of cards) {
              const cUrl = `${deck.baseUrl}/apps/deck/card/${c.id}`;
              lines.push(`- [#${c.id} ${c.title}](${cUrl})${c.duedate ? ` (due: ${c.duedate})` : ''}`);
            }
          }

          if (totalCards === 0) {
            return 'The board is empty.';
          }

          return lines.join('\n');
        } catch (err) {
          this.logger.error(`[deck_list_cards] ${err.message}`);
          return `Failed to list cards: ${err.message}`;
        }
      }
    });

    this.register({
      name: 'deck_move_card',
      mutates: true,
      domains: ['deck'],
      description: 'Move a card to a different stack. Use this when asked to close, finish, start, or queue a task. The card can be identified by title (partial match) or ID. Defaults to the task board; pass `board` to operate on a shared board.',
      parameters: {
        type: 'object',
        properties: {
          card: {
            type: 'string',
            description: 'Card title (partial match OK) or card ID prefixed with #'
          },
          target_stack: {
            type: 'string',
            description: 'Destination stack title. On the default task board: Inbox, Queued, Working, Done, Review. On a shared board: the stack title as it appears on that board (use deck_list_stacks to discover).'
          },
          board: {
            type: 'string',
            description: 'Board name (partial match) or board ID. If omitted, uses the task board.'
          }
        },
        required: ['card', 'target_stack']
      },
      handler: async (args) => {
        try {
          const resolution = await this._resolveCardOnBoard(deck, args.card, args.board);
          if (!resolution.found) {
            if (!args.board && resolution.reason === 'no_card') {
              const allCards = await deck.getAllCards();
              const available = Object.entries(allCards)
                .flatMap(([k, cards]) => cards.map(c => `  - "${c.title}" in ${this._stackDisplayName(k, deck)}`))
                .join('\n');
              return `No card found matching "${args.card}".${available ? ` Available cards:\n${available}` : ''}`;
            }
            return this._renderResolutionError(resolution, 'move');
          }

          const { card: foundCard, boardId, stackId: fromStackId, stackTitle: fromStackTitle, isDefaultBoard, stackKey: fromStackKey } = resolution;

          if (isDefaultBoard) {
            const toStackKey = this._stackKey(args.target_stack);
            if (fromStackKey === toStackKey) {
              return `Card "${foundCard.title}" is already in ${args.target_stack}.`;
            }
            await deck.moveCard(foundCard.id, fromStackKey, toStackKey);
            return `Moved "${foundCard.title}" (card #${foundCard.id}) from ${this._stackDisplayName(fromStackKey, deck)} to ${args.target_stack}.`;
          }

          const stacks = await deck.getStacks(boardId);
          const targetStack = (stacks || []).find(s => s.title.toLowerCase() === args.target_stack.toLowerCase());
          if (!targetStack) {
            const available = (stacks || []).map(s => `"${s.title}"`).join(', ');
            return `No stack "${args.target_stack}" on this board. Available stacks: ${available || '(none)'}`;
          }
          if (targetStack.id === fromStackId) {
            return `Card "${foundCard.title}" is already in "${targetStack.title}".`;
          }
          await deck.moveCardById(foundCard.id, targetStack.id, 0);
          return `Moved "${foundCard.title}" (card #${foundCard.id}) from "${fromStackTitle}" to "${targetStack.title}".`;
        } catch (err) {
          this.logger.error(`[deck_move_card] ${err.message}`);
          return `Failed to move card: ${err.message}`;
        }
      }
    });

    this.register({
      name: 'deck_create_card',
      mutates: true,
      domains: ['deck', 'news'],
      description: 'Create a new card (task) on a board. ALWAYS include a description with relevant context from the conversation — findings, results, next steps, or details discussed. If the user asks to save findings or results to a card, include that content in the description field. Cards are created in the Inbox stack by default.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Card title' },
          description: { type: 'string', description: 'Card content — include findings, context, results, or next steps from the conversation. Use markdown formatting. Always provide when the user asks to save results or findings.' },
          stack: {
            type: 'string',
            description: 'Stack to create in (default: Inbox)',
            enum: [DECK.stacks.inbox, DECK.stacks.queued, DECK.stacks.working, DECK.stacks.done]
          },
          board: {
            type: 'string',
            description: 'Target board name or ID (default: your task board). Use when the user specifies a board.'
          }
        },
        required: ['title']
      },
      handler: async (args) => {
        // TRACE-4: What params did the tool-calling LLM produce?
        console.log(`[TRACE-4] deck_create_card: title="${(args.title || '').substring(0, 60)}", description length: ${(args.description || '').length}`);
        try {
          // Board-targeted creation
          if (args.board) {
            const board = await this._resolveBoard(deck, args.board);
            if (!board) return `No board found matching "${args.board}".`;

            const stacks = await deck.getStacks(board.id);
            const targetStackName = args.stack || DECK.stacks.inbox;
            const stack = (stacks || []).find(s => s.title.toLowerCase() === targetStackName.toLowerCase());

            if (!stack) {
              const available = (stacks || []).map(s => `"${s.title}" (ID: ${s.id})`).join(', ');
              return `No stack "${targetStackName}" on board "${board.title}". Available stacks: ${available}`;
            }

            // Route through DeckClient guard (checks CONFIG: card for PAUSED label)
            console.log(`[deck_create_card] board=${board.id} stack=${stack.id} stackName="${stack.title}" — routing through createCardOnBoard`);
            const card = await deck.createCardOnBoard(board.id, stack.id, args.title, { description: args.description || '' });
            if (card === null) {
              return `Stack "${stack.title}" is PAUSED — cannot create cards in it. Choose a different stack.`;
            }

            if (!card || !card.id) return `Failed to create "${args.title}" — the server returned an empty response. Try again.`;
            return {
              text: `Created ${deckLink(args.title, deckCardUrl(card.id))} in "${stack.title}" on board "${board.title}".`,
              card: { id: card.id, boardId: board.id, stackId: stack.id }
            };
          }

          // Default board creation
          const stackKey = this._stackKey(args.stack || DECK.stacks.inbox);
          const card = await deck.createCard(stackKey, {
            title: args.title,
            description: args.description || ''
          });

          if (!card || !card.id) return `Failed to create "${args.title}" — no card ID returned. Try again.`;
          return {
            text: `Created ${deckLink(args.title, deckCardUrl(card.id))} in ${args.stack || DECK.stacks.inbox}.`,
            card: { id: card.id, boardId: card.boardId || null, stackId: card.stackId || null }
          };
        } catch (err) {
          this.logger.error(`[deck_create_card] ${err.message}`);
          return `Failed to create card: ${err.message}`;
        }
      }
    });

    // -- Phase A: Board ops --

    this.register({
      name: 'deck_list_boards',
      readOnly: true,
      domains: ['deck'],
      description: 'List all Deck boards accessible to you (owned and shared). Returns board names, IDs, and ownership info.',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: async () => {
        try {
          const boards = await deck.listBoards();
          if (!boards || boards.length === 0) return 'No boards found.';

          return boards.map(b => {
            const owned = b.owner?.uid === deck.username || b.owner === deck.username;
            return `- "${b.title}" (ID: ${b.id}, ${owned ? 'yours' : 'shared'})`;
          }).join('\n');
        } catch (err) {
          this.logger.error(`[deck_list_boards] ${err.message}`);
          return `Failed to list boards: ${err.message}`;
        }
      }
    });

    this.register({
      name: 'deck_get_board',
      readOnly: true,
      domains: ['deck'],
      description: 'Get details of a specific Deck board including its stacks, labels, and sharing settings. Accepts board name (partial match) or ID.',
      parameters: {
        type: 'object',
        properties: {
          board: { type: 'string', description: 'Board name (partial match) or board ID' }
        },
        required: ['board']
      },
      handler: async (args) => {
        try {
          const board = await this._resolveBoard(deck, args.board);
          if (!board) return `No board found matching "${args.board}".`;

          const full = await deck.getBoard(board.id);
          const stacks = (full.stacks || []).map(s => `  - ${s.title} (ID: ${s.id}, ${(s.cards || []).length} cards)`).join('\n');
          const labels = (full.labels || []).map(l => l.title).join(', ');
          const owned = full.owner?.uid === deck.username || full.owner === deck.username;

          let result = `Board: "${full.title}" (ID: ${full.id}, ${owned ? 'yours' : 'shared'})\n`;
          result += `Stacks:\n${stacks || '  (none)'}\n`;
          result += `Labels: ${labels || '(none)'}`;
          return result;
        } catch (err) {
          this.logger.error(`[deck_get_board] ${err.message}`);
          return `Failed to get board details: ${err.message}`;
        }
      }
    });

    this.register({
      name: 'deck_create_board',
      mutates: true,
      domains: ['deck'],
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
        try {
          const board = await deck._request('POST', '/index.php/apps/deck/api/v1.0/boards', {
            title: args.title,
            color: args.color || '0082c9'
          });
          return `Created board "${args.title}" (ID: ${board.id}).`;
        } catch (err) {
          this.logger.error(`[deck_create_board] ${err.message}`);
          return `Failed to create board: ${err.message}`;
        }
      }
    });

    // -- Phase F3: Board lifecycle --

    this.register({
      name: 'deck_rename_board',
      mutates: true,
      domains: ['deck'],
      description: 'Rename an existing Deck board.',
      parameters: {
        type: 'object',
        properties: {
          board: { type: 'string', description: 'Board name (partial match) or board ID' },
          title: { type: 'string', description: 'New board title' }
        },
        required: ['board', 'title']
      },
      handler: async (args) => {
        try {
          const board = await this._resolveBoard(deck, args.board);
          if (!board) return `No board found matching "${args.board}".`;
          await deck.updateBoard(board.id, { title: args.title });
          return `Renamed board "${board.title}" to "${args.title}".`;
        } catch (err) {
          this.logger.error(`[deck_rename_board] ${err.message}`);
          return `Failed to rename board: ${err.message}`;
        }
      }
    });

    this.register({
      name: 'deck_archive_board',
      mutates: true,
      domains: ['deck'],
      description: 'Archive a Deck board. Archived boards are hidden from the default view but not deleted.',
      parameters: {
        type: 'object',
        properties: {
          board: { type: 'string', description: 'Board name (partial match) or board ID' }
        },
        required: ['board']
      },
      handler: async (args) => {
        try {
          const board = await this._resolveBoard(deck, args.board);
          if (!board) return `No board found matching "${args.board}".`;
          await deck.archiveBoard(board.id);
          return `Archived board "${board.title}" (ID: ${board.id}).`;
        } catch (err) {
          this.logger.error(`[deck_archive_board] ${err.message}`);
          return `Failed to archive board: ${err.message}`;
        }
      }
    });

    this.register({
      name: 'deck_delete_board',
      mutates: true,
      writes: true,
      domains: ['deck'],
      description: 'Permanently delete a Deck board and all its stacks and cards. This is irreversible and requires confirmation.',
      parameters: {
        type: 'object',
        properties: {
          board: { type: 'string', description: 'Board name (partial match) or board ID' }
        },
        required: ['board']
      },
      handler: async (args) => {
        try {
          const board = await this._resolveBoard(deck, args.board);
          if (!board) return `No board found matching "${args.board}".`;
          await deck.deleteBoard(board.id);
          return `Deleted board "${board.title}" (ID: ${board.id}). This action is irreversible.`;
        } catch (err) {
          this.logger.error(`[deck_delete_board] ${err.message}`);
          return `Failed to delete board: ${err.message}`;
        }
      }
    });

    // -- Phase A: Stack ops --

    this.register({
      name: 'deck_list_stacks',
      readOnly: true,
      domains: ['deck'],
      description: 'List all stacks (columns) in a Deck board with card counts. Accepts board name (partial match) or ID.',
      parameters: {
        type: 'object',
        properties: {
          board: { type: 'string', description: 'Board name (partial match) or board ID' }
        },
        required: ['board']
      },
      handler: async (args) => {
        try {
          const board = await this._resolveBoard(deck, args.board);
          if (!board) return `No board found matching "${args.board}".`;

          const stacks = await deck.getStacks(board.id);
          if (!stacks || stacks.length === 0) return `Board "${board.title}" has no stacks.`;

          return stacks.map(s =>
            `- "${s.title}" (ID: ${s.id}, ${(s.cards || []).length} cards)`
          ).join('\n');
        } catch (err) {
          this.logger.error(`[deck_list_stacks] ${err.message}`);
          return `Failed to list stacks: ${err.message}`;
        }
      }
    });

    this.register({
      name: 'deck_create_stack',
      mutates: true,
      domains: ['deck'],
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
        try {
          const board = await this._resolveBoard(deck, args.board);
          if (!board) return `No board found matching "${args.board}".`;

          const stack = await deck.createStack(board.id, args.title, args.order || 999);
          return `Created stack "${args.title}" in board "${board.title}" (stack ID: ${stack.id}).`;
        } catch (err) {
          this.logger.error(`[deck_create_stack] ${err.message}`);
          return `Failed to create stack: ${err.message}`;
        }
      }
    });

    this.register({
      name: 'deck_rename_stack',
      mutates: true,
      domains: ['deck'],
      description: 'Rename a stack (column) in a Deck board.',
      parameters: {
        type: 'object',
        properties: {
          board: { type: 'string', description: 'Board name (partial match) or board ID' },
          stack: { type: 'string', description: 'Stack name (partial match) or stack ID' },
          title: { type: 'string', description: 'New stack title' }
        },
        required: ['board', 'stack', 'title']
      },
      handler: async (args) => {
        try {
          const board = await this._resolveBoard(deck, args.board);
          if (!board) return `No board found matching "${args.board}".`;
          const stacks = await deck.getStacks(board.id);
          const idStr = String(args.stack).replace(/^#/, '');
          const asNum = parseInt(idStr, 10);
          const stack = (!isNaN(asNum) && String(asNum) === idStr)
            ? stacks.find(s => String(s.id) === idStr)
            : stacks.find(s => s.title.toLowerCase().includes(args.stack.toLowerCase()));
          if (!stack) return `No stack found matching "${args.stack}" on board "${board.title}".`;
          await deck.updateStack(board.id, stack.id, { title: args.title });
          return `Renamed stack "${stack.title}" to "${args.title}" on board "${board.title}".`;
        } catch (err) {
          this.logger.error(`[deck_rename_stack] ${err.message}`);
          return `Failed to rename stack: ${err.message}`;
        }
      }
    });

    this.register({
      name: 'deck_delete_stack',
      mutates: true,
      writes: true,
      domains: ['deck'],
      description: 'Permanently delete a stack (column) and all its cards from a Deck board. This is irreversible and requires confirmation.',
      parameters: {
        type: 'object',
        properties: {
          board: { type: 'string', description: 'Board name (partial match) or board ID' },
          stack: { type: 'string', description: 'Stack name (partial match) or stack ID' }
        },
        required: ['board', 'stack']
      },
      handler: async (args) => {
        try {
          const board = await this._resolveBoard(deck, args.board);
          if (!board) return `No board found matching "${args.board}".`;
          const stacks = await deck.getStacks(board.id);
          const idStr = String(args.stack).replace(/^#/, '');
          const asNum = parseInt(idStr, 10);
          const stack = (!isNaN(asNum) && String(asNum) === idStr)
            ? stacks.find(s => String(s.id) === idStr)
            : stacks.find(s => s.title.toLowerCase().includes(args.stack.toLowerCase()));
          if (!stack) return `No stack found matching "${args.stack}" on board "${board.title}".`;
          await deck.deleteStack(board.id, stack.id);
          return `Deleted stack "${stack.title}" (ID: ${stack.id}) from board "${board.title}". This action is irreversible.`;
        } catch (err) {
          this.logger.error(`[deck_delete_stack] ${err.message}`);
          return `Failed to delete stack: ${err.message}`;
        }
      }
    });

    // -- Phase A: Card CRUD --

    this.register({
      name: 'deck_get_card',
      readOnly: true,
      domains: ['deck'],
      description: 'Get full details of a card including description, due date, assigned users, labels, and comments. Card identified by title (partial match) or #ID. Defaults to the task board; pass `board` to read from a shared board.',
      parameters: {
        type: 'object',
        properties: {
          card: { type: 'string', description: 'Card title (partial match) or card ID prefixed with #' },
          board: { type: 'string', description: 'Board name (partial match) or board ID. If omitted, uses the task board.' }
        },
        required: ['card']
      },
      handler: async (args) => {
        try {
          const resolution = await this._resolveCardOnBoard(deck, args.card, args.board);
          if (!resolution.found) return this._renderResolutionError(resolution, 'read');

          const { card: found, boardId, stackId, stackTitle, isDefaultBoard, stackKey } = resolution;
          const full = isDefaultBoard
            ? await deck.getCard(found.id, stackKey)
            : await deck.getCardById(boardId, stackId, found.id);
          const comments = await deck.getComments(found.id);

          let result = `Card #${full.id}: "${full.title}" in ${stackTitle}\n`;
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
        } catch (err) {
          this.logger.error(`[deck_get_card] ${err.message}`);
          return `Failed to get card: ${err.message}`;
        }
      }
    });

    this.register({
      name: 'deck_update_card',
      mutates: true,
      domains: ['deck'],
      description: 'Update a card\'s title, description, or due date. Card identified by title (partial match) or #ID. Defaults to the task board; pass `board` to update a card on a shared board.',
      parameters: {
        type: 'object',
        properties: {
          card: { type: 'string', description: 'Card title (partial match) or card ID prefixed with #' },
          title: { type: 'string', description: 'New title' },
          description: { type: 'string', description: 'New description' },
          duedate: { type: 'string', description: 'New due date (ISO format) or "none" to clear' },
          board: { type: 'string', description: 'Board name (partial match) or board ID. If omitted, uses the task board.' }
        },
        required: ['card']
      },
      handler: async (args) => {
        try {
          const resolution = await this._resolveCardOnBoard(deck, args.card, args.board);
          if (!resolution.found) return this._renderResolutionError(resolution, 'update');

          const { card: found, boardId, stackId, isDefaultBoard, stackKey } = resolution;
          const current = isDefaultBoard
            ? await deck.getCard(found.id, stackKey)
            : await deck.getCardById(boardId, stackId, found.id);

          const updates = {
            title: args.title || current.title,
            type: current.type || 'plain',
            owner: current.owner?.uid || current.owner || deck.username,
            description: args.description !== undefined ? args.description : (current.description || ''),
            duedate: args.duedate === 'none' ? null : (args.duedate || current.duedate || null)
          };

          if (isDefaultBoard) {
            await deck.updateCard(found.id, stackKey, updates);
          } else {
            await deck.updateCardById(boardId, stackId, found.id, updates);
          }

          const changes = [];
          if (args.title) changes.push(`title: "${args.title}"`);
          if (args.description !== undefined) changes.push('description updated');
          if (args.duedate) changes.push(`due: ${args.duedate}`);

          return `Updated card #${found.id} "${updates.title}".${changes.length ? ' Changes: ' + changes.join(', ') + '.' : ''}`;
        } catch (err) {
          this.logger.error(`[deck_update_card] ${err.message}`);
          return `Failed to update card: ${err.message}`;
        }
      }
    });

    this.register({
      name: 'deck_delete_card',
      mutates: true,
      writes: true,
      domains: ['deck'],
      description: 'Delete a card from the board. This is destructive and requires confirmation. Card identified by title (partial match) or #ID. Defaults to the task board; pass `board` to delete a card on a shared board.',
      parameters: {
        type: 'object',
        properties: {
          card: { type: 'string', description: 'Card title (partial match) or card ID prefixed with #' },
          board: { type: 'string', description: 'Board name (partial match) or board ID. If omitted, uses the task board.' }
        },
        required: ['card']
      },
      handler: async (args) => {
        try {
          const resolution = await this._resolveCardOnBoard(deck, args.card, args.board);
          if (!resolution.found) return this._renderResolutionError(resolution, 'delete');

          const { card: found, boardId, stackId, stackTitle, isDefaultBoard, stackKey } = resolution;
          if (isDefaultBoard) {
            await deck.deleteCard(found.id, stackKey);
          } else {
            await deck.deleteCardById(boardId, stackId, found.id);
          }
          return `Deleted card #${found.id} "${found.title}" from ${stackTitle}.`;
        } catch (err) {
          this.logger.error(`[deck_delete_card] ${err.message}`);
          return `Failed to delete card: ${err.message}`;
        }
      }
    });

    this.register({
      name: 'deck_assign_user',
      mutates: true,
      domains: ['deck'],
      description: 'Assign a user to a card. Card identified by title (partial match) or #ID. Defaults to the task board; pass `board` to assign on a shared board.',
      parameters: {
        type: 'object',
        properties: {
          card: { type: 'string', description: 'Card title (partial match) or card ID prefixed with #' },
          user: { type: 'string', description: 'NC username to assign' },
          board: { type: 'string', description: 'Board name (partial match) or board ID. If omitted, uses the task board.' }
        },
        required: ['card', 'user']
      },
      handler: async (args) => {
        const resolution = await this._resolveCardOnBoard(deck, args.card, args.board);
        if (!resolution.found) return this._renderResolutionError(resolution, 'assign on');

        const { card: found, boardId, stackId, isDefaultBoard, stackKey } = resolution;
        if (isStructuralCard(found)) {
          return `Card #${found.id} "${found.title}" is a structural/config card, not a work item. Structural cards should not be assigned to users. If you need to modify this card, do so explicitly.`;
        }

        if (isDefaultBoard) {
          const assignResult = await deck.assignUser(found.id, stackKey, args.user);
          if (assignResult === undefined || assignResult === null) {
            try {
              const updated = await deck.getCard(found.id, stackKey);
              const isAssigned = (updated.assignedUsers || []).some(
                a => (a.participant?.uid || '').toLowerCase() === args.user.toLowerCase()
              );
              if (!isAssigned) return `Could not assign "${args.user}" to card #${found.id} — user may not be a member of this board.`;
            } catch {
              return `Assignment of "${args.user}" to card #${found.id} could not be confirmed. The user may not be a member of this board.`;
            }
          }
          return `Assigned "${args.user}" to card #${found.id} "${found.title}".`;
        }

        const matched = await deck.assignUserById(boardId, stackId, found.id, args.user);
        if (matched === null) {
          return `Could not assign "${args.user}" to card #${found.id} — user may not be a member of this board.`;
        }
        return `Assigned "${matched}" to card #${found.id} "${found.title}".`;
      }
    });

    this.register({
      name: 'deck_unassign_user',
      mutates: true,
      domains: ['deck'],
      description: 'Remove a user assignment from a card. Card identified by title (partial match) or #ID. Defaults to the task board; pass `board` to unassign on a shared board.',
      parameters: {
        type: 'object',
        properties: {
          card: { type: 'string', description: 'Card title (partial match) or card ID prefixed with #' },
          user: { type: 'string', description: 'NC username to unassign' },
          board: { type: 'string', description: 'Board name (partial match) or board ID. If omitted, uses the task board.' }
        },
        required: ['card', 'user']
      },
      handler: async (args) => {
        try {
          const resolution = await this._resolveCardOnBoard(deck, args.card, args.board);
          if (!resolution.found) return this._renderResolutionError(resolution, 'unassign on');

          const { card: found, boardId, stackId, isDefaultBoard, stackKey } = resolution;
          if (isDefaultBoard) {
            await deck.unassignUser(found.id, stackKey, args.user);
            return `Unassigned "${args.user}" from card #${found.id} "${found.title}".`;
          }
          const matched = await deck.unassignUserById(boardId, stackId, found.id, args.user);
          if (matched === null) {
            return `Could not unassign "${args.user}" from card #${found.id} — user is not a member of this board.`;
          }
          return `Unassigned "${matched}" from card #${found.id} "${found.title}".`;
        } catch (err) {
          this.logger.error(`[deck_unassign_user] ${err.message}`);
          return `Failed to unassign user: ${err.message}`;
        }
      }
    });

    this.register({
      name: 'deck_set_due_date',
      mutates: true,
      domains: ['deck'],
      description: 'Set or clear the due date on a card. Card identified by title (partial match) or #ID. Defaults to the task board; pass `board` to update a card on a shared board.',
      parameters: {
        type: 'object',
        properties: {
          card: { type: 'string', description: 'Card title (partial match) or card ID prefixed with #' },
          duedate: { type: 'string', description: 'Due date in ISO format (e.g. 2026-02-15) or "none" to clear' },
          board: { type: 'string', description: 'Board name (partial match) or board ID. If omitted, uses the task board.' }
        },
        required: ['card', 'duedate']
      },
      handler: async (args) => {
        try {
          const resolution = await this._resolveCardOnBoard(deck, args.card, args.board);
          if (!resolution.found) return this._renderResolutionError(resolution, 'update');

          const { card: found, boardId, stackId, isDefaultBoard, stackKey } = resolution;
          if (isStructuralCard(found)) {
            return `Card #${found.id} "${found.title}" is a structural/config card, not a work item. Structural cards should not have due dates. If you need to modify this card, do so explicitly.`;
          }

          const current = isDefaultBoard
            ? await deck.getCard(found.id, stackKey)
            : await deck.getCardById(boardId, stackId, found.id);

          const duedate = args.duedate.toLowerCase() === 'none' ? null : args.duedate;
          const updates = {
            title: current.title,
            type: current.type || 'plain',
            owner: current.owner?.uid || current.owner || deck.username,
            duedate
          };

          if (isDefaultBoard) {
            await deck.updateCard(found.id, stackKey, updates);
          } else {
            await deck.updateCardById(boardId, stackId, found.id, updates);
          }

          return duedate
            ? `Set due date on card #${found.id} "${found.title}" to ${duedate}.`
            : `Cleared due date on card #${found.id} "${found.title}".`;
        } catch (err) {
          this.logger.error(`[deck_set_due_date] ${err.message}`);
          return `Failed to set due date: ${err.message}`;
        }
      }
    });

    // -- Phase A: Labels --

    this.register({
      name: 'deck_add_label',
      mutates: true,
      domains: ['deck'],
      description: 'Add a label to a card. Card identified by title (partial match) or #ID. Defaults to the task board; pass `board` to operate on a shared board. The label must already exist on the target board (use deck_create_label first if needed).',
      parameters: {
        type: 'object',
        properties: {
          card: { type: 'string', description: 'Card title (partial match) or card ID prefixed with #' },
          label: { type: 'string', description: 'Label name (e.g. urgent, research, writing, admin, blocked)' },
          board: { type: 'string', description: 'Board name (partial match) or board ID. If omitted, uses the task board.' }
        },
        required: ['card', 'label']
      },
      handler: async (args) => {
        try {
          const resolution = await this._resolveCardOnBoard(deck, args.card, args.board);
          if (!resolution.found) return this._renderResolutionError(resolution, 'label on');

          const { card: found, boardId, stackId, isDefaultBoard, stackKey } = resolution;
          if (isDefaultBoard) {
            await deck.addLabel(found.id, stackKey, args.label);
            return `Added label "${args.label}" to card #${found.id} "${found.title}".`;
          }

          const board = await deck.getBoard(boardId);
          const labelDef = (board.labels || []).find(l => l.title.toLowerCase() === args.label.toLowerCase());
          if (!labelDef) {
            const available = (board.labels || []).map(l => `"${l.title}"`).join(', ');
            return `No label "${args.label}" on board "${board.title}". Available labels: ${available || '(none)'}`;
          }
          await deck.assignLabelById(boardId, stackId, found.id, labelDef.id);
          return `Added label "${labelDef.title}" to card #${found.id} "${found.title}".`;
        } catch (err) {
          this.logger.error(`[deck_add_label] ${err.message}`);
          return `Failed to add label: ${err.message}`;
        }
      }
    });

    this.register({
      name: 'deck_remove_label',
      mutates: true,
      domains: ['deck'],
      description: 'Remove a label from a card. Card identified by title (partial match) or #ID. Defaults to the task board; pass `board` to operate on a shared board.',
      parameters: {
        type: 'object',
        properties: {
          card: { type: 'string', description: 'Card title (partial match) or card ID prefixed with #' },
          label: { type: 'string', description: 'Label name to remove' },
          board: { type: 'string', description: 'Board name (partial match) or board ID. If omitted, uses the task board.' }
        },
        required: ['card', 'label']
      },
      handler: async (args) => {
        try {
          const resolution = await this._resolveCardOnBoard(deck, args.card, args.board);
          if (!resolution.found) return this._renderResolutionError(resolution, 'unlabel on');

          const { card: found, boardId, stackId, isDefaultBoard, stackKey } = resolution;
          if (isDefaultBoard) {
            await deck.removeLabel(found.id, stackKey, args.label);
            return `Removed label "${args.label}" from card #${found.id} "${found.title}".`;
          }

          const board = await deck.getBoard(boardId);
          const labelDef = (board.labels || []).find(l => l.title.toLowerCase() === args.label.toLowerCase());
          if (!labelDef) {
            return `No label "${args.label}" on board "${board.title}".`;
          }
          await deck.removeLabelById(boardId, stackId, found.id, labelDef.id);
          return `Removed label "${labelDef.title}" from card #${found.id} "${found.title}".`;
        } catch (err) {
          this.logger.error(`[deck_remove_label] ${err.message}`);
          return `Failed to remove label: ${err.message}`;
        }
      }
    });

    this.register({
      name: 'deck_create_label',
      mutates: true,
      domains: ['deck'],
      description: 'Create a new label on a board. Use this when the board needs a label that doesn\'t exist yet.',
      parameters: {
        type: 'object',
        properties: {
          board_id: { type: 'number', description: 'Board ID to create the label on' },
          title: { type: 'string', description: 'Label name (e.g. urgent, research, client-A)' },
          color: { type: 'string', description: 'Hex color without # (e.g. "ff0000" for red, "00ff00" for green, "0800fd" for blue)' }
        },
        required: ['board_id', 'title', 'color']
      },
      handler: async (args) => {
        try {
          const label = await deck.createLabel(args.board_id, args.title, args.color);
          return `Created label "${args.title}" (color: #${args.color}) on board ${args.board_id}. Label ID: ${label.id}`;
        } catch (err) {
          this.logger.error(`[deck_create_label] ${err.message}`);
          return `Failed to create label: ${err.message}`;
        }
      }
    });

    // -- Phase A: Comments --

    this.register({
      name: 'deck_add_comment',
      mutates: true,
      domains: ['deck'],
      description: 'Add a comment to a card. Use this to leave notes, updates, or communicate about a task. Card identified by title (partial match) or #ID. Defaults to the task board; pass `board` to comment on a shared board.',
      parameters: {
        type: 'object',
        properties: {
          card: { type: 'string', description: 'Card title (partial match) or card ID prefixed with #' },
          message: { type: 'string', description: 'Comment text' },
          board: { type: 'string', description: 'Board name (partial match) or board ID. If omitted, uses the task board.' }
        },
        required: ['card', 'message']
      },
      handler: async (args) => {
        try {
          const resolution = await this._resolveCardOnBoard(deck, args.card, args.board);
          if (!resolution.found) return this._renderResolutionError(resolution, 'comment on');

          const { card: found } = resolution;
          await deck.addComment(found.id, args.message, 'STATUS', { prefix: false });
          return `Added comment to card #${found.id} "${found.title}".`;
        } catch (err) {
          this.logger.error(`[deck_add_comment] ${err.message}`);
          return `Failed to add comment: ${err.message}`;
        }
      }
    });

    this.register({
      name: 'deck_list_comments',
      readOnly: true,
      domains: ['deck'],
      description: 'List all comments on a card. Card identified by title (partial match) or #ID. Defaults to the task board; pass `board` to read comments on a shared board.',
      parameters: {
        type: 'object',
        properties: {
          card: { type: 'string', description: 'Card title (partial match) or card ID prefixed with #' },
          board: { type: 'string', description: 'Board name (partial match) or board ID. If omitted, uses the task board.' }
        },
        required: ['card']
      },
      handler: async (args) => {
        try {
          const resolution = await this._resolveCardOnBoard(deck, args.card, args.board);
          if (!resolution.found) return this._renderResolutionError(resolution, 'read comments on');

          const { card: found } = resolution;
          const comments = await deck.getComments(found.id);

          if (comments.length === 0) return `No comments on card #${found.id} "${found.title}".`;

          const lines = [`Comments on card #${found.id} "${found.title}":`];
          for (const c of comments) {
            const author = c.actorId || 'unknown';
            const date = c.creationDateTime || '';
            lines.push(`- [${author}] ${c.message}${date ? ` (${date})` : ''}`);
          }
          return lines.join('\n');
        } catch (err) {
          this.logger.error(`[deck_list_comments] ${err.message}`);
          return `Failed to list comments: ${err.message}`;
        }
      }
    });

    // -- Phase A: Sharing --

    this.register({
      name: 'deck_share_board',
      mutates: true,
      writes: true,
      domains: ['deck'],
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
        try {
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
        } catch (err) {
          this.logger.error(`[deck_share_board] ${err.message}`);
          return `Failed to share board: ${err.message}`;
        }
      }
    });

    // -- Phase B: Smart ops --

    this.register({
      name: 'deck_overview',
      readOnly: true,
      domains: ['deck'],
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
      readOnly: true,
      domains: ['deck'],
      description: 'List all cards assigned to a user across all accessible boards. Defaults to you if no user specified.',
      parameters: {
        type: 'object',
        properties: {
          user: { type: 'string', description: 'NC username (default: yourself)' }
        },
        required: []
      },
      handler: async (args) => {
        try {
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
        } catch (err) {
          this.logger.error(`[deck_my_assigned_cards] ${err.message}`);
          return `Failed to list assigned cards: ${err.message}`;
        }
      }
    });

    this.register({
      name: 'deck_overdue_cards',
      readOnly: true,
      domains: ['deck'],
      description: 'List all cards with past due dates across all accessible boards.',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: async () => {
        try {
          const allEntries = await this._resolveCardAcrossBoards(deck);
          const now = new Date();

          const overdue = allEntries.filter(e =>
            e.card.duedate && new Date(e.card.duedate) < now
          );

          if (overdue.length === 0) return 'No overdue cards found.';

          return overdue.map(e =>
            `- [#${e.card.id}] "${e.card.title}" — due: ${e.card.duedate} (board: ${e.boardTitle}, stack: ${e.stackTitle})`
          ).join('\n');
        } catch (err) {
          this.logger.error(`[deck_overdue_cards] ${err.message}`);
          return `Failed to list overdue cards: ${err.message}`;
        }
      }
    });

    this.register({
      name: 'deck_mark_done',
      mutates: true,
      domains: ['deck'],
      description: 'Mark a card as done by moving it to the Done stack. Card identified by title (partial match) or #ID. Defaults to the task board; pass `board` to mark a card on a shared board (requires a stack titled "Done" on that board).',
      parameters: {
        type: 'object',
        properties: {
          card: { type: 'string', description: 'Card title (partial match) or card ID prefixed with #' },
          board: { type: 'string', description: 'Board name (partial match) or board ID. If omitted, uses the task board.' }
        },
        required: ['card']
      },
      handler: async (args) => {
        try {
          const resolution = await this._resolveCardOnBoard(deck, args.card, args.board);
          if (!resolution.found) return this._renderResolutionError(resolution, 'mark done');

          const { card: found, boardId, stackId, stackTitle, isDefaultBoard, stackKey } = resolution;

          if (isDefaultBoard) {
            if (stackKey === 'done') return `Card #${found.id} "${found.title}" is already in Done.`;
            await deck.moveCard(found.id, stackKey, 'done');
            return `Marked card #${found.id} "${found.title}" as done (moved from ${this._stackDisplayName(stackKey, deck)} to Done).`;
          }

          const stacks = await deck.getStacks(boardId);
          const doneStack = (stacks || []).find(s => s.title.toLowerCase() === 'done');
          if (!doneStack) {
            const available = (stacks || []).map(s => `"${s.title}"`).join(', ');
            return `No "Done" stack on this board. Available stacks: ${available || '(none)'}. Use deck_move_card with an explicit target_stack instead.`;
          }
          if (doneStack.id === stackId) {
            return `Card #${found.id} "${found.title}" is already in "${doneStack.title}".`;
          }
          await deck.moveCardById(found.id, doneStack.id, 0);
          return `Marked card #${found.id} "${found.title}" as done (moved from "${stackTitle}" to "${doneStack.title}").`;
        } catch (err) {
          this.logger.error(`[deck_mark_done] ${err.message}`);
          return `Failed to mark card as done: ${err.message}`;
        }
      }
    });

    this.register({
      name: 'deck_complete_task',
      mutates: true,
      domains: ['deck'],
      description: 'Mark a task as complete: moves the card to Done and adds a completion comment.',
      parameters: {
        type: 'object',
        properties: {
          card_id: { type: 'number', description: 'ID of the card to complete' },
          message: { type: 'string', description: 'Completion note (what was done, results, deliverables)' }
        },
        required: ['card_id']
      },
      handler: async (args) => {
        try {
          await deck.completeTask(args.card_id, args.message || 'Task complete.');
          return `Card #${args.card_id} moved to Done.${args.message ? ' Comment added.' : ''}`;
        } catch (err) {
          this.logger.error(`[deck_complete_task] ${err.message}`);
          return `Failed to complete task: ${err.message}`;
        }
      }
    });

    this.register({
      name: 'deck_complete_review',
      mutates: true,
      domains: ['deck'],
      description: 'Complete the review process: moves a card from Review to Done with an optional final note.',
      parameters: {
        type: 'object',
        properties: {
          card_id: { type: 'number', description: 'ID of the card in Review' },
          message: { type: 'string', description: 'Final review note (optional)' }
        },
        required: ['card_id']
      },
      handler: async (args) => {
        try {
          await deck.completeReview(args.card_id, args.message || '');
          return `Review complete. Card #${args.card_id} moved to Done.`;
        } catch (err) {
          this.logger.error(`[deck_complete_review] ${err.message}`);
          return `Failed to complete review: ${err.message}`;
        }
      }
    });

    // -- Phase F3: Compound ops --

    this.register({
      name: 'deck_setup_workflow',
      mutates: true,
      writes: true,
      domains: ['deck'],
      description: 'Create a new board with a set of named stacks (columns), optionally seed it with cards in the first stack, and optionally share it with a user. Use when asked to set up a workflow or project board with a defined column structure. Requires confirmation.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Board title' },
          stacks: {
            type: 'array',
            description: 'Stack (column) names in display order',
            items: { type: 'string' }
          },
          cards: {
            type: 'array',
            description: 'Optional card titles to create in the first stack',
            items: { type: 'string' }
          },
          share_with: { type: 'string', description: 'NC username to share the board with (optional)' }
        },
        required: ['title', 'stacks']
      },
      handler: async (args) => {
        try {
          if (!Array.isArray(args.stacks) || args.stacks.length === 0) {
            return 'At least one stack name is required.';
          }

          const board = await deck.createNewBoard(args.title);
          this.logger.info(`[deck_setup_workflow] Created board "${args.title}" (${board.id})`);

          const createdStacks = [];
          for (let i = 0; i < args.stacks.length; i++) {
            try {
              const stack = await deck.createStack(board.id, args.stacks[i], i);
              createdStacks.push(stack);
              this.logger.info(`[deck_setup_workflow] Created stack "${args.stacks[i]}" (${stack.id})`);
            } catch (err) {
              this.logger.warn(`[deck_setup_workflow] Stack creation failed "${args.stacks[i]}": ${err.message}`);
            }
          }

          let cardCount = 0;
          if (Array.isArray(args.cards) && args.cards.length > 0 && createdStacks.length > 0) {
            const firstStackId = createdStacks[0].id;
            for (const cardTitle of args.cards) {
              try {
                await deck.createCardOnBoard(board.id, firstStackId, cardTitle);
                cardCount++;
              } catch (err) {
                this.logger.warn(`[deck_setup_workflow] Card creation failed "${cardTitle}": ${err.message}`);
              }
            }
          }

          if (args.share_with) {
            try {
              await deck.shareBoardWithUser(board.id, args.share_with);
              this.logger.info(`[deck_setup_workflow] Shared board ${board.id} with ${args.share_with}`);
            } catch (err) {
              this.logger.warn(`[deck_setup_workflow] Share failed for ${args.share_with}: ${err.message}`);
            }
          }

          const boardUrl = deckBoardUrl(board.id);
          const boardLink = deckLink(`"${board.title}"`, boardUrl);
          const stackSummary = createdStacks.map(s => s.title).join(' → ');
          let response = `Created board ${boardLink} with ${createdStacks.length} stack(s): ${stackSummary}.`;
          if (cardCount > 0) response += ` Added ${cardCount} card(s) to "${createdStacks[0].title}".`;
          if (args.share_with) response += ` Shared with "${args.share_with}".`;
          if (createdStacks.length < args.stacks.length) {
            response += ` Note: ${args.stacks.length - createdStacks.length} stack(s) could not be created.`;
          }
          return response;
        } catch (err) {
          this.logger.error(`[deck_setup_workflow] ${err.message}`);
          return `Failed to set up workflow: ${err.message}`;
        }
      }
    });

    this.register({
      name: 'deck_troubleshoot',
      readOnly: true,
      domains: ['deck'],
      description: 'Diagnose board access and visibility issues. Lists accessible boards and reports whether a specific board exists. Does NOT perform sharing — if a share is needed, use deck_share_board.',
      parameters: {
        type: 'object',
        properties: {
          board: { type: 'string', description: 'Board name (partial match) or board ID to check (optional)' }
        },
        required: []
      },
      handler: async (args) => {
        try {
          const boards = await deck.listBoards();
          const activeBoards = (boards || []).filter(b => !b.archived);

          if (args.board) {
            const found = await this._resolveBoard(deck, args.board);
            if (!found) {
              const list = activeBoards.length > 0
                ? `\n\nAccessible boards:\n${activeBoards.map(b => `- "${b.title}" (ID: ${b.id})`).join('\n')}`
                : '';
              return `No board found matching "${args.board}".${list}\n\nIf the board exists but is not listed, it may not be shared with this account. Use deck_share_board to grant access.`;
            }

            const owned = found.owner?.uid === deck.username || found.owner === deck.username;
            let report = `Board "${found.title}" (ID: ${found.id}) is accessible`;
            report += owned ? ' and owned by this account.' : ' (shared with this account).';
            if (found.archived) report += ' Note: this board is archived.';
            report += '\n\nIf another user cannot see it, use deck_share_board to share it with them.';
            return report;
          }

          if (activeBoards.length === 0) {
            return 'No active boards found. The account may have no boards, or all boards are archived.';
          }

          const lines = activeBoards.map(b => {
            const owned = b.owner?.uid === deck.username || b.owner === deck.username;
            return `- "${b.title}" (ID: ${b.id}, ${owned ? 'owned' : 'shared'})`;
          });
          return `Accessible boards (${activeBoards.length}):\n${lines.join('\n')}\n\nIf a board is missing for another user, use deck_share_board to share it with them.`;
        } catch (err) {
          this.logger.error(`[deck_troubleshoot] ${err.message}`);
          return `Failed to run board diagnostics: ${err.message}`;
        }
      }
    });
  }

  // ---- CALENDAR TOOLS ------------------------------------------------------

  /** @private */
  _registerCalendarTools() {
    const cal = this.clients.calDAVClient;
    if (!cal) return;
    const ncMgr = this.clients.ncRequestManager;

    this.register({
      name: 'calendar_list_events',
      readOnly: true,
      domains: ['calendar'],
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
        try {
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
        } catch (err) {
          this.logger.error(`[calendar_list_events] ${err.message}`);
          return `Failed to list events: ${err.message}`;
        }
      }
    });

    this.register({
      name: 'calendar_create_event',
      mutates: true,
      writes: true,
      domains: ['calendar'],
      description: 'Create a calendar event. Optionally checks availability first (set check_availability: true). Supports attendees with automatic invitation emails. Use duration_minutes OR end to set the event length (default: 60 minutes).',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Event title (optional). When omitted, the handler supplies a sensible default in the user\'s language — do NOT invent a title or ask the user for one; a request that states time and duration is complete.' },
          start: { type: 'string', description: 'Start datetime as ISO 8601 string' },
          end: { type: 'string', description: 'End datetime as ISO 8601 string. Overrides duration_minutes if both are given (default: start + duration_minutes, or +1 hour).' },
          duration_minutes: { type: 'number', description: 'Event length in minutes. Used to compute end when end is omitted (default: 60).' },
          check_availability: { type: 'boolean', description: 'When true, check the slot is free before creating; if not, report conflicts and create nothing (default: false).' },
          description: { type: 'string', description: 'Event description (optional)' },
          location: { type: 'string', description: 'Location (optional)' },
          attendees: {
            type: 'array',
            description: 'Attendees to invite. NC sends invitation emails automatically.',
            items: {
              type: 'object',
              properties: {
                email: { type: 'string', description: 'Attendee email address' },
                name: { type: 'string', description: 'Attendee display name (optional)' }
              },
              required: ['email']
            }
          }
        },
        required: ['start']
      },
      handler: async (args) => {
        const startDate = new Date(args.start);
        if (isNaN(startDate.getTime())) {
          return `Invalid start date: "${args.start}". Use ISO 8601 format (e.g. 2026-02-26T14:00:00).`;
        }

        // Title is optional (#167 PR-1). A request that gives a time and duration
        // is complete; it need not name the event. When no title is supplied the
        // handler defaults one in the turn's language — rather than making the
        // model invent one (small models fabricate, cloud models decline and the
        // turn stalls into the #280 clarify loop). Enrichment is structural only: named
        // attendees from the args append to the default; no prose is inspected.
        // Calendar content reaches the user through CalDAV, not Talk, so this
        // default lives in the handler, not surface-text.js (the same membership
        // boundary the past-date guard's model-facing text observes).
        const DEFAULT_TITLE = { EN: 'Meeting', DE: 'Termin', PT: 'Reunião' };
        const suppliedTitle = typeof args.title === 'string' ? args.title.trim() : '';
        let title = suppliedTitle;
        let titleDefaulted = false;
        if (!title) {
          title = DEFAULT_TITLE[this.getRequestContext().language] || DEFAULT_TITLE.EN;
          if (Array.isArray(args.attendees) && args.attendees.length > 0) {
            const names = args.attendees
              .map(a => (typeof a === 'string' ? a : a.name || a.email))
              .filter(Boolean)
              .join(', ');
            if (names) title += `: ${names}`;
          }
          titleDefaulted = true;
        }

        // Past-date rejection lives in the CalDAVClient.createEvent substrate (#169),
        // so every creation path inherits it; do not duplicate it here.

        // end wins when both end and duration_minutes are supplied; otherwise
        // duration_minutes computes end; otherwise default to a 60-minute event.
        let endDate;
        if (args.end) {
          endDate = new Date(args.end);
          if (isNaN(endDate.getTime())) {
            return `Invalid end date: "${args.end}". Use ISO 8601 format (e.g. 2026-02-26T15:00:00).`;
          }
        } else if (Number.isFinite(args.duration_minutes) && args.duration_minutes > 0) {
          endDate = new Date(startDate.getTime() + args.duration_minutes * 60 * 1000);
        } else {
          endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
        }

        if (endDate <= startDate) {
          return `Invalid time range: end (${endDate.toISOString()}) is not after start (${startDate.toISOString()}).`;
        }

        // Optional pre-creation availability check (absorbs calendar_quick_schedule).
        if (args.check_availability) {
          const availability = await cal.checkAvailability(startDate, endDate);
          if (!availability.isFree) {
            const conflicts = (availability.conflicts || []).map(c =>
              `- ${c.summary} (${new Date(c.start).toLocaleString()} – ${new Date(c.end).toLocaleString()})`
            ).join('\n');
            return `Time slot not available. Conflicts:\n${conflicts}\nNo event created. Try a different time.`;
          }
        }

        const eventData = {
          summary: title,
          start: startDate,
          end: endDate,
          description: args.description || '',
          location: args.location || ''
        };

        // Always auto-add requesting user as ATTENDEE so the event appears in their calendar.
        // If they're already in the list, upgrade their PARTSTAT to ACCEPTED.
        const reqUser = this.getRequestContext().user;
        if (reqUser && ncMgr) {
          try {
            const userEmail = await ncMgr.getUserEmail(reqUser);
            if (userEmail) {
              if (!eventData.attendees) eventData.attendees = [];
              const existingIdx = eventData.attendees.findIndex(
                a => (typeof a === 'string' ? a : a.email).toLowerCase() === userEmail.toLowerCase()
              );
              if (existingIdx >= 0) {
                const existing = eventData.attendees[existingIdx];
                eventData.attendees[existingIdx] = typeof existing === 'string'
                  ? { email: existing, name: reqUser, status: 'ACCEPTED' }
                  : { ...existing, status: 'ACCEPTED' };
              } else {
                eventData.attendees.push({ email: userEmail, name: reqUser, status: 'ACCEPTED' });
              }

              // Set organizer to Moltagent's NC identity so NC can send invitations
              const orgEmail = await ncMgr.getUserEmail(ncMgr.ncUser);
              if (orgEmail) {
                eventData.organizer = { email: orgEmail, name: ncMgr.ncUser };
              }
            }
          } catch (err) {
            this.logger.warn(`[ToolRegistry] Could not resolve email for ${reqUser}: ${err.message}`);
          }
        }

        // Merge any explicit attendees (dedup against auto-added user)
        if (args.attendees && args.attendees.length > 0) {
          if (!eventData.attendees) eventData.attendees = [];
          for (const att of args.attendees) {
            const email = (typeof att === 'string' ? att : att.email || '').toLowerCase();
            if (!eventData.attendees.some(a => (typeof a === 'string' ? a : a.email).toLowerCase() === email)) {
              eventData.attendees.push(att);
            }
          }
        }

        const event = await cal.createEvent(eventData);

        if (!event || !event.uid) {
          return `Calendar event "${title}" may not have been created — no event ID returned. Check the calendar to verify.`;
        }

        if (event.verified === false) {
          return `Warning: "${title}" was sent to the server but could not be verified. The event may not have been saved. Event ID: ${event.uid}. Please check the calendar.`;
        }

        let msg = `Created "${title}" on ${startDate.toLocaleDateString()} at ${startDate.toLocaleTimeString()}. Event ID: ${event.uid}`;
        if (titleDefaulted) {
          msg += ` No title was given, so the default "${title}" was applied — mention this so the user can rename it if they'd like.`;
        }
        if (args.attendees && args.attendees.length > 0) {
          const names = args.attendees.map(a => a.name || a.email).join(', ');
          msg += ` Invitations sent to: ${names}.`;
        }
        return msg;
      }
    });

    this.register({
      name: 'calendar_update_event',
      mutates: true,
      writes: true,
      domains: ['calendar'],
      description: 'Update an existing calendar event. Use to reschedule, rename, change duration, add attendees, or modify any event property.',
      parameters: {
        type: 'object',
        properties: {
          event: { type: 'string', description: 'Event title (partial match) or UID to find the event' },
          title: { type: 'string', description: 'New title' },
          start: { type: 'string', description: 'New start datetime as ISO 8601 string' },
          end: { type: 'string', description: 'New end datetime as ISO 8601 string' },
          description: { type: 'string', description: 'New description' },
          location: { type: 'string', description: 'New location' },
          all_day: { type: 'boolean', description: 'Set as all-day event' },
          attendees: {
            type: 'array',
            description: 'Attendees to add/set. NC sends invitation emails automatically.',
            items: {
              type: 'object',
              properties: {
                email: { type: 'string', description: 'Attendee email address' },
                name: { type: 'string', description: 'Attendee display name (optional)' }
              },
              required: ['email']
            }
          }
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
        if (args.attendees !== undefined) {
          updates.attendees = [...args.attendees];

          // Auto-add requesting user as ATTENDEE when attendees are being set.
          // If already listed, upgrade PARTSTAT to ACCEPTED.
          const reqUser = this.getRequestContext().user;
          if (reqUser && ncMgr) {
            try {
              const userEmail = await ncMgr.getUserEmail(reqUser);
              if (userEmail) {
                const existingIdx = updates.attendees.findIndex(
                  a => (typeof a === 'string' ? a : a.email).toLowerCase() === userEmail.toLowerCase()
                );
                if (existingIdx >= 0) {
                  const existing = updates.attendees[existingIdx];
                  updates.attendees[existingIdx] = typeof existing === 'string'
                    ? { email: existing, name: reqUser, status: 'ACCEPTED' }
                    : { ...existing, status: 'ACCEPTED' };
                } else {
                  updates.attendees.push({ email: userEmail, name: reqUser, status: 'ACCEPTED' });
                }
              }
            } catch (err) {
              this.logger.warn(`[ToolRegistry] Could not resolve email for ${reqUser}: ${err.message}`);
            }
          }

          // Set organizer to Moltagent's NC identity
          if (ncMgr && !foundEvent.organizer) {
            try {
              const orgEmail = await ncMgr.getUserEmail(ncMgr.ncUser);
              if (orgEmail) {
                updates.organizer = { email: orgEmail, name: ncMgr.ncUser };
              }
            } catch (err) {
              this.logger.warn(`[ToolRegistry] Could not resolve organizer email: ${err.message}`);
            }
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
        if (args.attendees && args.attendees.length > 0) {
          const names = args.attendees.map(a => a.name || a.email).join(', ');
          changedFields.push(`attendees: ${names}`);
        }

        return `Updated "${originalTitle}"${changedFields.length ? '. Changes: ' + changedFields.join(', ') : ''}.`;
      }
    });

    this.register({
      name: 'calendar_delete_event',
      mutates: true,
      writes: true,
      domains: ['calendar'],
      description: 'Delete a calendar event.',
      parameters: {
        type: 'object',
        properties: {
          event: { type: 'string', description: 'Event title (partial match) or UID to find the event' }
        },
        required: ['event']
      },
      handler: async (args) => {
        try {
          const match = await this._findCalendarEvent(cal, args.event);
          if (!match) {
            return `No event found matching "${args.event}" in the next 30 days or past 7 days.`;
          }
          const { event: foundEvent, calendarId: foundCalendar } = match;

          await cal.deleteEvent(foundCalendar, foundEvent.uid, foundEvent.etag);

          const eventTitle = foundEvent.summary || 'Untitled';
          const eventStart = foundEvent.start ? new Date(foundEvent.start).toLocaleString() : '';
          return `Deleted "${eventTitle}"${eventStart ? ` (was scheduled for ${eventStart})` : ''}.`;
        } catch (err) {
          this.logger.error(`[calendar_delete_event] ${err.message}`);
          return `Failed to delete event: ${err.message}`;
        }
      }
    });

    this.register({
      name: 'calendar_check_availability',
      readOnly: true,
      domains: ['calendar'],
      description: 'Check whether a time slot is free. Returns availability and any conflicting events. If end is omitted, checks a 1-hour window from start.',
      parameters: {
        type: 'object',
        properties: {
          start: {
            type: 'string',
            description: 'Start datetime to check as ISO 8601 string (e.g., "2026-02-25T15:00:00").'
          },
          end: {
            type: 'string',
            description: 'End datetime as ISO 8601 string (optional; default: 1 hour after start).'
          }
        },
        required: ['start']
      },
      handler: async (args) => {
        try {
          const start = new Date(args.start);
          if (isNaN(start.getTime())) {
            return `Invalid start date: "${args.start}". Use ISO 8601 format (e.g. 2026-02-25T15:00:00).`;
          }
          const end = args.end
            ? new Date(args.end)
            : new Date(start.getTime() + 60 * 60 * 1000);
          if (args.end && isNaN(end.getTime())) {
            return `Invalid end date: "${args.end}". Use ISO 8601 format (e.g. 2026-02-25T16:00:00).`;
          }
          const result = await cal.checkAvailability(start, end);
          if (result.isFree) {
            return `You're free from ${start.toLocaleString()} to ${end.toLocaleString()}. No conflicts.`;
          }
          const conflicts = result.conflicts.map(c =>
            `- ${c.summary} (${new Date(c.start).toLocaleString()} – ${new Date(c.end).toLocaleString()})`
          ).join('\n');
          return `Not available. Conflicts:\n${conflicts}`;
        } catch (err) {
          this.logger.error(`[calendar_check_availability] ${err.message}`);
          return `Failed to check availability: ${err.message}`;
        }
      }
    });

    // calendar_quick_schedule and calendar_schedule_meeting retired (#169):
    // calendar_create_event now subsumes both via check_availability +
    // duration_minutes + attendees. Past-date guard lives in the CalDAV substrate.

    this.register({
      name: 'calendar_cancel_meeting',
      mutates: true,
      writes: true,
      domains: ['calendar'],
      description: 'Cancel a scheduled meeting and send cancellation notices to all attendees.',
      parameters: {
        type: 'object',
        properties: {
          calendar_id: { type: 'string', description: 'Calendar ID containing the meeting' },
          event_uid: { type: 'string', description: 'UID of the meeting event to cancel' },
          reason: { type: 'string', description: 'Cancellation reason (included in notice to attendees, optional)' }
        },
        required: ['calendar_id', 'event_uid']
      },
      handler: async (args) => {
        try {
          await cal.cancelMeeting(args.calendar_id, args.event_uid, args.reason || '');
          const reasonNote = args.reason ? ` Reason: "${args.reason}"` : '';
          return `Meeting cancelled. Cancellation notices sent to attendees.${reasonNote}`;
        } catch (err) {
          this.logger.error(`[calendar_cancel_meeting] ${err.message}`);
          return `Failed to cancel meeting: ${err.message}`;
        }
      }
    });
  }

  // ---- MEETING TOOLS --------------------------------------------------------

  /** @private */
  _registerMeetingTools() {
    const composer = this.clients.meetingComposer;
    if (!composer) return;

    this.register({
      name: 'meeting_compose',
      mutates: true,
      domains: ['calendar'],
      description: 'Start or continue a smart meeting scheduling flow. Resolves participant names from Nextcloud Contacts, checks calendar conflicts, asks for confirmation, creates the event, sends invitations, and tracks RSVPs on Deck. Works in multiple languages (EN/DE/PT). Use this for natural language meeting requests like "Schedule a meeting with João and Maria next Tuesday at 2pm".',
      parameters: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: 'Natural language meeting request or follow-up response (disambiguation, confirmation)'
          },
          user_id: {
            type: 'string',
            description: 'User ID of the person requesting the meeting'
          },
          conversation_token: {
            type: 'string',
            description: 'Talk conversation token for responses'
          }
        },
        required: ['message', 'user_id']
      },
      handler: async (args) => {
        try {
          const result = await composer.process(
            args.message,
            args.user_id,
            args.conversation_token || null
          );
          return result;
        } catch (err) {
          this.logger.error(`[meeting_compose] ${err.message}`);
          return `Failed to process meeting request: ${err.message}`;
        }
      }
    });

    this.register({
      name: 'meeting_check_rsvp',
      readOnly: true,
      domains: ['calendar'],
      description: 'Check RSVP status for a scheduled meeting. Shows who accepted, declined, or hasn\'t responded yet.',
      parameters: {
        type: 'object',
        properties: {
          meeting_title: {
            type: 'string',
            description: 'Title or part of the meeting name to check RSVPs for'
          }
        },
        required: ['meeting_title']
      },
      handler: async (args) => {
        try {
          const rsvpTracker = this.clients.rsvpTracker;
          if (!rsvpTracker) return 'RSVP tracking is not available.';

          // getStatus() is keyed by UID; resolve the title against the
          // pending summary first, then fetch that event's attendee detail.
          const pending = rsvpTracker.getPendingSummary();
          if (!pending || pending.length === 0) return 'No meetings are currently being tracked for RSVPs.';

          const lower = args.meeting_title.toLowerCase();
          const found = pending.find(e =>
            e.summary && e.summary.toLowerCase().includes(lower)
          );

          if (!found) return `No tracked meeting found matching "${args.meeting_title}".`;

          const match = rsvpTracker.getStatus(found.uid);
          if (!match.found) return `No tracked meeting found matching "${args.meeting_title}".`;

          const lines = match.attendees.map(a => {
            const icon = a.lastStatus === 'ACCEPTED' ? '✅' :
                         a.lastStatus === 'DECLINED' ? '❌' :
                         a.lastStatus === 'TENTATIVE' ? '🟡' : '⬜';
            return `${icon} ${a.name} (${a.email}) — ${a.lastStatus}`;
          });

          return `RSVP status for "${match.summary}":\n${lines.join('\n')}`;
        } catch (err) {
          this.logger.error(`[meeting_check_rsvp] ${err.message}`);
          return `Failed to check RSVPs: ${err.message}`;
        }
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

  // NOTE: If a tool modifies external state (email, files, calendar),
  // evaluate adding it to SENSITIVE_TOOLS in src/lib/agent/guardrail-enforcer.js

  /** @private */
  _registerFileTools() {
    const files = this.clients.ncFilesClient;
    if (!files) return;

    this.register({
      name: 'file_read',
      readOnly: true,
      domains: ['file'],
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
      readOnly: true,
      domains: ['file'],
      description: 'List files and folders in a Nextcloud directory. Shows name, size, modified date, and type.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path to list. Defaults to root.' }
        },
        required: []
      },
      handler: async (args) => {
        try {
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
        } catch (err) {
          this.logger.error(`[file_list] ${err.message}`);
          return `Failed to list files: ${err.message}`;
        }
      }
    });

    this.register({
      name: 'file_write',
      mutates: true,
      writes: true,
      domains: ['file'],
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
        if (!args.content && args.content !== '') {
          return `file_write requires "content" — received empty or missing content for "${args.path}".`;
        }
        try {
          // Ensure parent directory exists (mkdir is idempotent — 405 on exists)
          const parts = (args.path || '').split('/');
          if (parts.length > 1) {
            const parentDir = parts.slice(0, -1).join('/');
            await files.mkdir(parentDir);
          }
          await files.writeFile(args.path, args.content);

          // Auto-share with requesting user (best-effort)
          const reqUser = this.getRequestContext().user;
          if (reqUser && files.shareFile) {
            try {
              await files.shareFile(args.path, reqUser);
            } catch (shareErr) {
              this.logger.warn(`[ToolRegistry] file_write auto-share failed for ${reqUser}: ${shareErr.message}`);
            }
          }

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
      readOnly: true,
      domains: ['file'],
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
      mutates: true,
      writes: true,
      domains: ['file'],
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
        try {
          await files.moveFile(args.from_path, args.to_path);
          return `Moved "${args.from_path}" to "${args.to_path}".`;
        } catch (err) {
          this.logger.error(`[file_move] ${err.message}`);
          return `Failed to move file: ${err.message}`;
        }
      }
    });

    this.register({
      name: 'file_copy',
      mutates: true,
      domains: ['file'],
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
        try {
          await files.copyFile(args.from_path, args.to_path);
          return `Copied "${args.from_path}" to "${args.to_path}".`;
        } catch (err) {
          this.logger.error(`[file_copy] ${err.message}`);
          return `Failed to copy file: ${err.message}`;
        }
      }
    });

    this.register({
      name: 'file_delete',
      mutates: true,
      writes: true,
      domains: ['file'],
      description: 'Delete a file or folder. Requires confirmation.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File or folder path to delete' }
        },
        required: ['path']
      },
      handler: async (args) => {
        try {
          await files.deleteFile(args.path);
          return `Deleted "${args.path}".`;
        } catch (err) {
          this.logger.error(`[file_delete] ${err.message}`);
          return `Failed to delete file: ${err.message}`;
        }
      }
    });

    this.register({
      name: 'file_mkdir',
      mutates: true,
      domains: ['file'],
      description: 'Create a new folder in your workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Folder path to create' }
        },
        required: ['path']
      },
      handler: async (args) => {
        try {
          await files.mkdir(args.path);
          return `Created folder "${args.path}".`;
        } catch (err) {
          this.logger.error(`[file_mkdir] ${err.message}`);
          return `Failed to create folder: ${err.message}`;
        }
      }
    });

    this.register({
      name: 'file_share',
      mutates: true,
      writes: true,
      domains: ['file'],
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
        try {
          const result = await files.shareFile(args.path, args.share_with, args.permission || 'read');
          return `Shared "${args.path}" with "${args.share_with}" (${args.permission || 'read'} access).${result.shareId ? ' Share ID: ' + result.shareId : ''}`;
        } catch (err) {
          this.logger.error(`[file_share] ${err.message}`);
          return `Failed to share file: ${err.message}`;
        }
      }
    });

    // file_extract: requires both ncFilesClient and textExtractor
    const extractor = this.clients.textExtractor;
    if (extractor) {
      this.register({
        name: 'file_extract',
        readOnly: true,
        domains: ['file'],
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
      readOnly: true,
      domains: ['search'],
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
        try {
          const providerIds = args.providers
            ? args.providers.split(',').map(s => s.trim()).filter(Boolean)
            : undefined;
          const limit = args.limit || 5;
          const memorySearcher = this.clients.memorySearcher;

          // Wiki/knowledge queries: route through MemorySearcher for 3-channel fusion
          // (keyword + vector + graph) with LTP access tracking.
          // Non-wiki provider requests fall back to direct NC search.
          const isWikiQuery = !providerIds ||
            providerIds.every(p => p.startsWith('collectives'));

          if (memorySearcher && isWikiQuery) {
            const scope = providerIds ? 'wiki' : 'all';
            const fused = await memorySearcher.search(args.query, { maxResults: limit, scope });
            if (fused.length === 0) {
              return `No results found for "${args.query}".`;
            }
            return fused.map(r => {
              const label = r.source || 'Result';
              return `[${label}] ${r.title}${r.excerpt ? ' — ' + r.excerpt : ''}`;
            }).join('\n');
          }

          // Fallback: direct NC search (non-wiki providers or no memorySearcher)
          const results = await search.search(args.query, providerIds, limit);

          if (results.length === 0) {
            return `No results found for "${args.query}".`;
          }

          return results.map(r =>
            `[${r.provider}] ${r.title}${r.subline ? ' — ' + r.subline : ''}`
          ).join('\n');
        } catch (err) {
          this.logger.error(`[unified_search] ${err.message}`);
          return `Failed to search: ${err.message}`;
        }
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
      mutates: true,
      domains: ['file'],
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
        try {
          const success = await tags.tagFileByPath(args.path, args.tag);
          return success
            ? `Tagged "${args.path}" as ${args.tag}.`
            : `Failed to tag "${args.path}" as ${args.tag}.`;
        } catch (err) {
          this.logger.error(`[tag_file] ${err.message}`);
          return `Failed to tag file: ${err.message}`;
        }
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
      readOnly: true,
      domains: ['search'],
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
    const resilientWriter = this.clients.resilientWriter;

    this.register({
      name: 'wiki_read',
      readOnly: true,
      domains: ['wiki'],
      description: 'Read a page from the Moltagent Knowledge wiki. Returns page content with frontmatter metadata summary.',
      parameters: {
        type: 'object',
        properties: {
          page_title: { type: 'string', description: 'Page title to read (e.g. "People/John Smith" or "Projects/Q3 Campaign")' }
        },
        required: ['page_title']
      },
      handler: async (args) => {
        try {
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
        } catch (err) {
          if (err.statusCode >= 500) {
            return `Wiki service is temporarily unavailable (HTTP ${err.statusCode}). Cannot read "${args.page_title}" right now.`;
          }
          this.logger.error(`[wiki_read] ${err.message}`);
          return `Failed to read wiki page: ${err.message}`;
        }
      }
    });

    this.register({
      name: 'wiki_write',
      mutates: true,
      writes: true,
      domains: ['wiki'],
      description: 'Create or update a page in the Moltagent Knowledge wiki. Content can include YAML frontmatter between --- delimiters. To ADD to an existing page rather than replace it, call wiki_read first, then wiki_write with the merged content.',
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
        // Knowledge-graph population — Path-A port of the retired Path-B wiki executor side-effect.
        // Fire-and-forget: graph population must never block or fail the write itself.
        const populateGraph = (title, body) => {
          const extractor = this.clients.entityExtractor;
          if (!extractor || typeof extractor.extractFromPage !== 'function') return;
          Promise.resolve()
            .then(() => extractor.extractFromPage(title, body))
            .then(() => this.logger.info(`[wiki_write] entity extraction complete for "${title}"`))
            .catch(err => this.logger.warn(`[wiki_write] entity extraction failed for "${title}": ${err.message}`));
        };
        try {
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
            // Update existing page — resilient path if available
            if (resilientWriter) {
              await resilientWriter.updatePage(existing.path, writeContent);
            } else {
              await wiki.writePageContent(existing.path, writeContent);
            }

            // Touch page to invalidate NC Text editor cache
            if (existing.page && existing.page.id) {
              const cId = await wiki.resolveCollective();
              await wiki.touchPage(cId, existing.page.id);
            }

            // Log to learning log
            if (this.clients.learningLog) {
              try {
                const { parseFrontmatter } = require('../knowledge/frontmatter');
                const { frontmatter: fm } = parseFrontmatter(writeContent);
                this.clients.learningLog.logKnowledgeChange('updated', args.page_title, { confidence: fm.confidence });
              } catch { /* best effort */ }
            }

            populateGraph(args.page_title, writeContent);
            const updateUrl = wiki.buildPageUrl(existing.page.title, existing.page.id);
            return `Updated wiki page "${args.page_title}" at ${existing.path}. [View](${updateUrl})`;
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
            if (resilientWriter) {
              await resilientWriter.updatePage(fallbackPath, writeContent);
            } else {
              await wiki.writePageContent(fallbackPath, writeContent);
            }
            // Touch page to invalidate NC Text editor cache
            if (existingByList.id) {
              await wiki.touchPage(collectiveId, existingByList.id);
            }
            populateGraph(args.page_title, writeContent);
            const dedupUrl = wiki.buildPageUrl(existingByList.title, existingByList.id);
            return `Updated wiki page "${leafTitle}" (dedup: found via list scan). [View](${dedupUrl})`;
          }

          // Create the page with just the leaf title
          const created = await wiki.createPage(collectiveId, parentId, leafTitle);

          if (!created || !created.id) {
            return `Failed to create wiki page "${leafTitle}" — no page ID returned.`;
          }

          // Use API-returned path for WebDAV write
          const pagePath = created.filePath
            ? `${created.filePath}/${created.fileName}`
            : created.fileName || `${leafTitle}.md`;

          // Write content — resilient path if available
          if (resilientWriter) {
            await resilientWriter.updatePage(pagePath, writeContent);
          } else {
            await wiki.writePageContent(pagePath, writeContent);
          }

          // Touch page to invalidate NC Text editor cache
          try { await wiki.touchPage(collectiveId, created.id); } catch { /* best effort */ }

          // Log to learning log
          if (this.clients.learningLog) {
            try {
              const { parseFrontmatter } = require('../knowledge/frontmatter');
              const { frontmatter: fm } = parseFrontmatter(writeContent);
              this.clients.learningLog.logKnowledgeChange('created', args.page_title, { confidence: fm.confidence });
            } catch { /* best effort */ }
          }

          populateGraph(args.page_title, writeContent);
          const createUrl = wiki.buildPageUrl(leafTitle, created.id);
          return `Created wiki page "${leafTitle}" (page #${created.id})${parentHint ? ` under ${parentHint}` : ''}. [View](${createUrl})`;
        } catch (err) {
          if (err.statusCode >= 500) {
            return `Wiki service is temporarily unavailable (HTTP ${err.statusCode}). Your content was NOT saved. Please try again later.`;
          }
          this.logger.error(`[wiki_write] ${err.message}`);
          return `Failed to write wiki page: ${err.message}`;
        }
      }
    });

    this.register({
      name: 'wiki_search',
      readOnly: true,
      domains: ['wiki'],
      description: 'Search the Moltagent Knowledge wiki for pages matching a query.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search term' }
        },
        required: ['query']
      },
      handler: async (args) => {
        const memorySearcher = this.clients.memorySearcher;
        const ncSearch = this.clients.ncSearchClient;

        // Primary: MemorySearcher 3-channel fusion (keyword + vector + graph)
        // with LTP access tracking — richer ranking than raw NC search.
        if (memorySearcher) {
          try {
            const fused = await memorySearcher.search(args.query, { scope: 'wiki', maxResults: 10 });
            if (fused.length > 0) {
              return fused.map(r => {
                let line = `- "${r.title}"`;
                if (r.excerpt) line += ` — ${r.excerpt.substring(0, 100)}`;
                if (r.link) line += ` [View](${r.link})`;
                return line;
              }).join('\n');
            }
          } catch (err) {
            this.logger.warn(`[wiki_search] MemorySearcher failed, falling back: ${err.message}`);
          }
        }

        // Fallback: direct NC Unified Search (collectives-page-content + collectives-pages)
        let results = [];
        if (ncSearch) {
          try {
            const [contentHits, titleHits] = await Promise.allSettled([
              ncSearch.searchProvider('collectives-page-content', args.query, 5),
              ncSearch.searchProvider('collectives-pages', args.query, 5)
            ]);
            const content = contentHits.status === 'fulfilled' ? contentHits.value : [];
            const titles = titleHits.status === 'fulfilled' ? titleHits.value : [];

            // Merge, deduplicate by title
            const seen = new Set();
            for (const entry of [...titles, ...content]) {
              const key = (entry.title || '').toLowerCase();
              if (key && !seen.has(key)) {
                seen.add(key);
                results.push(entry);
              }
            }
          } catch (err) {
            this.logger.warn(`[wiki_search] NC Unified Search failed: ${err.message}`);
          }
        }

        // Last resort: listPages + client-side filter
        if (results.length === 0) {
          try {
            const collectiveId = await wiki.resolveCollective();
            if (collectiveId) {
              const allPages = await wiki.listPages(collectiveId);
              const queryLower = (args.query || '').toLowerCase();
              results = (allPages || []).filter(p =>
                (p.title || '').toLowerCase().includes(queryLower)
              );
            }
          } catch (err) {
            this.logger.warn(`[wiki_search] listPages fallback failed: ${err.message}`);
          }
        }

        if (results.length === 0) {
          return `No wiki pages found matching "${args.query}".`;
        }

        return results.map(p => {
          let line = `- "${p.title}"`;
          if (p.emoji) line += ` ${p.emoji}`;
          if (p.excerpt || p.subline || p.snippet) line += ` — ${(p.excerpt || p.subline || p.snippet).substring(0, 100)}`;
          if (p.resourceUrl) line += ` [View](${p.resourceUrl})`;
          else if (p.id) line += ` [View](${wiki.buildPageUrl(p.title, p.id)})`;
          return line;
        }).join('\n');
      }
    });

    this.register({
      name: 'wiki_list',
      readOnly: true,
      domains: ['wiki', 'search'],
      description: 'List pages in a section of the Moltagent Knowledge wiki. Sections: People, Projects, Procedures, Research, Meta.',
      parameters: {
        type: 'object',
        properties: {
          section: { type: 'string', description: 'Section name to list (e.g. "People", "Projects"). Omit for root-level pages.' }
        },
        required: []
      },
      handler: async (args) => {
        try {
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
        } catch (err) {
          this.logger.error(`[wiki_list] ${err.message}`);
          return `Failed to list wiki pages: ${err.message}`;
        }
      }
    });

    this.register({
      name: 'wiki_delete',
      mutates: true,
      writes: true,
      domains: ['wiki'],
      description: 'Delete (trash) a page from the Moltagent Knowledge wiki. This action cannot be undone.',
      parameters: {
        type: 'object',
        properties: {
          page_title: { type: 'string', description: 'Title of the wiki page to delete (e.g. "People/John Smith" or "Outdated Notes")' }
        },
        required: ['page_title']
      },
      handler: async (args) => {
        try {
          const collectiveId = await wiki.resolveCollective();
          if (!collectiveId) return 'Could not find the knowledge wiki collective.';

          const found = await wiki.findPageByTitle(args.page_title);
          if (!found || !found.page) {
            return `No wiki page found matching "${args.page_title}". Use wiki_search or wiki_list to find pages.`;
          }

          await wiki.trashPage(collectiveId, found.page.id);

          // Invalidate wikilink cache so deleted page is removed
          wiki._wikilinkMap = null;

          return `Deleted wiki page "${found.page.title}" (page #${found.page.id}).`;
        } catch (err) {
          this.logger.error(`[wiki_delete] ${err.message}`);
          return `Failed to delete wiki page: ${err.message}`;
        }
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
        readOnly: true,
        universal: true,
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
          try {
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
          } catch (err) {
            this.logger.error(`[web_search] ${err.message}`);
            return `Failed to search the web: ${err.message}`;
          }
        }
      });
    }

    if (webReader) {
      this.register({
        name: 'web_read',
        readOnly: true,
        domains: ['search'],
        description: 'Fetch and extract readable content from a URL. Returns article text, title, and metadata.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'URL to read' }
          },
          required: ['url']
        },
        handler: async (args) => {
          try {
            const result = await webReader.read(args.url);
            let output = `**${result.title}**\nSource: ${result.url}\n\n${result.content}`;
            if (result.truncated) {
              output += '\n\n(Content was truncated due to length)';
            }
            return output;
          } catch (err) {
            this.logger.error(`[web_read] ${err.message}`);
            return `Failed to read web page: ${err.message}`;
          }
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
      readOnly: true,
      domains: ['email', 'search'],
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
      readOnly: true,
      domains: ['email'],
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

    this.register({
      name: 'contacts_resolve',
      readOnly: true,
      domains: ['email'],
      description: 'Look up a contact by name. Returns email, phone, and other details. Handles partial names and disambiguates if multiple matches are found.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name to search for (first name, last name, or full name)' }
        },
        required: ['name']
      },
      handler: async (args) => {
        try {
          const result = await contacts.resolve(args.name);
          if (!result || result.error === 'no_match') {
            return `No contact found matching "${args.name}". Try a different spelling or check the address book.`;
          }
          if (!result.resolved && result.options) {
            const options = result.options.map(c =>
              `- ${c.name || c.displayName} (${c.email || 'no email'})`
            ).join('\n');
            return `Multiple contacts match "${args.name}":\n${options}\nPlease specify which one.`;
          }
          if (result.resolved && result.contact) {
            const c = result.contact;
            const details = [];
            if (c.email) details.push(`Email: ${c.email}`);
            if (c.phone) details.push(`Phone: ${c.phone}`);
            if (c.org) details.push(`Org: ${c.org}`);
            return `${c.name || c.displayName}\n${details.join('\n')}`;
          }
          return `No contact found matching "${args.name}".`;
        } catch (err) {
          this.logger.error(`[contacts_resolve] ${err.message}`);
          return `Failed to look up contact: ${err.message}`;
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
      readOnly: true,
      domains: ['email', 'wiki', 'search'],
      description: 'Search across your knowledge wiki, Talk conversations, files, tasks, and calendar. Use to recall past decisions, people, project details, conversations, or events. Supports time filtering with since/until.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Natural language search query (e.g., "budget decision", "meeting with Alex")'
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
        try {
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
        } catch (err) {
          this.logger.error(`[memory_search] ${err.message}`);
          return `Failed to search memory: ${err.message}`;
        }
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
    const deck = this.clients.deckClient;

    this.register({
      name: 'workflow_deck_move_card',
      mutates: true,
      domains: ['workflow'],
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
        try {
          await nc.request(`/index.php/apps/deck/cards/${args.card_id}/reorder`, {
            method: 'PUT',
            body: { stackId: args.target_stack_id, order: args.order || 0 }
          });
          return `Moved card ${args.card_id} to stack ${args.target_stack_id}.`;
        } catch (err) {
          this.logger.error(`[workflow_deck_move_card] ${err.message}`);
          return `Failed to move card: ${err.message}`;
        }
      }
    });

    this.register({
      name: 'workflow_deck_add_comment',
      mutates: true,
      domains: ['workflow'],
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
        try {
          await nc.request(`/ocs/v2.php/apps/deck/api/v1.0/cards/${args.card_id}/comments`, {
            method: 'POST',
            body: { message: args.message }
          });
          return `Added comment to card ${args.card_id}.`;
        } catch (err) {
          this.logger.error(`[workflow_deck_add_comment] ${err.message}`);
          return `Failed to add comment: ${err.message}`;
        }
      }
    });

    this.register({
      name: 'workflow_deck_create_card',
      mutates: true,
      domains: ['workflow'],
      description: 'Create a card on any board. Provide board_id and either stack (name) or stack_id. Stack names are resolved against the target board to avoid cross-board ID mismatches.',
      parameters: {
        type: 'object',
        properties: {
          board_id: { type: 'number', description: 'Numeric board ID' },
          stack_id: { type: 'number', description: 'Numeric stack ID (validated against board)' },
          stack: { type: 'string', description: 'Stack name (e.g. "Inbox") — preferred over stack_id' },
          title: { type: 'string', description: 'Card title' },
          description: { type: 'string', description: 'Card description (optional)' }
        },
        required: ['board_id', 'title']
      },
      handler: async (args) => {
        // Resolve the target stack from the board's actual stacks
        let stacks;
        try {
          stacks = deck
            ? await deck.getStacks(args.board_id)
            : (await nc.request(`/index.php/apps/deck/api/v1.0/boards/${args.board_id}/stacks`, { method: 'GET' })).body;
        } catch (err) {
          return `Board ${args.board_id} not found or inaccessible: ${err.message}`;
        }

        if (!stacks || stacks.length === 0) {
          return `Board ${args.board_id} has no stacks.`;
        }

        let targetStack;
        if (args.stack) {
          // Resolve by name (case-insensitive)
          targetStack = stacks.find(s => s.title.toLowerCase() === args.stack.toLowerCase());
          if (!targetStack) {
            const available = stacks.map(s => `"${s.title}" (ID: ${s.id})`).join(', ');
            return `No stack "${args.stack}" on board ${args.board_id}. Available: ${available}`;
          }
        } else if (args.stack_id) {
          // Validate numeric ID belongs to this board
          targetStack = stacks.find(s => s.id === args.stack_id);
          if (!targetStack) {
            const available = stacks.map(s => `"${s.title}" (ID: ${s.id})`).join(', ');
            return `Stack ID ${args.stack_id} not found on board ${args.board_id}. Available: ${available}`;
          }
        } else {
          // Default to first stack (usually "Inbox")
          targetStack = stacks[0];
        }

        // Route through DeckClient guard (checks CONFIG: card for PAUSED label)
        console.log(`[workflow_deck_create_card] board=${args.board_id} stack=${targetStack.id} stackName="${targetStack.title}" — routing through createCardOnBoard`);
        let card;
        if (deck) {
          card = await deck.createCardOnBoard(args.board_id, targetStack.id, args.title, { description: args.description || '' });
          if (card === null) {
            this.logger.info(`[workflow_deck_create_card] Stack "${targetStack.title}" is PAUSED — blocked`);
            return `Stack "${targetStack.title}" is PAUSED — card "${args.title}" not created.`;
          }
        } else {
          const resp = await nc.request(
            `/index.php/apps/deck/api/v1.0/boards/${args.board_id}/stacks/${targetStack.id}/cards`,
            { method: 'POST', body: { title: args.title, type: 'plain', order: 0, description: args.description || '' } }
          );
          card = resp.body || resp;
        }
        if (!card || !card.id) return `Failed to create "${args.title}" — no card ID returned.`;
        return `Created "${args.title}" (card #${card.id}) in "${targetStack.title}" (stack ${targetStack.id}) on board ${args.board_id}.`;
      }
    });

    this.register({
      name: 'workflow_deck_update_card',
      mutates: true,
      domains: ['workflow'],
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
        try {
          // GET current card so the PUT carries a complete body. See #139.
          const card = deck
            ? await deck.getCardById(args.board_id, args.stack_id, args.card_id)
            : (await nc.request(
                `/index.php/apps/deck/api/v1.0/boards/${args.board_id}/stacks/${args.stack_id}/cards/${args.card_id}`,
                { method: 'GET' }
              )).body || {};

          const changes = {};
          if (args.title !== undefined) changes.title = args.title;
          if (args.description !== undefined) changes.description = args.description;
          if (args.duedate !== undefined) changes.duedate = args.duedate;

          if (deck) {
            await deck.updateCardComplete(args.board_id, args.stack_id, args.card_id, card, changes);
          } else {
            // Fallback when no DeckClient is available: replicate the complete-body
            // logic inline, including the finite-number `order` gate.
            const body = {
              title:       changes.title       ?? card.title,
              type:        card.type           ?? 'plain',
              owner:       card.owner?.uid     ?? card.owner ?? '',
              description: changes.description ?? card.description ?? '',
              duedate:     changes.duedate     ?? card.duedate ?? null
            };
            const resolvedOrder = card.order;
            if (Number.isFinite(resolvedOrder)) body.order = resolvedOrder;
            await nc.request(
              `/index.php/apps/deck/api/v1.0/boards/${args.board_id}/stacks/${args.stack_id}/cards/${args.card_id}`,
              { method: 'PUT', body }
            );
          }

          const changeList = [];
          if (args.title) changeList.push(`title: "${args.title}"`);
          if (args.description !== undefined) changeList.push('description updated');
          if (args.duedate !== undefined) changeList.push(`due: ${args.duedate}`);

          return `Updated card ${args.card_id}.${changeList.length ? ' Changes: ' + changeList.join(', ') + '.' : ''}`;
        } catch (err) {
          this.logger.error(`[workflow_deck_update_card] ${err.message}`);
          return `Failed to update card: ${err.message}`;
        }
      }
    });

    this.register({
      name: 'workflow_deck_assign_label',
      mutates: true,
      domains: ['workflow'],
      description: 'Assign a label to a card using raw numeric IDs. Use this in workflow processing to add labels (e.g. GATE, APPROVED) to cards on any board.',
      parameters: {
        type: 'object',
        properties: {
          board_id: { type: 'number', description: 'Numeric board ID' },
          stack_id: { type: 'number', description: 'Numeric stack ID' },
          card_id: { type: 'number', description: 'Numeric card ID' },
          label_id: { type: 'number', description: 'Numeric label ID (from Available Labels in context)' }
        },
        required: ['board_id', 'stack_id', 'card_id', 'label_id']
      },
      handler: async (args) => {
        try {
          const labelPath = `/index.php/apps/deck/api/v1.0/boards/${args.board_id}/stacks/${args.stack_id}/cards/${args.card_id}/assignLabel`;
          if (deck) {
            await deck._request('PUT', labelPath, { labelId: args.label_id });
          } else {
            await nc.request(labelPath, { method: 'PUT', body: { labelId: args.label_id } });
          }
          return `Assigned label ${args.label_id} to card ${args.card_id}.`;
        } catch (err) {
          this.logger.error(`[workflow_deck_assign_label] ${err.message}`);
          return `Failed to assign label: ${err.message}`;
        }
      }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Email Tools
    // ─────────────────────────────────────────────────────────────────────────

    const emailHandler = this.clients.emailHandler;
    if (emailHandler) {
      this.register({
        name: 'mail_send',
        mutates: true,
        writes: true,
        domains: ['email'],
        description: 'Send an email. REQUIRES human approval before execution. Provide recipient, subject, and body. The email will be sent via SMTP from the configured Moltagent email account.',
        parameters: {
          type: 'object',
          properties: {
            to: { type: 'string', description: 'Recipient email address' },
            subject: { type: 'string', description: 'Email subject line' },
            body: { type: 'string', description: 'Email body text' }
          },
          required: ['to', 'subject', 'body']
        },
        handler: async (args) => {
          try {
            if (!args.to || !args.to.includes('@')) {
              return 'Invalid email address. Please provide a valid recipient email.';
            }
            const result = await emailHandler.confirmSendEmail(
              { to: args.to, subject: args.subject, body: args.body },
              'moltagent'
            );
            if (!result || !result.success) return `Failed to send email: ${result?.error || 'no confirmation from mail server.'}`;
            return result.message || `Email sent to ${args.to}.`;
          } catch (err) {
            this.logger.error(`[mail_send] ${err.message}`);
            return `Failed to send email: ${err.message}`;
          }
        }
      });
    }

    // ============================================================
    // NC NEWS TOOLS
    // ============================================================

    const newsClient = this.clients.newsClient;
    if (newsClient) {
      this.register({
        name: 'news_get_items',
        readOnly: true,
        domains: ['news'],
        description: 'Get recent unread articles from NC News RSS feeds. Returns title, URL, body summary, and feed source for each item.',
        parameters: {
          type: 'object',
          properties: {
            batchSize: {
              type: 'integer',
              description: 'Number of items to return (default 20, max 100)'
            }
          },
          required: []
        },
        handler: async (args) => {
          try {
            const batchSize = Math.max(1, Math.min(Number.isFinite(args.batchSize) ? args.batchSize : 20, 100));
            const items = await newsClient.getItems({ batchSize, getRead: false });
            if (!items || items.length === 0) return 'No unread news items.';
            return JSON.stringify(items.map(item => ({
              id: item.id,
              title: item.title,
              url: item.url,
              author: item.author,
              feedTitle: item.feedTitle,
              pubDate: item.pubDate,
              body: (item.body || '').substring(0, 500),
              unread: item.unread,
              starred: item.starred
            })));
          } catch (err) {
            this.logger.error(`[news_get_items] ${err.message}`);
            return `Failed to get news items: ${err.message}`;
          }
        }
      });

      this.register({
        name: 'news_list_feeds',
        readOnly: true,
        domains: ['news'],
        description: 'List all RSS feeds subscribed in NC News with their unread counts.',
        parameters: {
          type: 'object',
          properties: {},
          required: []
        },
        handler: async () => {
          try {
            const feeds = await newsClient.getFeeds();
            if (!feeds || feeds.length === 0) return 'No feeds subscribed in NC News.';
            return JSON.stringify(feeds.map(feed => ({
              id: feed.id,
              title: feed.title,
              url: feed.url,
              link: feed.link,
              unreadCount: feed.unreadCount,
              folderId: feed.folderId
            })));
          } catch (err) {
            this.logger.error(`[news_list_feeds] ${err.message}`);
            return `Failed to list feeds: ${err.message}`;
          }
        }
      });

      this.register({
        name: 'news_mark_read',
        mutates: true,
        domains: ['news'],
        description: 'Mark a news item as read after it has been evaluated or turned into a Deck card.',
        parameters: {
          type: 'object',
          properties: {
            itemId: {
              type: 'integer',
              description: 'The ID of the news item to mark as read'
            }
          },
          required: ['itemId']
        },
        handler: async (args) => {
          try {
            if (args.itemId == null) return 'itemId is required.';
            await newsClient.markItemRead(args.itemId);
            return `Item ${args.itemId} marked as read.`;
          } catch (err) {
            this.logger.error(`[news_mark_read] ${err.message}`);
            return `Failed to mark item as read: ${err.message}`;
          }
        }
      });
    }
  }
}

module.exports = { ToolRegistry, detectHandlerFailureString, HANDLER_FAILURE_MARKERS };
