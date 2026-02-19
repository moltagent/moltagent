/**
 * Server Module - Barrel Export
 *
 * Architecture Brief:
 * -------------------
 * Problem: webhook-server.js is a monolithic file handling HTTP routing,
 * message processing, command handling, health checks, and more.
 *
 * Pattern: Module decomposition with factory functions. Each handler has
 * a single responsibility. This index exports all handlers and provides
 * a factory for creating configured server components.
 *
 * Key Dependencies:
 * - ./message-processor.js
 * - ./command-handler.js
 * - ./webhook-handler.js
 * - ./health-handler.js
 *
 * Data Flow:
 * - webhook-server.js imports createServerComponents()
 * - Factory creates all handlers with shared dependencies
 * - HTTP server delegates to appropriate handler
 *
 * @module server
 * @version 1.0.0
 */

'use strict';

const MessageProcessor = require('./message-processor');
const CommandHandler = require('./command-handler');
const WebhookHandler = require('./webhook-handler');
const HealthHandler = require('./health-handler');

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * @typedef {Object} ServerComponents
 * @property {MessageProcessor} messageProcessor - Processes incoming messages
 * @property {CommandHandler} commandHandler - Handles slash commands
 * @property {WebhookHandler} webhookHandler - Handles webhook endpoint
 * @property {HealthHandler} healthHandler - Handles health/stats endpoints
 */

/**
 * @typedef {Object} ServerDependencies
 * @property {Object} signatureVerifier - TalkSignatureVerifier instance
 * @property {Object} messageRouter - MessageRouter instance
 * @property {Object} [llmRouter] - LLMRouter instance
 * @property {Object} [ncRequestManager] - NCRequestManager instance
 * @property {Function} sendTalkReply - Function to send Talk replies
 * @property {Function} auditLog - Audit logging function
 * @property {string} botUsername - Bot's NC username
 * @property {string[]} allowedBackends - Allowed webhook backend URLs
 * @property {Function} [onTokenDiscovered] - Callback for new room tokens
 * @property {Object} [conversationContext] - ConversationContext instance
 * @property {Object} [agentLoop] - AgentLoop instance (Session 14)
 * @property {Object} [sessionManager] - SessionManager instance (Session 29b)
 * @property {Object} [statusIndicator] - NCStatusIndicator instance
 * @property {Object} [botEnroller] - BotEnroller instance for instant enrollment
 * @property {Object} [filesClient] - NCFilesClient instance (Session 37: voice file download)
 * @property {Object} [whisperClient] - WhisperClient instance (Session 37: STT transcription)
 * @property {Object} [audioConverter] - AudioConverter instance (Session 37: audio format conversion)
 * @property {string[]} [botNames] - Names the bot responds to (Session 37: address detection)
 */

// -----------------------------------------------------------------------------
// Factory Function
// -----------------------------------------------------------------------------

/**
 * Create all server components with shared dependencies
 *
 * @param {ServerDependencies} deps
 * @returns {ServerComponents}
 */
function createServerComponents(deps) {
  const {
    signatureVerifier,
    messageRouter,
    llmRouter,
    ncRequestManager,
    sendTalkReply,
    auditLog,
    botUsername,
    allowedBackends,
    onTokenDiscovered,
    conversationContext,
    agentLoop,
    sessionManager,
    statusIndicator,
    filesClient,
    whisperClient,
    audioConverter,
    voiceManager,
    botNames,
    microPipeline,
    intentRouter,
    warmMemory
  } = deps;

  // Create command handler first (used by message processor)
  const commandHandler = new CommandHandler({
    signatureVerifier,
    messageRouter,
    llmRouter,
    auditLog,
    allowedBackends
  });

  // Create message processor (uses command handler)
  const messageProcessor = new MessageProcessor({
    messageRouter,
    commandHandler,
    sendTalkReply,
    auditLog,
    botUsername,
    onTokenDiscovered,
    conversationContext,
    agentLoop,
    sessionManager,
    statusIndicator,
    filesClient,
    whisperClient,
    audioConverter,
    voiceManager,
    ncRequestManager,
    botNames,
    microPipeline,
    intentRouter,
    warmMemory
  });

  // Create webhook handler (uses message processor)
  const webhookHandler = new WebhookHandler({
    signatureVerifier,
    messageProcessor,
    auditLog,
    botEnroller: deps.botEnroller || null
  });

  // Create health handler
  const healthHandler = new HealthHandler({
    signatureVerifier,
    ncRequestManager
  });

  return {
    messageProcessor,
    commandHandler,
    webhookHandler,
    healthHandler
  };
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = {
  // Classes
  MessageProcessor,
  CommandHandler,
  WebhookHandler,
  HealthHandler,

  // Factory
  createServerComponents
};
