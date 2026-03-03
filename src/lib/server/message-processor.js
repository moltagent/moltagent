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

/** Domain intents that can be handled locally with focused tool subsets. */
const DOMAIN_INTENTS = new Set(['deck', 'calendar', 'email', 'wiki', 'file', 'search']);

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

    // ClarificationManager is set by _wireMicroPipelineDomainTools() above

    /** @type {Map<string, Array>} - Silent observation buffer per room */
    this.roomContext = new Map();

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

    // Skip messages consumed by HITL guardrail confirmation polling
    const enforcer = this.agentLoop?.guardrailEnforcer;
    if (enforcer?.isPendingConfirmation() && enforcer.isConfirmationResponse(extracted.content)) {
      console.log(`[Message] Skipping HITL confirmation response from ${extracted.user}`);
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

      // Handle slash commands
      if (extracted.content.startsWith('/')) {
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
          if (response.response) {
            response = response.response;
          }
        }
        result = { intent: 'micro_pipeline', provider: 'local' };
      } else if (this.microPipeline && this.agentLoop && this._isSmartMixMode()) {
        // Smart-mix: three-path routing (local text / local tools / cloud)
        const { useLocal, useDomainTools, intent } = await this._smartMixClassify(pipelineMessage, session, extracted.token);
        console.log(`[Message] Smart-mix classification: ${intent} → ${useLocal ? (useDomainTools ? 'local-tools' : 'local') : 'cloud'}`);

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
        } else if (useLocal && useDomainTools) {
          // Path 2: Domain-specific — local tool-calling with focused subset
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
              if (response.response) {
                response = response.response;
              }
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
              if (response.response) {
                response = response.response;
              }
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
        } else {
          // Path 3: Question/task/complex — skip local, go straight to cloud via AgentLoop
          if (this.agentLoop.llmProvider?.skipLocalForConversation) {
            this.agentLoop.llmProvider.skipLocalForConversation();
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
          result = { intent: `smart_mix_cloud:${intent}`, provider: 'agent' };
          response = response || 'Sorry, I encountered an error processing your message.';
        }
      } else if (this.agentLoop) {
        // Session 14: AgentLoop handles all natural language via tool-calling LLM
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
        const { flushNeeded: assistantFlush } = this.sessionManager.addContext(session, 'assistant', response);
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
        responsePreview: response.substring(0, 100)
      });

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
      await this.statusIndicator?.setStatus('ready');

      return { error: errorResponse };
    }

    } catch (outerError) {
      console.error('[Process] Unhandled processing error:', outerError.message);
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
      .map(entry => ({ role: entry.role, content: entry.content || '' }));
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
  async _smartMixClassify(message, session, roomToken) {
    try {
      const recentContext = this._extractRecentContext(session);

      // Use IntentRouter if available, fall back to MicroPipeline regex
      let classification;
      if (this.intentRouter) {
        classification = await this.intentRouter.classify(message, recentContext, {
          replyFn: roomToken ? (text) => this.sendTalkReply(roomToken, text) : null
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

      let { intent, domain } = classification;

      // Action-ledger override: when the last action was file_* and the message
      // is an ambiguous reference (no explicit domain keywords), force file domain.
      // This prevents "read the most recent one" from routing to wiki after a file listing.
      if (session && this.sessionManager && domain !== 'file') {
        const lastAction = this.sessionManager.getLastAction(session, 'file_');
        if (lastAction && lastAction.type === 'file_list') {
          const lower = message.toLowerCase();
          const hasAmbiguousRef = /\b(the most recent|the latest|the newest|that one|the last one|read it|open it|all of them|the first)\b/.test(lower);
          const hasExplicitOtherDomain = /\b(wiki|calendar|event|meeting|deck|card|task|email|mail|schedule)\b/.test(lower);
          if (hasAmbiguousRef && !hasExplicitOtherDomain) {
            intent = 'domain';
            domain = 'file';
          }
        }
      }

      // Greeting/chitchat → always local regardless of word count.
      // If the LLM classified it as greeting/chitchat, trust that classification.
      // Substantive messages disguised as greetings are a classification accuracy
      // issue — the word-count gate was leaking most natural chitchat to cloud.
      if (intent === 'greeting' || intent === 'chitchat') {
        return { useLocal: true, useDomainTools: false, intent };
      }
      // Confirmation/selection → cloud (needs full history)
      if (intent === 'confirmation' || intent === 'selection') {
        return { useLocal: false, useDomainTools: false, intent };
      }
      // Domain → local with focused tools
      if (intent === 'domain' && domain && DOMAIN_INTENTS.has(domain)) {
        return { useLocal: true, useDomainTools: true, intent: domain };
      }
      // Complex / fallback → cloud
      return { useLocal: false, useDomainTools: false, intent: intent === 'domain' ? (domain || 'complex') : intent };
    } catch (err) {
      console.warn(`[Message] Smart-mix classification failed: ${err.message}`);
      return { useLocal: false, useDomainTools: false, intent: 'error' };
    }
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
    const recent = ctx.slice(-6); // Last 3 exchanges
    const continuation = recent
      .filter(c => c.role === 'user' || c.role === 'assistant')
      .map(c => {
        const text = (c.content || '').substring(0, 150);
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
