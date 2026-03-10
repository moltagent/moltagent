/**
 * MoltAgent CockpitManager -- Deck as Control Plane
 *
 * Architecture Brief:
 * -------------------
 * Problem: The agent needs a visual, non-code management interface where a human
 * can configure behavior, persona, guardrails, and operating mode by editing
 * kanban cards on a Nextcloud Deck board.
 *
 * Pattern: Read-on-heartbeat configuration reader. CockpitManager reads a dedicated
 * Deck board ("Moltagent Cockpit") on every heartbeat pulse, translates card states
 * (labels, stars, descriptions) into a structured config object, and compiles a
 * system prompt overlay. Status cards are written back with runtime metrics.
 * Bootstrap creates the board idempotently on first run.
 *
 * Key Dependencies:
 *   - DeckClient (HTTP transport to Nextcloud Deck API)
 *   - config.js (cockpit section: adminUser, board title, cache TTL)
 *   - HeartbeatManager (calls readConfig + updateStatus on each pulse)
 *   - AgentLoop (consumes buildSystemPromptOverlay for LLM context)
 *
 * Data Flow:
 *   HeartbeatManager.pulse()
 *     -> cockpitManager.readConfig()  [Deck API: GET stacks with full=true]
 *     -> cockpitManager.buildSystemPromptOverlay()  [pure transform, no I/O]
 *     -> cockpitManager.updateStatus(metrics)  [Deck API: PUT card descriptions]
 *
 * Dependency Map:
 *   cockpit-manager.js depends on: deck-client, config
 *   Used by: heartbeat-manager (pulse cycle), agent-loop (system prompt)
 *   Tested by: test/unit/integrations/cockpit-manager.test.js
 *
 * @module integrations/cockpit-manager
 * @version 1.0.0
 */

'use strict';

const appConfig = require('../config');

// ===========================================================================
// Constants
// ===========================================================================

/**
 * Board title for the Cockpit board.
 * @type {string}
 */
const BOARD_TITLE = 'Moltagent Cockpit';

/**
 * Board color (hex without #).
 * @type {string}
 */
const BOARD_COLOR = '0082c9';

/**
 * Label definitions for the Cockpit board.
 * Order matters: labels are created in this order during bootstrap.
 * @type {Array<{title: string, color: string}>}
 */
const LABEL_DEFS = [
  { title: '⚙️1', color: 'e9322d' },   // option 1 / off / minimal
  { title: '⚙️2', color: 'f0c400' },   // option 2 / moderate / balanced
  { title: '⚙️3', color: '00b600' },   // option 3 / on / maximum
  { title: '⚙️★', color: 'ffd700' },   // active / starred (Styles + Modes)
  { title: '⚙️4', color: '0000ff' },   // custom (read from description)
  { title: '⚙️5', color: '7c3aed' },   // reserved (violet)
  { title: '⚙️6', color: 'ff6f61' },   // reserved (coral)
  { title: '⚙️7', color: '17a2b8' },   // reserved (teal)
  { title: '⚙️8', color: '795548' },   // reserved (brown)
  { title: '⚙️9', color: '6c757d' },   // reserved (slate)
  { title: '⏸ PAUSED', color: '6b7280' }, // guardrail toggle — grey
  { title: '⛔ GATE', color: 'dc2626' }   // guardrail gating — only GATE cards trigger HITL
];

/**
 * Stack definitions for the Cockpit board.
 * Order is the display order (left to right).
 * @type {Array<{key: string, title: string}>}
 */
const STACK_DEFS = [
  { key: 'styles',     title: '\ud83d\udca1 Styles' },
  { key: 'persona',    title: '\ud83c\udfad Persona' },
  { key: 'guardrails', title: '\ud83d\udee1\ufe0f Guardrails' },
  { key: 'modes',      title: '\ud83c\udf19 Modes' },
  { key: 'system',     title: '\ud83d\udd27 System' },
  { key: 'status',     title: '\ud83d\udcca Status' }
];

/**
 * Default cards for each stack. Each entry specifies the stack key,
 * card title, card description, and optional default label title.
 * @type {Object<string, Array<{title: string, description: string, defaultLabel?: string}>>}
 */
const DEFAULT_CARDS = {
  styles: [
    {
      title: 'Concise Executive',
      description: 'Tight, high-signal, zero ceremony. Every sentence earns its place or gets cut.\nThe answer comes first — context and reasoning follow only if they change the decision.\n\nDo: lead with the conclusion, use numbers when available, structure with bullets only when there are genuinely parallel items\n\nDon\'t: open with context-setting before the point, use hedging language ("it seems like," "might potentially"), write transitions that exist only to sound smooth\n\nSounds like: "Three open tasks. One overdue since Tuesday. That\'s the one to address."\n\n---\n\nCommunication style preset. Star (\u2699\ufe0f\u2605) the style you want\nactive. Only one style can be active at a time. Edit the\ndescription to customize how your agent writes and speaks.',
      defaultLabel: '\u2699\ufe0f\u2605'
    },
    {
      title: 'Warm Professional',
      description: 'Collegial and grounded. Warm enough to feel human, polished enough to belong\nin a professional context. Acknowledges complexity without drowning in it.\n\nDo: use "we" framing for shared work, acknowledge when something is genuinely difficult before offering a path forward, explain the reasoning not just the conclusion\n\nDon\'t: be so warm it reads as performative, use corporate filler ("circle back," "move the needle"), overcomplicate a simple answer\n\nSounds like: "We\'ve got a bit of a backlog building — here\'s what I\'d suggest tackling first, and why."\n\n---\n\nCommunication style preset. Star (\u2699\ufe0f\u2605) the style you want\nactive. Only one style can be active at a time.'
    },
    {
      title: 'Blunt Analyst',
      description: 'Unvarnished, precise, no cushion between the finding and the reader.\nFacts stated plainly. Risks named, not implied. If data is missing,\nthat absence is part of the answer.\n\nDo: lead with the uncomfortable finding if there is one, use numbers over adjectives, explicitly flag what you don\'t know or can\'t confirm\n\nDon\'t: soften conclusions with qualifiers that dilute them, bury a risk inside a balanced paragraph, use passive voice to avoid assigning accountability\n\nSounds like: "Revenue is flat. Pipeline is thin for Q2. The forecast assumes growth that isn\'t visible in the current numbers."\n\n---\n\nCommunication style preset. Star (\u2699\ufe0f\u2605) the style you want\nactive. Only one style can be active at a time.'
    },
    {
      title: 'Creative Partner',
      description: 'Generative, lateral, genuinely playful. The job here is to build, not evaluate.\nIdeas get extended, not stress-tested — critical analysis comes later, in a\ndifferent mode. Unexpected connections are a feature.\n\nDo: extend ideas with "yes and" energy, offer connections the human probably didn\'t see coming, match the human\'s enthusiasm rather than moderating it\n\nDon\'t: introduce risks or objections during ideation, evaluate feasibility unprompted, default to a structured summary when the conversation wants to sprawl\n\nSounds like: "What if the constraint is actually the feature? The limitation you\'re frustrated by might be the thing that makes it distinctive."\n\n---\n\nCommunication style preset. Star (\u2699\ufe0f\u2605) the style you want\nactive. Only one style can be active at a time.'
    },
    {
      title: 'Warm Teacher',
      description: 'Patient, curious, genuinely invested in the other person understanding —\nnot just receiving information. Builds bridges from what the person already\nknows to what they\'re learning. Checks that the bridge held.\n\nDo: use analogies that start from the familiar ("think of it like..."), acknowledge when a topic is genuinely hard before explaining it, end with an invitation to go deeper or ask follow-up questions\n\nDon\'t: use jargon the human hasn\'t introduced, present a structured taxonomy when a story would work better, skip the "does that land?" check at the end\n\nSounds like: "Think of it like a library where the books reorganize themselves every time you look for one — chaotic, but that\'s sort of how quantum states behave before measurement. Make sense so far?"\n\n---\n\nCommunication style preset. Star (\u2699\ufe0f\u2605) the style you want\nactive. Only one style can be active at a time.'
    }
  ],
  persona: [
    { title: 'Name',      description: 'Molti\n\n---\n\nYour agent\'s name. Used in Talk messages, email signatures,\nand self-references. Change the name above the line to\nrename your agent.' },
    { title: 'Humor',     description: '\u2699\ufe0f1 none / \u2699\ufe0f2 light / \u2699\ufe0f3 playful\n\n---\n\nHow much humor your agent uses in conversation.\n\u2699\ufe0f1 keeps things strictly professional. \u2699\ufe0f3 allows jokes,\nwordplay, and lighter moments when appropriate.\n\nTo change: remove the current label and add the one you want.', defaultLabel: '\u2699\ufe0f2' },
    { title: 'Emoji',     description: '\u2699\ufe0f1 none / \u2699\ufe0f2 minimal / \u2699\ufe0f3 generous\n\n---\n\nEmoji usage in messages and comments. \u2699\ufe0f1 means pure text.\n\u2699\ufe0f2 allows occasional emoji for emphasis. \u2699\ufe0f3 uses them\nfreely for tone and visual scanning.\n\nTo change: remove the current label and add the one you want.', defaultLabel: '\u2699\ufe0f1' },
    { title: 'Language',  description: 'EN\n\n---\n\nPrimary language for agent communication. Use ISO codes:\nEN, PT, DE, FR, ES, etc. For bilingual, use: EN+PT\nYour agent will respond in this language by default but\nswitches to match the human\'s language when different.' },
    { title: 'Verbosity', description: '\u2699\ufe0f1 concise / \u2699\ufe0f2 balanced / \u2699\ufe0f3 detailed\n\n---\n\nResponse length preference. \u2699\ufe0f1 gives the shortest useful\nanswer. \u2699\ufe0f3 provides thorough explanations with context.\n\u2699\ufe0f2 adapts to the complexity of the question.\n\nTo change: remove the current label and add the one you want.', defaultLabel: '\u2699\ufe0f1' },
    { title: 'Formality', description: '\u2699\ufe0f1 formal / \u2699\ufe0f2 balanced / \u2699\ufe0f3 casual\n\n---\n\nCommunication tone. \u2699\ufe0f1 for professional/client-facing work.\n\u2699\ufe0f3 for relaxed, conversational interaction. \u2699\ufe0f2 reads the\nroom and adjusts.\n\nTo change: remove the current label and add the one you want.', defaultLabel: '\u2699\ufe0f2' }
  ],
  guardrails: [
    {
      title: 'Never delete files without asking',
      description: 'Never delete files without explicit confirmation from the\nhuman. Always list what will be deleted and wait for\napproval before proceeding.\n\n---\n\nHard constraint. The agent will always ask before any\ndestructive file operation, regardless of initiative level\nor mode. Remove this card to lift the restriction.'
    },
    {
      title: 'Confirm before sending external communications',
      description: 'When sending emails to external addresses, always CC the\nhuman owner on the message.\n\n---\n\nHard constraint. Ensures the human has visibility on all\noutbound communication. Remove this card to allow the\nagent to send external emails independently.'
    },
    {
      title: 'Route credential-sensitive operations through local LLM',
      description: 'For financial transactions, credential changes, or\npermission modifications: always notify the human in Talk\nbefore proceeding, even in Full Auto mode.\n\n---\n\nSafety constraint for high-impact operations. The agent\nwill pause and ask before taking irreversible actions\ninvolving money, access, or permissions.'
    },
    {
      title: 'Maximum 8 tool calls per reasoning cycle',
      description: 'Hard limit on tool iterations per user request to prevent\nrunaway loops and excessive token consumption.\n\n---\n\nPerformance guardrail. Prevents the agent from spiraling\ninto long tool-call chains. Increase if complex workflows\nrequire more steps.'
    }
  ],
  modes: [
    {
      title: 'Full Auto',
      description: 'Process all inbox items, execute workflows, handle routine\ntasks independently. Only pause for guardrail-gated\noperations or explicit human review requests.\n\n---\n\nBehavioral mode. Star (\u2699\ufe0f\u2605) the mode you want active.\nFull Auto is the most autonomous mode \u2014 the agent works\nthrough its queue without waiting for instruction.',
      defaultLabel: '\u2699\ufe0f\u2605'
    },
    {
      title: 'Focus Mode',
      description: 'Only respond to direct messages. Pause all proactive work,\ninbox processing, and workflow execution. Minimal\nnotifications.\n\n---\n\nUse when you need the agent to stop background activity\nand only respond when spoken to. Good for deep work\nsessions where notifications are distracting.'
    },
    {
      title: 'Meeting Day',
      description: 'Prioritize calendar preparation and meeting follow-ups.\nPrepare briefing docs 30 minutes before each meeting.\nSummarize action items after meetings end. Reduce other\nproactive work.\n\n---\n\nActivates meeting-centric behavior. The agent shifts\nfocus to your calendar and deprioritizes other tasks.'
    },
    {
      title: 'Creative Session',
      description: 'Verbose, exploratory responses. Suggest connections and\nideas. Don\'t optimize for brevity. Brainstorm freely.\nPull in related knowledge from wiki.\n\n---\n\nFor brainstorming and creative work. The agent becomes\nmore generative and less structured.'
    },
    {
      title: 'Out of Office',
      description: 'Auto-respond to incoming messages with a short "away"\nnotice. Queue non-urgent tasks. Only escalate items\nmarked urgent or from VIP contacts. Send the human a\ndaily summary instead of individual notifications.\n\n---\n\nFor vacation or extended absence. The agent holds the\nfort, handles what it can, and batches everything else\nfor your return.'
    }
  ],
  system: [
    { title: 'Models', description: 'trust: local-only\n\n---\n\n(Description will be generated on first heartbeat)' },
    { title: 'Daily Digest',    description: '\u2699\ufe0f1 off / \u2699\ufe0f2 morning (08:00) / \u2699\ufe0f3 custom\n\n---\n\nDaily summary message in Talk with overnight activity,\nupcoming calendar, and pending tasks.\n\u2699\ufe0f1  No digest.\n\u2699\ufe0f2  Sent at 08:00 local time.\n\u2699\ufe0f3  Custom: write your preferred time above the line.', defaultLabel: '\u2699\ufe0f2' },
    { title: 'Initiative Level', description: '\u2699\ufe0f1 minimal / \u2699\ufe0f2 moderate / \u2699\ufe0f3 active / \u2699\ufe0f4 autonomous\n\n---\n\nHow proactive your agent is between conversations.\n\u2699\ufe0f1  Only responds when spoken to. No background work.\n\u2699\ufe0f2  Checks inbox, processes queued tasks on heartbeat.\n\u2699\ufe0f3  Suggests improvements, flags issues, prepares briefs.\n\u2699\ufe0f4  Takes action within guardrails without asking first.', defaultLabel: '\u2699\ufe0f2' },
    { title: 'Working Hours',   description: '\u2699\ufe0f1 always / \u2699\ufe0f2 business (09:00-18:00) / \u2699\ufe0f3 extended (07:00-22:00) / \u2699\ufe0f4 custom\n\n---\n\nWhen your agent is allowed to do proactive work. Outside\nthese hours, the agent sleeps \u2014 it still responds if you\nmessage it directly in Talk.\n\u2699\ufe0f1  Always active (24/7).\n\u2699\ufe0f2  Business hours: 09:00-18:00.\n\u2699\ufe0f3  Extended hours: 07:00-22:00.\n\u2699\ufe0f4  Custom: write your hours above the line as HH:MM-HH:MM.', defaultLabel: '\u2699\ufe0f2' },
    { title: '\ud83d\udcb0 Budget Limits', description: '\u2699\ufe0f1 no limits / \u2699\ufe0f2 conservative / \u2699\ufe0f3 moderate / \u2699\ufe0f4 custom\n\n---\n\nCost controls for cloud LLM usage. The agent automatically\nswitches to local models when limits are reached.\n\u2699\ufe0f1  No spending limits.\n\u2699\ufe0f2  Daily: \u20ac2.00 / Monthly: \u20ac30.00\n\u2699\ufe0f3  Daily: \u20ac5.00 / Monthly: \u20ac50.00\n\u2699\ufe0f4  Custom: edit the values above the line.', defaultLabel: '\u2699\ufe0f3' },
    { title: '\ud83d\udd0a Voice', description: '\u2699\ufe0f1 off / \u2699\ufe0f2 listen / \u2699\ufe0f3 full voice\n\n---\n\nVoice processing mode.\n\u2699\ufe0f1  Off \u2014 voice messages are ignored.\n\u2699\ufe0f2  Listen \u2014 transcribe voice messages, respond as text.\n\u2699\ufe0f3  Full \u2014 transcribe voice, respond with voice + text.', defaultLabel: '\u2699\ufe0f1' }
  ],
  status: [
    { title: 'Health', description: '\ud83d\udfe2 OK -- Uptime: 0d 0h -- Last error: none' },
    { title: 'Costs', description: 'This month: \u20ac0.00\nCloud: 0 calls\nLocal: 0 calls\nLocal ratio: --' },
    { title: 'Model Usage', description: 'This month: 0 requests\nNo provider data yet.' }
  ]
};

