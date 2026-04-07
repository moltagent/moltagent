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
 * Problem: When users ask "what's your status?" there is no unified view of
 * system health, provider statuses, uptime, or integration states. The existing
 * /status command returns only signature verification stats.
 *
 * Pattern: Reporter that aggregates data from CapabilityRegistry (provider
 * statuses, capability counts), HeartbeatManager (heartbeat state), and
 * KnowledgeBoard (knowledge metrics) into a formatted status report.
 *
 * Key Dependencies:
 *   - CapabilityRegistry: getProviderStatuses(), getAllCapabilities()
 *   - HeartbeatManager: getStatus() (optional, injected via options)
 *   - KnowledgeBoard: getStatus() (optional, injected via options)
 *
 * Data Flow:
 *   CommandHandler -> generateStatus() (async)
 *                  -> reads registry, heartbeat, knowledgeBoard
 *                  -> returns formatted markdown string
 *   CommandHandler -> getHealthCheck()
 *                  -> reads provider statuses from registry
 *                  -> returns formatted markdown string
 *
 * Dependency Map:
 *   status-reporter.js depends on: capability-registry.js (injected)
 *   Used by: command-handler.js
 */

// -----------------------------------------------------------------------------
// StatusReporter Class
// -----------------------------------------------------------------------------

/**
 * Generates status reports from the CapabilityRegistry and optional subsystems.
 *
 * All output is markdown-formatted for display in NC Talk.
 *
 * @module capabilities/status-reporter
 */
class StatusReporter {
  /**
   * @param {import('./capability-registry').CapabilityRegistry} registry
   * @param {Object} [options={}]
   * @param {Object} [options.heartbeat] - HeartbeatManager instance (for heartbeat status)
   * @param {Object} [options.knowledgeBoard] - KnowledgeBoard instance (for knowledge metrics)
   */
  constructor(registry, options = {}) {
    /** @type {import('./capability-registry').CapabilityRegistry} */
    this.registry = registry;

    /** @type {Object|null} */
    this.heartbeat = options.heartbeat || null;

    /** @type {Object|null} */
    this.knowledgeBoard = options.knowledgeBoard || null;

    /**
     * Timestamp when the StatusReporter was created (proxy for bot start time).
     * @type {number}
     */
    this.startTime = Date.now();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Generate a full status report (async because it may query subsystems).
   *
   * Includes:
   * - Uptime
   * - Provider health
   * - Integration statuses
   * - Heartbeat state (if available)
   * - Knowledge board metrics (if available)
   *
   * @returns {Promise<string>} Markdown-formatted status report
   */
  async generateStatus() {
    const lines = ['**Moltagent Status Report**\n'];

    // Uptime
    const uptime = this.formatUptime(Date.now() - this.startTime);
    lines.push(`**Uptime:** ${uptime}`);
    lines.push('');

    // Provider health
    const providers = this.registry.getProviderStatuses();
    if (providers.length > 0) {
      lines.push('**Providers:**');
      for (const p of providers) {
        const icon = this._statusIcon(p.status);
        const msg = p.message ? ` - ${p.message}` : '';
        lines.push(`- ${icon} ${p.name}: ${p.status}${msg}`);
      }
      lines.push('');
    }

    // Integrations
    const integrations = this.registry.getAllCapabilities('integration');
    if (integrations.length > 0) {
      lines.push('**Integrations:**');
      for (const integ of integrations) {
        const icon = integ.enabled ? 'ON' : 'OFF';
        lines.push(`- [${icon}] ${integ.name}: ${integ.description}`);
      }
      lines.push('');
    }

    // Heartbeat state
    if (this.heartbeat) {
      try {
        const hbStatus = this.heartbeat.getStatus();
        lines.push('**Heartbeat:**');
        lines.push(`- Running: ${hbStatus.isRunning ? 'Yes' : 'No'}`);
        lines.push(`- Last run: ${hbStatus.lastRun ? hbStatus.lastRun.toISOString() : 'Never'}`);
        lines.push(`- Tasks today: ${hbStatus.tasksProcessedToday || 0}`);
        lines.push(`- Failures: ${hbStatus.consecutiveFailures || 0}`);
        lines.push('');
      } catch (err) {
        lines.push(`**Heartbeat:** Error reading status: ${err.message}`);
        lines.push('');
      }
    }

    // Knowledge board metrics
    if (this.knowledgeBoard) {
      try {
        const kbStatus = await this.knowledgeBoard.getStatus();
        lines.push('**Knowledge Board:**');
        lines.push(`- Verified: ${Math.max(0, kbStatus.stacks.verified || 0)}`);
        lines.push(`- Uncertain: ${Math.max(0, kbStatus.stacks.uncertain || 0)}`);
        lines.push(`- Stale: ${Math.max(0, kbStatus.stacks.stale || 0)}`);
        lines.push(`- Disputed: ${Math.max(0, kbStatus.stacks.disputed || 0)}`);
        lines.push('');
      } catch (err) {
        lines.push(`**Knowledge Board:** Error reading status: ${err.message}`);
        lines.push('');
      }
    }

    // Capability counts
    const all = this.registry.getAllCapabilities();
    lines.push(`**Total capabilities:** ${all.length}`);

    return lines.join('\n');
  }

  /**
   * Quick health check -- returns provider statuses only.
   * Synchronous (reads from cached registry data).
   *
   * @returns {string} Markdown-formatted health check
   */
  getHealthCheck() {
    const providers = this.registry.getProviderStatuses();

    if (providers.length === 0) {
      return '**Health Check:** No providers registered.';
    }

    const lines = ['**Health Check**\n'];
    let allHealthy = true;

    for (const p of providers) {
      const icon = this._statusIcon(p.status);
      lines.push(`${icon} **${p.name}**: ${p.status}`);
      if (p.status !== 'online') {
        allHealthy = false;
      }
    }

    lines.push('');
    lines.push(allHealthy ? 'All systems operational.' : 'Some systems require attention.');

    return lines.join('\n');
  }

  /**
   * Format a millisecond duration as a human-readable uptime string.
   * @param {number} ms - Duration in milliseconds
   * @returns {string} Formatted uptime (e.g. "2d 5h 30m 12s")
   */
  formatUptime(ms) {
    if (!Number.isFinite(ms) || ms < 0) ms = 0;

    const seconds = Math.floor(ms / 1000) % 60;
    const minutes = Math.floor(ms / (1000 * 60)) % 60;
    const hours = Math.floor(ms / (1000 * 60 * 60)) % 24;
    const days = Math.floor(ms / (1000 * 60 * 60 * 24));

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    parts.push(`${seconds}s`);

    return parts.join(' ');
  }

  // ---------------------------------------------------------------------------
  // Private Helpers
  // ---------------------------------------------------------------------------

  /**
   * Get a text icon for a provider status.
   * @param {import('./capability-registry').ProviderStatus} status
   * @returns {string} Status icon text
   * @private
   */
  _statusIcon(status) {
    switch (status) {
      case 'online': return '[OK]';
      case 'offline': return '[DOWN]';
      case 'degraded': return '[WARN]';
      default: return '[??]';
    }
  }
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = { StatusReporter };
