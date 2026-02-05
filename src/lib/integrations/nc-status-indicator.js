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
 * Problem: Users have no visual indication of what Molti is doing. The NC user
 * status next to Molti's avatar in Talk, Contacts, and the user list is always
 * blank. A live status indicator ("Ready", "Thinking...", "Checking in...")
 * makes Molti feel like a real teammate.
 *
 * Pattern: Stateful facade over the NC User Status OCS API. Maintains a
 * currentStatus string to avoid redundant API calls. All API calls are
 * best-effort (fire-and-forget, never throw, never block).
 *
 * Key Dependencies:
 *   - NCRequestManager: request(url, options) for OCS API calls
 *   - config.statusIndicator.enabled (from centralized config)
 *
 * Data Flow:
 *   Caller (webhook-server, MessageProcessor, HeartbeatManager)
 *     -> setStatus('ready' | 'thinking' | 'heartbeat' | ...)
 *       -> maps state to { statusType, icon, message }
 *       -> PUT /ocs/v2.php/apps/user_status/api/v1/user_status/status
 *       -> PUT /ocs/v2.php/apps/user_status/api/v1/user_status/message/custom
 *       -> (or DELETE message on shutdown)
 *
 * Dependency Map:
 *   nc-status-indicator.js depends on: nc-request-manager.js (injected)
 *   Used by: webhook-server.js, message-processor.js, heartbeat-manager.js
 *
 * NOTE: This class is NOT the same as capabilities/status-reporter.js, which
 * generates markdown status reports for the /status command. This class sets
 * the NC user presence indicator visible in the Nextcloud UI.
 */

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/**
 * OCS API base path for the user_status app.
 * @type {string}
 */
const OCS_STATUS_BASE = '/ocs/v2.php/apps/user_status/api/v1/user_status';

/**
 * Valid Molti states and their NC User Status API mappings.
 *
 * Each entry maps to:
 *   statusType — one of 'online', 'away', 'dnd', 'invisible', 'offline'
 *   icon       — emoji shown next to the status message (null = clear)
 *   message    — text shown next to the user's name (null = clear message)
 *
 * @type {Object.<string, {statusType: string, icon: string|null, message: string|null}>}
 */
const STATE_MAP = {
  ready:     { statusType: 'online',  icon: '\u{1F7E2}', message: 'Ready' },
  thinking:  { statusType: 'dnd',     icon: '\u{1F9E0}', message: 'Thinking...' },
  heartbeat: { statusType: 'online',  icon: '\u{1F493}', message: 'Checking in...' },
  error:     { statusType: 'away',    icon: '\u26A0\uFE0F', message: 'Having issues' },
  budget:    { statusType: 'away',    icon: '\u{1F4B0}', message: 'Budget limit reached' },
  startup:   { statusType: 'online',  icon: '\u{1F680}', message: 'Starting up...' },
  shutdown:  { statusType: 'offline', icon: null,         message: null }
};

// -----------------------------------------------------------------------------
// NCStatusIndicator Class
// -----------------------------------------------------------------------------

/**
 * Sets Molti's Nextcloud user status via the NC User Status OCS API,
 * reflecting real-time operational state.
 *
 * Best-effort: all API calls are wrapped in try/catch and will never
 * throw or block the caller. Failures are logged to console.warn.
 *
 * @module integrations/nc-status-indicator
 */