/**
 * Persona option value maps.
 * For each persona card title, maps label key to config value.
 * @type {Object<string, {option1: string, option2: string, option3: string}>}
 */
const PERSONA_VALUE_MAP = {
  Humor:     { off: 'none',    moderate: 'light',    on: 'playful' },
  Emoji:     { off: 'none',    moderate: 'minimal',  on: 'generous' },
  Verbosity: { off: 'concise', moderate: 'balanced', on: 'detailed' },
  Formality: { off: 'formal',  moderate: 'balanced', on: 'casual' }
};

/**
 * System option value maps.
 * @type {Object<string, {option1: string, option2: string, option3: string}>}
 */
const SYSTEM_VALUE_MAP = {
  'Daily Digest':      { off: 'off',        moderate: '08:00',      on: 'custom' },
  'Initiative Level':  { off: '1',          moderate: '2',          on: '3' },
  '\ud83d\udd0a Voice':        { off: 'off',        moderate: 'listen',     on: 'full' },
  'Working Hours':     { off: '00:00-23:59', moderate: '09:00-18:00', on: '07:00-22:00' }
};

/**
 * Acceptable titles for the Models card (matched case-insensitively).
 * Supports the renamed card ("Models") and legacy titles.
 * @type {Array<string>}
 */
const MODELS_CARD_TITLES = ['models', 'llm provider'];

// ===========================================================================
// Custom Error
// ===========================================================================

/**
 * Custom error class for Cockpit operations
 */
class CockpitError extends Error {
  /**
   * @param {string} message
   * @param {string} [phase='unknown'] - Bootstrap, read, write, etc.
   * @param {*} [cause=null] - Original error
   */
  constructor(message, phase = 'unknown', cause = null) {
    super(message);
    this.name = 'CockpitError';
    this.phase = phase;
    this.cause = cause;
  }
}

// ===========================================================================
// CockpitManager
// ===========================================================================

class CockpitManager {
  /**
   * @param {Object} options
   * @param {Object} options.deckClient - DeckClient instance (must support NCRequestManager mode)
   * @param {Object} [options.config] - Config overrides
   * @param {string} [options.config.adminUser] - Admin username for board sharing
   * @param {string} [options.config.boardTitle] - Board title override
   * @param {number} [options.config.cacheTTLMs] - Cache TTL in ms (default: 300000 = 5 min)
   * @param {Function} [options.auditLog] - Audit logging function
   */
  constructor({ deckClient, config = {}, auditLog } = {}) {
    if (!deckClient) {
      throw new Error('CockpitManager requires a deckClient instance');
    }

    this.deck = deckClient;
    this.adminUser = config.adminUser || appConfig.cockpit?.adminUser || '';
    this.boardTitle = config.boardTitle || appConfig.cockpit?.boardTitle || BOARD_TITLE;
    this.auditLog = auditLog || (async () => {});

    /** @type {number|null} Resolved board ID */
    this.boardId = null;

    /** @type {Object<string, number>} stackKey -> stackId mapping */
    this.stacks = {};

    /** @type {Object<string, Object>} labelTitle -> {id, title, color} mapping */
    this.labels = {};

    /** @type {Object|null} Last read config object from readConfig() */
    this.cachedConfig = null;

    /** @type {number} Timestamp when cache expires */
    this.cacheExpiry = 0;

    /** @type {number} Cache time-to-live in milliseconds */
    this.CACHE_TTL = config.cacheTTLMs || appConfig.cockpit?.cacheTTLMs || 5 * 60 * 1000;

    /** @type {string|null} Fingerprint of last Models card (labels+description) for change detection */
    this._lastModelsFingerprint = null;

    /** @type {Object|null} Last parsed modelsConfig (reused when fingerprint unchanged) */
    this._lastModelsConfig = null;

    /** @type {boolean} Whether initialize() has been called successfully */
    this._initialized = false;
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  /**
   * Find or create the Cockpit board and resolve stack/label IDs.
   * Must be called once before readConfig() or updateStatus().
   * Safe to call multiple times (idempotent).
   *
   * @returns {Promise<void>}
   * @throws {CockpitError} If board resolution fails
   */
  async initialize() {
    try {
      // Find existing board by title
      const boards = await this.deck.listBoards();
      let board = boards.find(b => b.title === this.boardTitle);

      if (!board) {
        // Board doesn't exist, create it
        const bootstrapResult = await this.bootstrap();
        this.boardId = bootstrapResult.boardId;
        this.stacks = bootstrapResult.stacks;
        this.labels = bootstrapResult.labels;
      } else {
        // Board exists, resolve IDs
        this.boardId = board.id;

        // Get board details for labels
        const boardDetails = await this.deck.getBoard(this.boardId);

        // Get stacks with cards
        const stacks = await this.deck.getStacks(this.boardId);

        // Resolve IDs
        this._resolveIdsFromBoard({
          stacks: stacks,
          labels: boardDetails.labels || []
        });

        // Migrate old label names (Option 1/2/3 -> Off/Moderate/On)
        const labelsMigrated = await this._migrateLabels();
        if (labelsMigrated > 0) {
          // Re-fetch board details to update this.labels with new titles
          const refreshedBoard = await this.deck.getBoard(this.boardId);
          this.labels = {};
          for (const label of (refreshedBoard.labels || [])) {
            if (label.title) this.labels[label.title] = label;
          }
        }

        // Create any missing default cards (e.g. Budget Limits added after first bootstrap)
        await this._ensureMissingCards(stacks);

        // Remove obsolete cards from status stack (e.g. Tasks This Week, Knowledge, Recent Actions)
        await this._removeObsoleteCards(stacks);
      }

      this._initialized = true;
    } catch (err) {
      throw new CockpitError(
        `Failed to initialize CockpitManager: ${err.message}`,
        'initialize',
        err
      );
    }
  }

  /**
   * Create the Cockpit board with all stacks, labels, and default cards.
   * Idempotent: skips creation of items that already exist.
   *
   * Steps:
   * 1. Create board with BOARD_TITLE and BOARD_COLOR
   * 2. Share with admin user (if configured)
   * 3. Delete default stacks ("To do", "Doing", "Done") that Deck creates
   * 4. Create 6 stacks (Styles, Persona, Guardrails, Modes, System, Status)
   * 5. Create labels (Active, Option 1, Option 2, Option 3, Custom)
   * 6. Create default cards in each stack
   * 7. Assign default labels to Persona + System cards
   * 8. Star default Style (Concise Executive) and Mode (Full Auto)
   *
   * @returns {Promise<{boardId: number, stacks: Object, labels: Object}>}
   * @throws {CockpitError} If bootstrap fails
   */
  async bootstrap() {
    try {
      // 1. Create board
      const boardPath = '/index.php/apps/deck/api/v1.0/boards';
      const board = await this.deck._request('POST', boardPath, {
        title: this.boardTitle,
        color: BOARD_COLOR
      });
      const boardId = board.id;

      // 2. Share with admin user (if configured)
      if (this.adminUser) {
        try {
          await this.deck.shareBoard(boardId, this.adminUser, 0, true, true, true);
        } catch (err) {
          // Non-critical, continue
        }
      }

      // 3. Delete default stacks
      const defaultStacks = await this.deck.getStacks(boardId);
      await this._deleteDefaultStacks(boardId, defaultStacks);

      // 4. Create stacks
      const stacks = {};
      for (let i = 0; i < STACK_DEFS.length; i++) {
        const def = STACK_DEFS[i];
        const stack = await this.deck.createStack(boardId, def.title, i);
        stacks[def.key] = stack.id;
      }

      // 5. Create labels
      const labels = {};
      const labelPath = `/index.php/apps/deck/api/v1.0/boards/${boardId}/labels`;
      for (const labelDef of LABEL_DEFS) {
        const label = await this.deck._request('POST', labelPath, {
          title: labelDef.title,
          color: labelDef.color
        });
        labels[label.title] = label;
      }

      // 6. Create cards in each stack
      for (const [stackKey, stackId] of Object.entries(stacks)) {
        const cardDefs = DEFAULT_CARDS[stackKey] || [];
        for (let i = 0; i < cardDefs.length; i++) {
          const cardDef = cardDefs[i];
          const cardPath = `/index.php/apps/deck/api/v1.0/boards/${boardId}/stacks/${stackId}/cards`;
          const card = await this.deck._request('POST', cardPath, {
            title: cardDef.title,
            description: cardDef.description,
            type: 'plain',
            order: i
          });

          // 7. Assign default labels
          if (cardDef.defaultLabel) {
            const label = labels[cardDef.defaultLabel];
            if (label) {
              const assignPath = `/index.php/apps/deck/api/v1.0/boards/${boardId}/stacks/${stackId}/cards/${card.id}/assignLabel`;
              try {
                await this.deck._request('PUT', assignPath, { labelId: label.id });
              } catch (err) {
                // Non-critical, continue
              }
            }
          }
        }
      }

      // Store resolved IDs
      this.boardId = boardId;
      this.stacks = stacks;
      this.labels = labels;

      return { boardId, stacks, labels };
    } catch (err) {
      throw new CockpitError(
        `Failed to bootstrap Cockpit board: ${err.message}`,
        'bootstrap',
        err
      );
    }
  }

  // ===========================================================================
  // Read (called on heartbeat)
  // ===========================================================================

  /**
   * Read all cockpit configuration from the Deck board.
   * Returns a structured config object. Cached for CACHE_TTL ms.
   *
   * Makes a single API call (GET stacks with cards) and parses all stacks.
   *
   * @returns {Promise<CockpitConfig>} Full cockpit configuration object
   * @throws {CockpitError} If read fails
   */
  async readConfig() {
    if (!this._initialized) {
      throw new CockpitError('CockpitManager not initialized — call initialize() first', 'read');
    }

    // Check cache
    if (this.cachedConfig && Date.now() < this.cacheExpiry) {
      return this.cachedConfig;
    }

    try {
      // Fetch all stacks with cards
      const stacks = await this.deck.getStacks(this.boardId);

      // Build a map by matching stack titles to STACK_DEFS keys
      const stacksByKey = {};
      for (const stack of stacks) {
        for (const def of STACK_DEFS) {
          // Match if the stack title includes the emoji/title from STACK_DEFS
          const titlePart = def.title.split(' ')[1]; // Extract the text part after emoji
          if (stack.title && stack.title.includes(titlePart)) {
            stacksByKey[def.key] = stack.cards || [];
            break;
          }
        }
      }

      // Parse each stack
      const config = {
        style: await this.getActiveStyle(stacksByKey.styles),
        persona: await this.getPersona(stacksByKey.persona),
        guardrails: await this.getGuardrails(stacksByKey.guardrails),
        mode: await this.getActiveMode(stacksByKey.modes),
        system: await this.getSystemSettings(stacksByKey.system)
      };

      // Parse Budget Limits card from System stack
      const systemCards = stacksByKey.system || [];
      const budgetCard = systemCards.find(c => c.title && c.title.includes('Budget'));
      if (budgetCard) {
        const budgetResolved = this._resolveCardValue(budgetCard, {});
        if (budgetResolved.source === 'custom') {
          config.budget = this._parseBudgetCard(budgetCard.description);
        } else {
          config.budget = this._expandBudgetPreset(budgetResolved.source);
        }
      }

      // Cache the result
      this.cachedConfig = config;
      this.cacheExpiry = Date.now() + this.CACHE_TTL;

      return config;
    } catch (err) {
      throw new CockpitError(
        `Failed to read Cockpit config: ${err.message}`,
        'read',
        err
      );
    }
  }

  /**
   * Invalidate the cached config so the next readConfig() fetches fresh data.
   * Call this before heartbeat reads to ensure card edits are picked up.
   */
  invalidateCache() {
    this.cachedConfig = null;
    this.cacheExpiry = 0;
    // Also clear fingerprint so Models card is re-parsed and propagated
    this._lastModelsFingerprint = null;
    this._lastModelsConfig = null;
  }

  /**
   * Get the currently active communication style.
   * Finds the card in the Styles stack with the "Active" label.
   *
   * @param {Array<Object>} [cards] - Pre-fetched cards from Styles stack
   * @returns {Promise<{name: string, description: string}|null>}
   */
  async getActiveStyle(cards) {
    let styleCards = cards;

    if (!styleCards) {
      const stacks = await this.deck.getStacks(this.boardId);
      const stylesStack = stacks.find(s => s.id === this.stacks.styles);
      styleCards = stylesStack?.cards || [];
    }

    const activeCard = this._findStarredCard(styleCards);
    if (!activeCard) return null;

    return {
      name: activeCard.title,
      description: activeCard.description || ''
    };
  }

  /**
   * Get all active guardrails.
   * Every card in the Guardrails stack is a hard behavioral constraint.
   *
   * @param {Array<Object>} [cards] - Pre-fetched cards from Guardrails stack
   * @returns {Promise<Array<{title: string, description: string}>>}
   */
  async getGuardrails(cards) {
    let guardrailCards = cards;

    if (!guardrailCards) {
      const stacks = await this.deck.getStacks(this.boardId);
      const guardrailsStack = stacks.find(s => s.id === this.stacks.guardrails);
      guardrailCards = guardrailsStack?.cards || [];
    }

    const activeCards = guardrailCards.filter(card => {
      const labels = card.labels || [];
      return !labels.some(l =>
        l.title?.replace(/\uFE0F/g, '').trim() === '⏸ PAUSED'
      );
    });

    return activeCards.map(card => {
      const labels = card.labels || [];
      const gate = labels.some(l =>
        l.title?.replace(/\uFE0F/g, '').trim() === '⛔ GATE'
      );
      return {
        title: card.title,
        description: card.description || '',
        gate
      };
    });
  }

  /**
   * Get the currently active operating mode.
   * Finds the card in the Modes stack with the "Active" label.
   *
   * @param {Array<Object>} [cards] - Pre-fetched cards from Modes stack
   * @returns {Promise<{name: string, description: string}|null>}
   */
  async getActiveMode(cards) {
    let modeCards = cards;

    if (!modeCards) {
      const stacks = await this.deck.getStacks(this.boardId);
      const modesStack = stacks.find(s => s.id === this.stacks.modes);
      modeCards = modesStack?.cards || [];
    }

    const activeCard = this._findStarredCard(modeCards);
    if (!activeCard) return null;

    return {
      name: activeCard.title,
      description: activeCard.description || ''
    };
  }

  /**
   * Get persona configuration from Persona stack cards.
   * Each card is a personality dimension; the assigned label determines the value.
   *
   * Label mapping:
   *   ⚙1 (red)    -> first option (none / concise / formal)
   *   ⚙2 (yellow) -> second option (light / balanced / balanced)
   *   ⚙3 (green)  -> third option (playful / detailed / casual)
   *   ⚙4 (blue)   -> read card description for value
   *
   * @param {Array<Object>} [cards] - Pre-fetched cards from Persona stack
   * @returns {Promise<PersonaConfig>}
   */
  async getPersona(cards) {
    let personaCards = cards;

    if (!personaCards) {
      const stacks = await this.deck.getStacks(this.boardId);
      const personaStack = stacks.find(s => s.id === this.stacks.persona);
      personaCards = personaStack?.cards || [];
    }

    const config = {
      name: 'Molti',
      humor: 'light',
      emoji: 'none',
      language: 'EN',
      verbosity: 'concise',
      formality: 'balanced'
    };

    for (const card of personaCards) {
      const title = card.title;

      if (title === 'Name' || title === 'Language') {
        // Custom labels, read description
        const resolved = this._resolveCardValue(card, {});
        if (resolved.source === 'custom') {
          config[title.toLowerCase()] = resolved.value;
        }
      } else if (PERSONA_VALUE_MAP[title]) {
        // Map label to value
        const resolved = this._resolveCardValue(card, PERSONA_VALUE_MAP[title]);
        config[title.toLowerCase()] = resolved.value;
      }
    }

    return config;
  }

  /**
   * Get system settings from System stack cards.
   * Same label-as-value pattern as Persona.
   *
   * @param {Array<Object>} [cards] - Pre-fetched cards from System stack
   * @returns {Promise<SystemConfig>}
   */
  async getSystemSettings(cards) {
    let systemCards = cards;

    if (!systemCards) {
      const stacks = await this.deck.getStacks(this.boardId);
      const systemStack = stacks.find(s => s.id === this.stacks.system);
      systemCards = systemStack?.cards || [];
    }

    const config = {
      dailyDigest: 'off',
      initiativeLevel: 2,
      workingHours: '08:00-18:00'
    };

    for (const card of systemCards) {
      const title = card.title;

      if (title === 'Working Hours') {
        const resolved = this._resolveCardValue(card, SYSTEM_VALUE_MAP[title]);
        if (resolved.source === 'custom') {
          // ⚙4: read HH:MM-HH:MM range from description above the --- line
          const timeMatch = (card.description || '').split('---')[0].match(/\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}/);
          config.workingHours = timeMatch ? timeMatch[0] : '09:00-18:00';
        } else if (resolved.value) {
          config.workingHours = resolved.value;
        }
      } else if (title === 'Initiative Level') {
        const resolved = this._resolveCardValue(card, SYSTEM_VALUE_MAP[title]);
        const parsed = parseInt(resolved.value, 10);
        config.initiativeLevel = isNaN(parsed) ? 2 : parsed;
      } else if (title === 'Daily Digest') {
        const resolved = this._resolveCardValue(card, SYSTEM_VALUE_MAP[title]);
        if (resolved.source === 'custom' || resolved.value === 'custom') {
          // ⚙3 custom: read time from description above the --- line
          const timeMatch = (card.description || '').split('---')[0].match(/\d{1,2}:\d{2}/);
          config.dailyDigest = timeMatch ? timeMatch[0] : '08:00';
        } else if (resolved.value && resolved.value !== 'off') {
          config.dailyDigest = resolved.value; // e.g. '08:00' from ⚙2
        } else {
          config.dailyDigest = 'off';
        }
      } else if (MODELS_CARD_TITLES.includes(title.toLowerCase())) {
        config.modelsConfig = this._parseModelsCard(card);
      } else if (title === '\ud83d\udd0a Voice' || title.includes('Voice')) {
        const resolved = this._resolveCardValue(card, SYSTEM_VALUE_MAP['\ud83d\udd0a Voice']);
        const validVoiceModes = ['off', 'listen', 'full'];
        if (validVoiceModes.includes(resolved.value)) {
          config.voice = resolved.value;
        } else if (resolved.source === 'custom' && resolved.value) {
          // Backward compat: old ⚙4 card with "Voice input: on/off" format
          const match = resolved.value.match(/voice\s*input\s*:\s*(on|off)/i);
          config.voice = match && match[1].toLowerCase() === 'on' ? 'listen' : 'off';
        } else {
          config.voice = 'off';
        }
      }
    }

    return config;
  }

