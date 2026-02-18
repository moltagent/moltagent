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

    // M1: WarmMemory for post-response consolidation
    /** @type {Object|null} - WarmMemory instance */
    this.warmMemory = deps.warmMemory || null;

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

    /** @type {Map<string, Array>} - Silent observation buffer per room */
    this.roomContext = new Map();

    /** @type {import('../errors/error-handler').ErrorHandler} */
    this.errorHandler = createErrorHandler({
      serviceName: 'MessageProcessor',
      auditLog: this.auditLog
    });
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

    // CRITICAL: Ignore bot's own messages to prevent self-reply loops
    if (extracted.isBotMessage) {
      console.log(`[Message] Ignoring own message from: ${extracted.user}`);
      return { skipped: true };
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
            extracted.content = result.transcript;
            extracted._transcript = result.transcript;
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
          const transcript = await this._transcribeVoiceMessage(extracted._voiceFile);
          if (!transcript || transcript.trim().length === 0) {
            extracted.content = 'I received your voice message but it appeared to be empty or inaudible. ' +
              'Could you try again or send a text message?';
          } else {
            extracted.content = transcript;
            extracted._transcript = transcript;
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
    if (this.sessionManager && extracted.token && extracted.user) {
      session = this.sessionManager.getSession(extracted.token, extracted.user);
      this.sessionManager.addContext(session, 'user', extracted.content);
    }

    // Set status to thinking before processing
    await this.statusIndicator?.setStatus('thinking');

    try {
      let response;
      let result;

      // Handle slash commands
      if (extracted.content.startsWith('/')) {
        result = await this.commandHandler.handle(extracted.content, {
          user: extracted.user,
          token: extracted.token,
          messageId: extracted.messageId
        });
        response = result.response;
      } else if (this.microPipeline && this._shouldUseMicroPipeline()) {
        // Local Intelligence: MicroPipeline handles local-only messages with focused calls
        response = await this.microPipeline.process(extracted.content, {
          userName: extracted.user,
          roomToken: extracted.token,
          warmMemory: ''
        });
        result = { intent: 'micro_pipeline', provider: 'local' };
      } else if (this.microPipeline && this.agentLoop && this._isSmartMixMode()) {
        // Smart-mix: classify with MicroPipeline, route greeting/chitchat locally, rest to cloud
        const { useLocal, intent } = await this._smartMixClassify(extracted.content);
        console.log(`[Message] Smart-mix classification: ${intent} → ${useLocal ? 'local' : 'cloud'}`);

        if (useLocal) {
          // Greeting/chitchat — MicroPipeline handles locally (fast, no cloud)
          if (this.agentLoop.llmProvider?.clearLocalSkip) {
            this.agentLoop.llmProvider.clearLocalSkip();
          }
          response = await this.microPipeline.process(extracted.content, {
            userName: extracted.user,
            roomToken: extracted.token,
            warmMemory: ''
          });
          result = { intent: `smart_mix_local:${intent}`, provider: 'local' };
        } else {
          // Question/task/complex — skip local, go straight to cloud via AgentLoop
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

          response = await this.agentLoop.process(extracted.content, extracted.token, agentOpts);
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

        response = await this.agentLoop.process(extracted.content, extracted.token, agentOpts);
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

        result = await this.messageRouter.route(extracted.content, {
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
      if (session && response) {
        this.sessionManager.addContext(session, 'assistant', response);
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
  }

  // ---------------------------------------------------------------------------
  // Private Methods
  // ---------------------------------------------------------------------------

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

    if (messageContent === '{object}' || messageContent === '[object Object]' || messageContent === '{file}') {
      if (this._isVoiceMessage(messageObj)) {
        isVoice = true;
        voiceFile = messageObj.messageParameters?.file;
        messageContent = '[Voice message]';
      } else {
        messageContent = "I can see you sent something, but it came through as a rich object " +
          "(like a poll, file, or location) that I can't read directly. " +
          "Could you share the content as a text message instead?";
      }
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
      _voiceFile: voiceFile
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
   * @returns {Promise<string>} Transcribed text
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
    const transcript = await this.whisperClient.transcribe(wavBuffer);

    console.log(`[Message] Transcribed voice: "${transcript.substring(0, 80)}..."`);
    return transcript;
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
   * Classify message intent via MicroPipeline for smart-mix routing.
   * Only greeting/chitchat are handled locally; everything else goes to cloud.
   * @param {string} message
   * @returns {Promise<{useLocal: boolean, intent: string}>}
   * @private
   */
  async _smartMixClassify(message) {
    try {
      const classification = await this.microPipeline._classify(message);
      const intent = classification.intent || 'unknown';
      const useLocal = (intent === 'greeting' || intent === 'chitchat');
      return { useLocal, intent };
    } catch (err) {
      console.warn(`[Message] Smart-mix classification failed: ${err.message}`);
      return { useLocal: false, intent: 'error' };
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
