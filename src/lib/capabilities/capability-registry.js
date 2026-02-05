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
 * Problem: The agent has no self-knowledge of its own capabilities. When users
 * ask "what can you do?" there is no canonical source of truth, leading to
 * inconsistent help text and stale documentation.
 *
 * Pattern: Central registry (Map-based) that tracks five capability categories:
 *   core, integrations, skills, commands, providers.
 * Each capability is a descriptor object with name, description, category, and
 * optional metadata. The registry is populated during bot startup and queried
 * by HelpGenerator, StatusReporter, and CommandHandler.
 *
 * Key Dependencies:
 *   - None (leaf module - no internal dependencies)
 *
 * Data Flow:
 *   bot.js -> initialize() registers built-in capabilities
 *   bot.js -> registerIntegration()/registerSkill() adds dynamic capabilities
 *   HelpGenerator/StatusReporter -> getAllCapabilities()/getProviderStatuses()
 *   CommandHandler -> getCommand()/search()
 *
 * Dependency Map:
 *   capability-registry.js depends on: nothing
 *   Used by: help-generator.js, status-reporter.js, command-handler.js, bot.js
 */

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * @typedef {'core'|'integration'|'skill'|'command'|'provider'} CapabilityCategory
 */

/**
 * @typedef {Object} CapabilityDescriptor
 * @property {string} name - Unique identifier (e.g. 'conversation', 'deck')
 * @property {string} description - Human-readable description
 * @property {CapabilityCategory} category - Capability category
 * @property {boolean} [enabled=true] - Whether the capability is currently active
 * @property {Object} [metadata={}] - Additional data (version, config, etc.)
 */

/**
 * @typedef {'online'|'offline'|'degraded'|'unknown'} ProviderStatus
 */

/**
 * @typedef {Object} ProviderStatusEntry
 * @property {string} name - Provider name (e.g. 'ollama', 'nextcloud')
 * @property {ProviderStatus} status - Current status
 * @property {string} [message] - Optional status message
 * @property {number} [lastChecked] - Timestamp of last status check
 */

// -----------------------------------------------------------------------------
// CapabilityRegistry Class
// -----------------------------------------------------------------------------

/**
 * Central registry of agent capabilities, commands, and provider statuses.
 *
 * Categories:
 * - core: Built-in capabilities (conversation, research)
 * - integration: External service integrations (deck, calendar, knowledge)
 * - skill: Learned or configured skills
 * - command: Slash commands (/help, /status, /capabilities, /health)
 * - provider: LLM/service provider status tracking
 *
 * @module capabilities/capability-registry
 */
