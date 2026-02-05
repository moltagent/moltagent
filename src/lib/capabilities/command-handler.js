/*
 * MoltAgent - Sovereign AI Security Layer
 * Copyright (C) 2026 MoltAgent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

'use strict';

/*
 * Architecture Brief
 * ------------------
 * Problem: The existing server/command-handler.js has hardcoded /help, /status,
 * /stats commands. Adding new capability-aware commands requires modifying that
 * file. There is no way for other modules to register custom commands.
 *
 * Pattern: Capabilities-aware command handler that reads commands from the
 * CapabilityRegistry and delegates to HelpGenerator, StatusReporter, or
 * custom registered handlers. This handler is designed to be called by the
 * existing server/command-handler.js as a delegate for capability commands,
 * or used directly via HeartbeatManager for Talk-based command processing.
 *
 * Key Dependencies:
 *   - CapabilityRegistry: getCommand(), getCommandHandler()
 *   - HelpGenerator: generateMainHelp(), generateTopicHelp()
 *   - StatusReporter: generateStatus(), getHealthCheck()
 *
 * Data Flow:
 *   message -> isCommand() check
 *   message -> parseCommand() -> { command, args }
 *   message -> handle(message, context) -> route to:
 *     /help [topic] -> HelpGenerator
 *     /status       -> StatusReporter.generateStatus()
 *     /capabilities -> list all capabilities
 *     /caps         -> alias for /capabilities
 *     /health       -> StatusReporter.getHealthCheck()
 *     /custom       -> registry custom handler
 *     /unknown      -> fallback message
 *
 * Dependency Map:
 *   command-handler.js depends on: capability-registry.js, help-generator.js,
 *                                   status-reporter.js (all injected)
 *   Used by: heartbeat-manager.js (for Talk message command interception),
 *            server/command-handler.js (as delegate)
 */

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * @typedef {Object} CommandHandlerDeps
 * @property {import('./capability-registry').CapabilityRegistry} registry
 * @property {import('./help-generator').HelpGenerator} helpGenerator
 * @property {import('./status-reporter').StatusReporter} statusReporter
 */

/**
 * @typedef {Object} CommandContext
 * @property {string} [user] - User who sent the command
 * @property {string} [token] - NC Talk room token
 * @property {string} [messageId] - Original message ID
 */

/**
 * @typedef {Object} CommandResult
 * @property {string} response - Response text (markdown formatted)
 * @property {boolean} handled - Whether the command was handled
 * @property {string} [command] - The parsed command name
 */

// -----------------------------------------------------------------------------
// CapabilitiesCommandHandler Class
// -----------------------------------------------------------------------------

/**
 * Handles slash commands using the CapabilityRegistry.
 *
 * Supports built-in routes (/help, /status, /capabilities, /health)
 * and custom registered command handlers from the registry.
 *
 * @module capabilities/command-handler
 */
class CapabilitiesCommandHandler {
  /**
   * @param {CommandHandlerDeps} deps
   */
  constructor(deps) {
    /** @type {import('./capability-registry').CapabilityRegistry} */
    this.registry = deps.registry;

    /** @type {import('./help-generator').HelpGenerator} */
    this.helpGenerator = deps.helpGenerator;

    /** @type {import('./status-reporter').StatusReporter} */
    this.statusReporter = deps.statusReporter;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Check if a message is a slash command.
   * @param {string} message - Message text
   * @returns {boolean} True if the message starts with '/'
   */
  isCommand(message) {
    if (!message || typeof message !== 'string') return false;
    return message.trim().startsWith('/') && message.trim().length >= 2;
  }

  /**
   * Parse a command message into command name and arguments.
   * @param {string} message - Full message starting with '/'
   * @returns {{ command: string, args: string }} Parsed command and arguments
   */
  parseCommand(message) {
    const trimmed = message.trim();
    const spaceIndex = trimmed.indexOf(' ');

    if (spaceIndex === -1) {
      return { command: trimmed.toLowerCase(), args: '' };
    }

    return {
      command: trimmed.substring(0, spaceIndex).toLowerCase(),
      args: trimmed.substring(spaceIndex + 1).trim()
    };
  }

  /**
   * Handle a slash command message.
   *
   * Routes to built-in handlers or custom registered handlers.
   * Returns { response, handled } -- if handled is false, the caller
   * should fall through to other command processors.
   *
   * @param {string} message - Full message starting with '/'
   * @param {CommandContext} [context={}] - Command context
   * @returns {Promise<CommandResult>} Command result
   */
  async handle(message, context = {}) {
    if (!message || typeof message !== 'string') {
      return { response: '', handled: false, command: '' };
    }
    const { command, args } = this.parseCommand(message);

    switch (command) {
      case '/help':
        return this._handleHelp(args);

      case '/status':
        return await this._handleStatus();

      case '/capabilities':
      case '/caps':
        return this._handleCapabilities();

      case '/health':
        return this._handleHealth();

      default: {
        // Check for custom registered handler
        const customHandler = this.registry.getCommandHandler(command);
        if (customHandler) {
          try {
            const response = await customHandler(args, context);
            return { response, handled: true, command };
          } catch (err) {
            return {
              response: `Error executing ${command}: ${err.message}`,
              handled: true,
              command
            };
          }
        }

        // Unknown command
        return {
          response: `Unknown command: \`${command}\`\nType \`/help\` for available commands.`,
          handled: false,
          command
        };
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Built-in Command Handlers
  // ---------------------------------------------------------------------------

  /**
   * Handle /help [topic]
   * @param {string} args - Optional topic argument
   * @returns {CommandResult}
   * @private
   */
  _handleHelp(args) {
    const response = args
      ? this.helpGenerator.generateTopicHelp(args)
      : this.helpGenerator.generateMainHelp();

    return { response, handled: true, command: '/help' };
  }

  /**
   * Handle /status
   * @returns {Promise<CommandResult>}
   * @private
   */
  async _handleStatus() {
    const response = await this.statusReporter.generateStatus();
    return { response, handled: true, command: '/status' };
  }

  /**
   * Handle /capabilities or /caps
   * @returns {CommandResult}
   * @private
   */
  _handleCapabilities() {
    const lines = ['**Registered Capabilities**\n'];
    const categories = ['core', 'integration', 'skill', 'command'];

    for (const category of categories) {
      const caps = this.registry.getAllCapabilities(category);
      if (caps.length > 0) {
        lines.push(`**${category.charAt(0).toUpperCase() + category.slice(1)}:**`);
        for (const cap of caps) {
          lines.push(this.helpGenerator.formatCapabilityHelp(cap));
        }
        lines.push('');
      }
    }

    return { response: lines.join('\n'), handled: true, command: '/capabilities' };
  }

  /**
   * Handle /health
   * @returns {CommandResult}
   * @private
   */
  _handleHealth() {
    const response = this.statusReporter.getHealthCheck();
    return { response, handled: true, command: '/health' };
  }
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = { CapabilitiesCommandHandler };
