/**
 * Slash Command Handler
 *
 * Architecture Brief:
 * -------------------
 * Problem: webhook-server.js handleCommand() function is embedded in the server
 * file, making it harder to test and extend with new commands.
 *
 * Pattern: Command pattern - each slash command maps to a handler method.
 * New commands can be added without modifying the core routing logic.
 *
 * Key Dependencies:
 * - TalkSignatureVerifier (for /stats command)
 * - MessageRouter (for /status command)
 * - Audit logging
 *
 * Data Flow:
 * - MessageProcessor detects slash command (starts with '/')
 * - CommandHandler.handle() parses command and args
 * - Dispatches to specific command method
 * - Returns response string
 *
 * Integration Points:
 * - Called by MessageProcessor for messages starting with '/'
 * - Uses signatureVerifier.getStats() for /stats
 * - Uses messageRouter.getStats() for /status
 *
 * @module server/command-handler
 * @version 1.0.0
 */

'use strict';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * @typedef {Object} CommandDependencies
 * @property {Object} signatureVerifier - TalkSignatureVerifier instance
 * @property {Object} [messageRouter] - MessageRouter instance
 * @property {Object} [llmRouter] - LLMRouter instance
 * @property {Function} auditLog - Audit logging function
 * @property {string[]} allowedBackends - List of allowed webhook backends
 * @property {Object} [selfHealClient] - SelfHealClient instance
 * @property {Object} [sessionManager] - SessionManager instance
 * @property {Object} [sessionPersister] - SessionPersister instance
 * @property {string} [adminUser] - Admin username for privileged commands
 */

/**
 * @typedef {Object} CommandContext
 * @property {string} user - User who sent the command
 * @property {string} token - NC Talk room token
 * @property {string} messageId - Original message ID
 */

/**
 * @typedef {Object} CommandResult
 * @property {string} response - Command response text (markdown formatted)
 * @property {boolean} [unknown] - True if command was not recognized
 */

// -----------------------------------------------------------------------------
// Command Handler Class
// -----------------------------------------------------------------------------

/**
 * Handles slash commands from NC Talk messages.
 *
 * Supported commands:
 * - /help - Show available commands
 * - /status - Show server status and handler availability
 * - /stats - Show signature verification statistics
 */