  // ===========================================================================
  // Write (called by HeartbeatManager)
  // ===========================================================================

  /**
   * Update Status stack cards with current runtime metrics.
   * Only updates existing cards (never creates or deletes in Status stack).
   *
   * @param {Object} statusData
   * @param {Object} [statusData.health] - Health metrics (with optional requestStats)
   * @param {Object} [statusData.costs] - Cost metrics from BudgetEnforcer (enriched with _providerTypes)
   * @param {Object} [statusData.routerStats] - Router stats from llmRouter.getStats() (enriched with _providerTypes)
   * @returns {Promise<void>}
   */
  async updateStatus(statusData) {
    if (!this._initialized) return;

    try {
      // Fetch Status stack cards
      const stacks = await this.deck.getStacks(this.boardId);
      const statusStack = stacks.find(s => s.id === this.stacks.status);
      if (!statusStack) return;

      const cards = statusStack.cards || [];

      // Update each known status card
      const updates = [
        { title: 'Health', formatter: this._formatHealthStatus.bind(this), data: statusData.health },
        { title: 'Costs', formatter: this._formatCostStatus.bind(this), data: { costs: statusData.costs, costTracker: statusData.costTracker } },
        { title: 'Model Usage', formatter: this._formatModelUsage.bind(this), data: statusData.routerStats }
      ];

      for (const update of updates) {
        const card = cards.find(c => c.title === update.title);
        if (!card) continue;

        try {
          const description = update.formatter(update.data);
          const updatePath = `/index.php/apps/deck/api/v1.0/boards/${this.boardId}/stacks/${this.stacks.status}/cards/${card.id}`;
          await this.deck._request('PUT', updatePath, {
            title: card.title,
            description: description,
            type: 'plain',
            owner: card.owner || 'moltagent'
          });
        } catch (err) {
          console.warn(`[CockpitManager] Failed to update ${card.title}:`, err.message);
        }
      }
    } catch (err) {
      console.warn('[CockpitManager] updateStatus failed:', err.message);
    }
  }

  // ===========================================================================
  // System Prompt Overlay
  // ===========================================================================

  /**
   * Build a strong behavioral style directive for the TOP of the system prompt.
   * This must be positioned before the agent's identity and tools so it has
   * maximum positional authority over the LLM's output behavior.
   *
   * Returns empty string if no style is configured.
   *
   * @returns {string} Imperative style directive text
   */
  buildStyleDirective() {
    if (!this.cachedConfig || !this.cachedConfig.style) {
      return '';
    }

    const { style, persona } = this.cachedConfig;
    const parts = [];

    parts.push(`## Communication Style: ${style.name}`);
    parts.push('');
    parts.push('Every response you write MUST reflect this style. This is not optional.');
    parts.push('');
    // Strip human-facing documentation below --- separator
    const behavioralDescription = style.description.split('---')[0].trim();
    parts.push(behavioralDescription);
    parts.push('');

    parts.push(`Before writing any response, check: does this sound like "${style.name}"? If it sounds like a generic assistant, rewrite it.`);
    parts.push('');
    parts.push('Style governs voice and approach. Persona directives (length, tone, humor, emoji) take precedence over style defaults when they conflict.');

    return parts.join('\n');
  }

  /**
   * Build a composed behavioral directive from persona dial values.
   * Positioned at #2 in the system prompt (after Style, before SOUL.md)
   * so all dials have positional authority over the identity block.
   *
   * Returns empty string if no persona is configured.
   *
   * @returns {string} Imperative persona directive text
   */
  buildPersonaDirective() {
    if (!this.cachedConfig || !this.cachedConfig.persona) {
      return '';
    }

    const { name, humor, emoji, verbosity, formality, language } = this.cachedConfig.persona;

    const verbosityMap = {
      concise:  'Maximum two short paragraphs. If the core point fits in one sentence, stop there. Do not add context, background, or elaboration unless the human explicitly asks for it. When in doubt, cut.',
      balanced: 'Match response length to the complexity of the question. Neither pad nor compress.',
      detailed: 'Be thorough. Provide context, reasoning, and relevant detail. Don\'t cut for brevity.'
    };

    const formalityMap = {
      formal:   'Keep tone professional and precise. Client-facing register throughout.',
      balanced: 'Read the room. Match the human\'s register — professional when they are, relaxed when they are.',
      casual:   'Keep it conversational. Relaxed, direct, human. No corporate polish.'
    };

    const humorMap = {
      none:    'No humor. Strictly professional.',
      light:   'Light touch — occasional wit when it fits naturally. Don\'t force it.',
      playful: 'Playful when the moment allows. Jokes, wordplay, lighter energy are welcome.'
    };

    const emojiMap = {
      none:     'No emoji. Pure text only.',
      minimal:  'Occasional emoji for emphasis or tone. Use sparingly.',
      generous: 'Use emoji freely for tone and visual scanning.'
    };

    const lines = [
      '## Persona Directives',
      '',
      `Your name is ${name || 'Molti'}. Use it in self-references and signatures.`,
      '',
      `**Length:** ${verbosityMap[verbosity] || verbosityMap.balanced}`,
      `**Tone:** ${formalityMap[formality] || formalityMap.balanced}`,
      `**Humor:** ${humorMap[humor] || humorMap.light}`,
      `**Emoji:** ${emojiMap[emoji] || emojiMap.none}`
    ];

    if (language && language !== 'EN') {
      lines.push(`**Language:** Respond in ${language} by default. Switch to match the human's language if they write in a different one.`);
    }

    lines.push('');
    lines.push('These are active constraints. Apply them to every response.');

    return lines.join('\n');
  }

  /**
   * Compile the cached cockpit config into a text block for system prompt injection.
   * Pure synchronous function -- uses this.cachedConfig (no I/O).
   *
   * Note: Communication style and persona directives are NOT included here —
   * they are emitted separately by buildStyleDirective() and
   * buildPersonaDirective() and injected at the top of the system prompt
   * for maximum positional authority.
   *
   * Returns empty string if no config is cached yet.
   *
   * @returns {string} Markdown-formatted overlay text
   */
  buildSystemPromptOverlay() {
    if (!this.cachedConfig) {
      return '';
    }

    const c = this.cachedConfig;
    const parts = [];

    parts.push('## Active Configuration (from Cockpit)');
    parts.push('');

    // Guardrails
    if (c.guardrails && c.guardrails.length > 0) {
      parts.push('### Guardrails (MUST OBEY)');
      c.guardrails.forEach((rail, idx) => {
        parts.push(`${idx + 1}. **${rail.title}**: ${rail.description}`);
      });
      parts.push('');
    }

    // Current Mode — prominent block so the model can't miss it
    if (c.mode) {
      parts.push('=== YOUR CURRENT OPERATING MODE ===');
      parts.push(`Mode: ${c.mode.name}`);
      parts.push(`Behavior: ${c.mode.description}`);
      parts.push('When asked about your mode, state this mode name explicitly.');
      parts.push('===============================');
      parts.push('');
    }

    return parts.join('\n');
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  /**
   * Expand a Budget Limits preset label into a budget config object.
   * Maps ⚙1/⚙2/⚙3 to fixed limit values; returns null for custom (⚙4).
   *
   * @private
   * @param {string} source - Label source: 'off' (⚙1), 'moderate' (⚙2), 'on' (⚙3), 'custom' (⚙4)
   * @returns {Object|null} Budget config or null to fall through to custom parsing
   */
  _expandBudgetPreset(source) {
    switch (source) {
      case 'off':      return { dailyLimit: null, monthlyLimit: null }; // ⚙1 no limits
      case 'moderate': return { dailyLimit: 2.00, monthlyLimit: 30.00 }; // ⚙2 conservative
      case 'on':       return { dailyLimit: 5.00, monthlyLimit: 50.00 }; // ⚙3 moderate
      default:         return null; // fall through to custom parsing
    }
  }

  /**
   * Parse a Budget Limits card description into a config object.
   * Expected format (one key-value per line):
   *   Daily cloud limit: €5.00
   *   Monthly cloud limit: €50.00
   *   Workflow model: auto
   *   Warning threshold: 80%
   *
   * @private
   * @param {string} description - Card description text
   * @returns {Object} Parsed budget config
   */
  _parseBudgetCard(description) {
    const config = {};
    const lines = (description || '').split('---')[0].split('\n');
    for (const line of lines) {
      const match = line.match(/^(.+?):\s*[€$]?([\d.]+|[\w-]+)/i);
      if (match) {
        const key = match[1].trim().toLowerCase();
        const val = match[2];
        if (key.includes('daily'))    config.dailyLimit = parseFloat(val);
        if (key.includes('monthly'))  config.monthlyLimit = parseFloat(val);
        if (key.includes('model'))    config.workflowModel = val;
        if (key.includes('warning'))  config.warningThreshold = parseFloat(val) / 100;
      }
    }
    return config;
  }

  /**
   * Parse a Voice card description into a config object.
   * Expected format (one key-value per line):
   *   Voice input: on
   *   STT model: small
   *   Meeting notes: off
   *
   * @private
   * @param {string} description - Card description text
   * @returns {Object} Parsed voice config
   */
  _parseVoiceCard(description) {
    const config = { voiceInput: true, sttModel: 'small', meetingNotes: false };
    const lines = (description || '').split('---')[0].split('\n');
    for (const line of lines) {
      const match = line.match(/^(.+?):\s*(.+)/i);
      if (!match) continue;
      const key = match[1].trim().toLowerCase();
      const val = match[2].trim().toLowerCase();
      if (key.includes('voice input') || key.includes('input'))
        config.voiceInput = val === 'on' || val === 'true';
      if (key.includes('stt model') || key.includes('model'))
        config.sttModel = val;
      if (key.includes('meeting notes') || key.includes('notes'))
        config.meetingNotes = val === 'on' || val === 'true';
    }
    return config;
  }

  /**
   * Parse the Models card into a modelsConfig object.
   * Maps ⚙ labels to presets, or parses a custom roster from the card description.
   *
   * @private
   * @param {Object} card - Deck card object
   * @returns {{ preset?: string, roster?: Object }} Models configuration
   */
  _parseModelsCard(card) {
    const configSection = (card.description || '').split('---')[0];

    // Fingerprint: config section only (labels no longer control Models card)
    const labelKeys = (card.labels || []).map(l => l.title).sort().join(',');
    const fingerprint = `${labelKeys}|||${configSection}`;

    if (fingerprint === this._lastModelsFingerprint && this._lastModelsConfig) {
      return { ...this._lastModelsConfig, changed: false };
    }

    const isContentChange = this._lastModelsFingerprint !== null;
    if (isContentChange) {
      console.log('[CockpitManager] Models card content changed, re-parsing');
    }
    this._lastModelsFingerprint = fingerprint;

    let result;

    // Check for new trust-based format
    const trustMatch = configSection.match(/trust\s*:\s*(local-only|cloud-ok)/i);

    if (trustMatch) {
      // New trust-based format
      const trust = trustMatch[1].toLowerCase();
      const preferMatch = configSection.match(/prefer\s*:\s*(speed|quality|cost)/i);
      const prefer = preferMatch ? preferMatch[1].toLowerCase() : 'speed';

      // Check for optional custom roster override
      const rosterMatch = configSection.match(/roster:\s*\n([\s\S]*?)(?=\n\S|\s*$)/);
      let customRoster = null;
      if (rosterMatch) {
        customRoster = this._parseCustomRoster('roster:\n' + rosterMatch[1] + '\n---');
        if (Object.keys(customRoster).length === 0) customRoster = null;
      }

      result = { trust, prefer, customRoster };
    } else {
      // Check for old format and migrate
      const migrated = this._migrateOldModelsCard(card.description);
      if (migrated) {
        // Parse the migrated config text
        const mTrust = migrated.match(/trust\s*:\s*(local-only|cloud-ok)/i);
        const mPrefer = migrated.match(/prefer\s*:\s*(speed|quality|cost)/i);
        result = {
          trust: mTrust ? mTrust[1].toLowerCase() : 'local-only',
          prefer: mPrefer ? mPrefer[1].toLowerCase() : 'speed',
          customRoster: null,
          _migratedConfig: migrated
        };
      } else {
        // Check for ⚙4 custom Players/Roster format (power users)
        const { source } = this._resolveCardValue(card, {});
        if (source === 'custom') {
          try {
            const customConfig = this._parseCustomModelsCard(card.description);
            if (customConfig) {
              const pCount = Object.keys(customConfig.players || {}).length;
              const rCount = Object.keys(customConfig.roster || {}).length;
              console.log(`[CockpitManager] Parsed custom Models card: ${pCount} players, ${rCount} jobs`);
              result = customConfig;
            }
            if (!result) {
              const roster = this._parseCustomRoster(card.description);
              if (Object.keys(roster).length > 0) {
                result = { roster };
              }
            }
            if (!result) {
              console.warn('[CockpitManager] Custom roster is empty, falling back to local-only');
              result = { trust: 'local-only', prefer: 'speed', customRoster: null };
            }
          } catch (err) {
            console.error(`[CockpitManager] Failed to parse Models card: ${err.message}`);
            this._lastModelsConfig = null;
            return null;
          }
        } else {
          // No trust field, no old format detected, no custom label → default to local-only
          result = { trust: 'local-only', prefer: 'speed', customRoster: null };
        }
      }
    }

    // Store card metadata for heartbeat writeback
    result._cardId = card.id;
    result._cardDescription = card.description || '';
    result._userConfig = configSection;
    result._cardLabels = (card.labels || []).map(l => l.title);

    this._lastModelsConfig = result;
    return { ...result, changed: true };
  }

  /**
   * Parse a custom roster from a Models card description.
   * Reads lines above the `---` separator. Each line: `job: player1, player2`.
   * Ignores the `credentials` job (security invariant).
   *
   * @private
   * @param {string} description - Card description text
   * @returns {Object} Map of job → [player1, player2, ...]
   */
  _parseCustomRoster(description) {
    if (!description) return {};

    // Split on --- separator, take only content above it
    const parts = description.split('---');
    const configSection = parts[0];

    const roster = {};
    const lines = configSection.split('\n');

    for (const line of lines) {
      const match = line.match(/^\s*(quick|tools|thinking|writing|research|coding|synthesis)\s*:\s*(.+)/i);
      if (!match) continue;

      const job = match[1].toLowerCase();

      // Security invariant: credentials job cannot be overridden
      if (job === 'credentials') continue;

      // Accept both comma-separated and arrow-separated formats
      const players = match[2].split(/\s*(?:\u2192|->|,)\s*/).map(p => p.trim()).filter(Boolean);
      if (players.length > 0) {
        roster[job] = players;
      }
    }

    return roster;
  }

  /**
   * Parse a Models card description in the new Players/Roster format.
   * Returns null if the description has no Players section, so the caller
   * can fall back to legacy parsing.
   *
   * @private
   * @param {string} description - Card description text
   * @returns {{ players: Object, roster: Object, localDefault: string|null, preset: string }|null}
   */
  _parseCustomModelsCard(description) {
    if (!description) return null;

    const configSection = description.split('---')[0];
    const allLines = configSection.split('\n');

    let currentSection = null;
    const playerLines = [];
    const rosterLines = [];

    for (const line of allLines) {
      const lower = line.trim().toLowerCase();
      if (lower.startsWith('players:')) { currentSection = 'players'; continue; }
      if (lower.startsWith('roster:')) { currentSection = 'roster'; continue; }
      if (currentSection === 'players') playerLines.push(line);
      if (currentSection === 'roster') rosterLines.push(line);
    }

    const players = this._parsePlayersSection(playerLines);
    if (Object.keys(players).length === 0) return null;

    const localDefault = this._findLocalDefault(players);
    const roster = this._parseRosterSection(rosterLines, players, localDefault);

    return { players, roster, localDefault, preset: 'custom' };
  }

  /**
   * Find the first local player name in the players map, used as the
   * automatic last-resort fallback in roster chains.
   *
   * @private
   * @param {Object} players - Map of modelName → player definition
   * @returns {string|null} First local player name, or null if none
   */
  _findLocalDefault(players) {
    for (const [name, def] of Object.entries(players)) {
      if (def.local) return name;
    }
    return null;
  }

  /**
   * Parse a Players section into a map of model definitions.
   * Each line format: `<scope>: <model1>, <model2> (<provider-type>[, key: <label>][, endpoint: <url>])`
   * scope is `local` or `cloud` — determines the `local` boolean on each entry.
   *
   * @private
   * @param {string[]} lines - Lines from the Players section
   * @returns {Object} Map of modelName → { type, model, credentialLabel, endpoint, local }
   */
  _parsePlayersSection(lines) {
    const players = {};
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      // Match: local: model1, model2 (provider-type, key: label, endpoint: url)
      const match = trimmed.match(/^(?:local|cloud)\s*:\s*(.+?)\s*\(([^)]+)\)\s*$/i);
      if (!match) continue;

      const modelsStr = match[1];
      const paramsStr = match[2];

      // First param is provider type; remaining are key: value pairs
      const params = paramsStr.split(',').map(s => s.trim());
      const providerType = params[0];
      const kvPairs = {};
      for (let i = 1; i < params.length; i++) {
        const kv = params[i].match(/^(\w+)\s*:\s*(.+)$/);
        if (kv) kvPairs[kv[1]] = kv[2].trim();
      }

      const isLocal = trimmed.toLowerCase().startsWith('local');
      // Strip per-model provider annotations: "phi4-mini (ollama), qwen3:8b (ollama)" → ["phi4-mini", "qwen3:8b"]
      const modelNames = modelsStr.split(',').map(m => m.trim().replace(/\s*\([^)]*\)\s*$/, '')).filter(Boolean);

