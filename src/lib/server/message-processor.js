/**
 * Message Processor
 *
 * Architecture Brief:
 * -------------------
 * Problem: webhook-server.js processMessage() function handles message extraction,
 * bot message filtering, slash command detection, and routing - all in one place.
 *
 * Pattern: Single Responsibility - this module extracts and processes incoming
 * Activity Streams 2.0 messages from NC Talk webhooks.
 *
 * Key Dependencies:
 * - MessageRouter (for routing non-command messages)
 * - CommandHandler (for slash commands)
 *
 * Data Flow:
 * - Webhook handler passes raw Activity Streams data
 * - Processor extracts message content, user, token, messageId
 * - Filters out bot's own messages
 * - Delegates to CommandHandler or MessageRouter
 * - Returns response for Talk reply
 *
 * Integration Points:
 * - Called by WebhookHandler after signature verification
 * - Calls MessageRouter.route() for natural language
 * - Calls CommandHandler.handle() for slash commands
 * - Calls sendTalkReply callback to respond
 *
 * Session 37: Voice Pipeline + Call-Aware Routing
 * - Detects voice messages (messageType 'voice-message' or audio/* mimetype)
 * - Transcribes via WhisperClient (whisper.cpp STT)
 * - Call-aware: in multi-participant rooms, only responds when addressed
 * - Silent observation buffer for unaddressed messages
 *
 * @module server/message-processor
 * @version 1.1.0
 */

'use strict';

const { createErrorHandler } = require('../errors/error-handler');
const { MODES } = require('../integrations/cockpit-modes');
const ProvenanceAnnotator = require('../security/provenance-annotator');
const { getFeedbackMessage } = require('../talk/feedback-messages');
const IntentDecomposer = require('../agent/intent-decomposer');
const ollamaGate = require('../shared/ollama-gate');
const CONFIG = require('../config');

/** Domain intents that can be handled locally with focused tool subsets. */
const DOMAIN_INTENTS = new Set(['deck', 'calendar', 'email', 'wiki', 'file', 'search', 'knowledge', 'confirmation', 'confirmation_declined']);

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * @typedef {Object} ProcessorDependencies
 * @property {Object} messageRouter - MessageRouter instance
 * @property {Object} commandHandler - CommandHandler instance
 * @property {Function} sendTalkReply - Function to send Talk replies
 * @property {Function} auditLog - Audit logging function
 * @property {string} botUsername - Bot's NC username (to filter own messages)
 * @property {Function} [onTokenDiscovered] - Callback when new room token seen
 * @property {Object} [conversationContext] - ConversationContext instance
 * @property {Object} [agentLoop] - AgentLoop instance (Session 14: replaces messageRouter for natural language)
 * @property {Object} [sessionManager] - SessionManager instance (Session 29b: context tracking + persistence)
 * @property {Object} [filesClient] - NCFilesClient instance (Session 37: voice file download)
 * @property {Object} [whisperClient] - WhisperClient instance (Session 37: STT transcription)
 * @property {Object} [audioConverter] - AudioConverter instance (Session 37: audio format conversion)
 * @property {Object} [ncRequestManager] - NCRequestManager instance (Session 37: room participant lookup)
 * @property {string[]} [botNames] - Names the bot responds to (Session 37: address detection)
 */

/**
 * @typedef {Object} ExtractedMessage
 * @property {string} content - Message text content
 * @property {string} user - Sender username
 * @property {string} token - NC Talk room token
 * @property {string} messageId - Message ID (for replies)
 * @property {string} actorType - Actor type (users, bots, etc.)
 * @property {boolean} isBotMessage - True if message is from the bot itself
 * @property {Object} _rawMessage - Raw message object for mention/reply detection
 * @property {boolean} [_isVoice] - True if message is a voice message
 * @property {Object} [_voiceFile] - Voice file metadata from messageParameters
 * @property {string} [_transcript] - Transcribed text from voice message
 * @property {string|null} [_typedContent] - User-typed text alongside voice (null if voice-only)
 */

/**
 * @typedef {Object} ProcessResult
 * @property {string} response - The response text
 * @property {boolean} [skipped] - True if message was skipped (bot's own)
 * @property {string} [reason] - Reason for skipping (e.g. 'not_addressed')
 * @property {string} [error] - Error message if processing failed
 */

// -----------------------------------------------------------------------------
// Live Context Builder
// -----------------------------------------------------------------------------

/**
 * Build the live conversational context from the current session.
 * Called once per message, passed to every pipeline component.
 * This is SHORT-TERM memory — what happened in the last few exchanges.
 *
 * @param {Object} session - SessionManager session
 * @param {string} currentMessage - Current user message text
 * @returns {Object} Live context with exchanges, actions, entities, summary
 */