class CapabilityRegistry {
  constructor() {
    /**
     * All registered capabilities keyed by name.
     * @type {Map<string, CapabilityDescriptor>}
     */
    this._capabilities = new Map();

    /**
     * Provider statuses keyed by provider name.
     * @type {Map<string, ProviderStatusEntry>}
     */
    this._providerStatuses = new Map();

    /**
     * Custom command handlers keyed by command name (e.g. '/mycommand').
     * @type {Map<string, Function>}
     */
    this._commandHandlers = new Map();

    /**
     * Whether initialize() has been called.
     * @type {boolean}
     */
    this._initialized = false;
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  /**
   * Initialize the registry with built-in capabilities.
   * Idempotent -- safe to call multiple times.
   *
   * Registers:
   * - 2 core capabilities (conversation, research)
   * - 4 built-in commands (/help, /status, /capabilities, /health)
   */
  initialize() {
    if (this._initialized) return;

    // Core capabilities
    this.registerCore({
      name: 'conversation',
      description: 'Natural language conversation via LLM providers'
    });

    this.registerCore({
      name: 'research',
      description: 'Information retrieval and analysis from connected sources'
    });

    // Built-in commands
    this.registerCommand({
      name: '/help',
      description: 'Show available commands and capabilities'
    });

    this.registerCommand({
      name: '/status',
      description: 'Show system status, uptime, and provider health'
    });

    this.registerCommand({
      name: '/capabilities',
      description: 'List all registered capabilities by category'
    });

    this.registerCommand({
      name: '/health',
      description: 'Quick health check of all providers'
    });

    this._initialized = true;
  }

  // ---------------------------------------------------------------------------
  // Registration Methods
  // ---------------------------------------------------------------------------

  /**
   * Register a core capability.
   * @param {Object} descriptor
   * @param {string} descriptor.name - Unique capability name
   * @param {string} descriptor.description - Human-readable description
   * @param {Object} [descriptor.metadata={}] - Additional metadata
   * @returns {CapabilityDescriptor} The registered capability
   */
  registerCore(descriptor) {
    const capability = {
      name: descriptor.name,
      description: descriptor.description,
      category: 'core',
      enabled: true,
      metadata: descriptor.metadata || {}
    };
    this._capabilities.set(descriptor.name, capability);
    return capability;
  }

  /**
   * Register an external service integration.
   * @param {Object} descriptor
   * @param {string} descriptor.name - Integration name (e.g. 'deck', 'calendar')
   * @param {string} descriptor.description - Human-readable description
   * @param {boolean} [descriptor.enabled=true] - Whether integration is active
   * @param {Object} [descriptor.metadata={}] - Additional metadata
   * @returns {CapabilityDescriptor} The registered capability
   */
  registerIntegration(descriptor) {
    const capability = {
      name: descriptor.name,
      description: descriptor.description,
      category: 'integration',
      enabled: descriptor.enabled !== false,
      metadata: descriptor.metadata || {}
    };
    this._capabilities.set(descriptor.name, capability);
    return capability;
  }

  /**
   * Register a skill.
   * @param {Object} descriptor
   * @param {string} descriptor.name - Skill name
   * @param {string} descriptor.description - Human-readable description
   * @param {Object} [descriptor.metadata={}] - Additional metadata
   * @returns {CapabilityDescriptor} The registered capability
   */
  registerSkill(descriptor) {
    const capability = {
      name: descriptor.name,
      description: descriptor.description,
      category: 'skill',
      enabled: true,
      metadata: descriptor.metadata || {}
    };
    this._capabilities.set(descriptor.name, capability);
    return capability;
  }

  /**
   * Register a slash command.
   * @param {Object} descriptor
   * @param {string} descriptor.name - Command name including slash (e.g. '/help')
   * @param {string} descriptor.description - Human-readable description
   * @param {Function} [descriptor.handler] - Custom command handler function
   * @param {Object} [descriptor.metadata={}] - Additional metadata
   * @returns {CapabilityDescriptor} The registered capability
   */
  registerCommand(descriptor) {
    const capability = {
      name: descriptor.name,
      description: descriptor.description,
      category: 'command',
      enabled: true,
      metadata: descriptor.metadata || {}
    };
    this._capabilities.set(descriptor.name, capability);

    if (typeof descriptor.handler === 'function') {
      this._commandHandlers.set(descriptor.name, descriptor.handler);
    }

    return capability;
  }

  // ---------------------------------------------------------------------------
  // Provider Status Management
  // ---------------------------------------------------------------------------

  /**
   * Set the status of a provider (e.g. ollama, nextcloud).
   * @param {string} name - Provider name
   * @param {ProviderStatus} status - Current status ('online', 'offline', 'degraded', 'unknown')
   * @param {string} [message=''] - Optional status message
   */
  setProviderStatus(name, status, message = '') {
    this._providerStatuses.set(name, {
      name,
      status,
      message,
      lastChecked: Date.now()
    });
  }

  /**
   * Set the enabled/disabled status of an integration.
   * @param {string} name - Integration name
   * @param {boolean} enabled - Whether the integration is active
   * @returns {boolean} True if the integration was found and updated
   */
  setIntegrationStatus(name, enabled) {
    const cap = this._capabilities.get(name);
    if (cap && cap.category === 'integration') {
      cap.enabled = enabled;
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Query Methods
  // ---------------------------------------------------------------------------

  /**
   * Get all registered capabilities, optionally filtered by category.
   * @param {CapabilityCategory} [category] - Filter by category (omit for all)
   * @returns {Array<CapabilityDescriptor>} Array of capability descriptors
   */
  getAllCapabilities(category) {
    const all = Array.from(this._capabilities.values());
    if (category) {
      return all.filter(c => c.category === category);
    }
    return all;
  }

  /**
   * Search capabilities by name or description substring (case-insensitive).
   * @param {string} query - Search query
   * @returns {Array<CapabilityDescriptor>} Matching capabilities
   */
  search(query) {
    if (!query || typeof query !== 'string') return [];
    const lower = query.toLowerCase();
    return Array.from(this._capabilities.values()).filter(c =>
      c.name.toLowerCase().includes(lower) ||
      c.description.toLowerCase().includes(lower)
    );
  }

  /**
   * Get a specific command descriptor by name.
   * @param {string} name - Command name including slash (e.g. '/help')
   * @returns {CapabilityDescriptor|null} Command descriptor or null
   */
  getCommand(name) {
    const cap = this._capabilities.get(name);
    if (cap && cap.category === 'command') {
      return cap;
    }
    return null;
  }

  /**
   * Get the custom handler function for a command, if registered.
   * @param {string} name - Command name including slash
   * @returns {Function|null} Handler function or null
   */
  getCommandHandler(name) {
    return this._commandHandlers.get(name) || null;
  }

  /**
   * Check whether a capability exists by name.
   * @param {string} name - Capability name
   * @returns {boolean} True if capability is registered
   */
  hasCapability(name) {
    return this._capabilities.has(name);
  }

  /**
   * Get a single capability by name.
   * @param {string} name - Capability name
   * @returns {CapabilityDescriptor|null} Capability descriptor or null
   */
  getCapability(name) {
    return this._capabilities.get(name) || null;
  }

  /**
   * Get all provider statuses.
   * @returns {Array<ProviderStatusEntry>} Array of provider status entries
   */
  getProviderStatuses() {
    return Array.from(this._providerStatuses.values());
  }

  // ---------------------------------------------------------------------------
  // Serialization
  // ---------------------------------------------------------------------------

  /**
   * Export the full registry state as a plain JSON-safe object.
   * @returns {Object} Serialized registry state
   */
  toJSON() {
    const grouped = {};
    for (const cap of this._capabilities.values()) {
      if (!grouped[cap.category]) {
        grouped[cap.category] = [];
      }
      grouped[cap.category].push(cap);
    }

    return {
      capabilities: grouped,
      providers: Array.from(this._providerStatuses.values()),
      initialized: this._initialized,
      totalCapabilities: this._capabilities.size
    };
  }
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = { CapabilityRegistry };