class NCStatusIndicator {
  /**
   * @param {Object} options
   * @param {import('../nc-request-manager')} options.ncRequestManager - NCRequestManager instance
   * @param {Object} [options.config] - Application config object (expects config.statusIndicator)
   */
  constructor({ ncRequestManager, config }) {
    /** @type {import('../nc-request-manager')} */
    this.nc = ncRequestManager;

    /**
     * Whether status updates are enabled. Defaults to true.
     * Controlled by STATUS_INDICATOR_ENABLED env var via config.
     * @type {boolean}
     */
    this.enabled = config?.statusIndicator?.enabled !== false;

    /**
     * The last successfully set status state. Used to skip no-op updates.
     * @type {string|null}
     */
    this.currentStatus = null;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Set Molti's NC user status to reflect the given operational state.
   *
   * This method is best-effort: it never throws and never blocks the caller.
   * If the API call fails, a warning is logged and execution continues.
   *
   * If the requested state matches the current status, the call is a no-op
   * (no API request is made).
   *
   * @param {'ready'|'thinking'|'heartbeat'|'error'|'budget'|'startup'|'shutdown'} state
   *   The operational state to reflect in the NC user status.
   * @param {Object} [options]
   * @param {boolean} [options.force=false] - Bypass no-op check (re-send even if unchanged).
   *   Needed for 'ready' during heartbeat to prevent NC activity timeout blanking.
   * @returns {Promise<void>}
   */
  async setStatus(state, options) {
    // 1. If disabled, skip all API calls
    if (!this.enabled) {
      return;
    }

    // 2. No-op optimization: skip if state unchanged (unless forced)
    if (state === this.currentStatus && !options?.force) {
      return;
    }

    // 3. Look up state mapping
    const mapping = STATE_MAP[state];
    if (!mapping) {
      console.warn(`[StatusIndicator] Unknown state: ${state}`);
      return;
    }

    // 4. Best-effort: never throw
    try {
      // 5. Set presence status (online, away, dnd, offline, etc.)
      await this._setPresenceStatus(mapping.statusType);

      // 6. Set or clear custom message
      if (mapping.message !== null) {
        await this._setCustomMessage(mapping.icon, mapping.message);
      } else {
        // Shutdown: clear the custom message
        await this._clearCustomMessage();
      }

      // 7. Update current status on success
      this.currentStatus = state;
    } catch (err) {
      // 8. Log error but never propagate
      console.warn(`[StatusIndicator] Failed to set ${state}:`, err.message);
    }
  }

  /**
   * Get the current status state string.
   * @returns {string|null} The current state, or null if never set.
   */
  getCurrentStatus() {
    return this.currentStatus;
  }

  // ---------------------------------------------------------------------------
  // Private — OCS API Calls
  // ---------------------------------------------------------------------------

  /**
   * Set the NC user presence status (online, away, dnd, offline, invisible).
   *
   * PUT /ocs/v2.php/apps/user_status/api/v1/user_status/status
   * Body: { statusType: 'online' | 'away' | 'dnd' | 'offline' | 'invisible' }
   *
   * @param {string} statusType - One of: online, away, dnd, offline, invisible
   * @returns {Promise<void>}
   * @private
   */
  async _setPresenceStatus(statusType) {
    const url = OCS_STATUS_BASE + '/status';
    const options = {
      method: 'PUT',
      headers: {
        'OCS-APIRequest': 'true',
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ statusType }),
      skipCache: true
    };
    await this.nc.request(url, options);
  }

  /**
   * Set a custom status message with an emoji icon.
   *
   * PUT /ocs/v2.php/apps/user_status/api/v1/user_status/message/custom
   * Body: { statusIcon, message, clearAt: null }
   *
   * @param {string} icon - Emoji icon (e.g. '\u{1F7E2}')
   * @param {string} message - Status message text (e.g. 'Ready')
   * @returns {Promise<void>}
   * @private
   */
  async _setCustomMessage(icon, message) {
    const url = OCS_STATUS_BASE + '/message/custom';
    const options = {
      method: 'PUT',
      headers: {
        'OCS-APIRequest': 'true',
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ statusIcon: icon, message, clearAt: null }),
      skipCache: true
    };
    await this.nc.request(url, options);
  }

  /**
   * Clear the custom status message (used on shutdown).
   *
   * DELETE /ocs/v2.php/apps/user_status/api/v1/user_status/message
   *
   * @returns {Promise<void>}
   * @private
   */
  async _clearCustomMessage() {
    const url = OCS_STATUS_BASE + '/message';
    const options = {
      method: 'DELETE',
      headers: {
        'OCS-APIRequest': 'true',
        'Accept': 'application/json'
      },
      skipCache: true
    };
    await this.nc.request(url, options);
  }
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = NCStatusIndicator;