function buildLiveContext(session, currentMessage) {
  if (!session?.context || session.context.length === 0) {
    return {
      exchanges: [],
      lastAssistantAction: null,
      lastUserIntent: null,
      recentEntityRefs: [],
      turnCount: 0,
      summary: ''
    };
  }

  // Last 3 exchanges (6 entries: user/assistant pairs)
  const recent = session.context
    .filter(c => c.role === 'user' || c.role === 'assistant')
    .slice(-6);

  // Extract the last thing the agent did/said
  const lastAssistant = [...session.context]
    .reverse()
    .find(c => c.role === 'assistant');

  // Extract the last thing the user asked (NOT the current message)
  const allUserEntries = session.context.filter(c => c.role === 'user');
  const lastUser = allUserEntries.length > 1
    ? allUserEntries[allUserEntries.length - 2]
    : null;

  // Detect what the agent last offered/did
  let lastAssistantAction = null;
  if (lastAssistant?.content) {
    const content = lastAssistant.content;
    if (/card\s*#\d+|Created\s+"/i.test(content)) {
      const cardMatch = content.match(/#(\d+)/);
      lastAssistantAction = {
        type: 'card_created',
        cardId: cardMatch?.[1] || null,
        description: content.substring(0, 200)
      };
    }
    if (/Do you want me to|Should I|Would you like me to|I can |Want me to|I[''']ll .{1,30} if you|I[''']m ready to|Once you .{1,40} I[''']ll|Confirm and I/i.test(content)) {
      lastAssistantAction = lastAssistantAction || { type: 'offered_action' };
      lastAssistantAction.offer = content.substring(0, 200);
    }
    if (/don't have that|no information|not in my|can't access|don't have .{0,20} information/i.test(content)) {
      lastAssistantAction = lastAssistantAction || {};
      lastAssistantAction.admittedIgnorance = true;
    }
  }

  // Extract entity references from recent exchanges
  const recentText = recent.map(c => c.content || '').join(' ');
  const entityRefs = [];
  const cardRefs = recentText.match(/#\d+/g) || [];
  cardRefs.forEach(ref => entityRefs.push({ type: 'card', ref }));

  // Named entities (capitalized words not at sentence start)
  const nameMatches = recentText.match(/(?<=\s)[A-Z][a-z]+(?:\s[A-Z][a-z]+)*/g) || [];
  const commonWords = new Set(['The', 'This', 'That', 'What', 'Where', 'When', 'How',
    'Yes', 'No', 'Please', 'Here', 'There', 'Created', 'Found', 'Your', 'Missing',
    'Source', 'Status', 'Active', 'Done', 'Inbox', 'Working', 'None', 'Sorry',
    'Sure', 'Would', 'Could', 'Should', 'Based', 'However']);
  nameMatches
    .filter(n => !commonWords.has(n))
    .forEach(n => {
      if (!entityRefs.some(e => e.ref === n)) {
        entityRefs.push({ type: 'name', ref: n });
      }
    });

  // Build a compact summary for injection
  const exchangeLines = recent.map(c => {
    const role = c.role === 'user' ? 'User' : 'Agent';
    const text = (c.content || '').substring(0, 250);
    return `${role}: ${text}`;
  });

  return {
    exchanges: recent,
    lastAssistantAction,
    lastUserIntent: lastUser?.content?.substring(0, 200) || null,
    recentEntityRefs: entityRefs,
    turnCount: Math.floor(session.context.length / 2),
    summary: exchangeLines.join('\n')
  };
}

// -----------------------------------------------------------------------------
// Message Processor Class
// -----------------------------------------------------------------------------

/**
 * Processes incoming NC Talk webhook messages.
 *
 * Responsibilities:
 * - Extract message data from Activity Streams 2.0 format
 * - Filter out bot's own messages
 * - Detect and transcribe voice messages
 * - Call-aware routing in multi-participant rooms
 * - Route to command handler or message router
 * - Handle errors with safe user messages
 */
class MessageProcessor {
  /**
   * @param {ProcessorDependencies} deps
   */
  constructor(deps) {
    /** @type {Object} */
    this.messageRouter = deps.messageRouter;

    /** @type {Object} */
    this.commandHandler = deps.commandHandler;

    /** @type {Function} */
    this.sendTalkReply = deps.sendTalkReply;

    /** @type {Function} */
    this.auditLog = deps.auditLog || (async () => {});

    /** @type {string} */
    this.botUsername = (deps.botUsername || 'moltagent').toLowerCase();

    /** @type {Function|null} */
    this.onTokenDiscovered = deps.onTokenDiscovered || null;

    /** @type {Object|null} */
    this.conversationContext = deps.conversationContext || null;

    /** @type {Object|null} - AgentLoop (Session 14: tool-calling agent brain) */
    this.agentLoop = deps.agentLoop || null;

    /** @type {Object|null} - SessionManager (Session 29b: context tracking + flush) */
    this.sessionManager = deps.sessionManager || null;

    /** @type {Object|null} - NCStatusIndicator (sets Molti's NC user status) */
    this.statusIndicator = deps.statusIndicator || null;

    // Local Intelligence: MicroPipeline for local-only message processing
    /** @type {Object|null} - MicroPipeline instance */
    this.microPipeline = deps.microPipeline || null;

    /** @type {Object|null} - ClarificationManager (Layer 1: pending clarification bypass) */
    this.clarificationManager = deps.clarificationManager || null;

    // Wire domain tool-calling capabilities into MicroPipeline from AgentLoop
    if (this.microPipeline && this.agentLoop) {
      this._wireMicroPipelineDomainTools();
    }

    // IntentRouter: LLM-powered intent classification with conversation context
    /** @type {Object|null} - IntentRouter instance */
    this.intentRouter = deps.intentRouter || null;

    /** @type {Function} - Returns cockpit language code (EN, DE, PT, etc.) */
    this._getLanguage = deps.intentRouter?.getLanguage || (() => 'EN');

    // M1: WarmMemory for post-response consolidation
    /** @type {Object|null} - WarmMemory instance */
    this.warmMemory = deps.warmMemory || null;

    // Post-response proactive evaluation (knowledge gaps, implied tasks)
    /** @type {Object|null} - ProactiveEvaluator instance */
    this.proactiveEvaluator = deps.proactiveEvaluator || null;

    // Pre-routing reference resolution (resolves "that", "the biggest one", etc.)
    /** @type {Object|null} - ReferenceResolver instance */
    this.referenceResolver = deps.referenceResolver || null;

    // Budget override: BudgetEnforcer for "override budget" command
    /** @type {Object|null} - BudgetEnforcer instance */
    this.budgetEnforcer = deps.budgetEnforcer || null;
    /** @type {string} - Admin username for privileged commands (budget override) */
    this.adminUser = deps.adminUser || '';

    // Session V2: VoiceManager for mode-aware voice orchestration
    /** @type {Object|null} - VoiceManager instance */
    this.voiceManager = deps.voiceManager || null;

    // Session 37: Voice pipeline dependencies
    /** @type {Object|null} - NCFilesClient for downloading voice files */
    this.filesClient = deps.filesClient || null;

    /** @type {Object|null} - WhisperClient for STT transcription */
    this.whisperClient = deps.whisperClient || null;

    /** @type {Object|null} - AudioConverter for format conversion */
    this.audioConverter = deps.audioConverter || null;

    /** @type {Object|null} - NCRequestManager for room participant lookup */
    this.ncRequestManager = deps.ncRequestManager || null;

    /** @type {string[]} - Names the bot responds to */
    this.botNames = deps.botNames || ['moltagent'];

    /** @type {Object|null} - SelfRecovery (deferred action retry via Personal board) */
    this.selfRecovery = deps.selfRecovery || null;

    // ClarificationManager is set by _wireMicroPipelineDomainTools() above

    /** @type {Map<string, Array>} - Silent observation buffer per room */
    this.roomContext = new Map();

    // Layer 1 Bullshit Protection: Provenance tagging at generation time
    /** @type {ProvenanceAnnotator} */
    this._provenanceAnnotator = new ProvenanceAnnotator({ logger: console });

    /** @type {import('../errors/error-handler').ErrorHandler} */
    this.errorHandler = createErrorHandler({
      serviceName: 'MessageProcessor',
      auditLog: this.auditLog
    });

    /** @type {string|null} - Active Cockpit mode (propagated by HeartbeatManager) */
    this.activeMode = null;
  }

  /**
   * Set the active Cockpit mode.
   * Called by HeartbeatManager when mode changes are detected.
   *
   * @param {string} modeName - One of the MODES values from cockpit-modes.js
   */
  setMode(modeName) {
    this.activeMode = modeName;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Process an incoming webhook message
   *
   * @param {Object} data - Activity Streams 2.0 webhook payload
   * @returns {Promise<ProcessResult>}
   */
  async process(data) {
    // Extract message data from Activity Streams format
    const extracted = this._extractMessage(data);

    try {
    // CRITICAL: Ignore bot's own messages to prevent self-reply loops
    if (extracted.isBotMessage) {
      console.log(`[Message] Ignoring own message from: ${extracted.user}`);
      return { skipped: true };
    }

    // Signal Ollama gate: user message needs LLM — heartbeat should yield
    ollamaGate.markUserActive();

    // Immediate status indicator: "Processing..." within ~100ms of message arrival.
    // This is the peripheral sidebar signal — the user sees it before classification.
    // Fire-and-forget: never blocks the pipeline.
    this.statusIndicator?.setStatus('processing').catch(() => {});

    // Skip messages consumed by HITL guardrail confirmation polling
    const enforcer = this.agentLoop?.guardrailEnforcer;
    if (enforcer?.isPendingConfirmation() && enforcer.isConfirmationResponse(extracted.content)) {
      console.log(`[Message] Skipping HITL confirmation response from ${extracted.user}`);
      this.statusIndicator?.setStatus('ready').catch(() => {});
      return { skipped: true, reason: 'hitl_confirmation' };
    }

    // OOO auto-responder: reply with away notice, skip processing
    if (this.activeMode === MODES.OUT_OF_OFFICE && !extracted.isBotMessage) {
      const oooMessage = "I'm currently out of office. Your message has been noted and will be reviewed on my return.";
      try {
        await this.sendTalkReply(extracted.token, oooMessage, extracted.messageId);
        await this.auditLog('ooo_auto_reply', { user: extracted.user, token: extracted.token });
      } catch (err) {
        // Swallow — best effort
      }
      return { response: oooMessage, skipped: false, reason: 'ooo_auto_reply' };
    }

    // Session 37: Call-aware — check if we should respond in this room
    // Voice messages always get a response (user intentionally recorded for the bot)
    if (extracted.token && this.ncRequestManager && !extracted._isVoice) {
      const roomBehavior = await this._getRoomBehavior(extracted);
      if (roomBehavior === 'silent') {
        this._silentlyObserve(extracted.token, extracted);
        return { skipped: true, reason: 'not_addressed' };
      }
    }

    console.log(`[Message] From: ${extracted.user}, Token: ${extracted.token}, Content: ${extracted.content.substring(0, 50)}...`);

    // Call token discovered callback if new token seen
    if (extracted.token && this.onTokenDiscovered) {
      this.onTokenDiscovered(extracted.token);
    }

    await this.auditLog('chat_incoming', {
      user: extracted.user,
      token: extracted.token,
      messagePreview: extracted.content.substring(0, 100)
    });

    // Budget override detection: "override budget", "budget override", "unlock budget"
    // Only the admin user is authorized to activate budget overrides.
    if (this.budgetEnforcer && this._isBudgetOverride(extracted.content)) {
      if (!this.adminUser || extracted.user !== this.adminUser) {
        const deny = 'Budget override requires admin privileges.';
        try { await this.sendTalkReply(extracted.token, deny, extracted.messageId); } catch (_e) { /* best effort */ }
        await this.auditLog('budget_override_denied', { user: extracted.user, token: extracted.token });
        return { response: deny, skipped: false, reason: 'budget_override_denied' };
      }
      this.budgetEnforcer.activateOverride(3600000); // 1 hour
      const reply = 'Budget override activated for 1 hour. Cloud models are available. The override will expire automatically.';
      try {
        await this.sendTalkReply(extracted.token, reply, extracted.messageId);
      } catch (_e) { /* best effort */ }
      await this.auditLog('budget_override', { user: extracted.user, token: extracted.token });
      return { response: reply, skipped: false, reason: 'budget_override' };
    }

    // Session V2: Voice message — transcribe via VoiceManager (preferred) or WhisperClient (fallback)
    if (extracted._isVoice && extracted._voiceFile) {
      if (this.voiceManager) {
        if (this.voiceManager.mode === 'off') {
          // Voice processing intentionally disabled via Cockpit — skip silently
          return { skipped: true, reason: 'voice_disabled' };
        }
        try {
          const result = await this.voiceManager.processVoiceMessage(extracted._rawMessage);
          if (result && result.transcript) {
            extracted._transcript = result.transcript;
            extracted.content = this._tagVoiceTranscription(
              result.transcript, result.confidence, extracted._typedContent
            );
          } else {
            extracted.content = 'I received your voice message but it appeared to be empty or inaudible. ' +
              'Could you try again or send a text message?';
          }
        } catch (err) {
          console.error('[Message] Voice transcription failed:', err.message);
          extracted.content = 'I received your voice message but couldn\'t transcribe it. ' +
            'Could you try again or send a text message?';
        }
      } else if (this.whisperClient && this.filesClient) {
        // Fallback: Session 37 WhisperClient path
        try {
          const sttResult = await this._transcribeVoiceMessage(extracted._voiceFile);
          const transcript = typeof sttResult === 'string' ? sttResult : (sttResult.text || '');
          const confidence = (typeof sttResult === 'object' && sttResult) ? (sttResult.confidence ?? null) : null;
          if (!transcript || transcript.trim().length === 0) {
            extracted.content = 'I received your voice message but it appeared to be empty or inaudible. ' +
              'Could you try again or send a text message?';
          } else {
            extracted._transcript = transcript;
            extracted.content = this._tagVoiceTranscription(
              transcript, confidence, extracted._typedContent
            );
          }
        } catch (err) {
          console.error('[Message] Voice transcription failed:', err.message);
          extracted.content = 'I received your voice message but couldn\'t transcribe it. ' +
            'Could you try again or send a text message?';
        }
      }
    }

    // Session 29b: Track user message in SessionManager for context persistence
    let session = null;
    let flushPrompt = null;
    if (this.sessionManager && extracted.token && extracted.user) {
      session = this.sessionManager.getSession(extracted.token, extracted.user);
      const { flushNeeded } = this.sessionManager.addContext(session, 'user', extracted.content);
      // Also honour a pending flush set by the previous assistant reply
      // (the 80% threshold can be crossed by an assistant entry, not always a user entry)
      const shouldFlush = flushNeeded || session._pendingFlush;
      if (session._pendingFlush) {
        session._pendingFlush = false;     // consume the pending flag
        session._flushRequested = true;    // prevent SessionManager from double-firing this cycle
      }
      if (shouldFlush) {
        console.log(`[Memory] Context flush triggered for ${extracted.token}:${extracted.user} — prompting selective persist`);
        flushPrompt = [
          '[SYSTEM — Memory Flush]',
          'You are approaching context limits. Before this conversation is trimmed, identify the 5–10 most important facts from this session:',
          '- Key decisions made',
          '- Commitments or deadlines agreed',
          '- Names, roles, or relationships mentioned',
          '- Numbers: budgets, dates, quantities',
          '- Preferences or corrections the user expressed',
          '',
          'Write each fact to the appropriate wiki page using wiki_write (People/, Projects/, Procedures/, Research/).',
          'Be selective — this is memory, not a transcript. Only persist what would be valuable in a future conversation.',
          'After persisting, continue answering the user\'s current message normally.',
        ].join('\n');
      }
    }

    // ──── Layer 1: Pending Clarification Check ────
    if (this.clarificationManager && session) {
      const clarCheck = this.clarificationManager.check(session, extracted.content);
      if (clarCheck.bypass) {
        if (clarCheck.cancelled) {
          this.sendTalkReply(extracted.token, clarCheck.response, extracted.messageId).catch(err => {
            console.error('[Process] Failed to send Talk reply:', err.message);
          });
          this.sessionManager.addContext(session, 'user', extracted.content);
          this.sessionManager.addContext(session, 'assistant', clarCheck.response);
          return { response: clarCheck.response };
        }

        await this.statusIndicator?.setStatus('thinking');
        const clarResult = await this.clarificationManager.resolve(
          clarCheck.handler, clarCheck.clarification,
          { session, roomToken: extracted.token, userId: extracted.user }
        );
        this._captureActionRecord(session, clarResult.actionRecord);
        const clarResponse = clarResult.response || 'Done.';

        this.sendTalkReply(extracted.token, clarResponse, extracted.messageId).catch(err => {
          console.error('[Process] Failed to send Talk reply:', err.message);
        });
        this.sessionManager.addContext(session, 'user', extracted.content);
        this.sessionManager.addContext(session, 'assistant', clarResponse);
        await this.statusIndicator?.setStatus('ready');
        return { response: clarResponse };
      }
    }
    // ──── END Layer 1 ────

    // Set status to thinking before processing
    await this.statusIndicator?.setStatus('thinking');

    try {
      let response;
      let result;
      let _enrichmentBlock = null; // Layer 1: captured agent_knowledge for provenance tagging
      let _probeResults = null;    // Probe results for post-processing (link entities)

      // Pre-routing reference resolution
      // Enriches "read the biggest one" → "Read file X.md from Moltagent DEV/docs"
      // Original message stays in session context; enriched goes to pipeline
      let pipelineMessage = extracted.content;
      if (this.referenceResolver && !extracted.content.startsWith('/')) {
        try {
          const refContext = {
            recentTurns: session ? session.context.slice(-4) : [],
            lastAction: session && this.sessionManager
              ? this.sessionManager.getLastAction(session) : null,
            lastAssistantMessage: session
              ? session.context.filter(t => t.role === 'assistant').slice(-1)[0]?.content || null
              : null,
          };
          const resolved = await this.referenceResolver.resolve(extracted.content, refContext);
          if (resolved.wasEnriched && resolved.enrichedMessage) {
            pipelineMessage = resolved.enrichedMessage;
          }
        } catch (refErr) {
          console.warn(`[ReferenceResolver] Error, using original: ${refErr.message}`);
        }
      }

      // Card-link short-circuit: when the agent just created a card and user asks for the link,
      // construct and return it immediately. No classification, no probes needed.
      // GUARD: verify card creation via action ledger, not just response text pattern.
      // The LLM can hallucinate "card #N" in compound fallback responses — text matching alone
      // is not trustworthy. Cross-check against the action ledger which only records real API calls.
      const earlyLiveContext = session ? buildLiveContext(session, pipelineMessage) : null;
      if (earlyLiveContext?.lastAssistantAction?.type === 'card_created' &&
          earlyLiveContext.lastAssistantAction.cardId &&
          /\b(link|url|card|created|made|just)\b/i.test(pipelineMessage)) {
        const cardId = earlyLiveContext.lastAssistantAction.cardId;
        // Cross-check: action ledger must contain a deck card creation with this ID
        const ledgerConfirmed = (session.actionLedger || []).some(a =>
          a.type?.startsWith('deck_create') &&
          String(a.refs?.cardId) === String(cardId)
        );
        if (ledgerConfirmed) {
          const ncUrl = (this.ncRequestManager?.ncUrl || process.env.NC_URL || '').replace(/\/$/, '');
          if (ncUrl) {
            const cardUrl = `${ncUrl}/apps/deck/card/${cardId}`;
            response = `Here's the card: [#${cardId}](${cardUrl})`;
            result = { intent: 'card_link_shortcircuit', provider: 'context' };
          }
        } else {
          console.warn(`[Message] Card-link short-circuit blocked: card #${cardId} not confirmed in action ledger`);
        }
      }

      // Natural-language admin commands (before classification)
      else if (/^(persist\s+session|Sitzung\s+speichern|persistir\s+sess[aã]o)$/i.test(extracted.content.trim())) {
        if (this.commandHandler) {
          result = await this.commandHandler.handle('/persist', {
            user: extracted.user,
            token: extracted.token,
            messageId: extracted.messageId
          });
          response = result.response;
        } else {
          response = 'Session persistence not available.';
          result = { intent: 'admin_command' };
        }
      } else if (extracted.content.startsWith('/')) {
        // Handle slash commands
        result = await this.commandHandler.handle(extracted.content, {
          user: extracted.user,
          token: extracted.token,
          messageId: extracted.messageId
        });
        response = result.response;
      } else if (this.microPipeline && this._shouldUseMicroPipeline() && !flushPrompt) {
        // Local Intelligence: MicroPipeline handles local-only messages with focused calls
        // (skipped when flushPrompt is pending — wiki_write requires the full agent loop)
        response = await this.microPipeline.process(pipelineMessage, {
          userName: extracted.user,
          roomToken: extracted.token,
          warmMemory: '',
          // Layer 3: Action ledger accessors
          getLastAction: session ? (dp) => this.sessionManager.getLastAction(session, dp) : undefined,
          getRecentActions: session ? (dp) => this.sessionManager.getRecentActions(session, dp) : undefined,
          getRecentContext: session ? () => session.context.slice(-4) : undefined,
        });
        if (typeof response === 'object' && response !== null) {
          if (response.pendingClarification && session && this.sessionManager) {
            this.sessionManager.setPendingClarification(session, response.pendingClarification);
          }
          this._captureActionRecord(session, response.actionRecord);
          if (response.enrichmentBlock) _enrichmentBlock = response.enrichmentBlock;
          response = response.response || 'Done.';
        }
        result = { intent: 'micro_pipeline', provider: 'local' };
      } else if (this.microPipeline && this.agentLoop && this._isSmartMixMode()) {
        // Smart-mix: three-path routing (local text / local tools / cloud)
        // Build live context ONCE — passed to classifier, probes, synthesis, guard
        const liveContext = earlyLiveContext || (session ? buildLiveContext(session, pipelineMessage) : null);
        const { useLocal, useDomainTools, intent, compound } = await this._smartMixClassify(pipelineMessage, session, extracted.token, liveContext);
        console.log(`[Message] Smart-mix classification: ${intent} → ${useLocal ? (useDomainTools ? 'local-tools' : 'local') : 'cloud'}${compound ? ' [COMPOUND]' : ''}`);

        // Intent-specific feedback: acknowledge the user immediately (fire-and-forget)
        const lang = this._getLanguage();
        const feedbackMsg = compound ? getFeedbackMessage('compound', 'decomposing', lang) : getFeedbackMessage(intent, null, lang);
        if (feedbackMsg && extracted.token) {
          this.sendTalkReply(extracted.token, feedbackMsg).catch(() => {});
        }

        if (flushPrompt) {
          // Memory flush pending — escalate to agentLoop regardless of smart-mix classification
          // (wiki_write requires the full agent loop, MicroPipeline can't persist)
          console.log(`[Message] Smart-mix overridden by memory flush — escalating to cloud`);
          if (this.agentLoop.llmProvider?.skipLocalForConversation) {
            this.agentLoop.llmProvider.skipLocalForConversation();
          }
          response = await this.agentLoop.process(pipelineMessage, extracted.token, {
            messageId: extracted.messageId,
            inputType: extracted._isVoice ? 'voice' : 'text',
            user: extracted.user,
            systemSuffix: flushPrompt
          });
          result = { intent: `smart_mix_flush:${intent}`, provider: 'agent' };
          response = response || 'Sorry, I encountered an error processing your message.';
        } else if (compound && useLocal && useDomainTools) {
          // Path 2c: Compound intent — decompose into multi-step plan
          if (this.agentLoop?.llmProvider?.clearLocalSkip) {
            this.agentLoop.llmProvider.clearLocalSkip();
          }
          try {
            const compoundResult = await this._handleCompoundIntent(pipelineMessage, session, extracted.token);
            if (typeof compoundResult === 'object' && compoundResult !== null) {
              this._captureActionRecord(session, compoundResult.actionRecord);
              if (compoundResult.enrichmentBlock) _enrichmentBlock = compoundResult.enrichmentBlock;
              response = compoundResult.response || "I completed the steps but couldn't compose a summary.";
            } else {
              response = compoundResult || "I completed the steps but couldn't compose a summary.";
            }
            result = { intent: 'smart_mix_compound', provider: 'local' };
          } catch (compoundErr) {
            // Compound decomposition failed — fall back to knowledge-only mode.
            // CRITICAL: knowledge pipeline CANNOT perform actions (create cards, send emails, etc).
            // The response MUST NOT claim actions were performed — append an honest disclaimer.
            console.warn(`[Message] Compound decomposition failed, falling back to knowledge-only: ${compoundErr.message}`);
            const compoundFallbackPolicy = '\n\nCRITICAL CONSTRAINT: You are running in KNOWLEDGE-ONLY mode because the action pipeline failed. ' +
              'You CANNOT create cards, move cards, send emails, book appointments, or perform ANY action. ' +
              'If the user asked you to do something, answer the knowledge part of their question, then clearly state that you could not complete the requested action and they should ask again separately.';
            try {
              const knowledgeResult = await this._handleKnowledgeQuery(pipelineMessage, session, liveContext, extracted.token, compoundFallbackPolicy);
              if (typeof knowledgeResult === 'object' && knowledgeResult !== null) {
                this._captureActionRecord(session, knowledgeResult.actionRecord);
                if (knowledgeResult.enrichmentBlock) _enrichmentBlock = knowledgeResult.enrichmentBlock;
                if (knowledgeResult.probeResults) _probeResults = knowledgeResult.probeResults;
                response = knowledgeResult.response || "I don't have any information about that.";
              } else {
                response = knowledgeResult || "I don't have any information about that.";
              }
              // Always append honest disclaimer — the knowledge pipeline cannot perform actions.
              // Don't rely on regex to detect whether the LLM acknowledged the failure;
              // the LLM operates in multiple languages and phrasings are unpredictable.
              if (response) {
                response += '\n\n⚠️ I wasn\'t able to complete the action part of your request — I\'ve noted it and will complete it shortly.';
              }
              // Self-recovery: park the failed action on the Personal board
              // for the heartbeat to pick up. Fire-and-forget.
              if (this.selfRecovery) {
                this.selfRecovery.createRecoveryCard({
                  originalRequest: pipelineMessage.substring(0, 500),
                  completedPart: (response || '').substring(0, 2000),
                  failedAction: `Action from compound request: "${pipelineMessage.substring(0, 200)}"`,
                  reason: `Compound decomposition failed: ${compoundErr.message}`,
                  recoveryInstructions: `Complete the action part of this request. The user (${extracted.user}) asked: "${pipelineMessage.substring(0, 300)}". ` +
                    `The research/knowledge part was answered. Now execute the action (create card, send email, etc.) and assign the result to ${extracted.user}.`,
                  userId: extracted.user,
                  sessionId: extracted.token
                }).catch(() => {});
              }
              result = { intent: 'smart_mix_compound_fallback', provider: 'local' };
            } catch (fallbackErr) {
              console.warn(`[Message] Compound fallback also failed: ${fallbackErr.message}`);
              response = await this.agentLoop.process(pipelineMessage, extracted.token, {
                messageId: extracted.messageId,
                inputType: extracted._isVoice ? 'voice' : 'text',
                user: extracted.user
              });
              result = { intent: 'smart_mix_escalated:compound', provider: 'agent' };
              response = response || 'Sorry, I encountered an error processing your message.';
            }
          }
        } else if (useLocal && useDomainTools && intent === 'confirmation') {
          // Direct execution from Living Context — bypass AgentLoop entirely
          const offerText = liveContext?.lastAssistantAction?.offer || '';
          console.log(`[Message] Confirmation: executing from context — "${offerText.substring(0, 80)}"`);
          if (!offerText) {
            response = "I'm not sure what to execute — could you tell me what you'd like me to do?";
            result = { intent: 'smart_mix_confirmation_empty', provider: 'context' };
          } else try {
            const actionMessage = offerText;
            response = await this.microPipeline.process(actionMessage, {
              userName: extracted.user,
              roomToken: extracted.token,
              warmMemory: '',
              getLastAction: session ? (dp) => this.sessionManager.getLastAction(session, dp) : undefined,
              getRecentActions: session ? (dp) => this.sessionManager.getRecentActions(session, dp) : undefined,
              getRecentContext: session ? () => session.context.slice(-4) : undefined,
            });
            if (typeof response === 'object' && response !== null) {
              if (response.pendingClarification && session && this.sessionManager) {
                this.sessionManager.setPendingClarification(session, response.pendingClarification);
              }
              this._captureActionRecord(session, response.actionRecord);
              if (response.enrichmentBlock) _enrichmentBlock = response.enrichmentBlock;
              response = response.response || 'Done.';
            }
            result = { intent: 'smart_mix_confirmation', provider: 'local-tools' };
          } catch (confirmErr) {
            console.warn(`[Message] Confirmation execution failed, escalating: ${confirmErr.message}`);
            if (this.agentLoop?.llmProvider?.skipLocalForConversation) {
              this.agentLoop.llmProvider.skipLocalForConversation();
            }
            response = await this.agentLoop.process(pipelineMessage, extracted.token, {
              messageId: extracted.messageId,
              inputType: extracted._isVoice ? 'voice' : 'text',
              user: extracted.user
            });
            result = { intent: 'smart_mix_escalated:confirmation', provider: 'agent' };
            response = response || 'Sorry, I encountered an error processing your message.';
          }
        } else if (useLocal && useDomainTools && intent === 'knowledge') {
          // Path 2a: Knowledge query — synthesize from enricher + multi-source probes
          if (this.agentLoop?.llmProvider?.clearLocalSkip) {
            this.agentLoop.llmProvider.clearLocalSkip();
          }
          try {
            const knowledgeResult = await this._handleKnowledgeQuery(pipelineMessage, session, liveContext, extracted.token);
            if (typeof knowledgeResult === 'object' && knowledgeResult !== null) {
              this._captureActionRecord(session, knowledgeResult.actionRecord);
              if (knowledgeResult.enrichmentBlock) _enrichmentBlock = knowledgeResult.enrichmentBlock;
              if (knowledgeResult.probeResults) _probeResults = knowledgeResult.probeResults;
              response = knowledgeResult.response || "I don't have any information about that.";
            } else {
              response = knowledgeResult || "I don't have any information about that.";
            }
            result = { intent: 'smart_mix_knowledge', provider: 'local' };
          } catch (knowledgeErr) {
            console.warn(`[Message] Knowledge query failed, escalating to cloud: ${knowledgeErr.message}`);
            if (this.agentLoop?.llmProvider?.skipLocalForConversation) {
              this.agentLoop.llmProvider.skipLocalForConversation();
            }
            response = await this.agentLoop.process(pipelineMessage, extracted.token, {
              messageId: extracted.messageId,
              inputType: extracted._isVoice ? 'voice' : 'text',
              user: extracted.user
            });
            result = { intent: 'smart_mix_escalated:knowledge', provider: 'agent' };
            response = response || 'Sorry, I encountered an error processing your message.';
          }
        } else if (useLocal && useDomainTools) {
          // Path 2b: Domain-specific — local tool-calling with focused subset
          if (this.agentLoop.llmProvider?.clearLocalSkip) {
            this.agentLoop.llmProvider.clearLocalSkip();
          }
          try {
            response = await this.microPipeline.process(pipelineMessage, {
              userName: extracted.user,
              roomToken: extracted.token,
              warmMemory: '',
              intent,  // Skip re-classification inside MicroPipeline
              // Layer 3: Action ledger accessors
              getLastAction: session ? (dp) => this.sessionManager.getLastAction(session, dp) : undefined,
              getRecentActions: session ? (dp) => this.sessionManager.getRecentActions(session, dp) : undefined,
              getRecentContext: session ? () => session.context.slice(-4) : undefined,
            });
            if (typeof response === 'object' && response !== null) {
              if (response.pendingClarification && session && this.sessionManager) {
                this.sessionManager.setPendingClarification(session, response.pendingClarification);
              }
              this._captureActionRecord(session, response.actionRecord);
              if (response.enrichmentBlock) _enrichmentBlock = response.enrichmentBlock;
              response = response.response || 'Done.';
            }
            result = { intent: `smart_mix_domain:${intent}`, provider: 'local-tools' };
          } catch (domainErr) {
            // Domain escalation: local tool-calling failed → fall back to cloud
            console.warn(`[Message] Domain ${intent} escalated to cloud: ${domainErr.message}`);
            if (this.agentLoop.llmProvider?.skipLocalForConversation) {
              this.agentLoop.llmProvider.skipLocalForConversation();
            }
            response = await this.agentLoop.process(pipelineMessage, extracted.token, {
              messageId: extracted.messageId,
              inputType: extracted._isVoice ? 'voice' : 'text',
              user: extracted.user,
              systemSuffix: flushPrompt
            });
            result = { intent: `smart_mix_escalated:${intent}`, provider: 'agent' };
            response = response || 'Sorry, I encountered an error processing your message.';
          }
        } else if (useLocal) {
          // Path 1: Greeting/chitchat — MicroPipeline handles locally (fast, no cloud)
          if (this.agentLoop.llmProvider?.clearLocalSkip) {
            this.agentLoop.llmProvider.clearLocalSkip();
          }
          try {
            response = await this.microPipeline.process(pipelineMessage, {
              userName: extracted.user,
              roomToken: extracted.token,
              warmMemory: '',
              intent,  // Skip re-classification inside MicroPipeline
              // Layer 3: Action ledger accessors
              getLastAction: session ? (dp) => this.sessionManager.getLastAction(session, dp) : undefined,
              getRecentActions: session ? (dp) => this.sessionManager.getRecentActions(session, dp) : undefined,
              getRecentContext: session ? () => session.context.slice(-4) : undefined,
            });
            if (typeof response === 'object' && response !== null) {
              if (response.pendingClarification && session && this.sessionManager) {
                this.sessionManager.setPendingClarification(session, response.pendingClarification);
              }
              this._captureActionRecord(session, response.actionRecord);
              if (response.enrichmentBlock) _enrichmentBlock = response.enrichmentBlock;
              response = response.response || 'Done.';
            }
            result = { intent: `smart_mix_local:${intent}`, provider: 'local' };
          } catch (chatErr) {
            console.warn(`[Message] Chitchat escalated to cloud: ${chatErr.message}`);
            if (this.agentLoop.llmProvider?.skipLocalForConversation) {
              this.agentLoop.llmProvider.skipLocalForConversation();
            }
            response = await this.agentLoop.process(pipelineMessage, extracted.token, {
              messageId: extracted.messageId,
              inputType: extracted._isVoice ? 'voice' : 'text',
              user: extracted.user
            });
            result = { intent: `smart_mix_escalated:${intent}`, provider: 'agent' };
            response = response || 'Sorry, I encountered an error processing your message.';
          }
        } else if (intent === 'thinking') {
          // Path 4: Thinking — direct LLM call with rich context, no AgentLoop
          // One call: SOUL.md + enrichment + living context + question → Opus
          if (this.agentLoop?.llmProvider?.skipLocalForConversation) {
            this.agentLoop.llmProvider.skipLocalForConversation();
          }
          try {
            const thinkingResult = await this._handleThinkingQuery(pipelineMessage, session, liveContext);
            if (typeof thinkingResult === 'object' && thinkingResult !== null) {
              this._captureActionRecord(session, thinkingResult.actionRecord);
              if (thinkingResult.enrichmentBlock) _enrichmentBlock = thinkingResult.enrichmentBlock;
              response = thinkingResult.response;
            } else {
              response = thinkingResult || "I need a moment to think about that — could you ask again?";
            }
            result = { intent: 'smart_mix_thinking', provider: 'cloud' };
          } catch (thinkErr) {
            console.warn(`[Message] Thinking query failed, escalating to agentLoop: ${thinkErr.message}`);
            response = await this.agentLoop.process(pipelineMessage, extracted.token, {
              messageId: extracted.messageId,
              inputType: extracted._isVoice ? 'voice' : 'text',
              user: extracted.user
            });
            result = { intent: 'smart_mix_escalated:thinking', provider: 'agent' };
            response = response || 'Sorry, I encountered an error processing your message.';
          }
        } else {
          // Path 5: Question/task/complex — skip local, go straight to cloud via AgentLoop
          if (this.agentLoop.llmProvider?.skipLocalForConversation) {
            this.agentLoop.llmProvider.skipLocalForConversation();
          }

          // Pre-enrich: run MemoryContextEnricher so cloud path sees wiki + deck knowledge
          let cloudSuffix = flushPrompt || '';
          const enricher = this.microPipeline && this.microPipeline.memoryContextEnricher;
          if (enricher) {
            try {
              const enrichment = await enricher.enrich(pipelineMessage, intent);
              if (enrichment) {
                _enrichmentBlock = enrichment; // Layer 1: capture for provenance tagging
                cloudSuffix = cloudSuffix
                  ? cloudSuffix + '\n\n' + enrichment
                  : enrichment;
              }
            } catch (err) {
              console.warn(`[Message] Cloud path enrichment failed: ${err.message}`);
            }
          }

          const voiceReplyEnabled = extracted._isVoice && this.voiceManager && this.voiceManager.mode === 'full';
          const agentOpts = {
            messageId: extracted.messageId,
            inputType: extracted._isVoice ? 'voice' : 'text',
            voiceReplyEnabled,
            user: extracted.user
          };

          // Bug 3 fix: Short confirmations shouldn't loop to max iterations
          const trimmed = extracted.content.trim().toLowerCase();
          if (trimmed.length <= 12 && trimmed.split(/\s+/).length <= 3) {
            agentOpts.maxIterations = 2;
          }

          response = await this.agentLoop.process(pipelineMessage, extracted.token, {
            ...agentOpts,
            systemSuffix: cloudSuffix || undefined
          });
          result = { intent: `smart_mix_cloud:${intent}`, provider: 'agent' };
          response = response || 'Sorry, I encountered an error processing your message.';
        }
      } else if (this.agentLoop) {
        // Session 14: AgentLoop handles all natural language via tool-calling LLM
        // Generic feedback — no classification available in this path
        if (extracted.token) {
          const agentFeedback = getFeedbackMessage('complex', null, this._getLanguage());
          if (agentFeedback) this.sendTalkReply(extracted.token, agentFeedback).catch(() => {});
        }
        const voiceReplyEnabled = extracted._isVoice && this.voiceManager && this.voiceManager.mode === 'full';
        const agentOpts = {
          messageId: extracted.messageId,
          inputType: extracted._isVoice ? 'voice' : 'text',
          voiceReplyEnabled,
          user: extracted.user
        };

        // Bug 3 fix: Short confirmations shouldn't loop to max iterations
        const trimmed = extracted.content.trim().toLowerCase();
        if (trimmed.length <= 10 && /^(yes|no|ok|sure|yeah|nah|do it|go ahead|cancel|stop|yep|nope|y|n)$/.test(trimmed)) {
          agentOpts.maxIterations = 2;
        }

        response = await this.agentLoop.process(pipelineMessage, extracted.token, {
          ...agentOpts,
          systemSuffix: flushPrompt
        });
        result = { intent: 'agent_loop', provider: 'agent' };
        response = response || 'Sorry, I encountered an error processing your message.';
      } else {
        // Fallback: MessageRouter (pre-Session 14 regex-based routing)
        let history = [];
        if (this.conversationContext && extracted.token) {
          try {
            history = await this.conversationContext.getHistory(extracted.token, {
              excludeMessageId: extracted.messageId
            });
          } catch (err) {
            console.warn('[Message] Conversation context fetch failed:', err.message);
          }
        }

        result = await this.messageRouter.route(pipelineMessage, {
          user: extracted.user,
          token: extracted.token,
          messageId: extracted.messageId,
          history
        });
        response = result.response || 'Sorry, I encountered an error processing your message.';
      }

      // V3: Voice reply — synthesize + share audio in Talk when mode is 'full'
      // Done BEFORE transcript prefix so TTS gets the clean LLM response
      if (extracted._isVoice && this.voiceManager && this.voiceManager.mode === 'full' && response) {
        try {
          const voiceResult = await this.voiceManager.replyWithVoice(extracted.token, response);
          if (voiceResult.success) {
            console.log(`[Message] Voice reply sent: ${voiceResult.filename} (${voiceResult.size} bytes)`);
          } else {
            console.warn(`[Message] Voice reply skipped: ${voiceResult.reason}`);
          }
        } catch (err) {
          console.warn(`[Message] Voice reply failed: ${err.message}`);
        }
        // Text reply always sent regardless — voice is additive
      }

      // Session 37: Prepend transcript indicator for voice messages
      if (extracted._transcript && response) {
        const preview = extracted._transcript.length > 200
          ? extracted._transcript.substring(0, 200) + '...'
          : extracted._transcript;
        response = `\ud83c\udfa4 "${preview}"\n\n${response}`;
      }

      // Session 29b: Track assistant response in SessionManager
      // addContext() can return flushNeeded=true for the assistant entry when the 80%
      // threshold is crossed mid-turn (user message landed at threshold-1, assistant
      // reply lands at threshold).  Capture that signal and carry it forward as a
      // pending flag so the NEXT user-message turn injects the flush prompt.
      if (session && response) {
        // Layer 1 Bullshit Protection: Tag response with provenance before storing in context
        let provenance = null;
        let groundedRatio = null;
        try {
          const annotation = this._provenanceAnnotator.annotate(response, {
            agentKnowledge: _enrichmentBlock,
            userMessage: extracted.content,
            actionLedger: session.actionLedger || []
          });
          provenance = annotation.segments;
          groundedRatio = annotation.groundedRatio;
          console.log(`[Provenance] ${provenance.length} segments, groundedRatio=${groundedRatio.toFixed(2)}, enrichment=${_enrichmentBlock ? 'yes' : 'no'}`);
        } catch (err) {
          console.warn(`[Provenance] Annotation failed: ${err.message}`);
        }

        const { flushNeeded: assistantFlush } = this.sessionManager.addContext(
          session, 'assistant', response, { provenance, groundedRatio }
        );
        if (assistantFlush && !flushPrompt) {
          // Flush fired on the assistant side — store pending for next user turn
          session._pendingFlush = true;
          console.log(`[Memory] Context flush pending after assistant reply for ${extracted.token}:${extracted.user}`);
        }
      }

      await this.auditLog('chat_outgoing', {
        user: extracted.user,
        intent: result.intent,
        provider: result.provider,
        responsePreview: (typeof response === 'string' ? response : String(response)).substring(0, 100)
      });

      // Post-process ALL outbound responses — one gate, every path.
      // Strips leaked tags, links entity names from probe results.
      if (typeof response === 'string') {
        response = this._postProcessResponse(response, _probeResults || []);
      }

      // Send reply asynchronously (fire-and-forget) - don't block webhook response
      if (extracted.token) {
        this.sendTalkReply(extracted.token, response, extracted.messageId).catch(err => {
          console.error('[Process] Failed to send Talk reply:', err.message);
        });
      }

      // M1: Consolidate warm memory after substantive conversations
      this._maybeConsolidate(session).catch(err => {
        console.warn(`[WarmMemory] Post-response consolidation failed: ${err.message}`);
      });

      // Post-response proactive evaluation (fire-and-forget, non-blocking)
      if (this.proactiveEvaluator) {
        this.proactiveEvaluator.evaluate({
          userMessage: extracted.content,
          assistantResponse: response,
          classification: result?.intent || 'unknown',
          actionRecord: null,
          session,
          roomToken: extracted.token
        }).catch(err => {
          console.warn(`[Proactive] Background evaluation failed: ${err.message}`);
        });
      }

      // Set status back to ready after successful processing
      ollamaGate.markUserDone();
      await this.statusIndicator?.setStatus('ready');

      return { response };

    } catch (error) {
      console.error('[Process] Router error:', error.message);

      await this.auditLog('chat_error', {
        user: extracted.user,
        error: error.message
      });

      const { message } = await this.errorHandler.handle(error, {
        operation: 'process_message',
        user: extracted.user,
        metadata: { token: extracted.token }
      });
      const errorResponse = message;

      // Send error reply asynchronously (fire-and-forget) - don't block webhook response
      if (extracted.token) {
        this.sendTalkReply(extracted.token, errorResponse, extracted.messageId).catch(err => {
          console.error('[Process] Failed to send Talk error reply:', err.message);
        });
      }

      // Set status back to ready after error handling
      ollamaGate.markUserDone();
      await this.statusIndicator?.setStatus('ready');

      return { error: errorResponse };
    }

    } catch (outerError) {
      console.error('[Process] Unhandled processing error:', outerError.message);
      ollamaGate.markUserDone();
      await this.statusIndicator?.setStatus('ready');
      // Guarantee a response to the user even when pre-routing logic throws
      if (extracted.token) {
        const fallback = "I ran into an unexpected error processing your message. Could you try rephrasing?";
        this.sendTalkReply(extracted.token, fallback, extracted.messageId).catch(err => {
          console.error('[Process] Failed to send fallback error reply:', err.message);
        });
      }
      return { error: outerError.message };
    }
  }

  // ---------------------------------------------------------------------------
  // Private Methods
  // ---------------------------------------------------------------------------

  /**
   * Check if message is a budget override command.
   * @param {string} content
   * @returns {boolean}
   * @private
   */
  _isBudgetOverride(content) {
    if (!content) return false;
    const text = content.toLowerCase().trim();
    return /override\s+budget/i.test(text) ||
           /budget\s+override/i.test(text) ||
           /unlock\s+budget/i.test(text) ||
           /remove\s+budget\s+limit/i.test(text);
  }

  /**
   * Extract message data from Activity Streams 2.0 format
   *
   * @param {Object} data - Raw webhook payload
   * @returns {ExtractedMessage}
   * @private
   */
  _extractMessage(data) {
    // Extract message content from Activity Streams 2.0 format
    let messageContent = data.object?.content || data.object?.message?.message || '';

    // NC Talk sometimes sends content as JSON string - parse it
    let parsedParameters = null;
    if (typeof messageContent === 'string' && messageContent.startsWith('{')) {
      try {
        const parsed = JSON.parse(messageContent);
        messageContent = parsed.message || parsed.content || messageContent;
        // Preserve parameters from parsed JSON (file shares, voice messages)
        if (parsed.parameters) {
          parsedParameters = parsed.parameters;
        }
      } catch {
        // Not JSON, use as-is
      }
    }

    // Clean up NC Talk mention placeholders
    messageContent = this._cleanContent(messageContent);

    const user = data.actor?.id?.replace('users/', '') || data.actor?.name || 'unknown';
    const token = data.target?.id || data.object?.message?.token;
    const messageId = data.object?.id || data.object?.message?.id;
    const actorType = data.actor?.type || data.object?.message?.actorType || '';
    const messageObj = data.object?.message || data.object || {};

    // Merge parsed parameters into messageObj so voice detection can find file metadata
    if (parsedParameters && !messageObj.messageParameters) {
      messageObj.messageParameters = parsedParameters;
    }

    // Session 37: Voice message detection — check BEFORE generic rich-object error
    let isVoice = false;
    let voiceFile = null;
    let typedContent = null;   // user-typed text alongside voice (null = voice-only)

    if (messageContent === '{object}' || messageContent === '[object Object]' || messageContent === '{file}') {
      if (this._isVoiceMessage(messageObj)) {
        isVoice = true;
        voiceFile = messageObj.messageParameters?.file;
        messageContent = '[Voice message]';
        // No typed content — the placeholder means voice-only
      } else {
        messageContent = "I can see you sent something, but it came through as a rich object " +
          "(like a poll, file, or location) that I can't read directly. " +
          "Could you share the content as a text message instead?";
      }
    } else if (this._isVoiceMessage(messageObj)) {
      // User typed text alongside a voice recording — both present
      isVoice = true;
      voiceFile = messageObj.messageParameters?.file;
      typedContent = messageContent;  // preserve the user's typed text
    }

    return {
      content: messageContent,
      user,
      token,
      messageId,
      actorType,
      isBotMessage: this._isBotMessage(user, actorType),
      _rawMessage: messageObj,
      _isVoice: isVoice,
      _voiceFile: voiceFile,
      _typedContent: typedContent
    };
  }

  /**
   * Check if a message object represents a voice message.
   *
   * @param {Object} message - NC Talk message object
   * @returns {boolean}
   * @private
   */
  _isVoiceMessage(message) {
    if (message.messageType === 'voice-message') return true;
    if (message.messageParameters?.file) {
      const mime = message.messageParameters.file.mimetype || '';
      if (mime.startsWith('audio/')) return true;
    }
    return false;
  }

  /**
   * Transcribe a voice message file via Whisper STT.
   *
   * @param {Object} file - File metadata from messageParameters
   * @returns {Promise<{text: string, confidence: number|null}>} Transcription result
   * @private
   */
  async _transcribeVoiceMessage(file) {
    // 1. Download audio from NC Files
    const audioBuffer = await this.filesClient.readFileBuffer(file.path);

    // 2. Convert to WAV 16kHz mono
    let wavBuffer = audioBuffer;
    if (this.audioConverter) {
      wavBuffer = await this.audioConverter.toWav16kMono(audioBuffer);
    }

    // 3. Send to Whisper
    const result = await this.whisperClient.transcribe(wavBuffer);
    const text = typeof result === 'string' ? result : (result.text || '');
    const confidence = (typeof result === 'object' && result) ? (result.confidence ?? null) : null;

    console.log(`[Message] Transcribed voice: "${text.substring(0, 80)}..."`);
    return { text, confidence };
  }

  /**
   * Build a provenance-tagged string for a voice transcription.
   *
   * @param {string} transcript - Raw transcribed text
   * @param {number|null} confidence - Whisper confidence score (0–1), or null if unavailable
   * @param {string|null} typedContent - User-typed text alongside voice, or null if voice-only
   * @returns {string} Tagged message content for the agent's context
   * @private
   */
  _tagVoiceTranscription(transcript, confidence, typedContent) {
    let tag = '[Voice transcription';
    if (confidence != null) {
      tag += `, confidence: ${Math.round(confidence * 100)}%`;
    }
    tag += ']';

    // Replace inner double-quotes to prevent ambiguous tag boundaries
    const safeTranscript = transcript.replace(/"/g, "'");
    const tagged = `${tag}: "${safeTranscript}"`;

    if (typedContent) {
      return `${typedContent}\n${tagged}`;
    }
    return tagged;
  }

  // ---------------------------------------------------------------------------
  // Call-Aware Routing (Session 37)
  // ---------------------------------------------------------------------------

  /**
   * Determine how the bot should behave in this room.
   * In 1:1 rooms (<=2 participants), always respond.
   * In larger rooms, only respond when addressed by name/mention/reply.
   *
   * @param {ExtractedMessage} extracted - Extracted message data
   * @returns {Promise<string>} 'respond' or 'silent'
   * @private
   */
  async _getRoomBehavior(extracted) {
    try {
      const response = await this.ncRequestManager.request(
        '/ocs/v2.php/apps/spreed/api/v4/room/' + extracted.token,
        { method: 'GET', headers: { 'OCS-APIRequest': 'true', 'Accept': 'application/json' } }
      );
      const room = response.body?.ocs?.data;
      if (!room) return 'respond';

      const participantCount = room.participantCount || 0;

      // 1:1 or just the user and bot — respond to everything
      if (participantCount <= 2) return 'respond';

      // Larger room — only respond when addressed
      if (this._isAddressed(extracted)) return 'respond';

      return 'silent';
    } catch (err) {
      console.warn('[Message] Room lookup failed, defaulting to respond:', err.message);
      return 'respond';
    }
  }

  /**
   * Check if the message is addressed to the bot.
   * Checks: @mention, name at start, name anywhere, reply to bot.
   *
   * @param {ExtractedMessage} extracted - Extracted message data
   * @returns {boolean}
   * @private
   */
  _isAddressed(extracted) {
    const text = (extracted.content || '').toLowerCase();

    // 1. @mention in raw message data
    const messageObj = extracted._rawMessage || {};
    if (messageObj.mentions?.some(m =>
      m.id === this.botUsername || m.id === 'moltagent'
    )) return true;

    // 2. Name at start of message
    for (const name of this.botNames) {
      const lower = name.toLowerCase();
      if (text.startsWith(lower + ',') ||
          text.startsWith(lower + ' ') ||
          text.startsWith(lower + ':') ||
          text.startsWith(lower + '?') ||
          text.startsWith(lower + '!')) return true;
    }

    // 3. Name anywhere in message (only for names >= 3 chars to avoid false positives)
    for (const name of this.botNames) {
      if (name.length >= 3 && text.includes(name.toLowerCase())) return true;
    }

    // 4. Reply to bot's previous message
    if (messageObj.parent?.actorId === this.botUsername ||
        messageObj.parent?.actorId === 'moltagent') return true;

    return false;
  }

  /**
   * Buffer an unaddressed message for silent observation.
   * Caps at 200 messages per room to prevent unbounded growth.
   *
   * @param {string} token - Room token
   * @param {ExtractedMessage} extracted - Message data
   * @private
   */
  _silentlyObserve(token, extracted) {
    if (!this.roomContext.has(token)) {
      this.roomContext.set(token, []);
    }
    this.roomContext.get(token).push({
      author: extracted.user,
      text: extracted.content,
      timestamp: Date.now()
    });
    // Cap at 200 messages per room
    const ctx = this.roomContext.get(token);
    if (ctx.length > 200) ctx.splice(0, ctx.length - 200);
  }

  // ---------------------------------------------------------------------------
  // Local Intelligence: MicroPipeline Routing
  // ---------------------------------------------------------------------------

  /**
   * Wire domain tool-calling capabilities into MicroPipeline.
   * Extracts the OllamaToolsProvider from RouterChatBridge and passes
   * it along with the ToolRegistry so MicroPipeline can do focused
   * local tool-calling for domain-specific intents.
   * @private
   */
  _wireMicroPipelineDomainTools() {
    const toolRegistry = this.agentLoop.toolRegistry;
    if (toolRegistry && !this.microPipeline.toolRegistry) {
      this.microPipeline.toolRegistry = toolRegistry;
      console.log('[Message] Wired ToolRegistry into MicroPipeline for domain tool-calling');
    }

    // Extract local OllamaToolsProvider from the RouterChatBridge
    const bridge = this.agentLoop.llmProvider;
    if (bridge?.chatProviders && !this.microPipeline.ollamaToolsProvider) {
      for (const [id, provider] of bridge.chatProviders) {
        // OllamaToolsProvider has endpoint + model fields and a chat() method
        if (provider.endpoint && provider.model && typeof provider.chat === 'function') {
          this.microPipeline.ollamaToolsProvider = provider;
          console.log(`[Message] Wired OllamaToolsProvider (${id}: ${provider.model}) into MicroPipeline`);
          break;
        }
      }
    }

    // Wire guardrails into MicroPipeline
    if (this.agentLoop.guardrailEnforcer && !this.microPipeline.guardrailEnforcer) {
      this.microPipeline.guardrailEnforcer = this.agentLoop.guardrailEnforcer;
      console.log('[Message] Wired GuardrailEnforcer into MicroPipeline');
    }
    if (this.agentLoop.toolGuard && !this.microPipeline.toolGuard) {
      this.microPipeline.toolGuard = this.agentLoop.toolGuard;
      console.log('[Message] Wired ToolGuard into MicroPipeline');
    }

    // Wire domain executors (structured parameter extraction)
    const guardrailEnforcer = this.microPipeline.guardrailEnforcer;
    const toolGuardRef = this.microPipeline.toolGuard;
    const router = this.microPipeline.router;
    const tz = this.microPipeline.timezone;
    const aLog = this.microPipeline.activityLogger;

    if (router && !this.microPipeline.executors.calendar && this.microPipeline.calendarClient) {
      try {
        const CalendarExecutor = require('../agent/executors/calendar-executor');
        this.microPipeline.executors.calendar = new CalendarExecutor({
          router, calendarClient: this.microPipeline.calendarClient,
          guardrailEnforcer: guardrailEnforcer, toolGuard: toolGuardRef,
          activityLogger: aLog, timezone: tz, logger: console
        });
        console.log('[Message] Wired CalendarExecutor into MicroPipeline');
      } catch (err) {
        console.warn(`[Message] CalendarExecutor skipped: ${err.message}`);
      }
    }

    if (router && !this.microPipeline.executors.file && this.agentLoop.toolRegistry?.clients?.ncFilesClient) {
      try {
        const FileExecutor = require('../agent/executors/file-executor');
        this.microPipeline.executors.file = new FileExecutor({
          router, ncFilesClient: this.agentLoop.toolRegistry.clients.ncFilesClient,
          textExtractor: this.agentLoop.toolRegistry.clients.textExtractor || null,
          guardrailEnforcer: guardrailEnforcer, toolGuard: toolGuardRef,
          activityLogger: aLog, timezone: tz, logger: console
        });
        console.log('[Message] Wired FileExecutor into MicroPipeline');
      } catch (err) {
        console.warn(`[Message] FileExecutor skipped: ${err.message}`);
      }
    }

    if (router && !this.microPipeline.executors.wiki && toolRegistry) {
      try {
        const WikiExecutor = require('../agent/executors/wiki-executor');
        this.microPipeline.executors.wiki = new WikiExecutor({
          router, toolRegistry,
          guardrailEnforcer: guardrailEnforcer, toolGuard: toolGuardRef,
          activityLogger: aLog, timezone: tz, logger: console
        });
        console.log('[Message] Wired WikiExecutor into MicroPipeline');
      } catch (err) {
        console.warn(`[Message] WikiExecutor skipped: ${err.message}`);
      }
    }

    if (router && !this.microPipeline.executors.deck && toolRegistry) {
      try {
        const DeckExecutor = require('../agent/executors/deck-executor');
        this.microPipeline.executors.deck = new DeckExecutor({
          router, toolRegistry,
          deckClient: toolRegistry.clients?.deckClient || null,
          adminUser: process.env.KNOWLEDGE_ADMIN_USER || this.adminUser || null,
          guardrailEnforcer: guardrailEnforcer, toolGuard: toolGuardRef,
          activityLogger: aLog, timezone: tz, logger: console
        });
        console.log('[Message] Wired DeckExecutor into MicroPipeline');
      } catch (err) {
        console.warn(`[Message] DeckExecutor skipped: ${err.message}`);
      }
    }

    // Wire ClarificationManager — needs sessionManager + executor map
    if (this.sessionManager && !this.clarificationManager) {
      try {
        const ClarificationManager = require('../agent/clarification-manager');
        this.clarificationManager = new ClarificationManager({
          sessionManager: this.sessionManager,
          executors: this.microPipeline.executors,
          logger: console
        });
        console.log('[Message] Wired ClarificationManager (pending clarification bypass)');
      } catch (err) {
        console.warn(`[Message] ClarificationManager skipped: ${err.message}`);
      }
    }
  }

  /**
   * Determine if the MicroPipeline should handle this message.
   * True when the system is running in all-local mode (no cloud providers
   * active) — the MicroPipeline decomposes work into small calls that
   * local models can handle reliably.
   *
   * @returns {boolean}
   * @private
   */
  _shouldUseMicroPipeline() {
    // Check if the AgentLoop's ProviderChain has a local primary
    if (this.agentLoop?.llmProvider?.primaryIsLocal) return true;
    return false;
  }

  // ---------------------------------------------------------------------------
  // Smart-Mix Mode Detection + Classification
  // ---------------------------------------------------------------------------

  /**
   * Detect smart-mix mode: RouterChatBridge with both local and cloud providers.
   * @returns {boolean}
   * @private
   */
  _isSmartMixMode() {
    const provider = this.agentLoop?.llmProvider;
    if (!provider) return false;
    // Must be RouterChatBridge (has resetConversation) with >1 provider
    if (typeof provider.resetConversation !== 'function') return false;
    if (!provider.chatProviders || provider.chatProviders.size <= 1) return false;
    return true;
  }

  /**
   * Record action(s) from a structured executor response onto the session ledger.
   * Handles both single actionRecord objects and arrays.
   *
   * @param {Object} session - Session from SessionManager
   * @param {Object|Array} actionRecord - Single record or array of records
   * @private
   */
  _captureActionRecord(session, actionRecord) {
    if (!actionRecord || !session || !this.sessionManager) return;
    if (Array.isArray(actionRecord)) {
      for (const record of actionRecord) {
        this.sessionManager.recordAction(session, record);
      }
    } else {
      this.sessionManager.recordAction(session, actionRecord);
    }
  }

  /**
   * Extract recent conversation context for the classifier.
   * Returns the last N exchanges from the session, formatted for the IntentRouter.
   *
   * @param {Object} session - Session from SessionManager
   * @param {number} [maxExchanges=3] - Number of exchange pairs to include
   * @returns {Array<{role: string, content: string}>}
   * @private
   */
  _extractRecentContext(session, maxExchanges = 3) {
    if (!session || !session.context || session.context.length === 0) {
      return [];
    }
    const maxEntries = maxExchanges * 2;
    return session.context
      .filter(entry => entry.role === 'user' || entry.role === 'assistant')
      .slice(-maxEntries)
      .map(entry => ({ role: entry.role, content: typeof entry.content === 'string' ? entry.content : String(entry.content || '') }));
  }

  /**
   * Classify message intent for smart-mix routing.
   *
   * Uses IntentRouter (LLM with conversation context) when available,
   * falls back to MicroPipeline regex classification.
   *
   * Three-path routing:
   * - greeting/chitchat → local (no tools, text-only)
   * - domain-specific (deck/calendar/email/wiki/file/search) → local (focused tool subset)
   * - confirmation/selection/complex → cloud (full AgentLoop)
   *
   * @param {string} message
   * @param {Object} [session] - SessionManager session for conversation context
   * @returns {Promise<{useLocal: boolean, useDomainTools: boolean, intent: string}>}
   * @private
   */
  async _smartMixClassify(message, session, roomToken, liveContext) {
    try {
      const recentContext = this._extractRecentContext(session);

      // Use IntentRouter if available, fall back to MicroPipeline regex
      let classification;
      if (this.intentRouter) {
        classification = await this.intentRouter.classify(message, recentContext, {
          replyFn: roomToken ? (text) => this.sendTalkReply(roomToken, text) : null,
          liveContext
        });
      } else {
        // Build context for _classifyFallback so it has conversation history
        const fallbackCtx = {};
        if (recentContext.length > 0) {
          fallbackCtx.getRecentContext = () => recentContext;
        }
        if (session && this.sessionManager) {
          fallbackCtx.getLastAction = (dp) => this.sessionManager.getLastAction(session, dp);
        }
        const fallback = await this.microPipeline._classifyFallback(message, fallbackCtx);
        // Map fallback domain intents to IntentRouter format
        if (DOMAIN_INTENTS.has(fallback.intent)) {
          classification = { intent: 'domain', domain: fallback.intent, needsHistory: false };
        } else {
          classification = { intent: fallback.intent, domain: null, needsHistory: false };
        }
      }

      let { intent, domain, compound } = classification;

      // Greeting/chitchat → always local regardless of word count.
      // The LLM classifier handles all languages natively — trust its classification.
      if (intent === 'greeting' || intent === 'chitchat') {
        return { useLocal: true, useDomainTools: false, intent, compound: false };
      }
      // Confirmation/selection → cloud (needs full history)
      if (intent === 'confirmation' || intent === 'selection') {
        return { useLocal: false, useDomainTools: false, intent, compound: false };
      }
      if (intent === 'confirmation_declined') {
        return { useLocal: true, useDomainTools: false, intent: 'confirmation_declined', compound: false };
      }
      // Domain → local with focused tools
      if (DOMAIN_INTENTS.has(intent)) {
        return { useLocal: true, useDomainTools: true, intent, compound: !!compound };
      }
      // Complex / fallback → cloud
      return { useLocal: false, useDomainTools: false, intent: intent || 'complex', compound: !!compound };
    } catch (err) {
      console.warn(`[Message] Smart-mix classification failed: ${err.message}`);
      return { useLocal: false, useDomainTools: false, intent: 'error', compound: false };
    }
  }

  // ---------------------------------------------------------------------------
  // Knowledge Mode: Cross-domain information synthesis
  // ---------------------------------------------------------------------------

  /**
   * Handle a knowledge query through multi-source probes + LLM synthesis.
   *
   * Instead of routing to a single domain executor:
   * 1. Extract search terms from the query
   * 2. Probe wiki, deck, vector store, graph, sessions in parallel
   * 3. Aggregate results with provenance tags
   * 4. One LLM synthesis call reads all gathered data
   *
   * @param {string} message - User message
   * @param {Object} [session] - SessionManager session
   * @returns {Promise<{response: string, actionRecord: Object, enrichmentBlock?: string}>}
   * @private
   */
  async _handleKnowledgeQuery(message, session, liveContext, roomToken, extraPolicy = '') {
    const enricher = this.microPipeline?.memoryContextEnricher;
    const searcher = this.microPipeline?.memorySearcher;
    const router = this.microPipeline?.router;

    if (!router) {
      throw new Error('No LLM router available for knowledge synthesis');
    }

    // Step 1: Extract search terms via LLM (language-agnostic keyword extraction)
    let searchTerms = await this._extractSearchTermsLLM(message, router);

    // Pronoun resolution: when message contains references like "it", "that", "more about",
    // resolve from previous message context. Uses LLM extraction on the previous message.
    if (searchTerms.length === 0 && liveContext?.lastUserIntent &&
      /\b(that|it|this|those|the one|more about|about it|about that|about this|davon|darüber|dazu|isso|disso|aquilo)\b/i.test(message)
    ) {
      const contextTerms = await this._extractSearchTermsLLM(liveContext.lastUserIntent, router);
      searchTerms = [...new Set([...searchTerms, ...contextTerms])];
    }

    const query = message;

    console.log(`[Message] Knowledge query: "${message.substring(0, 80)}" → terms: [${searchTerms.join(', ')}]`);

    // Step 2: Parallel multi-source probes
    const probeResults = await this._executeKnowledgeProbes(searchTerms, query, enricher, searcher);

    // Step 2b: Web fallback — gated by Cockpit Search Policy card.
    // research: auto-fallback (default). internal-first: offer only. sovereign: never.
    const cockpitConfig = this.agentLoop?.cockpitManager?.cachedConfig;
    const searchPolicy = cockpitConfig?.system?.searchPolicy || 'research';

    const lowerTerms = searchTerms.map(t => t.toLowerCase());
    const substantiveResults = probeResults.reduce((sum, p) => {
      const relevant = (p.results || []).filter(r => {
        const text = ((r.title || '') + ' ' + (r.snippet || '')).toLowerCase();
        return lowerTerms.some(t => text.includes(t));
      });
      return sum + relevant.length;
    }, 0);

    const contextSuggestsWeb = liveContext?.lastAssistantAction?.admittedIgnorance === true;
    let webSearchOffered = false;

    if (substantiveResults < 2 || (contextSuggestsWeb && substantiveResults < 4)) {
      if (searchPolicy === 'research') {
        // Auto web fallback — current behavior
        if (roomToken) {
          this.sendTalkReply(roomToken, '\u{1F310} Also checking the web...').catch(() => {});
        }
        const webResults = await this._probeWeb(query);
        if (webResults.length > 0) {
          probeResults.push({
            source: 'web',
            results: webResults,
            provenance: 'web_search'
          });
          console.log(`[Message] Knowledge insufficient (${substantiveResults} results) — web fallback added ${webResults.length} result(s)`);
        }
      } else if (searchPolicy === 'internal-first') {
        webSearchOffered = true;
        console.log(`[Message] Knowledge insufficient (${substantiveResults} results) — search policy: internal-first, web search available but not auto-fired`);
      } else {
        // sovereign — no web search
        console.log(`[Message] Knowledge insufficient (${substantiveResults} results) — search policy: sovereign, no web search`);
      }
    }

    // Tag provenance on all results
    for (const probe of probeResults) {
      const prov = probe.provenance === 'web_search' ? 'web' : 'internal';
      for (const r of (probe.results || [])) {
        if (!r.provenance) r.provenance = prov;
      }
    }

    // Step 3: Aggregate with provenance
    const aggregated = this._aggregateProbeResults(probeResults);
    const sourcesConsulted = probeResults.map(p => p.source);
    const sourcesWithResults = probeResults.filter(p => p.results.length > 0).map(p => p.source);

    console.log(`[Message] Knowledge probes: ${sourcesConsulted.length} sources consulted, ${sourcesWithResults.length} returned results (${sourcesWithResults.join(', ')})`);

    // Step 4: Synthesis — one LLM call with policy-aware context
    let policyContext = '';
    if (webSearchOffered) {
      policyContext = '\n\nNote: Internal knowledge was limited. Offer to search the web for more information if the user would find that helpful.';
    } else if (searchPolicy === 'sovereign' && substantiveResults < 2) {
      policyContext = '\n\nNote: Search policy is sovereign — no web search. If internal knowledge is insufficient, state what you know and what gaps exist honestly. Do not offer to search the web.';
    }
    const response = await this._synthesizeKnowledge(query, aggregated, session, router, liveContext, policyContext + extraPolicy);

    return {
      response,
      probeResults,
      enrichmentBlock: aggregated || undefined,
      actionRecord: {
        type: 'knowledge_query',
        refs: { query: message.substring(0, 200), sourcesConsulted, sourcesWithResults }
      }
    };
  }

  /**
   * Handle a thinking/reflection intent via a direct LLM call with rich context.
   * Does NOT go through AgentLoop — one call with SOUL.md + enrichment + living context.
   * Same pattern as _handleKnowledgeQuery but for opinion/reflection rather than fact retrieval.
   * @private
   */
  async _handleThinkingQuery(message, session, liveContext) {
    const router = this.microPipeline?.router;
    if (!router) {
      throw new Error('No LLM router available for thinking synthesis');
    }

    // Gather rich context — same enrichment as cloud path
    const enricher = this.microPipeline?.memoryContextEnricher;
    let enrichment = '';
    if (enricher) {
      try {
        enrichment = await enricher.enrich(message, 'thinking') || '';
      } catch (err) {
        console.warn(`[Message] Thinking enrichment failed: ${err.message}`);
      }
    }

    // SOUL.md for identity-aware reflection
    let soulContext = '';
    if (this.agentLoop?.soul) {
      soulContext = this.agentLoop.soul;
    }

    // Living context for conversational continuity
    let conversationBlock = '';
    if (liveContext?.summary) {
      conversationBlock = `\nRECENT CONVERSATION:\n${liveContext.summary}\n\n` +
        `The user's current message may reference things from this conversation. ` +
        `Resolve "that", "it", "the one", etc. from context.\n`;
    }

    // Warm memory
    let warmMemoryBlock = '';
    if (session?.warmMemory) {
      warmMemoryBlock = `\nRecent context:\n${session.warmMemory}\n`;
    }

    const now = new Date();
    const tz = this.agentLoop?.timezone || 'UTC';
    const dateStr = new Intl.DateTimeFormat('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: tz
    }).format(now);
    const timeStr = new Intl.DateTimeFormat('en-US', {
      hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz
    }).format(now);

    const prompt = `${soulContext}

Current date/time: ${dateStr}, ${timeStr} (${tz})
${conversationBlock}
${enrichment ? `\nWORKSPACE KNOWLEDGE:\n${enrichment}\n` : ''}
${warmMemoryBlock}

You are being asked to THINK — reflect, analyse, give your opinion, or reason deeply.
This is not a factual lookup. This is not an action request.
The user wants your genuine perspective, shaped by your identity and knowledge.
Be thoughtful. Be honest. Be yourself.`;

    const result = await router.route({
      job: 'thinking',
      task: 'thinking',
      content: prompt + '\n\nQuestion: ' + message.substring(0, 500),
      requirements: { maxTokens: 2000, temperature: 0.7 }
    });

    return {
      response: result?.result || result?.content || "I need a moment to think about that — could you ask again?",
      actionRecord: {
        type: 'thinking_query',
        refs: { query: message.substring(0, 200) }
      }
    };
  }

  /**
   * Execute parallel probes across knowledge sources.
   * Each probe is lightweight — API call or cache read, no LLM.
   * @private
   */
  async _executeKnowledgeProbes(searchTerms, query, enricher, searcher) {
    const probes = [];
    const searchQuery = searchTerms.join(' ');
    const wiki = searcher?.wiki;
    const ncSearch = searcher?.nc;

    // -----------------------------------------------------------------------
    // Probe 0: Unified wiki search — routes through MemorySearcher for
    // three-channel fusion (keyword + vector + graph), access tracking (LTP),
    // co-access expansion, archive fallback, and gap detection.
    // Replaces three separate NC Unified Search probes with one call that
    // activates 2,500 lines of search intelligence.
    // -----------------------------------------------------------------------
    if (searcher?.search) {
      probes.push(
        searcher.search(searchQuery, { maxResults: 10 })
          .then(async (results) => {
            const items = (results || []).filter(r => r.source === 'Wiki').map(r => ({
              title: r.title || '',
              snippet: r.excerpt || '',
              sourceTag: 'wiki',
              url: r.link || '',
              archived: r.archived || false,
            }));
            // Deep-read top results to replace search snippets with full page content
            await this._deepReadWikiResults(items, searcher, 5);
            return { source: 'wiki_unified', results: items, provenance: 'stored_knowledge' };
          })
          .catch(() => ({ source: 'wiki_unified', results: [], provenance: 'stored_knowledge' }))
      );
    }

    // -----------------------------------------------------------------------
    // Probe 1: Direct wiki page lookup — exact entity name matching.
    // Catches pages that NC Unified Search misses due to ranking or indexing.
    // Complements the unified search with reliable direct title lookups.
    // -----------------------------------------------------------------------
    if (wiki && wiki.findPageByTitle && wiki.readPageContent) {
      const entityNames = this._extractEntityNames(query);
      if (entityNames.length > 0) {
        probes.push(
          this._directWikiLookup(entityNames, wiki)
            .then(results => ({
              source: 'wiki_direct',
              results,
              provenance: 'stored_knowledge'
            }))
            .catch(() => ({ source: 'wiki_direct', results: [], provenance: 'stored_knowledge' }))
        );
      }
    }

    // -----------------------------------------------------------------------
    // Probe 2: Deck (cached board state — keyword match on cards)
    // -----------------------------------------------------------------------
    if (enricher?._searchDeck) {
      probes.push(
        enricher._searchDeck(searchTerms)
          .then(results => ({
            source: 'deck',
            results: (results || []).map(r => ({
              title: r.title || '',
              snippet: r.stack ? `[${r.stack}] ${r.title}` : r.title,
              sourceTag: 'deck',
              url: r.cardId ? `${CONFIG.nextcloud.url}/apps/deck/card/${r.cardId}` : ''
            })),
            provenance: 'task_state'
          }))
          .catch(() => ({ source: 'deck', results: [], provenance: 'task_state' }))
      );
    }

    // -----------------------------------------------------------------------
    // Probe 4: NC Unified Search — "files" provider.
    // Catches wiki pages via their underlying file representation (Carlos.md).
    // Clean titles, reliable. Deep-read top 2 for content.
    // -----------------------------------------------------------------------
    if (ncSearch) {
      probes.push(
        ncSearch.searchProvider('files', searchQuery, 3)
          .then(async (results) => {
            // Only keep Collectives files (wiki pages), skip random files
            const wikiFiles = (results || []).filter(r =>
              (r.subline || '').toLowerCase().includes('collectives')
            );
            const items = wikiFiles.map(r => ({
              title: (r.title || '').replace(/\.md$/, ''),
              snippet: r.subline || '',
              sourceTag: 'wiki',
              url: r.resourceUrl || ''
            }));
            await this._deepReadWikiResults(items, searcher, 2);
            return { source: 'files', results: items, provenance: 'stored_knowledge' };
          })
          .catch(() => ({ source: 'files', results: [], provenance: 'stored_knowledge' }))
      );
    }

    const settled = await Promise.allSettled(probes);

    return settled
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value);
  }

  /**
   * Web search fallback — queries SearXNG when knowledge probes are insufficient.
   * Uses the raw user query. No transformation needed.
   * @param {string} query - User's original question
   * @returns {Promise<Array>} Results in probe-compatible format
   * @private
   */
  async _probeWeb(query) {
    try {
      const searxng = this.agentLoop?.toolRegistry?.clients?.searxngClient;
      if (!searxng) return [];

      const searchResult = await searxng.search(query, { limit: 3 });
      if (!searchResult?.results?.length) return [];

      const results = searchResult.results.map(r => ({
        title: r.title || '',
        snippet: r.content || '',
        sourceTag: 'web',
        url: r.url || ''
      }));

      // Enrich top results with actual page content via WebReader
      const webReader = this.agentLoop?.toolRegistry?.clients?.webReader;
      if (webReader) {
        const urls = results
          .map(r => r.url)
          .filter(u => u && u.startsWith('http'));

        const pageReads = await Promise.allSettled(
          urls.slice(0, 3).map(u => webReader.read(u))
        );

        let enriched = 0;
        for (const pr of pageReads) {
          if (pr.status !== 'fulfilled' || !pr.value) continue;
          const page = pr.value;
          const match = results.find(r => r.url === page.url);
          if (match && page.content && page.content.length > (match.snippet || '').length) {
            match.content = page.content.substring(0, 5000);
            match.hasFullContent = true;
            enriched++;
          }
        }
        if (enriched > 0) {
          console.log(`[Message] WebReader enriched ${enriched}/${urls.length} search results with page content`);
        }
      }

      return results;
    } catch (err) {
      console.log(`[Message] Web fallback failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Deep-read wiki page content for top N search results.
   * Replaces shallow search snippets with actual page content (truncated to 800 chars).
   * @param {Array} items - Probe result items (mutated in place)
   * @param {Object} searcher - MemorySearcher with .wiki (CollectivesClient)
   * @param {number} [maxReads=3] - Max pages to read
   * @private
   */
  async _deepReadWikiResults(items, searcher, maxReads = 3) {
    const wiki = searcher?.wiki;
    if (!wiki || !wiki.readPageContent) return;

    const toRead = items.filter(r => (r.title || r.url) && r.sourceTag !== 'graph').slice(0, maxReads);

    // Deduplicate by resolved page title to avoid reading the same page twice
    const seenPages = new Set();

    const reads = toRead.map(async (item) => {
      try {
        // Search result titles from NC Unified Search are often content snippets,
        // not actual page titles. Extract a cleaner title from the URL slug if available.
        const candidates = this._extractPageTitleCandidates(item);

        let found = null;
        let resolvedTitle = null;
        for (const candidate of candidates) {
          found = await wiki.findPageByTitle(candidate);
          if (found) {
            resolvedTitle = candidate;
            break;
          }
        }

        if (!found) return;

        // Skip if we already read this page (dedup across items)
        const pageKey = found.path || resolvedTitle;
        if (seenPages.has(pageKey)) return;
        seenPages.add(pageKey);

        const content = await wiki.readPageContent(found.path);
        if (content && content.trim().length >= 50) {
          item.snippet = content.substring(0, 800);
          item.title = found.page?.title || resolvedTitle;
        } else {
          // Empty or stub page — check if it's a section parent with children
          const children = await this._listSectionChildren(wiki, found.page?.title || resolvedTitle);
          if (children.length > 0) {
            // Replace stub with children summaries
            item.title = found.page?.title || resolvedTitle;
            item.snippet = children.map(c => `**${c.title}**: ${c.snippet}`).join('\n\n');
            // Inject remaining children as extra items so synthesis sees them
            for (let ci = 1; ci < children.length && ci < 5; ci++) {
              items.push({
                title: children[ci].title,
                snippet: children[ci].snippet,
                sourceTag: 'wiki',
                url: children[ci].url || ''
              });
            }
          } else if (content) {
            item.snippet = content.substring(0, 800);
            item.title = found.page?.title || resolvedTitle;
          }
        }
        if (found.page?.id && wiki.buildPageUrl) {
          item.url = wiki.buildPageUrl(found.page?.title || resolvedTitle, found.page.id);
        }
      } catch {
        // Keep the search snippet on read failure
      }
    });

    await Promise.allSettled(reads);
  }

  /**
   * List children of a wiki section parent page.
   * Uses listPages + filePath filtering to find subpages.
   * Reads top 5 children by title and returns their content snippets.
   * @param {Object} wiki - CollectivesClient instance
   * @param {string} parentTitle - Title of the section parent (e.g. "People")
   * @returns {Promise<Array<{title: string, snippet: string, url: string}>>}
   * @private
   */
  async _listSectionChildren(wiki, parentTitle) {
    try {
      if (!wiki.listPages || !wiki.resolveCollective) return [];

      const collectiveId = await wiki.resolveCollective();
      const allPages = await wiki.listPages(collectiveId);
      if (!Array.isArray(allPages)) return [];

      // Find children: pages whose filePath ends with the parent title
      const parentLower = (parentTitle || '').toLowerCase();
      const children = allPages.filter(p => {
        const fp = (p.filePath || '').toLowerCase();
        return fp.endsWith('/' + parentLower) || fp.endsWith('/' + parentLower + '/');
      });

      if (children.length === 0) return [];

      // Read top 5 children
      const results = [];
      for (const child of children.slice(0, 5)) {
        try {
          const path = wiki._buildPagePath ? wiki._buildPagePath(child) : `${child.title}.md`;
          const content = await wiki.readPageContent(path);
          results.push({
            title: child.title || '',
            snippet: (content || '').substring(0, 500),
            url: (child.id && wiki.buildPageUrl) ? wiki.buildPageUrl(child.title, child.id) : ''
          });
        } catch {
          // Skip unreadable children
        }
      }

      return results;
    } catch (err) {
      console.log(`[Message] Section children lookup failed for "${parentTitle}": ${err.message}`);
      return [];
    }
  }

  /**
   * Extract page title candidates from a search result item.
   * NC Unified Search "titles" are often content snippets. This extracts
   * cleaner candidates from:
   * 1. URL slug (e.g. /Carlos-27016 → "Carlos")
   * 2. Markdown header in title (e.g. "# Carlos\n..." → "Carlos")
   * 3. Raw title as fallback
   * @private
   */
  _extractPageTitleCandidates(item) {
    const candidates = [];

    // 1. URL slug: /apps/collectives/.../PageName-12345 → "PageName"
    if (item.url) {
      const urlMatch = item.url.match(/\/([^/]+)-\d+\s*$/);
      if (urlMatch) {
        // URL-decode and replace hyphens with spaces
        const slug = decodeURIComponent(urlMatch[1]).replace(/-/g, ' ');
        candidates.push(slug);
      }
    }

    // 2. Markdown header: "# Carlos\n..." → "Carlos"
    if (item.title) {
      const headerMatch = item.title.match(/^#\s+(.+)$/m);
      if (headerMatch) {
        candidates.push(headerMatch[1].trim());
      }
    }

    // 3. Raw title (cleaned): take first line, strip markdown
    if (item.title) {
      const firstLine = item.title.split('\n').find(l => l.trim());
      if (firstLine) {
        const cleaned = firstLine.replace(/^#+\s*/, '').replace(/[*_`]/g, '').trim();
        if (cleaned.length >= 2 && cleaned.length <= 100) {
          candidates.push(cleaned);
        }
      }
    }

    // Deduplicate while preserving order
    return [...new Set(candidates)];
  }

  /**
   * Aggregate probe results into a structured knowledge block with provenance.
   * @private
   */
  _aggregateProbeResults(probeResults) {
    const withResults = probeResults.filter(p => p.results && p.results.length > 0);
    if (withResults.length === 0) return '';

    // Deduplicate across probes: same page title from different providers
    // should only appear once. Keep the version with the longest snippet.
    const seenTitles = new Map(); // normalized title → { result, provenance }

    let block = '';
    for (const probe of withResults) {
      const uniqueResults = [];
      for (const result of probe.results) {
        const key = (result.title || '').toLowerCase().replace(/[^\w]/g, '');
        if (!key) { uniqueResults.push(result); continue; }

        const existing = seenTitles.get(key);
        if (existing) {
          // Keep whichever has the longer snippet (more content)
          if ((result.snippet || '').length > (existing.result.snippet || '').length) {
            existing.result.snippet = result.snippet;
            if (result.url) existing.result.url = result.url;
          }
          continue; // Skip duplicate
        }
        seenTitles.set(key, { result, provenance: probe.provenance });
        uniqueResults.push(result);
      }

      if (uniqueResults.length > 0) {
        for (const result of uniqueResults) {
          const sourceLabel = probe.provenance === 'web_search' ? ' [Source: web]' : '';
          const text = result.content || result.snippet || '';
          block += `\n${result.title || ''}${sourceLabel}:\n${text}\n`;
        }
      }
    }
    return block;
  }

  /**
   * Synthesize an answer from pre-gathered, source-tagged knowledge.
   * One LLM call — the model's job is ONLY synthesis.
   * @private
   */
  async _synthesizeKnowledge(query, aggregatedKnowledge, session, router, liveContext, policyContext = '') {
    if (!aggregatedKnowledge) {
      return "I don't have any information about that in my knowledge base.";
    }

    const warmMemory = session?.warmMemory || '';

    let conversationBlock = '';
    if (liveContext?.summary) {
      conversationBlock = `\nRECENT CONVERSATION:\n${liveContext.summary}\n\n` +
        `The user's current message may reference things from this conversation. ` +
        `Resolve "that", "it", "the one", etc. from context.\n`;
    }

    const now = new Date();
    const timeStr = `${now.toLocaleDateString('en-US', { weekday: 'long' })}, ${now.toISOString().split('T')[0]} ${now.toTimeString().split(' ')[0]} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`;

    const prompt = `You are a KNOWLEDGE SYNTHESIZER. You can ONLY answer questions — you CANNOT perform actions.
DO NOT claim you created a card, sent an email, booked a meeting, moved anything, or performed ANY action.
If the user asked you to DO something, say what you FOUND, then say: "I couldn't complete that action — please ask me separately."

Current date/time: ${timeStr}
${conversationBlock}
Here is what was found across your data sources:
${aggregatedKnowledge}
${warmMemory ? `\nRecent context:\n${warmMemory}\n` : ''}

RULES:
- Answer ONLY from the data above.
- If multiple sources mention the same entity, combine their information.
- State what you found. Name what's missing. Never fabricate.
- No hedging ("might", "could", "possibly"). Either you found it or you didn't.
- Be concise. Lead with the most relevant facts.
- Use the entity names exactly as they appear in the data.
- Items marked [Source: web] are from web search. Treat as external — useful but unverified.
- For internal information, say "from our files" or "according to internal documents". For web information, say "from web search" or "according to online sources". Weave attribution naturally — no ugly brackets.
- Always present internal knowledge first, web enrichment second.${policyContext}`;

    const result = await router.route({
      job: 'synthesis',
      task: 'knowledge_synthesis',
      content: prompt + '\n\nQuestion: ' + query.substring(0, 300),
      requirements: { maxTokens: 1000, temperature: 0.3 }
    });

    return result?.result || result?.content || "I couldn't synthesize an answer from the available information.";
  }

  /**
   * Post-process synthesis response: strip leaked tags and link entity names.
   * Works regardless of model capability — all formatting done in code.
   * @private
   */
  _postProcessResponse(response, probeResults) {
    let processed = response;

    // Strip any leaked [Source: ...] or [url: ...] tags
    processed = processed.replace(/\[Source:\s*[^\]]+\]/g, '').trim();
    processed = processed.replace(/\[url:\s*[^\]]+\]/g, '').trim();

    // Deduplicate by normalized title: each entity name is linked at most once.
    // Without this, a second probe with the same title would match the entity
    // name inside the URL slug from the first pass's markdown link, creating
    // nested broken links like [Carlos](…/[Carlos](…)-456).
    const linkedTitles = new Map(); // normalized title → { title, url }
    for (const probe of probeResults) {
      for (const result of probe.results || []) {
        if (result.url && result.title) {
          const key = result.title.toLowerCase();
          if (!linkedTitles.has(key)) {
            const fullUrl = result.url.startsWith('http')
              ? result.url
              : CONFIG.nextcloud.url + result.url;
            linkedTitles.set(key, { title: result.title, url: fullUrl });
          }
        }
      }
    }

    // Link each unique entity name once
    for (const { title, url } of linkedTitles.values()) {
      const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Skip if response already contains a markdown link for this entity
      if (processed.includes(`](`) && new RegExp(`\\[${escaped}\\]\\(`).test(processed)) continue;
      const titleRegex = new RegExp(`(?<!\\[)${escaped}(?!\\]|\\()`, 'i');
      processed = processed.replace(titleRegex, `[${title}](${url})`);
    }

    return processed;
  }

  /**
   * Extract likely entity names (capitalized words) from a query.
   * Returns unique names that might correspond to wiki pages.
   * @private
   */
  _extractEntityNames(query) {
    // Match capitalized words (2+ chars), skip sentence-initial words
    const words = query.replace(/[^\w\s'-]/g, ' ').split(/\s+/);
    const entities = new Set();
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (w.length < 2) continue;
      // Capitalized and not sentence-initial (not after . or at position 0 after newline)
      if (/^[A-Z][a-z]/.test(w)) {
        // Skip common non-entity words
        if (/^(Who|What|Where|When|How|Why|The|This|That|Please|Can|Could|Would|Should|Does|Did|Has|Have|Was|Were|Are|Is|Do|Tell|Check|Find|Show|Get|Give|Let|Look|Make|May|Might|Must|Need|Not|Some|Also|Just|Still|Very)$/.test(w)) continue;
        entities.add(w);
      }
    }
    return [...entities];
  }

  /**
   * Direct wiki page lookup: try findPageByTitle for each entity name.
   * Returns full page content (800 chars) with clickable URLs.
   * Bypasses search ranking — if a page named "Carlos" exists, we find it directly.
   * @private
   */
  async _directWikiLookup(entityNames, wiki) {
    const results = [];
    const reads = entityNames.slice(0, 3).map(async (name) => {
      try {
        const found = await wiki.findPageByTitle(name);
        if (!found) return;

        const content = await wiki.readPageContent(found.path);
        if (!content) return;

        const url = (found.page?.id && wiki.buildPageUrl)
          ? wiki.buildPageUrl(found.page.title || name, found.page.id)
          : '';

        results.push({
          title: found.page?.title || name,
          snippet: content.substring(0, 800),
          sourceTag: 'wiki',
          url
        });
      } catch {
        // Skip on error
      }
    });
    await Promise.allSettled(reads);
    return results;
  }

  /**
   * Extract 1-4 search keywords from a message using the fast LLM model.
   * Language-agnostic — no stop word lists, no hardcoded patterns.
   * Falls back to enricher entity extraction if LLM is unavailable.
   *
   * @param {string} message - User message
   * @param {Object} router - LLM router instance
   * @returns {Promise<string[]>} 1-4 keyword/noun phrases
   * @private
   */
  async _extractSearchTermsLLM(message, router) {
    if (!router) {
      // No router — fall back to enricher's capitalized-word extraction
      const enricher = this.microPipeline?.memoryContextEnricher;
      return enricher?._extractSearchTerms?.(message) || [];
    }

    try {
      const result = await router.route({
        job: 'classification',
        task: 'extract_search_terms',
        content: `Extract 1-4 search keywords from this message. Return ONLY nouns and noun phrases. No question words. No filler verbs. No full sentences. Keep compound concepts together (e.g. "document ingestion" not "document" + "ingestion"). Keep proper nouns intact. Return as JSON array.

Message: "${message.substring(0, 200)}"

JSON array:`,
        requirements: { maxTokens: 100, temperature: 0.0 }
      });

      const raw = result?.result || result?.content || '';
      const match = raw.match(/\[.*?\]/s);
      if (match) {
        const parsed = JSON.parse(match[0]);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed
            .filter(t => typeof t === 'string' && t.length >= 2)
            .map(t => t.trim())
            .slice(0, 4);
        }
      }
    } catch (err) {
      console.warn(`[Message] LLM search term extraction failed: ${err.message}`);
    }

    // Fallback: enricher's capitalized-word extraction
    const enricher = this.microPipeline?.memoryContextEnricher;
    return enricher?._extractSearchTerms?.(message) || [];
  }

  // ---------------------------------------------------------------------------
  // Compound Intents: Multi-step plan decomposition + execution
  // ---------------------------------------------------------------------------

  /**
   * Handle a compound intent by decomposing into steps and executing the plan.
   *
   * @param {string} message - User message
   * @param {Object} [session] - SessionManager session
   * @param {string} [roomToken] - Talk room token for feedback messages
   * @returns {Promise<{response: string, actionRecord: Object, enrichmentBlock?: string}>}
   * @private
   */
  async _handleCompoundIntent(message, session, roomToken) {
    const router = this.microPipeline?.router;
    if (!router) {
      throw new Error('No LLM router available for compound decomposition');
    }

    const decomposer = new IntentDecomposer({ llmRouter: router, logger: console });

    // Step 1: Decompose
    console.log(`[Message] Compound decomposition: "${message.substring(0, 80)}"`);
    const plan = await decomposer.decompose(message);

    if (!plan) {
      throw new Error('Decomposition returned no plan');
    }

    console.log(`[Message] Compound plan: ${plan.steps.length} steps — ${plan.steps.map(s => `${s.type}:${s.source}`).join(', ')}`);

    // Step 2: Build probe executor from existing knowledge probe infrastructure
    const probeExecutor = this._buildProbeExecutor();

    // Step 3: Execute plan
    const replyFn = roomToken ? (text) => this.sendTalkReply(roomToken, text) : null;
    const response = await decomposer.executePlan(plan, {
      probeExecutor,
      actionExecutor: this.microPipeline,
      session,
      replyFn,
      userContext: {
        userName: session?.userId || 'system',
        roomToken: roomToken || '',
        warmMemory: session?.warmMemory || '',
        getRecentContext: session ? () => session.context.slice(-4) : undefined
      }
    });

    return {
      response,
      enrichmentBlock: undefined,
      actionRecord: {
        type: 'compound_intent',
        refs: {
          query: message.substring(0, 200),
          stepCount: plan.steps.length,
          steps: plan.steps.map(s => ({ id: s.id, type: s.type, source: s.source }))
        }
      }
    };
  }

  /**
   * Build a probe executor object that wraps existing knowledge probe methods.
   * Reuses the same infrastructure as _executeKnowledgeProbes.
   * @private
   */
  _buildProbeExecutor() {
    const enricher = this.microPipeline?.memoryContextEnricher;
    const searcher = this.microPipeline?.memorySearcher;
    const self = this;

    return {
      probeWiki: async (terms) => {
        if (!searcher?.search) return [];
        try {
          const query = terms.join(' ');
          const results = await searcher.search(query, { maxResults: 8 });
          const items = (results || []).filter(r => r.source === 'Wiki').map(r => ({
            title: r.title || '',
            snippet: r.excerpt || '',
            sourceTag: 'wiki',
            url: r.link || '',
          }));
          await self._deepReadWikiResults(items, searcher, 3);
          return items;
        } catch { return []; }
      },

      probeDeck: async (terms) => {
        if (!enricher?._searchDeck) return [];
        try {
          const results = await enricher._searchDeck(terms);
          return (results || []).map(r => ({
            title: r.title || '',
            snippet: r.stack ? `[${r.stack}] ${r.title}` : r.title,
            sourceTag: 'deck',
            url: r.cardId ? `/apps/deck/card/${r.cardId}` : ''
          }));
        } catch { return []; }
      },

      probeCalendar: async (query) => {
        const calExec = this.microPipeline?.executors?.calendar;
        if (!calExec) return [];
        try {
          const result = await calExec.queryEvents({ query_type: 'upcoming' }, {});
          if (typeof result === 'string') {
            return [{ title: 'Upcoming events', snippet: result }];
          }
          return [];
        } catch { return []; }
      },

      probeGraph: async (terms) => {
        if (!searcher?.graphSearch) return [];
        try {
          const results = await searcher.graphSearch(terms.join(' '), 3);
          return (results || []).map(r => ({
            title: r.entity || r.title || '',
            snippet: r.summary || r.content || '',
            sourceTag: 'graph'
          }));
        } catch { return []; }
      },

      probeSessions: async (terms) => {
        if (!searcher?.nc) return [];
        try {
          const results = await searcher.nc.searchProvider('collectives-page-content', terms.join(' '), 3);
          const sessionResults = (results || []).filter(r =>
            (r.subline || r.title || '').toLowerCase().includes('session')
          );
          const items = sessionResults.map(r => ({
            title: r.title || '',
            snippet: r.subline || '',
            sourceTag: 'conversation_history',
            url: r.resourceUrl || ''
          }));
          await self._deepReadWikiResults(items, searcher, 2);
          return items;
        } catch { return []; }
      }
    };
  }

  // ---------------------------------------------------------------------------
  // M1: Warm Memory Consolidation
  // ---------------------------------------------------------------------------

  /**
   * Consolidate warm memory after a substantive conversation.
   * Fires after 3+ exchanges, debounced to at most once per 5 minutes.
   * Non-blocking — errors are logged but don't affect the user response.
   *
   * @param {Object|null} session - SessionManager session object
   * @returns {Promise<void>}
   * @private
   */
  async _maybeConsolidate(session) {
    if (!this.warmMemory || !session) return;

    const ctx = session.context || [];
    const userMessages = ctx.filter(c => c.role === 'user');
    const assistantMessages = ctx.filter(c => c.role === 'assistant');

    // Only consolidate after 3+ exchanges (not on every "hi")
    if (userMessages.length < 3 || assistantMessages.length < 3) return;

    // Debounce: at most once per 5 minutes to avoid excessive WebDAV writes
    const now = Date.now();
    if (this._lastConsolidateTime && now - this._lastConsolidateTime < 300000) return;
    this._lastConsolidateTime = now;

    // Build a continuation summary from recent context
    // TRUST FILTER: Only write user messages and tool results to WARM.md.
    // Assistant output is where hallucinations live — excluded until
    // the full Bullshit Protection Layer ships.
    const recent = ctx.slice(-6); // Last 3 exchanges
    const continuation = recent
      .filter(c => c.role === 'user' || c.role === 'tool')
      .map(c => {
        const text = (typeof c.content === 'string' ? c.content : String(c.content || '')).substring(0, 150);
        return `${c.role}: ${text}`;
      })
      .join(' | ');

    await this.warmMemory.consolidate({
      continuation: continuation,
      timestamp: new Date().toISOString()
    });
    console.log('[WarmMemory] Consolidated after substantive conversation');
  }

  // ---------------------------------------------------------------------------
  // Existing Private Methods
  // ---------------------------------------------------------------------------

  /**
   * Check if message is from the bot itself
   *
   * @param {string} user - Sender username
   * @param {string} actorType - Actor type
   * @returns {boolean}
   * @private
   */
  _isBotMessage(user, actorType) {
    return user.toLowerCase() === this.botUsername ||
           user.toLowerCase() === 'moltagent' ||
           actorType === 'bots';
  }

  /**
   * Clean message content by removing mention placeholders
   *
   * @param {string} content - Raw message content
   * @returns {string} Cleaned content
   * @private
   */
  _cleanContent(content) {
    return content.replace(/\{mention-[^}]+\}/g, '').trim();
  }
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = MessageProcessor;