class CommandHandler {
  /**
   * @param {CommandDependencies} deps
   */
  constructor(deps) {
    /** @type {Object} */
    this.signatureVerifier = deps.signatureVerifier;

    /** @type {Object|null} */
    this.messageRouter = deps.messageRouter || null;

    /** @type {Object|null} */
    this.llmRouter = deps.llmRouter || null;

    /** @type {Function} */
    this.auditLog = deps.auditLog || (async () => {});

    /** @type {string[]} */
    this.allowedBackends = deps.allowedBackends || [];

    /** @type {Object|null} */
    this.selfHealClient = deps.selfHealClient || null;

    /** @type {Object|null} */
    this.sessionManager = deps.sessionManager || null;

    /** @type {Object|null} */
    this.sessionPersister = deps.sessionPersister || null;

    /** @type {string} */
    this.adminUser = deps.adminUser || '';
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Handle a slash command
   *
   * @param {string} message - Full message starting with '/'
   * @param {CommandContext} context - Command context
   * @returns {Promise<CommandResult>}
   */
  async handle(message, context) {
    const { command, args } = this._parseCommand(message);

    let response;

    switch (command) {
      case '/help':
        response = this._handleHelp();
        break;

      case '/status':
        response = this._handleStatus();
        break;

      case '/stats':
        response = this._handleStats();
        break;

      case '/restart':
        response = await this._handleRestart(args, context);
        break;

      case '/persist':
        response = await this._handlePersist(context);
        break;

      default:
        response = `Unknown command: ${command}\nType /help for available commands.`;
        await this.auditLog('command', { command, user: context.user, args: args.substring(0, 50) });
        return { response, unknown: true };
    }

    await this.auditLog('command', { command, user: context.user, args: args.substring(0, 50) });

    return { response };
  }

  // ---------------------------------------------------------------------------
  // Command Handlers
  // ---------------------------------------------------------------------------

  /**
   * Handle /help command
   *
   * @returns {string}
   * @private
   */
  _handleHelp() {
    return `**MoltAgent Commands:**
- /status - Show server status
- /stats - Show verification statistics
- /persist - Force-persist current session (wiki + commitment cards)
- /restart <service> - Restart a remote service (admin only: voice, ai)
- /help - Show this help

**Natural Language:**
- Ask about your calendar: "What's on my schedule today?"
- Check email: "Do I have any unread emails?"
- Send email: "Send an email to john@example.com about the meeting"
- Schedule events: "Schedule a meeting tomorrow at 2pm"

Just send a message to chat with the AI!`;
  }

  /**
   * Handle /status command
   *
   * @returns {string}
   * @private
   */
  _handleStatus() {
    const verifierStats = this.signatureVerifier.getStats();
    const routerStats = this.messageRouter ? this.messageRouter.getStats() : null;

    return `**MoltAgent Status:**
- Server: Running
- Signature verifications: ${verifierStats.totalVerifications}
- Success rate: ${verifierStats.successRate}
- LLM Router: ${this.llmRouter ? 'Available' : 'Not configured'}
- Calendar: ${routerStats?.handlersConfigured.calendar ? 'Available' : 'Not configured'}
- Email: ${routerStats?.handlersConfigured.email ? 'Available' : 'Not configured'}
- Allowed backends: ${this.allowedBackends.length}`;
  }

  /**
   * Handle /stats command
   *
   * @returns {string}
   * @private
   */
  _handleStats() {
    const stats = this.signatureVerifier.getStats();

    return `**Signature Verification Stats:**
- Total: ${stats.totalVerifications}
- Successful: ${stats.successful}
- Failed: ${stats.failed}
- Success rate: ${stats.successRate}
- Failure reasons: ${JSON.stringify(stats.failureReasons)}`;
  }

  /**
   * Handle /restart command — admin-only remote service restart.
   *
   * @param {string} args - Service name (voice, whisper, ai, ollama)
   * @param {CommandContext} context
   * @returns {Promise<string>}
   * @private
   */
  async _handleRestart(args, context) {
    if (!this._isAdmin(context.user)) {
      return 'This command requires admin access.';
    }
    if (!this.selfHealClient) {
      return 'Self-heal daemon is not configured.';
    }

    const serviceMap = {
      voice: 'whisper-server',
      whisper: 'whisper-server',
      ai: 'ollama',
      ollama: 'ollama'
    };

    const target = args.trim().toLowerCase();
    const systemdName = serviceMap[target];

    if (!systemdName) {
      return `Unknown service: "${target}"\nAvailable: voice (whisper-server), ai (ollama)`;
    }

    try {
      const result = await this.selfHealClient.restart(systemdName);
      return `Restarted ${systemdName}. ${result.message || ''}`.trim();
    } catch (err) {
      return `Failed to restart ${systemdName}: ${err.message}`;
    }
  }

  /**
   * Handle /persist command — force-persist the current session to wiki
   * and run commitment detection immediately.
   *
   * @param {CommandContext} context
   * @returns {Promise<string>}
   * @private
   */
  async _handlePersist(context) {
    if (!this.sessionManager) {
      return 'SessionManager not available.';
    }
    if (!this.sessionPersister) {
      return 'SessionPersister not available.';
    }

    const session = this.sessionManager.getSession(context.token, context.user);
    if (!session) {
      return 'No active session found for this room.';
    }

    if (!session.context || session.context.length < 4) {
      return `Session too short to persist (${session.context?.length || 0} messages, need ≥4).`;
    }

    try {
      const page = await this.sessionPersister.persistSession(session);
      if (page) {
        return `Session persisted: **${page}**\nCommitments detected and captured (if any).`;
      }
      return 'Session was below persistence threshold (too few exchanges or empty summary).';
    } catch (err) {
      console.error('[CommandHandler] /persist failed:', err.message);
      return `Persist failed: ${err.message}`;
    }
  }

  // ---------------------------------------------------------------------------
  // Private Helpers
  // ---------------------------------------------------------------------------

  /**
   * Check if user is the configured admin.
   * @param {string} user
   * @returns {boolean}
   * @private
   */
  _isAdmin(user) {
    return this.adminUser && user === this.adminUser;
  }

  /**
   * Parse command and arguments from message
   *
   * @param {string} message - Full message starting with '/'
   * @returns {{ command: string, args: string }}
   * @private
   */
  _parseCommand(message) {
    const parts = message.split(' ');
    const command = parts[0].toLowerCase();
    const args = parts.slice(1).join(' ');
    return { command, args };
  }
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = CommandHandler;