      for (const modelName of modelNames) {
        players[modelName] = {
          type: providerType,
          model: modelName,
          credentialLabel: kvPairs.key || null,
          endpoint: kvPairs.endpoint || null,
          local: isLocal,
        };
      }
    }
    return players;
  }

  /**
   * Parse a Roster section into a map of job → ordered player name array.
   * Each line format: `<job>: <player1> → <player2> → ...` (or ASCII ->).
   * Applies the last-local rule: if the chain doesn't end with a local player,
   * `localDefault` is appended as a final fallback.
   *
   * @private
   * @param {string[]} lines - Lines from the Roster section
   * @param {Object} players - Players map from _parsePlayersSection
   * @param {string|null} localDefault - First local player name (or null)
   * @returns {Object} Map of job → [playerName, ...]
   */
  _parseRosterSection(lines, players, localDefault) {
    const roster = {};
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const match = trimmed.match(/^(\w[\w-]*)\s*:\s*(.+)$/);
      if (!match) continue;

      const job = match[1].toLowerCase();
      if (job === 'credentials') continue; // security invariant

      const chain = match[2]
        .split(/\s*(?:\u2192|->)\s*/)
        .map(p => p.trim())
        .filter(Boolean);

      const validChain = [];
      for (const playerName of chain) {
        if (players[playerName]) {
          validChain.push(playerName);
        } else {
          console.warn(`[CockpitManager] Unknown player '${playerName}' in ${job} roster. Skipped.`);
        }
      }

      if (validChain.length === 0) {
        if (localDefault) validChain.push(localDefault);
        else continue;
      }

      // Last-local rule: ensure chain ends with a local player as ultimate fallback
      const lastPlayer = players[validChain[validChain.length - 1]];
      if (lastPlayer && !lastPlayer.local && localDefault && !validChain.includes(localDefault)) {
        validChain.push(localDefault);
      }

      roster[job] = validChain;
    }
    return roster;
  }

  /**
   * Detect old Models card format and return equivalent trust-based config text.
   * Returns null if already in new format or unrecognized.
   *
   * @private
   * @param {string} description - Full card description
   * @returns {string|null} Migrated config text (e.g. 'trust: cloud-ok\n') or null
   */
  _migrateOldModelsCard(description) {
    if (!description) return null;
    const configSection = description.split('---')[0];

    // Detect old format: has "Active preset:" or "synthesis_provider"
    // Note: the old card's doc header contains all ⚙️ tags as a menu line
    // ("⚙️1 all-local / ⚙️2 smart mix / ..."), so individual ⚙️ tags in
    // the text are NOT reliable indicators of the active preset. Instead,
    // check "Active preset:" line and synthesis_provider field.
    const hasOldFormat = configSection.includes('Active preset:') ||
      configSection.includes('synthesis_provider');

    if (!hasOldFormat) return null;

    // ⚙4 with Players/Roster: don't migrate, let the custom parser handle it
    if (configSection.toLowerCase().includes('players:')) {
      return null;
    }

    // Most specific signal: synthesis_provider: haiku → was using cloud for synthesis
    if (configSection.match(/synthesis_provider\s*:\s*haiku/i)) {
      // Check if it was cloud-first (quality preference)
      if (configSection.toLowerCase().includes('active preset: cloud-first')) {
        return 'trust: cloud-ok\nprefer: quality\n';
      }
      return 'trust: cloud-ok\n';
    }

    // Active preset: All-local → local-only
    if (configSection.toLowerCase().includes('active preset: all-local')) {
      return 'trust: local-only\n';
    }

    // Active preset: Cloud-first without haiku → cloud-ok quality
    if (configSection.toLowerCase().includes('active preset: cloud-first')) {
      return 'trust: cloud-ok\nprefer: quality\n';
    }

    // Active preset: Smart mix without haiku → local-only (was local synthesis)
    if (configSection.toLowerCase().includes('active preset: smart mix')) {
      return 'trust: local-only\n';
    }

    // synthesis_provider: local explicitly → local-only
    if (configSection.match(/synthesis_provider\s*:\s*local/i)) {
      return 'trust: local-only\n';
    }

    // Default: local-only (sovereignty)
    return 'trust: local-only\n';
  }

  /**
   * Build a roster object from a trust boundary and preference.
   * Pure function — no I/O.
   *
   * @param {string} trust - 'local-only' or 'cloud-ok'
   * @param {string} prefer - 'speed', 'quality', or 'cost'
   * @param {Object} infra - Infrastructure detection result
   * @param {Array} infra.localModels - Available local models
   * @param {boolean} infra.gpuDetected - Whether GPU is available
   * @param {Array} infra.cloudProviders - Available cloud providers [{name, models}]
   * @returns {Object} Roster: job → provider-ID chain
   */
  _buildRosterFromTrust(trust, prefer, infra) {
    // Security invariant: credentials job is never included here.
    // It is always local-only, enforced by the router's _buildRosterChain().
    const hasHaiku = (infra.cloudProviders || []).some(p =>
      p.name === 'Anthropic' || p.models?.some(m => m.toLowerCase().includes('haiku'))
    );
    const hasSonnet = (infra.cloudProviders || []).some(p =>
      p.name === 'Anthropic' || p.models?.some(m => m.toLowerCase().includes('sonnet'))
    );
    const hasOpus = (infra.cloudProviders || []).some(p =>
      p.name === 'Anthropic' || p.models?.some(m => m.toLowerCase().includes('opus'))
    );

    // Provider IDs matching moltagent-providers.yaml
    const opus = 'anthropic-claude';   // claude-opus-4-6
    const sonnet = 'claude-sonnet';    // claude-sonnet-4-5
    const haiku = 'claude-haiku';      // claude-haiku-4-5

    const localFast = 'ollama-fast';
    const localCapable = 'ollama-local';

    if (trust === 'local-only') {
      return {
        quick: [localFast, localCapable],
        synthesis: [localFast, localCapable],
        decomposition: [localCapable, localFast],
        tools: [localCapable, localFast],
        thinking: [localCapable],
        writing: [localCapable],
        research: [localCapable],
        coding: [localCapable]
      };
    }

    // trust === 'cloud-ok'
    if (prefer === 'cost') {
      // Minimize cloud spend: local first, cloud as fallback only
      return {
        quick: [localFast, localCapable],
        synthesis: hasHaiku
          ? [haiku, localFast, localCapable]
          : [localFast, localCapable],
        decomposition: hasHaiku ? [haiku, localCapable, localFast] : [localCapable, localFast],
        tools: [localCapable, localFast],
        thinking: [localCapable, hasSonnet ? sonnet : null].filter(Boolean),
        writing: [localCapable, hasSonnet ? sonnet : null].filter(Boolean),
        research: [localCapable, hasSonnet ? sonnet : null].filter(Boolean),
        coding: [localCapable, hasSonnet ? sonnet : null].filter(Boolean)
      };
    }

    if (prefer === 'quality') {
      // Maximum quality: Opus for deep work, Sonnet for tools/research
      return {
        quick: [localFast, localCapable],
        synthesis: [hasSonnet ? sonnet : null, hasHaiku ? haiku : null, localCapable].filter(Boolean),
        decomposition: [hasHaiku ? haiku : null, localCapable, localFast].filter(Boolean),
        tools: [localCapable, hasHaiku ? haiku : null, localFast].filter(Boolean),
        thinking: [hasOpus ? opus : null, hasSonnet ? sonnet : null, localCapable].filter(Boolean),
        writing: [hasOpus ? opus : null, hasSonnet ? sonnet : null, localCapable].filter(Boolean),
        research: [hasSonnet ? sonnet : null, hasOpus ? opus : null, localCapable].filter(Boolean),
        coding: [hasOpus ? opus : null, hasSonnet ? sonnet : null, localCapable].filter(Boolean)
      };
    }

    // Default: prefer === 'speed'
    // Opus for thinking/writing (best output), Sonnet for research/coding (fast enough)
    return {
      quick: [localFast, localCapable],
      synthesis: hasHaiku
        ? [haiku, localFast, localCapable]
        : [localFast, localCapable],
      decomposition: hasHaiku ? [haiku, localCapable, localFast] : [localCapable, localFast],
      tools: [localCapable, hasHaiku ? haiku : null, localFast].filter(Boolean),
      thinking: [hasOpus ? opus : null, hasSonnet ? sonnet : null, localCapable].filter(Boolean),
      writing: [hasOpus ? opus : null, hasSonnet ? sonnet : null, localCapable].filter(Boolean),
      research: [hasSonnet ? sonnet : null, localCapable].filter(Boolean),
      coding: [hasSonnet ? sonnet : null, localCapable].filter(Boolean)
    };
  }

  /**
   * Generate the description section (below ---) for the Models card.
   * Shows trust status, infrastructure, performance estimates, cost, and tips.
   * Pure function — no I/O.
   *
   * @param {string} trust - 'local-only' or 'cloud-ok'
   * @param {string} prefer - 'speed', 'quality', or 'cost'
   * @param {Object} infra - Infrastructure detection result
   * @returns {string} Full description starting with '---'
   */
  _generateModelsCardDescription(trust, prefer, infra) {
    let desc = '\n\n---\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';

    // Trust section
    if (trust === 'local-only') {
      desc += '\ud83d\udd12 Trust: Local only\n';
      desc += '   All data stays on your servers. Nothing leaves your infrastructure.\n\n';
    } else {
      desc += '\ud83c\udf10 Trust: Cloud allowed\n';
      desc += '   Simple tasks run locally (free, private).\n';
      desc += '   Knowledge answers use cloud AI (fast, small cost).\n\n';
    }

    // Infrastructure section
    desc += '\ud83d\udcca Your Setup:\n';
    const modelCount = (infra.localModels || []).length;
    desc += `   Local AI: ${modelCount} model(s) ready\n`;
    desc += `   GPU: ${infra.gpuDetected ? 'detected \u26a1' : 'not detected (CPU inference)'}\n`;

    if ((infra.cloudProviders || []).length > 0) {
      const providers = infra.cloudProviders.map(p => `${p.name} \u2705`).join(', ');
      desc += `   Cloud AI: ${providers}\n`;
    } else {
      desc += '   Cloud AI: no API keys configured\n';
    }
    desc += '\n';

    // Performance estimates
    desc += '\u26a1 Estimated Performance:\n';
    if (trust === 'local-only') {
      if (infra.gpuDetected) {
        desc += '   Simple questions: ~1-2 seconds \u26a1\n';
        desc += '   Knowledge answers: ~3-5 seconds \u26a1\n';
        desc += '   Complex tasks: ~8-15 seconds\n';
      } else {
        desc += '   Simple questions: ~3 seconds\n';
        desc += '   Knowledge answers: ~15-20 seconds\n';
        desc += '   Complex tasks: ~30-60 seconds\n';
      }
    } else {
      desc += '   Simple questions: ~3 seconds\n';
      desc += '   Knowledge answers: ~3-5 seconds \u26a1\n';
      desc += '   Complex tasks: ~10-15 seconds \u26a1\n';
    }
    desc += '\n';

    // Cost section
    desc += '\ud83d\udcb0 Estimated Cost:\n';
    if (trust === 'local-only') {
      desc += '   \u20ac0/month (everything runs locally)\n';
    } else {
      desc += '   Classification: free (always local)\n';
      desc += '   Knowledge answers: ~\u20ac0.001/query (Haiku)\n';
      desc += '   Complex tasks: ~\u20ac0.01/task (Sonnet)\n';
      desc += '   Typical month: \u20ac3-8 depending on usage\n';
    }
    desc += '\n';

    // Tips
    desc += '\ud83d\udca1 Tips:\n';
    if (trust === 'local-only') {
      if (!infra.gpuDetected) {
        desc += '   \u2022 Add a GPU server for 3-5x faster local responses\n';
      }
      if ((infra.cloudProviders || []).length === 0) {
        desc += '   \u2022 Add an Anthropic API key in Nextcloud Passwords for cloud option\n';
      }
      desc += '   \u2022 Change "trust: cloud-ok" above the line to enable cloud AI\n';
    } else {
      desc += '   \u2022 Change "trust: local-only" above the line for full privacy\n';
      if (!infra.gpuDetected) {
        desc += '   \u2022 Add a GPU server to get cloud-like speed without cloud cost\n';
      }
    }
    desc += '\n';

    // How it works section
    desc += '\u2501\u2501\u2501 How it works \u2501\u2501\u2501\n\n';
    desc += 'Your agent does different types of work:\n\n';
    desc += '\ud83d\udce8 Understanding your message\n';
    desc += '   Always done locally (free, instant, private).\n\n';
    desc += '\ud83d\udd0d Finding information\n';
    desc += '   Searches your wiki, task boards, calendar, past conversations.\n';
    desc += '   Always local, even in cloud mode.\n\n';
    desc += '\ud83d\udcdd Composing answers\n';
    if (trust === 'local-only') {
      desc += '   Your local AI writes the response.\n\n';
    } else {
      desc += '   Claude Haiku writes the response (fast, ~\u20ac0.001).\n\n';
    }
    desc += '\ud83e\udde0 Complex thinking\n';
    if (trust === 'local-only') {
      desc += '   Your most capable local AI handles deep reasoning.\n\n';
    } else {
      desc += '   Claude Opus handles deep reasoning and creative writing (~\u20ac0.05).\n';
      desc += '   Claude Sonnet for research and coding (~\u20ac0.01).\n\n';
    }
    desc += '\ud83d\udd12 Always private (every mode):\n';
    desc += '   \u2022 Wiki, task boards, calendar stay on your server\n';
    desc += '   \u2022 Classification is always local\n';
    desc += '   \u2022 Search is always local\n\n';

    if (trust === 'cloud-ok') {
      desc += '\ud83c\udf10 Sent to cloud AI (cloud mode only):\n';
      desc += '   \u2022 Found information + your question \u2192 cloud AI \u2192 answer\n';
      desc += '   \u2022 No data is stored by the cloud provider\n\n';
    }

    // Advanced section
    desc += '\u2501\u2501\u2501 Advanced \u2501\u2501\u2501\n\n';
    desc += 'Override automatic routing by adding a custom roster above the line:\n\n';
    desc += 'trust: cloud-ok\n';
    desc += 'roster:\n';
    desc += '  quick: qwen2.5:3b \u2192 qwen3:8b\n';
    desc += '  synthesis: claude-haiku \u2192 qwen2.5:3b\n';
    desc += '  tools: phi4-mini \u2192 qwen3:8b \u2192 claude-sonnet\n';
    desc += '  thinking: anthropic-claude \u2192 claude-sonnet \u2192 qwen3:8b\n';
    desc += '  writing: anthropic-claude \u2192 claude-sonnet \u2192 qwen3:8b\n';
    desc += '  research: claude-sonnet \u2192 anthropic-claude\n';
    desc += '  coding: anthropic-claude \u2192 claude-sonnet\n\n';

    desc += 'Available providers:\n';
    desc += '  Local:\n';
    for (const model of (infra.localModels || []).slice(0, 5)) {
      desc += `    ${model.name}\n`;
    }
    if ((infra.cloudProviders || []).length > 0) {
      desc += '  Cloud:\n';
      for (const provider of infra.cloudProviders) {
        desc += `    ${provider.name}: ${(provider.models || []).join(', ')}\n`;
      }
    }
    desc += '\nAdd API keys in Nextcloud Passwords:\n';
    desc += '  anthropic-api-key \u2192 Claude (Opus, Sonnet, Haiku)\n';
    desc += '  openai-api-key \u2192 GPT-4o\n';
    desc += '  google-ai-api-key \u2192 Gemini Pro\n';

    return desc;
  }

  /**
   * Write a new description to the Models card. Skips if unchanged.
   *
   * @private
   * @param {Object} card - Deck card object (must have .id)
   * @param {string} newDescription - Full new description text
   * @returns {Promise<void>}
   */
  async _writeModelsCardDescription(card, newDescription) {
    if (!card || !card.id) return;
    if (newDescription === card.description) return; // avoid API spam

    try {
      const stackId = this.stacks.system;
      if (stackId) {
        const updatePath = `/index.php/apps/deck/api/v1.0/boards/${this.boardId}/stacks/${stackId}/cards/${card.id}`;
        await this.deck._request('PUT', updatePath, {
          title: card.title || 'Models',
          description: newDescription,
          type: 'plain',
          owner: card.owner || 'moltagent'
        });
      }
    } catch (err) {
      console.warn(`[CockpitManager] Failed to write Models card description: ${err.message}`);
    }
  }

  /**
   * Remove a label from a cockpit card by label title.
   * Uses the cockpit board's own label registry, not the task board's.
   * @param {number} cardId - Card ID
   * @param {string} labelTitle - Label title (e.g. '⚙️2')
   */
  async _removeCardLabel(cardId, labelTitle) {
    const stackId = this.stacks.system;
    if (!stackId || !this.boardId) return;

    const labelObj = this.labels?.[labelTitle] || this.labels?.[labelTitle.toLowerCase()];
    const labelId = labelObj?.id;
    if (!labelId) return;

    try {
      await this.deck._request(
        'PUT',
        `/index.php/apps/deck/api/v1.0/boards/${this.boardId}/stacks/${stackId}/cards/${cardId}/removeLabel`,
        { labelId }
      );
    } catch (err) {
      // Label may already be gone — ignore
    }
  }

  /**
   * Find a card with the "Active" label in a list of cards.
   * @private
   * @param {Array<Object>} cards - Cards to search
   * @returns {Object|null} Card with Active label, or null
   */
  _findStarredCard(cards) {
    if (!Array.isArray(cards)) return null;

    for (const card of cards) {
      if (Array.isArray(card.labels)) {
        for (const label of card.labels) {
          if (!label.title) continue;
          // Match ⚙★ (current) or ⭐ Active (legacy)
          // Normalize: strip variation selector U+FE0F so ⚙★ and ⚙️★ both match
          const t = label.title.replace(/\ufe0f/g, '');
          if (t === '\u2699\u2605' || label.title.includes('Active')) {
            return card;
          }
        }
      }
    }

    return null;
  }

  /**
   * Determine the option value from a card's assigned labels.
   * @private
   * @param {Object} card - Deck card object
   * @param {Object} valueMap - Map of { option1, option2, option3 } to values
   * @returns {{ value: string, source: string }} Resolved value and which label was used
   */
  _resolveCardValue(card, valueMap) {
    if (!card || !Array.isArray(card.labels)) {
      return { value: valueMap?.moderate || '', source: 'default' };
    }

    for (const label of card.labels) {
      if (!label.title) continue;

      // Normalize: strip variation selector U+FE0F so ⚙1 and ⚙️1 both match
      const t = label.title.replace(/\ufe0f/g, '');

      // ⚙4 (current) or Custom (legacy)
      if (t === '\u26994' || label.title.includes('Custom')) {
        // Strip documentation below --- separator
        const raw = card.description || '';
        const value = raw.split('---')[0].trim();
        return { value, source: 'custom' };
      }
      // ⚙1 (current) or Off (A3) or Option 1 (original)
      if (t === '\u26991' || label.title.includes('Off') || label.title.includes('Option 1')) {
        return { value: valueMap?.off || '', source: 'off' };
      }
      // ⚙2 (current) or Moderate (A3) or Option 2 (original)
      if (t === '\u26992' || label.title.includes('Moderate') || label.title.includes('Option 2')) {
        return { value: valueMap?.moderate || '', source: 'moderate' };
      }
      // ⚙3 (current) or On (A3) or Option 3 (original)
      if (t === '\u26993' || label.title.includes('On') || label.title.includes('Option 3')) {
        return { value: valueMap?.on || '', source: 'on' };
      }
    }

    return { value: valueMap?.moderate || '', source: 'default' };
  }

  /**
   * Format health status description for the Health card.
   * @private
   * @param {Object} health - Health metrics
   * @returns {string} Formatted description
   */
  _formatHealthStatus(health) {
    // New rich format: if infra check results are present, render per-service lines
    if (health?.infra) {
      const infra = health.infra;
      const parts = [];

      // Overall status line
      const overallEmoji = infra.overall === 'ok' ? '\ud83d\udfe2' : (infra.overall === 'down' ? '\ud83d\udd34' : '\ud83d\udfe1');
      parts.push(`${overallEmoji} ${(infra.overall || 'unknown').toUpperCase()}`);

      // Per-service lines
      if (infra.services) {
        for (const [id, svc] of Object.entries(infra.services)) {
          if (svc.ok) {
            parts.push(`\ud83d\udfe2 ${id} (${svc.latencyMs}ms)`);
          } else {
            const reason = svc.error || 'error';
            parts.push(`\ud83d\udd34 ${id} -- ${reason}`);
          }
        }
      }

      // System stat warnings
      if (infra.systemStats) {
        if (infra.systemStats.ramUsedPct != null && infra.systemStats.ramUsedPct > 85) {
          parts.push(`\u26a0\ufe0f RAM: ${infra.systemStats.ramUsedPct}%`);
        }
        if (infra.systemStats.diskUsedPct != null && infra.systemStats.diskUsedPct > 90) {
          parts.push(`\u26a0\ufe0f Disk: ${infra.systemStats.diskUsedPct}%`);
        }
      }

      // Uptime line
      const uptimeDays = health.uptimeDays || infra.systemStats?.uptimeDays || 0;
      parts.push(`Uptime: ${uptimeDays}d`);

      // Request success rate
      if (health.requestStats) {
        const rs = health.requestStats;
        parts.push(`Last session: ${rs.total} requests, ${rs.succeeded} succeeded (${rs.rate}%)`);
      }

      return parts.join('\n');
    }

    // Legacy format (backwards-compatible)
    const status = health?.status || 'OK';
    const emoji = status === 'OK' ? '\ud83d\udfe2' : '\ud83d\udd34';
    const uptimeDays = health?.uptimeDays || 0;
    const uptimeHours = health?.uptimeHours || 0;
    const lastError = health?.lastError || 'none';

    const parts = [`${emoji} ${status} -- Uptime: ${uptimeDays}d ${uptimeHours}h -- Last error: ${lastError}`];

    // Request success rate
    if (health?.requestStats) {
      const rs = health.requestStats;
      parts.push(`Last session: ${rs.total} requests, ${rs.succeeded} succeeded (${rs.rate}%)`);
    }

    return parts.join('\n');
  }

  /**
   * Format cost summary for the Costs card using monthly data with local/cloud breakdown.
   * @private
   * @param {Object} costs - Cost metrics from BudgetEnforcer.getFullReport(), enriched with _providerTypes
   * @returns {string} Formatted description
   */
  _formatCostStatus(data) {
    // Enhanced path: use CostTracker when available
    if (data?.costTracker) {
      return this._formatCostStatusFromTracker(data.costTracker, data.costs);
    }

    // Legacy path: use BudgetEnforcer report directly
    const costs = data?.costs || data;
    if (!costs || !costs.providers) {
      return 'This month: \u20ac0.00\nCloud: 0 calls\nLocal: 0 calls\nLocal ratio: --';
    }

    let monthlyTotal = 0;
    let cloudCalls = 0;
    let localCalls = 0;
    const cloudProviders = [];

    for (const [providerId, summary] of Object.entries(costs.providers)) {
      const monthly = summary?.monthly || {};
      monthlyTotal += monthly.cost || 0;
      if (costs._providerTypes?.[providerId] === 'local') {
        localCalls += monthly.calls || 0;
      } else {
        cloudCalls += monthly.calls || 0;
        if ((monthly.calls || 0) > 0) {
          cloudProviders.push(`${providerId}: ${monthly.calls}`);
        }
      }
    }

    const totalCalls = cloudCalls + localCalls;
    const localRatio = totalCalls > 0 ? Math.round((localCalls / totalCalls) * 100) : 0;

    const lines = [`This month: \u20ac${monthlyTotal.toFixed(2)}`];
    lines.push(`Cloud: ${cloudCalls} calls${cloudProviders.length ? ' (' + cloudProviders.join(', ') + ')' : ''}`);
    lines.push(`Local: ${localCalls} calls`);
    lines.push(`Local ratio: ${totalCalls > 0 ? localRatio + '%' : '--'}`);

    return lines.join('\n');
  }

  /**
   * Format cost summary using CostTracker data (enriched display).
   * Shows daily + monthly with budget limits and top spending breakdown.
   * @private
   * @param {Object} costTracker - CostTracker instance
   * @param {Object} [costs] - BudgetEnforcer report (for budget limit display)
   * @returns {string} Formatted description
   */
  _formatCostStatusFromTracker(costTracker, costs) {
    const totals = costTracker.getTotals();
    const budget = this.cachedConfig?.budget || {};

    const lines = [];

    // Daily line
    const dailyEur = totals.daily.costEur.toFixed(2);
    if (budget.dailyLimit) {
      lines.push(`Today: \u20ac${dailyEur} / \u20ac${budget.dailyLimit.toFixed(2)}`);
    } else {
      lines.push(`Today: \u20ac${dailyEur}`);
    }

    // Monthly line
    const monthlyEur = totals.monthly.costEur.toFixed(2);
    if (budget.monthlyLimit) {
      lines.push(`This month: \u20ac${monthlyEur} / \u20ac${budget.monthlyLimit.toFixed(2)}`);
    } else {
      lines.push(`This month: \u20ac${monthlyEur}`);
    }

    lines.push('');
    lines.push(`Cloud: ${totals.monthly.cloudCalls} calls`);
    lines.push(`Local: ${totals.monthly.localCalls} calls`);
    lines.push(`Local ratio: ${totals.localRatio}%`);

    // Top spending breakdown
    if (totals.topSpending.length > 0) {
      lines.push('');
      lines.push('Top spending:');
      for (const s of totals.topSpending) {
        lines.push(`  ${s.job} (${s.type}): \u20ac${(s.costUsd * costTracker.usdToEur).toFixed(2)}`);
      }
    }

    // Timestamp
    lines.push('');
    lines.push(`_Updated: ${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}_`);

    return lines.join('\n');
  }

  /**
   * Format model usage breakdown for the Model Usage card.
   * Shows per-provider request counts with local/cloud labels.
   * @private
   * @param {Object} routerStats - Router stats enriched with _providerTypes and budget data
   * @returns {string} Formatted description
   */
  _formatModelUsage(routerStats) {
    if (!routerStats || !routerStats.byProvider) {
      return 'This month: 0 requests\nNo provider data yet.';
    }

    const budget = routerStats.budget;
    const byProvider = routerStats.byProvider;

    // Use budget monthly calls if available (survives restarts), else router stats
    let totalMonthly = 0;
    const providerLines = [];

    if (budget?.providers) {
      for (const [id, summary] of Object.entries(budget.providers)) {
        const calls = summary?.monthly?.calls || 0;
        if (calls > 0) {
          totalMonthly += calls;
          const isLocal = routerStats._providerTypes?.[id] === 'local';
          const label = isLocal ? `${id} (local)` : `${id} (cloud)`;
          providerLines.push({ label, calls, isLocal });
        }
      }
    }

    // Fallback to router session stats
    if (totalMonthly === 0) {
      for (const [id, calls] of Object.entries(byProvider)) {
        if (calls > 0) {
          totalMonthly += calls;
          const isLocal = routerStats._providerTypes?.[id] === 'local';
          const label = isLocal ? `${id} (local)` : `${id} (cloud)`;
          providerLines.push({ label, calls, isLocal });
        }
      }
    }

    // Sort by calls desc
    providerLines.sort((a, b) => b.calls - a.calls);

    const lines = [`This month: ${totalMonthly} requests`];
    for (const p of providerLines) {
      const pct = totalMonthly > 0 ? Math.round((p.calls / totalMonthly) * 100) : 0;
      lines.push(`${p.label}: ${p.calls} (${pct}%)`);
    }

    return lines.join('\n');
  }

  /**
   * Create any DEFAULT_CARDS entries that are missing from existing stacks.
   * Called during initialize() on existing boards so that cards added in
   * later releases (e.g. Budget Limits) appear without a full re-bootstrap.
   * Safe and idempotent — only creates cards that don't exist by exact title match.
   *
   * @private
   * @param {Array<Object>} stacks - Fetched stacks with cards
   * @returns {Promise<void>}
   */
  async _ensureMissingCards(stacks) {
    for (const def of STACK_DEFS) {
      const stackId = this.stacks[def.key];
      if (!stackId) continue;

      const cardDefs = DEFAULT_CARDS[def.key] || [];
      if (cardDefs.length === 0) continue;

      // Find the matching stack in fetched data
      const stack = stacks.find(s => s.id === stackId);
      const existingTitles = new Set((stack?.cards || []).map(c => c.title));

      for (let i = 0; i < cardDefs.length; i++) {
        const cardDef = cardDefs[i];
        if (existingTitles.has(cardDef.title)) continue;

        // Card is missing — create it
        const cardPath = `/index.php/apps/deck/api/v1.0/boards/${this.boardId}/stacks/${stackId}/cards`;
        const card = await this.deck._request('POST', cardPath, {
          title: cardDef.title,
          description: cardDef.description,
          type: 'plain',
          order: i
        });

        // Assign default label if specified
        if (cardDef.defaultLabel) {
          const label = this.labels[cardDef.defaultLabel];
          if (label) {
            const assignPath = `/index.php/apps/deck/api/v1.0/boards/${this.boardId}/stacks/${stackId}/cards/${card.id}/assignLabel`;
            try {
              await this.deck._request('PUT', assignPath, { labelId: label.id });
            } catch (err) {
              // Non-critical
            }
          }
        }

        console.log(`[CockpitManager] Created missing card: "${cardDef.title}" in stack "${def.title}"`);
      }
    }
  }

  /**
   * Remove obsolete cards from the status stack that are no longer in DEFAULT_CARDS.
   * Called during initialize() after _ensureMissingCards() to clean up cards from
   * previous releases (e.g. "Tasks This Week", "Knowledge", "Recent Actions", "💰 Costs").
   *
   * @private
   * @param {Array<Object>} stacks - Fetched stacks with cards
   * @returns {Promise<void>}
   */
  async _removeObsoleteCards(stacks) {
    // Obsolete cards per stack — user-added custom cards are preserved.
    const OBSOLETE_TITLES = {
      status: new Set([
        'Tasks This Week', 'Costs This Month', 'Knowledge',
        'Recent Actions', '\ud83d\udcb0 Costs'
      ]),
      system: new Set([
        'Search Provider', 'Auto-tag Files', 'LLM Tier',
        '\ud83c\udfe5 Infrastructure'
      ])
    };

    for (const [stackKey, obsoleteTitles] of Object.entries(OBSOLETE_TITLES)) {
      const stackId = this.stacks[stackKey];
      if (!stackId) continue;

      const stack = stacks.find(s => s.id === stackId);
      if (!stack?.cards) continue;

      for (const card of stack.cards) {
        if (obsoleteTitles.has(card.title)) {
          try {
            const deletePath = `/index.php/apps/deck/api/v1.0/boards/${this.boardId}/stacks/${stackId}/cards/${card.id}`;
            await this.deck._request('DELETE', deletePath);
            console.log(`[CockpitManager] Removed obsolete card: "${card.title}"`);
          } catch (err) {
            console.warn(`[CockpitManager] Failed to remove card "${card.title}": ${err.message}`);
          }
        }
      }
    }
  }

  /**
   * Resolve stack IDs and label IDs from the current board.
   * Updates this.stacks and this.labels.
   * @private
   * @param {Object} boardData - Full board object with stacks and labels arrays
   */
  _resolveIdsFromBoard(boardData) {
    // Map stacks: match stack titles to STACK_DEFS keys
    if (Array.isArray(boardData.stacks)) {
      for (const stack of boardData.stacks) {
        for (const def of STACK_DEFS) {
          // Match if the stack title includes the emoji/title from STACK_DEFS
          if (stack.title && stack.title.includes(def.title.split(' ')[1])) {
            this.stacks[def.key] = stack.id;
            break;
          }
        }
      }
    }

    // Map labels: store by title
    if (Array.isArray(boardData.labels)) {
      for (const label of boardData.labels) {
        if (label.title) {
          this.labels[label.title] = label;
        }
      }
    }
  }

  /**
   * Migrate label names from any previous generation to the ⚙ namespace.
   * Matches by color (stable across all generations) and updates title + color
   * via PUT if the label doesn't already match the target.
   * Safe and idempotent — skips labels already at their target.
   *
   * Handles three generations:
   *   Gen 1 (original): Option 1/2/3, ⭐ Active, 🔵 Custom
   *   Gen 2 (A3):       🔴 Off, 🟡 Moderate, 🟢 On
   *   Gen 3 (A3b):      ⚙1, ⚙2, ⚙3, ⚙★, ⚙4
   *
   * @private
   * @returns {Promise<number>} Number of labels migrated
   */
  async _migrateLabels() {
    // Key = OLD color on board, value = target title + optional new color
    const MIGRATIONS = {
      'e9322d': { to: '\u2699\ufe0f1' },                          // red: Option 1 / Off → ⚙1
      'f0c400': { to: '\u2699\ufe0f2' },                          // yellow: Option 2 / Moderate → ⚙2
      '00b600': { to: '\u2699\ufe0f3' },                          // green: Option 3 / On → ⚙3
      'ff8700': { to: '\u2699\ufe0f\u2605', newColor: 'ffd700' }, // orange→gold: Active → ⚙★
      '0082c9': { to: '\u2699\ufe0f4', newColor: '0000ff' }       // teal→blue: Custom → ⚙4
    };

    let migrated = 0;

    for (const label of Object.values(this.labels)) {
      const migration = MIGRATIONS[label.color?.toLowerCase()];
      if (!migration) continue;
      if (label.title === migration.to) continue; // already at target

      try {
        const labelPath = `/index.php/apps/deck/api/v1.0/boards/${this.boardId}/labels/${label.id}`;
        await this.deck._request('PUT', labelPath, {
          title: migration.to,
          color: migration.newColor || label.color
        });
        console.log(`[CockpitManager] Migrated label: "${label.title}" -> "${migration.to}"`);
        label.title = migration.to;
        if (migration.newColor) label.color = migration.newColor;
        migrated++;
      } catch (err) {
        console.warn(`[CockpitManager] Failed to migrate label "${label.title}": ${err.message}`);
      }
    }

    // Create any reserved labels that don't exist yet on the board
    const existingTitles = new Set(Object.values(this.labels).map(l => l.title));
    for (const def of LABEL_DEFS) {
      if (existingTitles.has(def.title)) continue;
      try {
        const labelPath = `/index.php/apps/deck/api/v1.0/boards/${this.boardId}/labels`;
        const label = await this.deck._request('POST', labelPath, {
          title: def.title,
          color: def.color
        });
        this.labels[label.title] = label;
        console.log(`[CockpitManager] Created reserved label: "${def.title}"`);
        migrated++;
      } catch (err) {
        console.warn(`[CockpitManager] Failed to create label "${def.title}": ${err.message}`);
      }
    }

    return migrated;
  }

  /**
   * Delete the default stacks that Deck creates ("To do", "Doing", "Done").
   * @private
   * @param {number} boardId - Board ID
   * @param {Array<Object>} existingStacks - Current stacks on the board
   * @returns {Promise<void>}
   */
  async _deleteDefaultStacks(boardId, existingStacks) {
    const defaultStackTitles = ['To do', 'Doing', 'Done'];

    for (const stack of existingStacks) {
      if (defaultStackTitles.includes(stack.title)) {
        const path = `/index.php/apps/deck/api/v1.0/boards/${boardId}/stacks/${stack.id}`;
        try {
          await this.deck._request('DELETE', path);
        } catch (err) {
          // Ignore errors, continue deleting other stacks
        }
      }
    }
  }
}

// ===========================================================================
// Type Definitions (for JSDoc)
// ===========================================================================

/**
 * @typedef {Object} CockpitConfig
 * @property {{name: string, description: string}|null} style - Active communication style
 * @property {PersonaConfig} persona - Persona settings
 * @property {Array<{title: string, description: string}>} guardrails - Active guardrails
 * @property {{name: string, description: string}|null} mode - Active operating mode
 * @property {SystemConfig} system - System settings
 */

/**
 * @typedef {Object} PersonaConfig
 * @property {string} name - Agent name (e.g., "Molti")
 * @property {string} humor - none | light | playful
 * @property {string} emoji - none | minimal | generous
 * @property {string} language - Language code(s) (e.g., "EN", "EN+PT")
 * @property {string} verbosity - concise | balanced | detailed
 * @property {string} formality - formal | balanced | casual
 */

/**
 * @typedef {Object} SystemConfig
 * @property {string} dailyDigest - Time string (e.g., "08:00") or "off"
 * @property {number} initiativeLevel - 1-4
 * @property {string} workingHours - Time range (e.g., "08:00-18:00")
 */

// ===========================================================================
// Exports
// ===========================================================================

module.exports = CockpitManager;
module.exports.CockpitError = CockpitError;
module.exports.BOARD_TITLE = BOARD_TITLE;
module.exports.LABEL_DEFS = LABEL_DEFS;
module.exports.STACK_DEFS = STACK_DEFS;
module.exports.DEFAULT_CARDS = DEFAULT_CARDS;
module.exports.PERSONA_VALUE_MAP = PERSONA_VALUE_MAP;
module.exports.SYSTEM_VALUE_MAP = SYSTEM_VALUE_MAP;
module.exports.MODELS_CARD_TITLES = MODELS_CARD_TITLES;
