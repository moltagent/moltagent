/*
 * Moltagent - Sovereign AI Security Layer
 * Copyright (C) 2026 Moltagent Contributors
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
 * Problem: Help text is hardcoded in the server command handler and quickly
 * becomes stale as new features are added. There is no way to generate help
 * for specific topics or search capabilities.
 *
 * Pattern: Generator that reads from CapabilityRegistry to produce up-to-date
 * help text. Supports main help, topic-specific help, capability listing,
 * and command listing -- all derived from the single source of truth.
 *
 * Key Dependencies:
 *   - CapabilityRegistry: getAllCapabilities(), getCommand(), search()
 *
 * Data Flow:
 *   CommandHandler -> generateMainHelp() | generateTopicHelp(topic)
 *                  -> reads CapabilityRegistry
 *                  -> returns formatted markdown string
 *
 * Dependency Map:
 *   help-generator.js depends on: capability-registry.js (injected)
 *   Used by: command-handler.js
 */

// -----------------------------------------------------------------------------
// HelpGenerator Class
// -----------------------------------------------------------------------------

/**
 * Generates help text from the CapabilityRegistry.
 *
 * All output is markdown-formatted for display in NC Talk.
 *
 * @module capabilities/help-generator
 */
class HelpGenerator {
  /**
   * @param {import('./capability-registry').CapabilityRegistry} registry
   */
  constructor(registry) {
    /** @type {import('./capability-registry').CapabilityRegistry} */
    this.registry = registry;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Generate the main help text showing all commands and a brief capability summary.
   * @returns {string} Markdown-formatted help text
   */
  generateMainHelp() {
    const lines = ['**Moltagent Help**\n'];

    // Commands section
    const commands = this.registry.getAllCapabilities('command');
    if (commands.length > 0) {
      lines.push('**Commands:**');
      for (const cmd of commands) {
        lines.push(`- \`${cmd.name}\` - ${cmd.description}`);
      }
      lines.push('');
    }

    // Capabilities summary
    const summary = this.generateSummary();
    lines.push(summary);

    // Natural language hint
    lines.push('');
    lines.push('**Tip:** You can also just send a message in natural language!');

    return lines.join('\n');
  }

  /**
   * Generate help text for a specific topic.
   * Searches capabilities by topic name and returns matching entries.
   *
   * @param {string} topic - Topic to search for (e.g. 'calendar', 'email')
   * @returns {string} Markdown-formatted help text for the topic
   */
  generateTopicHelp(topic) {
    if (!topic || topic.trim() === '') {
      return this.generateMainHelp();
    }

    const matches = this.registry.search(topic.trim());

    if (matches.length === 0) {
      return `No capabilities found matching "${topic}".\n\nType \`/help\` to see all available capabilities.`;
    }

    const lines = [`**Help: ${topic}**\n`];

    for (const cap of matches) {
      lines.push(this.formatCapabilityHelp(cap));
    }

    return lines.join('\n');
  }

  /**
   * Format a single capability as a help entry.
   * @param {import('./capability-registry').CapabilityDescriptor} capability
   * @returns {string} Formatted markdown line(s) for this capability
   */
  formatCapabilityHelp(capability) {
    const status = capability.enabled ? '' : ' (disabled)';
    return `- **${capability.name}** [${capability.category}]: ${capability.description}${status}`;
  }

  /**
   * Format a single command as a help entry.
   * @param {import('./capability-registry').CapabilityDescriptor} command
   * @returns {string} Formatted markdown line for this command
   */
  formatCommandHelp(command) {
    return `- \`${command.name}\` - ${command.description}`;
  }

  /**
   * Generate a brief summary of registered capabilities by category.
   * @returns {string} Markdown-formatted summary
   */
  generateSummary() {
    const categories = ['core', 'integration', 'skill'];
    const lines = ['**Capabilities:**'];

    for (const category of categories) {
      const caps = this.registry.getAllCapabilities(category);
      if (caps.length > 0) {
        const enabled = caps.filter(c => c.enabled);
        const names = enabled.map(c => c.name).join(', ');
        lines.push(`- ${category}: ${names}`);
      }
    }

    return lines.join('\n');
  }
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = { HelpGenerator };
